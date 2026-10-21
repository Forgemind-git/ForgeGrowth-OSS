import { useEffect } from "react";
import { X, Zap, Bot } from "lucide-react";
import { C, FONT, BTN, T } from "../../constants.js";
import { TEMPLATES } from "./shared.jsx";
import { IG_QUICK_AGENTS } from "../agents/igQuickAgents.js";

// "New Automation" / "New AI agent" picker. Creation is preset-only: an
// automation starts from the one quick template (Auto-DM links from comments),
// an AI agent from one of the Instagram agent presets. There is no blank path.
export default function TemplatesModal({ onClose, onQuick, onAgent, initialFilter = "all" }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const agentMode = initialFilter === "agent" && !!onAgent;
  const items = agentMode
    ? IG_QUICK_AGENTS.map(t => ({ ...t, kind: "agent" }))
    : TEMPLATES.map(t => ({ ...t, kind: "quick" }));
  const pick = (t) => (t.kind === "agent" ? onAgent(t) : onQuick(t));

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1000, background: C.scrim, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
      <div role="dialog" aria-label="Templates" data-testid="ig-templates" style={{ width: agentMode ? "min(1000px, 100%)" : "min(560px, 100%)", maxHeight: "min(760px, 100%)", background: C.raised, borderRadius: 20, boxShadow: C.shadowLg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
          <span style={{ ...T.h3, fontSize: 19, color: C.text, flex: 1 }}>{agentMode ? "New AI agent" : "New automation"}</span>
          <button type="button" onClick={onClose} style={BTN.icon} aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }}>
          <Grid items={items} onPick={pick} />
        </div>
      </div>
    </div>
  );
}

function Grid({ items, onPick }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(250px, 100%), 1fr))", gap: 12 }}>
      {items.map(t => (
        <button key={t.kind + t.id} type="button" onClick={() => onPick(t)} className="fs-tpl-card"
          style={{ display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "left", minHeight: 150, padding: 16, borderRadius: 16, border: "none", cursor: "pointer", fontFamily: FONT, background: C.surface }}>
          <div style={{ fontSize: 16, fontWeight: 750, color: C.text, letterSpacing: "-0.01em", lineHeight: 1.3 }}>{t.title}</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6, lineHeight: 1.45, flex: 1 }}>{t.body}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 12, color: C.textSecondary, fontWeight: 600 }}>
            {t.kind === "agent" ? <Bot size={13} /> : <Zap size={13} />}
            {t.kind === "agent" ? "Quick AI Agent" : "Quick Automation"}
          </div>
        </button>
      ))}
      <style>{".fs-tpl-card{transition:box-shadow .15s, transform .15s}.fs-tpl-card:hover{box-shadow:0 0 0 2px var(--fc-primary);transform:translateY(-1px)}"}</style>
    </div>
  );
}
