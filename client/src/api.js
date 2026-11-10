const TOKEN_KEY = 'chatx_token';

let token = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  /* storage blocked: stay signed out after reload */
}

let unauthorizedHandler = null;

export const getToken = () => token;
export const onUnauthorized = (fn) => {
  unauthorizedHandler = fn;
};

export function setToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request(path, { method = 'GET', json, raw = false, allow = [] } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body });
  } catch {
    throw new Error('Cannot reach the server');
  }

  if (!res.ok && !allow.includes(res.status)) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token && unauthorizedHandler) unauthorizedHandler();
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return raw ? res : res.json();
}

export const api = {
  register: (payload) => request('/auth/register', { method: 'POST', json: payload }),
  login: (payload) => request('/auth/login', { method: 'POST', json: payload }),
  me: () => request('/auth/me'),
  users: () => request('/users'),
  messages: (peerId) => request(`/messages/${peerId}`),
  send: (peerId, payload) => request(`/messages/${peerId}`, { method: 'POST', json: payload }),
  markSeen: (peerId) => request(`/messages/${peerId}/seen`, { method: 'POST' }),
  unsend: (peerId, id) => request(`/messages/${peerId}/${id}`, { method: 'DELETE' }),
  react: (peerId, id, body) => request(`/messages/${peerId}/${id}/react`, { method: 'PUT', json: body }),
  pin: (peerId, id, pinned) => request(`/messages/${peerId}/${id}/pin`, { method: 'PUT', json: { pinned } }),
  deleteChat: (peerId) => request(`/messages/${peerId}`, { method: 'DELETE' }),
  block: (peerId, blocked) => request(`/users/block/${peerId}`, { method: 'PUT', json: { blocked } }),
  myGroups: () => request('/users/me/groups'),
  joinGroup: (code) => request('/users/me/groups', { method: 'POST', json: { code } }),
  leaveGroup: (id) => request(`/users/me/groups/${id}`, { method: 'DELETE' }),
  setTheme: (theme) => request('/users/me/theme', { method: 'PUT', json: { theme } }),
  iceServers: () => request('/calls/ice'),
  pushKey: () => request('/push/key'),
  pushSubscribe: (subscription) => request('/push/subscribe', { method: 'POST', json: { subscription } }),
  pushUnsubscribe: (endpoint) => request('/push/unsubscribe', { method: 'POST', json: { endpoint } }),
  pushTest: () => request('/push/test', { method: 'POST', json: {} }),
  pinChat: (peerId, pinned) => request(`/users/pins/${peerId}`, { method: 'PUT', json: { pinned } }),

  // Admin only (the server checks the role on every call).
  adminGroups: () => request('/admin/groups'),
  createGroup: (name, isPrivate = false) =>
    request('/admin/groups', { method: 'POST', json: { name, private: isPrivate } }),
  adminPending: () => request('/admin/pending'),
  // `body` is {} (accept as requested), { group: null } (only me) or { group: '<group id>' }.
  approveUser: (id, body = {}) => request(`/admin/pending/${id}/approve`, { method: 'POST', json: body }),
  rejectUser: (id) => request(`/admin/pending/${id}/reject`, { method: 'POST', json: {} }),
  moveMember: (id, group) => request(`/admin/members/${id}`, { method: 'PATCH', json: { group } }),
  adminRequests: () => request('/admin/requests'),
  approveRequest: (id) => request(`/admin/requests/${id}/approve`, { method: 'POST', json: {} }),
  rejectRequest: (id) => request(`/admin/requests/${id}/reject`, { method: 'POST', json: {} }),
  removeVisitor: (id) => request(`/admin/visitors/${id}`, { method: 'DELETE' }),

  // "Send message request" (no account). Used by the contact page.
  guestRequest: (payload) => request('/guest/request', { method: 'POST', json: payload }),
  guestIntro: (id, payload) => request(`/guest/${id}/intro`, { method: 'POST', json: payload }),
  guestLogin: (payload) => request('/guest/login', { method: 'POST', json: payload, allow: [202] }),

  updateGroup: (id, patch) => request(`/admin/groups/${id}`, { method: 'PATCH', json: patch }),
  deleteGroup: (id) => request(`/admin/groups/${id}`, { method: 'DELETE' }),

  // XHR (not fetch) so we can report upload progress.
  uploadFile(blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      const form = new FormData();
      form.append('file', blob, 'blob');
      xhr.send(form);
    });
  },

  async downloadFile(fileId) {
    const res = await request(`/files/${fileId}`, { raw: true });
    return res.arrayBuffer();
  },
};
