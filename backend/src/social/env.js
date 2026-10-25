// Environment for the Social section (ported from ForgeSocial).
//
// ForgeGrowth and ForgeSocial read many of the SAME variable names
// (META/FACEBOOK app ids, JWT_SECRET, PUBLIC_BASE_URL, REDIS_URL, ...) with
// DIFFERENT meanings, and the Social section runs on its own Meta app. So every
// Social read goes through here: `SOCIAL_<NAME>` wins, and only the names in
// SHARED fall back to the unprefixed ForgeGrowth value. A Social platform
// credential therefore can never silently pick up a ForgeGrowth one.
//
// FORGESOCIAL_<X> names (kept verbatim from the ported code) also accept
// SOCIAL_<X>, so the env file reads SOCIAL_ENCRYPTION_KEY, not
// SOCIAL_FORGESOCIAL_ENCRYPTION_KEY.

const SHARED = new Set([
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
  'NODE_ENV', 'REDIS_URL', 'SUPABASE_DATABASE_URL', 'POSTGRES_SSL',
]);

// The install's own address, the same inputs util/publicUrl.js reads when no
// request is in hand (a background job, an OAuth redirect built at boot).
function installOrigin() {
  // PUBLIC_URL pins the install's address (util/publicUrl.js); it wins here too.
  const pinned = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/]+$/i.test(pinned)) return pinned;
  const tls = String(process.env.TLS_DOMAIN || '').trim();
  if (tls) return `https://${tls}`;
  const cors = String(process.env.CORS_ORIGIN || '').split(',')[0].trim().replace(/\/+$/, '');
  return cors || '';
}

const DEFAULTS = {
  DB_SCHEMA: 'social',
  UPLOADS_DIR: '/app/uploads/social',
  PUBLIC_BASE_URL: installOrigin(),
};

// What the SERVER provides for a name, ignoring anything saved in the app.
function serverValue(name) {
  const own = process.env[`SOCIAL_${name}`];
  if (own !== undefined && own !== '') return own;
  if (name.startsWith('FORGESOCIAL_')) {
    const short = process.env[`SOCIAL_${name.slice('FORGESOCIAL_'.length)}`];
    if (short !== undefined && short !== '') return short;
  }
  if (SHARED.has(name)) return process.env[name];
  return DEFAULTS[name];
}

// App credentials saved in Settings → Integrations win over the server's value
// (see credentials.js). Required lazily: credentials.js needs db.js, which
// needs this module.
function read(name) {
  const creds = require('./credentials');
  if (creds.has(name)) {
    const saved = creds.get(name);
    if (saved) return saved;
  }
  return serverValue(name);
}

module.exports = new Proxy({}, {
  get: (_t, name) => {
    if (name === 'serverValue') return serverValue;
    return typeof name === 'string' ? read(name) : undefined;
  },
  has: (_t, name) => read(name) !== undefined,
});
