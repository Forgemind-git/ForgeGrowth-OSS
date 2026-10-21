// ============================================================
// tokenService.js — proactive token refresh + health reporting
//
// Fixes the "accounts log out automatically" problem: Instagram long-lived
// tokens hard-expire at 60 days unless refreshed. A daily cron (plus a boot
// one-shot) refreshes every credential generation:
//   - the legacy app_settings token (instagram_access_token)
//   - per-account OAuth tokens (instagram_accounts.token)
//
// All Graph calls go through the module's gatedFetch, so refresh traffic is
// rate-limited like everything else (~1 call/account/day — negligible).
// ============================================================
const pool      = require('./db');
const instagram = require('./instagram');

const THRESHOLD_DAYS = 45;   // refresh once a token has <=45 of its 60 days left
const EXPIRING_DAYS  = 7;    // below this, surface an amber "expiring" warning

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value || null;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]);
}
async function deleteSetting(key) {
  await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
}

function daysLeftOf(expiresAt) {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  return isNaN(d) ? null : (d - Date.now()) / 86400000;
}

const DEAD_RE = /expired|invalid|session|revoked|deauthorized|invalid_grant|cannot be refreshed/i;
const BENIGN_RE = /24 hours|too soon|No access token saved/i;
// Transient infrastructure errors (network blip, rate-limiter backoff) say
// nothing about token health — recording them caused a false "needs attention"
// banner for 24h. Skip; the next daily pass retries anyway.
const TRANSIENT_RE = /fetch failed|network|econn|etimedout|socket hang|rate.?limited|timed?\s?out|temporar/i;

// Refresh one legacy app_settings credential via the module's refreshToken().
async function _refreshLegacy(platform, tokenKey, expiresKey, refreshFn) {
  const token = await getSetting(tokenKey);
  if (!token) return { platform, account: 'primary', skipped: true, reason: 'not connected' };

  const daysLeft = daysLeftOf(await getSetting(expiresKey));
  if (daysLeft !== null && daysLeft > THRESHOLD_DAYS) {
    return { platform, account: 'primary', ok: true, skipped: true, daysLeft: Math.round(daysLeft) };
  }
  try {
    const result = await refreshFn();
    await setSetting(`${platform}_token_refreshed_at`, new Date().toISOString());
    await deleteSetting(`${platform}_token_refresh_error`);
    return { platform, account: 'primary', ok: true, daysLeft: result?.daysLeft };
  } catch (e) {
    if (BENIGN_RE.test(e.message) || TRANSIENT_RE.test(e.message)) {
      return { platform, account: 'primary', ok: true, skipped: true };
    }
    await setSetting(`${platform}_token_refresh_error`, String(e.message).slice(0, 500));
    return { platform, account: 'primary', ok: false, error: e.message };
  }
}

// ── Run a full refresh pass over every Instagram credential ──
async function refreshAll() {
  const out = [];
  const push = (platform, rows) => {
    for (const r of rows || []) out.push({ platform, ...r });
  };

  // Instagram — legacy + every OAuth account
  out.push(await _refreshLegacy('instagram', 'instagram_access_token', 'instagram_token_expires_at', instagram.refreshToken));
  try { push('instagram', await instagram.refreshAccountTokens(THRESHOLD_DAYS)); }
  catch (e) { console.error('[tokenService] instagram accounts:', e.message); }

  const refreshed = out.filter(r => r.ok && !r.skipped).length;
  const failed    = out.filter(r => r.ok === false);
  console.log(`[tokenService] pass done: ${refreshed} refreshed, ${failed.length} failed, ${out.length} checked`);
  for (const f of failed) console.warn(`[tokenService]   FAILED ${f.platform}/${f.account || f.accountId || f.accountKey}: ${f.error}`);
  return out;
}

function _statusOf({ daysLeft, error, needsReconnect }) {
  if (needsReconnect) return 'needs_reconnect';
  if (daysLeft !== null && daysLeft <= 0) return 'needs_reconnect';
  // A stale error self-heals once a reconnect pushes expiry beyond the
  // refresh threshold (fresh 60-day token → daysLeft > THRESHOLD_DAYS).
  if (error && (daysLeft === null || daysLeft <= THRESHOLD_DAYS)) return 'refresh_failed';
  if (daysLeft !== null && daysLeft <= EXPIRING_DAYS) return 'expiring';
  return 'ok';
}

// ── Health snapshot for the in-app banner — pure DB reads, zero API calls ──
async function getTokenHealth() {
  const rows = [];

  // Legacy app_settings credentials (token + expiry + last refresh error)
  const legacy = [
    { platform: 'instagram', tokenKey: 'instagram_access_token', expiresKey: 'instagram_token_expires_at' },
  ];
  for (const l of legacy) {
    const token = await getSetting(l.tokenKey);
    if (!token) continue;
    const daysLeft = l.expiresKey ? daysLeftOf(await getSetting(l.expiresKey)) : null;
    const error    = await getSetting(`${l.platform}_token_refresh_error`);
    rows.push({
      platform:  l.platform,
      accountId: null,
      account:  'Primary',
      daysLeft: daysLeft === null ? null : Math.max(0, Math.round(daysLeft)),
      status:   _statusOf({ daysLeft, error, needsReconnect: !!(error && DEAD_RE.test(error)) }),
      error:    error || null,
    });
  }

  // Instagram OAuth accounts
  const ig = await pool.query(
    `SELECT account_id, COALESCE(name, username, account_id) AS label,
            token_expires_at, last_refresh_error, needs_reconnect
       FROM instagram_accounts WHERE token IS NOT NULL`);
  for (const a of ig.rows) {
    const daysLeft = daysLeftOf(a.token_expires_at);
    rows.push({
      platform:  'instagram',
      accountId: a.account_id,
      account:   a.label,
      daysLeft: daysLeft === null ? null : Math.max(0, Math.round(daysLeft)),
      status:   _statusOf({ daysLeft, error: a.last_refresh_error, needsReconnect: a.needs_reconnect }),
      error:    a.last_refresh_error || null,
    });
  }

  return rows;
}

module.exports = { refreshAll, getTokenHealth, THRESHOLD_DAYS };
