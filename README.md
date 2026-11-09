# ChatX v1 — private end-to-end-encrypted chat

**ChatX** is a small MERN app (MongoDB, Express, React, Node) for you and your friends. Messages, photos, audio, video and any other file are encrypted in the browser before they leave the device, so the server only ever stores scrambled data.

## Features

- Email + password accounts (the password itself is never sent to the server)
- Sign-up needs a **group code** from the admin, and the **admin approves** each person. Each group only sees itself plus the admin
- Text, images, mp3, mp4 and any file (drag and drop, paste, or 📎); **voice messages**
- Desktop pop-up: "**Name sent this**" (decrypted on your device)
- Message status (sent / delivered / seen), typing and speaking hints, reactions, replies, pins, unsend, delete chat
- **Audio and video calls** (WebRTC, encrypted; call set-up is encrypted too): flip front/back camera, **minimise** a call and go back to your chats while it keeps running, **add people from your group** to a running call (up to 6), and a **call log** (called at / ended at, duration) saved in the chat
- **Attach as Photos or Document:** Photos shrinks very large pictures to save data; Document sends the file untouched, original quality, as a file card
- **Join another group** with its code in ⚙ Settings; you keep your current group and chats
- Phone-first layout; the logo is a faint watermark behind your messages
- **Block** a user (both ways)
- **Colour:** purple or blue, both a little neon on pure black. You choose in a small pop-up after your first sign-up / log-in, and can change it in ⚙ Settings
- A small 3D **ChatX** logo, a different hello each time the app opens, springy animations, coding-style font
- **Message requests**: a visitor can write to the admin from `/contact` without an account (below)

**Admin:** the account whose email is `ADMIN_EMAIL`. Makes groups and codes (🗂 **Groups & codes**), approves or rejects sign-ups, makes private codes ("only me" chats), moves people, answers message requests. The admin cannot read other people's chats.

More detail: [PLAN.md](PLAN.md) (design, security, API). Deploying: [DEPLOY.md](DEPLOY.md).

## Run it on your computer

You need **Node 20+** and **MongoDB** (local, or a free Atlas cluster).

```bash
# unzip, then open a terminal in the folder that contains package.json
npm run setup                               # installs everything, creates server/.env with random secrets
node scripts/make-env.mjs you@example.com   # sets YOUR email as the admin
npm run dev                                 # server :5000, app http://localhost:5173
```

`setup` prints an **admin setup code** (saved as `ADMIN_SETUP_CODE` in `server/.env`). You need it once, to create the admin account. Using Atlas? Put the connection string in `MONGO_URI` in `server/.env`.

## First-run checklist

1. Open http://localhost:5173 → **Sign up** with your admin email, a password (10+ characters) and the admin setup code in the "Group code" box. A small pop-up asks purple or blue.
2. **🗂 Groups & codes** → create a group, copy its code.
3. In a second browser (not a private window) sign up with that code. It says "Request sent". Approve it as admin. Then log in there.
4. Send text, a photo, an mp3, an mp4 and a PDF each way. Click **🔒 Verify**: both sides show the same safety number.
5. Allow pop-ups, switch tabs, send from the other account: you get a pop-up.
6. Typing, voice message, react, reply, pin, unsend; ⋮ in the header: pin, block, delete chat.
7. **Calls:** 📞 / 🎥 between two browsers (allow the microphone). Block someone: messages and calls stop; unblock restores them.
8. ⚙ Settings: switch purple / blue. Refresh: a new hello each time.
9. In a logged-out browser open `/contact`, send a request, approve it as admin: the visitor gets a private chat with you.
10. Try a **Private** code: that person sees only you, and appears as a plain chat (no folder).
11. **Group call:** start a video call, tap ＋ and add a third person; tap ⌄ to minimise, go to another chat, tap the green bar to return. Afterwards the chat shows a call entry.
12. ⚙ Settings → enter a second group's code: you can now also chat with that group.

## Deploy

Follow [DEPLOY.md](DEPLOY.md) (Render + MongoDB Atlas, optional Cloudflare). Short version: `npm run build` then `npm start` serves app and API on one port, behind https.

## Message requests (no account)

For a visitor (for example from your portfolio) who should be able to write to you without signing up.

- **The link to put on your portfolio:** `https://YOUR-DOMAIN/contact`. It opens a page with a form: name, email or phone (optional) and a message. The login page also has **Send a message request without signing up**.
- The visitor's browser makes a secret just for them, creates encryption keys from it, and **encrypts the contact details and message for you** before sending. The server only stores ciphertext (plus the name they typed).
- You get a badge and a pop-up. In **🗂 Groups & codes → Message requests** you see their name, contact and message (decrypted in your browser) and can **Approve** or **Decline**.
- **Approve** turns the request into the first message of a **private chat between only you and them** (a folder called "Message requests" in your list). They never see anyone else and nobody else sees them.
- They are stored in a separate collection (`requestedusers`), not with real accounts. They can send **text, voice notes and pictures only** (max 10 MB each), and **no audio or video calls**.
- They have no password. After sending, the page shows a **private link**; keeping it lets them come back to the chat from any device. Anyone holding that link can open the chat, so it should not be shared. This browser also remembers them.
- You can **Remove** an approved visitor any time. Until you approve, they cannot log in and nobody can see them. Anti-spam: 6 requests per hour per network address, and at most 200 unanswered requests.

## How the encryption works (short version)

1. At sign-up your browser creates a key pair. The private key is locked with a key made from your password and stored on the server only in that locked form.
2. For each friend, your browser combines your private key with their public key to get a secret only the two of you share (ECDH → AES-256-GCM).
3. Text and files are encrypted with that secret before upload. File names and types are inside the encrypted message.
4. The server stores ciphertext and relays a "new message" signal. Your friend's browser decrypts and shows the pop-up.

Replies (which message you quoted), voice-note waveforms and emoji reactions are encrypted the same way.

What the server can still see: who talks to whom, when, message sizes, that a message has an attachment, and the small bits of state it needs to do its job: delivered/seen times, which messages are pinned, which chats you pinned, and live "typing / speaking" hints (relayed, never stored).

## Honest limits

- **Forgotten password = lost history.** That is how real E2EE works.
- **No forward secrecy:** keys are long-lived. If someone ever gets your unlocked device, they can read that conversation's history.
- **Check the safety number once** with your friend (call or in person). It protects against a tampered server swapping keys at first contact.
- **Seen receipts are always on** (there is no switch to turn them off yet).
- **Voice messages need a microphone permission** and an https:// (or localhost) page. Recording length is capped at 5 minutes.
- **Unsend can't reach screenshots or copies** your friend already made, and a friend who had the file open keeps what they already downloaded.
- **Pop-ups need the app open** in a tab or window (it can be in the background). Pop-ups with the browser fully closed would need Web Push, which is not included.
- **The admin cannot read other people's chats**, by design. Adding a way to would break the encryption for everyone.
- **The admin's password** is the one they choose when they sign up. It is not stored in `.env`, because the browser uses it to unlock the encryption keys. If it is forgotten, the admin's old messages cannot be recovered (the admin role stays with the `ADMIN_EMAIL` address).
- **No removing members yet.** You can move people between groups (or to "Only me") but not delete their account. Closing a code stops new sign-ups but does not remove anyone.
- **Messages are stored inside each person's `User` document.** That is fine for a few dozen people; if it ever grows large, move messages to their own collection.
- **Calls need https:// (or localhost)**, a microphone (and camera for video), and the other person online with the app open. Most home networks connect with the built-in free STUN servers. Strict networks (some mobile data and offices) also need a TURN relay: set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` in `server/.env`. There is no group calling. Calls are not written into the chat history.
- **Blocking hides, it does not delete.** Existing messages stay on both sides. Blocking is checked by the server for messages, calls and typing hints.
- Upload limit is 100 MB per file (`MAX_FILE_MB` on the server, `MAX_FILE_MB` in `client/src/components/ChatWindow.jsx`).

## Tests

```bash
npm test     # 29 client tests (crypto, calls, greetings, themes, visitors) + 47 server tests (visibility, approvals, visitors, calls, codes, .env script)
```

These tests cover the logic only. The full app has not been run against real MongoDB and browsers by its builder, so do the checklist above once before you rely on it.

## Project layout

```
server/   Express + Mongoose + Socket.IO
  src/models/        User, RequestedUser (visitors), Group
  src/routes/        auth, users, admin, messages, files, guest, calls
  src/services/      access (who may see whom), accounts, approval, calls, codes, bootstrap, receipts, theme
  src/socket.js      presence, typing and call-signal relay
  tests/
client/   React + Vite
  src/crypto.js      all encryption (WebCrypto)
  src/call.js        call engine (WebRTC), testable without a browser
  src/components/    screens and widgets (Logo, ThemePrompt, Settings, Chat, Admin ...)
  tests/
scripts/make-env.mjs   creates / completes server/.env
render.yaml, DEPLOY.md deployment
```

## Troubleshooting

- **"Encryption needs a secure page"** → open the app via https:// or http://localhost.
- **"Could not connect to MongoDB"** → start MongoDB, or fix `MONGO_URI` in `server/.env`.
- **Mic button says access was blocked** → allow the microphone for the site in the browser's address bar.
- **No pop-ups** → click "Enable desktop pop-ups" and allow notifications for the site; check your OS "Do not disturb" setting.
- **Server stops with "Missing ADMIN_EMAIL"** → run `node scripts/make-env.mjs you@example.com`, or add `ADMIN_EMAIL=you@example.com` to `server/.env`.
- **Sign-up says "That code is not valid"** → the group code is wrong, or the admin closed it. Ask the admin for a current one. For the admin account: use the exact `ADMIN_EMAIL` and the `ADMIN_SETUP_CODE`.
- **I signed up with a code but see nobody** → you only see people in your group and the admin. Ask the admin to give the same code to the people you want to chat with.
