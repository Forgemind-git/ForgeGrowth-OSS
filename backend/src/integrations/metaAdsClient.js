// Meta (Facebook) Marketing API client — reads ad accounts, campaigns and
// insights so the Campaigns dashboard shows real spend/results instead of
// hand-typed numbers. Read-only against Meta (we never mutate ads).
//
// Token is stored encrypted in coexistence.meta_ads_config (util/crypto). This
// module only knows how to TALK to Meta; the route layer owns storage + gating.

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// A "lead" = a WhatsApp conversation started from the ad (the cleanest CTWA
// signal). ONLY messaging_conversation_started_7d — deliberately NOT summed with
// total_messaging_connection (a near-duplicate metric that would double-count).
// Chosen definition, 2026-07-03.
const LEAD_ACTIONS = ['onsite_conversion.messaging_conversation_started_7d'];

async function graph(path, params, token) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    const err = new Error(e.message || `Meta API ${res.status}`);
    err.metaCode = e.code;
    err.metaSubcode = e.error_subcode;
    err.status = res.status;
    throw err;
  }
  return body;
}

// Validate a token + surface its app id, scopes and expiries. Throws on invalid.
async function inspectToken(token) {
  const body = await graph('debug_token', { input_token: token }, token);
  const d = body.data || {};
  if (!d.is_valid) {
    const err = new Error('Token is not valid');
    err.status = 400;
    throw err;
  }
  const scopes = d.scopes || [];
  const hasAds = scopes.includes('ads_read') || scopes.includes('ads_management');
  return {
    appId: d.app_id ? String(d.app_id) : null,
    appName: d.application || null,
    type: d.type || null,                       // USER | SYSTEM
    scopes,
    hasAds,
    expiresAt: d.expires_at || 0,               // 0 = never
    dataAccessExpiresAt: d.data_access_expires_at || null,
  };
}

// All ad accounts this token can read, with a lightweight spend indicator.
async function listAdAccounts(token) {
  const body = await graph('me/adaccounts', {
    fields: 'name,account_id,account_status,currency,amount_spent',
    limit: 100,
  }, token);
  return (body.data || []).map(a => ({
    id: a.id,                                    // "act_123..."
    accountId: a.account_id,
    name: a.name,
    status: a.account_status,                    // 1 = active
    currency: a.currency,
    amountSpent: Number(a.amount_spent || 0) / 100, // minor units → major
  }));
}

function sumActions(actions, types) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (types.includes(a.action_type)) total += Number(a.value || 0);
  }
  return total;
}

// Pull campaigns + lifetime insights for ONE ad account. Returns normalized rows
// ready to UPSERT into coexistence.campaigns. Insights are fetched at campaign
// level with date_preset=maximum so paused/older campaigns still report totals.
async function fetchAccountCampaigns(token, accountId, accountName) {
  const camp = await graph(`${accountId}/campaigns`, {
    fields: 'id,name,objective,effective_status,start_time,stop_time',
    limit: 200,
  }, token);
  const campaigns = camp.data || [];
  if (!campaigns.length) return [];

  // Insights keyed by campaign id (one call for the whole account).
  const insightsById = {};
  try {
    const ins = await graph(`${accountId}/insights`, {
      level: 'campaign',
      fields: 'campaign_id,spend,impressions,clicks,actions',
      date_preset: 'maximum',
      limit: 500,
    }, token);
    for (const r of ins.data || []) insightsById[r.campaign_id] = r;
  } catch (e) {
    // Insights can 400 on accounts that never spent — treat as zero, don't fail.
    if (e.metaCode !== 100) console.warn(`[meta-ads] insights ${accountId}: ${e.message}`);
  }

  return campaigns.map(c => {
    const ins = insightsById[c.id] || {};
    const leads = sumActions(ins.actions, LEAD_ACTIONS); // WhatsApp conversations started
    return {
      externalId: c.id,
      name: c.name,
      objective: c.objective || null,
      effectiveStatus: c.effective_status || null,
      status: (c.effective_status || '').toUpperCase() === 'ACTIVE' ? 'active' : 'paused',
      spend: Number(ins.spend || 0),
      impressions: Number(ins.impressions || 0),
      clicks: Number(ins.clicks || 0),
      leadsGenerated: leads,
      startDate: c.start_time ? c.start_time.slice(0, 10) : null,
      endDate: c.stop_time ? c.stop_time.slice(0, 10) : null,
      accountId,
      accountName: accountName || null,
    };
  });
}

// Choose the sharpest of a video's thumbnails.
//
// ⚠ The `width`/`height` Meta reports on a thumbnail are the SOURCE video's
// dimensions, NOT the size of the image the URI serves. Verified on video
// 2239534770128518: all nine thumbnails claim 1440x2560, while the URIs
// actually deliver 640x1136, 640x1136, 640x1136 and 1080x1920. So sorting by
// the reported area is a no-op that leaves the winner down to array order, and
// `is_preferred` is no better — on that video it points at a 640px frame while
// a 1080px one sits further down the list.
//
// Byte size tracks resolution reliably, and a HEAD gives it without
// downloading anything, so that is what decides. Cheap in practice: only
// videos with more than one thumbnail are probed, capped at MAX_PROBE, and all
// requests for a video run in parallel.
const MAX_PROBE = 6;

async function pickLargestThumbnail(thumbs) {
  if (!thumbs || !thumbs.length) return null;
  // Meta's own cover frame is the sensible default and the fallback if every
  // probe fails (offline, CDN hiccup) — never return nothing just because the
  // size check didn't work.
  const preferred = thumbs.find(t => t.is_preferred)?.uri || thumbs[0].uri;
  if (thumbs.length === 1) return preferred;

  const candidates = thumbs.slice(0, MAX_PROBE).filter(t => t.uri);
  const sized = await Promise.all(candidates.map(async (t) => {
    try {
      const r = await fetch(t.uri, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const n = Number(r.headers.get('content-length') || 0);
      return n > 0 ? { uri: t.uri, bytes: n } : null;
    } catch { return null; }
  }));

  const best = sized.filter(Boolean).sort((a, b) => b.bytes - a.bytes)[0];
  return best?.uri || preferred;
}

// Resolve a full-resolution still + a watch link for each video creative.
//
// Meta will NOT hand over the MP4: requesting `source` on a video returns
// `{"id": "..."}` with the field silently omitted rather than an error, so
// there is nothing to embed and the UI must link out. What IS available is
// `thumbnails`, which returns real 1440x2560 frames — the only route to a
// usable image for a video ad, since adcreatives.thumbnail_url is locked at
// 64x64.
//
// Returns { [videoId]: { imageUrl, watchUrl } }. Never throws: a creative with
// no still must degrade to the small thumbnail, never fail the whole ad sync.
async function fetchVideoStills(token, videoIds) {
  const out = {};
  if (!videoIds || !videoIds.length) return out;

  // Meta's `?ids=` batch form caps well below the number of ads an account can
  // have, so chunk rather than assuming one request is enough.
  for (let i = 0; i < videoIds.length; i += 40) {
    const chunk = videoIds.slice(i, i + 40);
    let body;
    try {
      body = await graph('', {
        ids: chunk.join(','),
        fields: 'id,permalink_url,thumbnails{uri,width,height,is_preferred}',
      }, token);
    } catch (e) {
      console.warn(`[meta-ads] video stills (${chunk.length} ids): ${e.message}`);
      continue;
    }
    const entries = Object.entries(body || {}).filter(([, v]) => v && typeof v === 'object');
    // Resolved in parallel: each one may issue a few HEAD requests (see below).
    await Promise.all(entries.map(async ([id, v]) => {
      const thumbs = (v.thumbnails && v.thumbnails.data) || [];
      const best = await pickLargestThumbnail(thumbs);
      // permalink_url comes back RELATIVE ("/<page>/videos/<id>"); stored as-is
      // it would resolve against our own domain and 404.
      const p = v.permalink_url || null;
      out[id] = {
        imageUrl: best || null,
        watchUrl: p ? (p.startsWith('http') ? p : `https://www.facebook.com${p}`) : null,
      };
    }));
  }
  return out;
}

// Pull every AD for an account with its creative content + per-ad lifetime
// insights, so a campaign can be drilled into. The per-ad nested creative fields
// are unreliable, so creatives are fetched from the /adcreatives endpoint and
// joined by creative id. Returns normalized rows ready to UPSERT into campaign_ads.
async function fetchAccountAds(token, accountId) {
  const [adsBody, creBody] = await Promise.all([
    // adset_id + adset{name} give each ad its parent bucket in one call — asking
    // Meta for the ad-set name per ad is far cheaper than a second lookup, and it
    // means an ad still knows its ad set even if the ad-set fetch below fails.
    graph(`${accountId}/ads`, { fields: 'id,name,campaign_id,adset_id,adset{name},effective_status,creative{id}', limit: 500 }, token),
    // image_url + video_id are what make a FULL-RESOLUTION creative possible.
    // thumbnail_url is Meta's 64x64 and has no larger form — asking for
    // thumbnail_url.width(1080).height(1080) returns the identical p64x64 URL
    // (verified live), so the only way to a usable image is these two fields.
    graph(`${accountId}/adcreatives`, {
      fields: 'id,thumbnail_url,image_url,video_id,title,body,object_type,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url',
      limit: 500,
    }, token),
  ]);
  const ads = adsBody.data || [];
  if (!ads.length) return [];

  const creById = {};
  for (const c of creBody.data || []) creById[c.id] = c;

  // Resolve full-res stills + a watch link for VIDEO creatives. Only creatives
  // actually referenced by a live ad are looked up, so this costs one extra
  // call per distinct video rather than one per creative in the account.
  const videoIds = [...new Set(
    ads.map(a => (a.creative && creById[a.creative.id]) || {})
       .map(c => c.video_id).filter(Boolean)
  )];
  const videoById = await fetchVideoStills(token, videoIds);

  const insByAd = {};
  try {
    const ins = await graph(`${accountId}/insights`, {
      level: 'ad', fields: 'ad_id,spend,impressions,clicks,actions', date_preset: 'maximum', limit: 1000,
    }, token);
    for (const r of ins.data || []) insByAd[r.ad_id] = r;
  } catch (e) {
    if (e.metaCode !== 100) console.warn(`[meta-ads] ad insights ${accountId}: ${e.message}`);
  }

  return ads.map(a => {
    const c = (a.creative && creById[a.creative.id]) || {};
    const ins = insByAd[a.id] || {};
    const leads = sumActions(ins.actions, LEAD_ACTIONS); // WhatsApp conversations started
    return {
      adExternalId: a.id,
      campaignExternalId: a.campaign_id,
      adsetExternalId: a.adset_id || null,
      adsetName: (a.adset && a.adset.name) || null,
      name: a.name,
      status: (a.effective_status || '').toUpperCase() === 'ACTIVE' ? 'active' : 'paused',
      spend: Number(ins.spend || 0),
      impressions: Number(ins.impressions || 0),
      clicks: Number(ins.clicks || 0),
      leads,
      thumbnailUrl: c.thumbnail_url || null,
      // Full-res comes from a DIFFERENT field per creative type: SHARE creatives
      // carry image_url, VIDEO creatives only a video_id whose thumbnails we
      // resolved above. Neither is a superset of the other, so both are tried.
      imageUrl: c.image_url || videoById[c.video_id]?.imageUrl || null,
      watchUrl: videoById[c.video_id]?.watchUrl || null,
      videoId: c.video_id || null,
      title: c.title || null,
      body: c.body || null,
      objectType: c.object_type || null,
      igMediaId: c.effective_instagram_media_id || null,
      igPermalink: c.instagram_permalink_url || null,
      storyId: c.effective_object_story_id || null,
      accountId,
    };
  });
}

// Pull every AD SET for an account — the middle tier of Meta's hierarchy, where
// audience, placement, optimisation goal and budget actually live. Insights are
// requested at level=adset rather than summed from the ads underneath: Meta
// attributes part of the cost at this tier, so summing ads under-reports spend.
async function fetchAccountAdSets(token, accountId) {
  const body = await graph(`${accountId}/adsets`, {
    fields: 'id,name,campaign_id,effective_status,optimization_goal,billing_event,daily_budget,lifetime_budget,start_time,end_time',
    limit: 500,
  }, token);
  const adsets = body.data || [];
  if (!adsets.length) return [];

  const insBySet = {};
  try {
    const ins = await graph(`${accountId}/insights`, {
      level: 'adset', fields: 'adset_id,spend,impressions,clicks,reach,actions', date_preset: 'maximum', limit: 1000,
    }, token);
    for (const r of ins.data || []) insBySet[r.adset_id] = r;
  } catch (e) {
    // An account that never spent 400s here — zeroes are the honest answer.
    if (e.metaCode !== 100) console.warn(`[meta-ads] adset insights ${accountId}: ${e.message}`);
  }

  return adsets.map(s => {
    const ins = insBySet[s.id] || {};
    return {
      adsetExternalId: s.id,
      campaignExternalId: s.campaign_id,
      name: s.name,
      effectiveStatus: s.effective_status || null,
      status: (s.effective_status || '').toUpperCase() === 'ACTIVE' ? 'active' : 'paused',
      optimizationGoal: s.optimization_goal || null,
      billingEvent: s.billing_event || null,
      // Budgets come back in minor units (paise) like every other Meta money field.
      dailyBudget: s.daily_budget != null ? Number(s.daily_budget) / 100 : null,
      lifetimeBudget: s.lifetime_budget != null ? Number(s.lifetime_budget) / 100 : null,
      spend: Number(ins.spend || 0),
      impressions: Number(ins.impressions || 0),
      clicks: Number(ins.clicks || 0),
      reach: Number(ins.reach || 0),
      leads: sumActions(ins.actions, LEAD_ACTIONS),
      startDate: s.start_time ? s.start_time.slice(0, 10) : null,
      endDate: s.end_time ? s.end_time.slice(0, 10) : null,
      accountId,
    };
  });
}

// Per-ad, per-DAY insights. Everything else here uses date_preset=maximum,
// which gives lifetime totals — correct for "what has this ad cost", useless for
// "what did it cost that week". Any before/after comparison needs the daily
// grain, and Meta only provides it via time_increment=1.
//
// `sinceDate` is 'YYYY-MM-DD'. Meta caps a single insights call, so callers
// should keep the range to months rather than years; the sync uses a rolling
// window and the backfill walks it in chunks.
async function fetchAccountAdDailyStats(token, accountId, sinceDate, untilDate) {
  const until = untilDate || new Date().toISOString().slice(0, 10);
  const body = await graph(`${accountId}/insights`, {
    level: 'ad',
    fields: 'ad_id,adset_id,campaign_id,spend,impressions,clicks,actions',
    time_increment: 1,
    time_range: { since: sinceDate, until },
    limit: 1000,
  }, token);

  return (body.data || []).map(r => ({
    adExternalId: r.ad_id,
    adsetExternalId: r.adset_id || null,
    campaignExternalId: r.campaign_id || null,
    // date_start is the day this row covers when time_increment=1.
    statDate: r.date_start,
    spend: Number(r.spend || 0),
    impressions: Number(r.impressions || 0),
    clicks: Number(r.clicks || 0),
    leads: sumActions(r.actions, LEAD_ACTIONS),
    accountId,
  }));
}

module.exports = {
  inspectToken, listAdAccounts, fetchAccountCampaigns, fetchAccountAdSets,
  fetchAccountAds, fetchAccountAdDailyStats, META_API_VERSION,
};
