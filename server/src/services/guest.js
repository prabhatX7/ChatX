import crypto from 'node:crypto';

// Pure helpers for visitor ("message request") sign-ups, so they can be unit-tested without a database.

const HEX64 = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9+/=]+$/;
const OID = /^[a-f0-9]{24}$/;

export const MAX_WAITING = 200; // how many unanswered requests we keep before refusing new ones

/** Same shape check the normal sign-up uses for the public key. */
export function validPublicKey(s) {
  try {
    const k = JSON.parse(s);
    return k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && s.length < 400;
  } catch {
    return false;
  }
}

const cleanName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim() : '');

/** Validates the body of POST /api/guest/request. Returns { ok:true, value } or { ok:false, error }. */
export function checkRequestBody(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Bad request' };
  const name = cleanName(b.name);
  if (!name || name.length > 40) return { ok: false, error: 'Name must be 1–40 characters' };
  if (typeof b.authSecret !== 'string' || !HEX64.test(b.authSecret)) return { ok: false, error: 'Malformed credentials' };
  if (typeof b.publicKey !== 'string' || !validPublicKey(b.publicKey)) return { ok: false, error: 'Malformed public key' };
  const k = b.encPrivateKey;
  if (
    !k ||
    typeof k.iv !== 'string' ||
    typeof k.data !== 'string' ||
    !B64.test(k.iv) ||
    !B64.test(k.data) ||
    k.iv.length > 32 ||
    k.data.length > 2000
  )
    return { ok: false, error: 'Malformed key bundle' };
  return {
    ok: true,
    value: {
      name,
      authSecret: b.authSecret,
      publicKey: b.publicKey,
      encPrivateKey: { iv: k.iv, data: k.data },
    },
  };
}

/** The request itself: one encrypted blob holding the contact details and the message. */
export function checkIntro(b) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'Bad message' };
  if (typeof b.iv !== 'string' || b.iv.length > 32 || !B64.test(b.iv)) return { ok: false, error: 'Bad message' };
  if (typeof b.ct !== 'string' || b.ct.length < 16 || b.ct.length > 20000 || !B64.test(b.ct))
    return { ok: false, error: 'Bad message' };
  return { ok: true, value: { iv: b.iv, ct: b.ct } };
}

export const isId = (s) => typeof s === 'string' && OID.test(s);

export const hashSecret = (authSecret) => crypto.createHash('sha256').update(String(authSecret)).digest('hex');

export function secretMatches(authSecret, storedHash) {
  const a = Buffer.from(hashSecret(authSecret));
  const b = Buffer.from(String(storedHash || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
