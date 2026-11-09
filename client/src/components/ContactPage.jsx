import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { cryptoAvailable, deriveCredentials, createIdentity, unwrapIdentity, sharedKeyFor, encryptJson, b64 } from '../crypto.js';
import Logo from './Logo.jsx';

// "Send message request": a visitor (for example from your portfolio) writes to the admin without an account.
// The browser makes a secret just for them. Their keys come from it, so their message is encrypted for the admin
// before it leaves the device. They keep the secret in this browser, and can save a link to come back on another one.
const STORE = 'chatx_guest';
const SALT = 'guest@chatx';
export const GUEST_HASH = '#guest=';

export const loadGuest = () => {
  try {
    const g = JSON.parse(localStorage.getItem(STORE) || 'null');
    return g && typeof g.id === 'string' && typeof g.secret === 'string' ? g : null;
  } catch {
    return null;
  }
};
const saveGuest = (g) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(g));
  } catch {
    /* ignore */
  }
};
const forgetGuest = () => {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
};

/** If the address holds a saved visitor link (#guest=<id>.<secret>), store it and clean the address bar. */
export function takeGuestLink() {
  const h = window.location.hash;
  if (!h.startsWith(GUEST_HASH)) return false;
  const [id, secret] = h.slice(GUEST_HASH.length).split('.');
  history.replaceState(null, '', window.location.pathname);
  if (/^[a-f0-9]{24}$/.test(id || '') && /^[A-Za-z0-9_-]{20,64}$/.test(secret || '')) {
    saveGuest({ id, secret });
    return true;
  }
  return false;
}

const newSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return b64.enc(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const link = (g) => `${window.location.origin}/${GUEST_HASH}${g.id}.${g.secret}`;

export default function ContactPage({ onAuthed, onBack }) {
  const [saved, setSaved] = useState(loadGuest);
  const [form, setForm] = useState({ name: '', contact: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(null); // { name } once the request is in and the admin has not approved yet
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Come back later: check whether the admin approved, and sign in if so.
  async function check(g) {
    try {
      const { authSecret, wrapKey } = await deriveCredentials(SALT, g.secret);
      const res = await api.guestLogin({ id: g.id, authSecret });
      if (res.pending) {
        setWaiting({ name: res.name });
        return;
      }
      const privateKey = await unwrapIdentity(wrapKey, res.encPrivateKey);
      await onAuthed({ user: res.user, privateKey, token: res.token });
    } catch (e) {
      if (e.status === 404) {
        forgetGuest();
        setSaved(null);
        setWaiting(null);
        setError('That request is no longer open. You can send a new one.');
      } else {
        setError(e.message || 'Could not check your request');
      }
    }
  }

  useEffect(() => {
    if (!saved || !cryptoAvailable()) return undefined;
    check(saved);
    // While waiting, look again every 30 seconds.
    timer.current = setInterval(() => check(saved), 30000);
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!cryptoAvailable()) {
      setError('Encryption needs a secure page. Open this app over https:// (or on localhost).');
      return;
    }
    const name = form.name.trim();
    const message = form.message.trim();
    const contact = form.contact.trim();
    if (!name || !message) {
      setError('Please enter your name and a message.');
      return;
    }

    setBusy(true);
    try {
      setStatus('Creating your private keys…');
      const secret = newSecret();
      const { authSecret, wrapKey } = await deriveCredentials(SALT, secret);
      const identity = await createIdentity(wrapKey);
      const made = await api.guestRequest({
        name,
        authSecret,
        publicKey: identity.publicKey,
        encPrivateKey: identity.encPrivateKey,
      });

      setStatus('Encrypting your message for the admin…');
      const key = await sharedKeyFor(identity.privateKey, made.admin.id, made.admin.publicKey);
      // Same format as every chat message, so it becomes the first message of the chat when approved.
      const text = contact ? `${message}\n\n(Contact: ${contact})` : message;
      const sealed = await encryptJson(key, { k: 'text', text, msg: message, ...(contact ? { contact } : {}) }, `${made.id}>${made.admin.id}`);
      await api.guestIntro(made.id, { authSecret, iv: sealed.iv, ct: sealed.ct });

      const g = { id: made.id, secret };
      saveGuest(g);
      setWaiting({ name });
      setSaved(g);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link(saved));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card contact">
        <div className="auth-logo">
          <Logo big />
          <p className="muted">Message the admin. No account needed.</p>
        </div>

        {waiting ? (
          <>
            <div className="notice" role="status">
              <strong>Request sent{waiting.name ? `, ${waiting.name}` : ''}.</strong> If the admin approves, a private chat
              opens here. You can leave this page open.
            </div>
            {saved && (
              <div className="field">
                <span>Your private link</span>
                <div className="code-row small">
                  <code className="link-box">{link(saved)}</code>
                  <button type="button" className="btn small" onClick={copyLink}>
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <small className="hint">Keep this link to return to your chat. Do not share it.</small>
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="btn wide" type="button" onClick={onBack}>
              Back to log in
            </button>
          </>
        ) : saved ? (
          <p className="hint center">{error || 'Checking your request…'}</p>
        ) : (
          <form onSubmit={submit} className="contact-form">
            <label className="field">
              <span>Your name</span>
              <input value={form.name} onChange={set('name')} maxLength={40} required autoComplete="name" placeholder="Who is this?" />
            </label>
            <label className="field">
              <span>Email or phone (optional)</span>
              <input value={form.contact} onChange={set('contact')} maxLength={120} autoComplete="email" placeholder="Optional" />
            </label>
            <label className="field">
              <span>Message</span>
              <textarea value={form.message} onChange={set('message')} rows={4} maxLength={2000} required placeholder="Your message" />
            </label>

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}

            <button className="btn wide primary" type="submit" disabled={busy}>
              {busy ? status || 'Sending…' : 'Send message request'}
            </button>
            <button className="btn wide" type="button" onClick={onBack}>
              Back to log in
            </button>
            <p className="fineprint">🔒 Encrypted on this device. Only the admin can read it.</p>
          </form>
        )}
      </div>
    </div>
  );
}
