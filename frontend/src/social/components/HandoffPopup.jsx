// Real-time human handoff popup. Connects to /api/events/stream (SSE) on mount
// and shows a persistent modal whenever an agent fires a handoff event.
// Clicking "Go to chat" uses the same sessionStorage + CustomEvent deep-link
// pattern as NotificationBell, routing directly to the exact DM conversation.
//
// Presented as a modal (scrim + blur, card fill, radius 24) — one handoff at a
// time; the rest of the queue waits behind it and surfaces as it is dismissed.

import { useState, useEffect, useRef } from "react";
import { UserCheck, X, MessageCircle } from "lucide-react";
import { C, FONT, T, BTN } from "../constants.js";

export default function HandoffPopup({ user }) {
  const [queue, setQueue] = useState([]); // array of notification rows from SSE
  const esRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    const connect = () => {
      const es = new EventSource("/api/social/events/stream", { withCredentials: true });
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const n = JSON.parse(e.data);
          if (n && n.type === "handoff") {
            setQueue(q => [...q, { ...n, _popupId: Date.now() + Math.random() }]);
          }
        } catch (_) {}
      };
      es.onerror = () => {
        // Browser auto-reconnects; close + let it retry on its own.
        es.close();
      };
    };
    connect();
    return () => { if (esRef.current) esRef.current.close(); };
  }, [user]);

  // Auto-dismiss cards after 5 minutes (safety net — primary UX is manual dismiss).
  useEffect(() => {
    if (queue.length === 0) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setQueue(q => q.filter(n => (now - Number(String(n._popupId).split(".")[0])) < 5 * 60 * 1000));
    }, 60000);
    return () => clearTimeout(t);
  }, [queue]);

  const dismiss = (popupId) => setQueue(q => q.filter(n => n._popupId !== popupId));

  const goToChat = (n) => {
    dismiss(n._popupId);
    const meta = n.meta || {};
    try {
      sessionStorage.setItem("forgesocial.inboxDeepLink", JSON.stringify({
        kind: meta.kind || "dm",
        platform: meta.platform || "instagram",
        accountId: meta.accountId || null,
        peerId: meta.peerId || null,
      }));
    } catch (_) {}
    window.dispatchEvent(new CustomEvent("forgesocial:inbox-deeplink", {
      detail: { kind: meta.kind || "dm", platform: meta.platform || "instagram", accountId: meta.accountId, peerId: meta.peerId },
    }));
    window.location.hash = "/social/inbox";
  };

  if (queue.length === 0) return null;
  const n = queue[0];
  const waiting = queue.length - 1;

  return (
    <div onClick={() => dismiss(n._popupId)}
      style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.42)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: FONT }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
        style={{ width: 420, maxWidth: "100%", background: C.card, borderRadius: 24, boxShadow: C.shadowLg, padding: 24, position: "relative", animation: "fc-pop-in .2s ease-out both" }}>
        <button onClick={() => dismiss(n._popupId)} title="Dismiss" aria-label="Dismiss"
          style={{ ...BTN.icon, width: 32, height: 32, position: "absolute", top: 16, right: 16 }}>
          <X size={15} />
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, paddingRight: 40 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: C.primarySoft, color: C.primary, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <UserCheck size={19} strokeWidth={2.2} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...T.h3, color: C.text }}>Human handoff needed</div>
            {n.account_key && (
              <div style={{ ...T.label, color: C.textMuted, marginTop: 3 }}>
                {n.platform || "instagram"} · {n.account_key}
              </div>
            )}
          </div>
        </div>

        <div style={{ ...T.body, color: C.text, marginBottom: 18 }}>
          {n.body || "A conversation needs your attention."}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {n.meta?.peerId ? (
            <button onClick={() => goToChat(n)} style={{ ...BTN.primary, flex: 1, justifyContent: "center" }}>
              <MessageCircle size={14} /> Go to chat
            </button>
          ) : (
            <button onClick={() => { window.location.hash = "/social/inbox"; dismiss(n._popupId); }} style={{ ...BTN.primary, flex: 1, justifyContent: "center" }}>
              <MessageCircle size={14} /> Open inbox
            </button>
          )}
          <button onClick={() => dismiss(n._popupId)} style={BTN.secondary}>
            Dismiss
          </button>
        </div>
        {waiting > 0 && (
          <div style={{ ...T.small, color: C.textMuted, marginTop: 12, textAlign: "center" }}>
            {waiting} more waiting
          </div>
        )}
      </div>
    </div>
  );
}
