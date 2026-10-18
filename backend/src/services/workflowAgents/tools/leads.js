// Lead and funnel tools.

const { toIst, istDate, paiseToRupees, formatInr, maskPhone, maskName, normKey } = require('../format');
const { KEY10, OWNER_SQL } = require('../sql');
const { leadScopeSql, leadInScope } = require('../scope');
const { derivePaymentStatus } = require('../../paymentStatus');
const {
  err, binder, pageArgs, paginate, parseInstant, leadIdentity, money, repRef, strArr,
} = require('./common');
const { activeMemory } = require('./context');

async function stageLabels(pool) {
  const { rows } = await pool.query(
    `SELECT stage_key, label, order_index, is_won, is_funnel, active FROM coexistence.funnel_stages ORDER BY order_index, id`);
  return { map: new Map(rows.map(r => [r.stage_key, r])), list: rows.filter(r => r.active) };
}

/** Tags across all of a person's threads, de-duplicated by tag id. */
const TAGS_LATERAL = (alias = 'l') => `LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', t->>'id', 'name', t->>'name', 'category_id', t->>'category_id')), '[]'::jsonb) AS tags
      FROM coexistence.contacts tc, jsonb_array_elements(COALESCE(tc.tags, '[]'::jsonb)) t
     WHERE ${KEY10('tc.contact_number')} = ${KEY10(`${alias}.whatsapp_number`)}
  ) tg ON TRUE`;

/** Last inbound/outbound computed from chat_history (leads.last_outbound_at is unreliable). */
const ACTIVITY_LATERAL = (alias = 'l') => `LEFT JOIN LATERAL (
    SELECT MAX(ch.timestamp) FILTER (WHERE ch.direction = 'incoming') AS last_inbound_at,
           MAX(ch.timestamp) FILTER (WHERE ch.direction = 'outgoing') AS last_outbound_at
      FROM coexistence.chat_history ch
     WHERE ${KEY10('ch.contact_number')} = ${KEY10(`${alias}.whatsapp_number`)}
       AND ch.message_type NOT IN ('status', 'reaction', 'revoke')
  ) act ON TRUE`;

const PAYMENTS_SQL = `
  SELECT 'gateway' AS kind, rz.id, rz.amount_paise, rz.created_at AS paid_at, rz.method, NULL::bigint AS course_id, rz.payment_id AS reference
    FROM (
      SELECT DISTINCT ON (COALESCE(payment_id, 'evt'||id::text)) id, amount_paise, created_at, method, payment_id
        FROM coexistence.razorpay_events
       WHERE status = 'captured' AND matched_lead_id = $1
       ORDER BY COALESCE(payment_id, 'evt'||id::text), (event_type = 'payment.captured') DESC, id
    ) rz
  UNION ALL
  SELECT 'manual', sl.id, sl.amount_paise, (sl.payment_date::timestamp AT TIME ZONE 'Asia/Kolkata'), sl.method, sl.course_id, NULL
    FROM coexistence.sales_log sl WHERE sl.lead_id = $1`;

const SORTS = {
  last_inbound_desc: 'act.last_inbound_at DESC NULLS LAST, l.id DESC',
  created_desc: 'l.created_at DESC, l.id DESC',
  created_asc: 'l.created_at ASC, l.id ASC',
  stage_changed_desc: 'l.stage_changed_at DESC NULLS LAST, l.id DESC',
};

const listLeads = {
  key: 'list_leads',
  category: 'Leads & funnel',
  kind: 'read',
  title: 'List leads',
  description: 'Filterable list of in-scope leads with stage, source, owner rep, product, tags, and last inbound/outbound times (IST). Use it to find leads by stage or by quiet period, e.g. leads at an advanced stage whose last inbound was 2–7 days ago ("slipping"). contact_id is the lead id to pass to other tools.',
  input_schema: {
    type: 'object',
    properties: {
      stage: { type: 'array', items: { type: 'string' }, description: 'Funnel stage keys.' },
      source: { type: 'array', items: { type: 'string' }, description: 'Lead source labels.' },
      owner_rep_id: { type: 'string', description: 'Rep user id, or "unassigned".' },
      product: { type: 'string', description: 'Product name the lead bought (leads.paid_course), case-insensitive.' },
      created_from: { type: 'string', description: 'IST date YYYY-MM-DD, inclusive.' },
      created_to: { type: 'string', description: 'IST date YYYY-MM-DD, inclusive.' },
      last_inbound_from: { type: 'string', description: 'IST date or ISO timestamp.' },
      last_inbound_to: { type: 'string', description: 'IST date (inclusive day) or ISO timestamp.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only leads carrying any of these tag names.' },
      has_payment: { type: 'boolean', description: 'true = at least one recorded payment; false = none.' },
      sort: { type: 'string', enum: Object.keys(SORTS) },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  overridable: [{ key: 'limit', type: 'number', mode: 'cap', label: 'Maximum leads per call' }],
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const page = pageArgs(input, { cap: ctx.caps?.limit });
    const { params, add } = binder();
    const where = [];
    const stages = strArr(input.stage);
    if (stages.length) where.push(`l.stage = ANY(${add(stages)}::text[])`);
    const sources = strArr(input.source);
    if (sources.length) where.push(`lower(btrim(COALESCE(l.source,''))) = ANY(${add(sources.map(s => s.toLowerCase()))}::text[])`);
    if (input.owner_rep_id != null && input.owner_rep_id !== '') {
      if (String(input.owner_rep_id).toLowerCase() === 'unassigned') where.push('o.owner IS NULL');
      else if (/^\d+$/.test(String(input.owner_rep_id))) where.push(`o.owner = ${add(Number(input.owner_rep_id))}`);
      else return err('invalid_input', 'owner_rep_id must be a rep user id or "unassigned".');
    }
    if (input.product) where.push(`lower(btrim(COALESCE(l.paid_course,''))) = ${add(String(input.product).toLowerCase().trim())}`);
    for (const [key, col, eod] of [['created_from', 'l.created_at', false], ['created_to', 'l.created_at', true], ['last_inbound_from', 'act.last_inbound_at', false], ['last_inbound_to', 'act.last_inbound_at', true]]) {
      if (input[key] == null || input[key] === '') continue;
      const d = parseInstant(input[key], { endOfDay: eod });
      if (!d) return err('invalid_input', `${key} must be YYYY-MM-DD (IST) or an ISO timestamp.`);
      where.push(`${col} ${key.endsWith('_from') ? '>=' : '<'} ${add(d)}`);
    }
    const tags = strArr(input.tags).map(normKey);
    if (tags.length) where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(tg.tags) x WHERE trim(both '_' from regexp_replace(lower(x->>'name'), '[^a-z0-9]+', '_', 'g')) = ANY(${add(tags)}::text[]))`);
    if (typeof input.has_payment === 'boolean') {
      const pay = `(EXISTS (SELECT 1 FROM coexistence.razorpay_events re WHERE re.status='captured' AND re.matched_lead_id = l.id)
                    OR EXISTS (SELECT 1 FROM coexistence.sales_log sl WHERE sl.lead_id = l.id))`;
      where.push(input.has_payment ? pay : `NOT ${pay}`);
    }
    if (input.sort && !SORTS[input.sort]) return err('invalid_input', `sort must be one of ${Object.keys(SORTS).join(', ')}.`);
    const scopeSql = leadScopeSql(scope, add, { ownerExpr: 'o.owner' });
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.whatsapp_number, l.stage, l.source, l.paid_course, l.created_at, l.stage_changed_at,
              l.opted_out, o.owner, tg.tags, act.last_inbound_at, act.last_outbound_at
         FROM coexistence.leads l
         CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
         ${TAGS_LATERAL('l')}
         ${ACTIVITY_LATERAL('l')}
        WHERE TRUE ${scopeSql} ${where.length ? `AND ${where.join(' AND ')}` : ''}
        ORDER BY ${SORTS[input.sort] || SORTS.last_inbound_desc}
        LIMIT ${add(page.limit + 1)} OFFSET ${add(page.offset)}`, params);
    const labels = await stageLabels(pool);
    const { rows: out, next_cursor } = paginate(rows, page);
    return {
      leads: out.map(r => ({
        ...leadIdentity(r, scope),
        stage: r.stage, stage_label: labels.map.get(r.stage)?.label || r.stage,
        source: r.source, product: r.paid_course || null,
        ...repRef(ctx.users, r.owner),
        tags: (r.tags || []).map(t => t.name).filter(Boolean),
        created_at: toIst(r.created_at), stage_changed_at: toIst(r.stage_changed_at),
        last_inbound_at: toIst(r.last_inbound_at), last_outbound_at: toIst(r.last_outbound_at),
      })),
      next_cursor,
    };
  },
};

const getLeadProfile = {
  key: 'get_lead_profile',
  category: 'Leads & funnel',
  kind: 'read',
  title: 'Lead profile',
  description: 'Everything about one lead: profile, language hint, stage and full stage history, product, owner rep, tags, payments and outstanding balance, WhatsApp threads with 24-hour window state, recent automation flow runs, form answers, internal notes, the ad that brought them (if any), and this agent\'s contact memory for them. Returns {"error":"out_of_scope"} for leads you may not see.',
  input_schema: {
    type: 'object',
    properties: { contact_id: { type: 'string', description: 'Lead id.' } },
    required: ['contact_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope, now } = ctx;
    const id = Number(input.contact_id);
    if (!(await leadInScope(pool, scope, id))) return err('out_of_scope', 'That lead does not exist or is outside this agent\'s data scope.');
    const { rows: [l] } = await pool.query(
      `SELECT l.*, ${OWNER_SQL('l')} AS owner, tg.tags
         FROM coexistence.leads l ${TAGS_LATERAL('l')} WHERE l.id = $1`, [id]);
    const labels = await stageLabels(pool);

    const [events, payments, threads, flows, notes, referral, memory, price] = await Promise.all([
      pool.query(`SELECT id, ts, from_value, to_value, actor FROM coexistence.lead_events
                   WHERE lead_id = $1 AND event_type = 'stage_changed' ORDER BY ts, id`, [id]),
      pool.query(`${PAYMENTS_SQL} ORDER BY paid_at`, [id]),
      pool.query(
        `SELECT ch.wa_number,
                COUNT(*) FILTER (WHERE ch.direction = 'incoming')::int AS inbound,
                COUNT(*) FILTER (WHERE ch.direction = 'outgoing')::int AS outbound,
                MAX(ch.timestamp) FILTER (WHERE ch.direction = 'incoming') AS last_inbound_at,
                MAX(ch.timestamp) FILTER (WHERE ch.direction = 'outgoing') AS last_outbound_at
           FROM coexistence.chat_history ch
          WHERE ${KEY10('ch.contact_number')} = ${KEY10('$1')}
            AND ch.message_type NOT IN ('status','reaction','revoke')
            AND ch.timestamp <= $2
          GROUP BY ch.wa_number`, [l.whatsapp_number, now]),
      pool.query(
        `SELECT e.id, e.automation_id, c.name AS flow_name, c.config, e.status, e.awaiting_node_id, e.awaiting_kind,
                e.started_at, e.completed_at, e.error_message,
                (SELECT s.node_id FROM coexistence.automation_execution_steps s WHERE s.execution_id = e.id ORDER BY s.id DESC LIMIT 1) AS last_node_id
           FROM coexistence.automation_executions e
           LEFT JOIN coexistence.chatbots c ON c.id = e.automation_id
          WHERE ${KEY10('e.contact_number')} = ${KEY10('$1')} AND e.started_at >= $2
          ORDER BY e.started_at DESC LIMIT 10`, [l.whatsapp_number, new Date(now.getTime() - scope.lookback_days * 864e5)]),
      scope.chat_types.includes('internal_note')
        ? pool.query(`SELECT n.id, n.body, n.author_user_id, n.source, n.created_at FROM coexistence.lead_notes n WHERE n.lead_id = $1 ORDER BY n.created_at DESC LIMIT 20`, [id])
        : Promise.resolve({ rows: [] }),
      scope.chat_types.includes('ad_referral') ? firstReferral(pool, l) : Promise.resolve(null),
      activeMemory(pool, ctx.agent.id, { kinds: ['contact'], leadIds: [id], now }),
      pool.query(`SELECT id, name, default_price_paise FROM coexistence.courses WHERE lower(btrim(name)) = lower(btrim($1)) ORDER BY id LIMIT 1`, [l.paid_course || '']),
    ]);

    const totalPaid = payments.rows.reduce((s, p) => s + Number(p.amount_paise || 0), 0);
    const pay = derivePaymentStatus({ override: l.payment_status, totalPaidPaise: totalPaid, pricePaise: price.rows[0]?.default_price_paise });
    const history = events.rows.map((e, i) => {
      const next = events.rows[i + 1];
      const end = next ? next.ts : now;
      return {
        from: e.from_value, from_label: e.from_value ? (labels.map.get(e.from_value)?.label || e.from_value) : null,
        to: e.to_value, to_label: labels.map.get(e.to_value)?.label || e.to_value,
        at: toIst(e.ts), actor: e.actor, hours_in_stage: Math.round(((new Date(end) - new Date(e.ts)) / 36e5) * 10) / 10,
      };
    });
    const cf = l.custom_fields && typeof l.custom_fields === 'object' ? l.custom_fields : {};
    const threadRows = threads.rows.filter(t => ctx.inScopeNumber(t.wa_number));
    return {
      ...leadIdentity(l, scope),
      email: scope.mask_pii ? (l.email ? l.email.replace(/^(.).*(@.*)$/, '$1***$2') : null) : l.email,
      language_hint: cf.language_known || null,
      city: l.city || null, state: l.state || null, profession: l.profession || null, age: l.age ?? null,
      created_at: toIst(l.created_at),
      source: l.source,
      stage: l.stage, stage_label: labels.map.get(l.stage)?.label || l.stage,
      stage_changed_at: toIst(l.stage_changed_at),
      hours_in_current_stage: l.stage_changed_at ? Math.round(((now - new Date(l.stage_changed_at)) / 36e5) * 10) / 10 : null,
      stage_history: history,
      ...repRef(ctx.users, l.owner),
      tags: (l.tags || []).map(t => t.name).filter(Boolean),
      opted_out: l.opted_out === true,
      product: l.paid_course || null,
      custom_fields: cf,
      payments: payments.rows.map(p => ({
        source: p.kind, amount: money(p.amount_paise), paid_at: toIst(p.paid_at), method: p.method || null,
      })),
      total_paid: money(totalPaid),
      product_price: price.rows[0] ? money(price.rows[0].default_price_paise) : null,
      payment_status: pay.status, payment_status_source: pay.source,
      outstanding_balance: pay.outstandingPaise == null ? null : money(pay.outstandingPaise),
      threads: threadRows.map(t => ({
        business_number_id: ctx.accounts.byNumber.get(t.wa_number)?.id || null,
        business_number_label: ctx.accounts.byNumber.get(t.wa_number)?.label || null,
        inbound: t.inbound, outbound: t.outbound,
        last_inbound_at: toIst(t.last_inbound_at), last_outbound_at: toIst(t.last_outbound_at),
        window_open: !!t.last_inbound_at && (now - new Date(t.last_inbound_at)) < 24 * 36e5,
      })),
      flow_runs: flows.rows.map(f => flowRunShape(f)),
      internal_notes: notes.rows.map(n => ({ note_id: String(n.id), body: n.body, source: n.source, ...repRef(ctx.users, n.author_user_id), created_at: toIst(n.created_at) })),
      ad_referral: referral,
      contact_memory: memory,
    };
  },
};

function nodeTitle(config, nodeId) {
  if (!nodeId || !config?.nodes) return null;
  const n = config.nodes.find(x => x.id === nodeId);
  return n ? (n.title || n.type || nodeId) : nodeId;
}

function flowRunShape(f) {
  return {
    run_id: String(f.id), flow_id: String(f.automation_id), flow_name: f.flow_name || null,
    status: f.status, waiting_for: f.status === 'paused' ? (f.awaiting_kind || 'reply') : null,
    stopped_at_node: nodeTitle(f.config, f.awaiting_node_id || f.last_node_id),
    started_at: toIst(f.started_at), completed_at: toIst(f.completed_at), error: f.error_message || null,
  };
}

async function firstReferral(pool, lead) {
  const { rows: [r] } = await pool.query(
    `SELECT r.source_id, r.source_type, r.source_url, r.platform, r.headline, r.body, r.clicked_at, r.message_id,
            ca.name AS ad_name, cmp.name AS campaign_name, ch.message_body AS first_message
       FROM coexistence.ctwa_referrals r
       LEFT JOIN coexistence.campaign_ads ca ON ca.ad_external_id = r.source_id
       LEFT JOIN coexistence.campaigns cmp ON cmp.external_id = ca.campaign_external_id
       LEFT JOIN coexistence.chat_history ch ON ch.message_id = r.message_id
      WHERE r.lead_id = $1 OR ${KEY10('r.contact_number')} = ${KEY10('$2')}
      ORDER BY r.clicked_at ASC LIMIT 1`, [lead.id, lead.whatsapp_number]);
  if (!r) return null;
  return {
    ad_id: r.source_id, source_type: r.source_type, platform: r.platform, ad_name: r.ad_name || null,
    campaign_name: r.campaign_name || null, headline: r.headline || null, source_url: r.source_url || null,
    clicked_at: toIst(r.clicked_at), first_message_id: r.message_id || null,
    first_message_text: r.first_message ? `<customer_message>${r.first_message}</customer_message>` : null,
  };
}

const getStageHistory = {
  key: 'get_stage_history',
  category: 'Leads & funnel',
  kind: 'read',
  title: 'Stage history',
  description: 'Stage changes with time spent in the previous stage. Pass contact_id for one lead\'s full history, or filter by to_stage and a window to list recent stage changes across in-scope leads.',
  input_schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      to_stage: { type: 'array', items: { type: 'string' }, description: 'Only changes INTO these stage keys.' },
      since: { type: 'string', description: 'IST date YYYY-MM-DD. Default: scope lookback.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope, now } = ctx;
    const labels = await stageLabels(pool);
    if (input.contact_id != null && input.contact_id !== '') {
      const id = Number(input.contact_id);
      if (!(await leadInScope(pool, scope, id))) return err('out_of_scope', 'That lead does not exist or is outside this agent\'s data scope.');
      const { rows } = await pool.query(
        `SELECT ts, from_value, to_value, actor FROM coexistence.lead_events
          WHERE lead_id = $1 AND event_type = 'stage_changed' AND ts <= $2 ORDER BY ts, id`, [id, now]);
      return {
        contact_id: String(id),
        changes: rows.map((e, i) => ({
          from: e.from_value, to: e.to_value, to_label: labels.map.get(e.to_value)?.label || e.to_value,
          at: toIst(e.ts), actor: e.actor,
          hours_in_previous_stage: i === 0 ? null : Math.round(((new Date(e.ts) - new Date(rows[i - 1].ts)) / 36e5) * 10) / 10,
        })),
      };
    }
    const page = pageArgs(input);
    const floor = new Date(now.getTime() - scope.lookback_days * 864e5);
    let since = floor;
    if (input.since) {
      const d = parseInstant(input.since);
      if (!d) return err('invalid_input', 'since must be YYYY-MM-DD.');
      if (d > floor) since = d;
    }
    const { params, add } = binder();
    const toStages = strArr(input.to_stage);
    const { rows } = await pool.query(
      `SELECT e.lead_id, e.ts, e.from_value, e.to_value, e.actor, l.name, l.whatsapp_number, l.id,
              (SELECT p.ts FROM coexistence.lead_events p WHERE p.lead_id = e.lead_id AND p.event_type = 'stage_changed' AND (p.ts, p.id) < (e.ts, e.id) ORDER BY p.ts DESC, p.id DESC LIMIT 1) AS prev_ts
         FROM coexistence.lead_events e
         JOIN coexistence.leads l ON l.id = e.lead_id
        WHERE e.event_type = 'stage_changed' AND e.ts >= ${add(since)} AND e.ts <= ${add(now)}
          ${toStages.length ? `AND e.to_value = ANY(${add(toStages)}::text[])` : ''}
          ${leadScopeSql(scope, add)}
        ORDER BY e.ts DESC, e.id DESC LIMIT ${add(page.limit + 1)} OFFSET ${add(page.offset)}`, params);
    const { rows: out, next_cursor } = paginate(rows, page);
    return {
      changes: out.map(r => ({
        ...leadIdentity(r, scope), from: r.from_value, to: r.to_value, to_label: labels.map.get(r.to_value)?.label || r.to_value,
        at: toIst(r.ts), actor: r.actor,
        hours_in_previous_stage: r.prev_ts ? Math.round(((new Date(r.ts) - new Date(r.prev_ts)) / 36e5) * 10) / 10 : null,
      })),
      next_cursor,
    };
  },
};

const PERIODS = ['last_7_days', 'last_14_days', 'last_30_days', 'this_month', 'last_month', 'custom'];
const GROUPS = ['none', 'source', 'rep', 'week'];

function periodRange(period, input, now) {
  const day = 864e5;
  const todayIst = istDate(now);
  const startOfIstDay = (s) => new Date(`${s}T00:00:00+05:30`);
  switch (period) {
    case 'last_7_days': return { from: new Date(now - 7 * day), to: now };
    case 'last_14_days': return { from: new Date(now - 14 * day), to: now };
    case 'last_30_days': return { from: new Date(now - 30 * day), to: now };
    case 'this_month': return { from: startOfIstDay(`${todayIst.slice(0, 7)}-01`), to: now };
    case 'last_month': {
      const [y, m] = todayIst.split('-').map(Number);
      const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
      return { from: startOfIstDay(`${py}-${String(pm).padStart(2, '0')}-01`), to: startOfIstDay(`${todayIst.slice(0, 7)}-01`) };
    }
    default: {
      const from = parseInstant(input.from); const to = parseInstant(input.to, { endOfDay: true });
      if (!from || !to) return null;
      return { from, to: to > now ? now : to };
    }
  }
}

const getFunnelSummary = {
  key: 'get_funnel_summary',
  category: 'Leads & funnel',
  kind: 'read',
  title: 'Funnel summary',
  description: 'Funnel counts and stage-to-stage conversion for in-scope leads. current_by_stage = where leads are now. cohort = leads created in the period, with how many reached each funnel stage (from stage history) and the conversion between consecutive stages. group_by splits the cohort by source, rep (owner) or ISO week of creation.',
  input_schema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: PERIODS, description: 'Default last_30_days. custom needs from/to.' },
      from: { type: 'string', description: 'IST date for period=custom.' },
      to: { type: 'string', description: 'IST date for period=custom (inclusive).' },
      group_by: { type: 'string', enum: GROUPS },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope, now } = ctx;
    const period = input.period || 'last_30_days';
    if (!PERIODS.includes(period)) return err('invalid_input', `period must be one of ${PERIODS.join(', ')}.`);
    const groupBy = input.group_by || 'none';
    if (!GROUPS.includes(groupBy)) return err('invalid_input', `group_by must be one of ${GROUPS.join(', ')}.`);
    const range = periodRange(period, input, now);
    if (!range) return err('invalid_input', 'period=custom needs valid from and to dates (YYYY-MM-DD).');
    const labels = await stageLabels(pool);
    const funnel = labels.list.filter(s => s.is_funnel);

    const { params, add } = binder();
    const scopeSql = leadScopeSql(scope, add, { ownerExpr: 'o.owner' });
    const { rows: current } = await pool.query(
      `SELECT l.stage, COUNT(*)::int AS n FROM coexistence.leads l
        CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
        WHERE TRUE ${scopeSql} GROUP BY l.stage`, params);

    const b = binder();
    const scopeSql2 = leadScopeSql(scope, b.add, { ownerExpr: 'o.owner' });
    const { rows: cohort } = await pool.query(
      `SELECT l.id, l.stage, l.source, o.owner, l.created_at,
              to_char(date_trunc('week', l.created_at AT TIME ZONE 'Asia/Kolkata'), 'IYYY-"W"IW') AS week,
              COALESCE((SELECT array_agg(DISTINCT e.to_value) FROM coexistence.lead_events e
                         WHERE e.lead_id = l.id AND e.event_type = 'stage_changed' AND e.ts <= ${b.add(now)}), '{}') AS reached
         FROM coexistence.leads l
         CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
        WHERE l.created_at >= ${b.add(range.from)} AND l.created_at < ${b.add(range.to)} ${scopeSql2}`, b.params);

    const orderOf = new Map(funnel.map((s, i) => [s.stage_key, i]));
    const maxReached = (r) => {
      let m = -1;
      for (const k of [...(r.reached || []), r.stage]) if (orderOf.has(k)) m = Math.max(m, orderOf.get(k));
      return m;
    };
    const summarise = (rows) => {
      const reached = funnel.map((s, i) => ({ stage_key: s.stage_key, label: s.label, reached: rows.filter(r => maxReached(r) >= i).length }));
      return {
        leads: rows.length,
        reached,
        conversion: reached.slice(0, -1).map((s, i) => ({
          from: s.stage_key, to: reached[i + 1].stage_key,
          pct: s.reached ? Math.round((reached[i + 1].reached / s.reached) * 1000) / 10 : null,
        })),
        won: rows.filter(r => labels.map.get(r.stage)?.is_won).length,
      };
    };
    let groups = null;
    if (groupBy !== 'none') {
      const keyOf = groupBy === 'source' ? (r) => r.source || '(none)' : groupBy === 'rep' ? (r) => (r.owner == null ? 'unassigned' : String(r.owner)) : (r) => r.week;
      const m = new Map();
      for (const r of cohort) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      groups = [...m.entries()].map(([k, rows]) => ({
        group: groupBy === 'rep' ? repRef(ctx.users, k === 'unassigned' ? null : k) : k,
        ...summarise(rows),
      })).sort((a, b2) => b2.leads - a.leads);
    }
    return {
      period, from: toIst(range.from), to: toIst(range.to),
      current_by_stage: labels.list.map(s => ({ stage_key: s.stage_key, label: s.label, leads: current.find(c => c.stage === s.stage_key)?.n || 0 })),
      cohort: summarise(cohort),
      groups,
      note: 'Conversion counts a lead as reaching a stage if its stage history or current stage is at or past it. Cold/Lost is a branch, not a funnel step.',
    };
  },
};

module.exports = {
  tools: [listLeads, getLeadProfile, getStageHistory, getFunnelSummary],
  stageLabels, PAYMENTS_SQL, TAGS_LATERAL, ACTIVITY_LATERAL, flowRunShape, nodeTitle, maskPhone, maskName, paiseToRupees, formatInr,
};
