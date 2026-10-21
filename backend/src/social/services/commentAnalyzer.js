// Comment Analyzer — classifies Instagram comments with TypeSafe
// Jev (OpenRouter "decisions" endpoint): sentiment, what the commenter is doing,
// insightful?, needs a reply?, abusive?
//
// Token saving happens BEFORE any call (all configurable, settings in
// app_settings.comment_analyzer_settings):
//   - our own comments / replies are never analysed
//   - comment-automation keywords (auto-collected from Quick Automations + Flow
//     triggers, plus a custom list): short comments containing one are skipped
//   - fewer than N words, emoji-only, links
//   - repeated comments: the same text is analysed once and the result reused
// Skipped comments still get a row (status 'skipped' + reason) so the Results
// tab can show what was filtered. Calls are logged in ai_usage_log for spend.
const pool = require('../db');
const openRouter = require('./openRouter');

const FEATURE = 'comment_analyzer';
const K_SETTINGS = 'comment_analyzer_settings';
const PLATFORMS = ['instagram'];
const DEFAULTS = {
  enabled: false,
  model: 'typesafe/jev-1.13',
  platforms: PLATFORMS,
  accounts: null,            // null = every account; else ['instagram|<id>', …]
  sinceDays: 90,
  minWords: 3,
  skipAutomationKeywords: true,
  keywords: [],              // extra words to treat like automation keywords
  keywordMaxWords: 3,        // "link pls", "send link bro" count as keyword comments
  skipEmojiOnly: true,
  skipLinks: false,
  repeated: 'reuse',         // reuse | skip | analyze
  repeatThreshold: 3,
  includeCaption: true,
  dailyLimit: 3000,
  analyzeDms: false,         // Instagram DMs: one call per conversation, re-run when they write again
};

const SENTIMENTS = ['positive', 'neutral', 'negative'];
const CATEGORIES = {
  praise: 'Compliments, thanks or appreciation',
  question: 'Asks a question about the content, course, product or service',
  lead: 'Wants to buy, join or enroll, or asks for price, fees or contact details',
  feedback: 'Gives a suggestion, correction or idea for improvement',
  complaint: 'Reports a problem, is unhappy or disappointed',
  request: 'Asks for the link, file, details or a DM',
  spam: 'Promotion, scam, unrelated links or bot-like text',
  other: 'Tags a friend, chit-chat or anything else',
};
const QUESTIONS = {
  sentiment: { type: 'choice', instructions: 'Overall sentiment of the comment toward the creator or the post', criteria: {
    positive: 'Praise, thanks, excitement, agreement', neutral: 'Factual, a plain question or request with no clear feeling', negative: 'Criticism, complaint, anger, disappointment or insult' } },
  category: { type: 'choice', instructions: 'What is the commenter mainly doing?', criteria: CATEGORIES },
  insightful: { type: 'noul', instructions: 'Does the comment contain a specific, useful insight, correction, idea or content request the creator could act on?' },
  needs_reply: { type: 'noul', instructions: 'Should the creator reply to this comment?' },
  toxic: { type: 'noul', instructions: 'Is the comment abusive, hateful, harassing or sexually explicit?' },
};

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await openRouter.ensureSchema();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS comment_analysis (
          platform        text NOT NULL,
          comment_id      text NOT NULL,
          status          text NOT NULL,            -- done | skipped
          skip_reason     text,
          norm_text       text,
          sentiment       text,
          sentiment_conf  real,
          category        text,
          category_conf   real,
          insightful      real,
          needs_reply     real,
          toxic           real,
          reused          boolean NOT NULL DEFAULT false,
          model           text,
          analyzed_at     timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (platform, comment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_comment_analysis_norm ON comment_analysis (norm_text) WHERE status = 'done';
        CREATE INDEX IF NOT EXISTS idx_comment_analysis_at ON comment_analysis (analyzed_at DESC);
        -- One row per Instagram conversation, labelled from the person's latest messages.
        CREATE TABLE IF NOT EXISTS dm_analysis (
          account_id      text NOT NULL,
          peer_id         text NOT NULL,
          last_mid        text,                     -- newest incoming message covered
          last_in_ts      timestamptz,
          status          text NOT NULL,            -- done | skipped
          skip_reason     text,
          sentiment       text,
          sentiment_conf  real,
          category        text,
          category_conf   real,
          insightful      real,
          needs_reply     real,
          toxic           real,
          model           text,
          analyzed_at     timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (account_id, peer_id)
        );
      `);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function getSettings() {
  let s = {};
  try { s = JSON.parse(await getSetting(K_SETTINGS) || '{}'); } catch (_) {}
  return { ...DEFAULTS, ...s };
}
function cleanSettings(b = {}) {
  const s = { ...DEFAULTS };
  const num = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  s.enabled = !!b.enabled;
  s.model = String(b.model || DEFAULTS.model).trim().slice(0, 120);
  s.platforms = (Array.isArray(b.platforms) ? b.platforms : DEFAULTS.platforms).filter(p => PLATFORMS.includes(p));
  s.accounts = Array.isArray(b.accounts) ? [...new Set(b.accounts.map(String).filter(t => PLATFORMS.includes(t.split('|')[0])))].slice(0, 200) : null;
  if (s.accounts) s.platforms = PLATFORMS.filter(p => s.accounts.some(t => t.startsWith(p + '|')));
  s.sinceDays = num(b.sinceDays, 1, 3650, DEFAULTS.sinceDays);
  s.minWords = num(b.minWords, 1, 20, DEFAULTS.minWords);
  s.skipAutomationKeywords = b.skipAutomationKeywords !== false;
  s.keywords = (Array.isArray(b.keywords) ? b.keywords : []).map(k => norm(k)).filter(Boolean).slice(0, 200);
  s.keywordMaxWords = num(b.keywordMaxWords, 1, 10, DEFAULTS.keywordMaxWords);
  s.skipEmojiOnly = b.skipEmojiOnly !== false;
  s.skipLinks = !!b.skipLinks;
  s.repeated = ['reuse', 'skip', 'analyze'].includes(b.repeated) ? b.repeated : DEFAULTS.repeated;
  s.repeatThreshold = num(b.repeatThreshold, 2, 1000, DEFAULTS.repeatThreshold);
  s.includeCaption = b.includeCaption !== false;
  s.dailyLimit = num(b.dailyLimit, 0, 100000, DEFAULTS.dailyLimit);
  s.analyzeDms = !!b.analyzeDms;
  return s;
}
async function saveSettings(body) {
  const s = cleanSettings(body);
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [K_SETTINGS, JSON.stringify(s)]);
  return s;
}

// lower-case, letters/digits only (any script), single spaces
function norm(t) {
  return String(t || '').toLowerCase().normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/[\u200d\ufe0e\ufe0f\u20e3]/g, '')          // eslint-disable-line no-misleading-character-class -- emoji joiners / variation selectors, stripped one by one
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/(^|\s)\p{M}+/gu, '$1')                       // stray marks left by emoji
    .replace(/\s+/g, ' ').trim();
}
const words = (n) => (n ? n.split(' ').length : 0);

// Keywords the automations react to (Quick Automations + Flow comment/DM triggers).
async function automationKeywords() {
  const out = new Set();
  try {
    const { rows } = await pool.query('SELECT keywords FROM ig_automation_rules');
    for (const r of rows) for (const k of r.keywords || []) out.add(norm(k));
  } catch (_) {}
  try {
    const { rows } = await pool.query(`SELECT graph FROM ig_flows`);
    for (const r of rows) for (const n of r.graph?.nodes || []) for (const t of n.data?.triggers || []) for (const k of t.keywords || []) out.add(norm(k));
  } catch (_) {}
  out.delete('');
  return [...out];
}

// All Instagram comments in one shape, newest first. `ours` = written by
// one of our accounts (never analysed).
const SOURCE = `
  -- Accounts with no stored username: the handle that writes most of the replies
  -- on its posts (10+) is the account itself (its automation / manual replies).
  WITH ig_inferred AS (
    SELECT DISTINCT ON (c.account_id) c.account_id, lower(c.from_username) u
      FROM instagram_comments c JOIN instagram_accounts a ON a.account_id = c.account_id AND a.username IS NULL
     WHERE c.parent_id IS NOT NULL AND c.from_username IS NOT NULL
     GROUP BY c.account_id, c.from_username HAVING count(*) >= 10
     ORDER BY c.account_id, count(*) DESC
  ),
  own AS (
    SELECT lower(username) u FROM instagram_accounts WHERE username IS NOT NULL
    UNION SELECT u FROM ig_inferred
  ),
  src AS (
    -- Instagram withholds the author on some API-synced comments. When one of our
    -- accounts replied, Instagram starts the reply with "@theirhandle" — use it.
    SELECT 'instagram' AS platform, c.comment_id, c.text,
           COALESCE(c.from_username, (
             SELECT substring(r.text from '^@([A-Za-z0-9._]{1,30})') FROM instagram_comments r
              WHERE r.parent_id = c.comment_id AND lower(COALESCE(r.from_username, '')) IN (SELECT u FROM own)
                AND r.text ~ '^@[A-Za-z0-9._]'
                AND lower(substring(r.text from '^@([A-Za-z0-9._]{1,30})')) NOT IN (SELECT u FROM own)
              ORDER BY r.ts LIMIT 1)) AS author,
           c.media_id AS post_id, c.parent_id, c.ts,
           (lower(COALESCE(c.from_username,'')) IN (SELECT u FROM own)) AS ours, c.account_id, c.account_id AS acct
      FROM instagram_comments c
  )`;
const TOKEN = `(src.platform || '|' || COALESCE(src.acct, ''))`;

// Which accounts the analyzer covers: the saved list, or every account of the chosen platforms.
async function scopeTokens(s) {
  if (s.accounts) return s.accounts;
  return (await listAccounts()).filter(a => s.platforms.includes(a.platform)).map(a => a.value);
}

// Every account that has comments, with a readable name and counts.
async function listAccounts() {
  const { rows } = await pool.query(`${SOURCE}
    SELECT src.platform, COALESCE(src.acct, '') AS acct, count(*)::int AS comments,
           count(*) FILTER (WHERE src.ts > now() - interval '30 days')::int AS recent
      FROM src WHERE NOT src.ours GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
  const { rows: ig } = await pool.query(`SELECT account_id, username, name, COALESCE(hidden,false) AS hidden FROM instagram_accounts`);
  const { rows: inferred } = await pool.query(`SELECT DISTINCT ON (c.account_id) c.account_id, c.from_username AS u
      FROM instagram_comments c JOIN instagram_accounts a ON a.account_id = c.account_id AND a.username IS NULL
     WHERE c.parent_id IS NOT NULL AND c.from_username IS NOT NULL
     GROUP BY c.account_id, c.from_username HAVING count(*) >= 10 ORDER BY c.account_id, count(*) DESC`);
  for (const r of inferred) { const a = ig.find(x => x.account_id === r.account_id); if (a) a.username = r.u; }
  const igMap = new Map(ig.map(r => [r.account_id, r]));
  return rows.filter(r => !(r.platform === 'instagram' && (r.acct === '0' || r.acct === ''))).map(r => {
    const a = igMap.get(r.acct);
    const label = a?.username ? '@' + a.username : a?.name || `Instagram account …${r.acct.slice(-6)}`;
    return { value: `${r.platform}|${r.acct}`, platform: r.platform, label, sublabel: a?.name && a?.username ? a.name : null, hidden: !!a?.hidden, comments: r.comments, recent: r.recent };
  });
}

// Decide, without any model call, what happens to one comment.
function prefilter(text, s, ctx) {
  const n = norm(text);
  const w = words(n);
  if (!n) return { reason: /https?:\/\//.test(text || '') ? 'link' : (String(text || '').trim() ? 'emoji_only' : 'empty'), n };
  if (s.skipLinks && /https?:\/\/|www\./i.test(text || '')) return { reason: 'link', n };
  if (ctx.keywords.length && w <= s.keywordMaxWords && ctx.keywords.some(k => n === k || (' ' + n + ' ').includes(' ' + k + ' '))) return { reason: 'automation_keyword', n };
  if (w < s.minWords) return { reason: 'too_short', n };
  if (s.repeated === 'skip' && (ctx.counts.get(n) || 0) >= s.repeatThreshold) return { reason: 'repeated', n };
  return { reason: null, n };
}
// emoji-only is only skipped when the setting is on — otherwise it is "too short"
function applyEmojiRule(r, s) {
  if (r.reason === 'emoji_only' && !s.skipEmojiOnly) return { ...r, reason: 'too_short' };
  return r;
}

async function context(s) {
  const kws = new Set(s.keywords);
  if (s.skipAutomationKeywords) for (const k of await automationKeywords()) kws.add(k);
  const { rows } = await pool.query(`${SOURCE} SELECT text FROM src WHERE NOT ours AND ${TOKEN} = ANY($1) AND ts > now() - ($2 || ' days')::interval`, [await scopeTokens(s), String(s.sinceDays)]);
  const counts = new Map();
  for (const r of rows) { const n = norm(r.text); if (n) counts.set(n, (counts.get(n) || 0) + 1); }
  return { keywords: [...kws], counts, total: rows.length };
}

// What the current (or unsaved) settings would do — counts + cost estimate.
async function preview(body) {
  await ensureSchema();
  const s = body ? cleanSettings({ ...(await getSettings()), ...body }) : await getSettings();
  const ctx = await context(s);
  const { rows } = await pool.query(`${SOURCE} SELECT text FROM src WHERE NOT ours AND ${TOKEN} = ANY($1) AND ts > now() - ($2 || ' days')::interval`, [await scopeTokens(s), String(s.sinceDays)]);
  const reasons = {};
  const seen = new Set();
  let send = 0, reused = 0;
  for (const r of rows) {
    const p = applyEmojiRule(prefilter(r.text, s, ctx), s);
    if (p.reason) { reasons[p.reason] = (reasons[p.reason] || 0) + 1; continue; }
    if (s.repeated === 'reuse' && seen.has(p.n)) { reused++; continue; }
    seen.add(p.n); send++;
  }
  const { rows: [avg] } = await pool.query(`SELECT avg(cost_usd)::float AS a FROM ai_usage_log WHERE feature = $1 AND cost_usd > 0`, [FEATURE]);
  const perCall = avg?.a || 0.000027;
  const fx = await openRouter.inrRate();
  // Most repeated short comments — one-click candidates for the keyword list.
  const topRepeated = [...ctx.counts].filter(([n, c]) => c >= 5 && words(n) <= 4).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([text, count]) => ({ text, count }));
  // DMs: conversations with an incoming message in the window on the selected IG accounts.
  let dms = null;
  if (s.analyzeDms) {
    const ig = (await scopeTokens(s)).filter(t => t.startsWith('instagram|')).map(t => t.split('|')[1]);
    const { rows: [d] } = await pool.query(`SELECT count(DISTINCT (account_id, sender_id))::int AS n FROM instagram_messages
      WHERE direction = 'incoming' AND account_id = ANY($1) AND ts > now() - ($2 || ' days')::interval`, [ig, String(s.sinceDays)]);
    dms = { conversations: d.n, estInr: d.n * perCall * fx.rate };
  }
  return { dms, total: rows.length, send, reused, skipped: reasons, topRepeated, keywords: ctx.keywords, perCallUsd: perCall, estUsd: send * perCall, estInr: send * perCall * fx.rate, inrRate: fx.rate };
}

// ── worker ──
let running = false;
let lastRun = null;
async function run({ max = 400, manual = false } = {}) {
  if (running) return { busy: true };
  running = true;
  const started = Date.now();
  const res = { analyzed: 0, reused: 0, skipped: 0, errors: 0, stopped: null, dms: 0, dmsSkipped: 0 };
  try {
    await ensureSchema();
    const s = await getSettings();
    if (!s.enabled && !manual) return { ...res, stopped: 'disabled' };
    if (!await openRouter.getKey()) return { ...res, stopped: 'OpenRouter is not connected' };
    const { rows: [{ n: today }] } = await pool.query(`SELECT count(*)::int n FROM ai_usage_log WHERE feature = $1 AND created_at > now() - interval '1 day'`, [FEATURE]);
    let budget = Math.max(0, s.dailyLimit - today);

    const ctx = await context(s);
    const { rows } = await pool.query(`${SOURCE}
      SELECT src.platform, src.comment_id, src.text, src.post_id, src.parent_id,
             COALESCE(NULLIF(p.caption,''), p.title) AS caption
        FROM src
        LEFT JOIN comment_analysis a ON a.platform = src.platform AND a.comment_id = src.comment_id
        LEFT JOIN LATERAL (SELECT caption, title FROM posts WHERE external_id = src.post_id LIMIT 1) p ON true
       WHERE a.comment_id IS NULL AND NOT src.ours AND ${TOKEN} = ANY($1) AND src.ts > now() - ($2 || ' days')::interval
       ORDER BY src.ts DESC NULLS LAST LIMIT $3`, [await scopeTokens(s), String(s.sinceDays), max]);

    const save = (r, f) => pool.query(
      `INSERT INTO comment_analysis (platform, comment_id, status, skip_reason, norm_text, sentiment, sentiment_conf, category, category_conf, insightful, needs_reply, toxic, reused, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (platform, comment_id) DO NOTHING`,
      [r.platform, r.comment_id, f.status, f.reason || null, f.n || null, f.sentiment || null, f.sentimentConf ?? null, f.category || null, f.categoryConf ?? null,
       f.insightful ?? null, f.needsReply ?? null, f.toxic ?? null, !!f.reused, f.model || null]);

    const known = new Map();   // norm_text → labels (this run)
    const queue = [];
    for (const r of rows) {
      const p = applyEmojiRule(prefilter(r.text, s, ctx), s);
      if (p.reason) { await save(r, { status: 'skipped', reason: p.reason, n: p.n }); res.skipped++; continue; }
      queue.push({ r, n: p.n });
    }

    const reuseFrom = async (n) => {
      if (s.repeated !== 'reuse') return null;
      if (known.has(n)) return known.get(n);
      const { rows: [hit] } = await pool.query(
        `SELECT sentiment, sentiment_conf, category, category_conf, insightful, needs_reply, toxic, model FROM comment_analysis WHERE status = 'done' AND norm_text = $1 AND NOT reused LIMIT 1`, [n]);
      if (!hit) return null;
      const f = { sentiment: hit.sentiment, sentimentConf: hit.sentiment_conf, category: hit.category, categoryConf: hit.category_conf, insightful: hit.insightful, needsReply: hit.needs_reply, toxic: hit.toxic, model: hit.model };
      known.set(n, f);
      return f;
    };

    let consecutiveErr = 0;
    const CONC = 4;
    let i = 0;
    async function worker() {
      while (i < queue.length && !res.stopped) {
        const { r, n } = queue[i++];
        const prev = await reuseFrom(n);
        if (prev) { await save(r, { ...prev, status: 'done', n, reused: true }); res.reused++; continue; }
        if (budget <= 0) { res.stopped = 'daily limit reached'; break; }
        budget--;
        try {
          const state = { comment: String(r.text).slice(0, 2000) };
          if (s.includeCaption && r.caption) state.post_caption = String(r.caption).slice(0, 600);
          if (r.parent_id) state.is_reply_to_another_comment = true;
          const d = await openRouter.decide({ model: s.model, state, questions: QUESTIONS, feature: FEATURE });
          const a = d.answers || {};
          const f = {
            status: 'done', n, model: d.model || s.model,
            sentiment: SENTIMENTS.includes(a.sentiment?.choice) ? a.sentiment.choice : null, sentimentConf: a.sentiment?.probabilities?.[a.sentiment?.choice] ?? null,
            category: CATEGORIES[a.category?.choice] ? a.category.choice : null, categoryConf: a.category?.probabilities?.[a.category?.choice] ?? null,
            insightful: a.insightful?.noul ?? null, needsReply: a.needs_reply?.noul ?? null, toxic: a.toxic?.noul ?? null,
          };
          known.set(n, f);
          await save(r, f);
          res.analyzed++; consecutiveErr = 0;
        } catch (e) {
          res.errors++; consecutiveErr++;
          if (e.status === 401 || e.status === 402 || consecutiveErr >= 5) res.stopped = e.message;
        }
      }
    }
    // First occurrence of each text goes to the model; repeats reuse its result afterwards.
    if (s.repeated === 'reuse') {
      const seen = new Set(), firsts = [], dups = [];
      for (const q of queue) (seen.has(q.n) ? dups : firsts).push(q), seen.add(q.n);
      queue.length = 0; queue.push(...firsts);
      await Promise.all(Array.from({ length: CONC }, worker));
      queue.push(...dups);
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    // Instagram DMs (opt-in): conversations whose newest incoming message isn't labelled yet.
    if (s.analyzeDms && !res.stopped) {
      const left = { n: budget };
      await runDms(s, ctx, left, res);
      budget = left.n;
    }
  } catch (e) {
    res.stopped = e.message;
    console.error('[comment-analyzer]', e.message);
  } finally {
    running = false;
    lastRun = { ...res, at: new Date().toISOString(), ms: Date.now() - started };
  }
  // New labels may include negative comments → Telegram alerts (no-op unless alerts are on).
  if (res.analyzed || res.reused) setImmediate(() => require('./commentAlerts').dispatch().catch(() => {}));
  return lastRun;
}

function start() {
  setTimeout(() => run().catch(() => {}), 90 * 1000);
  setInterval(() => run().catch(() => {}), 10 * 60 * 1000);
}

// ── DMs ──
const DM_QUESTIONS = {
  sentiment: { type: 'choice', instructions: "Overall sentiment of the customer's messages toward the business", criteria: QUESTIONS.sentiment.criteria },
  category: { type: 'choice', instructions: 'What is the customer mainly doing in these messages?', criteria: CATEGORIES },
  insightful: { type: 'noul', instructions: 'Do the messages contain a specific, useful insight, correction, idea or request the business could act on?' },
  needs_reply: { type: 'noul', instructions: 'Does the customer expect or need a reply from the business?' },
  toxic: { type: 'noul', instructions: 'Are the messages abusive, hateful, harassing or sexually explicit?' },
};
async function runDms(s, ctx, left, res) {
  const scope = (await scopeTokens(s)).filter(t => t.startsWith('instagram|')).map(t => t.split('|')[1]);
  if (!scope.length) return;
  // Last 5 incoming texts per conversation that changed since it was labelled.
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (m.account_id, m.sender_id) m.account_id, m.sender_id AS peer_id, m.mid, m.ts
        FROM instagram_messages m
       WHERE m.direction = 'incoming' AND m.account_id = ANY($1) AND m.ts > now() - ($2 || ' days')::interval
       ORDER BY m.account_id, m.sender_id, m.ts DESC
    ), todo AS (
      SELECT l.* FROM latest l LEFT JOIN dm_analysis d ON d.account_id = l.account_id AND d.peer_id = l.peer_id
       WHERE d.last_mid IS DISTINCT FROM l.mid ORDER BY l.ts DESC LIMIT 200
    )
    SELECT t.account_id, t.peer_id, t.mid, t.ts,
           (SELECT array_agg(x.text ORDER BY x.ts) FROM (
              SELECT text, ts FROM instagram_messages
               WHERE direction = 'incoming' AND account_id = t.account_id AND sender_id = t.peer_id AND text IS NOT NULL
               ORDER BY ts DESC LIMIT 5) x) AS texts
      FROM todo t`, [scope, String(s.sinceDays)]);

  const save = (r, f) => pool.query(`
    INSERT INTO dm_analysis (account_id, peer_id, last_mid, last_in_ts, status, skip_reason, sentiment, sentiment_conf, category, category_conf, insightful, needs_reply, toxic, model, analyzed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
    ON CONFLICT (account_id, peer_id) DO UPDATE SET last_mid = EXCLUDED.last_mid, last_in_ts = EXCLUDED.last_in_ts, analyzed_at = now(),
      status = CASE WHEN EXCLUDED.status = 'skipped' AND dm_analysis.status = 'done' THEN 'done' ELSE EXCLUDED.status END,
      skip_reason = CASE WHEN EXCLUDED.status = 'skipped' AND dm_analysis.status = 'done' THEN NULL ELSE EXCLUDED.skip_reason END,
      sentiment = COALESCE(EXCLUDED.sentiment, dm_analysis.sentiment), sentiment_conf = COALESCE(EXCLUDED.sentiment_conf, dm_analysis.sentiment_conf),
      category = COALESCE(EXCLUDED.category, dm_analysis.category), category_conf = COALESCE(EXCLUDED.category_conf, dm_analysis.category_conf),
      insightful = COALESCE(EXCLUDED.insightful, dm_analysis.insightful), needs_reply = COALESCE(EXCLUDED.needs_reply, dm_analysis.needs_reply),
      toxic = COALESCE(EXCLUDED.toxic, dm_analysis.toxic), model = COALESCE(EXCLUDED.model, dm_analysis.model)`,
    [r.account_id, r.peer_id, r.mid, r.ts, f.status, f.reason || null, f.sentiment || null, f.sentimentConf ?? null, f.category || null, f.categoryConf ?? null,
     f.insightful ?? null, f.needsReply ?? null, f.toxic ?? null, f.model || null]);

  let i = 0, consecutiveErr = 0;
  async function worker() {
    while (i < rows.length && !res.stopped) {
      const r = rows[i++];
      // Same token-saving rules as comments, per message: keep only messages that pass.
      const kept = (r.texts || []).filter(t => !applyEmojiRule(prefilter(t, { ...s, repeated: 'analyze' }, ctx), s).reason);
      if (!kept.length) {
        const last = (r.texts || []).slice(-1)[0];
        const reason = last == null ? 'empty' : applyEmojiRule(prefilter(last, { ...s, repeated: 'analyze' }, ctx), s).reason || 'too_short';
        await save(r, { status: 'skipped', reason }); res.dmsSkipped++; continue;
      }
      if (left.n <= 0) { res.stopped = 'daily limit reached'; break; }
      left.n--;
      try {
        const d = await openRouter.decide({ model: s.model, state: { customer_messages: kept.map(t => String(t).slice(0, 800)), channel: 'Instagram direct messages' }, questions: DM_QUESTIONS, feature: FEATURE });
        const a = d.answers || {};
        await save(r, {
          status: 'done', model: d.model || s.model,
          sentiment: SENTIMENTS.includes(a.sentiment?.choice) ? a.sentiment.choice : null, sentimentConf: a.sentiment?.probabilities?.[a.sentiment?.choice] ?? null,
          category: CATEGORIES[a.category?.choice] ? a.category.choice : null, categoryConf: a.category?.probabilities?.[a.category?.choice] ?? null,
          insightful: a.insightful?.noul ?? null, needsReply: a.needs_reply?.noul ?? null, toxic: a.toxic?.noul ?? null,
        });
        res.dms++; consecutiveErr = 0;
      } catch (e) {
        res.errors++; consecutiveErr++;
        if (e.status === 401 || e.status === 402 || consecutiveErr >= 5) res.stopped = e.message;
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
}

// Conversation labels for the Inbox: { 'accountId|peerId': [sentiment, category, needsReply, toxic] }.
async function dmLabels() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT account_id, peer_id, sentiment, category, needs_reply, toxic FROM dm_analysis WHERE status = 'done' AND sentiment IS NOT NULL`);
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;
  return { labels: Object.fromEntries(rows.map(r => [`${r.account_id}|${r.peer_id}`, [r.sentiment, r.category, r2(r.needs_reply), r2(r.toxic)]])) };
}

// Forget skipped (or all) results so changed settings apply to old comments.
async function reset(scope) {
  await ensureSchema();
  const { rowCount } = await pool.query(scope === 'all' ? 'DELETE FROM comment_analysis' : `DELETE FROM comment_analysis WHERE status = 'skipped'`);
  await pool.query(scope === 'all' ? 'DELETE FROM dm_analysis' : `DELETE FROM dm_analysis WHERE status = 'skipped'`);
  return { removed: rowCount };
}

// ── read side ──
async function summary({ platform, days, account } = {}) {
  await ensureSchema();
  const p = platform && PLATFORMS.includes(platform) ? platform : null;
  const d = Math.min(3650, Math.max(1, parseInt(days, 10) || 30));
  const acc = account ? String(account).split(',').filter(Boolean) : null;
  const args = [p, String(d), acc];
  const where = `($1::text IS NULL OR a.platform = $1) AND ($3::text[] IS NULL OR ${TOKEN} = ANY($3)) AND src.ts > now() - ($2 || ' days')::interval`;
  const scope = await scopeTokens(await getSettings());
  const base = `${SOURCE} SELECT a.* , src.ts FROM comment_analysis a JOIN src ON src.platform = a.platform AND src.comment_id = a.comment_id WHERE NOT src.ours AND ${where}`;
  const [{ rows: [tot] }, { rows: sent }, { rows: cat }, { rows: skip }, { rows: trend }, { rows: [pend] }] = await Promise.all([
    pool.query(`WITH x AS (${base}) SELECT count(*) FILTER (WHERE status='done')::int AS analyzed, count(*) FILTER (WHERE status='skipped')::int AS skipped,
       count(*) FILTER (WHERE status='done' AND reused)::int AS reused,
       count(*) FILTER (WHERE status='done' AND insightful >= 0.7)::int AS insightful,
       count(*) FILTER (WHERE status='done' AND needs_reply >= 0.7)::int AS needs_reply,
       count(*) FILTER (WHERE status='done' AND toxic >= 0.7)::int AS toxic FROM x`, args),
    pool.query(`WITH x AS (${base}) SELECT sentiment AS k, count(*)::int n FROM x WHERE status='done' AND sentiment IS NOT NULL GROUP BY 1`, args),
    pool.query(`WITH x AS (${base}) SELECT category AS k, count(*)::int n FROM x WHERE status='done' AND category IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, args),
    pool.query(`WITH x AS (${base}) SELECT skip_reason AS k, count(*)::int n FROM x WHERE status='skipped' GROUP BY 1 ORDER BY 2 DESC`, args),
    pool.query(`WITH x AS (${base}) SELECT to_char((ts AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE sentiment='positive')::int AS positive, count(*) FILTER (WHERE sentiment='neutral')::int AS neutral,
       count(*) FILTER (WHERE sentiment='negative')::int AS negative FROM x WHERE status='done' GROUP BY 1 ORDER BY 1`, args),
    pool.query(`${SOURCE} SELECT count(*)::int AS n FROM src LEFT JOIN comment_analysis a ON a.platform = src.platform AND a.comment_id = src.comment_id
       WHERE a.comment_id IS NULL AND NOT src.ours AND ($1::text IS NULL OR src.platform = $1) AND ($3::text[] IS NULL OR ${TOKEN} = ANY($3)) AND ${TOKEN} = ANY($4) AND src.ts > now() - ($2 || ' days')::interval`, [...args, scope]),
  ]);
  const toObj = (rows) => Object.fromEntries(rows.map(r => [r.k, r.n]));
  return { ...tot, pending: pend.n, sentiment: toObj(sent), category: toObj(cat), skipped_by: toObj(skip), trend, lastRun, running };
}

async function results(q = {}) {
  await ensureSchema();
  const args = [];
  const cond = [];
  const add = (sql, v) => { args.push(v); cond.push(sql.replace('?', '$' + args.length)); };
  if (q.platform && PLATFORMS.includes(q.platform)) add('a.platform = ?', q.platform);
  if (q.account) add(`${TOKEN} = ANY(?)`, String(q.account).split(',').filter(Boolean));
  cond.push('NOT src.ours');
  if (q.status === 'skipped') cond.push(`a.status = 'skipped'`); else cond.push(`a.status = 'done'`);
  if (q.sentiment && SENTIMENTS.includes(q.sentiment)) add('a.sentiment = ?', q.sentiment);
  if (q.category && CATEGORIES[q.category]) add('a.category = ?', q.category);
  if (q.reason) add('a.skip_reason = ?', String(q.reason));
  if (q.flag === 'insightful') cond.push('a.insightful >= 0.7');
  if (q.flag === 'needs_reply') cond.push('a.needs_reply >= 0.7');
  if (q.flag === 'toxic') cond.push('a.toxic >= 0.7');
  if (q.q) add('src.text ILIKE ?', '%' + String(q.q).slice(0, 100) + '%');
  const days = Math.min(3650, Math.max(1, parseInt(q.days, 10) || 30));
  add(`src.ts > now() - (? || ' days')::interval`, String(days));
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const order = q.flag === 'insightful' ? 'a.insightful DESC' : q.flag === 'needs_reply' ? 'a.needs_reply DESC' : 'src.ts DESC';
  const { rows } = await pool.query(`${SOURCE}
    SELECT a.platform, a.comment_id AS "commentId", a.status, a.skip_reason AS "skipReason", a.sentiment, a.sentiment_conf AS "sentimentConf",
           a.category, a.category_conf AS "categoryConf", a.insightful, a.needs_reply AS "needsReply", a.toxic, a.reused, a.analyzed_at AS "analyzedAt",
           src.text, src.author, src.ts, src.post_id AS "postId", src.parent_id AS "parentId", src.account_id AS "accountId",
           EXISTS (SELECT 1 FROM src s2 WHERE s2.parent_id = src.comment_id AND s2.ours) AS replied,
           p.thumbnail_url AS "postThumbnail", COALESCE(NULLIF(p.caption,''), p.title) AS "postCaption", p.permalink AS "postPermalink",
           count(*) OVER () AS total
      FROM comment_analysis a
      JOIN src ON src.platform = a.platform AND src.comment_id = a.comment_id
      LEFT JOIN LATERAL (SELECT thumbnail_url, caption, title, permalink FROM posts WHERE external_id = src.post_id LIMIT 1) p ON true
     WHERE ${cond.join(' AND ')}
     ORDER BY ${order} NULLS LAST LIMIT ${limit} OFFSET ${offset}`, args);
  return { total: Number(rows[0]?.total || 0), rows: rows.map(({ total, ...r }) => r) };
}

// Compact labels for the Inbox (one platform): { commentId: [sentiment, category, insightful, needsReply, toxic] }.
async function labels(platform) {
  await ensureSchema();
  if (!PLATFORMS.includes(platform)) throw new Error('platform is required');
  const { rows } = await pool.query(
    `SELECT comment_id, sentiment, category, insightful, needs_reply, toxic FROM comment_analysis WHERE platform = $1 AND status = 'done'`, [platform]);
  const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;
  return { labels: Object.fromEntries(rows.map(r => [r.comment_id, [r.sentiment, r.category, r2(r.insightful), r2(r.needs_reply), r2(r.toxic)]])) };
}

// Each user's default Results view (platform, accounts, period) — opened every visit.
const viewKey = (userId) => `comment_analyzer_view:${userId}`;
async function getView(userId) {
  try { return JSON.parse(await getSetting(viewKey(userId)) || 'null'); } catch (_) { return null; }
}
async function saveView(userId, b) {
  if (b == null || b.clear) { await pool.query('DELETE FROM app_settings WHERE key = $1', [viewKey(userId)]); return null; }
  const v = {
    platform: PLATFORMS.includes(b.platform) ? b.platform : '',
    accounts: (Array.isArray(b.accounts) ? b.accounts : []).map(String).filter(t => PLATFORMS.includes(t.split('|')[0])).slice(0, 100),
    days: ['7', '30', '90', '365'].includes(String(b.days)) ? String(b.days) : '90',
  };
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [viewKey(userId), JSON.stringify(v)]);
  return v;
}

module.exports = { SOURCE, dmLabels, getView, saveView, labels, listAccounts, ensureSchema, getSettings, saveSettings, preview, run, start, reset, summary, results, CATEGORIES, DEFAULTS, FEATURE };
