// ============================================================
// notificationService.js — the in-app alert spine.
//
// emit(type, payload) is called from the existing event sites (IG webhook,
// token/insight checks) — never from new polling. Reads are pure DB.
// Fail-soft: emit never throws into its caller (a notification must not break a
// webhook ingest).
//
// read_by is a JSONB array of user ids who've read the item → "unread for me" =
// my id is not in read_by. dedupe_key (UNIQUE) stops the same event or the same
// daily check from notifying twice.
// ============================================================
const pool = require('./db');

/* ===================================================================
 * SSE (Server-Sent Events) — real-time push for handoff notifications.
 * The backend keeps a set of active response streams. When a handoff
 * fires, pushToSseClients() writes the event to all connected browsers
 * immediately — no 60-second poll lag. Falls back gracefully (no-op)
 * if no browsers are connected.
 * =================================================================== */
const sseClients = new Set(); // { res, userId }

function registerSseClient(res, userId) {
  const client = { res, userId };
  sseClients.add(client);
  return client;
}

function deregisterSseClient(client) {
  sseClients.delete(client);
}

function pushToSseClients(notification) {
  if (sseClients.size === 0) return;
  const msg = `data: ${JSON.stringify(notification)}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(msg); } catch (_) { sseClients.delete(c); }
  }
}

// Heartbeat every 20s keeps the connection alive through Traefik / proxies.
setInterval(() => {
  if (sseClients.size === 0) return;
  for (const c of sseClients) {
    try { c.res.write(': heartbeat\n\n'); } catch (_) { sseClients.delete(c); }
  }
}, 20000);

const DEFAULT_PREFS = {
  dm: true, comment: true,
  token: true, anomaly: true, handoff: true, email_digest: false,
};

async function getPrefs() {
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'notification_prefs'`);
    const parsed = rows[0]?.value ? (typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value) : {};
    return { ...DEFAULT_PREFS, ...parsed };
  } catch { return { ...DEFAULT_PREFS }; }
}

async function setPrefs(patch) {
  const cur = await getPrefs();
  const next = { ...cur, ...(patch || {}) };
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('notification_prefs', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
  return next;
}

// Record a notification. Returns the row (or null if suppressed/duplicate/error).
// payload: { title, body?, link?, severity?, platform?, accountKey?, dedupeKey? }
async function emit(type, payload = {}) {
  try {
    const prefs = await getPrefs();
    if (prefs[type] === false) return null; // type muted by workspace pref
    const { title, body = null, link = null, severity = 'info', platform = null, accountKey = null, dedupeKey = null, meta = null } = payload;
    if (!title) return null;
    const { rows } = await pool.query(
      `INSERT INTO notifications (type, severity, title, body, link, platform, account_key, dedupe_key, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [type, severity, String(title).slice(0, 200), body && String(body).slice(0, 500), link, platform, accountKey, dedupeKey, meta ? JSON.stringify(meta) : null]);
    const row = rows[0] || null;
    // Push handoff notifications immediately via SSE (no 60-second poll lag).
    if (row && type === 'handoff') pushToSseClients(row);
    return row;
  } catch (e) {
    console.error('[notify] emit failed (non-fatal):', e.message);
    return null;
  }
}

// Feed for a user: recent items, each flagged read/unread for THAT user.
async function getFeed(userId, { limit = 30 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 30));
  const uid = JSON.stringify([Number(userId)]);
  const { rows } = await pool.query(
    `SELECT id, type, severity, title, body, link, platform, account_key AS "accountKey", meta,
            created_at AS "createdAt", (read_by @> $1::jsonb) AS read
       FROM notifications ORDER BY created_at DESC LIMIT $2`, [uid, lim]);
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS unread FROM notifications WHERE NOT (read_by @> $1::jsonb)`, [uid]);
  return { items: rows, unread: cnt[0]?.unread || 0 };
}

async function unreadCount(userId) {
  const uid = JSON.stringify([Number(userId)]);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS unread FROM notifications WHERE NOT (read_by @> $1::jsonb)`, [uid]);
  return rows[0]?.unread || 0;
}

// Mark items read for a user (append the user id to read_by, idempotently).
async function markRead(userId, { ids = null, all = false } = {}) {
  const uid = Number(userId);
  const append = `read_by = CASE WHEN read_by @> to_jsonb($1::int) THEN read_by ELSE read_by || to_jsonb($1::int) END`;
  if (all) {
    await pool.query(`UPDATE notifications SET ${append} WHERE NOT (read_by @> to_jsonb($1::int))`, [uid]);
  } else if (Array.isArray(ids) && ids.length) {
    await pool.query(`UPDATE notifications SET ${append} WHERE id = ANY($2::bigint[])`, [uid, ids.map(Number)]);
  }
  return { ok: true };
}

// Periodic, check-based notifications (token health + insight anomalies). Run on a
// cron, NOT inline — deduped per day so a standing condition notifies once a day.
// Lazy-require the deps so there's no load-time require cycle.
async function runChecks() {
  const today = new Date().toISOString().slice(0, 10);

  // Token health → one warn per account/day while it needs attention.
  try {
    const tokenService = require('./tokenService');
    const health = await tokenService.getTokenHealth();
    for (const a of health) {
      if (!a.status || a.status === 'ok') continue;
      const msg = a.status === 'needs_reconnect'
        ? `${a.account} needs reconnecting in Integrations.`
        : a.status === 'refresh_failed'
        ? `${a.account} token refresh failed — reconnect it.`
        : `${a.account} token expires in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}.`;
      await emit('token', {
        title: `${cap(a.platform)} — action needed`,
        body: msg, link: '#/social/integrations', severity: a.status === 'expiring' ? 'warn' : 'error',
        platform: a.platform, accountKey: a.account,
        dedupeKey: `token:${a.platform}:${a.account}:${a.status}:${today}`,
      });
    }
  } catch (e) { console.error('[notify] token check:', e.message); }

  // Insight anomalies → one per platform/metric/day (good = opportunity, warn = risk).
  try {
    const insightsService = require('./insightsService');
    const { anomalies = [] } = await insightsService.getTrendsAndAnomalies('30D');
    for (const an of anomalies) {
      await emit('anomaly', {
        title: `${an.name} — ${an.metric === 'post' ? 'viral candidate' : an.metric}`,
        body: an.message, link: '#/social/insights', severity: an.severity === 'good' ? 'good' : 'warn',
        platform: an.platform,
        dedupeKey: `anomaly:${an.platform}:${an.metric}:${today}`,
      });
    }
  } catch (e) { console.error('[notify] anomaly check:', e.message); }
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

module.exports = { emit, getFeed, unreadCount, markRead, getPrefs, setPrefs, runChecks, registerSseClient, deregisterSseClient };
