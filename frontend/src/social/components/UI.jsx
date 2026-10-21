import { toLayout, pillRect } from '../../lib/uiZoom.js';
import React, { useState, useRef, useLayoutEffect } from "react";
import { PLATFORMS, fmtNum, pct, platformColor } from '../data/mockData.js';
import { relativeTime, C, FONT, MONO, T } from '../constants.js';

// Near-realtime freshness pill — "Updated Xm ago" with a live green dot.
export const LiveBadge = ({ ts }) => (
  <span title="Auto-refreshes every minute" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 650, color: C.green, background: C.greenSoft, padding: "4px 10px", borderRadius: 999, fontFamily: FONT, whiteSpace: "nowrap" }}>
    <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: `0 0 0 3px ${C.greenSoft}` }} />
    {ts ? `Updated ${relativeTime(ts)}` : "Live"}
  </span>
);

// Chip: fill = colour at ~10%, text = colour. `bg`/`color` from the legacy status maps still work.
export const Badge = ({ label, bg, color, weight = 650 }) => (
  <span style={{ fontSize: 11.5, fontWeight: weight, padding: "3px 9px", borderRadius: 999, background: bg, color, fontFamily: FONT, whiteSpace: "nowrap", letterSpacing: ".01em", display: "inline-block", lineHeight: 1.35 }}>{label}</span>
);

// Data-quality pill — distinguishes numbers that aren't the platform's own.
export const DataQualityBadge = ({ kind = "demo" }) => {
  const cfg = {
    demo:      { label: "Sample data",  title: "Hardcoded sample data — not from a connected platform." },
    estimated: { label: "Estimated",    title: "No snapshot for this period yet — values are scaled from another period and may differ from the platform's own numbers." },
  }[kind] || { label: kind, title: "" };
  return (
    <span title={cfg.title} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 650, padding: "3px 10px", borderRadius: 999, background: C.amberSoft, color: C.amber, fontFamily: FONT, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.amber }} />
      {cfg.label}
    </span>
  );
};

export const PlatformBadge = ({ platform, size = "sm" }) => {
  const p = PLATFORMS[platform];
  if (!p) return null;
  const dim = size === "sm" ? 22 : size === "md" ? 28 : 36;
  const fs = size === "sm" ? 11.5 : size === "md" ? 12 : 13;
  return (
    <div title={p.name} style={{ width: dim, height: dim, borderRadius: dim >= 36 ? 12 : 8, background: platformColor(platform), color: C.onAccent, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: fs, fontWeight: 700, fontFamily: FONT, letterSpacing: ".02em", flexShrink: 0 }}>{p.short}</div>
  );
};

export const PlatformPill = ({ platform }) => {
  const p = PLATFORMS[platform];
  if (!p) return null;
  const col = platformColor(platform);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px 3px 4px", borderRadius: 999, background: `color-mix(in srgb, ${col} 12%, transparent)`, color: col, fontSize: 12, fontWeight: 650, fontFamily: FONT, whiteSpace: "nowrap" }}>
      <span style={{ width: 20, height: 20, borderRadius: 6, background: col, color: C.onAccent, fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", letterSpacing: 0 }}>{p.short}</span>
      {p.name}
    </span>
  );
};

// KPI tile: eyebrow label → metric (sans, 38/780) → delta chip. Raised fill on the pane, no border.
export const StatCard = ({ label, value, delta, deltaLabel, suffix, currency, positive, info, color, sub }) => {
  const [tip, setTip] = useState(null);
  const isPositive = positive !== undefined ? positive : delta >= 0;
  const valueStr = currency || typeof value === "number" ? fmtNum(value) : value;
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 18, minWidth: 0 }}>
      <div style={{ ...T.label, color: C.textSecondary, display: "flex", alignItems: "center", gap: 5 }}>
        {label}
        {info && (
          <span
            style={{ display: "inline-flex", cursor: "help", opacity: 0.55 }}
            onMouseEnter={(e) => setTip({ x: e.clientX + 8, y: e.clientY - 8, content: info })}
            onMouseMove={(e) => setTip(prev => prev ? { ...prev, x: e.clientX + 8, y: e.clientY - 8 } : null)}
            onMouseLeave={() => setTip(null)}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </span>
        )}
      </div>
      <div style={{ ...T.metric, color: color || C.text, marginTop: 8, marginBottom: delta != null ? 10 : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{valueStr}{suffix || ""}</div>
      {sub && <div style={{ fontSize: 13, color: C.textMuted, marginTop: delta != null ? 0 : 6, marginBottom: delta != null ? 8 : 0 }}>{sub}</div>}
      {delta != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 650, fontFamily: FONT, color: isPositive ? C.green : C.errText, padding: "2px 8px", borderRadius: 999, background: isPositive ? C.greenSoft : C.errBg, fontVariantNumeric: "tabular-nums" }}>{pct(delta)}</span>
          {deltaLabel && <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>{deltaLabel}</span>}
        </div>
      )}
      {tip && <Tooltip x={tip.x} y={tip.y}>{tip.content}</Tooltip>}
    </div>
  );
};

// The dark name-plate: constant in both themes.
// x/y are mouse clientX/Y (screen px); the app is CSS-zoomed, so convert them to
// layout px before using them as a fixed position (lib/uiZoom.js).
export const Tooltip = ({ x, y, children, style }) => (
  <div style={{ position: 'fixed', left: toLayout(x), top: toLayout(y), zIndex: 9999, background: C.plate, color: C.plateText, padding: '8px 12px', borderRadius: 12, fontSize: 13, fontWeight: 500, fontFamily: FONT, whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.45, pointerEvents: 'none', boxShadow: C.shadowLg, ...style }}>
    {children}
  </div>
);

// Section eyebrow — label style in DM Mono, text-secondary.
export const SectionHead = ({ children, right, style }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, ...style }}>
    <div style={{ ...T.label, fontFamily: MONO, color: C.textSecondary }}>{children}</div>
    {right}
  </div>
);

// A card on the content pane: raised fill, radius 16, no border.
export const Card = ({ children, style, padding = 18 }) => (
  <div style={{ background: C.raised, borderRadius: 16, padding, ...style }}>{children}</div>
);

// PillStrip — THE segmented control (§4 header switch, §6 level-2 strip).
// A translucent strip holds BARE items; ONE accent pill sits behind the selected item
// and SLIDES to the next one (left + width animate, 220ms). Items never carry a fill of
// their own and only change ink. Every segmented control in the product renders this.
//   items [{ id, label, Icon?, title?, badge?, disabled? }]  value  onChange(id)
//   onBar white-alpha fills for the black bar   size 'md' 34 | 'sm' 30 | 'bar' 32   grow items share width
export function PillStrip({ items, value, onChange, onBar = false, size = "md", grow = false, style, itemStyle }) {
  const refs = useRef(new Map());
  const wrapRef = useRef(null);
  const [pill, setPill] = useState(null);
  const [ready, setReady] = useState(false);
  const key = items.map(i => i.id + (i.label ?? "") + (i.badge ?? "")).join("|");
  const measure = () => {
    const el = refs.current.get(value);
    if (!el || !wrapRef.current) { setPill(null); return; }
    setPill(pillRect(el, wrapRef.current));
  };
  useLayoutEffect(() => {
    measure();
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [value, key]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined" || !wrapRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [value]);
  const h = size === "bar" ? 32 : size === "sm" ? 30 : 34;
  const padX = size === "bar" ? 16 : size === "sm" ? 12 : 15;
  const fs = size === "sm" ? 13 : 14;
  const inactiveInk = onBar ? "rgba(255,255,255,.72)" : C.textSecondary;
  const hoverInk = onBar ? "#fff" : C.text;
  return (
    <div ref={wrapRef} role="tablist" style={{ position: "relative", display: grow ? "flex" : "inline-flex", alignItems: "center", gap: 2, padding: 4, borderRadius: 999, background: onBar ? "rgba(255,255,255,.08)" : C.surface, maxWidth: "100%", ...style }}>
      {pill && (
        <span aria-hidden className="fc-pill-slider" style={{ position: "absolute", top: 4, bottom: 4, left: pill.left, width: pill.width, borderRadius: 999, background: C.primary, pointerEvents: "none",
          transition: ready ? "left .22s cubic-bezier(.2,0,.2,1), width .22s cubic-bezier(.2,0,.2,1)" : "none" }} />
      )}
      {items.map(({ id, label, Icon, title, badge, disabled }) => {
        const on = id === value;
        return (
          <button key={id} ref={el => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
            role="tab" aria-selected={on} title={title} disabled={disabled} onClick={() => !disabled && onChange(id)}
            onMouseEnter={e => { if (!on) e.currentTarget.style.color = hoverInk; }}
            onMouseLeave={e => { if (!on) e.currentTarget.style.color = inactiveInk; }}
            style={{ position: "relative", zIndex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: h, padding: `0 ${padX}px`, borderRadius: 999, border: "none",
              background: "transparent", cursor: disabled ? "not-allowed" : "pointer", fontFamily: FONT, fontSize: fs, whiteSpace: "nowrap", fontWeight: on ? 700 : 550,
              color: on ? C.onAccent : inactiveInk, opacity: disabled ? .5 : 1, transition: "color .18s ease", flex: grow ? 1 : undefined, ...itemStyle }}>
            {Icon && (React.isValidElement(Icon) ? Icon : <Icon size={15} strokeWidth={on ? 2.4 : 2} />)}
            {label}
            {badge != null && badge !== 0 && badge !== "" && (
              <span style={{ fontSize: 11.5, fontWeight: 780, lineHeight: 1, padding: "3px 6px", borderRadius: 999, background: on ? "rgba(255,255,255,.22)" : C.surface2, color: on ? C.onAccent : C.text }}>{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
// Header mode switch — the same strip on the black bar.
export const HeaderSegmented = (props) => <PillStrip onBar size="bar" {...props} />;

// Level-2 pill strip for sub-sections — a thin wrapper over PillStrip that accepts the
// legacy `tabs` shape (string[] or [{id,label,Icon|icon,count}]).
export const PillTabs = ({ tabs, ...rest }) => (
  <PillStrip items={tabs.map(t => typeof t === "string" ? { id: t, label: t } : { id: t.id, label: t.label, Icon: t.Icon || t.icon, badge: t.count ?? t.badge, title: t.title, disabled: t.disabled })} {...rest} />
);

// Underline tabs (level-1 tabs inside a page). Never rounded — the accent underline must stay straight.
export const UnderlineTabs = ({ tabs, value, onChange, style }) => (
  <div style={{ display: "flex", gap: 4, ...style }}>
    {tabs.map((t) => {
      const tab = typeof t === "string" ? { id: t, label: t } : t;
      const on = tab.id === value;
      const Icon = tab.Icon || tab.icon;
      return (
        <button key={tab.id} className="fc-tab" onClick={() => onChange(tab.id)}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "transparent", border: "none", borderRadius: 0, cursor: "pointer", fontFamily: FONT, padding: "10px 14px", fontSize: 14.5, color: on ? C.primary : C.textSecondary, fontWeight: on ? 700 : 600, borderBottom: `2.5px solid ${on ? C.primary : "transparent"}`, whiteSpace: "nowrap" }}>
          {Icon && <Icon size={16} strokeWidth={2.1} />}{tab.label}
          {tab.count != null && <span style={{ fontSize: 11.5, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: on ? C.primarySoft : C.surface2, color: on ? C.primary : C.textSecondary }}>{tab.count}</span>}
        </button>
      );
    })}
  </div>
);

export const PeriodPills = ({ value, onChange, options = ["7D", "30D", "90D", "Custom"] }) => (
  <PillTabs tabs={options} value={value} onChange={onChange} size="sm" />
);

// Page toolbar. The sidebar already names the active tab, so the page does NOT repeat it as a
// 38px headline — that cost every tab ~90px of its first screen. What remains is one slim row:
// a small mono context label (cycle) + optional one-line sub on the left, the page controls on
// the right. `title` is still accepted (kept for aria/consumers) but rendered only as the label
// when no cycle is given.
export const PageHeader = ({ cycle, title, sub, right }) => {
  const label = cycle || title;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 16, flexWrap: "wrap", minHeight: 36 }}>
      <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        {label && <div className="fs-page-label" style={{ ...T.label, color: C.textMuted, fontFamily: MONO }}>{label}</div>}
        {sub && <div style={{ fontSize: 13.5, color: C.textSecondary, minWidth: 0 }}>{sub}</div>}
      </div>
      {right && <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>{right}</div>}
    </div>
  );
};

// Legacy filter pill — kept for compatibility; prefer SearchableSelect from components/Dropdown.jsx.
export const FilterPill = ({ label, value, options, onChange, allLabel = "All" }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)} className="settings-btn" style={{ minWidth: 0, background: value ? C.primarySoft : undefined, color: value ? C.primary : undefined }}>
        <span style={{ ...T.label, color: value ? C.primary : C.textMuted, fontSize: 11 }}>{label}</span>
        <span style={{ fontWeight: 650 }}>{value || allLabel}</span>
        <span style={{ fontSize: 9, opacity: .6 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: C.raised, borderRadius: 16, boxShadow: C.shadowLg, padding: 6, minWidth: 190, zIndex: 51 }}>
            {[null, ...options].map(opt => {
              const on = opt === null ? !value : value === opt;
              return (
                <div key={opt ?? "__all"} onClick={() => { onChange(opt); setOpen(false); }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = C.surface; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
                  style={{ padding: "9px 12px", fontSize: 14, color: C.text, fontWeight: on ? 700 : 500, borderRadius: 12, cursor: "pointer", background: on ? C.primarySoft : "transparent", fontFamily: FONT }}>
                  {opt ?? allLabel}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

// Composed search field: the WRAPPER is the control; the input inside is bare.
export const SearchBar = ({ value, onChange, placeholder, style, autoFocus }) => (
  <div className="fc-searchfield" style={{ flex: 1, position: "relative", minWidth: 200, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", height: 40, borderRadius: 12, background: C.surface, ...style }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: C.textMuted, flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
    <input value={value} autoFocus={autoFocus} onChange={e => onChange(e.target.value)} placeholder={placeholder || "Search…"}
      style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: 14, fontFamily: FONT, color: C.text, padding: 0, borderRadius: 0 }} />
    {value && <button onClick={() => onChange("")} className="clear-btn" style={{ position: "static", transform: "none" }}>×</button>}
  </div>
);

export const TokenBadge = ({ token }) => {
  if (token === "healthy")  return <Badge label="Healthy"  bg={C.greenSoft} color={C.green} />;
  if (token === "expiring") return <Badge label="Expiring" bg={C.amberSoft} color={C.amber} />;
  return <Badge label="—" bg={C.surface2} color={C.textMuted} />;
};

export const StatusDot = ({ status }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 650, color: status === "connected" ? C.green : C.errText }}>
    <span style={{ width: 8, height: 8, borderRadius: "50%", background: status === "connected" ? C.green : C.textMuted, boxShadow: status === "connected" ? `0 0 0 3px ${C.greenSoft}` : `0 0 0 3px ${C.surface}` }} />
    {status === "connected" ? "Connected" : "Disconnected"}
  </span>
);

// Empty state: centred muted copy, an icon in an accent-soft disc, one primary action.
export const EmptyState = ({ Icon, title, body, action, style }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "48px 24px", gap: 10, ...style }}>
    {Icon && <span style={{ width: 40, height: 40, borderRadius: 12, background: C.primarySoft, color: C.primary, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon size={19} strokeWidth={2.2} /></span>}
    {title && <div style={{ ...T.h3, color: C.text }}>{title}</div>}
    {body && <div style={{ ...T.small, color: C.textMuted, maxWidth: 420 }}>{body}</div>}
    {action && <div style={{ marginTop: 6 }}>{action}</div>}
  </div>
);

// Toggle: 46×26 pill, white knob in both themes, no glow ring.
export const Toggle = ({ on, onChange, disabled, size = "md" }) => {
  const w = size === "sm" ? 38 : 46, h = size === "sm" ? 22 : 26, k = size === "sm" ? 16 : 19, pad = 3.5;
  return (
    <button type="button" role="switch" aria-checked={!!on} disabled={disabled} onClick={() => !disabled && onChange?.(!on)}
      style={{ width: w, height: h, borderRadius: 999, border: "none", padding: 0, position: "relative", flexShrink: 0, cursor: disabled ? "not-allowed" : "pointer", background: on ? C.primary : C.surface2, opacity: disabled ? .5 : 1, transition: "background .2s ease" }}>
      <span style={{ position: "absolute", top: (h - k) / 2, left: on ? w - k - pad : pad, width: k, height: k, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.28)", transition: "left .2s ease" }} />
    </button>
  );
};
