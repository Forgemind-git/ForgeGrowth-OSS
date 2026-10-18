const socialEnv = require('./env');
// ============================================================
// instagram.js — Instagram Graph API service (Business accounts)
// ============================================================
const pool   = require('./db');
const crypto = require('crypto');
const { forgeCommandNotify } = require('./forgeCommandNotify');
const fs     = require('fs');
const path   = require('path');
// Route every API call in this module through the Redis rate limiter. gatedFetch
// gates known API hosts (graph.instagram.com / graph.facebook.com) per token and
// passes non-API fetches (image/CDN downloads) straight through.
const fetch  = require('./rateLimiter').gatedFetch;
const notify = require('./notificationService');

const UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';
const truncate = (s, n = 80) => { s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const IG_API = 'https://graph.instagram.com/v21.0';   // Instagram API with Instagram Login
const OAUTH_REDIRECT = socialEnv.INSTAGRAM_OAUTH_REDIRECT || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/instagram/oauth/callback' : '');
const OAUTH_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights,instagram_business_content_publish';
// Public origin Instagram fetches uploaded media from (it must resolve image_url/video_url
// over the internet). Derived from the OAuth redirect so it tracks the deployed host.
const PUBLIC_BASE = socialEnv.PUBLIC_BASE_URL || OAUTH_REDIRECT.replace(/\/api\/.*$/, '');

// ── In-memory cache (prevents repeat API calls & rate limit burn) ─
// Rate limit: 200 calls/hour per user token. getStats() uses 5 calls per run.
// Cache TTL: 15min for stats, 5min for status, invalidated on credential save.
const cache = new Map();
const CACHE_TTL = {
  stats:  5 * 60 * 1000,   // 5 minutes (near-realtime; revalidated on view)
  status:  5 * 60 * 1000,  // 5 minutes
};

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function cacheInvalidate(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ── Normalise Instagram media type to Post / Reel / Story ────
function normalizeMediaType(m) {
  const mt  = (m.media_type || '').toUpperCase();
  const mpt = (m.media_product_type || '').toUpperCase();
  if (mt === 'REELS' || mt === 'REEL' || mpt === 'REELS') return 'Reel';
  if (mt === 'STORY' || mpt === 'STORY') return 'Story';
  // IMAGE, VIDEO, CAROUSEL_ALBUM and anything else → Post
  return 'Post';
}

// ── Credential helpers ───────────────────────────────────────
async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value || null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function getCredentials() {
  const [accountId, accessToken, appId, tokenExpiresAt] = await Promise.all([
    getSetting('instagram_account_id'),
    getSetting('instagram_access_token'),
    getSetting('instagram_app_id'),
    getSetting('instagram_token_expires_at'),
  ]);
  return { accountId, accessToken, appId, tokenExpiresAt };
}

// ── Graph API fetch ──────────────────────────────────────────
// `base` defaults to the Facebook Graph host; pass IG_API for Instagram-Login tokens.
async function graphFetch(path, params = {}, base = GRAPH_BASE) {
  const url = new URL(`${base}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Instagram API error');
  return data;
}

// ── Active auth resolver ─────────────────────────────────────
// Analytics (getStats/getAllPosts) run off whichever credential is connected:
//   1. OAuth-connected account → Instagram Login token + graph.instagram.com
//      (requires the instagram_business_manage_insights scope on the token)
//   2. Legacy manually-pasted credentials → Facebook Graph token + graph.facebook.com
// Returns { base, token, accountId, via } or null when nothing is connected.
async function getActiveAuth() {
  const { rows } = await pool.query(
    `SELECT account_id, token FROM instagram_accounts
      WHERE token IS NOT NULL
      ORDER BY token_expires_at DESC NULLS LAST
      LIMIT 1`);
  if (rows[0]?.token && rows[0]?.account_id) {
    return { base: IG_API, token: rows[0].token, accountId: rows[0].account_id, via: 'oauth' };
  }
  const { accountId, accessToken } = await getCredentials();
  if (accountId && accessToken) {
    return { base: GRAPH_BASE, token: accessToken, accountId, via: 'legacy' };
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────
async function testConnection(force = false) {
  if (!force) {
    const cached = cacheGet('status');
    if (cached) return cached;
  }

  // Prefer an OAuth-connected account (Instagram Login token in instagram_accounts)
  const { rows } = await pool.query(
    `SELECT account_id, username, name, token, token_expires_at, needs_reconnect
       FROM instagram_accounts
      WHERE token IS NOT NULL
      ORDER BY token_expires_at DESC NULLS LAST
      LIMIT 1`);
  if (rows[0]) {
    const a = rows[0];
    const expiry  = a.token_expires_at ? new Date(a.token_expires_at).getTime() : null;
    const expired = expiry != null && expiry <= Date.now();
    const daysLeft = expiry != null ? Math.max(0, Math.round((expiry - Date.now()) / 86400000)) : null;

    // SOURCE OF TRUTH = the stored token. A non-expired OAuth token that isn't
    // flagged for reconnect IS a live connection. The /me call below only ENRICHES
    // the profile (followers/pic) — its failure (rate-limit, transient Graph blip)
    // must NEVER downgrade a genuinely-connected account to "disconnected". (Before,
    // any /me hiccup fell through to the legacy paste credential, which is empty for
    // OAuth-connected accounts, so the card flapped to Disconnected while syncing.)
    if (!a.needs_reconnect && !expired) {
      let profile = { name: a.name, username: a.username, followers: null, profilePictureUrl: null };
      try {
        const meUrl = new URL(`${IG_API}/me`);
        meUrl.searchParams.set('fields', 'user_id,username,name,followers_count,profile_picture_url');
        meUrl.searchParams.set('access_token', a.token);
        const me = await (await fetch(meUrl)).json();
        if (me && !me.error) {
          profile = {
            name: me.name || a.name,
            username: me.username || a.username,
            followers: me.followers_count,
            profilePictureUrl: me.profile_picture_url,
          };
        }
      } catch { /* keep the DB profile — the connection stands regardless */ }
      const result = { connected: true, hasCredentials: true, via: 'oauth', profile, tokenDaysLeft: daysLeft };
      cacheSet('status', result, CACHE_TTL.status);
      return result;
    }

    // Token genuinely expired or flagged by the refresher → really needs reconnect.
    if (expired || a.needs_reconnect) {
      return {
        connected: false, hasCredentials: true, via: 'oauth', needsReconnect: true,
        error: expired ? 'Instagram token expired — reconnect the account.' : 'Instagram account needs reconnecting.',
        profile: { name: a.name, username: a.username }, tokenDaysLeft: daysLeft,
      };
    }
  }

  const { accountId, accessToken, tokenExpiresAt } = await getCredentials();
  if (!accountId || !accessToken) {
    return { connected: false, error: 'No credentials saved', hasCredentials: false };
  }
  try {
    const profile = await graphFetch(`/${accountId}`, {
      fields: 'followers_count,media_count,name,username,biography,profile_picture_url',
      access_token: accessToken,
    });
    const daysLeft = tokenExpiresAt
      ? Math.max(0, Math.round((new Date(tokenExpiresAt) - Date.now()) / 86400000))
      : null;
    const result = {
      connected: true,
      hasCredentials: true,
      profile: {
        name: profile.name,
        username: profile.username,
        followers: profile.followers_count,
        mediaCount: profile.media_count,
        biography: profile.biography,
        profilePictureUrl: profile.profile_picture_url,
      },
      tokenDaysLeft: daysLeft,
    };
    cacheSet('status', result, CACHE_TTL.status);
    return result;
  } catch (err) {
    return { connected: false, hasCredentials: true, error: err.message };
  }
}

async function saveCredentials({ accountId, accessToken, appId }) {
  const tasks = [
    setSetting('instagram_account_id', accountId),
    setSetting('instagram_access_token', accessToken),
  ];
  if (appId) tasks.push(setSetting('instagram_app_id', appId));

  // Default 60-day expiry for long-lived tokens
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  tasks.push(setSetting('instagram_token_expires_at', expiresAt));

  await Promise.all(tasks);
  cacheInvalidate('');  // Clear all cache on credential change
}

async function refreshToken() {
  const { accessToken } = await getCredentials();
  if (!accessToken) throw new Error('No access token saved');

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Token refresh failed');

  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
  await Promise.all([
    setSetting('instagram_access_token', data.access_token),
    setSetting('instagram_token_expires_at', expiresAt),
  ]);
  return { expiresAt, daysLeft: Math.round((data.expires_in || 5184000) / 86400) };
}

// Refresh every OAuth-connected account token (instagram_accounts rows).
// IG long-lived tokens are refreshable once they're >=24h old and not yet
// expired; each refresh restarts the 60-day clock. Tokens younger than 24h
// are skipped silently (Meta rejects the refresh — benign, retried tomorrow).
async function refreshAccountTokens(thresholdDays = 45) {
  const { rows } = await pool.query(
    `SELECT account_id, username, token, token_expires_at FROM instagram_accounts
      WHERE token IS NOT NULL`);
  const results = [];
  for (const a of rows) {
    const daysLeft = a.token_expires_at
      ? (new Date(a.token_expires_at) - Date.now()) / 86400000
      : null;
    if (daysLeft !== null && daysLeft > thresholdDays) {
      results.push({ accountId: a.account_id, ok: true, skipped: true, daysLeft: Math.round(daysLeft) });
      continue;
    }
    try {
      const url = new URL('https://graph.instagram.com/refresh_access_token');
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', a.token);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'Token refresh failed');
      const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000);
      await pool.query(
        `UPDATE instagram_accounts
            SET token = $2, token_expires_at = $3, last_refresh_at = now(),
                last_refresh_error = NULL, needs_reconnect = false
          WHERE account_id = $1`,
        [a.account_id, data.access_token, expiresAt]);
      results.push({ accountId: a.account_id, ok: true, daysLeft: Math.round((data.expires_in || 5184000) / 86400) });
    } catch (e) {
      // "<24h old" rejections are benign — the token was just (re)issued.
      if (/24 hours|too soon/i.test(e.message)) {
        results.push({ accountId: a.account_id, ok: true, skipped: true });
        continue;
      }
      // Transient (network/rate-limit) errors say nothing about the token — skip.
      if (/fetch failed|network|econn|etimedout|socket hang|rate.?limited|timed?\s?out|temporar/i.test(e.message)) {
        results.push({ accountId: a.account_id, ok: true, skipped: true });
        continue;
      }
      const dead = /expired|invalid|session|cannot be refreshed|deauthorized/i.test(e.message)
        || (daysLeft !== null && daysLeft <= 0);
      await pool.query(
        `UPDATE instagram_accounts
            SET last_refresh_error = $2, needs_reconnect = needs_reconnect OR $3
          WHERE account_id = $1`,
        [a.account_id, e.message.slice(0, 500), dead]);
      results.push({ accountId: a.account_id, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Audience insights — demographics + when followers are online ──
// 4 Graph calls per account, cached 24h (vs the 180/hr budget that's noise).
// follower_demographics needs instagram_business_manage_insights (already in
// OAUTH_SCOPES) and Instagram only reports it for accounts with 100+ followers.
async function getAudience(accountId = null) {
  const cacheKey = `audience:${accountId || 'active'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let auth = null;
  if (accountId) {
    const { rows } = await pool.query(
      'SELECT account_id, token FROM instagram_accounts WHERE account_id = $1 AND token IS NOT NULL', [accountId]);
    if (rows[0]) auth = { base: IG_API, token: rows[0].token, accountId: rows[0].account_id };
  }
  if (!auth) auth = await getActiveAuth();
  if (!auth) return { available: false, reason: 'Instagram is not connected' };

  const demo = async (breakdown, metric = 'follower_demographics') => {
    try {
      const d = await graphFetch(`/${auth.accountId}/insights`, {
        metric, period: 'lifetime', metric_type: 'total_value',
        breakdown, access_token: auth.token, locale: 'en_US',
      }, auth.base);
      const results = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      return results
        .map(r => ({ label: (r.dimension_values || []).join(' '), value: r.value || 0 }))
        .filter(r => r.label)
        .sort((a, b) => b.value - a.value);
    } catch (_) { return null; }   // <100 followers / missing scope → just omit
  };

  // online_followers: hourly histogram of followers active on IG, last 30 days.
  // Meta reports one histogram PER DAY in UTC; IST is +5:30, so each UTC hour's
  // count is split across the two IST hours it straddles. The buckets are
  // AVERAGED across the sampled days — summing inflated the numbers 30× (a 60K
  // account showed "8.4L online"), which was nonsense.
  const online = async () => {
    try {
      const until = Math.floor(Date.now() / 1000) - 86400;
      const since = until - 29 * 86400;
      const d = await graphFetch(`/${auth.accountId}/insights`, {
        metric: 'online_followers', period: 'lifetime', since, until,
        access_token: auth.token,
      }, auth.base);
      const days = d.data?.[0]?.values || [];
      if (!days.length) return null;
      const buckets = new Array(24).fill(0);
      for (const v of days) {
        for (const [h, n] of Object.entries(v.value || {})) {
          const hour = parseInt(h, 10);
          if (Number.isNaN(hour)) continue;
          buckets[(hour + 5) % 24] += (n || 0) / 2;
          buckets[(hour + 6) % 24] += (n || 0) / 2;
        }
      }
      const avg = buckets.map(b => Math.round(b / days.length));
      return Math.max(...avg) > 0 ? avg : null;
    } catch (_) { return null; }
  };

  const [age, gender, country, onlineFollowers, engAge, engGender, engCountry] = await Promise.all([
    demo('age'), demo('gender'), demo('country'), online(),
    // Engaged-audience demographics — who actually interacts with the content,
    // which can differ sharply from who follows. Same 24h cache, 3 extra calls/day.
    demo('age', 'engaged_audience_demographics'),
    demo('gender', 'engaged_audience_demographics'),
    demo('country', 'engaged_audience_demographics'),
  ]);
  const engaged = (engAge?.length || engGender?.length || engCountry?.length)
    ? { age: engAge, gender: engGender, country: engCountry }
    : null;
  const result = {
    available: !!(age?.length || gender?.length || country?.length || onlineFollowers || engaged),
    age, gender, country, onlineFollowers, engaged,
    timezone: 'Asia/Kolkata',
  };
  // Durability: the section must NEVER disappear because one fetch failed
  // (rate-limited boot, container restart, transient API error). Persist the
  // last good payload in the DB and serve it (up to 7 days) when a fresh fetch
  // comes back empty. Failures are memory-cached only briefly so the next view
  // retries soon.
  const storeKey = `audience_cache:instagram:${accountId || 'active'}`;
  if (result.available) {
    await setSetting(storeKey, JSON.stringify({ at: Date.now(), data: result })).catch(() => {});
    cacheSet(cacheKey, result, 24 * 3600 * 1000);
    return result;
  }
  try {
    const stored = JSON.parse(await getSetting(storeKey) || 'null');
    if (stored?.data?.available && Date.now() - stored.at < 7 * 24 * 3600 * 1000) {
      const fallback = { ...stored.data, stale: true };
      cacheSet(cacheKey, fallback, 10 * 60 * 1000);
      return fallback;
    }
  } catch (_) {}
  cacheSet(cacheKey, result, 10 * 60 * 1000);
  return result;
}

// ── Stats for platform page ──────────────────────────────────
// Instagram Graph API v20 uses TWO metric formats:
//   1. period=day + since/until   → time-series (reach, follower_count)
//   2. period=day + metric_type=total_value → aggregated scalar (views, interactions, etc.)
// account (optional): { accountId, token } → stats for THAT IG account instead of
// the active one (used for per-account Overview rollup).
// Media fetch with per-post `views` (the impressions replacement) in the inline
// insights expansion. Older API versions reject `views` as a media metric and
// fail the WHOLE call — so probe once, remember the answer, and fall back to
// the legacy expansion permanently if unsupported. Non-metric errors rethrow.
let _mediaViewsSupported = null;   // null = not probed yet
const _mediaFields = (withViews) =>
  'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,media_url,thumbnail_url,' +
  `insights.metric(${withViews ? 'views,' : ''}reach,saved,shares)`;
async function _fetchMediaPage(gf, accountId, accessToken, params = {}) {
  if (_mediaViewsSupported !== false) {
    try {
      const d = await gf(`/${accountId}/media`, { fields: _mediaFields(true), limit: '50', access_token: accessToken, ...params });
      _mediaViewsSupported = true;
      return d;
    } catch (e) {
      if (/metric|views|invalid|unsupported|param/i.test(e.message)) _mediaViewsSupported = false;
      else throw e;   // rate limit / auth errors must not flip the flag
    }
  }
  return gf(`/${accountId}/media`, { fields: _mediaFields(false), limit: '50', access_token: accessToken, ...params });
}

async function getStats(period = '30D', account = null) {
  const cacheKey = `stats:${period}:${account?.accountId || 'active'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const auth = account?.token
    ? { base: IG_API, token: account.token, accountId: account.accountId, via: 'oauth' }
    : await getActiveAuth();
  if (!auth) return null;
  const { base, token: accessToken, accountId } = auth;
  const gf = (path, params) => graphFetch(path, params, base);

  const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90, 'Custom': 45 };
  const days = PERIOD_DAYS[period] || 30;
  // Instagram caps follower_count insight at 30 days
  const insightDays = Math.min(days, 30);
  const now       = Math.floor(Date.now() / 1000);
  const since     = now - days * 86400;
  const iSince    = now - insightDays * 86400;  // insight window start
  const prevSince = iSince - insightDays * 86400;

  // ── 6 parallel API calls (cached 15 min → max ~24 calls/6hr ≪ 200/hr limit) ──
  const [profile, tsMetrics, aggMetrics, tsPrev, aggPrev, media] = await Promise.all([
    // 1. Profile — followers, media count
    gf(`/${accountId}`, {
      fields: 'followers_count,media_count,name,username',
      access_token: accessToken,
    }),
    // 2. Time-series: reach + follower_count (daily gains) for current period
    gf(`/${accountId}/insights`, {
      metric: 'reach,follower_count',
      period: 'day',
      since:  String(iSince),
      until:  String(now),
      access_token: accessToken,
    }).catch(() => ({ data: [] })),
    // 3. Aggregate (total_value): views, profile_views, total_interactions, likes, comments, saves, website_clicks
    gf(`/${accountId}/insights`, {
      metric:      'views,profile_views,total_interactions,likes,comments,saves,website_clicks',
      period:      'day',
      metric_type: 'total_value',
      since:       String(iSince),
      until:       String(now),
      access_token: accessToken,
    }).catch(() => ({ data: [] })),
    // 4. Previous period time-series: reach
    gf(`/${accountId}/insights`, {
      metric: 'reach',
      period: 'day',
      since:  String(prevSince),
      until:  String(iSince),
      access_token: accessToken,
    }).catch(() => ({ data: [] })),
    // 5. Previous period aggregate: views (for delta)
    gf(`/${accountId}/insights`, {
      metric:      'views',
      period:      'day',
      metric_type: 'total_value',
      since:       String(prevSince),
      until:       String(iSince),
      access_token: accessToken,
    }).catch(() => ({ data: [] })),
    // 6. Recent media for top posts (inline insights — views/reach/saves/shares;
    //    `views` probes once and falls back if this API version rejects it)
    _fetchMediaPage(gf, accountId, accessToken).catch(() => ({ data: [] })),
  ]);

  // 7. Best-effort extra account metrics (newer additions — one bad metric fails
  //    the whole call, so tier down rather than risk the core stats above).
  const tryAgg = (metric) => gf(`/${accountId}/insights`, {
    metric, period: 'day', metric_type: 'total_value',
    since: String(iSince), until: String(now), access_token: accessToken,
  }).catch(() => null);
  const extraAgg = await tryAgg('accounts_engaged,shares,follows_and_unfollows,profile_links_taps')
    || await tryAgg('accounts_engaged,shares')
    || { data: [] };

  // ── Helpers ────────────────────────────────────────────────
  // Time-series: sum all day values for a named metric
  const tsSum = (data, name) =>
    (data.data?.find(d => d.name === name)?.values || []).reduce((s, v) => s + (v.value || 0), 0);

  // Time-series: return raw values array for a named metric
  const tsVals = (data, name) =>
    data.data?.find(d => d.name === name)?.values || [];

  // Aggregate (total_value format): extract scalar for named metric
  const aggVal = (data, name) =>
    data.data?.find(d => d.name === name)?.total_value?.value || 0;

  const pctChange = (curr, prev) =>
    !prev ? 0 : parseFloat(((curr - prev) / prev * 100).toFixed(1));

  // ── Current period metrics ─────────────────────────────────
  const reach        = tsSum(tsMetrics, 'reach');
  const views        = aggVal(aggMetrics, 'views');         // replaces impressions
  const profileViews = aggVal(aggMetrics, 'profile_views');
  const totalInt     = aggVal(aggMetrics, 'total_interactions');
  const _totalLikes  = aggVal(aggMetrics, 'likes');
  const _totalComments= aggVal(aggMetrics, 'comments');
  const totalSaves   = aggVal(aggMetrics, 'saves');
  const totalWebsiteClicks = aggVal(aggMetrics, 'website_clicks');
  const engagementRate = reach > 0
    ? parseFloat(((totalInt / reach) * 100).toFixed(2))
    : 0;

  // ── Previous period metrics for deltas ─────────────────────
  const prevReach = tsSum(tsPrev, 'reach');
  const prevViews = aggVal(aggPrev, 'views');

  // ── Follower trend (daily gains → cumulative absolute counts) ──
  const gainValues = tsVals(tsMetrics, 'follower_count');
  const totalGrowth = gainValues.reduce((s, v) => s + (v.value || 0), 0);
  const baseCount   = Math.max(0, profile.followers_count - totalGrowth);
  let running = baseCount;
  const trendData = gainValues.map(v => { running += (v.value || 0); return running; });
  const trendDays = gainValues.map(v =>
    new Date(v.end_time).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
  );
  // Same series, but carrying the API's own end_time date per point. The trend
  // chart uses this to place estimated points on the right calendar day instead
  // of guessing by array position. NOTE for anyone reading these numbers: IG's
  // `follower_count` counts NEW follows and never subtracts unfollows, so this
  // reconstruction can only rise and its baseline drifts low over the window —
  // it is an ESTIMATE, and follower_samples is the source of truth.
  const trendSeries = gainValues.map((v, i) => ({
    date: new Date(v.end_time).toISOString().slice(0, 10),
    value: trendData[i],
  }));
  const growthPct = baseCount > 0 ? (totalGrowth / baseCount) * 100 : 0;

  // ── Posts in period ────────────────────────────────────────
  const allMedia      = media.data || [];
  const postsInPeriod = allMedia.filter(m => new Date(m.timestamp).getTime() / 1000 >= since);

  const mapPost = (m) => {
    const eng   = (m.like_count || 0) + (m.comments_count || 0);
    const avgEng = postsInPeriod.length ? totalInt / postsInPeriod.length : 1;
    const score  = Math.min(99, Math.max(40, Math.round((eng / Math.max(avgEng, 1)) * 75)));
    const caption = m.caption || '';
    // Extract impressions/reach/saves/shares from inline insights
    const insightMetrics = m.insights?.data || [];
    const postViews   = insightMetrics.find(d => d.name === 'views')?.values?.[0]?.value || 0;
    const impressions = insightMetrics.find(d => d.name === 'impressions')?.values?.[0]?.value || 0;
    const reach       = insightMetrics.find(d => d.name === 'reach')?.values?.[0]?.value || 0;
    const saves       = insightMetrics.find(d => d.name === 'saved')?.values?.[0]?.value || 0;
    const shares      = insightMetrics.find(d => d.name === 'shares')?.values?.[0]?.value || 0;
    const safeTruncate = (str, max) => {
      if (!str || str.length <= max) return str;
      return Array.from(str).slice(0, max).join('') + '…';
    };
    return {
      id:       m.id,
      title:    safeTruncate(caption, 77) || normalizeMediaType(m),
      caption,  // full caption (stored on posts.caption for the comment-detail preview)
      date:     new Date(m.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views:    postViews || impressions || reach, // real per-post views when the API supports it; reach is the last-resort proxy
      eng,
      clicks:   saves,               // use per-post saves as the post-level click proxy
      saves,                          // per-post saves (unique per post)
      shares,                         // per-post shares (unique per post)
      score,
      likes:    m.like_count     || 0,
      comments: m.comments_count || 0,
      permalink: m.permalink,
      thumbnail: m.thumbnail_url || m.media_url || null,
      type:     normalizeMediaType(m),
      media_type: m.media_type,
      timestamp: m.timestamp,
    };
  };

  const allPosts = postsInPeriod.map(mapPost);
  const topPosts = [...allPosts].sort((a, b) => b.eng - a.eng).slice(0, 4);

  const result = {
    key: 'instagram',
    platform: { name: 'Instagram', short: 'IG', color: '#C13584', bg: '#FBE8F2', textOnBg: '#7A1F52' },
    followers:        profile.followers_count,
    growth:           totalGrowth,
    growthPct:        parseFloat(growthPct.toFixed(1)),
    impressions:      views,        // mapped to "views" metric for UI compatibility
    reach,
    engagementRate,
    clicks:           totalWebsiteClicks,
    posts:            postsInPeriod.length,
    scaledGrowth:     totalGrowth,
    impressionsDelta: pctChange(views, prevViews),
    reachDelta:       pctChange(reach, prevReach),
    engagementDelta:  0,
    clicksDelta:      null,
    postsDelta:       0,
    extras: [
      { label: 'Reach',          value: reach,              info: 'Unique Instagram accounts that saw your content.' },
      { label: 'Profile Visits', value: profileViews,       info: 'Users who visited your Instagram profile during this period.' },
      { label: 'Website Clicks', value: totalWebsiteClicks, info: 'Clicks on the website link in your Instagram bio.' },
      { label: 'Saves',          value: totalSaves,         info: 'Number of times your posts were saved.' },
      // Newer metrics — present only when this API version/account supports them.
      ...(extraAgg.data?.some(d => d.name === 'accounts_engaged')
        ? [{ label: 'Accounts Engaged', value: aggVal(extraAgg, 'accounts_engaged'), info: 'Unique accounts that interacted with your content (liked, commented, saved, or shared).' }] : []),
      ...(extraAgg.data?.some(d => d.name === 'shares')
        ? [{ label: 'Content Shares', value: aggVal(extraAgg, 'shares'), info: 'Number of times your posts, reels, or stories were shared.' }] : []),
      ...(extraAgg.data?.some(d => d.name === 'profile_links_taps')
        ? [{ label: 'Profile Link Taps', value: aggVal(extraAgg, 'profile_links_taps'), info: 'Taps on the link, call, email, or address buttons on your profile.' }] : []),
      ...(extraAgg.data?.some(d => d.name === 'follows_and_unfollows')
        ? [{ label: 'Follows & Unfollows', value: aggVal(extraAgg, 'follows_and_unfollows'), info: 'Total follow and unfollow actions on your account in this period (combined count as reported by Instagram).' }] : []),
    ],
    topPosts,
    allPosts,
    trend:    trendData.length ? trendData : [profile.followers_count],
    trendDays: trendDays.length ? trendDays : ['Now'],
    trendSeries,
    isThreads: false,
    isReal:    true,
  };
  cacheSet(cacheKey, result, CACHE_TTL.stats);
  return result;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL media (not just recent period) for the Content Library.
async function getAllPosts(arg = null) {
  // arg = { accountId, token } (from accountsForSync) → backfill a SPECIFIC account.
  // Omitted → the active OAuth/legacy account (regular sync path).
  const auth = arg && arg.token
    ? { base: IG_API, token: arg.token, accountId: arg.accountId }
    : await getActiveAuth();
  if (!auth) return [];
  const { base, token: accessToken, accountId } = auth;

  // Fetch account-level website_clicks for the last 30 days (no per-post data available)
  // Instagram API caps since/until range at 30 days for insights
  let _totalWebsiteClicks = 0;
  try {
    const now30 = Math.floor(Date.now() / 1000);
    const since30 = now30 - 30 * 86400;
    const wcUrl = new URL(`${base}/${accountId}/insights`);
    wcUrl.searchParams.set('metric', 'website_clicks');
    wcUrl.searchParams.set('period', 'day');
    wcUrl.searchParams.set('metric_type', 'total_value');
    wcUrl.searchParams.set('since', String(since30));
    wcUrl.searchParams.set('until', String(now30));
    wcUrl.searchParams.set('access_token', accessToken);
    const wcRes = await fetch(wcUrl.toString());
    const wcData = await wcRes.json();
    _totalWebsiteClicks = wcData.data?.find(d => d.name === 'website_clicks')?.total_value?.value || 0;
  } catch (e) {
    console.error('Instagram website_clicks fetch error:', e.message);
  }

  const allMedia = [];
  // Same views-aware field set as getStats; honours the probe result so an API
  // version without per-post `views` keeps the legacy expansion.
  let url = `${base}/${accountId}/media?fields=${encodeURIComponent(_mediaFields(_mediaViewsSupported !== false))}&limit=50&access_token=${accessToken}`;

  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      // First page may be probing `views` — if THAT's what failed, fall back to
      // the legacy field set and retry instead of aborting the whole backfill.
      const msg = data.error.message || '';
      if (_mediaViewsSupported === null && /metric|views|invalid|unsupported|param/i.test(msg)) {
        _mediaViewsSupported = false;
        url = `${base}/${accountId}/media?fields=${encodeURIComponent(_mediaFields(false))}&limit=50&access_token=${accessToken}`;
        continue;
      }
      console.error('Instagram getAllPosts error:', data.error);
      break;
    }
    if (_mediaViewsSupported === null) _mediaViewsSupported = true;
    allMedia.push(...(data.data || []));
    url = data.paging?.next || null;
  }

  return allMedia.map(m => {
    const eng = (m.like_count || 0) + (m.comments_count || 0);
    const caption = m.caption || '';
    const insightMetrics = m.insights?.data || [];
    const postViews   = insightMetrics.find(d => d.name === 'views')?.values?.[0]?.value || 0;
    const impressions = insightMetrics.find(d => d.name === 'impressions')?.values?.[0]?.value || 0;
    const reach       = insightMetrics.find(d => d.name === 'reach')?.values?.[0]?.value || 0;
    const saves       = insightMetrics.find(d => d.name === 'saved')?.values?.[0]?.value || 0;
    const shares      = insightMetrics.find(d => d.name === 'shares')?.values?.[0]?.value || 0;
    const safeTruncate = (str, max) => {
      if (!str || str.length <= max) return str;
      return Array.from(str).slice(0, max).join('') + '…';
    };
    return {
      id: m.id,
      title: safeTruncate(caption, 77) || normalizeMediaType(m),
      caption,  // full caption (stored on posts.caption for the comment-detail preview)
      date: new Date(m.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views: postViews || impressions || reach,
      eng,
      clicks: saves,             // use per-post saves as the post-level click proxy
      saves,                      // per-post saves (unique per post)
      shares,                     // per-post shares (unique per post)
      score: 50,
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
      permalink: m.permalink,
      thumbnail: m.thumbnail_url || m.media_url || null,
      type: normalizeMediaType(m),
      media_type: m.media_type,
      timestamp: m.timestamp,
    };
  });
}

// ============================================================
// Webhook ingestion — DMs (messaging) + comments (changes)
// ============================================================
// No outbound Graph API calls here, so the 200 calls/hour budget is
// untouched. Meta delivers events; we verify, audit, and persist.

// Accepted signing secrets — supports multi-app cutover with zero downtime.
// INSTAGRAM_APP_SECRET may be a comma-separated list; the Instagram-Login app
// secret is always included too (instagram-object webhooks may sign with it).
function candidateSecrets() {
  const list = [];
  (socialEnv.INSTAGRAM_APP_SECRET || '').split(',').map(s => s.trim()).filter(Boolean).forEach(s => list.push(s));
  const ig = (socialEnv.INSTAGRAM_OAUTH_CLIENT_SECRET || '').trim();
  if (ig) list.push(ig);
  // The Meta app secret signs Page-object deliveries.
  const fb = (socialEnv.FACEBOOK_APP_SECRET || '').trim();
  if (fb) list.push(fb);
  // ForgeSocial app secret saved from the "Receive Instagram DMs" settings card
  try { const s = require('./services/metaPageLink').appSecretForWebhook(); if (s) list.push(s); } catch (_) {}
  return [...new Set(list)];
}

// ── X-Hub-Signature-256 verification (required mode) ─────────
// Meta signs the *raw* request body with the App Secret (HMAC-SHA256).
// Tries every accepted secret; logs which matched so we can prune after cutover.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secrets = candidateSecrets();
  if (secrets.length === 0) return { ok: false, reason: 'No app secret configured' };
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'Missing or malformed X-Hub-Signature-256 header' };
  }
  const sigBuf = Buffer.from(signatureHeader);
  for (let i = 0; i < secrets.length; i++) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secrets[i]).update(rawBody || Buffer.alloc(0)).digest('hex');
    const expBuf = Buffer.from(expected);
    if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
      if (i > 0) console.log(`[ig-webhook] signature matched secret candidate #${i} (…${secrets[i].slice(-4)})`);
      return { ok: true, reason: null };
    }
  }
  return { ok: false, reason: 'Signature mismatch' };
}

// ── Audit log: record every delivery (verified or rejected) ──
async function logWebhookEvent(payload, { remoteIp = null, signatureOk = null } = {}) {
  const objectType = payload?.object || null;
  const fields = new Set();
  for (const entry of (payload?.entry || [])) {
    if (Array.isArray(entry.messaging) && entry.messaging.length) fields.add('messages');
    for (const ch of (entry.changes || [])) if (ch.field) fields.add(ch.field);
  }
  const { rows } = await pool.query(
    `INSERT INTO instagram_webhook_events (object_type, fields, remote_ip, signature_ok, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [objectType, Array.from(fields).join(',') || null, remoteIp, signatureOk,
     JSON.stringify(payload || {})]
  );
  return rows[0].id;
}

// ── Localize DM media attachments (image/video/audio) ───────
// Their payload.url is a signed IG CDN link that EXPIRES. Download once into
// /api/uploads (deterministic name keyed on mid+index) and rewrite the URL so
// the chat keeps rendering forever. Not a Graph API call → 200/hr budget untouched.
// Shares/reels/templates are skipped (they carry permalinks/external links).
const ATTACH_MEDIA_TYPES = new Set(['image', 'video', 'audio']);
const ATTACH_EXT = { image: 'jpg', video: 'mp4', audio: 'm4a' };

async function _downloadAttachment(mid, idx, type, url) {
  try {
    const hash = crypto.createHash('sha1').update(`${mid}:${idx}`).digest('hex').slice(0, 16);
    const fname = `dm-${type}-${hash}.${ATTACH_EXT[type] || 'bin'}`;
    const fpath = path.join(UPLOADS_DIR, fname);
    const localUrl = `/api/social/uploads/${fname}`;
    if (fs.existsSync(fpath)) return localUrl;          // already downloaded → reuse
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    await fs.promises.writeFile(fpath, buf);
    return localUrl;
  } catch { return null; }
}

// Returns a rewritten attachments array (local URLs) or null if nothing changed.
async function localizeAttachments(mid, attachments) {
  if (!mid || !Array.isArray(attachments) || !attachments.length) return null;
  let changed = false;
  const out = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const url = att?.payload?.url;
    if (att && ATTACH_MEDIA_TYPES.has(att.type) && url && !String(url).startsWith('/api/social/uploads/')) {
      const local = await _downloadAttachment(mid, i, att.type, url);
      if (local) { out.push({ ...att, payload: { ...att.payload, url: local } }); changed = true; continue; }
    }
    out.push(att);
  }
  return changed ? out : null;
}

// ── Parse + persist DMs and comments from a webhook payload ──
async function handleWebhook(payload, meta = {}) {
  await logWebhookEvent(payload, { ...meta, signatureOk: true }).catch(() => {});

  const result = { messages: 0, comments: 0, other: 0 };
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const accountId = entry.id || null;          // the business account that owns this event
    const entryTs = entry.time ? new Date(Number(entry.time) * 1000) : null;

    // Auto-register the account so the Inbox can group/filter by it
    if (accountId) {
      await pool.query(
        `INSERT INTO instagram_accounts (account_id, last_event)
         VALUES ($1, now())
         ON CONFLICT (account_id) DO UPDATE SET last_event = now()`,
        [accountId]
      ).catch(() => {});
    }

    // 1. Direct messages — Messenger-Platform format under entry.messaging[]
    for (const ev of (entry.messaging || [])) {
      // Read receipt — the peer (ev.sender) has seen our outgoing messages.
      // Watermark by the event timestamp: everything we sent them up to then is seen.
      if (ev.read) {
        const peerId = ev.sender?.id || null;
        const watermark = ev.timestamp ? new Date(Number(ev.timestamp)) : (entryTs || new Date());
        if (peerId && accountId) {
          await pool.query(
            `UPDATE instagram_messages
                SET seen = true, seen_at = COALESCE(seen_at, $3)
              WHERE account_id = $1 AND recipient_id = $2
                AND direction = 'outgoing' AND seen = false AND ts <= $3`,
            [accountId, peerId, watermark]
          ).catch(() => {});
        }
        result.reads = (result.reads || 0) + 1;
        continue;
      }
      // Template button taps → ManyChat-style automations (services/commentAutomation.js)
      if (ev.postback) {
        try { require('./services/commentAutomation').onInstagramMessaging({ accountId, ev }).catch(e => console.error('[automation]', e.message)); } catch (_) {}
      }
      if (!ev.message) continue;  // skip delivery/postback-only events
      const isEcho = !!ev.message.is_echo;
      const ts = ev.timestamp ? new Date(Number(ev.timestamp)) : (entryTs || new Date());
      const dmIns = await pool.query(
        `INSERT INTO instagram_messages
           (mid, account_id, sender_id, recipient_id, direction, text, attachments, raw, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (mid) DO NOTHING`,
        [
          ev.message.mid || null,
          accountId,
          ev.sender?.id || null,
          ev.recipient?.id || null,
          isEcho ? 'outgoing' : 'incoming',
          ev.message.text || null,
          ev.message.attachments ? JSON.stringify(ev.message.attachments) : null,
          JSON.stringify(ev),
          ts,
        ]
      );
      // Notify on a genuinely new INCOMING DM (skip our own echoes + dupes).
      if (!isEcho && dmIns.rowCount > 0) {
        notify.emit('dm', {
          title: 'New Instagram DM',
          body: ev.message.text ? truncate(ev.message.text, 80) : 'Sent an attachment',
          link: '#/social/inbox', severity: 'info', platform: 'instagram', accountKey: accountId,
          dedupeKey: `dm:${ev.message.mid}`,
          meta: { kind: 'dm', platform: 'instagram', accountId, peerId: ev.sender?.id || null },
        });
        // Notify ForgeCommand about the new DM (fire-and-forget).
        forgeCommandNotify('new_dm', {
          platform: 'instagram',
          from: ev.sender?.id || null,
          text: ev.message.text || null,
        });
      }
      // Resolve the sender's name/username/profile_pic in the background (incoming
      // only). force=true: the inbound message means the 24h window is open NOW —
      // the only moment the profile_pic is fetchable.
      if (!isEcho && ev.sender?.id) resolveUserProfile(ev.sender.id, accountId, { force: true }).catch(() => {});
      // AI agent auto-reply: hand a genuinely new incoming DM to the dispatcher
      // (fire-and-forget; it no-ops unless an active DM agent serves this account).
      // Lazy require avoids a module cycle (agentDispatch → instagram).
      if (!isEcho && dmIns.rowCount > 0 && ev.sender?.id) {
        try { require('./services/agentDispatch').onInstagramDm({ accountId, peerId: ev.sender.id, text: ev.message.text || '', attachments: ev.message.attachments || null }); }
        catch (e) { console.error('[instagram] agent dispatch failed:', e.message); }
      }
      // Keyword DM / quick-reply automations (services/commentAutomation.js)
      if (!isEcho && dmIns.rowCount > 0) {
        try { require('./services/commentAutomation').onInstagramMessaging({ accountId, ev }).catch(e => console.error('[automation]', e.message)); } catch (_) {}
      }
      // Upsert the contact (auto-CRM). Peer is the OTHER side: sender if incoming,
      // recipient if outgoing. Best-effort — never blocks ingest.
      const peerId = isEcho ? ev.recipient?.id : ev.sender?.id;
      if (peerId) upsertContact({
        accountId, peerId,
        direction: isEcho ? 'outgoing' : 'incoming',
        text: ev.message.text || null, ts,
      }).catch(() => {});
      // Localize media attachments so they outlive the expiring CDN URL (non-blocking)
      if (ev.message.mid && Array.isArray(ev.message.attachments)) {
        localizeAttachments(ev.message.mid, ev.message.attachments)
          .then(localized => localized && pool.query(
            'UPDATE instagram_messages SET attachments = $1 WHERE mid = $2',
            [JSON.stringify(localized), ev.message.mid]))
          .catch(() => {});
      }
      result.messages++;
    }

    // 2. Comments — entry.changes[] where field === 'comments'
    for (const ch of (entry.changes || [])) {
      if (ch.field !== 'comments') { result.other++; continue; }
      const v = ch.value || {};
      const ts = v.created_time ? new Date(Number(v.created_time) * 1000)
               : (entryTs || new Date());
      const cmtIns = await pool.query(
        `INSERT INTO instagram_comments
           (comment_id, account_id, media_id, parent_id, from_id, from_username, text, raw, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (comment_id) DO NOTHING`,
        [
          v.id || null,
          accountId,
          v.media?.id || null,
          v.parent_id || null,
          v.from?.id || null,
          v.from?.username || null,
          v.text || null,
          JSON.stringify(v),
          ts,
        ]
      );
      // Notify on a genuinely new comment (skip dupes; from_username is the commenter).
      if (cmtIns.rowCount > 0) {
        notify.emit('comment', {
          title: 'New Instagram comment',
          body: `${v.from?.username ? '@' + v.from.username + ': ' : ''}${truncate(v.text || '', 80)}`,
          link: '#/social/inbox', severity: 'info', platform: 'instagram', accountKey: accountId,
          dedupeKey: `comment:${v.id}`,
          meta: { kind: 'comment', platform: 'instagram', accountId, mediaId: v.media?.id || null },
        });
        // Notify ForgeCommand about the new comment (fire-and-forget).
        forgeCommandNotify('new_comment', {
          post_id: v.media?.id || null,
          platform: 'instagram',
          from: v.from?.username || null,
          text: v.text || null,
        });
        // Trigger agent comment sweep immediately for top-level comments
        // (replies have a parent_id so agents ignore them). Same lazy-require
        // pattern as DMs to avoid a module cycle.
        if (!v.parent_id) {
          try { require('./services/agentDispatch').sweepComments(); } catch (_) {}
        }
        // Comment → public reply + private-reply DM automations (services/commentAutomation.js)
        try { require('./services/commentAutomation').onInstagramComment({ accountId, comment: v }).catch(e => console.error('[automation]', e.message)); } catch (_) {}
        // Negative-comment Telegram alerts: classify this comment within seconds, not at the next 10-min run.
        try { require('./services/commentAlerts').onNewComment(); } catch (_) {}
      }
      result.comments++;
    }
  }
  return result;
}

// ── Account registry helpers (for the Inbox account filter) ──
// Cheap follower-count sampler — ONE Graph call per OAuth-connected account
// (`GET /{id}?fields=followers_count`), versus getStats's 6 calls. Called by the
// periodic follower-sample cron so the hourly trend stays gap-free without
// burning the 200-calls/hour budget. Returns [{ accountId, followers }].
async function sampleFollowers() {
  const { rows } = await pool.query(
    `SELECT account_id, token FROM instagram_accounts
      WHERE token IS NOT NULL AND NOT COALESCE(hidden, false)`);
  const out = [];
  for (const a of rows) {
    try {
      const url = new URL(`${IG_API}/${a.account_id}`);
      url.searchParams.set('fields', 'followers_count');
      url.searchParams.set('access_token', a.token);
      const data = await (await fetch(url)).json();
      if (!data.error && typeof data.followers_count === 'number') {
        out.push({ accountId: a.account_id, followers: data.followers_count });
      } else if (data.error) {
        console.error('sampleFollowers API error for', a.account_id, data.error.message);
      }
    } catch (e) {
      console.error('sampleFollowers fetch failed for', a.account_id, e.message);
    }
  }
  return out;
}

async function listAccounts() {
  // Exclude accounts the user hid, and webhook noise rows that never carried an
  // identity (e.g. entry.id "0" with no name/username) — both auto-registered.
  const { rows } = await pool.query(
    `SELECT account_id AS "accountId", name, username, page_id AS "pageId",
            (token IS NOT NULL) AS "canPublish",
            first_seen AS "firstSeen", last_event AS "lastEvent"
       FROM instagram_accounts
      WHERE NOT COALESCE(hidden, false)
        AND NOT (name IS NULL AND username IS NULL)
      ORDER BY last_event DESC NULLS LAST, account_id`
  );
  return rows;
}

async function upsertAccount({ accountId, name, username, pageId }) {
  await pool.query(
    `INSERT INTO instagram_accounts (account_id, name, username, page_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id) DO UPDATE SET
       name     = COALESCE(EXCLUDED.name, instagram_accounts.name),
       username = COALESCE(EXCLUDED.username, instagram_accounts.username),
       page_id  = COALESCE(EXCLUDED.page_id, instagram_accounts.page_id)`,
    [accountId, name || null, username || null, pageId || null]
  );
}

// ── Subscribe Facebook Pages to this app's webhook ──
// Per-page subscription covers Instagram DMs (the `messages` field). Instagram
// COMMENTS are delivered via the app-level Instagram-object webhook (configured
// once in the App Dashboard), not per-page — so we only send `messages` here.
// Uses the stored USER token to derive each Page token, subscribes the page,
// and registers the linked IG account so the Inbox can label it by name.
async function subscribePages(pageIds, fields = 'messages') {
  const userToken = await getSetting('instagram_access_token');
  if (!userToken) throw new Error('No stored access token in app_settings');

  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username}');
  url.searchParams.set('limit', '200');
  url.searchParams.set('access_token', userToken);
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const pages = data.data || [];

  const results = [];
  for (const pid of pageIds.map(String)) {
    const page = pages.find(p => p.id === pid);
    if (!page) { results.push({ pageId: pid, ok: false, error: 'Page not visible to this token' }); continue; }
    if (!page.access_token) { results.push({ pageId: pid, name: page.name, ok: false, error: 'No Page token (missing pages_show_list / pages_manage_metadata)' }); continue; }

    const subUrl = new URL(`${GRAPH_BASE}/${pid}/subscribed_apps`);
    subUrl.searchParams.set('subscribed_fields', fields);
    subUrl.searchParams.set('access_token', page.access_token);
    let subData;
    try {
      const subRes = await fetch(subUrl, { method: 'POST' });
      subData = await subRes.json();
    } catch (e) { subData = { error: { message: e.message } }; }

    const iga = page.instagram_business_account;
    if (iga?.id) {
      await upsertAccount({ accountId: iga.id, name: page.name, username: iga.username, pageId: page.id });
    }
    results.push({
      pageId: pid, name: page.name,
      igAccountId: iga?.id || null, igUsername: iga?.username || null,
      ok: subData?.success === true,
      response: subData,
    });
  }
  return results;
}

// ── Meta signed_request (data-deletion / deauthorize callbacks) ──
// Format: "<base64url(HMAC-SHA256 sig)>.<base64url(JSON payload)>"
function parseSignedRequest(signedRequest) {
  if (!signedRequest || !signedRequest.includes('.')) return null;
  const [encSig, encPayload] = signedRequest.split('.');
  const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = b64url(encSig);
  for (const secret of candidateSecrets()) {
    const expected = crypto.createHmac('sha256', secret).update(encPayload).digest();
    if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) {
      try { return JSON.parse(b64url(encPayload).toString('utf8')); } catch { return null; }
    }
  }
  return null;
}

// Delete all stored message/comment data for a given IG user id; record the request
async function handleDataDeletion(userId) {
  const code = crypto.randomBytes(12).toString('hex');
  if (userId) {
    await pool.query('DELETE FROM instagram_messages WHERE sender_id = $1 OR recipient_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM instagram_comments WHERE from_id = $1', [userId]).catch(() => {});
    await require('./services/commentAutomation').deleteUserData(userId).catch(() => {});
  }
  await pool.query(
    `INSERT INTO instagram_deletion_requests (code, user_id, status) VALUES ($1, $2, 'completed')`,
    [code, userId || null]
  ).catch(() => {});
  return code;
}

// ── Outbound: reply to a DM (Instagram messaging via the connected Page) ──
const pageTokenCache = new Map();
async function getPageToken(pageId) {
  const hit = pageTokenCache.get(pageId);
  if (hit && Date.now() < hit.exp) return hit.token;
  const userToken = await getSetting('instagram_access_token');
  if (!userToken) throw new Error('No stored access token');
  const url = new URL(`${GRAPH_BASE}/me/accounts`);
  url.searchParams.set('fields', 'id,access_token');
  url.searchParams.set('limit', '200');
  url.searchParams.set('access_token', userToken);
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const page = (data.data || []).find(p => p.id === String(pageId));
  if (!page?.access_token) throw new Error('No Page token available for page ' + pageId);
  pageTokenCache.set(pageId, { token: page.access_token, exp: Date.now() + 30 * 60 * 1000 });
  return page.access_token;
}

async function sendDirectMessage({ accountId, recipientId, text }) {
  if (!recipientId || !text || !text.trim()) throw new Error('recipientId and text are required');
  const auth = await getAccountAuth(accountId);
  // Instagram-Login sends via /me/messages; Page (FB-login) sends via /{page-id}/messages
  const path = auth.ig ? `${IG_API}/me/messages` : `${GRAPH_BASE}/${(await pool.query('SELECT page_id FROM instagram_accounts WHERE account_id=$1', [accountId])).rows[0]?.page_id}/messages`;
  const url = new URL(path);
  url.searchParams.set('access_token', auth.token);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: text.trim() },
      ...(auth.ig ? {} : { messaging_type: 'RESPONSE' }),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const mid = data.message_id || null;
  await pool.query(
    `INSERT INTO instagram_messages (mid, account_id, sender_id, recipient_id, direction, text, raw, ts)
     VALUES ($1, $2, $3, $4, 'outgoing', $5, $6, now())
     ON CONFLICT (mid) DO NOTHING`,
    [mid, accountId, accountId, recipientId, text.trim(), JSON.stringify(data)]
  ).catch(() => {});
  // Mirror the webhook's contact upsert so a freshly-replied-to peer becomes a
  // contact even if the echo webhook hasn't landed yet.
  upsertContact({ accountId, peerId: recipientId, direction: 'outgoing', text: text.trim(), ts: new Date() }).catch(() => {});
  return { ok: true, messageId: mid };
}

// ── Instagram Login OAuth (the consent flow App Review requires) ──────
function getOAuthUrl() {
  const clientId = socialEnv.INSTAGRAM_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error('INSTAGRAM_OAUTH_CLIENT_ID not configured');
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', OAUTH_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', OAUTH_SCOPES);
  return u.toString();
}

async function exchangeOAuthCode(code) {
  const clientId = socialEnv.INSTAGRAM_OAUTH_CLIENT_ID;
  const clientSecret = socialEnv.INSTAGRAM_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Instagram OAuth client credentials not configured');

  // 1. code → short-lived token
  const form = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
    redirect_uri: OAUTH_REDIRECT, code: String(code).replace(/#_$/, ''),
  });
  const shortData = await (await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  })).json();
  if (!shortData.access_token) throw new Error(shortData.error_message || 'Token exchange failed');

  // 2. short-lived → long-lived (60 days). No fallback to the 1-hour token: saving
  // it made the connect look successful, then the account died an hour later.
  const llUrl = new URL('https://graph.instagram.com/access_token');
  llUrl.searchParams.set('grant_type', 'ig_exchange_token');
  llUrl.searchParams.set('client_secret', clientSecret);
  llUrl.searchParams.set('access_token', shortData.access_token);
  const llData = await (await fetch(llUrl)).json();
  if (!llData.access_token) {
    console.error('[ig-oauth] long-lived exchange failed:', JSON.stringify(llData.error || llData));
    throw new Error(`Instagram would not issue a 60-day token: ${llData.error?.message || 'unknown error'}. ` +
      'On a Standard-access app the account must be an accepted Instagram Tester.');
  }
  const token = llData.access_token;
  const expiresIn = Number(llData.expires_in || 5184000);

  // 3. who connected. No fallback to shortData.user_id: that is the app-scoped id,
  // not the account's 1784… id, so it created a blank duplicate row.
  const meUrl = new URL(`${IG_API}/me`);
  meUrl.searchParams.set('fields', 'user_id,username,name');
  meUrl.searchParams.set('access_token', token);
  const me = await (await fetch(meUrl)).json();
  if (!me.user_id) {
    console.error('[ig-oauth] /me failed:', JSON.stringify(me.error || me));
    throw new Error(`Instagram did not say which account connected: ${me.error?.message || 'unknown error'}`);
  }
  const accountId = String(me.user_id);

  // 4. store account + token
  await pool.query(
    `INSERT INTO instagram_accounts (account_id, name, username, token, token_expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     ON CONFLICT (account_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, instagram_accounts.name),
       username = COALESCE(EXCLUDED.username, instagram_accounts.username),
       token = EXCLUDED.token, token_expires_at = EXCLUDED.token_expires_at,
       hidden = false,
       needs_reconnect = false, last_refresh_error = NULL`,   /* explicitly (re)authorizing an account un-hides it + clears token-health flags */
    [accountId, me.name || null, me.username || null, token, String(expiresIn)]);

  // 5. subscribe this account to the webhook (messages + comments + read receipts)
  try {
    const subUrl = new URL(`${IG_API}/me/subscribed_apps`);
    subUrl.searchParams.set('subscribed_fields', 'messages,comments,messaging_seen');
    subUrl.searchParams.set('access_token', token);
    await fetch(subUrl, { method: 'POST' });
  } catch { /* non-fatal */ }

  cacheInvalidate('status');  // so the Integrations card flips to Connected immediately
  return { accountId, username: me.username };
}

// Disconnect an account: unsubscribe its webhook, drop its stored token.
// Keeps the row (and its past messages/comments) for history; just removes auth.
async function disconnectAccount(accountId) {
  const row = accountId
    ? (await pool.query('SELECT account_id, token FROM instagram_accounts WHERE account_id = $1', [accountId])).rows[0]
    : (await pool.query("SELECT account_id, token FROM instagram_accounts WHERE token IS NOT NULL ORDER BY token_expires_at DESC NULLS LAST LIMIT 1")).rows[0];
  if (!row) throw new Error('No connected account to disconnect');
  if (row.token) {
    try {
      const u = new URL(`${IG_API}/me/subscribed_apps`);
      u.searchParams.set('access_token', row.token);
      await fetch(u, { method: 'DELETE' });   // best-effort unsubscribe
    } catch { /* ignore */ }
  }
  await pool.query(
    'UPDATE instagram_accounts SET token = NULL, token_expires_at = NULL WHERE account_id = $1',
    [row.account_id]);
  cacheInvalidate('status');
  return { ok: true, accountId: row.account_id };
}

// Pick the right API base + token for an account: Instagram-Login token if it has
// one (graph.instagram.com), else the connected Page token (graph.facebook.com).
async function getAccountAuth(accountId) {
  const { rows } = await pool.query(
    'SELECT token, page_id FROM instagram_accounts WHERE account_id = $1', [accountId]);
  const a = rows[0] || {};
  if (a.token) return { base: IG_API, token: a.token, ig: true };
  if (a.page_id) return { base: GRAPH_BASE, token: await getPageToken(a.page_id), ig: false };
  throw new Error('No auth available for account ' + accountId);
}

// Reply to an Instagram comment (POST /{comment-id}/replies). Needs the
// instagram_manage_comments scope (held by both the OAuth IG token and the Page
// token). Persists the reply so it shows in the Inbox without waiting on a webhook.
async function replyToComment({ commentId, accountId, message }) {
  if (!commentId)       throw new Error('commentId is required');
  if (!message?.trim()) throw new Error('Reply text is required');

  // Resolve the owning account from the stored comment if not supplied.
  let acctId = accountId;
  let mediaId = null;
  try {
    const { rows } = await pool.query('SELECT account_id, media_id FROM instagram_comments WHERE comment_id = $1', [commentId]);
    acctId = acctId || rows[0]?.account_id;
    mediaId = rows[0]?.media_id || null;
  } catch (_) {}

  const auth = acctId ? await getAccountAuth(acctId).catch(() => null) : await getActiveAuth();
  if (!auth?.token) throw new Error('Instagram is not connected');

  const res = await fetch(`${auth.base}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message.trim(), access_token: auth.token }),
  });
  const json = await res.json();
  if (json.error) {
    const m = json.error.message || 'Reply failed';
    if (/permission|manage_comments|scope/i.test(m))
      throw new Error('Replying needs the instagram_manage_comments permission.');
    throw new Error(m);
  }

  // Persist our reply (parent_id = the comment we replied to) so it appears at once.
  try {
    let username = null;
    if (acctId) {
      const a = await pool.query('SELECT username FROM instagram_accounts WHERE account_id = $1', [acctId]);
      username = a.rows[0]?.username || null;
    }
    await pool.query(
      `INSERT INTO instagram_comments (comment_id, account_id, media_id, parent_id, from_username, text, ts)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (comment_id) DO NOTHING`,
      [json.id, acctId || null, mediaId, commentId, username, message.trim()]
    );
  } catch (_) {}

  return { id: json.id };
}

// Delete an Instagram comment (DELETE /{comment-id}). Needs instagram_manage_comments.
// IG lets the media owner delete ANY comment on their media (own or others'), so
// this is a true delete (no "hide" fallback like YouTube). Mirrors the removal locally.
async function deleteComment(commentId, accountId) {
  if (!commentId) throw new Error('commentId is required');

  let acctId = accountId;
  if (!acctId) {
    try {
      const { rows } = await pool.query('SELECT account_id FROM instagram_comments WHERE comment_id = $1', [commentId]);
      acctId = rows[0]?.account_id;
    } catch (_) {}
  }

  const auth = acctId ? await getAccountAuth(acctId).catch(() => null) : await getActiveAuth();
  if (!auth?.token) throw new Error('Instagram is not connected');

  const res = await fetch(`${auth.base}/${commentId}?access_token=${encodeURIComponent(auth.token)}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.error) {
    const m = json.error.message || 'Delete failed';
    if (/permission|manage_comments|scope/i.test(m))
      throw new Error('Deleting needs the instagram_manage_comments permission.');
    throw new Error(m);
  }
  await pool.query('DELETE FROM instagram_comments WHERE comment_id = $1 OR parent_id = $1', [commentId]).catch(() => {});
  return { ok: true };
}

// ── Content publishing (Instagram API with Instagram Login) ──────────
// Two-step Graph publish: create a media container (/me/media) → publish it
// (/me/media_publish). Video (reels/video carousel children) is async — the
// container must reach status_code FINISHED before it can be published.
// Requires the instagram_business_content_publish scope on the account token.
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _igCall(base, edge, params, token, method = 'POST') {
  const url = new URL(`${base}${edge}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('locale', 'en_US');   // force Meta's error_user_msg to English
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, String(v)); });
  const res = await fetch(url.toString(), { method });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.error_user_msg || data.error.message || 'Instagram publish error');
  return data;
}

// Build the caption: the typed caption plus the composer's separate hashtags field
// (normalized to #tags, capped at 30 per IG, whole caption capped at 2200 chars).
function _composeCaption(job) {
  let caption = (job.caption || '').toString();
  const tags = Array.isArray(job.details && job.details.hashtags) ? job.details.hashtags : [];
  const norm = tags.map(t => String(t).trim()).filter(Boolean)
    .map(t => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, ''))).slice(0, 30);
  if (norm.length) caption = (caption ? caption + '\n\n' : '') + norm.join(' ');
  return caption.slice(0, 2200);
}

// collaborators → JSON array of up to 3 plain usernames (Graph expects ['a','b']).
function _collaborators(details) {
  const list = (Array.isArray(details.collaborators) ? details.collaborators : [])
    .map(u => String(u).replace(/^@/, '').trim()).filter(Boolean).slice(0, 3);
  return list.length ? JSON.stringify(list) : null;
}

// user_tags → JSON [{username,x,y}]. Feed images REQUIRE x/y (0–1); we center them
// since the API gives no way to capture exact tap positions outside Instagram's app.
function _userTags(details) {
  const list = (Array.isArray(details.tagPeople) ? details.tagPeople : [])
    .map(u => String(u).replace(/^@/, '').trim()).filter(Boolean)
    .map(username => ({ username, x: 0.5, y: 0.5 }));
  return list.length ? JSON.stringify(list) : null;
}

// Poll a video container until processing finishes (or fails / times out).
async function _waitForContainer(base, creationId, token, { tries = 30, delayMs = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await _igCall(base, `/${creationId}`, { fields: 'status_code' }, token, 'GET');
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED')
      throw new Error(`Instagram could not process the media (status: ${s.status_code})`);
    await _sleep(delayMs);
  }
  throw new Error('Instagram media processing timed out — try a smaller/shorter video');
}

// Publish a job to Instagram. Returns { ok, simulated:false, externalId, permalink }.
async function publishContent(job) {
  const accountId = job.account_id;
  if (!accountId) throw new Error('No Instagram account selected for this post');
  const auth = await getAccountAuth(accountId);
  if (!auth.ig)
    throw new Error('Instagram publishing needs an OAuth-connected account. Reconnect it on the Integrations page to grant the content-publish permission.');
  const { base, token } = auth;

  const caption = _composeCaption(job);
  const media = Array.isArray(job.media) ? job.media : [];
  const postType = job.post_type;
  const details = job.details || {};
  const absUrl = (u) => !u ? null : (/^https?:\/\//.test(u) ? u : PUBLIC_BASE + u);
  const isVideo = (m) => String(m && m.mime || '').toLowerCase().startsWith('video');

  let creationId;

  if (postType === 'highlight') {
    throw new Error('Instagram highlights can\'t be created via the API — they\'re built from existing stories.');
  } else if (postType === 'story') {
    const m = media[0];
    if (!m) throw new Error('A story needs an image or video');
    const c = await _igCall(base, '/me/media',
      isVideo(m) ? { media_type: 'STORIES', video_url: absUrl(m.url) }
                 : { media_type: 'STORIES', image_url: absUrl(m.url) }, token);
    creationId = c.id;
    if (isVideo(m)) await _waitForContainer(base, creationId, token);
  } else if (postType === 'reel' || (postType === 'post' && media.length === 1 && isVideo(media[0]))) {
    const m = media[0];
    if (!m || !isVideo(m)) throw new Error('A reel needs a video file');
    const params = { media_type: 'REELS', video_url: absUrl(m.url), caption };
    const cover = absUrl(details.thumbnailUrl);
    if (cover) params.cover_url = cover;                                  // custom reel cover image
    if (details.audio) params.audio_name = String(details.audio).slice(0, 100); // name the reel's audio
    params.share_to_feed = details.shareToFeed === 'no' ? 'false' : 'true';     // also show in Feed (default yes)
    const col = _collaborators(details); if (col) params.collaborators = col;   // co-authors (≤3)
    const c = await _igCall(base, '/me/media', params, token);
    creationId = c.id;
    await _waitForContainer(base, creationId, token);
  } else if (postType === 'post') {
    if (!media.length) throw new Error('An Instagram post needs at least one image');
    if (media.length === 1) {
      const params = { image_url: absUrl(media[0].url), caption };
      if (details.altText) params.alt_text = String(details.altText).slice(0, 1000); // accessibility text
      const ut = _userTags(details);     if (ut)  params.user_tags = ut;             // tag people (centered)
      const col = _collaborators(details); if (col) params.collaborators = col;       // co-authors (≤3)
      const c = await _igCall(base, '/me/media', params, token);
      creationId = c.id;
    } else {
      // Carousel — up to 10 children, then a CAROUSEL container.
      const children = [];
      for (const m of media.slice(0, 10)) {
        const child = await _igCall(base, '/me/media',
          isVideo(m) ? { media_type: 'VIDEO', video_url: absUrl(m.url), is_carousel_item: true }
                     : { image_url: absUrl(m.url), is_carousel_item: true }, token);
        if (isVideo(m)) await _waitForContainer(base, child.id, token);
        children.push(child.id);
      }
      // Caption + collaborators live on the parent (per-child user_tags/alt_text not wired).
      const params = { media_type: 'CAROUSEL', children: children.join(','), caption };
      const col = _collaborators(details); if (col) params.collaborators = col;
      const c = await _igCall(base, '/me/media', params, token);
      creationId = c.id;
    }
  } else {
    throw new Error(`Unsupported Instagram post type: ${postType}`);
  }

  // Publish the finished container.
  const pub = await _igCall(base, '/me/media_publish', { creation_id: creationId }, token);
  const mediaId = pub.id;

  // Turn off commenting if requested — a post-publish toggle on the live media, NOT
  // a create-container param. Best-effort: the post is already live, so a failure here
  // must not fail the job.
  if (details.commenting === 'off') {
    try { await _igCall(base, `/${mediaId}`, { comment_enabled: 'false' }, token); }
    catch (e) { console.error('Disable comments failed for', mediaId, '-', e.message); }
  }

  let permalink = null;
  try {
    const info = await _igCall(base, `/${mediaId}`, { fields: 'permalink' }, token, 'GET');
    permalink = info.permalink || null;
  } catch { /* permalink is best-effort */ }
  return { ok: true, simulated: false, externalId: mediaId, permalink };
}

// ── Resolve a DM peer's profile (webhook only gives the opaque IGSID) ──
// Uses the account's token. Resolved profiles cached 7d; failed lookups
// negative-cached 24h (a "stub" row with no name) so we don't re-hit the API
// every inbox load for users Instagram won't disclose (e.g. consent code 230)
// or accounts without a token — yet still retry daily / once they're connected.
// IG profile_pic is a signed cdninstagram.com URL that EXPIRES — download a
// permanent copy to /api/uploads (one file per user, keyed on igsid; overwritten
// on each successful re-resolve so it stays current). Not a Graph call.
async function _downloadProfilePic(igsid, url) {
  if (!url || String(url).startsWith('/api/social/uploads/')) return url || null;
  const hash = crypto.createHash('sha1').update(String(igsid)).digest('hex').slice(0, 16);
  const fname = `pfp-${hash}.jpg`;
  for (let attempt = 0; attempt < 2; attempt++) {   // one retry for transient CDN blips
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(UPLOADS_DIR, fname), buf);
      return `/api/social/uploads/${fname}`;
    } catch { /* fall through to retry */ }
  }
  return null;
}

// Resolve a DM peer's name/username/profile_pic. The per-user lookup is gated to
// Instagram's 24h messaging window (code 230 otherwise) AND only the per-user
// endpoint returns a profile_pic (the conversations batch does not). So on a
// genuine inbound message (`force`), we always re-attempt — that's the one moment
// the window is open and the pic is fetchable.
async function resolveUserProfile(igsid, accountId, { force = false } = {}) {
  if (!igsid) return null;
  const { rows } = await pool.query(
    'SELECT igsid, username, name, profile_pic, updated_at FROM instagram_users WHERE igsid = $1', [igsid]);
  const cached = rows[0];
  if (cached) {
    const hasPic = !!cached.profile_pic;
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (hasPic && age < 7 * 24 * 3600 * 1000) return cached;       // complete + fresh → use cache
    if (!hasPic && !force && age < 6 * 3600 * 1000) return cached; // throttle pic-less retries unless a fresh inbound msg forces one
  }
  const markUnresolved = () => pool.query(
    `INSERT INTO instagram_users (igsid, updated_at) VALUES ($1, now())
     ON CONFLICT (igsid) DO UPDATE SET updated_at = now()`, [igsid]).catch(() => {});
  try {
    const auth = await getAccountAuth(accountId);
    const url = new URL(`${auth.base}/${igsid}`);
    url.searchParams.set('fields', 'name,username,profile_pic');
    url.searchParams.set('access_token', auth.token);
    const data = await (await fetch(url)).json();
    if (data.error || (!data.username && !data.name)) { await markUnresolved(); return cached || null; }
    // Only ever persist a permanent local copy — never the expiring cdn URL.
    // If the download fails, leave pic null so it's retried within the window
    // (COALESCE in the upsert keeps any existing good pic).
    const pic = data.profile_pic ? await _downloadProfilePic(igsid, data.profile_pic) : null;
    await pool.query(
      `INSERT INTO instagram_users (igsid, username, name, profile_pic, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (igsid) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, instagram_users.username),
         name = COALESCE(EXCLUDED.name, instagram_users.name),
         profile_pic = COALESCE(EXCLUDED.profile_pic, instagram_users.profile_pic),
         updated_at = now()`,
      [igsid, data.username || null, data.name || null, pic]);
    return { igsid, username: data.username, name: data.name, profile_pic: pic };
  } catch { await markUnresolved(); return cached || null; }
}

// ── Comments backfill / periodic sync ──────────────────────────
// Webhooks deliver NEW comments live, but historical comments (from before the
// webhook was wired) only enter the DB if we pull them. This function does ONE
// Graph call per connected account using `comments{...replies{...}}` nested field
// expansion → gets all recent posts + their comment trees in a single request.
// Idempotent via ON CONFLICT — safe to run alongside webhook ingest. 15s self-throttle
// matches the FB/YT/Threads syncComments pattern.
let _lastIgCommentSync = 0;

async function _upsertIgComment(c, accountId, mediaId, parentId) {
  await pool.query(
    `INSERT INTO instagram_comments
       (comment_id, account_id, media_id, parent_id, from_id, from_username, text, raw, ts, like_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (comment_id) DO UPDATE
       SET text          = COALESCE(EXCLUDED.text,          instagram_comments.text),
           parent_id     = COALESCE(instagram_comments.parent_id, EXCLUDED.parent_id),
           from_username = COALESCE(EXCLUDED.from_username, instagram_comments.from_username),
           from_id       = COALESCE(EXCLUDED.from_id,       instagram_comments.from_id),
           raw           = EXCLUDED.raw,
           like_count    = COALESCE(EXCLUDED.like_count,    instagram_comments.like_count)`,
    [
      c.id, accountId, mediaId, parentId || null,
      c.user?.id || c.from?.id || null,
      c.user?.username || c.username || c.from?.username || null,
      c.text || null,
      JSON.stringify(c),
      c.timestamp ? new Date(c.timestamp) : null,
      // Webhook payloads carry no like_count (stays null until the next sync).
      Number.isFinite(c.like_count) ? c.like_count : null,
    ]
  ).catch(() => {});
}

// Deletion reconciliation: a comment deleted ON Instagram (not via the app)
// only reaches us if the deletion webhook arrived — when it's missed, the row
// lingers forever. After a successful full fetch we drop rows for the fetched
// media whose comment_id no longer exists on the platform. Scoped to the same
// account + the fetched media only, and never on an empty/failed fetch. The
// 5-minute age guard keeps a comment that arrived via webhook mid-sync alive.
async function _pruneDeletedIgComments(accountId, mediaIds, seenCommentIds) {
  if (!mediaIds.length) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM instagram_comments
      WHERE account_id = $1
        AND media_id = ANY($2::text[])
        AND comment_id <> ALL($3::text[])
        AND created_at < now() - interval '5 minutes'`,
    [accountId, mediaIds, seenCommentIds.length ? seenCommentIds : ['__none__']]
  ).catch(() => ({ rowCount: 0 }));
  if (rowCount > 0) console.log(`IG comments: pruned ${rowCount} deleted-on-platform rows (account ${accountId})`);
  return rowCount;
}

// Upsert one IG media row into the shared `posts` table so the Inbox post-cards
// always have a thumbnail/caption/permalink, even for posts that pre-date the
// regular stats sync. Idempotent on (platform_id, external_id). The thumbnail
// is fetched once and stored — IG CDN URLs expire but posts.thumbnail_url stays
// valid because syncService localizes thumbs to /api/uploads on its next pass.
async function _upsertIgPost(m) {
  if (!m?.id) return;
  await pool.query(
    `INSERT INTO posts
       (platform_id, external_id, title, caption, type, media_type, date,
        views, engagements, likes, comments, shares, saves, clicks, score,
        permalink, thumbnail_url, fetched_at)
     SELECT id, $1, $2, $3, $4, $5, $6, 0, 0, 0, $7, 0, 0, 0, 0, $8, $9, now()
       FROM platforms WHERE key = 'instagram' LIMIT 1
     ON CONFLICT (platform_id, external_id) DO UPDATE SET
       caption       = COALESCE(EXCLUDED.caption,       posts.caption),
       title         = COALESCE(NULLIF(EXCLUDED.title,''), posts.title),
       media_type    = COALESCE(EXCLUDED.media_type,    posts.media_type),
       date          = COALESCE(EXCLUDED.date,          posts.date),
       comments      = GREATEST(EXCLUDED.comments,      posts.comments),
       permalink     = COALESCE(EXCLUDED.permalink,     posts.permalink),
       thumbnail_url = COALESCE(posts.thumbnail_url,    EXCLUDED.thumbnail_url)`,
    [
      m.id,
      (m.caption || '').slice(0, 80) || 'Instagram post',
      m.caption || null,
      m.media_type || 'Post',
      m.media_type || null,
      m.timestamp ? new Date(m.timestamp).toISOString().slice(0, 10) : null,
      m.comments_count || 0,
      m.permalink || null,
      m.thumbnail_url || m.media_url || null,
    ]
  ).catch(() => {});
}

async function _syncCommentsForAccount(accountId, token) {
  // ONE call: posts (most recent 50) + their comments + replies, nested.
  // Also pulls media_url/permalink/caption so we can upsert the post row — fixes
  // the "no thumbnail" placeholder on comment cards for posts that aren't in
  // `posts` from the stats sync yet (older posts, posts beyond the stats window).
  const url = new URL(`${IG_API}/${accountId}/media`);
  url.searchParams.set('fields',
    'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,comments_count,' +
    'comments{id,text,timestamp,username,like_count,user{id,username},' +
    'replies{id,text,timestamp,username,like_count,user{id,username}}}');
  url.searchParams.set('limit', '50');
  url.searchParams.set('access_token', token);

  const data = await (await fetch(url.toString())).json();
  if (data.error) {
    // Field-expansion errors fall back to a per-post fetch (rare; IG sometimes
    // rejects nested replies expansion if the post is older).
    const msg = data.error.message || 'IG comments sync error';
    if (/replies|field|nested/i.test(msg)) return await _syncCommentsPerPost(accountId, token);
    throw new Error(msg);
  }

  let count = 0;
  const mediaIds = [], seenIds = [];
  for (const media of (data.data || [])) {
    // Always upsert the post (even if 0 comments) so the cards have full media.
    await _upsertIgPost(media);
    mediaIds.push(String(media.id));
    if (!media.comments?.data?.length) continue;
    // The comments edge also lists every reply as a top-level entry (no parent
    // marker). Skip those here — they are stored under their parent below.
    const replyIds = new Set(media.comments.data.flatMap(c => (c.replies?.data || []).map(r => String(r.id))));
    for (const c of media.comments.data) {
      if (replyIds.has(String(c.id))) continue;
      await _upsertIgComment(c, accountId, media.id, null);
      seenIds.push(String(c.id));
      count++;
      for (const r of (c.replies?.data || [])) {
        await _upsertIgComment(r, accountId, media.id, c.id);
        seenIds.push(String(r.id));
        count++;
      }
    }
  }
  // The fetch succeeded for the whole window → safe to reconcile deletions.
  await _pruneDeletedIgComments(accountId, mediaIds, seenIds);
  return count;
}

// Fallback: one comments call per post (used only if nested expansion fails).
// Caps at 25 posts and skips ones with comments_count=0 to stay within rate budget.
async function _syncCommentsPerPost(accountId, token) {
  const mediaUrl = new URL(`${IG_API}/${accountId}/media`);
  mediaUrl.searchParams.set('fields', 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,comments_count');
  mediaUrl.searchParams.set('limit', '25');
  mediaUrl.searchParams.set('access_token', token);
  const md = await (await fetch(mediaUrl.toString())).json();
  if (md.error) throw new Error(md.error.message);
  let count = 0;
  for (const m of (md.data || [])) {
    await _upsertIgPost(m);   // ensure the post row exists for the Inbox card
    if (!(m.comments_count > 0)) continue;
    const cu = new URL(`${IG_API}/${m.id}/comments`);
    cu.searchParams.set('fields', 'id,text,timestamp,username,like_count,user{id,username},replies{id,text,timestamp,username,like_count,user{id,username}}');
    cu.searchParams.set('access_token', token);
    try {
      const cd = await (await fetch(cu.toString())).json();
      if (cd.error) continue;
      const replyIds = new Set((cd.data || []).flatMap(c => (c.replies?.data || []).map(r => String(r.id))));
      for (const c of (cd.data || [])) {
        if (replyIds.has(String(c.id))) continue;   // a reply listed at top level
        await _upsertIgComment(c, accountId, m.id, null);
        count++;
        for (const r of (c.replies?.data || [])) {
          await _upsertIgComment(r, accountId, m.id, c.id);
          count++;
        }
      }
    } catch (_) { /* skip this post */ }
  }
  return count;
}

async function syncComments({ force = false } = {}) {
  if (!force && Date.now() - _lastIgCommentSync < 15000) return 0;
  _lastIgCommentSync = Date.now();

  // Pull every visible OAuth-connected account with a token. Legacy single-account
  // installs put their token in app_settings; that path was deprecated for multi-
  // account, but for backwards-compat we also try the Page-token route via
  // getAccountAuth for any account row without its own token.
  const { rows: accounts } = await pool.query(
    `SELECT account_id, token FROM instagram_accounts
      WHERE NOT COALESCE(hidden, false)`);
  let total = 0, errors = 0;
  for (const a of accounts) {
    try {
      let token = a.token;
      if (!token) {
        try { const auth = await getAccountAuth(a.account_id); token = auth.token; } catch (_) { continue; }
      }
      if (!token) continue;
      total += await _syncCommentsForAccount(a.account_id, token);
    } catch (e) {
      errors++;
      console.error(`IG comments sync failed for ${a.account_id}:`, e.message);
    }
  }
  // If every account failed, surface the error so the UI can show a banner.
  if (errors > 0 && total === 0 && accounts.length > 0) throw new Error('IG comments sync failed for every account');
  return total;
}

// ── Auto-CRM: upsert a contact row from each ingested DM ─────
// One row per (account_id, peer_id). Identity (name/username/pic) is pulled from
// instagram_users (the API cache) — so contacts pick up profile data as the
// resolver fills it in over time. Best-effort: never blocks ingest.
async function upsertContact({ accountId, peerId, direction, text, ts }) {
  if (!accountId || !peerId) return;
  await pool.query(
    `INSERT INTO contacts
       (platform, account_id, peer_id, name, username, profile_pic,
        first_seen_at, last_seen_at, last_msg_preview, last_msg_dir, message_count)
     SELECT 'instagram', $1, $2, u.name, u.username, u.profile_pic,
            $3, $3, $4, $5, 1
       FROM (SELECT 1) _
       LEFT JOIN instagram_users u ON u.igsid = $2
     ON CONFLICT (platform, account_id, peer_id) DO UPDATE SET
       last_seen_at     = GREATEST(contacts.last_seen_at, EXCLUDED.last_seen_at),
       last_msg_preview = COALESCE(EXCLUDED.last_msg_preview, contacts.last_msg_preview),
       last_msg_dir     = EXCLUDED.last_msg_dir,
       message_count    = contacts.message_count + 1,
       name             = COALESCE(EXCLUDED.name,        contacts.name),
       username         = COALESCE(EXCLUDED.username,    contacts.username),
       profile_pic      = COALESCE(EXCLUDED.profile_pic, contacts.profile_pic)`,
    [accountId, peerId, ts || new Date(), text ? text.slice(0, 280) : null, direction || null]
  );
}

// ── Resolve peer names via the Conversations API ─────────────
// The per-user profile lookup is consent-gated (code 230) for users who only
// RECEIVED messages (e.g. ManyChat broadcasts). But listing the account's own
// conversations returns participant usernames for ALL of them. One call (+paging)
// per connected account; globally throttled to 5 min. Resolves the names that
// resolveUserProfile() can't.
let _convoResolveAt = 0;

async function resolveAccountConversations(accountId, token) {
  let next = (() => {
    const u = new URL(`${IG_API}/me/conversations`);
    u.searchParams.set('platform', 'instagram');
    u.searchParams.set('fields', 'participants');
    u.searchParams.set('access_token', token);
    return u.toString();
  })();
  let count = 0, pages = 0;
  while (next && pages < 20) {
    const d = await (await fetch(next)).json();
    if (d.error) break;
    for (const c of (d.data || [])) {
      for (const p of (c.participants?.data || [])) {
        if (!p.id || p.id === accountId || (!p.username && !p.name)) continue;
        await pool.query(
          `INSERT INTO instagram_users (igsid, username, name, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (igsid) DO UPDATE SET
             username = COALESCE(EXCLUDED.username, instagram_users.username),
             name = COALESCE(EXCLUDED.name, instagram_users.name)`,
          [p.id, p.username || null, p.name || null]).catch(() => {});
        count++;
      }
    }
    next = d.paging?.next || null;
    pages++;
  }
  return count;
}

async function resolveAllConversations({ force = false } = {}) {
  if (!force && Date.now() - _convoResolveAt < 5 * 60 * 1000) return { skipped: true };
  _convoResolveAt = Date.now();
  const { rows } = await pool.query("SELECT account_id, token FROM instagram_accounts WHERE token IS NOT NULL");
  let total = 0;
  for (const a of rows) {
    try { total += await resolveAccountConversations(a.account_id, a.token); }
    catch (e) { console.error('resolveAccountConversations failed:', e.message); }
  }
  return { resolved: total };
}

// ── Historical chat backfill ────────────────────────────────────────────
// Webhooks deliver NEW DMs live; this fills in conversations + messages that
// pre-date the webhook (or were missed during downtime). Uses the Conversations
// API which IG allows for backfill (the per-user profile lookup is gated, but
// the account's OWN conversations are always accessible to its own token).
// Pulls up to 200 conversations × 50 messages/each = ~10k upserts worst case.
// Idempotent via ON CONFLICT(mid). Self-throttled to once per 10 minutes.
let _lastMsgBackfillAt = 0;

// The Conversations API returns attachments as { data: [{ image_data | video_data |
// generic_template | file_url … }] } and shared reels/posts under a separate
// `shares` edge. The webhook (and the Inbox UI) use an array of
// { type, payload: { url, title } }. Convert one API message to that array.
function _normalizeConvAttachments(m) {
  const out = [];
  const list = Array.isArray(m?.attachments) ? m.attachments : (m?.attachments?.data || []);
  for (const a of list) {
    if (a?.type && a?.payload) { out.push(a); continue; }   // already webhook-shaped
    if (a?.image_data?.url) out.push({ type: 'image', payload: { url: a.image_data.url } });
    else if (a?.video_data?.url) out.push({ type: 'video', payload: { url: a.video_data.url } });
    else if (a?.audio_data?.url) out.push({ type: 'audio', payload: { url: a.audio_data.url } });
    else if (a?.generic_template) {
      const g = a.generic_template;
      out.push({ type: 'template', payload: { generic: { elements: [{
        title: g.title || null, subtitle: g.subtitle || null, image_url: g.media_url || g.image_url || null,
        buttons: (g.cta || g.buttons || []).map(b => ({ type: b.type, title: b.title, url: b.url || null, payload: b.payload || null })),
      }] } } });
    } else if (a?.file_url) out.push({ type: 'file', payload: { url: a.file_url, title: a.name || null } });
  }
  for (const sh of (m?.shares?.data || [])) {
    const url = sh.link || null;
    out.push({ type: /instagram\.com\/(reel|reels)\//i.test(url || '') ? 'ig_reel' : 'share', payload: { url, title: sh.name || sh.description || null } });
  }
  const story = m?.story?.reply_to || m?.story?.mention;
  if (story) out.push({ type: m.story.mention ? 'story_mention' : 'story_reply', payload: { url: story.link || null } });
  return out.length ? out : null;
}

// One-time heal for rows the backfill stored in the raw API shape (zero Graph calls).
async function normalizeStoredAttachments() {
  let fixed = 0;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, attachments, raw FROM instagram_messages
        WHERE jsonb_typeof(attachments) = 'object' LIMIT 500`);
    if (!rows.length) break;
    for (const r of rows) {
      const norm = _normalizeConvAttachments({ attachments: r.attachments, shares: r.raw?.shares, story: r.raw?.story });
      await pool.query('UPDATE instagram_messages SET attachments = $2 WHERE id = $1', [r.id, norm ? JSON.stringify(norm) : null]);
      fixed++;
    }
  }
  if (fixed) console.log(`[instagram] normalised ${fixed} backfilled message attachments`);
  return fixed;
}

async function _backfillMessagesForAccount(accountId, token) {
  let next = (() => {
    const u = new URL(`${IG_API}/me/conversations`);
    u.searchParams.set('platform', 'instagram');
    // messages.limit(25) — request the most recent 25 per conversation. `from`
    // and `to` give us the sender/recipient ids; `message` is the text.
    u.searchParams.set('fields',
      'participants,messages.limit(25){id,created_time,from,to,message,attachments,shares,story}');
    u.searchParams.set('access_token', token);
    // 50x50 makes Instagram reject the page with "Please reduce the amount of
    // data you're asking for" for accounts with media-heavy threads — and since
    // a page error breaks the loop, that account ends up with ZERO messages.
    // 20x25 stays under the limit; the page cap below is raised to compensate.
    u.searchParams.set('limit', '20');
    return u.toString();
  })();
  let inserted = 0, pages = 0;
  while (next && pages < 25) {
    const d = await (await fetch(next)).json();
    if (d.error) { console.error('IG message backfill page error:', d.error.message); break; }
    for (const conv of (d.data || [])) {
      // Cache participant identity (same as resolveAccountConversations would)
      for (const p of (conv.participants?.data || [])) {
        if (!p.id || p.id === accountId) continue;
        if (p.username || p.name) {
          await pool.query(
            `INSERT INTO instagram_users (igsid, username, name, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (igsid) DO UPDATE SET
               username = COALESCE(EXCLUDED.username, instagram_users.username),
               name     = COALESCE(EXCLUDED.name,     instagram_users.name)`,
            [p.id, p.username || null, p.name || null]).catch(() => {});
        }
      }
      // Upsert each message in the conversation
      for (const m of (conv.messages?.data || [])) {
        const fromId = m.from?.id || null;
        const toData = m.to?.data?.[0] || {};
        const toId   = toData.id || null;
        const isOutgoing = fromId === accountId;
        const peerId = isOutgoing ? toId : fromId;
        const direction = isOutgoing ? 'outgoing' : 'incoming';
        const ts = m.created_time ? new Date(m.created_time) : null;
        const senderId    = isOutgoing ? accountId : peerId;
        const recipientId = isOutgoing ? peerId    : accountId;
        await pool.query(
          `INSERT INTO instagram_messages
             (mid, account_id, sender_id, recipient_id, direction, text, attachments, raw, ts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (mid) DO UPDATE SET attachments = EXCLUDED.attachments, raw = EXCLUDED.raw
             -- only fill rows that never got usable attachments (webhook rows keep theirs)
             WHERE EXCLUDED.attachments IS NOT NULL
               AND (instagram_messages.attachments IS NULL OR jsonb_typeof(instagram_messages.attachments) <> 'array')`,
          [m.id || null, accountId, senderId, recipientId, direction,
           m.message || null, (() => { const n = _normalizeConvAttachments(m); return n ? JSON.stringify(n) : null; })(),
           JSON.stringify(m), ts]
        ).catch(() => {});
        inserted++;
        // Also upsert the contact for this peer (mirrors the webhook ingest path)
        if (peerId) upsertContact({ accountId, peerId, direction, text: m.message || null, ts }).catch(() => {});
      }
    }
    next = d.paging?.next || null;
    pages++;
  }
  return inserted;
}

async function syncMessages({ force = false } = {}) {
  if (!force && Date.now() - _lastMsgBackfillAt < 10 * 60 * 1000) return 0;
  _lastMsgBackfillAt = Date.now();
  const { rows } = await pool.query(
    `SELECT account_id, token FROM instagram_accounts
      WHERE token IS NOT NULL AND NOT COALESCE(hidden, false)`);
  let total = 0;
  for (const a of rows) {
    try { total += await _backfillMessagesForAccount(a.account_id, a.token); }
    catch (e) { console.error(`IG message backfill failed for ${a.account_id}:`, e.message); }
  }
  return total;
}

// ── Mark a conversation's incoming messages as read by our team ──
// Drives the per-conversation unread badge in the Inbox. Scoped to one
// account + counterparty (the peer is the sender_id of incoming DMs).
async function markConversationRead({ accountId, peerId }) {
  if (!accountId || !peerId) throw new Error('accountId and peerId are required');
  const { rowCount } = await pool.query(
    `UPDATE instagram_messages
        SET read_by_us = true
      WHERE account_id = $1 AND sender_id = $2
        AND direction = 'incoming' AND read_by_us = false`,
    [accountId, peerId]
  );
  return { ok: true, marked: rowCount };
}

module.exports = {
  normalizeStoredAttachments,
  testConnection, saveCredentials, refreshToken, refreshAccountTokens, getStats, getAllPosts, getAudience,
  verifyWebhookSignature, logWebhookEvent, handleWebhook, localizeAttachments,
  listAccounts, upsertAccount, subscribePages, sampleFollowers,
  parseSignedRequest, handleDataDeletion, sendDirectMessage, resolveUserProfile,
  resolveAllConversations,
  getOAuthUrl, exchangeOAuthCode, disconnectAccount, markConversationRead,
  publishContent, replyToComment, deleteComment, _composeCaption,
  upsertContact, syncComments, syncMessages,
  getAccountAuth,
};
