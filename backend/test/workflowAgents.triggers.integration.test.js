// Workflow Agents — triggers against real Postgres: schedules fire once per slot,
// a burst of messages debounces into one run, events de-duplicate, a new sale
// fires one payment event, a quiet spell fires once, expired approvals expire.
// The queue is stubbed (no Redis); runs are created but not executed.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const queuePath = require.resolve('../src/queue/sendQueue');
require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true, exports: { enqueueSend: async () => ({}) } };
const wfQueuePath = require.resolve('../src/services/workflowAgents/queue');
const enqueued = [];
require.cache[wfQueuePath] = { id: wfQueuePath, filename: wfQueuePath, loaded: true, exports: { enqueueRun: async (id) => { enqueued.push(String(id)); } } };

const pool = require('../src/db');
const { ensureWorkflowAgentTables } = require('../src/services/workflowAgents/schema');
const service = require('../src/services/workflowAgents/service');
const triggers = require('../src/services/workflowAgents/triggers');
const world = require('./fixtures/workflowAgentsWorld').makeWorld(3);

const { ids, mid, L, NUM_A } = world;
const LIVE_REFUSED = process.env.DB_NAME === 'forgegrowth' && process.env.WORKFLOW_AGENT_TESTS_ALLOW_LIVE !== '1';
let dbUp = false;
let agentId;

const minutesAgo = (m) => new Date(Date.now() - m * 60000);

async function inbound(id, type, atMinutesAgo, to = L.hot) {
  await pool.query(
    `INSERT INTO coexistence.chat_history (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, created_at)
     VALUES ($1,$2,$3,'incoming',$4,$5,'received',$6,$6)`,
    [mid(id), NUM_A, to, type, type === 'audio' ? 'Audio message' : 'hello', minutesAgo(atMinutesAgo)]);
}

async function agentsForTest() {
  return (await triggers.activeAgents()).filter(a => String(a.id) === String(agentId));
}

async function runsFor(prefix) {
  const { rows } = await pool.query(`SELECT id, trigger_type, trigger_key, trigger_payload FROM coexistence.workflow_agent_runs WHERE agent_id = $1 AND trigger_key LIKE $2 ORDER BY id`, [agentId, `${prefix}%`]);
  return rows;
}

before(async () => {
  if (LIVE_REFUSED) return;
  try { await pool.query('SELECT 1'); dbUp = true; } catch { return; }
  await ensureWorkflowAgentTables();
  await world.seed(pool);
  const created = await service.createAgent({ name: `${world.names.agentSlug}-triggers`, userId: ids.repA });
  agentId = created.agent.id;
  const v = created.version;
  await service.saveVersion(agentId, {
    ...v,
    // Scope to this world's numbers so rows written by other test files never reach this agent.
    data_scope: { business_numbers: [world.NUM_A, world.NUM_B], exclude_tags: [] },
    triggers: [
      { type: 'schedule', cron: '* * * * *' },
      { type: 'event', event: 'message.inbound', filters: { message_type: ['voice_note', 'text'] }, debounce_minutes: 15 },
      { type: 'event', event: 'lead.stage_changed', filters: { to: ['enrolled'] }, debounce_minutes: 0 },
      { type: 'event', event: 'payment.created', debounce_minutes: 0 },
      { type: 'event', event: 'lead.quiet', filters: { hours_since_last_inbound: 48 } },
      { type: 'manual' },
    ],
  }, 'triggers for test', ids.repA);
  await service.updateAgent(agentId, { status: 'active' }, ids.repA);
  // Move the global cursors to "now" so only rows this file writes are swept.
  await pool.query(
    `UPDATE coexistence.workflow_agent_settings SET
       last_chat_history_id = (SELECT COALESCE(MAX(id),0) FROM coexistence.chat_history),
       last_lead_event_id = (SELECT COALESCE(MAX(id),0) FROM coexistence.lead_events),
       last_sales_log_id = (SELECT COALESCE(MAX(id),0) FROM coexistence.sales_log) WHERE id = 1`);
});

after(async () => {
  if (dbUp && !LIVE_REFUSED) await world.cleanup(pool);
  await pool.end();
});

const skip = (t) => {
  if (LIVE_REFUSED) { t.skip('refusing to seed the live forgegrowth database'); return true; }
  if (!dbUp) { t.skip('no database'); return true; }
  return false;
};

describe('schedules', () => {
  test('a slot fires once however many ticks see it; a paused agent does not fire', async (t) => {
    if (skip(t)) return;
    const now = new Date();
    const agents = await agentsForTest();
    assert.equal(agents.length, 1);
    const first = await triggers.tickSchedules(agents, now);
    const second = await triggers.tickSchedules(agents, new Date(now.getTime() + 1000));
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.ok(enqueued.includes(String(first[0])));
    await service.updateAgent(agentId, { status: 'paused' }, ids.repA);
    assert.equal((await agentsForTest()).length, 0);
    await service.updateAgent(agentId, { status: 'active' }, ids.repA);
  });
});

describe('events', () => {
  test('a burst of inbound messages debounces into ONE run', async (t) => {
    if (skip(t)) return;
    await inbound('t1', 'text', 3);
    await inbound('t2', 'audio', 2.5);
    await inbound('t3', 'image', 2, L.hot);  // not a watched message type
    await inbound('t4', 'text', 2);
    const counts = await triggers.sweepEvents(await agentsForTest());
    assert.ok(counts.buffered >= 3);
    const { rows: pending } = await pool.query(`SELECT * FROM coexistence.workflow_agent_pending_events WHERE agent_id = $1 AND event = 'message.inbound' AND status = 'waiting'`, [agentId]);
    assert.equal(pending.length, 1, 'one waiting row per lead');
    assert.deepEqual(pending[0].payload.items.map(i => i.message_type), ['text', 'voice_note', 'text']);
    assert.equal((await triggers.fireDueEvents(new Date())).length, 0, 'still inside the debounce window');
    const fired = await triggers.fireDueEvents(new Date(Date.now() + 16 * 60000));
    assert.equal(fired.length, 1);
    assert.equal((await triggers.fireDueEvents(new Date(Date.now() + 20 * 60000))).length, 0);
    const runs = await runsFor('event:1:message.inbound');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger_payload.lead_id, String(ids.hot));
    assert.equal(runs[0].trigger_payload.items.length, 3);
    // Sweeping again reads nothing new.
    assert.equal((await triggers.sweepEvents(await agentsForTest())).messages, 0);
  });

  test('a stage change into a watched stage fires; others do not', async (t) => {
    if (skip(t)) return;
    await pool.query(
      `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor, ts)
       VALUES ($1,'stage_changed','hot','enrolled','test',$2), ($1,'stage_changed','new','engaged','test',$2)`, [ids.onB, minutesAgo(1)]);
    await triggers.sweepEvents(await agentsForTest());
    await triggers.fireDueEvents(new Date(Date.now() + 60000));
    const runs = await runsFor('event:2:lead.stage_changed');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].trigger_payload.items, [{ from: 'hot', to: 'enrolled' }]);
  });

  test('a new sale produces one payment event', async (t) => {
    if (skip(t)) return;
    await pool.query(
      `INSERT INTO coexistence.sales_log (lead_id, student_name, amount_paise, payment_date, created_at)
       VALUES ($1, $2, 150000, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $3)`,
      [ids.enrolled, `${world.names.student}_b`, minutesAgo(1)]);
    try {
      await triggers.sweepEvents(await agentsForTest());
      await triggers.fireDueEvents(new Date(Date.now() + 60000));
      const runs = await runsFor('event:3:payment.created');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].trigger_payload.items.length, 1);
      assert.equal(runs[0].trigger_payload.items[0].amount_rupees, 1500);
    } finally {
      await pool.query(`DELETE FROM coexistence.sales_log WHERE student_name = $1`, [`${world.names.student}_b`]);
    }
  });

  test('a quiet spell fires once', async (t) => {
    if (skip(t)) return;
    await pool.query(
      `INSERT INTO coexistence.chat_history (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp)
       VALUES ($1,$2,$3,'incoming','text','are you there?','received',$4)`, [mid('q1'), world.NUM_B, L.onB, new Date(Date.now() - 49 * 36e5)]);
    // onB's latest inbound must be the 49h-old one for this lead to be "quiet".
    await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id = $1`, [mid('b1')]);
    const first = await triggers.scanQuiet(await agentsForTest());
    const second = await triggers.scanQuiet(await agentsForTest());
    const runs = await runsFor('quiet:4:');
    assert.ok(first.length >= 1);
    assert.equal(second.length, 0);
    assert.ok(runs.some(r => r.trigger_payload.lead_id === String(ids.onB)));
  });
});

describe('housekeeping', () => {
  test('expired approvals expire and never stay pending', async (t) => {
    if (skip(t)) return;
    const { rows: [a] } = await pool.query(
      `INSERT INTO coexistence.workflow_agent_actions (agent_id, action_type, lead_id, payload, status, expires_at)
       VALUES ($1, 'tag_contact', $2, '{"tag":"x"}', 'pending', NOW() - INTERVAL '1 minute') RETURNING id`, [agentId, ids.hot]);
    await triggers.housekeeping();
    const { rows: [after] } = await pool.query(`SELECT status FROM coexistence.workflow_agent_actions WHERE id = $1`, [a.id]);
    assert.equal(after.status, 'expired');
  });
});
