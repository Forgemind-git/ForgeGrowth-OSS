import { Radio, Activity, MousePointerClick, ClipboardList, Trophy, Flame, Bot } from "lucide-react";
import { C, FONT, MONO } from "../../constants.js";

// A CTR on a handful of sends is noise (1 of 1 = 100%), so "Top CTR" only
// considers automations that have sent at least this many links.
export const MIN_SENDS_FOR_TOP_CTR = 5;

/**
 * The cards above Automations: what is live, how much it ran, how links
 * convert, and the best performers. Numbers come from the SAME rows the table
 * shows (toRows), so a card can never disagree with the list under it.
 *
 * `rows` are already scoped to "My accounts" and the account filter.
 */
export function summarize(rows, agents = []) {
  const live = rows.filter(r => r.active).length;
  const runs = rows.reduce((n, r) => n + (r.runs || 0), 0);
  const clicks = rows.reduce((n, r) => n + (r.clicks || 0), 0);
  const sends = rows.reduce((n, r) => n + (r.sends || 0), 0);
  const leads = rows.reduce((n, r) => n + (r.leads || 0), 0);
  const ranked = rows.filter(r => r.ctr != null && (r.sends || 0) >= MIN_SENDS_FOR_TOP_CTR)
    .sort((a, b) => b.ctr - a.ctr || b.sends - a.sends);
  const busiest = rows.filter(r => r.runs > 0).sort((a, b) => b.runs - a.runs);
  return {
    live, total: rows.length, runs, clicks, sends, leads,
    ctr: sends ? Math.round((clicks / sends) * 100) : null,
    topCtr: ranked[0] || null, busiest: busiest[0] || null,
    agentsLive: agents.filter(a => a.isActive && a.status === "active").length, agents: agents.length,
  };
}

export default function AutomationsDashboard({ rows, agents, onOpen, onShowLive, onShowAgents, liveFilterOn }) {
  const s = summarize(rows, agents);
  const n = (v) => Number(v || 0).toLocaleString("en-IN");
  return (
    <div data-testid="automation-dashboard" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(190px, 100%), 1fr))", gap: 12, marginBottom: 18, fontFamily: FONT }}>
      <Card Icon={Radio} label="Live now" value={`${s.live}`} unit={`of ${s.total}`} testId="dash-live" active={liveFilterOn}
        sub={liveFilterOn ? "Showing live only — click to show all" : "automations answering now"} onClick={onShowLive} />
      <Card Icon={Bot} label="AI agents" value={`${s.agentsLive}`} unit={`of ${s.agents} live`} testId="dash-agents"
        sub={s.agents ? "reply to DMs and comments" : "none yet — create one"} onClick={onShowAgents} />
      <Card Icon={Activity} label="Runs" value={n(s.runs)} sub="times an automation fired" testId="dash-runs" />
      <Card Icon={MousePointerClick} label="Link CTR" value={s.ctr != null ? `${s.ctr}%` : "–"} testId="dash-ctr"
        sub={s.sends ? `${n(s.clicks)} ${s.clicks === 1 ? "click" : "clicks"} of ${n(s.sends)} ${s.sends === 1 ? "link" : "links"} sent` : "no links sent yet"} />
      <Card Icon={ClipboardList} label="Leads" value={n(s.leads)} sub="captured by quick automations" testId="dash-leads" />
      <Card Icon={Trophy} label="Top CTR" testId="dash-top-ctr"
        value={s.topCtr ? `${s.topCtr.ctr}%` : "–"} title={s.topCtr?.name}
        sub={s.topCtr ? s.topCtr.name : `needs ${MIN_SENDS_FOR_TOP_CTR}+ links sent`} onClick={s.topCtr ? () => onOpen(s.topCtr) : undefined} />
      <Card Icon={Flame} label="Most runs" testId="dash-busiest"
        value={s.busiest ? n(s.busiest.runs) : "–"} title={s.busiest?.name}
        sub={s.busiest ? s.busiest.name : "nothing has run yet"} onClick={s.busiest ? () => onOpen(s.busiest) : undefined} />
    </div>
  );
}

function Card({ Icon, label, value, unit, sub, onClick, testId, active, title }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} data-testid={testId} title={title}
      className={onClick ? "fs-dash-card" : undefined}
      style={{ textAlign: "left", border: "none", fontFamily: FONT, background: active ? C.primarySoft : C.raised, borderRadius: 16, padding: "14px 16px", cursor: onClick ? "pointer" : "default", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 650, letterSpacing: ".04em", textTransform: "uppercase", color: active ? C.primary : C.textMuted }}>
        <Icon size={13} /> {label}
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 780, letterSpacing: "-0.02em", color: C.text, lineHeight: 1.15 }}>{value}</span>
        {unit && <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>{unit}</span>}
      </span>
      <span style={{ fontSize: 12.5, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>
      <style>{".fs-dash-card{transition:box-shadow .15s}.fs-dash-card:hover{box-shadow:0 0 0 2px var(--fc-surface-2)}"}</style>
    </Tag>
  );
}
