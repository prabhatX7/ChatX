# Deploying ChatX

This guide uses three free services: **MongoDB Atlas** (database), **GitHub** (your code) and **Render** (runs the app). **Cloudflare** is optional (your own domain, extra protection).

ChatX is one Node app. It serves the website and the API from the same address, so there is nothing else to host.

## 0. What you need
- A GitHub account, a MongoDB Atlas account and a Render account (all have free plans).
- The project folder on your computer, with `npm test` passing (run `npm run setup` once first).

## 1. Put the code on GitHub
Make sure `server/.env` is **not** uploaded (the included `.gitignore` already blocks it). From the project folder:
```bash
git init
git add .
git status          # check that .env and node_modules are NOT listed
git commit -m "ChatX v1"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/chatx.git
git push -u origin main
```
Create the empty repo on GitHub first (private is fine).

## 2. Database: MongoDB Atlas
1. Create a free **M0** cluster.
2. **Database Access** → add a user with a password (letters and numbers only keeps it simple). Give it "Read and write to any database".
3. **Network Access** → add `0.0.0.0/0` (Render's address changes, so it cannot be pinned; the password protects the database).
4. **Connect** → **Drivers** → copy the connection string. It looks like
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   Put the database name before the `?`, so the end reads `...mongodb.net/chatx?retryWrites=true&w=majority`, and put your real password in place of `PASSWORD`.

Note: free clusters pause after a long time with no use. Opening the Atlas page and resuming it fixes that.

## 3. App: Render
**Easiest:** Render dashboard → **New** → **Blueprint** → pick your repo. Render reads `render.yaml` and asks you for three values:
- `MONGO_URI`: the connection string from step 2
- `ADMIN_EMAIL`: the email you will log in with as admin
- `ADMIN_SETUP_CODE`: a secret only you know, 8+ characters (used once, in step 4)

(`JWT_SECRET` is created for you.)

**Or by hand:** New → **Web Service** → your repo, then
- Build command: `npm --prefix server install && npm --prefix client install --include=dev && npm run build`
- Start command: `npm --prefix server start`
- Health check path: `/api/health`
- Environment: `NODE_ENV=production`, `NODE_VERSION=20`, `JWT_SECRET` (32+ random characters), `MONGO_URI`, `ADMIN_EMAIL`, `ADMIN_SETUP_CODE`

(`--include=dev` matters: Render skips dev tools when `NODE_ENV=production`, and the build needs them.)

When the deploy finishes you get an address like `https://chatx-xxxx.onrender.com`.

## 4. First run
1. Open your address → **Sign up** with your `ADMIN_EMAIL`, a password of 10+ characters, and your `ADMIN_SETUP_CODE` in the "Group code" box. You are the admin.
2. Pick your colour in the popup.
3. **🗂 Groups & codes** → create a group → send its code to a friend. They sign up, you approve them.
4. Put `https://YOUR-ADDRESS/contact` on your portfolio for message requests.

If the page says "Encryption needs a secure page", you opened it over `http://`. Render gives you `https://` automatically.

## 5. Where uploads live (important on the free plan)
Photos, audio, video and files are stored (encrypted) in `server/uploads` on Render's disk. **On Render's free plan that disk is erased on every restart or redeploy**, and the app also sleeps after 15 minutes idle (the first visit then takes about a minute). Messages stay (they are in Atlas), but old attachments would break.

Pick one:
- **Just trying it:** stay on free. Text is safe, attachments are temporary.
- **Keep attachments:** use a paid Render plan with a **persistent disk**. In `render.yaml` uncomment the `disk:` block, and set the environment variable `UPLOAD_DIR=/var/data/uploads`. Check Render's pricing page for the current cost.
- **Not included:** storing files in object storage (Cloudflare R2, S3). That needs extra code.

To stop the free service sleeping, a free uptime monitor can open `https://YOUR-ADDRESS/api/health` every 10 minutes.

## 6. Optional: your own domain with Cloudflare
1. Render → your service → **Settings → Custom Domains** → add `chat.yourdomain.com` and follow its DNS instructions.
2. Cloudflare DNS: point the record at Render. Keep the cloud **orange (proxied)** if you want Cloudflare protection.
3. Cloudflare **SSL/TLS mode: Full (strict)**. Under Network, make sure **WebSockets** is On (needed for live chat).
4. In Render set `TRUST_PROXY=2` (Cloudflare + Render), so rate limits count real visitors and not one shared address.
5. Cloudflare's free and Pro plans accept uploads up to 100 MB, which matches the default `MAX_FILE_MB=100`.

## 7. Calls on strict networks (optional)
Audio and video calls connect directly between browsers using free Google STUN servers. Some networks (strict offices, some mobile data) block that. If a call does not connect for someone, add a TURN relay (a paid or self-hosted service) and set `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` in Render.

## 8. Updating ChatX later
Change the code, test it locally, then `git push`. Render rebuilds and redeploys by itself. Your users, chats and settings live in Atlas, so they stay.
- Never edit the `chatx:` labels in `client/src/crypto.js` (they are part of how keys are made).
- Changing `JWT_SECRET` signs everyone out once. That is harmless.
- Back up Atlas from its **Backup** or export pages if the chat matters to you. Encrypted messages are only readable with each person's password, so a backup cannot be read by anyone else either.

## 9. Security checklist
- `.env` is not on GitHub. `JWT_SECRET` is long and random.
- Atlas user has a strong password.
- `ADMIN_SETUP_CODE` is only needed until the admin account exists. Once it exists, the code does nothing, but keep it private anyway.
- Everyone, including you, picks a password of 10+ characters. **A forgotten password cannot be recovered** (that is how end-to-end encryption works).
- The admin cannot read other people's chats, by design.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Render build fails with "vite: not found" | The build command is missing `--include=dev` on the client install |
| App starts then stops: "Missing JWT_SECRET" / "Missing ADMIN_EMAIL" | Add the environment variable in Render and redeploy |
| "Could not connect to MongoDB" | Wrong password in `MONGO_URI`, no database name, or Network Access does not allow `0.0.0.0/0` |
| First page load takes a minute | Free plan waking up. Use the uptime monitor, or a paid plan |
| Images/files stopped loading after a while | Free-plan disk was erased. See section 5 |
| 530 or "Bad gateway" | The service is still starting or is sleeping. Wait a minute and refresh |
| Everyone shares "Too many requests" | Set `TRUST_PROXY` correctly (1 on Render alone, 2 with Cloudflare) |
