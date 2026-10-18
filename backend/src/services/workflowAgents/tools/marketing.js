// Ads, automation flow runs and broadcasts.

const { toIst, istDate, dateOnly, round, key10 } = require('../format');
const { KEY10 } = require('../sql');
const { leadScopeSql, isAll } = require('../scope');
const { err, binder, pageArgs, paginate, windowArgs, leadIdentity, strArr, idList } = require('./common');
const { nodeTitle } = require('./leads');

const GST = 1.18;

const getAdPerformance = {
  key: 'get_ad_performance',
  category: 'Marketing',
  kind: 'read',
  title: 'Ad performance',
  description: 'Meta ad results in a window, per ad: campaign, ad set, status, spend (pre-GST, from Meta) and spend_incl_gst (×1.18 — use this when discussing cost), impressions, clicks, click-to-WhatsApp conversations started (Meta\'s count), leads attributed (distinct in-scope leads whose first click came from the ad), and cost per attributed lead incl. GST. Revenue per ad is NOT attributable here; never claim it.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'IST date. Default and floor: the scope lookback.' },
      to: { type: 'string', description: 'IST date, inclusive.' },
      ad_ids: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const win = windowArgs({ since: input.from, until: input.to }, ctx);
    if (win.error) return win;
    const adIds = strArr(input.ad_ids);
    const fromDate = istDate(win.since);
    const toDate = istDate(win.until);
    const { params, add } = binder();
    const { rows: daily } = await pool.query(
      `SELECT d.ad_external_id, SUM(d.spend)::numeric AS spend, SUM(d.impressions)::bigint AS impressions,
              SUM(d.clicks)::bigint AS clicks, SUM(d.leads)::int AS conversations, MIN(d.stat_date) AS first_day, MAX(d.stat_date) AS last_day
         FROM coexistence.ad_daily_stats d
        WHERE d.stat_date >= ${add(fromDate)}::date AND d.stat_date <= ${add(toDate)}::date
          ${adIds.length ? `AND d.ad_external_id = ANY(${add(adIds)}::text[])` : ''}
        GROUP BY d.ad_external_id`, params);

    const b = binder();
    const { rows: attributed } = await pool.query(
      `SELECT r.source_id, COUNT(DISTINCT l.id)::int AS leads
         FROM coexistence.ctwa_referrals r
         JOIN coexistence.leads l ON l.id = r.lead_id OR ${KEY10('l.whatsapp_number')} = ${KEY10('r.contact_number')}
        WHERE r.source_type = 'ad' AND r.clicked_at >= ${b.add(win.since)} AND r.clicked_at < ${b.add(win.until)}
          ${adIds.length ? `AND r.source_id = ANY(${b.add(adIds)}::text[])` : ''}
          ${leadScopeSql(scope, b.add)}
        GROUP BY r.source_id`, b.params);
    const attrBy = new Map(attributed.map(a => [a.source_id, a.leads]));
    const ids = [...new Set([...daily.map(d => d.ad_external_id), ...attributed.map(a => a.source_id)])];
    const { rows: meta } = await pool.query(
      `SELECT ca.ad_external_id, ca.name, ca.status, ca.adset_name, ca.campaign_external_id, cmp.name AS campaign_name
         FROM coexistence.campaign_ads ca LEFT JOIN coexistence.campaigns cmp ON cmp.external_id = ca.campaign_external_id
        WHERE ca.ad_external_id = ANY($1::text[])`, [ids]);
    const metaBy = new Map(meta.map(m => [m.ad_external_id, m]));
    const ads = ids.map(id => {
      const d = daily.find(x => x.ad_external_id === id) || {};
      const m = metaBy.get(id) || {};
      const spend = d.spend == null ? null : Number(d.spend);
      const inclGst = spend == null ? null : round(spend * GST, 2);
      const leads = attrBy.get(id) || 0;
      return {
        ad_id: id, ad_name: m.name || null, status: m.status || null, ad_set: m.adset_name || null,
        campaign_id: m.campaign_external_id || null, campaign_name: m.campaign_name || null,
        spend: spend == null ? null : round(spend, 2), spend_incl_gst: inclGst,
        impressions: d.impressions == null ? null : Number(d.impressions), clicks: d.clicks == null ? null : Number(d.clicks),
        ctwa_conversations_started: d.conversations ?? null,
        leads_attributed: leads,
        cost_per_attributed_lead_incl_gst: inclGst != null && leads ? round(inclGst / leads, 2) : null,
        spend_days: d.first_day ? { first: dateOnly(d.first_day), last: dateOnly(d.last_day) } : null,
      };
    }).sort((a, b2) => (b2.spend_incl_gst || 0) - (a.spend_incl_gst || 0));
    const totalSpend = ads.reduce((s, a) => s + (a.spend || 0), 0);
    return {
      window: { from: fromDate, to: toDate, clamped_to_lookback: win.clamped },
      totals: {
        spend: round(totalSpend, 2), spend_incl_gst: round(totalSpend * GST, 2),
        ctwa_conversations_started: ads.reduce((s, a) => s + (a.ctwa_conversations_started || 0), 0),
        leads_attributed: ads.reduce((s, a) => s + a.leads_attributed, 0),
      },
      ads,
      notes: [
        'spend is pre-GST as reported by Meta; spend_incl_gst = spend × 1.18.',
        'Daily spend is synced for a rolling 45 days; older windows may show null spend.',
        'Revenue per ad is not attributable in this workspace.',
      ],
    };
  },
};

const getFlowRuns = {
  key: 'get_flow_runs',
  category: 'Marketing',
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
  category: 'Marketing',
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

module.exports = { tools: [getAdPerformance, getFlowRuns, getBroadcastResults], GST, idList };
