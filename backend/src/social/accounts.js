// ============================================================
// accounts.js — unified multi-account layer for the Integrations page
// ============================================================
// Presents a consistent account list per platform. Instagram is the only
// platform: its accounts live in instagram_accounts (wired to webhooks/inbox).
// This layer gives them one shape so the UI can render a platform → accounts
// drill-down, and holds the user-chosen primary account.
const pool = require('./db');
const instagram = require('./instagram');

const PLATFORMS = ['instagram'];

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

// Whether more accounts can be connected for a platform (Instagram: connect again).
function supportsAdd(platform) {
  return platform === 'instagram';
}

// List accounts for a platform in the unified shape. Each account carries:
//   managed — always false: every Instagram account is removable
//   primary — the user-chosen default (ordered first; Overview defaults to it)
async function listAccounts(platform) {
  if (platform !== 'instagram') return [];
  const rows = await instagram.listAccounts();   // already excludes hidden/noise
  let out = rows.map(a => ({
    accountId: a.accountId,
    label: a.name || (a.username ? '@' + a.username : a.accountId),
    username: a.username || null,
    avatar: null,
    connected: true,
    tokenHealthy: a.canPublish === true,   // has an OAuth token → can act
    managed: false,                        // IG accounts live in instagram_accounts, all removable
  }));

  // Resolve + apply the user-chosen primary, then order it first.
  const primaryId = await resolvePrimaryId(platform, out.map(a => a.accountId));
  out = out.map(a => ({ ...a, primary: a.accountId === primaryId }));
  out.sort((a, b) => (a.primary ? 0 : 1) - (b.primary ? 0 : 1));

  return out;
}

// Remove an account: disconnect (unsubscribe webhook + null token) AND hide it
// so it leaves the list. Reversible: re-authorizing the account un-hides it.
// Keeps message history.
async function removeAccount(platform, accountKey) {
  if (platform !== 'instagram') throw new Error('Account not found');
  await instagram.disconnectAccount(accountKey).catch(() => {});
  const { rowCount } = await pool.query('UPDATE instagram_accounts SET hidden = true WHERE account_id = $1', [accountKey]);
  if (!rowCount) throw new Error('Account not found');
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

// Accounts to snapshot for analytics, with the credential to pass to getStats.
// accountId matches listAccounts() so the Overview chips line up with snapshots.
async function accountsForSync(platform) {
  if (platform !== 'instagram') return [];
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

module.exports = { PLATFORMS, listAccounts, summary, removeAccount, accountsForSync, supportsAdd, getPrimaryKey, setPrimary, resolvePrimaryId };
