// The follow-up ENROLLMENT sweeper, against a real database.
//
//   node --test test/followUpEngine.integration.test.js
//
// Scope: the cursor half. Every step here is given a delay far in the future,
// so the sweeper enrolls but never reaches the send path — no queue, no Meta,
// no message. That is deliberate: the enrollment rules are the ones whose
// failure is silent and retroactive, and they can be proven without sending
// anything to anybody.
//
// The rule that matters most: the cursor advances even when NOTHING is active.
// If it stalled, activating a sequence months later would replay every stage
// change since — mass-enrolling a backlog of leads into a live chase.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const engine = require('../src/services/followUpEngine');

let stageA = null;
let stageB = null;

const FAR_FUTURE_MINUTES = 60 * 24 * 30;   // 30 days — never due during a test run

async function cursor() {
  const { rows } = await h.pool.query(
    `SELECT last_event_id FROM coexistence.follow_up_state WHERE id = 1`);
  return Number(rows[0]?.last_event_id || 0);
}

async function makeSequence({ active = true, entryStage = null } = {}) {
  const { rows } = await h.pool.query(
    `INSERT INTO coexistence.follow_up_sequences (name, active, trigger_stage_key)
     VALUES ($1, $2, $3) RETURNING id`,
    [`Engine ${h.SEED}`, active, entryStage || stageB]);
  const id = rows[0].id;
  await h.pool.query(
    `INSERT INTO coexistence.follow_up_steps (sequence_id, step_order, message_kind, body, delay_minutes)
     VALUES ($1, 1, 'text', $2, $3)`,
    [id, 'Still interested?', FAR_FUTURE_MINUTES]);
  return id;
}

// Move a lead's stage the way the rest of the app does: update the row AND
// append the lead_events row the cursor reads. Eight code paths write
// leads.stage and several use raw SQL, which is exactly why the engine watches
// the log rather than hooking the writers.
async function moveStage(leadId, toStage) {
  await h.pool.query(`UPDATE coexistence.leads SET stage = $2 WHERE id = $1`, [leadId, toStage]);
  await h.pool.query(
    `INSERT INTO coexistence.lead_events (lead_id, event_type, to_value)
     VALUES ($1, 'stage_changed', $2)`,
    [leadId, toStage]);
}

describe('follow-up enrollment sweeper', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    await engine.ensureFollowUpTables().catch(() => {});
    const { rows } = await h.pool.query(
      `SELECT stage_key FROM coexistence.funnel_stages WHERE active = TRUE ORDER BY order_index`);
    stageA = rows[0]?.stage_key || 'new';
    stageB = rows[1]?.stage_key || rows[0]?.stage_key || 'new';
  });

  test('the cursor ADVANCES even with no active sequences', async (t) => {
    if (h.skipNoDb(t)) return;
    // The whole point. A stalled cursor turns "activate this sequence" into
    // "message everyone who ever reached this stage".
    await h.pool.query(`UPDATE coexistence.follow_up_sequences SET active = FALSE
                         WHERE name LIKE $1`, [`%${h.SEED}%`]);
    const lead = await h.makeLead({ phone: `9190${Date.now() % 100000000}`, name: `Cursor ${h.SEED}`, stage: stageA });
    await moveStage(lead.id, stageB);

    const before = await cursor();
    await engine.sweepFollowUps();
    const after = await cursor();
    assert.ok(after >= before, `cursor moved forward (${before} -> ${after})`);

    const { rows } = await h.pool.query(
      `SELECT MAX(id)::int AS max FROM coexistence.lead_events`);
    assert.equal(after, Number(rows[0].max), 'and it caught up to the newest event');
  });

  test('a stage change AFTER activation enrolls the lead', async (t) => {
    if (h.skipNoDb(t)) return;
    const seqId = await makeSequence({ active: true, entryStage: stageB });
    await engine.sweepFollowUps();                       // drain the backlog first

    const lead = await h.makeLead({ phone: `9191${Date.now() % 100000000}`, name: `Enrol ${h.SEED}`, stage: stageA });
    await moveStage(lead.id, stageB);
    await engine.sweepFollowUps();

    const { rows } = await h.pool.query(
      `SELECT status, next_step_order, stage_key_at_enrollment, enrolled_by, next_send_at
         FROM coexistence.follow_up_enrollments
        WHERE sequence_id = $1 AND lead_id = $2`, [seqId, lead.id]);
    assert.equal(rows.length, 1, 'enrolled exactly once');
    assert.equal(rows[0].status, 'active');
    // ⚠ next_step_order is a 0-based POSITION into `ORDER BY step_order, id`,
    // NOT the step's own step_order value. That is precisely why reordering or
    // deleting steps under a live run is 409-refused: the position would then
    // point at a different message than the one the lead was queued for.
    assert.equal(Number(rows[0].next_step_order), 0, 'positioned at the first step');
    assert.equal(rows[0].stage_key_at_enrollment, stageB,
      'the entry stage is snapshotted, so the stop rule compares against it later');
    assert.equal(rows[0].enrolled_by, 'auto:stage', 'attributed to the cursor, not a human');
    assert.ok(new Date(rows[0].next_send_at).getTime() > Date.now(),
      'the first step is scheduled into the future, never sent immediately');
  });

  test('activation is NOT retroactive — a change before it does not enroll', async (t) => {
    if (h.skipNoDb(t)) return;
    const lead = await h.makeLead({ phone: `9192${Date.now() % 100000000}`, name: `Past ${h.SEED}`, stage: stageA });
    await moveStage(lead.id, stageB);                    // happens FIRST
    await engine.sweepFollowUps();                       // cursor passes it with nothing active

    const seqId = await makeSequence({ active: true, entryStage: stageB });
    await engine.sweepFollowUps();                       // activating later must not replay

    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments
        WHERE sequence_id = $1 AND lead_id = $2`, [seqId, lead.id]);
    assert.equal(rows[0].n, 0, 'the backlog was not replayed into a live chase');
  });

  test('a second entry into the same stage does not enroll twice', async (t) => {
    if (h.skipNoDb(t)) return;
    const seqId = await makeSequence({ active: true, entryStage: stageB });
    await engine.sweepFollowUps();
    const lead = await h.makeLead({ phone: `9193${Date.now() % 100000000}`, name: `Twice ${h.SEED}`, stage: stageA });

    await moveStage(lead.id, stageB);
    await engine.sweepFollowUps();
    await moveStage(lead.id, stageA);
    await moveStage(lead.id, stageB);                    // back in again
    await engine.sweepFollowUps();

    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments
        WHERE sequence_id = $1 AND lead_id = $2`, [seqId, lead.id]);
    assert.equal(rows[0].n, 1, 'auto-enrollment refuses a lead with any prior run');
  });

  test('an INACTIVE sequence never enrolls', async (t) => {
    if (h.skipNoDb(t)) return;
    const seqId = await makeSequence({ active: false, entryStage: stageB });
    const lead = await h.makeLead({ phone: `9194${Date.now() % 100000000}`, name: `Off ${h.SEED}`, stage: stageA });
    await moveStage(lead.id, stageB);
    await engine.sweepFollowUps();
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments WHERE sequence_id = $1`, [seqId]);
    assert.equal(rows[0].n, 0);
  });

  test('a sweep is idempotent — running it twice changes nothing', async (t) => {
    if (h.skipNoDb(t)) return;
    const seqId = await makeSequence({ active: true, entryStage: stageB });
    await engine.sweepFollowUps();
    const lead = await h.makeLead({ phone: `9195${Date.now() % 100000000}`, name: `Idem ${h.SEED}`, stage: stageA });
    await moveStage(lead.id, stageB);

    await engine.sweepFollowUps();
    const a = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments WHERE sequence_id = $1`, [seqId]);
    await engine.sweepFollowUps();
    await engine.sweepFollowUps();
    const b = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments WHERE sequence_id = $1`, [seqId]);
    assert.equal(b.rows[0].n, a.rows[0].n, 'no duplicate enrollment from re-sweeping');
  });

  test('nothing becomes due while every step is 30 days out', async (t) => {
    if (h.skipNoDb(t)) return;
    // Proves this suite never reaches the send path — no queue job, no message.
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_log l
         JOIN coexistence.follow_up_enrollments e ON e.id = l.enrollment_id
         JOIN coexistence.follow_up_sequences s ON s.id = e.sequence_id
        WHERE s.name LIKE $1`, [`%${h.SEED}%`]);
    assert.equal(rows[0].n, 0, 'not one send was logged');
  });

  test('computeStopReason: a reply and a stage exit both stop the run', async (t) => {
    if (h.skipNoDb(t)) return;
    // Takes ONE options object, and reports 'stage_changed' (not 'left_stage').
    const base = {
      stopOnReply: true, stopOnStageChange: true,
      enrolledAt: new Date('2026-01-01T00:00:00Z'), stageAtEnrollment: stageB,
    };
    assert.equal(engine.computeStopReason({ ...base, stageNow: stageB, lastInboundAt: null }),
      null, 'quiet lead keeps running');
    assert.equal(engine.computeStopReason({ ...base, stageNow: stageB, lastInboundAt: new Date('2026-01-02T00:00:00Z') }),
      'replied', 'a reply after enrolling stops it');
    assert.equal(engine.computeStopReason({ ...base, stageNow: stageB, lastInboundAt: new Date('2025-12-01T00:00:00Z') }),
      null, 'a reply from BEFORE enrolling is not a reply to this sequence');
    assert.equal(engine.computeStopReason({ ...base, stageNow: stageA, lastInboundAt: null }),
      'stage_changed', 'leaving the entry stage stops it');
  });

  test('computeStopReason respects the per-sequence toggles', async (t) => {
    if (h.skipNoDb(t)) return;
    const enrolledAt = new Date('2026-01-01T00:00:00Z');
    assert.equal(engine.computeStopReason({
      stopOnReply: false, stopOnStageChange: false,
      enrolledAt, stageAtEnrollment: stageB,
      stageNow: stageA, lastInboundAt: new Date('2026-06-01T00:00:00Z'),
    }), null, 'with both rules off, neither a reply nor a stage exit stops it');
  });
});

after(async () => { await h.teardown(); });
