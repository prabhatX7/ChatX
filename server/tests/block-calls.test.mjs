import test from 'node:test';
import assert from 'node:assert/strict';
import { canChat, canSee, blockedBetween } from '../src/services/access.js';
import { cleanSignal } from '../src/services/calls.js';

const admin = { _id: 'a1', role: 'admin', group: null, status: 'active', blocked: [] };
const bob = { _id: 'b1', role: 'member', group: 'g1', status: 'active', blocked: [] };
const eve = { _id: 'e1', role: 'member', group: 'g1', status: 'active', blocked: [] };

test('without blocks nothing changes', () => {
  assert.equal(canChat(bob, eve), true);
  assert.equal(canChat(bob, admin), true);
});

test('a block works in both directions', () => {
  const bobBlocksEve = { ...bob, blocked: ['e1'] };
  assert.equal(blockedBetween(bobBlocksEve, eve), true);
  assert.equal(blockedBetween(eve, bobBlocksEve), true);
  assert.equal(canChat(bobBlocksEve, eve), false);
  assert.equal(canChat(eve, bobBlocksEve), false);
});

test('a block does not affect anyone else', () => {
  const bobBlocksEve = { ...bob, blocked: ['e1'] };
  assert.equal(canChat(bobBlocksEve, admin), true);
  assert.equal(canSee(bobBlocksEve, eve), true); // still allowed to see, so the blocker can unblock
});

test('anyone can block the admin and the admin can block anyone', () => {
  assert.equal(canChat({ ...bob, blocked: ['a1'] }, admin), false);
  assert.equal(canChat({ ...admin, blocked: ['b1'] }, bob), false);
});

test('objects without ids or block lists are never treated as blocked (old behaviour)', () => {
  assert.equal(blockedBetween({ role: 'member' }, { role: 'member' }), false);
  assert.equal(canChat({ role: 'member', group: 'g' }, { role: 'member', group: 'g' }), true);
});

test('block lists may hold ObjectId-like values', () => {
  const oid = { toString: () => 'e1' };
  assert.equal(canChat({ ...bob, blocked: [oid] }, eve), false);
});

const ID = 'a'.repeat(24);
const CALL = 'f'.repeat(16);

test('good call signals are accepted and cleaned', () => {
  assert.deepEqual(cleanSignal({ to: ID, type: 'invite', callId: CALL, video: true, junk: 1 }), {
    to: ID, type: 'invite', callId: CALL, video: true, data: null,
  });
  const offer = cleanSignal({ to: ID, type: 'offer', callId: CALL, data: { type: 'offer', sdp: 'v=0' } });
  assert.equal(offer.data.sdp, 'v=0');
  assert.equal(offer.video, false);
});

test('bad call signals are refused', () => {
  assert.equal(cleanSignal(null), null);
  assert.equal(cleanSignal({ to: 'x', type: 'invite', callId: CALL }), null);
  assert.equal(cleanSignal({ to: ID, type: 'hack', callId: CALL }), null);
  assert.equal(cleanSignal({ to: ID, type: 'invite', callId: 'no' }), null);
  assert.equal(cleanSignal({ to: ID, type: 'offer', callId: CALL }), null); // offers need data
  assert.equal(cleanSignal({ to: ID, type: 'ice', callId: CALL, data: 'str' }), null);
  assert.equal(cleanSignal({ to: ID, type: 'offer', callId: CALL, data: { sdp: 'x'.repeat(30000) } }), null);
});
