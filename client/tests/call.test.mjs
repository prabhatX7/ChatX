import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CallManager, RING_MS, DROP_MS } from '../src/call.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ---- fakes ----
class FakeTrack {
  constructor(kind) { this.kind = kind; this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeStream {
  constructor(video) { this.tracks = [new FakeTrack('audio'), ...(video ? [new FakeTrack('video')] : [])]; }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
  addTrack(t) { this.tracks.push(t); }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
}
class FakePC {
  constructor(config) { this.config = config; this.added = []; this.ice = []; this.closed = false; this.remoteDescription = null; }
  addTrack(t) { const s = { track: t, replaced: [], async replaceTrack(n) { this.replaced.push(n); this.track = n; } }; this.senders = [...(this.senders || []), s]; this.added.push(t); return s; }
  getSenders() { return this.senders || []; }
  async createOffer() { return { type: 'offer', sdp: 'OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'ANSWER' }; }
  async setLocalDescription(d) { this.local = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate(c) { this.ice.push(c); }
  close() { this.closed = true; }
}

function setup({ media = true, cameras = 2 } = {}) {
  const links = [];
  const sent = [];
  const states = [];
  const timers = new Map();
  let nextTimer = 1;
  const pcs = [];
  const mgr = new CallManager({
    sendSignal: (s) => sent.push(s),
    getIceServers: async () => [{ urls: 'stun:x' }],
    getMedia: async (video) => { if (!media) throw new Error('denied'); return new FakeStream(video); },
    getVideo: async (facing) => { if (facing === 'none') throw new Error('no such camera'); const s = new FakeStream(true); s.tracks = [s.tracks[1]]; s.facing = facing; return s; },
    countCameras: async () => cameras,
    onLink: (e) => links.push(e),
    createPeer: (c) => { const p = new FakePC(c); pcs.push(p); return p; },
    encrypt: async (peer, obj, callId) => ({ iv: 'iv', ct: JSON.stringify({ obj, peer, callId }) }),
    decrypt: async (peer, blob, callId) => {
      const x = JSON.parse(blob.ct);
      assert.equal(x.callId, callId);
      return x.obj;
    },
    onChange: (s) => states.push(s && { ...s }),
    setTimer: (f, ms) => { const id = nextTimer++; timers.set(id, { f, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const fire = (ms) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.f(); } };
  return { mgr, sent, states, pcs, timers, fire, links };
}
const types = (sent) => sent.map((s) => s.type);
const ID = 'b'.repeat(24);

test('outgoing call: invite, then offer after accept, then active once connected', async () => {
  const t = setup();
  await t.mgr.start(ID, true);
  assert.deepEqual(types(t.sent), ['invite']);
  assert.equal(t.sent[0].to, ID);
  assert.equal(t.sent[0].video, true);
  assert.equal(t.mgr.state.phase, 'ringing');
  const callId = t.mgr.state.callId;

  await t.mgr.signal({ from: ID, type: 'accept', callId });
  assert.equal(t.mgr.state.phase, 'connecting');
  assert.deepEqual(types(t.sent), ['invite', 'offer']);
  assert.equal(t.sent[1].data.iv, 'iv'); // the offer travels encrypted
  assert.equal(t.pcs[0].added.length, 2); // audio + video
  assert.deepEqual(t.pcs[0].config.iceServers, [{ urls: 'stun:x' }]);

  await t.mgr.signal({ from: ID, type: 'answer', callId, data: { iv: 'iv', ct: JSON.stringify({ obj: { type: 'answer', sdp: 'A' }, callId }) } });
  assert.equal(t.pcs[0].remoteDescription.sdp, 'A');

  t.pcs[0].connectionState = 'connected';
  t.pcs[0].onconnectionstatechange();
  assert.equal(t.mgr.state.phase, 'active');
  assert.ok(t.mgr.state.startedAt);
});

test('incoming call: ring, accept, answer the offer', async () => {
  const t = setup();
  await t.mgr.signal({ from: ID, type: 'invite', callId: 'c1c1c1c1c1c1c1c1', video: false });
  assert.equal(t.mgr.state.dir, 'in');
  assert.equal(t.mgr.state.phase, 'ringing');
  assert.deepEqual(t.sent, []);

  await t.mgr.accept();
  assert.deepEqual(types(t.sent), ['accept']);
  assert.equal(t.pcs[0].added.length, 1); // audio only

  await t.mgr.signal({ from: ID, type: 'offer', callId: 'c1c1c1c1c1c1c1c1', data: { iv: 'iv', ct: JSON.stringify({ obj: { type: 'offer', sdp: 'O' }, callId: 'c1c1c1c1c1c1c1c1' }) } });
  assert.equal(t.pcs[0].remoteDescription.sdp, 'O');
  assert.deepEqual(types(t.sent), ['accept', 'answer']);
});

test('candidates that arrive before the remote description are held, then applied', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  const callId = t.mgr.state.callId;
  await t.mgr.signal({ from: ID, type: 'accept', callId });
  const cand = { candidate: 'c1' };
  await t.mgr.signal({ from: ID, type: 'ice', callId, data: { iv: 'iv', ct: JSON.stringify({ obj: cand, callId }) } });
  assert.equal(t.pcs[0].ice.length, 0);
  await t.mgr.signal({ from: ID, type: 'answer', callId, data: { iv: 'iv', ct: JSON.stringify({ obj: { type: 'answer', sdp: 'A' }, callId }) } });
  assert.deepEqual(t.pcs[0].ice, [cand]);
});

test('a second call while busy is answered with "busy" and the first call is untouched', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  const first = t.mgr.state.callId;
  const OTHER = 'c'.repeat(24);
  await t.mgr.signal({ from: OTHER, type: 'invite', callId: 'd2d2d2d2d2d2d2d2' });
  assert.equal(t.mgr.state.callId, first);
  const busy = t.sent.at(-1);
  assert.deepEqual([busy.type, busy.to, busy.callId], ['busy', OTHER, 'd2d2d2d2d2d2d2d2']);
});

test('signals from strangers or for old calls are ignored', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  const callId = t.mgr.state.callId;
  await t.mgr.signal({ from: 'c'.repeat(24), type: 'end', callId });
  await t.mgr.signal({ from: ID, type: 'end', callId: 'deadbeefdeadbeef' });
  assert.equal(t.mgr.state.phase, 'ringing');
});

test('rejecting, hanging up and the other side hanging up all end the call and release the camera', async () => {
  const t = setup();
  await t.mgr.signal({ from: ID, type: 'invite', callId: 'e3e3e3e3e3e3e3e3', video: true });
  await t.mgr.reject();
  assert.equal(t.sent.at(-1).type, 'reject');
  assert.equal(t.mgr.state.phase, 'ended');
  assert.equal(t.mgr.state.endReason, 'declined');

  const u = setup();
  await u.mgr.start(ID, true);
  const stream = u.mgr.state.localStream;
  await u.mgr.hangup();
  assert.equal(u.sent.at(-1).type, 'end');
  assert.ok(stream.tracks.every((x) => x.stopped));
  assert.equal(u.mgr.state.endReason, 'ended');

  const v = setup();
  await v.mgr.start(ID, false);
  await v.mgr.signal({ from: ID, type: 'reject', callId: v.mgr.state.callId });
  assert.equal(v.mgr.state.endReason, 'declined');
});

test('an unanswered call is missed after the ring time, on both sides', async () => {
  const a = setup();
  await a.mgr.start(ID, false);
  a.fire(RING_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.mgr.state.endReason, 'missed');
  assert.equal(a.sent.at(-1).type, 'end');

  const b = setup();
  await b.mgr.signal({ from: ID, type: 'invite', callId: 'f4f4f4f4f4f4f4f4' });
  b.fire(RING_MS);
  assert.equal(b.mgr.state.endReason, 'missed');
});

test('caller cancelling before the callee answers counts as missed for the callee', async () => {
  const t = setup();
  await t.mgr.signal({ from: ID, type: 'invite', callId: 'a5a5a5a5a5a5a5a5' });
  await t.mgr.signal({ from: ID, type: 'end', callId: 'a5a5a5a5a5a5a5a5' });
  assert.equal(t.mgr.state.endReason, 'missed');
});

test('a blocked camera or microphone ends the call at once', async () => {
  const t = setup({ media: false });
  await t.mgr.start(ID, true);
  assert.equal(t.mgr.state.endReason, 'denied');
  assert.deepEqual(t.sent, []); // the other person was never rung

  const u = setup({ media: false });
  await u.mgr.signal({ from: ID, type: 'invite', callId: 'b6b6b6b6b6b6b6b6' });
  await u.mgr.accept();
  assert.equal(u.sent.at(-1).type, 'reject');
  assert.equal(u.mgr.state.endReason, 'denied');
});

test('"unavailable" and "handled" are understood', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  await t.mgr.signal({ from: ID, type: 'unavailable', callId: t.mgr.state.callId });
  assert.equal(t.mgr.state.endReason, 'unavailable');

  const u = setup();
  await u.mgr.signal({ from: ID, type: 'invite', callId: 'c7c7c7c7c7c7c7c7' });
  await u.mgr.signal({ from: ID, type: 'handled', callId: 'c7c7c7c7c7c7c7c7' });
  assert.equal(u.mgr.state, null); // stops ringing silently
});

test('mute and camera toggles switch the real tracks', async () => {
  const t = setup();
  await t.mgr.start(ID, true);
  t.mgr.setMuted(true);
  t.mgr.setCameraOff(true);
  const s = t.mgr.state.localStream;
  assert.equal(s.getAudioTracks()[0].enabled, false);
  assert.equal(s.getVideoTracks()[0].enabled, false);
  t.mgr.setMuted(false);
  assert.equal(s.getAudioTracks()[0].enabled, true);
});

test('a dropped connection ends the call after a grace period, but recovery cancels that', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  const callId = t.mgr.state.callId;
  await t.mgr.signal({ from: ID, type: 'accept', callId });
  const pc = t.pcs[0];
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  t.fire(DROP_MS);
  assert.equal(t.mgr.state.phase, 'active');

  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  t.fire(DROP_MS);
  assert.equal(t.mgr.state.endReason, 'failed');
});

test('the finished call disappears by itself and a new one can start', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  await t.mgr.hangup();
  t.fire(2000);
  assert.equal(t.mgr.state, null);
  await t.mgr.start(ID, false);
  assert.equal(t.mgr.state.phase, 'ringing');
});

test('only one call can be started at a time', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  await t.mgr.start('c'.repeat(24), true);
  assert.equal(t.sent.filter((s) => s.type === 'invite').length, 1);
});

/* ---------------- more: camera flip, call log events, group calls ---------------- */

const tick = () => new Promise((r) => setImmediate(r));

test('the flip button only exists when there is more than one camera, and flipping swaps the sent track', async () => {
  const one = setup({ cameras: 1 });
  await one.mgr.start(ID, true);
  assert.equal(one.mgr.state.canFlip, false);

  const t = setup({ cameras: 2 });
  await t.mgr.start(ID, true);
  assert.equal(t.mgr.state.canFlip, true);
  assert.equal(t.mgr.state.facing, 'user');
  const callId = t.mgr.state.callId;
  await t.mgr.signal({ from: ID, type: 'accept', callId });
  const oldTrack = t.mgr.state.localStream.getVideoTracks()[0];
  const sender = t.pcs[0].getSenders().find((s) => s.track === oldTrack);

  assert.equal(await t.mgr.flipCamera(), true);
  assert.equal(t.mgr.state.facing, 'environment');
  assert.equal(oldTrack.stopped, true);
  const now = t.mgr.state.localStream.getVideoTracks();
  assert.equal(now.length, 1);
  assert.notEqual(now[0], oldTrack);
  assert.equal(sender.track, now[0]); // the other person receives the new camera on the same connection

  assert.equal(await t.mgr.flipCamera(), true); // and back again
  assert.equal(t.mgr.state.facing, 'user');
});

test('flipping keeps the camera-off state, and a camera that cannot open leaves the call unchanged', async () => {
  const t = setup();
  await t.mgr.start(ID, true);
  t.mgr.setCameraOff(true);
  await t.mgr.flipCamera();
  assert.equal(t.mgr.state.localStream.getVideoTracks()[0].enabled, false);

  const u = setup();
  await u.mgr.start(ID, true);
  const before = u.mgr.state.localStream.getVideoTracks()[0];
  u.mgr.d.getVideo = async () => { throw new Error('busy'); };
  assert.equal(await u.mgr.flipCamera(), false);
  assert.equal(u.mgr.state.localStream.getVideoTracks()[0], before);
  assert.equal(before.stopped, false);

  const audio = setup();
  await audio.mgr.start(ID, false);
  assert.equal(await audio.mgr.flipCamera(), false); // no camera in an audio call
});

test('the caller gets one log event per person: ended (with times), missed, declined', async () => {
  const a = setup();
  await a.mgr.start(ID, false);
  const callId = a.mgr.state.callId;
  await a.mgr.signal({ from: ID, type: 'accept', callId });
  a.pcs[0].connectionState = 'connected';
  a.pcs[0].onconnectionstatechange();
  await a.mgr.hangup();
  assert.equal(a.links.length, 1);
  assert.equal(a.links[0].peerId, ID);
  assert.equal(a.links[0].outcome, 'ended');
  assert.ok(a.links[0].startedAt && a.links[0].endedAt >= a.links[0].startedAt);

  const b = setup();
  await b.mgr.start(ID, true);
  b.fire(RING_MS);
  await tick();
  assert.deepEqual(b.links.map((e) => [e.outcome, e.video, e.startedAt]), [['missed', true, null]]);

  const c = setup();
  await c.mgr.start(ID, false);
  await c.mgr.signal({ from: ID, type: 'reject', callId: c.mgr.state.callId });
  assert.deepEqual(c.links.map((e) => e.outcome), ['declined']);

  const d = setup();
  await d.mgr.start(ID, false);
  await d.mgr.hangup(); // cancelled while ringing: the other person sees a missed call
  assert.deepEqual(d.links.map((e) => e.outcome), ['missed']);
});

test('no log event when nobody was rung or when you were the one being called', async () => {
  const denied = setup({ media: false });
  await denied.mgr.start(ID, false);
  assert.deepEqual(denied.links, []);

  const callee = setup();
  await callee.mgr.signal({ from: ID, type: 'invite', callId: 'a1a1a1a1a1a1a1a1' });
  await callee.mgr.accept();
  await callee.mgr.hangup();
  assert.deepEqual(callee.links, []);
});

/* A tiny network of several people, so a group call can be played through end to end. */
function network(names) {
  const people = {};
  const queue = [];
  for (const n of names) {
    const p = setup();
    people[n] = p;
    p.id = n.repeat(24).slice(0, 24);
    p.mgr.d.sendSignal = (s) => { p.sent.push(s); queue.push({ ...s, from: p.id }); };
  }
  const byId = Object.fromEntries(Object.values(people).map((p) => [p.id, p]));
  async function pump() {
    for (let i = 0; i < 200 && (queue.length || i < 3); i++) {
      while (queue.length) {
        const s = queue.shift();
        const target = byId[s.to];
        if (target) await target.mgr.signal(s);
      }
      await tick();
    }
  }
  const connect = (p, peerIndex = 0) => { const pc = p.pcs[peerIndex]; pc.connectionState = 'connected'; pc.onconnectionstatechange(); };
  return { people, pump, connect, byId };
}

test('group call: a person in a call adds a third, and the third connects to everyone', async () => {
  const net = network(['a', 'b', 'c']);
  const { a, b, c } = net.people;

  await a.mgr.start(b.id, false);
  await net.pump();
  await b.mgr.accept();
  await net.pump();
  net.connect(a, 0);
  net.connect(b, 0);
  assert.equal(a.mgr.state.phase, 'active');

  assert.equal(a.mgr.invite(c.id), true);
  await net.pump();
  assert.equal(c.mgr.state.phase, 'ringing');
  assert.equal(c.mgr.state.callId, a.mgr.state.callId); // the same call, so a group call
  await c.mgr.accept();
  await net.pump();

  // A tells B about C; B then connects to C directly without ringing, so everyone ends up with a link to everyone.
  assert.ok(b.sent.some((s) => s.type === 'offer' && s.to === c.id), 'B offers to C');
  assert.ok(a.sent.some((s) => s.type === 'joined' && s.to === b.id));
  assert.equal(c.mgr.links.size, 2);
  assert.equal(b.mgr.links.size, 2);
  assert.equal(a.mgr.links.size, 2);
  assert.equal(c.pcs.length, 2);
  assert.equal(b.pcs.length, 2);
  assert.equal(b.pcs[1].remoteDescription.sdp, 'ANSWER'); // B offered, C answered
  assert.equal(c.pcs[1].remoteDescription.sdp, 'OFFER');

  // Everything connects.
  net.connect(a, 1); net.connect(b, 1); net.connect(c, 0); net.connect(c, 1);
  assert.deepEqual(a.mgr.state.peers.map((p) => p.status), ['connected', 'connected']);
  assert.equal(c.mgr.state.phase, 'active');
});

test('group call: when one person leaves, the others stay in the call; the last one out ends it', async () => {
  const net = network(['a', 'b', 'c']);
  const { a, b, c } = net.people;
  await a.mgr.start(b.id, false); await net.pump(); await b.mgr.accept(); await net.pump();
  net.connect(a, 0); net.connect(b, 0);
  a.mgr.invite(c.id); await net.pump(); await c.mgr.accept(); await net.pump();
  net.connect(a, 1); net.connect(b, 1); net.connect(c, 0); net.connect(c, 1);

  await b.mgr.hangup();
  await net.pump();
  assert.equal(a.mgr.state.phase, 'active');
  assert.deepEqual(a.mgr.state.peers.map((p) => p.id), [c.id]);
  assert.equal(c.mgr.state.phase, 'active');

  await c.mgr.hangup();
  await net.pump();
  assert.equal(a.mgr.state.phase, 'ended');
  assert.equal(a.mgr.state.endReason, 'ended');
  // A rang both B and C, so A writes both call-log entries.
  assert.deepEqual(a.links.map((e) => [e.peerId, e.outcome]).sort(), [[b.id, 'ended'], [c.id, 'ended']].sort());
});

test('group call: an added person who declines or never answers only affects their own log', async () => {
  const net = network(['a', 'b', 'c']);
  const { a, b, c } = net.people;
  await a.mgr.start(b.id, false); await net.pump(); await b.mgr.accept(); await net.pump();
  net.connect(a, 0); net.connect(b, 0);
  a.mgr.invite(c.id); await net.pump();
  await c.mgr.reject(); await net.pump();
  assert.equal(a.mgr.state.phase, 'active'); // the call with B carries on
  assert.deepEqual(a.links.map((e) => [e.peerId, e.outcome]), [[c.id, 'declined']]);
  assert.equal(a.mgr.state.peers.length, 1);

  assert.equal(a.mgr.invite(c.id), true); // can be tried again
  a.fire(RING_MS); await tick();
  assert.equal(a.mgr.state.phase, 'active');
  assert.equal(a.links.at(-1).outcome, 'missed');
});

test('group call: the number of people is capped, and a person cannot be added twice', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  assert.equal(t.mgr.invite('c'.repeat(24)), false); // still ringing: nobody to add them through yet
  await t.mgr.signal({ from: ID, type: 'accept', callId: t.mgr.state.callId });
  assert.equal(t.mgr.invite(ID), false); // already in
  let ok = 0;
  for (let i = 0; i < 9; i++) if (t.mgr.invite(String(i).repeat(24).slice(0, 24))) ok++;
  assert.equal(ok, 4); // you + the first person + 4 more = 6 people
});

test('a direct link that never connects is dropped without ending the whole call', async () => {
  const net = network(['a', 'b', 'c']);
  const { a, b, c } = net.people;
  await a.mgr.start(b.id, false); await net.pump(); await b.mgr.accept(); await net.pump();
  net.connect(a, 0); net.connect(b, 0);
  a.mgr.invite(c.id); await net.pump(); await c.mgr.accept(); await net.pump();
  assert.equal(b.mgr.links.size, 2);
  b.fire(20000); // B and C cannot reach each other (for example, not allowed to chat)
  await tick();
  assert.equal(b.mgr.links.size, 1);
  assert.equal(b.mgr.state.phase, 'active');
});

test('starting a new call right after one ended is not cancelled by the old "call ended" timer', async () => {
  const t = setup();
  await t.mgr.start(ID, false);
  await t.mgr.hangup();
  await t.mgr.start(ID, false); // within the 2 seconds the old call lingers
  t.fire(2000);
  assert.equal(t.mgr.state?.phase, 'ringing');
});
