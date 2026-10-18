// Sales tools. Money comes from the SAME union the Sales Log uses: deduped captured
// Razorpay webhook payments matched to a lead (RZP_CAPTURED semantics) plus manual
// sales_log rows. razorpay_payments (the ledger) is never merged in — its lead
// match is only a hint (DATA_MAP §2.4).

const { toIst } = require('../format');
const { OWNER_SQL } = require('../sql');
const { leadScopeSql } = require('../scope');
const { derivePaymentStatus } = require('../../paymentStatus');
const { err, binder, pageArgs, paginate, windowArgs, leadIdentity, money, repRef } = require('./common');
const { stageLabels } = require('./leads');

const TYPES = ['new_admission', 'full', 'partial', 'balance'];

/** Every payment for in-scope leads, with its ordinal per lead (for payment_type). */
const ALL_PAYMENTS_CTE = `
  pay AS (
    SELECT rz.lead_id, rz.amount_paise, rz.created_at AS paid_at, rz.method, 'gateway' AS kind, rz.payment_id AS reference,
           NULL::bigint AS course_id
      FROM (
        SELECT DISTINCT ON (COALESCE(payment_id, 'evt'||id::text)) matched_lead_id AS lead_id, amount_paise, created_at, method, payment_id
          FROM coexistence.razorpay_events
         WHERE status = 'captured' AND matched_lead_id IS NOT NULL
         ORDER BY COALESCE(payment_id, 'evt'||id::text), (event_type = 'payment.captured') DESC, id
      ) rz
    UNION ALL
    SELECT sl.lead_id, sl.amount_paise, (sl.payment_date::timestamp AT TIME ZONE 'Asia/Kolkata'), sl.method, 'manual', 'sales_log:'||sl.id, sl.course_id
      FROM coexistence.sales_log sl WHERE sl.lead_id IS NOT NULL
  ),
  ordered AS (
    SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.lead_id ORDER BY p.paid_at, p.reference) AS nth,
           SUM(p.amount_paise) OVER (PARTITION BY p.lead_id ORDER BY p.paid_at, p.reference) AS running_paise
      FROM pay p
  )`;

function paymentType(row, pricePaise) {
  const price = Number(pricePaise || 0);
  if (Number(row.nth) === 1) {
    if (price > 0 && Number(row.amount_paise) >= price) return 'full';
    return 'new_admission';
  }
  if (price > 0 && Number(row.running_paise) >= price) return 'balance';
  return 'partial';
}

const getSales = {
  key: 'get_sales',
  category: 'Sales',
  kind: 'read',
  title: 'Sales',
  description: 'Payments received from in-scope leads in a window (gateway + manual Sales Log), with product, amount, method and a derived payment_type: new_admission (first payment, below full price), full (first payment covering the price), partial (a later payment still short of the price) or balance (the payment that completed it). Summary counts admissions as DISTINCT customers, never transactions. GST and closed-by rep are NOT recorded in this workspace: gst and closed_by_rep_id are null, and revenue cannot be attributed to a rep.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'IST date YYYY-MM-DD. Default and floor: the scope lookback.' },
      to: { type: 'string', description: 'IST date YYYY-MM-DD, inclusive. Default: today.' },
      product: { type: 'string', description: 'Product name, case-insensitive.' },
      type: { type: 'string', enum: TYPES },
      rep_id: { type: 'string', description: 'Not supported: closed-by rep is not recorded. Passing it returns an explanation.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  overridable: [{ key: 'limit', type: 'number', mode: 'cap', label: 'Maximum payments per call' }],
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    if (input.rep_id) {
      return err('not_recorded', 'The rep who closed a sale is not recorded in this workspace, so sales cannot be filtered or attributed by rep. Use get_outstanding_balances for owner-based follow-up.');
    }
    if (input.type && !TYPES.includes(input.type)) return err('invalid_input', `type must be one of ${TYPES.join(', ')}.`);
    const win = windowArgs({ since: input.from, until: input.to }, ctx);
    if (win.error) return win;
    const page = pageArgs(input, { cap: ctx.caps?.limit });
    const { params, add } = binder();
    const { rows } = await pool.query(
      `WITH ${ALL_PAYMENTS_CTE}
       SELECT o.*, l.id, l.name, l.whatsapp_number, l.paid_course, l.stage, l.source,
              COALESCE(pc.name, lc.name, l.paid_course) AS product_name,
              COALESCE(pc.default_price_paise, lc.default_price_paise) AS price_paise
         FROM ordered o
         JOIN coexistence.leads l ON l.id = o.lead_id
         LEFT JOIN coexistence.courses pc ON pc.id = o.course_id
         LEFT JOIN LATERAL (SELECT c.name, c.default_price_paise FROM coexistence.courses c
                             WHERE lower(btrim(c.name)) = lower(btrim(l.paid_course)) ORDER BY c.id LIMIT 1) lc ON TRUE
        WHERE o.paid_at >= ${add(win.since)} AND o.paid_at < ${add(win.until)}
          ${input.product ? `AND lower(btrim(COALESCE(pc.name, lc.name, l.paid_course, ''))) = ${add(String(input.product).toLowerCase().trim())}` : ''}
          ${leadScopeSql(scope, add)}
        ORDER BY o.paid_at DESC, o.reference`, params);
    const typed = rows.map(r => ({ ...r, payment_type: paymentType(r, r.price_paise) }))
      .filter(r => !input.type || r.payment_type === input.type);

    const total = typed.reduce((s, r) => s + Number(r.amount_paise), 0);
    const admissions = new Set(typed.filter(r => r.payment_type === 'new_admission' || r.payment_type === 'full').map(r => r.lead_id));
    const byProduct = {};
    for (const r of typed) {
      const k = r.product_name || '(no product)';
      byProduct[k] = byProduct[k] || { product: k, transactions: 0, customers: new Set(), paise: 0 };
      byProduct[k].transactions += 1; byProduct[k].customers.add(r.lead_id); byProduct[k].paise += Number(r.amount_paise);
    }
    const sliced = typed.slice(page.offset, page.offset + page.limit + 1);
    const { rows: pageRows, next_cursor } = paginate(sliced, page);
    const { rows: [refunds] } = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_refunded_paise), 0) AS paise FROM coexistence.razorpay_payments
        WHERE amount_refunded_paise > 0 AND paid_at >= $1 AND paid_at < $2`, [win.since, win.until]);
    return {
      window: { from: toIst(win.since), to: toIst(win.until), clamped_to_lookback: win.clamped },
      summary: {
        collected: money(total),
        transactions: typed.length,
        admissions_distinct_customers: admissions.size,
        paying_customers_distinct: new Set(typed.map(r => r.lead_id)).size,
        by_product: Object.values(byProduct).map(p => ({ product: p.product, transactions: p.transactions, customers: p.customers.size, collected: money(p.paise) })),
        refunds_ledger: { count: refunds.n, amount: money(refunds.paise), note: 'From the Razorpay ledger; its lead match is a hint, so refunds are not netted against in-scope sales.' },
        gst: null,
        closed_by_rep: null,
      },
      payments: pageRows.map(r => ({
        ...leadIdentity(r, scope),
        product: r.product_name || null, amount: money(r.amount_paise), gst: null,
        paid_at: toIst(r.paid_at), method: r.method || null, recorded_via: r.kind, payment_type: r.payment_type,
        closed_by_rep_id: null,
      })),
      next_cursor,
    };
  },
};

const getOutstandingBalances = {
  key: 'get_outstanding_balances',
  category: 'Sales',
  kind: 'read',
  title: 'Outstanding balances',
  description: 'In-scope customers at a won stage who still owe money: product price minus everything paid (gateway + manual), honouring a manual payment-status override. Includes last payment date and owner rep. Products with no price cannot produce a balance and are listed under price_unknown.',
  input_schema: {
    type: 'object',
    properties: {
      rep_id: { type: 'string', description: 'Owner rep user id, or "unassigned".' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const page = pageArgs(input, { cap: ctx.caps?.limit });
    const { params, add } = binder();
    const ownerWhere = [];
    if (input.rep_id != null && input.rep_id !== '') {
      if (String(input.rep_id).toLowerCase() === 'unassigned') ownerWhere.push('o.owner IS NULL');
      else if (/^\d+$/.test(String(input.rep_id))) ownerWhere.push(`o.owner = ${add(Number(input.rep_id))}`);
      else return err('invalid_input', 'rep_id must be a rep user id or "unassigned".');
    }
    const { rows } = await pool.query(
      `WITH ${ALL_PAYMENTS_CTE}
       SELECT l.id, l.name, l.whatsapp_number, l.paid_course, l.payment_status, o.owner,
              c.default_price_paise AS price_paise,
              COALESCE((SELECT SUM(p.amount_paise) FROM pay p WHERE p.lead_id = l.id), 0) AS paid_paise,
              (SELECT MAX(p.paid_at) FROM pay p WHERE p.lead_id = l.id) AS last_paid_at
         FROM coexistence.leads l
         CROSS JOIN LATERAL (SELECT ${OWNER_SQL('l')} AS owner) o
         LEFT JOIN LATERAL (SELECT cc.default_price_paise FROM coexistence.courses cc
                             WHERE lower(btrim(cc.name)) = lower(btrim(l.paid_course)) ORDER BY cc.id LIMIT 1) c ON TRUE
        WHERE l.stage IN (SELECT stage_key FROM coexistence.funnel_stages WHERE is_won AND active)
          ${ownerWhere.length ? `AND ${ownerWhere.join(' AND ')}` : ''}
          ${leadScopeSql(scope, add, { ownerExpr: 'o.owner' })}
        ORDER BY l.id`, params);
    const owing = [];
    const priceUnknown = [];
    for (const r of rows) {
      const s = derivePaymentStatus({ override: r.payment_status, totalPaidPaise: r.paid_paise, pricePaise: r.price_paise });
      const base = {
        ...leadIdentity(r, scope), product: r.paid_course || null, ...repRef(ctx.users, r.owner),
        paid: money(r.paid_paise), last_payment_at: toIst(r.last_paid_at), payment_status: s.status, status_source: s.source,
      };
      if (s.outstandingPaise == null) { if (s.status !== 'paid') priceUnknown.push(base); continue; }
      if (s.outstandingPaise > 0) owing.push({ ...base, price: money(r.price_paise), outstanding: money(s.outstandingPaise) });
    }
    owing.sort((a, b) => b.outstanding.rupees - a.outstanding.rupees);
    const sliced = owing.slice(page.offset, page.offset + page.limit + 1);
    const { rows: pageRows, next_cursor } = paginate(sliced, page);
    return {
      total_outstanding: money(owing.reduce((s, r) => s + Math.round(r.outstanding.rupees * 100), 0)),
      customers_owing: owing.length,
      balances: pageRows,
      price_unknown: priceUnknown.slice(0, 50),
      next_cursor,
    };
  },
};

module.exports = { tools: [getSales, getOutstandingBalances], paymentType, ALL_PAYMENTS_CTE, stageLabels };
