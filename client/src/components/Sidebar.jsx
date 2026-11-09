import { useState } from 'react';
import { askPermission, notificationPermission } from '../notify.js';
import { ActivityLabel } from './Ticks.jsx';
import Logo from './Logo.jsx';

export default function Sidebar({
  me,
  users,
  online,
  unread,
  activity,
  pinnedChats,
  active,
  view,
  pendingCount = 0,
  onOpenSettings,
  onOpen,
  onOpenAdmin,
  onTogglePin,
  onDeleteChat,
  onLogout,
}) {
  const [perm, setPerm] = useState(notificationPermission());
  const iAmAdmin = me.role === 'admin';
  const iAmGuest = me.role === 'guest';

  // Pinned chats float to the top, then the admin, then everyone else (alphabetical, as sent by the server).
  const pinnedSet = new Set(pinnedChats);
  const rank = (u) => (u.role === 'admin' ? 0 : 1);
  const sortFn = (a, b) => Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id)) || rank(a) - rank(b);
  const sorted = [...users].sort(sortFn);

  // Everyone gets one plain list of conversations. The admin ALSO gets a folder for each real group, below it; a person
  // who is in two groups appears in both folders. One-to-one people (private codes, message requests) are never put in a
  // folder: they are just conversations in the plain list.
  let plain = sorted;
  let folders = [];
  if (iAmAdmin) {
    const byGroup = new Map();
    plain = [];
    for (const u of sorted) {
      const groups = u.role === 'member' || !u.role ? [u.group, ...(u.extra || [])].filter(Boolean) : [];
      if (!groups.length) {
        plain.push(u);
        continue;
      }
      for (const g of groups) {
        if (!byGroup.has(g.id)) byGroup.set(g.id, { key: g.id, label: g.name, users: [] });
        byGroup.get(g.id).users.push(u);
      }
    }
    folders = [...byGroup.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  function renderUser(u) {
    const isPinned = pinnedSet.has(u.id);
    const act = activity[u.id];
    return (
      <li key={u.id} className="user-row">
        <button className={`user-item ${view === 'chat' && active === u.id ? 'active' : ''}`} onClick={() => onOpen(u.id)}>
          <span className={`dot ${online.has(u.id) ? 'on' : ''}`} title={online.has(u.id) ? 'online' : 'offline'} />
          <span className="user-text">
            <span className="user-name">
              {u.name}
              {u.role === 'admin' && <span className="role-badge">Admin</span>}
              {u.role === 'guest' && <span className="role-badge">Request</span>}
              {u.blocked && <span className="role-badge blocked-badge">Blocked</span>}
            </span>
            {act && (
              <span className="user-sub small-text">
                <ActivityLabel kind={act} short />
              </span>
            )}
          </span>
          {isPinned && (
            <span className="pin-mark" title="Pinned chat">
              📌
            </span>
          )}
          {unread[u.id] > 0 && <span className="badge">{unread[u.id]}</span>}
        </button>
        <div className="row-actions">
          {!iAmGuest && (
          <button
            className="icon-btn"
            title={isPinned ? 'Unpin chat' : 'Pin chat to top'}
            aria-label={isPinned ? `Unpin chat with ${u.name}` : `Pin chat with ${u.name}`}
            onClick={() => onTogglePin(u.id)}
          >
            📌
          </button>
          )}
          <button
            className="icon-btn"
            title="Delete chat"
            aria-label={`Delete chat with ${u.name}`}
            onClick={() => onDeleteChat(u)}
          >
            🗑
          </button>
        </div>
      </li>
    );
  }

  return (
    <aside className="sidebar">
      <div className="side-head">
        <Logo />
        <span className="side-head-actions">
          <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            ⚙
          </button>
          <button className="btn small" onClick={onLogout}>
            Log out
          </button>
        </span>
      </div>

      <div className="me-card">
        <div className="avatar">{me.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="me-name">
            {me.name}
            {iAmAdmin && <span className="role-badge">Admin</span>}
          </div>
          <div className="muted small-text">🔒 end-to-end encrypted</div>
        </div>
      </div>

      {iAmAdmin && (
        <button className={`btn wide admin-btn ${view === 'admin' ? 'on' : ''}`} onClick={onOpenAdmin}>
          🗂 Groups &amp; codes
          {pendingCount > 0 && <span className="badge nav-badge">{pendingCount}</span>}
        </button>
      )}

      {perm === 'default' && (
        <button className="btn wide perm-note" onClick={async () => setPerm(await askPermission())}>
          🔔 Turn on pop-ups
        </button>
      )}
      {perm === 'denied' && (
        <p className="hint perm-note">🔕 Pop-ups are blocked in your browser settings.</p>
      )}

      <div className="section-label">Chats</div>
      <ul className="user-list">
        {users.length === 0 && (
          <li className="hint">
            {iAmAdmin
              ? 'Nobody has joined yet. Open "Groups & codes", make a group and give its code to people.'
              : 'Nobody else is in your group yet.'}
          </li>
        )}
        {plain.map(renderUser)}
        {folders.map((f) => (
          <li key={f.key} className="folder">
            <div className="folder-label">
              <span>📁 {f.label}</span>
              <span className="muted small-text">{f.users.length}</span>
            </div>
            <ul className="folder-list">{f.users.map(renderUser)}</ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}
