// Follow-up Sequences engine — auto-enrollment + due-step sender.
//
// Two halves, run by one sweep:
//   1. ENROLLMENT — a cursor over lead_events `stage_changed` rows (own
//      singleton cursor in follow_up_state; cursors are never shared between
//      features). Eight+ code paths write leads.stage and several use raw SQL,
//      so observation is the cursor, never hooks in the write paths — the same
//      shape as the CAPI / CLO / funnel-tag dispatchers.
//   2. DUE STEPS — enrollments whose next_send_at has arrived are claimed with
//      a lease UPDATE (rowCount check), stop rules are evaluated against the
//      CURRENT lead row, and the step is sent / skipped-with-reason / retried.
//
// Every send goes through the real outbound pipeline (insertPendingRow →
// enqueueSend), and every send calls routes/leads recordOutbound — which is
// the previously-dormant follow-up counter + cold-drop engine. After the
// configured number of unanswered follow-ups (agent_config
// stage_thresholds.cold_after_follow_ups, default 3) the lead moves to
// Cold/Lost automatically; the resulting stage change then stops the
// enrollment through the normal stop rule.
//
// Failure semantics follow the CAPI sweeper, not funnel-tags: sends are not
// idempotent, so the enrollment cursor never advances past an event that
// errored, and a failed send retries via its lease at most MAX_STEP_ATTEMPTS
// times before the step is skipped with `gave_up_after_3_attempts`.
const pool = require('../db');
const bus = require('../events');
const cfg = require('./funnelConfig');

const SWEEP_BATCH = 200;          // lead_events rows per enrollment pass
const SEND_CAP = 30;              // due steps processed per tick (blast guard)
const LEASE_MINUTES = 15;         // re-due horizon while a claim is being worked
const MAX_STEP_ATTEMPTS = 3;

// ── Schema self-heal (mirrors migration 095 — additive only) ─────────────────
async function ensureFollowUpTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_sequences (
      id                    BIGSERIAL PRIMARY KEY,
      name                  TEXT NOT NULL,
      description           TEXT,
      active                BOOLEAN NOT NULL DEFAULT FALSE,
      trigger_stage_key     TEXT,
      stop_on_reply         BOOLEAN NOT NULL DEFAULT TRUE,
      stop_on_stage_change  BOOLEAN NOT NULL DEFAULT TRUE,
      created_by            TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_steps (
      id                 BIGSERIAL PRIMARY KEY,
      sequence_id        BIGINT NOT NULL REFERENCES coexistence.follow_up_sequences(id) ON DELETE CASCADE,
      step_order         INT NOT NULL DEFAULT 0,
      delay_minutes      INT NOT NULL DEFAULT 1440 CHECK (delay_minutes >= 1),
      message_kind       TEXT NOT NULL DEFAULT 'template' CHECK (message_kind IN ('template', 'text')),
      template_id        INTEGER REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
      template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
      body               TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_follow_up_steps_seq
      ON coexistence.follow_up_steps (sequence_id, step_order);
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_enrollments (
      id                       BIGSERIAL PRIMARY KEY,
      sequence_id              BIGINT NOT NULL REFERENCES coexistence.follow_up_sequences(id) ON DELETE CASCADE,
      lead_id                  BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
      status                   TEXT NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'completed', 'replied', 'stage_changed', 'stopped')),
      stage_key_at_enrollment  TEXT,
      next_step_order          INT NOT NULL DEFAULT 0,
      next_send_at             TIMESTAMPTZ,
      fail_count               INT NOT NULL DEFAULT 0,
      enrolled_by              TEXT NOT NULL DEFAULT 'auto:stage',
      enrolled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at             TIMESTAMPTZ,
      finished_at              TIMESTAMPTZ,
      stop_reason              TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_enroll_active
      ON coexistence.follow_up_enrollments (sequence_id, lead_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_follow_up_enroll_due
      ON coexistence.follow_up_enrollments (next_send_at) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_follow_up_enroll_lead
      ON coexistence.follow_up_enrollments (lead_id);
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_log (
      id               BIGSERIAL PRIMARY KEY,
      enrollment_id    BIGINT NOT NULL REFERENCES coexistence.follow_up_enrollments(id) ON DELETE CASCADE,
      sequence_id      BIGINT NOT NULL,
      lead_id          BIGINT NOT NULL,
      step_id          BIGINT,
      step_order       INT,
      status           TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed', 'stopped')),
      reason           TEXT,
      local_message_id TEXT,
      ts               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_follow_up_log_seq ON coexistence.follow_up_log (sequence_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_follow_up_log_enroll ON coexistence.follow_up_log (enrollment_id);
    CREATE TABLE IF NOT EXISTS coexistence.follow_up_state (
      id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_event_id BIGINT NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Seed the cursor at the CURRENT max event id — enabling the feature must
  // never replay historical stage changes into mass enrollment.
  await pool.query(`
    INSERT INTO coexistence.follow_up_state (id, last_event_id)
    SELECT 1, COALESCE((SELECT MAX(id) FROM coexistence.lead_events), 0)
    ON CONFLICT (id) DO NOTHING
  `);
}

// ── Pure decision helpers (unit-tested in test/followup.test.js) ─────────────

// Why should this enrollment stop, if at all? Evaluated at each due step
// against the CURRENT lead row — no reply-cursor needed because
// leads.last_inbound_at is already stamped on every inbound message.
function computeStopReason({ stopOnReply, stopOnStageChange, enrolledAt, lastInboundAt, stageNow, stageAtEnrollment }) {
  if (stopOnReply && lastInboundAt && enrolledAt &&
      new Date(lastInboundAt).getTime() > new Date(enrolledAt).getTime()) {
    return 'replied';
  }
  if (stopOnStageChange && stageAtEnrollment && stageNow && stageNow !== stageAtEnrollment) {
    return 'stage_changed';
  }
  return null;
}

// Per-lead token substitution in step text and template variables. The legacy
// six tokens ({{name}} … {{stage}}) behave exactly as before (pinned by the
// unit tests); the grammar now also supports {{lead.<field>}}, {{sale.<token>}}
// and {{form.<slug>.<field>}} via services/variables.js. Unknown tokens are
// left as-is at send time — routes/followUps.js rejects them at save time.
// ctx carries the sale/form context loaded by loadTokenContext() when a step
// actually references those namespaces.
const { resolveTokens, loadTokenContext } = require('./variables');
function fillVars(text, lead, ctx = {}) {
  return resolveTokens(text, { lead, ...ctx });
}

// null when the template is sendable by this engine, else a skip reason.
//
// The engine builds ONLY body parameters (buildLiteralTemplateComponents).
// A template whose variables live anywhere else — a {{1}} in a TEXT header,
// a dynamic URL button like the payment (/pay/{{1}}) and form (/f/…/{{1}})
// templates, a COPY_CODE coupon — would pass a naive status check and then
// fail at Meta on EVERY send while the log claimed success. Those shapes are
// refused here, at save time in the route, and in the page's picker.
const HAS_VAR = /\{\{\s*\d+\s*\}\}/;
function templateBlockReason(template) {
  if (!template) return 'template_missing';
  if (String(template.status || '').toUpperCase() !== 'APPROVED') return 'template_not_approved';
  if (String(template.template_type || '').toUpperCase() === 'CAROUSEL') return 'carousel_not_supported';
  const ht = String(template.header_type || '').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht)) return 'media_header_not_supported';
  if (ht === 'TEXT' && HAS_VAR.test(template.header_text || '')) return 'header_variable_not_supported';
  const buttons = Array.isArray(template.buttons) ? template.buttons : [];
  for (const b of buttons) {
    const type = String(b?.type || '').toUpperCase();
    // Button fields are the editor's `value`/`urlSample`, never Meta's `url`.
    if (type === 'COPY_CODE') return 'button_variables_not_supported';
    if (type === 'URL' && HAS_VAR.test(String(b?.value || ''))) return 'button_variables_not_supported';
  }
  return null;
}

// Meta rejects a body-parameter count that differs from the template's {{n}}
// placeholders — normalise to EXACTLY the needed count. The route validates
// this at save; this is the second layer for steps created via API/MCP.
function templateVarMax(body) {
  let max = 0;
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body || ''))) max = Math.max(max, parseInt(m[1], 10));
  return max;
}
function normalizeTemplateVariables(variables, body) {
  const need = templateVarMax(body);
  const vals = Array.isArray(variables) ? variables : [];
  return Array.from({ length: need }, (_, i) => String(vals[i] ?? ' ') || ' ');
}

// ── Enrollment: cursor over lead_events stage_changed rows ───────────────────
async function sweepEnrollments() {
  const { rows: [state] } = await pool.query(
    `SELECT last_event_id FROM coexistence.follow_up_state WHERE id = 1`);
  if (!state) return { enrolled: 0 };
  let cursor = Number(state.last_event_id);

  const { rows: events } = await pool.query(
    `SELECT id, lead_id, to_value FROM coexistence.lead_events
      WHERE id > $1 AND event_type = 'stage_changed'
      ORDER BY id LIMIT ${SWEEP_BATCH}`, [cursor]);
  if (!events.length) return { enrolled: 0 };

  // Active auto-enroll sequences, with each one's first-step delay. A sequence
  // with no steps enrolls nobody (firstDelay null).
  const { rows: seqs } = await pool.query(`
    SELECT s.id, s.trigger_stage_key,
           (SELECT st.delay_minutes FROM coexistence.follow_up_steps st
             WHERE st.sequence_id = s.id ORDER BY st.step_order, st.id LIMIT 1) AS first_delay
      FROM coexistence.follow_up_sequences s
     WHERE s.active = TRUE AND s.trigger_stage_key IS NOT NULL`);
  const byStage = new Map();
  for (const s of seqs) {
    if (s.first_delay == null) continue;
    if (!byStage.has(s.trigger_stage_key)) byStage.set(s.trigger_stage_key, []);
    byStage.get(s.trigger_stage_key).push(s);
  }

  let enrolled = 0;
  let advanced = cursor;
  for (const ev of events) {
    try {
      const targets = (ev.lead_id && ev.to_value) ? (byStage.get(ev.to_value) || []) : [];
      for (const seq of targets) {
        // Auto-enrollment refuses a lead with ANY prior run of this sequence
        // (active or finished) — a lead bouncing back into the stage must not
        // be chased twice automatically. Manual re-enrollment stays possible.
        const { rowCount } = await pool.query(
          `INSERT INTO coexistence.follow_up_enrollments
             (sequence_id, lead_id, status, stage_key_at_enrollment, next_step_order, next_send_at, enrolled_by)
           SELECT $1, $2, 'active', $3, 0, NOW() + make_interval(mins => $4), 'auto:stage'
            WHERE NOT EXISTS (SELECT 1 FROM coexistence.follow_up_enrollments
                               WHERE sequence_id = $1 AND lead_id = $2)`,
          [seq.id, ev.lead_id, ev.to_value, seq.first_delay]);
        enrolled += rowCount;
      }
      advanced = Number(ev.id);
    } catch (err) {
      // CAPI semantics: never advance past a failed event — it is retried on
      // the next sweep instead of being lost.
      console.error('[follow-up] enrollment error at event', ev.id, err.message);
      break;
    }
  }
  if (advanced !== cursor) {
    await pool.query(
      `UPDATE coexistence.follow_up_state SET last_event_id = $1, updated_at = NOW() WHERE id = 1`,
      [advanced]);
  }
  return { enrolled };
}

// ── Due steps ────────────────────────────────────────────────────────────────

async function logOutcome(enrollment, step, status, reason, localMessageId) {
  try {
    await pool.query(
      `INSERT INTO coexistence.follow_up_log
         (enrollment_id, sequence_id, lead_id, step_id, step_order, status, reason, local_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [enrollment.id, enrollment.sequence_id, enrollment.lead_id,
       step?.id || null, step?.step_order ?? null, status, reason || null, localMessageId || null]);
  } catch (err) {
    console.error('[follow-up] log write failed:', err.message);
  }
}

async function finishEnrollment(enrollment, status, reason) {
  await pool.query(
    `UPDATE coexistence.follow_up_enrollments
        SET status = $2, stop_reason = $3, finished_at = NOW(), next_send_at = NULL
      WHERE id = $1`,
    [enrollment.id, status, reason || null]);
}

// Send one step. Returns { outcome: 'sent'|'skipped', reason?, localMessageId? }
// or throws for transient failures (retried via the lease).
async function sendStep(enrollment, step, lead) {
  const toDigits = String(lead.whatsapp_number || '').replace(/\D/g, '');
  if (!toDigits) return { outcome: 'skipped', reason: 'no_whatsapp_number' };

  // Load sale/form variable context only when this step's tokens need it —
  // zero extra queries for the common lead-only steps.
  const stepTexts = step.message_kind === 'text'
    ? [step.body]
    : (Array.isArray(step.template_variables) ? step.template_variables : []);
  const varCtx = await loadTokenContext(stepTexts, lead.id);

  if (step.message_kind === 'text') {
    // Free text rides the lead's existing thread and needs the 24h window.
    // One person can have contact rows on several business numbers; pick the
    // thread the customer last WROTE on — the one whose 24h window is
    // freshest. Sorting by contacts.updated_at instead would pick whichever
    // row was touched last (tags, renames) and could probe a closed window
    // while another thread's is open.
    const { rows: [thread] } = await pool.query(
      `SELECT c.wa_number, c.contact_number
         FROM coexistence.contacts c
         LEFT JOIN LATERAL (
           SELECT MAX(ch.timestamp) AS last_in
             FROM coexistence.chat_history ch
            WHERE ch.wa_number = c.wa_number AND ch.contact_number = c.contact_number
              AND ch.direction = 'incoming'
         ) t ON TRUE
        WHERE right(regexp_replace(c.contact_number, '\\D', '', 'g'), 10)
            = right(regexp_replace($1, '\\D', '', 'g'), 10)
        ORDER BY t.last_in DESC NULLS LAST LIMIT 1`,
      [lead.whatsapp_number]);
    if (!thread) return { outcome: 'skipped', reason: 'no_thread' };

    const { sendOnThread } = require('./paymentFlow');
    const res = await sendOnThread({
      waNumber: thread.wa_number,
      contactNumber: thread.contact_number,
      body: fillVars(step.body, lead, varCtx),
      requireWindow: true,
    });
    if (!res.sent) return { outcome: 'skipped', reason: res.reason };
    return { outcome: 'sent', localMessageId: res.localMessageId };
  }

  // Template step — sent from the template's OWN WhatsApp account (a template
  // only exists on the WABA it was approved under; sending it from another
  // number is Meta #132001).
  const { rows: [template] } = await pool.query(
    `SELECT id, name, language, status, whatsapp_account_id, header_type, header_text,
            template_type, body, buttons
       FROM coexistence.message_templates WHERE id = $1`, [step.template_id]);
  const blocked = templateBlockReason(template);
  if (blocked) return { outcome: 'skipped', reason: blocked };
  if (!template.whatsapp_account_id) return { outcome: 'skipped', reason: 'template_has_no_account' };

  const { resolveAccount, insertPendingRow } = require('./messageSender');
  const { account, error } = await resolveAccount({ accountId: template.whatsapp_account_id });
  if (!account) return { outcome: 'skipped', reason: `no_account: ${error || template.whatsapp_account_id}` };

  // Meta accepts a send even when the account is billing-blocked, then fails
  // it async — skip with the real reason instead (same guard as broadcasts).
  const { assertCanSend } = require('../routes/whatsappAccounts');
  const canSend = await assertCanSend(account);
  if (!canSend.ok) return { outcome: 'skipped', reason: `account_blocked: ${canSend.reason}` };

  const variables = normalizeTemplateVariables(step.template_variables, template.body)
    .map(v => fillVars(v, lead, varCtx));
  const { buildLiteralTemplateComponents } = require('./mcpService');
  const components = buildLiteralTemplateComponents(template, variables, null);

  // Resolved body stored on the local row so the chat UI shows real text.
  // Replacement via a function — a plain string replacement treats `$` as a
  // back-reference and would corrupt values containing it.
  let resolvedBody = template.body || '';
  variables.forEach((v, i) => {
    resolvedBody = resolvedBody.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, 'g'), () => v);
  });

  const localId = await insertPendingRow({
    account, toNumber: toDigits, messageType: 'template', messageBody: resolvedBody,
    templateMeta: { name: template.name, language: template.language, buttons: template.buttons },
    templateId: template.id, sendOrigin: 'follow_up',
  });
  const { enqueueSend } = require('../queue/sendQueue');
  await enqueueSend({
    kind: 'template', accountId: account.id, to: toDigits, localMessageId: localId,
    payload: { name: template.name, languageCode: template.language || 'en', components },
    // Unknown originRef kinds claim the wamid WITHOUT firing outbound keyword
    // triggers (sendQueue loop guard) — exactly right for an automated chase.
    originRef: { kind: 'follow_up_log', id: enrollment.id },
  });
  return { outcome: 'sent', localMessageId: localId };
}

async function processDueSteps() {
  const { rows: due } = await pool.query(`
    SELECT e.*, s.active AS seq_active, s.name AS seq_name,
           s.stop_on_reply, s.stop_on_stage_change
      FROM coexistence.follow_up_enrollments e
      JOIN coexistence.follow_up_sequences s ON s.id = e.sequence_id
     WHERE e.status = 'active' AND s.active = TRUE
       AND e.next_send_at IS NOT NULL AND e.next_send_at <= NOW()
     ORDER BY e.next_send_at
     LIMIT ${SEND_CAP}`);

  let sent = 0, skipped = 0, stopped = 0, failed = 0;
  for (const e of due) {
    // Lease-claim: push the due time forward so an overlapping tick (or a
    // crash mid-send) re-dues the row instead of double-processing it now.
    const { rowCount } = await pool.query(
      `UPDATE coexistence.follow_up_enrollments
          SET next_send_at = NOW() + make_interval(mins => ${LEASE_MINUTES})
        WHERE id = $1 AND status = 'active' AND next_send_at <= NOW()`,
      [e.id]);
    if (!rowCount) continue; // another sweep claimed it

    // Phase 1 — reads + stop rules. A failure here is harmless (nothing was
    // sent): log it and let the lease re-due the row.
    let lead, steps, step;
    try {
      // The full row (plus the assignee's display name) so ANY lead field can
      // be a variable — a narrower column list here would make new registry
      // fields silently resolve to '' (the old three-list sync hazard).
      ({ rows: [lead] } = await pool.query(
        `SELECT l.*, u.display_name AS assigned_user_name
           FROM coexistence.leads l
           LEFT JOIN coexistence.forgecrm_users u ON u.id = l.assigned_user_id
          WHERE l.id = $1`,
        [e.lead_id]));
      if (!lead) { await finishEnrollment(e, 'stopped', 'lead_missing'); stopped++; continue; }
      // {{stage}} fills with the human label; the key is the fallback when the
      // funnel config cache has no entry (e.g. a deactivated stage).
      lead.stage_label = (cfg.stages().find(s => s.stageKey === lead.stage) || {}).label || lead.stage;

      const stop = computeStopReason({
        stopOnReply: e.stop_on_reply,
        stopOnStageChange: e.stop_on_stage_change,
        enrolledAt: e.enrolled_at,
        lastInboundAt: lead.last_inbound_at,
        stageNow: lead.stage,
        stageAtEnrollment: e.stage_key_at_enrollment,
      });
      if (stop) {
        await finishEnrollment(e, stop, stop === 'replied' ? 'lead_replied' : 'left_enrollment_stage');
        await logOutcome(e, null, 'stopped', stop === 'replied' ? 'lead_replied' : 'left_enrollment_stage');
        stopped++;
        continue;
      }

      ({ rows: steps } = await pool.query(
        `SELECT * FROM coexistence.follow_up_steps
          WHERE sequence_id = $1 ORDER BY step_order, id`, [e.sequence_id]));
      step = steps[e.next_step_order];
      if (!step) { await finishEnrollment(e, 'completed', null); continue; }
    } catch (err) {
      console.error('[follow-up] pre-send read failed for enrollment', e.id, err.message);
      continue;
    }

    // Phase 2 — the send. Only THIS phase feeds the retry counter: retrying
    // is safe here because nothing reached the queue.
    let res;
    try {
      res = await sendStep(e, step, lead);
    } catch (err) {
      failed++;
      console.error('[follow-up] send failed for enrollment', e.id, err.message);
      try {
        const { rows: [row] } = await pool.query(
          `UPDATE coexistence.follow_up_enrollments SET fail_count = fail_count + 1
            WHERE id = $1 RETURNING fail_count, next_step_order`, [e.id]);
        await logOutcome(e, step, 'failed', err.message.slice(0, 300));
        if (row && row.fail_count >= MAX_STEP_ATTEMPTS) {
          // One bad step must not wedge the run: skip it and move on.
          const next = steps[row.next_step_order + 1];
          await logOutcome(e, step, 'skipped', 'gave_up_after_3_attempts');
          if (next) {
            await pool.query(
              `UPDATE coexistence.follow_up_enrollments
                  SET next_step_order = next_step_order + 1,
                      next_send_at = NOW() + make_interval(mins => $2), fail_count = 0
                WHERE id = $1`, [e.id, next.delay_minutes]);
          } else {
            await finishEnrollment(e, 'completed', 'ended_after_failed_step');
          }
        }
      } catch (err2) {
        console.error('[follow-up] failure bookkeeping failed for enrollment', e.id, err2.message);
      }
      continue;
    }

    // Phase 3 — bookkeeping after the send. NEVER routed to the retry path: a
    // retry here would deliver the message twice. Worst case on a DB blip the
    // lease re-dues the row and ONE duplicate is possible — preferred over
    // silently losing the chase.
    try {
      await logOutcome(e, step, res.outcome, res.reason, res.localMessageId);
      if (res.outcome === 'sent') {
        sent++;
        // The dormant follow-up counter + cold-drop engine, finally wired:
        // unanswered chases increment the streak; at the configured limit the
        // lead moves to Cold/Lost and the stage-change stop rule ends the run.
        try {
          const { recordOutbound } = require('../routes/leads');
          await recordOutbound(e.lead_id, { bda: 'auto:follow-up', note: `${e.seq_name} · step ${e.next_step_order + 1}` });
        } catch (err) {
          console.error('[follow-up] recordOutbound failed:', err.message);
        }
      } else {
        skipped++;
      }

      // Advance — a skipped step (closed window, blocked template) must not
      // wedge the sequence; the next step still goes out on schedule.
      const next = steps[e.next_step_order + 1];
      if (next) {
        await pool.query(
          `UPDATE coexistence.follow_up_enrollments
              SET next_step_order = next_step_order + 1,
                  next_send_at = NOW() + make_interval(mins => $2),
                  fail_count = 0,
                  last_sent_at = CASE WHEN $3 THEN NOW() ELSE last_sent_at END
            WHERE id = $1`,
          [e.id, next.delay_minutes, res.outcome === 'sent']);
      } else {
        if (res.outcome === 'sent') {
          await pool.query(
            `UPDATE coexistence.follow_up_enrollments SET last_sent_at = NOW() WHERE id = $1`, [e.id]);
        }
        await finishEnrollment(e, 'completed', null);
      }
    } catch (err) {
      console.error('[follow-up] post-send bookkeeping failed for enrollment', e.id,
        '— the lease will re-due it; a duplicate send is possible:', err.message);
    }
  }
  return { due: due.length, sent, skipped, stopped, failed };
}

// ── The sweep ────────────────────────────────────────────────────────────────
let sweeping = false; // sends are not idempotent — re-entrancy mutex (CAPI-style)
async function sweepFollowUps() {
  if (sweeping) return { skipped: 'busy' };
  sweeping = true;
  try {
    const enroll = await sweepEnrollments();
    const steps = await processDueSteps();
    return { ...enroll, ...steps };
  } finally {
    sweeping = false;
  }
}

// Debounced kick so a stage change enrolls near-instantly; the interval timer
// in index.js is the safety net. Leading-edge suppression like the other
// dispatchers — safe because the sweep re-reads its cursor when it fires.
let _kickTimer = null;
function kickSweep(delay = 3000) {
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    sweepFollowUps().catch(err => console.error('[follow-up] kicked sweep failed:', err.message));
  }, delay);
  if (typeof _kickTimer.unref === 'function') _kickTimer.unref();
}
bus.on('lead-changed', () => kickSweep());

module.exports = {
  ensureFollowUpTables,
  sweepFollowUps,
  kickSweep,
  // pure helpers, exported for tests + route validation
  computeStopReason,
  fillVars,
  templateBlockReason,
  templateVarMax,
  normalizeTemplateVariables,
};
