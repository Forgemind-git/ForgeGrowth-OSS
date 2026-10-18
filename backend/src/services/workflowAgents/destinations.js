// Where a finished run's output goes. Every destination writes one
// workflow_agent_deliveries row (sent / failed / skipped / scheduled) so the Runs
// tab can say exactly what happened — a destination that was not configured is
// "skipped, because…", never silently nothing.

const crypto = require('crypto');
const pool = require('../../db');
const { renderMarkdown, renderSummary, isLeadSignal } = require('./markdown');
const { decrypt } = require('../../util/crypto');
const { OWNER_SQL } = require('./sql');
const { toIst } = require('./format');

const FETCH_TIMEOUT_MS = 10000;
const WORKLIST_TOKENS = ['rep_name', 'lead_count', 'hot_count', 'top_leads', 'run_date'];

async function record(runId, index, type, status, { detail = null, error = null, scheduledFor = null } = {}) {
  await pool.query(
    `INSERT INTO coexistence.workflow_agent_deliveries (run_id, destination_index, type, status, detail, error, scheduled_for, attempts, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4 = 'scheduled' THEN 0 ELSE 1 END, NOW())
     ON CONFLICT (run_id, destination_index) DO UPDATE
       SET status = EXCLUDED.status, detail = EXCLUDED.detail, error = EXCLUDED.error, scheduled_for = EXCLUDED.scheduled_for,
           attempts = coexistence.workflow_agent_deliveries.attempts + 1, updated_at = NOW()`,
    [runId, index, type, status, detail ? JSON.stringify(detail) : null, error, scheduledFor]);
}

/** Leads in a Lead Signal output grouped by their CURRENT owner (server-resolved, never the model's grouping). */
async function leadsByOwner(output) {
  const leads = (output.reps || []).flatMap(r => (r.leads || []).map(l => ({ ...l })));
  const ids = [...new Set(leads.map(l => Number(l.contact_id)).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT l.id, ${OWNER_SQL('l')} AS owner FROM coexistence.leads l WHERE l.id = ANY($1::bigint[])`, [ids]);
  const owner = new Map(rows.map(r => [String(r.id), r.owner == null ? null : String(r.owner)]));
  const by = new Map();
  for (const l of leads) {
    const k = owner.get(String(l.contact_id)) ?? null;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(l);
  }
  return by;
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function sendAtFor(sendAt, now = new Date()) {
  if (!sendAt) return null;
  const today = new Date(now.getTime() + 5.5 * 36e5).toISOString().slice(0, 10);
  const at = new Date(`${today}T${sendAt}:00+05:30`);
  return at > now ? at : null;
}

const LABEL_RANK = { hot: 0, warm: 1, watch: 2, slipping: 3 };
const maskNumber = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length > 5 ? `${d.slice(0, 2)}${'x'.repeat(d.length - 5)}${d.slice(-3)}` : d; };

/**
 * A Lead Signal digest as an approved template: one message per rep with THEIR
 * leads (to: "rep", sent to the rep's notify phone), or one team-wide message to
 * fixed numbers (to: "numbers"). Template variables fill in the order of
 * WORKLIST_TOKENS, as many as the template body has.
 */
async function whatsappTemplate(run, agent, dest) {
  const output = run.output;
  if (!isLeadSignal(output)) return { status: 'skipped', error: 'This destination sends a lead list; the output has no reps.' };
  const { rows: [tpl] } = await pool.query(
    `SELECT mt.id, mt.name, mt.body, mt.whatsapp_account_id, wa.display_phone_number
       FROM coexistence.message_templates mt LEFT JOIN coexistence.whatsapp_accounts wa ON wa.id = mt.whatsapp_account_id
      WHERE lower(mt.name) = lower($1) AND upper(mt.status) = 'APPROVED' ORDER BY mt.id LIMIT 1`, [dest.template]);
  if (!tpl) return { status: 'skipped', error: `No APPROVED template named "${dest.template}". Create it in Templates, then this destination will send.` };
  let fromNumber = tpl.display_phone_number;
  if (!fromNumber) {
    const { rows: [def] } = await pool.query(`SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE is_active ORDER BY is_default DESC, id LIMIT 1`);
    fromNumber = def?.display_phone_number;
  }
  if (!fromNumber) return { status: 'skipped', error: 'No active WhatsApp number to send from.' };
  const varCount = new Set((String(tpl.body || '').match(/\{\{\s*\d+\s*\}\}/g) || [])).size;
  const variablesFor = (values) => WORKLIST_TOKENS.slice(0, varCount).map(k => values[k]);
  const { sendTemplateMessage } = require('../mcpService');

  if (dest.to === 'numbers') {
    const numbers = dest.numbers || [];
    if (!numbers.length) return { status: 'skipped', error: 'No numbers are set on this destination.' };
    const leads = (output.reps || []).flatMap(r => r.leads || [])
      .sort((a, b) => (LABEL_RANK[a.label] ?? 9) - (LABEL_RANK[b.label] ?? 9) || (b.score ?? 0) - (a.score ?? 0));
    const variables = variablesFor({
      rep_name: 'Team', lead_count: String(leads.length), hot_count: String(leads.filter(l => l.label === 'hot').length),
      top_leads: leads.slice(0, 3).map(l => l.name_masked).join(', '), run_date: output.run_date || '',
    });
    const perNumber = [];
    for (const n of numbers) {
      try {
        await sendTemplateMessage({ fromNumber, toNumber: n, templateId: tpl.id, variables });
        perNumber.push({ to: maskNumber(n), status: 'sent' });
      } catch (e) {
        perNumber.push({ to: maskNumber(n), status: 'failed', reason: String(e.message).slice(0, 200) });
      }
    }
    const sent = perNumber.filter(p => p.status === 'sent').length;
    return { status: sent ? 'sent' : 'failed', detail: { template: tpl.name, per_number: perNumber }, error: sent ? null : 'No number could be messaged; see details.' };
  }

  const by = await leadsByOwner(output);
  const { rows: users } = await pool.query(`SELECT id, COALESCE(display_name, username) AS name, notify_phone FROM coexistence.forgecrm_users WHERE is_active`);
  const perRep = [];
  for (const [owner, leads] of by.entries()) {
    const u = users.find(x => String(x.id) === owner);
    if (!owner || !u) { perRep.push({ rep_user_id: owner, status: 'skipped', reason: owner ? 'rep not active' : 'unassigned leads have no rep to message' }); continue; }
    if (!u.notify_phone) { perRep.push({ rep_user_id: owner, status: 'skipped', reason: 'no notify phone on the rep profile' }); continue; }
    const variables = variablesFor({
      rep_name: u.name, lead_count: String(leads.length), hot_count: String(leads.filter(l => l.label === 'hot').length),
      top_leads: leads.slice(0, 3).map(l => l.name_masked).join(', '), run_date: output.run_date || '',
    });
    try {
      await sendTemplateMessage({ fromNumber, toNumber: u.notify_phone, templateId: tpl.id, variables });
      perRep.push({ rep_user_id: owner, status: 'sent', leads: leads.length });
    } catch (e) {
      perRep.push({ rep_user_id: owner, status: 'failed', reason: String(e.message).slice(0, 200) });
    }
  }
  const sent = perRep.filter(p => p.status === 'sent').length;
  return { status: sent ? 'sent' : (perRep.some(p => p.status === 'failed') ? 'failed' : 'skipped'), detail: { template: tpl.name, per_rep: perRep }, error: sent ? null : 'No rep could be messaged; see details.' };
}

async function telegram(run, agent, dest) {
  const { rows: [s] } = await pool.query(`SELECT telegram_bot_token_encrypted FROM coexistence.workflow_agent_settings WHERE id = 1`);
  const token = s?.telegram_bot_token_encrypted ? decrypt(s.telegram_bot_token_encrypted) : null;
  if (!token) return { status: 'skipped', error: 'No Telegram bot token is saved (Workflow Agents → Settings).' };
  if (!dest.chat_id) return { status: 'skipped', error: 'No Telegram chat id is set on this destination.' };
  const text = (dest.format === 'full' ? renderMarkdown(run.output, { agentName: agent.name }) : renderSummary(run.output, { agentName: agent.name })).slice(0, 4000);
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: dest.chat_id, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok && body.ok ? { status: 'sent', detail: { message_id: body.result?.message_id } } : { status: 'failed', error: body.description || `Telegram answered HTTP ${res.status}.` };
}

async function email(run, agent, dest) {
  const { gmailSend } = require('../../integrations/googleClient');
  const text = renderMarkdown(run.output, { agentName: agent.name });
  try {
    await gmailSend({ to: dest.to.join(', '), subject: `${agent.name} — ${toIst(run.finished_at || new Date()).slice(0, 10)}`, text });
    return { status: 'sent', detail: { to: dest.to, format: 'text' } };
  } catch (e) {
    return { status: 'failed', error: `Gmail: ${String(e.message).slice(0, 200)} (connect Gmail in Admin Settings → Integrations).` };
  }
}

async function webhook(run, agent, dest) {
  const body = JSON.stringify({
    agent: { id: String(agent.id), name: agent.name, preset_key: agent.preset_key || null },
    run: { id: String(run.id), trigger_type: run.trigger_type, status: run.status, finished_at: toIst(run.finished_at) },
    output: run.output, output_markdown: run.output_markdown,
  });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ForgeGrowth-WorkflowAgents/1' };
  if (dest.secret) headers['X-Forge-Signature'] = `sha256=${crypto.createHmac('sha256', dest.secret).update(body).digest('hex')}`;
  try {
    const res = await fetchWithTimeout(dest.url, { method: 'POST', headers, body });
    return res.ok ? { status: 'sent', detail: { http_status: res.status } } : { status: 'failed', error: `The webhook answered HTTP ${res.status}.` };
  } catch (e) {
    return { status: 'failed', error: e.name === 'AbortError' ? 'The webhook did not answer within 10 seconds.' : String(e.message).slice(0, 200) };
  }
}

const HANDLERS = { whatsapp_template: whatsappTemplate, telegram, email, webhook };

async function deliverOne(run, agent, dest, index) {
  if (dest.type === 'results_inbox') return record(run.id, index, dest.type, 'sent', { detail: { stored: true } });
  if (dest.type === 'rep_worklist') {
    const reps = isLeadSignal(run.output) ? [...(await leadsByOwner(run.output)).keys()].length : 0;
    return record(run.id, index, dest.type, isLeadSignal(run.output) ? 'sent' : 'skipped', {
      detail: { reps }, error: isLeadSignal(run.output) ? null : 'The worklist reads Lead Signal-shaped outputs (reps → leads).',
    });
  }
  if (dest.enabled === false) return record(run.id, index, dest.type, 'skipped', { error: 'Destination is switched off.' });
  const handler = HANDLERS[dest.type];
  if (!handler) return record(run.id, index, dest.type, 'skipped', { error: 'Unknown destination type.' });
  try {
    const r = await handler(run, agent, dest);
    return record(run.id, index, dest.type, r.status, { detail: r.detail, error: r.error || null });
  } catch (e) {
    return record(run.id, index, dest.type, 'failed', { error: String(e.message).slice(0, 300) });
  }
}

/** Called by the runtime after a live run finishes with output. */
async function deliverRun(run, agent, config) {
  const dests = config.destinations || [];
  for (const [i, dest] of dests.entries()) {
    const at = dest.type === 'whatsapp_template' && dest.enabled !== false ? sendAtFor(dest.send_at) : null;
    if (at) {
      await record(run.id, i, dest.type, 'scheduled', { scheduledFor: at, detail: { send_at: dest.send_at } });
      continue;
    }
    await deliverOne(run, agent, dest, i);
  }
}

/** Housekeeping tick: send scheduled deliveries that are due. */
async function sendDueDeliveries(now = new Date()) {
  const { rows } = await pool.query(
    `UPDATE coexistence.workflow_agent_deliveries d SET status = 'sent', updated_at = NOW()
      WHERE d.id IN (SELECT id FROM coexistence.workflow_agent_deliveries WHERE status = 'scheduled' AND scheduled_for <= $1 LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING d.*`, [now]);
  for (const d of rows) {
    const { rows: [run] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_runs WHERE id = $1`, [d.run_id]);
    const { rows: [agent] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [run.agent_id]);
    const dest = (run.config_snapshot?.destinations || [])[d.destination_index];
    if (!dest) { await record(run.id, d.destination_index, d.type, 'skipped', { error: 'Destination no longer in the run config.' }); continue; }
    await deliverOne(run, agent, { ...dest, send_at: null }, d.destination_index);
  }
  return rows.length;
}

module.exports = { deliverRun, deliverOne, sendDueDeliveries, leadsByOwner, sendAtFor, WORKLIST_TOKENS };
