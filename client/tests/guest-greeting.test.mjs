import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCredentials, createIdentity, unwrapIdentity, sharedKeyFor, encryptJson, decryptJson } from '../src/crypto.js';
import { GREETINGS, pickGreeting } from '../src/greetings.js';
import { normalizeTheme } from '../src/theme.js';

// ---- greetings ----

const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
};

test('there are plenty of greetings and they are all real sentences', () => {
  assert.ok(GREETINGS.length >= 30);
  assert.equal(new Set(GREETINGS).size, GREETINGS.length); // no duplicates
  for (const g of GREETINGS) assert.ok(g.length > 8 && g.length < 90, g);
  assert.ok(GREETINGS.includes('Hey beautiful, hope this will be your refreshing chatting time.'));
});

test('the same greeting is never shown twice in a row', () => {
  const store = fakeStore();
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const g = pickGreeting(() => 0.5, store); // a "random" source that would repeat forever
    assert.notEqual(g, prev);
    prev = g;
  }
});

test('different random values give a spread of greetings', () => {
  const store = fakeStore();
  const seen = new Set();
  for (let i = 0; i < GREETINGS.length; i++) seen.add(pickGreeting(() => i / GREETINGS.length, store));
  assert.ok(seen.size >= GREETINGS.length - 1);
});

test('greetings still work when storage is blocked', () => {
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
  assert.ok(GREETINGS.includes(pickGreeting(Math.random, broken)));
  assert.ok(GREETINGS.includes(pickGreeting(Math.random, null)));
});

// ---- colours ----

test('only "blue" switches the colour; anything else is purple', () => {
  assert.equal(normalizeTheme('blue'), 'blue');
  assert.equal(normalizeTheme('purple'), 'purple');
  assert.equal(normalizeTheme(undefined), 'purple');
  assert.equal(normalizeTheme('neon'), 'purple');
  assert.equal(normalizeTheme('<script>'), 'purple');
});

// ---- the visitor flow: the same crypto the contact page uses ----

test('a visitor encrypts the request for the admin; only the admin can read it', async () => {
  const secret = 'v'.repeat(32);
  const guest = await deriveCredentials('guest@chatx', secret);
  const guestId = await createIdentity(guest.wrapKey);

  const adminCreds = await deriveCredentials('admin@example.com', 'the admin password');
  const admin = await createIdentity(adminCreds.wrapKey);

  const GID = 'a'.repeat(24);
  const AID = 'b'.repeat(24);

  // visitor side
  const gKey = await sharedKeyFor(guestId.privateKey, AID, admin.publicKey);
  const sealed = await encryptJson(gKey, { k: 'text', text: 'Hi!\n\n(Contact: a@b.c)', msg: 'Hi!', contact: 'a@b.c' }, `${GID}>${AID}`);
  assert.ok(!sealed.ct.includes('Hi'));

  // admin side
  const aKey = await sharedKeyFor(admin.privateKey, GID, guestId.publicKey);
  const opened = await decryptJson(aKey, sealed.iv, sealed.ct, `${GID}>${AID}`);
  assert.equal(opened.msg, 'Hi!');
  assert.equal(opened.contact, 'a@b.c');

  // it cannot be replayed as if the admin had written it
  await assert.rejects(decryptJson(aKey, sealed.iv, sealed.ct, `${AID}>${GID}`));
});

test('the same secret always gives the visitor back their keys (this is how the saved link works)', async () => {
  const secret = 'w'.repeat(32);
  const first = await deriveCredentials('guest@chatx', secret);
  const identity = await createIdentity(first.wrapKey);
  const again = await deriveCredentials('guest@chatx', secret);
  assert.equal(again.authSecret, first.authSecret);
  const restored = await unwrapIdentity(again.wrapKey, identity.encPrivateKey);
  assert.ok(restored);

  const other = await deriveCredentials('guest@chatx', 'x'.repeat(32));
  assert.notEqual(other.authSecret, first.authSecret);
  await assert.rejects(unwrapIdentity(other.wrapKey, identity.encPrivateKey));
});

// ---- call signalling is encrypted with the pair key ----

test('call signals are readable only by the two people, and tied to one call and direction', async () => {
  const a = await createIdentity((await deriveCredentials('a@example.com', 'password one long')).wrapKey);
  const b = await createIdentity((await deriveCredentials('b@example.com', 'password two long')).wrapKey);
  const aKey = await sharedKeyFor(a.privateKey, 'B', b.publicKey);
  const bKey = await sharedKeyFor(b.privateKey, 'A', a.publicKey);

  const offer = { type: 'offer', sdp: 'v=0 a=fingerprint:sha-256 AA:BB' };
  const sealed = await encryptJson(aKey, offer, 'call:c0ffee00c0ffee00:A>B');
  assert.ok(!sealed.ct.includes('fingerprint'));
  assert.deepEqual(await decryptJson(bKey, sealed.iv, sealed.ct, 'call:c0ffee00c0ffee00:A>B'), offer);
  await assert.rejects(decryptJson(bKey, sealed.iv, sealed.ct, 'call:othercall00000000:A>B')); // other call
  await assert.rejects(decryptJson(bKey, sealed.iv, sealed.ct, 'call:c0ffee00c0ffee00:B>A')); // wrong direction
});
