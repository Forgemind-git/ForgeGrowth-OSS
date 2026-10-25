// mcpService.js — the Instagram data reads (and the two engage writes) behind
// the social_* tools of ForgeGrowth's one MCP server (services/mcpRouteToolRunner.js).
//
// HARD RULE: every read here is a pure DB query — ZERO outbound Graph/API calls
// (no revalidate kicks, no testConnection), so an external MCP client can never
// burn the platforms' rate budgets. The only outbound calls are the engage
// writes, which go through the same rate-gated module functions the UI uses.

const pool = require('./db');
const syncService = require('./syncService');
const accounts = require('./accounts');
const mockService = require('./mockService');
const tokenService = require('./tokenService');
const instagram = require('./instagram');
const reportData = require('./reportData');
const insightsService = require('./insightsService');

/* ------------------------------ account scope ---------------------------- */
// A key may be locked to ONE account on ONE platform. `scope` is either null
// (unrestricted — the key sees everything, which is the default and how every
// pre-existing key behaves) or { platform, accountId, label, username }.
//
// The boundary is HARD: a scoped key never reads another account's rows, never
// sees another platform, and can never write on another account's behalf. Every
// exported read/write below takes `scope` as its last argument and applies it at
// the SQL level — nothing is filtered in the transport layer alone, so a missed
// tool registration can't leak data.

async function resolveScope(platform, accountId) {
  const p = String(platform || '').trim().toLowerCase();
  const id = String(accountId || '').trim();
  if (!p || !id || !accounts.PLATFORMS.includes(p)) return null;
  let label = null, username = null;
  const { rows } = await pool.query(
    'SELECT name, username FROM instagram_accounts WHERE account_id = $1', [id]);
  if (rows[0]) { label = rows[0].name; username = rows[0].username; }
  return { platform: p, accountId: id, label: label || username || id, username: username || null };
}

// How the scope reads in errors and in the connector's instructions banner.
function scopeLabel(scope) {
  if (!scope) return 'all accounts';
  return `${scope.username ? '@' + scope.username : scope.label} on ${scope.platform}`;
}

function denied(msg) { const e = new Error(msg); e.status = 403; throw e; }

// Force a platform argument to the scope. A different platform is REFUSED rather
// than silently rewritten — a caller must never misread whose data it received.
function scopedPlatform(scope, platform) {
  if (!scope) return platform || null;
  const p = platform ? String(platform).toLowerCase() : null;
  if (p && p !== scope.platform) {
    denied(`This connection is restricted to ${scopeLabel(scope)} — '${p}' data is not available on this key.`);
  }
  return scope.platform;
}

// Force an account argument to the scope. 'all' is accepted and resolves to the
// scoped account: for a one-account key "all accounts" IS that account, so this
// is accurate rather than a silent substitution.
function scopedAccount(scope, account) {
  if (!scope) return account || null;
  const a = account ? String(account) : null;
  if (a && a !== 'all' && a !== scope.accountId) {
    denied(`This connection is restricted to ${scopeLabel(scope)} — account '${a}' is not available on this key.`);
  }
  return scope.accountId;
}

// Stamped onto every scoped result so the client can never present one account's
// numbers as the whole workspace's.
function scopeStamp(scope) {
  if (!scope) return {};
  return { scope: {
    restricted: true,
    platform: scope.platform,
    accountId: scope.accountId,
    account: scope.username ? '@' + scope.username : scope.label,
  } };
}

/* ------------------------------ analytics ------------------------------- */

const PERIODS = ['7D', '30D', '90D'];
function normPeriod(period) { return PERIODS.includes(period) ? period : '30D'; }

// Cross-platform overview — mirrors GET /api/overview but never kicks a
// background revalidate (that path makes Graph calls).
async function getOverview(period = '30D', scope = null) {
  period = normPeriod(period);
  const info = mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D'];
  // A scoped key rolls up exactly one platform/account — so the "cross-platform"
  // totals below are that one account's numbers, not a workspace sum.
  const wanted = scope ? [scope.platform] : accounts.PLATFORMS;
  let snapshots = [];
  for (const key of wanted) {
    const snaps = await syncService.getAccountSnapshots(key, period);
    if (!snaps.length) continue;
    const accountSnaps = snaps.filter(s => s.account_key);
    let chosen;
    if (scope) {
      // Scoped: the ONE account's snapshot, or nothing. Never fall back to the
      // primary/combined row — that would hand back someone else's numbers.
      chosen = accountSnaps.find(s => (s.data?.accountId || s.account_key) === scope.accountId);
      if (!chosen) continue;
    } else if (accountSnaps.length) {
      const primaryId = await accounts.resolvePrimaryId(key, accountSnaps.map(s => s.data?.accountId || s.account_key));
      chosen = accountSnaps.find(s => (s.data?.accountId || s.account_key) === primaryId) || accountSnaps[0];
    } else {
      chosen = snaps[0];
    }
    snapshots.push({ platform: key, data: chosen.data, fetched_at: chosen.fetched_at });
  }
  let estimated = false;
  if (!snapshots.length) {
    // No snapshot for this period — fall back to the latest of any period,
    // clearly flagged (numbers belong to that other period, not scaled).
    const params = [accounts.PLATFORMS];
    let where = 'WHERE platform = ANY($1)';
    if (scope) { params.push(scope.platform, scope.accountId); where += ' AND platform = $2 AND account_key = $3'; }
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (platform) platform, data, fetched_at, period AS snap_period
        FROM sync_snapshots ${where} ORDER BY platform, fetched_at DESC`, params);
    snapshots = rows;
    estimated = true;
  }
  if (!snapshots.length) return { period, synced: false, platforms: [], ...scopeStamp(scope) };

  let totalAudience = 0, totalGrowth = 0, totalImpressions = 0, totalEngRate = 0, count = 0;
  const platforms = [];
  for (const snap of snapshots) {
    const d = snap.data || {};
    totalAudience += d.followers || 0;
    totalGrowth += d.growth || 0;
    totalImpressions += d.impressions || 0;
    totalEngRate += d.engagementRate || 0;
    count++;
    platforms.push({
      platform: snap.platform,
      name: mockService.PLATFORMS[snap.platform]?.name || snap.platform,
      followers: d.followers || 0,
      growth: d.growth || 0,
      impressions: d.impressions || 0,
      engagementRate: d.engagementRate || 0,
      lastSyncAt: snap.fetched_at,
      snapshotPeriod: snap.snap_period || period,
    });
  }
  return {
    period, periodDays: info.days, synced: true, estimated,
    totals: {
      audience: totalAudience,
      netGrowth: totalGrowth,
      impressions: totalImpressions,
      avgEngagementRate: count ? parseFloat((totalEngRate / count).toFixed(1)) : 0,
    },
    platforms,
    ...scopeStamp(scope),
  };
}

// One platform's full stats payload — mirrors GET /api/platforms/:key/stats
// minus the revalidate kick and thumbnail enrichment (MCP doesn't need images).
async function getPlatformStats(key, period = '30D', account = null, scope = null) {
  period = normPeriod(period);
  key = scopedPlatform(scope, key);
  account = scopedAccount(scope, account);
  if (!accounts.PLATFORMS.includes(key)) { const e = new Error(`Unknown platform '${key}'`); e.status = 400; throw e; }
  const snaps = await syncService.getAccountSnapshots(key, period);
  if (!snaps.length) {
    // A scoped key must not fall back to the platform-wide (account-less)
    // snapshot — that row is the combined figure across every account.
    if (scope) return { platform: key, synced: false, message: 'No synced data for this account yet.', ...scopeStamp(scope) };
    const snapshot = await syncService.getLatestSnapshot(key, period);
    if (snapshot) return { ...snapshot.data, synced: true, estimated: snapshot.period !== period, snapshotPeriod: snapshot.period, fetchedAt: snapshot.fetched_at };
    return { platform: key, synced: false, message: 'No synced data for this platform yet.' };
  }
  const accountsList = snaps
    .filter(s => s.account_key)
    .map(s => ({ accountId: s.data?.accountId || s.account_key, accountLabel: s.data?.accountLabel || s.account_key }))
    .filter(a => !scope || a.accountId === scope.accountId);
  const primaryAccount = await accounts.resolvePrimaryId(key, accountsList.map(a => a.accountId));

  let data, resolvedAccountId;
  if (account && account !== 'all') {
    const s = snaps.find(x => (x.data?.accountId || x.account_key) === account);
    if (!s) return { platform: key, synced: false, accounts: accountsList, message: 'No data for this account yet.', ...scopeStamp(scope) };
    data = s.data; resolvedAccountId = account;
  } else if (account === 'all') {
    data = snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(s => s.data));
    resolvedAccountId = 'all';
  } else {
    const s = snaps.find(x => (x.data?.accountId || x.account_key) === primaryAccount);
    data = s ? s.data : (snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(x => x.data)));
    resolvedAccountId = primaryAccount;
  }
  if (data) await syncService.overlayFreshFollowers(key, resolvedAccountId, data);
  return { ...data, accounts: accountsList, primaryAccount, synced: true, fetchedAt: snaps[0].fetched_at, ...scopeStamp(scope) };
}

// Followers-over-time series — mirrors GET /api/platforms/:key/followers-trend.
async function getFollowersTrend(key, unit = 'days', range = null, account = null, scope = null) {
  key = scopedPlatform(scope, key);
  account = scopedAccount(scope, account);
  if (!accounts.PLATFORMS.includes(key)) { const e = new Error(`Unknown platform '${key}'`); e.status = 400; throw e; }
  unit = ['weeks', 'hours', 'days'].includes(unit) ? unit : 'days';
  const DEFAULTS = { hours: 24, days: 30, weeks: 8 };
  const MAXES = { hours: 168, days: 90, weeks: 52 };
  range = Math.max(1, Math.min(parseInt(range, 10) || DEFAULTS[unit], MAXES[unit]));

  const snaps = await syncService.getAccountSnapshots(key, '30D');
  if (!snaps.length) return { platform: key, synced: false, unit, range, points: [], ...scopeStamp(scope) };
  const accountsList = snaps
    .filter(s => s.account_key)
    .map(s => ({ accountId: s.data?.accountId || s.account_key, accountLabel: s.data?.accountLabel || s.account_key }))
    .filter(a => !scope || a.accountId === scope.accountId);
  const primaryAccount = await accounts.resolvePrimaryId(key, accountsList.map(a => a.accountId));

  let chosen, accountKey;
  if (account && account !== 'all') {
    chosen = snaps.find(x => (x.data?.accountId || x.account_key) === account);
    accountKey = account;
  } else if (account === 'all') {
    chosen = { data: snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(s => s.data)), fetched_at: snaps[0].fetched_at };
    accountKey = 'all';
  } else {
    chosen = snaps.find(x => (x.data?.accountId || x.account_key) === primaryAccount) || snaps[0];
    accountKey = chosen.data?.accountId || chosen.account_key;
  }
  if (!chosen?.data) return { platform: key, synced: false, unit, range, points: [], ...scopeStamp(scope) };
  const refFollowers = Number(chosen.data?.followers) || undefined;
  const points = await syncService.buildFollowersTrend(key, accountKey, chosen.data, chosen.fetched_at, unit, range, { refFollowers });
  return { platform: key, synced: true, unit, range, account: accountKey, points, ...scopeStamp(scope) };
}

// Audience demographics — reads ONLY the persisted audience_cache:* payloads in
// app_settings (written by the daily rate-gated fetch). Never fetches live.
async function getAudienceInsights(key = null, scope = null) {
  key = scope ? scope.platform : key;
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'audience_cache:%' ORDER BY key`);
  const entries = [];
  for (const r of rows) {
    const parts = r.key.split(':'); // audience_cache:<platform>:<account>
    const platform = parts[1] || null;
    const account = parts[2] || null;
    if (!accounts.PLATFORMS.includes(platform)) continue;   // cache left by a removed platform
    if (key && platform !== key) continue;
    // Scoped: only this account's cache row. The `:active` / `:primary` aliases
    // hold whichever account the dashboard last looked at, so they're excluded.
    if (scope && account !== scope.accountId) continue;
    let data = null;
    try { data = JSON.parse(r.value); } catch (_) { /* unreadable cache entry — skip */ }
    if (data) entries.push({ platform, account, ...data });
  }
  return {
    entries,
    note: entries.length
      ? 'Cached daily audience payloads (demographics, online-followers, traffic sources where supported).'
      : 'No cached audience data yet — it populates after the daily audience fetch runs.',
    ...scopeStamp(scope),
  };
}

/* ------------------------------- reports -------------------------------- */

// Default the range to the last 30 days (IST) when not supplied, so a bare
// "generate a report" call just works.
function _defaultRange(from, to) {
  const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const back = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const t = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : istToday;
  const f = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : back(t, -29);
  return { from: f, to: t };
}

// Full report (per-platform performance summary) PLUS a forward-looking
// forecast — what to prioritise in the coming days, blending this account's
// own momentum with evergreen best-creator playbooks per platform.
async function generateReport({ platforms, from, to } = {}, scope = null) {
  const keys = scope
    ? [scopedPlatform(scope, Array.isArray(platforms) && platforms.length === 1 ? platforms[0] : null)]
    : ((platforms && (Array.isArray(platforms) ? platforms.length : String(platforms).trim()))
        ? platforms : reportData.ALLOWED);
  const range = _defaultRange(from, to);
  const out = await reportData.generateReport({
    platforms: keys, from: range.from, to: range.to,
    accountKey: scope ? scope.accountId : null,
  });
  return { ...out, ...scopeStamp(scope) };
}

/* ------------------------------- content -------------------------------- */

const POST_SORTS = {
  date: 'p.date DESC NULLS LAST', score: 'p.score DESC NULLS LAST', views: 'p.views DESC NULLS LAST',
  engagements: 'p.engagements DESC NULLS LAST', likes: 'p.likes DESC NULLS LAST', comments: 'p.comments DESC NULLS LAST',
};

async function listPosts({ platform, q, days, sortBy = 'date', limit = 50 } = {}, scope = null) {
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  platform = scopedPlatform(scope, platform);
  const conds = ['pl.key = ANY($1)'], params = [accounts.PLATFORMS];
  if (platform) { params.push(platform); conds.push(`pl.key = $${params.length}`); }
  if (scope) { params.push(scope.accountId); conds.push(`p.account_key = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conds.push(`(p.title ILIKE $${params.length} OR p.caption ILIKE $${params.length} OR p.topic ILIKE $${params.length})`); }
  const d = parseInt(days, 10);
  if (d > 0) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - d);
    params.push(cutoff.toISOString().split('T')[0]);
    conds.push(`p.date >= $${params.length}`);
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT p.id, pl.key AS "platform", p.external_id AS "externalId",
            COALESCE(ia.username, ia.name) AS "accountUsername",
            p.title, p.caption, p.type, p.topic, p.date, p.permalink,
            p.views, p.engagements, p.likes, p.comments, p.shares, p.saves, p.clicks, p.score
       FROM posts p
       JOIN platforms pl ON pl.id = p.platform_id
       LEFT JOIN instagram_accounts ia ON pl.key = 'instagram' AND ia.account_id = p.account_key
      WHERE ${conds.join(' AND ')}
      ORDER BY ${POST_SORTS[sortBy] || POST_SORTS.date}
      LIMIT $${params.length}`, params);
  return { posts: rows, total: rows.length, sortBy: POST_SORTS[sortBy] ? sortBy : 'date', ...scopeStamp(scope) };
}

async function listMedia({ limit = 100 } = {}) {
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 200));
  const { rows } = await pool.query(
    `SELECT id, title, caption, format, file_count AS "fileCount", total_size AS "totalSize",
            uploaded_by AS "uploadedBy", created_at AS "createdAt"
       FROM media ORDER BY created_at DESC LIMIT $1`, [limit]);
  return { media: rows, total: rows.length };
}

/* -------------------------------- inbox --------------------------------- */

// Hidden / identity-less IG accounts are excluded everywhere (same rule as the UI).
const HIDDEN_IG = `SELECT account_id FROM instagram_accounts WHERE COALESCE(hidden,false) OR (name IS NULL AND username IS NULL)`;

async function listMessages({ account, peer, q, limit = 100 } = {}, scope = null) {
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  // DMs exist on Instagram only — a key scoped to another platform has none.
  if (scope && scope.platform !== 'instagram') {
    return { messages: [], total: 0, note: `This connection is restricted to ${scopeLabel(scope)}; direct messages are an Instagram-only feature.`, ...scopeStamp(scope) };
  }
  account = scopedAccount(scope, account);
  const conds = [`m.account_id NOT IN (${HIDDEN_IG})`];
  const params = [];
  if (account) { params.push(account); conds.push(`m.account_id = $${params.length}`); }
  if (peer) { params.push(peer); conds.push(`(CASE WHEN m.direction='incoming' THEN m.sender_id ELSE m.recipient_id END) = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conds.push(`m.text ILIKE $${params.length}`); }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT m.id, m.account_id AS "accountId", m.direction, m.text, m.ts,
            (CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END) AS "peerId",
            u.username AS "peerUsername", u.name AS "peerName",
            a.username AS "accountUsername", a.name AS "accountName"
       FROM instagram_messages m
       LEFT JOIN instagram_users u
         ON u.igsid = (CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END)
       LEFT JOIN instagram_accounts a ON a.account_id = m.account_id
      WHERE ${conds.join(' AND ')}
      ORDER BY m.ts DESC NULLS LAST, m.id DESC
      LIMIT $${params.length}`, params);
  return { messages: rows, total: rows.length, platform: 'instagram' };
}

// Instagram comments, normalized to one shape.
async function listComments({ platform = 'instagram', account, q, limit = 100 } = {}, scope = null) {
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  platform = scopedPlatform(scope, platform);
  account = scopedAccount(scope, account);
  const params = [];
  let sql;
  if (platform === 'instagram') {
    const conds = [`c.account_id NOT IN (${HIDDEN_IG})`];
    if (account) { params.push(account); conds.push(`c.account_id = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`(c.text ILIKE $${params.length} OR c.from_username ILIKE $${params.length})`); }
    params.push(limit);
    sql = `SELECT 'instagram' AS platform, c.id, c.comment_id AS "commentId", c.media_id AS "postId",
                  c.parent_id AS "parentId", c.from_username AS "author", c.text,
                  c.like_count AS "likeCount", c.ts,
                  COALESCE(p.caption, p.title) AS "postCaption", p.permalink AS "postPermalink", p.date AS "postDate"
             FROM instagram_comments c
             LEFT JOIN posts p ON p.external_id = c.media_id
              AND p.platform_id = (SELECT id FROM platforms WHERE key = 'instagram' LIMIT 1)
            WHERE ${conds.join(' AND ')}
            ORDER BY c.ts DESC NULLS LAST, c.id DESC LIMIT $${params.length}`;
  } else {
    const e = new Error(`Comments are available for instagram only — not '${platform}'`);
    e.status = 400; throw e;
  }
  const { rows } = await pool.query(sql, params);
  return { comments: rows, total: rows.length, platform, ...scopeStamp(scope) };
}

/* ------------------------------- contacts ------------------------------- */

async function listContacts({ q, account, tag, limit = 100 } = {}, scope = null) {
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  // Contacts are built from Instagram DM history — nothing to show off-platform.
  if (scope && scope.platform !== 'instagram') {
    return { contacts: [], total: 0, note: `This connection is restricted to ${scopeLabel(scope)}; contacts are built from Instagram DM history.`, ...scopeStamp(scope) };
  }
  account = scopedAccount(scope, account);
  const conds = [`c.platform = 'instagram'`, `c.account_id NOT IN (${HIDDEN_IG})`];
  const params = [];
  if (account) { params.push(account); conds.push(`c.account_id = $${params.length}`); }
  if (tag) { params.push(JSON.stringify([tag])); conds.push(`c.tags @> $${params.length}::jsonb`); }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    conds.push(`(LOWER(c.name) LIKE $${params.length} OR LOWER(c.username) LIKE $${params.length} OR c.peer_id LIKE $${params.length} OR LOWER(COALESCE(c.notes,'')) LIKE $${params.length})`);
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT c.id, c.platform, c.account_id AS "accountId", c.peer_id AS "peerId",
            c.name, c.username, c.notes, c.tags,
            c.first_seen_at AS "firstSeenAt", c.last_seen_at AS "lastSeenAt",
            c.last_msg_preview AS "lastMsgPreview", c.last_msg_dir AS "lastMsgDir",
            c.message_count AS "messageCount",
            a.name AS "accountName", a.username AS "accountUsername"
       FROM contacts c
       LEFT JOIN instagram_accounts a ON a.account_id = c.account_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.last_seen_at DESC NULLS LAST, c.id DESC
      LIMIT $${params.length}`, params);
  return { contacts: rows, total: rows.length, ...scopeStamp(scope) };
}

async function listTags() {
  const [tags, categories] = await Promise.all([
    pool.query(`SELECT id, name, color, category_id AS "categoryId" FROM tags ORDER BY name`),
    pool.query(`SELECT id, name, description FROM categories ORDER BY name`),
  ]);
  return { tags: tags.rows, categories: categories.rows };
}

/* ------------------------------- accounts ------------------------------- */

// Connected Instagram accounts — pure DB, no cached-status probes. NOTE: the
// user-chosen primary is stored in app_settings (`primary_account:<platform>`) —
// resolve it via the accounts module.
async function listConnectedAccounts(scope = null) {
  const ig = await pool.query(
    `SELECT account_id AS "accountId", name, username, (token IS NOT NULL) AS "canPublish"
       FROM instagram_accounts
      WHERE NOT COALESCE(hidden,false) AND (name IS NOT NULL OR username IS NOT NULL)
      ORDER BY name NULLS LAST`);
  let primary = null;
  try { primary = await accounts.resolvePrimaryId('instagram', ig.rows.map(r => r.accountId)); }
  catch { primary = null; }
  const all = ig.rows.map(r => ({ platform: 'instagram', accountId: r.accountId, label: r.name || (r.username ? '@' + r.username : r.accountId), username: r.username, canPublish: r.canPublish, isPrimary: r.accountId === primary }));
  // Scoped keys see exactly the one account they are locked to — the rest of the
  // workspace's accounts are not disclosed, not even by name.
  const visible = scope
    ? all.filter(a => a.platform === scope.platform && a.accountId === scope.accountId)
    : all;
  return { accounts: visible, ...scopeStamp(scope) };
}

function getTokenHealth(scope = null) {
  return tokenService.getTokenHealth().then(rows => {
    // Legacy workspace-level credentials carry accountId null — a scoped key
    // must not see those either, so the strict equality drops them.
    const visible = scope
      ? rows.filter(a => a.platform === scope.platform && a.accountId === scope.accountId)
      : rows;
    return {
      accounts: visible,
      attention: visible.filter(a => a.status !== 'ok'),
      ...scopeStamp(scope),
    };
  });
}

/* ------------------------- writes (gated, off by default) ---------------- */

// Reply to an Instagram comment. Goes through the same
// rate-gated module functions the Inbox uses; kicks a background re-sync so the
// reply shows up in the stored data.
async function replyToComment({ platform, commentId, message, accountId }, scope = null) {
  if (!commentId || !message) { const e = new Error('commentId and message are required'); e.status = 400; throw e; }
  platform = scopedPlatform(scope, platform);
  if (scope) {
    accountId = scopedAccount(scope, accountId);
    // Writes are checked against the DATA, not just the argument: confirm the
    // comment actually sits under the scoped account before replying publicly.
    if (platform === 'instagram') {
      const { rows } = await pool.query(
        'SELECT 1 FROM instagram_comments WHERE comment_id = $1 AND account_id = $2 LIMIT 1', [commentId, scope.accountId]);
      if (!rows[0]) denied(`Comment '${commentId}' does not belong to ${scopeLabel(scope)} — this key cannot reply to it.`);
    }
  }
  if (platform && platform !== 'instagram') {
    const e = new Error(`Replies are supported on instagram only — not '${platform}'`);
    e.status = 400; throw e;
  }
  const r = await instagram.replyToComment({ commentId, accountId: accountId || null, message });
  instagram.syncComments({ force: true }).catch(() => {});
  return { ok: true, ...r };
}

function sendInstagramDm({ accountId, recipientId, text }, scope = null) {
  if (scope) {
    scopedPlatform(scope, 'instagram');
    accountId = scopedAccount(scope, accountId);
  }
  if (!accountId || !recipientId || !text) {
    const e = new Error('accountId, recipientId and text are required'); e.status = 400; throw e;
  }
  return instagram.sendDirectMessage({ accountId, recipientId, text });
}

/* ------------------------------- insights ------------------------------ */
// Thin pass-throughs to insightsService (pure-DB derived decision layer), so
// the MCP tools and the /api/insights routes share one implementation.
async function getExecutiveSummary(period, scope = null) {
  return { ...(await insightsService.getExecutiveScorecard(period, scope)), ...scopeStamp(scope) };
}
async function getContentThemes(args, scope = null) {
  const a = { ...(args || {}) };
  if (scope) a.platform = scopedPlatform(scope, a.platform);
  return { ...(await insightsService.getContentThemes(a, scope)), ...scopeStamp(scope) };
}
async function getTrendsAnomalies(period, scope = null) {
  return { ...(await insightsService.getTrendsAndAnomalies(period, scope)), ...scopeStamp(scope) };
}

module.exports = {
  resolveScope, scopeLabel,
  getOverview, getPlatformStats, getFollowersTrend, getAudienceInsights,
  getExecutiveSummary, getContentThemes, getTrendsAnomalies,
  generateReport,
  listPosts, listMedia,
  listMessages, listComments,
  listContacts, listTags,
  listConnectedAccounts, getTokenHealth,
  replyToComment, sendInstagramDm,
};
