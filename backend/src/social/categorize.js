// ============================================================
// categorize.js — Rule-based content categorization.
//
// Fills posts.topic (which the sync pipeline always leaves NULL) by matching
// each post's caption + hashtags against an admin-editable theme→keywords map
// stored in app_settings('content_themes'). ZERO LLM / API cost — pure string
// matching. posts.topic is EXCLUDED from the sync ON CONFLICT update
// (syncService _upsertPosts), so the topic we write here survives every re-sync.
//
// A post with no keyword hit becomes 'Uncategorized' (never force-fit) so theme
// coverage stays honest and visible.
// ============================================================
const pool = require('./db');

const UNCATEGORIZED = 'Uncategorized';

// Fallback used only if the app_settings row is somehow missing (auth.js seeds it).
const FALLBACK_THEMES = {
  'AI Agents':  ['agent', 'mcp', 'claude', 'llm', 'gpt', 'autonomous'],
  'Automation': ['automation', 'automate', 'n8n', 'workflow', 'no-code'],
  'Tutorial':   ['tutorial', 'how to', 'guide', 'tips'],
};

let _cache = null; // { at, map }
const THEME_TTL = 5 * 60 * 1000;

// Load the theme map from app_settings (5-min cache). Returns { theme: [kw,...] }.
async function getThemeMap({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cache.at < THEME_TTL) return _cache.map;
  let map = FALLBACK_THEMES;
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'content_themes'`);
    if (rows[0]?.value) {
      const parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) map = parsed;
    }
  } catch (e) { console.error('[categorize] theme map load failed, using fallback:', e.message); }
  // Normalize: lowercase every keyword once.
  const norm = {};
  for (const [theme, kws] of Object.entries(map)) {
    norm[theme] = (Array.isArray(kws) ? kws : []).map(k => String(k).toLowerCase().trim()).filter(Boolean);
  }
  _cache = { at: Date.now(), map: norm };
  return norm;
}

function clearCache() { _cache = null; }

// Classify one caption against the theme map. Returns { topic, hits, matched }.
// Scores each theme by the number of distinct keywords found in the caption
// (a hashtag like #aiagents matches the "ai agents"/"agent" keyword too).
function categorize(caption, themeMap) {
  const text = String(caption || '').toLowerCase();
  if (!text.trim()) return { topic: UNCATEGORIZED, hits: 0, matched: [] };
  // Flatten hashtags so "#AIAgents" also matches "agent"/"ai".
  const hashtagWords = (text.match(/#[a-z0-9_]+/g) || []).map(h => h.slice(1));
  const haystack = text + ' ' + hashtagWords.join(' ');

  let best = { topic: UNCATEGORIZED, hits: 0, matched: [] };
  for (const [theme, kws] of Object.entries(themeMap)) {
    const matched = kws.filter(kw => haystack.includes(kw));
    if (matched.length > best.hits) best = { topic: theme, hits: matched.length, matched };
  }
  return best;
}

// Re-categorize stored posts. By default only fills posts with NULL topic (cheap,
// runs every sync). force:true re-runs ALL posts (use after editing the theme map).
// Returns { scanned, updated, byTopic }.
async function recategorizeAll({ onlyNull = true, force = false } = {}) {
  const themeMap = await getThemeMap({ fresh: force });
  const where = (force || !onlyNull) ? '' : 'WHERE topic IS NULL';
  const { rows } = await pool.query(`SELECT id, caption, title FROM posts ${where}`);
  if (!rows.length) return { scanned: 0, updated: 0, byTopic: {} };

  // Group post ids by computed topic, then one UPDATE per topic (cheap, batched).
  const idsByTopic = new Map();
  for (const r of rows) {
    const { topic } = categorize(r.caption || r.title, themeMap);
    if (!idsByTopic.has(topic)) idsByTopic.set(topic, []);
    idsByTopic.get(topic).push(r.id);
  }

  let updated = 0;
  const byTopic = {};
  for (const [topic, ids] of idsByTopic.entries()) {
    byTopic[topic] = ids.length;
    // Skip a no-op when only filling NULLs and the computed topic is Uncategorized
    // for a row that's already NULL — but we DO want to stamp 'Uncategorized' so it
    // stops being re-scanned every cycle. So always write.
    const res = await pool.query(`UPDATE posts SET topic = $1 WHERE id = ANY($2::bigint[])`, [topic, ids]);
    updated += res.rowCount || 0;
  }
  return { scanned: rows.length, updated, byTopic };
}

module.exports = { getThemeMap, clearCache, categorize, recategorizeAll, UNCATEGORIZED };
