import { io } from 'socket.io-client';

let socket = null;

export function connectSocket(token) {
  disconnectSocket();
  socket = io({ auth: { token } });
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/** Send a call signal (invite, accept, offer, ice, end…) to one person. The server only relays it. */
export function sendSignal(signal) {
  if (socket?.connected) socket.emit('call:signal', signal);
}

/** Tell a friend you are typing / speaking (kind: 'typing' | 'speaking'). Never stored by the server. */
export function sendActivity(to, kind, on) {
  if (socket?.connected) socket.emit('activity', { to, kind, on });
}

/** Tell the server whether ChatX is in front of you. When it is not, new messages and calls reach you as push notifications. */
export function sendVisible(visible) {
  if (socket?.connected) socket.emit('visible', visible === true);
}

/** The app has loaded: the server may now hand over a call that was ringing while it was closed. */
export function sendReady() {
  if (socket?.connected) socket.emit('ready');
}
