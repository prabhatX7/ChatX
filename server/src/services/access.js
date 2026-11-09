// Who may see and message whom. Pure functions with no database, so they are easy to test.
//
//  - The admin can see and message everyone who has been approved.
//  - Everyone can see and message the admin.
//  - Members can only see and message members of their own group(s): the group the admin approved them into, plus any
//    extra groups they joined themselves by entering a group code in Settings.
//  - A member with no group (a "private" one-to-one person) sees only the admin.
//  - Someone who is still waiting for approval is invisible to everyone and cannot message anyone.

export const isAdmin = (u) => Boolean(u) && u.role === 'admin';
export const isPending = (u) => Boolean(u) && u.status === 'pending';

/**
 * Every group a person is in, as strings: the main `group` plus `extraGroups` (or `groups`, the same list as kept on
 * a live socket). Ids may be strings or ObjectIds.
 */
export function groupIdsOf(u) {
  if (!u) return [];
  const all = [u.group, ...(u.extraGroups || []), ...(u.groups || [])].filter(Boolean).map(String);
  return [...new Set(all)];
}

/**
 * Groups and approval only (no blocking). `a` and `b` look like { role, group, extraGroups, status }.
 * Two members can see each other when they share at least one group.
 */
export function canSee(a, b) {
  if (!a || !b) return false;
  if (isPending(a) || isPending(b)) return false;
  if (isAdmin(a) || isAdmin(b)) return true;
  const mine = new Set(groupIdsOf(a));
  return groupIdsOf(b).some((id) => mine.has(id));
}

/** True when either person has blocked the other. Each side looks like { _id, blocked: [ids] }. */
export function blockedBetween(a, b) {
  if (!a || !b || a._id == null || b._id == null) return false;
  const has = (list, id) => Array.isArray(list) && list.some((x) => String(x) === String(id));
  return has(a.blocked, b._id) || has(b.blocked, a._id);
}

/** Full rule for messaging and calling: the groups rule, and nobody has blocked anybody. */
export function canChat(a, b) {
  return canSee(a, b) && !blockedBetween(a, b);
}
