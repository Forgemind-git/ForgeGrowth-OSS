import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { C, FONT } from "../constants.js";
import { api } from "../api.js";
import { useApi } from "../hooks/useApi.js";

// Persistent token-health warning shown on every page (under the top bar).
// Backed by GET /api/token-health (pure DB read — zero Graph calls). The daily
// auto-refresh keeps tokens alive; this banner only appears when an account
// genuinely needs human action (reconnect) or is days from expiry.
export default function TokenHealthBanner() {
  const { data } = useApi(() => api.getTokenHealth(), [], { pollMs: 300000 });
  const [dismissed, setDismissed] = useState(false);

  const attention = data?.attention || [];
  if (!attention.length || dismissed) return null;

  // Severity: only a confirmed-dead token (needs_reconnect) is red — the user
  // must act. A failed refresh attempt retries automatically (daily cron), so
  // it's an amber heads-up, not an alarm.
  const needsAction = attention.filter(a => a.status === "needs_reconnect");
  const failed      = attention.filter(a => a.status === "refresh_failed");
  const expiring    = attention.filter(a => a.status === "expiring");
  const severe      = needsAction.length > 0;

  const bg     = severe ? C.errBg : C.amberSoft;
  const color  = severe ? C.errText : C.amber;

  const label = (a) =>
    `${a.platform.charAt(0).toUpperCase() + a.platform.slice(1)} (${a.account})`;

  const parts = [];
  if (needsAction.length) {
    parts.push(
      `${needsAction.map(label).join(", ")} ${needsAction.length === 1 ? "needs" : "need"} reconnection — the token can't be renewed automatically`
    );
  }
  if (failed.length) {
    parts.push(
      `${failed.map(label).join(", ")}: last token refresh failed — retrying automatically`
    );
  }
  if (expiring.length) {
    parts.push(
      `${expiring.map(a => `${label(a)} expires in ${a.daysLeft}d`).join(", ")}`
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
      background: bg, color, borderRadius: 16,
      padding: "10px 18px", fontFamily: FONT, fontSize: 14, fontWeight: 550,
    }}>
      <AlertTriangle size={15} strokeWidth={2} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{parts.join(" · ")}</span>
      <a
        href="#/social/integrations"
        style={{ color, fontWeight: 700, textDecoration: "underline", whiteSpace: "nowrap", flexShrink: 0 }}
      >
        Open Integrations
      </a>
      <button
        onClick={() => setDismissed(true)}
        title="Dismiss until next reload"
        style={{
          background: "transparent", border: "none", color, cursor: "pointer",
          padding: 2, display: "flex", alignItems: "center", flexShrink: 0,
        }}
      >
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  );
}
