// ─── Per-product totals, read FROM THE SALES LOG ──────────────────────────────
//
// ⚠ WHY THIS FILE EXISTS. A product's sales are the leads at the won stage whose
// Product (`leads.paid_course`) names it, with per-transaction overrides on
// `sales_log.course_id`. Independent attribution paths over the same money
// disagree by construction, so this is the ONE place that mapping lives. Three call sites read it (the products
// list, the revenue endpoint, and the MCP `get_product_revenue` tool) — each of
// them previously carried its own copy of the old query, which is exactly how
// a number drifts away from the page it is supposed to agree with.
//
// The mapping, stated once:
//   sale        = a lead at a won stage (what GET /students lists)
//   its product = the product whose NAME equals leads.paid_course
//   transaction = a sales_log row for that lead
//   a transaction's product = its own course_id when set, otherwise the sale's
//                 ("— Same as enrolment —", the literal wording in the
//                 Add Transaction modal)
//
// ⚠ The lead→product link is by NAME, not by id: `leads.paid_course` is TEXT.
// That is the column the Sales Log itself reads, so matching it is what keeps
// the two pages equal — but it means renaming a product orphans the sales
// already recorded under the old name (they fall into `unattributed` rather
// than silently landing on another product). Compare case/space-insensitively
// so trailing whitespace alone can't split a product in two.

const pool = require('../db');

// Built lazily: routes/leads.js owns the won-stage definition, and importing it
// at module load would fix a require order this service does not need to care about.
function leadsHelpers() {
  const { SALE_STAGE_KEYS } = require('../routes/leads');
  return { SALE_STAGE_KEYS };
}

// The shared CTE chain. $1 is the won-stage key array.
function salesLogCte() {
  return `
    sales AS (
      SELECT l.id AS lead_id, c.id AS product_id
        FROM coexistence.leads l
        LEFT JOIN coexistence.courses c
               ON lower(btrim(c.name)) = lower(btrim(l.paid_course))
       WHERE l.stage = ANY($1)
    ),
    txns AS (
      SELECT COALESCE(sl.course_id, s.product_id) AS product_id, sl.amount_paise
        FROM coexistence.sales_log sl
        JOIN sales s ON s.lead_id = sl.lead_id
    )`;
}

// One row per product: how many sales the Sales Log holds for it, how many
// transactions those sales carry, and what was collected.
async function productTotals() {
  const { SALE_STAGE_KEYS } = leadsHelpers();
  const { rows } = await pool.query(
    `WITH ${salesLogCte()}
     SELECT c.id, c.name, c.active,
            (SELECT COUNT(*) FROM sales s WHERE s.product_id = c.id)::int                      AS sales_count,
            (SELECT COUNT(*) FROM txns  t WHERE t.product_id = c.id)::int                      AS payment_count,
            (SELECT COALESCE(SUM(t.amount_paise), 0) FROM txns t WHERE t.product_id = c.id)::bigint AS revenue_paise
       FROM coexistence.courses c
      ORDER BY revenue_paise DESC, c.name`,
    [SALE_STAGE_KEYS()],
  );
  return rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    active: r.active,
    sales_count: r.sales_count,
    payment_count: r.payment_count,
    revenue_paise: Number(r.revenue_paise),
  }));
}

// Sales whose Product is not set, so their money is in no product's totals —
// open the sale and pick its Product.
async function unattributedTotals() {
  const { SALE_STAGE_KEYS } = leadsHelpers();
  const { rows: [u] } = await pool.query(
    `WITH ${salesLogCte()}
     SELECT (SELECT COUNT(*) FROM sales WHERE product_id IS NULL)::int                            AS sales_count,
            (SELECT COUNT(*) FROM txns  WHERE product_id IS NULL)::int                            AS payment_count,
            (SELECT COALESCE(SUM(amount_paise), 0) FROM txns WHERE product_id IS NULL)::bigint    AS revenue_paise`,
    [SALE_STAGE_KEYS()],
  );
  return {
    unattributed: {
      sales_count: u.sales_count,
      payment_count: u.payment_count,
      revenue_paise: Number(u.revenue_paise),
    },
  };
}

/**
 * Sales-log totals for the Home dashboard.
 *
 * ⚠ Lives HERE, not in dashboard.js, so the home page cannot report a different
 * revenue figure from the Products page and the Sales Log. Those three answer
 * the same question and must share one implementation — independent queries
 * answer subtly different questions under the same name and all look correct.
 *
 * A "sale" is a lead at a won stage (`SALE_STAGE_KEYS`, never re-derived); a
 * transaction is a sales_log row for it.
 *
 * `uid` scopes to one BDA's own leads (null = org-wide).
 */
async function salesSummary({ days, uid = null }) {
  const { SALE_STAGE_KEYS } = leadsHelpers();
  const scope = uid == null ? '' : ' AND l.assigned_user_id = $3';
  const params = uid == null ? [SALE_STAGE_KEYS(), days] : [SALE_STAGE_KEYS(), days, uid];

  // `won_at` does not exist on leads, so a sale is dated by when the lead was
  // last updated into its won stage… which is unreliable. The transactions are
  // dated precisely, so revenue is windowed on the PAYMENT date and the sale
  // count on the lead's own created_at — each on the timestamp it actually has.
  const { rows } = await pool.query(
    `WITH sales AS (
       SELECT l.id AS lead_id, l.created_at
         FROM coexistence.leads l
        WHERE l.stage = ANY($1)${scope}
     ),
     txns AS (
       SELECT sl.amount_paise, sl.created_at AS paid_at
         FROM coexistence.sales_log sl
         JOIN sales s ON s.lead_id = sl.lead_id
     )
     SELECT
       (SELECT COUNT(*) FROM sales)::int                                                        AS total_sales,
       (SELECT COUNT(*) FROM sales WHERE created_at >= NOW() - ($2 * INTERVAL '1 day'))::int     AS new_sales,
       (SELECT COUNT(*) FROM sales WHERE created_at >= NOW() - ($2 * INTERVAL '1 day') * 2
                                     AND created_at <  NOW() - ($2 * INTERVAL '1 day'))::int     AS prev_sales,
       (SELECT COALESCE(SUM(amount_paise),0) FROM txns)::bigint                                  AS total_paise,
       (SELECT COALESCE(SUM(amount_paise),0) FROM txns
         WHERE paid_at >= NOW() - ($2 * INTERVAL '1 day'))::bigint                               AS range_paise,
       (SELECT COALESCE(SUM(amount_paise),0) FROM txns
         WHERE paid_at >= NOW() - ($2 * INTERVAL '1 day') * 2
           AND paid_at <  NOW() - ($2 * INTERVAL '1 day'))::bigint                               AS prev_paise,
       (SELECT COUNT(*) FROM txns WHERE paid_at >= NOW() - ($2 * INTERVAL '1 day'))::int         AS range_payments`,
    params,
  );
  const r = rows[0] || {};
  return {
    totalSales: r.total_sales || 0,
    newSales: r.new_sales || 0,
    prevSales: r.prev_sales || 0,
    totalPaise: Number(r.total_paise || 0),
    rangePaise: Number(r.range_paise || 0),
    prevPaise: Number(r.prev_paise || 0),
    rangePayments: r.range_payments || 0,
  };
}

/** The most recent sales, for the Home "Latest sales" strip. */
async function recentSales({ limit = 6, uid = null }) {
  const { SALE_STAGE_KEYS } = leadsHelpers();
  const scope = uid == null ? '' : ' AND l.assigned_user_id = $2';
  const params = uid == null ? [SALE_STAGE_KEYS()] : [SALE_STAGE_KEYS(), uid];
  const { rows } = await pool.query(
    `WITH sales AS (
       SELECT l.id AS lead_id, l.name, l.whatsapp_number, l.paid_course, l.created_at
         FROM coexistence.leads l
        WHERE l.stage = ANY($1)${scope}
     ),
     paid AS (
       SELECT s.lead_id, SUM(t.amount_paise)::bigint AS paise, MAX(t.paid_at) AS last_paid
         FROM sales s
         JOIN (
           SELECT sl.lead_id, sl.amount_paise, sl.created_at AS paid_at
             FROM coexistence.sales_log sl
         ) t ON t.lead_id = s.lead_id
        GROUP BY s.lead_id
     )
     SELECT s.lead_id, s.name, s.whatsapp_number, s.paid_course, s.created_at,
            COALESCE(p.paise, 0)::bigint AS paise, p.last_paid
       FROM sales s
       LEFT JOIN paid p ON p.lead_id = s.lead_id
      ORDER BY COALESCE(p.last_paid, s.created_at) DESC
      LIMIT ${Math.max(1, Math.min(20, parseInt(limit, 10) || 6))}`,
    params,
  );
  return rows.map(r => ({
    leadId: Number(r.lead_id),
    name: r.name || null,
    whatsappNumber: r.whatsapp_number,
    product: r.paid_course || null,
    amountPaise: Number(r.paise || 0),
    at: r.last_paid || r.created_at,
  }));
}

module.exports = { productTotals, unattributedTotals, salesSummary, recentSales };
