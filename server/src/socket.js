import { Server } from 'socket.io';
import { config } from './config.js';
import { verifyTokenFull } from './middleware/auth.js';
import { markDelivered } from './services/receipts.js';
import { canChat, isAdmin, groupIdsOf } from './services/access.js';
import { cleanSignal } from './services/calls.js';
import User from './models/User.js';
import RequestedUser from './models/RequestedUser.js';

const OID = /^[a-f0-9]{24}$/;
const ACTIVITY = new Set(['typing', 'speaking']);

export function createSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.clientOrigin },
    maxHttpBufferSize: 1e5, // sockets only carry tiny events; files go over HTTP
  });

  // userId -> { count, role, group, groups }. Role and groups are kept so we can decide who may see whom.
  const online = new Map();
  io.isOnline = (userId) => (online.get(String(userId))?.count || 0) > 0;

  // Rooms: user:<id> (one person, all their tabs), group:<id> (members of a group), admins (the admin).
  io.use(async (socket, next) => {
    try {
      const { id, guest } = verifyTokenFull(socket.handshake.auth?.token);
      // A visitor (message request) lives in its own collection; only approved ones may connect.
      const u = guest
        ? await RequestedUser.findById(id, 'role status').lean()
        : await User.findById(id, 'role group extraGroups status blocked').lean();
      if (!u || u.status === 'pending') return next(new Error('unauthorized'));
      // Everyone who has blocked you or been blocked by you (either direction), so we never relay between them.
      const blockers = (await User.find({ blocked: u._id }, '_id').lean()).map((b) => String(b._id));
      socket.userId = id;
      socket.meta = {
        _id: id,
        role: guest ? 'guest' : u.role || 'member',
        group: u.group ? String(u.group) : null,
        groups: groupIdsOf(u), // the main group plus any joined by code
        blocked: [...(u.blocked || []).map(String), ...blockers],
      };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // Online/offline is only announced to people who are allowed to see this person.
  function announce(userId, meta, isOnline) {
    const payload = { userId, online: isOnline };
    if (isAdmin(meta)) {
      io.emit('presence', payload); // everyone can see the admin
      return;
    }
    let target = io.to('admins');
    for (const g of meta.groups || []) target = target.to(`group:${g}`);
    target.emit('presence', payload);
  }

  io.on('connection', (socket) => {
    const id = socket.userId;
    const meta = socket.meta;

    socket.join(`user:${id}`);
    if (isAdmin(meta)) socket.join('admins');
    for (const g of meta.groups || []) socket.join(`group:${g}`);

    // Always take the latest role/group: it changes when the admin moves someone, and that person reconnects.
    const entry = online.get(id) || { count: 0 };
    Object.assign(entry, { count: entry.count + 1, ...meta });
    online.set(id, entry);
    announce(id, meta, true);

    // Only the people you may see, never the whole server's online list.
    const visible = [...online.entries()].filter(([uid, m]) => uid !== id && canChat(meta, { ...m, _id: uid })).map(([uid]) => uid);
    socket.emit('presence:list', visible);

    // Anything friends sent while you were away has now been delivered.
    markDelivered(io, id).catch((err) => console.error('markDelivered failed:', err.message));

    // "typing" / "speaking" hints. They are never stored, only relayed to the friend, and capped per connection.
    let budget = 30;
    const refill = setInterval(() => (budget = 30), 5000);
    socket.on('activity', (p) => {
      if (budget-- <= 0) return;
      if (!p || typeof p.to !== 'string' || !OID.test(p.to) || !ACTIVITY.has(p.kind)) return;
      const target = online.get(p.to);
      if (!target || !canChat(meta, { ...target, _id: p.to })) return; // only relay to someone you are allowed to talk to
      io.to(`user:${p.to}`).emit('activity', { from: id, kind: p.kind, on: p.on === true });
    });

    // Call signalling (invite / accept / reject / busy / end and the WebRTC offer, answer, ICE). Never stored.
    let callBudget = 150;
    const callRefill = setInterval(() => (callBudget = 150), 5000);
    socket.on('call:signal', (raw) => {
      if (callBudget-- <= 0) return;
      const p = cleanSignal(raw);
      if (!p || p.to === id) return;
      const target = online.get(p.to);
      // Visitors (message requests) can never call or be called.
      const noCalls = meta.role === 'guest' || target?.role === 'guest';
      if (!target || noCalls || !canChat(meta, { ...target, _id: p.to })) {
        // Not reachable (offline, not allowed or blocked). Only an invite needs an answer.
        if (p.type === 'invite') socket.emit('call:signal', { from: p.to, type: 'unavailable', callId: p.callId });
        return;
      }
      io.to(`user:${p.to}`).emit('call:signal', {
        from: id,
        type: p.type,
        callId: p.callId,
        video: p.video,
        data: p.data,
        ...(p.who ? { who: p.who } : {}),
      });
      // If I answer on one tab or device, stop ringing on my others.
      if (p.type === 'accept' || p.type === 'reject') {
        socket.to(`user:${id}`).emit('call:signal', { from: p.to, type: 'handled', callId: p.callId });
      }
    });

    socket.on('disconnect', () => {
      clearInterval(callRefill);
      clearInterval(refill);
      const e = online.get(id);
      if (!e) return;
      e.count -= 1;
      if (e.count <= 0) {
        online.delete(id);
        announce(id, meta, false);
      }
    });
  });

  return io;
}
