import { useState } from "react";
import { UserPlus, UserMinus, Inbox as InboxIcon, Activity } from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import { api } from "../api.js";
import { C, T, FONT, MONO, relativeTime } from "../constants.js";
import { PageHeader, Card, EmptyState } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";

// action → friendly verb + icon + colour (status hue on the icon only).
const ACTIONS = {
  "user.invite":     { label: "added a teammate",      Icon: UserPlus,     color: C.blue },
  "user.remove":     { label: "removed a teammate",    Icon: UserMinus,    color: C.errText },
  "inbox.update":    { label: "updated an inbox item", Icon: InboxIcon,    color: C.amber },
};
const FILTERS = [
  { value: "user",    label: "Team" },
  { value: "inbox",   label: "Inbox" },
];

function describe(a) {
  const base = ACTIONS[a.action] || { label: a.action, Icon: Activity, color: C.textMuted };
  let detail = "";
  const m = a.meta || {};
  if (a.action === "user.invite") detail = `${m.email || ""}${m.role ? ` (${m.role})` : ""}`;
  else if (a.action === "inbox.update") detail = [m.status, m.platform].filter(Boolean).join(" · ");
  return { ...base, detail };
}

export default function ActivityLogTab() {
  const { data, loading } = useApi(() => api.getActivity(100), [], { pollMs: 30000 });
  const [filter, setFilter] = useState(null);
  const all = data || [];
  const rows = filter ? all.filter(a => String(a.action || "").startsWith(filter + ".")) : all;

  return (
    <div>
      <PageHeader cycle="Audit trail" title="Activity Log"
        right={<SearchableSelect label="Type" allLabel="All activity" value={filter} onChange={setFilter} options={FILTERS} />} />
      <Card padding={6}>
        {loading && !data ? (
          <div style={{ padding: 24, color: C.textMuted, ...T.small }}>Loading…</div>
        ) : rows.length === 0 ? (
          <EmptyState Icon={Activity} title={all.length ? "Nothing in this type yet" : "No activity recorded yet"} body={all.length ? "Pick another type to see the rest of the trail." : "Actions by your team show up here as they happen."} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {rows.map(a => {
              const d = describe(a);
              const Icon = d.Icon;
              return (
                <div key={a.id} className="rc" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderRadius: 12, fontFamily: FONT }}>
                  <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.surface2, color: d.color, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon size={15} strokeWidth={2.2} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...T.h3, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.userName} <span style={{ fontWeight: 450 }}>{d.label}</span>
                    </div>
                    {d.detail && <div style={{ ...T.small, fontSize: 13, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.detail}</div>}
                  </div>
                  <span style={{ fontSize: 12.5, color: C.textMuted, fontFamily: MONO, whiteSpace: "nowrap" }}>{relativeTime(a.createdAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
