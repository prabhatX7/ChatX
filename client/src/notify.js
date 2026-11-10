// Desktop pop-ups use the browser Notification API. The text shown is decrypted locally on this device.

export const notificationsSupported = () => typeof Notification !== 'undefined';
export const notificationPermission = () => (notificationsSupported() ? Notification.permission : 'unsupported');

export function askPermission() {
  if (!notificationsSupported() || Notification.permission !== 'default') {
    return Promise.resolve(notificationPermission());
  }
  return Notification.requestPermission();
}

/**
 * A pop-up with text decrypted on this device. It goes through the service worker when there is one (the only way
 * phones allow it), and the worker then knows not to replace it with a plain "sent you a message".
 * kind: 'chat' (opens `from`'s chat), 'call' or 'admin'.
 */
export async function desktopNotify({ title, body, tag, kind = 'chat', from, onClick }) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const options = {
    body,
    tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    renotify: true,
    data: { src: 'page', at: Date.now(), kind, from },
    ...(kind === 'call' ? { requireInteraction: true, vibrate: [300, 150, 300, 150, 300] } : {}),
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.active) {
      await reg.showNotification(title, options);
      return;
    }
  } catch {
    /* fall back below */
  }
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}

/** Remove notifications that are no longer needed (a call that was answered, a chat you opened). */
export async function closeNotifications(match) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return;
    (await reg.getNotifications()).filter((n) => match(n.tag || '')).forEach((n) => n.close());
  } catch {
    /* nothing to close */
  }
}

let audioCtx = null;

/** Short two-tone chime. */
export function ping() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1320, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch {
    /* audio blocked until the user interacts with the page */
  }
}
