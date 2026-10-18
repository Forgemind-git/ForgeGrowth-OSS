// Payments dashboard — money over time from the Razorpay LEDGER
// (coexistence.razorpay_payments), bucketed by IST day / week / month and split
// by method, product ("what for") or status.
//
// Read-only: this describes what the gateway holds and changes no CRM state.
//
// Dates are IST calendar days and both ends are INCLUSIVE. The DB session runs
// in UTC, so a bare `paid_at >= '2026-09-10'::date` would put a payment made at
// 02:00 IST on the 10th into the 9th. Every filter and bucket here goes through
// IST_DAY so the chart, the per-date table and the drill-down list agree.
const IST_DAY = `(p.paid_at AT TIME ZONE 'Asia/Kolkata')::date`;

// Who paid, for "one per payer". The same person reaches Razorpay as
// 9876543210 / +919876543210 / 91…, so phones join on their last 10 digits.
// void@razorpay.com is Razorpay's placeholder for "no email given" — keying on
// it would fold unrelated customers into one. A payment with neither falls back
// to its own id, i.e. it is always its own payer.
const PAYER_KEY = `COALESCE(
  NULLIF(RIGHT(regexp_replace(COALESCE(p.payer_contact,''), '\\D', '', 'g'), 10), ''),
  NULLIF(NULLIF(lower(btrim(COALESCE(p.payer_email,''))), ''), 'void@razorpay.com'),
  p.payment_id)`;
const UNIQUE_MODES = { first: 'ASC', last: 'DESC' };

// Rupees from the query string → paise, or null. Rejects junk and negatives
// rather than guessing, so a typo never silently filters everything out.
function rupeesToPaise(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const BUCKETS = { day: 'day', week: 'week', month: 'month' };
const SPLITS = ['method', 'product', 'status'];
// Beyond this many products the rest are folded into "Other" — a stacked chart
// with 40 colours says nothing.
const TOP_PRODUCTS = 6;
// A day-bucketed chart over 1.5 years is 600 points; still fine, but cap the
// padded series so a bad `from` cannot generate millions of rows.
const MAX_POINTS = 1500;

// Status filter → SQL, mirroring the ledger list's semantics exactly.
function statusClause(status) {
  if (status === 'captured') return ` AND p.status = 'captured'`;
  if (status === 'failed') return ` AND p.status = 'failed'`;
  if (status === 'refunded') return ` AND (p.status = 'refunded' OR p.amount_refunded_paise > 0)`;
  return '';
}

/**
 * Shared WHERE builder for the ledger list, summary and trend so the three can
 * never disagree about which payments a filter selects.
 * @param {object} f {from,to,method,q,status,minAmount,maxAmount,unique}
 *   minAmount / maxAmount are RUPEES, both inclusive. unique = 'first' | 'last'
 *   keeps one payment per payer — their earliest / latest that matches every
 *   other filter (so "unique" is decided AFTER the date, amount and status
 *   filters, never before them).
 * @param {boolean} withStatus apply the status filter (the summary does not)
 */
function ledgerWhere(f = {}, withStatus = true) {
  const params = [];
  let where = 'WHERE 1=1';
  if (withStatus) {
    const s = statusClause(f.status);
    if (s) where += s;
    else if (f.status && !['', 'all'].includes(f.status)) {
      params.push(f.status); where += ` AND p.status = $${params.length}`;
    }
  }
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (f.from && DATE.test(f.from)) { params.push(f.from); where += ` AND ${IST_DAY} >= $${params.length}::date`; }
  if (f.to && DATE.test(f.to)) { params.push(f.to); where += ` AND ${IST_DAY} <= $${params.length}::date`; }
  if (f.method) { params.push(f.method); where += ` AND p.method = $${params.length}`; }
  const q = (f.q || '').trim();
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    where += ` AND (p.payer_email ILIKE $${n} OR p.payer_contact ILIKE $${n}
                    OR p.description ILIKE $${n} OR p.payment_id ILIKE $${n}
                    OR p.matched_lead_name ILIKE $${n})`;
  }
  const minP = rupeesToPaise(f.minAmount);
  const maxP = rupeesToPaise(f.maxAmount);
  if (minP != null) { params.push(minP); where += ` AND p.amount_paise >= $${params.length}`; }
  if (maxP != null) { params.push(maxP); where += ` AND p.amount_paise <= $${params.length}`; }
  const dir = UNIQUE_MODES[f.unique];
  if (dir) {
    // The subquery re-uses the exact WHERE (and its params) built above, so the
    // payment kept for each payer is chosen among the payments this view shows.
    where += ` AND p.payment_id IN (
      SELECT DISTINCT ON (${PAYER_KEY}) p.payment_id
        FROM coexistence.razorpay_payments p ${where}
       ORDER BY ${PAYER_KEY}, p.paid_at ${dir} NULLS LAST, p.payment_id)`;
  }
  return { where, params };
}

// Razorpay stores descriptions HTML-escaped ("&amp;"); a link payment's
// description is "#<link id>", which means nothing to a reader.
function productLabel(desc) {
  const d = String(desc || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  if (!d) return 'No description';
  if (/^#[A-Za-z0-9]{8,}$/.test(d)) return 'Payment link';
  return d;
}

function methodKey(m) { return m ? String(m) : 'unknown'; }

function splitKeyOf(row, split) {
  if (split === 'method') return methodKey(row.method);
  if (split === 'status') {
    if (Number(row.refunded_paise) > 0 || row.status === 'refunded') return 'refunded';
    return row.status || 'unknown';
  }
  return productLabel(row.description);
}

const fmtYmd = (d) => {
  if (typeof d === 'string') return d.slice(0, 10);
  // pg returns DATE as a JS Date at local midnight; the container runs UTC.
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Start of the bucket containing a YYYY-MM-DD (week = ISO Monday), matching
// Postgres date_trunc so padding and data line up.
function bucketStart(ymd, bucket) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (bucket === 'month') dt.setUTCDate(1);
  else if (bucket === 'week') dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
function nextBucket(ymd, bucket) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (bucket === 'month') dt.setUTCMonth(dt.getUTCMonth() + 1);
  else dt.setUTCDate(dt.getUTCDate() + (bucket === 'week' ? 7 : 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Pure: turn raw per-payment-group rows into a padded series. Exported for tests.
 * rows: [{period:'YYYY-MM-DD', key, amount_paise, refunded_paise, count}]
 * Every period between first..last (or from..to) is present, zero-filled, so a
 * quiet day reads as zero instead of the line skipping over it.
 */
function buildSeries(rows, { bucket = 'day', from, to, keys = [] } = {}) {
  const byPeriod = new Map();
  for (const r of rows) {
    const p = r.period;
    if (!byPeriod.has(p)) byPeriod.set(p, { period: p, amount: 0, count: 0, refunded: 0, split: {} });
    const b = byPeriod.get(p);
    const amt = Number(r.amount_paise || 0) / 100;
    b.amount += amt;
    b.count += Number(r.count || 0);
    b.refunded += Number(r.refunded_paise || 0) / 100;
    b.split[r.key] = (b.split[r.key] || 0) + amt;
  }
  const periods = [...byPeriod.keys()].sort();
  const start = from ? bucketStart(from, bucket) : periods[0];
  const end = to ? bucketStart(to, bucket) : periods[periods.length - 1];
  const out = [];
  if (start && end) {
    let cur = start;
    while (cur <= end && out.length < MAX_POINTS) {
      const b = byPeriod.get(cur) || { period: cur, amount: 0, count: 0, refunded: 0, split: {} };
      for (const k of keys) if (b.split[k] == null) b.split[k] = 0;
      b.amount = Math.round(b.amount * 100) / 100;
      out.push(b);
      cur = nextBucket(cur, bucket);
    }
  }
  return out;
}

async function paymentTrend(pool, query = {}) {
  const bucket = BUCKETS[query.bucket] || 'day';
  const split = SPLITS.includes(query.split) ? query.split : 'method';
  // Default to captured money — "how much we got". A status split needs every
  // status, so the status filter is dropped for it (the UI says so).
  const status = split === 'status' ? '' : (query.status ?? 'captured');
  const { where, params } = ledgerWhere({ ...query, status }, true);

  const { rows } = await pool.query(
    `SELECT date_trunc('${bucket}', ${IST_DAY})::date AS period,
            p.method, p.status, p.description,
            COUNT(*)::int AS count,
            -- Money only counts where it was actually collected; a failed
            -- payment's amount was never received.
            COALESCE(SUM(CASE WHEN p.status IN ('captured','refunded') THEN p.amount_paise ELSE 0 END),0) AS amount_paise,
            COALESCE(SUM(p.amount_refunded_paise),0) AS refunded_paise
       FROM coexistence.razorpay_payments p
       ${where} AND p.paid_at IS NOT NULL
      GROUP BY 1,2,3,4`, params);

  // Resolve split keys; fold long-tail products into "Other".
  let keyed = rows.map(r => ({ ...r, period: fmtYmd(r.period), key: splitKeyOf(r, split) }));
  const totals = new Map();
  for (const r of keyed) {
    const t = totals.get(r.key) || { key: r.key, amount: 0, count: 0 };
    t.amount += Number(r.amount_paise) / 100; t.count += r.count;
    totals.set(r.key, t);
  }
  let splitTotals = [...totals.values()].sort((a, b) => b.amount - a.amount || b.count - a.count);
  if (split === 'product' && splitTotals.length > TOP_PRODUCTS + 1) {
    const keep = new Set(splitTotals.slice(0, TOP_PRODUCTS).map(t => t.key));
    keyed = keyed.map(r => keep.has(r.key) ? r : { ...r, key: 'Other' });
    const other = splitTotals.slice(TOP_PRODUCTS).reduce((a, t) => ({ key: 'Other', amount: a.amount + t.amount, count: a.count + t.count }), { key: 'Other', amount: 0, count: 0 });
    splitTotals = [...splitTotals.slice(0, TOP_PRODUCTS), other];
  }
  splitTotals = splitTotals.map(t => ({ ...t, amount: Math.round(t.amount * 100) / 100 }));
  const keys = splitTotals.map(t => t.key);

  const series = buildSeries(keyed, { bucket, from: query.from, to: query.to, keys });

  // How many different people paid in this view (any filter, incl. "unique").
  const { rows: [pp] } = await pool.query(
    `SELECT COUNT(DISTINCT ${PAYER_KEY})::int AS payers
       FROM coexistence.razorpay_payments p ${where} AND p.paid_at IS NOT NULL`, params);

  const amount = series.reduce((a, b) => a + b.amount, 0);
  const count = series.reduce((a, b) => a + b.count, 0);
  const refunded = series.reduce((a, b) => a + b.refunded, 0);
  const active = series.filter(b => b.count > 0);
  const best = active.reduce((a, b) => (!a || b.amount > a.amount ? b : a), null);

  return {
    bucket, split, status: status || 'all',
    series, keys, splitTotals,
    totals: {
      amount: Math.round(amount * 100) / 100,
      count,
      payers: pp?.payers || 0,
      refunded: Math.round(refunded * 100) / 100,
      average: count ? Math.round((amount / count) * 100) / 100 : 0,
      activePeriods: active.length,
      periods: series.length,
      best: best ? { period: best.period, amount: best.amount, count: best.count } : null,
      first: series[0]?.period || null,
      last: series[series.length - 1]?.period || null,
    },
  };
}

module.exports = { paymentTrend, ledgerWhere, buildSeries, productLabel, bucketStart, rupeesToPaise, IST_DAY, PAYER_KEY, SPLITS };
