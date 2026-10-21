// App credentials for the Social section, entered in Settings → Integrations.
//
// Each key can come from two places: saved here by an admin (stored in this
// schema's app_settings as `credential:<KEY>`, secrets encrypted), or the
// server's SOCIAL_<KEY> environment variable. A value saved here wins; the
// environment is the fallback. env.js consults this cache first, so every
// module that reads socialEnv.<KEY> picks up a saved value without a restart.
//
// Secrets are never sent back to the browser — only whether they are set,
// where from, and their last four characters.
// db.js and util/crypto.js read env.js, and env.js reads this module — so both
// are required on first use, never at load time, or the cycle hands one of
// them a half-loaded module.
const db = () => require('./db');
const cryptoUtil = () => require('./util/crypto');

const CREDENTIALS = [
  { key: 'FACEBOOK_APP_ID', group: 'meta', label: 'Meta App ID', secret: false,
    help: 'App Dashboard → App settings → Basic → App ID.' },
  { key: 'FACEBOOK_APP_SECRET', group: 'meta', label: 'Meta App secret', secret: true,
    help: 'App Dashboard → App settings → Basic → App secret.' },
  { key: 'INSTAGRAM_OAUTH_CLIENT_ID', group: 'meta', label: 'Instagram App ID', secret: false,
    help: 'Instagram → API setup with Instagram login → Instagram app ID.' },
  { key: 'INSTAGRAM_OAUTH_CLIENT_SECRET', group: 'meta', label: 'Instagram App secret', secret: true,
    help: 'Instagram → API setup with Instagram login → Instagram app secret. Also used to verify webhook signatures.' },
  { key: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN', group: 'meta', label: 'Webhook verify token', secret: true,
    help: 'Any text you choose. Type the same text into the app’s Webhooks setup.' },
];
const BY_KEY = new Map(CREDENTIALS.map(c => [c.key, c]));

// Shape checks for the keys whose format Meta fixes. A browser that auto-fills
// a login into these fields (it happened: an email in the App ID, a password in
// the secret) is caught here instead of being stored and silently failing.
const FORMAT = {
  FACEBOOK_APP_ID: [/^\d{6,20}$/, 'should be digits only (App settings → Basic → App ID)'],
  INSTAGRAM_OAUTH_CLIENT_ID: [/^\d{6,20}$/, 'should be digits only'],
  FACEBOOK_APP_SECRET: [/^[0-9a-f]{32}$/, 'should be 32 characters of 0-9 and a-f'],
  INSTAGRAM_OAUTH_CLIENT_SECRET: [/^[0-9a-f]{32}$/, 'should be 32 characters of 0-9 and a-f'],
};
const PREFIX = 'credential:';

let cache = new Map();   // key -> plaintext value saved in the app

function get(key) {
  return cache.has(key) ? cache.get(key) : undefined;
}
function has(key) { return BY_KEY.has(key); }

async function load() {
  const { rows } = await db().query(
    'SELECT key, value FROM app_settings WHERE key LIKE $1', [PREFIX + '%']);
  const next = new Map();
  for (const r of rows) {
    const key = r.key.slice(PREFIX.length);
    const def = BY_KEY.get(key);
    if (!def || !r.value) continue;
    const plain = def.secret ? cryptoUtil().decrypt(r.value) : r.value;
    if (plain) next.set(key, plain);
  }
  cache = next;
}

function last4(v) { return v.length > 4 ? v.slice(-4) : ''; }

function status() {
  const socialEnv = require('./env');
  return CREDENTIALS.map(def => {
    const saved = cache.get(def.key);
    const server = socialEnv.serverValue(def.key);
    const value = saved || server || '';
    const source = saved ? 'app' : (server ? 'server' : null);
    return {
      key: def.key, group: def.group, label: def.label, secret: def.secret, help: def.help,
      set: !!value, source,
      // IDs are not secret and are shown in full; secrets only as their last 4.
      value: def.secret ? null : value || null,
      last4: def.secret && value ? last4(value) : null,
    };
  });
}

// values: { KEY: string | null }. A non-empty string saves it; '' or null
// removes the saved value (the server value, if any, applies again).
async function save(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    const e = new Error('Nothing to save'); e.status = 400; throw e;
  }
  const writes = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = BY_KEY.get(key);
    if (!def) { const e = new Error(`Unknown setting: ${key}`); e.status = 400; throw e; }
    const v = raw == null ? '' : String(raw).trim();
    if (v.length > 4000) { const e = new Error(`${def.label} is too long`); e.status = 400; throw e; }
    if (v && /\s/.test(v)) { const e = new Error(`${def.label} cannot contain spaces`); e.status = 400; throw e; }
    if (v && FORMAT[key] && !FORMAT[key][0].test(v)) {
      const e = new Error(`${def.label} ${FORMAT[key][1]} — was something auto-filled by the browser?`); e.status = 400; throw e;
    }
    if (v && def.secret) {
      try { writes.push([key, cryptoUtil().encrypt(v)]); }
      catch (err) {
        const e = new Error('Secrets cannot be saved yet: the server has no SOCIAL_ENCRYPTION_KEY.'); e.status = 503; throw e;
      }
    } else {
      writes.push([key, v]);
    }
  }
  for (const [key, stored] of writes) {
    if (stored) {
      await db().query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [PREFIX + key, stored]);
    } else {
      await db().query('DELETE FROM app_settings WHERE key = $1', [PREFIX + key]);
    }
  }
  await load();
  return status();
}

module.exports = { CREDENTIALS, get, has, load, save, status };
