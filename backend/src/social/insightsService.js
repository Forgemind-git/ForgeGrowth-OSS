// ============================================================
// insightsService.js — Derived MANAGERIAL decision layer.
//
// HARD RULE (same as mcpService / reportData): every read here is a pure DB query
// — snapshots + posts + follower_samples. ZERO outbound Graph/API calls, so
// neither the in-app Insights page nor the MCP tools can ever burn a platform's
// rate budget.
//
// Single source of truth for the cross-platform executive view, consumed by BOTH:
//   - GET /api/insights, /api/insights/themes, /api/insights/anomalies
//   - MCP tools get_executive_summary / get_content_themes / get_trends_anomalies
//
// Honesty: metrics that mean the same thing on every platform (follower growth %,
// engagement rate, posting cadence) are marked `comparable:true`. Metrics whose
// definition differs per platform (reach vs impressions, the 1-99 percentile
// content score) are marked `comparable:false` so the UI can badge them and we
// never fake cross-platform equivalence.
// ============================================================
const pool = require('./db');
const reportData = require('./reportData');
const mockService = require('./mockService');
const accounts = require('./accounts');

const ALLOWED = reportData.ALLOWED; // ['instagram']
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);

// ── Date helpers (IST day boundaries, mirrors reportData) ─────────────
function _istToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // YYYY-MM-DD
}
function _addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90 };
function normPeriod(p) { return PERIOD_DAYS[p] ? p : '30D'; }

// Current window + the immediately-preceding equal window (for WoW/MoM deltas).
function _ranges(period) {
  period = normPeriod(period);
  const days = PERIOD_DAYS[period];
  const to = _istToday();
  const from = _addDays(to, -(days - 1));
  const prevTo = _addDays(from, -1);
  const prevFrom = _addDays(prevTo, -(days - 1));
  return { period, days, from, to, prevFrom, prevTo };
}

// Per-platform summaries for a date range (reuses the report assembly + derivations).
// `scope` (optional) narrows the whole scorecard to one platform + one account,
// which is how an account-scoped MCP key sees only its own numbers.
async function _summaries(from, to, scope = null) {
  const data = await reportData.assembleReportData({
    platforms: scope ? [scope.platform] : ALLOWED,
    from, to,
    accountKey: scope ? scope.accountId : null,
  });
  return data.platforms.map(p => reportData.summarizePlatform(p, data.rangeDays));
}

/* ─────────────────────── Executive scorecard ─────────────────────── */
// Cross-platform, normalized, ranked. Returns { period, range, platforms[], summary[], generatedAt }.
async function getExecutiveScorecard(period = '30D', scope = null) {
  const r = _ranges(period);
  const [cur, prev] = await Promise.all([
    _summaries(r.from, r.to, scope),
    _summaries(r.prevFrom, r.prevTo, scope),
  ]);
  const prevByKey = Object.fromEntries(prev.map(s => [s.platform, s]));

  // A rate can't exceed 100% — a stored value above that is a bad metric
  // (e.g. eng/tiny-denominator), so we suppress it rather than show "141%".
  const plausibleEr = v => (v != null && v >= 0 && v <= 100) ? v : null;
  const minHistory = Math.ceil(r.days * 0.5);

  const rows = cur.filter(s => s.connected).map(s => {
    const p = prevByKey[s.platform] || null;
    const postsInRange = s.content.postsInRange;
    const ws = s.windowStats || {};
    const reachBasis = ws.impressions != null ? ws.impressions : ws.reach;
    const reachMetric = ws.impressions != null ? 'impressions' : (ws.reach != null ? 'reach' : null);
    const reachPerPost = (reachBasis != null && postsInRange > 0) ? Math.round(reachBasis / postsInRange) : null;

    const engRate = plausibleEr(s.content.engagementRate);
    const prevEngRate = p ? plausibleEr(p.content.engagementRate) : null;

    // Growth is only trustworthy when (a) we have enough follower history in-window
    // and (b) the figure is plausible. A >100% jump for an established account is
    // almost always a baseline/sampling artifact (a bad early sample, or a metric
    // that just started being captured) — not organic growth — so we don't assert it.
    const histDays = (s.followersSeries || []).length;
    const plausibleGrowth = !!s.audience && s.audience.pct != null && Math.abs(s.audience.pct) <= 100;
    const growthReliable = !!s.audience && plausibleGrowth && (s.audience.source === 'window' || histDays >= minHistory);
    const growthPct = (s.audience && growthReliable) ? s.audience.pct : null;
    const prevReliable = !!(p && p.audience && (p.audience.source === 'window' || (p.followersSeries || []).length >= minHistory));
    const prevGrowthPct = prevReliable ? p.audience.pct : null;

    return {
      platform: s.platform,
      name: s.name,
      account: s.account,
      isRealData: s.isRealData,
      followers: s.audience ? s.audience.end : (ws.followers ?? null),
      followersLabel: s.audience ? s.audience.label : 'followers',
      // ── comparable across platforms ──
      growthPct,                                  // follower growth %, period (null when history too short)
      growthReliable,
      growthPctDelta: (growthPct != null && prevGrowthPct != null) ? round1(growthPct - prevGrowthPct) : null,
      engagementRate: engRate,                    // % engaged (denominator labelled per platform)
      engagementRateDelta: (engRate != null && prevEngRate != null) ? round1(engRate - prevEngRate) : null,
      postsPerWeek: s.cadence.postsPerWeek,
      // Don't assert a trajectory we can't back with enough history.
      trajectory: growthReliable ? s.trajectory : 'Insufficient history',
      // ── platform-defined (NOT cross-comparable — badge in UI) ──
      reachPerPost, reachMetric,
      bestFormat: s.cadence.bestFormat,
      bestTheme: (s.risingTopics[0] && s.risingTopics[0].topic) || null,
      // raw totals for context
      postsInRange,
      totalEngagements: s.content.totalEngagements,
      totalViews: s.content.totalViews,
    };
  });

  // Rank by the most trustworthy comparable signal: engagement rate first, then
  // RELIABLE growth %, then raw engagement. (Ranking on growth alone let a small
  // recently-added account with sparse history top the board on an inflated %.)
  const ranked = [...rows].sort((a, b) =>
    (b.engagementRate ?? -1e9) - (a.engagementRate ?? -1e9) ||
    ((b.growthReliable ? b.growthPct : null) ?? -1e9) - ((a.growthReliable ? a.growthPct : null) ?? -1e9) ||
    (b.totalEngagements ?? 0) - (a.totalEngagements ?? 0));
  ranked.forEach((row, i) => { row.rank = i + 1; });

  return {
    period: r.period,
    range: { from: r.from, to: r.to },
    comparability: {
      comparable: ['growthPct', 'engagementRate', 'postsPerWeek'],
      platformDefined: ['reachPerPost', 'bestFormat', 'bestTheme'],
      note: 'growth %, engagement rate, and cadence are comparable across platforms; reach/impressions and content themes are platform-defined and should not be ranked head-to-head.',
    },
    platforms: ranked,
    summary: _scorecardSummary(ranked, cur),
    generatedAt: new Date().toISOString(),
  };
}

// Data-real "where to focus" lines (the same intent as reportData.overallForecast
// but for the live scorecard, not the report forecast).
function _scorecardSummary(ranked, summaries) {
  const lines = [];
  const active = ranked.filter(r => r.postsInRange > 0);
  if (!active.length) { return ['No posts in this window yet — start publishing to build a signal.']; }

  const byEng = [...active].sort((a, b) => b.totalEngagements - a.totalEngagements);
  lines.push(`${byEng[0].name} drove the most engagement this window (${byEng[0].totalEngagements.toLocaleString()}) — keep it the priority channel.`);

  const accel = ranked.filter(r => r.trajectory === 'Accelerating').map(r => r.name);
  if (accel.length) lines.push(`Accelerating audience growth: ${accel.join(', ')} — lean in while momentum lasts.`);

  const declining = ranked.filter(r => r.trajectory === 'Declining').map(r => r.name);
  if (declining.length) lines.push(`Watch: ${declining.join(', ')} ${declining.length > 1 ? 'are' : 'is'} losing audience — review cadence and content mix.`);

  // Best format that recurs across platforms.
  const fmtCounts = {};
  active.forEach(r => { if (r.bestFormat) fmtCounts[r.bestFormat] = (fmtCounts[r.bestFormat] || 0) + 1; });
  const topFmt = Object.entries(fmtCounts).sort((a, b) => b[1] - a[1])[0];
  if (topFmt && topFmt[1] > 1) lines.push(`"${topFmt[0]}" is your strongest format across ${topFmt[1]} platforms — lead with it.`);

  // Engagement-rate movers vs the prior window.
  const moved = active.filter(r => r.engagementRateDelta != null && Math.abs(r.engagementRateDelta) >= 1)
    .sort((a, b) => Math.abs(b.engagementRateDelta) - Math.abs(a.engagementRateDelta))[0];
  if (moved) lines.push(`${moved.name} engagement rate ${moved.engagementRateDelta > 0 ? 'up' : 'down'} ${Math.abs(moved.engagementRateDelta)} pts vs the prior window.`);

  return lines;
}

/* ─────────────────────── Content-theme ROI ───────────────────────── */
// Per-theme performance, powered by the now-populated posts.topic. Returns
// { period, range, platform, themes[], coverage, generatedAt }.
async function getContentThemes({ platform = null, period = '30D' } = {}, scope = null) {
  const r = _ranges(period);
  const wanted = scope ? scope.platform : platform;
  const plat = wanted && ALLOWED.includes(String(wanted).toLowerCase()) ? String(wanted).toLowerCase() : null;

  // No platform chosen = every live platform (rows of removed ones are ignored).
  const platFilter = plat ? [plat] : ALLOWED;
  const params = [r.from, r.to, platFilter];
  let platClause = 'AND pl.key = ANY($3)';
  if (scope) { params.push(scope.accountId); platClause += ` AND p.account_key = $${params.length}`; }

  const q = (from, to, extra) => pool.query(`
    SELECT COALESCE(p.topic, 'Uncategorized') AS topic,
           COUNT(*)::int AS posts,
           ROUND(AVG(p.views))::bigint   AS "avgViews",
           ROUND(AVG(p.engagements))::bigint AS "avgEng",
           ROUND(AVG(p.score))::int      AS "avgScore",
           SUM(p.views)::bigint          AS "totalViews",
           SUM(p.engagements)::bigint    AS "totalEng"
      FROM posts p JOIN platforms pl ON pl.id = p.platform_id
     WHERE p.date >= $1 AND p.date <= $2 ${platClause}
     GROUP BY COALESCE(p.topic, 'Uncategorized')`, extra);

  const curRes = await q(r.from, r.to, params);
  const prevParams = [r.prevFrom, r.prevTo, platFilter];
  if (scope) prevParams.push(scope.accountId);
  const prevRes = await q(r.prevFrom, r.prevTo, prevParams);
  const prevByTopic = Object.fromEntries(prevRes.rows.map(t => [t.topic, t]));

  const totalPosts = curRes.rows.reduce((a, t) => a + t.posts, 0) || 1;
  const themes = curRes.rows.map(t => {
    const prev = prevByTopic[t.topic];
    const avgEng = Number(t.avgEng);
    const prevAvgEng = prev ? Number(prev.avgEng) : null;
    return {
      topic: t.topic,
      posts: t.posts,
      sharePct: round1((t.posts / totalPosts) * 100),
      avgViews: Number(t.avgViews),
      avgEng,
      avgScore: t.avgScore,
      totalViews: Number(t.totalViews),
      totalEng: Number(t.totalEng),
      engTrendPct: (prevAvgEng && prevAvgEng > 0) ? round1(((avgEng - prevAvgEng) / prevAvgEng) * 100) : null,
    };
  }).sort((a, b) => b.avgEng - a.avgEng);

  const categorized = themes.filter(t => t.topic !== 'Uncategorized').reduce((a, t) => a + t.posts, 0);
  return {
    period: r.period,
    range: { from: r.from, to: r.to },
    platform: plat,
    themes,
    coverage: { totalPosts, categorized, uncategorized: totalPosts - categorized,
      categorizedPct: round1((categorized / totalPosts) * 100) },
    note: 'Themes are assigned by rule-based caption/hashtag matching (admin-editable map). "Uncategorized" posts had no theme keyword match.',
    generatedAt: new Date().toISOString(),
  };
}

/* ─────────────────────── Trends & anomalies ──────────────────────── */
// WoW/MoM-style deltas from retained snapshots + flagged anomalies.
// Returns { period, platforms[], anomalies[], generatedAt }.
const ANOMALY = { impressionsDropPct: 20, engRateSpikePts: 2, viralScore: 97 };

async function getTrendsAndAnomalies(period = '30D', scope = null) {
  const r = _ranges(period);
  const platforms = [];
  const anomalies = [];

  for (const key of (scope ? [scope.platform] : ALLOWED)) {
    // Scope the time-series to ONE account (the primary) — mixing per-account +
    // combined snapshot rows produces garbage deltas (e.g. comparing a small
    // secondary account's followers against the primary's).
    const { rows: keyRows } = await pool.query(
      `SELECT DISTINCT account_key FROM sync_snapshots
        WHERE platform = $1 AND period = '30D' AND account_key IS NOT NULL`, [key]);
    let acctClause = 'AND account_key IS NULL';
    const params = [key];
    if (scope) {
      // Scoped: this account's series only — never the account-less combined row.
      if (!keyRows.some(x => x.account_key === scope.accountId)) continue;
      params.push(scope.accountId);
      acctClause = 'AND account_key = $2';
    } else if (keyRows.length) {
      const primary = await accounts.resolvePrimaryId(key, keyRows.map(r => r.account_key)).catch(() => keyRows[0].account_key);
      params.push(primary || keyRows[0].account_key);
      acctClause = 'AND account_key = $2';
    }
    // Time-ordered snapshots for this platform's primary account.
    const { rows: snaps } = await pool.query(`
      SELECT data, fetched_at FROM sync_snapshots
       WHERE platform = $1 AND period = '30D' ${acctClause}
       ORDER BY fetched_at DESC LIMIT 200`, params);
    if (!snaps.length) continue;

    const latest = snaps[0].data || {};
    const name = mockService.PLATFORMS[key]?.name || key;

    // Pick a baseline snapshot ~`days` old. RELIABILITY: only trust deltas when we
    // actually have history reaching ~that far back. If our oldest snapshot is much
    // newer than the window (the account/metric was added recently), the "30-day"
    // delta would be computed over far fewer days and inflate wildly — so we mark
    // the platform unreliable, null out deltas, and raise NO anomalies for it.
    const nowMs = Date.now();
    const targetMs = nowMs - r.days * 86400000;
    const oldest = snaps[snaps.length - 1];
    const oldestAgeDays = (nowMs - new Date(oldest.fetched_at).getTime()) / 86400000;
    let baseline = oldest;
    for (const s of snaps) { if (new Date(s.fetched_at).getTime() <= targetMs) { baseline = s; break; } }
    const base = baseline.data || {};
    const baselineAgeDays = Math.round((nowMs - new Date(baseline.fetched_at).getTime()) / 86400000);
    const reliable = oldestAgeDays >= r.days * 0.5; // need ≥ half the window of history

    // % delta only when BOTH ends are real positive values (a ~0 baseline yields a
    // meaningless thousands-of-% jump — the metric simply started being captured).
    const pct = (now, then) => (reliable && now > 0 && then > 0) ? round1(((now - then) / then) * 100) : null;
    const followersDelta = pct(latest.followers, base.followers);
    const impressionsDelta = pct(latest.impressions, base.impressions);
    const plausibleEr = v => v != null && v >= 0 && v <= 100; // a RATE can't exceed 100%
    const engRateDelta = (reliable && plausibleEr(latest.engagementRate) && plausibleEr(base.engagementRate) && base.engagementRate > 0)
      ? round1(latest.engagementRate - base.engagementRate) : null;

    platforms.push({
      platform: key, name,
      followers: latest.followers ?? null, followersDeltaPct: followersDelta,
      impressions: latest.impressions ?? null, impressionsDeltaPct: impressionsDelta,
      engagementRate: plausibleEr(latest.engagementRate) ? latest.engagementRate : null, engRateDeltaPts: engRateDelta,
      windowDays: r.days, reliable, baselineAgeDays,
    });

    if (!reliable) continue; // not enough history → never alert on noise

    // Anomaly flags — all deltas above are already null-guarded for sanity.
    if (impressionsDelta != null && impressionsDelta <= -ANOMALY.impressionsDropPct)
      anomalies.push({ platform: key, name, metric: 'impressions', severity: 'warn',
        message: `${name} impressions down ${Math.abs(impressionsDelta)}% over ${r.days}d — review recent content & cadence.` });
    if (engRateDelta != null && engRateDelta >= ANOMALY.engRateSpikePts)
      anomalies.push({ platform: key, name, metric: 'engagementRate', severity: 'good',
        message: `${name} engagement rate up ${engRateDelta} pts over ${r.days}d — identify what's resonating and do more of it.` });
    if (followersDelta != null && followersDelta < 0)
      anomalies.push({ platform: key, name, metric: 'followers', severity: 'warn',
        message: `${name} followers down ${Math.abs(followersDelta)}% over ${r.days}d.` });
  }

  // Viral-candidate posts: very high percentile score in the last 14 days.
  const viralParams = [ANOMALY.viralScore, _addDays(r.to, -14), ALLOWED];
  let viralClause = 'AND pl.key = ANY($3)';
  if (scope) { viralParams.push(scope.platform, scope.accountId); viralClause += ' AND pl.key = $4 AND p.account_key = $5'; }
  const { rows: viral } = await pool.query(`
    SELECT pl.key AS platform, p.title, p.topic, p.score, p.views, p.engagements AS eng, p.permalink, p.date
      FROM posts p JOIN platforms pl ON pl.id = p.platform_id
     WHERE p.score >= $1 AND p.date >= $2 ${viralClause}
     ORDER BY p.score DESC, p.views DESC LIMIT 5`, viralParams);
  for (const v of viral) {
    const name = mockService.PLATFORMS[v.platform]?.name || v.platform;
    anomalies.push({ platform: v.platform, name, metric: 'post', severity: 'good',
      message: `Viral candidate on ${name}: "${(v.title || '').slice(0, 60)}" scored ${v.score} (${Number(v.views).toLocaleString()} views) — study & replicate its hook/format.`,
      permalink: v.permalink || null });
  }

  return { period: r.period, range: { from: r.from, to: r.to }, platforms, anomalies, generatedAt: new Date().toISOString() };
}

/* ─────────────────────── Follower trajectory ─────────────────────── */
// Lightweight linear projection from follower_samples (the full predictive model
// is a later phase). Returns { platform, current, slopePerDay, projected30d, plateau }.
async function getTrajectory(platform, { days = 30 } = {}) {
  const key = String(platform || '').toLowerCase();
  if (!ALLOWED.includes(key)) { const e = new Error('Unknown platform'); e.status = 400; throw e; }

  // Resolve the primary account id for this platform.
  const { rows: accs } = await pool.query(
    `SELECT DISTINCT account_id FROM follower_samples WHERE platform = $1`, [key]);
  if (!accs.length) return { platform: key, current: null, slopePerDay: null, projected30d: null, plateau: null, note: 'No follower history recorded yet.' };
  const primaryId = await accounts.resolvePrimaryId(key, accs.map(a => a.account_id)).catch(() => accs[0].account_id);
  const accountId = primaryId || accs[0].account_id;

  // LAST reading per IST day — same semantics as the Overview trend chart, so a
  // projection is fitted to exactly the series the user sees (MAX would fit to
  // intraday peaks and read as steeper growth than actually happened).
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (day) day AS date, followers::bigint AS followers
      FROM (
        SELECT to_char(sampled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
               followers, sampled_at
          FROM follower_samples
         WHERE platform = $1 AND account_id = $2
           AND sampled_at >= now() - ($3 || ' days')::interval
      ) t ORDER BY day, sampled_at DESC`, [key, accountId, String(days)]);
  if (rows.length < 2) return { platform: key, current: rows[0] ? Number(rows[0].followers) : null, slopePerDay: null, projected30d: null, plateau: null, note: 'Not enough history to project yet.' };

  // Least-squares slope over day index.
  const pts = rows.map((r, i) => ({ x: i, y: Number(r.followers) }));
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.x, 0), sy = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0), sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const current = pts[n - 1].y;
  const projected30d = Math.round(current + slope * 30);
  const plateau = Math.abs(slope) < Math.max(1, current * 0.0002); // ~flat

  return {
    platform: key, accountId,
    current, slopePerDay: round1(slope), projected30d,
    plateau, trend: slope > 0 ? (plateau ? 'flat' : 'growing') : (plateau ? 'flat' : 'declining'),
    days: n, generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getExecutiveScorecard, getContentThemes, getTrendsAndAnomalies, getTrajectory,
};
