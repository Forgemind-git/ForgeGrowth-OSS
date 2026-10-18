// Negative-comment alerts → Telegram.
//
// The Comment Analyzer (services/commentAnalyzer.js) labels every comment and
// stores it in comment_analysis. This module watches those rows and sends the
// ones matching the alert rules to the chosen Telegram chats:
//   negative sentiment (≥ a confidence), abusive/toxic, or a complaint.
//
// Rules, each against a specific failure:
//   - Only comments analysed AFTER alerts were switched on, and posted within
//     maxAgeHours — switching alerts on (or re-analysing history) must never
//     blast months of old comments into someone's phone.
//   - comment_alerts PRIMARY KEY (platform, comment_id, chat_id) — one alert per
//     comment per chat, ever, however often the dispatcher runs.
//   - Only APPROVED chats are ever sent to, re-checked at send time, so blocking
//     a chat stops its alerts immediately even if it is still ticked here.
//   - A failed send retries (3 attempts) and then gives up, logged.
//
// "Instant": a live Instagram comment webhook calls onNewComment(), which waits
// a few seconds for the batch, runs the analyzer on what is new, then
// dispatches. Everything else (other platforms arrive by sync) is picked up by
// the analyzer's own 10-minute run, which also calls dispatch() at the end.
const pool = require('../db');
const bot = require('./telegramBot');
const socialEnv = require('../env');

const K = 'comment_alert_settings';
const PLATFORM_NAME = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', threads: 'Threads' };
const CATEGORY_NAME = {
  praise: 'Praise', question: 'Question', lead: 'Lead', feedback: 'Feedback', complaint: 'Complaint',
  request: 'Request', spam: 'Spam', other: 'Other',
};
const DEFAULTS = {
  enabled: false,
  chatIds: [],
  negative: true,
  minConfidence: 0.6,
  toxic: true,
  complaint: false,
  maxAgeHours: 48,
  enabledAt: null,
};
const MAX_ATTEMPTS = 3;

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await bot.ensureSchema();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS comment_alerts (
          platform     text NOT NULL,
          comment_id   text NOT NULL,
          chat_id      bigint NOT NULL,
          status       text NOT NULL,             -- sent | failed | gave_up
          reason       text,                      -- negative | toxic | complaint | test
          attempts     int NOT NULL DEFAULT 0,
          error        text,
          telegram_message_id bigint,
          created_at   timestamptz NOT NULL DEFAULT now(),
          sent_at      timestamptz,
          PRIMARY KEY (platform, comment_id, chat_id)
        );
        CREATE INDEX IF NOT EXISTS idx_comment_alerts_at ON comment_alerts (created_at DESC);
      `);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function getSettings() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [K]);
  let s = {};
  try { s = JSON.parse(rows[0]?.value || '{}'); } catch (_) {}
  return { ...DEFAULTS, ...s };
}
async function saveSettings(b = {}) {
  await ensureSchema();
  const prev = await getSettings();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const s = {
    enabled: b.enabled === true,
    chatIds: [...new Set((Array.isArray(b.chatIds) ? b.chatIds : prev.chatIds).map(String).filter(x => /^-?\d{1,20}$/.test(x)))].slice(0, 50),
    negative: b.negative !== undefined ? b.negative === true : prev.negative,
    minConfidence: num(b.minConfidence ?? prev.minConfidence, 0.3, 0.99, DEFAULTS.minConfidence),
    toxic: b.toxic !== undefined ? b.toxic === true : prev.toxic,
    complaint: b.complaint !== undefined ? b.complaint === true : prev.complaint,
    maxAgeHours: Math.round(num(b.maxAgeHours ?? prev.maxAgeHours, 1, 720, DEFAULTS.maxAgeHours)),
    // Reset the cursor each time alerts go off → on, so a pause never replays its backlog.
    enabledAt: b.enabled === true ? (prev.enabled && prev.enabledAt ? prev.enabledAt : new Date().toISOString()) : prev.enabledAt,
  };
  if (s.enabled && !s.negative && !s.toxic && !s.complaint) throw new Error('Pick at least one kind of comment to alert on');
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [K, JSON.stringify(s)]);
  if (s.enabled && !prev.enabled) setImmediate(() => dispatch().catch(() => {}));
  return s;
}

// Does one analysed comment match the rules? Returns the reason, or null.
function matchReason(a, s) {
  if (s.toxic && a.toxic != null && a.toxic >= 0.7) return 'toxic';
  if (s.negative && a.sentiment === 'negative' && (a.sentiment_conf == null || a.sentiment_conf >= s.minConfidence)) return 'negative';
  if (s.complaint && a.category === 'complaint') return 'complaint';
  return null;
}
const ruleSql = (s) => {
  const parts = [];
  if (s.toxic) parts.push('a.toxic >= 0.7');
  if (s.negative) parts.push(`(a.sentiment = 'negative' AND (a.sentiment_conf IS NULL OR a.sentiment_conf >= ${Number(s.minConfidence)}))`);
  if (s.complaint) parts.push(`a.category = 'complaint'`);
  return parts.length ? `(${parts.join(' OR ')})` : 'false';
};

// Comment rows (+ post + account) for a set of matches, in one shape.
function SELECT_ROWS() {
  const { SOURCE } = require('./commentAnalyzer');
  return `${SOURCE}
    SELECT a.platform, a.comment_id, a.sentiment, a.sentiment_conf, a.category, a.category_conf, a.toxic, a.analyzed_at,
           src.text, src.author, src.ts, src.post_id, src.parent_id, src.acct,
           p.caption, p.permalink,
           COALESCE('@' || ia.username, ia.name, sa.label, '@' || sa.username) AS account_label
      FROM comment_analysis a
      JOIN src ON src.platform = a.platform AND src.comment_id = a.comment_id
      LEFT JOIN LATERAL (SELECT COALESCE(NULLIF(caption,''), title) AS caption, permalink FROM posts WHERE external_id = src.post_id LIMIT 1) p ON true
      LEFT JOIN instagram_accounts ia ON a.platform = 'instagram' AND ia.account_id = src.acct
      LEFT JOIN LATERAL (SELECT label, username FROM social_accounts WHERE platform = a.platform AND account_key = src.acct LIMIT 1) sa ON true`;
}

const esc = bot.escapeHtml;
const trunc = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function alertMessage(r, reason, { test = false } = {}) {
  const head = reason === 'toxic' ? '🚨 <b>Abusive comment</b>' : reason === 'complaint' ? '🟠 <b>Complaint</b>' : '🔴 <b>Negative comment</b>';
  const lines = [
    (test ? '🧪 <i>Test alert</i>\n' : '') + `${head} · ${esc(PLATFORM_NAME[r.platform] || r.platform)}${r.account_label ? ' · ' + esc(r.account_label) : ''}`,
  ];
  const labels = [];
  if (r.category) labels.push(`<b>${esc(CATEGORY_NAME[r.category] || r.category)}</b>`);
  if (r.sentiment) labels.push(`${esc(r.sentiment)}${r.sentiment_conf != null ? ' ' + Math.round(r.sentiment_conf * 100) + '%' : ''}`);
  if (r.toxic != null && r.toxic >= 0.7) labels.push('⚠️ abusive');
  if (r.parent_id) labels.push('reply to a comment');
  if (labels.length) lines.push(labels.join(' · '));
  lines.push(`👤 ${esc(r.author ? (r.platform === 'instagram' || r.platform === 'threads' ? '@' + r.author : r.author) : 'Unknown')}${r.ts ? ' · ' + esc(fmtTime(r.ts)) : ''}`);
  lines.push(`<blockquote>${esc(trunc(r.text, 900))}</blockquote>`);
  if (r.caption) lines.push(`📝 On: ${esc(trunc(r.caption, 140))}`);
  const buttons = [];
  if (r.permalink && /^https?:\/\//.test(r.permalink)) buttons.push([{ text: 'Open post', url: r.permalink }]);
  const base = String(socialEnv.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (/^https:\/\//.test(base)) buttons.push([{ text: 'Open in Forge Growth', url: `${base}/#/social/comment-analyzer` }]);
  return { text: lines.join('\n'), buttons };
}

// ── dispatcher ──
let running = false, again = false;
async function dispatch() {
  if (running) { again = true; return { busy: true }; }
  running = true;
  const res = { sent: 0, failed: 0, matched: 0 };
  try {
    await ensureSchema();
    const s = await getSettings();
    if (!s.enabled || !s.chatIds.length || !s.enabledAt) return res;
    if (!await bot.getToken()) return { ...res, stopped: 'Telegram is not connected' };
    const { rows: chats } = await pool.query(`SELECT chat_id FROM telegram_chats WHERE status = 'approved' AND chat_id = ANY($1::bigint[])`, [s.chatIds]);
    if (!chats.length) return { ...res, stopped: 'none of the chosen chats is approved' };
    const chatIds = chats.map(c => String(c.chat_id));
    const { rows } = await pool.query(`${SELECT_ROWS()}
      WHERE a.status = 'done' AND NOT src.ours AND ${ruleSql(s)}
        AND a.analyzed_at >= $1 AND src.ts > now() - ($2 || ' hours')::interval
        AND EXISTS (SELECT 1 FROM unnest($3::bigint[]) c(id)
                     WHERE NOT EXISTS (SELECT 1 FROM comment_alerts x WHERE x.platform = a.platform AND x.comment_id = a.comment_id
                                        AND x.chat_id = c.id AND (x.status IN ('sent','gave_up') OR x.attempts >= ${MAX_ATTEMPTS})))
      ORDER BY src.ts ASC LIMIT 40`, [s.enabledAt, String(s.maxAgeHours), chatIds]);
    res.matched = rows.length;
    for (const r of rows) {
      const reason = matchReason(r, s);
      if (!reason) continue;
      const msg = alertMessage(r, reason);
      for (const chatId of chatIds) {
        const { rows: [done] } = await pool.query('SELECT status, attempts FROM comment_alerts WHERE platform = $1 AND comment_id = $2 AND chat_id = $3', [r.platform, r.comment_id, chatId]);
        if (done && (done.status === 'sent' || done.status === 'gave_up' || done.attempts >= MAX_ATTEMPTS)) continue;
        try {
          const out = await bot.send(chatId, msg.text, { kind: 'alert', html: true, buttons: msg.buttons, meta: { platform: r.platform, commentId: r.comment_id, reason } });
          await pool.query(`INSERT INTO comment_alerts (platform, comment_id, chat_id, status, reason, attempts, telegram_message_id, sent_at)
              VALUES ($1,$2,$3,'sent',$4,1,$5,now())
              ON CONFLICT (platform, comment_id, chat_id) DO UPDATE SET status = 'sent', attempts = comment_alerts.attempts + 1, error = NULL,
                telegram_message_id = EXCLUDED.telegram_message_id, sent_at = now()`, [r.platform, r.comment_id, chatId, reason, out.messageId]);
          res.sent++;
        } catch (e) {
          await pool.query(`INSERT INTO comment_alerts (platform, comment_id, chat_id, status, reason, attempts, error)
              VALUES ($1,$2,$3,'failed',$4,1,$5)
              ON CONFLICT (platform, comment_id, chat_id) DO UPDATE SET attempts = comment_alerts.attempts + 1, error = EXCLUDED.error,
                status = CASE WHEN comment_alerts.attempts + 1 >= ${MAX_ATTEMPTS} THEN 'gave_up' ELSE 'failed' END`,
            [r.platform, r.comment_id, chatId, reason, String(e.message).slice(0, 500)]);
          res.failed++;
        }
      }
    }
  } catch (e) {
    console.error('[comment-alerts]', e.message);
    res.error = e.message;
  } finally {
    running = false;
    if (again) { again = false; setImmediate(() => dispatch().catch(() => {})); }
  }
  return res;
}

// Live comment arrived (Instagram webhook). Debounced: wait for the burst,
// analyse what is new, then alert. A no-op unless alerts are on.
let kickTimer = null;
function onNewComment() {
  if (kickTimer) return;
  kickTimer = setTimeout(async () => {
    kickTimer = null;
    try {
      const s = await getSettings();
      if (!s.enabled) return;
      const analyzer = require('./commentAnalyzer');
      const r = await analyzer.run({ max: 60 });
      if (r?.busy) { setTimeout(onNewComment, 15000); return; }   // the 10-min run is mid-flight; try again shortly
      await dispatch();
    } catch (e) { console.error('[comment-alerts] kick', e.message); }
  }, 8000);
}

// Send a sample using the newest analysed negative comment (or a made-up one) to the chosen chats.
async function sendTest(chatIds) {
  await ensureSchema();
  const ids = [...new Set((chatIds || []).map(String).filter(x => /^-?\d{1,20}$/.test(x)))];
  if (!ids.length) throw new Error('Pick at least one chat to send the test to');
  const { rows: approved } = await pool.query(`SELECT chat_id FROM telegram_chats WHERE status = 'approved' AND chat_id = ANY($1::bigint[])`, [ids]);
  if (!approved.length) throw new Error('None of the chosen chats is approved');
  const { rows: [r] } = await pool.query(`${SELECT_ROWS()} WHERE a.status = 'done' AND NOT src.ours AND a.sentiment = 'negative' ORDER BY src.ts DESC LIMIT 1`);
  const sample = r || { platform: 'instagram', comment_id: 'test', sentiment: 'negative', sentiment_conf: 0.91, category: 'complaint', toxic: 0.1,
    text: 'This is a sample negative comment — no real comment has been flagged yet.', author: 'sample_user', ts: new Date(), account_label: null };
  const msg = alertMessage(sample, sample.toxic >= 0.7 ? 'toxic' : 'negative', { test: true });
  const out = [];
  for (const { chat_id } of approved) {
    try { await bot.send(chat_id, msg.text, { kind: 'alert', html: true, buttons: msg.buttons, meta: { test: true } }); out.push({ chatId: String(chat_id), ok: true }); }
    catch (e) { out.push({ chatId: String(chat_id), ok: false, error: e.message }); }
  }
  return { results: out, usedRealComment: !!r };
}

// Recent alerts for the panel.
async function log({ limit = 50 } = {}) {
  await ensureSchema();
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const { rows } = await pool.query(`
    WITH x AS (SELECT * FROM comment_alerts ORDER BY created_at DESC LIMIT ${lim})
    SELECT x.*, c.title, c.first_name, c.last_name, c.username, c.chat_id AS cid,
           COALESCE(ig.text, fb.message, yt.text, th.text) AS text
      FROM x
      LEFT JOIN telegram_chats c ON c.chat_id = x.chat_id
      LEFT JOIN instagram_comments ig ON x.platform = 'instagram' AND ig.comment_id = x.comment_id
      LEFT JOIN facebook_comments fb ON x.platform = 'facebook' AND fb.comment_id = x.comment_id
      LEFT JOIN youtube_comments yt ON x.platform = 'youtube' AND yt.comment_id = x.comment_id
      LEFT JOIN threads_comments th ON x.platform = 'threads' AND th.comment_id = x.comment_id
     ORDER BY x.created_at DESC`);
  return rows.map(r => ({
    platform: r.platform, commentId: r.comment_id, chatId: String(r.chat_id),
    chatName: r.cid ? bot.chatName({ ...r, chat_id: r.cid }) : String(r.chat_id),
    status: r.status, reason: r.reason, attempts: r.attempts, error: r.error, text: r.text, createdAt: r.created_at, sentAt: r.sent_at,
  }));
}

// /recent in Telegram: the last 5 negative comments (approved chats only — the bot checks that).
async function recentForBot() {
  await ensureSchema();
  const { rows } = await pool.query(`${SELECT_ROWS()} WHERE a.status = 'done' AND NOT src.ours AND (a.sentiment = 'negative' OR a.toxic >= 0.7)
      ORDER BY src.ts DESC LIMIT 5`);
  if (!rows.length) return 'No negative comments have been flagged yet.';
  const lines = rows.map((r, i) => `${i + 1}. ${esc(PLATFORM_NAME[r.platform] || r.platform)} · ${esc(r.author ? '@' + r.author : 'Unknown')} · ${esc(fmtTime(r.ts))}\n<blockquote>${esc(trunc(r.text, 280))}</blockquote>`);
  return { text: `<b>Latest negative comments</b>\n\n${lines.join('\n')}`, html: true };
}
async function statusForBot(chat) {
  const s = await getSettings();
  const mine = s.chatIds.includes(String(chat.chat_id));
  const kinds = [s.negative && 'negative', s.toxic && 'abusive', s.complaint && 'complaints'].filter(Boolean).join(', ');
  return `Comment alerts are ${s.enabled ? 'ON' : 'OFF'}.\n${mine ? 'This chat receives them' : 'This chat is not on the alert list'}${kinds ? ` (${kinds}).` : '.'}`;
}

function start() {
  ensureSchema().catch(e => console.error('[comment-alerts] schema:', e.message));
  bot.registerCommand('/recent', () => recentForBot());
  bot.registerCommand('/status', (chat) => statusForBot(chat));
  // Safety net: a comment analysed by a path that did not call dispatch() still alerts within 2 min.
  setTimeout(() => dispatch().catch(() => {}), 60 * 1000).unref?.();
  setInterval(() => dispatch().catch(() => {}), 2 * 60 * 1000).unref?.();
}

module.exports = { ensureSchema, getSettings, saveSettings, dispatch, onNewComment, sendTest, log, start, matchReason, alertMessage, DEFAULTS };
