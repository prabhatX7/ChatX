import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_PEOPLE, REASONS } from '../call.js';

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// Plays a MediaStream in an element (React cannot set srcObject through props).
function useStream(ref, stream) {
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream || null;
  }, [ref, stream]);
}

// One person in the call. The <video> is always there (it carries the sound too), it is only drawn when there is a picture.
function Tile({ peer, name, video }) {
  const ref = useRef(null);
  useStream(ref, peer.stream);
  const live = video && peer.status === 'connected' && peer.stream;
  return (
    <div className={`call-tile ${live ? 'live' : ''}`}>
      <video ref={ref} className="call-remote" autoPlay playsInline />
      {!live && (
        <div className="call-center">
          <div className={`call-avatar ${peer.status !== 'connected' ? 'pulse' : ''}`}>{name.slice(0, 1).toUpperCase()}</div>
        </div>
      )}
      <div className="call-tile-name">
        {name}
        {peer.status === 'ringing' && <span className="muted small-text"> · ringing…</span>}
        {peer.status === 'connecting' && <span className="muted small-text"> · connecting…</span>}
      </div>
    </div>
  );
}

/**
 * The call screen: ringing, connecting, live (audio or video, one person or several) and the brief "call ended".
 * While a call is live it can be minimised, so you can go back to your chats and keep talking.
 */
export default function CallOverlay({
  call,
  nameOf, // id -> name
  addable = [], // people who can be added to the call: [{ id, name }]
  minimized,
  onMinimize,
  onExpand,
  onAccept,
  onReject,
  onHangup,
  onMute,
  onCamera,
  onFlip,
  onAdd,
}) {
  const localRef = useRef(null);
  const [secs, setSecs] = useState(0);
  const [adding, setAdding] = useState(false);

  useStream(localRef, call?.localStream);

  useEffect(() => {
    if (call?.phase !== 'active' || !call.startedAt) {
      setSecs(0);
      return undefined;
    }
    const tick = () => setSecs(Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [call?.phase, call?.startedAt]);

  useEffect(() => {
    if (!call || call.phase === 'ended') setAdding(false);
  }, [call]);

  if (!call) return null;

  const incoming = call.dir === 'in';
  const ringing = call.phase === 'ringing';
  const ended = call.phase === 'ended';
  const live = !ended && !ringing;
  const mini = Boolean(minimized) && live; // a ringing or finished call is always shown in full
  const peers = call.peers || [];
  const names = peers.map((p) => nameOf(p.id));
  const title = ended
    ? names[0] || nameOf(call.peerId)
    : peers.length > 1
      ? `Group call · ${peers.length + 1} people`
      : names[0] || nameOf(call.peerId);
  const anyVideo = call.video && peers.some((p) => p.status === 'connected' && p.stream);

  let status;
  if (ended) status = REASONS[call.endReason] || 'Call ended';
  else if (ringing) status = incoming ? `Incoming ${call.video ? 'video' : 'audio'} call…` : 'Calling…';
  else if (call.phase === 'connecting') status = 'Connecting…';
  else status = fmt(secs);

  const canAdd = live; // anyone in the call may add people
  const room = peers.length + 1 < MAX_PEOPLE;
  const tiles = peers.length ? peers : ringing && incoming ? [{ id: call.peerId, status: 'ringing', stream: null }] : [];

  return createPortal(
    <div className={`call-back ${ended ? 'ending' : ''} ${mini ? 'mini' : ''}`} role="dialog" aria-modal={!mini} aria-label="Call">
      <div className={`call-card ${mini ? 'mini' : ''} ${anyVideo ? 'has-video' : ''}`}>
        {mini ? (
          <div className="call-mini-bar">
            <button className="call-mini-open" onClick={onExpand} aria-label="Return to the call">
              <span className="call-mini-dot" aria-hidden="true" />
              <span className="call-mini-text">
                <b>{title}</b>
                <span className="muted small-text">{status} · tap to return</span>
              </span>
            </button>
            <button className={`call-mini-btn ${call.muted ? 'off' : ''}`} onClick={() => onMute(!call.muted)} aria-label={call.muted ? 'Unmute' : 'Mute'}>
              {call.muted ? '🔇' : '🎙'}
            </button>
            <button className="call-mini-btn end" onClick={onHangup} aria-label="End call">
              ✕
            </button>
          </div>
        ) : (
          <div className="call-head">
            {live ? (
              <button className="call-min" onClick={onMinimize} aria-label="Minimise the call and go back to your chats" title="Back to chats">
                ⌄
              </button>
            ) : (
              <span />
            )}
            <div className="call-title">
              <div className="call-name">{title}</div>
              <div className="call-status" aria-live="polite">
                {status}
              </div>
            </div>
            <span />
          </div>
        )}

        {/* The people. This stays on screen when minimised, so sound and picture never stop. */}
        <div
          className={`call-stage n${Math.min(Math.max(tiles.length, 1), 6)}`}
          onClick={mini ? onExpand : undefined}
          role={mini ? 'button' : undefined}
          aria-label={mini ? 'Return to the call' : undefined}
        >
          {tiles.map((p) => (
            <Tile key={p.id} peer={p} name={nameOf(p.id)} video={call.video} />
          ))}
        </div>

        {!mini && call.video && call.localStream && !call.camOff && (
          <video ref={localRef} className={`call-local ${call.facing === 'user' ? 'front' : ''}`} autoPlay playsInline muted />
        )}

        {!mini && !ended && <div className="muted small-text call-lock">🔒 end-to-end encrypted call</div>}

        {!mini && !ended && (
          <div className="call-actions">
            {incoming && ringing ? (
              <>
                <button className="call-btn decline" onClick={onReject} aria-label="Decline call" title="Decline">
                  ✕
                </button>
                <button className="call-btn accept" onClick={onAccept} aria-label="Accept call" title="Accept">
                  {call.video ? '🎥' : '📞'}
                </button>
              </>
            ) : (
              <>
                <button
                  className={`call-btn ${call.muted ? 'off' : ''}`}
                  onClick={() => onMute(!call.muted)}
                  aria-label={call.muted ? 'Unmute' : 'Mute'}
                  aria-pressed={call.muted}
                  title={call.muted ? 'Unmute' : 'Mute'}
                >
                  {call.muted ? '🔇' : '🎙'}
                </button>
                {call.video && (
                  <button
                    className={`call-btn ${call.camOff ? 'off' : ''}`}
                    onClick={() => onCamera(!call.camOff)}
                    aria-label={call.camOff ? 'Turn camera on' : 'Turn camera off'}
                    aria-pressed={call.camOff}
                    title={call.camOff ? 'Camera on' : 'Camera off'}
                  >
                    {call.camOff ? '🚫' : '📷'}
                  </button>
                )}
                {call.video && call.canFlip && (
                  <button className="call-btn" onClick={onFlip} aria-label="Switch between the front and back camera" title="Flip camera">
                    🔄
                  </button>
                )}
                {canAdd && room && (
                  <button className="call-btn" onClick={() => setAdding((a) => !a)} aria-label="Add someone to this call" title="Add someone" aria-expanded={adding}>
                    ＋
                  </button>
                )}
                <button className="call-btn decline" onClick={onHangup} aria-label="End call" title="End call">
                  ✕
                </button>
              </>
            )}
          </div>
        )}

        {adding && !mini && (
          <div className="call-add" role="group" aria-label="Add someone to the call">
            <div className="call-add-head">
              <b>Add to this call</b>
              <button className="icon-btn" onClick={() => setAdding(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {addable.length === 0 ? (
              <p className="hint">Nobody else is online right now.</p>
            ) : (
              <ul>
                {addable.map((u) => (
                  <li key={u.id}>
                    <span className="avatar sm">{u.name.slice(0, 1).toUpperCase()}</span>
                    <span className="call-add-name">{u.name}</span>
                    <button
                      className="btn small primary"
                      onClick={() => {
                        onAdd(u.id);
                        setAdding(false);
                      }}
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
