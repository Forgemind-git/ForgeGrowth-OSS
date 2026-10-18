import { useState, useEffect } from "react";
import { Layers, Loader2 } from "lucide-react";
import { C, FONT, BTN } from "../../constants.js";
import { PLATFORMS, PLATFORM_ORDER } from "../../data/mockData.js";
import { PlatformBadge } from "../UI.jsx";
import { showToast } from "../../Toast.jsx";
import { useScope, saveScope } from "./scopeStore.js";

// Top-bar "My accounts" picker: choose the platforms / Instagram accounts every
// page opens with. Saved per user on the server, so it follows you to any device.
export default function ScopePicker({ buttonStyle }) {
  const scope = useScope();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setSel(new Set(scope.tokens)); }, [open]);
  // Pages open this picker through a window event (DefaultViewButton "Set default accounts").
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("fs:open-scope", onOpen);
    return () => window.removeEventListener("fs:open-scope", onOpen);
  }, []);

  // One row per Instagram account, one per other connected platform.
  const rows = [];
  for (const p of PLATFORM_ORDER) {
    const list = scope.accounts.filter(a => a.platform === p);
    if (!list.length) continue;
    if (p === "instagram") for (const a of list) rows.push({ token: `instagram|${a.accountId}`, platform: p, label: a.username ? `@${a.username}` : a.label, sub: a.username ? a.label : null });
    else rows.push({ token: p, platform: p, label: list[0].label || PLATFORMS[p]?.name || p, sub: PLATFORMS[p]?.name });
  }
  const toggle = (t) => setSel(s => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  async function save(tokens) {
    setBusy(true);
    try { await saveScope(tokens); setOpen(false); showToast(tokens.length ? "Pages now open with your accounts" : "Showing all accounts again", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }

  const count = scope.tokens.length;
  const label = !count ? "All accounts" : count === 1 ? (rows.find(r => r.token === scope.tokens[0])?.label || "1 account") : `${count} accounts`;

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} title="My accounts — the platforms and accounts every page opens with"
        style={{ ...buttonStyle, width: "auto", padding: "0 12px", gap: 7, fontSize: 13, fontWeight: 650, fontFamily: FONT, background: count ? C.primary : buttonStyle.background, color: count ? C.onAccent : buttonStyle.color }}>
        <Layers size={15} /> <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
          <div style={{ position: "absolute", top: "calc(100% + 10px)", right: 0, width: 320, maxWidth: "calc(calc(100vw / var(--fg-zoom, 1)) - 32px)", background: C.raised, borderRadius: 16, boxShadow: C.shadowLg, zIndex: 201, padding: 12, fontFamily: FONT, animation: "fc-pop-in .18s ease-out both" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>My accounts</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, margin: "3px 0 10px", lineHeight: 1.4 }}>Overview, Inbox, Contacts, Content Library, Automations and Comment Analyzer open with only these. You can still switch on any page.</div>
            <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {!scope.loaded && <Loader2 size={15} color={C.textMuted} style={{ animation: "spin 1s linear infinite", margin: 12 }} />}
              {rows.map(r => {
                const on = sel.has(r.token);
                return (
                  <div key={r.token} role="checkbox" aria-checked={on} tabIndex={0} onClick={() => toggle(r.token)} onKeyDown={e => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(r.token))}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, cursor: "pointer", background: on ? C.primaryFaint : "transparent" }}>
                    <span style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: on ? C.primary : C.surface2, color: C.onAccent }}>
                      {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>}
                    </span>
                    <PlatformBadge platform={r.platform} size="sm" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
                      {r.sub && <div style={{ fontSize: 12, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={() => save([...sel])} disabled={busy || sel.size === 0} style={{ ...BTN.primary, flex: 1, justifyContent: "center", padding: "9px 14px" }}>
                {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : null} Save as default
              </button>
              {count > 0 && <button onClick={() => save([])} disabled={busy} style={{ ...BTN.secondary, padding: "9px 14px" }}>Show all</button>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
