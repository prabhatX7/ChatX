// Web Push: pop-up notifications that arrive even when ChatX is closed (laptop and phone).
//
// The server cannot read messages, so a push never contains message text: it only says WHO wrote (the name is not
// secret to the server) and whether it was a message or a call. When the person opens ChatX the text is decrypted there.

// Only real browser push services may be called. Without this list, anyone could make the server send requests to any address.
const PUSH_HOSTS = ['.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
export const MAX_SUBS = 8;

/** Is this a push endpoint we are willing to call? */
export function okEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return PUSH_HOSTS.some((h) => u.hostname.endsWith(h));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** A clean { endpoint, p256dh, auth } from what the browser sent, or null. */
export function cleanSubscription(raw) {
  const s = raw && typeof raw === 'object' ? raw : null;
  const k = s?.keys;
  if (!s || !k || !okEndpoint(s.endpoint)) return null;
  if (typeof k.p256dh !== 'string' || k.p256dh.length < 40 || k.p256dh.length > 200 || !B64URL.test(k.p256dh)) return null;
  if (typeof k.auth !== 'string' || k.auth.length < 8 || k.auth.length > 100 || !B64URL.test(k.auth)) return null;
  return { endpoint: s.endpoint, p256dh: k.p256dh, auth: k.auth };
}

// Where subscriptions live. The real store uses the database; tests swap it.
const dbStore = {
  async subsOf(userId) {
    const { default: User } = await import('../models/User.js');
    return (await User.findById(userId, 'pushSubs').lean())?.pushSubs || [];
  },
  async drop(userId, endpoint) {
    const { default: User } = await import('../models/User.js');
    await User.updateOne({ _id: userId }, { $pull: { pushSubs: { endpoint } } });
  },
  async has(userId) {
    const { default: User } = await import('../models/User.js');
    return Boolean(await User.exists({ _id: userId, 'pushSubs.0': { $exists: true } }));
  },
};
let store = dbStore;
/** For tests. */
export const setPushStore = (s) => {
  store = s || dbStore;
};

let lib = null; // the web-push package
let publicKey = '';
let sender = null; // (subscription, jsonString, options) => Promise

export const pushPublicKey = () => publicKey;
export const pushReady = () => Boolean(sender);
/** For tests: replace the real sender. */
export function setPushSender(fn, key = 'test-key') {
  sender = fn;
  publicKey = key;
}

function subject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL; // https://your-app.onrender.com
  return `mailto:${process.env.ADMIN_EMAIL || 'admin@localhost'}`;
}

/** Runs once at start-up. The key pair is made on the first start and kept in the database, so nothing needs setting up. */
export async function initPush() {
  // Whatever goes wrong here, the chat server must still start: push is an extra.
  try {
    try {
      lib = (await import('web-push')).default;
    } catch {
      console.warn('Push notifications are off: the web-push package is not installed (run "npm --prefix server install web-push").');
      return;
    }
    const { default: ServerKey } = await import('../models/ServerKey.js');
    let keys =
      process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
        ? { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() }
        : (await ServerKey.findById('vapid').lean())?.value;
    if (!keys?.publicKey || !keys?.privateKey) {
      keys = lib.generateVAPIDKeys();
      await ServerKey.updateOne({ _id: 'vapid' }, { $setOnInsert: { value: keys } }, { upsert: true });
      keys = (await ServerKey.findById('vapid').lean()).value; // if two servers started at once, both use the stored one
      console.log('Push notifications: created a new key pair.');
    }
    lib.setVapidDetails(subject(), keys.publicKey, keys.privateKey);
    publicKey = keys.publicKey;
    sender = (sub, body, opts) => lib.sendNotification(sub, body, opts);
    console.log('Push notifications: ready.');
  } catch (err) {
    sender = null;
    console.error('Push notifications are off:', err.message);
  }
}

/**
 * Send a notification to every device of one person. Never throws.
 * payload: { t: 'msg' | 'call' | 'cancel' | 'test', ... } (small, no message text).
 */
export async function sendPush(userId, payload, { ttl = 3600, urgency = 'high' } = {}) {
  if (!sender) return 0;
  try {
    const subs = await store.subsOf(userId);
    if (!subs.length) return 0;
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: ttl, urgency });
          sent += 1;
        } catch (err) {
          // 404 / 410: this device unsubscribed or uninstalled the app. Forget it.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await store.drop(userId, s.endpoint).catch(() => {});
          } else {
            console.warn('push failed:', err?.statusCode || err?.message);
          }
        }
      })
    );
    return sent;
  } catch (err) {
    console.warn('push error:', err.message);
    return 0;
  }
}

export const hasPushDevice = async (userId) => Boolean(sender && (await store.has(userId)));

/** Tell the admin (sign-up waiting, message request) when they are not looking at ChatX. Never throws. */
export async function notifyAdmin(io, payload) {
  try {
    const { default: User } = await import('../models/User.js');
    const admin = await User.findOne({ role: 'admin' }, '_id').lean();
    if (!admin || io.isVisible(String(admin._id))) return;
    await sendPush(admin._id, payload, { ttl: 86400 });
  } catch {
    /* a missed pop-up is not worth failing the request */
  }
}
