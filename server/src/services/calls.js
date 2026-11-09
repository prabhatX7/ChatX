// Call signalling: the server only relays small messages between two people who are allowed to talk.
// The audio and video themselves go directly between the browsers (WebRTC, encrypted with DTLS-SRTP).

const OID = /^[a-f0-9]{24}$/;
const CALL_ID = /^[a-f0-9]{8,32}$/;

// 'joined' is for calls with more than two people: whoever added a new person tells the others in the call ('joined',
// with `who`), and each of them then connects to that person directly.
export const SIGNAL_TYPES = new Set(['invite', 'accept', 'reject', 'busy', 'end', 'offer', 'answer', 'ice', 'joined']);
const NEEDS_DATA = new Set(['offer', 'answer', 'ice']);
const MAX_DATA = 20000; // a session description is a few KB

/** Returns a clean { to, type, callId, video, data[, who] } or null if the message is not acceptable. */
export function cleanSignal(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.to !== 'string' || !OID.test(p.to)) return null;
  if (typeof p.type !== 'string' || !SIGNAL_TYPES.has(p.type)) return null;
  if (typeof p.callId !== 'string' || !CALL_ID.test(p.callId)) return null;

  let data = null;
  if (NEEDS_DATA.has(p.type)) {
    if (!p.data || typeof p.data !== 'object') return null;
    let size = 0;
    try {
      size = JSON.stringify(p.data).length;
    } catch {
      return null;
    }
    if (size > MAX_DATA) return null;
    data = p.data;
  }
  const out = { to: p.to, type: p.type, callId: p.callId, video: p.video === true, data };
  if (p.type === 'joined') {
    if (typeof p.who !== 'string' || !OID.test(p.who) || p.who === p.to) return null;
    out.who = p.who;
  }
  return out;
}
