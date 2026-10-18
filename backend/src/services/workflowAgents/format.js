// Formatting helpers for everything a workflow-agent tool returns.
//
// Timestamps leave the tool layer as IST ISO strings ("2026-09-17T14:22:10+05:30").
// India has no daylight saving, so a fixed +05:30 offset is exact. Money leaves as
// rupees (numbers) plus an Indian-grouped string where a person will read it.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Date | string | null → "YYYY-MM-DDTHH:mm:ss+05:30" (or null). */
function toIst(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

/** The IST calendar day of an instant, "YYYY-MM-DD". */
function istDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A human IST stamp for prompts: "Thursday, 17 September 2026, 14:22 IST". */
function istHuman(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} IST`;
}

/** DATE column value (pg returns a JS Date at local midnight, or a string) → "YYYY-MM-DD". */
function dateOnly(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // pg parses DATE as local midnight; the container runs UTC, so the UTC parts are the date.
  const d = value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const key10 = (s) => digits(s).slice(-10);

/**
 * "+91 98xxxxx210". Country code = everything before the last 10 digits.
 * Numbers shorter than 10 digits are masked except their last 2.
 */
function maskPhone(value) {
  const d = digits(value);
  if (!d) return null;
  if (d.length < 10) return `${'x'.repeat(Math.max(0, d.length - 2))}${d.slice(-2)}`;
  const cc = d.slice(0, d.length - 10);
  const local = d.slice(-10);
  return `${cc ? `+${cc} ` : ''}${local.slice(0, 2)}xxxxx${local.slice(-3)}`;
}

/** "Priya Sharma" → "Priya S."  ·  single word stays as is  ·  empty → null. */
function maskName(value) {
  const s = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const parts = s.split(' ');
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

const paiseToRupees = (p) => (p == null ? null : Math.round(Number(p)) / 100);

/** Indian digit grouping: 123456.5 → "₹1,23,456.50"; whole rupees drop the paise. */
function formatInr(rupees) {
  if (rupees == null || Number.isNaN(Number(rupees))) return null;
  const n = Number(rupees);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const frac = Math.round((abs - whole) * 100);
  const s = String(whole);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? '-' : ''}₹${grouped}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** Tag / label comparison key: "Do not contact" and "do_not_contact" are the same tag. */
const normKey = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const round = (n, dp = 2) => (n == null ? null : Math.round(Number(n) * 10 ** dp) / 10 ** dp);

module.exports = {
  IST_OFFSET_MS, toIst, istDate, istHuman, dateOnly, digits, key10, maskPhone, maskName,
  paiseToRupees, formatInr, normKey, round,
};
