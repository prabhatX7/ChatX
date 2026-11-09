import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Admin only: create groups (folders), each with its own sign-up code, and see who is in each one.
 * Members of a group only ever see each other plus the admin. Chats stay end-to-end encrypted, so the admin can
 * message anyone but cannot read other people's conversations.
 */
export default function AdminPanel({
  ask,
  online,
  onOpenChat,
  onClose,
  refreshKey,
  pending = [],
  requests = [], // message requests from visitors without an account
  visitors = [], // approved visitors
  openRequest, // async (request) -> { msg, contact } decrypted in this browser
  onChanged,
}) {
  const [groups, setGroups] = useState(null); // null while loading
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(''); // group id, or 'new'
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState(null); // { id, value }
  const [isPrivate, setIsPrivate] = useState(false); // create form: one-to-one code
  const [privateOthers, setPrivateOthers] = useState([]); // approved people who are in no group
  const [choice, setChoice] = useState({}); // pending id -> '' (as requested) | 'none' | group id
  const [opened, setOpened] = useState({}); // request id -> { msg, contact } | { error }
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const { groups: list, privateOthers: others } = await api.adminGroups();
      setGroups(list);
      setPrivateOthers(others || []);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load the groups');
    }
  }, []);

  // Reload when the panel opens and whenever someone new joins.
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  // Open each message request (decrypts it here; the server only holds ciphertext).
  useEffect(() => {
    let ok = true;
    for (const r of requests) {
      if (opened[r.id]) continue;
      Promise.resolve(openRequest(r))
        .then((v) => ok && setOpened((o) => ({ ...o, [r.id]: v })))
        .catch(() => ok && setOpened((o) => ({ ...o, [r.id]: { error: 'Could not decrypt this request' } })));
    }
    return () => {
      ok = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, openRequest]);

  async function run(id, job) {
    setBusy(id);
    try {
      await job();
      setError('');
    } catch (e) {
      setError(e.message || 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  const replace = (g) => setGroups((prev) => (prev || []).map((x) => (x.id === g.id ? g : x)));

  function create(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    run('new', async () => {
      const g = await api.createGroup(name, isPrivate);
      setGroups((prev) => [...(prev || []), g]);
      setNewName('');
      setIsPrivate(false);
    });
  }

  const patch = (g, body) => run(g.id, async () => replace(await api.updateGroup(g.id, body)));

  function saveName(g) {
    const value = (editing?.value || '').trim();
    setEditing(null);
    if (value && value !== g.name) patch(g, { name: value });
  }

  function askNewCode(g) {
    ask(
      {
        title: `Make a new code for "${g.name}"?`,
        body: 'The current code stops working immediately. People who are already in the group stay in it.',
        confirmLabel: 'New code',
        danger: true,
      },
      () => patch(g, { regenerate: true })
    );
  }

  function askDelete(g) {
    ask(
      {
        title: `Delete the group "${g.name}"?`,
        body: 'It has no members, so nobody is affected. Its code stops working.',
        confirmLabel: 'Delete group',
        danger: true,
      },
      () =>
        run(g.id, async () => {
          await api.deleteGroup(g.id);
          setGroups((prev) => (prev || []).filter((x) => x.id !== g.id));
        })
    );
  }

  const sharedGroups = (groups || []).filter((g) => !g.private);

  // body for the approve call: {} = as requested, { group: null } = only me, { group: id } = that group
  function approve(p) {
    const c = choice[p.id] || '';
    const body = c === '' ? {} : c === 'none' ? { group: null } : { group: c };
    run(`p:${p.id}`, async () => {
      await api.approveUser(p.id, body);
      onChanged?.();
      await load();
    });
  }

  function askReject(p) {
    ask(
      {
        title: `Reject ${p.name}?`,
        body: 'Their request is deleted. They can sign up again with a code if you let them.',
        confirmLabel: 'Reject',
        danger: true,
      },
      () =>
        run(`p:${p.id}`, async () => {
          await api.rejectUser(p.id);
          onChanged?.();
        })
    );
  }

  function approveRequest(r) {
    run(`r:${r.id}`, async () => {
      await api.approveRequest(r.id);
      onChanged?.();
    });
  }

  function askRejectRequest(r) {
    ask(
      {
        title: `Decline the request from ${r.name}?`,
        body: 'The request is deleted and they are told it is no longer open.',
        confirmLabel: 'Decline',
        danger: true,
      },
      () =>
        run(`r:${r.id}`, async () => {
          await api.rejectRequest(r.id);
          onChanged?.();
        })
    );
  }

  function askRemoveVisitor(v) {
    ask(
      {
        title: `Remove ${v.name}?`,
        body: 'Their access and their copy of the chat are deleted. Your own copy of the chat stays.',
        confirmLabel: 'Remove',
        danger: true,
      },
      () =>
        run(`r:${v.id}`, async () => {
          await api.removeVisitor(v.id);
          onChanged?.();
        })
    );
  }

  function move(m, value) {
    run(`m:${m.id}`, async () => {
      await api.moveMember(m.id, value === 'none' ? null : value);
      onChanged?.();
      await load();
    });
  }

  function MoveSelect({ m, current }) {
    return (
      <select
        className="move-select"
        value=""
        disabled={busy === `m:${m.id}`}
        aria-label={`Move ${m.name}`}
        onChange={(e) => e.target.value && move(m, e.target.value)}
      >
        <option value="">Move…</option>
        {current !== 'none' && <option value="none">Only me (private)</option>}
        {sharedGroups
          .filter((x) => x.id !== current)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </select>
    );
  }

  async function copy(g) {
    try {
      await navigator.clipboard.writeText(g.display);
      setCopied(g.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Could not copy. Select the code and copy it by hand.');
    }
  }

  return (
    <section className="chat admin-panel">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onClose} aria-label="Back to chats">
          ←
        </button>
        <div className="avatar">★</div>
        <div className="head-text">
          <div className="peer-name">Groups &amp; codes</div>
          <div className="muted small-text">You are the admin</div>
        </div>
      </header>

      <div className="admin-body">
        <p className="muted admin-note">
          Each group has its own code. People who join with it see each other and you. A <strong>private</strong> code
          makes one-to-one chats with you only. New sign-ups wait below until you approve them.
        </p>

        {requests.length > 0 && (
          <article className="group-card pending-card">
            <div className="group-head">
              <h3 className="group-name">Message requests ({requests.length})</h3>
              <span className="status-chip private">No account</span>
            </div>
            <ul className="pending-list">
              {requests.map((r) => {
                const o = opened[r.id];
                return (
                  <li key={r.id} className="pending-row">
                    <div className="pending-who">
                      <span className="user-name">{r.name}</span>
                      {!o && <span className="muted small-text">Decrypting…</span>}
                      {o?.error && <span className="muted small-text">⚠ {o.error}</span>}
                      {o?.contact && <span className="muted small-text">Contact: {o.contact}</span>}
                      {o?.msg && <p className="request-msg">{o.msg}</p>}
                    </div>
                    <div className="pending-actions">
                      <button className="btn small primary" disabled={busy === `r:${r.id}`} onClick={() => approveRequest(r)}>
                        Approve (private chat)
                      </button>
                      <button className="btn small danger" disabled={busy === `r:${r.id}`} onClick={() => askRejectRequest(r)}>
                        Decline
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </article>
        )}

        {pending.length > 0 && (
          <article className="group-card pending-card">
            <div className="group-head">
              <h3 className="group-name">Waiting for approval ({pending.length})</h3>
            </div>
            <ul className="pending-list">
              {pending.map((p) => (
                <li key={p.id} className="pending-row">
                  <div className="pending-who">
                    <span className="user-name">{p.name}</span>
                    <span className="muted small-text">{p.email}</span>
                    <span className="muted small-text">
                      Used code: {p.requested ? `${p.requested.name}${p.requested.private ? ' (private)' : ''}` : 'none'}
                    </span>
                  </div>
                  <select
                    className="move-select"
                    value={choice[p.id] || ''}
                    onChange={(e) => setChoice((c) => ({ ...c, [p.id]: e.target.value }))}
                    aria-label={`Where to put ${p.name}`}
                  >
                    <option value="">
                      {p.requested
                        ? p.requested.private
                          ? `Only me, via ${p.requested.name}`
                          : `Group: ${p.requested.name}`
                        : 'Only me (private)'}
                    </option>
                    <option value="none">Only me (private)</option>
                    {sharedGroups
                      .filter((x) => x.id !== p.requested?.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          Group: {x.name}
                        </option>
                      ))}
                  </select>
                  <div className="pending-actions">
                    <button className="btn small primary" disabled={busy === `p:${p.id}`} onClick={() => approve(p)}>
                      Approve
                    </button>
                    <button className="btn small danger" disabled={busy === `p:${p.id}`} onClick={() => askReject(p)}>
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </article>
        )}

        <form className="new-group" onSubmit={create}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            placeholder="New group name, e.g. Family"
            aria-label="New group name"
          />
          <label className="check">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            <span>Private (one-to-one with me)</span>
          </label>
          <button className="btn primary" type="submit" disabled={!newName.trim() || busy === 'new'}>
            Create group
          </button>
        </form>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {groups === null && !error && <p className="hint center">Loading…</p>}
        {groups && groups.length === 0 && (
          <p className="hint center">No groups yet. Create one to get a code you can give to people.</p>
        )}

        <div className="group-list">
          {(groups || []).map((g) => (
            <article key={g.id} className={`group-card ${g.active ? '' : 'closed'}`}>
              <div className="group-head">
                {editing?.id === g.id ? (
                  <input
                    className="rename"
                    autoFocus
                    value={editing.value}
                    maxLength={40}
                    onChange={(e) => setEditing({ id: g.id, value: e.target.value })}
                    onBlur={() => saveName(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveName(g);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    aria-label="Group name"
                  />
                ) : (
                  <h3 className="group-name">
                    {g.name}
                    <button
                      className="icon-btn"
                      title="Rename group"
                      aria-label={`Rename ${g.name}`}
                      onClick={() => setEditing({ id: g.id, value: g.name })}
                    >
                      ✎
                    </button>
                  </h3>
                )}
                {g.private && <span className="status-chip private">Private</span>}
                <span className={`status-chip ${g.active ? 'open' : ''}`}>{g.active ? 'Open for sign-ups' : 'Closed'}</span>
              </div>

              <div className="code-row">
                <code className="group-code">{g.display}</code>
                <button className="btn small" onClick={() => copy(g)}>
                  {copied === g.id ? 'Copied ✓' : 'Copy'}
                </button>
              </div>

              <div className="group-actions">
                <button className="btn small" disabled={busy === g.id} onClick={() => patch(g, { active: !g.active })}>
                  {g.active ? 'Close code' : 'Reopen code'}
                </button>
                <button className="btn small" disabled={busy === g.id} onClick={() => askNewCode(g)}>
                  New code
                </button>
                {g.members.length === 0 && (
                  <button className="btn small danger" disabled={busy === g.id} onClick={() => askDelete(g)}>
                    Delete
                  </button>
                )}
              </div>

              <div className="section-label">Members ({g.members.length})</div>
              {g.members.length === 0 ? (
                <p className="hint">Nobody has joined with this code yet.</p>
              ) : (
                <ul className="member-list">
                  {g.members.map((m) => (
                    <li key={m.id}>
                      <button className="member" onClick={() => onOpenChat(m.id)} title={`Open chat with ${m.name}`}>
                        <span className={`dot ${online.has(m.id) ? 'on' : ''}`} />
                        <span className="user-name">{m.name}</span>
                        <span className="muted small-text">Message</span>
                      </button>
                      <MoveSelect m={m} current={g.private ? 'none' : g.id} />
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>

        {visitors.length > 0 && (
          <article className="group-card">
            <div className="group-head">
              <h3 className="group-name">Message requests you approved</h3>
              <span className="muted small-text">Text, voice and pictures only</span>
            </div>
            <ul className="member-list">
              {visitors.map((v) => (
                <li key={v.id}>
                  <button className="member" onClick={() => onOpenChat(v.id)} title={`Open chat with ${v.name}`}>
                    <span className={`dot ${online.has(v.id) ? 'on' : ''}`} />
                    <span className="user-name">{v.name}</span>
                    <span className="muted small-text">Message</span>
                  </button>
                  <button className="btn small danger" disabled={busy === `r:${v.id}`} onClick={() => askRemoveVisitor(v)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </article>
        )}

        {privateOthers.length > 0 && (
          <article className="group-card">
            <div className="group-head">
              <h3 className="group-name">Private chats (only you)</h3>
            </div>
            <ul className="member-list">
              {privateOthers.map((m) => (
                <li key={m.id}>
                  <button className="member" onClick={() => onOpenChat(m.id)} title={`Open chat with ${m.name}`}>
                    <span className={`dot ${online.has(m.id) ? 'on' : ''}`} />
                    <span className="user-name">{m.name}</span>
                    <span className="muted small-text">Message</span>
                  </button>
                  <MoveSelect m={m} current="none" />
                </li>
              ))}
            </ul>
          </article>
        )}
      </div>
    </section>
  );
}
