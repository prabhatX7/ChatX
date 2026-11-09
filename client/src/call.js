// Audio / video calls (WebRTC): one-to-one, and group calls where someone in the call adds more people.
//
//  - The audio and video go straight between the browsers, encrypted by WebRTC itself (DTLS-SRTP).
//  - The server only relays small "signalling" messages. The important ones (the session description, which carries the
//    key fingerprints, and the network candidates) are ALSO encrypted with your pair key, so the server cannot read or
//    swap them. That keeps calls end-to-end encrypted even though the server is in the middle of setting them up.
//  - A group call is a mesh: every person has one direct connection ("link") to every other person. There is no server
//    mixing the audio, so it is meant for a handful of people (MAX_PEOPLE).
//
// How someone is added: A (already in the call) rings C with the same call id. When C accepts, A and C connect as usual,
// and A tells everyone else in the call ("joined"). Each of them then connects to C directly, with no ringing.
//
// This file has no React and touches no browser globals directly: everything it needs is passed in (`deps`), which
// makes the whole call flow testable with fakes.

export const RING_MS = 45_000; // how long a call rings before it counts as missed
export const DROP_MS = 10_000; // how long a flaky connection may stay down before that person is dropped
export const LINK_MS = 20_000; // how long a direct link to a person who was already in the call may take to connect
export const LINGER_MS = 2_000; // how long "call ended" stays on screen
export const MAX_PEOPLE = 6; // people in one call, including you

const newCallId = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export const REASONS = {
  declined: 'Call declined',
  busy: 'Busy on another call',
  unavailable: 'Not available right now',
  missed: 'Nobody answered',
  failed: 'The connection was lost',
  ended: 'Call ended',
  denied: 'Camera or microphone is blocked. Allow it in your browser and try again.',
};

/**
 * deps = {
 *   sendSignal({ to, type, callId, video, data, who }),
 *   getIceServers() -> Promise<RTCIceServer[]>,
 *   getMedia(video) -> Promise<MediaStream>,
 *   getVideo(facing) -> Promise<MediaStream>          // a stream with only a camera track, 'user' or 'environment'
 *   countCameras() -> Promise<number>                 // optional: how many cameras there are (for the flip button)
 *   createPeer(config) -> RTCPeerConnection,
 *   encrypt(peerId, obj, callId) -> Promise<{ iv, ct }>,
 *   decrypt(peerId, blob, callId) -> Promise<object>,
 *   onChange(state | null),
 *   onLink({ peerId, outcome, video, startedAt, endedAt })   // optional: one person's part of the call is over; only
 *                                                            // for people THIS device rang (it writes the call log)
 *   setTimer / clearTimer (default setTimeout / clearTimeout),
 * }
 *
 * state = {
 *   callId, video, dir: 'out' | 'in', phase: 'ringing' | 'connecting' | 'active' | 'ended',
 *   peerId (the person who rang you, or the first person you rang),
 *   peers: [{ id, status: 'ringing' | 'connecting' | 'connected', stream }],
 *   remoteStream (the first person's stream), localStream, muted, camOff, facing, canFlip, startedAt, endReason
 * }
 */
export class CallManager {
  constructor(deps) {
    this.d = { setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t), ...deps };
    this.state = null;
    this.links = new Map(); // peerId -> { id, pc, pendingIce, stream, status, invited, offerer, startedAt }
    this.timers = {};
  }

  /* ----- state helpers ----- */

  _fresh(extra) {
    return {
      callId: null,
      peerId: null,
      video: false,
      dir: 'out',
      phase: 'ringing',
      muted: false,
      camOff: false,
      facing: 'user',
      canFlip: false,
      localStream: null,
      remoteStream: null,
      peers: [],
      startedAt: null,
      endReason: null,
      ...extra,
    };
  }

  // Rebuild the list of people from the links, then tell the screen.
  _publish(patch = {}) {
    if (!this.state) return;
    const peers = [...this.links.values()].map((l) => ({ id: l.id, status: l.status, stream: l.stream || null }));
    const first = [...this.links.values()].find((l) => l.stream);
    this.state = { ...this.state, ...patch, peers, remoteStream: first ? first.stream : null };
    this.d.onChange(this.state);
  }

  _set(patch) {
    if (!this.state) return;
    this._publish(patch);
  }

  _timer(name, fn, ms) {
    this._untimer(name);
    this.timers[name] = this.d.setTimer(fn, ms);
  }

  _untimer(name) {
    if (this.timers[name] != null) this.d.clearTimer(this.timers[name]);
    delete this.timers[name];
  }

  get busy() {
    return Boolean(this.state) && this.state.phase !== 'ended';
  }

  _here(msg) {
    return this.busy && msg.callId === this.state.callId;
  }

  _link(id, props) {
    const l = { id, pc: null, pendingIce: [], stream: null, status: 'ringing', invited: false, offerer: false, rung: false, startedAt: null, ...props };
    this.links.set(id, l);
    return l;
  }

  _send(to, type, extra = {}) {
    const s = this.state;
    if (!s) return;
    this.d.sendSignal({ to, type, callId: s.callId, video: s.video, ...extra });
  }

  async _sendSecret(to, type, obj) {
    const s = this.state;
    if (!s) return;
    const data = await this.d.encrypt(to, obj, s.callId);
    this.d.sendSignal({ to, type, callId: s.callId, video: s.video, data });
  }

  async _gotMedia(video) {
    const stream = await this.d.getMedia(Boolean(video));
    let canFlip = false;
    if (video && this.d.countCameras) {
      try {
        canFlip = (await this.d.countCameras()) > 1;
      } catch {
        /* no flip button */
      }
    }
    return { stream, canFlip };
  }

  /* ----- starting, answering, adding people ----- */

  /** Call `peerId`. `video` false = audio only. */
  async start(peerId, video) {
    if (this.busy) return;
    this._untimer('linger'); // a call that just ended must not remove this new one from the screen
    const callId = newCallId();
    this.links.clear();
    this._link(peerId, { invited: true, offerer: true });
    this.state = this._fresh({ callId, peerId, video: Boolean(video), dir: 'out' });
    this._publish();
    try {
      const { stream, canFlip } = await this._gotMedia(video);
      this._set({ localStream: stream, canFlip });
    } catch {
      return this._finish('denied', false);
    }
    if (!this.busy) return this._releaseMedia();
    this._ring(peerId);
  }

  // Send the invite and start the clock on it.
  _ring(peerId) {
    const l = this.links.get(peerId);
    if (l) l.rung = true;
    this._send(peerId, 'invite');
    this._timer(`ring:${peerId}`, () => this._ringOut(peerId), RING_MS);
  }

  // Nobody answered somebody I rang.
  _ringOut(id) {
    if (!this.links.has(id)) return;
    this._send(id, 'end');
    this._removeLink(id, 'missed');
  }

  /** Ring one more person into the call that is running. */
  invite(peerId) {
    if (!this.busy || this.state.phase === 'ringing') return false;
    if (this.links.has(peerId) || this.links.size + 1 >= MAX_PEOPLE) return false;
    this._link(peerId, { invited: true, offerer: true });
    this._publish();
    this._ring(peerId);
    return true;
  }

  /** Accept the call that is ringing. */
  async accept() {
    const s = this.state;
    if (!s || s.dir !== 'in' || s.phase !== 'ringing') return;
    this._untimer('ring');
    this._set({ phase: 'connecting' });
    const first = this.links.get(s.peerId);
    if (first) first.status = 'connecting';
    this._publish();
    try {
      const { stream, canFlip } = await this._gotMedia(s.video);
      this._set({ localStream: stream, canFlip });
    } catch {
      this._send(s.peerId, 'reject');
      return this._finish('denied', false);
    }
    if (!this.busy) return this._releaseMedia();
    await this._makePeer(s.peerId);
    this._send(s.peerId, 'accept');
  }

  async reject() {
    if (!this.state || this.state.dir !== 'in' || this.state.phase !== 'ringing') return;
    this._send(this.state.peerId, 'reject');
    this._finish('declined', false);
  }

  /** Drop one person from the call (for example, they were blocked). Everyone else stays in it. */
  dropPeer(id) {
    if (this.busy && this.links.has(id)) this._removeLink(id, 'ended', true);
  }

  /** Leave the call (also cancels anyone still ringing). Everyone else stays in it. */
  async hangup(reason = 'ended') {
    if (!this.busy) return;
    for (const id of this.links.keys()) this._send(id, 'end');
    this._finish(reason, false);
  }

  setMuted(muted) {
    this.state?.localStream?.getAudioTracks?.().forEach((t) => (t.enabled = !muted));
    this._set({ muted });
  }

  setCameraOff(camOff) {
    this.state?.localStream?.getVideoTracks?.().forEach((t) => (t.enabled = !camOff));
    this._set({ camOff });
  }

  /** Switch between the front and the back camera, without dropping the call. Returns true when it worked. */
  async flipCamera() {
    const s = this.state;
    if (!this.busy || !s.video || !s.localStream || !this.d.getVideo) return false;
    const facing = s.facing === 'user' ? 'environment' : 'user';
    let next;
    try {
      next = await this.d.getVideo(facing);
    } catch {
      return false; // that camera is not available: keep the one in use
    }
    const track = next?.getVideoTracks?.()[0];
    if (!track || !this.busy) {
      next?.getTracks?.().forEach((t) => t.stop());
      return false;
    }
    track.enabled = !this.state.camOff;
    const old = this.state.localStream.getVideoTracks()[0];
    for (const l of this.links.values()) {
      const sender = l.pc?.getSenders?.().find((x) => x.track && x.track.kind === 'video');
      try {
        await sender?.replaceTrack(track);
      } catch {
        /* that person keeps the old picture until it stops; the call itself goes on */
      }
    }
    if (old) {
      this.state.localStream.removeTrack?.(old);
      old.stop();
    }
    this.state.localStream.addTrack?.(track);
    this._set({ facing });
    return true;
  }

  /* ----- incoming signals ----- */

  async signal(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'invite') {
      if (this.busy) {
        // Already in this very call (someone else added me too): nothing to do. Otherwise tell the caller I am busy.
        if (msg.callId !== this.state.callId) this.d.sendSignal({ to: msg.from, type: 'busy', callId: msg.callId, video: false });
        return;
      }
      this._drop(); // forget any call that has just ended
      this.links.clear();
      this._link(msg.from, {});
      this.state = this._fresh({ callId: msg.callId, peerId: msg.from, video: msg.video === true, dir: 'in' });
      this._publish();
      this._timer('ring', () => this._finish('missed', false), RING_MS);
      return;
    }

    if (msg.type === 'unavailable') {
      // Only an invite I sent can get this, and it carries our callId.
      if (this._here(msg) && this.links.get(msg.from)?.invited) this._removeLink(msg.from, 'unavailable');
      return;
    }

    if (msg.type === 'handled') {
      // I answered on another tab or device.
      if (this.busy && this.state.dir === 'in' && this.state.phase === 'ringing' && msg.callId === this.state.callId) this._drop();
      return;
    }

    if (!this._here(msg)) return;
    const from = msg.from;

    try {
      switch (msg.type) {
        case 'accept': {
          const l = this.links.get(from);
          if (!l || !l.invited || l.status !== 'ringing') return;
          this._untimer(`ring:${from}`);
          l.status = 'connecting';
          if (this.state.phase === 'ringing') this._set({ phase: 'connecting' });
          else this._publish();
          // Someone added to a call that already has people in it: the others connect to them too.
          for (const other of this.links.values()) {
            if (other.id !== from && other.status !== 'ringing') this._send(other.id, 'joined', { who: from });
          }
          await this._makePeer(from);
          await this._offer(l);
          break;
        }
        case 'joined': {
          // `from` is in this call and has added `who`: connect to them directly (no ringing).
          const who = msg.who;
          if (!this.links.has(from) || typeof who !== 'string' || this.links.has(who)) return;
          if (this.links.size + 1 >= MAX_PEOPLE) return;
          const l = this._link(who, { offerer: true, status: 'connecting' });
          this._publish();
          this._timer(`link:${who}`, () => this._removeLink(who, 'failed', true), LINK_MS);
          await this._makePeer(who);
          await this._offer(l);
          break;
        }
        case 'offer': {
          let l = this.links.get(from);
          // A person who was added to the call and is already in it reaches me directly; I answer without ringing.
          if (!l && this.state.phase !== 'ringing' && this.state.localStream && this.links.size + 1 < MAX_PEOPLE) {
            l = this._link(from, { status: 'connecting' });
            this._publish();
            this._timer(`link:${from}`, () => this._removeLink(from, 'failed', true), LINK_MS);
            await this._makePeer(from);
          }
          if (!l || l.offerer || !l.pc) return;
          const desc = await this.d.decrypt(from, msg.data, this.state.callId);
          await l.pc.setRemoteDescription(desc);
          await this._flushIce(l);
          const answer = await l.pc.createAnswer();
          await l.pc.setLocalDescription(answer);
          await this._sendSecret(from, 'answer', { type: answer.type, sdp: answer.sdp });
          break;
        }
        case 'answer': {
          const l = this.links.get(from);
          if (!l || !l.offerer || !l.pc) return;
          const desc = await this.d.decrypt(from, msg.data, this.state.callId);
          await l.pc.setRemoteDescription(desc);
          await this._flushIce(l);
          break;
        }
        case 'ice': {
          const l = this.links.get(from);
          if (!l) return;
          const cand = await this.d.decrypt(from, msg.data, this.state.callId);
          if (l.pc && l.pc.remoteDescription) await l.pc.addIceCandidate(cand).catch(() => {});
          else l.pendingIce.push(cand);
          break;
        }
        case 'reject':
          if (this.links.get(from)?.invited) this._removeLink(from, 'declined');
          break;
        case 'busy':
          if (this.links.get(from)?.invited) this._removeLink(from, 'busy');
          break;
        case 'end':
          // That person hung up. On an unanswered incoming call that means it was missed.
          if (this.links.has(from)) this._removeLink(from, 'ended');
          break;
        default:
      }
    } catch {
      this._removeLink(from, 'failed', true);
    }
  }

  /* ----- one direct connection per person ----- */

  async _offer(l) {
    const offer = await l.pc.createOffer();
    await l.pc.setLocalDescription(offer);
    await this._sendSecret(l.id, 'offer', { type: offer.type, sdp: offer.sdp });
  }

  async _makePeer(id) {
    const l = this.links.get(id);
    if (!l) return;
    let iceServers = [];
    try {
      iceServers = await this.d.getIceServers();
    } catch {
      /* fall back to no servers: works on the same network */
    }
    if (!this.busy || !this.links.has(id)) return;
    const pc = this.d.createPeer({ iceServers });
    l.pc = pc;
    l.pendingIce = [];
    const stream = this.state.localStream;
    stream?.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate && this.links.get(id) === l) {
        this._sendSecret(id, 'ice', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate).catch(() => {});
      }
    };
    pc.ontrack = (e) => {
      if (this.links.get(id) !== l) return;
      l.stream = e.streams?.[0] || l.stream;
      this._publish();
    };
    pc.onconnectionstatechange = () => {
      if (this.links.get(id) !== l) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        this._untimer(`drop:${id}`);
        this._untimer(`link:${id}`);
        if (l.status !== 'connected') {
          l.status = 'connected';
          l.startedAt = Date.now();
        }
        if (this.state && this.state.phase !== 'active') this._set({ phase: 'active', startedAt: Date.now() });
        else this._publish();
      } else if (st === 'failed') {
        this._removeLink(id, 'failed', true);
      } else if (st === 'disconnected') {
        this._timer(`drop:${id}`, () => this._removeLink(id, 'failed', true), DROP_MS);
      }
    };
  }

  async _flushIce(l) {
    const list = l.pendingIce;
    l.pendingIce = [];
    for (const c of list) await l.pc.addIceCandidate(c).catch(() => {});
  }

  /* ----- finishing ----- */

  _closeLink(l) {
    this._untimer(`ring:${l.id}`);
    this._untimer(`drop:${l.id}`);
    this._untimer(`link:${l.id}`);
    try {
      l.pc?.close();
    } catch {
      /* already closed */
    }
    l.pc = null;
  }

  // The call with one person is over. When that was the last person, the whole call is over.
  _removeLink(id, hint, tell = false) {
    const l = this.links.get(id);
    if (!l) return;
    if (tell) this._send(id, 'end');
    // An unanswered incoming call that the caller cancels is a missed call.
    const unanswered = l.status === 'ringing' && !l.invited;
    this._reportLink(l, l.startedAt ? 'ended' : unanswered ? 'missed' : hint === 'failed' ? 'missed' : hint);
    this._closeLink(l);
    this.links.delete(id);
    if (this.links.size === 0) {
      const reason = unanswered ? 'missed' : hint;
      this._finish(reason, false);
    } else {
      this._publish();
    }
  }

  // Only the device that rang someone writes the call log for that person.
  _reportLink(l, outcome) {
    if (!l.invited || !l.rung || !this.state) return; // nobody was rung, so there is nothing to log
    this.d.onLink?.({ peerId: l.id, outcome, video: this.state.video, startedAt: l.startedAt, endedAt: Date.now() });
  }

  _releaseMedia() {
    this.state?.localStream?.getTracks?.().forEach((t) => t.stop());
  }

  _teardown() {
    this._releaseMedia();
    for (const l of this.links.values()) this._closeLink(l);
    this.links.clear();
    for (const k of Object.keys(this.timers)) this._untimer(k);
  }

  // Stop everything right now and show "call ended" for a moment. `tell` = also let everyone know.
  _finish(reason, tell) {
    if (!this.state || this.state.phase === 'ended') return;
    for (const l of this.links.values()) {
      if (tell) this._send(l.id, 'end');
      this._reportLink(l, l.startedAt ? 'ended' : reason === 'declined' || reason === 'busy' || reason === 'unavailable' ? reason : 'missed');
    }
    this._teardown();
    this._set({ phase: 'ended', endReason: reason, localStream: null, remoteStream: null });
    this._timer('linger', () => this._drop(), LINGER_MS);
  }

  // Remove the call from the screen without any message.
  _drop() {
    this._teardown();
    this.state = null;
    this.d.onChange(null);
  }

  /** Call when the page closes or the user logs out. */
  dispose() {
    if (this.busy) for (const id of this.links.keys()) this._send(id, 'end');
    this._drop();
  }
}
