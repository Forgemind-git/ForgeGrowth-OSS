// Shared dashboard primitives for the AI Academy — KPI cards + inline-SVG charts,
// all themed via C/FONT/MONO and with hover tooltips on every data point. Kept in
// one module so every Marketing/Sales dashboard reads as one visual system.
import { useState } from 'react';
import { C, FONT, MONO } from '../constants.js';
import InfoDot from './InfoDot.jsx';

// Categorical palette — brand red first, then the accents, then a neutral cycle.
export const SERIES = ['#dc2626', '#534AB7', '#0F6E56', '#E8A317', '#2563eb', '#db2777', '#0891b2', '#65a30d'];

// ── KPI stat card ─────────────────────────────────────────────────────────────
export function KpiCard({ label, value, sub, info, accent = C.text, onClick, icon: Icon }) {
  const [hover, setHover] = useState(false);
  return (
    <div
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
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
          {label}
        </span>
        {info && <InfoDot text={info} />}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent, fontFamily: MONO, lineHeight: 1 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 6, fontFamily: FONT }}>{sub}</div>}
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
export function Card({ title, right, children, style }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: C.shadowSm, padding: 18, ...style }}>
      {(title || right) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Donut ─────────────────────────────────────────────────────────────────────
export function Donut({ data = [], size = 168, thickness = 26 }) {
  const [hover, setHover] = useState(null);
  const total = data.reduce((s, d) => s + (d.value || 0), 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = data.map((d, i) => {
    const frac = (d.value || 0) / total;
    const seg = { ...d, color: d.color || SERIES[i % SERIES.length], dash: frac * circ, offset: offset * circ, pct: Math.round(frac * 100) };
    offset += frac;
    return seg;
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth={thickness} opacity={0.4} />
        {segs.map((s, i) => (
          <circle
            key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color}
            strokeWidth={hover === i ? thickness + 4 : thickness}
            strokeDasharray={`${s.dash} ${circ - s.dash}`} strokeDashoffset={-s.offset}
            transform={`rotate(-90 ${cx} ${cy})`} style={{ transition: 'stroke-width .15s', cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
          >
            <title>{`${s.label}: ${s.value} (${s.pct}%)`}</title>
          </circle>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, fill: C.text }}>{total}</text>
        <text x={cx} y={cy + 15} textAnchor="middle" style={{ fontFamily: FONT, fontSize: 10, fill: C.textMuted }}>total</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
        {segs.map((s, i) => (
          <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT, fontSize: 12.5, opacity: hover == null || hover === i ? 1 : 0.5, cursor: 'default' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{s.label}</span>
            <span style={{ color: C.textMuted, fontFamily: MONO, marginLeft: 'auto' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Horizontal funnel/bars ────────────────────────────────────────────────────
export function FunnelBars({ data = [], colorFor, onClick }) {
  const max = Math.max(1, ...data.map(d => d.count || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {data.map((d, i) => {
        const color = (colorFor && colorFor(d, i)) || SERIES[i % SERIES.length];
        const pct = Math.round(((d.count || 0) / max) * 100);
        return (
          <div key={i} onClick={onClick ? () => onClick(d) : undefined}
            style={{ cursor: onClick ? 'pointer' : 'default' }} title={`${d.label || d.stage || d.step}: ${d.count}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontFamily: FONT, fontSize: 12 }}>
              <span style={{ color: C.text, textTransform: 'capitalize' }}>{d.label || d.stage || d.step}</span>
              <span style={{ color: C.textMuted, fontFamily: MONO }}>{d.count}</span>
            </div>
            <div style={{ height: 10, borderRadius: 6, background: C.hover, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 6, transition: 'width .3s' }} />
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
  const bw = 100 / Math.max(1, data.length);
  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
        {data.map((d, i) => {
          const h = ((d[valueKey] || 0) / max) * (height - 24);
          const x = i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={height - 18 - h} width={w} height={h} rx={1.5}
                fill={hover === i ? C.primaryHover : C.primary} style={{ transition: 'fill .15s' }} />
              <title>{`${d[labelKey]}: ${d[valueKey]}`}</title>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', marginTop: 4 }}>
        {data.map((d, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', fontFamily: FONT, fontSize: 9.5, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d[labelKey]}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Line trend ────────────────────────────────────────────────────────────────
export function LineTrend({ data = [], height = 150, valueKey = 'count', labelKey = 'day' }) {
  const [hover, setHover] = useState(null);
  if (!data.length) return <EmptyChart />;
  const W = 100, H = height;
  const max = Math.max(1, ...data.map(d => d[valueKey] || 0));
  const step = data.length > 1 ? W / (data.length - 1) : W;
  const pts = data.map((d, i) => ({ x: i * step, y: H - 20 - ((d[valueKey] || 0) / max) * (H - 30), d }));
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const area = `${path} L${pts[pts.length - 1].x},${H - 20} L0,${H - 20} Z`;
  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="lt-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.primary} stopOpacity="0.18" />
            <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#lt-grad)" />
        <path d={path} fill="none" stroke={C.primary} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={p.x} cy={p.y} r={hover === i ? 3 : 0} fill={C.primary} vectorEffect="non-scaling-stroke" />
            <rect x={p.x - step / 2} y={0} width={step} height={H} fill="transparent" />
            <title>{`${p.d[labelKey]}: ${p.d[valueKey]}`}</title>
          </g>
        ))}
      </svg>
      {hover != null && (
        <div style={{ position: 'absolute', top: 0, left: `${(pts[hover].x / W) * 100}%`, transform: 'translateX(-50%)',
          background: '#1F1F23', color: '#fff', fontFamily: FONT, fontSize: 11, padding: '3px 7px', borderRadius: 6, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {data[hover][valueKey]}
        </div>
      )}
    </div>
  );
}

// ── Sparkline (inline, for table rows) ────────────────────────────────────────
export function Sparkline({ data = [], width = 90, height = 26, color = C.primary }) {
  if (!data.length) return <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => `${i * step},${height - 3 - (v / max) * (height - 6)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyChart({ text = 'No data yet' }) {
  return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontFamily: FONT, fontSize: 13 }}>
      {text}
    </div>
  );
}

// ── Loading shimmer ───────────────────────────────────────────────────────────
export function Shimmer({ width = '100%', height = 14, radius = 6, style }) {
  return <div style={{ width, height, borderRadius: radius, background: `linear-gradient(90deg,${C.hover} 25%,${C.surfaceAlt} 50%,${C.hover} 75%)`, backgroundSize: '200% 100%', animation: 'shimmer 1.3s ease infinite', ...style }} />;
}
