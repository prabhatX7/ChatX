import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, onUnauthorized } from './api.js';
import { loadKey, saveKey, clearKeys } from './keystore.js';
import { sharedKeyFor, encryptJson, decryptJson, encryptBytes, clearSharedCache } from './crypto.js';
import { connectSocket, disconnectSocket, sendActivity, sendSignal, sendVisible, sendReady } from './socket.js';
import { syncPush } from './push.js';
import { CallManager } from './call.js';
import { applyTheme, getSavedTheme } from './theme.js';
import { pickGreeting } from './greetings.js';
import { desktopNotify, closeNotifications, ping } from './notify.js';
import AuthScreen from './components/AuthScreen.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import Toasts from './components/Toasts.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import Splash from './components/Splash.jsx';
import Logo from './components/Logo.jsx';
import ThemePrompt from './components/ThemePrompt.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import ContactPage, { takeGuestLink } from './components/ContactPage.jsx';
import { previewOf } from './util.js';

// Is ChatX in front of the person right now? If not, new messages and calls reach them as push notifications.
const inFront = () => document.visibilityState === 'visible' && document.hasFocus();

const byTime = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null); // { user, privateKey }
  const [users, setUsers] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState({}); // peerId -> decrypted messages
  const [loadingChat, setLoadingChat] = useState(false);
  const [unread, setUnread] = useState({});
  const [toasts, setToasts] = useState([]);
  const [activity, setActivity] = useState({}); // peerId -> 'typing' | 'speaking'
  const [pinnedChats, setPinnedChats] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [focusTick, setFocusTick] = useState(0);
  const [view, setView] = useState('chat'); // 'chat' | 'admin' (the admin's groups & codes screen)
  const [adminTick, setAdminTick] = useState(0); // bumped when something changes, so the admin screens reload
  const [pending, setPending] = useState([]); // admin only: people waiting for approval
  const [connTick, setConnTick] = useState(0); // bumped to reconnect the live connection (e.g. after being moved)
  const [requests, setRequests] = useState([]); // admin only: message requests from visitors without an account
  const [theme, setTheme] = useState(getSavedTheme);
  const [showSettings, setShowSettings] = useState(false);
  const [needsTheme, setNeedsTheme] = useState(false); // the one-time "pick your colour" popup
  const [call, setCall] = useState(null); // the audio / video call in progress, if any
  const [callMin, setCallMin] = useState(false); // the call is shrunk so you can use the chats meanwhile
  // A different hello every time the app opens (and after you sign up or log in).
  const [splash, setSplash] = useState(() => ({ text: pickGreeting() }));
  // '/contact' is the page for "Send message request" (the link you put on your portfolio).
  const [route, setRoute] = useState(() => {
    const viaLink = takeGuestLink();
    return viaLink || window.location.pathname.replace(/\/+$/, '') === '/contact' ? 'contact' : 'app';
  });

  // Refs let long-lived socket/notification callbacks always see the latest state.
  const usersRef = useRef([]);
  const activeRef = useRef(null);
  const live = useRef({});
  const sessionRef = useRef(null);
  const callsRef = useRef(null);
  const ringTimer = useRef(null);
  const activityTimers = useRef({});
  const seenInFlight = useRef(false);
  const tmpCounter = useRef(0);
  usersRef.current = users;
  activeRef.current = active;
  sessionRef.current = session;

  /* ---------- calls ---------- */

  // The call engine lives for the whole page. It reads the latest session and people through refs.
  if (!callsRef.current) {
    const keyFor = async (peerId) => {
      const peer = usersRef.current.find((u) => u.id === peerId);
      if (!peer || !sessionRef.current) throw new Error('Unknown person');
      return sharedKeyFor(sessionRef.current.privateKey, peer.id, peer.publicKey);
    };
    callsRef.current = new CallManager({
      sendSignal,
      getIceServers: async () => (await api.iceServers()).iceServers,
      getMedia: (video) =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: video ? { facingMode: 'user' } : false,
        }),
      // Just a camera (front: 'user', back: 'environment'), for the flip button.
      getVideo: (facing) => navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing } } }),
      countCameras: async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length,
      // One person's part of a call is over: the device that rang them writes the call entry in that chat.
      onLink: (e) => live.current.logCall?.(e),
      createPeer: (config) => new RTCPeerConnection(config),
      // The offer / answer / network candidates are encrypted with the pair key, so the server cannot read or swap them.
      encrypt: async (peerId, obj, callId) =>
        encryptJson(await keyFor(peerId), obj, `call:${callId}:${sessionRef.current.user.id}>${peerId}`),
      decrypt: async (peerId, blob, callId) =>
        decryptJson(await keyFor(peerId), blob.iv, blob.ct, `call:${callId}:${peerId}>${sessionRef.current.user.id}`),
      onChange: setCall,
    });
  }

  /* ---------- session ---------- */

  async function logout() {
    disconnectSocket();
    setToken(null);
    clearSharedCache();
    await clearKeys().catch(() => {});
    setSession(null);
    setUsers([]);
    setMessages({});
    setActive(null);
    setUnread({});
    setToasts([]);
    setOnline(new Set());
    setActivity({});
    setPinnedChats([]);
    setConfirm(null);
    setView('chat');
    setPending([]);
    setRequests([]);
    setShowSettings(false);
    setNeedsTheme(false);
    callsRef.current?.dispose();
    Object.values(activityTimers.current).forEach(clearTimeout);
    activityTimers.current = {};
  }
  live.current.logout = logout;

  async function onAuthed({ user, privateKey, token }) {
    setToken(token);
    await saveKey(privateKey).catch(() => {}); // if this fails you simply log in again after a reload
    setSession({ user, privateKey });
    if (user.theme) setTheme(applyTheme(user.theme)); // your saved colour follows you to any device
    setNeedsTheme(user.themeChosen === false);
    if (window.location.pathname !== '/' || window.location.hash) history.replaceState(null, '', '/');
    setRoute('app');
    setSplash({ text: pickGreeting() });
  }

  async function changeTheme(t) {
    setTheme(applyTheme(t));
    try {
      await api.setTheme(t);
    } catch {
      /* the colour still applies on this device */
    }
  }

  // The popup's Continue button: save the colour and don't ask again.
  async function finishThemePrompt(t) {
    await changeTheme(t);
    setNeedsTheme(false);
  }

  const goContact = () => {
    history.pushState(null, '', '/contact');
    setRoute('contact');
  };
  const goLogin = () => {
    history.pushState(null, '', '/');
    setRoute('app');
  };
  useEffect(() => {
    const sync = () => setRoute(window.location.pathname.replace(/\/+$/, '') === '/contact' ? 'contact' : 'app');
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  useEffect(() => {
    onUnauthorized(() => live.current.logout?.());
    (async () => {
      try {
        if (getToken()) {
          const key = await loadKey();
          if (key) {
            const { user } = await api.me();
            setSession({ user, privateKey: key });
            if (user.theme) setTheme(applyTheme(user.theme));
            setNeedsTheme(user.themeChosen === false);
          } else {
            setToken(null);
          }
        }
      } catch (e) {
        if (e.status === 401) {
          setToken(null);
          await clearKeys().catch(() => {});
        }
      }
      setBooting(false);
    })();
  }, []);

  /* ---------- realtime ---------- */

  useEffect(() => {
    if (!session) return undefined;
    let alive = true;

    const loadUsers = () =>
      api
        .users()
        .then(({ users: list, pinnedChats: pins }) => {
          if (!alive) return;
          setUsers(list);
          setPinnedChats(pins || []);
        })
        .catch(() => {});
    // Once the people are loaded the server may hand over a call that was ringing while ChatX was closed.
    let loaded = false;
    const announceReady = () => loaded && sendReady();
    loadUsers().finally(() => {
      loaded = true;
      announceReady();
    });

    const socket = connectSocket(getToken());
    socket.on('connect', () => {
      sendVisible(inFront());
      announceReady();
    });
    socket.on('presence:list', (ids) => setOnline(new Set(ids)));
    socket.on('presence', ({ userId, online: isOnline }) =>
      setOnline((prev) => {
        const next = new Set(prev);
        if (isOnline) next.add(userId);
        else next.delete(userId);
        return next;
      })
    );
    // The server only sends this for people you are allowed to see.
    socket.on('user:new', (u) => {
      setUsers((prev) => (u.id === session.user.id || prev.some((x) => x.id === u.id) ? prev : [...prev, u]));
      setAdminTick((t) => t + 1);
    });
    socket.on('message', (raw) => live.current.onMessage?.(raw));
    socket.on('message:update', (raw) => live.current.onUpdate?.(raw));
    socket.on('status', (s) => live.current.onStatus?.(s));
    socket.on('activity', (a) => live.current.onActivity?.(a));
    socket.on('chat:deleted', ({ peerId }) => live.current.clearChat?.(peerId));
    socket.on('chats:pinned', (ids) => setPinnedChats(ids));
    socket.on('call:signal', (s) => callsRef.current?.signal(s));
    // Admin only: someone sent a message request from the contact page.
    socket.on('request:new', (p) => {
      setAdminTick((t) => t + 1);
      live.current.onRequest?.(p);
    });
    // The admin removed this visitor.
    socket.on('session:end', () => live.current.logout?.());

    // Groups changed (someone was approved or moved): reload who you can see.
    socket.on('users:changed', loadUsers);
    // Admin only: a sign-up request arrived, or the admin screens need a refresh.
    socket.on('signup:pending', (p) => {
      setAdminTick((t) => t + 1);
      live.current.onSignup?.(p);
    });
    socket.on('admin:changed', () => {
      setAdminTick((t) => t + 1);
      loadUsers();
    });
    // The admin moved you: reconnect so your live updates match your new group.
    socket.on('session:refresh', () => setConnTick((t) => t + 1));

    return () => {
      alive = false;
      disconnectSocket();
    };
  }, [session, connTick]);

  // Admin only: the list of people waiting for approval.
  useEffect(() => {
    if (!session || session.user.role !== 'admin') {
      setPending([]);
      return undefined;
    }
    let ok = true;
    api
      .adminPending()
      .then(({ pending: list }) => ok && setPending(list))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, [session, adminTick]);

  // Admin only: message requests from visitors (still encrypted; they are opened in this browser).
  useEffect(() => {
    if (!session || session.user.role !== 'admin') {
      setRequests([]);
      return undefined;
    }
    let ok = true;
    api
      .adminRequests()
      .then(({ requests: list }) => ok && setRequests(list))
      .catch(() => {});
    return () => {
      ok = false;
    };
  }, [session, adminTick]);

  // Decrypt one request (name is plain; contact and message are only readable here).
  const openRequestRef = useRef(null);
  openRequestRef.current = async (r) => {
    if (!r.intro) return { error: 'This request has no message' };
    const key = await sharedKeyFor(session.privateKey, r.id, r.publicKey);
    const p = await decryptJson(key, r.intro.iv, r.intro.ct, `${r.intro.from}>${r.intro.to}`);
    return { msg: p.msg ?? p.text ?? '', contact: p.contact || '' };
  };
  const openRequest = useCallback((r) => openRequestRef.current(r), []);

  // Incoming call: ring until answered. Missed call: leave a note. Blocked or removed mid-call: hang up.
  useEffect(() => {
    clearInterval(ringTimer.current);
    if (call?.dir === 'in' && call.phase === 'ringing') {
      const name = usersRef.current.find((u) => u.id === call.peerId)?.name || 'Someone';
      const title = `${name} is calling`;
      const body = call.video ? 'Video call' : 'Audio call';
      if (!document.hasFocus()) desktopNotify({ title, body, tag: `call-${call.callId}`, kind: 'call', from: call.peerId });
      ping();
      ringTimer.current = setInterval(ping, 2200);
    }
    if (call?.phase === 'ended' && call.endReason === 'missed' && call.dir === 'in') {
      const name = usersRef.current.find((u) => u.id === call.peerId)?.name || 'Someone';
      const id = `missed-${call.callId}`;
      setToasts((t) => [...t.slice(-3), { id, peerId: call.peerId, title: `Missed ${call.video ? 'video' : 'audio'} call`, body: `from ${name}` }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
    }
    return () => clearInterval(ringTimer.current);
  }, [call?.phase, call?.callId, call?.dir, call?.endReason]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone blocked or removed mid-call leaves the call; the others carry on.
  useEffect(() => {
    if (!call || call.phase === 'ended') return;
    for (const p of call.peers || []) {
      const u = users.find((x) => x.id === p.id);
      if (!u || u.blocked) callsRef.current.dropPeer(p.id);
    }
  }, [users, call]);

  // A new call always opens in full; the call screen resets when the call is gone.
  useEffect(() => {
    if (!call) setCallMin(false);
  }, [call]);

  // Keep this device registered for notifications (only if they were already allowed here), and tell the server
  // whether ChatX is in front, so it knows when to send a pop-up instead.
  useEffect(() => {
    if (!session) return undefined;
    syncPush();
    const report = () => {
      sendVisible(inFront());
      if (inFront()) {
        // You are here now: take down pop-ups for the chat you are looking at.
        closeNotifications((tag) => tag === 'test' || tag === activeRef.current);
      }
    };
    report();
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A call that is answered, declined or over: take its pop-up down.
  useEffect(() => {
    if (!(call?.dir === 'in' && call.phase === 'ringing')) closeNotifications((tag) => tag.startsWith('call-'));
  }, [call?.phase, call?.callId, call?.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tapping a notification opens the right chat. When ChatX was closed it starts with ?chat=<id>; when it was open
  // the service worker sends a message instead.
  const pendingOpen = useRef(null);
  const applyOpen = () => {
    const want = pendingOpen.current;
    if (!want || !sessionRef.current) return;
    if (want.kind === 'admin') {
      if (sessionRef.current.user.role === 'admin') openAdmin();
      pendingOpen.current = null;
    } else if (want.kind === 'chat' && want.from) {
      if (usersRef.current.some((u) => u.id === want.from)) {
        openChat(want.from);
        pendingOpen.current = null;
      }
    } else {
      pendingOpen.current = null; // a call: the ring arrives by itself
    }
  };
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('chat')) pendingOpen.current = { kind: 'chat', from: q.get('chat') };
    else if (q.get('admin')) pendingOpen.current = { kind: 'admin' };
    if (q.has('chat') || q.has('admin')) window.history.replaceState(null, '', window.location.pathname);
    const onMessage = (ev) => {
      if (ev.data?.type === 'open') {
        pendingOpen.current = { kind: ev.data.kind, from: ev.data.from };
        applyOpen();
      } else if (ev.data?.type === 'resubscribe') {
        syncPush();
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    applyOpen();
  }, [users, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page ends the call politely.
  useEffect(() => {
    const bye = () => callsRef.current?.dispose();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  /* ---------- decrypt / store ---------- */

  async function decode(raw) {
    const myId = session.user.id;
    const peerId = raw.from === myId ? raw.to : raw.from;
    const base = {
      id: raw._id,
      from: raw.from,
      to: raw.to,
      peerId,
      fileId: raw.fileId,
      createdAt: raw.createdAt,
      deliveredAt: raw.deliveredAt || null,
      seenAt: raw.seenAt || null,
      pinned: Boolean(raw.pinned),
      pinnedAt: raw.pinnedAt || null,
      unsent: Boolean(raw.unsent),
      reactions: [],
    };
    if (raw.unsent) return base; // nothing left to decrypt

    let peer = usersRef.current.find((u) => u.id === peerId);
    if (!peer) {
      try {
        const { users: fresh } = await api.users();
        usersRef.current = fresh;
        setUsers(fresh);
        peer = fresh.find((u) => u.id === peerId);
      } catch {
        /* handled below */
      }
    }
    if (!peer) return { ...base, error: 'Message from an unknown user' };

    try {
      const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
      const payload = await decryptJson(key, raw.iv, raw.ct, `${raw.from}>${raw.to}`);
      // Reactions are emoji encrypted by whoever reacted; ones that fail to decrypt are ignored.
      const reactions = [];
      for (const r of raw.reactions || []) {
        try {
          const { e } = await decryptJson(key, r.iv, r.ct, `react:${raw._id}:${r.by}`);
          if (typeof e === 'string' && e.length > 0 && e.length <= 16) reactions.push({ by: r.by, emoji: e });
        } catch {
          /* ignore */
        }
      }
      return { ...base, payload, reactions };
    } catch {
      return { ...base, error: 'This message could not be decrypted' };
    }
  }

  function addMessage(m) {
    setMessages((prev) => {
      const list = prev[m.peerId] || [];
      if (list.some((x) => x.id === m.id)) return prev;
      return { ...prev, [m.peerId]: [...list, m].sort(byTime) };
    });
  }

  // Replace a message that is already on screen (reactions, pins, unsend). Unknown ones are ignored:
  // their chat has not been opened yet, and history is fetched fresh when it is.
  function applyUpdate(m) {
    setMessages((prev) => {
      const list = prev[m.peerId];
      const i = list ? list.findIndex((x) => x.id === m.id) : -1;
      if (i < 0) return prev;
      const next = [...list];
      // `justGone` plays the "dissolve" animation once, only for the moment a message is unsent on screen.
      next[i] = m.unsent && !list[i].unsent ? { ...m, justGone: true } : m;
      return { ...prev, [m.peerId]: next };
    });
  }

  function patchMessages(ids, patch) {
    const set = new Set(ids);
    setMessages((prev) => {
      let changed = false;
      const out = {};
      for (const [peerId, list] of Object.entries(prev)) {
        out[peerId] = list.map((m) => {
          if (!set.has(m.id)) return m;
          changed = true;
          return { ...m, ...patch(m) };
        });
      }
      return changed ? out : prev;
    });
  }

  function clearActivity(peerId) {
    clearTimeout(activityTimers.current[peerId]);
    delete activityTimers.current[peerId];
    setActivity((a) => {
      if (!a[peerId]) return a;
      const n = { ...a };
      delete n[peerId];
      return n;
    });
  }

  function openChat(id) {
    setView('chat');
    setActive(id);
    setUnread((u) => ({ ...u, [id]: 0 }));
    setToasts((t) => t.filter((x) => x.peerId !== id));
  }

  function openAdmin() {
    setActive(null);
    setView('admin');
  }

  // Admin only: someone signed up and is waiting to be approved.
  live.current.onSignup = (p) => {
    const title = 'New sign-up request';
    const body = `${p.name} is waiting for your approval`;
    setToasts((t) => [...t.slice(-3), { id: `signup-${p.id}`, peerId: null, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== `signup-${p.id}`)), 8000);
    if (!document.hasFocus()) desktopNotify({ title, body, tag: 'signup', kind: 'admin', onClick: openAdmin });
    ping();
  };

  // A toast opens the chat it is about; the sign-up toast has no chat, so it opens the admin screen.
  function openToast(peerId) {
    setToasts((t) => t.filter((x) => x.peerId !== peerId));
    if (peerId) openChat(peerId);
    else openAdmin();
  }

  // New message from the server (yours or a friend's).
  live.current.onMessage = async (raw) => {
    const m = await decode(raw);
    // `fresh` makes a message that just arrived pop in; history loaded from the server does not animate.
    addMessage(m.from === session.user.id ? m : { ...m, fresh: true });
    if (m.from === session.user.id) return;
    clearActivity(m.peerId); // they sent it, so they are no longer typing

    const viewing =
      document.visibilityState === 'visible' && document.hasFocus() && activeRef.current === m.peerId;
    if (viewing) return;

    // A call entry is not a message to pop up about (the call itself already rang). Only a missed call is counted.
    if (m.payload?.k === 'call') {
      if (m.payload.o === 'missed') setUnread((u) => ({ ...u, [m.peerId]: (u[m.peerId] || 0) + 1 }));
      return;
    }

    const name = usersRef.current.find((u) => u.id === m.peerId)?.name || 'Someone';
    const title = `${name} sent this`;
    const body = previewOf(m);

    setUnread((u) => ({ ...u, [m.peerId]: (u[m.peerId] || 0) + 1 }));

    if (document.visibilityState === 'visible') {
      setToasts((t) => [...t.slice(-3), { id: m.id, peerId: m.peerId, title, body }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== m.id)), 6500);
    }
    if (!document.hasFocus()) {
      desktopNotify({ title, body, tag: m.peerId, kind: 'chat', from: m.peerId, onClick: () => openChat(m.peerId) });
    }
    ping();
  };

  live.current.onUpdate = async (raw) => applyUpdate(await decode(raw));

  live.current.onStatus = ({ ids, deliveredAt, seenAt }) =>
    patchMessages(ids, (m) => ({
      deliveredAt: m.deliveredAt || deliveredAt || null,
      seenAt: seenAt || m.seenAt,
    }));

  live.current.onActivity = ({ from, kind, on }) => {
    if (!on) return clearActivity(from);
    setActivity((a) => (a[from] === kind ? a : { ...a, [from]: kind }));
    clearTimeout(activityTimers.current[from]);
    // The friend's app repeats the signal while it is true; silence for 6 s means it stopped.
    activityTimers.current[from] = setTimeout(() => clearActivity(from), 6000);
  };

  live.current.clearChat = (peerId) => {
    setMessages((prev) => ({ ...prev, [peerId]: [] }));
    setUnread((u) => ({ ...u, [peerId]: 0 }));
    setToasts((t) => t.filter((x) => x.peerId !== peerId));
    setActive((cur) => (cur === peerId ? null : cur));
  };

  // Load history when you open a chat.
  useEffect(() => {
    if (!session || !active || users.length === 0) return undefined;
    let ok = true;
    setLoadingChat(true);
    (async () => {
      try {
        const { messages: raws } = await api.messages(active);
        const decoded = await Promise.all(raws.map(decode));
        if (!ok) return;
        setMessages((prev) => {
          const merged = new Map((prev[active] || []).map((m) => [m.id, m]));
          decoded.forEach((m) => merged.set(m.id, m));
          return { ...prev, [active]: [...merged.values()].sort(byTime) };
        });
      } catch {
        /* the chat stays empty; a reload retries */
      } finally {
        if (ok) setLoadingChat(false);
      }
    })();
    return () => {
      ok = false;
    };
  }, [active, session, users.length]);

  // Clear the unread badge when you come back to the window.
  useEffect(() => {
    const clear = () => {
      setFocusTick((t) => t + 1);
      if (document.visibilityState === 'visible' && document.hasFocus() && activeRef.current) {
        const id = activeRef.current;
        setUnread((u) => (u[id] ? { ...u, [id]: 0 } : u));
      }
    };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  // While you are looking at a chat, tell the server (and so your friend) that their messages were seen.
  useEffect(() => {
    if (!session || !active || seenInFlight.current) return;
    if (!(document.visibilityState === 'visible' && document.hasFocus())) return;
    const unseen = (messages[active] || []).filter((m) => m.from === active && !m.seenAt && !m.unsent).map((m) => m.id);
    if (unseen.length === 0) return;

    seenInFlight.current = true;
    api
      .markSeen(active)
      .then(({ seenAt }) => patchMessages(unseen, () => ({ seenAt: seenAt || new Date().toISOString() })))
      .catch(() => {})
      .finally(() => {
        seenInFlight.current = false;
        setFocusTick((t) => t + 1); // re-check in case more arrived meanwhile
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, active, focusTick, session]);

  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = total ? `(${total}) ChatX` : 'ChatX';
  }, [unread]);

  /* ---------- sending ---------- */

  async function postMessage(peer, payload, fileId = null, silent = false) {
    const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
    const { iv, ct } = await encryptJson(key, payload, `${session.user.id}>${peer.id}`);
    return decode(await api.send(peer.id, { iv, ct, fileId, ...(silent ? { silent: true } : {}) }));
  }

  // Text shows up immediately with a "sending" clock, then settles to sent / delivered / seen.
  async function sendText(peer, text, replyTo) {
    const tmpId = `tmp-${++tmpCounter.current}`;
    const payload = { k: 'text', text, ...(replyTo ? { replyTo } : {}) };
    addMessage({
      id: tmpId,
      from: session.user.id,
      to: peer.id,
      peerId: peer.id,
      createdAt: new Date().toISOString(),
      payload,
      reactions: [],
      status: 'sending',
      fresh: true,
    });
    const dropTmp = () =>
      setMessages((prev) => ({ ...prev, [peer.id]: (prev[peer.id] || []).filter((m) => m.id !== tmpId) }));
    try {
      const real = await postMessage(peer, payload);
      dropTmp();
      addMessage(real);
    } catch (e) {
      dropTmp();
      throw e;
    }
  }

  async function sendFile(peer, file, onProgress, { replyTo, voice, doc } = {}) {
    const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
    onProgress?.(0, 'encrypting');
    const { iv, data } = await encryptBytes(key, await file.arrayBuffer(), `file:${session.user.id}>${peer.id}`);
    const { fileId } = await api.uploadFile(new Blob([data]), (pct) => onProgress?.(pct, 'uploading'));
    const reply = replyTo ? { replyTo } : {};
    const payload = voice
      ? { k: 'voice', mime: file.type || 'audio/webm', size: file.size, fiv: iv, dur: voice.dur, wave: voice.wave, ...reply }
      : { k: 'file', name: file.name, mime: file.type || 'application/octet-stream', size: file.size, fiv: iv, ...(doc ? { doc: true } : {}), ...reply };
    addMessage(await postMessage(peer, payload, fileId));
  }

  /* ---------- message actions ---------- */

  async function reactTo(peer, m, emoji) {
    const mine = m.reactions.find((r) => r.by === session.user.id);
    let body = { clear: true };
    if (!(mine && mine.emoji === emoji)) {
      const key = await sharedKeyFor(session.privateKey, peer.id, peer.publicKey);
      body = await encryptJson(key, { e: emoji }, `react:${m.id}:${session.user.id}`);
    }
    applyUpdate(await decode(await api.react(peer.id, m.id, body)));
  }

  async function pinMessage(peer, m, pinned) {
    applyUpdate(await decode(await api.pin(peer.id, m.id, pinned)));
  }

  async function unsendMessage(peer, m) {
    await api.unsend(peer.id, m.id);
    // The server also pushes this; applying it now makes the change instant for you.
    applyUpdate({ ...m, unsent: true, payload: undefined, fileId: null, reactions: [], pinned: false, pinnedAt: null });
  }

  async function deleteChat(peer) {
    await api.deleteChat(peer.id);
    live.current.clearChat(peer.id);
  }

  async function togglePinChat(peerId) {
    const pinned = !pinnedChats.includes(peerId);
    setPinnedChats((p) => (pinned ? [...p, peerId] : p.filter((x) => x !== peerId))); // optimistic
    try {
      const { pinnedChats: saved } = await api.pinChat(peerId, pinned);
      setPinnedChats(saved);
    } catch {
      setPinnedChats((p) => (pinned ? p.filter((x) => x !== peerId) : [...p, peerId]));
    }
  }

  async function toggleBlock(peer) {
    const blocked = !peer.blocked;
    await api.block(peer.id, blocked);
    // The server also tells both of you to refresh; this makes the change instant here.
    setUsers((list) => list.map((u) => (u.id === peer.id ? { ...u, blocked } : u)));
  }

  function startCall(peer, video) {
    callsRef.current.start(peer.id, video);
  }

  // The call log: "Voice call, started 14:05, ended 14:09". Written by whoever rang, into the chat with that person.
  live.current.logCall = async ({ peerId, outcome, video, startedAt, endedAt }) => {
    const peer = usersRef.current.find((u) => u.id === peerId);
    if (!peer || peer.role === 'guest' || !sessionRef.current) return;
    const o = outcome === 'ended' ? 'ended' : outcome === 'declined' ? 'declined' : 'missed'; // busy / offline count as missed
    try {
      addMessage(await postMessage(peer, { k: 'call', video: Boolean(video), o, t0: startedAt || 0, t1: endedAt || Date.now() }, null, true)); // silent: the call itself already rang, no push for the entry
    } catch {
      /* the call itself is not affected if the entry cannot be saved */
    }
  };

  // Admin only: a visitor sent a message request.
  live.current.onRequest = (p) => {
    const title = 'New message request';
    const body = `${p.name} wants to message you`;
    setToasts((t) => [...t.slice(-3), { id: `req-${p.id}`, peerId: null, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== `req-${p.id}`)), 8000);
    if (!document.hasFocus()) desktopNotify({ title, body, tag: 'request', kind: 'admin', onClick: openAdmin });
    ping();
  };

  const ask = (options, onConfirm) => setConfirm({ ...options, onConfirm });

  function askDeleteChat(u) {
    ask(
      {
        title: `Delete your chat with ${u.name}?`,
        body: `All messages and files in this chat are removed from your account. ${u.name} keeps their own copy.`,
        confirmLabel: 'Delete chat',
        danger: true,
      },
      () => deleteChat(u).catch(() => {})
    );
  }

  /* ---------- render ---------- */

  let content;
  if (booting) {
    content = (
      <div className="splash">
        <Logo big />
      </div>
    );
  } else if (!session) {
    content =
      route === 'contact' ? (
        <ContactPage onAuthed={onAuthed} onBack={goLogin} />
      ) : (
        <AuthScreen onAuthed={onAuthed} onContact={goContact} />
      );
  } else {
    const me = session.user;
    const showAdmin = view === 'admin' && me.role === 'admin';
    const peer = showAdmin ? null : users.find((u) => u.id === active) || null;
    const nameOf = (id) => users.find((u) => u.id === id)?.name || 'Someone';
    // Who can be added to a running call: online people you can talk to who are not already in it.
    const inCallIds = new Set((call?.peers || []).map((p) => p.id));
    const addable = users.filter((u) => u.role !== 'guest' && !u.blocked && online.has(u.id) && !inCallIds.has(u.id));

    content = (
      <div className={`app ${peer || showAdmin ? 'has-chat' : ''}`}>
        <Sidebar
          me={me}
          users={users}
          online={online}
          unread={unread}
          activity={activity}
          pinnedChats={pinnedChats}
          active={active}
          view={showAdmin ? 'admin' : 'chat'}
          pendingCount={pending.length + requests.length}
          onOpenAdmin={openAdmin}
          onOpenSettings={() => setShowSettings(true)}
          onOpen={openChat}
          onTogglePin={togglePinChat}
          onDeleteChat={askDeleteChat}
          onLogout={logout}
        />

        <main className="chat-pane">
          {showAdmin ? (
            <AdminPanel
              ask={ask}
              online={online}
              refreshKey={adminTick}
              pending={pending}
              requests={requests}
              visitors={users.filter((u) => u.role === 'guest')}
              openRequest={openRequest}
              onChanged={() => setAdminTick((t) => t + 1)}
              onOpenChat={openChat}
              onClose={() => setView('chat')}
            />
          ) : peer ? (
            <ChatWindow
              key={peer.id}
              me={me}
              peer={peer}
              online={online.has(peer.id)}
              activity={activity[peer.id]}
              messages={messages[peer.id] || []}
              loading={loadingChat}
              chatPinned={pinnedChats.includes(peer.id)}
              ask={ask}
              onSendText={(text, replyTo) => sendText(peer, text, replyTo)}
              onSendFile={(file, onProgress, extra) => sendFile(peer, file, onProgress, extra)}
              onActivity={(kind, on) => sendActivity(peer.id, kind, on)}
              onReact={(m, emoji) => reactTo(peer, m, emoji)}
              onPin={(m, pinned) => pinMessage(peer, m, pinned)}
              onUnsend={(m) => unsendMessage(peer, m)}
              onTogglePinChat={() => togglePinChat(peer.id)}
              onDeleteChat={() => deleteChat(peer)}
              onCall={(video) => startCall(peer, video)}
              inCall={Boolean(call) && call.phase !== 'ended'}
              onToggleBlock={() => toggleBlock(peer)}
              getKey={() => sharedKeyFor(session.privateKey, peer.id, peer.publicKey)}
              onBack={() => setActive(null)}
            />
          ) : (
            <div className="empty">
              <Logo big />
              <p className="muted">
                {users.length
                  ? 'Pick someone to start an end-to-end encrypted chat.'
                  : me.role === 'admin'
                    ? 'Nobody has joined yet. Open "Groups & codes", create a group and share its code.'
                    : me.role === 'guest'
                      ? 'The admin has not opened this chat.'
                      : 'Nobody else is in your group yet.'}
              </p>
            </div>
          )}
        </main>

        {confirm && (
          <ConfirmDialog
            title={confirm.title}
            body={confirm.body}
            confirmLabel={confirm.confirmLabel}
            danger={confirm.danger}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const run = confirm.onConfirm;
              setConfirm(null);
              run();
            }}
          />
        )}

        {needsTheme && !splash && (
          <ThemePrompt initial={theme} onPreview={(t) => setTheme(applyTheme(t))} onDone={finishThemePrompt} />
        )}

        {showSettings && (
          <SettingsDialog me={me} theme={theme} onTheme={changeTheme} onClose={() => setShowSettings(false)} />
        )}

        <CallOverlay
          call={call}
          nameOf={nameOf}
          addable={addable}
          minimized={callMin}
          onMinimize={() => setCallMin(true)}
          onExpand={() => setCallMin(false)}
          onFlip={() => callsRef.current.flipCamera()}
          onAdd={(id) => callsRef.current.invite(id)}
          onAccept={() => callsRef.current.accept()}
          onReject={() => callsRef.current.reject()}
          onHangup={() => callsRef.current.hangup()}
          onMute={(m) => callsRef.current.setMuted(m)}
          onCamera={(c) => callsRef.current.setCameraOff(c)}
        />

        <Toasts
          items={toasts}
          onOpen={openToast}
          onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
        />
      </div>
    );
  }

  return (
    <>
      {content}
      {splash && <Splash key={splash.text} text={splash.text} onDone={() => setSplash(null)} />}
    </>
  );
}
