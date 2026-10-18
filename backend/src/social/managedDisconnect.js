const socialEnv = require('./env');
// ============================================================
// managedDisconnect.js — disconnect a platform's MANAGED account
// ============================================================
// The managed account is the single credential a platform keeps in app_settings
// (see accounts.js). It has no social_accounts row, so the normal "Remove" can't
// touch it. Disconnecting deletes its stored token keys; the account then drops
// out of the Integrations list, the sync worker and the MCP connector. Synced
// posts and snapshots stay. Reconnect any time via Credentials or "+ Add account".
const pool = require('./db');
const accounts = require('./accounts');

const MODULES = {
  youtube:  require('./youtube'),
  facebook: require('./facebook'),
  threads:  require('./threads'),
  linkedin: require('./linkedin'),
};

// app_settings keys that hold each platform's managed credential.
const KEYS = {
  facebook: ['facebook_page_token', 'facebook_page_name', 'facebook_token_refresh_error'],
  youtube:  ['youtube_refresh_token', 'youtube_token_refresh_error'],
  threads:  ['threads_access_token', 'threads_user_id', 'threads_token_expires_at'],
  linkedin: ['linkedin_access_token', 'linkedin_refresh_token', 'linkedin_token_expires_at',
             'linkedin_org_id', 'linkedin_org_name'],
};

// A token set in the server .env is read as a fallback when app_settings is empty,
// so deleting the DB key would not disconnect it. Refuse rather than pretend.
const ENV_FALLBACK = {
  facebook: 'FACEBOOK_PAGE_TOKEN',
  youtube:  'YOUTUBE_REFRESH_TOKEN',
};

async function disconnectManaged(platform) {
  const keys = KEYS[platform];
  if (!keys) throw new Error(`Disconnect isn't supported for ${platform}`);

  const envVar = ENV_FALLBACK[platform];
  if (envVar && socialEnv[envVar]) {
    throw new Error(`This account's token comes from ${envVar} in the server .env file — remove it there and restart to disconnect`);
  }

  const mod = MODULES[platform];
  let accountId = null;
  try { accountId = (await mod.testConnection(true))?.profile?.id || null; } catch (_) {}

  await pool.query('DELETE FROM app_settings WHERE key = ANY($1)', [keys]);
  if (typeof mod.cacheInvalidate === 'function') mod.cacheInvalidate('');

  // If it was the user-chosen primary, clear that so the list falls back cleanly.
  if (accountId) {
    await pool.query('DELETE FROM app_settings WHERE key = $1 AND value = $2',
      [`primary_account:${platform}`, String(accountId)]).catch(() => {});
  }
  return { ok: true };
}

function mount(app, adminOnly) {
  app.post('/api/social/integrations/:platform/managed/disconnect', adminOnly, async (req, res) => {
    try {
      if (!accounts.PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Unknown platform' });
      res.json(await disconnectManaged(req.params.platform));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = { disconnectManaged, mount };
