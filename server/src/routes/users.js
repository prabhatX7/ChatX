import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import Group from '../models/Group.js';
import User from '../models/User.js';
import RequestedUser from '../models/RequestedUser.js';
import { requireAuth, noGuests, wrap } from '../middleware/auth.js';
import { modelForCaller } from '../services/accounts.js';
import { THEMES, normalizeTheme } from '../services/theme.js';
import { isAdmin, groupIdsOf } from '../services/access.js';
import { normalizeCode } from '../services/codes.js';
import { mayChat, maySee } from '../services/pairs.js';
import { baseWire, adminWire, groupNames } from '../services/wire.js';

const OID = /^[a-f0-9]{24}$/;

// Trying codes is rate-limited, like sign-up.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tries. Wait a few minutes.' },
});

export default function usersRouter(io) {
  const r = Router();

  // The people YOU may see:
  //  - admin  -> everyone approved, each tagged with their group (folder)
  //  - member -> the admin, plus approved members of your own group. A member with no group sees only the admin.
  //              Nobody else is ever sent to your browser, and people still waiting for approval never appear.
  // `pinnedChats` is the list of friends you pinned to the top.
  r.get(
    '/',
    requireAuth,
    wrap(async (req, res) => {
      // A visitor (message request) sees the admin and nobody else.
      if (req.isGuest) {
        const guest = await RequestedUser.findById(req.userId, 'status theme').lean();
        if (!guest || guest.status !== 'active') return res.status(401).json({ error: 'Account not found' });
        const boss = await User.findOne({ role: 'admin', blocked: { $ne: guest._id } }, 'name publicKey role').lean();
        return res.json({
          users: boss ? [{ ...baseWire(boss), blocked: false }] : [],
          theme: normalizeTheme(guest.theme),
          pinnedChats: [],
        });
      }

      const me = await User.findById(req.userId, 'role group extraGroups pinnedChats blocked theme').lean();
      if (!me) return res.status(401).json({ error: 'Account not found' });
      const admin = isAdmin(me);
      const approved = { status: { $ne: 'pending' } };

      // People who blocked you vanish from your list (you are not told who). People you blocked stay, marked,
      // so you can unblock them.
      const blockers = (await User.find({ blocked: me._id }, '_id').lean()).map((b) => b._id);
      const mine = new Set((me.blocked || []).map(String));
      const notBlockers = { $nin: [me._id, ...blockers] };

      const myGroups = groupIdsOf(me);
      const filter = admin
        ? { _id: notBlockers, ...approved }
        : {
            _id: notBlockers,
            ...approved,
            // The admin, plus anyone who shares a group with me (my own group or an extra one I joined by code).
            $or: [
              { role: 'admin' },
              ...(myGroups.length ? [{ group: { $in: myGroups } }, { extraGroups: { $in: myGroups } }] : []),
            ],
          };

      const list = await User.find(filter, 'name publicKey role group extraGroups via').sort({ name: 1 }).lean();
      const names = admin ? await groupNames(list.flatMap((u) => [u.group, u.via, ...(u.extraGroups || [])])) : new Map();

      // The admin also sees approved visitors (people who used "Send message request"), shown in their own folder.
      const visitors = admin
        ? await RequestedUser.find({ status: 'active' }, 'name publicKey role').sort({ name: 1 }).lean()
        : [];

      res.json({
        // Only the admin is told which group someone is in.
        users: [...list, ...visitors].map((u) => ({
          ...(admin ? adminWire(u, names) : baseWire(u)),
          blocked: mine.has(String(u._id)),
        })),
        theme: normalizeTheme(me.theme),
        pinnedChats: (me.pinnedChats || []).map(String),
      });
    })
  );

  // Pin or unpin a chat in your own list (private to you, synced across your devices).
  r.put(
    '/pins/:peerId',
    requireAuth,
    noGuests,
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId) || peerId === req.userId) return res.status(400).json({ error: 'Bad id' });
      if (!(await mayChat(req.userId, peerId))) return res.status(404).json({ error: 'User not found' });

      const id = new mongoose.Types.ObjectId(peerId);
      await User.updateOne(
        { _id: req.userId },
        req.body?.pinned === true ? { $addToSet: { pinnedChats: id } } : { $pull: { pinnedChats: id } }
      );
      const me = await User.findById(req.userId, 'pinnedChats').lean();
      const pinnedChats = (me?.pinnedChats || []).map(String);
      io.to(`user:${req.userId}`).emit('chats:pinned', pinnedChats);
      res.json({ pinnedChats });
    })
  );

  // Block or unblock someone you can see. Blocking works both ways: neither of you can message or call the other,
  // and the blocked person no longer sees you in their list. Both people are told to refresh their view.
  r.put(
    '/block/:peerId',
    requireAuth,
    noGuests,
    wrap(async (req, res) => {
      const { peerId } = req.params;
      if (!OID.test(peerId) || peerId === req.userId) return res.status(400).json({ error: 'Bad id' });
      if (!(await maySee(req.userId, peerId))) return res.status(404).json({ error: 'User not found' });

      const id = new mongoose.Types.ObjectId(peerId);
      const block = req.body?.blocked === true;
      await User.updateOne({ _id: req.userId }, block ? { $addToSet: { blocked: id } } : { $pull: { blocked: id } });
      if (block) io.to(`user:${peerId}`).emit('call:signal', { from: req.userId, type: 'end', callId: '' });
      io.to(`user:${req.userId}`).to(`user:${peerId}`).emit('session:refresh');
      res.json({ ok: true, blocked: block });
    })
  );

  // The groups you are in: your main one plus any you joined with a code. (The admin has no groups of their own.)
  r.get(
    '/me/groups',
    requireAuth,
    noGuests,
    wrap(async (req, res) => {
      const me = await User.findById(req.userId, 'role group extraGroups').lean();
      if (!me) return res.status(401).json({ error: 'Account not found' });
      if (isAdmin(me)) return res.json({ groups: [], canJoin: false });
      const ids = groupIdsOf(me);
      const names = await groupNames(ids);
      res.json({
        canJoin: true,
        groups: ids.map((id) => ({ id, name: names.get(id) || 'Group', main: String(me.group || '') === id })),
      });
    })
  );

  // Join another group by entering its code. You keep your main group (or your private chat with the admin) and also
  // see the members of the new group, and they see you. Private codes cannot be used this way.
  r.post(
    '/me/groups',
    joinLimiter,
    requireAuth,
    noGuests,
    wrap(async (req, res) => {
      const code = normalizeCode(req.body?.code);
      const BAD = 'That code is not valid';
      if (!code) return res.status(400).json({ error: BAD });
      const me = await User.findById(req.userId, 'role group extraGroups status').lean();
      if (!me || me.status === 'pending') return res.status(401).json({ error: 'Account not found' });
      if (isAdmin(me)) return res.status(400).json({ error: 'The admin can already see every group' });

      const group = await Group.findOne({ code, active: true }, 'name private').lean();
      if (!group) return res.status(403).json({ error: BAD });
      if (group.private) return res.status(403).json({ error: 'That code is for one-to-one chats with the admin. It cannot be used to join a group.' });
      if (groupIdsOf(me).includes(String(group._id))) return res.status(409).json({ error: `You are already in ${group.name}` });

      await User.updateOne({ _id: req.userId }, { $addToSet: { extraGroups: group._id } });

      // Members of the new group get you in their list; your own sockets join the group's room.
      io.to(`group:${group._id}`).emit('users:changed');
      io.to(`user:${req.userId}`).emit('session:refresh');
      io.to('admins').emit('admin:changed');
      res.json({ ok: true, group: { id: String(group._id), name: group.name, main: false } });
    })
  );

  // Leave a group you joined with a code (your main group can only be changed by the admin).
  r.delete(
    '/me/groups/:id',
    requireAuth,
    noGuests,
    wrap(async (req, res) => {
      const { id } = req.params;
      if (!OID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const me = await User.findById(req.userId, 'group extraGroups').lean();
      if (!me) return res.status(401).json({ error: 'Account not found' });
      if (String(me.group || '') === id) return res.status(400).json({ error: 'Only the admin can change your main group' });
      await User.updateOne({ _id: req.userId }, { $pull: { extraGroups: new mongoose.Types.ObjectId(id) } });
      io.to(`group:${id}`).emit('users:changed');
      io.to(`user:${req.userId}`).emit('session:refresh');
      io.to('admins').emit('admin:changed');
      res.json({ ok: true });
    })
  );

  // Your colour: 'purple' or 'blue'. Saved on your account so it follows you (and marks the one-time colour popup as answered).
  r.put(
    '/me/theme',
    requireAuth,
    wrap(async (req, res) => {
      const theme = req.body?.theme;
      if (!THEMES.includes(theme)) return res.status(400).json({ error: 'Pick purple or blue' });
      await modelForCaller(req).updateOne({ _id: req.userId }, { theme, themeChosen: true });
      res.json({ theme });
    })
  );

  return r;
}
