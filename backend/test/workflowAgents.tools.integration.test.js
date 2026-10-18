// Workflow Agents — tool layer against real Postgres.
//
// Seeds a small, fully known world (marker numbers 91900000010x / 9191000000xx,
// message ids "wftest.*"), runs the real tools over it and asserts exact values.
// Everything seeded is removed in after().
//
// ⚠ Refuses to run against the live `forgegrowth` database unless
// WORKFLOW_AGENT_TESTS_ALLOW_LIVE=1: point DB_NAME at a scratch clone.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Stub the send queue so requiring services never opens a Redis handle.
const queuePath = require.resolve('../src/queue/sendQueue');
require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true, exports: { enqueueSend: async () => ({}), startSendWorker() {}, shutdownSendQueue: async () => {} } };

const pool = require('../src/db');
const { ensureWorkflowAgentTables } = require('../src/services/workflowAgents/schema');
const reg = require('../src/services/workflowAgents/tools');
const { normalizeScope } = require('../src/services/workflowAgents/scope');

const LIVE_REFUSED = process.env.DB_NAME === 'forgegrowth' && process.env.WORKFLOW_AGENT_TESTS_ALLOW_LIVE !== '1';
let dbUp = false;

const world = require('./fixtures/workflowAgentsWorld').makeWorld(1);
const { ids, L, NUM_B, now, names, mid } = world;
const allTools = reg.TOOLS.map(t => ({ tool_key: t.key, enabled: true }));

async function ctxFor(scopeRaw = {}, { dryRun = true, runId = null, toolConfig = allTools, agentId = null } = {}) {
  const { scope } = normalizeScope({ lookback_days: 14, ...scopeRaw });
  return reg.buildToolContext({ pool, agent: { id: agentId || ids.agent, auto_accept_memory: false }, scope, toolConfig, dryRun, runId, now, recordStep: () => {} });
}

before(async () => {
  if (LIVE_REFUSED) return;
  try { await pool.query('SELECT 1'); dbUp = true; } catch { return; }
  await ensureWorkflowAgentTables();
  await world.seed(pool);
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

const IST_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;

describe('scope enforcement', () => {
  test('list_leads masks PII, stamps IST, and excludes opted-out and do-not-contact leads', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor();
    const r = await reg.runTool(ctx, 'list_leads', { limit: 200, sort: 'created_desc' });
    const mine = r.leads.filter(l => Object.values(ids).map(String).includes(l.contact_id));
    const byId = new Map(mine.map(l => [l.contact_id, l]));
    assert.ok(byId.has(String(ids.hot)));
    assert.ok(!byId.has(String(ids.optedOut)), 'opted-out lead must be invisible');
    assert.ok(!byId.has(String(ids.dnc)), 'a "Do not contact" tag on any thread excludes the lead');
    const hot = byId.get(String(ids.hot));
    assert.equal(hot.name, 'Priya S.');
    assert.equal(hot.phone, '+91 91xxxxx001');
    assert.match(hot.created_at, IST_RE);
    assert.match(hot.last_inbound_at, IST_RE);
  });

  test('an out-of-scope lead returns out_of_scope from every lead tool', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor({ funnel_stages: ['hot'] });
    for (const [tool, input] of [
      ['get_lead_profile', { contact_id: String(ids.dnc) }],
      ['get_conversation', { contact_id: String(ids.optedOut) }],
      ['get_stage_history', { contact_id: String(ids.enrolled) }],
      ['draft_whatsapp_reply', { contact_id: String(ids.enrolled), message: 'hi' }],
      ['tag_contact', { contact_id: String(ids.enrolled), tag: 'hot_signal', reason: 'x' }],
      ['get_lead_profile', { contact_id: '999999999' }],
    ]) {
      const r = await reg.runTool(ctx, tool, input);
      assert.equal(r.error, 'out_of_scope', tool);
      assert.equal(Object.keys(r).length, 2, `${tool} must not leak anything beyond the error`);
    }
    assert.equal((await reg.runTool(ctx, 'get_lead_profile', { contact_id: String(ids.hot) })).stage, 'hot');
  });

  test('business number scope limits leads and messages', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor({ business_numbers: [NUM_B] });
    assert.equal((await reg.runTool(ctx, 'get_lead_profile', { contact_id: String(ids.hot) })).error, 'out_of_scope');
    const r = await reg.runTool(ctx, 'search_messages', { query: 'fees', limit: 50 });
    assert.deepEqual([...new Set(r.matches.map(m => m.contact_id))].filter(id => Object.values(ids).map(String).includes(id)), [String(ids.onB)]);
  });

  test('the lookback window hides older messages even when asked for them', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor();
    const r = await reg.runTool(ctx, 'get_conversation', { contact_id: String(ids.old), since: '2020-01-01' });
    assert.equal(r.window.clamped_to_lookback, true);
    assert.equal(r.messages.length, 0);
    const wide = await reg.runTool(await ctxFor({ lookback_days: 60 }), 'get_conversation', { contact_id: String(ids.old) });
    assert.equal(wide.messages.length, 1);
  });

  test('chat_types scope removes voice notes entirely', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor({ chat_types: ['lead_bot', 'lead_rep', 'broadcast'] });
    const r = await reg.runTool(ctx, 'get_conversation', { contact_id: String(ids.hot), chat_types: ['voice_note', 'lead_bot', 'lead_rep'] });
    assert.ok(r.messages.length > 0);
    assert.ok(!r.messages.some(m => m.message_type === 'voice_note'), 'voice notes are out of scope even when requested');
    assert.ok(!r.messages.some(m => m.chat_type === 'broadcast'), 'a type in scope but not requested is not returned');
  });

  test('won_stages: exclude hides customers; exclude_unless_outstanding keeps the ones who still owe', async (t) => {
    if (skip(t)) return;
    const excluded = await ctxFor({ won_stages: 'exclude' });
    assert.equal((await reg.runTool(excluded, 'get_lead_profile', { contact_id: String(ids.enrolled) })).error, 'out_of_scope');
    const owing = await ctxFor({ won_stages: 'exclude_unless_outstanding' });
    assert.equal((await reg.runTool(owing, 'get_lead_profile', { contact_id: String(ids.enrolled) })).outstanding_balance.rupees, 2000);
    await pool.query(`UPDATE coexistence.leads SET payment_status = 'paid' WHERE id = $1`, [ids.enrolled]);
    try {
      assert.equal((await reg.runTool(owing, 'get_lead_profile', { contact_id: String(ids.enrolled) })).error, 'out_of_scope', 'a manual "paid" override means nothing is owed');
    } finally {
      await pool.query(`UPDATE coexistence.leads SET payment_status = NULL WHERE id = $1`, [ids.enrolled]);
    }
  });

  test('rep scope uses the time-bounded number assignment', async (t) => {
    if (skip(t)) return;
    // Priya's latest inbound is on number A, which Rep B holds now.
    assert.equal((await reg.runTool(await ctxFor({ rep_user_ids: [String(ids.repB)] }), 'get_lead_profile', { contact_id: String(ids.hot) })).rep_user_id, String(ids.repB));
    assert.equal((await reg.runTool(await ctxFor({ rep_user_ids: [String(ids.repA)] }), 'get_lead_profile', { contact_id: String(ids.hot) })).error, 'out_of_scope');
  });
});

describe('conversation shape', () => {
  test('messages are chronological with transcripts, titles, templates, sender types and window flags', async (t) => {
    if (skip(t)) return;
    const r = await reg.runTool(await ctxFor(), 'get_conversation', { contact_id: String(ids.hot) });
    const byId = new Map(r.messages.map(m => [m.message_id, m]));
    assert.deepEqual(r.messages.map(m => m.message_id), [mid('h1'), mid('h2'), mid('h3'), mid('h4'), mid('h5'), mid('h6'), mid('h7'), mid('h8')]);
    for (const m of r.messages) { assert.match(m.created_at, IST_RE); assert.equal(m.contact_id, String(ids.hot)); }
    assert.equal(byId.get(mid('h4')).transcript, '<customer_message>fees evlo? weekend batch iruka</customer_message>');
    assert.equal(byId.get(mid('h4')).transcript_language, 'ta');
    assert.equal(byId.get(mid('h5')).interactive_reply_title, '<customer_message>Pay now</customer_message>');
    assert.equal(byId.get(mid('h3')).template_name, names.template);
    assert.equal(byId.get(mid('h3')).sender_type, 'broadcast');
    assert.equal(byId.get(mid('h3')).chat_type, 'broadcast');
    assert.equal(byId.get(mid('h6')).sender_type, 'human_agent', 'a phone-app echo is a human reply');
    assert.equal(byId.get(mid('h6')).chat_type, 'lead_rep');
    assert.equal(byId.get(mid('h7')).chat_type, 'lead_rep', 'an inbound after a human reply belongs to the rep conversation');
    assert.equal(byId.get(mid('h2')).sender_type, 'unattributed');
    assert.equal(byId.get(mid('h3')).is_within_24h_window, false, 'the template went out 3 days after the last inbound');
    assert.equal(byId.get(mid('h6')).is_within_24h_window, true);
    assert.equal(byId.get(mid('h1')).rep_user_id, String(ids.repA), 'five days ago number A belonged to Rep A');
    assert.equal(byId.get(mid('h6')).rep_user_id, String(ids.repB), 'Rep B took number A over 48 hours ago');
  });

  test('ad referral and first message are attached', async (t) => {
    if (skip(t)) return;
    const p = await reg.runTool(await ctxFor(), 'get_lead_profile', { contact_id: String(ids.hot) });
    assert.equal(p.ad_referral.ad_id, names.ad);
    assert.equal(p.ad_referral.first_message_id, mid('h1'));
    assert.equal(p.stage_history.length, 3);
    assert.equal(p.threads[0].window_open, true);
  });
});

describe('metrics, sales, ads', () => {
  test('engagement metrics count voice notes and unanswered messages', async (t) => {
    if (skip(t)) return;
    const r = await reg.runTool(await ctxFor(), 'get_engagement_metrics', { contact_ids: [String(ids.hot), String(ids.optedOut)] });
    assert.deepEqual(r.out_of_scope, [String(ids.optedOut)]);
    const m = r.metrics[0];
    assert.equal(m.inbound_count, 5);
    assert.equal(m.voice_notes_count, 1);
    assert.equal(m.interactive_replies_count, 1);
    assert.equal(m.unanswered_inbound_count, 2, 'two customer messages after the last reply');
    assert.equal(m.templates_sent, 1);
    assert.equal(m.template_read_rate, 100);
    assert.equal(m.human_replies_attributed, 1);
  });

  test('sales dedupe the double Razorpay row and derive payment types', async (t) => {
    if (skip(t)) return;
    const r = await reg.runTool(await ctxFor(), 'get_sales', { limit: 200 });
    const mine = r.payments.filter(p => p.contact_id === String(ids.enrolled));
    assert.equal(mine.length, 2, 'one gateway payment (written twice) + one manual');
    assert.deepEqual(mine.map(p => p.payment_type).sort(), ['new_admission', 'partial']);
    assert.ok(mine.every(p => p.gst === null && p.closed_by_rep_id === null));
    assert.equal((await reg.runTool(await ctxFor(), 'get_sales', { rep_id: '1' })).error, 'not_recorded');
    const b = await reg.runTool(await ctxFor(), 'get_outstanding_balances', { limit: 200 });
    const owed = b.balances.find(x => x.contact_id === String(ids.enrolled));
    assert.equal(owed.outstanding.rupees, 2000);
    assert.equal(owed.outstanding.display, '₹2,000');
  });

  test('ad performance adds GST and attributes in-scope leads', async (t) => {
    if (skip(t)) return;
    const r = await reg.runTool(await ctxFor(), 'get_ad_performance', { ad_ids: [names.ad] });
    assert.equal(r.ads.length, 1);
    assert.equal(r.ads[0].spend, 100);
    assert.equal(r.ads[0].spend_incl_gst, 118);
    assert.equal(r.ads[0].leads_attributed, 1);
    assert.equal(r.ads[0].cost_per_attributed_lead_incl_gst, 118);
  });
});

describe('write tools never change anything', () => {
  test('a test run simulates; a live run files ONE pending action and dedupes', async (t) => {
    if (skip(t)) return;
    const input = { contact_id: String(ids.hot), tag: 'hot_signal', reason: 'Asked fees and EMI today (wftest.h7, wftest.h8)' };
    const dry = await reg.runTool(await ctxFor({}, { dryRun: true }), 'tag_contact', input);
    assert.equal(dry.status, 'simulated');
    const { rows: [run] } = await pool.query(`INSERT INTO coexistence.workflow_agent_runs (agent_id, trigger_type) VALUES ($1, 'manual') RETURNING id`, [ids.agent]);
    const live = await ctxFor({}, { dryRun: false, runId: run.id });
    const first = await reg.runTool(live, 'tag_contact', input);
    assert.equal(first.status, 'pending_approval');
    const second = await reg.runTool(live, 'tag_contact', input);
    assert.equal(second.status, 'already_proposed');
    const { rows } = await pool.query(`SELECT status, action_type, payload FROM coexistence.workflow_agent_actions WHERE run_id = $1`, [run.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].action_type, 'tag_contact');
    const { rows: contact } = await pool.query(`SELECT tags FROM coexistence.contacts WHERE contact_number = $1`, [L.hot]);
    // Other test files' sweeps may add funnel-stage tags to this contact; what matters is
    // that the PROPOSED tag is not applied.
    assert.ok(!(contact[0].tags || []).some(tg => tg.name === 'hot_signal'), 'the tag is NOT applied by the tool');
  });

  test('send_whatsapp_message refuses free text outside the window and checks template variables', async (t) => {
    if (skip(t)) return;
    const { rows: [run] } = await pool.query(`INSERT INTO coexistence.workflow_agent_runs (agent_id, trigger_type) VALUES ($1, 'manual') RETURNING id`, [ids.agent]);
    const ctx = await ctxFor({}, { dryRun: false, runId: run.id });
    // The enrolled lead last wrote 4 days ago: window closed.
    const closed = await reg.runTool(ctx, 'send_whatsapp_message', { contact_id: String(ids.enrolled), text: 'hello', reason: 'x' });
    assert.equal(closed.error, 'outside_24h_window');
    assert.ok(closed.templates.some(tp => tp.name === names.template));
    assert.equal((await reg.runTool(ctx, 'send_whatsapp_message', { contact_id: String(ids.enrolled), template_name: names.template, variables: [], reason: 'x' })).error, 'invalid_input');
    assert.equal((await reg.runTool(ctx, 'send_whatsapp_message', { contact_id: String(ids.enrolled), template_name: names.template, variables: ['Enrolled'], reason: 'x' })).status, 'pending_approval');
    const templatesOnly = reg.normalizeToolConfig([{ tool_key: 'send_whatsapp_message', enabled: true, params_override: { templates_only: true } }]);
    const ctx2 = { ...ctx, toolConfig: templatesOnly };
    assert.equal((await reg.runTool(ctx2, 'send_whatsapp_message', { contact_id: String(ids.hot), text: 'hi', reason: 'x' })).error, 'not_allowed');
  });

  test('draft reply reports the window and suggests templates when it is closed', async (t) => {
    if (skip(t)) return;
    const ctx = await ctxFor();
    const open = await reg.runTool(ctx, 'draft_whatsapp_reply', { contact_id: String(ids.hot), message: 'Yes, EMI is available. Shall I share the link?' });
    assert.equal(open.window_open, true);
    assert.equal(open.free_text_allowed, true);
    const closed = await reg.runTool(ctx, 'draft_whatsapp_reply', { contact_id: String(ids.enrolled), message: 'Reminder about your balance' });
    assert.equal(closed.window_open, false);
    assert.ok(closed.suggested_templates.length >= 1);
  });
});
