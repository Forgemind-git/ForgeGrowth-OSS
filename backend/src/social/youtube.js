const socialEnv = require('./env');
// ============================================================
// youtube.js — YouTube Data API v3 + Analytics API service
// ============================================================
const { google } = require('googleapis');
// YouTube uses the googleapis client (not fetch), so gate explicitly. Quota is
// 10k units/day — generous vs our usage — so this is a light safety throttle.
const { gate } = require('./rateLimiter');
const ytGate = () => gate('yt', 'channel', { max: 60, windowMs: 100000, maxWaitMs: 20000 });
const pool = require('./db');

const CHANNEL_ID = socialEnv.YOUTUBE_CHANNEL_ID;
// OAuth callback. Explicit YT_REDIRECT_URI wins; else derive from PUBLIC_BASE_URL
// (single per-deployment var); else the production fallback.
const YT_REDIRECT = socialEnv.YT_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/youtube/callback' : '');

// ── Cache (15min stats, 5min status) ────────────────────────
const cache = new Map();
const CACHE_TTL = {
  stats:  5 * 60 * 1000,
  status:  5 * 60 * 1000,
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

async function getRefreshToken() {
  const fromDb = await getSetting('youtube_refresh_token');
  return fromDb || socialEnv.YOUTUBE_REFRESH_TOKEN || null;
}

function createAuthClient(refreshToken) {
  const oauth2 = new google.auth.OAuth2(
    socialEnv.YT_GOOGLE_CLIENT_ID,
    socialEnv.YT_GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

// ── Public API ───────────────────────────────────────────────
// cred (optional): { refreshToken, accountKey } — when given, acts on THAT account
// instead of the legacy app_settings credential (the primary account).
async function testConnection(force = false, cred = null) {
  if (!force && !cred) {
    const cached = cacheGet('status');
    if (cached) return cached;
  }
  const refreshToken = cred?.refreshToken || await getRefreshToken();
  if (!refreshToken) {
    return { connected: false, error: 'No credentials saved', hasCredentials: false };
  }
  try {
    const auth = createAuthClient(refreshToken);
    const yt = google.youtube({ version: 'v3', auth });
    const { data } = await yt.channels.list({
      part: 'snippet,statistics',
      mine: true,
    });
    const channel = data.items?.[0];
    if (!channel) throw new Error('No channel found for this account');

    const result = {
      connected: true,
      hasCredentials: true,
      profile: {
        name: channel.snippet.title,
        channelId: channel.id,
        subscribers: parseInt(channel.statistics.subscriberCount || '0', 10),
        videoCount: parseInt(channel.statistics.videoCount || '0', 10),
        thumbnailUrl: channel.snippet.thumbnails?.default?.url || null,
      },
    };
    if (!cred) cacheSet('status', result, CACHE_TTL.status);
    return result;
  } catch (err) {
    return { connected: false, hasCredentials: true, error: err.message };
  }
}

async function saveCredentials({ refreshToken }) {
  await setSetting('youtube_refresh_token', refreshToken);
  // Reconnecting mints a fresh refresh token — clear any stale validation error
  // so the token-health banner doesn't keep showing "needs reconnection".
  // (Mirrors the social_accounts reconnect path which clears needs_reconnect.)
  await pool.query(`DELETE FROM app_settings WHERE key = 'youtube_token_refresh_error'`);
  cacheInvalidate('');
}

// Google refresh tokens don't expire on a clock, but they DO die on revocation
// (myaccount.google.com), password change, or 6-month inactivity for unverified
// apps — always surfacing as `invalid_grant`. Validate by minting an access
// token; flag dead refresh tokens for reconnection.
async function validateTokens() {
  const results = [];
  const check = async (refreshToken) => {
    const auth = createAuthClient(refreshToken);
    await auth.getAccessToken();   // throws invalid_grant when the refresh token is dead
  };
  const legacy = await getRefreshToken();
  if (legacy) {
    try {
      await check(legacy);
      results.push({ accountKey: 'primary', ok: true });
    } catch (e) {
      results.push({ accountKey: 'primary', ok: false, error: e.message, dead: /invalid_grant/i.test(e.message) });
    }
  }
  const { rows } = await pool.query(
    `SELECT id, account_key, refresh_token FROM social_accounts
      WHERE platform = 'youtube' AND refresh_token IS NOT NULL`);
  for (const a of rows) {
    try {
      await check(a.refresh_token);
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
      const dead = /invalid_grant/i.test(e.message);
      await pool.query(
        `UPDATE social_accounts
            SET last_refresh_error = $2, needs_reconnect = needs_reconnect OR $3
          WHERE id = $1`,
        [a.id, String(e.message).slice(0, 500), dead]);
      results.push({ accountKey: a.account_key, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Stats ─────────────────────────────────────────────────────
// Calls: channels.list (1 quota) + videos.list (1 quota) + 3 Analytics calls (free)
// ── Audience insights — viewer demographics, countries, traffic sources ──
// 3 Analytics calls (1 quota unit each), cached 24h. Demographics use a 90-day
// window — YouTube needs sustained watch volume before it reports them at all.
async function getAudience(cred = null) {
  const cacheKey = `audience:${cred?.accountKey || 'primary'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const refreshToken = cred?.refreshToken || await getRefreshToken();
  if (!refreshToken) return { available: false, reason: 'YouTube is not connected' };
  await ytGate();

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 2);            // analytics data lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 89);
  const fmt = (d) => d.toISOString().split('T')[0];

  const analytics = google.youtubeAnalytics({ version: 'v2', auth: createAuthClient(refreshToken) });
  const q = (params) => analytics.reports.query({
    ids: 'channel==MINE', startDate: fmt(startDate), endDate: fmt(endDate), ...params,
  }).catch(() => ({ data: { rows: [] } }));

  const [demoRes, countryRes, trafficRes] = await Promise.all([
    q({ dimensions: 'ageGroup,gender', metrics: 'viewerPercentage', sort: '-viewerPercentage' }),
    q({ dimensions: 'country', metrics: 'views', sort: '-views', maxResults: 10 }),
    q({ dimensions: 'insightTrafficSourceType', metrics: 'views', sort: '-views' }),
  ]);

  // ageGroup rows: ['age18-24', 'female', 12.3] → split into age + gender lists
  const ageAcc = {}, genderAcc = {};
  for (const [ageGroup, gender, pctVal] of (demoRes.data.rows || [])) {
    const ageLabel = String(ageGroup).replace(/^age/, '');
    ageAcc[ageLabel] = (ageAcc[ageLabel] || 0) + (pctVal || 0);
    const gLabel = String(gender).charAt(0).toUpperCase() + String(gender).slice(1);
    genderAcc[gLabel] = (genderAcc[gLabel] || 0) + (pctVal || 0);
  }
  const toList = (acc, suffix) => Object.entries(acc)
    .map(([label, value]) => ({ label, value: parseFloat(value.toFixed(1)), suffix }))
    .sort((a, b) => b.value - a.value);

  const TRAFFIC_LABELS = {
    YT_SEARCH: 'YouTube search', RELATED_VIDEO: 'Suggested videos', EXT_URL: 'External links',
    NO_LINK_OTHER: 'Direct / unknown', PLAYLIST: 'Playlists', SUBSCRIBER: 'Subscriber feed',
    YT_CHANNEL: 'Channel pages', NOTIFICATION: 'Notifications', SHORTS: 'Shorts feed',
    YT_OTHER_PAGE: 'Other YouTube pages', ADVERTISING: 'Ads', PROMOTED: 'Promoted',
    ANNOTATION: 'Annotations', CAMPAIGN_CARD: 'Campaign cards', END_SCREEN: 'End screens',
    HASHTAGS: 'Hashtags', SOUND_PAGE: 'Sound pages', LIVE_REDIRECT: 'Live redirects',
    VIDEO_REMIXES: 'Remixes', IMMERSIVE_LIVE: 'Immersive live',
  };
  const trafficSources = (trafficRes.data.rows || [])
    .map(([type, views]) => ({ label: TRAFFIC_LABELS[type] || type, value: views || 0 }))
    .filter(r => r.value > 0);

  const age     = toList(ageAcc, '%');
  const gender  = toList(genderAcc, '%');
  const country = (countryRes.data.rows || []).map(([cc, views]) => ({ label: cc, value: views || 0 }));

  const result = {
    available: !!(age.length || country.length || trafficSources.length),
    age: age.length ? age : null,
    gender: gender.length ? gender : null,
    country: country.length ? country : null,
    trafficSources: trafficSources.length ? trafficSources : null,
    windowDays: 90,
  };
  // DB-persisted last-good copy (<=7 days) so a failed fetch never hides the section.
  const storeKey = `audience_cache:youtube:${cred?.accountKey || 'primary'}`;
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

async function getStats(period = '30D', cred = null) {
  const cacheKey = `stats:${period}:${cred?.accountKey || 'primary'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const refreshToken = cred?.refreshToken || await getRefreshToken();
  if (!refreshToken) return null;
  await ytGate();

  const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90, 'Custom': 45 };
  const days = PERIOD_DAYS[period] || 30;

  // YouTube Analytics has a 1-2 day data lag
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 2);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  const prevEndDate = new Date(startDate);
  prevEndDate.setDate(prevEndDate.getDate() - 1);
  const prevStartDate = new Date(prevEndDate);
  prevStartDate.setDate(prevStartDate.getDate() - days + 1);

  const fmt = (d) => d.toISOString().split('T')[0];

  const auth = createAuthClient(refreshToken);
  const yt = google.youtube({ version: 'v3', auth });
  const analytics = google.youtubeAnalytics({ version: 'v2', auth });

  const [channelRes, currentRes, prevRes, videoRes] = await Promise.all([
    // 1. Channel totals (subscribers, video count) — contentDetails carries the
    // uploads playlist id used below to spot videos too new for Analytics.
    yt.channels.list({ part: 'snippet,statistics,contentDetails', mine: true }),

    // 2. Current period: daily breakdown (averageViewPercentage appended LAST so
    //    existing positional destructuring stays valid)
    analytics.reports.query({
      ids: 'channel==MINE',
      startDate: fmt(startDate),
      endDate:   fmt(endDate),
      metrics:   'views,estimatedMinutesWatched,subscribersGained,subscribersLost,averageViewDuration,likes,comments,shares,averageViewPercentage',
      dimensions: 'day',
      sort:       'day',
    }).catch(() => ({ data: { rows: [] } })),

    // 3. Previous period: views only (for delta)
    analytics.reports.query({
      ids: 'channel==MINE',
      startDate: fmt(prevStartDate),
      endDate:   fmt(prevEndDate),
      metrics:   'views,subscribersGained',
      dimensions: 'day',
      sort:       'day',
    }).catch(() => ({ data: { rows: [] } })),

    // 4. Top videos in period by views (averageViewPercentage appended last)
    analytics.reports.query({
      ids: 'channel==MINE',
      startDate: fmt(startDate),
      endDate:   fmt(endDate),
      metrics:   'views,estimatedMinutesWatched,likes,comments,shares,averageViewDuration,averageViewPercentage',
      dimensions: 'video',
      sort:       '-views',
      maxResults: 10,
    }).catch(() => ({ data: { rows: [] } })),
  ]);

  // ── Channel profile ────────────────────────────────────────
  const channel = channelRes.data.items?.[0];
  const stats   = channel?.statistics || {};
  const totalSubscribers = parseInt(stats.subscriberCount || '0', 10);

  // ── Aggregate daily rows ───────────────────────────────────
  // columns: day, views, estimatedMinutesWatched, subscribersGained, subscribersLost, averageViewDuration, likes, comments, shares
  const rows = currentRes.data.rows || [];
  let totalViews = 0, totalMinutes = 0, totalSubsGained = 0, totalSubsLost = 0;
  let totalLikes = 0, totalComments = 0, _totalShares = 0, lastAvgDur = 0;
  let pctWeighted = 0, pctViews = 0;
  const trendDays = [], netGainPerDay = [];

  for (const row of rows) {
    const [day, views, minutes, subsGained, subsLost, avgDur, likes, comments] = row;
    const avgPct = row[8];   // averageViewPercentage (appended last)
    totalViews      += views       || 0;
    totalMinutes    += minutes     || 0;
    totalSubsGained += subsGained  || 0;
    totalSubsLost   += subsLost    || 0;
    totalLikes      += likes       || 0;
    totalComments   += comments    || 0;
    if (avgDur) lastAvgDur = avgDur;
    if (avgPct != null && views > 0) { pctWeighted += avgPct * views; pctViews += views; }
    netGainPerDay.push((subsGained || 0) - (subsLost || 0));
    trendDays.push(new Date(day).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
  }
  // View-weighted average % of each video watched across the period.
  const avgViewedPct = pctViews > 0 ? parseFloat((pctWeighted / pctViews).toFixed(1)) : null;

  // ── Subscriber trend ───────────────────────────────────────
  const totalNetGain  = netGainPerDay.reduce((s, v) => s + v, 0);
  const baseSubscribers = Math.max(0, totalSubscribers - totalNetGain);
  let running = baseSubscribers;
  const trendData = netGainPerDay.map(gain => { running += gain; return running; });

  // ── Derived metrics ────────────────────────────────────────
  const netGrowth    = totalSubsGained - totalSubsLost;
  const growthPct    = baseSubscribers > 0 ? parseFloat((netGrowth / baseSubscribers * 100).toFixed(1)) : 0;
  const watchTimeHrs = Math.round(totalMinutes / 60);
  const avgViewDur   = formatDuration(lastAvgDur);
  const engRate      = totalViews > 0
    ? parseFloat(((totalLikes + totalComments) / totalViews * 100).toFixed(2))
    : 0;

  const pctChange = (curr, prev) =>
    !prev ? 0 : parseFloat(((curr - prev) / prev * 100).toFixed(1));

  // ── Previous period ────────────────────────────────────────
  const prevRows = prevRes.data.rows || [];
  let prevViews = 0, _prevSubsGained = 0;
  for (const row of prevRows) {
    prevViews      += row[1] || 0;
    _prevSubsGained += row[2] || 0;
  }

  // ── Top videos ─────────────────────────────────────────────
  // Analytics video rows lag 1-2 days — a video uploaded today is absent and
  // its counts are stale. Workaround within quota: pull the uploads playlist
  // (1 unit) for brand-new video ids, then fetch LIVE statistics for the whole
  // set via videos.list (1 unit, also realtime within minutes). Live counts
  // overlay the lagged analytics; watch-time/AVD stay analytics-only (no
  // realtime source exists for those).
  const videoRows = videoRes.data.rows || [];
  let recentIds = [];
  try {
    const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (uploadsId) {
      const { data: pl } = await yt.playlistItems.list({ part: 'contentDetails', playlistId: uploadsId, maxResults: 10 });
      const cutoff = startDate.getTime();
      recentIds = (pl.items || [])
        .filter(i => new Date(i.contentDetails?.videoPublishedAt || 0).getTime() >= cutoff)
        .map(i => i.contentDetails?.videoId)
        .filter(Boolean);
    }
  } catch (_) {}
  const videoIds = [...new Set([...videoRows.slice(0, 10).map(r => r[0]), ...recentIds])];
  let videoMeta = {};
  if (videoIds.length > 0) {
    try {
      const { data: vd } = await yt.videos.list({ part: 'snippet,contentDetails,statistics', id: videoIds.join(',') });
      for (const item of vd.items || []) {
        videoMeta[item.id] = {
          title:       item.snippet.title,
          description: item.snippet.description || '',
          url:         `https://youtu.be/${item.id}`,
          date:        new Date(item.snippet.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
          ts:          item.snippet.publishedAt,
          duration:    item.contentDetails?.duration || null,
          liveViews:    item.statistics?.viewCount    != null ? parseInt(item.statistics.viewCount, 10)    : null,
          liveLikes:    item.statistics?.likeCount    != null ? parseInt(item.statistics.likeCount, 10)    : null,
          liveComments: item.statistics?.commentCount != null ? parseInt(item.statistics.commentCount, 10) : null,
        };
      }
    } catch (_) {}
  }

  const avgVideoViews = totalViews / Math.max(videoRows.length, 1);
  const mapVideo = (row) => {
    const [vid, rawViews, minutes, rawLikes, rawComments,, avgDur] = row;
    const meta  = videoMeta[vid] || {};
    // Live overlay: for a video published INSIDE the period, lifetime counts ==
    // period counts (it didn't exist before), so the realtime Data-API numbers
    // are strictly fresher than the 1-2 day lagged Analytics row. Older videos
    // keep their analytics period numbers (lifetime would inflate them).
    const publishedInPeriod = meta.ts && new Date(meta.ts) >= startDate;
    const views    = publishedInPeriod && meta.liveViews    != null ? meta.liveViews    : (rawViews    || 0);
    const likes    = publishedInPeriod && meta.liveLikes    != null ? meta.liveLikes    : (rawLikes    || 0);
    const comments = publishedInPeriod && meta.liveComments != null ? meta.liveComments : (rawComments || 0);
    const eng   = (likes || 0) + (comments || 0);
    const wt    = Math.round((minutes || 0) / 60);
    const durSec = parseIsoDuration(meta.duration);
    const titleLower = (meta.title || '').toLowerCase();
    const descLower  = (meta.description || '').toLowerCase();
    const isShort = durSec > 0 && durSec <= 60 && (titleLower.includes('#shorts') || descLower.includes('#shorts'));
    return {
      id:        vid,
      title:     meta.title || vid,
      date:      meta.date  || '',
      views:     views       || 0,
      eng,
      clicks:    null,
      score:     Math.min(99, Math.max(40, Math.round(((views || 0) / Math.max(avgVideoViews, 1)) * 75))),
      likes:     likes    || 0,
      comments:  comments || 0,
      shares:    0,
      watchTime: wt ? `${wt}h` : null,
      avd:       formatDuration(avgDur),
      // averageViewPercentage rides at index 7 (appended last); synthesized
      // fresh-upload rows don't have it yet → null until Analytics catches up.
      avgViewedPct: row[7] != null ? parseFloat(Number(row[7]).toFixed(1)) : null,
      ctr:       null,
      permalink: meta.url || null,
      thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      timestamp: meta.ts || null,
      media_type: isShort ? 'Short' : 'Video',
    };
  };
  // Brand-new uploads have NO analytics row yet (1-2 day lag) — synthesize one
  // from the live Data-API statistics so a video posted minutes ago shows up
  // immediately instead of vanishing until Analytics catches up.
  const knownIds = new Set(videoRows.map(r => r[0]));
  const freshRows = recentIds
    .filter(id => !knownIds.has(id) && videoMeta[id])
    .map(id => {
      const m = videoMeta[id];
      return [id, m.liveViews || 0, 0, m.liveLikes || 0, m.liveComments || 0, 0, 0];
    });

  const allPosts = [...freshRows, ...videoRows].map(mapVideo)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  const topPosts = allPosts.slice(0, 4);

  const result = {
    key: 'youtube',
    platform: { name: 'YouTube', short: 'YT', color: '#CC0000', bg: '#FCEAEA', textOnBg: '#8A0F0F' },
    followers:        totalSubscribers,
    growth:           netGrowth,
    growthPct,
    impressions:      totalViews,
    reach:            null,
    engagementRate:   engRate,
    clicks:           null,
    posts:            allPosts.length,
    scaledGrowth:     netGrowth,
    impressionsDelta: pctChange(totalViews, prevViews),
    reachDelta:       null,
    engagementDelta:  0,
    clicksDelta:      null,
    postsDelta:       0,
    extras: [
      { label: 'Watch Time (hrs)',   value: watchTimeHrs,             info: 'Total hours users spent watching your YouTube videos.' },
      { label: 'Avg. View Duration', value: avgViewDur,  raw: true,   info: 'Average time users spend watching each video.' },
      { label: 'Subscribers Gained', value: totalSubsGained,          info: 'New YouTube subscribers acquired during the period.' },
      { label: 'Subscribers Lost',   value: totalSubsLost,            info: 'Subscribers who unsubscribed during the period.' },
      ...(avgViewedPct != null
        ? [{ label: 'Avg % Viewed', value: `${avgViewedPct}%`, raw: true, info: 'Average percentage of each video that viewers actually watch (view-weighted) — the retention signal YouTube ranks by.' }] : []),
    ],
    topPosts,
    allPosts,
    // allPosts = videos with Analytics views in the period (any publish date), NOT
    // a listing of uploads — a low-view video is absent, not deleted. syncService
    // must not prune from it; getAllPosts (full uploads listing) does that.
    allPostsPrunable: false,
    trend:     trendData.length ? trendData : [totalSubscribers],
    trendDays: trendDays.length ? trendDays : ['Now'],
    isReal:    true,
  };

  cacheSet(cacheKey, result, CACHE_TTL.stats);
  return result;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseIsoDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || 0, 10);
  const m = parseInt(match[2] || 0, 10);
  const s = parseInt(match[3] || 0, 10);
  return h * 3600 + m * 60 + s;
}

function getConsentUrl(state) {
  const oauth2 = new google.auth.OAuth2(
    socialEnv.YT_GOOGLE_CLIENT_ID,
    socialEnv.YT_GOOGLE_CLIENT_SECRET,
    YT_REDIRECT,
  );
  return oauth2.generateAuthUrl({
    access_type:  'offline',
    prompt:       'consent',
    state:        state || undefined,
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      // force-ssl is required to POST comment replies (comments.insert) from the
      // Inbox. Reading comments works on youtube.readonly; replies stay blocked
      // until the user reconnects to grant this scope.
      'https://www.googleapis.com/auth/youtube.force-ssl',
      // upload is required to publish videos/shorts via videos.insert (Composer).
      'https://www.googleapis.com/auth/youtube.upload',
    ],
  });
}

async function exchangeCode(code) {
  const oauth2 = new google.auth.OAuth2(
    socialEnv.YT_GOOGLE_CLIENT_ID,
    socialEnv.YT_GOOGLE_CLIENT_SECRET,
    YT_REDIRECT,
  );
  const { tokens } = await oauth2.getToken(code);
  if (tokens.refresh_token) {
    await saveCredentials({ refreshToken: tokens.refresh_token });
  }
  return tokens;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL videos (not just recent period) for the Content Library.
async function getAllPosts(cred = null) {
  const refreshToken = cred?.refreshToken || await getRefreshToken();
  if (!refreshToken) return [];
  await ytGate();

  const auth = createAuthClient(refreshToken);
  const yt = google.youtube({ version: 'v3', auth });

  // 1. Resolve the channel's "uploads" playlist (videos.list has no `mine`)
  const ch = await yt.channels.list({ part: 'contentDetails', mine: true });
  const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  // 2. Page through every uploaded video
  const items = [];
  let pageToken = null;
  do {
    const { data } = await yt.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId: uploads,
      maxResults: 50,
      pageToken: pageToken || undefined,
    });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  // 3. Fetch durations + LIFETIME statistics in batches of 50 — statistics ride
  //    the same call for free, so Content Library videos carry real view/like/
  //    comment counts instead of hardcoded zeros (refreshed every backfill).
  const ids = items.map(i => i.contentDetails?.videoId).filter(Boolean);
  const durations = {}, liveStats = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const { data } = await yt.videos.list({ part: 'contentDetails,statistics', id: ids.slice(i, i + 50).join(',') });
      for (const v of data.items || []) {
        durations[v.id] = v.contentDetails?.duration || null;
        liveStats[v.id] = v.statistics || {};
      }
    } catch (_) { /* best-effort */ }
  }

  return items.map(item => {
    const vid = item.contentDetails?.videoId;
    const sn = item.snippet || {};
    const durSec = parseIsoDuration(durations[vid]);
    const titleLower = (sn.title || '').toLowerCase();
    const descLower = (sn.description || '').toLowerCase();
    const isShort = durSec > 0 && durSec <= 60 && (titleLower.includes('#shorts') || descLower.includes('#shorts'));
    const st = liveStats[vid] || {};
    const views    = parseInt(st.viewCount    || '0', 10);
    const likes    = parseInt(st.likeCount    || '0', 10);
    const comments = parseInt(st.commentCount || '0', 10);

    return {
      id: vid,
      title: sn.title || vid,
      date: new Date(sn.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views,
      eng: likes + comments,
      clicks: null,
      score: 50,
      likes,
      comments,
      shares: 0,
      watchTime: null,
      avd: formatDuration(durSec),
      ctr: null,
      permalink: `https://youtu.be/${vid}`,
      thumbnail: sn.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      timestamp: sn.publishedAt,
      media_type: isShort ? 'Short' : 'Video',
    };
  });
}

// ── Comments (Inbox) ─────────────────────────────────────────
// YouTube has NO comment webhook, so we poll. commentThreads.list with
// allThreadsRelatedToChannelId pulls every comment+reply on the channel's videos
// for ~1 quota unit/page (cheap against the 10k/day budget).
// IMPORTANT: the comment endpoints require youtube.force-ssl for BOTH reading and
// replying — youtube.readonly is NOT sufficient (verified live: a readonly token
// returns insufficientPermissions on commentThreads.list). So the user must
// reconnect YouTube once to grant force-ssl before any comments appear.
let _ytChannelId = null;
let _lastCommentSync = 0;

async function _resolveChannelId(yt) {
  if (CHANNEL_ID) return CHANNEL_ID;
  if (_ytChannelId) return _ytChannelId;
  const { data } = await yt.channels.list({ part: 'id', mine: true });
  _ytChannelId = data.items?.[0]?.id || null;
  return _ytChannelId;
}

// YouTube's textDisplay is HTML (entities + <br> + <a> link tags). Convert it to
// the plain text our UI renders. textOriginal (raw) is preferred when available
// (own comments); decode is a no-op on already-plain text. Decode &amp; LAST to
// avoid double-decoding sequences like &amp;#39;.
function decodeHtml(s) {
  if (!s) return s || null;
  return s
    .replace(/<br\s*\/?>/gi, '\n')                                   // line breaks
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')                         // keep link/mention text
    .replace(/<[^>]+>/g, '')                                         // strip any other tags
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    || null;
}

async function _storeComment(c, fallbackVideoId, parentId) {
  const sn = c.snippet || {};
  await pool.query(
    `INSERT INTO youtube_comments
       (comment_id, video_id, parent_id, author_name, author_channel_id, author_pic, text, like_count, raw, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (comment_id) DO UPDATE
       SET text = EXCLUDED.text, like_count = EXCLUDED.like_count, raw = EXCLUDED.raw,
           refreshed_at = now()`,
    [
      c.id, sn.videoId || fallbackVideoId || null, parentId,
      sn.authorDisplayName || null, sn.authorChannelId?.value || null, sn.authorProfileImageUrl || null,
      decodeHtml(sn.textOriginal || sn.textDisplay), sn.likeCount || 0,
      JSON.stringify(c), sn.publishedAt ? new Date(sn.publishedAt) : null,
    ]
  ).catch(() => {});
}

async function syncComments({ force = false, fast = false } = {}) {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return 0;
  if (!force && Date.now() - _lastCommentSync < 15000) return 0;
  _lastCommentSync = Date.now();

  const yt = google.youtube({ version: 'v3', auth: createAuthClient(refreshToken) });
  const channelId = await _resolveChannelId(yt);
  if (!channelId) return 0;

  // fast mode (5-min lane): one page only — `order: time` puts the newest 100
  // threads first, plenty for a 5-min window at 1 quota unit. The 30-min full
  // run keeps the 5-page depth (and is the only one allowed to prune).
  const maxPages = fast ? 1 : 5;
  let count = 0, pageToken, pages = 0, complete = true;
  const videoIds = new Set(), seenIds = [];
  do {
    let data;
    try {
      ({ data } = await yt.commentThreads.list({
        part: 'snippet,replies',
        allThreadsRelatedToChannelId: channelId,
        maxResults: 100,
        order: 'time',
        pageToken,
      }));
    } catch (e) {
      const reason = e?.errors?.[0]?.reason || '';
      const msg = e?.errors?.[0]?.message || e?.message || '';
      // Missing comment permission is actionable — surface it so the UI can tell
      // the user to reconnect (readonly token can't read comments).
      if (e?.code === 403 || /insufficientpermissions|forbidden|insufficient/i.test(reason + msg)) {
        throw new Error('Reading YouTube comments needs the youtube.force-ssl permission. Reconnect YouTube from Settings.');
      }
      // Other errors (e.g. a channel that rejects allThreadsRelatedToChannelId) —
      // stop gracefully rather than fail the whole sync run.
      complete = false;
      break;
    }
    for (const thread of (data.items || [])) {
      const videoId = thread.snippet?.videoId || null;
      const top = thread.snippet?.topLevelComment;
      if (videoId) videoIds.add(String(videoId));
      if (top) { await _storeComment(top, videoId, null); seenIds.push(String(top.id)); count++; }
      for (const reply of (thread.replies?.comments || [])) {
        await _storeComment(reply, videoId, reply.snippet?.parentId || top?.id || null);
        seenIds.push(String(reply.id));
        count++;
      }
    }
    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < maxPages);

  // YouTube ToS compliance (Developer Policies III.E.4): stored API data must
  // be refreshed or deleted within 30 calendar days. Recent comments refresh on
  // every poll (refreshed_at bumps on upsert); rows the API hasn't re-confirmed
  // in 30 days — the long tail beyond the polling window — must be deleted.
  // They still exist on YouTube; this only ages them out of OUR store.
  if (!fast) {
    const purged = await pool.query(
      `DELETE FROM youtube_comments
        WHERE COALESCE(refreshed_at, created_at) < now() - interval '30 days'`
    ).catch(() => null);
    // Deleting is still the correct action when we cannot refresh — but a dead
    // credential turns it into silent data loss (a disconnected channel quietly
    // empties the whole store 30 days later). `complete` is false exactly when
    // the API listing failed, so say which case this was.
    if (purged && purged.rowCount) {
      console.warn(
        `YT compliance purge: deleted ${purged.rowCount} comment(s) not re-confirmed in 30 days` +
        (complete ? '' : ' — WARNING: this run could not reach the YouTube API, so nothing could be refreshed; check the channel connection'));
    }
  }

  // Deletion reconciliation — only when the listing finished cleanly (no error
  // break, no page-cap truncation, not the shallow fast lane): a truncated
  // listing would make older comments look deleted. Comments removed/moderated
  // on YouTube directly then disappear from the Inbox instead of lingering.
  if (!fast && complete && !pageToken && videoIds.size) {
    await pool.query(
      `DELETE FROM youtube_comments
        WHERE video_id = ANY($1::text[])
          AND comment_id <> ALL($2::text[])
          AND created_at < now() - interval '5 minutes'`,
      [[...videoIds], seenIds.length ? seenIds : ['__none__']]
    ).catch(() => {});
  }
  return count;
}

// Reply to a comment as the channel. parentId MUST be a top-level comment id
// (YouTube only nests one level). Needs youtube.force-ssl — until the user
// reconnects to grant it, comments.insert returns 403.
async function replyToComment({ parentId, text }) {
  if (!parentId)     throw new Error('parentId is required');
  if (!text?.trim()) throw new Error('Reply text is required');
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('YouTube is not connected');

  const yt = google.youtube({ version: 'v3', auth: createAuthClient(refreshToken) });
  try {
    const { data } = await yt.comments.insert({
      part: 'snippet',
      requestBody: { snippet: { parentId, textOriginal: text.trim() } },
    });
    // Persist our reply tagged with the channel identity so it shows the channel
    // name + avatar immediately and survives reload (next poll also refreshes it).
    try {
      const parent = await pool.query('SELECT video_id FROM youtube_comments WHERE comment_id = $1', [parentId]);
      const status = await testConnection();
      await pool.query(
        `INSERT INTO youtube_comments
           (comment_id, video_id, parent_id, author_name, author_channel_id, author_pic, text, like_count, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,now())
         ON CONFLICT (comment_id) DO UPDATE SET text = EXCLUDED.text`,
        [data.id, parent.rows[0]?.video_id || null, parentId,
         status.profile?.name || 'Channel', status.profile?.channelId || null,
         status.profile?.thumbnailUrl || null, text.trim()]
      );
    } catch (_) { /* best-effort persistence */ }
    return { id: data.id };
  } catch (e) {
    const m = e?.errors?.[0]?.message || e?.message || 'Reply failed';
    if (e?.code === 403 || /insufficient|scope|forbidden|permission/i.test(m))
      throw new Error('Replying needs the youtube.force-ssl permission. Reconnect YouTube with reply access from Settings.');
    throw new Error(m);
  }
}

// Delete/remove a comment. Needs youtube.force-ssl. comments.delete only works
// on OUR OWN comments; for a viewer's comment on our video we moderate it to
// 'rejected' (YouTube's only API path to remove others' comments from public view).
async function deleteComment(commentId) {
  if (!commentId) throw new Error('commentId is required');
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('YouTube is not connected');
  const yt = google.youtube({ version: 'v3', auth: createAuthClient(refreshToken) });

  let ours = false;
  try {
    const { rows } = await pool.query('SELECT author_channel_id FROM youtube_comments WHERE comment_id = $1', [commentId]);
    const myId = (await testConnection()).profile?.channelId;
    ours = !!myId && rows[0]?.author_channel_id === myId;
  } catch (_) {}

  const scopeErr = () => new Error('Deleting needs the youtube.force-ssl permission. Reconnect YouTube with manage access from Settings.');
  try {
    if (ours) await yt.comments.delete({ id: commentId });
    else      await yt.comments.setModerationStatus({ id: commentId, moderationStatus: 'rejected' });
  } catch (e) {
    const msg = e?.errors?.[0]?.message || e?.message || 'Delete failed';
    // If a delete on a supposedly-own comment is forbidden, fall back to moderation.
    if (ours && (e?.code === 403 || /forbidden|insufficient/i.test(msg))) {
      try { await yt.comments.setModerationStatus({ id: commentId, moderationStatus: 'rejected' }); }
      catch (_) { throw scopeErr(); }
    } else if (e?.code === 403 || /insufficient|scope|forbidden/i.test(msg)) {
      throw scopeErr();
    } else {
      throw new Error(msg);
    }
  }
  await pool.query('DELETE FROM youtube_comments WHERE comment_id = $1 OR parent_id = $1', [commentId]).catch(() => {});
  return { ok: true };
}

// Add a NEW account from an OAuth code (the "Add account" flow) — stores it in
// social_accounts (append) instead of overwriting the legacy primary credential.
async function appendAccountFromCode(code) {
  const oauth2 = new google.auth.OAuth2(
    socialEnv.YT_GOOGLE_CLIENT_ID, socialEnv.YT_GOOGLE_CLIENT_SECRET, YT_REDIRECT);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('No refresh token returned — revoke the app at myaccount.google.com/permissions and reconnect.');
  const status = await testConnection(true, { refreshToken: tokens.refresh_token });
  if (!status.connected) throw new Error(status.error || 'Could not verify the channel');
  await pool.query(
    `INSERT INTO social_accounts (platform, account_key, label, username, refresh_token)
     VALUES ('youtube', $1, $2, NULL, $3)
     ON CONFLICT (platform, account_key) DO UPDATE
       SET refresh_token = EXCLUDED.refresh_token, label = EXCLUDED.label, last_error = NULL, hidden = false,
           needs_reconnect = false, last_refresh_error = NULL`,
    [status.profile.channelId, status.profile.name, tokens.refresh_token]);
  return { accountKey: status.profile.channelId, label: status.profile.name };
}

// ── Content publishing (LIVE) ────────────────────────────────
// Uploads a video via videos.insert (resumable). Needs the youtube.upload scope
// (reconnect to grant). Reads the media file off disk — the googleapis client
// streams it directly, so the file must exist in UPLOADS_DIR. videos.insert costs
// ~1600 quota units, so uploads are inherently limited (~6/day on the default quota).
const fs = require('fs');
const path = require('path');
const YT_UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';

// Resolve a refresh token for the job's account (or the legacy primary).
async function _refreshTokenFor(accountKey) {
  if (accountKey) {
    const { rows } = await pool.query(
      `SELECT refresh_token FROM social_accounts
        WHERE platform = 'youtube' AND account_key = $1 AND refresh_token IS NOT NULL LIMIT 1`, [accountKey]);
    if (rows[0]?.refresh_token) return rows[0].refresh_token;
  }
  return getRefreshToken();
}

// Map a /api/uploads/<name> URL to its on-disk path.
function _localPath(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('/api/social/uploads/')) return path.join(YT_UPLOADS_DIR, path.basename(url));
  if (/^https?:\/\//.test(url)) return null; // remote — can't stream from disk
  return path.join(YT_UPLOADS_DIR, path.basename(url));
}

// Publish a job to YouTube. Returns { ok, simulated:false, externalId, permalink }.
async function publishVideo(job) {
  if (job.post_type === 'community')
    throw new Error('YouTube community posts can\'t be created via the API — only video uploads are supported.');
  const media = Array.isArray(job.media) ? job.media : [];
  const vid = media.find(m => String(m.mime || '').toLowerCase().startsWith('video')) || media[0];
  if (!vid) throw new Error('YouTube requires a video file');
  const fpath = _localPath(vid.url);
  if (!fpath || !fs.existsSync(fpath))
    throw new Error('The video file is missing on disk — re-upload it to the media library and try again.');

  const refreshToken = await _refreshTokenFor(job.account_id || null);
  if (!refreshToken) throw new Error('YouTube is not connected. Connect it on the Integrations page.');
  const yt = google.youtube({ version: 'v3', auth: createAuthClient(refreshToken) });

  const d = job.details || {};
  let title = (d.title || job.caption || 'Untitled').toString().slice(0, 100);
  let description = (d.description || job.caption || '').toString().slice(0, 5000);
  // Shorts are just regular uploads; the #Shorts tag helps YouTube classify them.
  if (job.post_type === 'short' && !/#shorts/i.test(title + description))
    description = (description ? description + '\n\n' : '') + '#Shorts';
  const tags = Array.isArray(d.tags) ? d.tags.map(String) : (typeof d.tags === 'string' ? d.tags.split(',').map(s => s.trim()).filter(Boolean) : undefined);
  // The composer's field id is `visibility` (postTypes.js); accept `privacy` too
  // as a fallback. Reading the wrong key silently forced every upload to public.
  const chosenPrivacy = d.visibility || d.privacy;
  const privacyStatus = ['public', 'private', 'unlisted'].includes(chosenPrivacy) ? chosenPrivacy : 'public';

  await ytGate();
  let resp;
  try {
    resp = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description, tags, categoryId: d.categoryId || undefined },
        status: { privacyStatus, selfDeclaredMadeForKids: !!d.madeForKids },
      },
      media: { body: fs.createReadStream(fpath) },
    });
  } catch (e) {
    const m = e?.errors?.[0]?.message || e.message || 'YouTube upload failed';
    if (e?.code === 403 || /insufficient|scope|forbidden|permission/i.test(m))
      throw new Error('Uploading needs the youtube.upload permission. Reconnect YouTube with publish access from Settings.');
    if (/quota/i.test(m)) throw new Error('YouTube upload quota exceeded for today — try again tomorrow.');
    throw new Error(m);
  }
  const videoId = resp.data.id;

  // Custom thumbnail — a SEPARATE thumbnails.set call (videos.insert ignores it).
  // Best-effort: the video is already live, so a thumbnail failure must NOT fail
  // the job. Custom thumbnails require a verified YouTube channel; an unverified
  // channel returns 403 here, which is the usual reason a thumbnail "doesn't show".
  let warning;
  if (d.thumbnailUrl) {
    try {
      const tpath = _localPath(d.thumbnailUrl);
      if (tpath && fs.existsSync(tpath)) {
        const mimeType = path.extname(tpath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        await ytGate();
        await yt.thumbnails.set({ videoId, media: { mimeType, body: fs.createReadStream(tpath) } });
      } else {
        warning = 'Thumbnail file was missing on disk, so the video was published without a custom thumbnail.';
        console.warn('[youtube] thumbnail file not found:', d.thumbnailUrl);
      }
    } catch (e) {
      const m = e?.errors?.[0]?.message || e.message || 'thumbnail upload failed';
      warning = /verif|forbidden|permission/i.test(m)
        ? 'Video published, but the custom thumbnail was rejected — custom thumbnails require a verified YouTube channel (verify at youtube.com/verify).'
        : `Video published, but the custom thumbnail failed: ${m}`;
      console.warn('[youtube] thumbnails.set failed for', videoId, '-', m);
    }
  }

  return { ok: true, simulated: false, externalId: String(videoId), permalink: `https://www.youtube.com/watch?v=${videoId}`, warning };
}

// Delete an already-published video. Used by the Publish log.
async function deletePost(externalId, accountKey = null) {
  const refreshToken = await _refreshTokenFor(accountKey);
  if (!refreshToken) throw new Error('YouTube is not connected');
  const yt = google.youtube({ version: 'v3', auth: createAuthClient(refreshToken) });
  await ytGate();
  try {
    await yt.videos.delete({ id: externalId });
  } catch (e) {
    const m = e?.errors?.[0]?.message || e.message || 'Delete failed';
    if (e?.code === 403 || /insufficient|scope|forbidden/i.test(m))
      throw new Error('Deleting needs the youtube.force-ssl/upload permission. Reconnect YouTube from Settings.');
    throw new Error(m);
  }
  return { ok: true };
}

// ── Cheap follower (subscriber) sampler ──────────────────────
// ONE channels.list call per connected channel (1 quota unit), so the daily
// subscriber series keeps advancing even when the Analytics-heavy getStats run
// fails or is skipped — that is why YouTube's samples went silent before.
async function sampleFollowers() {
  const creds = [{ refreshToken: null }];   // legacy/primary credential
  try {
    const { rows } = await pool.query(
      `SELECT account_key, refresh_token FROM social_accounts
        WHERE platform = 'youtube' AND refresh_token IS NOT NULL AND NOT COALESCE(hidden, false)`);
    for (const r of rows) creds.push({ accountKey: r.account_key, refreshToken: r.refresh_token });
  } catch (_) {}

  const out = [];
  for (const c of creds) {
    try {
      const status = await testConnection(false, c.refreshToken ? { refreshToken: c.refreshToken } : null);
      if (!status.connected) {
        // Almost always an expired refresh token (Google expires them after 7
        // days while the OAuth consent screen is in "Testing"). Say so — a silent
        // skip is what let YouTube's follower history go stale unnoticed.
        console.error('YT sampleFollowers: channel not connected —', status.error || 'no credentials');
        continue;
      }
      const id = String(status.profile?.channelId || c.accountKey || 'primary');
      const n = Number(status.profile?.subscribers) || 0;
      if (n > 0 && !out.some(o => o.accountId === id)) out.push({ accountId: id, followers: n });
    } catch (e) {
      console.error('YT sampleFollowers failed:', e.message);
    }
  }
  return out;
}

module.exports = { cacheInvalidate, testConnection, sampleFollowers, saveCredentials, validateTokens, getStats, getAllPosts, getAudience, getConsentUrl, exchangeCode, appendAccountFromCode, syncComments, replyToComment, deleteComment, publishVideo, deletePost };
