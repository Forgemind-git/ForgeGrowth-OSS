// Approvals: who may decide an agent's proposed action, and executing an approved
// action EXACTLY ONCE through the app's existing services.
//
// Once-only is a database claim, not a flag in memory: `executing_at` is set by a
// single UPDATE … WHERE status='approved' AND executing_at IS NULL, so two people
// approving at the same moment, a double click, or a retry can only ever run the
// executor once. A rejected or expired action has no path to the executor at all.

const pool = require('../../db');
const bus = require('../../events');
const { KEY10, OWNER_SQL } = require('./sql');
const { toIst, normKey, maskName, maskPhone } = require('./format');
const { leadThread } = require('./tools/draft');
const { normalizeScope } = require('./scope');
const { ServiceError, audit } = require('./service');

const AGENT_SIGNALS_CATEGORY = { id: 'cat-agent-signals', name: 'Agent signals', description: 'Tags applied by approved Workflow Agent actions.' };
const EDITABLE = { send_whatsapp: ['text', 'variables'], create_task: ['title', 'due_at'], add_note: ['note'], notify_rep: ['message'], tag_contact: ['tag'] };

// ── who can see / decide ─────────────────────────────────────────────────────

async function actorContext(user) {
  const id = Number(user.id);
  const { rows: teams } = await pool.query(`SELECT id FROM coexistence.rep_teams WHERE lead_user_id = $1`, [id]);
  const teamIds = teams.map(t => Number(t.id));
  let teamMemberIds = [];
  if (teamIds.length) {
    const { rows } = await pool.query(`SELECT id FROM coexistence.forgecrm_users WHERE team_id = ANY($1::bigint[])`, [teamIds]);
    teamMemberIds = rows.map(r => Number(r.id));
  }
  return { id, isAdmin: user.role === 'admin', leadsTeams: teamIds.length > 0, teamMemberIds };
}

/** Can this actor decide an action whose lead is owned by `ownerId` under these approval rules? */
function canDecide(actor, rules, ownerId) {
  if (actor.isAdmin) return true;
  const approvers = rules?.approvers || ['admin'];
  if (approvers.includes('team_lead') && actor.leadsTeams && ownerId != null && actor.teamMemberIds.includes(Number(ownerId))) return true;
  if (approvers.includes('owner_rep') && ownerId != null && Number(ownerId) === actor.id) return true;
  return false;
}

function actionRow(r, { maskPii = true } = {}) {
  return {
    id: String(r.id), run_id: r.run_id == null ? null : String(r.run_id), agent_id: String(r.agent_id), agent_name: r.agent_name,
    action_type: r.action_type, contact_id: r.lead_id == null ? null : String(r.lead_id),
    contact_name: r.lead_name == null ? null : (maskPii ? maskName(r.lead_name) : r.lead_name),
    contact_phone: r.whatsapp_number ? (maskPii ? maskPhone(r.whatsapp_number) : r.whatsapp_number) : null,
    stage: r.stage || null, owner_rep_id: r.owner == null ? null : String(r.owner), owner_rep_name: r.owner_name || null,
    payload: r.payload, reason: r.reason, status: r.status, editable_fields: EDITABLE[r.action_type] || [],
    decided_by: r.decided_by, decided_by_name: r.decided_by_name || null, decided_at: toIst(r.decided_at),
    executed_at: toIst(r.executed_at), expires_at: toIst(r.expires_at), result: r.result, created_at: toIst(r.created_at),
  };
}

const SELECT_ACTIONS = `
  SELECT x.*, a.name AS agent_name, v.approval_rules, v.data_scope, l.name AS lead_name, l.whatsapp_number, l.stage,
         o.owner, COALESCE(ou.display_name, ou.username) AS owner_name, COALESCE(du.display_name, du.username) AS decided_by_name
    FROM coexistence.workflow_agent_actions x
    JOIN coexistence.workflow_agents a ON a.id = x.agent_id
    LEFT JOIN coexistence.workflow_agent_runs r ON r.id = x.run_id
    LEFT JOIN coexistence.workflow_agent_versions v ON v.id = COALESCE(r.agent_version_id, a.current_version_id)
    LEFT JOIN coexistence.leads l ON l.id = x.lead_id
    LEFT JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o ON l.id IS NOT NULL
    LEFT JOIN coexistence.forgecrm_users ou ON ou.id = o.owner
    LEFT JOIN coexistence.forgecrm_users du ON du.id = x.decided_by`;

async function listActions(user, { status = 'pending', agentId = null, runId = null, limit = 100, offset = 0 } = {}) {
  const actor = await actorContext(user);
  const params = [];
  const where = [];
  if (status && status !== 'all') { params.push(status); where.push(`x.status = $${params.length}`); }
  if (status === 'pending') where.push('(x.expires_at IS NULL OR x.expires_at > NOW())');
  if (agentId) { params.push(Number(agentId)); where.push(`x.agent_id = $${params.length}`); }
  if (runId) { params.push(Number(runId)); where.push(`x.run_id = $${params.length}`); }
  const { rows } = await pool.query(
    `${SELECT_ACTIONS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY x.created_at DESC LIMIT 1000`, params);
  const visible = rows.filter(r => canDecide(actor, r.approval_rules, r.owner) || (!actor.isAdmin && r.owner != null && Number(r.owner) === actor.id));
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return {
    actions: visible.slice(off, off + lim).map(r => ({
      ...actionRow(r, { maskPii: normalizeScope(r.data_scope).scope.mask_pii }),
      can_decide: canDecide(actor, r.approval_rules, r.owner),
    })),
    total: visible.length,
  };
}

// ── executors ─────────────────────────────────────────────────────────────────

async function contactRowsFor(leadId) {
  const { rows } = await pool.query(
    `SELECT c.wa_number, c.contact_number FROM coexistence.contacts c JOIN coexistence.leads l ON ${KEY10('l.whatsapp_number')} = ${KEY10('c.contact_number')} WHERE l.id = $1`, [leadId]);
  return rows;
}

async function ensureSignalTag(name) {
  const { rows: existing } = await pool.query(
    `SELECT t.id, t.name, t.color, t.category_id FROM coexistence.tags t
      WHERE lower(t.name) = lower($1) AND t.category_id NOT IN ('cat-funnel-stage', 'cat-product') ORDER BY t.created_at LIMIT 1`, [name]);
  if (existing[0]) return existing[0];
  await pool.query(
    `INSERT INTO coexistence.categories (id, name, description) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [AGENT_SIGNALS_CATEGORY.id, AGENT_SIGNALS_CATEGORY.name, AGENT_SIGNALS_CATEGORY.description]);
  const id = `tag-agent-${normKey(name).slice(0, 40) || 'signal'}`;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.tags (id, name, color, category_id) VALUES ($1, $2, '#DC2626', $3)
     ON CONFLICT (id) DO UPDATE SET name = coexistence.tags.name RETURNING id, name, color, category_id`, [id, name, AGENT_SIGNALS_CATEGORY.id]);
  return rows[0];
}

const EXECUTORS = {
  async tag_contact(a) {
    const tag = await ensureSignalTag(String(a.payload.tag));
    const tagObj = { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id };
    const threads = await contactRowsFor(a.lead_id);
    if (!threads.length) return { ok: false, error: 'This lead has no WhatsApp contact row to tag.' };
    // Merge in SQL (never read-modify-write): drop any copy of this tag, append it once.
    const { rowCount } = await pool.query(
      `UPDATE coexistence.contacts c
          SET tags = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) x WHERE x->>'id' <> $2), '[]'::jsonb) || jsonb_build_array($3::jsonb),
              updated_at = NOW()
        FROM coexistence.leads l
       WHERE l.id = $1 AND ${KEY10('l.whatsapp_number')} = ${KEY10('c.contact_number')}`,
      [a.lead_id, tag.id, JSON.stringify(tagObj)]);
    for (const t of threads) {
      bus.emit('contact-saved', { waNumber: t.wa_number, contactNumber: t.contact_number });
      setImmediate(() => {
        try {
          require('../../engine/automationEngine').fireTagAppliedTriggers({ waNumber: t.wa_number, contactNumber: t.contact_number, tagName: tag.name, direction: 'added' }).catch(() => {});
        } catch { /* engine unavailable (tests) */ }
      });
    }
    return { ok: true, tag: tag.name, contact_rows: rowCount };
  },

  async set_stage(a, decidedBy) {
    const to = a.payload.to;
    const { rows: stage } = await pool.query(`SELECT stage_key FROM coexistence.funnel_stages WHERE stage_key = $1 AND active`, [to]);
    if (!stage.length) return { ok: false, error: `Stage "${to}" no longer exists.` };
    const { rows: [cur] } = await pool.query(`SELECT stage FROM coexistence.leads WHERE id = $1`, [a.lead_id]);
    if (!cur) return { ok: false, error: 'The lead no longer exists.' };
    if (cur.stage === to) return { ok: true, note: 'The lead was already at that stage.' };
    await pool.query(`UPDATE coexistence.leads SET stage = $1, stage_changed_at = NOW(), last_activity_at = NOW(), updated_at = NOW() WHERE id = $2`, [to, a.lead_id]);
    // The audit row every downstream dispatcher (CAPI, CLO, funnel tags) reads.
    await pool.query(`INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor) VALUES ($1,'stage_changed',$2,$3,$4)`,
      [a.lead_id, cur.stage, to, `workflow-agent:${a.agent_id}:approved-by:${decidedBy}`]);
    bus.emit('lead-changed', { leadId: a.lead_id });
    return { ok: true, from: cur.stage, to };
  },

  async assign_rep(a) {
    const { rows: [u] } = await pool.query(`SELECT id FROM coexistence.forgecrm_users WHERE id = $1 AND is_active`, [a.payload.rep_user_id]);
    if (!u) return { ok: false, error: 'That rep is no longer active.' };
    await pool.query(`UPDATE coexistence.leads SET assigned_user_id = $1, updated_at = NOW() WHERE id = $2`, [u.id, a.lead_id]);
    bus.emit('lead-changed', { leadId: a.lead_id });
    return { ok: true, rep_user_id: String(u.id) };
  },

  async add_note(a, decidedBy) {
    const { rows: [n] } = await pool.query(
      `INSERT INTO coexistence.lead_notes (lead_id, body, author_user_id, source, workflow_action_id) VALUES ($1,$2,$3,'agent',$4) RETURNING id`,
      [a.lead_id, String(a.payload.note), decidedBy, a.id]);
    return { ok: true, note_id: String(n.id) };
  },

  async create_task(a) {
    const { rows: [t] } = await pool.query(
      `INSERT INTO coexistence.workflow_agent_tasks (agent_id, action_id, lead_id, assignee_user_id, title, due_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [a.agent_id, a.id, a.lead_id, a.payload.assignee_rep_id || null, String(a.payload.title), a.payload.due_at ? new Date(a.payload.due_at) : null]);
    return { ok: true, task_id: String(t.id) };
  },

  async notify_rep(a) {
    const title = `Workflow agent: ${a.agent_name || 'agent'}`;
    if (a.payload.rep_user_id) {
      await pool.query(`INSERT INTO coexistence.workflow_agent_notifications (user_id, agent_id, action_id, lead_id, title, body) VALUES ($1,$2,$3,$4,$5,$6)`,
        [Number(a.payload.rep_user_id), a.agent_id, a.id, a.lead_id, title, String(a.payload.message)]);
      return { ok: true, notified: [String(a.payload.rep_user_id)] };
    }
    const { rows } = await pool.query(
      `INSERT INTO coexistence.workflow_agent_notifications (user_id, agent_id, action_id, lead_id, title, body)
       SELECT u.id, $1, $2, $3, $4, $5 FROM coexistence.forgecrm_users u WHERE u.role = 'admin' AND u.is_active RETURNING user_id`,
      [a.agent_id, a.id, a.lead_id, title, String(a.payload.message)]);
    return { ok: true, notified: rows.map(r => String(r.user_id)), note: 'No owner rep: sent to admins.' };
  },

  async send_whatsapp(a) {
    const { rows: [lead] } = await pool.query(`SELECT id, whatsapp_number, opted_out FROM coexistence.leads WHERE id = $1`, [a.lead_id]);
    if (!lead) return { ok: false, error: 'The lead no longer exists.' };
    if (lead.opted_out) return { ok: false, error: 'The lead opted out after this was proposed; nothing was sent.' };
    const thread = await leadThread(pool, normalizeScope({}).scope, lead);
    if (!thread) return { ok: false, error: 'No WhatsApp thread with this lead.' };
    if (a.payload.kind === 'text') {
      const { sendOnThread } = require('../paymentFlow');
      const r = await sendOnThread({ waNumber: thread.wa_number, contactNumber: thread.contact_number, body: String(a.payload.text), requireWindow: true });
      return r.sent ? { ok: true, local_message_id: r.localMessageId } : { ok: false, error: r.detail || r.reason };
    }
    const { sendTemplateMessage } = require('../mcpService');
    const r = await sendTemplateMessage({ fromNumber: thread.wa_number, toNumber: thread.contact_number, templateId: a.payload.template_id, variables: a.payload.variables || [] });
    return { ok: true, local_message_id: r.messageId, template: r.template };
  },

  async trigger_automation(a) {
    const { rows: [flow] } = await pool.query(`SELECT * FROM coexistence.chatbots WHERE id = $1`, [Number(a.payload.flow_id)]);
    if (!flow) return { ok: false, error: 'The flow no longer exists.' };
    if (flow.status !== 'active') return { ok: false, error: `Flow "${flow.name}" is not active.` };
    const { rows: [lead] } = await pool.query(`SELECT id, whatsapp_number, opted_out FROM coexistence.leads WHERE id = $1`, [a.lead_id]);
    if (!lead || lead.opted_out) return { ok: false, error: 'The lead no longer exists or opted out.' };
    const thread = await leadThread(pool, normalizeScope({}).scope, lead);
    if (!thread) return { ok: false, error: 'No WhatsApp thread with this lead.' };
    const { executeAutomation } = require('../../engine/automationEngine');
    const client = await pool.connect();
    try {
      const { rows: [c] } = await client.query(`SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`, [thread.wa_number, thread.contact_number]);
      const context = {
        contact_number: thread.contact_number, message_body: '', trigger_type: 'workflowAgent',
        trigger_data: { wa_number: thread.wa_number, workflow_agent_id: String(a.agent_id), workflow_action_id: String(a.id) },
        contact: c ? { name: c.name, profile_name: c.profile_name, contact_number: thread.contact_number, tags: c.tags || [], custom_fields: c.custom_fields || {} } : undefined,
      };
      const execution = await executeAutomation(client, flow, context);
      return execution ? { ok: true, execution_id: String(execution.id) } : { ok: false, error: 'The flow has no steps.' };
    } finally {
      client.release();
    }
  },
};

/**
 * Postgres aborts one side of a deadlock (40P01). An approval can legitimately race
 * a background sweep over the same contact or lead rows (the funnel-tag mirror, the
 * CAPI cursor), so a deadlocked statement is retried instead of failing the action.
 * Every executor statement is a single autocommitted write, so a retry is safe.
 */
async function withDeadlockRetry(fn, attempts = 3) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!(e && (e.code === '40P01' || e.code === '40001')) || i >= attempts) throw e;
      await new Promise(r => setTimeout(r, 50 * i + Math.floor(Math.random() * 50)));
    }
  }
}

async function executeApproved(actionId, decidedBy) {
  const { rows: [a] } = await pool.query(
    `UPDATE coexistence.workflow_agent_actions x SET executing_at = NOW()
       FROM coexistence.workflow_agents ag
      WHERE x.id = $1 AND x.agent_id = ag.id AND x.status = 'approved' AND x.executing_at IS NULL
      RETURNING x.*, ag.name AS agent_name`, [actionId]);
  if (!a) return null;
  let result;
  try {
    result = await withDeadlockRetry(() => EXECUTORS[a.action_type](a, decidedBy));
  } catch (e) {
    result = { ok: false, error: String(e.message).slice(0, 300) };
  }
  const { rows: [done] } = await pool.query(
    `UPDATE coexistence.workflow_agent_actions SET status = $2, executed_at = NOW(), result = $3 WHERE id = $1 RETURNING *`,
    [a.id, result.ok ? 'executed' : 'failed', JSON.stringify(result)]);
  return done;
}

function applyEdits(action, edits) {
  const allowed = EDITABLE[action.action_type] || [];
  const payload = { ...action.payload };
  for (const [k, v] of Object.entries(edits || {})) {
    if (!allowed.includes(k)) throw new ServiceError(400, `"${k}" cannot be edited on a ${action.action_type.replace('_', ' ')} action.`);
    if (k === 'text' && action.payload.kind !== 'text') throw new ServiceError(400, 'This is a template message; edit its variables instead.');
    if (k === 'variables') {
      if (!Array.isArray(v) || v.length !== (action.payload.variables || []).length) throw new ServiceError(400, 'Variables must keep the same count.');
      payload.variables = v.map(String);
    } else if (k === 'due_at') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new ServiceError(400, 'due_at is not a valid date.');
      payload.due_at = d.toISOString();
    } else {
      const s = String(v || '').trim();
      if (!s) throw new ServiceError(400, `${k} cannot be empty.`);
      payload[k] = s.slice(0, k === 'note' ? 2000 : 1024);
    }
  }
  return payload;
}

/** Approve (then execute) or reject one or many actions. Returns per-action outcomes. */
async function decide(user, actionIds, decision, { edits = null } = {}) {
  if (!['approve', 'reject'].includes(decision)) throw new ServiceError(400, 'decision must be approve or reject.');
  const ids = [...new Set((Array.isArray(actionIds) ? actionIds : [actionIds]).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) throw new ServiceError(400, 'No actions given.');
  if (edits && ids.length > 1) throw new ServiceError(400, 'Edits can only be applied to one action at a time.');
  const actor = await actorContext(user);
  const { rows } = await pool.query(`${SELECT_ACTIONS} WHERE x.id = ANY($1::bigint[])`, [ids]);
  const outcomes = [];
  for (const id of ids) {
    const r = rows.find(x => Number(x.id) === id);
    if (!r) { outcomes.push({ id: String(id), ok: false, error: 'Not found.' }); continue; }
    if (!canDecide(actor, r.approval_rules, r.owner)) { outcomes.push({ id: String(id), ok: false, error: 'You are not an approver for this action.' }); continue; }
    let payload = r.payload;
    if (edits && decision === 'approve') {
      try { payload = applyEdits(r, edits); } catch (e) { outcomes.push({ id: String(id), ok: false, error: e.message }); continue; }
    }
    const { rows: claimed } = await withDeadlockRetry(() => pool.query(
      `UPDATE coexistence.workflow_agent_actions SET status = $2, decided_by = $3, decided_at = NOW(), payload = $4
        WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id`,
      [id, decision === 'approve' ? 'approved' : 'rejected', actor.id, JSON.stringify(payload)]));
    if (!claimed.length) {
      const { rows: [now] } = await pool.query(`SELECT status, expires_at FROM coexistence.workflow_agent_actions WHERE id = $1`, [id]);
      const expired = now && now.status === 'pending' && now.expires_at && new Date(now.expires_at) <= new Date();
      outcomes.push({ id: String(id), ok: false, error: expired ? 'This action expired before it was decided.' : `Already ${now?.status}.` });
      continue;
    }
    await audit({ agentId: r.agent_id, entity: 'action', entityId: id, action: decision, before: { payload: r.payload }, after: edits ? { payload } : null, userId: actor.id });
    if (decision === 'reject') { outcomes.push({ id: String(id), ok: true, status: 'rejected' }); continue; }
    const done = await executeApproved(id, actor.id);
    outcomes.push({ id: String(id), ok: done?.status === 'executed', status: done?.status || 'approved', result: done?.result || null });
  }
  bus.emit('workflow-agent-actions', { ids: ids.map(String) });
  return { outcomes };
}

module.exports = { listActions, decide, executeApproved, withDeadlockRetry, canDecide, actorContext, EXECUTORS, EDITABLE, applyEdits, AGENT_SIGNALS_CATEGORY };
