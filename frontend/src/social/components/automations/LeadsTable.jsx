import { useMemo } from "react";
import { ClipboardList, Download } from "lucide-react";
import { C, FONT, MONO, BTN, relativeTime } from "../../constants.js";
import { EmptyState } from "../UI.jsx";

// Leads captured by "Collect details" automations, with CSV export.
export default function LeadsTable({ rows }) {
  // Union of every question across the automations that produced these leads, in order.
  const columns = useMemo(() => {
    const seen = new Map();
    for (const l of rows) for (const f of (l.rule_fields || [])) if (!seen.has(f.key)) seen.set(f.key, f.label || f.key);
    for (const l of rows) for (const k of Object.keys(l.data || {})) if (!seen.has(k)) seen.set(k, k);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [rows]);

  function exportCsv() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Captured", "Username", ...columns.map(c => c.label), "Automation", "Post ID", "Sheet"];
    const lines = rows.map(l => [new Date(l.updated_at).toISOString(), l.username ? "@" + l.username : l.peer_id,
      ...columns.map(c => l.data?.[c.key] ?? ""), l.rule_name || "", l.media_id || "", l.sheet_status || ""].map(esc).join(","));
    const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `instagram-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  if (!rows.length) return <EmptyState Icon={ClipboardList} title="No leads yet" body="Add questions under “Collect details” in an automation. Every completed set of answers lands here." />;

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <button onClick={exportCsv} style={BTN.secondary}><Download size={15} /> Export CSV</button>
      </div>
      <div style={{ background: C.raised, borderRadius: 16, padding: 8, overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 640 }}>
          <thead>
            <tr>{["Captured", "Who", ...columns.map(c => c.label), "Automation", "Sheet"].map(h => <th key={h} style={{ textAlign: "left", padding: "11px 12px", whiteSpace: "nowrap" }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map(l => (
              <tr key={l.id}>
                <td style={{ padding: "11px 12px", fontSize: 12.5, fontFamily: MONO, color: C.textMuted, whiteSpace: "nowrap" }} title={new Date(l.updated_at).toLocaleString()}>{relativeTime(l.updated_at)}</td>
                <td style={{ padding: "11px 12px", fontSize: 13.5, whiteSpace: "nowrap" }}>
                  {l.username ? <a href={`https://www.instagram.com/${l.username}/`} target="_blank" rel="noreferrer" style={{ color: C.text, fontWeight: 600 }}>@{l.username}</a> : <span style={{ color: C.textMuted, fontFamily: MONO, fontSize: 12 }}>{l.peer_id}</span>}
                </td>
                {columns.map(c => <td key={c.key} style={{ padding: "11px 12px", fontSize: 13.5, color: C.text }}>{l.data?.[c.key] ?? <span style={{ color: C.textMuted }}>—</span>}</td>)}
                <td style={{ padding: "11px 12px", fontSize: 13, color: C.textSecondary }}>{l.rule_name || "—"}</td>
                <td style={{ padding: "11px 12px", fontSize: 12.5, color: l.sheet_status === "appended" ? C.green : l.sheet_status ? C.amber : C.textMuted }} title={l.sheet_status || ""}>
                  {l.sheet_status === "appended" ? "Added" : l.sheet_status ? "Not added" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
