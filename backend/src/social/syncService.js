const socialEnv = require('./env');
// ============================================================
// syncService.js — Orchestrates data ingestion from social APIs into DB
// ============================================================
const pool = require('./db');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const instagram = require('./instagram');
const categorize = require('./categorize');

const UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';

// ── Thumbnail localization ───────────────────────────────────
// Instagram cover URLs are signed and EXPIRE. Download them once into
// /api/uploads (deterministic filename) and store the local path, so a
// thumbnail never breaks between syncs. Re-syncs reuse the on-disk file.

async function _localizeThumbnail(platformKey, externalId, remoteUrl) {
  if (!remoteUrl) return null;
  if (remoteUrl.startsWith('/api/social/uploads/')) return remoteUrl;   // already local
  try { new URL(remoteUrl); } catch { return remoteUrl; }

  const hash  = crypto.createHash('sha1').update(`${platformKey}:${externalId}`).digest('hex').slice(0, 16);
  const fname = `thumb-${platformKey}-${hash}.jpg`;
  const fpath = path.join(UPLOADS_DIR, fname);
  const localUrl = `/api/social/uploads/${fname}`;
  if (fs.existsSync(fpath)) return localUrl;                     // downloaded before → reuse

  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) return remoteUrl;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return remoteUrl;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    await fs.promises.writeFile(fpath, buf);
    return localUrl;
  } catch {
    return remoteUrl;   // network failure → keep remote (frontend onError falls back)
  }
}

const PLATFORM_MODULES = {
  instagram: { module: instagram, key: 'instagram' },
};

const PLATFORM_IDS = {};

async function _getPlatformId(key) {
  if (PLATFORM_IDS[key]) return PLATFORM_IDS[key];
  const { rows } = await pool.query('SELECT id FROM platforms WHERE key = $1', [key]);
  if (!rows.length) return null;
  PLATFORM_IDS[key] = rows[0].id;
  return rows[0].id;
}

function _parsePostDate(post) {
  if (post.timestamp) {
    const d = new Date(post.timestamp);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  }
  if (post.date) {
    // Parse "10 May" format — assume current year
    const parts = post.date.split(' ');
    if (parts.length === 2) {
      const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
      const month = monthMap[parts[1]];
      if (month !== undefined) {
        const d = new Date(new Date().getFullYear(), month, parseInt(parts[0], 10));
        if (!isNaN(d)) return d.toISOString().split('T')[0];
      }
    }
  }
  return new Date().toISOString().split('T')[0];
}

function _safeJsonStringify(obj) {
  // Remove lone surrogates that PostgreSQL jsonb rejects
  const json = JSON.stringify(obj);
  return json.replace(/\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}/g, match => {
    // Keep valid surrogate pairs
    return match;
  }).replace(/\\u[dD][89abABcfCF][0-9a-fA-F]{2}/g, ''); // Strip lone surrogates
}

function _mapPostToDb(post, platformId) {
  return {
    platform_id: platformId,
    external_id: post.id,
    title: post.title || 'Untitled',
    caption: post.caption || null,
    type: post.type || post.media_type || 'Post',
    media_type: post.media_type || null,
    topic: null, // real API data doesn't have topics; user can categorize later
    date: _parsePostDate(post),
    views: post.views || 0,
    engagements: post.eng || 0,
    likes: post.likes || 0,
    comments: post.comments || 0,
    shares: post.shares || 0,
    saves: post.saves || 0,
    clicks: post.clicks || 0,
    score: post.score || 0, // will be recalculated globally after sync
    permalink: post.permalink || null,
    thumbnail_url: post.thumbnail || null,
    raw_data: _safeJsonStringify(post),
    fetched_at: new Date().toISOString(),
  };
}

async function _upsertPosts(platformKey, posts, accountKey = null) {
  const platformId = await _getPlatformId(platformKey);
  if (!platformId || !posts || !posts.length) return 0;

  let inserted = 0;
  for (const post of posts) {
    if (post.thumbnail) post.thumbnail = await _localizeThumbnail(platformKey, post.id, post.thumbnail);
    const row = _mapPostToDb(post, platformId);
    await pool.query(
      `INSERT INTO posts (
        platform_id, external_id, title, caption, type, media_type, topic,
        date, views, engagements, likes, comments, shares, saves, clicks, score,
        permalink, thumbnail_url, raw_data, fetched_at, account_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (platform_id, external_id) DO UPDATE SET
        title = EXCLUDED.title,
        caption = EXCLUDED.caption,
        type = EXCLUDED.type,
        media_type = EXCLUDED.media_type,
        date = EXCLUDED.date,
        -- An incoming 0 must never wipe a known view count: some fetch paths
        -- don't carry per-post views while the period stats path does —
        -- whichever ran last was clobbering the other. Real view counts don't
        -- decrease to 0.
        views = CASE WHEN EXCLUDED.views = 0 THEN posts.views ELSE EXCLUDED.views END,
        engagements = EXCLUDED.engagements,
        likes = EXCLUDED.likes,
        comments = EXCLUDED.comments,
        shares = EXCLUDED.shares,
        saves = EXCLUDED.saves,
        clicks = EXCLUDED.clicks,
        score = EXCLUDED.score,
        permalink = EXCLUDED.permalink,
        thumbnail_url = EXCLUDED.thumbnail_url,
        raw_data = EXCLUDED.raw_data,
        fetched_at = EXCLUDED.fetched_at,
        account_key = COALESCE(EXCLUDED.account_key, posts.account_key)`,
      [
        row.platform_id, row.external_id, row.title, row.caption, row.type,
        row.media_type, row.topic, row.date, row.views, row.engagements,
        row.likes, row.comments, row.shares, row.saves, row.clicks, row.score,
        row.permalink, row.thumbnail_url, row.raw_data, row.fetched_at, accountKey,
      ]
    );
    inserted++;
  }
  return inserted;
}

// Reconcile externally-deleted posts. After fetching an account's recent feed,
// remove Content Library rows for that SAME account that fall WITHIN the fetched
// window (date >= the oldest fetched post) yet are no longer present — i.e. they
// were deleted on the platform directly. Account- and window-scoping prevent
// touching another account's posts or older posts beyond the API's fetch limit.
// An empty/failed fetch never prunes (so a transient API error can't wipe posts).
async function _pruneDeletedPosts(platformKey, accountKey, fetchedPosts) {
  if (!accountKey || !fetchedPosts || !fetchedPosts.length) return 0;
  const platformId = await _getPlatformId(platformKey);
  if (!platformId) return 0;
  const fetchedIds = fetchedPosts.map(p => p.id).filter(Boolean);
  if (!fetchedIds.length) return 0;
  const windowFloor = fetchedPosts.map(_parsePostDate).filter(Boolean).sort()[0];
  if (!windowFloor) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM posts
       WHERE platform_id = $1 AND account_key = $2
         AND date >= $3
         AND external_id <> ALL($4::text[])`,
    [platformId, accountKey, windowFloor, fetchedIds]);
  if (rowCount) console.log(`Pruned ${rowCount} externally-deleted ${platformKey} post(s) for account ${accountKey}`);
  return rowCount;
}

async function _storeSnapshot(platformKey, period, data, accountKey = null) {
  await pool.query(
    `INSERT INTO sync_snapshots (platform, period, data, account_key, fetched_at)
     VALUES ($1, $2, $3, $4, now())`,
    [platformKey, period, JSON.stringify(data), accountKey]
  );
}

// Latest snapshot per account for a platform+period. Once per-account snapshots
// exist they win; otherwise fall back to the legacy single (null-account) row.
async function getAccountSnapshots(platform, period = '30D') {
  let { rows } = await pool.query(
    `SELECT DISTINCT ON (account_key) account_key, data, fetched_at
       FROM sync_snapshots
      WHERE platform = $1 AND period = $2 AND account_key IS NOT NULL
      ORDER BY account_key, fetched_at DESC`, [platform, period]);
  if (!rows.length) {
    const r = await pool.query(
      `SELECT NULL::text AS account_key, data, fetched_at FROM sync_snapshots
        WHERE platform = $1 AND period = $2 ORDER BY fetched_at DESC LIMIT 1`, [platform, period]);
    rows = r.rows;
  }
  return rows;
}

// Combine per-account snapshots into one "All accounts" view: sum additive
// metrics + trend + extras, merge top posts, recompute rates, drop deltas.
function combineSnapshots(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const base = JSON.parse(JSON.stringify(list[0]));
  const SKIP = new Set(['engagementRate', 'growthPct', 'score']);
  const isDelta = k => /delta$/i.test(k) || /pct$/i.test(k);

  const sumKeys = new Set();
  for (const s of list) for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number' && !SKIP.has(k) && !isDelta(k)) sumKeys.add(k);
  }
  for (const k of sumKeys) base[k] = list.reduce((acc, s) => acc + (typeof s[k] === 'number' ? s[k] : 0), 0);

  if (Array.isArray(base.trend)) {
    const len = Math.max(...list.map(s => Array.isArray(s.trend) ? s.trend.length : 0));
    base.trend = Array.from({ length: len }, (_, i) =>
      list.reduce((acc, s) => acc + (Array.isArray(s.trend) && typeof s.trend[i] === 'number' ? s.trend[i] : 0), 0));
  }
  if (Array.isArray(base.extras)) {
    const m = new Map();
    for (const s of list) for (const e of (s.extras || [])) {
      const cur = m.get(e.label) || { ...e, value: 0 };
      cur.value = (cur.value || 0) + (typeof e.value === 'number' ? e.value : 0);
      m.set(e.label, cur);
    }
    base.extras = [...m.values()];
  }
  if (Array.isArray(base.topPosts)) {
    base.topPosts = list.flatMap(s => Array.isArray(s.topPosts) ? s.topPosts : [])
      .sort((a, b) => (b.score || b.views || 0) - (a.score || a.views || 0)).slice(0, 5);
  }
  // engagement rate: weighted by reach; growthPct recomputed; other deltas dropped
  const w = list.map(s => (typeof s.reach === 'number' && s.reach > 0) ? s.reach : 0);
  const tw = w.reduce((a, b) => a + b, 0);
  if ('engagementRate' in base) {
    base.engagementRate = Math.round((tw > 0
      ? list.reduce((acc, s, i) => acc + (s.engagementRate || 0) * w[i], 0) / tw
      : list.reduce((acc, s) => acc + (s.engagementRate || 0), 0) / list.length) * 100) / 100;
  }
  if ('growthPct' in base && typeof base.followers === 'number') {
    const prev = base.followers - (base.growth || 0);
    base.growthPct = prev > 0 ? Math.round((base.growth / prev) * 1000) / 10 : 0;
  }
  for (const k of Object.keys(base)) if (isDelta(k) && k !== 'growthPct') base[k] = null;

  base.accountId = 'all';
  base.accountLabel = 'All accounts';
  return base;
}

async function _updateIntegrationSyncTime(platformKey) {
  await pool.query(
    `UPDATE integrations SET last_sync_at = now(), last_sync = 'Just now'
     WHERE platform = $1`,
    [platformKey]
  );
}

async function _logSync(platform, status, message, recordsSynced) {
  await pool.query(
    `INSERT INTO sync_logs (platform, status, message, records_synced, completed_at)
     VALUES ($1, $2, $3, $4, now())`,
    [platform, status, message, recordsSynced]
  );
}

// ── Public API ───────────────────────────────────────────────

async function syncPlatform(key, { fullSync = false } = {}) {
  const config = PLATFORM_MODULES[key];
  if (!config) throw new Error(`Unknown platform: ${key}`);

  await _logSync(key, 'started', fullSync ? 'Full sync + snapshots' : null, 0);

  let totalRecordsSynced = 0;
  let hadError = null;

  try {
    // ── Full historical sync (optional) ────────────────────────
    if (fullSync && config.module.getAllPosts) {
      try {
        const allPosts = await config.module.getAllPosts();
        totalRecordsSynced = await _upsertPosts(key, allPosts);
      } catch (allPostsErr) {
        console.error(`Full sync failed for ${key}:`, allPostsErr.message);
        hadError = allPostsErr.message;
      }
    }

    // ── Per-account period snapshots ───────────────────────────
    // One snapshot per account per period (combined at read time). The Redis rate
    // limiter is PER TOKEN, so syncing every account each cycle costs the same per
    // token no matter how many accounts exist. We therefore refresh ALL accounts
    // (incl. the primary) every cycle — previously IG synced only account[0], which
    // left the primary's stats stale until the 3 AM full sync (followers/impressions
    // hours behind the live trend). getStats is gated, so it self-throttles.
    const PERIODS = ['7D', '30D', '90D', 'Custom'];
    const accountsLib = require('./accounts');
    let snapAccounts = await accountsLib.accountsForSync(key).catch(() => []);
    if (!snapAccounts.length) snapAccounts = [{ accountId: null, label: null, statsArg: null }];

    for (const period of PERIODS) {
      for (const acct of snapAccounts) {
        try {
          const stats = await config.module.getStats(period, acct.statsArg);
          if (!stats) continue;
          const snapshotData = { ...stats };
          delete snapshotData.allPosts;
          delete snapshotData.allPostsPrunable;
          snapshotData.accountId = acct.accountId;
          snapshotData.accountLabel = acct.label;
          await _storeSnapshot(key, period, snapshotData, acct.accountId);
          // Upsert each account's 90D posts (tagged by account) so the library reflects all accounts.
          if (period === '90D') {
            totalRecordsSynced += await _upsertPosts(key, stats.allPosts || [], acct.accountId);
            // Only prune when allPosts is a real feed listing (a module can
            // mark it allPostsPrunable:false when it is an analytics subset).
            if (stats.allPostsPrunable !== false) {
              await _pruneDeletedPosts(key, acct.accountId, stats.allPosts || [])
                .catch(e => console.error(`Prune failed for ${key} ${acct.accountId}:`, e.message));
            }
          }
        } catch (periodErr) {
          console.error(`Sync failed for ${key} ${acct.accountId || 'primary'} ${period}:`, periodErr.message);
          hadError = periodErr.message;
        }
      }
    }

    if (hadError && totalRecordsSynced === 0) {
      await _logSync(key, 'error', hadError, 0);
      return { success: false, platform: key, error: hadError };
    }

    // Recalculate scores globally so new posts are fairly ranked
    await recalculateScores();

    // Update integration sync time
    await _updateIntegrationSyncTime(key);

    await _logSync(key, 'success', fullSync ? 'Full sync complete' : null, totalRecordsSynced);
    return { success: true, platform: key, recordsSynced: totalRecordsSynced };
  } catch (err) {
    console.error(`Sync failed for ${key}:`, err.message);
    await _logSync(key, 'error', err.message, 0);
    return { success: false, platform: key, error: err.message };
  }
}

async function syncAll({ fullSync = false } = {}) {
  const results = [];
  const keys = Object.keys(PLATFORM_MODULES);
  for (let i = 0; i < keys.length; i++) {
    const result = await syncPlatform(keys[i], { fullSync });
    results.push(result);
    // Small delay between platforms to avoid rate limit collisions
    if (i < keys.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return results;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL lifetime posts from a platform and upserts them into the DB.
async function _syncAllPosts(platformKey) {
  const config = PLATFORM_MODULES[platformKey];
  if (!config) throw new Error(`Unknown platform: ${platformKey}`);
  if (!config.module.getAllPosts) {
    throw new Error(`Platform ${platformKey} does not support full post sync`);
  }

  await _logSync(platformKey, 'started', 'Full historical sync', 0);

  try {
    const posts = await config.module.getAllPosts();
    const totalRecordsSynced = await _upsertPosts(platformKey, posts);
    await recalculateScores();
    await _updateIntegrationSyncTime(platformKey);
    await _logSync(platformKey, 'success', 'Full historical sync complete', totalRecordsSynced);
    return { success: true, platform: platformKey, recordsSynced: totalRecordsSynced };
  } catch (err) {
    console.error(`Full sync failed for ${platformKey}:`, err.message);
    await _logSync(platformKey, 'error', `Full sync failed: ${err.message}`, 0);
    return { success: false, platform: platformKey, error: err.message };
  }
}

async function getSyncStatus() {
  const { rows: lastSyncRows } = await pool.query(`
    SELECT platform, MAX(fetched_at) as last_sync_at
    FROM sync_snapshots
    GROUP BY platform
  `);

  const { rows: logRows } = await pool.query(`
    SELECT DISTINCT ON (platform)
      platform, status, message, records_synced, completed_at
    FROM sync_logs
    ORDER BY platform, completed_at DESC
  `);

  const status = {};
  for (const row of lastSyncRows) {
    status[row.platform] = { lastSyncAt: row.last_sync_at, status: 'success' };
  }
  for (const row of logRows) {
    if (!status[row.platform]) status[row.platform] = {};
    status[row.platform].latestLog = {
      status: row.status,
      message: row.message,
      recordsSynced: row.records_synced,
      completedAt: row.completed_at,
    };
  }
  return status;
}

// ── Content Score — percentile-based, scoped PER PLATFORM ────
// Each post is scored RELATIVE to the rest of that platform's content using
// percentile ranks (fraction of sibling posts it beats), then blended with
// platform-specific weights. Why percentiles instead of max-normalisation:
//   - one viral outlier no longer crushes every other post toward 0,
//   - scores are comparable across platforms (a 90 means "top decile on its
//     own platform" everywhere), fixing the old cross-platform skew where
//     clicks were null on some platforms but still carried 25% weight.
// Weights pick the metrics each platform actually reports:
//   er    = engagement rate (engagements/views)
//   views = raw reach of the post
//   depth = "strong" interactions the platform exposes (saves+shares on IG)
const SCORE_WEIGHTS = {
  instagram: { er: 0.40, views: 0.30, depth: 0.30 },   // depth: saves + shares
};
const _depthOf = (key, p) => {
  if (key === 'instagram') return (p.saves  || 0) + (p.shares   || 0);
  return (p.likes || 0) + (p.comments || 0);
};

// Percentile rank for each value: fraction of the group strictly below it,
// plus half the ties (midrank) — stable for heavily tied metrics like zeros.
function _percentileRanks(values) {
  const n = values.length;
  if (n === 1) return [0.5];
  const sorted = [...values].sort((a, b) => a - b);
  return values.map(v => {
    let below = 0, ties = 0;
    for (const s of sorted) {
      if (s < v) below++;
      else if (s === v) ties++;
      else break;
    }
    return (below + (ties - 1) / 2) / (n - 1);
  });
}

async function recalculateScores() {
  const { rows: allPosts } = await pool.query(`
    SELECT p.id, pl.key AS platform, p.views, p.engagements, p.likes, p.comments,
           p.shares, p.saves, p.clicks
      FROM posts p JOIN platforms pl ON pl.id = p.platform_id
  `);
  if (!allPosts.length) return;

  const byPlatform = {};
  for (const p of allPosts) (byPlatform[p.platform] ||= []).push(p);

  for (const [key, posts] of Object.entries(byPlatform)) {
    const w = SCORE_WEIGHTS[key] || { er: 0.4, views: 0.3, depth: 0.3 };
    const erRanks    = _percentileRanks(posts.map(p => p.views > 0 ? (p.engagements / p.views) : 0));
    const viewRanks  = _percentileRanks(posts.map(p => Number(p.views) || 0));
    const depthRanks = _percentileRanks(posts.map(p => _depthOf(key, p)));
    // ONE batched UPDATE per platform (was one query per post — hundreds of
    // sequential round-trips per recompute, hogging pool connections that
    // interactive page requests then queued behind).
    const ids = [], scores = [];
    for (let i = 0; i < posts.length; i++) {
      const blended = erRanks[i] * w.er + viewRanks[i] * w.views + depthRanks[i] * w.depth;
      ids.push(posts[i].id);
      scores.push(Math.max(1, Math.min(99, Math.round(blended * 99))));
    }
    await pool.query(
      `UPDATE posts SET score = v.score
         FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS score) v
        WHERE posts.id = v.id AND posts.score IS DISTINCT FROM v.score`,
      [ids, scores]);
  }

  // Fill posts.topic for any newly-synced rows (rule-based, only-NULL → cheap).
  // Kept here so every score recompute also keeps categorization current. Topic
  // is excluded from the upsert ON CONFLICT, so this write persists across syncs.
  try {
    const r = await categorize.recategorizeAll({ onlyNull: true });
    if (r.updated) console.log(`[categorize] tagged ${r.updated} post(s):`, r.byTopic);
  } catch (e) { console.error('[categorize] recategorize failed (non-fatal):', e.message); }
}

// ── Realtime revalidation (stale-while-revalidate, globally throttled) ──
// Triggered when Overview/Performance are viewed. Refreshes ONLY the viewed
// period across platforms so API usage stays bounded. The per-platform getStats
// cache (5 min) + this throttle keep us well under Instagram's 200 calls/hour.
const REVALIDATE_STALE_MS = 5 * 60 * 1000;  // data older than this is "stale"
const REVALIDATE_MIN_MS   = 5 * 60 * 1000;  // never trigger more often than this
let _revalidateAt = 0;
let _revalidating = false;

async function revalidate(period = '30D') {
  const now = Date.now();
  if (_revalidating) return { triggered: false, reason: 'in-flight' };
  if (now - _revalidateAt < REVALIDATE_MIN_MS) return { triggered: false, reason: 'throttled' };

  const { rows } = await pool.query(
    'SELECT max(fetched_at) AS latest FROM sync_snapshots WHERE period = $1', [period]);
  const latest = rows[0]?.latest ? new Date(rows[0].latest).getTime() : 0;
  if (now - latest < REVALIDATE_STALE_MS) return { triggered: false, reason: 'fresh' };

  _revalidating = true;
  _revalidateAt = now;
  (async () => {
    try {
      for (const key of Object.keys(PLATFORM_MODULES)) {
        const mod = PLATFORM_MODULES[key].module;
        try {
          const stats = await mod.getStats(period);
          if (!stats) continue;
          const snap = { ...stats };
          delete snap.allPosts;
          await _storeSnapshot(key, period, snap);
          if (stats.allPosts?.length) await _upsertPosts(key, stats.allPosts);
        } catch (e) {
          console.error(`Revalidate ${key} ${period} failed:`, e.message);
        }
      }
      await recalculateScores();
      console.log(`[revalidate] refreshed period ${period}`);
    } finally {
      _revalidating = false;
    }
  })();

  return { triggered: true };
}

// Newest snapshot timestamp for a period (for the "Updated Xm ago" indicator)
async function getLastSyncAt(period = '30D') {
  const { rows } = await pool.query(
    'SELECT max(fetched_at) AS latest FROM sync_snapshots WHERE period = $1 AND platform = ANY($2)',
    [period, Object.keys(PLATFORM_MODULES)]);
  return rows[0]?.latest || null;
}

async function getLatestSnapshot(platform, period = '30D') {
  // Try requested period first
  const { rows } = await pool.query(
    `SELECT data, fetched_at, period FROM sync_snapshots
     WHERE platform = $1 AND period = $2
     ORDER BY fetched_at DESC LIMIT 1`,
    [platform, period]
  );
  if (rows[0]) return rows[0];
  // Fallback to latest snapshot of any period
  const { rows: fallback } = await pool.query(
    `SELECT data, fetched_at, period FROM sync_snapshots
     WHERE platform = $1
     ORDER BY fetched_at DESC LIMIT 1`,
    [platform]
  );
  return fallback[0] || null;
}

// ── Comment polling ──────────────────────────────────────────
// Instagram comments: webhooks deliver live deltas; this is the periodic
// catch-up + historical backfill (runs on the syncAll cron and once at boot).
// The module self-throttles with a cooldown.
async function syncComments() {
  try {
    const count = await instagram.syncComments();
    return [{ platform: 'instagram', success: true, count }];
  } catch (err) {
    return [{ platform: 'instagram', success: false, error: err.message }];
  }
}

// ── Followers trend (time-wise, hour/day/week filterable) ────
// MEASUREMENT-FIRST, one source of truth. `follower_samples` holds ABSOLUTE
// follower counts that we fetch ourselves on a fixed cadence for every account
// on every platform. Hours / Days / Weeks are all built from that single store
// with identical "last value in the bucket" semantics, so the three views can
// never disagree about the same moment in time.
//
// Anything else — a snapshot's `data.followers`, Instagram's `follower_count`
// insight — is only ever an ESTIMATE, and is used under two hard rules:
//   1. it may fill buckets BEFORE our first real measurement, never inside or
//      after the measured region, and
//   2. it is offset-corrected onto the measured series first.
// Rule 2 matters because IG's `follower_count` counts NEW follows and ignores
// unfollows: its reconstructed baseline (followers − Σgains) drifts hundreds of
// followers low over 30 days and can only ever go up. Splicing it in raw is what
// produced the "always a smooth gradual increase" daily line that contradicted
// the (real) hourly one. Estimated/carried points are flagged so the UI can say so.
//
// Every query here reads the DB only — zero Graph API calls.

const IST_OFFSET_MS = 330 * 60 * 1000;   // Asia/Kolkata, no DST
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _pad2 = n => String(n).padStart(2, '0');

// IST wall-clock bucket key for an epoch-ms instant.
//   hours → "2026-08-31 14:00"   days/weeks → "2026-08-31"
// Keys sort lexicographically in chronological order, which the merge relies on.
function _bucketKey(ms, unit) {
  const d = new Date(ms + IST_OFFSET_MS);
  const day = `${d.getUTCFullYear()}-${_pad2(d.getUTCMonth() + 1)}-${_pad2(d.getUTCDate())}`;
  return unit === 'hours' ? `${day} ${_pad2(d.getUTCHours())}:00` : day;
}

// The contiguous calendar grid the chart is drawn on: `count` buckets ending at
// the current IST hour/day. Building on a real calendar grid (instead of "the
// last N rows we happen to have") is what keeps the x-axis honest — a gap in
// sampling shows as a flat carried segment, not as a compressed axis.
function _gridKeys(unit, count) {
  const step = unit === 'hours' ? 3600e3 : 86400e3;
  const now = Date.now();
  const keys = [];
  for (let i = count - 1; i >= 0; i--) keys.push(_bucketKey(now - i * step, unit));
  return keys;
}

function _labelBucket(key, unit) {
  const [datePart, timePart] = key.split(' ');
  const [, mo, da] = datePart.split('-');
  const dayLabel = `${parseInt(da, 10)} ${MONTHS[parseInt(mo, 10) - 1]}`;
  if (unit !== 'hours' || !timePart) return dayLabel;
  const h = parseInt(timePart.slice(0, 2), 10);
  return `${dayLabel} ${(h % 12) || 12}${h >= 12 ? 'PM' : 'AM'}`;
}

// SQL expression that buckets a timestamptz column into an IST bucket key.
function _bucketSql(col, unit) {
  return unit === 'hours'
    ? `to_char(date_trunc('hour', ${col} AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24') || ':00'`
    : `to_char((${col} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;
}

// ── Measured series (the authority) ──────────────────────────
// Last sample per (account, bucket). Returns Map<accountId, Map<bucket, value>>.
async function _measuredBuckets(platform, accountKey, unit, spanKeys) {
  const params = [platform];
  let accCond = '';
  if (accountKey && accountKey !== 'all') {
    params.push(accountKey);
    accCond = ` AND account_id = $${params.length}`;
  }
  // Fetch a little beyond the window so the first bucket can carry forward from
  // the last known value before it instead of starting the line mid-air.
  params.push(spanKeys);
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (account_id, bucket) account_id, bucket, followers
       FROM (
         SELECT account_id, ${_bucketSql('sampled_at', unit)} AS bucket, followers, sampled_at
           FROM follower_samples
          WHERE platform = $1${accCond}
            AND followers > 0
            AND sampled_at > now() - ($${params.length})::interval
       ) t
      ORDER BY account_id, bucket, sampled_at DESC`, params);
  const per = new Map();
  for (const r of rows) {
    if (!per.has(r.account_id)) per.set(r.account_id, new Map());
    per.get(r.account_id).set(r.bucket, Number(r.followers));
  }
  return per;
}

// Collapse per-account measured maps onto the grid. Each account carries its own
// last known value forward; a bucket is only emitted once EVERY account in the
// set has a known value, so the combined "all accounts" line never shows a fake
// step when a second account's history begins later than the first's.
function _combineAccounts(perAccount, keys) {
  const out = new Map();
  const states = [...perAccount.values()].map(m => ({ m, last: null }));
  if (!states.length) return out;
  for (const k of keys) {
    let sum = 0, ready = 0, exact = false;
    for (const s of states) {
      if (s.m.has(k)) { s.last = s.m.get(k); exact = true; }
      if (s.last != null) { sum += s.last; ready++; }
    }
    if (ready === states.length) out.set(k, { value: sum, exact });
  }
  return out;
}

// Magnitude band around a known follower count — used to attribute legacy
// null-`account_key` snapshots (the frequent revalidate path stores them) to the
// right account, since a 1k account and a 59k account can't be confused. Pushes
// the lo/hi bounds onto `params` and returns the SQL fragment (or null).
function _bandSql(params, refFollowers) {
  if (!refFollowers) return null;
  params.push(Math.floor(refFollowers / 4)); const lo = '$' + params.length;
  params.push(Math.ceil(refFollowers * 4));  const hi = '$' + params.length;
  return `(data->>'followers')::bigint BETWEEN ${lo} AND ${hi}`;
}

// Account-match condition: a concrete account's own rows PLUS legacy null-account
// rows that fall in its magnitude band; for legacy rows (accountKey null)
// it's the null rows in band. Call AFTER _bandSql.
function _accountCond(params, accountKey, bandSql) {
  if (accountKey && accountKey !== 'all') {
    params.push(accountKey); const acc = '$' + params.length;
    return bandSql ? `(account_key = ${acc} OR (account_key IS NULL AND ${bandSql}))` : `account_key = ${acc}`;
  }
  return bandSql ? `(account_key IS NULL AND ${bandSql})` : `account_key IS NULL`;
}

// ── Estimate series (pre-measurement history only) ───────────
// Last `data.followers` per IST bucket from stored snapshots.
async function _snapshotBuckets(platform, accountKey, unit, refFollowers) {
  if (accountKey === 'all') return new Map();
  const params = [platform];
  const bandSql = _bandSql(params, refFollowers);
  const conds = [
    `platform = $1`,
    `(data->>'followers') ~ '^[0-9]+$'`,
    `(data->>'followers')::bigint > 0`,
    _accountCond(params, accountKey, bandSql),
  ];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (bucket) bucket, followers
       FROM (
         SELECT ${_bucketSql('fetched_at', unit)} AS bucket,
                (data->>'followers')::bigint AS followers, fetched_at
           FROM sync_snapshots
          WHERE ${conds.join(' AND ')}
       ) t
      ORDER BY bucket, fetched_at DESC`, params);
  return new Map(rows.map(r => [r.bucket, Number(r.followers)]));
}

// Platform-reported daily follower series from the latest snapshot payload.
// Prefers `trendSeries` ([{date,value}], carries the API's own end_time dates);
// falls back to the legacy positional `trend` array anchored at fetchedAt − 1 day
// (IG's follower_count end_time is the day BEFORE the fetch).
function _payloadTrendBuckets(data, fetchedAt) {
  const out = new Map();
  const series = Array.isArray(data?.trendSeries) ? data.trendSeries : null;
  if (series && series.length) {
    for (const p of series) {
      if (!p || typeof p.value !== 'number' || !p.date) continue;
      out.set(String(p.date).slice(0, 10), p.value);
    }
    return out;
  }
  const trend = Array.isArray(data?.trend) ? data.trend : [];
  if (!trend.length) return out;
  let ms = (fetchedAt ? new Date(fetchedAt).getTime() : Date.now()) - 86400e3;
  for (let i = trend.length - 1; i >= 0; i--, ms -= 86400e3) {
    if (typeof trend[i] === 'number') out.set(_bucketKey(ms, 'days'), trend[i]);
  }
  return out;
}

// Splice estimates into the measured map, offset-corrected, BEFORE the first
// measurement only. Mutates `measured`.
function _spliceEstimates(measured, estimate, keys) {
  if (!estimate.size) return;
  const firstMeasured = keys.find(k => measured.has(k));

  // Offset = median(measured − estimate) over buckets both cover. This removes
  // the systematic baseline error of a gains-derived reconstruction while
  // preserving its day-to-day shape, so the estimated tail joins the measured
  // line continuously instead of dropping off a cliff.
  const diffs = [];
  for (const [k, v] of estimate) {
    const m = measured.get(k);
    if (m) diffs.push(m.value - v);
  }
  let offset = 0;
  if (diffs.length) {
    diffs.sort((a, b) => a - b);
    offset = diffs[Math.floor(diffs.length / 2)];
  } else if (firstMeasured) {
    // No overlap at all — pin the newest estimate point to the first real one.
    const prior = [...estimate.keys()].filter(k => k < firstMeasured).sort();
    const anchor = prior[prior.length - 1];
    if (anchor !== undefined) offset = measured.get(firstMeasured).value - estimate.get(anchor);
  }

  for (const k of keys) {
    if (firstMeasured !== undefined && k >= firstMeasured) break;
    const v = estimate.get(k);
    if (v === undefined) continue;
    measured.set(k, { value: Math.max(0, Math.round(v + offset)), exact: false, estimated: true });
  }
}

// data = the chosen account's snapshot payload; fetchedAt = its fetch timestamp.
// Returns [{ label, date, value, delta, estimated, carried }] — `value` is the
// absolute follower count, `delta` the change since the previous point.
async function buildFollowersTrend(platform, accountKey, data, fetchedAt, unit = 'days', range = 30, opts = {}) {
  const refFollowers = opts.refFollowers || Number(data?.followers) || 0;
  const gridUnit = unit === 'hours' ? 'hours' : 'days';
  // Weeks are sampled out of a daily grid so a week point is a real calendar
  // week-ending value, not "seven rows back in whatever we happened to store".
  const count = unit === 'weeks' ? range * 7 : range;
  const keys = _gridKeys(gridUnit, count);
  const spanKeys = gridUnit === 'hours' ? `${count + 12} hours` : `${count + 7} days`;

  const perAccount = await _measuredBuckets(platform, accountKey, gridUnit, spanKeys);
  const merged = _combineAccounts(perAccount, keys);

  // Fill only what we never measured, from (offset-corrected) estimates.
  const estimate = await _snapshotBuckets(platform, accountKey, gridUnit, refFollowers);
  if (gridUnit === 'days' && accountKey !== 'all') {
    for (const [k, v] of _payloadTrendBuckets(data, fetchedAt)) estimate.set(k, v);
  }
  _spliceEstimates(merged, estimate, keys);

  // Walk the grid, carrying the last known value across gaps.
  const points = [];
  let last = null;
  for (const k of keys) {
    const hit = merged.get(k);
    if (hit) last = { value: hit.value, estimated: !!hit.estimated, carried: !hit.exact && !hit.estimated };
    else if (last) last = { ...last, carried: true };
    if (!last) continue;  // nothing known yet — don't draw a line out of nowhere
    points.push({ key: k, ...last });
  }
  if (!points.length) return [];

  const chosen = unit === 'weeks'
    ? points.filter((_, i) => (points.length - 1 - i) % 7 === 0).slice(-range)
    : points;

  return chosen.map((p, i) => ({
    label: _labelBucket(p.key, gridUnit),
    date: p.key,
    value: p.value,
    delta: i === 0 ? null : p.value - chosen[i - 1].value,
    estimated: p.estimated,
    carried: p.carried,
  }));
}

// When did we last get a real follower reading for this account? Lets the UI
// explain an empty/short chart ("last reading 54 days ago") instead of leaving a
// disconnected platform looking like it simply has no audience.
async function getLastFollowerSampleAt(platform, accountKey) {
  const params = [platform];
  let accCond = '';
  if (accountKey && accountKey !== 'all') { params.push(accountKey); accCond = ` AND account_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT max(sampled_at) AS at FROM follower_samples WHERE platform = $1${accCond}`, params);
  return rows[0]?.at || null;
}

// ── Follower sampler ─────────────────────────────────────────
// Records one ABSOLUTE follower count per connected account into
// follower_samples for EVERY platform, every 6 hours (startFollowerSampler in
// index.js — 4 readings a day), independent of page views. This is the
// canonical store every followers-trend view reads.
//
// Each platform is sampled DIRECTLY with its own cheapest call (1 API call or
// quota unit per account), so a platform whose analytics snapshot is stale or
// failing still gets a true daily reading. If the direct sampler is unavailable
// we fall back to a recent snapshot (<90 min old, > 0) rather than storing a
// stale or failed-fetch value as if it were fresh.
const _SAMPLERS = { instagram };

async function _directSamples(platform) {
  const mod = _SAMPLERS[platform];
  if (!mod || typeof mod.sampleFollowers !== 'function') return [];
  const out = await mod.sampleFollowers();
  return (out || []).filter(s => s && s.accountId && Number(s.followers) > 0)
    .map(s => ({ accountId: String(s.accountId), followers: Number(s.followers) }));
}

async function _snapshotSamples(platform, skipAccounts) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (acc) acc, followers FROM (
       SELECT COALESCE(data->>'accountId', account_key) AS acc,
              (data->>'followers')::bigint AS followers, fetched_at
         FROM sync_snapshots
        WHERE platform = $1
          AND COALESCE(data->>'accountId', account_key) IS NOT NULL
          AND (data->>'followers') ~ '^[0-9]+$' AND (data->>'followers')::bigint > 0
          AND fetched_at > now() - interval '90 minutes'
     ) t ORDER BY acc, fetched_at DESC`, [platform]);
  return rows
    .filter(r => !skipAccounts.has(String(r.acc)))
    .map(r => ({ accountId: String(r.acc), followers: Number(r.followers) }));
}

async function recordFollowerSamples() {
  let total = 0;
  const perPlatform = {};

  for (const platform of Object.keys(_SAMPLERS)) {
    const samples = [];
    try {
      samples.push(...await _directSamples(platform));
    } catch (e) {
      console.error(`${platform} direct follower sample failed:`, e.message);
    }
    try {
      const seen = new Set(samples.map(s => s.accountId));
      samples.push(...await _snapshotSamples(platform, seen));
    } catch (e) {
      console.error(`${platform} snapshot follower sample failed:`, e.message);
    }
    for (const s of samples) {
      try {
        await pool.query(
          `INSERT INTO follower_samples (platform, account_id, followers) VALUES ($1, $2, $3)`,
          [platform, s.accountId, s.followers]);
        total++;
      } catch (e) {
        console.error(`${platform} follower sample insert failed:`, e.message);
      }
    }
    if (samples.length) perPlatform[platform] = samples.length;
  }

  if (total) console.log(`Recorded ${total} follower sample(s):`,
    Object.entries(perPlatform).map(([p, n]) => `${p}:${n}`).join(', '));
  return total;
}

// ── Per-post daily metric logger ─────────────────────────────
// One row per post per IST day, snapshotted straight out of the `posts` table
// (kept fresh by the syncs) — ZERO extra API calls. Lifetime counters are stored
// as-of that day, so the difference between consecutive days is what the post
// actually gained that day: real per-reel/per-post daily views, likes, comments.
// Idempotent: re-running the same day updates the row instead of duplicating it,
// and lifetime counters only ever move up (GREATEST) so a partial sync can't
// write a dip that would read as "lost views".
// `days` bounds how far back a post may have been PUBLISHED to still be logged;
// null logs every post in the library. The whole library is only a few hundred
// rows, so logging all of it costs ~1 row/post/day and gives every post — not
// just recent ones — a real history from today forward.
async function recordPostMetricSamples({ days = null } = {}) {
  const { rowCount } = await pool.query(
    `INSERT INTO post_metric_samples
       (platform, account_key, external_id, post_id, day,
        views, likes, comments, shares, saves, engagements, score, sampled_at)
     SELECT pl.key, p.account_key, p.external_id, p.id,
            (now() AT TIME ZONE 'Asia/Kolkata')::date,
            p.views, p.likes, p.comments, p.shares, COALESCE(p.saves, 0),
            p.engagements, p.score, now()
       FROM posts p
       JOIN platforms pl ON pl.id = p.platform_id
      WHERE p.external_id IS NOT NULL
        AND pl.key = ANY($2)
        AND ($1::int IS NULL OR p.date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($1)::int)
     ON CONFLICT (platform, external_id, day) DO UPDATE SET
       account_key = COALESCE(EXCLUDED.account_key, post_metric_samples.account_key),
       post_id     = EXCLUDED.post_id,
       views       = GREATEST(post_metric_samples.views,       EXCLUDED.views),
       likes       = GREATEST(post_metric_samples.likes,       EXCLUDED.likes),
       comments    = GREATEST(post_metric_samples.comments,    EXCLUDED.comments),
       shares      = GREATEST(post_metric_samples.shares,      EXCLUDED.shares),
       saves       = GREATEST(post_metric_samples.saves,       EXCLUDED.saves),
       engagements = GREATEST(post_metric_samples.engagements, EXCLUDED.engagements),
       score       = EXCLUDED.score,
       sampled_at  = EXCLUDED.sampled_at`,
    [days, Object.keys(PLATFORM_MODULES)]);
  if (rowCount) console.log(`Logged daily metrics for ${rowCount} post(s)`);
  return rowCount;
}

const _METRIC_COLS = ['views', 'likes', 'comments', 'shares', 'saves', 'engagements'];

// Per-post daily history: absolute lifetime counters per day PLUS the per-day
// gain (delta vs the previous logged day). `gained*` is null on the first logged
// day — we don't know what the post had before we started logging it.
async function getPostMetricsTrend(postId, { days = 60, platform = null } = {}) {
  // `postId` may be the internal posts.id OR the platform's external id (the UI
  // carries the external id on preview cards). Both are numeric strings on some
  // platforms, so a supplied `platform` disambiguates: try external first, then
  // fall back to the internal id.
  const base = `SELECT p.id, p.external_id, p.title, p.date, p.type, pl.key AS platform
                  FROM posts p JOIN platforms pl ON pl.id = p.platform_id`;
  let post = null;
  if (platform) {
    const { rows } = await pool.query(`${base} WHERE p.external_id = $1 AND pl.key = $2 LIMIT 1`, [String(postId), platform]);
    post = rows[0] || null;
  }
  if (!post && /^\d+$/.test(String(postId))) {
    const { rows } = await pool.query(`${base} WHERE p.id = $1`, [postId]);
    post = rows[0] || null;
  }
  if (!post) {
    const { rows } = await pool.query(`${base} WHERE p.external_id = $1 LIMIT 1`, [String(postId)]);
    post = rows[0] || null;
  }
  if (!post) return null;

  const { rows } = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, views, likes, comments, shares, saves, engagements, score
       FROM post_metric_samples
      WHERE platform = $1 AND external_id = $2
        AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($3)::int
      ORDER BY day`, [post.platform, post.external_id, days]);

  const points = rows.map((r, i) => {
    const prev = rows[i - 1];
    const point = {
      date: r.day,
      label: _labelBucket(r.day, 'days'),
      score: r.score,
    };
    for (const c of _METRIC_COLS) {
      point[c] = Number(r[c]) || 0;
      const gainedKey = 'gained' + c[0].toUpperCase() + c.slice(1);
      point[gainedKey] = prev ? Math.max(0, Number(r[c]) - Number(prev[c])) : null;
    }
    return point;
  });

  return {
    post: { id: post.id, title: post.title, platform: post.platform, type: post.type, date: post.date },
    days,
    points,
    // Honest about what the chart can show: history starts the day the logger
    // first saw this post, which for older posts is after it was published.
    loggingStartedAt: points[0]?.date || null,
  };
}

// Account-wide daily gains: how many views / engagements ALL of a platform's
// posts picked up on each day, summed from the same per-post logs.
async function getDailyMetricsTrend(platform, { days = 30, account = null } = {}) {
  const params = [platform, days];
  let accCond = '';
  if (account && account !== 'all') {
    params.push(account);
    accCond = ` AND (account_key = $${params.length} OR account_key IS NULL)`;
  }
  const { rows } = await pool.query(
    `WITH d AS (
       SELECT external_id, day, views, likes, comments, shares, saves, engagements,
              LAG(views)       OVER w AS prev_views,
              LAG(likes)       OVER w AS prev_likes,
              LAG(comments)    OVER w AS prev_comments,
              LAG(shares)      OVER w AS prev_shares,
              LAG(saves)       OVER w AS prev_saves,
              LAG(engagements) OVER w AS prev_engagements
         FROM post_metric_samples
        WHERE platform = $1${accCond}
          AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($2)::int - 1
        WINDOW w AS (PARTITION BY external_id ORDER BY day)
     )
     SELECT to_char(day, 'YYYY-MM-DD') AS day,
            SUM(GREATEST(views       - COALESCE(prev_views, views),             0)) AS views,
            SUM(GREATEST(likes       - COALESCE(prev_likes, likes),             0)) AS likes,
            SUM(GREATEST(comments    - COALESCE(prev_comments, comments),       0)) AS comments,
            SUM(GREATEST(shares      - COALESCE(prev_shares, shares),           0)) AS shares,
            SUM(GREATEST(saves       - COALESCE(prev_saves, saves),             0)) AS saves,
            SUM(GREATEST(engagements - COALESCE(prev_engagements, engagements), 0)) AS engagements,
            COUNT(*) FILTER (WHERE prev_views IS NOT NULL) AS posts_tracked
       FROM d
      WHERE prev_views IS NOT NULL
        AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($2)::int
      GROUP BY day ORDER BY day`, params);

  return rows.map(r => ({
    date: r.day,
    label: _labelBucket(r.day, 'days'),
    views: Number(r.views) || 0,
    likes: Number(r.likes) || 0,
    comments: Number(r.comments) || 0,
    shares: Number(r.shares) || 0,
    saves: Number(r.saves) || 0,
    engagements: Number(r.engagements) || 0,
    postsTracked: Number(r.posts_tracked) || 0,
  }));
}

// Overlay the freshest sampled follower count onto a (possibly hours-old) snapshot
// so the "Followers" KPI matches the trend chart's latest point. The per-account
// snapshot can lag (the 30-min auto-sync only refreshes one IG account/cycle), but
// the sampler records every account's count every 30 min. Growth is shifted by the
// same delta so the "+N in 30d" stays consistent. Mutates + returns `data`.
async function overlayFreshFollowers(platform, accountId, data) {
  if (!data || typeof data.followers !== 'number') return data;
  let fresh = null;
  if (accountId && accountId !== 'all') {
    const { rows } = await pool.query(
      `SELECT followers FROM follower_samples WHERE platform = $1 AND account_id = $2 ORDER BY sampled_at DESC LIMIT 1`,
      [platform, accountId]);
    if (rows[0]) fresh = Number(rows[0].followers);
  } else if (accountId === 'all') {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (account_id) followers FROM follower_samples WHERE platform = $1 ORDER BY account_id, sampled_at DESC`,
      [platform]);
    if (rows.length) fresh = rows.reduce((a, r) => a + Number(r.followers), 0);
  }
  if (fresh == null || !(fresh > 0) || fresh === data.followers) return data;
  const delta = fresh - data.followers;
  data.followers = fresh;
  if (typeof data.growth === 'number') data.growth += delta;
  if (typeof data.scaledGrowth === 'number') data.scaledGrowth += delta;
  const base = fresh - (data.growth || 0);
  if (base > 0 && typeof data.growth === 'number') data.growthPct = parseFloat((data.growth / base * 100).toFixed(1));
  return data;
}

module.exports = {
  syncPlatform,
  syncAll,
  syncComments,
  getSyncStatus,
  getLatestSnapshot,
  getAccountSnapshots,
  combineSnapshots,
  buildFollowersTrend,
  getLastFollowerSampleAt,
  recordFollowerSamples,
  recordPostMetricSamples,
  getPostMetricsTrend,
  getDailyMetricsTrend,
  overlayFreshFollowers,
  _upsertPosts,
  recalculateScores,
  revalidate,
  getLastSyncAt,
  _pruneDeletedPosts,
};
