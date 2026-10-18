// Helpers shared by every workflow-agent tool: pagination, parameter binding,
// message shaping, masking and "error as data".

const {
  toIst, maskPhone, maskName, paiseToRupees, formatInr, key10,
} = require('../format');
const { PLACEHOLDER_BODIES } = require('../sql');

const MAX_LIMIT = 200;

/** Error returned to the MODEL as data (never thrown). */
const err = (code, message, extra = {}) => ({ error: code, message, ...extra });

/** Parameter binder: `const { params, add } = binder()`; add(v) → "$n". */
function binder(initial = []) {
  const params = [...initial];
  return { params, add: (v) => { params.push(v); return `$${params.length}`; } };
}

/** limit ≤ 200 (or a lower cap from the agent's parameter overrides) + opaque cursor. */
function pageArgs(input, { def = 50, cap = MAX_LIMIT } = {}) {
  const hardCap = Math.min(MAX_LIMIT, cap || MAX_LIMIT);
  let limit = Number(input?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = Math.min(def, hardCap);
  limit = Math.min(limit, hardCap);
  let offset = 0;
  if (input?.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'));
      if (Number.isInteger(parsed.o) && parsed.o >= 0) offset = parsed.o;
    } catch { /* bad cursor → first page */ }
  }
  return { limit, offset };
}

/** Rows fetched with LIMIT limit+1 → { rows, next_cursor }. */
function paginate(rows, { limit, offset }) {
  const more = rows.length > limit;
  return {
    rows: more ? rows.slice(0, limit) : rows,
    next_cursor: more ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : null,
  };
}

/** Parse an IST date or ISO instant. "2026-09-01" = start of that IST day. */
function parseInstant(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00+05:30`);
    if (Number.isNaN(d.getTime())) return undefined;
    return endOfDay ? new Date(d.getTime() + 24 * 3600 * 1000) : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Resolve a [since, until) window, clamped to the scope's lookback relative to the
 * run's "now". Returns { since, until, clamped } or an error object.
 */
function windowArgs(input, ctx, { sinceKey = 'since', untilKey = 'until', defaultDays = null } = {}) {
  const now = ctx.now;
  const floor = new Date(now.getTime() - ctx.scope.lookback_days * 24 * 3600 * 1000);
  // "last_run" = since this agent's previous successful run (incremental runs).
  let since = input?.[sinceKey] === 'last_run' ? (ctx.lastRunAt || null) : parseInstant(input?.[sinceKey]);
  let until = parseInstant(input?.[untilKey], { endOfDay: true });
  if (since === undefined) return err('invalid_input', `${sinceKey} is not a valid date. Use YYYY-MM-DD (IST) or an ISO timestamp.`);
  if (until === undefined) return err('invalid_input', `${untilKey} is not a valid date. Use YYYY-MM-DD (IST) or an ISO timestamp.`);
  if (!since) since = defaultDays ? new Date(now.getTime() - defaultDays * 24 * 3600 * 1000) : floor;
  if (!until || until > now) until = now;
  let clamped = false;
  if (since < floor) { since = floor; clamped = true; }
  if (since >= until) return err('invalid_input', `The window is empty: ${sinceKey} must be before ${untilKey}.`);
  return { since, until, clamped };
}

const inboundWrap = (text) => (text == null || text === '' ? text : `<customer_message>${text}</customer_message>`);

/** Brief message_type vocabulary. */
function briefMessageType(row) {
  const t = row.message_type;
  if (t === 'audio') return 'voice_note';
  if (row.direction === 'incoming' && (t === 'interactive' || t === 'button')) return 'interactive_reply';
  return t;
}

/**
 * One chat row → the brief's message shape. Customer-authored text is wrapped in
 * <customer_message> tags: it is DATA, and instructions inside it are ignored.
 */
function shapeMessage(row, ctx, { leadIdByKey = null } = {}) {
  const inbound = row.direction === 'incoming';
  const wrap = inbound ? inboundWrap : (v) => v;
  const body = row.message_body && !PLACEHOLDER_BODIES.has(row.message_body) ? row.message_body : null;
  const out = {
    message_id: row.message_id,
    contact_id: leadIdByKey ? (leadIdByKey.get(row.k10 || key10(row.contact_number)) ?? null) : undefined,
    business_number_id: ctx.accounts?.byNumber.get(row.wa_number)?.id ?? null,
    rep_user_id: row.rep_user_id == null ? null : String(row.rep_user_id),
    direction: inbound ? 'inbound' : 'outbound',
    sender_type: row.sender_type,
    sender_confidence: row.sender_confidence,
    chat_type: row.chat_type,
    message_type: briefMessageType(row),
    status: row.status,
    created_at: toIst(row.timestamp),
    is_within_24h_window: row.is_within_24h_window === true,
  };
  if (out.contact_id === undefined) delete out.contact_id;
  const mt = row.message_type;
  if (mt === 'audio') {
    if (row.transcript_status === 'ok' && row.transcript) {
      out.transcript = wrap(row.transcript);
      if (row.transcript_language) out.transcript_language = row.transcript_language;
    } else {
      out.transcript = null;
      out.transcript_status = row.transcript_status || 'not_transcribed';
    }
  } else if (['image', 'video', 'document', 'sticker'].includes(mt)) {
    out.caption = wrap(body);
    out.media = {
      mime_type: row.media_mime_type || null,
      filename: row.media_filename || null,
      size_bytes: row.media_size_bytes == null ? null : Number(row.media_size_bytes),
      description: row.media_description || null,
    };
  } else if (inbound && (mt === 'interactive' || mt === 'button')) {
    out.interactive_reply_title = wrap(row.message_body || null);
  } else {
    out.text = wrap(body);
  }
  if (mt === 'template' || row.template_name) {
    out.template_name = row.template_name || null;
    if (!body) out.text_note = 'Template or image message with no stored text; it was still sent. Count the row, do not match text.';
  }
  return out;
}

/** Lead display fields honouring mask_pii. */
function leadIdentity(row, scope) {
  return {
    contact_id: String(row.id),
    name: scope.mask_pii ? maskName(row.name) : (row.name || null),
    phone: scope.mask_pii ? maskPhone(row.whatsapp_number) : row.whatsapp_number,
  };
}

const money = (paise) => {
  const r = paiseToRupees(paise);
  return r == null ? null : { rupees: r, display: formatInr(r) };
};

/** Business-number lookup, loaded once per run. */
async function loadAccounts(pool) {
  const { rows } = await pool.query(
    `SELECT id, display_name, display_phone_number, is_active FROM coexistence.whatsapp_accounts ORDER BY id`);
  const byNumber = new Map(rows.map(r => [r.display_phone_number, { id: String(r.id), label: r.display_name, number: r.display_phone_number, active: r.is_active }]));
  const byId = new Map(rows.map(r => [String(r.id), { id: String(r.id), label: r.display_name, number: r.display_phone_number, active: r.is_active }]));
  return { byNumber, byId, list: rows };
}

/** Users lookup (id → {name, role, team_id}), loaded once per run. */
async function loadUsers(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, COALESCE(u.display_name, u.username) AS name, u.role, u.is_active, u.team_id, u.employee_id
       FROM coexistence.forgecrm_users u ORDER BY u.id`);
  return new Map(rows.map(r => [String(r.id), { id: String(r.id), name: r.name, role: r.role, active: r.is_active, team_id: r.team_id == null ? null : String(r.team_id), employee_id: r.employee_id || null }]));
}

function repRef(users, id) {
  if (id == null) return { rep_user_id: null, rep_name: 'Unassigned' };
  const u = users?.get(String(id));
  return { rep_user_id: String(id), rep_name: u ? u.name : `User ${id}` };
}

const median = (arr) => {
  const a = arr.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const minutesBetween = (a, b) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 60000 : null);

/** Normalise an id list input ("12", 12, ["12"]) → positive integers. */
function idList(v, max = MAX_LIMIT) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return [...new Set(arr.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0))].slice(0, max);
}

const strArr = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v])).map(x => String(x).trim()).filter(Boolean);

module.exports = {
  MAX_LIMIT, err, binder, pageArgs, paginate, parseInstant, windowArgs, inboundWrap, shapeMessage,
  briefMessageType, leadIdentity, money, loadAccounts, loadUsers, repRef, median, minutesBetween, idList, strArr,
};
