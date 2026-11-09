import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// `guest` marks a visitor (see models/RequestedUser.js): their id lives in a different collection.
export function signToken(userId, { guest = false } = {}) {
  return jwt.sign({ sub: String(userId), ...(guest ? { guest: true } : {}) }, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret).sub;
}

/** Like verifyToken but also says whether this is a visitor. */
export function verifyTokenFull(token) {
  const p = jwt.verify(token, config.jwtSecret);
  return { id: p.sub, guest: p.guest === true };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const t = verifyTokenFull(token);
    req.userId = t.id;
    req.isGuest = t.guest;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

// For routes visitors must not use (blocking, calls, pins, groups).
export function noGuests(req, res, next) {
  if (req.isGuest) return res.status(403).json({ error: 'Not available for message requests' });
  next();
}

// Express 4 does not catch rejected promises in async handlers; this does.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
