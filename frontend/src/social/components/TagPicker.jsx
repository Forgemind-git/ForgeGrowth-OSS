import { useState, useEffect, useRef } from "react";
import { Plus, X, Tag as TagIcon, Check } from "lucide-react";
import { api } from "../api.js";
import { C, MONO, T, BTN, POPOVER } from "../constants.js";

// A tag chip: fill = the tag colour at ~10%, text = the tag colour (never a solid block).
const chipStyle = (color, size = "sm") => ({
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: size === "sm" ? "3px 9px" : "4px 11px", borderRadius: 999,
  background: `${color}1a`, color, fontSize: size === "sm" ? 11.5 : 12.5, fontWeight: 650,
  fontFamily: "var(--fc-font)", whiteSpace: "nowrap", lineHeight: 1.35,
});

// Read-only pill list. Used wherever we display a contact's tags.
// Filters out tag ids that no longer exist (defensive — deleted tags leave
// stale ids in contacts.tags JSONB).
export function TagPills({ tagIds, allTags, size = "sm", maxShown }) {
  const ids = Array.isArray(tagIds) ? tagIds : [];
  const found = ids.map(id => allTags.find(t => t.id === id)).filter(Boolean);
  const shown = maxShown ? found.slice(0, maxShown) : found;
  const extra = maxShown && found.length > maxShown ? found.length - maxShown : 0;
  return (
    <div style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {shown.map(t => (
        <span key={t.id} style={chipStyle(t.color, size)}>{t.name}</span>
      ))}
      {extra > 0 && (
        <span style={{ ...chipStyle(C.textSecondary, size), background: C.surface2, color: C.textSecondary }}>
          +{extra}
        </span>
      )}
    </div>
  );
}

// Editable tag picker. A composed field (the wrapper carries the fill) holding the
// current chips + an "Add tag" pill that opens a popover grouped by category.
// Click a tag to toggle; click outside to close.
// Persistence is OPTIMISTIC + then saved via onSave(newIds). Parent passes
// `tagIds` controlled and provides `onSave` (returns a Promise).
export default function TagPicker({ tagIds, onSave, allTags, categories, disabled }) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(Array.isArray(tagIds) ? tagIds : []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const rootRef = useRef(null);

  // Reset local state when the upstream value changes (e.g. different contact loaded)
  useEffect(() => { setLocal(Array.isArray(tagIds) ? tagIds : []); }, [tagIds]);

  // Click-outside to close + commit
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!rootRef.current || rootRef.current.contains(e.target)) return;
      setOpen(false);
      commit();
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, local]);

  const toggle = (id) => {
    setLocal(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const commit = async () => {
    const sortedPrev = [...(tagIds || [])].sort().join(",");
    const sortedNext = [...local].sort().join(",");
    if (sortedPrev === sortedNext) return;   // nothing changed → no API call
    setSaving(true); setErr(null);
    try { await onSave(local); }
    catch (e) {
      setErr(e.message);
      setLocal(Array.isArray(tagIds) ? tagIds : []);   // rollback
    }
    finally { setSaving(false); }
  };

  // Group tags by category for the dropdown
  const byCat = new Map();
  for (const c of (categories || [])) byCat.set(c.id, { id: c.id, name: c.name, tags: [] });
  byCat.set("_uncat", { id: "_uncat", name: "Uncategorized", tags: [] });
  for (const t of (allTags || [])) {
    const k = (t.categoryId && byCat.has(t.categoryId)) ? t.categoryId : "_uncat";
    byCat.get(k).tags.push(t);
  }
  const groups = [...byCat.values()].filter(g => g.tags.length > 0);

  const visiblePills = local.map(id => allTags.find(t => t.id === id)).filter(Boolean);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      {/* The composed field: the WRAPPER carries the fill + radius; chips sit inside it. */}
      <div className="fc-searchfield" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", minHeight: 42, padding: "6px 8px", borderRadius: 12, background: C.surface, boxSizing: "border-box" }}>
        {visiblePills.map(t => (
          <span key={t.id} style={{ ...chipStyle(t.color, "md"), paddingRight: disabled ? 11 : 6 }}>
            {t.name}
            {!disabled && (
              <button onClick={() => { toggle(t.id); setTimeout(commit, 0); }}
                title="Remove tag"
                style={{ display: "flex", padding: 2, border: "none", background: "transparent", color: t.color, borderRadius: 999, cursor: "pointer", marginLeft: 1 }}>
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </span>
        ))}
        {visiblePills.length === 0 && disabled && <span style={{ fontSize: 13, color: C.textMuted, padding: "0 4px" }}>No tags</span>}

        {!disabled && (
          <button onClick={() => setOpen(o => !o)} disabled={saving}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 11px", border: "none", background: open ? C.primarySoft : C.surface2, borderRadius: 999, fontSize: 12.5, fontWeight: 650, fontFamily: "var(--fc-font)", color: open ? C.primary : C.textSecondary, cursor: saving ? "wait" : "pointer", transition: "background .15s" }}>
            <Plus size={12} strokeWidth={2.4} /> {saving ? "Saving…" : (visiblePills.length === 0 ? "Add tag" : "Add")}
          </button>
        )}

        {err && <span style={{ fontSize: 12.5, color: C.errText, marginLeft: 4 }}>{err}</span>}
      </div>

      {open && (
        <div style={{ ...POPOVER, position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, width: 280, maxHeight: 360, overflowY: "auto", animation: "fc-pop-in .18s ease-out both" }}>
          {allTags.length === 0 ? (
            <div style={{ padding: "20px 14px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
              <TagIcon size={20} color={C.textMuted} style={{ marginBottom: 6 }} />
              <div style={{ fontWeight: 700, color: C.textSecondary, marginBottom: 3 }}>No tags yet</div>
              <div>Create tags in Settings → Tags first.</div>
            </div>
          ) : (
            groups.map(g => (
              <div key={g.id} style={{ marginBottom: 2 }}>
                <div style={{ ...T.label, fontSize: 11.5, fontFamily: MONO, color: C.textMuted, padding: "8px 10px 4px" }}>{g.name}</div>
                {g.tags.map(t => {
                  const on = local.includes(t.id);
                  return (
                    <button key={t.id} className="fc-row" onClick={() => toggle(t.id)}
                      onMouseEnter={e => { if (!on) e.currentTarget.style.background = C.surface; }}
                      onMouseLeave={e => { if (!on) e.currentTarget.style.background = "transparent"; }}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", border: "none", background: on ? C.primarySoft : "transparent", borderRadius: 12, cursor: "pointer", fontFamily: "var(--fc-font)", textAlign: "left", transition: "background .12s" }}>
                      <span style={{ width: 16, height: 16, borderRadius: 999, background: on ? C.primary : C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {on && <Check size={10} color={C.onAccent} strokeWidth={3} />}
                      </span>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: t.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13.5, color: C.text, fontWeight: on ? 700 : 500, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
          <div style={{ marginTop: 4, padding: "8px 6px 4px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 500 }}>{local.length} selected</span>
            <button onClick={() => { setOpen(false); commit(); }}
              style={{ ...BTN.primary, padding: "6px 14px", fontSize: 12.5 }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Shared loader hook — fetches tags + categories once per component mount.
// Components that show OR edit tags should use this so they have the lookup data.
export function useTagsAndCategories() {
  const [data, setData] = useState({ tags: [], categories: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getTags().catch(() => ({ tags: [] })), api.getCategories().catch(() => ({ categories: [] }))])
      .then(([t, c]) => { if (!cancelled) setData({ tags: t.tags || [], categories: c.categories || [], loaded: true }); });
    return () => { cancelled = true; };
  }, []);
  return data;
}
