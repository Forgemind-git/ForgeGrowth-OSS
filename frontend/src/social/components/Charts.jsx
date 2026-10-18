import { useState } from 'react';
import { PLATFORMS, fmtNum, platformColor } from '../data/mockData.js';
import { C, FONT, MONO } from '../constants.js';
import { Tooltip } from './UI.jsx';

// Chart chrome (axes, grid, labels) is tokenised so it reads in both themes;
// only the series themselves carry brand / data colours.
const AXIS_TEXT = 'var(--fc-text-muted)';
const GRID = 'var(--fc-surface-2)';
const TIP_SUB = { fontSize: 12.5, color: 'rgba(255,255,255,.72)', marginTop: 2 };

// `meta` (optional, aligned with the values array) carries per-point provenance:
//   { delta, estimated, carried } — see syncService.buildFollowersTrend.
// Estimated points draw hollow so a reconstructed stretch of history is never
// mistaken for something we actually measured.
export const LineChart = ({ data, days, height = 260, unit = "impressions", meta = null }) => {
  const [tip, setTip] = useState(null);
  // Angle the x labels once there are too many to sit flat — lets us show a label
  // for EVERY data point without overlap (parallel diagonals never collide).
  const rotate = days.length > 7;
  const w = 720; const pad = { l: 50, r: 16, t: 16, b: rotate ? 62 : 30 };
  const allValues = Object.values(data).flat();
  const dataMax = Math.max(...allValues, 1);
  const dataMin = Math.min(...allValues);
  const range = dataMax - dataMin;
  // Flat line (all values equal, e.g. a steady follower count) → range 0 would make
  // (v-min)/(max-min) divide by zero and push every point to the top. Give it a
  // synthetic span so the line sits centered and readable.
  const headroom = range > 0 ? range * 0.1 : Math.max(1, Math.round(dataMax * 0.02));
  const max = dataMax + headroom;
  const min = Math.max(0, dataMin - headroom);
  const innerW = w - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const xAt = i => pad.l + (i / (days.length - 1)) * innerW;
  const yAt = v => pad.t + innerH - ((v - min) / (max - min)) * innerH;
  const yTicks = 4;
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) => min + ((max - min) / yTicks) * i);
  // Dense series: label every Nth point so the angled labels never collide.
  const labelEvery = days.length > 40 ? Math.ceil(days.length / 24) : 1;

  return (
    <>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" style={{ display: "block", maxHeight: height }}>
        {tickValues.map((tv, i) => (
          <g key={i}>
            <line x1={pad.l} y1={yAt(tv)} x2={w - pad.r} y2={yAt(tv)} stroke={GRID} strokeWidth="1" />
            <text x={pad.l - 8} y={yAt(tv) + 4} textAnchor="end" fontSize="11.5" fontFamily={MONO} fill={AXIS_TEXT}>{fmtNum(Math.round(tv))}</text>
          </g>
        ))}
        {Object.entries(data).map(([key, values]) => {
          const p = PLATFORMS[key];
          const col = platformColor(key);
          // A "carried" point is a day with no stored reading — the backend repeats the
          // last value so the axis stays a real calendar. Plot only stored readings: the
          // line runs straight from one reading to the next, and carried days get no dot
          // (they used to show as fake "+0" readings).
          const shown = values.map((_, i) => i).filter(i => !(meta?.[i]?.carried && !meta?.[i]?.estimated));
          const path = shown.map((i, n) => `${n === 0 ? "M" : "L"} ${xAt(i)} ${yAt(values[i])}`).join(" ");
          return (
            <g key={key}>
              <path d={path} stroke={col} strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" />
              {shown.map((i, n) => {
                const v = values[i];
                const m = meta?.[i];
                // Change since the previous STORED reading, not since a carried copy.
                const delta = meta ? (n === 0 ? null : v - values[shown[n - 1]]) : null;
                return (
                <g key={i}>
                  <circle cx={xAt(i)} cy={yAt(v)} r="2.4"
                    fill={m?.estimated ? 'var(--fc-raised)' : col}
                    stroke={m?.estimated ? col : 'none'} strokeWidth={m?.estimated ? 1.2 : 0} />
                  <circle
                    cx={xAt(i)} cy={yAt(v)} r="14" fill="transparent" pointerEvents="all"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => setTip({
                      x: e.clientX + 10, y: e.clientY - 10,
                      content: (
                        <div>
                          <div style={{ fontWeight: 700 }}>{p.name} · {days[i]}</div>
                          <div style={TIP_SUB}>
                            {fmtNum(v)} {unit}
                            {delta !== null && (
                              <span style={{ color: delta > 0 ? 'var(--fc-green)' : delta < 0 ? 'var(--fc-err-text)' : 'inherit', marginLeft: 6, fontWeight: 650 }}>
                                {delta > 0 ? '+' : ''}{fmtNum(delta)}
                              </span>
                            )}
                          </div>
                          {m?.estimated && <div style={{ ...TIP_SUB, color: 'var(--fc-amber)' }}>Estimated — before we started sampling</div>}
                        </div>
                      )
                    })}
                    onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY - 10 } : null)}
                    onMouseLeave={() => setTip(null)}
                  />
                </g>
                );
              })}
            </g>
          );
        })}
        {/* One label per data point. Flat when sparse; angled -45° when dense so
            every value stays readable without overlapping its neighbour. */}
        {days.map((d, i) => {
          if (!rotate) {
            return <text key={i} x={xAt(i)} y={height - 10} textAnchor="middle" fontSize="11.5" fontFamily={FONT} fill={AXIS_TEXT} fontWeight="600">{d}</text>;
          }
          if (i % labelEvery !== 0 && i !== days.length - 1) return null;
          const ly = height - pad.b + 16;
          return (
            <text key={i} x={xAt(i)} y={ly} textAnchor="end"
              transform={`rotate(-45, ${xAt(i)}, ${ly})`}
              fontSize="11.5" fontFamily={FONT} fill={AXIS_TEXT} fontWeight="600">{d}</text>
          );
        })}
      </svg>
      {tip && <Tooltip x={tip.x} y={tip.y} style={{ whiteSpace: 'nowrap' }}>{tip.content}</Tooltip>}
    </>
  );
};

export const ChartLegend = ({ keys }) => (
  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
    {keys.map(k => {
      const p = PLATFORMS[k];
      return (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: platformColor(k) }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: C.textSecondary }}>{p.name}</span>
        </div>
      );
    })}
  </div>
);

// The one bar/meter recipe: 22px fully-rounded rail on the surface tint, label
// left (14/600 secondary), fill in the series colour, count right (15/600).
export const BarChart = ({ data, valueKey = "avgViews", labelKey = "topic", color = "var(--fc-green)", formatter = fmtNum, tooltipFn }) => {
  const [tip, setTip] = useState(null);
  const max = Math.max(...data.map(d => d[valueKey]), 1);
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.map((d, i) => {
          const w = (d[valueKey] / max) * 100;
          const tooltipContent = tooltipFn ? tooltipFn(d) : (
            <div>
              <div style={{ fontWeight: 700 }}>{d[labelKey]}</div>
              <div style={TIP_SUB}>{formatter(d[valueKey])}</div>
            </div>
          );
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 120px) 1fr 72px", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 14, color: C.textSecondary, fontWeight: 600, fontFamily: FONT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{d[labelKey]}</div>
              <div
                style={{ height: 22, background: C.surface, borderRadius: 999, overflow: "hidden", cursor: 'pointer', minWidth: 0 }}
                onMouseEnter={(e) => setTip({ x: e.clientX + 10, y: e.clientY - 10, content: tooltipContent })}
                onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY - 10 } : null)}
                onMouseLeave={() => setTip(null)}
              >
                <div style={{ width: `${Math.max(w, 1.5)}%`, height: "100%", background: color, borderRadius: 999, transition: "width .3s" }} />
              </div>
              <div style={{ fontSize: 15, fontFamily: FONT, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: C.text, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatter(d[valueKey])}</div>
            </div>
          );
        })}
      </div>
      {tip && <Tooltip x={tip.x} y={tip.y} style={{ whiteSpace: 'nowrap' }}>{tip.content}</Tooltip>}
    </>
  );
};

export const Funnel = ({ steps }) => {
  const [tip, setTip] = useState(null);
  const max = steps[0].value;
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => {
          const widthPct = (s.value / max) * 100;
          const dropPct = i === 0 ? null : (((steps[i - 1].value - s.value) / steps[i - 1].value) * 100).toFixed(1);
          const tooltipContent = (
            <div>
              <div style={{ fontWeight: 700 }}>{s.label}</div>
              <div style={TIP_SUB}>
                {fmtNum(s.value)} {dropPct ? `· −${dropPct}% drop-off` : '· top of funnel'}
              </div>
            </div>
          );
          return (
            <div key={i} style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => setTip({ x: e.clientX + 10, y: e.clientY - 10, content: tooltipContent })}
              onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY - 10 } : null)}
              onMouseLeave={() => setTip(null)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, fontFamily: MONO, width: 18 }}>{i + 1}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.textSecondary }}>{s.label}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: C.text }}>{fmtNum(s.value)}</span>
                  {dropPct && <span style={{ fontSize: 11.5, fontWeight: 650, color: C.errText, background: C.errBg, padding: "2px 8px", borderRadius: 999 }}>−{dropPct}%</span>}
                </div>
              </div>
              <div style={{ height: 22, background: C.surface, borderRadius: 999, overflow: "hidden" }}>
                <div style={{ width: `${Math.max(widthPct, 4)}%`, height: "100%", background: s.color, borderRadius: 999, transition: "width .3s" }} />
              </div>
            </div>
          );
        })}
      </div>
      {tip && <Tooltip x={tip.x} y={tip.y} style={{ whiteSpace: 'nowrap' }}>{tip.content}</Tooltip>}
    </>
  );
};

export const Sparkline = ({ data, color = "var(--fc-green)", height = 48 }) => {
  const [tip, setTip] = useState(null);
  const w = 200;
  // Fewer than two points cannot make a line (n-1 = 0 → NaN paths); draw a flat rail.
  const n = Math.max(data.length, 1);
  const span = Math.max(n - 1, 1);
  const rawMax = data.length ? Math.max(...data) : 0, rawMin = data.length ? Math.min(...data) : 0;
  const max = rawMax === rawMin ? rawMax + 1 : rawMax * 1.05;
  const min = rawMax === rawMin ? rawMin - 1 : rawMin * 0.95;
  const path = data.map((v, i) => {
    const x = (i / span) * w;
    const y = height - ((v - min) / (max - min)) * height;
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");
  const area = path + ` L ${w} ${height} L 0 ${height} Z`;
  return (
    <>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" style={{ display: "block", height }}>
        <path d={area} fill={color} opacity="0.12" />
        <path d={path} stroke={color} strokeWidth="1.8" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((v, i) => {
          const x = (i / span) * w;
          const y = height - ((v - min) / (max - min)) * height;
          return (
            <circle key={i}
              cx={x} cy={y} r="10" fill="transparent" pointerEvents="all"
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => setTip({ x: e.clientX + 10, y: e.clientY - 10, content: <div>{fmtNum(v)}</div> })}
              onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 10, y: e.clientY - 10 } : null)}
              onMouseLeave={() => setTip(null)}
            />
          );
        })}
      </svg>
      {tip && <Tooltip x={tip.x} y={tip.y} style={{ whiteSpace: 'nowrap' }}>{tip.content}</Tooltip>}
    </>
  );
};
