// CLO dispatcher — turns a lead's stage change into a Meta CRM conversion event.
//
// Two halves:
//   enqueue()  decides whether an event should exist and writes one clo_events
//              row, recording the reason when it declines
//   flush()    picks up pending rows, batches them to Meta, records the outcome
//
// The split matters: enqueue runs near the lead-update path and must be fast and
// unable to break it, while flush does the network work on a schedule. Nothing
// in enqueue talks to Meta.
//
// INTEGRATION POINT — a cursor over coexistence.lead_events, NOT hooks in the
// stage-change call sites. Five code paths move a lead's stage and three of them
// write that row with raw SQL rather than a shared helper, so a hook would have
// to be added five times and would be missed the sixth. The CTWA sweeper already
// works this way; CLO reuses the pattern with its own independent cursor.

const pool = require('../db');
const clo = require('../integrations/metaCloClient');
const { decrypt } = require('../util/crypto');
const { loadCloSettings, CLO_WINDOW_DAYS } = require('../routes/clo');

// Stop retrying a row after this many attempts — past here it is a standing
// failure the operator needs to see, not something to keep hammering.
const MAX_ATTEMPTS = 6;

// Rows are retried on a widening delay: 2^attempts minutes, so a brief Meta
// outage clears quickly while a persistent one stops flooding.
function backoffMinutes(attempts) {
  return Math.min(2 ** Math.max(0, attempts), 240);
}

// ── enqueue ─────────────────────────────────────────────────────────────────
//
// Gates run in a fixed order, each producing a distinct status so the
// diagnostics panel can say exactly why volume is lower than expected. The
// first two produce NO row at all: a workspace with the feature off, or a status
// nobody mapped, is not an anomaly worth logging on every lead update.
async function enqueue(leadId, newStatus, { settings, occurredAt } = {}) {
  const cfg = settings || await loadCloSettings();

  // Gate 1 — feature enabled at all.
  if (!cfg || !cfg.enabled) return { status: 'noop', reason: 'disabled' };

  // Gate 2 — does this CRM status map to an active stage?
  const { rows: stageRows } = await pool.query(
    `SELECT * FROM coexistence.clo_funnel_stages
      WHERE active AND crm_status_values ? $1
      ORDER BY sort_order LIMIT 1`, [String(newStatus)]);
  const stage = stageRows[0];
  if (!stage) return { status: 'noop', reason: 'status_not_mapped' };

  const { rows: leadRows } = await pool.query(
    `SELECT id, name, whatsapp_number, email, meta_lead_id, meta_lead_created_at, created_at
       FROM coexistence.leads WHERE id = $1`, [leadId]);
  const lead = leadRows[0];
  if (!lead) return { status: 'noop', reason: 'lead_missing' };

  const eventTime = occurredAt ? new Date(occurredAt) : new Date();

  // Gate 3 — already reported this rung, or already queued to be.
  //
  // 'pending' counts as a duplicate as well as 'sent': the backfill replays the
  // same transitions the scheduled sweep is picking up, and two pending rows for
  // one pair would both try to become 'sent' in a single flush batch, tripping
  // the unique index and failing the WHOLE batch. A 'dry_run' row is NOT a
  // duplicate — it was never transmitted, so once dry run is off the event
  // legitimately queues for real.
  // While dry run is ON, an existing dry_run row also counts — otherwise running
  // the backfill twice piles up identical rows nobody will ever send. Once dry
  // run is OFF it deliberately stops counting, so those same transitions can
  // finally queue for real.
  const dupStatuses = cfg.dry_run ? ['sent', 'pending', 'dry_run'] : ['sent', 'pending'];
  const { rows: dup } = await pool.query(
    `SELECT id FROM coexistence.clo_events
      WHERE lead_id = $1 AND stage_id = $2 AND status = ANY($3::text[]) LIMIT 1`,
    [lead.id, stage.id, dupStatuses]);
  if (dup.length) {
    return record({ lead, stage, eventTime, status: 'skipped_duplicate' });
  }

  // Gate 4 — Meta's 28-day attribution window, measured from LEAD CREATION.
  // Back-dating an older conversion is not an option: Meta drops it and the
  // event would misreport which week produced the result.
  const basis = lead.meta_lead_created_at || lead.created_at;
  if (basis) {
    const ageDays = (eventTime.getTime() - new Date(basis).getTime()) / 86400000;
    if (ageDays > CLO_WINDOW_DAYS) {
      return record({ lead, stage, eventTime, status: 'skipped_out_of_window' });
    }
  }

  // Gate 5 — is there anything Meta can match on?
  const event = clo.buildCloEvent({
    eventName: stage.event_name,
    eventTime: eventTime.getTime(),
    metaLeadId: lead.meta_lead_id,
    leadEventSource: cfg.lead_event_source,
    phone: lead.whatsapp_number,
    email: lead.email,
  });
  if (!clo.hasIdentifier(event)) {
    return record({ lead, stage, eventTime, status: 'skipped_no_identifier' });
  }
  if (!lead.meta_lead_id) {
    // Not an error, but match rate falls sharply without the Meta lead id, and
    // silently degrading is how a half-working integration goes unnoticed.
    console.warn(`[clo] lead ${lead.id} has no meta_lead_id — falling back to hashed phone/email, expect a lower match rate`);
  }

  // Gate 6 — dry run: build and store the exact payload, send nothing.
  const status = cfg.dry_run ? 'dry_run' : 'pending';
  return record({ lead, stage, eventTime, status, payload: event });
}

async function record({ lead, stage, eventTime, status, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.clo_events
       (lead_id, meta_lead_id, stage_id, event_name, event_time, payload, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     RETURNING *`,
    [lead.id, lead.meta_lead_id || null, stage.id, stage.event_name,
     eventTime.toISOString(), JSON.stringify(payload || {}), status]);
  return { status, row: rows[0] };
}

// ── flush ───────────────────────────────────────────────────────────────────
//
// Idempotent by construction: it only ever claims rows in 'pending', and a
// partial unique index makes a second 'sent' row for the same (lead, stage)
// impossible even under concurrent runs.
let flushing = false;

async function flush({ limit = clo.MAX_EVENTS_PER_REQUEST } = {}) {
  if (flushing) return { skipped: 'already_running' };
  flushing = true;
  try {
    const cfg = await loadCloSettings();
    if (!cfg || !cfg.enabled) return { sent: 0, failed: 0, reason: 'disabled' };
    if (cfg.dry_run) return { sent: 0, failed: 0, reason: 'dry_run' };
    if (!cfg.dataset_id) return { sent: 0, failed: 0, reason: 'no_dataset' };

    const token = cfg.access_token_encrypted ? decrypt(cfg.access_token_encrypted) : null;
    if (!token) return { sent: 0, failed: 0, reason: 'no_token' };

    // Rows whose backoff has elapsed. attempts=0 (never tried) is always due.
    const { rows: due } = await pool.query(
      `SELECT * FROM coexistence.clo_events
        WHERE status = 'pending'
          AND attempts < $1
          AND (attempts = 0 OR updated_at < NOW() - (POWER(2, LEAST(attempts, 8)) || ' minutes')::interval)
        ORDER BY created_at
        LIMIT $2`, [MAX_ATTEMPTS, Math.min(limit, clo.MAX_EVENTS_PER_REQUEST)]);

    if (!due.length) {
      await stampFlush(null);
      return { sent: 0, failed: 0, considered: 0 };
    }

    const events = due.map(r => r.payload);
    const result = await clo.sendCloEvents(token, cfg.dataset_id, events, {
      testEventCode: cfg.test_event_code,
      graphApiVersion: cfg.graph_api_version,
    });

    const ids = due.map(r => r.id);
    // Meta answers for the batch, not per event, so the whole batch shares the
    // outcome. A 4xx is terminal; a 5xx or throttle leaves rows pending for the
    // next run with their attempt count raised.
    if (result.ok) {
      await pool.query(
        `UPDATE coexistence.clo_events
            SET status='sent', attempts=attempts+1, sent_at=NOW(), last_error=NULL,
                meta_response=$2::jsonb, fbtrace_id=$3, updated_at=NOW()
          WHERE id = ANY($1::bigint[])`,
        [ids, JSON.stringify(result.response || {}), result.fbtraceId]);
      await stampFlush(null);
      return { sent: ids.length, failed: 0, considered: ids.length, fbtraceId: result.fbtraceId };
    }

    const terminal = !result.retryable;
    await pool.query(
      `UPDATE coexistence.clo_events
          SET status = CASE WHEN $4 OR attempts + 1 >= $5 THEN 'failed' ELSE 'pending' END,
              attempts = attempts + 1, last_error = $2,
              meta_response = $3::jsonb, fbtrace_id = $6, updated_at = NOW()
        WHERE id = ANY($1::bigint[])`,
      [ids, result.error, JSON.stringify(result.response || {}), terminal, MAX_ATTEMPTS, result.fbtraceId]);
    await stampFlush(result.error);
    return { sent: 0, failed: ids.length, considered: ids.length, retryable: result.retryable, error: result.error };
  } catch (err) {
    console.error('[clo] flush error:', err.message);
    await stampFlush(err.message).catch(() => {});
    return { error: err.message };
  } finally {
    flushing = false;
  }
}

async function stampFlush(error) {
  await pool.query(
    `UPDATE coexistence.clo_settings SET last_flush_at = NOW(), last_flush_error = $1, updated_at = NOW() WHERE id = 1`,
    [error || null]);
}

// ── the cursor sweep ────────────────────────────────────────────────────────
//
// Walks new 'stage_changed' rows in lead_events and enqueues each one. Any
// future code path that moves a lead is covered automatically, because it has
// to write that row to be visible in the app at all.
let sweeping = false;

async function sweepStageChanges() {
  if (sweeping) return { skipped: 'already_running' };
  sweeping = true;
  try {
    const cfg = await loadCloSettings();
    if (!cfg || !cfg.enabled) return { processed: 0, reason: 'disabled' };

    // lead_events timestamps its rows with `ts`, not created_at.
    const { rows: events } = await pool.query(
      `SELECT id, lead_id, to_value, ts
         FROM coexistence.lead_events
        WHERE event_type = 'stage_changed' AND id > $1
        ORDER BY id
        LIMIT 500`, [Number(cfg.last_event_id || 0)]);
    if (!events.length) return { processed: 0 };

    let cursor = Number(cfg.last_event_id || 0);
    const tally = {};
    for (const ev of events) {
      try {
        const r = await enqueue(ev.lead_id, ev.to_value, { settings: cfg, occurredAt: ev.ts });
        tally[r.status] = (tally[r.status] || 0) + 1;
      } catch (err) {
        // One bad lead must not stall the cursor behind it forever.
        console.error(`[clo] enqueue failed for lead_event ${ev.id}:`, err.message);
        tally.error = (tally.error || 0) + 1;
      }
      cursor = ev.id;
    }

    await pool.query(
      `UPDATE coexistence.clo_settings SET last_event_id = $1, updated_at = NOW() WHERE id = 1`, [cursor]);
    return { processed: events.length, lastId: cursor, tally };
  } catch (err) {
    console.error('[clo] sweep error:', err.message);
    return { error: err.message };
  } finally {
    sweeping = false;
  }
}

// ── backfill ────────────────────────────────────────────────────────────────
//
// Replays stage transitions already in lead_events so a freshly configured
// install is not starting from zero. Deliberately runs through the SAME enqueue
// as everything else — every gate, the duplicate check, the 28-day window — so
// it cannot smuggle in an event the live path would have refused.
//
// Does NOT move the sweep cursor. The two are independent: the cursor tracks
// what the scheduled sweep has seen going forward, and moving it here would skip
// anything that arrived between the backfill window and now.
async function backfill({ days = 28, dryRunOnly = false } = {}) {
  const cfg = await loadCloSettings();
  if (!cfg) return { error: 'not_configured' };
  if (!cfg.enabled) return { error: 'disabled', message: 'Switch the feature on before backfilling.' };

  // Meta will not accept anything older than the attribution window anyway, so
  // reaching further back only manufactures skipped rows.
  const window = Math.max(1, Math.min(CLO_WINDOW_DAYS, parseInt(days, 10) || CLO_WINDOW_DAYS));

  const { rows: events } = await pool.query(
    `SELECT id, lead_id, to_value, ts
       FROM coexistence.lead_events
      WHERE event_type = 'stage_changed'
        AND ts >= NOW() - ($1 || ' days')::interval
      ORDER BY ts
      LIMIT 5000`, [String(window)]);

  const tally = {};
  for (const ev of events) {
    try {
      const settings = dryRunOnly ? { ...cfg, dry_run: true } : cfg;
      const r = await enqueue(ev.lead_id, ev.to_value, { settings, occurredAt: ev.ts });
      tally[r.status] = (tally[r.status] || 0) + 1;
    } catch (err) {
      console.error(`[clo] backfill failed for lead_event ${ev.id}:`, err.message);
      tally.error = (tally.error || 0) + 1;
    }
  }
  return { considered: events.length, windowDays: window, tally };
}

// Called from the lead-update path if anyone wants to enqueue inline. Wrapped so
// a CLO failure can never break the transaction that produced the lead change.
async function enqueueSafe(leadId, newStatus, opts) {
  try {
    return await enqueue(leadId, newStatus, opts);
  } catch (err) {
    console.error('[clo] enqueue error (ignored, lead update unaffected):', err.message);
    return { status: 'error', error: err.message };
  }
}

module.exports = {
  enqueue, enqueueSafe, flush, sweepStageChanges, backfill,
  backoffMinutes, MAX_ATTEMPTS,
};
