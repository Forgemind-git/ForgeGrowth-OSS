/* ═══════════════════════════════════════════════════════════════════
   FORGESOCIAL — Mock Data & Helpers
   ═══════════════════════════════════════════════════════════════════ */

/* ─── Formatters ──────────────────────────────────────────────── */
export const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");
export const fmtNum = (n) => Number(n).toLocaleString("en-IN");
// Truncates, never rounds: 62,991 must read "62.9K", not "63.0K" — a count that
// rounds up claims a milestone the account has not reached.
export const fmtCompact = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const a = Math.abs(v);
  const cut = (div, unit) => (Math.trunc(v / (div / 10)) / 10).toFixed(1) + unit;
  if (a >= 10000000) return cut(10000000, "Cr");
  if (a >= 100000) return cut(100000, "L");
  if (a >= 1000) return cut(1000, "K");
  return String(v);
};
export const pct = (n) => n == null ? '—' : (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

/* ─── Period Scaling & Date Helpers ───────────────────────────── */
export const PERIOD_INFO = {
  "7D":     { mult: 0.28, days: 7,  label: "Last 7 days",     sub: "7-day window",  trendSlice: 5  },
  "30D":    { mult: 1,    days: 30, label: "Last 30 days",    sub: "30-day window", trendSlice: 14 },
  "90D":    { mult: 2.85, days: 90, label: "Last 90 days",    sub: "90-day window", trendSlice: 14 },
  "Custom": { mult: 1.4,  days: 45, label: "Apr 1 – May 14",  sub: "Custom range",  trendSlice: 14 },
};
export const scale = (n, p) => Math.round(n * PERIOD_INFO[p].mult);

export const REFERENCE_DATE = new Date(2025, 4, 14);
export const MONTH_MAP = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export const parseLibDate = (s) => {
  if (!s) return REFERENCE_DATE;
  const parts = s.replace(/'/g, "").split(/\s+/).filter(Boolean);
  const d = parseInt(parts[0], 10);
  const m = MONTH_MAP[parts[1]] ?? 0;
  const y = parts[2] ? 2000 + parseInt(parts[2], 10) : 2025;
  return new Date(y, m, d);
};
export const daysAgo = (date, ref = REFERENCE_DATE) => Math.floor((ref - date) / 86400000);

/* ─── Centralized Constants ───────────────────────────────────── */
export const SCORE_TIERS = { excellent: 90, good: 80, average: 70 };
export const SCORE_WEIGHTS = { engagementRate: 45, views: 30, clicks: 25 };
export const DATE_FILTER_MAP = {
  "Last 7 days":  7,
  "Last 30 days": 30,
  "Last 90 days": 90,
  "Year-to-date": 365,
};

/* ─── Platform Identity ───────────────────────────────────────── */
export const PLATFORMS = {
  instagram: { name: "Instagram", short: "IG", color: "#C13584", bg: "#FBE8F2", textOnBg: "#7A1F52" },
};
export const PLATFORM_ORDER = ["instagram"];
// Brand colour for UI use. `color` above stays the canonical brand hex (kept in
// sync with backend/src/mockService.js).
export const platformColor = (key) => PLATFORMS[key]?.color || "var(--fc-text)";

/* ─── Company ─────────────────────────────────────────────────── */
export const COMPANY = { name: "Acme Studio", handle: "@acme.studio", tagline: "AI Automation Studio · Bengaluru" };

/* ─── Overview KPIs ───────────────────────────────────────────── */
export const OVERVIEW_KPIS = [
  { label: "Total Audience",    value: 24936, delta: 5.2,  deltaLabel: "+1,247 in 30d", positive: true,  info: "Combined followers and subscribers across all connected social platforms." },
  { label: "Net Growth",        value: 1247,  delta: 18.4, deltaLabel: "vs prev. 30d",  positive: true,  info: "Net increase in total audience across all platforms during the selected period." },
  { label: "Total Impressions", value: 442100,delta: 12.7, deltaLabel: "vs prev. 30d",  positive: true,  info: "Total number of times your content was displayed to users across all platforms." },
  { label: "Avg. Eng. Rate",    value: 4.7,   delta: -0.3, deltaLabel: "vs prev. 30d",  positive: false, suffix: "%", info: "Average percentage of viewers who engaged with your content (likes, comments, shares, clicks)." },
];

/* ─── Trend Data ──────────────────────────────────────────────── */
export const TREND_DAYS = ["Apr 6","Apr 9","Apr 12","Apr 15","Apr 18","Apr 21","Apr 24","Apr 27","Apr 30","May 3","May 6","May 9","May 12","May 14"];
export const TREND_DATA = {
  instagram: [3800, 4100, 4600, 5200, 5800, 6400, 7100, 7900, 8800, 9700, 10600, 11400, 12300, 13100],
};

/* ─── Platform Data ───────────────────────────────────────────── */
export const PLATFORM_DATA = {
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

export const TOP_CONTENT = [
  { rank: 1, platform: "instagram", title: "Reel: 30s walkthrough of our WhatsApp bot",       date: "29 Apr", views: 32400, eng: 2890, score: 94 },
  { rank: 3, platform: "instagram", title: "5 prompts to 10x your ChatGPT outputs",            date: "10 May", views: 24800, eng: 2104, score: 91 },
];

export const AI_INSIGHTS = [
  { icon: "🎯", tone: "neutral", title: "Optimal posting time has shifted to 11 AM IST",      body: "Engagement window has moved from 9 AM to 11 AM (Tue–Thu). Plan upcoming posts to match." },
];

export const CONTENT_LIBRARY = [
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

export const TOPICS  = ["AI Workflows", "Product Demo", "Build in Public", "Prompting", "Tools", "Case Study", "Hot Takes", "Founder Voice", "Hiring", "Company News"];
export const FORMATS = ["Article", "Video", "Reel", "Carousel", "Post"];

export const POSTING_HEATMAP = [
  { day: "Mon", slots: [1.2, 4.1, 5.8, 3.2, 4.6, 2.1] },
  { day: "Tue", slots: [1.4, 5.2, 6.4, 3.9, 5.1, 2.4] },
  { day: "Wed", slots: [1.1, 4.8, 6.7, 4.1, 5.4, 2.6] },
  { day: "Thu", slots: [1.3, 5.4, 6.2, 3.8, 4.9, 2.2] },
  { day: "Fri", slots: [1.0, 3.9, 4.8, 3.1, 4.2, 1.9] },
  { day: "Sat", slots: [0.8, 2.4, 3.1, 2.6, 3.4, 1.6] },
  { day: "Sun", slots: [0.7, 2.1, 2.8, 2.4, 3.1, 1.4] },
];
export const HEATMAP_SLOTS = ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];

// Compute best posting time from heatmap data
export const BEST_POSTING_TIME = (() => {
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

export const ENG_TREND = [3.8, 4.1, 4.4, 4.0, 4.7, 5.2, 4.9, 5.1, 4.8, 4.7, 5.0, 5.3, 5.1, 4.7];

export const WEEKLY_REPORTS = [
  { id: "w19", week: "Week 19 · May 5–11",       audience: 24812, growth: 312, impressions: 108200, eng: 4.9, status: "ready" },
  { id: "w18", week: "Week 18 · Apr 28–May 4",   audience: 24500, growth: 287, impressions: 96400,  eng: 4.6, status: "ready" },
  { id: "w17", week: "Week 17 · Apr 21–27",      audience: 24213, growth: 248, impressions: 88100,  eng: 4.4, status: "ready" },
  { id: "w16", week: "Week 16 · Apr 14–20",      audience: 23965, growth: 211, impressions: 78400,  eng: 4.2, status: "ready" },
  { id: "w15", week: "Week 15 · Apr 7–13",       audience: 23754, growth: 189, impressions: 71000,  eng: 4.1, status: "ready" },
];

export const MONTHLY_REPORTS = [
  { id: "m05", month: "May 2025",  audience: 24936, growth: 1247, impressions: 442100, eng: 4.7, status: "in-progress" },
  { id: "m04", month: "Apr 2025",  audience: 23689, growth: 1054, impressions: 384700, eng: 4.4, status: "ready" },
  { id: "m03", month: "Mar 2025",  audience: 22635, growth: 892,  impressions: 312400, eng: 4.1, status: "ready" },
  { id: "m02", month: "Feb 2025",  audience: 21743, growth: 712,  impressions: 248100, eng: 3.8, status: "ready" },
  { id: "m01", month: "Jan 2025",  audience: 21031, growth: 524,  impressions: 198600, eng: 3.5, status: "ready" },
];

export const INTEGRATIONS = [
  { id: "ig",  name: "Instagram",         platform: "instagram", status: "connected",    lastSync: "8 min ago",  token: "healthy",  account: "@acme.studio" },
  { id: "ga",  name: "Google Analytics",  iconKey: "GA",         status: "connected",    lastSync: "3 min ago",  token: "healthy",  account: "GA4 · acme.studio", iconBg: "#FFF3E0", iconColor: "#E65100" },
  { id: "wa",  name: "WhatsApp Business", iconKey: "WA",         status: "connected",    lastSync: "1 hr ago",   token: "healthy",  account: "+91 80477 ····",  iconBg: "#E6F9ED", iconColor: "#25D366" },
  { id: "crm", name: "CRM (HubSpot)",     iconKey: "HS",         status: "disconnected", lastSync: "—",          token: "—",        account: "Not connected",   iconBg: "#FFE5DA", iconColor: "#E65100" },
];

export const NAV = [
  { id: "overview",    label: "Overview" },
  { id: "insights",    label: "Insights" },
  { id: "inbox",       label: "Inbox" },
  { id: "contacts",    label: "Contacts" },
  { id: "library",     label: "Content Library" },
  { id: "automations", label: "Automations" },
];
