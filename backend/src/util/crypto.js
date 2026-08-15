// AES-256-GCM symmetric encryption for sensitive secrets stored in the DB
// (currently: Meta WhatsApp access tokens). Format: base64(iv || tag || ct)
// where iv=12B, tag=16B, ct=variable. Derives a 32-byte key by SHA-256 of
// FORGECRM_ENCRYPTION_KEY (falls back to JWT_SECRET so dev doesn't break).

const crypto = require('crypto');

// Unset, this used to fall through to sha256('') — a key that is identical on
// every install in the world, deriving silently from a console.warn nobody reads
// in a container log. Every Meta token, Google refresh token and gateway secret
// written afterwards is then readable by anyone holding the database.
//
// It stayed unnoticed because the source install has a guard the image-only
// install does not: scripts/install.sh checks the length, so the failure only
// ever reached the path with no script in front of it. Refusing to start is the
// version of that check which cannot be routed around.
//
// Same shape as util/session.js, deliberately — fatal in production, a warning
// in development, so a checkout still runs with nothing configured.
const RAW = process.env.FORGECRM_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
if (!RAW) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[crypto] FORGECRM_ENCRYPTION_KEY is not set.\n' +
      '         Refusing to start: without it every stored Meta, Google and\n' +
      '         payment-gateway credential would be encrypted with a key that is\n' +
      '         the same on every install, and therefore no key at all.\n' +
      '         Generate one and restart:\n' +
      '           echo "FORGECRM_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env\n' +
      '         Back it up once set — it is the only thing that decrypts them.'
    );
    process.exit(1);
  }
  console.warn('[crypto] FORGECRM_ENCRYPTION_KEY unset — encrypting with the development key.');
}
const KEY = crypto.createHash('sha256').update(RAW).digest(); // 32 bytes

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  try {
    const buf = Buffer.from(ciphertextB64, 'base64');
    if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('ciphertext too short');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[crypto] decrypt failed:', err.message);
    return null;
  }
}

/**
 * Mask a secret for display in admin UI: keep first 4 + last 4 chars, mask the
 * middle with a fixed-length asterisk run (so length isn't leaked).
 */
function maskSecret(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 8) return '••••••••';
  return `${str.slice(0, 4)}••••••••${str.slice(-4)}`;
}

/**
 * SHA-256 hex digest of a string. Used to store bearer API keys as a one-way
 * hash (we never need to recover the plaintext — only compare on lookup).
 */
function hashApiKey(plain) {
  return crypto.createHash('sha256').update(String(plain || '')).digest('hex');
}

module.exports = { encrypt, decrypt, maskSecret, hashApiKey };
