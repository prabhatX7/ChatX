import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env no matter which folder the server is started from.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(name, hint = 'Copy server/.env.example to server/.env and fill it in.') {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`Missing ${name} in server/.env. ${hint}`);
    process.exit(1);
  }
  return value;
}

const jwtSecret = required('JWT_SECRET', 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
if (process.env.NODE_ENV === 'production' && jwtSecret.length < 32) {
  console.error('JWT_SECRET is too short. Use 32 or more random characters.');
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chatx',
  jwtSecret,

  // The account with this email is the admin. The admin's password is whatever they choose when they sign up
  // (it is never stored on the server, because the browser uses it to unlock the encryption keys).
  adminEmail: required(
    'ADMIN_EMAIL',
    'Add a line like ADMIN_EMAIL=you@example.com (or run: npm run init-env -- you@example.com).'
  ).toLowerCase(),

  // A secret only the admin knows. Needed once, to create the admin account, so nobody else can grab that email first.
  adminSetupCode: (process.env.ADMIN_SETUP_CODE || '').trim(),

  // Calls: free Google STUN works for most home networks. Strict networks (some mobile data and offices) need a
  // TURN relay: set TURN_URL (e.g. turn:turn.example.com:3478), TURN_USERNAME and TURN_CREDENTIAL. Optional.
  turn: {
    url: (process.env.TURN_URL || '').trim(),
    username: (process.env.TURN_USERNAME || '').trim(),
    credential: (process.env.TURN_CREDENTIAL || '').trim(),
  },

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  maxFileMB: Number(process.env.MAX_FILE_MB) || 100,
  // Where encrypted uploads are kept. On a host with a persistent disk, point this at the disk (for example /var/data/uploads).
  uploadDir: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve(__dirname, '../uploads'),
  // How many proxies sit in front of the server (1 = just the host, 2 = Cloudflare in front of the host).
  // It makes rate limits count real visitors instead of the proxy.
  trustProxy: Number(process.env.TRUST_PROXY) || 1,
  isProduction: process.env.NODE_ENV === 'production',
  clientDist: path.resolve(__dirname, '../../client/dist'),
};

if (config.jwtSecret.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (config.adminSetupCode && config.adminSetupCode.length < 8) {
  console.error('ADMIN_SETUP_CODE must be at least 8 characters.');
  process.exit(1);
}
