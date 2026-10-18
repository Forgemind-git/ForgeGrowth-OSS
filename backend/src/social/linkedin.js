const socialEnv = require('./env');
// ============================================================
// linkedin.js — LinkedIn Company Page analytics service
// ============================================================
const pool = require('./db');
// Rate-limited fetch (gates api.linkedin.com per token via Redis).
const fetch = require('./rateLimiter').gatedFetch;

const LI_API  = 'https://api.linkedin.com/v2';
const LI_AUTH = 'https://www.linkedin.com/oauth/v2';

// ── Cache ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = { stats: 15 * 60 * 1000, status: 5 * 60 * 1000 };

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
  return getSetting('linkedin_access_token');
}

// ── LinkedIn API helpers ─────────────────────────────────────
// rawQuery allows appending List(...) syntax without double-encoding
async function liFetch(path, token, params = {}, rawQuery = '') {
  const baseUrl = path.startsWith('http') ? path : `${LI_API}/${path}`;
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(String(k), String(v));
  }
  const finalUrl = rawQuery ? `${url.toString()}&${rawQuery}` : url.toString();
  const res = await fetch(finalUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  const json = await res.json();
  if (json.status && json.status >= 400) {
    throw new Error(json.message || `LinkedIn API error (${json.status})`);
  }
  return json;
}

// OpenID Connect userinfo — works with openid+profile scopes (no r_liteprofile needed)
async function getUserInfo(token) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json.sub) throw new Error('Invalid token — could not read LinkedIn profile');
  return json; // { sub, name, given_name, family_name, email, picture }
}

// ── OAuth ─────────────────────────────────────────────────────
function getConsentUrl(state) {
  const clientId = socialEnv.LINKEDIN_CLIENT_ID;
  if (!clientId) throw new Error('LINKEDIN_CLIENT_ID not configured');
  const redirectUri = socialEnv.LINKEDIN_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/linkedin/callback' : '');
  const url = new URL(`${LI_AUTH}/authorization`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  // w_organization_social → publish posts AS the company Page (Composer). Needs
  // LinkedIn Marketing Developer Platform approval for production use.
  url.searchParams.set('scope',         'openid profile email w_member_social w_organization_social');
  url.searchParams.set('state',         state || 'forgesocial_li');
  return url.toString();
}

async function exchangeCode(code) {
  const clientId    = socialEnv.LINKEDIN_CLIENT_ID;
  const clientSecret = socialEnv.LINKEDIN_CLIENT_SECRET;
  const redirectUri = socialEnv.LINKEDIN_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/linkedin/callback' : '');
  if (!clientId)     throw new Error('LINKEDIN_CLIENT_ID not configured');
  if (!clientSecret) throw new Error('LINKEDIN_CLIENT_SECRET not configured');

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
  });
  const res  = await fetch(`${LI_AUTH}/accessToken`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  // expires_in is in seconds (typically 5184000 = 60 days)
  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
  await setSetting('linkedin_access_token',     data.access_token);
  await setSetting('linkedin_token_expires_at', expiresAt);
  if (data.refresh_token) await setSetting('linkedin_refresh_token', data.refresh_token);

  // Save member display name via userinfo
  const userInfo = await getUserInfo(data.access_token).catch(() => null);
  if (userInfo?.name) await setSetting('linkedin_member_name', userInfo.name);

  await _detectAndSaveOrg(data.access_token);
  cacheInvalidate('');
  return { ok: true };
}

// Auto-detect the first org the authenticated member admins
async function _detectAndSaveOrg(token) {
  try {
    const acls = await liFetch('organizationAcls', token, {
      q:     'roleAssignee',
      role:  'ADMINISTRATOR',
      state: 'APPROVED',
    });
    const el = acls.elements?.[0];
    if (!el?.organization) return;
    // el.organization is a URN string: "urn:li:organization:12345678"
    const orgId = String(el.organization).split(':').pop();
    await setSetting('linkedin_org_id', orgId);
    const org = await liFetch(`organizations/${orgId}`, token, {
      projection: '(localizedName)',
    }).catch(() => null);
    if (org?.localizedName) await setSetting('linkedin_org_name', org.localizedName);
  } catch (e) {
    console.warn('LinkedIn: could not auto-detect org:', e.message);
  }
}

// ── Manual credential save (fallback) ────────────────────────
async function saveCredentials({ accessToken, orgId }) {
  if (!accessToken) throw new Error('accessToken is required');

  const userInfo = await getUserInfo(accessToken);

  const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  await setSetting('linkedin_access_token',     accessToken);
  await setSetting('linkedin_token_expires_at', expiresAt);
  if (userInfo.name) await setSetting('linkedin_member_name', userInfo.name);
  if (orgId) await setSetting('linkedin_org_id', String(orgId));

  if (!orgId) await _detectAndSaveOrg(accessToken);
  cacheInvalidate('');
  return { displayName: userInfo.name || 'LinkedIn User' };
}

// ── Token refresh ─────────────────────────────────────────────
async function refreshToken() {
  const refreshTok = await getSetting('linkedin_refresh_token');
  if (!refreshTok) throw new Error('No LinkedIn refresh token saved — please re-authorise via OAuth');

  const clientId     = socialEnv.LINKEDIN_CLIENT_ID;
  const clientSecret = socialEnv.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not configured');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshTok,
    client_id:     clientId,
    client_secret: clientSecret,
  });
  const res  = await fetch(`${LI_AUTH}/accessToken`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);

  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
  await setSetting('linkedin_access_token',     data.access_token);
  await setSetting('linkedin_token_expires_at', expiresAt);
  if (data.refresh_token) await setSetting('linkedin_refresh_token', data.refresh_token);
  cacheInvalidate('');

  const daysLeft = Math.round((new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24));
  return { daysLeft };
}

// Refresh secondary LinkedIn org tokens (social_accounts rows). LinkedIn only
// issues refresh tokens to apps with that capability enabled — rows without
// one can't be renewed server-side and are flagged needs_reconnect once they
// get close to expiry.
async function refreshAccountTokens(thresholdDays = 45) {
  const clientId     = socialEnv.LINKEDIN_CLIENT_ID;
  const clientSecret = socialEnv.LINKEDIN_CLIENT_SECRET;
  const { rows } = await pool.query(
    `SELECT id, account_key, token, refresh_token, token_expires_at FROM social_accounts
      WHERE platform = 'linkedin' AND token IS NOT NULL`);
  const results = [];
  for (const a of rows) {
    const daysLeft = a.token_expires_at
      ? (new Date(a.token_expires_at) - Date.now()) / 86400000
      : null;
    if (daysLeft !== null && daysLeft > thresholdDays) {
      results.push({ accountKey: a.account_key, ok: true, skipped: true, daysLeft: Math.round(daysLeft) });
      continue;
    }
    if (!a.refresh_token || !clientId || !clientSecret) {
      // No server-side renewal path — only flag once it's actually close to dying.
      if (daysLeft !== null && daysLeft <= 7) {
        await pool.query(
          `UPDATE social_accounts
              SET last_refresh_error = $2, needs_reconnect = true
            WHERE id = $1`,
          [a.id, 'No refresh token — reconnect via OAuth before expiry']);
        results.push({ accountKey: a.account_key, ok: false, error: 'no refresh token' });
      } else {
        results.push({ accountKey: a.account_key, ok: true, skipped: true });
      }
      continue;
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: a.refresh_token,
        client_id: clientId, client_secret: clientSecret,
      });
      const res  = await fetch(`${LI_AUTH}/accessToken`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error_description || data.error);
      const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000);
      await pool.query(
        `UPDATE social_accounts
            SET token = $2, refresh_token = COALESCE($3, refresh_token),
                token_expires_at = $4, last_refresh_at = now(),
                last_refresh_error = NULL, needs_reconnect = false
          WHERE id = $1`,
        [a.id, data.access_token, data.refresh_token || null, expiresAt]);
      results.push({ accountKey: a.account_key, ok: true, daysLeft: Math.round((data.expires_in || 5184000) / 86400) });
    } catch (e) {
      // Transient (network/rate-limit) errors say nothing about the token — skip.
      if (/fetch failed|network|econn|etimedout|socket hang|rate.?limited|timed?\s?out|temporar/i.test(e.message)) {
        results.push({ accountKey: a.account_key, ok: true, skipped: true });
        continue;
      }
      const dead = /expired|invalid|revoked/i.test(e.message) || (daysLeft !== null && daysLeft <= 0);
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

// ── Connection test ──────────────────────────────────────────
async function testConnection(force = false, cred = null) {
  if (!force && !cred) {
    const cached = cacheGet('status');
    if (cached) return cached;
  }
  const token = cred?.accessToken || await getAccessToken();
  if (!token) return { connected: false, hasCredentials: false, error: 'No access token saved' };

  try {
    const expiresAt = cred ? null : await getSetting('linkedin_token_expires_at');
    const daysLeft  = expiresAt
      ? Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    const userInfo = await getUserInfo(token);
    const orgId = cred?.orgId || await getSetting('linkedin_org_id');
    let orgName = cred ? null : await getSetting('linkedin_org_name');
    if (cred && orgId) {
      try { const org = await liFetch(`organizations/${orgId}`, token, { projection: '(localizedName)' }); orgName = org?.localizedName || null; } catch (_) {}
    }

    const result = {
      connected:      true,
      hasCredentials: true,
      tokenDaysLeft:  daysLeft,
      profile: {
        id:      orgId || userInfo.sub,         // the org (company page) is the account
        name:    orgName || userInfo.name || 'LinkedIn',
        orgId,
        orgName: orgName || null,
      },
    };
    if (!cred) cacheSet('status', result, CACHE_TTL.status);
    return result;
  } catch (err) {
    return { connected: false, hasCredentials: true, error: err.message };
  }
}

// Per-post statistics — organizationalEntityShareStatistics accepts a batched
// shares=List(...)/ugcPosts=List(...) facet returning totalShareStatistics PER
// post (impressions, clicks, reactions, comments, shares). Without this every
// LinkedIn post showed zeros in the Content Library. Best-effort: failures
// leave the zeros in place. ~1-2 calls per batch of <=50 posts.
async function _fetchPostStats(token, orgUrn, postIds) {
  const out = {};
  const groups = [
    ['shares',   postIds.filter(id => /:share:/.test(id))],
    ['ugcPosts', postIds.filter(id => /:ugcPost:/.test(id))],
  ];
  for (const [param, ids] of groups) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const raw = `organizationalEntity=${encodeURIComponent(orgUrn)}&${param}=List(${chunk.map(encodeURIComponent).join(',')})`;
        const d = await liFetch('organizationalEntityShareStatistics', token, { q: 'organizationalEntity' }, raw);
        for (const el of d.elements || []) {
          const key = el.share || el.ugcPost;
          if (key) out[key] = el.totalShareStatistics || {};
        }
      } catch (_) { /* keep zeros for this chunk */ }
    }
  }
  return out;
}

// ── Stats ─────────────────────────────────────────────────────
async function getStats(period = '30D', cred = null) {
  const cacheKey = `stats:${period}:${cred?.accountKey || 'primary'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const token = cred?.accessToken || await getAccessToken();
  if (!token) return null;
  const orgId = cred?.orgId || await getSetting('linkedin_org_id');
  if (!orgId) return null;

  const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90, 'Custom': 45 };
  const days = PERIOD_DAYS[period] || 30;

  // LinkedIn uses millisecond timestamps
  const endDate   = new Date();
  endDate.setDate(endDate.getDate() - 1); // ~1-day lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  const prevEndDate   = new Date(startDate);
  prevEndDate.setDate(prevEndDate.getDate() - 1);
  const prevStartDate = new Date(prevEndDate);
  prevStartDate.setDate(prevStartDate.getDate() - days + 1);

  const startMs     = startDate.getTime();
  const endMs       = endDate.getTime() + 86400000;
  const prevStartMs = prevStartDate.getTime();
  const prevEndMs   = prevEndDate.getTime() + 86400000;

  const orgUrn     = `urn:li:organization:${orgId}`;
  const encodedUrn = encodeURIComponent(orgUrn);

  const [networkData, shareStats, prevShareStats, pageStats, recentPosts] = await Promise.all([
    // 1. Total followers via networkSizes
    liFetch(`networkSizes/${encodedUrn}`, token, { edgeType: 'CompanyFollowedByMember' })
      .catch(() => null),

    // 2. Current period — daily post/share statistics (impressions, clicks, reactions, comments, shares)
    liFetch('organizationalEntityShareStatistics', token, {
      q:                                     'organizationalEntity',
      organizationalEntity:                  orgUrn,
      'timeIntervals.timeGranularityType':   'DAY',
      'timeIntervals.timeRange.start':       startMs,
      'timeIntervals.timeRange.end':         endMs,
    }).catch(() => ({ elements: [] })),

    // 3. Previous period — for delta
    liFetch('organizationalEntityShareStatistics', token, {
      q:                                     'organizationalEntity',
      organizationalEntity:                  orgUrn,
      'timeIntervals.timeGranularityType':   'DAY',
      'timeIntervals.timeRange.start':       prevStartMs,
      'timeIntervals.timeRange.end':         prevEndMs,
    }).catch(() => ({ elements: [] })),

    // 4. Page view statistics
    liFetch('organizationPageStatistics', token, {
      q:                                     'organization',
      organization:                          orgUrn,
      'timeIntervals.timeGranularityType':   'DAY',
      'timeIntervals.timeRange.start':       startMs,
      'timeIntervals.timeRange.end':         endMs,
    }).catch(() => ({ elements: [] })),

    // 5. Recent ugcPosts — List() syntax requires raw query string to avoid double-encoding
    liFetch('ugcPosts', token, { q: 'authors', count: 10 }, `authors=List(${encodedUrn})`)
      .catch(() => ({ elements: [] })),
  ]);

  // ── Total followers ───────────────────────────────────────
  const totalFollowers = networkData?.firstDegreeSize ?? 0;

  // ── Parse share statistics ────────────────────────────────
  let totalImpressions = 0, totalClicks = 0, totalLikes = 0, totalComments = 0, totalShares = 0;
  const trendDays = [], trendValues = [];

  for (const el of shareStats.elements || []) {
    const s = el.totalShareStatistics || {};
    totalImpressions += s.impressionCount || 0;
    totalClicks      += s.clickCount      || 0;
    totalLikes       += s.likeCount       || 0;
    totalComments    += s.commentCount    || 0;
    totalShares      += s.shareCount      || 0;
    if (el.timeRange?.start) {
      trendDays.push(new Date(el.timeRange.start).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
      trendValues.push(totalImpressions);
    }
  }

  // ── Previous period impressions ───────────────────────────
  let prevImpressions = 0;
  for (const el of prevShareStats.elements || []) {
    prevImpressions += (el.totalShareStatistics?.impressionCount || 0);
  }

  // ── Page views ────────────────────────────────────────────
  let totalPageViews = 0;
  for (const el of pageStats.elements || []) {
    const v = el.totalPageStatistics?.views || {};
    totalPageViews +=
      (v.allDesktopPageViews?.pageViews || 0) +
      (v.allMobilePageViews?.pageViews  || 0);
  }

  const pctChange = (curr, prev) =>
    !prev ? 0 : parseFloat(((curr - prev) / prev * 100).toFixed(1));

  const totalEngagements = totalLikes + totalComments + totalShares + totalClicks;
  const engRate = totalFollowers > 0
    ? parseFloat((totalEngagements / totalFollowers * 100).toFixed(2))
    : 0;

  // ── Top posts ─────────────────────────────────────────────
  const postRows = recentPosts.elements || [];
  const postStats = postRows.length
    ? await _fetchPostStats(token, orgUrn, postRows.map(p => p.id).filter(Boolean))
    : {};
  const mapPost = (p, idx) => {
    const shareContent = p.specificContent?.['com.linkedin.ugc.ShareContent'] || {};
    const text = shareContent.shareCommentary?.text || '';
    const safeTruncate = (str, max) => {
      if (!str || str.length <= max) return str;
      return Array.from(str).slice(0, max).join('') + '…';
    };
    const title = safeTruncate(text, 60) || `Post ${idx + 1}`;
    const s = postStats[p.id] || {};
    const likes = s.likeCount || 0, comments = s.commentCount || 0, shares = s.shareCount || 0;
    return {
      id:        p.id,
      title,
      date:      new Date(p.created?.time || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views:     s.impressionCount || 0,
      eng:       likes + comments + shares + (s.clickCount || 0),
      clicks:    s.clickCount ?? null,
      saves:     0,
      score:     70,
      likes,
      comments,
      shares,
      watchTime: null,
      avd:       null,
      ctr:       s.impressionCount > 0 && s.clickCount != null
                   ? parseFloat((s.clickCount / s.impressionCount * 100).toFixed(1))
                   : null,
      permalink: p.id ? `https://www.linkedin.com/feed/update/${p.id}/` : null,
      timestamp: p.created?.time || null,
    };
  };
  const allPosts = postRows.map(mapPost);
  const topPosts = [...allPosts].sort((a, b) => (b.eng || 0) - (a.eng || 0)).slice(0, 4);

  const result = {
    key:      'linkedin',
    platform: { name: 'LinkedIn', short: 'IN', color: '#0A66C2', bg: '#E3EEF8', textOnBg: '#053F7A' },
    followers:        totalFollowers,
    growth:           0,
    growthPct:        0,
    impressions:      totalImpressions,
    reach:            null,
    engagementRate:   engRate,
    clicks:           totalClicks,
    posts:            postRows.length,
    scaledGrowth:     0,
    impressionsDelta: pctChange(totalImpressions, prevImpressions),
    reachDelta:       null,
    engagementDelta:  0,
    clicksDelta:      null,
    postsDelta:       0,
    extras: [
      { label: 'Page Views',  value: totalPageViews,  info: 'Total views of your LinkedIn company page during the period.' },
      { label: 'Post Clicks', value: totalClicks,      info: 'Clicks on links and media within your LinkedIn posts.' },
      { label: 'Reactions',   value: totalLikes,       info: 'Total likes and reactions on your LinkedIn content.' },
      { label: 'Comments',    value: totalComments,    info: 'Total comments received on your LinkedIn posts.' },
    ],
    topPosts,
    allPosts,
    trend:     trendValues.length ? trendValues : [totalImpressions],
    trendDays: trendDays.length   ? trendDays   : ['Now'],
    isReal:    true,
  };

  cacheSet(cacheKey, result, CACHE_TTL.stats);
  return result;
}

// ── Full historical post sync ────────────────────────────────
// Fetches ALL ugcPosts (not just recent) for the Content Library.
async function getAllPosts(cred = null) {
  const token = cred?.accessToken || await getAccessToken();
  const orgId = cred?.orgId || await getSetting('linkedin_org_id');
  if (!token || !orgId) return [];

  const orgUrn = `urn:li:organization:${orgId}`;
  const encodedUrn = encodeURIComponent(orgUrn);

  const allPosts = [];
  let start = 0;
  const count = 100;

  while (true) {
    const data = await liFetch('ugcPosts', token, { q: 'authors', count, start }, `authors=List(${encodedUrn})`)
      .catch(() => ({ elements: [] }));
    const elements = data.elements || [];
    allPosts.push(...elements);
    if (elements.length < count) break;
    start += count;
  }

  // Batched per-post statistics so the Content Library carries real numbers
  // (was hardcoded zeros). Chunked inside _fetchPostStats; best-effort.
  const orgUrnFull = `urn:li:organization:${orgId}`;
  const postStats = allPosts.length
    ? await _fetchPostStats(token, orgUrnFull, allPosts.map(p => p.id).filter(Boolean))
    : {};

  return allPosts.map((p, idx) => {
    const shareContent = p.specificContent?.['com.linkedin.ugc.ShareContent'] || {};
    const text = shareContent.shareCommentary?.text || '';
    const safeTruncate = (str, max) => {
      if (!str || str.length <= max) return str;
      return Array.from(str).slice(0, max).join('') + '…';
    };
    const title = safeTruncate(text, 60) || `Post ${idx + 1}`;
    const s = postStats[p.id] || {};
    const likes = s.likeCount || 0, comments = s.commentCount || 0, shares = s.shareCount || 0;
    return {
      id: p.id,
      title,
      date: new Date(p.created?.time || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
      views: s.impressionCount || 0,
      eng: likes + comments + shares + (s.clickCount || 0),
      clicks: s.clickCount ?? null,
      saves: 0,
      score: 50,
      likes,
      comments,
      shares,
      permalink: p.id ? `https://www.linkedin.com/feed/update/${p.id}/` : null,
      timestamp: p.created?.time || null,
    };
  });
}

// "Add account" → connect every LinkedIn organization the member admins (except
// the primary linkedin_org_id) as social_accounts rows (same token, per-org).
async function appendAccountFromCode(code) {
  const clientId = socialEnv.LINKEDIN_CLIENT_ID, clientSecret = socialEnv.LINKEDIN_CLIENT_SECRET;
  const redirectUri = socialEnv.LINKEDIN_REDIRECT_URI || (socialEnv.PUBLIC_BASE_URL ? socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/api/social/linkedin/callback' : '');
  if (!clientId || !clientSecret) throw new Error('LinkedIn app not configured');

  const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
  const data = await (await fetch(`${LI_AUTH}/accessToken`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })).json();
  if (data.error) throw new Error(data.error_description || data.error);
  const token = data.access_token;
  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();

  const primaryOrg = await getSetting('linkedin_org_id');
  const acls = await liFetch('organizationAcls', token, { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' });
  const orgs = [...new Set((acls.elements || []).map(e => String(e.organization).split(':').pop()).filter(Boolean))]
    .filter(id => id !== primaryOrg);
  if (!orgs.length) throw new Error('No additional LinkedIn organizations found on this account.');

  const labels = [];
  for (const orgId of orgs) {
    let orgName = null;
    try { const org = await liFetch(`organizations/${orgId}`, token, { projection: '(localizedName)' }); orgName = org?.localizedName || null; } catch (_) {}
    await pool.query(
      `INSERT INTO social_accounts (platform, account_key, label, token, refresh_token, token_expires_at, extra)
       VALUES ('linkedin', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform, account_key) DO UPDATE
         SET token=EXCLUDED.token, refresh_token=COALESCE(EXCLUDED.refresh_token, social_accounts.refresh_token),
             label=EXCLUDED.label, token_expires_at=EXCLUDED.token_expires_at, extra=EXCLUDED.extra,
             last_error=NULL, hidden=false, needs_reconnect=false, last_refresh_error=NULL`,
      [orgId, orgName || ('Org ' + orgId), token, data.refresh_token || null, expiresAt, JSON.stringify({ orgId })]
    );
    labels.push(orgName || orgId);
  }
  return { count: orgs.length, label: labels.join(', ') };
}

// ── Content publishing (LIVE) ────────────────────────────────
// Publishes AS the LinkedIn company Page (organization) via the UGC Posts API.
// Needs w_organization_social on the token (reconnect to grant) + the member must
// be an ADMINISTRATOR of the org. Image posts use the 3-step assets upload flow.
const _liFs = require('fs');
const _liPath = require('path');
const LI_UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';

// Resolve { token, orgId } for the job's account (or the legacy primary org).
async function _orgCredsFor(accountKey) {
  if (accountKey) {
    const { rows } = await pool.query(
      `SELECT account_key, token, extra FROM social_accounts
        WHERE platform = 'linkedin' AND account_key = $1 AND token IS NOT NULL LIMIT 1`, [accountKey]);
    if (rows[0]) return { token: rows[0].token, orgId: (rows[0].extra && rows[0].extra.orgId) || rows[0].account_key };
  }
  const token = await getAccessToken();
  const orgId = await getSetting('linkedin_org_id');
  if (token && orgId) return { token, orgId };
  return null;
}

// POST JSON to the LinkedIn REST API with a friendly scope error.
async function _liPost(path, token, jsonBody) {
  const res = await fetch(path.startsWith('http') ? path : `${LI_API}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(jsonBody),
  });
  const text = await res.text();
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { /* may be empty */ }
  if (res.status >= 400 || json.error) {
    const m = json.message || json.error_description || json.error || `LinkedIn error (${res.status})`;
    if (res.status === 403 || /permission|scope|ACCESS_DENIED|organization/i.test(String(m)))
      throw new Error('Publishing needs w_organization_social + admin rights on the Page. Reconnect LinkedIn with publish access from Settings.');
    throw new Error(String(m));
  }
  // The created post URN is returned in the x-restli-id header for ugcPosts.
  return { json, postUrn: res.headers.get('x-restli-id') || json.id || null };
}

// Upload a local image to LinkedIn and return its digitalmediaAsset URN.
async function _liUploadImage(token, ownerUrn, fpath) {
  const reg = await _liPost('assets?action=registerUpload', token, {
    registerUploadRequest: {
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
      owner: ownerUrn,
      serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
    },
  });
  const value = reg.json.value || {};
  const asset = value.asset;
  const uploadUrl = value.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
  if (!asset || !uploadUrl) throw new Error('LinkedIn did not return an upload URL for the image');
  const bytes = _liFs.readFileSync(fpath);
  const up = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  if (up.status >= 400) throw new Error(`LinkedIn image upload failed (${up.status})`);
  return asset;
}

// Publish a job to the LinkedIn company Page. Returns { ok, simulated:false, externalId, permalink }.
async function publishContent(job) {
  const creds = await _orgCredsFor(job.account_id || null);
  if (!creds) throw new Error('LinkedIn is not connected, or no company Page was detected. Connect it on the Integrations page.');
  const { token, orgId } = creds;
  const author = `urn:li:organization:${orgId}`;

  const d = job.details || {};
  const text = (job.caption || '').toString();
  const media = Array.isArray(job.media) ? job.media : [];
  const postType = job.post_type;

  if (postType === 'poll') throw new Error('LinkedIn polls can\'t be created via the API.');
  if (postType === 'document') throw new Error('LinkedIn document posts aren\'t supported via the API yet — use a post with an image or a link.');

  const share = { shareCommentary: { text }, shareMediaCategory: 'NONE' };

  if (postType === 'article' && d.link) {
    // Link/article share.
    share.shareMediaCategory = 'ARTICLE';
    share.media = [{ status: 'READY', originalUrl: String(d.link),
      title: d.title ? { text: String(d.title).slice(0, 200) } : undefined }];
  } else if (media.length) {
    // Image share (first image; LinkedIn UGC supports multiple but we keep it simple).
    const img = media.find(m => !String(m.mime || '').toLowerCase().startsWith('video')) || media[0];
    const fpath = _liPath.join(LI_UPLOADS_DIR, _liPath.basename(String(img.url || '')));
    if (!_liFs.existsSync(fpath)) throw new Error('The image file is missing on disk — re-upload it and try again.');
    const asset = await _liUploadImage(token, author, fpath);
    share.shareMediaCategory = 'IMAGE';
    share.media = [{ status: 'READY', media: asset,
      description: d.altText ? { text: String(d.altText).slice(0, 200) } : undefined,
      title: d.title ? { text: String(d.title).slice(0, 200) } : undefined }];
  } else if (!text.trim()) {
    throw new Error('A LinkedIn post needs text or media');
  }

  const { postUrn } = await _liPost('ugcPosts', token, {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': share },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });
  const id = postUrn || `urn:li:share:${Date.now()}`;
  // Activity permalink works for share URNs; ugcPost URNs resolve in-feed.
  const permalink = `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`;
  return { ok: true, simulated: false, externalId: String(id), permalink };
}

// Delete an already-published post. Used by the Publish log.
async function deletePost(externalId, accountKey = null) {
  const creds = await _orgCredsFor(accountKey);
  if (!creds) throw new Error('LinkedIn is not connected');
  const res = await fetch(`${LI_API}/ugcPosts/${encodeURIComponent(externalId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${creds.token}`, 'X-Restli-Protocol-Version': '2.0.0' },
  });
  if (res.status >= 400 && res.status !== 404) throw new Error(`LinkedIn delete failed (${res.status})`);
  return { ok: true };
}

// ── Cheap follower sampler ───────────────────────────────────
// ONE networkSizes call per connected organization, so the daily follower
// series does not depend on the heavier getStats run.
async function sampleFollowers() {
  const creds = [];
  const legacyToken = await getAccessToken();
  const legacyOrg   = await getSetting('linkedin_org_id');
  if (legacyToken && legacyOrg) creds.push({ orgId: String(legacyOrg), token: legacyToken });
  try {
    const { rows } = await pool.query(
      `SELECT account_key, token FROM social_accounts
        WHERE platform = 'linkedin' AND token IS NOT NULL AND NOT COALESCE(hidden, false)`);
    for (const r of rows) {
      if (creds.some(c => c.orgId === r.account_key)) continue;
      creds.push({ orgId: r.account_key, token: r.token });
    }
  } catch (_) {}

  const out = [];
  for (const c of creds) {
    try {
      const urn = encodeURIComponent(`urn:li:organization:${c.orgId}`);
      const d = await liFetch(`networkSizes/${urn}`, c.token, { edgeType: 'CompanyFollowedByMember' });
      const n = Number(d?.firstDegreeSize) || 0;
      if (n > 0) out.push({ accountId: String(c.orgId), followers: n });
    } catch (e) {
      console.error('LinkedIn sampleFollowers failed for', c.orgId, e.message);
    }
  }
  return out;
}

module.exports = { cacheInvalidate, testConnection, sampleFollowers, getConsentUrl, exchangeCode, appendAccountFromCode, saveCredentials, refreshToken, refreshAccountTokens, getStats, getAllPosts, publishContent, deletePost };
