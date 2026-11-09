import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequestBody, checkIntro, hashSecret, secretMatches, isId } from '../src/services/guest.js';
import { canChat } from '../src/services/access.js';

const key = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' });
const good = {
  name: '  Sita   Rai ',
  authSecret: 'a'.repeat(64),
  publicKey: key,
  encPrivateKey: { iv: 'QUJD', data: 'QUJDRA==' },
};

test('a good request is cleaned up and accepted', () => {
  const r = checkRequestBody(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.name, 'Sita Rai');
  assert.equal('theme' in r.value, false); // the colour is asked after the first login, not on the form
});

test('bad requests are refused', () => {
  assert.equal(checkRequestBody(null).ok, false);
  assert.equal(checkRequestBody({ ...good, name: '   ' }).ok, false);
  assert.equal(checkRequestBody({ ...good, name: 'x'.repeat(41) }).ok, false);
  assert.equal(checkRequestBody({ ...good, name: { $gt: '' } }).ok, false);
  assert.equal(checkRequestBody({ ...good, authSecret: 'short' }).ok, false);
  assert.equal(checkRequestBody({ ...good, publicKey: '{"kty":"RSA"}' }).ok, false);
  assert.equal(checkRequestBody({ ...good, publicKey: 'not json' }).ok, false);
  assert.equal(checkRequestBody({ ...good, encPrivateKey: { iv: '!!', data: 'QQ==' } }).ok, false);
  assert.equal(checkRequestBody({ ...good, encPrivateKey: null }).ok, false);
});

test('the intro must be base64 and a sensible size', () => {
  assert.equal(checkIntro({ iv: 'QUJD', ct: 'A'.repeat(40) }).ok, true);
  assert.equal(checkIntro({ iv: 'QUJD', ct: 'tiny' }).ok, false);
  assert.equal(checkIntro({ iv: 'QUJD', ct: 'A'.repeat(30000) }).ok, false);
  assert.equal(checkIntro({ iv: '<script>', ct: 'A'.repeat(40) }).ok, false);
  assert.equal(checkIntro(undefined).ok, false);
});

test('the secret is checked against its hash', () => {
  const secret = 'b'.repeat(64);
  const h = hashSecret(secret);
  assert.equal(secretMatches(secret, h), true);
  assert.equal(secretMatches('c'.repeat(64), h), false);
  assert.equal(secretMatches(undefined, h), false);
  assert.equal(secretMatches(secret, undefined), false);
});

test('ids are 24 hex characters', () => {
  assert.equal(isId('a'.repeat(24)), true);
  assert.equal(isId('a'.repeat(23)), false);
  assert.equal(isId({}), false);
});

// ---- who a visitor can reach ----
const admin = { _id: 'a1', role: 'admin', status: 'active', blocked: [] };
const member = { _id: 'm1', role: 'member', group: 'g1', status: 'active', blocked: [] };
const visitor = { _id: 'v1', role: 'guest', status: 'active' };
const visitor2 = { _id: 'v2', role: 'guest', status: 'active' };
const waiting = { _id: 'v3', role: 'guest', status: 'pending' };

test('a visitor can chat with the admin only', () => {
  assert.equal(canChat(visitor, admin), true);
  assert.equal(canChat(admin, visitor), true);
  assert.equal(canChat(visitor, member), false);
  assert.equal(canChat(member, visitor), false);
  assert.equal(canChat(visitor, visitor2), false);
});

test('a visitor still waiting for approval can chat with nobody', () => {
  assert.equal(canChat(waiting, admin), false);
  assert.equal(canChat(admin, waiting), false);
});

test('the admin can block a visitor', () => {
  assert.equal(canChat({ ...admin, blocked: ['v1'] }, visitor), false);
});
