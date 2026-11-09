# ChatX — private end-to-end-encrypted chat (MERN)

## 1. Goal
A tiny, closed chat app for you and your friends. Nobody else can read the messages — not even the person who runs the server.

## 2. Requirements
| Need | How it is met |
|---|---|
| MERN | MongoDB + Express + React (Vite) + Node |
| Email/password sign-up and login | JWT sessions; password is never sent to the server (see §4) |
| Models | `User` (messages embedded in it), `Group` (one sign-up code per folder) and `RequestedUser` (visitors), see §5 |
| End-to-end encryption | WebCrypto in the browser: ECDH P-256 keys, AES-256-GCM |
| Share images, mp3, mp4, any file | Files are encrypted in the browser, then uploaded as opaque blobs |
| Desktop pop-up when a friend sends something | Socket.IO event, decrypted locally, shown with the browser Notification API: "<name> sent this" |
| Only the people I let in | Sign-up requires a group code that the admin generated |
| Admin | The account whose email is `ADMIN_EMAIL` in `server/.env`. Created once with `ADMIN_SETUP_CODE`; the admin's password is chosen at sign-up |
| One code per folder (group) | The admin makes groups in the app; each has its own code. Signing up with a code puts you in that group |
| Members only see their own group | Enforced on the server (user list, sending, live presence, typing), not just hidden in the UI |
| Everyone can reach the admin; admin sees all groups and can message anyone | The admin is visible to every member; the admin's list is shown grouped in folders |
| Cursor goes to the message box on opening a chat or starting a reply | `Composer` focuses its textarea on mount and whenever a reply starts |
| Click a message to reply to it | Clicking a message bubble starts a reply (buttons, players and text selection are excluded) |
| Black UI, a little neon | Pure `#000` background, thin borders with a soft glow in the chosen colour |
| Colour: purple or blue (both a little neon) | `theme` + `themeChosen` on the account; `<html data-theme>`; one small pop-up after the first sign-up / log-in, then ⚙ Settings; follows the account to any device. Not shown on the login page |
| Small 3D ChatX logo | `Logo.jsx` + `.logo3d` CSS: "Chat" in black with a violet outline, "X" in blue; same artwork as the favicon |
| Coding-style font | JetBrains Mono, bundled with `@fontsource` (so the strict content-security policy still applies) |
| Audio and video calls | WebRTC between the browsers; signalling relayed by Socket.IO (see "Calls" in §4) |
| Block a user | `User.blocked`; folded into the single `canChat` rule, so messages, calls, typing and presence all obey it |
| Animations for every action | CSS keyframes (soft spring); a `fresh` flag so only live messages animate, not history; off under `prefers-reduced-motion` |
| A different hello on open / refresh / sign-up / log-in | `greetings.js` (40 lines, never the same twice in a row), `Splash` overlay |
| Message request without signing up (from the portfolio) | `/contact` page + `RequestedUser` model; admin approves; becomes a private text / voice / picture chat with only the admin |

## 3. Architecture
```
Browser A (React)                     Server (Express)                  Browser B (React)
 keys, encrypt/decrypt   --HTTPS-->   auth, store ciphertext   <--HTTPS--   keys, encrypt/decrypt
        ^                              MongoDB: User docs                         ^
        +------------- Socket.IO (realtime event: "new ciphertext") --------------+
```
The server only ever handles ciphertext and public keys.

## 4. Security design
1. **Identity key** – each user generates an ECDH P-256 key pair in the browser at sign-up.
2. **Password handling** – `PBKDF2-SHA256 (310k rounds, salt = app+email)` → master secret → `HKDF` splits it into
   - `authSecret` (sent to the server, which stores only `bcrypt(authSecret)`), and
   - `wrapKey` (never leaves the browser).
   The server never sees the real password, and cannot derive `wrapKey`.
3. **Private key storage** – the private key is wrapped with `wrapKey` (AES-GCM) and stored on the server so you can log in from another device. Locally it is kept as a **non-extractable** CryptoKey in IndexedDB.
4. **Messages** – `ECDH(myPrivate, friendPublic)` → `HKDF` → AES-256-GCM key shared by the pair. Fresh random IV per message. The sender→recipient ids are bound in as AAD so the server cannot flip a message's direction.
5. **Files** – encrypted in the browser with the same pair key before upload. File name, type and size travel inside the encrypted message payload, so the server only sees an opaque blob.
6. **Safety number** – a fingerprint of both public keys shown in the chat header. Compare it with your friend once (call or in person) to rule out a tampered key exchange.
7. **Transport hardening** – helmet + strict CSP, rate-limited auth, JWT, per-file authorization.

### Admin and groups: who can see whom
| Who | Sees | Can message |
|---|---|---|
| Admin | every approved member, shown in folders by group | anyone approved |
| Member | the admin + members of any group they belong to (own group + extra groups joined in Settings) | the same |
| Member with no group ("only me") | the admin only | the admin only |
| Waiting for approval | nobody | nobody (cannot log in) |

- One rule, `canChat(a, b)` in `server/src/services/access.js` (unit-tested): false if either is pending; true if either is the admin; otherwise true only when both share at least one group (`group` plus `extraGroups`; `groupIdsOf` in the same file). Members add extra groups themselves with `POST /api/users/groups {code}`; private codes cannot be joined this way.
- It is applied on the server to: `GET /api/users` (only the allowed people are ever sent to a browser), `POST /api/messages/:peerId`, `PUT /api/users/pins/:peerId`, typing/speaking relays, and who gets `user:new` / `presence` events (Socket.IO rooms `admins` and `group:<id>`).
- The admin role is read from the database on every admin request, never from the login token.
- **The admin cannot read other people's chats.** Messages are end-to-end encrypted between the two people, so the admin sees who is in each group but not what they write. This is deliberate: giving the admin a way to read chats would break the encryption for everyone.
- **Admin sign-up:** only the `ADMIN_EMAIL` address can become the admin, and only with `ADMIN_SETUP_CODE`, so nobody can grab the admin email first. All sign-up failures show the same "That code is not valid" message so it does not reveal which email is the admin's.
- **Group codes:** 10 random characters (no 0/O/1/I), compared without case or dashes. The admin can close a code (no new sign-ups), replace it with a new one, or delete an empty group. Existing members stay when a code is closed or replaced.
- **Approval:** member sign-ups are stored with `status: 'pending'` and no token is issued. Login for a pending account returns 403 (after the password check). The admin gets a `signup:pending` event, then approves (requested group, another group, or "only me") or rejects (account deleted). The server decides the destination in `services/approval.js` (unit-tested).
- **Private codes:** a group with `private: true` never puts anyone in a shared group. Approved people get `group: null` and `via: <private group>`, so they see only the admin, and the admin sees them in that code's folder. The admin can also move any member to another group or "only me" (`PATCH /api/admin/members/:id`); the person is told to reconnect (`session:refresh`) so live updates follow the new group.

### Calls
- Media (audio / video) goes browser to browser over WebRTC and is always encrypted (DTLS-SRTP). Nothing is recorded.
- The server only relays signals (`invite`, `accept`, `reject`, `busy`, `end`, `offer`, `answer`, `ice`) through `call:signal`. The signal types, ids and sizes are validated (`services/calls.js`) and rate-limited.
- **The session description (it holds the DTLS key fingerprints) and the network candidates are additionally encrypted with the pair key**, bound to the call id and direction. A malicious server therefore cannot read them or swap fingerprints to listen in. The safety number still lets you check the keys once.
- Calls are only relayed when `canChat` is true (so not across groups, not when blocked, not to visitors), and the browser hangs up when the other person is blocked or removed mid-call.
- **Group calls:** a mesh, one WebRTC link per pair, max 6 people. Anyone in a call can add an online person they can chat with: the adder rings them with the same call id; on accept the adder sends `joined{who}` and each existing member offers directly to the newcomer. Signals stay pair-key encrypted; the server relays only. **Call log:** the device that rang someone writes an ordinary encrypted message `{k:'call', video, o, t0, t1}` (rendered as a call entry), so the server learns nothing new. Offline people cannot be added.
- The call engine is `client/src/call.js`, a plain class with injected dependencies, unit-tested with fakes (outgoing, incoming, busy, reject, missed, blocked camera, dropped connection, buffered candidates).
- STUN is Google's free service; TURN is optional (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`). Calls on strict networks may fail without TURN. Honest limit: with STUN, the other person's network address is visible to you and Google's STUN (standard WebRTC).

### Blocking
`User.blocked` holds the ids you blocked. `canChat(a, b)` = `canSee(a, b)` and neither blocked the other. `canSee` (groups + approval only) is kept separate so you can still unblock someone you cannot message. The blocked person's list drops you (not told who blocked them) and both clients get `session:refresh`.

### Message requests (visitors without an account)
1. The browser makes a random secret and derives keys from it exactly like a password (`deriveCredentials('guest@chatx', secret)`); the server stores only a SHA-256 of the derived auth secret and the wrapped private key.
2. `POST /api/guest/request` creates a pending `RequestedUser` and returns the admin's public key. `POST /api/guest/:id/intro` stores one encrypted message (contact + text) with AAD `<visitorId>><adminId>`. The server never sees either in clear.
3. The admin's browser decrypts it in **Message requests**. **Approve** sets `status: 'active'` and copies the intro into the admin's own chat copy. **Decline** deletes it.
4. From then on a visitor is an ordinary chat peer using the same encrypted pipeline. `services/accounts.js` finds which collection holds an id. `canChat`: visitor <-> admin only; never visitor <-> member or visitor <-> visitor; pending = nobody.
5. Limits for visitors: text, voice, pictures only (client-enforced, since file types are encrypted); uploads capped at 10 MB (server-enforced); no calls, blocking, pinning or groups (server returns 403 / ignores signals).
6. Spam control: 12 calls (6 requests) per hour per address on `/request` + `/intro`, 200 unanswered requests max, half-finished requests cleared after an hour.
7. Coming back: the secret is kept in this browser and offered as a private link (`/#guest=<id>.<secret>`, in the URL fragment, so it is never sent to the server). Anyone with the link can open the chat.

### What the server can still see (metadata)
Who talks to whom, when, ciphertext sizes, and that a message has an attachment. Not the content, names, or file types. The server (and so the admin screen) also knows which group each member is in.

### What is encrypted vs. plain
| Thing | Stored as |
|---|---|
| Text, file/voice metadata, **reply target id**, voice waveform | inside the encrypted message payload |
| **Emoji reactions** | each reaction is its own AES-GCM blob (AAD `react:<messageId>:<reactorId>`) |
| Delivered / seen times, pinned flag, unsent flag | plain metadata on the message (the server needs them to relay status) |
| Pinned chats | plain list of friend ids on your `User` document |
| Typing / speaking | never stored, relayed over Socket.IO only |

### Known limits (honest list)
- No forward secrecy (static keys per user). A Double-Ratchet upgrade is the next step if needed.
- Forgetting the password = history is unrecoverable (that is what E2EE means).
- A malicious *server operator* could swap public keys at first contact → verify the safety number.
- Pop-ups work while the app tab/browser is open (even in the background). Pop-ups with the browser fully closed need Web Push (future).
- Needs HTTPS (or localhost) because WebCrypto is only available in secure contexts.

## 5. Data model — `User` (messages embedded), `Group` and `RequestedUser`
```
Group { name, code (unique, upper-case, no dashes), active, createdAt }   // one folder + its sign-up code

User {
  name, email (unique), authHash (bcrypt),
  publicKey (JWK string), encPrivateKey { iv, data },
  role: 'member' | 'admin',                      // admin = the ADMIN_EMAIL account
  group: ObjectId | null,                        // the folder a member belongs to (admin has none)
  pinnedChats: [ObjectId],                       // friends pinned to the top of this user's list
  messages: [ {
    _id, from, to, peer, iv, ct, fileId?, createdAt,
    deliveredAt?, seenAt?,                       // receipts
    pinned, pinnedAt?,                           // shared by both people
    unsent,                                      // iv/ct/fileId wiped, tombstone kept
    reactions: [ { by, iv, ct } ]                // encrypted emoji, one per person
  } ]                                            // embedded
}
```
Each message is stored in both participants' documents (same ciphertext), so either person can reload history. Receipt, pin, unsend and reaction changes are written to both copies. Trade-off of "one model": fine for a few friends; split into a `Message` collection if it ever grows large.

## 6. API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | create account (needs an open group's code, or `ADMIN_SETUP_CODE` for the admin email) |
| POST | `/api/auth/login` | returns JWT + wrapped private key + role |
| GET | `/api/auth/me` | current user (with role) |
| GET | `/api/users` | the people **you may see** + their public keys + your `pinnedChats` (admin: everyone, tagged with their group) |
| POST | `/api/guest/request` | **public:** start a message request (name + keys), returns the admin's public key |
| POST | `/api/guest/:id/intro` | **public:** the one encrypted request message (needs the visitor's secret) |
| POST | `/api/guest/login` | **public:** check a request / sign in once approved (`202 {pending}` while waiting) |
| GET | `/api/admin/requests` | **admin only:** pending message requests (encrypted) |
| POST | `/api/admin/requests/:id/approve` / `/reject` | **admin only:** approve (private chat) or decline |
| DELETE | `/api/admin/visitors/:id` | **admin only:** remove an approved visitor |
| PUT | `/api/users/block/:peerId` | block / unblock (`{blocked}`) |
| PUT | `/api/users/me/theme` | `{theme: 'purple' \| 'blue'}` |
| GET | `/api/calls/ice` | ICE (STUN / TURN) servers for a call |
| GET | `/api/admin/groups` | **admin only:** all groups with codes and members, plus `privateOthers` (approved people with no group) |
| GET | `/api/admin/pending` | **admin only:** people waiting for approval |
| POST | `/api/admin/pending/:id/approve` | **admin only:** body none = as requested, `{group:null}` = only me, `{group:id}` |
| POST | `/api/admin/pending/:id/reject` | **admin only:** delete the request |
| PATCH | `/api/admin/members/:id` | **admin only:** move to `{group: id|null}` |
| POST | `/api/admin/groups` | **admin only:** create a group (`{name, private}`), returns it with a new code |
| PATCH | `/api/admin/groups/:id` | **admin only:** rename, open/close the code (`{active}`), or `{regenerate: true}` for a new code |
| DELETE | `/api/admin/groups/:id` | **admin only:** delete an empty group |
| PUT | `/api/users/pins/:peerId` | pin / unpin a chat (`{pinned}`) |
| GET | `/api/messages/:peerId` | encrypted history |
| POST | `/api/messages/:peerId` | store + relay a ciphertext |
| POST | `/api/messages/:peerId/seen` | mark the friend's messages as seen |
| DELETE | `/api/messages/:peerId/:msgId` | unsend your own message (both sides) |
| PUT | `/api/messages/:peerId/:msgId/react` | set / clear your encrypted reaction |
| PUT | `/api/messages/:peerId/:msgId/pin` | pin / unpin a message (`{pinned}`) |
| DELETE | `/api/messages/:peerId` | delete the whole chat from *your* account |
| POST | `/api/files` | upload encrypted blob (≤ `MAX_FILE_MB`) |
| GET | `/api/files/:id` | download (only participants) |

Socket events (server → client): `message`, `message:update`, `status` (delivered/seen), `activity` (typing/speaking), `chat:deleted`, `chats:pinned`, `presence`, `presence:list`, `user:new`, `signup:pending`, `request:new`, `admin:changed`, `users:changed`, `session:refresh`, `session:end`, `call:signal` (both ways).
Client → server: `activity` `{to, kind: 'typing'|'speaking', on}` (rate-limited, validated, never stored).

Delivery rules: a message is **sent** once stored; **delivered** as soon as the friend has any open connection (or, if they were offline, when they next connect); **seen** when the friend has that chat open in a focused window.

## 7. UI spec
**Admin:** a "Groups & codes" screen (button in the sidebar, admin only) to create groups, copy each group's code, close/reopen/replace it, rename or delete a group, and approve or reject people waiting to join (choosing a group, or "Only me"), make private one-to-one codes, move members between groups, and open a chat with any member. The admin's chat list is shown in folders, one per group. Members see the admin first, with an "Admin" badge.

**Composer:** the cursor is put in the message box when a chat opens, when a reply starts (by click, by the ↩ button or by the menu), after sending, after choosing files and after a voice note. `Esc` cancels a reply. Clicking a message (not its buttons, players or selected text) starts a reply to it; messages that are still sending, unsent or broken cannot be replied to.

Message actions live in a hover toolbar (☺ react, ↩ reply, ⋯ more) that is always faintly visible on touch screens. Black (`#000`) only. Surfaces have a thin border in the chosen colour (purple or blue) with a soft glow; the active chat and focused inputs glow a little brighter. The colour pop-up appears once after the first sign-up / log-in (`themeChosen`), never on the login page. Responsive: sidebar + chat on desktop, single pane on phones.

## 8. Status
ChatX v1: accounts, admin + groups (+ joining extra groups), approval, end-to-end encrypted messages, files (Photos or Document mode), voice, reactions, replies, pins, unsend, 1:1 and group calls with camera flip, minimise and call log, blocking, message requests, crystal logo, phone-first design.

### Verification status
- **Passed:** client tests (crypto, call engine incl. flip camera, group call and call log with fake WebRTC, themes, signal encryption) and server tests (visibility incl. multi-group, blocks, pending, private codes, approval, validation). The real React client was driven in headless Chromium (phone and desktop sizes, fake camera) against an in-memory mock of the server: login, chat, settings, join-by-code, attach menu, admin panel, 1:1 call, adding a third person, minimise/return, call-log entries.
- **Not run for real:** the live Express + MongoDB server and calls between two real devices/networks (TURN may be needed). Do a hands-on test with the README checklist after deploying.
- Key-derivation labels start with `chatx:`. Do not change them once real accounts exist.

## 9. Later
Remove a member, ask a waiting person to be notified when approved, several admins, Web Push for closed-browser pop-ups, forward secrecy (ratchet), a switch to turn read receipts off, "delete for everyone" on whole chats, message editing, group chats between members.
