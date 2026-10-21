// Triggers: schedules (IST cron), events (cursors over existing tables, debounced
// and de-duplicated), quiet-lead scans, plus the housekeeping that keeps queued
// runs moving and pending approvals honest.
//
// ⚠ NOTHING HERE IS HOOKED INTO THE LIVE WEBHOOK OR SEND PATH. Events are read from
// the rows those paths already write (chat_history, lead_events, sales_log)
// through cursors kept in workflow_agent_settings — the same pattern the
// funnel-tag dispatcher uses. Cursors start at the current maximum, so
// switching an agent on never replays history.
//
// Idempotency comes from the database, not from timing: every run a trigger creates
// carries a trigger_key, and uq_workflow_agent_runs_trigger_key lets each key fire
// once however many ticks or backend instances see it.

const pool = require('../../db');
const bus = require('../../events');
const { dueSlot } = require('./cron');
const { normalizeScope, leadInScope } = require('./scope');
const { normalizeTriggers } = require('./config');
const { KEY10 } = require('./sql');
const { key10 } = require('./format');

const TICK_MS = parseInt(process.env.WORKFLOW_AGENT_TICK_MS || '60000', 10);
const SCHEDULE_LOOKBACK_MS = 60 * 60 * 1000;   // a restart within the hour still fires a missed slot, once
const EVENT_BATCH = 2000;
// Rows younger than this are left for the next tick: an id is assigned at INSERT but
// becomes visible at COMMIT, so a cursor reading right up to NOW() can step past a
// lower id that commits a moment later and never see it.

const QUIET_SCAN_CAP = 50;

let running = false;

async function activeAgents() {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, v.triggers, v.data_scope
       FROM coexistence.workflow_agents a
       JOIN coexistence.workflow_agent_versions v ON v.id = a.current_version_id
      WHERE a.status = 'active'`);
  return rows.map(r => ({ ...r, triggers: normalizeTriggers(r.triggers).triggers, scope: normalizeScope(r.data_scope).scope }));
}

async function startRun(args) {
  const { createRun } = require('./runtime');
  const { enqueueRun } = require('./queue');
  try {
    const run = await createRun(args);
    if (run) await enqueueRun(run.id);
    return run;
  } catch (e) {
    if (e.status !== 409) console.error(`[workflow-agents] trigger ${args.triggerKey} could not start: ${e.message}`);
    return null;
  }
}

// ── schedules ─────────────────────────────────────────────────────────────────

async function tickSchedules(agents, now = new Date()) {
  const started = [];
  for (const a of agents) {
    for (const [i, t] of a.triggers.entries()) {
      if (t.type !== 'schedule' || !t.enabled) continue;
      let slot;
      try { slot = dueSlot(t.cron, new Date(now.getTime() - SCHEDULE_LOOKBACK_MS), now); } catch { continue; }
      if (!slot) continue;
      const run = await startRun({ agentId: a.id, triggerType: 'schedule', triggerKey: `schedule:${i}:${t.cron}:${slot.toISOString()}`, triggerPayload: { cron: t.cron, slot: slot.toISOString() } });
      if (run) started.push(run.id);
    }
  }
  return started;
}

// ── events ────────────────────────────────────────────────────────────────────

const BRIEF_TYPE = (messageType) => {
  if (messageType === 'audio') return 'voice_note';
  if (messageType === 'interactive' || messageType === 'button') return 'interactive_reply';
  return messageType;
};

async function wonStageKeys() {
  const { rows } = await pool.query(`SELECT stage_key FROM coexistence.funnel_stages WHERE is_won AND active`);
  return new Set(rows.map(r => r.stage_key));
}

function leadPassesFilters(lead, filters, won) {
  if (filters.stage_in?.length && !filters.stage_in.includes(lead.stage)) return false;
  if (filters.stage_not_won && won.has(lead.stage)) return false;
  return true;
}

/** Buffer an event for (agent, trigger, lead); the debounce window slides with each new event. */
async function bufferEvent(agent, index, trigger, leadId, at, payload) {
  const fireAt = new Date(Math.max(Date.now(), new Date(at).getTime()) + trigger.debounce_minutes * 60000);
  await pool.query(
    `INSERT INTO coexistence.workflow_agent_pending_events (agent_id, trigger_index, event, lead_id, first_seen_at, last_seen_at, fire_at, payload)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7)
     ON CONFLICT (agent_id, trigger_index, lead_id) WHERE status = 'waiting' DO UPDATE
       SET last_seen_at = GREATEST(coexistence.workflow_agent_pending_events.last_seen_at, EXCLUDED.last_seen_at),
           fire_at = GREATEST(coexistence.workflow_agent_pending_events.fire_at, EXCLUDED.fire_at),
           payload = jsonb_set(coexistence.workflow_agent_pending_events.payload, '{items}',
             (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
                SELECT x FROM jsonb_array_elements(COALESCE(coexistence.workflow_agent_pending_events.payload->'items', '[]'::jsonb) || COALESCE(EXCLUDED.payload->'items', '[]'::jsonb)) x
                LIMIT 50) s))`,
    [agent.id, index, trigger.event, leadId, new Date(at), fireAt, JSON.stringify(payload)]);
}

/** Read new rows past each cursor, turn them into buffered events, advance cursors. One sweeper at a time. */
async function sweepEvents(agents) {
  const client = await pool.connect();
  const counts = { messages: 0, stage_changes: 0, payments: 0, buffered: 0 };
  try {
    await client.query('BEGIN');
    const { rows: [cur] } = await client.query(`SELECT * FROM coexistence.workflow_agent_settings WHERE id = 1 FOR UPDATE`);
    if (!cur) { await client.query('ROLLBACK'); return counts; }
    const wanted = (event) => agents.flatMap(a => a.triggers.map((t, i) => ({ a, t, i })).filter(x => x.t.type === 'event' && x.t.enabled && x.t.event === event));
    const won = await wonStageKeys();
    const leadsByKey = async (keys) => {
      if (!keys.length) return new Map();
      const { rows } = await client.query(
        `SELECT id, whatsapp_number, stage, ${KEY10('whatsapp_number')} AS k10 FROM coexistence.leads WHERE ${KEY10('whatsapp_number')} = ANY($1::text[])`, [keys]);
      return new Map(rows.map(r => [r.k10, r]));
    };
    const inScopeCache = new Map();
    const inScope = async (a, leadId) => {
      const k = `${a.id}:${leadId}`;
      if (!inScopeCache.has(k)) inScopeCache.set(k, await leadInScope(pool, a.scope, leadId));
      return inScopeCache.get(k);
    };

    // message.inbound
    const { rows: msgs } = await client.query(
      `SELECT id, message_id, contact_number, message_type, timestamp FROM coexistence.chat_history
        WHERE id > $1 AND direction = 'incoming' AND message_type NOT IN ('status','reaction','revoke') AND created_at <= NOW() - INTERVAL '10 seconds'
        ORDER BY id LIMIT ${EVENT_BATCH}`, [cur.last_chat_history_id]);
    let lastMsg = Number(cur.last_chat_history_id);
    const msgTriggers = wanted('message.inbound');
    if (msgs.length) {
      lastMsg = Number(msgs[msgs.length - 1].id);
      counts.messages = msgs.length;
      if (msgTriggers.length) {
        const leads = await leadsByKey([...new Set(msgs.map(m => key10(m.contact_number)))]);
        for (const m of msgs) {
          const lead = leads.get(key10(m.contact_number));
          if (!lead) continue;
          for (const { a, t, i } of msgTriggers) {
            if (t.filters.message_type?.length && !t.filters.message_type.includes(BRIEF_TYPE(m.message_type))) continue;
            if (!leadPassesFilters(lead, t.filters, won)) continue;
            if (!(await inScope(a, lead.id))) continue;
            await bufferEvent(a, i, t, lead.id, m.timestamp, { event: 'message.inbound', lead_id: String(lead.id), items: [{ message_id: m.message_id, message_type: BRIEF_TYPE(m.message_type) }] });
            counts.buffered += 1;
          }
        }
      }
    }

    // lead.stage_changed
    const { rows: evs } = await client.query(
      `SELECT e.id, e.lead_id, e.from_value, e.to_value, e.ts, l.stage FROM coexistence.lead_events e JOIN coexistence.leads l ON l.id = e.lead_id
        WHERE e.id > $1 AND e.event_type = 'stage_changed' AND e.ts <= NOW() - INTERVAL '10 seconds' ORDER BY e.id LIMIT ${EVENT_BATCH}`, [cur.last_lead_event_id]);
    let lastEv = Number(cur.last_lead_event_id);
    if (evs.length) {
      lastEv = Number(evs[evs.length - 1].id);
      counts.stage_changes = evs.length;
      for (const e of evs) {
        for (const { a, t, i } of wanted('lead.stage_changed')) {
          if (t.filters.to?.length && !t.filters.to.includes(e.to_value)) continue;
          if (t.filters.from?.length && !t.filters.from.includes(e.from_value)) continue;
          if (!leadPassesFilters({ stage: e.stage }, t.filters, won)) continue;
          if (!(await inScope(a, e.lead_id))) continue;
          await bufferEvent(a, i, t, e.lead_id, e.ts, { event: 'lead.stage_changed', lead_id: String(e.lead_id), items: [{ from: e.from_value, to: e.to_value }] });
          counts.buffered += 1;
        }
      }
    }

    // payment.created: a new sales_log row.
    const { rows: manual } = await client.query(
      `SELECT id, lead_id, amount_paise, created_at FROM coexistence.sales_log WHERE id > $1 AND created_at <= NOW() - INTERVAL '10 seconds' ORDER BY id LIMIT ${EVENT_BATCH}`, [cur.last_sales_log_id]);
    const lastSale = manual.length ? Number(manual[manual.length - 1].id) : Number(cur.last_sales_log_id);
    const payTriggers = wanted('payment.created');
    for (const p of manual.map(x => ({ ...x, source: 'manual' }))) {
      if (!p.lead_id) continue;
      counts.payments += 1;
      for (const { a, t, i } of payTriggers) {
        if (t.filters.min_amount_rupees != null && Number(p.amount_paise) / 100 < t.filters.min_amount_rupees) continue;
        if (!(await inScope(a, p.lead_id))) continue;
        await bufferEvent(a, i, t, p.lead_id, p.created_at, { event: 'payment.created', lead_id: String(p.lead_id), items: [{ source: p.source, amount_rupees: Number(p.amount_paise) / 100 }] });
        counts.buffered += 1;
      }
    }

    await client.query(
      `UPDATE coexistence.workflow_agent_settings SET last_chat_history_id = $1, last_lead_event_id = $2, last_sales_log_id = $3, updated_at = NOW() WHERE id = 1`,
      [lastMsg, lastEv, lastSale]);
    await client.query('COMMIT');
    return counts;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Fire debounced events whose window has closed. */
async function fireDueEvents(now = new Date()) {
  const { rows } = await pool.query(
    `UPDATE coexistence.workflow_agent_pending_events SET status = 'fired'
      WHERE id IN (SELECT id FROM coexistence.workflow_agent_pending_events WHERE status = 'waiting' AND fire_at <= $1 ORDER BY fire_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now]);
  const started = [];
  for (const p of rows) {
    const key = `event:${p.trigger_index}:${p.event}:${p.lead_id}:${new Date(p.first_seen_at).getTime()}`;
    const run = await startRun({ agentId: p.agent_id, triggerType: 'event', triggerKey: key, triggerPayload: { ...p.payload, first_seen_at: p.first_seen_at, last_seen_at: p.last_seen_at } });
    if (run) {
      started.push(run.id);
      await pool.query(`UPDATE coexistence.workflow_agent_pending_events SET run_id = $1 WHERE id = $2`, [run.id, p.id]);
    }
  }
  return started;
}

/**
 * lead.quiet: leads whose latest inbound crossed the silence threshold within the
 * last day. The key includes that inbound's time, so one quiet spell fires once,
 * and a lead that writes again and goes quiet again fires again. Only recently
 * crossed thresholds count, so activating an agent never sweeps up every lead that
 * has been silent for months.
 */
async function scanQuiet(agents, now = new Date()) {
  const started = [];
  const won = await wonStageKeys();
  for (const a of agents) {
    for (const [i, t] of a.triggers.entries()) {
      if (t.type !== 'event' || t.event !== 'lead.quiet' || !t.enabled) continue;
      const hours = t.filters.hours_since_last_inbound || 48;
      const { rows } = await pool.query(
        `SELECT l.id, l.stage, li.last_inbound_at
           FROM coexistence.leads l
           JOIN LATERAL (SELECT MAX(ch.timestamp) AS last_inbound_at FROM coexistence.chat_history ch
                          WHERE ${KEY10('ch.contact_number')} = ${KEY10('l.whatsapp_number')} AND ch.direction = 'incoming') li ON TRUE
          WHERE li.last_inbound_at <= $1::timestamptz - ($2 || ' hours')::interval
            AND li.last_inbound_at > $1::timestamptz - ($2 || ' hours')::interval - INTERVAL '1 day'
          ORDER BY li.last_inbound_at DESC LIMIT ${QUIET_SCAN_CAP}`, [now, String(hours)]);
      for (const l of rows) {
        if (!leadPassesFilters(l, t.filters, won)) continue;
        if (!(await leadInScope(pool, a.scope, l.id))) continue;
        const run = await startRun({
          agentId: a.id, triggerType: 'event',
          triggerKey: `quiet:${i}:${l.id}:${new Date(l.last_inbound_at).getTime()}`,
          triggerPayload: { event: 'lead.quiet', lead_id: String(l.id), last_inbound_at: l.last_inbound_at, hours_since_last_inbound: hours },
        });
        if (run) started.push(run.id);
      }
    }
  }
  return started;
}

// ── housekeeping ──────────────────────────────────────────────────────────────

async function housekeeping() {
  const { enqueueRun } = require('./queue');
  // Pending approvals past their expiry never execute.
  await pool.query(`UPDATE coexistence.workflow_agent_actions SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()`);
  // A run stuck in running for an hour lost its worker.
  await pool.query(
    `UPDATE coexistence.workflow_agent_runs SET status = 'failed', finished_at = NOW(), error = 'The run stopped responding (worker restarted?).'
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '60 minutes'`);
  // A queued run whose job was lost (Redis restart) is re-enqueued; jobId dedupes.
  const { rows } = await pool.query(`SELECT id FROM coexistence.workflow_agent_runs WHERE status = 'queued' AND queued_at < NOW() - INTERVAL '2 minutes' LIMIT 20`);
  for (const r of rows) await enqueueRun(r.id).catch(() => {});
  // WhatsApp lead lists scheduled for a later time of day (e.g. 08:05 IST).
  await require('./destinations').sendDueDeliveries().catch(e => console.error('[workflow-agents] scheduled delivery failed:', e.message));
}

async function tick(now = new Date()) {
  if (running) return null;
  running = true;
  try {
    const agents = await activeAgents();
    const schedules = await tickSchedules(agents, now);
    const events = await sweepEvents(agents);
    const fired = await fireDueEvents(now);
    const quiet = await scanQuiet(agents, now);
    await housekeeping();
    return { schedules, events, fired, quiet };
  } catch (e) {
    console.error('[workflow-agents] tick failed:', e.message);
    return null;
  } finally {
    running = false;
  }
}

let timer = null;
let kickTimer = null;

function startWorkflowAgentScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, TICK_MS);
  timer.unref();
  // Kick sooner after a lead changes, so event debounce windows feel immediate.
  bus.on('lead-changed', () => {
    if (kickTimer) return;
    kickTimer = setTimeout(() => { kickTimer = null; tick(); }, 5000);
    kickTimer.unref();
  });
  console.log(`[workflow-agents] scheduler started, tick=${TICK_MS}ms`);
}

module.exports = {
  tick, tickSchedules, sweepEvents, fireDueEvents, scanQuiet, housekeeping, activeAgents, startWorkflowAgentScheduler, BRIEF_TYPE,
};

/**
 * POST /workflow-agents/events — an internal way to raise an event (n8n, scripts).
 * Goes through the same filters, scope checks and debounce as the cursor sweep.
 */
async function ingestEvent({ event, leadId, at = new Date(), payload = {} }) {
  const { EVENTS } = require('./config');
  if (!EVENTS.includes(event)) {
    const err = new Error(`event must be one of ${EVENTS.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  const { rows: [lead] } = await pool.query(`SELECT id, stage FROM coexistence.leads WHERE id = $1`, [Number(leadId)]);
  if (!lead) { const e = new Error('Lead not found.'); e.status = 404; throw e; }
  const agents = await activeAgents();
  const won = await wonStageKeys();
  let buffered = 0;
  for (const a of agents) {
    for (const [i, t] of a.triggers.entries()) {
      if (t.type !== 'event' || !t.enabled || t.event !== event) continue;
      if (!leadPassesFilters(lead, t.filters, won)) continue;
      if (!(await leadInScope(pool, a.scope, lead.id))) continue;
      await bufferEvent(a, i, t, lead.id, at, { event, lead_id: String(lead.id), items: [{ source: 'api', ...payload }] });
      buffered += 1;
    }
  }
  return { buffered };
}

module.exports.ingestEvent = ingestEvent;
