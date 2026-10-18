import { useState, useEffect, useRef } from "react";
import { X, Plus, Search, Zap, Workflow, FileText, MessageCircle, Reply, MessageSquare, AtSign, ArrowRightCircle, Bot } from "lucide-react";
import { C, FONT, BTN, T } from "../../constants.js";
import { TEMPLATES } from "./shared.jsx";
import { FLOW_TEMPLATES, TEMPLATE_GOALS } from "../flows/flowDefs.js";
import { IG_QUICK_AGENTS } from "../agents/igQuickAgents.js";

// ManyChat-style "Templates" picker: quick automations (simple editor) and
// Flow Builder templates (node canvas), filterable by goal / trigger, plus
// "Start From Scratch" with a trigger or a blank canvas.
const QUICK_META = {
  comment_link:  { goal: "traffic", trigger: "comment", popular: true },
  comment_leads: { goal: "leads",   trigger: "comment" },
  comment_followers: { goal: "followers", trigger: "comment", popular: true },
  dm_followers:  { goal: "followers", trigger: "dm" },
  dm_keyword:    { goal: "engage",  trigger: "dm" },
  story_reply:   { goal: "engage",  trigger: "story_reply" },
};
const TRIGGER_FILTERS = [
  { id: "comment", label: "Post or Reel comment" },
  { id: "dm", label: "DM" },
  { id: "story_reply", label: "Story reply" },
  { id: "called", label: "Started by another automation" },
];
const SCRATCH = [
  { id: "comment", label: "Post or Reel comment", Icon: MessageCircle },
  { id: "story_reply", label: "Story reply", Icon: Reply },
  { id: "dm", label: "Direct message", Icon: MessageSquare },
  { id: "story_mention", label: "Story mention", Icon: AtSign },
  { id: "called", label: "Started by another automation", Icon: ArrowRightCircle },
];

export default function TemplatesModal({ onClose, onQuick, onFlow, onScratch, onAgent, initialFilter = "all" }) {
  const [filter, setFilter] = useState(initialFilter);
  const [q, setQ] = useState("");
  const [scratchOpen, setScratchOpen] = useState(false);
  const scratchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = (e) => { if (scratchRef.current && !scratchRef.current.contains(e.target)) setScratchOpen(false); };
    window.addEventListener("keydown", onKey); document.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [onClose]);

  const all = [
    ...TEMPLATES.map(t => ({ ...t, ...QUICK_META[t.id], kind: "quick" })),
    ...FLOW_TEMPLATES.map(t => ({ ...t, kind: "flow" })),
    // Quick Instagram AI agents (Automations → AI Agents) — shown only when the page can open them.
    ...(onAgent ? IG_QUICK_AGENTS.map(t => ({ ...t, kind: "agent" })) : []),
  ];
  const match = (t) => (filter === "all" || t.goal === filter || t.trigger === filter || (filter === "agent" && t.kind === "agent"))
    && (!q.trim() || (t.title + " " + t.body + " " + (t.keywords || "")).toLowerCase().includes(q.trim().toLowerCase()));
  const shown = all.filter(match);
  const recommended = filter === "all" && !q.trim() ? shown.filter(t => t.kind === "quick").slice(0, 3) : [];
  const rest = recommended.length ? shown.filter(t => !recommended.includes(t)) : shown;
  const pick = (t) => (t.kind === "quick" ? onQuick(t) : t.kind === "agent" ? onAgent(t) : onFlow(t));

  const side = (id, label) => (
    <button key={id} type="button" onClick={() => setFilter(id)}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 13.5,
        background: filter === id ? C.surface2 : "transparent", color: filter === id ? C.text : C.textSecondary, fontWeight: filter === id ? 700 : 500 }}>
      <span style={{ display: "contents" }}>{label}</span>
    </button>
  );

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1000, background: C.scrim, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
      <div role="dialog" aria-label="Templates" data-testid="ig-templates" style={{ width: "min(1180px, 100%)", height: "min(760px, 100%)", background: C.raised, borderRadius: 20, boxShadow: C.shadowLg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
          <span style={{ ...T.h3, fontSize: 19, color: C.text, flex: 1 }}>Templates</span>
          <div ref={scratchRef} style={{ position: "relative" }}>
            <button type="button" onClick={() => setScratchOpen(o => !o)} style={BTN.secondary}><Plus size={15} /> Start From Scratch</button>
            {scratchOpen && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 5, width: 270, background: C.raised, borderRadius: 14, boxShadow: C.shadowLg, padding: 6 }}>
                <div style={{ ...T.label, color: C.textMuted, padding: "8px 10px 4px" }}>Start with a trigger</div>
                {SCRATCH.map(s => <MenuRow key={s.id} Icon={s.Icon} label={s.label} onClick={() => onScratch(s.id)} />)}
                <div style={{ height: 1, background: C.surface2, margin: "6px 4px" }} />
                <div style={{ ...T.label, color: C.textMuted, padding: "8px 10px 4px" }}>Build your own way</div>
                <MenuRow Icon={FileText} label="Start from a blank canvas" onClick={() => onScratch(null)} />
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} style={BTN.icon} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: 210, flexShrink: 0, padding: 14, overflowY: "auto", boxShadow: `inset -1px 0 0 ${C.surface2}` }} className="fs-tpl-side">
            {side("all", "All templates")}
            <div style={{ ...T.label, color: C.textMuted, margin: "16px 10px 6px" }}>By goal</div>
            {TEMPLATE_GOALS.map(g => side(g.id, g.label))}
            <div style={{ ...T.label, color: C.textMuted, margin: "16px 10px 6px" }}>By trigger</div>
            {TRIGGER_FILTERS.map(g => side(g.id, g.label))}
            {onAgent && <><div style={{ ...T.label, color: C.textMuted, margin: "16px 10px 6px" }}>AI</div>{side("agent", "Instagram AI agents")}</>}
          </div>
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "16px 20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, borderRadius: 12, padding: "9px 12px", maxWidth: 360, marginBottom: 18, marginLeft: "auto" }}>
              <Search size={14} color={C.textMuted} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Instagram templates…" aria-label="Search templates"
                style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontFamily: FONT, fontSize: 13.5, color: C.text }} />
            </div>
            {recommended.length > 0 && <><Heading>Recommended</Heading><Grid items={recommended} onPick={pick} /></>}
            <Heading>{recommended.length ? "Discover more templates" : `${shown.length} template${shown.length === 1 ? "" : "s"}`}</Heading>
            {rest.length ? <Grid items={rest} onPick={pick} /> : <div style={{ color: C.textMuted, fontSize: 14, padding: 20 }}>No templates match. Try Start From Scratch.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

const Heading = ({ children }) => <div style={{ ...T.h3, fontSize: 18, color: C.text, margin: "4px 0 12px" }}>{children}</div>;

function Grid({ items, onPick }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(250px, 100%), 1fr))", gap: 12, marginBottom: 26 }}>
      {items.map(t => (
        <button key={t.kind + t.id} type="button" onClick={() => onPick(t)} className="fs-tpl-card"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "left", minHeight: 170, padding: 16, borderRadius: 16, border: "none", cursor: "pointer", fontFamily: FONT, background: C.surface }}>
          <div style={{ fontSize: 16, fontWeight: 750, color: C.text, letterSpacing: "-0.01em", lineHeight: 1.3 }}>{t.title}</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6, lineHeight: 1.45, flex: 1 }}>{t.body}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 12, color: C.textSecondary, fontWeight: 600 }}>
            {t.kind === "quick" ? <Zap size={13} /> : t.kind === "agent" ? <Bot size={13} /> : <Workflow size={13} />}
            {t.kind === "quick" ? "Quick Automation" : t.kind === "agent" ? "Quick AI Agent" : "Flow Builder"}
            {t.popular && <span style={{ marginLeft: "auto", padding: "2px 7px", borderRadius: 5, background: C.primary, color: C.onAccent, fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em" }}>POPULAR</span>}
          </div>
        </button>
      ))}
      <style>{".fs-tpl-card{transition:box-shadow .15s, transform .15s}.fs-tpl-card:hover{box-shadow:0 0 0 2px var(--fc-primary);transform:translateY(-1px)}"}</style>
    </div>
  );
}

function MenuRow({ Icon, label, onClick }) {
  return (
    <button type="button" onClick={onClick} className="fs-menu-row"
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, fontSize: 13.5, color: C.text, borderRadius: 10, textAlign: "left" }}>
      <Icon size={16} color={C.textSecondary} /><span>{label}</span>
      <style>{".fs-menu-row:hover{background:var(--fc-surface) !important}"}</style>
    </button>
  );
}
