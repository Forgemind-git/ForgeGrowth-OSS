import { Activity } from "lucide-react";
import { C, FONT, MONO, relativeTime } from "../../constants.js";
import { EmptyState } from "../UI.jsx";
import { StatusPill, triggerMeta } from "./shared.jsx";
import PersonLink from "./PersonLink.jsx";

const TRIGGER_LABEL = (t) => t === "gate" ? "Button tap (gate)" : t === "followup" ? "Follow-up" : triggerMeta(t).short;

// What every automation did, newest first, with skip / failure reasons.
export default function ActivityLog({ rows, isAdmin }) {
  if (!rows.length) return <EmptyState Icon={Activity} title="Nothing yet" body="Every comment, DM or tap an automation handles shows up here — what was sent, and why anything was skipped." />;
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 8, overflowX: "auto", fontFamily: FONT }}>
      <table style={{ width: "100%", minWidth: 720 }}>
        <thead>
          <tr>{["When", "Automation", "Trigger", "Who", "What they said", "Result"].map(h => <th key={h} style={{ textAlign: "left", padding: "11px 12px", whiteSpace: "nowrap" }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(l => (
            <tr key={l.id}>
              <td style={{ padding: "11px 12px", fontSize: 12.5, fontFamily: MONO, color: C.textMuted, whiteSpace: "nowrap" }} title={new Date(l.created_at).toLocaleString()}>{relativeTime(l.created_at)}</td>
              <td style={{ padding: "11px 12px", fontSize: 13.5, color: C.text, fontWeight: 600 }}>{l.rule_name || "Deleted automation"}</td>
              <td style={{ padding: "11px 12px", fontSize: 13, color: C.textSecondary, whiteSpace: "nowrap" }}>{TRIGGER_LABEL(l.trigger)}</td>
              <td style={{ padding: "11px 12px", fontSize: 13.5, color: C.text, whiteSpace: "nowrap" }}>
                <PersonLink row={l} isAdmin={isAdmin} style={{ fontWeight: 600 }} />
                {l.username && l.name && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{l.name}</div>}
              </td>
              <td style={{ padding: "11px 12px", fontSize: 13, color: C.textSecondary, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.input_text || ""}>{l.trigger === "gate" ? "Tapped the button" : l.trigger === "followup" ? "Follow-up message" : (l.input_text || "—")}</td>
              <td style={{ padding: "11px 12px" }}>
                <StatusPill status={l.status} />
                {l.error && <div style={{ fontSize: 12, color: l.status === "failed" ? C.errText : C.textMuted, marginTop: 4, maxWidth: 320, lineHeight: 1.35 }}>{l.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
