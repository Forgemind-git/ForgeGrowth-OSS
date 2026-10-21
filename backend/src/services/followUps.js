// My list + follow-up calendar.
//
// Two small things a salesperson needs every day:
//   • a PIN — "keep this chat on my list" (per user, so each rep has their own)
//   • a FOLLOW-UP — "contact this person on <date>", optionally at a time, with a
//     note. These fill the calendar grid on Leads → My list, can be set from
//     any chat (with an optional AI-suggested date) and over MCP, and can be
//     mirrored into the connected Google Calendar.
//
// A person is keyed by the LAST 10 DIGITS of their number (contact_key) — the
// rule every other lead lookup here uses — so a lead who writes to two of our
// numbers is still one entry. wa_number + contact_number are kept alongside so
// the chat can be opened on the thread it was pinned from.
//
// ⚠ At most ONE open follow-up per person per owner (partial unique index).
// "Set follow-up" on a chat that already has one RESCHEDULES it instead of
// stacking a second entry for the same call on the calendar.

const pool = require('../db');
const cfg = require('./funnelConfig');

const KEY10 = (col) => `right(regexp_replace(COALESCE(${col},''),'\\D','','g'),10)`;
const key10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const digits = (v) => String(v || '').replace(/\D/g, '');
const isAdmin = (u) => u && (u.role === 'admin' || u.viaMcp);

const STATUSES = new Set(['open', 'done', 'cancelled']);
const SOURCES = new Set(['manual', 'ai', 'mcp']);

function err(status, message) { return Object.assign(new Error(message), { status }); }

async function ensureFollowUpTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.lead_pins (
      id             BIGSERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
      contact_key    TEXT NOT NULL,
      wa_number      TEXT NOT NULL,
      contact_number TEXT NOT NULL,
      note           TEXT,
      pinned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, contact_key)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.lead_follow_ups (
      id               BIGSERIAL PRIMARY KEY,
      contact_key      TEXT NOT NULL,
      wa_number        TEXT,
      contact_number   TEXT,
      lead_id          BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      owner_user_id    BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      due_date         DATE NOT NULL,
      due_time         TIME,
      note             TEXT,
      status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
      source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','mcp')),
      ai_reason        TEXT,
      created_by       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      created_by_name  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at          TIMESTAMPTZ,
      google_event_id  TEXT,
      google_synced_at TIMESTAMPTZ,
      google_error     TEXT
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_follow_ups_open
    ON coexistence.lead_follow_ups (contact_key, COALESCE(owner_user_id, 0)) WHERE status = 'open'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_due
    ON coexistence.lead_follow_ups (due_date) WHERE status = 'open'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_settings (
      id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      google_auto_sync    BOOLEAN NOT NULL DEFAULT FALSE,
      google_calendar_id  TEXT NOT NULL DEFAULT 'primary',
      google_last_sync_at TIMESTAMPTZ,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`INSERT INTO coexistence.follow_up_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);
}

// ── who can see what ──────────────────────────────────────────────────────────

/**
 * WHERE fragment for follow-ups visible to `user`. Admins see everyone's with
 * scope 'all'; everyone else sees their own plus those on contacts assigned to
 * them (a colleague's reminder about MY lead is something I should see).
 */
function visibility(user, scope, params, alias = 'f') {
  if (isAdmin(user) && scope !== 'mine') return 'TRUE';
  if (!user?.id) return 'FALSE';
  params.push(user.id);
  const me = `$${params.length}`;
  if (scope === 'mine') return `${alias}.owner_user_id = ${me}`;
  return `(${alias}.owner_user_id = ${me} OR EXISTS (
            SELECT 1 FROM coexistence.contacts c
             WHERE ${KEY10('c.contact_number')} = ${alias}.contact_key AND c.assigned_user_id = ${me}))`;
}

async function assertCanReach(user, waNumber, contactNumber) {
  if (isAdmin(user)) return;
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.contacts
      WHERE ${KEY10('contact_number')} = $1 AND assigned_user_id = $2 LIMIT 1`,
    [key10(contactNumber), user?.id || -1]);
  if (!rows.length) throw err(403, 'You do not have access to this conversation');
}

/** The lead and a display name for a person, found by last-10 digits. */
async function personInfo(contactKey) {
  const { rows: [r] } = await pool.query(
    `SELECT l.id AS lead_id, l.name AS lead_name, l.stage, l.source, l.email, l.city, l.paid_course,
            l.assigned_user_id AS assigned_to, (SELECT c.name FROM coexistence.contacts c
                              WHERE ${KEY10('c.contact_number')} = $1 AND c.name IS NOT NULL
                              ORDER BY c.updated_at DESC NULLS LAST LIMIT 1) AS contact_name
       FROM (SELECT 1) x
       LEFT JOIN coexistence.leads l ON ${KEY10('l.whatsapp_number')} = $1`,
    [contactKey]);
  return r || {};
}

function stageLabel(key) {
  if (!key) return null;
  try { return (cfg.stages() || []).find(s => s.stageKey === key)?.label || key; }
  catch { return key; }
}

const FOLLOW_UP_SELECT = `
  SELECT f.*, to_char(f.due_date, 'YYYY-MM-DD') AS due_date_s, to_char(f.due_time, 'HH24:MI') AS due_time_s,
         u.display_name AS owner_name,
         COALESCE(NULLIF(l.name, ''), ct.name, f.contact_number) AS person_name,
         l.id AS lead_id_now, l.stage AS lead_stage, l.source AS lead_source
    FROM coexistence.lead_follow_ups f
    LEFT JOIN coexistence.forgecrm_users u ON u.id = f.owner_user_id
    LEFT JOIN LATERAL (SELECT id, name, stage, source FROM coexistence.leads
                        WHERE ${KEY10('whatsapp_number')} = f.contact_key LIMIT 1) l ON TRUE
    LEFT JOIN LATERAL (SELECT name FROM coexistence.contacts
                        WHERE ${KEY10('contact_number')} = f.contact_key AND name IS NOT NULL
                        ORDER BY updated_at DESC NULLS LAST LIMIT 1) ct ON TRUE`;

function shapeFollowUp(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    contactKey: r.contact_key, waNumber: r.wa_number, contactNumber: r.contact_number,
    leadId: r.lead_id_now ? Number(r.lead_id_now) : (r.lead_id ? Number(r.lead_id) : null),
    name: r.person_name || r.contact_number,
    stage: r.lead_stage || null, stageLabel: stageLabel(r.lead_stage), source: r.lead_source || null,
    dueDate: r.due_date_s, dueTime: r.due_time_s || null,
    note: r.note || '', status: r.status, origin: r.source, aiReason: r.ai_reason || null,
    ownerUserId: r.owner_user_id ? Number(r.owner_user_id) : null, ownerName: r.owner_name || null,
    createdByName: r.created_by_name || null,
    createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at,
    google: r.google_event_id
      ? { synced: true, eventId: r.google_event_id, syncedAt: r.google_synced_at, error: r.google_error || null }
      : (r.google_error ? { synced: false, error: r.google_error } : null),
  };
}

async function getFollowUp(id) {
  const { rows: [r] } = await pool.query(`${FOLLOW_UP_SELECT} WHERE f.id = $1`, [id]);
  return r || null;
}

// ── follow-ups ────────────────────────────────────────────────────────────────

function cleanDate(v) {
  const s = String(v || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw err(400, 'Pick a date for the follow-up (YYYY-MM-DD)');
  }
  return s;
}
function cleanTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw err(400, 'Time must look like 14:30');
  return s;
}

async function listFollowUps(user, { from = null, to = null, scope = 'all', status = 'open', contact = null, limit = 500 } = {}) {
  const params = [];
  const where = [visibility(user, scope, params)];
  if (status && status !== 'any') {
    const st = String(status).split(',').filter(x => STATUSES.has(x));
    if (st.length) { params.push(st); where.push(`f.status = ANY($${params.length})`); }
  }
  if (from) { params.push(cleanDate(from)); where.push(`f.due_date >= $${params.length}`); }
  if (to) { params.push(cleanDate(to)); where.push(`f.due_date <= $${params.length}`); }
  if (contact) { params.push(key10(contact)); where.push(`f.contact_key = $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 2000));
  const { rows } = await pool.query(
    `${FOLLOW_UP_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY f.due_date, f.due_time NULLS LAST, f.id LIMIT $${params.length}`, params);
  return rows.map(shapeFollowUp);
}

/**
 * Set (or reschedule) the open follow-up for a person. Also pins the chat to
 * the setter's list — someone you plan to call is someone you want in reach.
 */
async function setFollowUp(user, { waNumber, contactNumber, dueDate, dueTime = null, note = '', source = 'manual', aiReason = null, ownerUserId, pin = true } = {}) {
  if (!contactNumber) throw err(400, 'Which chat? contactNumber is required');
  await assertCanReach(user, waNumber, contactNumber);
  // No business number given (MCP): use the thread the
  // customer last WROTE on — that is where the follow-up will be sent from.
  if (!waNumber) {
    const { rows: [t] } = await pool.query(
      `SELECT wa_number, contact_number FROM coexistence.chat_history
        WHERE ${KEY10('contact_number')} = $1
        ORDER BY (direction = 'incoming') DESC, timestamp DESC LIMIT 1`, [key10(contactNumber)]);
    if (t) { waNumber = t.wa_number; contactNumber = t.contact_number; }
  }
  const date = cleanDate(dueDate);
  const time = cleanTime(dueTime);
  const key = key10(contactNumber);
  if (key.length < 8) throw err(400, 'That does not look like a phone number');
  const origin = SOURCES.has(source) ? source : 'manual';
  // Owner: yourself by default. Only an admin (or MCP) may put it on someone
  // else's calendar; MCP with no owner leaves it on the lead's assignee.
  let owner = user?.id || null;
  if (ownerUserId !== undefined && isAdmin(user)) owner = ownerUserId ? Number(ownerUserId) : null;
  const person = await personInfo(key);
  if (owner == null && user?.viaMcp && person.assigned_to) owner = Number(person.assigned_to) || null;

  const { rows: [r] } = await pool.query(
    `INSERT INTO coexistence.lead_follow_ups
       (contact_key, wa_number, contact_number, lead_id, owner_user_id, due_date, due_time, note,
        source, ai_reason, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (contact_key, COALESCE(owner_user_id, 0)) WHERE status = 'open' DO UPDATE SET
       due_date = EXCLUDED.due_date, due_time = EXCLUDED.due_time,
       note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE coexistence.lead_follow_ups.note END,
       source = EXCLUDED.source, ai_reason = EXCLUDED.ai_reason,
       wa_number = COALESCE(EXCLUDED.wa_number, coexistence.lead_follow_ups.wa_number),
       contact_number = COALESCE(EXCLUDED.contact_number, coexistence.lead_follow_ups.contact_number),
       lead_id = COALESCE(EXCLUDED.lead_id, coexistence.lead_follow_ups.lead_id),
       updated_at = NOW()
     RETURNING id`,
    [key, digits(waNumber) || null, digits(contactNumber), person.lead_id || null, owner, date, time,
     String(note || '').slice(0, 2000), origin, aiReason ? String(aiReason).slice(0, 300) : null,
     user?.id || null, user?.displayName || user?.username || (user?.viaMcp ? 'MCP' : null)]);
  if (pin && user?.id && waNumber) await pinChat(user, { waNumber, contactNumber }).catch(() => {});
  await pushToGoogleIfSynced(Number(r.id), { created: true });
  return shapeFollowUp(await getFollowUp(r.id));
}

async function updateFollowUp(user, id, b = {}) {
  const row = await getFollowUp(id);
  if (!row) throw err(404, 'That follow-up no longer exists');
  const params = [];
  const vis = visibility(user, 'all', params);
  params.push(id);
  const { rows: ok } = await pool.query(`SELECT 1 FROM coexistence.lead_follow_ups f WHERE ${vis} AND f.id = $${params.length}`, params);
  if (!ok.length) throw err(403, 'You cannot change this follow-up');

  const sets = []; const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.dueDate !== undefined) set('due_date', cleanDate(b.dueDate));
  if (b.dueTime !== undefined) set('due_time', cleanTime(b.dueTime));
  if (b.note !== undefined) set('note', String(b.note || '').slice(0, 2000));
  if (b.status !== undefined) {
    if (!STATUSES.has(b.status)) throw err(400, 'status must be open, done or cancelled');
    set('status', b.status);
    sets.push(b.status === 'open' ? 'done_at = NULL' : 'done_at = NOW()');
  }
  if (b.ownerUserId !== undefined && isAdmin(user)) set('owner_user_id', b.ownerUserId ? Number(b.ownerUserId) : null);
  if (!sets.length) return shapeFollowUp(row);
  vals.push(id);
  try {
    await pool.query(`UPDATE coexistence.lead_follow_ups SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  } catch (e) {
    if (e.code === '23505') throw err(409, 'This person already has an open follow-up — reschedule that one instead');
    throw e;
  }
  await pushToGoogleIfSynced(id);
  return shapeFollowUp(await getFollowUp(id));
}

async function deleteFollowUp(user, id) {
  const row = await getFollowUp(id);
  if (!row) throw err(404, 'That follow-up no longer exists');
  const params = [];
  const vis = visibility(user, 'all', params);
  params.push(id);
  const { rows: ok } = await pool.query(`SELECT 1 FROM coexistence.lead_follow_ups f WHERE ${vis} AND f.id = $${params.length}`, params);
  if (!ok.length) throw err(403, 'You cannot delete this follow-up');
  if (row.google_event_id) {
    const s = await settings();
    await require('../integrations/googleClient').calendarDeleteEvent({ calendarId: s.google_calendar_id, eventId: row.google_event_id })
      .catch(e => console.warn('[followUps] google delete failed', e.message));
  }
  await pool.query(`DELETE FROM coexistence.lead_follow_ups WHERE id = $1`, [id]);
  return { ok: true };
}

// ── my list (pins) ────────────────────────────────────────────────────────────

async function pinChat(user, { waNumber, contactNumber, note } = {}) {
  if (!user?.id) throw err(400, 'Pins belong to a signed-in user');
  if (!waNumber || !contactNumber) throw err(400, 'waNumber and contactNumber are required');
  await assertCanReach(user, waNumber, contactNumber);
  const key = key10(contactNumber);
  await pool.query(
    `INSERT INTO coexistence.lead_pins (user_id, contact_key, wa_number, contact_number, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, contact_key) DO UPDATE SET
       wa_number = EXCLUDED.wa_number, contact_number = EXCLUDED.contact_number,
       note = COALESCE(EXCLUDED.note, coexistence.lead_pins.note)`,
    [user.id, key, digits(waNumber), digits(contactNumber), note == null ? null : String(note).slice(0, 1000)]);
  return { ok: true, pinned: true };
}

async function unpinChat(user, { contactNumber } = {}) {
  if (!user?.id) throw err(400, 'Pins belong to a signed-in user');
  await pool.query(`DELETE FROM coexistence.lead_pins WHERE user_id = $1 AND contact_key = $2`, [user.id, key10(contactNumber)]);
  return { ok: true, pinned: false };
}

/** The signed-in user's pinned chats, with lead data, last message and next follow-up. */
async function myList(user) {
  if (!user?.id) return [];
  const { rows } = await pool.query(
    `SELECT p.*, l.id AS lead_id, l.name AS lead_name, l.stage, l.source, l.email, l.city, l.profession,
            l.paid_course, l.created_at AS lead_created_at,
            ct.name AS contact_name, lm.message_body, lm.message_type, lm.direction, lm.timestamp AS last_at,
            li.timestamp AS last_in_at,
            fu.id AS fu_id, to_char(fu.due_date,'YYYY-MM-DD') AS fu_date, to_char(fu.due_time,'HH24:MI') AS fu_time, fu.note AS fu_note
       FROM coexistence.lead_pins p
       LEFT JOIN LATERAL (SELECT * FROM coexistence.leads WHERE ${KEY10('whatsapp_number')} = p.contact_key LIMIT 1) l ON TRUE
       LEFT JOIN coexistence.contacts ct ON ct.wa_number = p.wa_number AND ct.contact_number = p.contact_number
       LEFT JOIN LATERAL (SELECT message_body, message_type, direction, timestamp FROM coexistence.chat_history
                           WHERE wa_number = p.wa_number AND contact_number = p.contact_number
                             AND message_type NOT IN ('status','reaction','revoke','edit')
                           ORDER BY timestamp DESC LIMIT 1) lm ON TRUE
       LEFT JOIN LATERAL (SELECT timestamp FROM coexistence.chat_history
                           WHERE wa_number = p.wa_number AND contact_number = p.contact_number AND direction = 'incoming'
                           ORDER BY timestamp DESC LIMIT 1) li ON TRUE
       LEFT JOIN LATERAL (SELECT id, due_date, due_time, note FROM coexistence.lead_follow_ups f
                           WHERE f.contact_key = p.contact_key AND f.status = 'open'
                             AND (f.owner_user_id = p.user_id OR f.owner_user_id IS NULL)
                           ORDER BY f.due_date, f.due_time NULLS LAST LIMIT 1) fu ON TRUE
      WHERE p.user_id = $1
      ORDER BY fu.due_date NULLS LAST, lm.timestamp DESC NULLS LAST`, [user.id]);
  return rows.map(r => ({
    contactKey: r.contact_key, waNumber: r.wa_number, contactNumber: r.contact_number,
    pinnedAt: r.pinned_at, note: r.note || '',
    name: r.lead_name || r.contact_name || r.contact_number,
    lead: r.lead_id ? {
      id: Number(r.lead_id), name: r.lead_name, stage: r.stage, stageLabel: stageLabel(r.stage),
      source: r.source, email: r.email, city: r.city, profession: r.profession,
      product: r.paid_course, createdAt: r.lead_created_at,
    } : null,
    lastMessage: r.last_at ? {
      text: r.message_type === 'text' ? r.message_body : (r.message_body && r.message_body !== 'Audio message' ? r.message_body : `[${r.message_type}]`),
      direction: r.direction, at: r.last_at,
    } : null,
    lastInboundAt: r.last_in_at || null,
    nextFollowUp: r.fu_id ? { id: Number(r.fu_id), dueDate: r.fu_date, dueTime: r.fu_time, note: r.fu_note || '' } : null,
  }));
}

/** Everything the chat header needs about one chat: pinned? open follow-up? */
async function chatState(user, { waNumber, contactNumber }) {
  const key = key10(contactNumber);
  const pinned = user?.id
    ? (await pool.query(`SELECT 1 FROM coexistence.lead_pins WHERE user_id = $1 AND contact_key = $2`, [user.id, key])).rows.length > 0
    : false;
  const params = [];
  const vis = visibility(user, 'all', params);
  params.push(key);
  const { rows } = await pool.query(
    `${FOLLOW_UP_SELECT} WHERE ${vis} AND f.contact_key = $${params.length} AND f.status = 'open'
      ORDER BY (f.owner_user_id = ${user?.id ? Number(user.id) : -1}) DESC, f.due_date LIMIT 1`, params);
  // The Chat Analyzer's stored next-follow-up date (chat_analysis.next_follow_up)
  // is no longer read: that feature was removed on 2026-10-21 and nothing keeps
  // the column current. The AI date is asked for on demand (suggestFollowUp).
  return {
    pinned,
    followUp: shapeFollowUp(rows[0]) || null,
  };
}

// ── AI suggestion ─────────────────────────────────────────────────────────────

/** Today in IST as YYYY-MM-DD. */
function istToday(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * {date, time, reason} or null. A date in the past is moved to today (the model
 * sometimes answers "yesterday's" plan) and one more than 90 days out is
 * refused — a calendar entry nobody will reach is noise.
 */
function cleanNextFollowUp(v, now = new Date()) {
  if (!v || typeof v !== 'object') return null;
  const date = String(v.date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  const today = istToday(now);
  const max = istToday(new Date(now.getTime() + 90 * 86400000));
  if (date > max) return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time || '').trim()) ? String(v.time).trim() : null;
  return {
    date: date < today ? today : date,
    time,
    reason: typeof v.reason === 'string' ? v.reason.trim().slice(0, 300) : null,
  };
}

function istStamp(ts) {
  try {
    // ⚠ hourCycle, not hour12:false — en-IN with hour12:false renders a message
    // sent at 00:17 as "24:17", which reads as the END of the day, not the start.
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch { return ''; }
}

function durationText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} days ${rh}h` : `${d} days`;
}

/**
 * Who is waiting on whom, and for how long — the thing a follow-up date most
 * depends on, and invisible in a list of timestamps unless it is spelled out.
 * `rows` are oldest-first with {direction, timestamp}.
 */
function timingText(rows, now = new Date()) {
  if (!rows.length) return '';
  const ago = (ts) => durationText(now - new Date(ts));
  const last = rows[rows.length - 1];
  const lastIn = [...rows].reverse().find(r => r.direction === 'incoming');
  const lines = [`Now: ${istStamp(now)} IST.`];
  if (last.direction === 'incoming') {
    let i = rows.length - 1;
    while (i > 0 && rows[i - 1].direction === 'incoming') i -= 1;
    lines.push(`The CUSTOMER wrote last (${istStamp(last.timestamp)}). They have been waiting for OUR reply for ${ago(rows[i].timestamp)}.`);
  } else {
    let n = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i].direction !== 'incoming'; i -= 1) n += 1;
    lines.push(lastIn
      ? `WE wrote last (${istStamp(last.timestamp)}, ${ago(last.timestamp)} ago). The customer has not replied to our last ${n} message${n === 1 ? '' : 's'}; their last message was ${ago(lastIn.timestamp)} ago (${istStamp(lastIn.timestamp)}).`
      : 'Only WE have written so far; the customer has never replied.');
  }
  // How long each customer message (or burst of them) waited for us.
  const waits = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].direction !== 'incoming' || (i > 0 && rows[i - 1].direction === 'incoming')) continue;
    const reply = rows.slice(i + 1).find(r => r.direction === 'outgoing');
    if (reply) waits.push(new Date(reply.timestamp) - new Date(rows[i].timestamp));
  }
  if (waits.length) {
    lines.push(`Our reply times to the customer's messages (oldest → newest): ${waits.slice(-5).map(durationText).join(', ')}.`);
  }
  if (lastIn) {
    const closes = new Date(new Date(lastIn.timestamp).getTime() + 24 * 3600 * 1000);
    lines.push(closes > now
      ? `WhatsApp 24h reply window: OPEN for another ${durationText(closes - now)} (free-form messages allowed until ${istStamp(closes)}).`
      : `WhatsApp 24h reply window: CLOSED since ${istStamp(closes)} — only an approved template can reach them now.`);
  }
  return lines.join('\n');
}

// Empty message_body is common for media. Without a placeholder the model reads
// a blank line as nothing having been sent.
const TYPE_PLACEHOLDER = {
  image: '[image]', video: '[video]', audio: '[voice note]', voice: '[voice note]',
  document: '[document]', sticker: '[sticker]', location: '[location]',
  contacts: '[contact card]', template: '[template message sent]',
  interactive: '[interactive message]', button: '[button tap]', order: '[order]',
  unsupported: '[unsupported message]',
};

/**
 * The last 30 messages of a chat as prompt lines, oldest first. A voice note,
 * image or PDF whose text is already cached (chat_message_artifacts) is shown
 * as that text — free; nothing is transcribed or read here.
 */
async function recentChatLines(key) {
  const { rows } = await pool.query(
    `SELECT ch.message_id, ch.direction, ch.message_type, ch.message_body, ch.timestamp,
            (SELECT a.text FROM coexistence.chat_message_artifacts a
              WHERE a.source = 'chat' AND a.message_key = ch.message_id AND a.status = 'ok'
                AND a.kind IN ('transcript','vision','document') AND a.text <> ''
              LIMIT 1) AS extracted
       FROM coexistence.chat_history ch
      WHERE ${KEY10('ch.contact_number')} = $1
        AND ch.message_type NOT IN ('status','reaction','revoke','edit')
      ORDER BY ch.timestamp DESC, ch.id DESC
      LIMIT 30`, [key]);
  rows.reverse();
  const { libraryMatches, libraryLabel } = require('./libraryMedia');
  const library = await libraryMatches('chat', rows).catch(() => new Map());
  const lines = [];
  for (const r of rows) {
    let body = (r.message_body || '').trim();
    const lib = library.get(r.message_id);
    if (lib && lib.description) {
      body = libraryLabel(lib, r.message_type);
    } else if (r.extracted) {
      const label = (r.message_type === 'audio' || r.message_type === 'voice') ? 'voice note'
        : r.message_type === 'image' ? 'image' : 'document';
      body = body && label !== 'voice note' ? `${body}\n  [${label}] ${r.extracted}` : `[${label}] ${r.extracted}`;
    } else if (lib) {
      body = libraryLabel(lib, r.message_type);
    }
    if (!body) body = TYPE_PLACEHOLDER[r.message_type] || '';
    if (!body) continue;
    if (body.length > 600) body = `${body.slice(0, 600)}…`;
    lines.push(`[${istStamp(r.timestamp)}] ${r.direction === 'incoming' ? 'CUSTOMER' : 'US'}: ${body}`);
  }
  return lines;
}

/**
 * An OpenAI-compatible credential and a model for the one small call below.
 * ⚠ Only OpenAI-compatible credentials work: runChatCompletion speaks the
 * OpenAI wire format, so an Anthropic or Gemini key would 404.
 */
async function resolveSuggestModel() {
  const { isOpenAiCompatible } = require('../llm/chatCompletion');
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.ai_models ORDER BY (provider = 'openai') DESC, id ASC`);
  const cred = rows.find(r => isOpenAiCompatible(r));
  if (!cred) return { cred: null, modelId: null };
  const enabled = Array.isArray(cred.enabled_models) ? cred.enabled_models : [];
  const modelId = enabled.find(m => /mini|flash|haiku|turbo/i.test(m)) || enabled[0] || 'gpt-4o-mini';
  return { cred, modelId };
}

/**
 * The AI's recommended next follow-up for a chat: ONE small call over the
 * timing and the recent messages. Never writes anything — the caller decides
 * whether to put it on the calendar.
 */
async function suggestFollowUp({ contactNumber }) {
  const key = key10(contactNumber);
  const { rows: timing } = await pool.query(
    `SELECT direction, timestamp FROM coexistence.chat_history
      WHERE ${KEY10('contact_number')} = $1 AND message_type NOT IN ('status','reaction','revoke','edit')
      ORDER BY timestamp, id`, [key]);
  if (!timing.length) throw err(400, 'This chat has no messages yet');

  const { cred, modelId } = await resolveSuggestModel();
  if (!cred) throw err(400, 'No AI model is connected (Admin Settings → AI Models)');
  const lines = await recentChatLines(key);
  const system = `You plan a salesperson's next WhatsApp follow-up with a lead. Today is ${istToday()} (IST).
Pick the best DAY for our next message: honour anything promised in the chat ("I'll check and tell you tomorrow", "call me Friday", a payment or batch date), otherwise judge from how long they have been quiet and how warm they are. Never a date in the past. Prefer a time of day only when the chat implies one.
Respond with ONLY JSON: {"date":"YYYY-MM-DD","time":"HH:MM or null","reason":"one short plain sentence why this day","note":"one short line: what to say or do on that day"}`;
  const user = [
    `TIMING:\n${timingText(timing)}`,
    `RECENT MESSAGES:\n${lines.join('\n')}`,
  ].join('\n\n');
  const { runChatCompletion } = require('../llm/chatCompletion');
  const res = await runChatCompletion(cred, modelId, [{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 1500, json: true });
  let parsed = null;
  try { parsed = JSON.parse(String(res).replace(/^```(?:json)?|```$/g, '').trim()); } catch { /* handled below */ }
  const s = cleanNextFollowUp(parsed);
  if (!s) throw err(502, 'The AI did not return a usable date — pick one yourself');
  return { ...s, note: typeof parsed?.note === 'string' ? parsed.note.trim().slice(0, 300) : null, from: 'ai' };
}

// ── Google Calendar mirror ────────────────────────────────────────────────────

async function settings() {
  const { rows: [s] } = await pool.query(`SELECT * FROM coexistence.follow_up_settings WHERE id = 1`);
  return s || { google_auto_sync: false, google_calendar_id: 'primary' };
}

async function googleStatus() {
  const s = await settings();
  const { rows: [i] } = await pool.query(
    `SELECT status, account_email, last_error FROM coexistence.integrations WHERE provider = 'google_calendar'`);
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE google_event_id IS NOT NULL)::int AS synced,
            COUNT(*) FILTER (WHERE status = 'open' AND due_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AND google_event_id IS NULL)::int AS unsynced
       FROM coexistence.lead_follow_ups`);
  // ⚠ "connected" in the integrations table only means a token was stored once.
  // Google silently revokes refresh tokens (7 days while the OAuth app is in
  // Testing mode, or when access is removed), and the row still says connected.
  // So actually obtain a token: that is the only honest answer to "can we sync?".
  let connected = i?.status === 'connected';
  let needsReconnect = false;
  let error = i?.status === 'error' ? i.last_error : null;
  if (connected) {
    try { await require('../integrations/googleClient').getValidAccessToken('google_calendar'); }
    catch (e) {
      connected = false; needsReconnect = true;
      error = /invalid_grant|Bad Request/i.test(e.message)
        ? 'Google no longer accepts the saved sign-in (it expired or was revoked). Reconnect Google Calendar in Admin Settings → Integrations.'
        : e.message;
    }
  }
  return {
    connected, needsReconnect, account: i?.account_email || null, error,
    autoSync: s.google_auto_sync, calendarId: s.google_calendar_id, lastSyncAt: s.google_last_sync_at,
    synced: c.synced, unsynced: c.unsynced,
  };
}

function appUrl() {
  const d = process.env.TLS_DOMAIN || process.env.FORGECRM_DOMAIN
    || String(process.env.CORS_ORIGIN || '').split(',')[0].trim() || 'localhost';
  return /^https?:\/\//.test(d) ? d : `https://${d}`;
}

function eventFor(r) {
  const name = r.person_name || r.contact_number;
  const lines = [
    r.note ? `Note: ${r.note}` : null,
    r.lead_stage ? `Stage: ${stageLabel(r.lead_stage)}` : null,
    r.contact_number ? `WhatsApp: +${r.contact_number}` : null,
    r.owner_name ? `Owner: ${r.owner_name}` : null,
    r.wa_number && r.contact_number ? `Open the chat: ${appUrl()}/#/follow-ups/${r.wa_number}/${r.contact_number}` : null,
    'Created by ForgeGrowth — edit it there; changes made here are overwritten on the next sync.',
  ].filter(Boolean);
  const event = {
    summary: `Follow up: ${name}`,
    description: lines.join('\n'),
    extendedProperties: { private: { forgegrowthFollowUpId: String(r.id) } },
  };
  if (r.due_time_s) {
    const start = `${r.due_date_s}T${r.due_time_s}:00`;
    const endD = new Date(Date.parse(`${start}+05:30`) + 30 * 60000);
    const end = new Date(endD.getTime() + 5.5 * 3600000).toISOString().slice(0, 19);
    event.start = { dateTime: start, timeZone: 'Asia/Kolkata' };
    event.end = { dateTime: end, timeZone: 'Asia/Kolkata' };
  } else {
    const next = new Date(Date.parse(`${r.due_date_s}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    event.start = { date: r.due_date_s };
    event.end = { date: next };
  }
  return event;
}

/** Push one follow-up to Google: open → create/update, done/cancelled → remove. Never throws. */
async function syncOne(id, calendarId) {
  const g = require('../integrations/googleClient');
  const r = await getFollowUp(id);
  if (!r) return 'missing';
  try {
    if (r.status !== 'open') {
      if (r.google_event_id) await g.calendarDeleteEvent({ calendarId, eventId: r.google_event_id });
      await pool.query(`UPDATE coexistence.lead_follow_ups SET google_event_id = NULL, google_synced_at = NOW(), google_error = NULL WHERE id = $1`, [id]);
      return r.google_event_id ? 'removed' : 'skipped';
    }
    const ev = await g.calendarUpsertEvent({ calendarId, eventId: r.google_event_id, event: eventFor(r) });
    await pool.query(`UPDATE coexistence.lead_follow_ups SET google_event_id = $2, google_synced_at = NOW(), google_error = NULL WHERE id = $1`, [id, ev.id]);
    return r.google_event_id ? 'updated' : 'created';
  } catch (e) {
    await pool.query(`UPDATE coexistence.lead_follow_ups SET google_error = $2 WHERE id = $1`, [id, String(e.message).slice(0, 300)]);
    return 'failed';
  }
}

/**
 * A follow-up already mirrored to Google is kept in step on every change; a new
 * one is pushed only when auto-sync is on. Best effort — a Google outage must
 * never make saving a follow-up fail.
 */
async function pushToGoogleIfSynced(id, { created = false } = {}) {
  try {
    const s = await settings();
    const { rows: [r] } = await pool.query(`SELECT google_event_id FROM coexistence.lead_follow_ups WHERE id = $1`, [id]);
    if (!r) return;
    if (r.google_event_id || (s.google_auto_sync && created)) {
      const st = await googleStatus();
      if (st.connected) await syncOne(id, s.google_calendar_id);
    }
  } catch (e) {
    console.warn('[followUps] google push failed', e.message);
  }
}

/**
 * The "Sync to Google Calendar" button: every visible open follow-up from today
 * on is created/updated as an event; ones closed since their last sync are
 * removed. Optionally flips auto-sync for new follow-ups.
 */
async function syncToGoogle(user, { scope = 'all', autoSync } = {}) {
  const st = await googleStatus();
  if (!st.connected) throw err(400, st.error || 'Google Calendar is not connected — connect it in Admin Settings → Integrations → Google');
  if (autoSync !== undefined && isAdmin(user)) {
    await pool.query(`UPDATE coexistence.follow_up_settings SET google_auto_sync = $1, updated_at = NOW() WHERE id = 1`, [!!autoSync]);
  }
  const s = await settings();
  const params = [];
  const vis = visibility(user, scope, params);
  const { rows } = await pool.query(
    `SELECT f.id FROM coexistence.lead_follow_ups f
      WHERE ${vis} AND (
        (f.status = 'open' AND f.due_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 1)
        OR (f.status <> 'open' AND f.google_event_id IS NOT NULL))
      ORDER BY f.due_date LIMIT 500`, params);
  const counts = { created: 0, updated: 0, removed: 0, failed: 0, skipped: 0, missing: 0 };
  for (const r of rows) counts[await syncOne(Number(r.id), s.google_calendar_id)] += 1;
  await pool.query(`UPDATE coexistence.follow_up_settings SET google_last_sync_at = NOW() WHERE id = 1`);
  return { ...counts, total: rows.length, status: await googleStatus() };
}

module.exports = {
  ensureFollowUpTables,
  listFollowUps, setFollowUp, updateFollowUp, deleteFollowUp,
  pinChat, unpinChat, myList, chatState, suggestFollowUp,
  cleanNextFollowUp, istToday, istStamp, durationText, timingText,
  googleStatus, syncToGoogle, eventFor,
  assertCanReach, key10,
};
