// ============================================================
// reportData.js — shared report assembly + forward-looking forecast
//
// HARD RULE (same as mcpService): every read here is a pure DB query — snapshots
// + posts + follower_samples. ZERO outbound Graph/API calls, so generating a
// report (UI or MCP) never touches any platform's rate budget.
//
// Used by:
//   - GET /api/reports/data            (the printable per-platform report)
//   - mcpService.generateReport()      (the MCP report tool — adds a forecast)
// ============================================================

const pool = require('./db');
const syncService = require('./syncService');
const accounts = require('./accounts');
const mockService = require('./mockService');

const ALLOWED = ['instagram', 'facebook', 'threads', 'youtube', 'linkedin'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function _addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ─── IST timestamp extraction (mirrors /api/performance) ─────────────── */
const _istParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false, weekday: 'short',
});
function extractIst(raw) {
  try {
    const ts = raw?.timestamp || raw?.created_time || raw?.publishedAt;
    if (!ts) return { hour: null, day: null };
    const d = new Date(ts);
    if (isNaN(d)) return { hour: null, day: null };
    const parts = _istParts.formatToParts(d);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
    const day = parts.find(p => p.type === 'weekday')?.value || null;
    return { hour: isNaN(hour) ? null : hour % 24, day };
  } catch { return { hour: null, day: null }; }
}

/* ─── Core assembly (DB only) ─────────────────────────────────────────── */
// Returns { from, to, rangeDays, generatedAt, platforms:[{key,name,connected,
// accountLabel,statsWindow,statsFetchedAt,stats,posts,followersSeries}] }.
// `accountKey` (optional) FORCES every platform in this report onto one account
// instead of resolving each platform's primary — that is how an account-scoped
// MCP key gets a report containing only its own account.
async function assembleReportData({ platforms, from, to, accountKey: forcedAccountKey = null }) {
  const keys = (Array.isArray(platforms) ? platforms : String(platforms || '').split(','))
    .map(s => String(s).trim().toLowerCase()).filter(k => ALLOWED.includes(k));
  if (!keys.length) { const e = new Error('No valid platforms requested'); e.status = 400; throw e; }
  if (!isDate(from) || !isDate(to)) { const e = new Error('from/to must be YYYY-MM-DD'); e.status = 400; throw e; }
  if (from > to) { const t = from; from = to; to = t; }

  const rangeDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const wantedWindow = rangeDays <= 10 ? '7D' : rangeDays <= 45 ? '30D' : '90D';

  const out = [];
  for (const key of keys) {
    let stats = null, accountKey = null, accountLabel = null;
    let statsWindow = wantedWindow, statsFetchedAt = null;
    for (const win of [wantedWindow, '30D', '90D', '7D']) {
      const snaps = await syncService.getAccountSnapshots(key, win);
      if (!snaps.length) continue;
      const accountSnaps = snaps.filter(s => s.account_key);
      let chosen;
      if (forcedAccountKey) {
        // Forced account: its snapshot or nothing. Never fall through to the
        // primary/combined row — that would be another account's data.
        chosen = accountSnaps.find(s => (s.data?.accountId || s.account_key) === forcedAccountKey);
        if (!chosen) continue;
      } else if (accountSnaps.length) {
        const primaryId = await accounts.resolvePrimaryId(key, accountSnaps.map(s => s.data?.accountId || s.account_key));
        chosen = accountSnaps.find(s => (s.data?.accountId || s.account_key) === primaryId) || accountSnaps[0];
      } else {
        chosen = snaps[0];
      }
      const d = chosen.data || {};
      stats = {
        followers: d.followers ?? null, growth: d.growth ?? null, growthPct: d.growthPct ?? null,
        impressions: d.impressions ?? null, reach: d.reach ?? null, engagementRate: d.engagementRate ?? null,
        clicks: d.clicks ?? null, posts: d.posts ?? null,
        extras: Array.isArray(d.extras) ? d.extras : [], isReal: d.isReal === true,
      };
      accountKey = d.accountId || chosen.account_key || null;
      accountLabel = d.accountLabel || accountKey || null;
      statsWindow = win; statsFetchedAt = chosen.fetched_at;
      break;
    }

    const params = [key, from, to];
    let acctClause = '';
    if (forcedAccountKey) {
      // Strict: only rows explicitly attributed to this account. Legacy rows with
      // a NULL account_key are un-attributed and could belong to anyone.
      params.push(forcedAccountKey); acctClause = 'AND p.account_key = $4';
    } else if (accountKey) {
      params.push(accountKey); acctClause = 'AND (p.account_key = $4 OR p.account_key IS NULL)';
    }
    const { rows: postRows } = await pool.query(`
      SELECT p.external_id AS "externalId", p.title, p.caption, p.type, p.topic, p.date, p.views,
             p.engagements AS eng, p.likes, p.comments, p.shares, p.saves,
             p.clicks, p.score, p.thumbnail_url AS thumbnail, p.permalink, p.raw_data
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      WHERE pl.key = $1 AND p.date >= $2 AND p.date <= $3 ${acctClause}
      ORDER BY p.date ASC`, params);
    const posts = postRows.map(p => {
      const ist = extractIst(p.raw_data);
      const { raw_data: _rawData, ...rest } = p;
      return { ...rest, hourIst: ist.hour, dayIst: ist.day };
    });

    let followersSeries = [];
    if (accountKey) {
      // LAST reading of each IST day — the same "value the day closed at"
      // semantics the Overview trend chart uses, so a report and the dashboard
      // never quote different numbers for the same day. (MAX would report an
      // intraday peak the day did not end on.)
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (day) day AS date, followers::bigint AS followers
        FROM (
          SELECT to_char(sampled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                 followers, sampled_at
          FROM follower_samples
          WHERE platform = $1 AND account_id = $2
            AND (sampled_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3::date AND $4::date
        ) t ORDER BY day, sampled_at DESC`, [key, accountKey, from, to]);
      followersSeries = rows.map(r => ({ date: r.date, followers: Number(r.followers) }));
    }

    out.push({
      key, name: mockService.PLATFORMS[key]?.name || key, connected: !!stats,
      accountLabel, statsWindow, statsFetchedAt, stats, posts, followersSeries,
    });
  }

  return { from, to, rangeDays, generatedAt: new Date().toISOString(), platforms: out };
}

/* ─── Derivation helpers (shared shape with the frontend engine) ──────── */
const SLOT_LABELS = ['6-8 AM', '8-11 AM', '11 AM-2 PM', '2-5 PM', '5-8 PM', '8 PM-12 AM'];
const slotForHour = h => (h < 8 ? 0 : h < 11 ? 1 : h < 14 ? 2 : h < 17 ? 3 : h < 20 ? 4 : 5);
const DAY_FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const normFormat = t => {
  const s = String(t || 'Post');
  const f = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return f === 'Text_post' ? 'Text post' : f;
};
const sumBy = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const round1 = n => Math.round(n * 10) / 10;

function formatBreakdown(posts) {
  const g = {};
  posts.forEach(p => {
    const f = normFormat(p.type);
    if (!g[f]) g[f] = { format: f, posts: 0, views: 0, eng: 0 };
    g[f].posts += 1; g[f].views += Number(p.views) || 0; g[f].eng += Number(p.eng) || 0;
  });
  return Object.values(g)
    .map(x => ({ ...x, avgViews: Math.round(x.views / x.posts), avgEng: Math.round(x.eng / x.posts) }))
    .sort((a, b) => b.avgEng - a.avgEng);
}

function bestTiming(posts) {
  const cells = {}, days = {};
  posts.forEach(p => {
    if (!p.dayIst) return;
    days[p.dayIst] = days[p.dayIst] || { n: 0, eng: 0 };
    days[p.dayIst].n += 1; days[p.dayIst].eng += Number(p.eng) || 0;
    if (p.hourIst == null) return;
    const k = `${p.dayIst}|${slotForHour(p.hourIst)}`;
    cells[k] = cells[k] || { n: 0, eng: 0 };
    cells[k].n += 1; cells[k].eng += Number(p.eng) || 0;
  });
  let best = null;
  for (const [k, v] of Object.entries(cells)) {
    if (v.n < 2) continue;
    const avg = v.eng / v.n;
    if (!best || avg > best.avg) {
      const [day, slot] = k.split('|');
      best = { label: `${DAY_FULL[day] || day} · ${SLOT_LABELS[Number(slot)]}`, n: v.n, avg, byCell: true };
    }
  }
  if (best) return best;
  let bd = null;
  for (const [day, v] of Object.entries(days)) {
    if (v.n < 2) continue;
    const avg = v.eng / v.n;
    if (!bd || avg > bd.avg) bd = { label: DAY_FULL[day] || day, n: v.n, avg, byCell: false };
  }
  return bd;
}

// Topics whose avg engagement beats the platform's own average (momentum).
function risingTopics(posts) {
  const valid = posts.filter(p => p.topic && p.topic !== 'Uncategorized' && p.topic !== 'General');
  if (valid.length < 3) return [];
  const avgAll = sumBy(valid, p => p.eng) / valid.length;
  const g = {};
  valid.forEach(p => {
    const t = p.topic;
    if (!g[t]) g[t] = { topic: t, n: 0, eng: 0 };
    g[t].n += 1; g[t].eng += Number(p.eng) || 0;
  });
  return Object.values(g)
    .map(x => ({ topic: x.topic, posts: x.n, avgEng: Math.round(x.eng / x.n) }))
    .filter(x => x.posts >= 1 && x.avgEng > avgAll * 1.1)
    .sort((a, b) => b.avgEng - a.avgEng)
    .slice(0, 3);
}

function summarizePlatform(p, rangeDays) {
  const posts = p.posts || [];
  const totalViews = sumBy(posts, x => x.views);
  const totalEng = sumBy(posts, x => x.eng);
  const engRate = totalViews > 0 ? round1((totalEng / totalViews) * 100) : null;
  const followersLabel = p.key === 'youtube' ? 'subscribers' : 'followers';

  let growth = null;
  const series = p.followersSeries || [];
  if (series.length >= 2) {
    const start = series[0].followers, end = series[series.length - 1].followers, net = end - start;
    growth = { start, end, net, pct: start > 0 ? round1((net / start) * 100) : null, source: 'samples' };
  } else if (p.stats && p.stats.followers != null && p.stats.growth != null) {
    const end = p.stats.followers, net = p.stats.growth;
    growth = { start: end - net, end, net, pct: p.stats.growthPct ?? (end - net > 0 ? round1(net / (end - net) * 100) : null), source: 'window' };
  }

  const formats = formatBreakdown(posts);
  const bestFormat = formats.find(f => f.posts >= 2) || (formats.length ? formats[0] : null);
  const timing = bestTiming(posts);
  const topics = risingTopics(posts);
  const postsPerWeek = posts.length ? round1(posts.length / (rangeDays / 7)) : 0;
  const clip = (s, n) => { s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const ranked = [...posts].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0) || (Number(b.eng) || 0) - (Number(a.eng) || 0));
  const topPosts = ranked.slice(0, 5).map(x => ({
    title: x.title, caption: clip(x.caption, 240) || null, type: normFormat(x.type), topic: x.topic || null,
    date: x.date, views: Number(x.views) || 0, engagements: Number(x.eng) || 0,
    likes: Number(x.likes) || 0, comments: Number(x.comments) || 0, shares: Number(x.shares) || 0, saves: Number(x.saves) || 0,
    permalink: x.permalink || null,
  }));
  // Rich per-post material for deep LLM analysis of WHY content performed:
  // the FULL caption (so the model can read the actual hook/CTA/topic), parsed
  // hashtags, posting day/time (IST), and per-post rate signals (save/share/
  // comment/like as % of views — the levers each platform ranks on). Includes
  // BOTH top and bottom performers so winners can be contrasted with misses.
  const rate = (num, den) => (Number(den) || 0) > 0 ? round1((Number(num) || 0) / Number(den) * 100) : null;
  const hashtagsOf = (cap) => {
    const m = String(cap || '').match(/#[\p{L}\p{N}_]+/gu);
    return m ? Array.from(new Set(m)).slice(0, 30) : [];
  };
  const N = ranked.length;
  const selected = N <= 30 ? ranked : [...ranked.slice(0, 20), ...ranked.slice(-10)];
  const mapAnalysis = (x, idx) => {
    const v = Number(x.views) || 0, eng = Number(x.eng) || 0;
    const fullCap = String(x.caption || '').replace(/\s+/g, ' ').trim();
    return {
      rank: idx + 1,
      title: x.title,
      caption: fullCap ? (fullCap.length > 1200 ? fullCap.slice(0, 1199) + '…' : fullCap) : null,
      hashtags: hashtagsOf(x.caption),
      type: normFormat(x.type), topic: x.topic || null,
      date: x.date, dayIst: x.dayIst, hourIst: x.hourIst,
      views: v, engagements: eng,
      likes: Number(x.likes) || 0, comments: Number(x.comments) || 0,
      shares: Number(x.shares) || 0, saves: Number(x.saves) || 0,
      engRatePct: rate(eng, v), saveRatePct: rate(x.saves, v), shareRatePct: rate(x.shares, v),
      commentRatePct: rate(x.comments, v), likeRatePct: rate(x.likes, v),
    };
  };
  const analysisPosts = selected.map(mapAnalysis);

  let trajectory = 'On track';
  if (growth && growth.net != null) trajectory = growth.net < 0 ? 'Declining' : (growth.pct != null && growth.pct >= 3 ? 'Accelerating' : 'On track');

  return {
    platform: p.key, name: p.name, connected: p.connected, account: p.accountLabel,
    statsWindow: p.statsWindow, isRealData: p.stats ? p.stats.isReal : false,
    audience: growth ? { ...growth, label: followersLabel } : null,
    // Daily in-range follower samples (IST) — lets a report renderer draw the
    // growth trend chart from this single payload. [] when none recorded.
    followersSeries: series,
    windowStats: p.stats ? {
      impressions: p.stats.impressions, reach: p.stats.reach,
      engagementRate: p.stats.engagementRate,
      extras: (p.stats.extras || []).filter(e => e && e.value != null && (typeof e.value !== 'number' || e.value > 0)),
    } : null,
    content: { postsInRange: posts.length, totalViews, totalEngagements: totalEng, engagementRate: engRate, topPosts, posts: analysisPosts, formatBreakdown: formats },
    cadence: { postsPerWeek, bestTime: timing ? timing.label : null, bestFormat: bestFormat ? bestFormat.format : null },
    risingTopics: topics,
    trajectory,
  };
}

/* ─── Forecast (MCP-only section) ─────────────────────────────────────── */
// Blends TWO sources, each clearly labelled in the output:
//   1) "Your data"  — momentum from this account's own posts in the range.
//   2) "Industry"   — evergreen best-practice patterns of top creators per
//                     platform (a curated, dated knowledge base — NOT scraped).

const INDUSTRY_PLAYBOOK = {
  instagram: [
    'Reels with a strong hook in the first 3 seconds and on-screen captions consistently out-reach static posts.',
    'Carousels that teach ONE idea per slide drive saves and shares (the signals IG ranks on).',
    'Use trending audio early, reply to every comment in the first hour, and post 4-7x/week.',
  ],
  youtube: [
    'Search-intent titles plus a high-contrast thumbnail with a single clear subject win the click.',
    'Earn retention in the first 30 seconds; the first 24-48h watch-time decides the algorithm push.',
    'Use Shorts as a discovery funnel into long-form, and keep a steady weekly upload cadence.',
  ],
  facebook: [
    'Native video and relatable, share-worthy posts beat outbound links on reach.',
    'Repurposing your best Instagram Reels as FB Reels extends their life for near-zero effort.',
    'Posts that spark comments/shares (questions, community wins) get the widest organic distribution.',
  ],
  threads: [
    'Conversational hot-takes and genuine questions that invite replies travel furthest.',
    'Reply to your own thread to add context — it re-surfaces the post and lifts reach.',
    'Post 1-3 short updates a day and ride timely, in-the-moment topics.',
  ],
  linkedin: [
    'Document/PDF carousels and first-person build-in-public stories earn the most dwell time.',
    'A strong first line (the "hook" before the see-more fold) decides whether the post opens.',
    'Comment back within the first hour; consistent 3-5x/week posting compounds reach.',
  ],
};

const PLAYBOOK_DATE = '2026-06';

function platformForecast(summary) {
  const youGuidance = [];
  if (summary.content.postsInRange === 0) {
    youGuidance.push('No posts in this range to learn from — start publishing to build a signal; the industry guidance below applies in the meantime.');
  } else {
    if (summary.cadence.bestFormat) {
      const bf = summary.content.formatBreakdown.find(f => f.format === summary.cadence.bestFormat);
      youGuidance.push(`Your ${summary.cadence.bestFormat.toLowerCase()}s are pulling ahead${bf ? ` (avg ${bf.avgEng} engagements)` : ''} — make them the backbone of next week's plan.`);
    }
    if (summary.cadence.bestTime) {
      youGuidance.push(`Publish your priority posts around ${summary.cadence.bestTime} (IST) — your highest-response window this period.`);
    }
    if (summary.risingTopics.length) {
      youGuidance.push(`Themes with momentum: ${summary.risingTopics.map(t => `"${t.topic}" (avg ${t.avgEng} eng)`).join(', ')} — plan follow-ups while interest is hot.`);
    }
    if (summary.cadence.postsPerWeek && summary.cadence.postsPerWeek < 3) {
      youGuidance.push(`Cadence is ${summary.cadence.postsPerWeek}/week — lifting toward 3-4/week gives the algorithm more chances to surface you.`);
    }
    if (summary.audience && summary.audience.net < 0) {
      youGuidance.push(`${summary.audience.label[0].toUpperCase() + summary.audience.label.slice(1)} dipped this period — rebalance toward the formats/themes that historically grew the account.`);
    }
  }
  return {
    platform: summary.platform,
    name: summary.name,
    fromYourData: youGuidance,
    industryTrends: INDUSTRY_PLAYBOOK[summary.platform] || [],
  };
}

// Cross-platform "what to prioritise next" — picks the platform with the
// strongest momentum and the single best format/time signal overall.
function overallForecast(summaries) {
  const active = summaries.filter(s => s.content.postsInRange > 0);
  const lines = [];
  if (active.length) {
    const byEng = [...active].sort((a, b) => b.content.totalEngagements - a.content.totalEngagements);
    const lead = byEng[0];
    lines.push(`${lead.name} drove the most engagement this period (${lead.content.totalEngagements}) — keep it the priority channel next week.`);
    const accel = summaries.filter(s => s.trajectory === 'Accelerating').map(s => s.name);
    if (accel.length) lines.push(`Accelerating audience growth on: ${accel.join(', ')} — increase cadence there while momentum lasts.`);
    const withFmt = active.filter(s => s.cadence.bestFormat);
    if (withFmt.length) {
      const counts = {};
      withFmt.forEach(s => { counts[s.cadence.bestFormat] = (counts[s.cadence.bestFormat] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) lines.push(`"${top[0]}" is your best-performing format across ${top[1]} platform${top[1] > 1 ? 's' : ''} — lead with it.`);
    }
  } else {
    lines.push('No posts in this range yet — the per-platform industry guidance is the best starting playbook.');
  }
  return lines;
}

// Full MCP report: per-platform summary + forecast (your-data + industry).
async function generateReport({ platforms, from, to, accountKey = null }) {
  const data = await assembleReportData({ platforms, from, to, accountKey });
  const summaries = data.platforms.map(p => summarizePlatform(p, data.rangeDays));
  // baselineForecast is a DETERMINISTIC FALLBACK only. A good report should NOT
  // ship this verbatim — the caller (Claude) is expected to read content.posts
  // (full captions + per-post rate signals) to explain WHY each post performed,
  // and to do live web research for competitor/trend analysis, then author its
  // own forecast. See analysisGuidance below.
  const baselineForecast = {
    horizon: 'next 7 days',
    overall: overallForecast(summaries),
    perPlatform: summaries.map(platformForecast),
    methodology: `Deterministic fallback only: blends own-post momentum with a static best-practice playbook (${PLAYBOOK_DATE}). NOT competitor research. Replace with your own content analysis + live research.`,
  };
  return {
    range: { from: data.from, to: data.to, days: data.rangeDays },
    generatedAt: data.generatedAt,
    platforms: summaries,
    forecast: baselineForecast,
    analysisGuidance: {
      whyContent: 'For each platform, READ content.posts (full captions, hashtags, day/time, and per-post save/share/comment/like rate vs views). Explain WHY the top posts performed by pointing at the specific lever (hook/CTA/format/topic/timing) and the rate that proves it; contrast with the weakest posts. Be specific to the actual post — never generic.',
      research: 'The forecast must be RESEARCH-BACKED, not generic. Use live web search to study what is currently working for top creators/competitors in this account\'s niche (infer the niche from the captions/topics), and current platform-format trends. Ground next-week recommendations in BOTH your first-party performance patterns and that external research, and cite sources. If web search is unavailable, say so explicitly rather than inventing competitor claims.',
      note: 'This payload contains NO competitor data — ForgeSocial only holds first-party accounts. Competitor/trend analysis must come from your own web research.',
    },
    notes: [
      'DB-only: no live platform calls were made to generate this report.',
      'Window stats (reach/impressions/extras) reflect the platform reporting window noted per platform; post counts and follower growth are exact-range.',
    ],
  };
}

module.exports = {
  ALLOWED,
  assembleReportData,
  summarizePlatform,
  generateReport,
  INDUSTRY_PLAYBOOK,
};
