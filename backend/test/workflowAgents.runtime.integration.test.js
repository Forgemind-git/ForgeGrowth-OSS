// Workflow Agents — runtime against real Postgres with a SCRIPTED model.
//
// The model is replaced by a script of responses, so every path (tool loop, parallel
// tool calls, validation retries, evidence checks, budgets, cancellation, dry runs)
// is exercised deterministically and without spending anything. The request the
// runtime builds is captured and asserted too: guardrails, memory, workspace
// context, caching breakpoints, sorted tools.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const queuePath = require.resolve('../src/queue/sendQueue');
require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true, exports: { enqueueSend: async () => ({}), startSendWorker() {}, shutdownSendQueue: async () => {} } };

const pool = require('../src/db');
const { ensureWorkflowAgentTables } = require('../src/services/workflowAgents/schema');
const service = require('../src/services/workflowAgents/service');
const runtime = require('../src/services/workflowAgents/runtime');
const world = require('./fixtures/workflowAgentsWorld').makeWorld(2);

const { ids, mid } = world;
const LIVE_REFUSED = process.env.DB_NAME === 'forgegrowth' && process.env.WORKFLOW_AGENT_TESTS_ALLOW_LIVE !== '1';
let dbUp = false;
let agentId;

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 };
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop = 'tool_use') => ({ model: 'claude-opus-5', stop_reason: stop, content, usage: USAGE });
const final = (obj) => reply([{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], 'end_turn');

function scripted(steps) {
  const calls = [];
  const fn = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`script exhausted at call ${calls.length}`);
    return typeof step === 'function' ? step(params, calls.length) : step;
  };
  fn.calls = calls;
  return fn;
}

function leadSignalOutput({ quote = 'fees evlo? naalaiku join panlama', messageId } = {}) {
  return {
    run_date: '2026-09-17',
    reps: [{
      rep_id: String(ids.repB), rep_name: 'Rep B',
      leads: [{
        contact_id: String(ids.hot), name_masked: 'Priya S.', stage: 'hot', score: 86, label: 'hot',
        reason: 'Asked about fees and joining tomorrow, then asked for EMI.',
        top_signal: 'Asked fees and when to join', blocker: 'price',
        evidence: [{ message_id: messageId || mid('h7'), quote, at: '2026-09-17T09:00:00+05:30', type: 'text' }],
        best_contact_time: 'Evenings', window_open: true,
        suggested_message: 'Hi Priya! Yes, EMI is available. Shall I share the payment link?', suggested_template: null, unanswered_minutes: 30,
      }],
    }],
    team_summary: { hot: 1, warm: 0, watch: 0, slipping: 0, top_reasons_not_buying: [{ reason: 'price', count: 1, example_quote: 'Is EMI available?' }], reps_with_unanswered_hot_leads: ['Rep B'] },
    data_gaps: [],
  };
}

before(async () => {
  if (LIVE_REFUSED) return;
  try { await pool.query('SELECT 1'); dbUp = true; } catch { return; }
  await ensureWorkflowAgentTables();
  await world.seed(pool);
  const created = await service.createAgent({ presetKey: 'lead_signal', name: `${world.names.agentSlug}-lead-signal`, userId: ids.repA });
  agentId = created.agent.id;
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

async function runWith(script, createArgs = {}) {
  const run = await runtime.createRun({ agentId, triggerType: 'manual', requestedBy: ids.repA, ...createArgs });
  const done = await runtime.executeRun(run.id, { callModel: script });
  const { rows: steps } = await pool.query(`SELECT step, type, tool_key, output FROM coexistence.workflow_agent_run_steps WHERE run_id = $1 ORDER BY step`, [run.id]);
  const { rows: [row] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_runs WHERE id = $1`, [run.id]);
  return { run: row, done, steps };
}

describe('preset', () => {
  test('creating from the Lead Signal preset copies config, memory and a first version', async (t) => {
    if (skip(t)) return;
    const a = await service.getAgent(agentId);
    assert.equal(a.agent.status, 'draft');
    assert.equal(a.agent.preset_key, 'lead_signal');
    assert.equal(a.version.version, 1);
    const on = a.version.tool_config.filter(x => x.enabled).map(x => x.tool_key).sort();
    assert.ok(on.includes('get_engagement_metrics') && on.includes('tag_contact'));
    assert.ok(!on.includes('send_whatsapp_message') && !on.includes('set_funnel_stage') && !on.includes('assign_owner'));
    assert.equal(a.version.data_scope.won_stages, 'exclude_unless_outstanding');
    const mem = await service.listMemory(agentId);
    assert.equal(mem.items.filter(m => m.kind === 'pinned').length, 5);
  });
});

describe('live run', () => {
  test('tool loop, parallel calls, validation, evidence, trace, cost and a pending action', async (t) => {
    if (skip(t)) return;
    const script = scripted([
      reply([toolUse('t1', 'get_workspace_context', {}), toolUse('t2', 'get_conversation', { contact_id: String(ids.hot) })]),
      reply([toolUse('t3', 'draft_whatsapp_reply', { contact_id: String(ids.hot), message: 'Hi Priya! Yes, EMI is available.' }), toolUse('t4', 'tag_contact', { contact_id: String(ids.hot), tag: 'hot_signal', reason: 'Asked fees and EMI' })]),
      final(leadSignalOutput()),
    ]);
    const { run, steps } = await runWith(script);
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.output_valid, true);
    assert.deepEqual({ total: run.checks.total, verified: run.checks.verified }, { total: 1, verified: 1 });
    assert.equal(run.tool_calls, 4);
    assert.equal(run.input_tokens, 3000);
    assert.equal(run.cache_read_tokens, 1500);
    assert.ok(Number(run.cost_inr) > 0);
    assert.ok(run.output_markdown.includes('Priya S.'));
    assert.ok(run.cursor.last_chat_history_id);

    // The request the runtime built.
    const first = script.calls[0];
    assert.equal(first.model, 'claude-opus-5');
    assert.equal(first.fallbacks, 'default');
    assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(first.temperature, undefined, 'Opus 5 rejects sampling parameters');
    assert.deepEqual(first.output_config, { effort: 'high' });
    assert.ok(first.system[0].text.startsWith('You are a workflow agent inside Forge Growth for '));
    assert.ok(first.system[0].text.includes('# Goal'), 'agent instructions follow the guardrails');
    assert.ok(first.system[1].text.includes('Voice notes signal intent'), 'pinned memory is in context');
    assert.ok(first.system[2].text.startsWith('# Workspace context'));
    assert.deepEqual(first.system[2].cache_control, { type: 'ephemeral' });
    const names = first.tools.map(x => x.name);
    assert.deepEqual(names, [...names].sort(), 'tools are sorted for a stable cache prefix');
    assert.ok(!names.includes('send_whatsapp_message'));
    // Parallel tool results come back in ONE user message, in call order.
    const second = script.calls[1];
    const results = second.messages[second.messages.length - 1];
    assert.equal(results.role, 'user');
    assert.deepEqual(results.content.map(c => c.tool_use_id), ['t1', 't2']);
    assert.ok(JSON.parse(results.content[1].content).messages.some(m => m.message_id === mid('h7')));

    const types = steps.map(s => s.type);
    assert.equal(types.filter(x => x === 'model').length, 3);
    assert.equal(types.filter(x => x === 'tool_call').length, 4);
    assert.equal(types.filter(x => x === 'tool_result').length, 4);
    assert.ok(types.includes('action_proposal'));
    assert.equal(types[types.length - 1], 'validation');

    const { rows: actions } = await pool.query(`SELECT action_type, status, lead_id FROM coexistence.workflow_agent_actions WHERE run_id = $1`, [run.id]);
    assert.deepEqual(actions.map(a => [a.action_type, a.status, String(a.lead_id)]), [['tag_contact', 'pending', String(ids.hot)]]);
  });

  test('a trigger key fires at most once', async (t) => {
    if (skip(t)) return;
    await service.updateAgent(agentId, { status: 'active' }, ids.repA);
    const key = `schedule:0:${Date.now()}`;
    const a = await runtime.createRun({ agentId, triggerType: 'schedule', triggerKey: key });
    const b = await runtime.createRun({ agentId, triggerType: 'schedule', triggerKey: key });
    assert.ok(a);
    assert.equal(b, null);
    await pool.query(`UPDATE coexistence.workflow_agent_runs SET status = 'cancelled' WHERE id = $1`, [a.id]);
    await service.updateAgent(agentId, { status: 'draft' }, ids.repA);
  });
});

describe('test runs', () => {
  test('a dry run uses unsaved instructions, pretends a date and files nothing', async (t) => {
    if (skip(t)) return;
    const saved = await service.getAgent(agentId);
    const override = { ...saved.version, instructions: 'UNSAVED TEST INSTRUCTIONS: find hot leads.' };
    const script = scripted([
      reply([toolUse('t1', 'tag_contact', { contact_id: String(ids.hot), tag: 'hot_signal', reason: 'test' })]),
      final(leadSignalOutput()),
    ]);
    const { rows: [{ n: before }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.workflow_agent_actions WHERE agent_id = $1`, [agentId]);
    const yesterday = new Date(Date.now() + 5.5 * 36e5 - 864e5).toISOString().slice(0, 10);
    const { run, steps } = await runWith(script, { dryRun: true, configOverride: override, pretendDate: yesterday });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.trigger_type, 'test');
    assert.ok(script.calls[0].system[0].text.includes('UNSAVED TEST INSTRUCTIONS'));
    assert.ok(script.calls[0].messages[0].content[0].text.includes('TEST RUN'));
    const proposal = steps.find(s => s.type === 'action_proposal');
    assert.equal(proposal.output.status, 'simulated');
    const { rows: [{ n: afterCount }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.workflow_agent_actions WHERE agent_id = $1`, [agentId]);
    assert.equal(afterCount, before);
    assert.equal((await service.getAgent(agentId)).version.instructions, saved.version.instructions, 'the saved agent is untouched');
    await assert.rejects(runtime.createRun({ agentId, triggerType: 'manual', pretendDate: '2999-01-01', dryRun: true }), /future/);
  });
});

describe('validation and evidence', () => {
  test('an invalid answer is sent back and the corrected one succeeds', async (t) => {
    if (skip(t)) return;
    const script = scripted([final('here you go: not json'), final({ run_date: 'x' }), final(leadSignalOutput())]);
    const { run, steps } = await runWith(script);
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(steps.filter(s => s.type === 'validation').length, 3);
    const feedback = script.calls[2].messages[script.calls[2].messages.length - 1].content[0].text;
    assert.ok(feedback.includes('missing required property "reps"'));
  });

  test('a quote not in its message is refused twice, then stripped and reported', async (t) => {
    if (skip(t)) return;
    const bad = leadSignalOutput({ quote: 'I will pay today for sure' });
    const script = scripted([final(bad), final(bad), final(bad)]);
    const { run } = await runWith(script);
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.output.reps[0].leads[0].evidence.length, 0);
    assert.ok(run.output.data_gaps.some(g => g.includes('could not be matched')));
    assert.equal(run.checks.removed, 1);
    assert.ok(script.calls[1].messages.at(-1).content[0].text.includes('quote not in message'));
  });

  test('a quote citing another lead\'s message is caught', async (t) => {
    if (skip(t)) return;
    const wrong = leadSignalOutput({ messageId: mid('b1'), quote: 'fees for the weekend batch?' });
    const script = scripted([final(wrong), final(leadSignalOutput())]);
    const { run } = await runWith(script);
    assert.equal(run.status, 'succeeded');
    assert.ok(script.calls[1].messages.at(-1).content[0].text.includes('belongs to another lead'));
  });

  test('a schema that still fails after two retries fails the run and tells admins', async (t) => {
    if (skip(t)) return;
    const script = scripted([final({}), final({}), final({})]);
    const { run } = await runWith(script);
    assert.equal(run.status, 'failed');
    assert.equal(run.output_valid, false);
    assert.ok(run.validation_errors.length > 0);
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.workflow_agent_notifications WHERE agent_id = $1 AND title LIKE 'Workflow agent failed%'`, [agentId]);
    assert.ok(rows.length >= 1, 'an active admin was notified');
  });
});

describe('budgets and control', () => {
  test('the tool-call budget stops tools and asks for a final answer', async (t) => {
    if (skip(t)) return;
    await service.updateAgent(agentId, { max_tool_calls: 1 }, ids.repA);
    try {
      const script = scripted([
        reply([toolUse('t1', 'get_workspace_context', {}), toolUse('t2', 'read_memory', {})]),
        final(leadSignalOutput()),
      ]);
      const { run } = await runWith(script);
      assert.equal(run.status, 'budget_stopped');
      assert.equal(run.tool_calls, 0, 'no tool ran once the budget was exceeded');
      assert.ok(run.output, 'the partial output is saved');
      assert.deepEqual(script.calls[1].tool_choice, { type: 'none' });
      assert.ok(script.calls[1].messages.at(-1).content[0].content.includes('tool_budget_reached'));
    } finally {
      await service.updateAgent(agentId, { max_tool_calls: 120 }, ids.repA);
    }
  });

  test('a spent monthly budget stops the run before any model call', async (t) => {
    if (skip(t)) return;
    await service.updateAgent(agentId, { monthly_budget_inr: 50 }, ids.repA);
    try {
      await pool.query(`INSERT INTO coexistence.workflow_agent_runs (agent_id, trigger_type, status, cost_inr) VALUES ($1, 'manual', 'succeeded', 60)`, [agentId]);
      const script = scripted([]);
      const { run } = await runWith(script);
      assert.equal(run.status, 'budget_stopped');
      assert.match(run.error, /Monthly budget/);
      assert.equal(script.calls.length, 0);
    } finally {
      await pool.query(`DELETE FROM coexistence.workflow_agent_runs WHERE agent_id = $1 AND cost_inr = 60`, [agentId]);
      await service.updateAgent(agentId, { monthly_budget_inr: null }, ids.repA);
    }
  });

  test('cancelling a running run stops it at the next step', async (t) => {
    if (skip(t)) return;
    let runIdSeen;
    const script = scripted([
      async () => { await service.cancelRun(runIdSeen, ids.repA); return reply([toolUse('t1', 'get_workspace_context', {})]); },
      final(leadSignalOutput()),
    ]);
    const run = await runtime.createRun({ agentId, triggerType: 'manual' });
    runIdSeen = run.id;
    await runtime.executeRun(run.id, { callModel: script });
    const { rows: [row] } = await pool.query(`SELECT status FROM coexistence.workflow_agent_runs WHERE id = $1`, [run.id]);
    assert.equal(row.status, 'cancelled');
    assert.equal(script.calls.length, 1);
  });

  test('without an Anthropic key the run fails with a sentence that says where to add one', async (t) => {
    if (skip(t)) return;
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.ai_models WHERE provider = 'anthropic'`);
    if (rows.length || process.env.ANTHROPIC_API_KEY) return t.skip('an Anthropic key exists here');
    const run = await runtime.createRun({ agentId, triggerType: 'manual' });
    await runtime.executeRun(run.id);
    const { rows: [row] } = await pool.query(`SELECT status, error FROM coexistence.workflow_agent_runs WHERE id = $1`, [run.id]);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /Admin Settings → AI Models/);
  });
});

describe('versions', () => {
  test('saving creates an immutable new version; unchanged saves do not; restore copies forward', async (t) => {
    if (skip(t)) return;
    const a = await service.getAgent(agentId);
    const same = await service.saveVersion(agentId, a.version, 'no change', ids.repA);
    assert.equal(same.unchanged, true);
    const v2 = await service.saveVersion(agentId, { ...a.version, instructions: `${a.version.instructions}\n- Extra rule.` }, 'Add a rule', ids.repA);
    assert.equal(v2.version.version, 2);
    await assert.rejects(pool.query(`UPDATE coexistence.workflow_agent_versions SET instructions = 'x' WHERE id = $1`, [v2.version.id]), /immutable/);
    const restored = await service.restoreVersion(agentId, a.version.id, ids.repA);
    assert.equal(restored.version.version, 3);
    assert.equal(restored.version.instructions, a.version.instructions);
    await assert.rejects(service.saveVersion(agentId, { ...a.version, output_schema: '{not json' }, 'bad', ids.repA), /not valid JSON/);
  });
});
