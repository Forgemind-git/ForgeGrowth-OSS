const socialEnv = require('./env');
// ============================================================
// facebook.js — Facebook Page Insights service
// ============================================================
const pool = require('./db');
// Rate-limited fetch (gates graph.facebook.com per token via Redis).
const fetch = require('./rateLimiter').gatedFetch;

const PAGE_ID     = socialEnv.FACEBOOK_PAGE_ID     || '';
// Read on every use (not captured at load): the App ID/secret can be saved
// later in Settings → Integrations and must apply without a restart.
const appId = () => socialEnv.FACEBOOK_APP_ID;
const appSecret = () => socialEnv.FACEBOOK_APP_SECRET;
const REDIRECT_URI = socialEnv.FACEBOOK_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/facebook/callback' : '');
const GRAPH       = 'https://graph.facebook.com/v20.0';

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

async function getPageToken() {
  return await getSetting('facebook_page_token') || socialEnv.FACEBOOK_PAGE_TOKEN || null;
}

// ── Graph API helper ─────────────────────────────────────────
async function graphFetch(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(String(k), String(v));
  }
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(`FB API: ${json.error.message} (code ${json.error.code})`);
  return json;
}

// ── Public API ───────────────────────────────────────────────
async function testConnection(force = false, cred = null) {
  if (!force && !cred) {
    const cached = cacheGet('status');
    if (cached) return cached;
  }
  const token  = cred?.pageToken || await getPageToken();
  const pageId = cred?.pageId || PAGE_ID;
  if (!token) return { connected: false, hasCredentials: false, error: 'No page token saved' };
  try {
    const data = await graphFetch(pageId, {
      fields: 'fan_count,name,username,picture{url}',
      access_token: token,
    });
    const result = {
      connected: true,
      hasCredentials: true,
      profile: {
        id:         pageId,
        name:       data.name,
        username:   data.username || null,
        fans:       data.fan_count || 0,
        pictureUrl: data.picture?.data?.url || null,
      },
    };
    if (!cred) cacheSet('status', result, CACHE_TTL.status);
    return result;
  } catch (err) {
    return { connected: false, hasCredentials: true, error: err.message };
  }
}

async function savePageToken({ pageToken, pageName }) {
  await setSetting('facebook_page_token', pageToken);
  if (pageName) await setSetting('facebook_page_name', pageName);
  // Reconnecting saves a fresh page token — clear any stale validation error so
  // the token-health banner doesn't keep showing "needs reconnection".
  await pool.query(`DELETE FROM app_settings WHERE key = 'facebook_token_refresh_error'`);
  cacheInvalidate('');
}

// Manual token path — the escape hatch when OAuth can't mint a Page token.
//
// This app's FACEBOOK_APP_ID is a Business-type (WhatsApp) app, so its login dialog
// grants scopes but attaches no Page asset: /me/accounts comes back empty and the
// OAuth reconnect can never produce a token. A Business Manager SYSTEM USER token
// sidesteps that entirely — it is issued against the Page directly, never expires,
// and (unlike a user-derived token) survives a password change, which is what killed
// the previous credential.
//
// Accepts either a system-user token or an already-page-scoped token, and resolves
// whichever it got down to a real Page token. Never log the value.
async function saveManualToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) throw new Error('Paste an access token first.');
  if (!PAGE_ID) throw new Error('FACEBOOK_PAGE_ID is not configured on the server.');

  const probe = async (path, params = {}) => {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const r = await fetch(`${GRAPH}/${path}?${qs}`);
    return r.json();
  };

  // 1) System-user (or admin user) token → ask the Page for its own page-scoped token.
  const direct = await probe(PAGE_ID, { fields: 'id,name,access_token' });
  if (direct?.access_token) {
    await savePageToken({ pageToken: direct.access_token, pageName: direct.name });
    return { pageName: direct.name, kind: 'derived' };
  }

  // 2) A token that already IS page-scoped can read the Page but won't hand back an
  //    access_token field. If it can see the Page, it works as-is.
  const asPage = await probe(PAGE_ID, { fields: 'id,name' });
  if (asPage?.id === PAGE_ID) {
    await savePageToken({ pageToken: token, pageName: asPage.name });
    return { pageName: asPage.name, kind: 'page' };
  }

  // Neither worked — surface Meta's own reason rather than a generic failure.
  const reason = direct?.error?.message || asPage?.error?.message || 'the token cannot read the Page';
  throw new Error(`That token does not grant access to Page ${PAGE_ID}: ${reason}`);
}

// Upsert one Page post into the shared `posts` table — mirrors instagram.js
// _upsertIgPost. Comes free with the comment-sync fetch, so a post published
// on Facebook appears in the Content Library / Inbox cards within the fast-lane
// interval. Metrics stay COALESCE/GREATEST-guarded so the richer stats sync
// (engagement counts, score) is never downgraded by this lightweight pass.
async function _upsertFbPost(p) {
  if (!p?.id) return;
  await pool.query(
    `INSERT INTO posts
       (platform_id, external_id, title, caption, type, media_type, date,
        views, engagements, likes, comments, shares, saves, clicks, score,
        permalink, thumbnail_url, account_key, fetched_at)
     SELECT id, $1, $2, $3, 'Post', 'Post', $4, 0, 0, 0, 0, 0, 0, 0, 0, $5, $6, $7, now()
       FROM platforms WHERE key = 'facebook' LIMIT 1
     ON CONFLICT (platform_id, external_id) DO UPDATE SET
       caption       = COALESCE(EXCLUDED.caption,    posts.caption),
       title         = COALESCE(NULLIF(EXCLUDED.title,''), posts.title),
       date          = COALESCE(EXCLUDED.date,       posts.date),
       permalink     = COALESCE(EXCLUDED.permalink,  posts.permalink),
       thumbnail_url = COALESCE(posts.thumbnail_url, EXCLUDED.thumbnail_url)`,
    [
      p.id,
      (p.message || '').slice(0, 80) || 'Facebook post',
      p.message || null,
      p.created_time ? new Date(p.created_time).toISOString().slice(0, 10) : null,
      p.permalink_url || null,
      p.full_picture || null,
      PAGE_ID,
    ]
  ).catch(() => {});
}

// FB page tokens (derived from a long-lived user token) have no expiry and no
// refresh API — but they DO die when the user changes password, revokes the
// app, or Meta invalidates the session. The only proactive option is to
// validate them and flag dead ones for reconnection.
async function validateTokens() {
  const results = [];
  const legacy = await getPageToken();
  if (legacy) {
    try {
      await graphFetch('me', { fields: 'id,name', access_token: legacy });
      results.push({ accountKey: 'primary', ok: true });
    } catch (e) {
      const dead = /expired|invalid|session|deauthorized|code 190/i.test(e.message);
      results.push({ accountKey: 'primary', ok: false, error: e.message, dead });
    }
  }
  const { rows } = await pool.query(
    `SELECT id, account_key, token FROM social_accounts
      WHERE platform = 'facebook' AND token IS NOT NULL`);
  for (const a of rows) {
    try {
      await graphFetch('me', { fields: 'id,name', access_token: a.token });
      await pool.query(
        `UPDATE social_accounts
            SET last_refresh_at = now(), last_refresh_error = NULL, needs_reconnect = false
          WHERE id = $1`, [a.id]);
      results.push({ accountKey: a.account_key, ok: true });
    } catch (e) {
      // Transient (network/rate-limit) errors say nothing about the token — skip.
      if (/fetch failed|network|econn|etimedout|socket hang|rate.?limited|timed?\s?out|temporar/i.test(e.message)) {
        results.push({ accountKey: a.account_key, ok: true, skipped: true });
        continue;
      }
      const dead = /expired|invalid|session|deauthorized|code 190/i.test(e.message);
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

function getConsentUrl(state) {
  if (!appId()) throw new Error('The Meta App ID is not set — add it in Social → Settings → Integrations.');
  const url = new URL('https://www.facebook.com/v20.0/dialog/oauth');
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  // Scopes (all need a reconnect to take effect; the write/PII ones need App Review):
  //  - pages_read_engagement     → comment TEXT + timestamps (already working)
  //  - pages_read_user_content   → the comment's `from` object (commenter name/id/picture).
  //      Without it Meta OMITS `from` entirely, so the Inbox shows "Facebook user" + initials.
  //  - pages_manage_engagement   → POST comment replies from the Inbox.
  //  - pages_manage_posts        → PUBLISH posts/photos/videos/reels to the Page (Composer).
  //  - pages_messaging           → READ and reply to Messenger conversations (Social → Messenger).
  url.searchParams.set('scope', 'pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_engagement,pages_manage_posts,pages_messaging,read_insights');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state || 'forgesocial_fb');
  return url.toString();
}

// Exchange an OAuth code → long-lived user token → the admin's Pages (id, name, token).
async function _exchangeForPages(code) {
  if (!appId())     throw new Error('The Meta App ID is not set — add it in Social → Settings → Integrations.');
  if (!appSecret()) throw new Error('The Meta App secret is not set — add it in Social → Settings → Integrations.');

  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?client_id=${appId()}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${appSecret()}&code=${encodeURIComponent(code)}`
  );
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error.message);

  // Long-lived user token (page tokens derived from it never expire)
  const llRes = await fetch(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId()}&client_secret=${appSecret()}&fb_exchange_token=${encodeURIComponent(tokenData.access_token)}`
  );
  const llData = await llRes.json();
  if (llData.error) throw new Error(llData.error.message);

  const accountsRes = await fetch(`${GRAPH}/me/accounts?fields=id,name,username,access_token,picture{url}&access_token=${encodeURIComponent(llData.access_token)}`);
  const accountsData = await accountsRes.json();
  if (accountsData.error) throw new Error(accountsData.error.message);
  const pages = accountsData.data || [];

  // An empty Page list means the grant itself was incomplete — a declined scope, or a
  // consent dialog where no Page was ticked. Meta reports this as success + zero rows,
  // so surface WHO logged in and WHICH scopes actually landed; otherwise every failure
  // mode looks identical from the outside.
  if (!pages.length) {
    const [me, perms] = await Promise.all([
      fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(llData.access_token)}`).then(r => r.json()).catch(() => ({})),
      fetch(`${GRAPH}/me/permissions?access_token=${encodeURIComponent(llData.access_token)}`).then(r => r.json()).catch(() => ({})),
    ]);
    const granted  = (perms.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    const declined = (perms.data || []).filter(p => p.status !== 'granted').map(p => p.permission);
    console.error('[fb-oauth] zero Pages returned.',
      'user=', me.name || me.id || 'unknown',
      '| granted=', granted.join(',') || 'none',
      '| declined=', declined.join(',') || 'none');
    const who = me.name ? `You logged in as ${me.name}. ` : '';
    const why = !granted.includes('pages_show_list')
      ? 'The "pages_show_list" permission was not granted, so Facebook will not reveal any Page to Forge Growth.'
      : 'That account has no Page selected for this app — on the "What do you want to allow" step, open the Pages list and tick your Page (not just "Continue").';
    throw new Error(`${who}Facebook returned no Pages. ${why}`);
  }
  return { longLived: llData.access_token, pages };
}

async function exchangeCode(code) {
  const { pages } = await _exchangeForPages(code);
  const page = pages.find(p => p.id === PAGE_ID);
  if (!page) {
    const found = pages.map(p => `${p.name} (${p.id})`).join(', ') || 'none';
    throw new Error(`Page ${PAGE_ID} not found. Pages found: ${found}. Make sure you logged in as the page admin.`);
  }
  await savePageToken({ pageToken: page.access_token, pageName: page.name });
  return { pageName: page.name };
}

// "Add account" → connect every Page the admin manages. Pages other than the primary
// PAGE_ID become social_accounts rows; the primary keeps living in app_settings, so a
// grant that contains it refreshes its token instead of being discarded. Without that,
// an admin whose only Page IS the primary could never reconnect from this flow — the
// filtered list came back empty and the fresh token was thrown away.
async function appendAccountFromCode(code) {
  const { pages } = await _exchangeForPages(code);   // throws if the grant carried no Pages
  const primary = pages.find(p => p.id === PAGE_ID);
  const extra   = pages.filter(p => p.id !== PAGE_ID);

  if (primary) await savePageToken({ pageToken: primary.access_token, pageName: primary.name });

  for (const p of extra) {
    await pool.query(
      `INSERT INTO social_accounts (platform, account_key, label, username, token, extra)
       VALUES ('facebook', $1, $2, $3, $4, $5)
       ON CONFLICT (platform, account_key) DO UPDATE
         SET token = EXCLUDED.token, label = EXCLUDED.label, username = EXCLUDED.username, last_error = NULL, hidden = false,
             needs_reconnect = false, last_refresh_error = NULL`,
      [p.id, p.name, p.username || null, p.access_token, JSON.stringify({ pageId: p.id })]
    ).catch(() => {});
  }

  const connected = pages.map(p => p.name);
  return { count: pages.length, label: connected.join(', '), reconnectedPrimary: !!primary };
}

// ── Stats ─────────────────────────────────────────────────────
// Available v20 metrics: page_follows (cumulative daily fans), page_views_total,
// page_post_engagements. page_impressions/reach/fan_adds removed in v17+.
// Meta's Nov-2025 deprecation replaced page impressions with a new content-views
// metric, but the exact name differs by rollout ("views" per Meta's blog,
// "page_media_view" per the changelog). Probe the candidates once and remember
// the winner; when none works we keep the old page_views_total proxy (profile
// visits) so nothing regresses on older API versions.
let _fbViewsMetric;   // undefined = not probed, null = unsupported, string = metric name
async function _resolveViewsMetric(token) {
  if (_fbViewsMetric !== undefined) return _fbViewsMetric;
  const until = Math.floor(Date.now() / 1000);
  const since = until - 3 * 86400;
  for (const candidate of ['views', 'page_media_view']) {
    try {
      const d = await graphFetch(`${PAGE_ID}/insights`, {
        metric: candidate, period: 'day', since, until, access_token: token,
      });
      if (d.data?.length) { _fbViewsMetric = candidate; return candidate; }
    } catch (_) { /* try the next candidate */ }
  }
  _fbViewsMetric = null;
  return null;
}

async function getStats(period = '30D') {
  const cacheKey = `stats:${period}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const token = await getPageToken();
  if (!token) return null;
  const viewsMetric = await _resolveViewsMetric(token).catch(() => null);

  const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90, 'Custom': 45 };
  const days = PERIOD_DAYS[period] || 30;

  // Facebook Insights has a ~2-day data lag
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 2);
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

  // Include the resolved content-views metric in the same insights calls (a
  // known-good name can't fail the batch). Falls back to page_views_total proxy.
  const currentMetrics = 'page_follows,page_views_total,page_post_engagements'
    + (viewsMetric ? `,${viewsMetric}` : '');
  const prevMetrics = 'page_views_total' + (viewsMetric ? `,${viewsMetric}` : '');

  const [profileData, insightsData, prevInsightsData, postsData] = await Promise.all([
    // 1. Page profile — followers_count is the "Page Fans → Followers" migration
    //    target; fan_count kept as fallback until Meta retires it.
    graphFetch(PAGE_ID, {
      fields: 'fan_count,followers_count,name,username,picture{url}',
      access_token: token,
    }).catch(() => null),

    // 2. Current period: page_follows = cumulative daily fan count (for trend + growth)
    //    page_views_total = page profile views; resolved views metric = real content views
    //    page_post_engagements = total post interactions
    graphFetch(`${PAGE_ID}/insights`, {
      metric: currentMetrics,
      period: 'day',
      since,
      until,
      access_token: token,
    }).catch(() => ({ data: [] })),

    // 3. Previous period for deltas
    graphFetch(`${PAGE_ID}/insights`, {
      metric: prevMetrics,
      period: 'day',
      since: prevSince,
      until: prevUntil,
      access_token: token,
    }).catch(() => ({ data: [] })),

    // 4. Recent posts with engagement summary
    graphFetch(`${PAGE_ID}/posts`, {
      fields: 'id,message,created_time,permalink_url,full_picture,reactions.summary(true),comments.summary(true),shares',
      limit: 10,
      since,
      until,
      access_token: token,
    }).catch(() => ({ data: [] })),
  ]);

  // ── Parse insights ────────────────────────────────────────
  const metricMap = {};
  for (const metric of insightsData.data || []) {
    metricMap[metric.name] = metric.values || [];
  }

  // page_follows = cumulative daily fan count — use for trend + growth
  const followsValues  = metricMap['page_follows']          || [];
  const pageViewValues = metricMap['page_views_total']       || [];
  const engValues      = metricMap['page_post_engagements']  || [];

  const totalFans = profileData?.followers_count
    ?? profileData?.fan_count
    ?? (followsValues.length ? followsValues[followsValues.length - 1].value : 0);

  // Growth = last value minus first value (page_follows is cumulative)
  const firstDayFans = followsValues.length ? (followsValues[0].value || 0) : totalFans;
  const lastDayFans  = followsValues.length ? (followsValues[followsValues.length - 1].value || totalFans) : totalFans;
  const netGrowth    = lastDayFans - firstDayFans;
  const growthPct    = firstDayFans > 0 ? parseFloat((netGrowth / firstDayFans * 100).toFixed(1)) : 0;

  // Trend from cumulative daily fan snapshots
  const trendDays = [], trendFans = [];
  for (const v of followsValues) {
    trendDays.push(new Date(v.end_time).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
    trendFans.push(v.value || 0);
  }

  let totalPageViews = 0, totalEngagements = 0, totalContentViews = 0;
  for (const v of pageViewValues)  totalPageViews  += v.value || 0;
  for (const v of engValues)       totalEngagements += v.value || 0;
  for (const v of (viewsMetric ? metricMap[viewsMetric] || [] : [])) totalContentViews += v.value || 0;

  // ── Previous period ────────────────────────────────────────
  let prevPageViews = 0, prevContentViews = 0;
  for (const metric of prevInsightsData.data || []) {
    if (metric.name === 'page_views_total') {
      for (const v of metric.values || []) prevPageViews += v.value || 0;
    }
    if (viewsMetric && metric.name === viewsMetric) {
      for (const v of metric.values || []) prevContentViews += v.value || 0;
    }
  }

  const pctChange = (curr, prev) =>
    !prev ? 0 : parseFloat(((curr - prev) / prev * 100).toFixed(1));

  // ── Top posts ──────────────────────────────────────────────
  const postRows = postsData.data || [];
  const avgEng = postRows.length
    ? postRows.reduce((s, p) =>
        s + (p.reactions?.summary?.total_count || 0) + (p.comments?.summary?.total_count || 0) + (p.shares?.count || 0), 0
      ) / postRows.length
    : 0;

  const mapPost = (p, idx) => {
    const reactions = p.reactions?.summary?.total_count || 0;
    const comments  = p.comments?.summary?.total_count  || 0;
    const shares    = p.shares?.count                   || 0;
    const eng       = reactions + comments + shares;
    const msg       = (p.message || '').slice(0, 60) + ((p.message?.length || 0) > 60 ? '…' : '');
    return {
      id:        p.id,
      title:     msg || `Post ${idx + 1}`,
      date:      new Date(p.created_time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views:     0,
      eng,
      clicks:    null,
      score:     Math.min(99, Math.max(40, avgEng > 0 ? Math.round((eng / avgEng) * 70) : 70)),
      likes:     reactions,
      comments,
      shares,
      watchTime: null,
      avd:       null,
      ctr:       null,
      permalink: p.permalink_url || null,
      thumbnail: p.full_picture || null,
      timestamp: p.created_time,
    };
  };
  const allPosts = postRows.map(mapPost);
  const topPosts = allPosts.slice(0, 4);

  const result = {
    key: 'facebook',
    platform: { name: 'Facebook', short: 'FB', color: '#1877F2', bg: '#E7F0FE', textOnBg: '#0A4FA8' },
    followers:        totalFans,
    growth:           netGrowth,
    growthPct,
    // Real content views when the post-deprecation metric resolved; otherwise the
    // old profile-visits proxy (kept so older API versions don't regress).
    impressions:      viewsMetric && totalContentViews > 0 ? totalContentViews : totalPageViews,
    reach:            null,
    engagementRate:   totalEngagements > 0 && totalFans > 0
                        ? parseFloat((totalEngagements / totalFans * 100).toFixed(2))
                        : 0,
    clicks:           null,
    posts:            postRows.length,
    scaledGrowth:     netGrowth,
    impressionsDelta: viewsMetric && totalContentViews > 0
                        ? pctChange(totalContentViews, prevContentViews)
                        : pctChange(totalPageViews, prevPageViews),
    reachDelta:       null,
    engagementDelta:  0,
    clicksDelta:      null,
    postsDelta:       0,
    extras: [
      ...(viewsMetric && totalContentViews > 0
        ? [{ label: 'Content Views', value: totalContentViews, info: 'Times your content appeared on screens (Meta\'s replacement for impressions), including repeat views.' }] : []),
      { label: 'Page Views',       value: totalPageViews,   info: 'Total views of your Facebook page profile during the period.' },
      { label: 'Post Engagements', value: totalEngagements, info: 'Total interactions (reactions + comments + shares) across all posts.' },
      { label: 'Fans at Start',    value: firstDayFans,     info: 'Total page followers at the start of the period.' },
      { label: 'Fans Gained',      value: netGrowth,        info: 'Net new followers gained during the period.' },
    ],
    topPosts,
    allPosts,
    trend:     trendFans.length ? trendFans : [totalFans],
    trendDays: trendDays.length ? trendDays : ['Now'],
    isReal:    true,
  };

  cacheSet(cacheKey, result, CACHE_TTL.stats);
  return result;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL page posts (not just recent period) for the Content Library.
async function getAllPosts(cred = null) {
  const token  = cred?.pageToken || await getPageToken();
  const pageId = cred?.pageId || PAGE_ID;
  if (!token) return [];

  const allPosts = [];
  let url = `${GRAPH}/${pageId}/posts?fields=id,message,created_time,permalink_url,full_picture,reactions.summary(true),comments.summary(true),shares&limit=100&access_token=${token}`;

  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error('Facebook getAllPosts error:', data.error);
      break;
    }
    allPosts.push(...(data.data || []));
    url = data.paging?.next || null;
  }

  return allPosts.map(p => {
    const reactions = p.reactions?.summary?.total_count || 0;
    const comments = p.comments?.summary?.total_count || 0;
    const shares = p.shares?.count || 0;
    const eng = reactions + comments + shares;
    const msg = p.message || '';
    return {
      id: p.id,
      title: msg.slice(0, 80) + (msg.length > 80 ? '…' : '') || 'Post',
      date: new Date(p.created_time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views: 0,
      eng,
      clicks: null,
      score: 50,
      likes: reactions,
      comments,
      shares,
      permalink: p.permalink_url || null,
      thumbnail: p.full_picture || null,
      timestamp: p.created_time,
    };
  });
}

// ── Comments (Inbox) ─────────────────────────────────────────
// Polls comments on recent Page posts and stores them for the Inbox. ONE Graph
// call per run (recent posts + their comment stream, flat incl. replies via
// filter(stream)). Reading needs only pages_read_engagement; a short cooldown
// keeps the on-demand Refresh from hammering the API.
let _lastCommentSync = 0;

async function syncComments({ force = false } = {}) {
  const token = await getPageToken();
  if (!token) return 0;
  if (!force && Date.now() - _lastCommentSync < 15000) return 0;
  _lastCommentSync = Date.now();

  const data = await graphFetch(`${PAGE_ID}/posts`, {
    // likes.summary(true) gives total_count + has_liked (did WE like it) without
    // pulling the liker list (.limit(0)). message/created_time/full_picture ride
    // along free so brand-new Page posts land in the `posts` table on the SAME
    // call — no extra rate budget, and the Inbox/Library see them within the
    // fast-lane interval instead of waiting for the next full stats sync.
    fields: 'id,message,created_time,permalink_url,full_picture,comments.filter(stream).limit(50){id,message,created_time,from{id,name,picture},parent,like_count,permalink_url,likes.summary(true).limit(0)}',
    limit: 25,
    access_token: token,
  });

  let count = 0;
  const postIds = [], seenIds = [];
  for (const post of (data.data || [])) {
    postIds.push(String(post.id));
    await _upsertFbPost(post);
    for (const c of (post.comments?.data || [])) {
      const summary = c.likes?.summary;
      const likeCount = (summary && typeof summary.total_count === 'number') ? summary.total_count : (c.like_count || 0);
      const likedByUs = summary?.has_liked === true;
      await pool.query(
        `INSERT INTO facebook_comments
           (comment_id, post_id, parent_id, from_id, from_name, from_pic, message, like_count, liked_by_us, permalink, raw, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (comment_id) DO UPDATE
           SET message = EXCLUDED.message, like_count = EXCLUDED.like_count,
               liked_by_us = EXCLUDED.liked_by_us, raw = EXCLUDED.raw`,
        [
          c.id, post.id, c.parent?.id || null,
          c.from?.id || null, c.from?.name || null, c.from?.picture?.data?.url || null,
          c.message || null, likeCount, likedByUs, c.permalink_url || post.permalink_url || null,
          JSON.stringify(c), c.created_time ? new Date(c.created_time) : null,
        ]
      ).catch(() => {});
      seenIds.push(String(c.id));
      count++;
    }
  }
  // Deletion reconciliation: comments removed ON Facebook still sat in the Inbox
  // forever (polling only upserts). Drop rows for the polled posts whose ids are
  // gone from the stream. Scoped to fetched posts only; the 5-min age guard keeps
  // a just-posted reply (persisted locally before the poll sees it) alive.
  if (postIds.length) {
    await pool.query(
      `DELETE FROM facebook_comments
        WHERE post_id = ANY($1::text[])
          AND comment_id <> ALL($2::text[])
          AND created_at < now() - interval '5 minutes'`,
      [postIds, seenIds.length ? seenIds : ['__none__']]
    ).catch(() => {});
  }
  return count;
}

// Reply to a comment as the Page. Needs the pages_manage_engagement scope on the
// Page token — until granted (reconnect) the Graph API returns a permission error,
// which we surface as a friendly "reconnect with reply access" message.
async function replyToComment({ commentId, message }) {
  if (!commentId)        throw new Error('commentId is required');
  if (!message?.trim())  throw new Error('Reply text is required');
  const token = await getPageToken();
  if (!token) throw new Error('Facebook is not connected');

  const res = await fetch(`${GRAPH}/${commentId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message.trim(), access_token: token }),
  });
  const json = await res.json();
  if (json.error) {
    const m = json.error.message || 'Reply failed';
    if (/permission|manage_engagement|scope|(#?\b200\b)/i.test(m))
      throw new Error('Replying needs the pages_manage_engagement permission. Reconnect Facebook with reply access from Settings.');
    throw new Error(m);
  }

  // Persist our reply right away tagged with the Page identity. The poll only
  // re-fetches recent posts, so a reply on an older post would otherwise never
  // be stored — and our own reply must show the Page name + picture, not "You".
  try {
    const parent = await pool.query('SELECT post_id FROM facebook_comments WHERE comment_id = $1', [commentId]);
    const status = await testConnection();
    await pool.query(
      `INSERT INTO facebook_comments
         (comment_id, post_id, parent_id, from_id, from_name, from_pic, message, like_count, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,now())
       ON CONFLICT (comment_id) DO UPDATE SET message = EXCLUDED.message`,
      [json.id, parent.rows[0]?.post_id || null, commentId, PAGE_ID,
       status.profile?.name || 'Page', status.profile?.pictureUrl || null, message.trim()]
    );
  } catch (_) { /* persistence is best-effort; the optimistic UI still shows it */ }

  return { id: json.id };
}

// Delete a comment (our own reply OR a user's comment on our Page). Needs
// pages_manage_engagement. FB cascades replies on its side; mirror that locally.
async function deleteComment(commentId) {
  if (!commentId) throw new Error('commentId is required');
  const token = await getPageToken();
  if (!token) throw new Error('Facebook is not connected');

  const res = await fetch(`${GRAPH}/${commentId}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
  const json = await res.json();
  if (json.error) {
    const m = json.error.message || 'Delete failed';
    if (/permission|manage_engagement|scope/i.test(m))
      throw new Error('Deleting needs the pages_manage_engagement permission. Reconnect Facebook with manage access from Settings.');
    throw new Error(m);
  }
  await pool.query('DELETE FROM facebook_comments WHERE comment_id = $1 OR parent_id = $1', [commentId]).catch(() => {});
  return { ok: true };
}

// Like / unlike a comment AS the Page. POST/DELETE on the comment's likes edge;
// needs pages_manage_engagement. The DB nudge is best-effort — the next poll
// reconciles like_count + liked_by_us from likes.summary(has_liked).
async function likeComment(commentId, like = true) {
  if (!commentId) throw new Error('commentId is required');
  const token = await getPageToken();
  if (!token) throw new Error('Facebook is not connected');

  const res = await fetch(`${GRAPH}/${commentId}/likes?access_token=${encodeURIComponent(token)}`, { method: like ? 'POST' : 'DELETE' });
  const json = await res.json();
  if (json.error) {
    const m = json.error.message || (like ? 'Like failed' : 'Unlike failed');
    if (/permission|manage_engagement|scope/i.test(m))
      throw new Error('Liking needs the pages_manage_engagement permission. Reconnect Facebook with manage access from Settings.');
    throw new Error(m);
  }
  await pool.query(
    `UPDATE facebook_comments SET liked_by_us = $2, like_count = GREATEST(0, like_count + $3) WHERE comment_id = $1`,
    [commentId, like, like ? 1 : -1]
  ).catch(() => {});
  return { ok: true, liked: like };
}

// ── Content publishing (LIVE) ────────────────────────────────
// Publishes to a Facebook Page. Needs pages_manage_posts on the Page token.
// Facebook fetches media from the public /api/uploads URL (file_url / url params),
// so files must be present on disk and reachable.
const _fbPublicBase = socialEnv.PUBLIC_BASE_URL || '';
const _fbAbsUrl = (u) => !u ? null : (/^https?:\/\//.test(u) ? u : _fbPublicBase.replace(/\/+$/, '') + u);
const _fbSleep = (ms) => new Promise(r => setTimeout(r, ms));

// Resolve { pageId, token } for the job's account. Falls back to the primary Page.
async function _pageCredsFor(accountId) {
  if (accountId && accountId !== PAGE_ID) {
    const { rows } = await pool.query(
      `SELECT account_key, token, extra FROM social_accounts
        WHERE platform = 'facebook' AND account_key = $1 AND token IS NOT NULL LIMIT 1`, [accountId]);
    if (rows[0]) return { pageId: (rows[0].extra && rows[0].extra.pageId) || rows[0].account_key, token: rows[0].token };
  }
  const token = await getPageToken();
  if (!token) return null;
  return { pageId: accountId || PAGE_ID, token };
}

// POST to the Graph API (form body), with a friendly scope error.
async function _fbPublish(path, params, token) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null) body.set(k, String(v));
  body.set('access_token', token);
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const m = json.error.message || 'Facebook publish error';
    if (/permission|manage_posts|scope|\(#200\)|\(#10\)/i.test(m))
      throw new Error('Publishing needs the pages_manage_posts permission. Reconnect Facebook with publish access from Settings.');
    throw new Error(m);
  }
  return json;
}

// Publish a Reel via the 3-phase video_reels protocol using a hosted file_url.
async function _fbPublishReel(pageId, token, videoUrl, description) {
  const start = await _fbPublish(`${pageId}/video_reels`, { upload_phase: 'start' }, token);
  const videoId = start.video_id;
  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/v20.0/${videoId}`;
  // Hosted upload: tell the rupload host to pull the file from our public URL.
  const up = await fetch(uploadUrl, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: videoUrl } });
  const upJson = await up.json().catch(() => ({}));
  if (upJson.error) throw new Error(upJson.error.message || 'Reel upload failed');
  // Poll until the upload host has the bytes, then finish+publish.
  for (let i = 0; i < 30; i++) {
    const st = await graphFetch(videoId, { fields: 'status', access_token: token }).catch(() => ({}));
    const phase = st.status?.video_status || st.status?.uploading_phase?.status;
    if (phase === 'ready' || phase === 'complete' || st.status?.processing_phase?.status === 'complete') break;
    await _fbSleep(4000);
  }
  await _fbPublish(`${pageId}/video_reels`, { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: description || '' }, token);
  return videoId;
}

// Publish a job to a Facebook Page. Returns { ok, simulated:false, externalId, permalink }.
async function publishContent(job) {
  const creds = await _pageCredsFor(job.account_id || null);
  if (!creds) throw new Error('Facebook is not connected. Connect a Page on the Integrations page.');
  const { pageId, token } = creds;

  const message = (job.caption || '').toString();
  const media   = Array.isArray(job.media) ? job.media : [];
  const isVideo = (m) => String(m && m.mime || '').toLowerCase().startsWith('video');
  const postType = job.post_type;
  const link = job.details && job.details.link ? String(job.details.link) : null;

  let externalId, permalink = null;

  if (postType === 'reel') {
    const m = media.find(isVideo) || media[0];
    if (!m || !isVideo(m)) throw new Error('A Facebook reel needs a video file');
    externalId = await _fbPublishReel(pageId, token, _fbAbsUrl(m.url), message);
  } else if (postType === 'story') {
    const m = media[0];
    if (!m) throw new Error('A Facebook story needs an image or video');
    if (isVideo(m)) {
      // Video story: 2-step (start → finish with file_url).
      const start = await _fbPublish(`${pageId}/video_stories`, { upload_phase: 'start' }, token);
      const videoId = start.video_id;
      const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/v20.0/${videoId}`;
      const up = await fetch(uploadUrl, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: _fbAbsUrl(m.url) } });
      const upJson = await up.json().catch(() => ({})); if (upJson.error) throw new Error(upJson.error.message || 'Story upload failed');
      await _fbSleep(4000);
      const fin = await _fbPublish(`${pageId}/video_stories`, { upload_phase: 'finish', video_id: videoId }, token);
      externalId = fin.post_id || videoId;
    } else {
      // Photo story: upload an unpublished photo, then attach it to a photo_story.
      const photo = await _fbPublish(`${pageId}/photos`, { url: _fbAbsUrl(m.url), published: 'false' }, token);
      const story = await _fbPublish(`${pageId}/photo_stories`, { photo_id: photo.id }, token);
      externalId = story.post_id || photo.id;
    }
  } else {
    // post — text/link, single photo, multi-photo, or single video.
    const videos = media.filter(isVideo);
    const photos = media.filter(m => !isVideo(m));
    if (videos.length) {
      const v = await _fbPublish(`${pageId}/videos`, { file_url: _fbAbsUrl(videos[0].url), description: message }, token);
      externalId = v.id;
    } else if (photos.length === 1) {
      const p = await _fbPublish(`${pageId}/photos`, { url: _fbAbsUrl(photos[0].url), caption: message }, token);
      externalId = p.post_id || p.id;
    } else if (photos.length > 1) {
      // Upload each photo unpublished, then a single feed post with attached_media.
      const ids = [];
      for (const m of photos.slice(0, 10)) {
        const p = await _fbPublish(`${pageId}/photos`, { url: _fbAbsUrl(m.url), published: 'false' }, token);
        ids.push(p.id);
      }
      const params = { message };
      ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
      const post = await _fbPublish(`${pageId}/feed`, params, token);
      externalId = post.id;
    } else {
      if (!message.trim() && !link) throw new Error('A Facebook post needs text, a link, or media');
      const params = { message };
      if (link) params.link = link;
      const post = await _fbPublish(`${pageId}/feed`, params, token);
      externalId = post.id;
    }
  }

  try {
    const info = await graphFetch(String(externalId), { fields: 'permalink_url', access_token: token });
    permalink = info.permalink_url || null;
  } catch { /* best-effort */ }
  return { ok: true, simulated: false, externalId: String(externalId), permalink };
}

// Delete an already-published Page post/photo/video. Used by the Publish log.
async function deletePost(externalId, accountId = null) {
  const creds = await _pageCredsFor(accountId);
  if (!creds) throw new Error('Facebook is not connected');
  const res = await fetch(`${GRAPH}/${externalId}?access_token=${encodeURIComponent(creds.token)}`, { method: 'DELETE' });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.message || 'Delete failed');
  return { ok: true };
}

// Every Page we hold a token for: the primary (app_settings) plus each extra
// Page connected through "Add account". Used by messenger.js.
async function listPageCreds() {
  const out = [];
  const legacy = await getPageToken();
  if (legacy) out.push({ pageId: PAGE_ID, name: await getSetting('facebook_page_name'), token: legacy });
  try {
    const { rows } = await pool.query(
      `SELECT account_key, label, token, extra FROM social_accounts
        WHERE platform = 'facebook' AND token IS NOT NULL AND NOT COALESCE(hidden, false)`);
    for (const r of rows) {
      const pageId = String((r.extra && r.extra.pageId) || r.account_key);
      if (out.some(c => c.pageId === pageId)) continue;
      out.push({ pageId, name: r.label || null, token: r.token });
    }
  } catch (_) {}
  return out;
}

// ── Cheap follower sampler ───────────────────────────────────
// ONE Graph call per connected Page (`?fields=followers_count`) — the daily
// follower time-series must not depend on a full getStats run succeeding.
// Prefers followers_count over the retiring fan_count.
async function sampleFollowers() {
  const creds = [];
  const legacy = await getPageToken();
  if (legacy) creds.push({ accountId: PAGE_ID, pageId: PAGE_ID, token: legacy });
  try {
    const { rows } = await pool.query(
      `SELECT account_key, token, extra FROM social_accounts
        WHERE platform = 'facebook' AND token IS NOT NULL AND NOT COALESCE(hidden, false)`);
    for (const r of rows) {
      if (creds.some(c => c.accountId === r.account_key)) continue;
      creds.push({ accountId: r.account_key, pageId: (r.extra && r.extra.pageId) || r.account_key, token: r.token });
    }
  } catch (_) {}

  const out = [];
  for (const c of creds) {
    try {
      const d = await graphFetch(c.pageId, { fields: 'followers_count,fan_count', access_token: c.token });
      const n = Number(d.followers_count ?? d.fan_count) || 0;
      if (n > 0) out.push({ accountId: String(c.accountId), followers: n });
    } catch (e) {
      console.error('FB sampleFollowers failed for', c.accountId, e.message);
    }
  }
  return out;
}

module.exports = { listPageCreds, cacheInvalidate, testConnection, sampleFollowers, savePageToken, saveManualToken, validateTokens, getStats, getAllPosts, getConsentUrl, exchangeCode, appendAccountFromCode, syncComments, replyToComment, deleteComment, likeComment, publishContent, deletePost };
