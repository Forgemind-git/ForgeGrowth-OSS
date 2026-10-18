// ============================================================
// accounts.js — unified multi-account layer for the Integrations page
// ============================================================
// Presents a consistent account list per platform. Instagram has its own
// multi-account table (instagram_accounts, wired to webhooks/inbox); the other
// platforms keep their primary credential in app_settings and hold ADDITIONAL
// accounts in social_accounts. This layer merges both into one shape so the UI
// can render a platform → accounts drill-down uniformly.
const pool = require('./db');
const instagram = require('./instagram');

const MODULES = {
  youtube:  require('./youtube'),
  facebook: require('./facebook'),
  threads:  require('./threads'),
  linkedin: require('./linkedin'),
};

const PLATFORMS = ['instagram', 'youtube', 'facebook', 'threads', 'linkedin'];

// Normalize a platform module's testConnection() profile into the unified shape.
// `managed` = this account's credential lives in app_settings (the legacy single
// connection) → it's edited via the Credentials modal and can't be Removed. This
// is independent of `primary` (the user-chosen default), added later in listAccounts.
function fromProfile(platform, status, managed = true) {
  const p = status.profile || {};
  return {
    accountId: String(p.id || p.channelId || p.username || 'primary'),
    label:     p.name || p.username || p.title || labelFor(platform),
    username:  p.username || null,
    avatar:    p.thumbnailUrl || p.pictureUrl || null,
    connected: status.connected === true,
    tokenHealthy: status.connected === true,
    managed,
  };
}

function labelFor(platform) {
  return { instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn' }[platform] || platform;
}

// The user-chosen primary account for a platform is a display/default-selection
// preference stored in app_settings — it does NOT change credentials or sync.
const primarySettingKey = (platform) => `primary_account:${platform}`;

async function getPrimaryKey(platform) {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [primarySettingKey(platform)]);
    return rows[0]?.value || null;
  } catch (_) { return null; }
}

// Followers per account from the latest snapshot — a cheap, indexed read used to
// pick a sensible default primary (the most-followed account) when none is set.
async function followersByAccount(platform) {
  const m = {};
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (account_key) account_key, data
         FROM sync_snapshots
        WHERE platform = $1 AND account_key IS NOT NULL
        ORDER BY account_key, fetched_at DESC`, [platform]);
    for (const r of rows) {
      const id = (r.data && (r.data.accountId || r.account_key)) || r.account_key;
      m[id] = Number(r.data && r.data.followers) || 0;
    }
  } catch (_) {}
  return m;
}

// Resolve the effective primary accountId from candidate ids: the stored
// preference if it still exists, else the most-followed account, else the first.
// Used by BOTH the Integrations list and the Overview stats so they always agree.
async function resolvePrimaryId(platform, ids) {
  if (!ids.length) return null;
  const stored = await getPrimaryKey(platform);
  if (stored && ids.includes(stored)) return stored;
  const fol = await followersByAccount(platform);
  let best = ids[0], bestF = fol[ids[0]] || 0;
  for (const id of ids) { const f = fol[id] || 0; if (f > bestF) { best = id; bestF = f; } }
  return best;
}

// Set the primary account (admin). Validates the account exists for the platform.
async function setPrimary(platform, accountId) {
  const list = await listAccounts(platform);
  if (!list.some(a => a.accountId === accountId)) throw new Error('Account not found');
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [primarySettingKey(platform), accountId]);
  return { ok: true, primary: accountId };
}

// Build a per-account credential override from a social_accounts row.
function credFromRow(platform, r) {
  const accountKey = r.account_key;
  if (platform === 'youtube')  return { refreshToken: r.refresh_token, accountKey };
  if (platform === 'facebook') return { pageToken: r.token, pageId: r.account_key, accountKey };
  if (platform === 'threads')  return { accessToken: r.token, userId: r.extra?.userId, accountKey };
  if (platform === 'linkedin') return { accessToken: r.token, orgId: r.extra?.orgId, accountKey };
  return { accountKey };
}

// Whether a platform module can append additional accounts yet (Phase-2 capable).
function supportsAdd(platform) {
  return platform === 'instagram'
    || (MODULES[platform] && typeof MODULES[platform].appendAccountFromCode === 'function');
}

// List accounts for a platform in the unified shape. Each account carries:
//   managed — credential lives in app_settings (Credentials vs Remove button)
//   primary — the user-chosen default (ordered first; Overview defaults to it)
async function listAccounts(platform) {
  let out = [];

  if (platform === 'instagram') {
    const rows = await instagram.listAccounts();   // already excludes hidden/noise
    out = rows.map(a => ({
      accountId: a.accountId,
      label: a.name || (a.username ? '@' + a.username : a.accountId),
      username: a.username || null,
      avatar: null,
      connected: true,
      tokenHealthy: a.canPublish === true,   // has an OAuth token → can act
      managed: false,                        // IG accounts live in instagram_accounts, all removable
    }));
  } else {
    const mod = MODULES[platform];
    if (!mod) return [];

    // Managed account = the single credential currently in app_settings.
    try {
      const status = await mod.testConnection();
      if (status.connected) out.push(fromProfile(platform, status, true));
    } catch (_) { /* not connected yet */ }

    // Additional accounts live in social_accounts — verify each against its own token.
    try {
      const { rows } = await pool.query(
        `SELECT account_key, label, username, token, refresh_token, extra, last_sync_at, last_error
           FROM social_accounts
          WHERE platform = $1 AND NOT COALESCE(hidden, false)
          ORDER BY created_at`, [platform]);
      for (const r of rows) {
        if (out.some(a => a.accountId === r.account_key)) continue;   // dedupe vs managed
        let connected = !r.last_error, label = r.label, username = r.username, avatar = null;
        try {
          const st = await mod.testConnection(true, credFromRow(platform, r));
          connected = st.connected === true;
          if (st.profile) {
            label = st.profile.name || st.profile.title || label;
            username = st.profile.username || username;
            avatar = st.profile.thumbnailUrl || st.profile.pictureUrl || null;
          }
        } catch (_) {}
        out.push({
          accountId: r.account_key,
          label: label || r.account_key,
          username: username || null,
          avatar,
          connected,
          tokenHealthy: connected,
          lastSyncAt: r.last_sync_at,
          managed: false,
        });
      }
    } catch (_) {}
  }

  // Resolve + apply the user-chosen primary, then order it first.
  const primaryId = await resolvePrimaryId(platform, out.map(a => a.accountId));
  out = out.map(a => ({ ...a, primary: a.accountId === primaryId }));
  out.sort((a, b) => (a.primary ? 0 : 1) - (b.primary ? 0 : 1));

  return out;
}

// Append a new account from an OAuth code (the "Add account" flow).
async function addAccountFromCode(platform, code) {
  if (!MODULES[platform] || typeof MODULES[platform].appendAccountFromCode !== 'function') {
    throw new Error(`Adding accounts isn't supported for ${platform} yet`);
  }
  return MODULES[platform].appendAccountFromCode(code);
}

// Remove an additional account (the managed/legacy account is edited via Credentials).
async function removeAccount(platform, accountKey) {
  if (platform === 'instagram') {
    // Disconnect (unsubscribe webhook + null token) AND hide it so it leaves the
    // list. Reversible: re-authorizing the account un-hides it. Keeps message history.
    await instagram.disconnectAccount(accountKey).catch(() => {});
    const { rowCount } = await pool.query('UPDATE instagram_accounts SET hidden = true WHERE account_id = $1', [accountKey]);
    if (!rowCount) throw new Error('Account not found');
    await clearPrimaryIfMatch(platform, accountKey);
    return { ok: true };
  }
  const { rowCount } = await pool.query('DELETE FROM social_accounts WHERE platform = $1 AND account_key = $2', [platform, accountKey]);
  if (!rowCount) throw new Error('That account is the managed connection — edit it via Credentials');
  await clearPrimaryIfMatch(platform, accountKey);
  return { ok: true };
}

// If the removed account was the stored primary, clear the preference so the next
// listAccounts falls back to the first remaining account.
async function clearPrimaryIfMatch(platform, accountKey) {
  try {
    const cur = await getPrimaryKey(platform);
    if (cur === accountKey) await pool.query('DELETE FROM app_settings WHERE key = $1', [primarySettingKey(platform)]);
  } catch (_) {}
}

// All per-account credentials for a platform (primary legacy + social_accounts rows),
// for the sync worker to iterate. Each entry: { accountKey, cred|null }.
async function accountCreds(platform) {
  const list = [{ accountKey: 'primary', cred: null }];   // null cred → module uses legacy app_settings
  try {
    const { rows } = await pool.query(
      `SELECT account_key, token, refresh_token, extra FROM social_accounts
        WHERE platform = $1 AND NOT COALESCE(hidden, false) ORDER BY created_at`, [platform]);
    for (const r of rows) list.push({ accountKey: r.account_key, cred: credFromRow(platform, r) });
  } catch (_) {}
  return list;
}

// Accounts to snapshot for analytics, with the credential to pass to getStats.
// accountId matches listAccounts() so the Overview chips line up with snapshots.
async function accountsForSync(platform) {
  if (platform === 'instagram') {
    const { rows } = await pool.query(
      `SELECT account_id, name, username, token FROM instagram_accounts
        WHERE token IS NOT NULL AND NOT COALESCE(hidden, false)
        ORDER BY token_expires_at DESC NULLS LAST`);
    return rows.map(r => ({
      accountId: r.account_id,
      label: r.name || (r.username ? '@' + r.username : r.account_id),
      statsArg: { accountId: r.account_id, token: r.token },
    }));
  }
  const mod = MODULES[platform];
  if (!mod) return [];
  const out = [];
  try {
    const s = await mod.testConnection();
    if (s.connected) out.push({
      accountId: String(s.profile?.id || s.profile?.channelId || 'primary'),
      label: s.profile?.name || s.profile?.title || labelFor(platform),
      statsArg: null,
    });
  } catch (_) {}
  const { rows } = await pool.query(
    `SELECT account_key, label, username, token, refresh_token, extra FROM social_accounts
      WHERE platform = $1 AND NOT COALESCE(hidden, false) ORDER BY created_at`, [platform]);
  for (const r of rows) {
    if (out.some(a => a.accountId === r.account_key)) continue;
    out.push({ accountId: r.account_key, label: r.label || r.account_key, statsArg: credFromRow(platform, r) });
  }
  return out;
}

// Summary across all platforms (for the Integrations overview cards).
async function summary() {
  const out = {};
  for (const platform of PLATFORMS) {
    try {
      const accounts = await listAccounts(platform);
      out[platform] = {
        count: accounts.length,
        connected: accounts.some(a => a.connected),
        canAdd: supportsAdd(platform),
        accounts,
      };
    } catch (_) {
      out[platform] = { count: 0, connected: false, accounts: [] };
    }
  }
  return out;
}

module.exports = { PLATFORMS, listAccounts, summary, addAccountFromCode, removeAccount, accountCreds, accountsForSync, supportsAdd, getPrimaryKey, setPrimary, resolvePrimaryId };
