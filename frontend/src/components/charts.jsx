// Shared dashboard primitives for the AI Academy — KPI cards + inline-SVG charts,
// all themed via C/FONT/MONO and with hover tooltips on every data point. Kept in
// one module so every Marketing/Sales dashboard reads as one visual system.
import { useState, useEffect, useRef, useId } from 'react';
import { C, FONT, MONO } from '../constants.js';
import InfoDot from './InfoDot.jsx';

// Categorical palette — brand red first, then the accents, then a neutral cycle.
// Categorical chart palette. Variable-driven for the same reason the colour and
// type tokens are: a section wrapper can restyle its charts without forking
// charts.jsx, which 14 pages across BOTH sections import. The fallback is the
// historical value, so an unscoped chart is byte-identical to before.
// SVG presentation attributes (`stroke={color}`) resolve var() in every browser
// we target — the funnel bars have always passed C.primary through this way.
export const SERIES = [
  'var(--fg-series-1, #dc2626)', 'var(--fg-series-2, #534AB7)',
  'var(--fg-series-3, #0F6E56)', 'var(--fg-series-4, #E8A317)',
  'var(--fg-series-5, #2563eb)', 'var(--fg-series-6, #db2777)',
  'var(--fg-series-7, #0891b2)', 'var(--fg-series-8, #65a30d)',
];

// ── KPI stat card ─────────────────────────────────────────────────────────────
export function KpiCard({ label, value, sub, info, accent = C.text, onClick, icon: Icon }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="fg-card fg-kpi"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: '16px 18px', minWidth: 0, flex: '1 1 160px',
        boxShadow: hover && onClick ? C.shadowMd : C.shadowSm,
        cursor: onClick ? 'pointer' : 'default', transition: 'box-shadow .15s, transform .15s',
        transform: hover && onClick ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        {Icon && <Icon size={14} color={C.textMuted} style={{ marginRight: 2 }} />}
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
          {label}
        </span>
        {info && <InfoDot text={info} />}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: accent, fontFamily: MONO, lineHeight: 1 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 6, fontFamily: FONT }}>{sub}</div>}
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
export function Card({ title, right, children, style }) {
  return (
    <div className="fg-card" style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: C.shadowSm, padding: 18, ...style }}>
      {(title || right) && (
        <div className="fg-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <span className="fg-card-title" style={{ fontSize: 16, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Donut ─────────────────────────────────────────────────────────────────────
export function Donut({ data = [], size = 190, thickness = 22, maxSlices = 0 }) {
  const [hover, setHover] = useState(null);

  // ⚠ A donut stops communicating past about six slices: the tail is too thin
  // to see, and once the categories outnumber the palette the colours WRAP and
  // two different sources render in the same red. Grouping the tail into one
  // "Other" keeps every visible wedge readable and every colour unique.
  // maxSlices=0 keeps the old behaviour for callers that have not opted in.
  const sorted = [...data].sort((a, b) => (b.value || 0) - (a.value || 0));
  const shown = maxSlices > 0 && sorted.length > maxSlices
    ? [...sorted.slice(0, maxSlices - 1), {
        label: `Other (${sorted.length - maxSlices + 1})`,
        value: sorted.slice(maxSlices - 1).reduce((t, d) => t + (d.value || 0), 0),
        color: 'var(--fg-series-7, #cbd5e1)',
      }]
    : sorted;

  const total = shown.reduce((s, d) => s + (d.value || 0), 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = shown.map((d, i) => {
    const frac = (d.value || 0) / total;
    const GAP = Math.min(6, circ * 0.012);
    const len = Math.max(0, frac * circ - GAP);
    const seg = { ...d, color: d.color || SERIES[i % SERIES.length], dash: len, gap: circ - len,
      offset: offset * circ, pct: frac * 100 };
    offset += frac;
    return seg;
  });
  const fmtPct = v => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle className="fg-donut-track" cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth={thickness} opacity={0.4} />
        {segs.map((s, i) => (
          <circle
            key={i} className="fg-donut-seg" cx={cx} cy={cy} r={r} fill="none" stroke={s.color}
            strokeWidth={hover === i ? thickness + 5 : thickness}
            strokeDasharray={`${s.dash} ${s.gap}`} strokeDashoffset={-s.offset} strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`} style={{ transition: 'stroke-width .15s', cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
          >
            <title>{`${s.label}: ${s.value} (${fmtPct(s.pct)}%)`}</title>
          </circle>
        ))}
        {/* The centre answers whatever the pointer is on, and falls back to the
            total — so a thin wedge can still be read without a tooltip. */}
        <text className="fg-donut-value" x={cx} y={cy - 2} textAnchor="middle"
          style={{ fontFamily: FONT, fontWeight: 700, fill: C.text }}>
          {hover == null ? total : `${fmtPct(segs[hover].pct)}%`}
        </text>
        <text className="fg-donut-cap" x={cx} y={cy + 20} textAnchor="middle"
          style={{ fontFamily: FONT, fontSize: 12, fill: C.textMuted }}>
          {hover == null ? 'total' : segs[hover].label}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: 1 }}>
        {segs.map((s, i) => (
          <div key={i} className="fg-legend-row" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: FONT, fontSize: 14,
              opacity: hover == null || hover === i ? 1 : 0.45, cursor: 'default', transition: 'opacity .15s' }}>
            <span className="fg-legend-swatch" style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{s.label}</span>
            {/* Share, not just the count — "which source contributes what" is
                the question this chart exists to answer. */}
            <span className="fg-legend-pct" style={{ color: C.textSecondary, fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtPct(s.pct)}%</span>
            <span className="fg-legend-val" style={{ color: C.textMuted, whiteSpace: 'nowrap', minWidth: 34, textAlign: 'right' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Horizontal funnel/bars ────────────────────────────────────────────────────
export function FunnelBars({ data = [], colorFor, onClick, unit = 'leads', empty }) {
  const max = Math.max(1, ...data.map(d => d.count || 0));
  if (!data.length) {
    return <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT, padding: '20px 0' }}>
      {empty || 'Nothing to show yet.'}
    </div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {data.map((d, i) => {
        const label = d.label || d.stage || d.step || '';
        const color = d.color || (colorFor && colorFor(d, i)) || SERIES[i % SERIES.length];
        const count = d.count || 0;
        return (
          <div key={i} onClick={onClick ? () => onClick(d) : undefined}
            title={`${label}: ${count} ${unit}`}
            style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: onClick ? 'pointer' : 'default' }}>
            <div style={{
              width: 120, flexShrink: 0, fontSize: 14, color: C.textSecondary, fontFamily: FONT,
              fontWeight: 600, textTransform: 'capitalize',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{label}</div>
            {/* A thick, fully-rounded rail. The track is a SURFACE tint rather
                than the page ground: these bars sit on a card, and the page
                colour read as a hole punched through it. */}
            <div className="fg-meter" style={{ flex: 1, height: 22, borderRadius: 999, background: 'var(--fc-surface)', overflow: 'hidden' }}>
              <div className="fg-meter-fill" style={{
                width: `${(count / max) * 100}%`, height: '100%', background: color,
                borderRadius: 999, minWidth: count > 0 ? 22 : 0, transition: 'width .45s cubic-bezier(.2,0,.2,1)',
              }} />
            </div>
            <div style={{ width: 44, flexShrink: 0, textAlign: 'right', fontSize: 15, fontWeight: 600, fontFamily: MONO, color: C.text }}>
              {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Vertical bars (e.g. spend vs leads) ───────────────────────────────────────
export function BarChart({ data = [], height = 160, valueKey = 'value', labelKey = 'label' }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map(d => d[valueKey] || 0));
  return (
    <div className="fg-barchart">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height }}>
        {data.map((d, i) => {
          const h = Math.max(2, ((d[valueKey] || 0) / max) * (height - 8));
          return (
            <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', alignItems: 'flex-end', height: '100%' }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              title={`${d[labelKey]}: ${d[valueKey]}`}>
              <div className="fg-bar" style={{
                width: '100%', maxWidth: 56, height: h, borderRadius: 4,
                background: hover === i ? C.primaryHover : C.primary,
                transition: 'background .15s, height .3s',
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        {data.map((d, i) => (
          <div key={i} className="fg-bar-label" style={{ flex: 1, minWidth: 0, textAlign: 'center', fontFamily: FONT, fontSize: 11, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d[labelKey]}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Line trend ────────────────────────────────────────────────────────────────
// Axis ends. The series carries ISO timestamps, and printing one raw puts
// "2026-08-03T00:00:00.000Z" under a chart — a machine string where a date
// belongs. Anything unparseable is passed straight through, so a label that is
// already human (a week number, a bucket name) is left alone.
function axisLabel(v) {
  if (v == null) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function LineTrend({ data = [], height = 170, valueKey = 'count', labelKey = 'day' }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const [w, setW] = useState(720);
  // ⚠ This chart used viewBox="0 0 100 H" with preserveAspectRatio="none", so a
  // ~1900px-wide card scaled x by ~19 and y by 1. Every curve flattened into a
  // plateau joined by near-vertical walls, and the round line caps stretched
  // into horizontal blobs — the shape on screen was not the shape of the data.
  // Measuring the box and drawing in real pixels is the fix; nothing else here
  // could have corrected it, because the distortion was in the viewport map.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const set = () => setW(Math.max(120, el.clientWidth));
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A unique gradient id per instance. Two trends on one page both defined
  // "lt-grad", and the second silently painted with the first one's fill.
  const gid = useId().replace(/:/g, '');

  if (!data.length) return <EmptyChart />;

  const PAD_B = 26, PAD_T = 12;
  const H = height;
  const max = Math.max(1, ...data.map(d => d[valueKey] || 0));
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const yOf = v => H - PAD_B - ((v || 0) / max) * (H - PAD_B - PAD_T);
  const pts = data.map((d, i) => ({ x: i * step, y: yOf(d[valueKey]), d }));

  // Monotone cubic: unlike Catmull-Rom it cannot overshoot, so a run of equal
  // values stays flat instead of bulging above the line, and a spike does not
  // dip below zero on the way in.
  const path = pts.length < 2 ? '' : pts.reduce((acc, p, i, a) => {
    if (i === 0) return `M${p.x},${p.y}`;
    const p1 = a[i - 1];
    const dx = (p.x - p1.x) / 2;
    return `${acc} C${p1.x + dx},${p1.y} ${p.x - dx},${p.y} ${p.x},${p.y}`;
  }, '');
  const area = `${path} L${pts[pts.length - 1].x},${H - PAD_B} L${pts[0].x},${H - PAD_B} Z`;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} style={{ display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`lt-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.primary} stopOpacity="0.22" />
            <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* One baseline instead of a grid — the value is read from the tooltip,
            so extra rules would only add ink. */}
        <line className="fg-grid" x1="0" y1={H - PAD_B} x2={w} y2={H - PAD_B} stroke={C.border} strokeWidth="1" />
        <path className="fg-area" d={area} fill={`url(#lt-${gid})`} />
        <path className="fg-line" d={path} fill="none" stroke={C.primary} strokeWidth={2.5}
          strokeLinecap="round" strokeLinejoin="round" />
        {hover != null && (
          <line x1={pts[hover].x} y1={PAD_T - 6} x2={pts[hover].x} y2={H - PAD_B}
            stroke={C.primary} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
        )}
        {pts.map((p, i) => (
          <circle key={`d${i}`} className="fg-dot" cx={p.x} cy={p.y} r={hover === i ? 5 : 0} fill={C.primary} />
        ))}
        {pts.map((p, i) => (
          <rect key={`h${i}`} x={p.x - step / 2} y={0} width={Math.max(step, 1)} height={H}
            fill="transparent" onMouseEnter={() => setHover(i)}>
            <title>{`${p.d[labelKey]}: ${p.d[valueKey]}`}</title>
          </rect>
        ))}
      </svg>
      {hover != null && (
        <div className="fg-valuetag" style={{ position: 'absolute', top: 0,
          left: Math.min(Math.max(pts[hover].x, 28), w - 28), transform: 'translateX(-50%)',
          background: '#1F1F23', color: '#fff', fontFamily: FONT, fontSize: 13,
          padding: '3px 7px', borderRadius: 6, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {data[hover][valueKey]}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span className="fg-bar-label" style={{ fontFamily: FONT, fontSize: 11, color: C.textMuted }}>{axisLabel(data[0]?.[labelKey])}</span>
        <span className="fg-bar-label" style={{ fontFamily: FONT, fontSize: 11, color: C.textMuted }}>{axisLabel(data[data.length - 1]?.[labelKey])}</span>
      </div>
    </div>
  );
}

// ── Sparkline (inline, for table rows) ────────────────────────────────────────
export function Sparkline({ data = [], width = 90, height = 26, color = C.primary }) {
  if (!data.length) return <span style={{ color: C.textMuted, fontSize: 13 }}>—</span>;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => `${i * step},${height - 3 - (v / max) * (height - 6)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline className="fg-line" points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyChart({ text = 'No data yet' }) {
  return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontFamily: FONT, fontSize: 15 }}>
      {text}
    </div>
  );
}

// ── Loading shimmer ───────────────────────────────────────────────────────────
export function Shimmer({ width = '100%', height = 14, radius = 6, style }) {
  return <div style={{ width, height, borderRadius: radius, background: `linear-gradient(90deg,${C.hover} 25%,${C.surfaceAlt} 50%,${C.hover} 75%)`, backgroundSize: '200% 100%', animation: 'shimmer 1.3s ease infinite', ...style }} />;
}
