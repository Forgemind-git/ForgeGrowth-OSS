/* ═══════════════════════════════════════════════════════════════════
   FORGESOCIAL — Mock Data Service
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Formatters ──────────────────────────────────────────────── */
const fmtNum = (n) => Number(n).toLocaleString("en-IN");
const _fmtCompact = (n) => {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000) return (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
};

/* ─── Period Scaling & Date Helpers ───────────────────────────── */
const PERIOD_INFO = {
  "7D":     { mult: 0.28, days: 7,  label: "Last 7 days",     sub: "7-day window",  trendSlice: 5  },
  "30D":    { mult: 1,    days: 30, label: "Last 30 days",    sub: "30-day window", trendSlice: 14 },
  "90D":    { mult: 2.85, days: 90, label: "Last 90 days",    sub: "90-day window", trendSlice: 14 },
  "Custom": { mult: 1.4,  days: 45, label: "Apr 1 – May 14",  sub: "Custom range",  trendSlice: 14 },
};
const scale = (n, p) => (n == null ? null : Math.round(n * PERIOD_INFO[p].mult));

const REFERENCE_DATE = new Date(2025, 4, 14);
const MONTH_MAP = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const parseLibDate = (s) => {
  if (!s) return REFERENCE_DATE;
  const parts = s.replace(/'/g, "").split(/\s+/).filter(Boolean);
  const d = parseInt(parts[0], 10);
  const m = MONTH_MAP[parts[1]] ?? 0;
  const y = parts[2] ? 2000 + parseInt(parts[2], 10) : 2025;
  return new Date(y, m, d);
};
const daysAgo = (date, ref = REFERENCE_DATE) => Math.floor((ref - date) / 86400000);

/* ─── Centralized Constants ───────────────────────────────────── */
const SCORE_TIERS = { excellent: 90, good: 80, average: 70 };
const SCORE_WEIGHTS = { engagementRate: 45, views: 30, clicks: 25 };
const DATE_FILTER_MAP = {
  "Last 7 days":  7,
  "Last 30 days": 30,
  "Last 90 days": 90,
  "Year-to-date": 365,
};

/* ─── Platform Identity ───────────────────────────────────────── */
const PLATFORMS = {
  instagram: { name: "Instagram", short: "IG", color: "#C13584", bg: "#FBE8F2", textOnBg: "#7A1F52" },
};
const PLATFORM_ORDER = ["instagram"];

/* ─── Company ─────────────────────────────────────────────────── */
const COMPANY = { name: "Acme Studio", handle: "@acme.studio", tagline: "AI Automation Studio · Bengaluru" };

/* ─── Overview KPIs ───────────────────────────────────────────── */
const OVERVIEW_KPIS = [
  { label: "Total Audience",    value: 24936, delta: 5.2,  deltaLabel: "+1,247 in 30d", positive: true,  info: "Combined followers and subscribers across all connected social platforms." },
  { label: "Net Growth",        value: 1247,  delta: 18.4, deltaLabel: "vs prev. 30d",  positive: true,  info: "Net increase in total audience across all platforms during the selected period." },
  { label: "Total Impressions", value: 442100,delta: 12.7, deltaLabel: "vs prev. 30d",  positive: true,  info: "Total number of times your content was displayed to users across all platforms." },
  { label: "Avg. Eng. Rate",    value: 4.7,   delta: -0.3, deltaLabel: "vs prev. 30d",  positive: false, suffix: "%", info: "Average percentage of viewers who engaged with your content (likes, comments, shares, clicks)." },
];

/* ─── Trend Data ──────────────────────────────────────────────── */
const TREND_DAYS = ["Apr 6","Apr 9","Apr 12","Apr 15","Apr 18","Apr 21","Apr 24","Apr 27","Apr 30","May 3","May 6","May 9","May 12","May 14"];
const TREND_DATA = {
  instagram: [3800, 4100, 4600, 5200, 5800, 6400, 7100, 7900, 8800, 9700, 10600, 11400, 12300, 13100],
};

/* ─── Platform Data ───────────────────────────────────────────── */
const PLATFORM_DATA = {
  instagram: {
    followers: 6832, growth: 428, growthPct: 6.7,
    impressions: 142300, reach: 98200, engagementRate: 4.2, clicks: 814, posts: 24,
    impressionsDelta: 14.3, reachDelta: 10.8, engagementDelta: -0.2, clicksDelta: 12.4, postsDelta: 8.5,
    extras: [
      { label: "Reach",          value: 98200, info: "Unique Instagram users who saw your content." },
      { label: "Profile Visits", value: 3210,  info: "Number of users who visited your Instagram profile." },
      { label: "Saves",          value: 1842,  info: "Number of times your Instagram content was saved." },
      { label: "Shares",         value: 924,   info: "Number of times your Instagram content was shared." },
    ],
    topPosts: [
      { id: "ig1", title: "5 prompts to 10x your ChatGPT outputs (carousel)", date: "10 May", views: 24800, eng: 2104, clicks: 218, score: 91, likes: 1189, comments: 463, shares: 316 },
      { id: "ig2", title: "Behind the scenes: building our voice AI demo", date: "5 May", views: 18200, eng: 1487, clicks: 142, score: 84, likes: 832, comments: 342, shares: 228 },
      { id: "ig3", title: "Reel: 30s walkthrough of our WhatsApp bot", date: "29 Apr", views: 32400, eng: 2890, clicks: 198, score: 88, likes: 1628, comments: 635, shares: 432 },
      { id: "ig4", title: "Founder Q&A — why we don't use AI for everything", date: "22 Apr", views: 9400, eng: 712, clicks: 84, score: 73, likes: 405, comments: 168, shares: 112 },
    ],
  },
};

const CONTENT_LIBRARY = [
  { id: 2,  platform: "instagram", title: "Reel: 30s WhatsApp bot walkthrough",                    type: "Reel",     topic: "Product Demo",    date: "29 Apr '25", views: 32400, eng: 2890, clicks: 198 },
  { id: 4,  platform: "instagram", title: "5 prompts to 10x your ChatGPT outputs",                 type: "Carousel", topic: "Prompting",       date: "10 May '25", views: 24800, eng: 2104, clicks: 218 },
  { id: 7,  platform: "instagram", title: "Behind the scenes: voice AI demo",                       type: "Reel",     topic: "Build in Public", date: "5 May '25",  views: 18200, eng: 1487, clicks: 142 },
  { id: 11, platform: "instagram", title: "Founder Q&A — why we don't use AI for everything",      type: "Reel",     topic: "Founder Voice",   date: "22 Apr '25", views: 9400,  eng: 712,  clicks: 84  },
];

// Compute content scores
(() => {
  const maxV  = Math.max(...CONTENT_LIBRARY.map(c => c.views));
  const maxC  = Math.max(...CONTENT_LIBRARY.map(c => c.clicks));
  const ers   = CONTENT_LIBRARY.map(c => c.views > 0 ? (c.eng / c.views) * 100 : 0);
  const maxER = Math.max(...ers);
  CONTENT_LIBRARY.forEach((c, i) => {
    c.score = Math.min(99, Math.round(
      (ers[i]   / maxER) * SCORE_WEIGHTS.engagementRate +
      (c.views  / maxV)  * SCORE_WEIGHTS.views +
      (c.clicks / maxC)  * SCORE_WEIGHTS.clicks
    ));
  });
})();

const TOPICS  = ["AI Workflows", "Product Demo", "Build in Public", "Prompting", "Tools", "Case Study", "Hot Takes", "Founder Voice", "Hiring", "Company News"];
const FORMATS = ["Article", "Video", "Reel", "Carousel", "Post"];

const POSTING_HEATMAP = [
  { day: "Mon", slots: [1.2, 4.1, 5.8, 3.2, 4.6, 2.1] },
  { day: "Tue", slots: [1.4, 5.2, 6.4, 3.9, 5.1, 2.4] },
  { day: "Wed", slots: [1.1, 4.8, 6.7, 4.1, 5.4, 2.6] },
  { day: "Thu", slots: [1.3, 5.4, 6.2, 3.8, 4.9, 2.2] },
  { day: "Fri", slots: [1.0, 3.9, 4.8, 3.1, 4.2, 1.9] },
  { day: "Sat", slots: [0.8, 2.4, 3.1, 2.6, 3.4, 1.6] },
  { day: "Sun", slots: [0.7, 2.1, 2.8, 2.4, 3.1, 1.4] },
];
const HEATMAP_SLOTS = ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];

const BEST_POSTING_TIME = (() => {
  let maxVal = -Infinity;
  let bestDay = "";
  let bestSlot = "";
  POSTING_HEATMAP.forEach(row => {
    row.slots.forEach((v, i) => {
      if (v > maxVal) {
        maxVal = v;
        bestDay = row.day;
        bestSlot = HEATMAP_SLOTS[i];
      }
    });
  });
  return `${bestDay} · ${bestSlot} peak`;
})();

const ENG_TREND = [3.8, 4.1, 4.4, 4.0, 4.7, 5.2, 4.9, 5.1, 4.8, 4.7, 5.0, 5.3, 5.1, 4.7];

const WEEKLY_REPORTS = [
  { id: "w19", week: "Week 19 · May 5–11",       audience: 24812, growth: 312, impressions: 108200, eng: 4.9, status: "ready" },
  { id: "w18", week: "Week 18 · Apr 28–May 4",   audience: 24500, growth: 287, impressions: 96400,  eng: 4.6, status: "ready" },
  { id: "w17", week: "Week 17 · Apr 21–27",      audience: 24213, growth: 248, impressions: 88100,  eng: 4.4, status: "ready" },
  { id: "w16", week: "Week 16 · Apr 14–20",      audience: 23965, growth: 211, impressions: 78400,  eng: 4.2, status: "ready" },
  { id: "w15", week: "Week 15 · Apr 7–13",       audience: 23754, growth: 189, impressions: 71000,  eng: 4.1, status: "ready" },
];

const MONTHLY_REPORTS = [
  { id: "m05", month: "May 2025",  audience: 24936, growth: 1247, impressions: 442100, eng: 4.7, status: "in-progress" },
  { id: "m04", month: "Apr 2025",  audience: 23689, growth: 1054, impressions: 384700, eng: 4.4, status: "ready" },
  { id: "m03", month: "Mar 2025",  audience: 22635, growth: 892,  impressions: 312400, eng: 4.1, status: "ready" },
  { id: "m02", month: "Feb 2025",  audience: 21743, growth: 712,  impressions: 248100, eng: 3.8, status: "ready" },
  { id: "m01", month: "Jan 2025",  audience: 21031, growth: 524,  impressions: 198600, eng: 3.5, status: "ready" },
];

const INTEGRATIONS = [
  { id: "ig",  name: "Instagram",         platform: "instagram", status: "connected",    lastSync: "8 min ago",  token: "healthy",  account: "@acme.studio" },
  { id: "ga",  name: "Google Analytics",  iconKey: "GA",         status: "connected",    lastSync: "3 min ago",  token: "healthy",  account: "GA4 · acme.studio", iconBg: "#FFF3E0", iconColor: "#E65100" },
  { id: "wa",  name: "WhatsApp Business", iconKey: "WA",         status: "connected",    lastSync: "1 hr ago",   token: "healthy",  account: "+91 80477 ····",  iconBg: "#E6F9ED", iconColor: "#25D366" },
  { id: "crm", name: "CRM (HubSpot)",     iconKey: "HS",         status: "disconnected", lastSync: "—",          token: "—",        account: "Not connected",   iconBg: "#FFE5DA", iconColor: "#E65100" },
];

const AI_INSIGHTS = [
  { icon: "🎯", tone: "neutral", title: "Optimal posting time has shifted to 11 AM IST",      body: "Engagement window has moved from 9 AM to 11 AM (Tue–Thu). Plan upcoming posts to match." },
];

const _NAV = [
  { id: "overview",    label: "Overview" },
  { id: "library",     label: "Content Library" },
  { id: "performance", label: "Content Performance" },
  { id: "reports",     label: "Reports" },
  { id: "integrations",label: "Integrations" },
  { id: "settings",    label: "Settings" },
];

/* ═══════════════════════════════════════════════════════════════════
   GETTERS
   ═══════════════════════════════════════════════════════════════════ */

function getOverview(period = "30D") {
  const info = PERIOD_INFO[period] || PERIOD_INFO["30D"];
  const kpis = OVERVIEW_KPIS.map((k, i) => ({
    ...k,
    value: i === 0 || k.suffix === "%" ? k.value : scale(k.value, period),
    deltaLabel: i === 0
      ? `+${fmtNum(scale(OVERVIEW_KPIS[1].value, period))} in ${info.days}d`
      : `vs prev. ${info.days}d`,
  }));

  return {
    period,
    periodInfo: info,
    kpis,
    platforms: PLATFORM_ORDER.map(key => ({
      key,
      ...PLATFORMS[key],
      trend: TREND_DATA[key].slice(-info.trendSlice),
    })),
    trendDays: TREND_DAYS.slice(-info.trendSlice),
  };
}

function getPlatformStats(key, period = "30D") {
  if (!PLATFORM_DATA[key]) return null;
  const info = PERIOD_INFO[period] || PERIOD_INFO["30D"];
  const data = PLATFORM_DATA[key];
  const scaledImpressions = scale(data.impressions, period);
  const scaledReach       = scale(data.reach, period);
  const scaledClicks      = data.clicks != null ? scale(data.clicks, period) : null;
  const scaledPosts       = Math.max(1, scale(data.posts, period));
  const scaledGrowth      = scale(data.growth, period);

  const filteredPosts = data.topPosts.filter(p => daysAgo(parseLibDate(p.date)) <= info.days);

  return {
    key,
    platform: PLATFORMS[key],
    followers: data.followers,
    growth: data.growth,
    growthPct: data.growthPct,
    impressions: scaledImpressions,
    reach: scaledReach,
    engagementRate: data.engagementRate,
    clicks: scaledClicks,
    posts: scaledPosts,
    scaledGrowth,
    impressionsDelta: data.impressionsDelta,
    reachDelta: data.reachDelta,
    engagementDelta: data.engagementDelta,
    clicksDelta: data.clicksDelta,
    postsDelta: data.postsDelta,
    extras: data.extras.map(e => ({
      ...e,
      value: e.raw ? e.value : scale(e.value, period),
    })),
    topPosts: filteredPosts,
    trend: TREND_DATA[key].slice(-info.trendSlice),
    trendDays: TREND_DAYS.slice(-info.trendSlice),
  };
}

function getContentLibrary(filters = {}) {
  const { platform, topic, format: formatFilter, dateFilter, sortBy = "score", search } = filters;
  const days = dateFilter ? (DATE_FILTER_MAP[dateFilter] ?? Infinity) : Infinity;

  let filtered = CONTENT_LIBRARY.filter(c => {
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
    if (platform && PLATFORMS[c.platform].name !== platform) return false;
    if (topic && c.topic !== topic) return false;
    if (formatFilter && c.type !== formatFilter) return false;
    if (days < Infinity && daysAgo(parseLibDate(c.date)) > days) return false;
    return true;
  });

  filtered = [...filtered].sort((a, b) => b[sortBy] - a[sortBy]);

  return {
    posts: filtered,
    total: CONTENT_LIBRARY.length,
    topics: TOPICS,
    formats: FORMATS,
    dateFilterOptions: Object.keys(DATE_FILTER_MAP),
  };
}

function getPerformance(period = "30D", platformFilter = null) {
  const info = PERIOD_INFO[period] || PERIOD_INFO["30D"];
  const platformKey = platformFilter
    ? PLATFORM_ORDER.find(k => PLATFORMS[k].name === platformFilter)
    : null;

  let lib = CONTENT_LIBRARY.filter(c => {
    if (platformKey && c.platform !== platformKey) return false;
    if (daysAgo(parseLibDate(c.date)) > info.days) return false;
    return true;
  });

  const perfByTopic = (() => {
    const groups = {};
    lib.forEach(c => {
      if (!groups[c.topic]) groups[c.topic] = { topic: c.topic, posts: 0, totalViews: 0, totalEng: 0, totalScore: 0 };
      groups[c.topic].posts += 1;
      groups[c.topic].totalViews += c.views;
      groups[c.topic].totalEng += c.eng;
      groups[c.topic].totalScore += c.score;
    });
    return Object.values(groups)
      .map(g => ({ topic: g.topic, posts: g.posts, avgViews: Math.round(g.totalViews / g.posts), avgEng: Math.round(g.totalEng / g.posts), avgScore: Math.round(g.totalScore / g.posts) }))
      .sort((a, b) => b.avgViews - a.avgViews);
  })();

  const perfByFormat = (() => {
    const groups = {};
    lib.forEach(c => {
      if (!groups[c.type]) groups[c.type] = { format: c.type, posts: 0, totalViews: 0, totalEng: 0, totalScore: 0 };
      groups[c.type].posts += 1;
      groups[c.type].totalViews += c.views;
      groups[c.type].totalEng += c.eng;
      groups[c.type].totalScore += c.score;
    });
    return Object.values(groups)
      .map(g => ({ format: g.format, posts: g.posts, avgViews: Math.round(g.totalViews / g.posts), avgEng: Math.round(g.totalEng / g.posts), avgScore: Math.round(g.totalScore / g.posts) }))
      .sort((a, b) => b.avgViews - a.avgViews);
  })();

  const sortedLib = [...lib].sort((a, b) => b.score - a.score);
  const best = sortedLib.slice(0, 3);
  const bestIds = new Set(best.map(c => c.id));
  const worst = sortedLib.slice(-3).reverse().filter(c => !bestIds.has(c.id));

  return {
    period,
    periodInfo: info,
    scopeLabel: `${platformFilter ? platformFilter + " · " : ""}${info.sub}`,
    perfByTopic,
    perfByFormat,
    heatmap: POSTING_HEATMAP,
    heatmapSlots: HEATMAP_SLOTS,
    bestPostingTime: BEST_POSTING_TIME,
    engTrend: ENG_TREND.slice(-info.trendSlice),
    engTrendDays: TREND_DAYS.slice(-info.trendSlice),
    best,
    worst,
    platformFilter,
  };
}

function getReports() {
  return {
    weekly: WEEKLY_REPORTS,
    monthly: MONTHLY_REPORTS,
  };
}

function getIntegrations() {
  return INTEGRATIONS;
}

function getInsights() {
  return AI_INSIGHTS;
}

function getSettings() {
  return {
    workspace: {
      name: COMPANY.name,
      handle: COMPANY.handle,
      timezone: "Asia/Kolkata (IST · UTC+5:30)",
    },
    notifications: {
      weeklyReportEmail: true,
      monthlyReportEmail: true,
      alertsForEngagementDrops: true,
      aiInsightsDigest: true,
      tokenExpiryReminders: true,
      marketingEmails: false,
    },
    team: [
      { name: "Arjun K.", role: "Founder · Owner",   color: "#1D9E75" },
      { name: "Priya M.", role: "Marketing Lead",    color: "#534AB7" },
      { name: "Vikram R.", role: "AI Engineer",      color: "#E65100" },
    ],
  };
}

module.exports = {
  getOverview,
  getPlatformStats,
  getContentLibrary,
  getPerformance,
  getReports,
  getIntegrations,
  getInsights,
  getSettings,
  PLATFORMS,
  PLATFORM_ORDER,
  COMPANY,
  PERIOD_INFO,
  SCORE_TIERS,
  POSTING_HEATMAP,
  HEATMAP_SLOTS,
  BEST_POSTING_TIME,
  ENG_TREND,
  TREND_DAYS,
};
