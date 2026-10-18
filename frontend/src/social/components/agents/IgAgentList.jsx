import { useState, useMemo } from "react";
import { Search, Bot, ChevronRight, Trash2, MessageSquare, MessageCircle } from "lucide-react";
import { C, FONT, MONO, BTN, relativeTime } from "../../constants.js";
import { SearchableSelect } from "../Dropdown.jsx";
import { Toggle, EmptyState } from "../UI.jsx";

const STATE_OPTIONS = [{ value: "live", label: "Live" }, { value: "off", label: "Off" }];

const isLive = (a) => !!(a.isActive && a.status === "active");

/** Automations → AI Agents: every Instagram AI agent, with a Live switch per row. */
export default function IgAgentList({ agents, accounts, isAdmin, onOpen, onToggle, onDelete, onCreate }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const userOf = (id) => accounts.find(a => a.account_id === id)?.username;
  const shown = useMemo(() => agents.filter(a =>
    (!q.trim() || a.name.toLowerCase().includes(q.trim().toLowerCase()))
    && (!state || (state === "live" ? isLive(a) : !isLive(a)))
  ), [agents, q, state]);

  if (!agents.length) {
    return (
      <div style={{ background: C.raised, borderRadius: 16 }}>
        <EmptyState Icon={Bot} title="No Instagram AI agents yet"
          body="Pick a ready-made agent, answer a few questions about your business, test it in the phone, and switch it on. It replies to DMs and comments for you."
          action={isAdmin && <button type="button" onClick={onCreate} style={BTN.primary}><Bot size={15} /> New AI agent</button>} />
      </div>
    );
  }

  return (
    <div style={{ fontFamily: FONT }} data-testid="ig-agent-list">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, borderRadius: 12, padding: "0 12px", flex: "1 1 240px", maxWidth: 340 }}>
          <Search size={14} color={C.textMuted} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search AI agents" aria-label="Search AI agents"
            style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontFamily: FONT, fontSize: 13.5, color: C.text, padding: "10px 0" }} />
        </div>
        <SearchableSelect value={state} options={STATE_OPTIONS} onChange={setState} allLabel="Any state" label="State" />
      </div>
      {shown.length === 0 && <div style={{ background: C.raised, borderRadius: 16, padding: 30, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No agents match these filters.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map(a => {
          const user = a.accountLabel || (userOf(a.accountId) ? "@" + userOf(a.accountId) : "No account");
          const where = [a.replyDms && "DMs", a.replyComments && "comments"].filter(Boolean).join(" + ") || "nothing yet";
          return (
            <div key={a.id} role="button" tabIndex={0} onClick={() => onOpen(a)} onKeyDown={e => e.key === "Enter" && onOpen(a)} className="fs-auto-row" data-agent={a.id}
              style={{ display: "flex", alignItems: "center", gap: 12, background: C.raised, borderRadius: 16, padding: "14px 16px", cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 750, letterSpacing: ".04em", flexShrink: 0, background: isLive(a) ? C.primary : C.surface2, color: isLive(a) ? C.onAccent : C.textMuted }}>{isLive(a) ? "LIVE" : a.status === "active" || a.lastRunAt ? "OFF" : "DRAFT"}</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12.5, color: C.textMuted, minWidth: 0 }}>
                  <Bot size={13} style={{ flexShrink: 0 }} />
                  {a.replyDms && <MessageSquare size={12} style={{ flexShrink: 0 }} />}
                  {a.replyComments && <MessageCircle size={12} style={{ flexShrink: 0 }} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Replies to {where} · {a.triggerMode === "keyword" ? `keyword “${a.triggerKeyword}”` : "every message"} · {user}
                  </span>
                </div>
              </div>
              <span style={{ width: 130, textAlign: "right", fontFamily: MONO, fontSize: 12, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className="fs-col-mod" title={a.llmModel || ""}>{a.llmModel || "no model"}</span>
              <span style={{ width: 110, textAlign: "right", fontSize: 12.5, color: C.textMuted }} className="fs-col-mod">{a.lastRunAt ? "ran " + relativeTime(a.lastRunAt) : "never ran"}</span>
              {isAdmin && <span onClick={e => e.stopPropagation()}><Toggle on={isLive(a)} onChange={(v) => onToggle(a, v)} size="sm" /></span>}
              {isAdmin && (
                <button type="button" onClick={e => { e.stopPropagation(); onDelete(a); }} title="Delete" aria-label={`Delete ${a.name}`} className="fs-row-del"
                  style={{ ...BTN.icon, width: 30, height: 30, background: "transparent", color: C.textMuted }}><Trash2 size={14} /></button>
              )}
              <ChevronRight size={16} color={C.textMuted} />
            </div>
          );
        })}
      </div>
      <style>{`.fs-auto-row{transition:box-shadow .15s}.fs-auto-row:hover{box-shadow:0 0 0 2px var(--fc-surface-2)}.fs-row-del{opacity:0}.fs-auto-row:hover .fs-row-del{opacity:1}@media (max-width:700px){.fs-col-mod{display:none}}`}</style>
    </div>
  );
}
