// The rep worklist ("My leads today"), feedback, and the rep's one-tap send.
//
// Leads are grouped by their CURRENT owner, resolved server-side at read time — not
// by the rep the model wrote into its output. A lead reassigned after the 08:00 run
// therefore shows up for its new owner, and a rep can never see another rep's list
// by editing a request.

const pool = require('../../db');
const { OWNER_SQL, KEY10 } = require('./sql');
const { toIst, istDate, maskName, maskPhone } = require('./format');
const { isLeadSignal } = require('./markdown');
const { normalizeScope } = require('./scope');
const { leadThread } = require('./tools/draft');
const { ServiceError, audit } = require('./service');
const { actorContext } = require('./actions');

const LABEL_ORDER = { hot: 0, warm: 1, watch: 2, slipping: 3 };
const OUTCOMES = { called: 'useful', messaged: 'useful', converted: 'converted', not_interested: 'not_useful', wrong_signal: 'wrong' };

async function worklistAgents() {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.preset_key, v.destinations, v.data_scope, v.approval_rules
       FROM coexistence.workflow_agents a JOIN coexistence.workflow_agent_versions v ON v.id = a.current_version_id
      ORDER BY (a.preset_key = 'lead_signal') DESC, a.id`);
  return rows.filter(r => (r.destinations || []).some(d => d.type === 'rep_worklist'));
}

/** Latest full list + the event runs that updated individual leads since. */
async function latestLeads(agentId) {
  const { rows: [base] } = await pool.query(
    `SELECT id, output, finished_at, trigger_type FROM coexistence.workflow_agent_runs
      WHERE agent_id = $1 AND dry_run = FALSE AND status IN ('succeeded', 'budget_stopped') AND output IS NOT NULL AND trigger_type IN ('schedule', 'manual')
      ORDER BY finished_at DESC LIMIT 1`, [agentId]);
  if (!base || !isLeadSignal(base.output)) return { base: null, leads: new Map() };
  const leads = new Map();
  for (const rep of base.output.reps || []) for (const l of rep.leads || []) leads.set(String(l.contact_id), { ...l, run_id: String(base.id), updated_at: base.finished_at });
  const { rows: updates } = await pool.query(
    `SELECT id, output, finished_at FROM coexistence.workflow_agent_runs
      WHERE agent_id = $1 AND dry_run = FALSE AND status = 'succeeded' AND trigger_type = 'event' AND finished_at > $2 AND output IS NOT NULL
      ORDER BY finished_at ASC LIMIT 200`, [agentId, base.finished_at]);
  for (const u of updates) {
    if (!isLeadSignal(u.output)) continue;
    for (const rep of u.output.reps || []) for (const l of rep.leads || []) leads.set(String(l.contact_id), { ...l, run_id: String(u.id), updated_at: u.finished_at, live_update: true });
  }
  return { base, leads };
}

async function getWorklist(user, { agentId = null, repId = null } = {}) {
  const actor = await actorContext(user);
  const agents = await worklistAgents();
  if (!agents.length) return { agents: [], agent: null, cards: [], note: 'No workflow agent publishes a rep worklist yet.' };
  const agent = agentId ? agents.find(a => String(a.id) === String(agentId)) : agents[0];
  if (!agent) throw new ServiceError(404, 'That agent does not publish a worklist.');

  // Whose list: yourself; admins and team leads may look at a rep they oversee.
  let target = String(actor.id);
  if (repId != null && repId !== '' && String(repId) !== String(actor.id)) {
    const allowed = actor.isAdmin || (actor.leadsTeams && actor.teamMemberIds.includes(Number(repId)));
    if (!allowed) throw new ServiceError(403, 'You can only open your own worklist.');
    target = String(repId);
  }

  const { base, leads } = await latestLeads(agent.id);
  const scope = normalizeScope(agent.data_scope).scope;
  if (!base) return { agents: agents.map(a => ({ id: String(a.id), name: a.name })), agent: { id: String(agent.id), name: agent.name }, run: null, cards: [], rep_user_id: target };

  const ids = [...leads.keys()].map(Number).filter(Number.isInteger);
  const { rows: current } = await pool.query(
    `SELECT l.id, l.name, l.whatsapp_number, l.stage, l.opted_out, ${OWNER_SQL('l')} AS owner, fs.label AS stage_label
       FROM coexistence.leads l LEFT JOIN coexistence.funnel_stages fs ON fs.stage_key = l.stage WHERE l.id = ANY($1::bigint[])`, [ids]);
  const mine = current.filter(c => (target === 'unassigned' ? c.owner == null : String(c.owner) === target) && !c.opted_out);
  const evidenceIds = [...new Set(mine.flatMap(c => (leads.get(String(c.id)).evidence || []).map(e => e.message_id)))];
  const { rows: msgRows } = evidenceIds.length
    ? await pool.query(`SELECT message_id, wa_number, contact_number FROM coexistence.chat_history WHERE message_id = ANY($1::text[])`, [evidenceIds])
    : { rows: [] };
  const msgBy = new Map(msgRows.map(m => [m.message_id, m]));
  const { rows: feedback } = await pool.query(
    `SELECT DISTINCT ON (lead_id) lead_id, outcome, rating, created_at FROM coexistence.workflow_agent_feedback
      WHERE agent_id = $1 AND user_id = $2 AND lead_id = ANY($3::bigint[]) AND created_at >= $4
      ORDER BY lead_id, created_at DESC`, [agent.id, actor.id, mine.map(c => c.id), base.finished_at]);
  const fbBy = new Map(feedback.map(f => [String(f.lead_id), f]));
  const { rows: tasks } = await pool.query(
    `SELECT id, lead_id, title, due_at FROM coexistence.workflow_agent_tasks WHERE status = 'open' AND lead_id = ANY($1::bigint[]) ORDER BY due_at NULLS LAST`, [mine.map(c => c.id)]);

  const cards = [];
  for (const c of mine) {
    const l = leads.get(String(c.id));
    const thread = await leadThread(pool, scope, c);
    cards.push({
      contact_id: String(c.id),
      name: scope.mask_pii ? (maskName(c.name) || l.name_masked) : (c.name || l.name_masked),
      phone: scope.mask_pii ? maskPhone(c.whatsapp_number) : c.whatsapp_number,
      stage: c.stage, stage_label: c.stage_label || c.stage, product: l.product || null,
      score: l.score, label: l.label, reason: l.reason, top_signal: l.top_signal || null, blocker: l.blocker || null,
      best_contact_time: l.best_contact_time || null,
      evidence: (l.evidence || []).map(e => {
        const m = msgBy.get(e.message_id);
        return { ...e, chat: m ? { wa_number: m.wa_number, contact_number: m.contact_number } : null };
      }),
      suggested_message: l.suggested_message || null, suggested_template: l.suggested_template || null,
      window_open: !!thread?.window_open, window_expires_at: toIst(thread?.window_expires_at),
      chat: thread ? { wa_number: thread.wa_number, contact_number: thread.contact_number } : null,
      run_id: l.run_id, live_update: !!l.live_update, updated_at: toIst(l.updated_at),
      feedback: fbBy.get(String(c.id)) ? { outcome: fbBy.get(String(c.id)).outcome, at: toIst(fbBy.get(String(c.id)).created_at) } : null,
      open_tasks: tasks.filter(t => String(t.lead_id) === String(c.id)).map(t => ({ id: String(t.id), title: t.title, due_at: toIst(t.due_at) })),
    });
  }
  cards.sort((a, b) => (LABEL_ORDER[a.label] ?? 9) - (LABEL_ORDER[b.label] ?? 9) || (b.score ?? 0) - (a.score ?? 0));
  const rules = agent.approval_rules || {};
  return {
    agents: agents.map(a => ({ id: String(a.id), name: a.name })),
    agent: { id: String(agent.id), name: agent.name },
    run: { id: String(base.id), finished_at: toIst(base.finished_at), date: istDate(base.finished_at) },
    rep_user_id: target,
    can_send_directly: rules.rep_can_send_suggested === true,
    cards,
  };
}

async function recordFeedback(user, { agent_id, run_id, contact_id, outcome, rating, comment }) {
  const actor = await actorContext(user);
  const out = outcome ? String(outcome) : null;
  if (out && !OUTCOMES[out]) throw new ServiceError(400, `outcome must be one of ${Object.keys(OUTCOMES).join(', ')}.`);
  const finalRating = out ? OUTCOMES[out] : rating;
  if (!['useful', 'not_useful', 'converted', 'wrong'].includes(finalRating)) throw new ServiceError(400, 'Give an outcome or a rating.');
  const { rows: [run] } = await pool.query(`SELECT id, agent_id FROM coexistence.workflow_agent_runs WHERE id = $1`, [Number(run_id)]);
  if (!run) throw new ServiceError(404, 'Run not found.');
  if (agent_id && String(agent_id) !== String(run.agent_id)) throw new ServiceError(400, 'That run belongs to another agent.');
  let leadId = null;
  if (contact_id != null && contact_id !== '') {
    leadId = Number(contact_id);
    const { rows: [l] } = await pool.query(`SELECT ${OWNER_SQL('l')} AS owner FROM coexistence.leads l WHERE l.id = $1`, [leadId]);
    if (!l) throw new ServiceError(404, 'Lead not found.');
    const mayRate = actor.isAdmin || (l.owner != null && Number(l.owner) === actor.id) || (actor.leadsTeams && l.owner != null && actor.teamMemberIds.includes(Number(l.owner)));
    if (!mayRate) throw new ServiceError(403, 'You can only give feedback on your own leads.');
  } else if (!actor.isAdmin) {
    throw new ServiceError(403, 'Only admins can rate a whole run.');
  }
  const { rows: [f] } = await pool.query(
    `INSERT INTO coexistence.workflow_agent_feedback (run_id, agent_id, lead_id, item_ref, rating, outcome, comment, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [run.id, run.agent_id, leadId, leadId ? `lead:${leadId}` : `run:${run.id}`, finalRating, out, comment ? String(comment).slice(0, 1000) : null, actor.id]);
  return { id: String(f.id), rating: finalRating, outcome: out, created_at: toIst(f.created_at) };
}

/**
 * A rep's "Send" on a card: files the suggested message as a send_whatsapp action.
 * It waits for approval unless the agent lets reps send suggested messages AND the
 * rep owns the lead, in which case it is approved and executed at once.
 */
async function sendSuggested(user, { agent_id, run_id, contact_id, text = null }) {
  const actor = await actorContext(user);
  const { rows: [run] } = await pool.query(
    `SELECT r.id, r.agent_id, r.output, v.approval_rules FROM coexistence.workflow_agent_runs r
       JOIN coexistence.workflow_agents a ON a.id = r.agent_id
       LEFT JOIN coexistence.workflow_agent_versions v ON v.id = a.current_version_id
      WHERE r.id = $1`, [Number(run_id)]);
  if (!run || (agent_id && String(agent_id) !== String(run.agent_id))) throw new ServiceError(404, 'Run not found.');
  const card = (run.output?.reps || []).flatMap(r => r.leads || []).find(l => String(l.contact_id) === String(contact_id));
  if (!card) throw new ServiceError(404, 'That lead is not in this run.');
  const { rows: [lead] } = await pool.query(`SELECT l.id, l.whatsapp_number, l.opted_out, ${OWNER_SQL('l')} AS owner FROM coexistence.leads l WHERE l.id = $1`, [Number(contact_id)]);
  if (!lead) throw new ServiceError(404, 'Lead not found.');
  const isOwner = lead.owner != null && Number(lead.owner) === actor.id;
  if (!actor.isAdmin && !isOwner && !(actor.leadsTeams && actor.teamMemberIds.includes(Number(lead.owner)))) throw new ServiceError(403, 'You can only send to your own leads.');
  if (lead.opted_out) throw new ServiceError(409, 'This lead has opted out.');
  const thread = await leadThread(pool, normalizeScope({}).scope, lead);
  if (!thread) throw new ServiceError(409, 'There is no WhatsApp thread with this lead.');
  const message = String(text || card.suggested_message || '').trim();
  let payload;
  if (thread.window_open) {
    if (!message) throw new ServiceError(400, 'There is no message to send.');
    payload = { kind: 'text', text: message.slice(0, 1024) };
  } else {
    if (!card.suggested_template) throw new ServiceError(409, 'The 24-hour window is closed and this card has no suggested template.');
    const { rows: [tpl] } = await pool.query(
      `SELECT id, name, body FROM coexistence.message_templates WHERE lower(name) = lower($1) AND upper(status) = 'APPROVED' ORDER BY id LIMIT 1`, [card.suggested_template]);
    if (!tpl) throw new ServiceError(409, `The suggested template "${card.suggested_template}" is not approved.`);
    const n = new Set((String(tpl.body || '').match(/\{\{\s*\d+\s*\}\}/g) || [])).size;
    if (n > 0) throw new ServiceError(409, `Template "${tpl.name}" needs ${n} variable(s); send it from the chat instead.`);
    payload = { kind: 'template', template_id: String(tpl.id), template_name: tpl.name, variables: [] };
  }
  const { rows: [action] } = await pool.query(
    `INSERT INTO coexistence.workflow_agent_actions (run_id, agent_id, action_type, lead_id, payload, reason, requested_by, expires_at)
     VALUES ($1,$2,'send_whatsapp',$3,$4,$5,$6, NOW() + INTERVAL '24 hours') RETURNING id`,
    [run.id, run.agent_id, lead.id, JSON.stringify(payload), 'Sent from the rep worklist', actor.id]);
  await audit({ agentId: run.agent_id, entity: 'action', entityId: action.id, action: 'rep_send_requested', after: payload, userId: actor.id });
  if (run.approval_rules?.rep_can_send_suggested === true && isOwner) {
    await pool.query(`UPDATE coexistence.workflow_agent_actions SET status = 'approved', decided_by = $2, decided_at = NOW() WHERE id = $1 AND status = 'pending'`, [action.id, actor.id]);
    const done = await require('./actions').executeApproved(action.id, actor.id);
    return { action_id: String(action.id), status: done?.status || 'approved', result: done?.result || null };
  }
  return { action_id: String(action.id), status: 'pending', note: 'Waiting for approval.' };
}

async function myNotifications(user, { unreadOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT n.id, n.title, n.body, n.lead_id, n.agent_id, n.read_at, n.created_at FROM coexistence.workflow_agent_notifications n
      WHERE n.user_id = $1 ${unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT 100`, [Number(user.id)]);
  return rows.map(r => ({ id: String(r.id), title: r.title, body: r.body, contact_id: r.lead_id == null ? null : String(r.lead_id), agent_id: r.agent_id == null ? null : String(r.agent_id), read_at: toIst(r.read_at), created_at: toIst(r.created_at) }));
}

async function markNotificationsRead(user, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  const { rowCount } = await pool.query(
    `UPDATE coexistence.workflow_agent_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL ${list.length ? 'AND id = ANY($2::bigint[])' : ''}`,
    list.length ? [Number(user.id), list] : [Number(user.id)]);
  return { updated: rowCount };
}

async function myTasks(user, { status = 'open' } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.lead_id, t.title, t.due_at, t.status, l.name, l.whatsapp_number, a.name AS agent_name
       FROM coexistence.workflow_agent_tasks t JOIN coexistence.leads l ON l.id = t.lead_id LEFT JOIN coexistence.workflow_agents a ON a.id = t.agent_id
      WHERE t.assignee_user_id = $1 AND t.status = $2 ORDER BY t.due_at NULLS LAST LIMIT 200`, [Number(user.id), status]);
  return rows.map(r => ({ id: String(r.id), contact_id: String(r.lead_id), name: maskName(r.name), phone: maskPhone(r.whatsapp_number), title: r.title, due_at: toIst(r.due_at), status: r.status, agent_name: r.agent_name }));
}

async function updateTask(user, taskId, status) {
  if (!['open', 'done', 'cancelled'].includes(status)) throw new ServiceError(400, 'status must be open, done or cancelled.');
  const actor = await actorContext(user);
  const { rows } = await pool.query(
    `UPDATE coexistence.workflow_agent_tasks SET status = $2, completed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE NULL END
      WHERE id = $1 AND ($3::boolean OR assignee_user_id = $4) RETURNING id`, [Number(taskId), status, actor.isAdmin, actor.id]);
  if (!rows.length) throw new ServiceError(404, 'Task not found.');
  return { ok: true };
}

module.exports = { getWorklist, recordFeedback, sendSuggested, myNotifications, markNotificationsRead, myTasks, updateTask, OUTCOMES, KEY10 };
