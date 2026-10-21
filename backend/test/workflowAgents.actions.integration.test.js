// Workflow Agents — approvals, execution, worklist, feedback, destinations and team
// setup against real Postgres. The send queue is stubbed; the webhook destination
// posts to a real local HTTP server.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const queuePath = require.resolve('../src/queue/sendQueue');
require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true, exports: { enqueueSend: async () => ({}), startSendWorker() {}, shutdownSendQueue: async () => {} } };

const pool = require('../src/db');
const { ensureWorkflowAgentTables } = require('../src/services/workflowAgents/schema');
const service = require('../src/services/workflowAgents/service');
const actions = require('../src/services/workflowAgents/actions');
const worklist = require('../src/services/workflowAgents/worklist');
const destinations = require('../src/services/workflowAgents/destinations');
const team = require('../src/services/workflowAgents/team');
const world = require('./fixtures/workflowAgentsWorld').makeWorld(4);

const { ids, L, mid } = world;
const LIVE_REFUSED = process.env.DB_NAME === 'forgegrowth' && process.env.WORKFLOW_AGENT_TESTS_ALLOW_LIVE !== '1';
let dbUp = false;
let agentId;
let runId;
const admin = { id: 1, role: 'admin' };
const repA = () => ({ id: ids.repA, role: 'sales' });
const repB = () => ({ id: ids.repB, role: 'sales' });

async function propose(actionType, leadId, payload, extra = {}) {
  // Other test files run bulk updates on the same database in parallel; retry a deadlock.
  const { rows: [a] } = await actions.withDeadlockRetry(() => pool.query(
    `INSERT INTO coexistence.workflow_agent_actions (run_id, agent_id, action_type, lead_id, payload, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5,'test', COALESCE($6, NOW() + INTERVAL '1 day')) RETURNING id`,
    [runId, agentId, actionType, leadId, JSON.stringify(payload), extra.expiresAt || null]));
  return String(a.id);
}
const actionRow = async (id) => (await pool.query(`SELECT * FROM coexistence.workflow_agent_actions WHERE id = $1`, [id])).rows[0];

before(async () => {
  if (LIVE_REFUSED) return;
  try { await pool.query('SELECT 1'); dbUp = true; } catch { return; }
  await ensureWorkflowAgentTables();
  await world.seed(pool);
  // Make sure an active admin exists for admin-only paths (a schema-only clone may have none).
  await pool.query(`INSERT INTO coexistence.forgecrm_users (id, username, email, password, display_name, role, is_active) VALUES (1,'admin','admin@example.test','x','Admin','admin',TRUE) ON CONFLICT (id) DO NOTHING`);
  const created = await service.createAgent({ presetKey: 'lead_signal', name: `${world.names.agentSlug}-actions`, userId: 1 });
  agentId = created.agent.id;
  const { rows: [r] } = await pool.query(
    `INSERT INTO coexistence.workflow_agent_runs (agent_id, agent_version_id, trigger_type, status, finished_at, config_snapshot, output)
     VALUES ($1,$2,'schedule','succeeded',NOW(),$3,$4) RETURNING id`,
    [agentId, created.version.id, JSON.stringify({ destinations: [] }), JSON.stringify({
      run_date: '2026-09-17',
      reps: [{ rep_id: 'unassigned', rep_name: 'Whoever', leads: [
        { contact_id: String(ids.hot), name_masked: 'Priya S.', stage: 'hot', score: 88, label: 'hot', reason: 'Asked fees and EMI', evidence: [{ message_id: mid('h7'), quote: 'fees evlo?', at: 'x' }], suggested_message: 'Yes, EMI is available.' },
        { contact_id: String(ids.enrolled), name_masked: 'Enrolled P.', stage: 'enrolled', score: 50, label: 'watch', reason: 'Balance due', evidence: [], suggested_message: 'Reminder' },
      ] }],
      team_summary: { hot: 1, warm: 0, watch: 1, slipping: 0 }, data_gaps: [],
    })]);
  runId = String(r.id);
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

describe('approve executes exactly once; reject never executes', () => {
  test('tag_contact: two simultaneous approvals run the executor once', async (t) => {
    if (skip(t)) return;
    const id = await propose('tag_contact', ids.hot, { tag: `${world.names.agentSlug} hot_signal` });
    const [a, b] = await Promise.all([actions.decide(admin, [id], 'approve'), actions.decide(admin, [id], 'approve')]);
    const outcomes = [...a.outcomes, ...b.outcomes];
    assert.equal(outcomes.filter(o => o.ok && o.status === 'executed').length, 1);
    assert.equal(outcomes.filter(o => !o.ok).length, 1);
    const row = await actionRow(id);
    assert.equal(row.status, 'executed');
    const { rows } = await pool.query(`SELECT tags FROM coexistence.contacts WHERE contact_number = $1`, [L.hot]);
    const matching = rows[0].tags.filter(tg => tg.name === `${world.names.agentSlug} hot_signal`);
    assert.equal(matching.length, 1, 'tag applied once');
    // Approving the same tag again from a new action does not duplicate it.
    const id2 = await propose('tag_contact', ids.hot, { tag: `${world.names.agentSlug} hot_signal` });
    await actions.decide(admin, [id2], 'approve');
    const { rows: again } = await pool.query(`SELECT tags FROM coexistence.contacts WHERE contact_number = $1`, [L.hot]);
    assert.equal(again[0].tags.filter(tg => tg.name === `${world.names.agentSlug} hot_signal`).length, 1);
    await pool.query(`DELETE FROM coexistence.tags WHERE lower(name) = lower($1)`, [`${world.names.agentSlug} hot_signal`]);
  });

  test('a rejected action never executes and cannot be approved later', async (t) => {
    if (skip(t)) return;
    const id = await propose('add_note', ids.hot, { note: 'should never exist' });
    await actions.decide(admin, [id], 'reject');
    const late = await actions.decide(admin, [id], 'approve');
    assert.equal(late.outcomes[0].ok, false);
    assert.equal((await actionRow(id)).status, 'rejected');
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.lead_notes WHERE body = 'should never exist'`);
    assert.equal(rows.length, 0);
  });

  test('an expired action cannot be approved', async (t) => {
    if (skip(t)) return;
    const id = await propose('add_note', ids.hot, { note: 'expired' }, { expiresAt: new Date(Date.now() - 60000) });
    const out = await actions.decide(admin, [id], 'approve');
    assert.equal(out.outcomes[0].ok, false);
    assert.match(out.outcomes[0].error, /expired/);
  });

  test('set_stage moves the lead and writes the audit event downstream dispatchers read', async (t) => {
    if (skip(t)) return;
    const id = await propose('set_stage', ids.onB, { from: 'hot', to: 'engaged' });
    const out = await actions.decide(admin, [id], 'approve');
    assert.equal(out.outcomes[0].status, 'executed');
    const { rows: [l] } = await pool.query(`SELECT stage FROM coexistence.leads WHERE id = $1`, [ids.onB]);
    assert.equal(l.stage, 'engaged');
    const { rows: [e] } = await pool.query(`SELECT from_value, to_value, actor FROM coexistence.lead_events WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`, [ids.onB]);
    assert.deepEqual([e.from_value, e.to_value], ['hot', 'engaged']);
    assert.match(e.actor, /^workflow-agent:/);
  });

  test('note, task (with an edited title) and notification are created by their executors', async (t) => {
    if (skip(t)) return;
    const note = await propose('add_note', ids.hot, { note: 'Asked about EMI twice' });
    const task = await propose('create_task', ids.hot, { title: 'Call', due_at: new Date(Date.now() + 36e5).toISOString(), assignee_rep_id: String(ids.repB) });
    const notify = await propose('notify_rep', ids.hot, { rep_user_id: String(ids.repB), message: 'Priya is hot' });
    await actions.decide(admin, [note], 'approve');
    await actions.decide(admin, [task], 'approve', { edits: { title: 'Call about EMI before 6pm' } });
    await actions.decide(admin, [notify], 'approve');
    assert.equal((await pool.query(`SELECT 1 FROM coexistence.lead_notes WHERE lead_id = $1 AND body = 'Asked about EMI twice' AND source = 'agent'`, [ids.hot])).rows.length, 1);
    const { rows: tasks } = await pool.query(`SELECT title, assignee_user_id FROM coexistence.workflow_agent_tasks WHERE action_id = $1`, [task]);
    assert.equal(tasks[0].title, 'Call about EMI before 6pm');
    assert.equal(String(tasks[0].assignee_user_id), String(ids.repB));
    assert.equal((await worklist.myNotifications(repB())).some(n => n.body === 'Priya is hot'), true);
    await assert.rejects(Promise.resolve().then(() => actions.applyEdits({ action_type: 'set_stage', payload: {} }, { to: 'won' })), /cannot be edited/);
  });

  test('a send that cannot go out is recorded as failed with the reason, never as executed', async (t) => {
    if (skip(t)) return;
    const id = await propose('send_whatsapp', ids.hot, { kind: 'text', text: 'Hello' });
    const out = await actions.decide(admin, [id], 'approve');
    const row = await actionRow(id);
    assert.equal(row.status, 'failed');
    assert.equal(out.outcomes[0].ok, false);
    assert.ok(row.result.error);
  });
});

describe('who may decide', () => {
  test('reps cannot decide; a team lead can for their team when the rules allow it', async (t) => {
    if (skip(t)) return;
    const id = await propose('add_note', ids.hot, { note: 'team lead test' });
    // Priya is owned by Rep B (number A moved to B). Rep A is not an approver.
    assert.equal((await actions.decide(repA(), [id], 'approve')).outcomes[0].error, 'You are not an approver for this action.');
    // Make Rep A the lead of a team that contains Rep B. The Lead Signal preset allows team_lead approvals.
    await team.upsertTeam({ name: `${world.names.agentSlug} team`, lead_user_id: ids.repA }, 1);
    const { rows: [tm] } = await pool.query(`SELECT id FROM coexistence.rep_teams WHERE name = $1`, [`${world.names.agentSlug} team`]);
    await team.updateRep(ids.repB, { team_id: tm.id }, 1);
    const listed = await actions.listActions(repA(), { status: 'pending' });
    assert.ok(listed.actions.some(a => a.id === id && a.can_decide));
    assert.equal((await actions.decide(repA(), [id], 'approve')).outcomes[0].status, 'executed');
    // Rep B owns the lead but the preset does not allow owner_rep approvals.
    const id2 = await propose('add_note', ids.hot, { note: 'owner test' });
    assert.equal((await actions.decide(repB(), [id2], 'approve')).outcomes[0].ok, false);
    await team.updateRep(ids.repB, { team_id: null }, 1);
  });
});

describe('rep worklist', () => {
  test('cards follow the CURRENT owner, not the model\'s grouping', async (t) => {
    if (skip(t)) return;
    const mine = await worklist.getWorklist(repB(), { agentId });
    // Priya wrote 30 minutes ago on number A, which Rep B holds now. The enrolled lead last
    // wrote 4 days ago, while Rep A still held number A: it stays Rep A's.
    assert.deepEqual(mine.cards.map(c => c.contact_id), [String(ids.hot)]);
    const card = mine.cards[0];
    assert.equal(card.label, 'hot');
    assert.equal(card.evidence[0].chat.contact_number, L.hot);
    assert.equal(card.window_open, true);
    assert.deepEqual((await worklist.getWorklist(repA(), { agentId })).cards.map(c => c.contact_id), [String(ids.enrolled)]);
    await assert.rejects(worklist.getWorklist(repA(), { agentId, repId: ids.repB }), /own worklist/);
    assert.equal((await worklist.getWorklist(admin, { agentId, repId: ids.repB })).cards.length, 1);
  });

  test('feedback maps the outcome to a rating and is limited to the lead\'s owner', async (t) => {
    if (skip(t)) return;
    const f = await worklist.recordFeedback(repB(), { run_id: runId, contact_id: ids.hot, outcome: 'called' });
    assert.equal(f.rating, 'useful');
    await assert.rejects(worklist.recordFeedback(repA(), { run_id: runId, contact_id: ids.hot, outcome: 'converted' }), /own leads/);
    await assert.rejects(worklist.recordFeedback(repB(), { run_id: runId, contact_id: ids.hot, outcome: 'maybe' }), /outcome must be/);
    const again = await worklist.getWorklist(repB(), { agentId });
    assert.equal(again.cards[0].feedback.outcome, 'called');
  });

  test('Send files an approval by default', async (t) => {
    if (skip(t)) return;
    const out = await worklist.sendSuggested(repB(), { run_id: runId, contact_id: ids.hot });
    assert.equal(out.status, 'pending');
    const row = await actionRow(out.action_id);
    assert.deepEqual(row.payload, { kind: 'text', text: 'Yes, EMI is available.' });
    assert.equal(String(row.requested_by), String(ids.repB));
  });
});

describe('destinations', () => {
  test('webhook is signed; unconfigured destinations are skipped with a reason; send_at schedules', async (t) => {
    if (skip(t)) return;
    let received = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { received = { body, sig: req.headers['x-forge-signature'] }; res.writeHead(200); res.end('ok'); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const { rows: [run] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_runs WHERE id = $1`, [runId]);
      const { rows: [agent] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [agentId]);
      const later = new Date(Date.now() + 5.5 * 36e5 + 2 * 36e5).toISOString().slice(11, 16);
      const config = {
        destinations: [
          { type: 'results_inbox' },
          { type: 'rep_worklist' },
          { type: 'webhook', url: `http://127.0.0.1:${server.address().port}/hook`, secret: 's3cret', enabled: true },
          { type: 'whatsapp_template', template: 'no_such_template', enabled: true },
          ...(later > '00:10' ? [{ type: 'whatsapp_template', template: 'no_such_template', send_at: later, enabled: true }] : []),
        ],
      };
      await destinations.deliverRun({ ...run, output_markdown: '# md' }, agent, config);
      const { rows } = await pool.query(`SELECT destination_index, type, status, error FROM coexistence.workflow_agent_deliveries WHERE run_id = $1 ORDER BY destination_index`, [runId]);
      const by = (i) => rows.find(r => r.destination_index === i);
      assert.equal(by(0).status, 'sent');
      assert.equal(by(1).status, 'sent');
      assert.equal(by(2).status, 'sent');
      const expected = crypto.createHmac('sha256', 's3cret').update(received.body).digest('hex');
      assert.equal(received.sig, `sha256=${expected}`);
      assert.equal(JSON.parse(received.body).output.run_date, '2026-09-17');
      assert.equal(by(3).status, 'skipped');
      assert.match(by(3).error, /APPROVED template/);
      if (by(4)) {
        assert.equal(by(4).status, 'scheduled');
        await pool.query(`UPDATE coexistence.workflow_agent_runs SET config_snapshot = $2 WHERE id = $1`, [runId, JSON.stringify(config)]);
        assert.ok(await destinations.sendDueDeliveries(new Date(Date.now() + 26 * 36e5)) >= 1);
        const { rows: [d4] } = await pool.query(`SELECT status FROM coexistence.workflow_agent_deliveries WHERE run_id = $1 AND destination_index = 4`, [runId]);
        assert.equal(d4.status, 'skipped', 'processed when due; skipped because the template does not exist');
      }
    } finally {
      server.close();
    }
  });
});

describe('guided creation', () => {
  test('setup answers land in version 1; the rest of the preset is kept', async (t) => {
    if (skip(t)) return;
    const preset = await service.getPreset('lead_signal');
    assert.ok(preset.memory.some(m => m.title === 'Products and pricing'), 'the preset exposes its memory for the wizard');
    const out = await service.createAgent({
      presetKey: 'lead_signal', name: `${world.names.agentSlug}-setup`, userId: 1,
      setup: {
        triggers: [{ type: 'schedule', cron: '30 9 * * 1-6', enabled: true }, { type: 'manual', enabled: true }],
        destinations: [{ type: 'results_inbox' }, { type: 'rep_worklist' }, { type: 'email', to: ['owner@example.test'] }],
        data_scope: { lookback_days: 7 },
        memory: [{ title: 'Products and pricing', content: 'Course A (₹5,499)' }, { title: 'Not in the preset', content: 'ignored' }],
        monthly_budget_inr: 500,
      },
    });
    assert.equal(out.agent.status, 'draft');
    assert.equal(out.agent.monthly_budget_inr, 500);
    assert.deepEqual(out.version.triggers.map(x => x.cron || x.type), ['30 9 * * 1-6', 'manual']);
    assert.deepEqual(out.version.destinations.map(d => d.type), ['results_inbox', 'rep_worklist', 'email']);
    assert.equal(out.version.data_scope.lookback_days, 7);
    assert.equal(out.version.data_scope.won_stages, 'exclude_unless_outstanding', 'scope keys not answered keep the preset value');
    assert.ok(out.version.instructions.includes('# Goal'), 'instructions stay the preset');
    const mem = await service.listMemory(out.agent.id);
    assert.equal(mem.items.length, 5, 'no memory item is added by an unknown title');
    assert.equal(mem.items.find(m => m.title === 'Products and pricing').content, 'Course A (₹5,499)');
  });

  test('a blank agent takes the description as instructions and the chosen read tools', async (t) => {
    if (skip(t)) return;
    const out = await service.createAgent({
      name: `${world.names.agentSlug}-blank`, userId: 1,
      setup: { instructions: '# Goal\nList leads who asked about EMI this week.', enable_tools: ['list_leads', 'search_messages'] },
    });
    assert.ok(out.version.instructions.includes('asked about EMI'));
    const on = out.version.tool_config.filter(x => x.enabled).map(x => x.tool_key).sort();
    assert.deepEqual(on, ['get_workspace_context', 'list_leads', 'read_memory', 'search_messages']);
  });

  test('an invalid answer is refused and creates nothing', async (t) => {
    if (skip(t)) return;
    const name = `${world.names.agentSlug}-bad`;
    await assert.rejects(service.createAgent({ presetKey: 'lead_signal', name, userId: 1, setup: { triggers: [{ type: 'schedule', cron: '99 99 * * *' }] } }), /out of range/);
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.workflow_agents WHERE name = $1`, [name]);
    assert.equal(rows.length, 0);
  });
});

describe('whatsapp digest destination', () => {
  test('goes team-wide to fixed numbers, reporting each number, and is refused without numbers', async (t) => {
    if (skip(t)) return;
    const mcp = require('../src/services/mcpService');
    const original = mcp.sendTemplateMessage;
    const sent = [];
    mcp.sendTemplateMessage = async (args) => {
      sent.push(args);
      if (String(args.toNumber).endsWith('000')) throw new Error('Meta refused this number');
      return { ok: true };
    };
    try {
      const { rows: [run] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_runs WHERE id = $1`, [runId]);
      const { rows: [agent] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [agentId]);
      const dest = { type: 'whatsapp_template', to: 'numbers', numbers: ['919876500111', '919876500000'], template: world.names.template, enabled: true };
      await destinations.deliverOne(run, agent, dest, 7);
      const { rows: [d7] } = await pool.query(`SELECT status, detail, error FROM coexistence.workflow_agent_deliveries WHERE run_id = $1 AND destination_index = 7`, [runId]);
      assert.equal(d7.status, 'sent', 'one number worked, so the delivery counts as sent');
      assert.equal(sent.length, 2);
      // The fixture template has one variable, so only the first token (rep_name) is filled.
      assert.deepEqual(sent[0].variables, ['Team']);
      assert.equal(String(sent[0].templateId), String(ids.tpl));
      assert.deepEqual(d7.detail.per_number.map(p => p.status), ['sent', 'failed']);
      assert.equal(d7.detail.per_number[1].to, '91xxxxxxx000', 'numbers are masked in the delivery log');
      assert.match(d7.detail.per_number[1].reason, /Meta refused/);

      await destinations.deliverOne(run, agent, { ...dest, numbers: [] }, 8);
      const { rows: [d8] } = await pool.query(`SELECT status, error FROM coexistence.workflow_agent_deliveries WHERE run_id = $1 AND destination_index = 8`, [runId]);
      assert.equal(d8.status, 'skipped');
      assert.match(d8.error, /No numbers/);

      const { normalizeDestinations } = require('../src/services/workflowAgents/config');
      const { destinations: norm, errors } = normalizeDestinations([{ type: 'whatsapp_template', to: 'numbers', numbers: ['12'], template: 'x', requires_approval: true }]);
      assert.match(errors.join(' '), /country code/);
      assert.equal('requires_approval' in norm[1], false, 'an option nothing honours is not stored');
    } finally {
      mcp.sendTemplateMessage = original;
    }
  });
});

describe('team setup', () => {
  test('reassigning a number closes the old period and keeps history', async (t) => {
    if (skip(t)) return;
    await team.assignNumber(ids.accB, ids.repA, 1);
    await team.assignNumber(ids.accB, ids.repB, 1);
    await team.assignNumber(ids.accB, ids.repB, 1); // no-op
    const { rows } = await pool.query(`SELECT user_id, valid_to FROM coexistence.rep_number_assignments WHERE whatsapp_account_id = $1 ORDER BY valid_from`, [ids.accB]);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].valid_to);
    assert.equal(rows[1].valid_to, null);
    assert.equal(String(rows[1].user_id), String(ids.repB));
    await assert.rejects(team.updateRep(ids.repA, { working_hours: { days: [1], start: '19:00', end: '10:00' } }, 1), /end after it starts/);
  });
});
