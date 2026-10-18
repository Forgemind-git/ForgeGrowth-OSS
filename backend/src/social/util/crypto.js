const socialEnv = require('../env');
// AES-256-GCM symmetric encryption for sensitive secrets stored in the DB
// (AI provider API keys). Format: base64(iv || tag || ct) where iv=12B,
// tag=16B, ct=variable. Derives a 32-byte key by SHA-256 of
// FORGESOCIAL_ENCRYPTION_KEY (falls back to JWT_SECRET so dev doesn't break).

const crypto = require('crypto');

// In ForgeGrowth this is SOCIAL_ENCRYPTION_KEY (see ../env.js). There is no
// fallback: an empty key would "encrypt" every stored secret with a known key.
const RAW = socialEnv.FORGESOCIAL_ENCRYPTION_KEY || '';
if (!RAW) {
  console.warn('[social/crypto] SOCIAL_ENCRYPTION_KEY is not set — saving secrets is refused until it is');
}
const KEY = crypto.createHash('sha256').update(RAW).digest(); // 32 bytes

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  if (!RAW) throw new Error('SOCIAL_ENCRYPTION_KEY is not set on the server');
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

// Mask a secret for display: keep first 4 + last 4 chars, fixed-length middle
// (so the true length isn't leaked).
function maskSecret(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 8) return '••••••••';
  return `${str.slice(0, 4)}••••••••${str.slice(-4)}`;
}

module.exports = { encrypt, decrypt, maskSecret };
