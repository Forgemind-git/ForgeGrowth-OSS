import { useState, useMemo } from "react";
import { Search, Zap, Workflow, ChevronRight, Trash2, Image as ImageIcon } from "lucide-react";
import { C, FONT, MONO, BTN, relativeTime } from "../../constants.js";
import { SearchableSelect } from "../Dropdown.jsx";
import { triggerMeta } from "./shared.jsx";
import { triggerText, TRIGGER_KINDS } from "../flows/flowDefs.js";

// ManyChat "My Automations": quick automations (rules) and Flow Builder flows in one table.
export function toRows(rules, flows) {
  const ruleRows = rules.map(r => {
    const t = triggerMeta(r.trigger);
    const kw = r.keywords?.length ? ` “${r.keywords.slice(0, 3).join("”, “")}”` : r.trigger === "story_mention" ? "" : " any word";
    const hasLink = JSON.stringify(r.dm_message || {}).includes("web_url");
    return {
      key: `r${r.id}`, kind: "quick", raw: r, name: r.name, active: r.active, trigger: r.trigger,
      line: `${t.short}${r.trigger === "comment" ? (r.media_id ? " on a specific post" : " on any post") : ""} ·${kw}`,
      thumb: r.trigger === "comment" ? r.media_thumbnail : null, account: r.account_username,
      runs: r.fired, ctr: r.ctr !== undefined ? r.ctr : hasLink && r.fired ? Math.round(((r.clicks || 0) / r.fired) * 100) : null,
      // Same base the backend CTR uses (commentAutomation.ruleCtr): link sends, or DMs sent when the DM has a link.
      leads: r.leads || 0, clicks: r.clicks || 0, sends: Math.max(r.link_sends || 0, hasLink ? (r.dms ?? r.fired ?? 0) : 0),
      modified: r.updated_at || r.created_at, draft: false,
    };
  });
  const flowRows = flows.map(f => {
    const ts = (f.graph?.nodes || []).find(n => n.type === "trigger")?.data?.triggers || [];
    return {
      key: `f${f.id}`, kind: "flow", raw: f, name: f.name, active: f.active, trigger: ts[0]?.kind || null, triggers: ts.map(t => t.kind),
      line: ts.length ? ts.map(triggerText).join(" · ") : "No trigger yet", thumb: null, account: f.account_username,
      runs: f.runs, ctr: f.link_sends ? Math.round((f.clicks / f.link_sends) * 100) : null,
      leads: 0, clicks: f.clicks || 0, sends: f.link_sends || 0,
      modified: f.updated_at, draft: !f.active && !f.runs,
    };
  });
  return [...flowRows, ...ruleRows].sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
}

const TRIGGER_OPTIONS = [...TRIGGER_KINDS.map(k => ({ value: k.id, label: k.label })), { value: "postback", label: "Button tap" }];
const STATE_OPTIONS = [{ value: "live", label: "Live" }, { value: "off", label: "Off" }, { value: "draft", label: "Draft" }];
export const SORT_OPTIONS = [
  { value: "modified", label: "Recently changed" },
  { value: "runs", label: "Most runs" },
  { value: "ctr", label: "Highest CTR" },
  { value: "name", label: "Name (A–Z)" },
];
// No CTR (no link sent yet) sorts last whichever way, so "Highest CTR" never leads with blanks.
const SORTERS = {
  modified: (a, b) => new Date(b.modified || 0) - new Date(a.modified || 0),
  runs: (a, b) => (b.runs || 0) - (a.runs || 0),
  ctr: (a, b) => (b.ctr ?? -1) - (a.ctr ?? -1) || (b.sends || 0) - (a.sends || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

// `view` = "list" (rows) | "grid" (cards). Filters and sort apply to both.
// `stateFilter` lets the dashboard's "Live" card narrow the list from outside.
export default function AutomationTable({ rows, onOpen, onDelete, isAdmin, view = "list", stateFilter, onStateFilter }) {
  const [q, setQ] = useState("");
  const [trig, setTrig] = useState("");
  const [ownState, setOwnState] = useState("");
  const state = stateFilter !== undefined ? stateFilter : ownState;
  const setState = onStateFilter || setOwnState;
  const [sort, setSort] = useState("modified");
  const shown = useMemo(() => rows.filter(r =>
    (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()))
    && (!trig || r.trigger === trig || r.triggers?.includes(trig))
    && (!state || (state === "live" ? r.active : state === "draft" ? r.draft : !r.active && !r.draft))
  ).sort(SORTERS[sort] || SORTERS.modified), [rows, q, trig, state, sort]);

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, borderRadius: 12, padding: "0 12px", flex: "1 1 240px", maxWidth: 340 }}>
          <Search size={14} color={C.textMuted} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search all automations" aria-label="Search automations"
            style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontFamily: FONT, fontSize: 13.5, color: C.text, padding: "10px 0" }} />
        </div>
        <SearchableSelect value={trig} options={TRIGGER_OPTIONS} onChange={setTrig} allLabel="Any trigger" label="Trigger" />
        <SearchableSelect value={state} options={STATE_OPTIONS} onChange={setState} allLabel="Any state" label="State" />
        <SearchableSelect value={sort} options={SORT_OPTIONS} onChange={v => setSort(v || "modified")} label="Sort" />
      </div>

      {view === "grid" ? (
        <>
          {shown.length === 0 && <div style={{ background: C.raised, borderRadius: 16, padding: 30, textAlign: "center", color: C.textMuted, fontSize: 14 }}>{rows.length ? "No automations match these filters." : "No automations yet. Create one from a template."}</div>}
          <div data-testid="automation-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))", gap: 12 }}>
            {shown.map(r => <GridCard key={r.key} r={r} onOpen={onOpen} onDelete={onDelete} isAdmin={isAdmin} />)}
          </div>
          <style>{`.fs-auto-card{transition:box-shadow .15s, transform .15s}.fs-auto-card:hover{box-shadow:0 0 0 2px var(--fc-surface-2);transform:translateY(-1px)}.fs-row-del{opacity:0}.fs-auto-card:hover .fs-row-del{opacity:1}`}</style>
        </>
      ) : (<>

      <div style={{ display: "flex", alignItems: "center", padding: "0 16px 8px", fontSize: 12, color: C.textMuted, fontWeight: 600 }}>
        <span style={{ flex: 1 }}>Name</span>
        <span style={{ width: 70, textAlign: "right" }}>Runs</span>
        <span style={{ width: 70, textAlign: "right" }}>CTR</span>
        <span style={{ width: 110, textAlign: "right" }} className="fs-col-mod">Modified</span>
        <span style={{ width: isAdmin ? 62 : 24 }} />
      </div>
      {shown.length === 0 && <div style={{ background: C.raised, borderRadius: 16, padding: 30, textAlign: "center", color: C.textMuted, fontSize: 14 }}>{rows.length ? "No automations match these filters." : "No automations yet. Create one from a template."}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map(r => (
          <div key={r.key} role="button" tabIndex={0} onClick={() => onOpen(r)} onKeyDown={e => e.key === "Enter" && onOpen(r)} className="fs-auto-row"
            style={{ display: "flex", alignItems: "center", gap: 12, background: C.raised, borderRadius: 16, padding: "14px 16px", cursor: "pointer" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Badge r={r} />
                <span style={{ fontSize: 15, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12.5, color: C.textMuted, minWidth: 0 }}>
                {r.kind === "flow" ? <Workflow size={13} style={{ flexShrink: 0 }} /> : <Zap size={13} style={{ flexShrink: 0 }} />}
                {r.thumb && <img src={r.thumb} alt="" style={{ width: 16, height: 16, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.line}{r.account ? ` · @${r.account}` : ""}</span>
              </div>
            </div>
            <span style={{ width: 70, textAlign: "right", fontFamily: MONO, fontWeight: 700, fontSize: 15, color: r.runs ? C.text : C.textMuted }}>{r.runs ?? 0}</span>
            <span style={{ width: 70, textAlign: "right", fontFamily: MONO, fontWeight: 700, fontSize: 15, color: r.ctr != null ? C.text : C.textMuted }}>{r.ctr != null ? r.ctr + "%" : "–"}</span>
            <span style={{ width: 110, textAlign: "right", fontSize: 12.5, color: C.textMuted }} className="fs-col-mod">{r.modified ? relativeTime(r.modified) : ""}</span>
            {isAdmin && (
              <button type="button" onClick={e => { e.stopPropagation(); onDelete(r); }} title="Delete" aria-label={`Delete ${r.name}`} className="fs-row-del"
                style={{ ...BTN.icon, width: 30, height: 30, background: "transparent", color: C.textMuted }}><Trash2 size={14} /></button>
            )}
            <ChevronRight size={16} color={C.textMuted} />
          </div>
        ))}
      </div>
      <style>{`.fs-auto-row{transition:box-shadow .15s}.fs-auto-row:hover{box-shadow:0 0 0 2px var(--fc-surface-2)}.fs-row-del{opacity:0}.fs-auto-row:hover .fs-row-del{opacity:1}@media (max-width:700px){.fs-col-mod{display:none}}`}</style>
      </>)}
    </div>
  );
}

// Grid view: one card per automation — what it is, whether it is live, and how it is doing.
function GridCard({ r, onOpen, onDelete, isAdmin }) {
  const stat = (label, value, on) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 650, letterSpacing: ".04em", textTransform: "uppercase", color: C.textMuted }}>{label}</div>
      <div style={{ fontFamily: MONO, fontWeight: 750, fontSize: 18, color: on ? C.text : C.textMuted, marginTop: 2 }}>{value}</div>
    </div>
  );
  return (
    <div role="button" tabIndex={0} onClick={() => onOpen(r)} onKeyDown={e => e.key === "Enter" && onOpen(r)} className="fs-auto-card" data-card={r.key}
      style={{ display: "flex", flexDirection: "column", background: C.raised, borderRadius: 16, padding: 14, cursor: "pointer", minHeight: 186, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        {r.thumb
          ? <img src={r.thumb} alt="" style={{ width: 44, height: 54, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} onError={e => { e.currentTarget.style.display = "none"; }} />
          : <span style={{ width: 44, height: 54, borderRadius: 8, background: C.surface2, color: C.textMuted, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {r.kind === "flow" ? <Workflow size={18} /> : r.trigger === "comment" ? <ImageIcon size={18} /> : <Zap size={18} />}
            </span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Badge r={r} />
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginTop: 6, lineHeight: 1.3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{r.name}</div>
        </div>
        {isAdmin && (
          <button type="button" onClick={e => { e.stopPropagation(); onDelete(r); }} title="Delete" aria-label={`Delete ${r.name}`} className="fs-row-del"
            style={{ ...BTN.icon, width: 28, height: 28, background: "transparent", color: C.textMuted }}><Trash2 size={14} /></button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 12.5, color: C.textMuted, minWidth: 0 }}>
        {r.kind === "flow" ? <Workflow size={13} style={{ flexShrink: 0 }} /> : <Zap size={13} style={{ flexShrink: 0 }} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.line}</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", gap: 10, background: C.surface, borderRadius: 12, padding: "9px 12px", marginTop: 12 }}>
        {stat("Runs", r.runs ?? 0, !!r.runs)}
        {stat("CTR", r.ctr != null ? r.ctr + "%" : "–", r.ctr != null)}
        {stat("Leads", r.leads || 0, !!r.leads)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8, fontSize: 12, color: C.textMuted }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.account ? "@" + r.account : ""}</span>
        <span style={{ flexShrink: 0 }}>{r.modified ? relativeTime(r.modified) : ""}</span>
      </div>
    </div>
  );
}

function Badge({ r }) {
  const s = r.active ? { bg: C.primary, fg: C.onAccent, t: "LIVE" } : r.draft ? { bg: C.surface2, fg: C.textMuted, t: "DRAFT" } : { bg: C.surface2, fg: C.textSecondary, t: "OFF" };
  return <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 750, letterSpacing: ".04em", background: s.bg, color: s.fg, flexShrink: 0 }}>{s.t}</span>;
}
