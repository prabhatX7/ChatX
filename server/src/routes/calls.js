import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth, noGuests } from '../middleware/auth.js';

const r = Router();

// The servers the browser uses to connect a call. Only for signed-in people.
r.get('/ice', requireAuth, noGuests, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (config.turn.url) {
    iceServers.push({ urls: config.turn.url, username: config.turn.username, credential: config.turn.credential });
  }
  res.json({ iceServers });
});

export default r;
