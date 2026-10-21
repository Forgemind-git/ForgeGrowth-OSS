// Automation flow runs and broadcasts.

const { toIst, key10 } = require('../format');
const { KEY10 } = require('../sql');
const { leadScopeSql, isAll } = require('../scope');
const { err, binder, pageArgs, paginate, windowArgs, leadIdentity } = require('./common');
const { nodeTitle } = require('./leads');

const getFlowRuns = {
  key: 'get_flow_runs',
  category: 'Automations',
  kind: 'read',
  title: 'Automation flow runs',
  description: 'Where in-scope leads went and dropped in WhatsApp automations: per flow, runs started, completed, still waiting (and on which node), errors, reply timeouts and no-match replies, and the nodes where leads most often stopped. Pass flow_id for one flow and its per-lead runs.',
  input_schema: {
    type: 'object',
    properties: {
      flow_id: { type: 'string' },
      since: { type: 'string', description: 'Default and floor: the scope lookback.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const win = windowArgs(input, ctx);
    if (win.error) return win;
    const flowId = input.flow_id ? Number(input.flow_id) : null;
    if (input.flow_id && !Number.isInteger(flowId)) return err('invalid_input', 'flow_id must be a flow id.');
    const { params, add } = binder();
    const { rows } = await pool.query(
      `SELECT e.id, e.automation_id, c.name AS flow_name, c.config, e.status, e.awaiting_node_id, e.awaiting_kind,
              e.started_at, e.completed_at, e.error_message, l.id AS lead_id, l.name, l.whatsapp_number,
              (SELECT s.node_id FROM coexistence.automation_execution_steps s WHERE s.execution_id = e.id ORDER BY s.id DESC LIMIT 1) AS last_node_id,
              (SELECT COUNT(*)::int FROM coexistence.automation_execution_steps s
                WHERE s.execution_id = e.id AND s.node_type = 'reply_routing' AND s.output_data->>'followed_handle' = 'timeout') AS timeouts,
              (SELECT COUNT(*)::int FROM coexistence.automation_execution_steps s
                WHERE s.execution_id = e.id AND s.node_type = 'reply_routing'
                  AND (s.output_data->>'followed_handle' = 'nomatch' OR (s.output_data->>'kept_waiting')::boolean IS TRUE)) AS no_match
         FROM coexistence.automation_executions e
         LEFT JOIN coexistence.chatbots c ON c.id = e.automation_id
         JOIN coexistence.leads l ON ${KEY10('l.whatsapp_number')} = ${KEY10('e.contact_number')}
        WHERE e.started_at >= ${add(win.since)} AND e.started_at <= ${add(win.until)}
          ${flowId ? `AND e.automation_id = ${add(flowId)}` : ''}
          ${isAll(scope.business_numbers) ? '' : `AND e.wa_number = ANY(${add(scope.business_numbers)}::text[])`}
          ${leadScopeSql(scope, add)}
        ORDER BY e.started_at DESC`, params);
    const flows = new Map();
    for (const r of rows) {
      const k = String(r.automation_id);
      if (!flows.has(k)) flows.set(k, { flow_id: k, flow_name: r.flow_name, runs: 0, completed: 0, waiting: 0, errors: 0, cancelled: 0, timeouts: 0, no_match: 0, stopped_at: {} });
      const f = flows.get(k);
      f.runs += 1;
      if (r.status === 'success') f.completed += 1;
      if (r.status === 'paused') f.waiting += 1;
      if (r.status === 'error') f.errors += 1;
      if (r.status === 'cancelled') f.cancelled += 1;
      f.timeouts += r.timeouts; f.no_match += r.no_match;
      if (r.status !== 'success') {
        const node = nodeTitle(r.config, r.awaiting_node_id || r.last_node_id) || '(unknown)';
        f.stopped_at[node] = (f.stopped_at[node] || 0) + 1;
      }
    }
    const summary = [...flows.values()].map(f => ({
      ...f, stopped_at: Object.entries(f.stopped_at).map(([node, n]) => ({ node, leads: n })).sort((a, b) => b.leads - a.leads),
    }));
    const out = { window: { since: toIst(win.since), until: toIst(win.until), clamped_to_lookback: win.clamped }, flows: summary };
    if (flowId) {
      const page = pageArgs(input, { cap: ctx.caps?.limit });
      const { rows: pageRows, next_cursor } = paginate(rows.slice(page.offset, page.offset + page.limit + 1), page);
      out.runs = pageRows.map(r => ({
        ...leadIdentity({ id: r.lead_id, name: r.name, whatsapp_number: r.whatsapp_number }, scope),
        run_id: String(r.id), status: r.status, waiting_for: r.status === 'paused' ? r.awaiting_kind : null,
        stopped_at_node: nodeTitle(r.config, r.awaiting_node_id || r.last_node_id),
        timeouts: r.timeouts, no_match: r.no_match, started_at: toIst(r.started_at), completed_at: toIst(r.completed_at), error: r.error_message || null,
      }));
      out.next_cursor = next_cursor;
    }
    return out;
  },
};

const getBroadcastResults = {
  key: 'get_broadcast_results',
  category: 'Automations',
  kind: 'read',
  title: 'Broadcast results',
  description: 'Broadcast campaigns sent in the window: template, recipients, delivered / read / failed (from WhatsApp receipts), and how many replied within 72 hours. Pass campaign_id for per-lead results (in-scope leads only). Image and template messages often have no stored text — results are counted by message row, never by matching text.',
  input_schema: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', description: 'Broadcast id.' },
      since: { type: 'string', description: 'Default and floor: the scope lookback.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const win = windowArgs(input, ctx);
    if (win.error) return win;
    const campaignId = input.campaign_id ? Number(input.campaign_id) : null;
    if (input.campaign_id && !Number.isInteger(campaignId)) return err('invalid_input', 'campaign_id must be a broadcast id.');
    const { params, add } = binder();
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.from_number, b.message_type, mt.name AS template_name, bl.sent_to, bl.sent_at, bl.status AS log_status,
              ch.status AS delivery_status,
              EXISTS (SELECT 1 FROM coexistence.chat_history r
                       WHERE r.direction = 'incoming' AND r.wa_number = b.from_number
                         AND ${KEY10('r.contact_number')} = ${KEY10('bl.sent_to')}
                         AND r.timestamp > bl.sent_at AND r.timestamp <= bl.sent_at + INTERVAL '72 hours') AS replied
         FROM coexistence.broadcast_logs bl
         JOIN coexistence.broadcasts b ON b.id = bl.broadcast_id
         LEFT JOIN coexistence.message_templates mt ON mt.id = b.template_id
         LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id
        WHERE bl.action = 'BROADCAST' AND bl.sent_at >= ${add(win.since)} AND bl.sent_at <= ${add(win.until)}
          ${campaignId ? `AND b.id = ${add(campaignId)}` : ''}
          ${isAll(scope.business_numbers) ? '' : `AND b.from_number = ANY(${add(scope.business_numbers)}::text[])`}
        ORDER BY bl.sent_at DESC`, params);
    const camp = new Map();
    for (const r of rows) {
      const k = String(r.id);
      if (!camp.has(k)) camp.set(k, { campaign_id: k, name: r.name, template_name: r.template_name || null, message_type: r.message_type, business_number_id: ctx.accounts.byNumber.get(r.from_number)?.id || null, sent: 0, delivered: 0, read: 0, failed: 0, replied_72h: 0, first_sent_at: r.sent_at });
      const c = camp.get(k);
      const st = r.log_status === 'failed' ? 'failed' : (r.delivery_status || r.log_status);
      c.sent += 1;
      if (st === 'delivered' || st === 'read') c.delivered += 1;
      if (st === 'read') c.read += 1;
      if (st === 'failed') c.failed += 1;
      if (r.replied) c.replied_72h += 1;
      if (r.sent_at < c.first_sent_at) c.first_sent_at = r.sent_at;
    }
    const out = {
      window: { since: toIst(win.since), until: toIst(win.until), clamped_to_lookback: win.clamped },
      campaigns: [...camp.values()].map(c => ({ ...c, first_sent_at: toIst(c.first_sent_at) })),
      note: 'Totals count every recipient on in-scope business numbers; per-lead results are limited to in-scope leads.',
    };
    if (campaignId) {
      const keys = [...new Set(rows.map(r => key10(r.sent_to)))];
      const b2 = binder();
      const { rows: leads } = await pool.query(
        `SELECT l.id, l.name, l.whatsapp_number FROM coexistence.leads l
          WHERE ${KEY10('l.whatsapp_number')} = ANY(${b2.add(keys)}::text[]) ${leadScopeSql(scope, b2.add)}`, b2.params);
      const leadBy = new Map(leads.map(l => [key10(l.whatsapp_number), l]));
      const perLead = rows.filter(r => leadBy.has(key10(r.sent_to))).map(r => ({
        ...leadIdentity(leadBy.get(key10(r.sent_to)), scope),
        status: r.log_status === 'failed' ? 'failed' : (r.delivery_status || r.log_status),
        sent_at: toIst(r.sent_at), replied_within_72h: r.replied,
      }));
      const page = pageArgs(input, { cap: ctx.caps?.limit });
      const { rows: pageRows, next_cursor } = paginate(perLead.slice(page.offset, page.offset + page.limit + 1), page);
      out.recipients = pageRows;
      out.next_cursor = next_cursor;
    }
    return out;
  },
};

module.exports = { tools: [getFlowRuns, getBroadcastResults] };
