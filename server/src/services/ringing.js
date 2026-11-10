// Calls that are ringing for someone who may not have ChatX open. Kept in memory for the length of a ring only.
// This is what lets a call notification wake the app: when the person opens ChatX from it, the invite is still here.

export const RING_MS = 45_000; // same as the browser's ring time (client/src/call.js)

export class RingBook {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map(); // `${to}:${callId}` -> { to, from, callId, video, at, delivered }
  }

  #key = (to, callId) => `${to}:${callId}`;

  #sweep() {
    const t = this.now();
    for (const [k, v] of this.map) if (t - v.at > RING_MS) this.map.delete(k);
  }

  /** `to` is being rung by `from`. `delivered` says whether it already reached an open app. */
  add(to, from, callId, video, delivered) {
    this.#sweep();
    this.map.set(this.#key(to, callId), { to, from, callId, video: video === true, at: this.now(), delivered: Boolean(delivered) });
  }

  /** The ring is over (answered, declined or cancelled). Returns the entry if it was still ringing. */
  end(to, callId) {
    this.#sweep();
    const k = this.#key(to, callId);
    const v = this.map.get(k);
    this.map.delete(k);
    return v;
  }

  /** Invites that have not reached an open app yet. They are handed over once, when the person opens ChatX. */
  takeUndelivered(to) {
    this.#sweep();
    const out = [];
    for (const v of this.map.values()) {
      if (v.to === to && !v.delivered) {
        v.delivered = true;
        out.push(v);
      }
    }
    return out;
  }
}
