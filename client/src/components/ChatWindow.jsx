import { useEffect, useMemo, useRef, useState } from 'react';
import { fingerprint } from '../crypto.js';
import { previewOf } from '../util.js';
import { optimizeImage } from '../media.js';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';
import Popover from './Popover.jsx';
import Ticks, { ActivityLabel } from './Ticks.jsx';

export const MAX_FILE_MB = 100; // keep in sync with MAX_FILE_MB on the server

const dayLabel = (d) => new Date(d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

export default function ChatWindow({
  me,
  peer,
  online,
  activity, // 'typing' | 'speaking' | undefined — what the friend is doing right now
  messages,
  loading,
  chatPinned,
  ask, // ask({ title, body, confirmLabel, danger }, onConfirm) opens the confirm dialog
  onSendText,
  onSendFile,
  onActivity,
  onReact,
  onPin,
  onUnsend,
  onTogglePinChat,
  onDeleteChat,
  onCall, // onCall(video: boolean) starts an audio or video call
  inCall = false, // you are already in a call, so starting another one is switched off
  onToggleBlock, // block / unblock this person
  getKey,
  onBack,
}) {
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState('');
  const [showSafety, setShowSafety] = useState(false);
  const [safety, setSafety] = useState('');
  const [dragging, setDragging] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [flash, setFlash] = useState(null);
  const [pinIdx, setPinIdx] = useState(0);
  const [headMenu, setHeadMenu] = useState(null); // anchor element of the ⋮ menu
  const [focusTick, setFocusTick] = useState(0); // bumped to move the cursor back into the message box

  // People who used "Send message request" (visitors) only get text, voice notes and pictures: no calls, no other files,
  // no blocking or pinning. This applies to the visitor and to the admin's chat with them.
  const iAmGuest = me.role === 'guest';
  const imagesOnly = iAmGuest || peer.role === 'guest';
  const callsAllowed = !imagesOnly && !peer.blocked;
  // Someone who is offline can still be rung if they have notifications on (the server says if they cannot be reached).
  const canStartCall = callsAllowed && !inCall;
  const limitMB = imagesOnly ? 10 : MAX_FILE_MB; // keep the 10 in sync with GUEST_MAX_MB on the server

  // Start (or restart) a reply to a message, and put the cursor in the box so you can just type.
  const startReply = (m) => {
    setReplyTo(m);
    setFocusTick((t) => t + 1);
  };
  const cancelReply = () => {
    setReplyTo(null);
    setFocusTick((t) => t + 1);
  };

  const listRef = useRef(null);
  const endRef = useRef(null);
  const prevLen = useRef(0);
  const flashTimer = useRef(null);

  useEffect(() => {
    fingerprint(me.publicKey, peer.publicKey)
      .then(setSafety)
      .catch(() => setSafety(''));
  }, [me.publicKey, peer.publicKey]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const pinned = useMemo(
    () => messages.filter((m) => m.pinned && !m.unsent).sort((a, b) => new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0)),
    [messages]
  );
  const shownPin = pinned.length ? pinned[pinIdx % pinned.length] : null;
  // Only the latest call entry offers "Call back", so the chat does not fill with buttons.
  const lastCallId = useMemo(() => [...messages].reverse().find((m) => m.payload?.k === 'call' && !m.unsent)?.id, [messages]);

  const scrollToEnd = () => endRef.current?.scrollIntoView({ block: 'end' });

  // Only follow new content if you are already near the bottom (so reading old messages is not interrupted).
  const scrollIfNear = () => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400) scrollToEnd();
  };

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (prevLen.current === 0 || last?.from === me.id) scrollToEnd();
    else scrollIfNear();
    prevLen.current = messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, uploads.length]);

  useEffect(() => {
    if (activity) scrollIfNear();
  }, [activity]);

  // If the message you were replying to disappears (chat deleted), drop the reply.
  useEffect(() => {
    if (replyTo && !byId.has(replyTo.id)) setReplyTo(null);
  }, [byId, replyTo]);

  function jumpTo(id) {
    document.getElementById(`m-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1500);
  }

  const takeReply = () => {
    const r = replyTo;
    setReplyTo(null);
    return r;
  };

  async function sendText(text) {
    setError('');
    const r = takeReply();
    try {
      await onSendText(text, r?.id);
      return true;
    } catch (e) {
      setReplyTo(r);
      setError(e.message || 'Could not send the message');
      return false;
    }
  }

  // Shows a progress bubble while a file / voice note is encrypted and uploaded.
  async function upload(label, send) {
    const id = `${Date.now()}-${Math.random()}`;
    setUploads((u) => [...u, { id, name: label, pct: 0, stage: 'encrypting' }]);
    try {
      await send((pct, stage) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct, stage } : x))));
    } finally {
      setUploads((u) => u.filter((x) => x.id !== id));
    }
  }

  // `doc` = sent as a document: the exact original file, shown as a file card. Otherwise big photos are made smaller.
  async function handleFiles(files, { doc = false } = {}) {
    setError('');
    const r = takeReply();
    for (const [i, original] of files.entries()) {
      if (imagesOnly && !original.type.startsWith('image/')) {
        setError('In this chat you can send text, voice notes and pictures only.');
        continue;
      }
      const asDoc = doc && !imagesOnly;
      const file = asDoc ? original : await optimizeImage(original);
      if (file.size > limitMB * 1024 * 1024) {
        setError(`${original.name} is larger than ${limitMB} MB.`);
        continue;
      }
      try {
        // Only the first file carries the reply.
        await upload(file.name, (progress) =>
          onSendFile(file, progress, { replyTo: i === 0 ? r?.id : undefined, doc: asDoc })
        );
      } catch (e) {
        setError(`Could not send ${original.name}: ${e.message}`);
      }
    }
  }

  async function handleVoice(blob, meta) {
    setError('');
    const r = takeReply();
    const file = new File([blob], 'voice-message', { type: blob.type || 'audio/webm' });
    try {
      await upload('🎤 Voice message', (progress) => onSendFile(file, progress, { replyTo: r?.id, voice: meta }));
    } catch (e) {
      setReplyTo(r);
      setError(`Could not send the voice message: ${e.message}`);
    }
  }

  const unsendAsk = (m) =>
    ask(
      {
        title: 'Unsend this message?',
        body: `It will be removed for you and ${peer.name}. ${peer.name} will see that a message was unsent.`,
        confirmLabel: 'Unsend',
        danger: true,
      },
      () => onUnsend(m).catch((e) => setError(e.message || 'Could not unsend'))
    );

  const deleteAsk = () =>
    ask(
      {
        title: `Delete your chat with ${peer.name}?`,
        body: `All messages and files in this chat are removed from your account. ${peer.name} keeps their own copy.`,
        confirmLabel: 'Delete chat',
        danger: true,
      },
      () => onDeleteChat().catch((e) => setError(e.message || 'Could not delete the chat'))
    );

  const blockAsk = () =>
    ask(
      peer.blocked
        ? {
            title: `Unblock ${peer.name}?`,
            body: `You and ${peer.name} will be able to message${peer.role === 'guest' ? '' : ' and call'} each other again.`,
            confirmLabel: 'Unblock',
          }
        : {
            title: `Block ${peer.name}?`,
            body: `Neither of you can message${peer.role === 'guest' ? '' : ' or call'} the other, and ${peer.name} will not see you in their list. Your old messages stay. You can unblock any time.`,
            confirmLabel: 'Block',
            danger: true,
          },
      () => onToggleBlock().catch((e) => setError(e.message || 'Could not update the block'))
    );

  const guard = (fn) => (...args) => fn(...args).catch((e) => setError(e.message || 'Something went wrong'));
  const who = (m) => (m.from === me.id ? 'You' : peer.name);

  let lastDay = '';

  return (
    <section
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to friends">
          ←
        </button>
        <div className="avatar">{peer.name.slice(0, 1).toUpperCase()}</div>
        <div className="head-text">
          <div className="peer-name">
            {peer.name} {chatPinned && <span title="Pinned chat">📌</span>}
          </div>
          <div className="muted small-text status-line" aria-live="polite">
            {activity ? <ActivityLabel name={peer.name} kind={activity} /> : online ? 'online' : 'offline'}
          </div>
        </div>
        {callsAllowed && (
          <>
            <button
              className="icon-btn call-start"
              aria-label={`Audio call ${peer.name}`}
              title={inCall ? 'You are already in a call' : online ? 'Audio call' : `Audio call (${peer.name} is offline: rings if they have notifications on)`}
              disabled={!canStartCall}
              onClick={() => onCall(false)}
            >
              📞
            </button>
            <button
              className="icon-btn call-start"
              aria-label={`Video call ${peer.name}`}
              title={inCall ? 'You are already in a call' : online ? 'Video call' : `Video call (${peer.name} is offline: rings if they have notifications on)`}
              disabled={!canStartCall}
              onClick={() => onCall(true)}
            >
              🎥
            </button>
          </>
        )}
        <button className="btn small verify-btn" onClick={() => setShowSafety((s) => !s)} aria-label="Verify the encryption">
          🔒<span className="lbl"> Verify</span>
        </button>
        <button
          className="icon-btn"
          aria-label="Chat options"
          onClick={(e) => {
            const a = e.currentTarget;
            setHeadMenu((cur) => (cur ? null : a));
          }}
        >
          ⋮
        </button>
      </header>

      {headMenu && (
        <Popover anchor={headMenu} onClose={() => setHeadMenu(null)} className="menu">
          {!iAmGuest && (
            <button
              className="menu-item"
              onClick={() => {
                setHeadMenu(null);
                onTogglePinChat();
              }}
            >
              📌 {chatPinned ? 'Unpin chat' : 'Pin chat to top'}
            </button>
          )}
          {!iAmGuest && (
            <button
              className="menu-item"
              onClick={() => {
                setHeadMenu(null);
                blockAsk();
              }}
            >
              🚫 {peer.blocked ? `Unblock ${peer.name}` : `Block ${peer.name}`}
            </button>
          )}
          <button
            className="menu-item danger"
            onClick={() => {
              setHeadMenu(null);
              deleteAsk();
            }}
          >
            🗑 Delete chat
          </button>
        </Popover>
      )}

      {showSafety && (
        <div className="safety">
          <p>
            Safety number for you and {peer.name}. Compare it with them by call or in person. If it matches on both
            screens, nobody has tampered with your keys.
          </p>
          <code>{safety || '…'}</code>
        </div>
      )}

      {shownPin && (
        <div className="pinbar">
          <button
            className="pin-main"
            onClick={() => {
              jumpTo(shownPin.id);
              setPinIdx((i) => i + 1);
            }}
            title={pinned.length > 1 ? 'Tap to cycle through pinned messages' : 'Go to pinned message'}
          >
            <span className="pin-ico">📌</span>
            <span className="pin-body">
              <span className="quote-who">
                Pinned{pinned.length > 1 ? ` ${(pinIdx % pinned.length) + 1}/${pinned.length}` : ''} · {who(shownPin)}
              </span>
              <span className="quote-text">{previewOf(shownPin)}</span>
            </span>
          </button>
          <button className="icon-btn" aria-label="Unpin message" title="Unpin" onClick={guard(() => onPin(shownPin, false))}>
            ✕
          </button>
        </div>
      )}

      <div className="messages" ref={listRef}>
        {loading && messages.length === 0 && <p className="hint center">Decrypting…</p>}
        {!loading && messages.length === 0 && uploads.length === 0 && (
          <p className="hint center">No messages yet. Say hi. Only you two can read it.</p>
        )}

        {messages.map((m) => {
          const day = dayLabel(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const replyId = m.payload?.replyTo;
          return (
            <div key={m.id} id={`m-${m.id}`} className={flash === m.id ? 'flash' : ''}>
              {showDay && (
                <div className="day">
                  <span>{day}</span>
                </div>
              )}
              <MessageBubble
                m={m}
                mine={m.from === me.id}
                myId={me.id}
                peerName={peer.name}
                quoted={replyId ? byId.get(replyId) : undefined}
                getKey={getKey}
                onLoaded={scrollIfNear}
                onReply={startReply}
                onReact={guard(onReact)}
                onPin={guard(onPin)}
                onUnsend={unsendAsk}
                onJump={jumpTo}
                canCall={canStartCall && m.id === lastCallId}
                onCallBack={onCall}
              />
            </div>
          );
        })}

        {uploads.map((u) => (
          <div className="row mine" key={u.id}>
            <div className="bubble mine pending">
              <div className="file-name">{u.name}</div>
              <div className="progress">
                <span style={{ width: `${u.stage === 'encrypting' ? 8 : u.pct}%` }} />
              </div>
              <span className="meta">
                <span className="muted small-text">{u.stage === 'encrypting' ? 'Encrypting…' : `Uploading ${u.pct}%`}</span>
                <Ticks status="sending" />
              </span>
            </div>
          </div>
        ))}

        {activity && (
          <div className="row">
            <div className="bubble act-bubble" aria-hidden="true">
              <ActivityLabel name={peer.name} kind={activity} short />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="error bar" role="alert">
          <span>{error}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setError('')}>
            ✕
          </button>
        </div>
      )}

      {peer.blocked ? (
        <div className="blocked-bar" role="status">
          <span>You blocked {peer.name}. Unblock to chat again.</span>
          <button className="btn small" onClick={blockAsk}>
            Unblock
          </button>
        </div>
      ) : (
      <Composer
        imagesOnly={imagesOnly}
        replyTo={replyTo}
        replyWho={replyTo ? who(replyTo) : ''}
        onCancelReply={cancelReply}
        focusTick={focusTick}
        onSendText={sendText}
        onFiles={handleFiles}
        onVoice={handleVoice}
        onActivity={onActivity}
        onError={setError}
      />
      )}

      {dragging && <div className="drop-hint">Drop to encrypt and send</div>}
    </section>
  );
}
