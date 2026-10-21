// ============================================================
// Dropdown.jsx — uniform dropdown UI/UX for ForgeGrowth
//
// Matches the FORGECHAT dropdown look (SearchableSelect / TagMultiSelect):
// Borderless: surface-filled trigger that shows an INSET accent ring while open
// (and an accent-soft fill while it holds a filter value), a raised popover with
// the large shadow, an optional type-to-filter search box (only when the list
// is long), check-marked rows, accent-soft selected / surface hover states.
//
//   <SearchableSelect label="Platform" value={v} onChange={fn}
//       options={["Instagram"]} allLabel="All" />   // filter pill
//   <SearchableSelect value={v} onChange={fn} fullWidth        // form field
//       options={[{value,label,sublabel}]} placeholder="Choose…" />
//   <MultiSelect label="Accounts" values={arr} onChange={fn}
//       options={[{value,label,group}]} placeholder="All accounts" />
// ============================================================

import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Check, Search, X, Plus } from "lucide-react";
import { C, FONT } from "../constants.js";

// Popover: raised fill, radius 16, large shadow, rows carry no fill of their own.
const POP = {
  position: "absolute", top: "calc(100% + 6px)", left: 0,
  background: C.raised, border: "none", borderRadius: 16,
  boxShadow: C.shadowLg, zIndex: 80, overflow: "hidden", fontFamily: FONT,
  animation: "fc-pop-in .18s ease-out both",
};
const SELECTED_BG = C.primarySoft;
// Trigger = input recipe + chevron; open = inset accent ring, never a border.
const TRIGGER = {
  width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 30px 9px 12px",
  borderRadius: 12, border: "none", fontSize: 14, fontFamily: FONT, background: C.surface,
  color: C.text, textAlign: "left", position: "relative", outline: "none", boxSizing: "border-box",
  transition: "box-shadow .15s, background .15s",
};

const norm = (o) => (typeof o === "string" || typeof o === "number") ? { value: o, label: String(o) } : o;

function useDismiss(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, setOpen, ref]);
}

function SearchBox({ inputRef, query, setQuery, placeholder = "Search…" }) {
  return (
    <div className="fc-searchfield" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 12, background: C.surface, marginBottom: 4 }}>
      <Search size={14} color={C.textMuted} style={{ flexShrink: 0 }} />
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, padding: 0, borderRadius: 0, border: "none", fontSize: 13.5, fontFamily: FONT, color: C.text, outline: "none", background: "transparent" }} />
    </div>
  );
}

// "+ Create “query”" row shown when onCreate is given and nothing matches exactly.
function CreateRow({ query, onCreate, onCreated, label = "Create" }) {
  const [busy, setBusy] = useState(false);
  const q = query.trim();
  if (!q || !onCreate) return null;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try { const v = await onCreate(q); if (v != null) onCreated(v); }
    finally { setBusy(false); }
  };
  return (
    <div onClick={go} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, cursor: "pointer", color: C.primary, fontSize: 13.5, fontWeight: 650 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = C.hoverBg; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
      <Plus size={13} /> {busy ? "Creating…" : <>{label} “{q}”</>}
    </div>
  );
}

function Row({ label, sublabel, on, onClick, checkbox }) {
  return (
    <div onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, cursor: "pointer", background: on ? SELECTED_BG : "transparent" }}
      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = C.hoverBg; }}
      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
      {checkbox ? (
        <span style={{ width: 16, height: 16, borderRadius: 5, flexShrink: 0, border: "none", background: on ? C.primary : C.surface2, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {on && <Check size={11} color={C.onAccent} />}
        </span>
      ) : (
        <Check size={13} color={C.primary} style={{ flexShrink: 0, opacity: on ? 1 : 0 }} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, color: C.text, fontWeight: on ? 650 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sublabel}</div>}
      </div>
    </div>
  );
}

/* ─── Single-select ─────────────────────────────────────────── */
export function SearchableSelect({
  value, onChange, options = [], label, placeholder = "Select…", allLabel,
  searchPlaceholder = "Search…", searchThreshold = 7, disabled,
  minWidth = 140, fullWidth = false, style, onCreate, createLabel,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);
  const opts = useMemo(() => options.map(norm), [options]);
  useDismiss(open, setOpen, ref);
  useEffect(() => { if (open) { setQuery(""); const t = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(t); } }, [open]);

  const selected = opts.find((o) => String(o.value) === String(value));
  const hasValue = selected != null && value != null && value !== "";
  const triggerText = selected ? selected.label : (allLabel || placeholder);
  const activeBorder = open || (allLabel !== undefined && hasValue);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter((o) => String(o.label).toLowerCase().includes(q) || String(o.sublabel || "").toLowerCase().includes(q));
  }, [opts, query]);
  const showSearch = opts.length > searchThreshold || !!onCreate;
  const choose = (v) => { onChange(v); setOpen(false); };
  const exact = opts.some((o) => String(o.label).toLowerCase() === query.trim().toLowerCase());

  return (
    <div ref={ref} style={{ position: "relative", width: fullWidth ? "100%" : undefined, minWidth: fullWidth ? undefined : minWidth, ...style }}>
      <button type="button" className="fc-square" disabled={disabled} onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          ...TRIGGER,
          boxShadow: open ? `inset 0 0 0 1.5px ${C.primary}` : "none",
          background: activeBorder && !open ? C.primarySoft : C.surface,
          opacity: disabled ? .55 : 1, cursor: disabled ? "not-allowed" : "pointer",
        }}>
        {label && <span style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: ".04em", textTransform: "uppercase", color: activeBorder ? C.primary : C.textMuted, flexShrink: 0 }}>{label}</span>}
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600, color: selected ? (activeBorder ? C.primary : C.text) : C.textMuted }}>{triggerText}</span>
        <ChevronDown size={14} color={C.textMuted} style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
      </button>
      {open && (
        <div style={{ ...POP, minWidth: 190, width: "max-content", maxWidth: 300 }}>
          {showSearch && <div style={{ padding: "8px 8px 0" }}><SearchBox inputRef={inputRef} query={query} setQuery={setQuery} placeholder={searchPlaceholder} /></div>}
          <div style={{ maxHeight: 244, overflowY: "auto", padding: 6 }}>
            {allLabel !== undefined && <Row label={allLabel} on={!hasValue} onClick={() => choose(null)} />}
            {filtered.length === 0 && !(onCreate && query.trim()) ? (
              <div style={{ padding: "10px 8px", color: C.textMuted, fontSize: 13.5 }}>{onCreate ? "Type a name to create one" : "No matches"}</div>
            ) : filtered.map((o) => <Row key={o.value} label={o.label} sublabel={o.sublabel} on={String(o.value) === String(value)} onClick={() => choose(o.value)} />)}
            {!exact && <CreateRow query={query} onCreate={onCreate} label={createLabel} onCreated={(v) => choose(v)} />}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Multi-select ──────────────────────────────────────────── */
export function MultiSelect({
  values = [], onChange, options = [], label, placeholder = "All",
  searchThreshold = 7, minWidth = 170, emptyText = "None available", style, onCreate, createLabel,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);
  const opts = useMemo(() => options.map(norm), [options]);
  useDismiss(open, setOpen, ref);
  useEffect(() => { if (open) { setQuery(""); const t = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(t); } }, [open]);

  const sel = new Set(values.map(String));
  const toggle = (v) => {
    const next = new Set(sel);
    if (next.has(String(v))) next.delete(String(v)); else next.add(String(v));
    onChange(opts.filter((o) => next.has(String(o.value))).map((o) => o.value));
  };
  const count = sel.size;
  const trig = count === 0 ? placeholder
    : count === 1 ? (opts.find((o) => sel.has(String(o.value)))?.label || "1 selected")
    : `${count} selected`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return opts;
    return opts.filter((o) => String(o.label).toLowerCase().includes(q) || String(o.group || "").toLowerCase().includes(q));
  }, [opts, query]);
  const showSearch = opts.length > searchThreshold || !!onCreate;
  const exact = opts.some((o) => String(o.label).toLowerCase() === query.trim().toLowerCase());
  const grouped = useMemo(() => {
    const m = new Map();
    filtered.forEach((o) => { const g = o.group || ""; if (!m.has(g)) m.set(g, []); m.get(g).push(o); });
    return [...m.entries()];
  }, [filtered]);

  return (
    <div ref={ref} style={{ position: "relative", minWidth, ...style }}>
      <button type="button" className="fc-square" onClick={() => setOpen((o) => !o)}
        style={{ ...TRIGGER, padding: "9px 12px", boxShadow: open ? `inset 0 0 0 1.5px ${C.primary}` : "none", background: count && !open ? C.primarySoft : C.surface, cursor: "pointer" }}>
        {label && <span style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: ".04em", textTransform: "uppercase", color: count ? C.primary : C.textMuted, flexShrink: 0 }}>{label}</span>}
        <span style={{ flex: 1, textAlign: "left", fontSize: 14, fontWeight: 600, color: count ? C.primary : C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{trig}</span>
        {count > 0 && <span role="button" title="Clear" onClick={(e) => { e.stopPropagation(); onChange([]); }} style={{ display: "flex", color: C.textMuted, flexShrink: 0 }}><X size={13} /></span>}
        <ChevronDown size={14} color={C.textMuted} style={{ flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ ...POP, minWidth: Math.max(minWidth, 210), width: "max-content", maxWidth: 320, maxHeight: 330, overflowY: "auto", padding: 6 }}>
          {showSearch && <SearchBox inputRef={inputRef} query={query} setQuery={setQuery} />}
          {!exact && <CreateRow query={query} onCreate={onCreate} label={createLabel} onCreated={(v) => { onChange([...values, v]); setQuery(""); }} />}
          {opts.length === 0 && !onCreate ? (
            <div style={{ padding: "10px 8px", color: C.textMuted, fontSize: 13.5 }}>{emptyText}</div>
          ) : opts.length === 0 && !query.trim() ? (
            <div style={{ padding: "10px 8px", color: C.textMuted, fontSize: 13.5 }}>Type a name to create one</div>
          ) : grouped.map(([g, items]) => (
            <div key={g || "_"} style={{ marginBottom: 2 }}>
              {g && <div style={{ fontSize: 11.5, fontWeight: 650, color: C.textMuted, textTransform: "uppercase", letterSpacing: ".04em", padding: "8px 10px 3px", fontFamily: "var(--fc-font-mono)" }}>{g}</div>}
              {items.map((o) => <Row key={o.value} label={o.label} sublabel={o.sublabel} on={sel.has(String(o.value))} onClick={() => toggle(o.value)} checkbox />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
