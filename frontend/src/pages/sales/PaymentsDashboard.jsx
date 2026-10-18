// Sales → Payments → Dashboard.
//
// Money over time from the Razorpay ledger: when payments came in, how much,
// and how each day (or week / month) splits by payment method, product or
// status. Click any point, bar or row to see the payments behind it.
//
// Reads GET /razorpay/payments/trend (bucketing + splitting happen server-side,
// in IST calendar days) and GET /razorpay/payments for the drill-down list —
// both with the SAME filters, so the list under a bar always adds up to it.
// Read-only: nothing here changes a lead or the funnel.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  SlidersHorizontal, Search, X, Percent, Loader2, CalendarDays, TrendingUp, Hash,
  IndianRupee, Trophy, Undo2, Users, BarChart3, LineChart as LineIcon, XCircle,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, maskPhone } from '../../constants.js';
import { Button, Segmented, inputStyle, EmptyState, Table, Td, fmtDate } from '../academy/shared.jsx';
import { KpiCard, Card, SERIES } from '../../components/charts.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { DateFromTo, istToday, shiftDay } from '../../components/DateRangeControl.jsx';
import {
  RANGE_PRESETS as PRESETS, cleanDate, oneOf, resolveRange, rangeText, SinceInput, monthStart,
  useSavedViews, SavedViewsBar,
} from './savedViews.jsx';

// Paise always shown as two digits (₹15,027.40, never ₹15,027.4); whole rupees stay bare.
const rupee = (n) => {
  const v = Number(n || 0);
  const frac = Math.round(Math.abs(v) * 100) % 100 !== 0;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })}`;
};
// Axis labels: ₹1.2L / ₹45K — full figures belong in the tooltip, not the axis.
const rupeeShort = (n) => {
  const v = Number(n || 0);
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${+(v / 1e3).toFixed(1)}K`;
  return `₹${Math.round(v)}`;
};
// KPI tiles: whole rupees, so a lakh figure fits the tile. Exact paise are in
// the tooltip, the per-date table and the drill-down.
// ── GST ──────────────────────────────────────────────────────────────────────
// Razorpay records what the customer PAID, so every ledger amount already
// includes GST. We split it back out: before-GST = paid / (1 + rate), GST =
// paid − before-GST. Derived on the page, never stored — the rate is a viewing
// choice (default 18%, remembered per browser), and a stored split would go
// stale the day the rate is changed.
const GST_KEY = 'forgegrowth.payments.gstRate';
const DEFAULT_GST = 18;
function readGstRate() {
  try {
    const raw = localStorage.getItem(GST_KEY);
    const v = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(v) && v >= 0 && v <= 50) return v;
  } catch { /* storage blocked: use the default */ }
  return DEFAULT_GST;
}
const r2 = (n) => Math.round(n * 100) / 100;
// Rounded to paise so the two halves always add back up to the paid figure.
export function splitGst(paid, rate) {
  const total = r2(Number(paid || 0));
  const base = r2(total / (1 + (Number(rate) || 0) / 100));
  return { total, base, gst: r2(total - base) };
}

const rupeeWhole = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;

const METHOD_LABELS = {
  upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet',
  emi: 'EMI', bank_transfer: 'Bank transfer', paylater: 'Pay Later', unknown: 'Unknown',
};
const STATUS_LABELS = { captured: 'Captured', refunded: 'Refunded', failed: 'Failed', created: 'Created', authorized: 'Authorized' };
const labelFor = (split, key) => {
  if (split === 'method') return METHOD_LABELS[key] || (key ? key[0].toUpperCase() + key.slice(1) : key);
  if (split === 'status') return STATUS_LABELS[key] || key;
  return key;
};

// A sensible default grouping per range — 365 daily points is a barcode.
const DEFAULT_BUCKET = { 7: 'day', 30: 'day', 90: 'week', 365: 'month', all: 'month', since: 'week', custom: 'day' };
const BUCKETS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];
const SPLITS = [
  { value: 'method', label: 'Payment method' },
  { value: 'product', label: 'What for' },
  { value: 'status', label: 'Status' },
];
const STATUSES = [
  { value: 'captured', label: 'Captured' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'failed', label: 'Failed' },
  { value: 'all', label: 'All' },
];

// Quick "above ₹X" picks; Min/Max boxes below them take any range.
const AMOUNT_PRESETS = [500, 1000, 1500, 2000, 5000];
// One payment per payer: their first or latest payment in this view.
const UNIQUE = [
  { value: '', label: 'All payments' },
  { value: 'first', label: 'One per payer · first' },
  { value: 'last', label: 'One per payer · latest' },
];
// Accept "2,000" / "₹2000" in the boxes; anything else counts as empty.
const parseRupees = (v) => {
  const t = String(v ?? '').replace(/[₹,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// ── Saved views (see savedViews.jsx) ─────────────────────────────────────────
const VIEW_KEYS = ['preset', 'from', 'to', 'since', 'bucket', 'split', 'status', 'method', 'q',
  'minAmount', 'maxAmount', 'unique', 'mode', 'metric', 'basis'];
// Anything read back from the server, coerced into a valid view.
function normalizeView(f) {
  const o = f && typeof f === 'object' ? f : {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const date = cleanDate;
  const preset = oneOf(PRESETS, o.preset, '90');
  return {
    preset,
    from: date(o.from), to: date(o.to), since: date(o.since),
    bucket: oneOf(BUCKETS, o.bucket, DEFAULT_BUCKET[preset] || 'day'),
    split: oneOf(SPLITS, o.split, 'method'),
    status: oneOf(STATUSES, o.status, 'captured'),
    method: str(o.method), q: str(o.q),
    minAmount: str(o.minAmount), maxAmount: str(o.maxAmount),
    unique: oneOf(UNIQUE, o.unique, ''),
    mode: o.mode === 'bars' ? 'bars' : 'line',
    metric: o.metric === 'count' ? 'count' : 'amount',
    basis: o.basis === 'excl' ? 'excl' : 'incl',
  };
}
// Only the fields the range actually uses, so two views that LOOK the same
// (e.g. "All time" with a stale custom date behind it) compare as equal.
function canonicalView(v) {
  const n = normalizeView(v);
  if (n.preset !== 'custom') { n.from = ''; n.to = ''; }
  if (n.preset !== 'since') n.since = '';
  n.q = n.q.trim(); n.minAmount = n.minAmount.trim(); n.maxAmount = n.maxAmount.trim();
  return JSON.stringify(VIEW_KEYS.map(k => n[k]));
}
function describeView(v) {
  const n = normalizeView(v);
  const parts = [];
  parts.push(rangeText(n));
  parts.push(BUCKETS.find(b => b.value === n.bucket)?.label);
  if (n.split !== 'status' && n.status !== 'captured') parts.push(STATUSES.find(x => x.value === n.status)?.label);
  if (n.method) parts.push(labelFor('method', n.method));
  const mn = parseRupees(n.minAmount), mx = parseRupees(n.maxAmount);
  if (mn != null && mx != null) parts.push(`${rupee(mn)} – ${rupee(mx)}`);
  else if (mn != null) parts.push(`${rupee(mn)}+`);
  else if (mx != null) parts.push(`up to ${rupee(mx)}`);
  if (n.unique) parts.push(UNIQUE.find(u => u.value === n.unique)?.label);
  if (n.q.trim()) parts.push(`“${n.q.trim()}”`);
  parts.push(`split by ${SPLITS.find(x => x.value === n.split)?.label.toLowerCase()}`);
  return parts.filter(Boolean).join(' · ');
}

// Period label + the inclusive IST date range it covers (for the drill-down).
function periodRange(period, bucket) {
  if (bucket === 'day') return { from: period, to: period };
  if (bucket === 'week') return { from: period, to: shiftDay(period, 6) };
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: period, to: `${period.slice(0, 8)}${String(last).padStart(2, '0')}` };
}
function periodLabel(period, bucket, long = false) {
  if (!period) return '';
  const d = new Date(`${period}T00:00:00Z`);
  const opt = (o) => d.toLocaleDateString('en-IN', { timeZone: 'UTC', ...o });
  if (bucket === 'month') return opt({ month: long ? 'long' : 'short', year: 'numeric' });
  if (bucket === 'week') {
    const end = new Date(`${shiftDay(period, 6)}T00:00:00Z`);
    const e = end.toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
    return long ? `Week of ${opt({ day: 'numeric', month: 'short', year: 'numeric' })} – ${e}` : opt({ day: 'numeric', month: 'short' });
  }
  return long ? opt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : opt({ day: 'numeric', month: 'short' });
}

// Width of the chart's container, measured so the SVG draws in real pixels.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(200, el.clientWidth));
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// "Nice" axis maximum and 4 gridlines.
function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
  return [0, 1, 2, 3, 4].map(i => i * step);
}

// ── Time chart: line (total) or stacked bars (split) ─────────────────────────
function TimeChart({ series, bucket, mode, metric, keys, colorOf, hidden, split, selected, onSelect, gstRate, basis, height = 280 }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const PAD_L = 58, PAD_R = 12, PAD_T = 14, PAD_B = 30;
  const H = height;
  const plotW = Math.max(10, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const n = series.length;
  const visibleKeys = keys.filter(k => !hidden.has(k));

  const valueOf = (b) => metric === 'count' ? b.count
    : mode === 'bars' ? visibleKeys.reduce((a, k) => a + (b.split[k] || 0), 0) : b.amount;
  const max = Math.max(0, ...series.map(valueOf));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const yOf = (v) => PAD_T + plotH - (v / top) * plotH;
  const slot = n ? plotW / n : plotW;
  const xOf = (i) => PAD_L + slot * i + slot / 2;
  const fmtY = metric === 'count' ? (v) => String(Math.round(v)) : rupeeShort;

  // ~7 x labels whatever the width, so they never collide.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));

  const linePath = series.map((b, i) => `${i ? 'L' : 'M'}${xOf(i)},${yOf(valueOf(b))}`).join(' ');
  const area = n ? `${linePath} L${xOf(n - 1)},${yOf(0)} L${xOf(0)},${yOf(0)} Z` : '';
  const barW = Math.max(2, Math.min(42, slot * 0.7));

  const hb = hover != null ? series[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(xOf(hover), 110), w - 110) : 0;

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={H} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="pd-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.primary} stopOpacity="0.22" />
            <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD_L} x2={w - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke={C.border} strokeWidth="1"
              strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={PAD_L - 8} y={yOf(t) + 4} textAnchor="end"
              style={{ fontFamily: FONT, fontSize: 11, fill: C.textMuted }}>{fmtY(t)}</text>
          </g>
        ))}
        {series.map((b, i) => (i % every === 0) && (
          <text key={`x${i}`} x={xOf(i)} y={H - 10} textAnchor="middle"
            style={{ fontFamily: FONT, fontSize: 11, fill: C.textMuted }}>{periodLabel(b.period, bucket)}</text>
        ))}

        {selected != null && series[selected] && (
          <rect x={PAD_L + slot * selected} y={PAD_T} width={slot} height={plotH}
            fill={C.primary} opacity="0.08" />
        )}

        {mode === 'bars' && metric !== 'count' ? series.map((b, i) => {
          let acc = 0;
          return (
            <g key={`b${i}`} opacity={hover == null || hover === i ? 1 : 0.55}>
              {visibleKeys.map(k => {
                const v = b.split[k] || 0;
                if (!v) return null;
                const y1 = yOf(acc + v), y0 = yOf(acc);
                acc += v;
                return <rect key={k} x={xOf(i) - barW / 2} y={y1} width={barW} height={Math.max(1, y0 - y1)}
                  fill={colorOf(k)} rx={1.5} />;
              })}
            </g>
          );
        }) : mode === 'bars' ? series.map((b, i) => (
          <rect key={`c${i}`} x={xOf(i) - barW / 2} y={yOf(b.count)} width={barW}
            height={Math.max(b.count ? 1 : 0, yOf(0) - yOf(b.count))} fill={C.primary} rx={1.5}
            opacity={hover == null || hover === i ? 1 : 0.55} />
        )) : (
          <>
            <path d={area} fill="url(#pd-area)" />
            <path d={linePath} fill="none" stroke={C.primary} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
            {series.map((b, i) => (n <= 60 || hover === i || selected === i) && valueOf(b) > 0 && (
              <circle key={`d${i}`} cx={xOf(i)} cy={yOf(valueOf(b))} r={hover === i || selected === i ? 5 : 3}
                fill={C.cardBg} stroke={C.primary} strokeWidth={2} />
            ))}
          </>
        )}

        {hover != null && (
          <line x1={xOf(hover)} x2={xOf(hover)} y1={PAD_T} y2={PAD_T + plotH}
            stroke={C.textMuted} strokeDasharray="3 3" opacity="0.6" />
        )}
        {/* One full-height hit area per period — easy to hover and click even
            on a zero day with nothing drawn. */}
        {series.map((b, i) => (
          <rect key={`h${i}`} x={PAD_L + slot * i} y={PAD_T} width={Math.max(slot, 1)} height={plotH}
            fill="transparent" style={{ cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)} onClick={() => onSelect(i)} />
        ))}
      </svg>

      {hb && (
        <div style={{ position: 'absolute', top: 4, left: tipLeft, transform: 'translateX(-50%)', pointerEvents: 'none',
          background: 'var(--c-toastBg, #111)', color: '#fff', fontFamily: FONT, fontSize: 13, borderRadius: 8,
          padding: '8px 11px', minWidth: 170, boxShadow: '0 6px 18px rgba(0,0,0,.25)', zIndex: 2 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{periodLabel(hb.period, bucket, true)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
            <span style={{ opacity: .75 }}>Paid (incl. GST)</span><b style={{ fontFamily: MONO }}>{rupee(hb.gross)}</b>
          </div>
          {hb.gross > 0 && (() => { const g = splitGst(hb.gross, gstRate); return (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                <span style={{ opacity: .75 }}>Before GST</span><span style={{ fontFamily: MONO }}>{rupee(g.base)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                <span style={{ opacity: .75 }}>GST ({gstRate}%)</span><span style={{ fontFamily: MONO }}>{rupee(g.gst)}</span>
              </div>
            </>
          ); })()}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
            <span style={{ opacity: .75 }}>Payments</span><b style={{ fontFamily: MONO }}>{hb.count}</b>
          </div>
          {hb.amount > 0 && keys.length > 1 && (
            <div style={{ borderTop: '1px solid rgba(255,255,255,.18)', marginTop: 6, paddingTop: 6 }}>
              <div style={{ opacity: .6, fontSize: 12, marginBottom: 3 }}>{basis === 'excl' ? 'Split, before GST' : 'Split, incl. GST'}</div>
              {keys.filter(k => hb.split[k] > 0).map(k => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'space-between' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(k), flexShrink: 0 }} />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{labelFor(split, k)}</span>
                  </span>
                  <span style={{ fontFamily: MONO }}>{rupee(hb.split[k])}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ opacity: .6, fontSize: 12, marginTop: 5 }}>Click to see these payments</div>
        </div>
      )}
    </div>
  );
}

// ── Filter chip ──────────────────────────────────────────────────────────────
function Chip({ children, onClear }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 10px', borderRadius: 999,
      background: C.primaryLight, color: C.primary, fontFamily: FONT, fontSize: 13, fontWeight: 600 }}>
      {children}
      <button type="button" onClick={onClear} title="Remove this filter"
        style={{ background: 'none', border: 'none', padding: 1, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}>
        <X size={13} />
      </button>
    </span>
  );
}

function FilterLabel({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
    color: C.textMuted, fontFamily: FONT, marginBottom: 6 }}>{children}</div>;
}

export default function PaymentsDashboard() {
  const [preset, setPreset] = useState('90');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [since, setSince] = useState('');        // 'Since a date': start day, runs to today
  const [bucket, setBucket] = useState(DEFAULT_BUCKET['90']);
  const [split, setSplit] = useState('method');
  const [status, setStatus] = useState('captured');
  const [method, setMethod] = useState('');
  const [q, setQ] = useState('');
  const [minAmount, setMinAmount] = useState(''); // rupees, as typed
  const [maxAmount, setMaxAmount] = useState('');
  const [unique, setUnique] = useState('');       // '' | first | last
  const [mode, setMode] = useState('line');       // line | bars
  const [metric, setMetric] = useState('amount'); // amount | count
  const [showFilters, setShowFilters] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [methods, setMethods] = useState([]);
  const [gstRate, setGstRateState] = useState(readGstRate);
  const [gstInput, setGstInput] = useState(() => String(readGstRate()));
  const [basis, setBasis] = useState('incl'); // chart: incl | excl GST
  const setGstRate = (raw) => {
    setGstInput(raw);
    const v = Number(raw);
    if (raw === '' || !Number.isFinite(v) || v < 0 || v > 50) return; // keep the last valid rate
    setGstRateState(v);
    try { localStorage.setItem(GST_KEY, String(v)); } catch { /* per-browser convenience only */ }
  };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(null); // index into series
  const [drill, setDrill] = useState(null);       // { rows, total, loading, error }

  // Resolve the preset into concrete IST dates for the API.
  const range = useMemo(() => resolveRange(preset, from, to, since), [preset, from, to, since]);

  const minR = parseRupees(minAmount);
  const maxR = parseRupees(maxAmount);
  // A min above the max can match nothing — say so instead of an empty chart.
  const amountInverted = minR != null && maxR != null && minR > maxR;
  const baseFilters = useMemo(() => ({
    from: range.from || undefined, to: range.to || undefined,
    method: method || undefined, q: q.trim() || undefined,
    status: split === 'status' ? undefined : status,
    minAmount: minR ?? undefined,
    maxAmount: amountInverted ? undefined : (maxR ?? undefined),
    unique: unique || undefined,
  }), [range, method, q, status, split, minR, maxR, amountInverted, unique]);

  // ── Saved views ──
  const currentView = { preset, from, to, since, bucket, split, status, method, q, minAmount, maxAmount, unique, mode, metric, basis };
  const applyView = useCallback((f) => {
    const n = normalizeView(f);
    setPreset(n.preset); setFrom(n.from); setTo(n.to); setSince(n.since);
    setBucket(n.bucket); setSplit(n.split); setStatus(n.status); setMethod(n.method); setQ(n.q);
    setMinAmount(n.minAmount); setMaxAmount(n.maxAmount); setUnique(n.unique);
    setMode(n.mode); setMetric(n.metric); setBasis(n.basis);
  }, []);
  const views = useSavedViews('dashboard', applyView);
  const presetsReady = views.ready;

  const load = useCallback(async () => {
    if (!presetsReady) return;
    try {
      setLoading(true); setError(null);
      const r = await api.razorpay.paymentsTrend({ ...baseFilters, bucket, split });
      setData(r);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [baseFilters, bucket, split, presetsReady]);

  // Debounce typing (search and the amount boxes); everything else loads at once.
  const typing = q || minAmount || maxAmount;
  useEffect(() => { const t = setTimeout(load, typing ? 350 : 0); return () => clearTimeout(t); }, [load, typing]);
  // Any change of view invalidates the drill-down and hidden series.
  useEffect(() => { setSelected(null); setDrill(null); }, [baseFilters, bucket, split]);
  useEffect(() => { setHidden(new Set()); }, [split]);

  // Method options from the filter-blind summary list (anti-pattern #25).
  useEffect(() => {
    api.razorpay.paymentsSummary({}).then(s => { if (Array.isArray(s?.methods)) setMethods(s.methods); }).catch(() => {});
  }, []);

  const rawSeries = data?.series || [];
  // `gross` is always the paid (incl. GST) figure; `amount`/`split` follow the
  // chosen basis so the chart, axis and bars show before-GST when asked.
  const series = useMemo(() => {
    const f = basis === 'excl' ? 1 / (1 + gstRate / 100) : 1;
    return rawSeries.map(b => ({
      ...b, gross: b.amount,
      amount: b.amount * f,
      split: f === 1 ? b.split : Object.fromEntries(Object.entries(b.split).map(([k, v]) => [k, v * f])),
    }));
  }, [rawSeries, basis, gstRate]);
  const keys = data?.keys || [];
  const colorOf = useCallback((k) => {
    if (split === 'status') {
      return k === 'captured' ? 'var(--c-successText, #0F6E56)' : k === 'failed' ? 'var(--c-dangerText, #A32D2D)'
        : k === 'refunded' ? 'var(--fg-series-4, #E8A317)' : SERIES[(keys.indexOf(k) + 4) % SERIES.length];
    }
    const i = keys.indexOf(k);
    return SERIES[(i < 0 ? 0 : i) % SERIES.length];
  }, [keys, split]);

  const openPeriod = useCallback(async (i) => {
    if (i == null || !series[i]) return;
    if (selected === i) { setSelected(null); setDrill(null); return; }
    setSelected(i);
    const pr = periodRange(series[i].period, bucket);
    // Clamp to the chosen range so a partial first/last week does not pull in
    // payments the chart left out.
    const f = range.from && range.from > pr.from ? range.from : pr.from;
    const t = range.to && range.to < pr.to ? range.to : pr.to;
    setDrill({ loading: true, rows: [], total: 0 });
    try {
      const r = await api.razorpay.payments({ ...baseFilters, status: split === 'status' ? '' : status, from: f, to: t, limit: 200, sort: 'newest' });
      setDrill({ loading: false, rows: r.payments || [], total: r.total || 0, from: f, to: t });
    } catch (e) { setDrill({ loading: false, rows: [], error: e.message }); }
  }, [series, bucket, selected, range, baseFilters, split, status]);

  const pickPreset = (v) => {
    setPreset(v);
    if (v === 'custom' && !from && !to) { const t = istToday(); setTo(t); setFrom(shiftDay(t, -29)); }
    if (v === 'since' && !since) setSince(monthStart());
    setBucket(DEFAULT_BUCKET[v] || 'day');
  };

  const toggleKey = (k) => setHidden(prev => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n.size >= keys.length ? new Set() : n; // never hide everything
  });

  const activeFilters = [
    status !== 'captured' && split !== 'status' && { key: 'status', label: `Status: ${STATUSES.find(s => s.value === status)?.label}`, clear: () => setStatus('captured') },
    method && { key: 'method', label: `Method: ${labelFor('method', method)}`, clear: () => setMethod('') },
    q.trim() && { key: 'q', label: `Search: “${q.trim()}”`, clear: () => setQ('') },
    (minR != null || (maxR != null && !amountInverted)) && {
      key: 'amount',
      label: `Amount: ${minR != null && maxR != null && !amountInverted ? `${rupee(minR)} – ${rupee(maxR)}`
        : minR != null ? `${rupee(minR)} and above` : `up to ${rupee(maxR)}`}`,
      clear: () => { setMinAmount(''); setMaxAmount(''); },
    },
    unique && { key: 'unique', label: UNIQUE.find(u => u.value === unique)?.label, clear: () => setUnique('') },
  ].filter(Boolean);
  const clearAll = () => { setStatus('captured'); setMethod(''); setQ(''); setMinAmount(''); setMaxAmount(''); setUnique(''); };
  const pickAbove = (v) => {
    // Clicking the active pick turns it off.
    if (minR === v && maxR == null) { setMinAmount(''); return; }
    setMinAmount(String(v)); setMaxAmount('');
  };

  const t = data?.totals;
  const periodWord = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';
  const perDate = series.filter(b => b.count > 0).slice().reverse();
  const splitMax = Math.max(1, ...(data?.splitTotals || []).map(s => s.amount));
  const splitSum = (data?.splitTotals || []).reduce((a, s) => a + s.amount, 0) || 1;
  const gT = t ? splitGst(t.amount, gstRate) : null;
  const gstLabel = `GST (${gstRate}%)`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented options={PRESETS} value={preset} onChange={pickPreset} />
        {preset === 'custom' && <DateFromTo from={from} to={to} setFrom={setFrom} setTo={setTo} clearable={false} />}
        {preset === 'since' && <SinceInput value={since} onChange={setSince} />}
        <Segmented options={BUCKETS} value={bucket} onChange={setBucket} />
        <div style={{ flex: 1 }} />
        <Button variant={showFilters ? 'primary' : 'ghost'} onClick={() => setShowFilters(s => !s)}
          aria-expanded={showFilters} title="Show or hide the filters">
          <SlidersHorizontal size={15} /> Filters{activeFilters.length ? ` (${activeFilters.length})` : ''}
        </Button>
      </div>

      <SavedViewsBar scope="dashboard" views={views} current={currentView} applyView={applyView}
        normalize={normalizeView} canonical={canonicalView} describe={describeView} />

      {showFilters && (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16,
          display: 'flex', flexWrap: 'wrap', gap: '16px 24px', alignItems: 'flex-start' }}>
          <div style={{ flex: '0 0 auto' }}>
            <FilterLabel>Status</FilterLabel>
            {split === 'status'
              ? <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT, paddingTop: 6 }}>Showing every status — the chart is split by status.</div>
              : <Segmented options={STATUSES} value={status} onChange={setStatus} />}
          </div>
          <div style={{ flex: '0 0 200px' }}>
            <FilterLabel>Payment method</FilterLabel>
            <SearchableSelect value={method} onChange={setMethod}
              options={[{ value: '', label: 'All methods' }, ...methods.map(m => ({ value: m, label: labelFor('method', m) }))]}
              placeholder="All methods" triggerStyle={{ padding: '8px 30px 8px 11px' }} />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <FilterLabel>Split the chart by</FilterLabel>
            <Segmented options={SPLITS} value={split} onChange={setSplit} />
          </div>
          <div style={{ flex: '0 0 130px' }}>
            <FilterLabel>GST rate %</FilterLabel>
            <input type="number" min="0" max="50" step="0.5" value={gstInput}
              onChange={e => setGstRate(e.target.value)} aria-label="GST rate percent"
              style={{ ...inputStyle, fontFamily: MONO }} />
          </div>
          <div style={{ flex: '1 1 100%' }}>
            <FilterLabel>Amount filter</FilterLabel>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {AMOUNT_PRESETS.map(v => {
                const on = minR === v && maxR == null;
                return (
                  <button key={v} type="button" onClick={() => pickAbove(v)} aria-pressed={on}
                    title={on ? 'Remove this filter' : `Only payments of ${rupee(v)} or more`}
                    style={{ padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                      border: `1px solid ${on ? C.primary : C.border}`, background: on ? C.primary : 'transparent',
                      color: on ? '#fff' : C.text }}>
                    Above {rupee(v)}
                  </button>
                );
              })}
              <span style={{ width: 8 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input inputMode="decimal" value={minAmount} onChange={e => setMinAmount(e.target.value)}
                  placeholder="Min ₹" aria-label="Minimum amount in rupees"
                  style={{ ...inputStyle, width: 110, fontFamily: MONO }} />
                <span style={{ color: C.textMuted, fontFamily: FONT }}>to</span>
                <input inputMode="decimal" value={maxAmount} onChange={e => setMaxAmount(e.target.value)}
                  placeholder="Max ₹" aria-label="Maximum amount in rupees"
                  style={{ ...inputStyle, width: 110, fontFamily: MONO }} />
              </div>
            </div>
            <div style={{ fontSize: 13, color: amountInverted ? 'var(--c-dangerText, #A32D2D)' : C.textMuted, fontFamily: FONT, marginTop: 6 }}>
              {amountInverted ? 'The minimum is above the maximum — only the minimum is applied.'
                : 'Both ends included. The amount is what the customer paid (incl. GST).'}
            </div>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <FilterLabel>Unique payments</FilterLabel>
            <Segmented options={UNIQUE} value={unique} onChange={setUnique} />
            <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginTop: 6, maxWidth: 420 }}>
              Counts each payer once (matched on phone, else email), keeping their first or latest payment that passes the other filters.
            </div>
          </div>
          <div style={{ flex: '1 1 260px', minWidth: 220 }}>
            <FilterLabel>Search</FilterLabel>
            <div style={{ position: 'relative' }}>
              <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Name, phone, email, product, payment id…"
                style={{ ...inputStyle, paddingLeft: 34 }} />
            </div>
          </div>
          {activeFilters.length > 0 && (
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={clearAll}><XCircle size={15} /> Clear filters</Button>
            </div>
          )}
        </div>
      )}

      {!showFilters && activeFilters.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {activeFilters.map(f => <Chip key={f.key} onClear={f.clear}>{f.label}</Chip>)}
          <button type="button" onClick={clearAll}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, fontFamily: FONT, fontSize: 13 }}>
            Clear all
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: 14, background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', borderRadius: 9, fontSize: 15 }}>{error}</div>
      )}

      {!data && loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: C.textMuted }}><Loader2 size={22} className="spin" /></div>
      ) : data && (
        <>
          {/* ── KPIs ─────────────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
            <KpiCard icon={IndianRupee} label={split === 'status' || status === 'all' ? 'Amount' : status === 'captured' ? 'Collected (incl. GST)' : 'Amount (incl. GST)'}
              value={rupeeWhole(t.amount)} accent="var(--c-successText, #0F6E56)"
              info={`Razorpay records what the customer paid, so this includes GST. Before GST = paid ÷ ${1 + gstRate / 100}.`}
              sub={t.first ? `${rupeeWhole(gT.base)} + ${rupeeWhole(gT.gst)} GST` : 'No payments'} />
            <KpiCard icon={Percent} label={`GST · ${gstRate}%`} value={rupeeWhole(gT.gst)}
              info="The GST inside the amounts collected in this view. Change the rate in Filters."
              sub={`on ${rupeeWhole(gT.base)} before GST`} />
            <KpiCard icon={Hash} label="Payments" value={t.count.toLocaleString('en-IN')}
              sub={`on ${t.activePeriods} of ${t.periods} ${periodWord}${t.periods === 1 ? '' : 's'} · ${t.first ? `${periodLabel(t.first, 'day')} – ${periodLabel(periodRange(t.last, bucket).to, 'day')}` : '—'}`} />
            <KpiCard icon={Users} label="Unique payers" value={(t.payers ?? 0).toLocaleString('en-IN')}
              info="Different people in this view — phones matched on the last 10 digits, else the email."
              sub={t.count > (t.payers ?? 0) ? `${t.count - t.payers} repeat payment${t.count - t.payers === 1 ? '' : 's'} in view` : 'no repeat payers in view'} />
            <KpiCard icon={TrendingUp} label="Average payment" value={rupeeWhole(t.average)}
              sub={`incl. GST · ${rupeeWhole(splitGst(t.average, gstRate).base)} before GST`} />
            <KpiCard icon={Trophy} label={`Best ${periodWord}`} value={t.best ? rupeeWhole(t.best.amount) : '—'}
              sub={t.best ? `incl. GST · ${periodLabel(t.best.period, bucket, true)} · ${t.best.count} payment${t.best.count === 1 ? '' : 's'}` : 'No payments'}
              onClick={t.best ? () => openPeriod(series.findIndex(b => b.period === t.best.period)) : undefined} />
            <KpiCard icon={Undo2} label="Refunded" value={rupeeWhole(t.refunded)} sub="in this view" />
          </div>

          {/* ── Over time ────────────────────────────────────────────────── */}
          <Card
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <CalendarDays size={16} color={C.textMuted} /> {metric === 'count' ? 'Payments' : 'Money received'} per {periodWord}
              {metric !== 'count' && <span style={{ fontSize: 13, fontWeight: 500, color: C.textMuted }}>{basis === 'excl' ? `(before GST)` : '(incl. GST)'}</span>}
            </span>}
            right={
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Segmented size="sm" options={[{ value: 'amount', label: '₹ Amount' }, { value: 'count', label: '# Count' }]}
                  value={metric} onChange={setMetric} />
                {metric === 'amount' && (
                  <Segmented size="sm" options={[{ value: 'incl', label: '+ GST' }, { value: 'excl', label: 'Before GST' }]}
                    value={basis} onChange={setBasis} title="Chart the amount paid (incl. GST) or the amount before GST" />
                )}
                <Segmented size="sm" options={[
                  { value: 'line', label: 'Line', Icon: LineIcon },
                  { value: 'bars', label: 'Split', Icon: BarChart3, title: `Stacked by ${SPLITS.find(s => s.value === split)?.label.toLowerCase()}` },
                ]} value={mode} onChange={setMode} />
              </div>
            }
          >
            {t.count === 0 ? (
              <EmptyState Icon={BarChart3} title="No payments in this view"
                hint="Widen the date range or clear a filter." />
            ) : (
              <>
                <TimeChart series={series} bucket={bucket} mode={mode} metric={metric} keys={keys}
                  colorOf={colorOf} hidden={hidden} split={split} selected={selected} onSelect={openPeriod}
                  gstRate={gstRate} basis={basis} />
                {mode === 'bars' && metric === 'amount' && keys.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {keys.map(k => (
                      <button key={k} type="button" onClick={() => toggleKey(k)} title="Show or hide this series"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 999,
                          border: `1px solid ${C.border}`, background: hidden.has(k) ? 'transparent' : C.surfaceMuted,
                          opacity: hidden.has(k) ? 0.45 : 1, cursor: 'pointer', fontFamily: FONT, fontSize: 13, color: C.text }}>
                        <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(k) }} />
                        <span style={{ maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{labelFor(split, k)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>

          {/* ── Drill-down ───────────────────────────────────────────────── */}
          {selected != null && drill && series[selected] && (
            <Card
              title={`Payments on ${periodLabel(series[selected].period, bucket, true)}`}
              right={<Button variant="ghost" onClick={() => { setSelected(null); setDrill(null); }}><X size={15} /> Close</Button>}
            >
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontFamily: FONT, fontSize: 14, color: C.textSecondary, marginBottom: 12 }}>
                <span><b style={{ color: C.text, fontFamily: MONO }}>{rupee(series[selected].gross)}</b> paid incl. GST</span>
                <span><b style={{ color: C.text, fontFamily: MONO }}>{rupee(splitGst(series[selected].gross, gstRate).base)}</b> before GST</span>
                <span><b style={{ color: C.text, fontFamily: MONO }}>{rupee(splitGst(series[selected].gross, gstRate).gst)}</b> {gstLabel}</span>
                <span><b style={{ color: C.text, fontFamily: MONO }}>{series[selected].count}</b> payment{series[selected].count === 1 ? '' : 's'}</span>
                {keys.filter(k => series[selected].split[k] > 0).map(k => (
                  <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(k) }} />
                    {labelFor(split, k)} <b style={{ color: C.text, fontFamily: MONO }}>{rupee(rawSeries[selected]?.split[k] ?? series[selected].split[k])}</b>
                  </span>
                ))}
              </div>
              {drill.error ? (
                <div style={{ color: 'var(--c-dangerText, #A32D2D)', fontSize: 14 }}>{drill.error}</div>
              ) : drill.loading ? (
                <div style={{ padding: 24, textAlign: 'center', color: C.textMuted }}><Loader2 size={18} className="spin" /></div>
              ) : (
                <>
                  <Table
                    columns={[{ label: 'Paid at' }, { label: 'Payer' }, { label: 'Paid (incl. GST)', align: 'right' },
                      { label: 'Before GST', align: 'right' }, { label: gstLabel, align: 'right' },
                      { label: 'Method' }, { label: 'For' }, { label: 'Lead' }]}
                    footer={drill.rows.length > 0 && (() => {
                      // Only money actually received — a failed attempt carries no GST.
                      const got = drill.rows.filter(p => p.status === 'captured' || p.status === 'refunded');
                      const g = splitGst(got.reduce((a, p) => a + Number(p.amount || 0), 0), gstRate);
                      return (
                        <>
                          <Td bold>Total</Td>
                          <Td color={C.textSecondary}>{got.length} received{drill.total > drill.rows.length ? ` · latest ${drill.rows.length} of ${drill.total}` : ''}</Td>
                          <Td mono align="right" bold color="var(--c-successText, #0F6E56)">{rupee(g.total)}</Td>
                          <Td mono align="right" bold>{rupee(g.base)}</Td>
                          <Td mono align="right" bold>{rupee(g.gst)}</Td>
                          <Td /><Td /><Td />
                        </>
                      );
                    })()}
                    rows={drill.rows} keyOf={p => p.paymentId}
                    empty={<EmptyState Icon={IndianRupee} title="No payments" />}
                    renderRow={(p) => (
                      <>
                        <Td color={C.textSecondary}>{new Date(p.paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Td>
                        <Td>
                          <div style={{ fontWeight: 600 }}>{p.contact ? maskPhone(p.contact) : (p.email || '—')}</div>
                          <div style={{ fontSize: 13, fontFamily: MONO, color: C.textMuted }}>{p.paymentId}</div>
                        </Td>
                        <Td mono align="right" bold color={p.status === 'captured' ? 'var(--c-successText, #0F6E56)' : C.text}>{rupee(p.amount)}</Td>
                        {(p.status === 'captured' || p.status === 'refunded') ? (() => { const g = splitGst(p.amount, gstRate); return (
                          <>
                            <Td mono align="right" color={C.textSecondary}>{rupee(g.base)}</Td>
                            <Td mono align="right" color={C.textSecondary}>{rupee(g.gst)}</Td>
                          </>
                        ); })() : (<><Td color={C.textMuted} align="right">—</Td><Td color={C.textMuted} align="right">—</Td></>)}
                        <Td color={C.textSecondary}>{labelFor('method', p.method) || '—'}</Td>
                        <Td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} color={C.textSecondary}>
                          <span title={String(p.description || '').replace(/&amp;/g, '&')}>{String(p.description || '—').replace(/&amp;/g, '&')}</span>
                        </Td>
                        <Td>{p.leadName || <span style={{ fontSize: 13, color: C.textMuted }}>Not in funnel</span>}</Td>
                      </>
                    )}
                  />
                  {drill.total > drill.rows.length && (
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8, fontFamily: FONT }}>
                      Showing the latest {drill.rows.length} of {drill.total}. Narrow the range to see the rest.
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {/* Stacked full-width: the per-period table carries paid / before GST /
              GST plus one column per split value, too wide for half a row. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* ── Split totals ─────────────────────────────────────────── */}
            <Card title={`Split by ${SPLITS.find(s => s.value === split)?.label.toLowerCase()}`}
              right={<div style={{ width: 170 }}><SearchableSelect value={split} onChange={setSplit} options={SPLITS}
                triggerStyle={{ padding: '6px 28px 6px 10px' }} /></div>}>
              {(data.splitTotals || []).length === 0 ? <EmptyState Icon={BarChart3} title="Nothing to split" /> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {data.splitTotals.map(s => {
                    const canFilter = split === 'method' && s.key !== 'unknown';
                    return (
                      <div key={s.key}
                        onClick={canFilter ? () => setMethod(method === s.key ? '' : s.key) : undefined}
                        title={canFilter ? (method === s.key ? 'Remove this filter' : 'Show only this method') : undefined}
                        style={{ cursor: canFilter ? 'pointer' : 'default', fontFamily: FONT }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, marginBottom: 5 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 3, background: colorOf(s.key), flexShrink: 0 }} />
                          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: C.text, fontWeight: method === s.key ? 700 : 500 }}>
                            {labelFor(split, s.key)}
                          </span>
                          <span style={{ color: C.textMuted, whiteSpace: 'nowrap' }}>{s.count} · {Math.round((s.amount / splitSum) * 1000) / 10}%</span>
                          <span style={{ fontFamily: MONO, fontWeight: 700, color: C.text, minWidth: 90, textAlign: 'right' }}
                            title={`${rupee(splitGst(s.amount, gstRate).base)} before GST + ${rupee(splitGst(s.amount, gstRate).gst)} GST`}>{rupee(s.amount)}</span>
                        </div>
                        <div style={{ height: 8, borderRadius: 999, background: C.surfaceMuted, overflow: 'hidden' }}>
                          <div style={{ width: `${(s.amount / splitMax) * 100}%`, height: '100%', background: colorOf(s.key), borderRadius: 999 }} />
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, fontFamily: FONT, fontSize: 14, display: 'grid',
                    gridTemplateColumns: '1fr auto', rowGap: 4 }}>
                    <span style={{ fontWeight: 700, color: C.text }}>Total paid (incl. GST)</span>
                    <span style={{ fontFamily: MONO, fontWeight: 700, color: 'var(--c-successText, #0F6E56)', textAlign: 'right' }}>{rupee(gT.total)}</span>
                    <span style={{ color: C.textSecondary }}>Before GST</span>
                    <span style={{ fontFamily: MONO, color: C.textSecondary, textAlign: 'right' }}>{rupee(gT.base)}</span>
                    <span style={{ color: C.textSecondary }}>{gstLabel}</span>
                    <span style={{ fontFamily: MONO, color: C.textSecondary, textAlign: 'right' }}>{rupee(gT.gst)}</span>
                  </div>
                  {split === 'method' && (
                    <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>Click a method to filter the whole dashboard by it.</div>
                  )}
                  {split === 'status' && (
                    <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>Failed payments carry no amount — that money was never received.</div>
                  )}
                </div>
              )}
            </Card>

            {/* ── Per-date table ───────────────────────────────────────── */}
            <Card title={`Per ${periodWord}`}
              right={<span style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>{perDate.length} with payments · split columns incl. GST · click a row</span>}>
              <div style={{ maxHeight: 520, overflow: 'auto', margin: '0 -4px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 14 }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: C.cardBg, zIndex: 1 }}>
                      {['Date', 'Payments', 'Paid (incl. GST)', 'Before GST', gstLabel, ...keys.map(k => labelFor(split, k))].map((h, i) => (
                        <th key={i} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '8px 6px', fontSize: 12, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: '.04em', color: C.textMuted, borderBottom: `1px solid ${C.border}`,
                          whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }} title={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {perDate.map(b => {
                      const idx = series.indexOf(b);
                      const on = idx === selected;
                      return (
                        <tr key={b.period} onClick={() => openPeriod(idx)}
                          style={{ cursor: 'pointer', background: on ? C.primaryLight : 'transparent' }}>
                          <td style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, color: C.text, fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {periodLabel(b.period, bucket, bucket !== 'week')}
                          </td>
                          <td style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontFamily: MONO, color: C.textSecondary }}>{b.count}</td>
                          <td style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontFamily: MONO, fontWeight: 700, color: 'var(--c-successText, #0F6E56)', whiteSpace: 'nowrap' }}>{rupee(b.gross)}</td>
                          <td style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontFamily: MONO, color: C.textSecondary, whiteSpace: 'nowrap' }}>{rupee(splitGst(b.gross, gstRate).base)}</td>
                          <td style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontFamily: MONO, color: C.textSecondary, whiteSpace: 'nowrap' }}>{rupee(splitGst(b.gross, gstRate).gst)}</td>
                          {keys.map(k => {
                            const v = rawSeries[idx]?.split[k] || 0; // split columns are incl. GST
                            return (
                              <td key={k} style={{ padding: '8px 6px', borderBottom: `1px solid ${C.border}`, textAlign: 'right', fontFamily: MONO,
                                color: v ? C.textSecondary : C.textMuted, whiteSpace: 'nowrap' }}>
                                {v ? rupee(v) : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                  {perDate.length > 0 && (
                    // Pinned to the bottom of the scroll area so the totals stay visible.
                    <tfoot>
                      <tr style={{ position: 'sticky', bottom: 0, background: C.surfaceMuted, zIndex: 1 }}>
                        {[
                          ['Total', 'left', C.text],
                          [String(t.count), 'right', C.text],
                          [rupee(gT.total), 'right', 'var(--c-successText, #0F6E56)'],
                          [rupee(gT.base), 'right', C.text],
                          [rupee(gT.gst), 'right', C.text],
                          ...keys.map(k => [rupee(data.splitTotals.find(x => x.key === k)?.amount || 0), 'right', C.text]),
                        ].map(([v, align, color], i) => (
                          <td key={i} style={{ padding: '9px 6px', borderTop: `2px solid ${C.border}`, textAlign: align, fontWeight: 700,
                            fontFamily: i === 0 ? FONT : MONO, color, whiteSpace: 'nowrap' }}>{v}</td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
                {perDate.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: C.textMuted, fontSize: 14 }}>No payments in this view.</div>}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
