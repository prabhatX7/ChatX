import { canChat, canSee } from './access.js';
import { findAccount } from './accounts.js';

// Both people are looked up fresh from the database (users and approved visitors alike).
async function pair(userId, peerId) {
  if (String(userId) === String(peerId)) return null;
  const [a, b] = await Promise.all([
    findAccount(userId, 'role group extraGroups status blocked'),
    findAccount(peerId, 'role group extraGroups status blocked'),
  ]);
  return a && b ? [a, b] : null;
}

/** True when `userId` is allowed to see and message `peerId`. */
export async function mayChat(userId, peerId) {
  const p = await pair(userId, peerId);
  return p ? canChat(p[0], p[1]) : false;
}

/** Like mayChat but ignores blocks. Used to decide whether you may block or unblock someone you can see. */
export async function maySee(userId, peerId) {
  const p = await pair(userId, peerId);
  return p ? canSee(p[0], p[1]) : false;
}
