// Workflow Agents API. Thin: validation, rules and permissions live in
// services/workflowAgents/*. Mounted under /api behind authMiddleware.
//
// Paths are /workflow-agents/… rather than the brief's /agents/… because /agents is
// the customer-facing AI Agents API (docs/agents/DATA_MAP.md §6).

const { Router } = require('express');
const pool = require('../db');
const { adminOnly, requirePermission } = require('../middleware/access');
const service = require('../services/workflowAgents/service');
const runtime = require('../services/workflowAgents/runtime');
const actions = require('../services/workflowAgents/actions');
const worklist = require('../services/workflowAgents/worklist');
const team = require('../services/workflowAgents/team');
const triggers = require('../services/workflowAgents/triggers');
const { describeTools, buildToolContext, runTool } = require('../services/workflowAgents/tools');
const { normalizeScope } = require('../services/workflowAgents/scope');
const { VARIABLES, GUARDRAILS } = require('../services/workflowAgents/guardrails');
const { EVENTS, DESTINATION_TYPES, APPROVERS } = require('../services/workflowAgents/config');
const { CHAT_TYPES } = require('../services/workflowAgents/scope');
const { enqueueRun } = require('../services/workflowAgents/queue');

const router = Router();
const P_AGENTS = requirePermission('workflow-agents');
const P_APPROVALS = requirePermission('workflow-agent-approvals');
const P_WORKLIST = requirePermission('my-worklist');

const userId = (req) => Number(req.user?.id) || null;

function wrap(handler) {
  return async (req, res) => {
    try {
      const out = await handler(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500) console.error(`[workflow-agents] ${req.method} ${req.path}:`, e);
      res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Please try again.' : e.message, ...(e.errors ? { errors: e.errors } : {}) });
    }
  };
}

/** Memory can be edited by admins, and by team leads who were given the Workflow Agents page. */
async function memoryEditor(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const { rows } = await pool.query(`SELECT 1 FROM coexistence.rep_teams WHERE lead_user_id = $1 LIMIT 1`, [userId(req)]);
  if (!rows.length) return res.status(403).json({ error: 'Only admins and team leads can edit agent memory.' });
  return next();
}

// ── catalogue ─────────────────────────────────────────────────────────────────

router.get('/workflow-agents/catalog', P_AGENTS, wrap(async () => ({
  tools: describeTools(), variables: VARIABLES, guardrails: GUARDRAILS, events: EVENTS,
  destination_types: DESTINATION_TYPES, approvers: APPROVERS, chat_types: CHAT_TYPES,
})));
router.get('/workflow-agents/presets', P_AGENTS, wrap(() => service.listPresets()));
router.get('/workflow-agents/presets/:key', P_AGENTS, wrap((req) => service.getPreset(req.params.key)));
router.get('/workflow-agents/tools', P_AGENTS, wrap(async () => ({ tools: describeTools() })));

router.post('/workflow-agents/tools/:key/preview', adminOnly, wrap(async (req) => {
  const b = req.body || {};
  const { scope, errors } = normalizeScope(b.data_scope);
  if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; throw e; }
  const agentId = b.agent_id ? Number(b.agent_id) : null;
  const ctx = await buildToolContext({
    pool, agent: { id: agentId || 0, name: 'preview', auto_accept_memory: false }, scope, dryRun: true, now: new Date(),
    toolConfig: [{ tool_key: req.params.key, enabled: true, permission: b.permission, params_override: b.params_override || {} }],
    recordStep: () => {},
  });
  const t0 = Date.now();
  const result = await runTool(ctx, req.params.key, b.input || {});
  return { tool_key: req.params.key, duration_ms: Date.now() - t0, result };
}));

// ── settings & team ───────────────────────────────────────────────────────────

router.get('/workflow-agents/settings', adminOnly, wrap(() => team.getSettings()));
router.put('/workflow-agents/settings', adminOnly, wrap((req) => team.updateSettings(req.body || {}, userId(req))));
router.get('/workflow-agents/team', adminOnly, wrap(() => team.getTeamSetup()));
router.post('/workflow-agents/team/teams', adminOnly, wrap((req) => team.upsertTeam(req.body || {}, userId(req))));
router.put('/workflow-agents/team/teams/:tid', adminOnly, wrap((req) => team.upsertTeam({ ...(req.body || {}), id: req.params.tid }, userId(req))));
router.delete('/workflow-agents/team/teams/:tid', adminOnly, wrap((req) => team.deleteTeam(req.params.tid, userId(req))));
router.put('/workflow-agents/team/reps/:uid', adminOnly, wrap((req) => team.updateRep(req.params.uid, req.body || {}, userId(req))));
router.put('/workflow-agents/team/numbers/:accountId', adminOnly, wrap((req) => team.assignNumber(req.params.accountId, req.body?.rep_user_id, userId(req), req.body?.note)));

// ── approvals ─────────────────────────────────────────────────────────────────

router.get('/workflow-agents/actions', P_APPROVALS, wrap((req) => actions.listActions(req.user, {
  status: req.query.status || 'pending', agentId: req.query.agent_id, runId: req.query.run_id, limit: req.query.limit, offset: req.query.offset,
})));
router.post('/workflow-agents/actions/decide', P_APPROVALS, wrap((req) => actions.decide(req.user, req.body?.ids, req.body?.decision)));
router.post('/workflow-agents/actions/:aid/approve', P_APPROVALS, wrap((req) => actions.decide(req.user, [req.params.aid], 'approve', { edits: req.body?.edits || null })));
router.post('/workflow-agents/actions/:aid/reject', P_APPROVALS, wrap((req) => actions.decide(req.user, [req.params.aid], 'reject')));

// ── rep worklist, feedback, tasks, notifications ─────────────────────────────

router.get('/workflow-agents/worklist/me', P_WORKLIST, wrap((req) => worklist.getWorklist(req.user, { agentId: req.query.agent_id, repId: req.query.rep_id })));
router.post('/workflow-agents/worklist/send', P_WORKLIST, wrap((req) => worklist.sendSuggested(req.user, req.body || {})));
router.post('/workflow-agents/feedback', wrap((req) => worklist.recordFeedback(req.user, req.body || {})));
router.get('/workflow-agents/tasks', P_WORKLIST, wrap(async (req) => ({ tasks: await worklist.myTasks(req.user, { status: req.query.status || 'open' }) })));
router.put('/workflow-agents/tasks/:tid', P_WORKLIST, wrap((req) => worklist.updateTask(req.user, req.params.tid, req.body?.status)));
router.get('/workflow-agents/notifications', wrap(async (req) => ({ notifications: await worklist.myNotifications(req.user, { unreadOnly: req.query.unread === '1' }) })));
router.post('/workflow-agents/notifications/read', wrap((req) => worklist.markNotificationsRead(req.user, req.body?.ids)));

// ── internal events ───────────────────────────────────────────────────────────

router.post('/workflow-agents/events', adminOnly, wrap((req) => triggers.ingestEvent({
  event: req.body?.event, leadId: req.body?.lead_id, payload: req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {},
})));

// ── runs ──────────────────────────────────────────────────────────────────────

router.get('/workflow-agents/runs/:rid', P_AGENTS, wrap((req) => service.getRun(req.params.rid)));
router.get('/workflow-agents/runs/:rid/steps', P_AGENTS, wrap(async (req) => ({ steps: await service.getRunSteps(req.params.rid) })));
router.post('/workflow-agents/runs/:rid/cancel', adminOnly, wrap((req) => service.cancelRun(req.params.rid, userId(req))));
router.post('/workflow-agents/runs/:rid/rerun', adminOnly, wrap(async (req, res) => {
  const { rows: [r] } = await pool.query(`SELECT agent_id, agent_version_id, dry_run, trigger_payload, config_snapshot, pretend_date FROM coexistence.workflow_agent_runs WHERE id = $1`, [Number(req.params.rid)]);
  if (!r) { const e = new Error('Run not found.'); e.status = 404; throw e; }
  // Re-running with the SAME version: a live run re-creates from the agent's saved
  // config; a test run replays its own snapshot.
  const run = await runtime.createRun({
    agentId: r.agent_id, triggerType: 'manual', triggerPayload: { ...r.trigger_payload, rerun_of: String(req.params.rid) },
    dryRun: r.dry_run, configOverride: r.dry_run ? r.config_snapshot : null, pretendDate: null, requestedBy: userId(req),
    versionId: r.dry_run ? null : r.agent_version_id,
  });
  await enqueueRun(run.id);
  res.status(202);
  return { run: service.runRow(run) };
}));

// ── agents ────────────────────────────────────────────────────────────────────

router.get('/workflow-agents', P_AGENTS, wrap(async () => ({ agents: await service.listAgents() })));
router.post('/workflow-agents', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await service.createAgent({ presetKey: b.preset_key || null, name: b.name, description: b.description, icon: b.icon, setup: b.setup || null, userId: userId(req) });
  res.status(201);
  return out;
}));
router.get('/workflow-agents/:id', P_AGENTS, wrap((req) => service.getAgent(req.params.id)));
router.patch('/workflow-agents/:id', adminOnly, wrap((req) => service.updateAgent(req.params.id, req.body || {}, userId(req))));
router.delete('/workflow-agents/:id', adminOnly, wrap((req) => service.deleteAgent(req.params.id, userId(req))));

router.post('/workflow-agents/:id/versions', adminOnly, wrap(async (req, res) => {
  const out = await service.saveVersion(req.params.id, req.body?.config || {}, req.body?.change_note, userId(req));
  if (!out.unchanged) res.status(201);
  return out;
}));
router.get('/workflow-agents/:id/versions', P_AGENTS, wrap(async (req) => ({ versions: await service.listVersions(req.params.id) })));
router.get('/workflow-agents/:id/versions/:vid', P_AGENTS, wrap((req) => service.getVersion(req.params.id, req.params.vid)));
router.post('/workflow-agents/:id/restore/:vid', adminOnly, wrap((req) => service.restoreVersion(req.params.id, req.params.vid, userId(req))));

router.get('/workflow-agents/:id/memory', P_AGENTS, wrap((req) => service.listMemory(req.params.id, { status: req.query.status, kind: req.query.kind, q: req.query.q })));
router.post('/workflow-agents/:id/memory', P_AGENTS, memoryEditor, wrap(async (req, res) => { res.status(201); return service.createMemory(req.params.id, req.body || {}, userId(req)); }));
router.patch('/workflow-agents/:id/memory/:mid', P_AGENTS, memoryEditor, wrap((req) => service.updateMemory(req.params.id, req.params.mid, req.body || {}, userId(req))));
router.delete('/workflow-agents/:id/memory/:mid', P_AGENTS, memoryEditor, wrap((req) => service.deleteMemory(req.params.id, req.params.mid, userId(req))));
router.post('/workflow-agents/:id/memory/:mid/approve', P_AGENTS, memoryEditor, wrap((req) => service.decideMemory(req.params.id, req.params.mid, 'approve', userId(req), req.body?.edits || {})));
router.post('/workflow-agents/:id/memory/:mid/reject', P_AGENTS, memoryEditor, wrap((req) => service.decideMemory(req.params.id, req.params.mid, 'reject', userId(req))));

router.post('/workflow-agents/:id/run', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const dryRun = b.dry_run === true;
  const run = await runtime.createRun({
    agentId: Number(req.params.id), triggerType: 'manual', triggerPayload: b.trigger_payload && typeof b.trigger_payload === 'object' ? b.trigger_payload : {},
    dryRun, pretendDate: b.pretend_date || null, configOverride: dryRun ? (b.config_override || null) : null, requestedBy: userId(req),
  });
  await enqueueRun(run.id);
  res.status(202);
  return { run: service.runRow(run) };
}));
router.get('/workflow-agents/:id/runs', P_AGENTS, wrap((req) => service.listRuns(req.params.id, {
  status: req.query.status, trigger: req.query.trigger, from: req.query.from, to: req.query.to, limit: req.query.limit, offset: req.query.offset,
})));
router.get('/workflow-agents/:id/results', P_AGENTS, wrap(async (req) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.trigger_type, r.status, r.finished_at, r.output_markdown, r.output, r.checks, r.cost_inr, r.dry_run,
            (SELECT COUNT(*) FROM coexistence.workflow_agent_actions x WHERE x.run_id = r.id AND x.status = 'pending')::int AS pending_actions,
            (SELECT COUNT(*) FROM coexistence.workflow_agent_feedback f WHERE f.run_id = r.id)::int AS feedback_count
       FROM coexistence.workflow_agent_runs r
      WHERE r.agent_id = $1 AND r.output IS NOT NULL AND ($2::boolean OR r.dry_run = FALSE)
      ORDER BY r.finished_at DESC NULLS LAST LIMIT 30`, [Number(req.params.id), req.query.include_tests === '1']);
  return { results: rows.map(r => ({ ...service.runRow(r), output: r.output, output_markdown: r.output_markdown, checks: r.checks, pending_actions: r.pending_actions, feedback_count: r.feedback_count })) };
}));
router.get('/workflow-agents/:id/audit', adminOnly, wrap(async (req) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.entity, a.entity_id, a.action, a.before, a.after, a.user_id, COALESCE(u.display_name, u.username) AS user_name, a.created_at
       FROM coexistence.workflow_agent_audit a LEFT JOIN coexistence.forgecrm_users u ON u.id = a.user_id
      WHERE a.agent_id = $1 ORDER BY a.created_at DESC LIMIT 200`, [Number(req.params.id)]);
  return { audit: rows };
}));

module.exports = { router };
