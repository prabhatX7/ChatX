import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import ThemePicker from './ThemePicker.jsx';

// Settings: your colour, and (for members) the groups you are in, with a box to join another group by its code.
export default function SettingsDialog({ me, theme, onTheme, onClose }) {
  const isMember = me.role === 'member';
  const [groups, setGroups] = useState(null); // null = loading
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ kind: '', text: '' });

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!isMember) return undefined;
    let ok = true;
    api
      .myGroups()
      .then((r) => ok && setGroups(r.groups))
      .catch(() => ok && setGroups([]));
    return () => {
      ok = false;
    };
  }, [isMember]);

  async function join(e) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setNote({ kind: '', text: '' });
    try {
      const { group } = await api.joinGroup(code.trim());
      setGroups((g) => [...(g || []), group]);
      setCode('');
      setNote({ kind: 'ok', text: `You joined ${group.name}. Its members can now see you.` });
    } catch (err) {
      setNote({ kind: 'error', text: err.message || 'Could not join' });
    } finally {
      setBusy(false);
    }
  }

  async function leave(g) {
    setNote({ kind: '', text: '' });
    try {
      await api.leaveGroup(g.id);
      setGroups((list) => (list || []).filter((x) => x.id !== g.id));
    } catch (err) {
      setNote({ kind: 'error', text: err.message || 'Could not leave' });
    }
  }

  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
        <h3>Settings</h3>
        <p className="muted small-text">Signed in as {me.name}</p>

        <div className="section-label">Colour</div>
        <ThemePicker value={theme} onChange={onTheme} name="settings-theme" />

        {isMember && (
          <>
            <div className="section-label">Groups</div>
            {groups === null ? (
              <p className="hint">Loading…</p>
            ) : groups.length === 0 ? (
              <p className="hint">You are not in a group. You chat with the admin.</p>
            ) : (
              <ul className="group-list">
                {groups.map((g) => (
                  <li key={g.id}>
                    <span>📁 {g.name}</span>
                    {g.main ? (
                      <span className="role-badge">Main</span>
                    ) : (
                      <button className="link small-text" onClick={() => leave(g)}>
                        Leave
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form className="join-form" onSubmit={join}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter a group code"
                aria-label="Group code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
                {busy ? '…' : 'Join'}
              </button>
            </form>
            {note.text && (
              <p className={note.kind === 'error' ? 'error' : 'notice'} role={note.kind === 'error' ? 'alert' : 'status'}>
                {note.text}
              </p>
            )}
            <p className="hint">You stay in your current group or private chat. The new group's members will see you.</p>
          </>
        )}

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
