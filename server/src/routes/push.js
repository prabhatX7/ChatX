import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { requireAuth, noGuests, wrap } from '../middleware/auth.js';
import { cleanSubscription, okEndpoint, pushPublicKey, pushReady, sendPush, MAX_SUBS } from '../services/push.js';

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many tries. Wait a minute.' } });

export default function pushRouter() {
  const r = Router();
  r.use(requireAuth, noGuests, limiter);

  // The public key the browser needs to subscribe.
  r.get('/key', (req, res) => res.json({ enabled: pushReady(), key: pushPublicKey() }));

  // Save this device. Calling it again with the same endpoint just refreshes it.
  r.post(
    '/subscribe',
    wrap(async (req, res) => {
      if (!pushReady()) return res.status(503).json({ error: 'Push notifications are not available on this server' });
      const s = cleanSubscription(req.body?.subscription);
      if (!s) return res.status(400).json({ error: 'Bad subscription' });
      await User.updateOne({ _id: req.userId }, { $pull: { pushSubs: { endpoint: s.endpoint } } });
      // Keep the newest devices if there are too many.
      await User.updateOne({ _id: req.userId }, { $push: { pushSubs: { $each: [s], $slice: -MAX_SUBS } } });
      res.json({ ok: true });
    })
  );

  r.post(
    '/unsubscribe',
    wrap(async (req, res) => {
      const endpoint = req.body?.endpoint;
      if (!okEndpoint(endpoint)) return res.status(400).json({ error: 'Bad endpoint' });
      await User.updateOne({ _id: req.userId }, { $pull: { pushSubs: { endpoint } } });
      res.json({ ok: true });
    })
  );

  // "Send me a test notification": lets you check that it works on this device.
  r.post(
    '/test',
    wrap(async (req, res) => {
      const sent = await sendPush(req.userId, { t: 'test' }, { ttl: 60 });
      res.json({ sent });
    })
  );

  return r;
}
