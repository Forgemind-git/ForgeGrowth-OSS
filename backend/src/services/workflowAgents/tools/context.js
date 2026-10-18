// Context tools: the workspace, the team, and the agent's own memory, outputs and feedback.

const { toIst, istDate, istHuman, paiseToRupees, formatInr } = require('../format');
const { OWNER_SQL } = require('../sql');
const { leadScopeSql, isAll } = require('../scope');
const { err, binder, idList, strArr, repRef } = require('./common');

const MEMORY_KINDS = ['pinned', 'learned', 'contact', 'glossary'];

async function loadSettings(pool) {
  const { rows } = await pool.query(`SELECT * FROM coexistence.workflow_agent_settings WHERE id = 1`);
  return rows[0] || {};
}

async function activeMemory(pool, agentId, { kinds = MEMORY_KINDS, leadIds = [], now = new Date() } = {}) {
  const { params, add } = binder();
  const clauses = [
    `m.agent_id = ${add(agentId)}`,
    `m.status = 'active'`,
    `(m.expires_at IS NULL OR m.expires_at > ${add(now)})`,
    `m.kind = ANY(${add(kinds)}::text[])`,
  ];
  // Contact memory only for the leads in focus.
  clauses.push(`(m.kind <> 'contact' OR m.lead_id = ANY(${add(leadIds)}::bigint[]))`);
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, m.lead_id, m.title, m.content, m.source, m.updated_at
       FROM coexistence.workflow_agent_memory m
      WHERE ${clauses.join(' AND ')}
      ORDER BY CASE m.kind WHEN 'pinned' THEN 0 WHEN 'glossary' THEN 1 WHEN 'learned' THEN 2 ELSE 3 END, m.id`,
    params);
  return rows.map(r => ({
    memory_id: String(r.id), kind: r.kind, contact_id: r.lead_id == null ? null : String(r.lead_id),
    title: r.title, content: r.content, source: r.source, updated_at: toIst(r.updated_at),
  }));
}

const getWorkspaceContext = {
  key: 'get_workspace_context',
  category: 'Context',
  kind: 'read',
  title: 'Workspace context',
  description: 'Call this FIRST. Returns the business name, products and prices, funnel stage definitions (in order, with the won stage marked), lead sources, reps and teams, business WhatsApp numbers, working hours, currency, timezone, today\'s date in IST, the glossary, the data scope you are limited to, and known data gaps. Rep owners are user ids; a null owner means Unassigned.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const { pool, scope, now } = ctx;
    const settings = ctx.settings || await loadSettings(pool);
    const [products, stages, sources, teams, glossary] = await Promise.all([
      pool.query(`SELECT id, name, default_price_paise, active FROM coexistence.courses ORDER BY active DESC, name`),
      pool.query(`SELECT stage_key, label, order_index, is_funnel, is_won FROM coexistence.funnel_stages WHERE active ORDER BY order_index, id`),
      pool.query(`SELECT label FROM coexistence.funnel_sources WHERE active ORDER BY label`),
      pool.query(`SELECT t.id, t.name, t.lead_user_id FROM coexistence.rep_teams t ORDER BY t.name`),
      activeMemory(pool, ctx.agent.id, { kinds: ['glossary'], now }),
    ]);
    const users = [...ctx.users.values()].filter(u => u.active);

    // Measure the owner gap instead of assuming it (DATA_MAP §0.1).
    const { params, add } = binder();
    const scopeSql = leadScopeSql(scope, add);
    const { rows: [own] } = await pool.query(
      `SELECT COUNT(*)::int AS leads, COUNT(o.owner)::int AS with_owner
         FROM coexistence.leads l
         CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
        WHERE TRUE ${scopeSql}`, params);

    const dataGaps = [
      'Closed-by rep, GST and payment type are not recorded on sales; revenue cannot be attributed to a rep yet.',
      'Most outgoing messages do not record which human sent them; sender_type is inferred and sometimes "unattributed".',
      'Voice notes are transcribed on demand only; untranscribed notes return transcript: null.',
      'Revenue per ad is not attributable. Ad spend is pre-GST; use spend_incl_gst for cost.',
    ];
    if (own.leads && own.with_owner === 0) dataGaps.unshift(`None of the ${own.leads} in-scope leads has an owner rep yet; group them under "unassigned".`);

    const businessName = settings.business_name
      || ctx.accounts.list.find(a => a.is_active)?.display_name || 'this business';

    return {
      business_name: businessName,
      today_ist: istDate(now),
      now_ist: toIst(now),
      now_human: istHuman(now),
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      products: products.rows.map(p => ({
        product_id: String(p.id), name: p.name, active: p.active,
        price_rupees: paiseToRupees(p.default_price_paise), price_display: formatInr(paiseToRupees(p.default_price_paise)),
      })),
      funnel_stages: stages.rows.map(s => ({ stage_key: s.stage_key, label: s.label, order: s.order_index, is_funnel: s.is_funnel, is_won: s.is_won })),
      sources: sources.rows.map(s => s.label),
      reps: users.map(u => ({ rep_user_id: u.id, name: u.name, role: u.role, team_id: u.team_id, employee_id: u.employee_id })),
      teams: teams.rows.map(t => ({ team_id: String(t.id), name: t.name, lead_user_id: t.lead_user_id == null ? null : String(t.lead_user_id) })),
      business_numbers: ctx.accounts.list.filter(a => isAll(scope.business_numbers) || scope.business_numbers.includes(a.display_phone_number))
        .map(a => ({ business_number_id: String(a.id), label: a.display_name, active: a.is_active })),
      working_hours_default: settings.default_working_hours || { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' },
      glossary: glossary.map(g => ({ term: g.title, meaning: g.content })),
      data_scope: {
        lookback_days: scope.lookback_days,
        chat_types: scope.chat_types,
        funnel_stages: scope.funnel_stages,
        sources: scope.sources,
        business_numbers: isAll(scope.business_numbers) ? ['all'] : scope.business_numbers.map(n => ctx.accounts.byNumber.get(n)?.id).filter(Boolean),
        rep_user_ids: scope.rep_user_ids,
        teams: scope.teams,
        pii_masked: scope.mask_pii,
        excludes_opted_out: scope.exclude_opted_out,
        excluded_tags: scope.exclude_tags,
        won_stages: scope.won_stages,
      },
      lead_counts: { in_scope: own.leads, with_owner: own.with_owner },
      data_gaps: dataGaps,
    };
  },
};

const getRepDirectory = {
  key: 'get_rep_directory',
  category: 'Context',
  kind: 'read',
  title: 'Rep directory',
  description: 'Reps (user id, name, role, team, employee id), teams and their leads, which business WhatsApp numbers each rep owns now and in the lookback window (assignment history), working hours, and each rep\'s current open-lead load (in-scope leads not at a won or cold/lost stage). Identify reps by rep_user_id only.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const { pool, scope, now } = ctx;
    const since = new Date(now.getTime() - scope.lookback_days * 24 * 3600 * 1000);
    const [users, teams, assignments] = await Promise.all([
      pool.query(`SELECT id, COALESCE(display_name, username) AS name, role, is_active, team_id, employee_id, working_hours FROM coexistence.forgecrm_users ORDER BY id`),
      pool.query(`SELECT id, name, lead_user_id FROM coexistence.rep_teams ORDER BY name`),
      pool.query(`SELECT whatsapp_account_id, user_id, valid_from, valid_to FROM coexistence.rep_number_assignments
                   WHERE valid_to IS NULL OR valid_to > $1 ORDER BY valid_from`, [since]),
    ]);
    const { params, add } = binder();
    const scopeSql = leadScopeSql(scope, add);
    const { rows: load } = await pool.query(
      `SELECT o.owner, COUNT(*)::int AS open_leads
         FROM coexistence.leads l
         CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
        WHERE l.stage NOT IN (SELECT stage_key FROM coexistence.funnel_stages WHERE is_won OR NOT is_funnel) ${scopeSql}
        GROUP BY o.owner`, params);
    const loadBy = new Map(load.map(r => [r.owner == null ? 'unassigned' : String(r.owner), r.open_leads]));
    const defaultHours = (ctx.settings || await loadSettings(pool)).default_working_hours;
    return {
      reps: users.rows.map(u => ({
        rep_user_id: String(u.id), name: u.name, role: u.role, active: u.is_active,
        team_id: u.team_id == null ? null : String(u.team_id), employee_id: u.employee_id || null,
        working_hours: u.working_hours || defaultHours,
        working_hours_source: u.working_hours ? 'rep' : 'workspace_default',
        numbers: assignments.rows.filter(a => String(a.user_id) === String(u.id)).map(a => ({
          business_number_id: String(a.whatsapp_account_id),
          label: ctx.accounts.byId.get(String(a.whatsapp_account_id))?.label || null,
          from: toIst(a.valid_from), to: toIst(a.valid_to), current: a.valid_to == null,
        })),
        open_lead_load: loadBy.get(String(u.id)) || 0,
      })),
      teams: teams.rows.map(t => {
        const lead = repRef(ctx.users, t.lead_user_id);
        return { team_id: String(t.id), name: t.name, lead_user_id: lead.rep_user_id, lead_name: t.lead_user_id == null ? null : lead.rep_name };
      }),
      unassigned_open_leads: loadBy.get('unassigned') || 0,
      numbers_without_rep: ctx.accounts.list
        .filter(a => !assignments.rows.some(x => String(x.whatsapp_account_id) === String(a.id) && x.valid_to == null))
        .map(a => ({ business_number_id: String(a.id), label: a.display_name })),
    };
  },
};

const readMemory = {
  key: 'read_memory',
  category: 'Agent',
  kind: 'read',
  title: 'Read memory',
  description: 'Active memory items for this agent: pinned rules first, then glossary, learned patterns, and per-lead contact memory for the contact_ids you pass. Pinned and learned memory is already in your context at the start of the run; call this for contact memory of specific leads.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'array', items: { type: 'string', enum: MEMORY_KINDS }, description: 'Kinds to return. Default: all.' },
      contact_ids: { type: 'array', items: { type: 'string' }, description: 'Lead ids whose contact memory you want.' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const kinds = strArr(input.kind).filter(k => MEMORY_KINDS.includes(k));
    const leadIds = idList(input.contact_ids);
    const items = await activeMemory(ctx.pool, ctx.agent.id, { kinds: kinds.length ? kinds : MEMORY_KINDS, leadIds, now: ctx.now });
    return { items, count: items.length };
  },
};

const OUTPUT_CHAR_CAP = 40000;

const getPreviousOutputs = {
  key: 'get_previous_outputs',
  category: 'Agent',
  kind: 'read',
  title: 'Previous outputs',
  description: 'This agent\'s last N successful (non-test) run outputs, newest first, so you can compare with yesterday and avoid repeating a lead that has had no new activity since.',
  input_schema: {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: 10, description: 'How many runs (default 3, max 10).' } },
    additionalProperties: false,
  },
  overridable: [{ key: 'n', type: 'number', mode: 'cap', label: 'Maximum runs' }],
  async handler(input, ctx) {
    let n = Number(input.n);
    if (!Number.isInteger(n) || n < 1) n = 3;
    n = Math.min(n, 10);
    const { rows } = await ctx.pool.query(
      `SELECT id, trigger_type, finished_at, output FROM coexistence.workflow_agent_runs
        WHERE agent_id = $1 AND status = 'succeeded' AND dry_run = FALSE AND output IS NOT NULL
          AND ($2::bigint IS NULL OR id <> $2) AND finished_at <= $3
        ORDER BY finished_at DESC LIMIT $4`,
      [ctx.agent.id, ctx.runId || null, ctx.now, n]);
    return {
      runs: rows.map(r => {
        const text = JSON.stringify(r.output);
        return {
          run_id: String(r.id), trigger_type: r.trigger_type, finished_at: toIst(r.finished_at),
          output: text.length > OUTPUT_CHAR_CAP ? null : r.output,
          output_truncated: text.length > OUTPUT_CHAR_CAP ? `${text.slice(0, OUTPUT_CHAR_CAP)}…` : undefined,
        };
      }),
    };
  },
};

const getFeedback = {
  key: 'get_feedback',
  category: 'Agent',
  kind: 'read',
  title: 'Rep feedback',
  description: 'Feedback reps gave on this agent\'s past outputs (useful / not_useful / converted / wrong, plus what they did: called, messaged, converted, not_interested, wrong_signal). Use leads marked "wrong" to learn what to down-weight.',
  input_schema: {
    type: 'object',
    properties: { since: { type: 'string', description: 'IST date YYYY-MM-DD. Default: the scope lookback.' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    let since = new Date(ctx.now.getTime() - ctx.scope.lookback_days * 24 * 3600 * 1000);
    if (input.since) {
      const d = new Date(`${String(input.since).slice(0, 10)}T00:00:00+05:30`);
      if (Number.isNaN(d.getTime())) return err('invalid_input', 'since must be YYYY-MM-DD.');
      if (d > since) since = d;
    }
    const { rows } = await ctx.pool.query(
      `SELECT f.id, f.run_id, f.lead_id, f.item_ref, f.rating, f.outcome, f.comment, f.user_id, f.created_at
         FROM coexistence.workflow_agent_feedback f
        WHERE f.agent_id = $1 AND f.created_at >= $2 AND f.created_at <= $3
        ORDER BY f.created_at DESC LIMIT 200`, [ctx.agent.id, since, ctx.now]);
    const counts = {};
    for (const r of rows) counts[r.rating] = (counts[r.rating] || 0) + 1;
    return {
      counts,
      items: rows.map(r => ({
        feedback_id: String(r.id), run_id: r.run_id == null ? null : String(r.run_id),
        contact_id: r.lead_id == null ? null : String(r.lead_id), item_ref: r.item_ref,
        rating: r.rating, outcome: r.outcome, comment: r.comment,
        ...repRef(ctx.users, r.user_id), created_at: toIst(r.created_at),
      })),
    };
  },
};

module.exports = {
  tools: [getWorkspaceContext, getRepDirectory, readMemory, getPreviousOutputs, getFeedback],
  activeMemory, loadSettings, MEMORY_KINDS,
};
