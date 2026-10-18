const socialEnv = require('./env');
// ============================================================
// threads.js — Threads Insights service
// ============================================================
const pool = require('./db');
// Rate-limited fetch (gates graph.threads.net per token via Redis).
const fetch = require('./rateLimiter').gatedFetch;

// Versioned graph base (for all data queries)
const GRAPH = 'https://graph.threads.net/v1.0';
// Unversioned base (for token refresh)
const GRAPH_BASE = 'https://graph.threads.net';

// ── Cache ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = { stats: 5 * 60 * 1000, status: 5 * 60 * 1000 };

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

async function getAccessToken() {
  return await getSetting('threads_access_token');
}

// ── Graph API helper ─────────────────────────────────────────
async function graphFetch(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(String(k), String(v));
  }
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(`Threads API: ${json.error.message} (code ${json.error.code})`);
  return json;
}

// ── OAuth ─────────────────────────────────────────────────────
function getConsentUrl(state) {
  const appId = socialEnv.THREADS_APP_ID;
  if (!appId) throw new Error('THREADS_APP_ID not configured');
  const redirectUri = socialEnv.THREADS_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/threads/callback' : '');
  const url = new URL('https://www.threads.net/oauth/authorize');
  url.searchParams.set('client_id',     appId);
  url.searchParams.set('redirect_uri',  redirectUri);
  // Scopes (need a reconnect to take effect):
  //  - threads_basic            → profile + reading own threads (always required)
  //  - threads_manage_insights  → analytics (already wired)
  //  - threads_read_replies     → READ replies/comments on our threads (Inbox)
  //  - threads_manage_replies   → REPLY to / HIDE replies on our threads (Inbox actions)
  //  - threads_content_publish  → POST new threads (Publish goes live; previously stubbed)
  url.searchParams.set('scope',         'threads_basic,threads_manage_insights,threads_read_replies,threads_manage_replies,threads_content_publish');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state',         state || 'forgesocial_th');
  return url.toString();
}

async function exchangeCode(code) {
  const appId      = socialEnv.THREADS_APP_ID;
  const appSecret  = socialEnv.THREADS_APP_SECRET;
  const redirectUri = socialEnv.THREADS_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/threads/callback' : '');
  if (!appId)     throw new Error('THREADS_APP_ID not configured');
  if (!appSecret) throw new Error('THREADS_APP_SECRET not configured');

  // 1. Exchange auth code for short-lived token (1 hour) — must be form-encoded POST
  const body = new URLSearchParams({
    client_id:     appId,
    client_secret: appSecret,
    grant_type:    'authorization_code',
    redirect_uri:  redirectUri,
    code,
  });
  const tokenRes = await fetch(`${GRAPH_BASE}/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error.message);
  const { access_token: shortLived, user_id } = tokenData;

  // 2. Exchange for long-lived token (60 days) — grant_type=th_exchange_token
  const llUrl = new URL(`${GRAPH_BASE}/access_token`);
  llUrl.searchParams.set('grant_type',    'th_exchange_token');
  llUrl.searchParams.set('client_secret', appSecret);
  llUrl.searchParams.set('access_token',  shortLived);
  const llRes  = await fetch(llUrl.toString());
  const llData = await llRes.json();
  if (llData.error) throw new Error(llData.error.message);

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await setSetting('threads_user_id',          String(user_id));
  await setSetting('threads_access_token',     llData.access_token);
  await setSetting('threads_token_expires_at', expiresAt);
  cacheInvalidate('');
  return { userId: user_id };
}

// ── Manual credential save (fallback) ────────────────────────
async function saveCredentials({ userId, accessToken }) {
  const url = new URL(`${GRAPH}/me`);
  url.searchParams.set('fields',       'id,username,threads_profile_picture_url');
  url.searchParams.set('access_token', accessToken);
  const res  = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Threads API: ${data.error.message}`);

  const resolvedUserId = data.id || String(userId);
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await setSetting('threads_user_id',          resolvedUserId);
  await setSetting('threads_access_token',     accessToken);
  await setSetting('threads_token_expires_at', expiresAt);
  cacheInvalidate('');
  return { username: data.username };
}

async function refreshToken() {
  const token = await getAccessToken();
  if (!token) throw new Error('No Threads token saved');

  // grant_type=th_refresh_token — simple GET, no secret needed
  const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type',   'th_refresh_token');
  url.searchParams.set('access_token', token);
  const res  = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await setSetting('threads_access_token',     data.access_token);
  await setSetting('threads_token_expires_at', expiresAt);
  cacheInvalidate('');

  const daysLeft = Math.round((new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24));
  return { daysLeft };
}

// Refresh every secondary Threads account token (social_accounts rows).
// Same th_refresh_token grant as the primary; each refresh restarts the
// 60-day clock. Tokens <24h old are rejected by Meta — benign skip.
async function refreshAccountTokens(thresholdDays = 45) {
  const { rows } = await pool.query(
    `SELECT id, account_key, token, token_expires_at FROM social_accounts
      WHERE platform = 'threads' AND token IS NOT NULL`);
  const results = [];
  for (const a of rows) {
    const daysLeft = a.token_expires_at
      ? (new Date(a.token_expires_at) - Date.now()) / 86400000
      : null;
    if (daysLeft !== null && daysLeft > thresholdDays) {
      results.push({ accountKey: a.account_key, ok: true, skipped: true, daysLeft: Math.round(daysLeft) });
      continue;
    }
    try {
      const url = new URL(`${GRAPH_BASE}/refresh_access_token`);
      url.searchParams.set('grant_type',   'th_refresh_token');
      url.searchParams.set('access_token', a.token);
      const res  = await fetch(url.toString());
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000);
      await pool.query(
        `UPDATE social_accounts
            SET token = $2, token_expires_at = $3, last_refresh_at = now(),
                last_refresh_error = NULL, needs_reconnect = false
          WHERE id = $1`,
        [a.id, data.access_token, expiresAt]);
      results.push({ accountKey: a.account_key, ok: true, daysLeft: Math.round((data.expires_in || 5184000) / 86400) });
    } catch (e) {
      if (/24 hours|too soon/i.test(e.message)) {
        results.push({ accountKey: a.account_key, ok: true, skipped: true });
        continue;
      }
      // Transient (network/rate-limit) errors say nothing about the token — skip.
      if (/fetch failed|network|econn|etimedout|socket hang|rate.?limited|timed?\s?out|temporar/i.test(e.message)) {
        results.push({ accountKey: a.account_key, ok: true, skipped: true });
        continue;
      }
      const dead = /expired|invalid|session|cannot be refreshed|deauthorized/i.test(e.message)
        || (daysLeft !== null && daysLeft <= 0);
      await pool.query(
        `UPDATE social_accounts
            SET last_refresh_error = $2, needs_reconnect = needs_reconnect OR $3
          WHERE id = $1`,
        [a.id, e.message.slice(0, 500), dead]);
      results.push({ accountKey: a.account_key, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Audience insights — follower demographics ────────────────
// 3 Graph calls, cached 24h. Needs threads_manage_insights (already in the
// consent URL); Threads only reports demographics for accounts with 100+
// followers — below that the calls fail and we return available:false.
async function getAudience() {
  const cached = cacheGet('audience');
  if (cached) return cached;

  const token  = await getAccessToken();
  const userId = await getSetting('threads_user_id');
  if (!token || !userId) return { available: false, reason: 'Threads is not connected' };

  const demo = async (breakdown) => {
    try {
      const d = await graphFetch(`${userId}/threads_insights`, {
        metric: 'follower_demographics', period: 'lifetime', breakdown,
        access_token: token,
      });
      const results = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      return results
        .map(r => ({ label: (r.dimension_values || []).join(' '), value: r.value || 0 }))
        .filter(r => r.label)
        .sort((a, b) => b.value - a.value);
    } catch (_) { return null; }
  };

  const [age, gender, country] = await Promise.all([demo('age'), demo('gender'), demo('country')]);
  const result = { available: !!(age?.length || gender?.length || country?.length), age, gender, country };
  // DB-persisted last-good copy (<=7 days) so a failed fetch never hides the section.
  if (result.available) {
    await setSetting('audience_cache:threads', JSON.stringify({ at: Date.now(), data: result })).catch(() => {});
    cacheSet('audience', result, 24 * 3600 * 1000);
    return result;
  }
  try {
    const stored = JSON.parse(await getSetting('audience_cache:threads') || 'null');
    if (stored?.data?.available && Date.now() - stored.at < 7 * 24 * 3600 * 1000) {
      const fallback = { ...stored.data, stale: true };
      cacheSet('audience', fallback, 10 * 60 * 1000);
      return fallback;
    }
  } catch (_) {}
  cacheSet('audience', result, 10 * 60 * 1000);
  return result;
}

// ── Connection test ──────────────────────────────────────────
async function testConnection(force = false, cred = null) {
  if (!force && !cred) {
    const cached = cacheGet('status');
    if (cached) return cached;
  }
  const token = cred?.accessToken || await getAccessToken();
  if (!token) return { connected: false, hasCredentials: false, error: 'No access token saved' };

  try {
    const expiresAt = cred ? null : await getSetting('threads_token_expires_at');
    const daysLeft  = expiresAt
      ? Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    const data = await graphFetch('me', {
      fields:       'id,username,threads_profile_picture_url',
      access_token: token,
    });

    const result = {
      connected:     true,
      hasCredentials: true,
      tokenDaysLeft: daysLeft,
      profile: {
        id:         data.id,
        username:   data.username,
        name:       data.username,
        followers:  0,
        pictureUrl: data.threads_profile_picture_url || null,
      },
    };
    if (!cred) cacheSet('status', result, CACHE_TTL.status);
    return result;
  } catch (err) {
    return { connected: false, hasCredentials: true, error: err.message };
  }
}

// ── Stats ─────────────────────────────────────────────────────
// Threads insight metrics (period='day'):
//   views — total impressions across all posts
//   likes, replies, reposts, quotes — engagement breakdown
//   followers_count — NEW followers gained each day (daily delta, NOT cumulative)
async function getStats(period = '30D', cred = null) {
  const cacheKey = `stats:${period}:${cred?.accountKey || 'primary'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const token  = cred?.accessToken || await getAccessToken();
  if (!token) return null;
  const userId = cred?.userId || await getSetting('threads_user_id');
  if (!userId) return null;

  const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90, 'Custom': 45 };
  const days = PERIOD_DAYS[period] || 30;

  // Threads has ~1-day data lag
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  const prevEndDate = new Date(startDate);
  prevEndDate.setDate(prevEndDate.getDate() - 1);
  const prevStartDate = new Date(prevEndDate);
  prevStartDate.setDate(prevStartDate.getDate() - days + 1);

  const since     = Math.floor(startDate.getTime() / 1000);
  const until     = Math.floor(endDate.getTime() / 1000) + 86400;
  const prevSince = Math.floor(prevStartDate.getTime() / 1000);
  const prevUntil = Math.floor(prevEndDate.getTime() / 1000) + 86400;

  const [profileData, insightsData, prevInsightsData, mediaData, lifetimeData] = await Promise.all([
    // 1. Profile
    graphFetch('me', {
      fields:       'id,username,threads_profile_picture_url',
      access_token: token,
    }).catch(() => null),

    // 2. Current period — daily breakdown for trend + totals
    graphFetch(`${userId}/threads_insights`, {
      metric:       'views,likes,replies,reposts,quotes,followers_count',
      period:       'day',
      since,
      until,
      access_token: token,
    }).catch(() => ({ data: [] })),

    // 3. Previous period — for delta calculations
    graphFetch(`${userId}/threads_insights`, {
      metric:       'views,likes,replies,reposts,quotes',
      period:       'day',
      since:        prevSince,
      until:        prevUntil,
      access_token: token,
    }).catch(() => ({ data: [] })),

    // 4. Recent posts in the period
    graphFetch(`${userId}/threads`, {
      fields:       'id,text,timestamp,media_type,like_count,replies_count,media_url,thumbnail_url',
      limit:        10,
      since,
      until,
      access_token: token,
    }).catch(() => ({ data: [] })),

    // 5. Lifetime follower count (total)
    graphFetch(`${userId}/threads_insights`, {
      metric:       'followers_count',
      period:       'lifetime',
      access_token: token,
    }).catch(() => ({ data: [] })),
  ]);

  // ── Parse insights ────────────────────────────────────────
  const metricMap = {};
  for (const metric of insightsData.data || []) {
    metricMap[metric.name] = metric.values || [];
  }

  const viewValues     = metricMap['views']           || [];
  const likeValues     = metricMap['likes']           || [];
  const replyValues    = metricMap['replies']         || [];
  const repostValues   = metricMap['reposts']         || [];
  const quoteValues    = metricMap['quotes']          || [];
  const followerValues = metricMap['followers_count'] || [];

  let totalViews = 0, totalLikes = 0, totalReplies = 0, totalReposts = 0, totalQuotes = 0, followerGain = 0;
  for (const v of viewValues)    totalViews    += v.value || 0;
  for (const v of likeValues)    totalLikes    += v.value || 0;
  for (const v of replyValues)   totalReplies  += v.value || 0;
  for (const v of repostValues)  totalReposts  += v.value || 0;
  for (const v of quoteValues)   totalQuotes   += v.value || 0;
  for (const v of followerValues) followerGain += v.value || 0;

  const lifetimeFollowers = lifetimeData?.data?.find(m => m.name === 'followers_count');
  const totalFollowers  = lifetimeFollowers?.total_value?.value ?? 0;
  const followersStart  = Math.max(0, totalFollowers - followerGain);
  const growthPct       = followersStart > 0
    ? parseFloat((followerGain / followersStart * 100).toFixed(1))
    : 0;

  // Trend: accumulate daily follower gains forward from start-of-period count
  // trendSeries carries the API's own end_time per point so the trend chart can
  // place these ESTIMATED values on the right calendar day. Like Instagram's,
  // Threads' followers_count insight reports gains only (no unfollows), so this
  // reconstruction is an estimate — follower_samples is the source of truth.
  const trendDays = [], trendValues = [], trendSeries = [];
  let running = followersStart;
  for (const v of followerValues) {
    running += v.value || 0;
    trendDays.push(new Date(v.end_time).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
    trendValues.push(running);
    trendSeries.push({ date: new Date(v.end_time).toISOString().slice(0, 10), value: running });
  }

  // ── Previous period ────────────────────────────────────────
  let prevViews = 0;
  for (const metric of prevInsightsData.data || []) {
    if (metric.name === 'views') {
      for (const v of metric.values || []) prevViews += v.value || 0;
    }
  }

  const pctChange = (curr, prev) =>
    !prev ? 0 : parseFloat(((curr - prev) / prev * 100).toFixed(1));

  const totalEngagements = totalLikes + totalReplies + totalReposts + totalQuotes;

  // ── Top posts ──────────────────────────────────────────────
  const postRows = mediaData.data || [];
  const avgEng   = postRows.length
    ? postRows.reduce((s, p) => s + (p.like_count || 0) + (p.replies_count || 0), 0) / postRows.length
    : 0;

  // Per-post views/reposts/quotes via media insights — the post object itself
  // only carries like/reply counts, which is why Threads posts showed 0 views.
  // One rate-gated call per recent post (<=10 per uncached stats, cached 5 min)
  // — well inside the budget. Best-effort: a failed call just leaves 0s.
  const postInsights = {};
  await Promise.all(postRows.map(async (p) => {
    try {
      const d = await graphFetch(`${p.id}/insights`, {
        metric: 'views,likes,replies,reposts,quotes,shares',
        access_token: token,
      });
      const m = {};
      for (const row of (d.data || [])) {
        m[row.name] = row.total_value?.value ?? row.values?.[0]?.value ?? 0;
      }
      postInsights[p.id] = m;
    } catch (_) { /* old token scope or new post — keep 0s */ }
  }));

  const mapPost = (p, idx) => {
    const ins     = postInsights[p.id] || {};
    const likes   = p.like_count    || ins.likes   || 0;
    const replies = p.replies_count || ins.replies || 0;
    const reposts = (ins.reposts || 0) + (ins.quotes || 0);
    const eng     = likes + replies + reposts;
    const text    = (p.text || '').slice(0, 60) + ((p.text?.length || 0) > 60 ? '…' : '');
    return {
      id:        p.id,
      title:     text || `Post ${idx + 1}`,
      date:      new Date(p.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views:     ins.views || 0,
      eng,
      clicks:    null,
      score:     Math.min(99, Math.max(40, avgEng > 0 ? Math.round((eng / avgEng) * 70) : 70)),
      likes,
      comments:  replies,
      shares:    reposts,
      watchTime: null,
      avd:       null,
      ctr:       null,
      permalink: profileData?.username
        ? `https://www.threads.net/@${profileData.username}/post/${p.id}`
        : null,
      thumbnail: p.thumbnail_url || p.media_url || null,
      timestamp: p.timestamp,
      media_type: p.media_type,
    };
  };
  const allPosts = postRows.map(mapPost);
  const topPosts = allPosts.slice(0, 4);

  const result = {
    key:      'threads',
    platform: { name: 'Threads', short: 'TH', color: '#111111', bg: '#EEEEE8', textOnBg: '#111111' },
    followers:        totalFollowers,
    growth:           followerGain,
    growthPct,
    impressions:      totalViews,
    reach:            null,
    engagementRate:   totalEngagements > 0 && totalFollowers > 0
                        ? parseFloat((totalEngagements / totalFollowers * 100).toFixed(2))
                        : 0,
    clicks:           null,
    posts:            postRows.length,
    scaledGrowth:     followerGain,
    impressionsDelta: pctChange(totalViews, prevViews),
    reachDelta:       null,
    engagementDelta:  0,
    clicksDelta:      null,
    postsDelta:       0,
    extras: [
      { label: 'Total Views',      value: totalViews,                  info: 'Total views across all Threads content during the period.' },
      { label: 'Likes',            value: totalLikes,                  info: 'Total likes on your Threads posts.' },
      { label: 'Replies',          value: totalReplies,                info: 'Total replies to your Threads posts.' },
      { label: 'Reposts & Quotes', value: totalReposts + totalQuotes,  info: 'Total reposts and quote-posts during the period.' },
    ],
    topPosts,
    allPosts,
    trend:     trendValues.length ? trendValues : [totalFollowers],
    trendDays: trendDays.length   ? trendDays   : ['Now'],
    trendSeries,
    isThreads: true,   // Threads has no reach/clicks — drives the data-aware KPI layout
    isReal:    true,
  };

  cacheSet(cacheKey, result, CACHE_TTL.stats);
  return result;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL threads (not just recent period) for the Content Library.
async function getAllPosts(cred = null) {
  const token = cred?.accessToken || await getAccessToken();
  const userId = cred?.userId || await getSetting('threads_user_id');
  if (!token || !userId) return [];

  const allThreads = [];
  let url = `${GRAPH}/${userId}/threads?fields=id,text,timestamp,media_type,like_count,replies_count,media_url,thumbnail_url&limit=100&access_token=${token}`;

  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error('Threads getAllPosts error:', data.error);
      break;
    }
    allThreads.push(...(data.data || []));
    url = data.paging?.next || null;
  }

  const profileData = await graphFetch('me', {
    fields: 'username',
    access_token: token,
  }).catch(() => null);

  // Per-post views for posts that don't have any in the DB yet (the post object
  // carries no view count — only /insights does). DB-aware so coverage converges
  // over runs without re-fetching: capped at 40 rate-gated calls per run, and
  // the _upsertPosts zero-guard preserves captured values on later passes.
  const postInsights = {};
  try {
    const { rows } = await pool.query(
      `SELECT p.external_id FROM posts p JOIN platforms pl ON pl.id = p.platform_id
        WHERE pl.key = 'threads' AND p.views > 0`);
    const haveViews = new Set(rows.map(r => String(r.external_id)));
    const targets = allThreads.filter(t => !haveViews.has(String(t.id))).slice(0, 40);
    await Promise.all(targets.map(async (t) => {
      try {
        const d = await graphFetch(`${t.id}/insights`, {
          metric: 'views,likes,replies,reposts,quotes,shares',
          access_token: token,
        });
        const m = {};
        for (const row of (d.data || [])) {
          m[row.name] = row.total_value?.value ?? row.values?.[0]?.value ?? 0;
        }
        postInsights[t.id] = m;
      } catch (_) { /* best-effort */ }
    }));
  } catch (_) { /* DB read failed — skip insights this run */ }

  return allThreads.map(t => {
    const ins = postInsights[t.id] || {};
    const reposts = (ins.reposts || 0) + (ins.quotes || 0);
    const eng = (t.like_count || 0) + (t.replies_count || 0) + reposts;
    return {
      id: t.id,
      title: (t.text || '').slice(0, 80) + ((t.text || '').length > 80 ? '…' : '') || 'Thread',
      date: new Date(t.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views: ins.views || 0,
      eng,
      clicks: null,
      score: 50,
      likes: t.like_count || 0,
      comments: t.replies_count || 0,
      shares: reposts,
      permalink: profileData?.username
        ? `https://www.threads.net/@${profileData.username}/post/${t.id}`
        : null,
      thumbnail: t.thumbnail_url || t.media_url || null,
      timestamp: t.timestamp,
      media_type: t.media_type,
    };
  });
}

// ── Comments (Inbox) ─────────────────────────────────────────
// Polls replies on the user's recent threads and stores them for the Inbox. Uses
// the `replies` field expansion so the WHOLE thread tree comes back in ONE Graph
// call per account. Reading needs threads_read_replies — until the user reconnects
// to grant it, the call returns 403 and we surface a friendly "reconnect" message.
// A 15s cooldown keeps the on-demand Refresh from hammering the API.
let _lastCommentSync = 0;

// One sync run for one credential (legacy app_settings primary OR a social_accounts row).
async function _syncOneAccount({ token, userId }) {
  if (!token || !userId) return 0;

  let data;
  try {
    data = await graphFetch(`${userId}/threads`, {
      fields:       'id,permalink,replies.fields(id,text,timestamp,username,replied_to,permalink,has_replies)',
      limit:        25,
      access_token: token,
    });
  } catch (e) {
    const m = e.message || '';
    if (/permission|scope|denied|10\b|200\b|read_replies/i.test(m)) {
      throw new Error('Reading Threads replies needs the threads_read_replies permission. Reconnect Threads from Settings.');
    }
    throw e;
  }

  let count = 0;
  const threadIds = [], seenIds = [];
  for (const post of (data.data || [])) {
    threadIds.push(String(post.id));
    const replies = post.replies?.data || [];
    for (const r of replies) {
      const repliedToId = r.replied_to?.id || null;
      const parentId    = repliedToId && repliedToId !== post.id ? repliedToId : null;
      await pool.query(
        `INSERT INTO threads_comments
           (comment_id, thread_id, parent_id, account_key, author_username, text, permalink, raw, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (comment_id) DO UPDATE
           SET text = EXCLUDED.text, raw = EXCLUDED.raw, permalink = EXCLUDED.permalink`,
        [
          r.id, post.id, parentId, String(userId),
          r.username || null, r.text || null,
          r.permalink || null, JSON.stringify(r),
          r.timestamp ? new Date(r.timestamp) : null,
        ]
      ).catch(() => {});
      seenIds.push(String(r.id));
      count++;
    }
  }
  // Deletion reconciliation: replies deleted (or hidden) ON Threads directly are
  // absent from the fetch — drop their rows so the Inbox matches the platform.
  // Scoped to this account's fetched threads; never runs on a failed fetch.
  if (threadIds.length) {
    await pool.query(
      `DELETE FROM threads_comments
        WHERE account_key = $1
          AND thread_id = ANY($2::text[])
          AND comment_id <> ALL($3::text[])
          AND created_at < now() - interval '5 minutes'`,
      [String(userId), threadIds, seenIds.length ? seenIds : ['__none__']]
    ).catch(() => {});
  }
  return count;
}

// Sync replies for every connected Threads account (legacy primary + social_accounts).
// Best-effort per account so one bad token doesn't kill the run.
async function syncComments({ force = false } = {}) {
  if (!force && Date.now() - _lastCommentSync < 15000) return 0;
  _lastCommentSync = Date.now();

  const creds = [];
  // Legacy primary credential (app_settings)
  const primaryToken  = await getAccessToken();
  const primaryUserId = await getSetting('threads_user_id');
  if (primaryToken && primaryUserId) creds.push({ token: primaryToken, userId: primaryUserId });
  // Additional accounts in social_accounts
  try {
    const { rows } = await pool.query(
      `SELECT account_key, token, extra FROM social_accounts
        WHERE platform = 'threads' AND NOT COALESCE(hidden, false) AND token IS NOT NULL`);
    for (const r of rows) {
      const uid = (r.extra && r.extra.userId) || r.account_key;
      if (uid && !creds.some(c => c.userId === uid)) creds.push({ token: r.token, userId: uid });
    }
  } catch (_) {}

  let total = 0, lastErr = null;
  for (const c of creds) {
    try { total += await _syncOneAccount(c); }
    catch (e) { lastErr = e; }
  }
  // If EVERY account failed, surface the error so the UI can show a banner.
  if (lastErr && total === 0 && creds.length > 0) throw lastErr;
  return total;
}

// Resolve the credentials (token + userId) for a given account_key, or fall back
// to the legacy primary if the key matches it. Used by reply/delete/hide.
async function _credsForAccount(accountKey) {
  const primaryUserId = await getSetting('threads_user_id');
  if (!accountKey || accountKey === primaryUserId) {
    const token = await getAccessToken();
    if (token && primaryUserId) return { token, userId: primaryUserId };
  }
  const { rows } = await pool.query(
    `SELECT account_key, token, extra FROM social_accounts
      WHERE platform = 'threads' AND account_key = $1 AND token IS NOT NULL LIMIT 1`,
    [accountKey]);
  if (rows[0]) {
    const uid = (rows[0].extra && rows[0].extra.userId) || rows[0].account_key;
    return { token: rows[0].token, userId: uid };
  }
  // Last resort: any connected account (single-account installs frequently lose
  // the account_key column when the row was inserted via the legacy /credentials flow)
  if (primaryUserId) {
    const token = await getAccessToken();
    if (token) return { token, userId: primaryUserId };
  }
  return null;
}

// Reply to a comment AS the account that owns the post. Threads uses the same
// 2-step "create container → publish" pattern as IG. Needs threads_manage_replies
// (and threads_content_publish to publish the container).
async function replyToComment({ commentId, text }) {
  if (!commentId)    throw new Error('commentId is required');
  if (!text?.trim()) throw new Error('Reply text is required');

  // Look up which account owns this reply's parent thread so we reply with the
  // right token. Fallback to the primary if the row is missing (rare).
  const row = await pool.query('SELECT account_key, thread_id FROM threads_comments WHERE comment_id = $1', [commentId]).catch(() => ({ rows: [] }));
  const accountKey = row.rows[0]?.account_key || null;
  const threadId   = row.rows[0]?.thread_id   || null;
  const creds = await _credsForAccount(accountKey);
  if (!creds) throw new Error('Threads is not connected');
  const { token, userId } = creds;

  // 1. Create the reply container — must POST as form-encoded (Threads quirk).
  const createBody = new URLSearchParams({
    media_type:   'TEXT',
    text:         text.trim(),
    reply_to_id:  commentId,
    access_token: token,
  });
  const cRes = await fetch(`${GRAPH}/${userId}/threads`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    createBody.toString(),
  });
  const cJson = await cRes.json();
  if (cJson.error) {
    const m = cJson.error.message || 'Reply failed';
    if (/permission|scope|10\b|200\b|manage_replies|content_publish/i.test(m))
      throw new Error('Replying needs threads_manage_replies + threads_content_publish. Reconnect Threads with reply access from Settings.');
    throw new Error(m);
  }
  const creationId = cJson.id;

  // 2. Publish the container.
  const pBody = new URLSearchParams({ creation_id: creationId, access_token: token });
  const pRes = await fetch(`${GRAPH}/${userId}/threads_publish`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    pBody.toString(),
  });
  const pJson = await pRes.json();
  if (pJson.error) throw new Error(pJson.error.message || 'Publish reply failed');
  const newId = pJson.id;

  // Persist our reply right away so it shows even before the next sync.
  try {
    const meUsername = (await testConnection(false, { accessToken: token })).profile?.username || null;
    await pool.query(
      `INSERT INTO threads_comments
         (comment_id, thread_id, parent_id, account_key, author_username, text, ts)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (comment_id) DO UPDATE SET text = EXCLUDED.text`,
      [newId, threadId, commentId, String(userId), meUsername, text.trim()]
    );
  } catch (_) { /* best-effort */ }

  return { id: newId };
}

// Delete a thread (only works for OWN threads — including our own replies).
// For OTHER users' replies on our post we hide them via /manage_reply instead.
async function deleteComment(commentId) {
  if (!commentId) throw new Error('commentId is required');
  const row = await pool.query('SELECT account_key, author_username FROM threads_comments WHERE comment_id = $1', [commentId]).catch(() => ({ rows: [] }));
  const accountKey = row.rows[0]?.account_key || null;
  const creds = await _credsForAccount(accountKey);
  if (!creds) throw new Error('Threads is not connected');
  const { token, userId } = creds;

  // Is this reply OURS? Compare its author_username to our profile username.
  let ours = false;
  try {
    const meUsername = (await testConnection(false, { accessToken: token })).profile?.username || null;
    ours = !!meUsername && row.rows[0]?.author_username === meUsername;
  } catch (_) {}

  const scopeErr = () => new Error('Deleting needs threads_manage_replies. Reconnect Threads with manage access from Settings.');

  if (ours) {
    // DELETE /{thread-id} — Threads's own delete endpoint
    const r = await fetch(`${GRAPH}/${commentId}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      const m = j.error.message || 'Delete failed';
      if (/permission|scope|10\b|200\b/i.test(m)) throw scopeErr();
      throw new Error(m);
    }
  } else {
    // /{reply-id}/manage_reply?hide=true — hides on our post (the only API path
    // for removing someone else's reply from public view). Threads has no "moderate"
    // analogue to YouTube — hide is the equivalent.
    void userId; // userId not needed for this endpoint
    const body = new URLSearchParams({ hide: 'true', access_token: token });
    const r = await fetch(`${GRAPH}/${commentId}/manage_reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      const m = j.error.message || 'Hide failed';
      if (/permission|scope|10\b|200\b/i.test(m)) throw scopeErr();
      throw new Error(m);
    }
  }

  await pool.query('DELETE FROM threads_comments WHERE comment_id = $1 OR parent_id = $1', [commentId]).catch(() => {});
  return { ok: true, ours };
}

// Lightweight identity for the Inbox (returned alongside comments). Used by the
// frontend to compute `ours` so OUR replies render as the connected account.
async function getMe() {
  const token  = await getAccessToken();
  const userId = await getSetting('threads_user_id');
  if (!token || !userId) return null;
  try {
    const data = await graphFetch('me', { fields: 'id,username,threads_profile_picture_url', access_token: token });
    return { id: String(data.id), username: data.username || null, name: data.username || null, pic: data.threads_profile_picture_url || null };
  } catch (_) { return null; }
}

// "Add account" → exchange the code for a NEW Threads user and store it in
// social_accounts (append) rather than overwriting the primary credential.
async function appendAccountFromCode(code) {
  const appId = socialEnv.THREADS_APP_ID, appSecret = socialEnv.THREADS_APP_SECRET;
  const redirectUri = socialEnv.THREADS_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/threads/callback' : '');
  if (!appId || !appSecret) throw new Error('Threads app not configured');

  const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
  const tokenData = await (await fetch(`${GRAPH_BASE}/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })).json();
  if (tokenData.error) throw new Error(tokenData.error.message);

  const llUrl = new URL(`${GRAPH_BASE}/access_token`);
  llUrl.searchParams.set('grant_type', 'th_exchange_token');
  llUrl.searchParams.set('client_secret', appSecret);
  llUrl.searchParams.set('access_token', tokenData.access_token);
  const llData = await (await fetch(llUrl.toString())).json();
  if (llData.error) throw new Error(llData.error.message);

  const status = await testConnection(true, { accessToken: llData.access_token });
  if (!status.connected) throw new Error(status.error || 'Could not verify the Threads account');
  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO social_accounts (platform, account_key, label, username, token, token_expires_at, extra)
     VALUES ('threads', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (platform, account_key) DO UPDATE
       SET token=EXCLUDED.token, label=EXCLUDED.label, username=EXCLUDED.username,
           token_expires_at=EXCLUDED.token_expires_at, extra=EXCLUDED.extra, last_error=NULL, hidden=false,
           needs_reconnect=false, last_refresh_error=NULL`,
    [String(status.profile.id), status.profile.username, status.profile.username, llData.access_token, expiresAt, JSON.stringify({ userId: String(status.profile.id) })]
  );
  return { accountKey: String(status.profile.id), label: status.profile.username };
}

// ── Content publishing (LIVE) ────────────────────────────────
// Threads uses the same 2-step "create container → publish" pattern as IG.
// Needs threads_content_publish on the account token. Media (image/video) is
// fetched by Threads from the public /api/uploads URL, so files must be on disk.
const _thPublicBase = socialEnv.PUBLIC_BASE_URL || '';
const _thAbsUrl = (u) => !u ? null : (/^https?:\/\//.test(u) ? u : _thPublicBase.replace(/\/+$/, '') + u);
const _thSleep = (ms) => new Promise(r => setTimeout(r, ms));

// POST form-encoded to the Threads Graph API; throws a friendly scope error.
async function _thPost(userId, edge, params, token) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null) body.set(k, String(v));
  body.set('access_token', token);
  const res = await fetch(`${GRAPH}/${userId}/${edge}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const m = json.error.message || 'Threads publish error';
    if (/permission|scope|content_publish|\b10\b|\b200\b/i.test(m))
      throw new Error('Publishing needs the threads_content_publish permission. Reconnect Threads from Settings to grant it.');
    throw new Error(m);
  }
  return json;
}

// Poll a media container until it finishes processing (video needs this).
async function _thWaitForContainer(containerId, token, { tries = 30, delayMs = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await graphFetch(String(containerId), { fields: 'status,error_message', access_token: token }).catch(() => ({}));
    const st = s.status;
    if (st === 'FINISHED') return;
    if (st === 'ERROR' || st === 'EXPIRED')
      throw new Error(`Threads could not process the media: ${s.error_message || st}`);
    await _thSleep(delayMs);
  }
  throw new Error('Threads media processing timed out — try a smaller/shorter video');
}

// Publish a job to Threads. Returns { ok, simulated:false, externalId, permalink }.
async function publishContent(job) {
  const creds = await _credsForAccount(job.account_id || null);
  if (!creds) throw new Error('Threads is not connected. Connect it on the Integrations page.');
  const { token, userId } = creds;

  const text  = (job.caption || '').toString().slice(0, 500);
  const media = Array.isArray(job.media) ? job.media : [];
  const isVideo = (m) => String(m && m.mime || '').toLowerCase().startsWith('video');
  const postType = job.post_type;

  let creationId;

  if (postType === 'carousel' || media.length > 1) {
    // Build ≤20 child containers, then a CAROUSEL parent carrying the text.
    if (media.length < 2) throw new Error('A Threads carousel needs at least 2 items');
    const children = [];
    for (const m of media.slice(0, 20)) {
      const child = await _thPost(userId, 'threads', isVideo(m)
        ? { media_type: 'VIDEO', video_url: _thAbsUrl(m.url), is_carousel_item: 'true' }
        : { media_type: 'IMAGE', image_url: _thAbsUrl(m.url), is_carousel_item: 'true' }, token);
      if (isVideo(m)) await _thWaitForContainer(child.id, token);
      children.push(child.id);
    }
    const c = await _thPost(userId, 'threads', { media_type: 'CAROUSEL', children: children.join(','), text }, token);
    creationId = c.id;
  } else if (media.length === 1) {
    const m = media[0];
    const c = await _thPost(userId, 'threads', isVideo(m)
      ? { media_type: 'VIDEO', video_url: _thAbsUrl(m.url), text }
      : { media_type: 'IMAGE', image_url: _thAbsUrl(m.url), text }, token);
    creationId = c.id;
    if (isVideo(m)) await _thWaitForContainer(creationId, token);
  } else {
    if (!text.trim()) throw new Error('A Threads post needs text or media');
    const c = await _thPost(userId, 'threads', { media_type: 'TEXT', text }, token);
    creationId = c.id;
  }

  // Publish the finished container.
  const pub = await _thPost(userId, 'threads_publish', { creation_id: creationId }, token);
  const mediaId = pub.id;

  let permalink = null;
  try {
    const info = await graphFetch(String(mediaId), { fields: 'permalink', access_token: token });
    permalink = info.permalink || null;
  } catch { /* best-effort */ }
  return { ok: true, simulated: false, externalId: String(mediaId), permalink };
}

// Delete an already-published thread (own posts only). Used by the Publish log.
async function deletePost(externalId, accountKey = null) {
  const creds = await _credsForAccount(accountKey);
  if (!creds) throw new Error('Threads is not connected');
  const r = await fetch(`${GRAPH}/${externalId}?access_token=${encodeURIComponent(creds.token)}`, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || 'Delete failed');
  return { ok: true };
}

// ── Cheap follower sampler ───────────────────────────────────
// ONE insights call per connected account (lifetime followers_count), so the
// daily follower series never depends on a full getStats run.
async function sampleFollowers() {
  const creds = [];
  const legacyToken  = await getAccessToken();
  const legacyUserId = await getSetting('threads_user_id');
  if (legacyToken && legacyUserId) creds.push({ userId: String(legacyUserId), token: legacyToken });
  try {
    const { rows } = await pool.query(
      `SELECT account_key, token FROM social_accounts
        WHERE platform = 'threads' AND token IS NOT NULL AND NOT COALESCE(hidden, false)`);
    for (const r of rows) {
      if (creds.some(c => c.userId === r.account_key)) continue;
      creds.push({ userId: r.account_key, token: r.token });
    }
  } catch (_) {}

  const out = [];
  for (const c of creds) {
    try {
      const d = await graphFetch(`${c.userId}/threads_insights`, {
        metric: 'followers_count', period: 'lifetime', access_token: c.token,
      });
      const n = Number(d.data?.find(m => m.name === 'followers_count')?.total_value?.value) || 0;
      if (n > 0) out.push({ accountId: String(c.userId), followers: n });
    } catch (e) {
      console.error('Threads sampleFollowers failed for', c.userId, e.message);
    }
  }
  return out;
}

module.exports = { cacheInvalidate, testConnection, sampleFollowers, getConsentUrl, exchangeCode, appendAccountFromCode, saveCredentials, refreshToken, refreshAccountTokens, getStats, getAllPosts, getAudience, syncComments, replyToComment, deleteComment, getMe, publishContent, deletePost };
