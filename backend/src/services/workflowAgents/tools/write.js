// Write tools. ⚠ NONE OF THESE CHANGES ANYTHING. Each validates its input against
// the real data, then files a `workflow_agent_actions` row with status 'pending'
// for a person to approve (services/workflowAgents/actions.js executes approved
// rows, once). In a test run nothing is filed; with permission "draft" the proposal
// is recorded in the run trace only.

const crypto = require('crypto');
const { toIst } = require('../format');
const { OWNER_SQL } = require('../sql');
const { leadInScope } = require('../scope');
const { err, parseInstant } = require('./common');
const { leadThread, approvedTemplates } = require('./draft');

// Brief tool key → stored action_type.
const ACTION_TYPES = {
  tag_contact: 'tag_contact',
  set_funnel_stage: 'set_stage',
  assign_owner: 'assign_rep',
  add_internal_note: 'add_note',
  create_follow_up_task: 'create_task',
  send_whatsapp_message: 'send_whatsapp',
  trigger_automation: 'trigger_automation',
  notify_rep: 'notify_rep',
};

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * File (or simulate) one proposal. Duplicates inside one run collapse onto the
 * existing row via uq_workflow_agent_actions_dedupe.
 */
async function proposeAction(ctx, { toolKey, leadId, payload, reason }) {
  const actionType = ACTION_TYPES[toolKey];
  const dedupeKey = crypto.createHash('sha256').update(`${actionType}|${leadId || ''}|${stableStringify(payload)}`).digest('hex').slice(0, 40);
  const proposal = { action_type: actionType, contact_id: leadId == null ? null : String(leadId), payload, reason };

  if (ctx.dryRun) {
    ctx.recordStep?.('action_proposal', { ...proposal, status: 'simulated' });
    return { status: 'simulated', note: 'Test run: no action was filed. In a live run this would wait for approval.', proposal };
  }
  if (ctx.permission === 'draft') {
    ctx.recordStep?.('action_proposal', { ...proposal, status: 'draft_only' });
    return { status: 'draft_only', note: 'This tool is set to draft: the proposal is recorded in the run but not queued for approval.', proposal };
  }
  const expireHours = Number(ctx.approvalRules?.expire_hours) > 0 ? Number(ctx.approvalRules.expire_hours) : 24;
  const { rows } = await ctx.pool.query(
    `INSERT INTO coexistence.workflow_agent_actions (run_id, agent_id, action_type, lead_id, payload, reason, dedupe_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' hours')::interval)
     ON CONFLICT (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, expires_at`,
    [ctx.runId, ctx.agent.id, actionType, leadId || null, JSON.stringify(payload), reason || null, dedupeKey, String(expireHours)]);
  if (!rows.length) return { status: 'already_proposed', note: 'An identical proposal is already waiting from this run.' };
  ctx.recordStep?.('action_proposal', { ...proposal, action_id: String(rows[0].id), status: 'pending' });
  return { status: 'pending_approval', action_id: String(rows[0].id), expires_at: toIst(rows[0].expires_at) };
}

const reasonProp = { type: 'string', description: 'Why, in one sentence a sales head would accept. Cite message_ids where relevant.' };

async function requireLead(ctx, contactId) {
  const id = Number(contactId);
  if (!(await leadInScope(ctx.pool, ctx.scope, id))) return { error: err('out_of_scope', 'That lead does not exist or is outside this agent\'s data scope.') };
  const { rows: [lead] } = await ctx.pool.query(
    `SELECT l.id, l.name, l.whatsapp_number, l.stage, l.opted_out, ${OWNER_SQL('l')} AS owner FROM coexistence.leads l WHERE l.id = $1`, [id]);
  return { lead };
}

const tagContact = {
  key: 'tag_contact', category: 'Actions', kind: 'write', title: 'Tag contact',
  description: 'Propose adding a tag to a lead\'s WhatsApp contact rows (e.g. "hot_signal", "slipping"). Waits for approval. Funnel Stage and Product tags are managed automatically and cannot be proposed.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string' }, tag: { type: 'string', maxLength: 60 }, reason: reasonProp },
    required: ['contact_id', 'tag', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    const tag = String(input.tag || '').trim().slice(0, 60);
    if (!tag) return err('invalid_input', 'tag is required.');
    const { rows } = await ctx.pool.query(
      `SELECT t.id, t.category_id FROM coexistence.tags t WHERE lower(t.name) = lower($1) LIMIT 1`, [tag]);
    if (rows[0] && ['cat-funnel-stage', 'cat-product'].includes(rows[0].category_id)) {
      return err('not_allowed', `"${tag}" is an auto-managed tag; change the stage or product instead.`);
    }
    return proposeAction(ctx, { toolKey: 'tag_contact', leadId: lead.id, payload: { tag }, reason: input.reason });
  },
};

const setFunnelStage = {
  key: 'set_funnel_stage', category: 'Actions', kind: 'write', title: 'Set funnel stage',
  description: 'Propose moving a lead to another funnel stage (use the stage_key from get_workspace_context). Waits for approval; approval writes the stage-change audit event.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string' }, stage_key: { type: 'string' }, reason: reasonProp },
    required: ['contact_id', 'stage_key', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    const key = String(input.stage_key || '').trim();
    const { rows } = await ctx.pool.query(`SELECT stage_key, label FROM coexistence.funnel_stages WHERE stage_key = $1 AND active`, [key]);
    if (!rows.length) return err('invalid_input', `Unknown stage_key "${key}". Use a stage_key from get_workspace_context.`);
    if (lead.stage === key) return err('no_change', `The lead is already at ${rows[0].label}.`);
    return proposeAction(ctx, { toolKey: 'set_funnel_stage', leadId: lead.id, payload: { from: lead.stage, to: key }, reason: input.reason });
  },
};

const assignOwner = {
  key: 'assign_owner', category: 'Actions', kind: 'write', title: 'Assign owner',
  description: 'Propose assigning a lead to a rep (rep_user_id from get_rep_directory). Waits for approval.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string' }, rep_user_id: { type: 'string' }, reason: reasonProp },
    required: ['contact_id', 'rep_user_id', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    const rep = ctx.users.get(String(input.rep_user_id));
    if (!rep || !rep.active) return err('invalid_input', 'rep_user_id must be an active rep from get_rep_directory.');
    if (lead.owner != null && String(lead.owner) === rep.id) return err('no_change', `The lead is already owned by ${rep.name}.`);
    return proposeAction(ctx, { toolKey: 'assign_owner', leadId: lead.id, payload: { rep_user_id: rep.id, from_rep_user_id: lead.owner == null ? null : String(lead.owner) }, reason: input.reason });
  },
};

const addInternalNote = {
  key: 'add_internal_note', category: 'Actions', kind: 'write', title: 'Add internal note',
  description: 'Propose an internal note on a lead (visible to the team, never sent to the customer). Waits for approval.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string' }, note: { type: 'string', maxLength: 2000 }, reason: reasonProp },
    required: ['contact_id', 'note'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    const note = String(input.note || '').trim().slice(0, 2000);
    if (!note) return err('invalid_input', 'note is required.');
    return proposeAction(ctx, { toolKey: 'add_internal_note', leadId: lead.id, payload: { note }, reason: input.reason || null });
  },
};

const createFollowUpTask = {
  key: 'create_follow_up_task', category: 'Actions', kind: 'write', title: 'Create follow-up task',
  description: 'Propose a follow-up task for a rep on a lead, due at an IST time. The assignee defaults to the lead\'s owner (unassigned if none). Waits for approval.',
  input_schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      title: { type: 'string', maxLength: 200, description: 'e.g. "Call about EMI option".' },
      due_at: { type: 'string', description: 'IST, e.g. "2026-09-18T11:00:00+05:30" or "2026-09-18".' },
      assignee_rep_id: { type: 'string' },
      reason: reasonProp,
    },
    required: ['contact_id', 'title', 'due_at', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    const title = String(input.title || '').trim().slice(0, 200);
    if (!title) return err('invalid_input', 'title is required.');
    const due = parseInstant(input.due_at);
    if (!due) return err('invalid_input', 'due_at must be an IST date or ISO timestamp.');
    if (due < new Date(ctx.now.getTime() - 3600e3)) return err('invalid_input', 'due_at is in the past.');
    let assignee = lead.owner == null ? null : String(lead.owner);
    if (input.assignee_rep_id) {
      const rep = ctx.users.get(String(input.assignee_rep_id));
      if (!rep || !rep.active) return err('invalid_input', 'assignee_rep_id must be an active rep.');
      assignee = rep.id;
    }
    return proposeAction(ctx, { toolKey: 'create_follow_up_task', leadId: lead.id, payload: { title, due_at: due.toISOString(), assignee_rep_id: assignee }, reason: input.reason });
  },
};

const sendWhatsappMessage = {
  key: 'send_whatsapp_message', category: 'Actions', kind: 'write', title: 'Send WhatsApp message',
  description: 'Propose sending a WhatsApp message to a lead: free text (only while the 24-hour window is open) or an approved template (any time) with its body variables. Refused for opted-out leads. Waits for approval; nothing is sent until a person approves it.',
  input_schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      text: { type: 'string', maxLength: 1024 },
      template_name: { type: 'string' },
      variables: { type: 'array', items: { type: 'string' }, description: 'Body variables {{1}}, {{2}}… in order.' },
      reason: reasonProp,
    },
    required: ['contact_id', 'reason'], additionalProperties: false,
  },
  overridable: [{ key: 'templates_only', type: 'boolean', mode: 'force', label: 'Templates only (no free text)' }],
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    if (lead.opted_out) return err('opted_out', 'This lead has opted out; do not message them.');
    const text = input.text == null ? '' : String(input.text).trim();
    const templateName = input.template_name == null ? '' : String(input.template_name).trim();
    if (!!text === !!templateName) return err('invalid_input', 'Provide exactly one of text or template_name.');
    if (text && ctx.overrides?.templates_only === true) return err('not_allowed', 'This agent may only propose approved templates, not free text.');
    const thread = await leadThread(ctx.pool, ctx.scope, lead, ctx.now);
    if (!thread) return err('no_thread', 'There is no WhatsApp thread with this lead on an in-scope business number.');
    const businessNumberId = ctx.accounts.byNumber.get(thread.wa_number)?.id || null;
    if (text) {
      if (!thread.window_open) return err('outside_24h_window', 'The 24-hour window is closed; propose an approved template instead.', { templates: (await approvedTemplates(ctx.pool, thread.wa_number)).slice(0, 25) });
      return proposeAction(ctx, { toolKey: 'send_whatsapp_message', leadId: lead.id, payload: { kind: 'text', text, business_number_id: businessNumberId }, reason: input.reason });
    }
    const templates = await approvedTemplates(ctx.pool, thread.wa_number);
    const tpl = templates.find(t => t.name.toLowerCase() === templateName.toLowerCase());
    if (!tpl) return err('invalid_input', `No approved template named "${templateName}" on this lead's business number.`, { templates: templates.slice(0, 25) });
    const vars = Array.isArray(input.variables) ? input.variables.map(v => String(v)) : [];
    if (vars.length !== tpl.variable_count) return err('invalid_input', `Template "${tpl.name}" needs ${tpl.variable_count} variable(s); you gave ${vars.length}.`);
    return proposeAction(ctx, { toolKey: 'send_whatsapp_message', leadId: lead.id, payload: { kind: 'template', template_id: tpl.template_id, template_name: tpl.name, variables: vars, business_number_id: businessNumberId }, reason: input.reason });
  },
};

const triggerAutomation = {
  key: 'trigger_automation', category: 'Actions', kind: 'write', title: 'Start automation',
  description: 'Propose starting an active WhatsApp automation flow for a lead (flow id from get_flow_runs). Waits for approval.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string' }, flow_id: { type: 'string' }, reason: reasonProp },
    required: ['contact_id', 'flow_id', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    const { lead, error } = await requireLead(ctx, input.contact_id);
    if (error) return error;
    if (lead.opted_out) return err('opted_out', 'This lead has opted out.');
    const { rows } = await ctx.pool.query(`SELECT id, name, status FROM coexistence.chatbots WHERE id = $1`, [Number(input.flow_id)]);
    if (!rows.length) return err('invalid_input', 'Unknown flow_id.');
    if (rows[0].status !== 'active') return err('invalid_input', `Flow "${rows[0].name}" is not active.`);
    return proposeAction(ctx, { toolKey: 'trigger_automation', leadId: lead.id, payload: { flow_id: String(rows[0].id), flow_name: rows[0].name }, reason: input.reason });
  },
};

const notifyRep = {
  key: 'notify_rep', category: 'Actions', kind: 'write', title: 'Notify rep',
  description: 'Propose an in-app notification to a rep (defaults to the lead\'s owner). Use for urgent items such as an unanswered hot lead. Waits for approval.',
  input_schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      rep_user_id: { type: 'string' },
      message: { type: 'string', maxLength: 500 },
      reason: reasonProp,
    },
    required: ['message', 'reason'], additionalProperties: false,
  },
  async handler(input, ctx) {
    let leadId = null;
    let target = input.rep_user_id ? String(input.rep_user_id) : null;
    if (input.contact_id) {
      const { lead, error } = await requireLead(ctx, input.contact_id);
      if (error) return error;
      leadId = lead.id;
      if (!target && lead.owner != null) target = String(lead.owner);
    }
    if (target) {
      const rep = ctx.users.get(target);
      if (!rep || !rep.active) return err('invalid_input', 'rep_user_id must be an active rep.');
    }
    const message = String(input.message || '').trim().slice(0, 500);
    if (!message) return err('invalid_input', 'message is required.');
    return proposeAction(ctx, { toolKey: 'notify_rep', leadId, payload: { rep_user_id: target, message }, reason: input.reason });
  },
};

module.exports = {
  tools: [tagContact, setFunnelStage, assignOwner, addInternalNote, createFollowUpTask, sendWhatsappMessage, triggerAutomation, notifyRep],
  ACTION_TYPES, proposeAction, stableStringify,
};
