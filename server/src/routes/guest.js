import mongoose from 'mongoose';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import RequestedUser from '../models/RequestedUser.js';
import { normalizeTheme } from '../services/theme.js';
import User from '../models/User.js';
import { signToken, wrap } from '../middleware/auth.js';
import { notifyAdmin } from '../services/push.js';
import { checkRequestBody, checkIntro, isId, hashSecret, secretMatches, MAX_WAITING } from '../services/guest.js';

const { ObjectId } = mongoose.Types;

const publicGuest = (g) => ({
  id: String(g._id),
  name: g.name,
  publicKey: g.publicKey,
  role: 'guest',
  theme: normalizeTheme(g.theme),
  themeChosen: g.themeChosen === true,
});

/**
 * "Send message request" without an account. Three steps, all done by the browser:
 *   1. POST /request   name + keys made from a random secret   -> { id }
 *   2. POST /:id/intro the contact details and message, encrypted for the admin
 *   3. POST /login     (later) check whether the admin approved, and sign in once they have
 * The admin sees the request, and if approved, it turns into an ordinary private chat with the admin.
 */
export default function guestRouter(io) {
  const r = Router();

  // Anyone on the internet can reach this, so keep it tight: a few requests per hour per address.
  // (Each request is two calls: the account, then the message. So 12 calls = 6 requests.)
  const submitLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this network. Please try again later.' },
  });
  // Checking on a request (and logging in) happens often while someone waits, so allow more.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' },
  });

  r.post(
    '/request',
    submitLimiter,
    wrap(async (req, res) => {
      const v = checkRequestBody(req.body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      // Half-finished requests (step 1 without step 2) are cleared out after an hour.
      await RequestedUser.deleteMany({ introSent: false, createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) } });
      if ((await RequestedUser.countDocuments({ status: 'pending', introSent: true })) >= MAX_WAITING)
        return res.status(429).json({ error: 'Too many requests are waiting right now. Please try again later.' });

      const g = await RequestedUser.create({
        name: v.value.name,
        authHash: hashSecret(v.value.authSecret),
        publicKey: v.value.publicKey,
        encPrivateKey: v.value.encPrivateKey,
      });
      // The browser needs the admin's public key to encrypt the request for them.
      const admin = await User.findOne({ role: 'admin' }, 'publicKey').lean();
      if (!admin) {
        await RequestedUser.deleteOne({ _id: g._id });
        return res.status(503).json({ error: 'Message requests are not open yet.' });
      }
      res.status(201).json({ id: String(g._id), admin: { id: String(admin._id), publicKey: admin.publicKey } });
    })
  );

  // The request itself. Allowed once, only while pending, and only with the secret from step 1.
  r.post(
    '/:id/intro',
    submitLimiter,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!isId(id)) return res.status(400).json({ error: 'Bad id' });
      const intro = checkIntro(req.body);
      if (!intro.ok) return res.status(400).json({ error: intro.error });

      const g = await RequestedUser.findOne({ _id: id, status: 'pending', introSent: false }, 'authHash name').lean();
      if (!g || !secretMatches(req.body?.authSecret, g.authHash)) return res.status(404).json({ error: 'Request not found' });
      const admin = await User.findOne({ role: 'admin' }, '_id').lean();
      if (!admin) return res.status(503).json({ error: 'Message requests are not open yet.' });

      const msg = {
        _id: new ObjectId(),
        from: g._id,
        to: admin._id,
        peer: admin._id,
        iv: intro.value.iv,
        ct: intro.value.ct,
        createdAt: new Date(),
      };
      await RequestedUser.updateOne({ _id: id }, { $set: { introSent: true }, $push: { messages: msg } });
      io.to('admins').emit('request:new', { id, name: g.name });
      notifyAdmin(io, { t: 'admin', what: 'request', name: g.name });
      res.status(201).json({ ok: true });
    })
  );

  // Sign in (or find out whether you were approved yet).
  r.post(
    '/login',
    loginLimiter,
    wrap(async (req, res) => {
      const { id, authSecret } = req.body || {};
      if (!isId(id) || typeof authSecret !== 'string') return res.status(400).json({ error: 'Malformed credentials' });
      const g = await RequestedUser.findById(id, 'name publicKey authHash encPrivateKey status theme themeChosen').lean();
      if (!g || !secretMatches(authSecret, g.authHash)) return res.status(404).json({ error: 'This request no longer exists' });

      if (g.status === 'pending') return res.status(202).json({ pending: true, name: g.name });
      res.json({
        token: signToken(g._id, { guest: true }),
        user: publicGuest(g),
        encPrivateKey: { iv: g.encPrivateKey.iv, data: g.encPrivateKey.data },
      });
    })
  );

  return r;
}
