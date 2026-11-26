import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = path.join(__dirname, 'auth_info');
export const ENC_FILE = path.join(__dirname, 'session.enc');
export const LOCAL_KEY_FILE = path.join(__dirname, 'session-key.txt');

export function getOrCreateKeyHex(allowCreate = false) {
  if (process.env.SESSION_KEY && process.env.SESSION_KEY.trim().length === 64) {
    return process.env.SESSION_KEY.trim();
  }
  if (fs.existsSync(LOCAL_KEY_FILE)) {
    const k = fs.readFileSync(LOCAL_KEY_FILE, 'utf8').trim();
    if (k.length === 64) return k;
  }
  if (allowCreate) {
    const newKey = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(LOCAL_KEY_FILE, newKey + '\n', 'utf8');
    return newKey;
  }
  throw new Error(
    'Missing SESSION_KEY! Provide SESSION_KEY env secret (64 hex chars) or run `npm run setup` locally first.'
  );
}

export function encryptAuthFolder(keyHex) {
  if (!fs.existsSync(AUTH_DIR)) {
    throw new Error(`Auth directory not found: ${AUTH_DIR}`);
  }
  const entries = fs.readdirSync(AUTH_DIR);
  const files = {};
  for (const name of entries) {
    const full = path.join(AUTH_DIR, name);
    if (fs.statSync(full).isFile()) {
      files[name] = fs.readFileSync(full).toString('base64');
    }
  }
  const jsonBuf = Buffer.from(JSON.stringify({ v: 1, files }), 'utf8');
  const compressed = zlib.gzipSync(jsonBuf, { level: 9 });

  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: [12-byte IV][16-byte AuthTag][Ciphertext]
  const payload = Buffer.concat([iv, tag, encrypted]);
  fs.writeFileSync(ENC_FILE, payload);
  return Object.keys(files).length;
}

export function decryptAuthFolder(keyHex) {
  if (!fs.existsSync(ENC_FILE)) {
    throw new Error(`Encrypted session file not found: ${ENC_FILE}`);
  }
  const payload = fs.readFileSync(ENC_FILE);
  if (payload.length < 29) {
    throw new Error('Invalid or corrupted session.enc file.');
  }

  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const jsonBuf = zlib.gunzipSync(compressed);
  const parsed = JSON.parse(jsonBuf.toString('utf8'));

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  let count = 0;
  for (const [name, b64] of Object.entries(parsed.files || {})) {
    const safeName = path.basename(name);
    fs.writeFileSync(path.join(AUTH_DIR, safeName), Buffer.from(b64, 'base64'));
    count++;
  }
  return count;
}

// CLI entrypoint if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'encrypt') {
    const key = getOrCreateKeyHex(true);
    const n = encryptAuthFolder(key);
    console.log(`Encrypted ${n} auth files -> session.enc`);
  } else if (cmd === 'decrypt') {
    const key = getOrCreateKeyHex(false);
    const n = decryptAuthFolder(key);
    console.log(`Decrypted ${n} auth files -> auth_info/`);
  } else {
    console.log('Usage: node session-crypto.mjs [encrypt|decrypt]');
  }
}
