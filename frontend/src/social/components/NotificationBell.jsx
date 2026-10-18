import { useState } from "react";
import { useApi } from '../hooks/useApi.js';
import { api } from '../api.js';
import { relativeTime, C, FONT } from '../constants.js';

// Severity → dot color for the feed rows.
const SEV = { good: C.green, warn: C.amber, error: C.primary, info: C.textMuted };

export default function NotificationBell({ onNavigate }) {
  const [open, setOpen] = useState(false);
  // Live feed — polls every 60s so the badge updates without a refresh.
  const { data, refetch } = useApi(() => api.getNotifications(30), [], { pollMs: 60000 });
  const items = data?.items || [];
  const unread = data?.unread || 0;

  const openFeed = () => {
    setOpen(o => !o);
    if (!open && unread > 0) {
      // Opening the feed marks everything read (then refresh the badge).
      api.markNotificationsRead({ all: true }).then(() => refetch(true)).catch(() => {});
    }
  };

  const clickItem = (n) => {
    setOpen(false);
    const m = n.meta;
    // Deep-link straight to the chat / comment the notification is about.
    if (m && (m.kind === 'dm' || m.kind === 'comment')) {
      try { sessionStorage.setItem('forgesocial.inboxDeepLink', JSON.stringify(m)); } catch (_) {}
      window.location.hash = '/social/inbox';
      // Tell an already-mounted Inbox to apply it (hash alone won't re-mount it).
      window.dispatchEvent(new CustomEvent('forgesocial:inbox-deeplink', { detail: m }));
      return;
    }
    if (n.link && n.link.startsWith('#/')) window.location.hash = n.link.slice(1);
    else if (n.link && onNavigate) onNavigate(n.link.replace(/^#?\/?/, ''));
  };

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={openFeed} title="Notifications"
        style={{ width: 34, height: 34, borderRadius: 999, background: open ? C.primary : C.headerSurface, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.headerText, flexShrink: 0, position: "relative", padding: 0, transition: "background .15s" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: C.primaryHover, color: C.onAccent, fontSize: 11, fontWeight: 780, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, boxShadow: `0 0 0 2px ${C.headerBg}` }}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
          <div style={{ position: "absolute", top: "calc(100% + 10px)", right: 0, width: 380, maxHeight: 480, background: C.raised, borderRadius: 16, boxShadow: C.shadowLg, zIndex: 201, overflow: "hidden", fontFamily: FONT, display: "flex", flexDirection: "column", padding: 6, animation: "fc-pop-in .18s ease-out both" }}>
            <div style={{ padding: "10px 12px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".04em", color: C.textSecondary, fontFamily: "var(--fc-font-mono)" }}>Notifications</span>
              {items.length > 0 && (
                <button onClick={() => api.markNotificationsRead({ all: true }).then(() => refetch(true))}
                  style={{ fontSize: 12.5, fontWeight: 650, color: C.textMuted, background: "none", border: "none", cursor: "pointer", fontFamily: FONT, padding: "2px 6px" }}>
                  Mark all read
                </button>
              )}
            </div>
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {items.length === 0 ? (
                <div style={{ padding: "28px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>
                  You're all caught up.
                </div>
              ) : items.map(n => (
                <div key={n.id} onClick={() => clickItem(n)}
                  onMouseEnter={e => e.currentTarget.style.background = C.surface}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 12, cursor: n.link ? "pointer" : "default", background: "transparent", transition: "background .14s" }}>
                  <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV[n.severity] || SEV.info }} />
                    {!n.read && <span style={{ position: "absolute", top: -1, right: -1, width: 9, height: 9, borderRadius: "50%", background: C.primary, boxShadow: `0 0 0 2px ${C.raised}` }} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <div style={{ fontSize: 14, fontWeight: n.read ? 600 : 700, color: C.text, marginBottom: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</div>
                      <div style={{ fontSize: 12, color: C.primary, fontWeight: 600, flexShrink: 0 }}>{relativeTime(n.createdAt)}</div>
                    </div>
                    {n.body && <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{n.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
