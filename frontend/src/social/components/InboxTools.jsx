import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { MessageSquarePlus, UserPlus, CheckCircle2, StickyNote, X } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, T, BTN, INPUT, POPOVER } from "../constants.js";
import { SearchableSelect } from "./Dropdown.jsx";
import { showToast } from "../Toast.jsx";

// ── Shared inbox tools: saved replies + per-item assignment/status/note ──
// Loaded once per inbox view and shared via context so the post cards, the chat
// thread, and the reply composers all see the same data without prop-threading.

const Ctx = createContext(null);

export function InboxToolsProvider({ children }) {
  const [canned, setCanned] = useState([]);
  const [users, setUsers] = useState([]);
  const [metaList, setMetaList] = useState([]);

  const loadCanned = useCallback(() => api.getCannedReplies().then(setCanned).catch(() => {}), []);
  const loadMeta = useCallback(() => api.getInboxMeta().then(setMetaList).catch(() => {}), []);
  useEffect(() => {
    loadCanned(); loadMeta();
    api.getUsers().then(setUsers).catch(() => {});
  }, [loadCanned, loadMeta]);

  // Map "type:id" → meta row for O(1) lookup.
  const metaMap = new Map(metaList.map(m => [`${m.itemType}:${m.itemId}`, m]));
  const metaFor = (type, id) => metaMap.get(`${type}:${id}`) || null;

  const setMeta = async (patch) => {
    try {
      await api.setInboxMeta(patch);
      // Optimistic local merge, then reconcile.
      setMetaList(prev => {
        const key = `${patch.itemType}:${patch.itemId}`;
        const i = prev.findIndex(m => `${m.itemType}:${m.itemId}` === key);
        const next = [...prev];
        const merged = { ...(i >= 0 ? next[i] : { itemType: patch.itemType, itemId: patch.itemId }), ...patch };
        if (patch.assignedTo !== undefined) merged.assignedName = users.find(u => u.id === Number(patch.assignedTo))?.displayName || null;
        if (i >= 0) next[i] = merged; else next.push(merged);
        return next;
      });
      loadMeta();
    } catch (e) { showToast(e.message, "error"); }
  };

  const addCanned = async (title, body) => { try { await api.createCannedReply({ title, body }); loadCanned(); showToast("Saved reply added", "success"); } catch (e) { showToast(e.message, "error"); } };
  const delCanned = async (id) => { try { await api.deleteCannedReply(id); loadCanned(); } catch (e) { showToast(e.message, "error"); } };

  return <Ctx.Provider value={{ canned, users, metaFor, setMeta, addCanned, delCanned }}>{children}</Ctx.Provider>;
}

export function useInboxTools() { return useContext(Ctx); }

// ── "awaiting Xh" SLA label from an inbound timestamp ─────────
export function slaLabel(ts) {
  if (!ts) return null;
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `awaiting ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `awaiting ${h}h`;
  return `awaiting ${Math.floor(h / 24)}d`;
}

// ── Saved-reply inserter — small button + popover, lists saved replies ──
// Icon button (34px round, surface fill); the popover is raised, radius 16,
// and its rows carry no fill of their own — hover = surface (fill only).
export function CannedReplyButton({ onInsert, peerName }) {
  const tools = useInboxTools();
  const [open, setOpen] = useState(false);
  if (!tools) return null;
  const sub = (body) => String(body || "").replace(/\{name\}/g, peerName || "there");
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" onClick={() => setOpen(o => !o)} title="Insert a saved reply"
        style={{ ...BTN.icon, background: open ? C.primarySoft : C.surface, color: open ? C.primary : C.textSecondary }}>
        <MessageSquarePlus size={15} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 300 }} />
          <div style={{ ...POPOVER, position: "absolute", bottom: "calc(100% + 6px)", left: 0, width: 280, maxHeight: 280, overflowY: "auto", zIndex: 301, fontFamily: FONT }}>
            <div style={{ ...T.label, padding: "8px 10px 6px", color: C.textMuted, fontFamily: "var(--fc-font-mono)" }}>Saved replies</div>
            {tools.canned.length === 0 ? (
              <div style={{ padding: "14px 10px 12px", fontSize: 13, color: C.textMuted, textAlign: "center" }}>None yet. Use “Save reply” to add one.</div>
            ) : tools.canned.map(c => (
              <div key={c.id} onClick={() => { onInsert(sub(c.body)); setOpen(false); }}
                onMouseEnter={e => e.currentTarget.style.background = C.surface} onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                style={{ padding: "8px 10px", borderRadius: 12, cursor: "pointer", background: "transparent", transition: "background .12s" }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{c.title}</div>
                <div style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub(c.body)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// "Save reply" — saves the given text as a new canned reply (prompts for a title).
export function SaveReplyButton({ text }) {
  const tools = useInboxTools();
  if (!tools || !String(text || "").trim()) return null;
  const save = () => {
    const title = window.prompt("Name this saved reply:");
    if (title && title.trim()) tools.addCanned(title.trim(), text);
  };
  return (
    <button type="button" onClick={save} title="Save this as a reusable reply"
      style={{ fontSize: 12.5, fontWeight: 650, color: C.textMuted, background: "none", border: "none", cursor: "pointer", padding: "0 4px", fontFamily: FONT }}>
      Save reply
    </button>
  );
}

// ── Assignment + status + internal note for one inbox item ────
// Pills: surface when neutral, a status tint when set (green resolved, amber note,
// accent-soft assigned). No outline anywhere — the fill IS the state.
export function AssignControl({ itemType, itemId, platform, compact }) {
  const tools = useInboxTools();
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const noteRef = useRef(null);
  if (!tools) return null;
  const meta = tools.metaFor(itemType, itemId) || {};
  const resolved = meta.status === "resolved";

  const assign = (uid) => tools.setMeta({ itemType, itemId, platform, assignedTo: uid == null || uid === "" ? null : Number(uid) });
  const toggleResolved = () => tools.setMeta({ itemType, itemId, platform, status: resolved ? "open" : "resolved" });
  const openNote = () => { setNoteDraft(meta.internalNote || ""); setNoteOpen(true); setTimeout(() => noteRef.current?.focus(), 30); };
  const saveNote = () => { tools.setMeta({ itemType, itemId, platform, internalNote: noteDraft }); setNoteOpen(false); };

  const pill = { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 650, padding: "7px 12px", height: 34, boxSizing: "border-box", borderRadius: 999, border: "none", background: C.surface, color: C.textSecondary, cursor: "pointer", fontFamily: FONT, whiteSpace: "nowrap", transition: "background .14s, color .14s" };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, position: "relative" }} onClick={e => e.stopPropagation()}>
      {/* assignee — the shared SearchableSelect; it tints accent-soft while a value is held */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <UserPlus size={14} color={meta.assignedTo ? C.primary : C.textMuted} />
        <SearchableSelect
          value={meta.assignedTo || null}
          onChange={assign}
          allLabel="Unassigned"
          minWidth={130}
          options={tools.users.map(u => ({ value: u.id, label: u.displayName }))}
          style={{ maxWidth: 170 }} />
      </span>
      {/* resolve */}
      <button type="button" onClick={toggleResolved} title={resolved ? "Mark open" : "Mark resolved"}
        style={{ ...pill, background: resolved ? C.greenSoft : C.surface, color: resolved ? C.green : C.textSecondary }}>
        <CheckCircle2 size={13} /> {resolved ? "Resolved" : "Resolve"}
      </button>
      {/* note */}
      <button type="button" onClick={openNote} title={meta.internalNote ? "Edit internal note" : "Add internal note"}
        style={{ ...BTN.icon, background: meta.internalNote ? C.amberSoft : C.surface, color: meta.internalNote ? C.amber : C.textSecondary }}>
        <StickyNote size={13} />
      </button>
      {noteOpen && (
        <>
          <div onClick={() => setNoteOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 300 }} />
          <div style={{ ...POPOVER, position: "absolute", top: "calc(100% + 6px)", right: 0, width: 280, zIndex: 301, padding: 12, fontFamily: FONT }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ ...T.label, color: C.textSecondary }}>Internal note (team-only)</span>
              <button type="button" onClick={() => setNoteOpen(false)} title="Close" style={{ ...BTN.icon, width: 26, height: 26 }}><X size={13} /></button>
            </div>
            <textarea ref={noteRef} value={noteDraft} onChange={e => setNoteDraft(e.target.value)} rows={3}
              placeholder="Context for your teammates…"
              style={{ ...INPUT, fontSize: 13.5, resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={saveNote} style={{ ...BTN.primary, padding: "7px 14px", fontSize: 13 }}>Save note</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
