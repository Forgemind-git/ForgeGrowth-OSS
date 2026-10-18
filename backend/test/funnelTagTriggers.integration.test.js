// The funnel stage-tag → tagApplied automation bridge, against a REAL Postgres.
//
//   node --test test/funnelTagTriggers.integration.test.js
//
// Needs a reachable database. Skips cleanly rather than failing when there is
// none, so `npm test` still works on a machine without one.
//
// WHAT THIS GUARDS
// ----------------
// `sweepStageEvents` mirrors a lead's funnel stage onto its contact rows, and
// now also fires any `tagApplied` automation waiting on that stage's tag. That
// is what lets a Razorpay payment (webhook → lead enrolled → stage tag) send a
// confirmation on WhatsApp with no human in the loop.
//
// ⚠ THE FAILURE THIS EXISTS TO PREVENT is not "the trigger does not fire" — it
// is the opposite. `syncAllLeadTags()` is a repair button that re-mirrors EVERY
// lead. If the bridge lived in `applyFunnelTagByNumber` (which both paths call)
// pressing it would start one automation per lead — on this instance, a few
// hundred real people messaged at once. So the backfill assertion below is the
// important half of this file, not the happy path.
//
// Safety: every row created here carries a SEED-prefixed number and is deleted
// afterwards. The automation used has NO message node, so nothing is ever sent
// to Meta — the assertion is on the execution row, which is what proves the
// trigger fired.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const pool = require('../src/db');
const funnelTags = require('../src/services/funnelTags');

const SEED = '99811';
const NUMBER = `91${SEED}54321`;
const WA = '911111111111';               // the business number side of contacts
const STAGE_FROM = 'hot';
const STAGE_TO = 'enrolled';

let dbUp = false;
let leadId = null;
let botId = null;
let tagLabel = null;

// setImmediate + a non-awaited async chain: give the fired trigger a moment to
// land its execution row before asserting. Polled rather than slept-on so the
// test is not slower than it needs to be.
async function waitForExecutions(expected, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM coexistence.automation_executions WHERE automation_id = $1`, [botId]);
    if (rows[0].n >= expected || Date.now() > deadline) return rows[0].n;
    await new Promise(r => setTimeout(r, 100));
  }
}

const clean = async () => {
  if (botId) await pool.query(`DELETE FROM coexistence.automation_executions WHERE automation_id = $1`, [botId]);
  await pool.query(`DELETE FROM coexistence.lead_events WHERE lead_id = $1`, [leadId]).catch(() => {});
  await pool.query(`DELETE FROM coexistence.leads WHERE whatsapp_number LIKE $1`, [`%${SEED}%`]);
  await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number LIKE $1`, [`%${SEED}%`]);
  if (botId) await pool.query(`DELETE FROM coexistence.chatbots WHERE id = $1`, [botId]);
};

describe('funnel stage tag → tagApplied bridge', () => {
  before(async () => {
    try { await pool.query('SELECT 1'); dbUp = true; } catch { dbUp = false; return; }

    // The label is what a tagApplied trigger matches on, so read the real one
    // rather than assuming "Enrolled" — an instance may have renamed it.
    const { rows: st } = await pool.query(
      `SELECT label FROM coexistence.funnel_stages WHERE stage_key = $1 AND active = TRUE`, [STAGE_TO]);
    if (!st[0]) { dbUp = false; return; }
    tagLabel = st[0].label;

    await pool.query(`DELETE FROM coexistence.leads WHERE whatsapp_number LIKE $1`, [`%${SEED}%`]);
    await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number LIKE $1`, [`%${SEED}%`]);

    const { rows } = await pool.query(
      `INSERT INTO coexistence.leads (whatsapp_number, name, stage, source)
       VALUES ($1,'Bridge Seed',$2,'Direct') RETURNING id`, [NUMBER, STAGE_FROM]);
    leadId = rows[0].id;

    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags)
       VALUES ($1,$2,'Bridge Seed','[]'::jsonb)
       ON CONFLICT (wa_number, contact_number) DO NOTHING`, [WA, NUMBER]);

    // Trigger + a delay step. Deliberately NO message node: this must never be
    // able to send anything, on any database it is pointed at.
    const config = {
      nodes: [
        { id: 't1', type: 'trigger', triggerKind: 'tagApplied', tag: tagLabel, tagDirection: 'added', fireOncePerTag: true, x: 0, y: 0 },
        { id: 'd1', type: 'delay', delayMode: 'duration', waitValue: 0, waitUnit: 'seconds', x: 300, y: 0 },
      ],
      edges: [{ id: 'e1', from: 't1', to: 'd1', fromHandle: 'default' }],
    };
    const { rows: bot } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, status, config)
       VALUES ('__bridge_test__','active',$1::jsonb) RETURNING id`, [JSON.stringify(config)]);
    botId = bot[0].id;

    // Park the cursor at the current head so the sweep only ever sees the one
    // event this test creates, not whatever the instance already had.
    const { rows: head } = await pool.query(`SELECT COALESCE(MAX(id),0)::bigint AS id FROM coexistence.lead_events`);
    await pool.query(`UPDATE coexistence.funnel_tag_state SET last_event_id = $1 WHERE id = 1`, [head[0].id]);
  });

  after(async () => {
    if (dbUp) await clean();
    await pool.end().catch(() => {});
  });

  const t = (name, fn) => test(name, async (ctx) => {
    if (!dbUp) return ctx.skip('no database, or funnel stage missing');
    await fn(ctx);
  });

  t('the BACKFILL mirrors tags but fires NOTHING', async () => {
    await pool.query(`UPDATE coexistence.leads SET stage = $1 WHERE id = $2`, [STAGE_TO, leadId]);

    await funnelTags.syncAllLeadTags({ limit: 100000 });

    const { rows } = await pool.query(
      `SELECT tags FROM coexistence.contacts WHERE contact_number = $1`, [NUMBER]);
    const names = (rows[0].tags || []).map(x => x.name);
    assert.ok(names.includes(tagLabel), `backfill should still mirror the tag, got ${JSON.stringify(names)}`);

    const n = await waitForExecutions(1, 1200);
    assert.equal(n, 0, 'a repair backfill must never start automations — it would message every lead at once');
  });

  t('a real stage CHANGE fires the automation exactly once', async () => {
    await pool.query(`DELETE FROM coexistence.automation_executions WHERE automation_id = $1`, [botId]);
    await pool.query(`UPDATE coexistence.leads SET stage = $1 WHERE id = $2`, [STAGE_FROM, leadId]);
    await funnelTags.syncAllLeadTags({ limit: 100000 });   // settle, fires nothing

    // What the Razorpay webhook does: move the stage and log the audit row the
    // sweep's cursor reads.
    await pool.query(`UPDATE coexistence.leads SET stage = $1 WHERE id = $2`, [STAGE_TO, leadId]);
    await pool.query(
      `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
       VALUES ($1,'stage_changed',$2,$3,'test')`, [leadId, STAGE_FROM, STAGE_TO]);

    const res = await funnelTags.sweepStageEvents();
    assert.ok(res.processed >= 1, 'the sweep should have seen the stage_changed event');

    const n = await waitForExecutions(1);
    assert.equal(n, 1, 'the payment confirmation automation should have started exactly once');

    const { rows } = await pool.query(
      `SELECT trigger_type, contact_number, trigger_data FROM coexistence.automation_executions
        WHERE automation_id = $1`, [botId]);
    assert.equal(rows[0].trigger_type, 'tagApplied');
    assert.equal(rows[0].contact_number, NUMBER);
    assert.equal(rows[0].trigger_data.tag, tagLabel);
  });

  t('re-entering the same stage does not message the person twice', async () => {
    // fireOncePerTag is what stops a second confirmation. Prove it, because the
    // sweep is a cursor and a stage can legitimately be set again.
    await pool.query(`UPDATE coexistence.leads SET stage = $1 WHERE id = $2`, [STAGE_TO, leadId]);
    await pool.query(
      `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
       VALUES ($1,'stage_changed',$2,$3,'test')`, [leadId, STAGE_TO, STAGE_TO]);
    await funnelTags.sweepStageEvents();

    const n = await waitForExecutions(2, 1500);
    assert.equal(n, 1, 'fireOncePerTag should have suppressed the duplicate');
  });
});
