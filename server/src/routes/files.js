import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { modelForCaller } from '../services/accounts.js';
import { config } from '../config.js';
import { requireAuth, wrap } from '../middleware/auth.js';

const FILE_ID = /^[a-f0-9]{32}$/;

// Files arrive already encrypted by the sender's browser; the server stores opaque bytes
// under a random id (no name, no type, no extension).
const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});
const upload = multer({
  storage,
  limits: { fileSize: config.maxFileMB * 1024 * 1024 + 1024, files: 1 }, // +1 KB for the GCM tag
});

// People who used "Send message request" only send short voice notes and pictures, so their uploads are capped lower.
const GUEST_MAX_MB = 10;
const guestUpload = multer({ storage, limits: { fileSize: GUEST_MAX_MB * 1024 * 1024 + 1024, files: 1 } });

const r = Router();
r.use(requireAuth);

r.post(
  '/',
  (req, res, next) => {
    (req.isGuest ? guestUpload : upload).single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE' && req.isGuest) {
        return res.status(413).json({ error: `File too large (max ${GUEST_MAX_MB} MB)` });
      }
      next(err);
    });
  },
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.status(201).json({ fileId: req.file.filename });
  }
);

// Only a participant of a message that references the file may download it.
r.get(
  '/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!FILE_ID.test(id)) return res.status(400).json({ error: 'Bad id' });
    const allowed = await modelForCaller(req).exists({ _id: req.userId, 'messages.fileId': id });
    if (!allowed) return res.status(404).json({ error: 'Not found' });

    res.set({
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.sendFile(path.join(config.uploadDir, id));
  })
);

export default r;
