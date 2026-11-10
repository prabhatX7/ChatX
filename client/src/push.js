// Push notifications for this device: lets ChatX pop up on your phone or laptop when it is closed.
import { api } from './api.js';

const FLAG = 'chatx:push'; // 'off' = the person turned it off on this device, so do not turn it back on by itself

const flag = {
  get: () => {
    try {
      return localStorage.getItem(FLAG);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      if (v) localStorage.setItem(FLAG, v);
      else localStorage.removeItem(FLAG);
    } catch {
      /* private window */
    }
  },
};

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalledApp = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

function keyBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribeThisDevice() {
  const { enabled, key } = await api.pushKey();
  if (!enabled) throw new Error('Notifications are not available on this server yet');
  const reg = await navigator.serviceWorker.ready;
  const opts = { userVisibleOnly: true, applicationServerKey: keyBytes(key) };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe(opts);
  } else {
    // A subscription made with a different server key cannot be reused.
    const same = sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() === keyBytes(key).join();
    if (!same) {
      await sub.unsubscribe();
      sub = await reg.pushManager.subscribe(opts);
    }
  }
  await api.pushSubscribe(sub.toJSON());
  return sub;
}

/** Ask for permission (must run from a tap or click) and turn notifications on for this device. */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return { ok: false, reason: perm };
  try {
    await subscribeThisDevice();
    flag.set(null);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message };
  }
}

export async function disablePush() {
  flag.set('off');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* nothing to undo */
  }
}

/** 'on' | 'off' | 'blocked' | 'unsupported' for this device. */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** After sign-in: if notifications were already allowed here, quietly keep this device registered. */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || flag.get() === 'off') return;
  try {
    await subscribeThisDevice();
  } catch {
    /* try again next time */
  }
}
