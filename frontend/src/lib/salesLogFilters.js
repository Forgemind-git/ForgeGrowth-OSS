// Sales Log filtering, sorting and the month-by-month summary.
//
// Pure functions over the /students payload so the page stays a thin view.
// Every date here is an IST calendar day 'YYYY-MM-DD' (the backend sends
// loggedOn and each payment's date in that form), so comparisons are plain
// string compares and a sale can never slide a day across time zones.

export const NO_PRODUCT = '__none__';

export const SALES_SORTS = [
  { value: 'logged_desc', label: 'Newest logged first' },
  { value: 'logged_asc', label: 'Oldest logged first' },
  { value: 'payment_desc', label: 'Latest payment first' },
  { value: 'paid_desc', label: 'Highest paid first' },
  { value: 'paid_asc', label: 'Lowest paid first' },
  { value: 'name_asc', label: 'Name A–Z' },
];

export const DATE_BASIS = [
  { value: 'logged', label: 'Sale logged' },
  { value: 'payment', label: 'Payment received' },
];

const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
export const monthOf = (d) => day(d).slice(0, 7); // 'YYYY-MM'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) return ym || '';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// First and last day of a 'YYYY-MM' month.
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

const inRange = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);

// Payments of one sale that fall inside the range (all of them when no range).
export function paymentsInRange(sale, from, to) {
  return (sale.payments || []).filter(p => inRange(day(p.date), from, to));
}

export const productKey = (sale) => (sale.paidCourse && sale.paidCourse.trim()) ? sale.paidCourse.trim() : NO_PRODUCT;

// Filters that are NOT about dates — the month summary applies these, never the
// date range, so its rows don't vanish when a month is picked.
function matchesNonDate(s, f) {
  if (f.product && productKey(s) !== f.product) return false;
  if (f.status && s.paymentStatus !== f.status) return false;
  const q = (f.search || '').trim().toLowerCase();
  if (q) {
    const digits = q.replace(/\D/g, '');
    const hay = [s.name, s.email, s.paidCourse].filter(Boolean).join(' ').toLowerCase();
    const num = String(s.whatsappNumber || '').replace(/\D/g, '');
    if (!hay.includes(q) && !(digits.length >= 3 && num.includes(digits))) return false;
  }
  return true;
}

// f = { search, product, status, basis: 'logged'|'payment', from, to, sort }
// Returns rows annotated with `periodPaid` (collected inside the range).
export function filterSales(sales, f) {
  const hasRange = !!(f.from || f.to);
  const rows = [];
  for (const s of sales || []) {
    if (!matchesNonDate(s, f)) continue;
    const inPeriod = paymentsInRange(s, f.from, f.to);
    if (hasRange) {
      if (f.basis === 'payment' ? inPeriod.length === 0 : !inRange(day(s.loggedOn), f.from, f.to)) continue;
    }
    const periodPaid = inPeriod.reduce((a, p) => a + (p.amount || 0), 0);
    rows.push({ ...s, periodPaid, periodPayments: inPeriod.length });
  }
  return sortSales(rows, f.sort);
}

export function sortSales(rows, sort = 'logged_desc') {
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const cmp = {
    logged_desc: (a, b) => byStr(day(b.loggedOn), day(a.loggedOn)) || b.id - a.id,
    logged_asc: (a, b) => byStr(day(a.loggedOn), day(b.loggedOn)) || a.id - b.id,
    payment_desc: (a, b) => byStr(day(b.lastPaymentAt) || '', day(a.lastPaymentAt) || '') || b.id - a.id,
    paid_desc: (a, b) => (b.totalPaid || 0) - (a.totalPaid || 0) || b.id - a.id,
    paid_asc: (a, b) => (a.totalPaid || 0) - (b.totalPaid || 0) || a.id - b.id,
    name_asc: (a, b) => byStr((a.name || '').toLowerCase(), (b.name || '').toLowerCase()) || a.id - b.id,
  }[sort] || null;
  return cmp ? [...rows].sort(cmp) : [...rows];
}

// Month-by-month: new sales logged + payments received + collected, newest
// month first. Honours product/status/search but deliberately NOT the date
// range, so it stays the overview you pick a month from.
export function monthlySummary(sales, f) {
  const map = new Map();
  const bucket = (ym) => {
    if (!map.has(ym)) map.set(ym, { month: ym, sales: 0, payments: 0, collected: 0 });
    return map.get(ym);
  };
  for (const s of sales || []) {
    if (!matchesNonDate(s, f)) continue;
    const lm = monthOf(s.loggedOn);
    if (lm) bucket(lm).sales += 1;
    for (const p of s.payments || []) {
      const pm = monthOf(p.date);
      if (!pm) continue;
      const b = bucket(pm);
      b.payments += 1;
      b.collected += p.amount || 0;
    }
  }
  return [...map.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

// Every month any sale was logged or paid in — the Month dropdown's options.
// Built from ALL sales so picking a product can't make the current month vanish.
export function allMonths(sales) {
  const set = new Set();
  for (const s of sales || []) {
    if (monthOf(s.loggedOn)) set.add(monthOf(s.loggedOn));
    for (const p of s.payments || []) if (monthOf(p.date)) set.add(monthOf(p.date));
  }
  return [...set].sort().reverse();
}
