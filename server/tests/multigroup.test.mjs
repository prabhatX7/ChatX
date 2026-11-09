import test from 'node:test';
import assert from 'node:assert/strict';
import { canChat, canSee, groupIdsOf } from '../src/services/access.js';
import { cleanSignal } from '../src/services/calls.js';

const admin = { _id: 'a1', role: 'admin', status: 'active' };
const ann = { _id: 'n1', role: 'member', group: 'g1', status: 'active' };
const raj = { _id: 'r1', role: 'member', group: 'g2', status: 'active' };
const priv = { _id: 'p1', role: 'member', group: null, via: 'g9', status: 'active' };

test('people in different groups cannot see each other', () => {
  assert.equal(canSee(ann, raj), false);
});

test('joining another group by code makes you visible to its members, and keeps your own group', () => {
  const annPlus = { ...ann, extraGroups: ['g2'] };
  assert.equal(canChat(annPlus, raj), true);
  assert.equal(canChat(raj, annPlus), true);
  const sam = { _id: 's1', role: 'member', group: 'g1', status: 'active' };
  assert.equal(canChat(annPlus, sam), true); // still sees the old group
  assert.equal(canChat(sam, raj), false); // joining does not connect the two groups to each other
});

test('a private-chat person who joins a group keeps the private chat and gains the group', () => {
  const p = { ...priv, extraGroups: ['g2'] };
  assert.equal(canChat(p, admin), true);
  assert.equal(canChat(p, raj), true);
  assert.equal(canChat(p, ann), false);
  assert.equal(canChat(priv, raj), false);
});

test('a socket entry lists its groups in `groups`', () => {
  assert.equal(canChat({ _id: 'x', role: 'member', groups: ['g1', 'g2'] }, raj), true);
  assert.deepEqual(groupIdsOf({ group: 'g1', extraGroups: ['g1', 'g2'] }), ['g1', 'g2']);
  assert.deepEqual(groupIdsOf(null), []);
});

test('pending people stay invisible even if they have extra groups', () => {
  assert.equal(canSee({ ...ann, status: 'pending', extraGroups: ['g2'] }, raj), false);
});

const ID = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);
const CALL = 'f'.repeat(16);

test('group-call signal: "joined" needs a valid person who is not the receiver', () => {
  assert.equal(cleanSignal({ to: ID, type: 'joined', callId: CALL, who: ID2 }).who, ID2);
  assert.equal(cleanSignal({ to: ID, type: 'joined', callId: CALL }), null);
  assert.equal(cleanSignal({ to: ID, type: 'joined', callId: CALL, who: 'nope' }), null);
  assert.equal(cleanSignal({ to: ID, type: 'joined', callId: CALL, who: ID }), null);
  assert.equal(cleanSignal({ to: ID, type: 'roster', callId: CALL, ids: [ID2] }), null); // not a signal any more
});
