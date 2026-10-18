import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";
import { C, BTN, INPUT, MONO, FONT } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { useCrm, createTag, updateTag, deleteTag, TAG_COLORS } from "./crmStore.js";

// Contacts → Tags: create, rename, recolour and delete tags. Deleting a tag also
// takes it off every contact. Counts come from the loaded contact list.
export default function TagsManager({ counts = {}, confirm, editId, onFilter }) {
  const crm = useCrm();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(editId || null);
  useEffect(() => { if (editId) setEditing(editId); }, [editId]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    if (await createTag(name.trim())) { setName(""); showToast("Tag created", "success"); }
    setBusy(false);
  }
  async function remove(t) {
    const n = counts[t.id] || 0;
    if (!await confirm({ title: `Delete tag “${t.name}”?`, body: n ? `It is removed from ${n.toLocaleString("en-IN")} contact${n === 1 ? "" : "s"}. Automation steps that add or check this tag stop doing it.` : "No contact has this tag. Automation steps that add or check it stop doing it.", confirmLabel: "Delete", danger: true })) return;
    const r = await deleteTag(t.id);
    if (r != null) showToast(`Tag deleted${r ? ` · removed from ${r} contact${r === 1 ? "" : "s"}` : ""}`, "success");
  }

  const tags = [...crm.tags].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.name.localeCompare(b.name));
  return (
    <div style={{ fontFamily: FONT }}>
      <form onSubmit={create} style={{ background: C.raised, borderRadius: 16, padding: 14, display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New tag name, e.g. Hot lead" aria-label="Tag name" style={{ ...INPUT, flex: "1 1 220px", width: "auto" }} />
        <button type="submit" disabled={!name.trim() || busy} style={BTN.primary}>{busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={14} />} Create tag</button>
      </form>

      <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Tag", "Contacts", ""].map((h, i) => <th key={i} style={{ textAlign: i === 1 ? "right" : "left", padding: "11px 14px", fontSize: 12, fontWeight: 650, color: C.textMuted }}>{h}</th>)}</tr></thead>
          <tbody>
            {!crm.loaded && <tr><td colSpan={3} style={{ padding: 30, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /></td></tr>}
            {crm.loaded && tags.length === 0 && <tr><td colSpan={3} style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No tags yet. Create one above, or add one from an automation step.</td></tr>}
            {tags.map(t => editing === t.id
              ? <EditRow key={t.id} t={t} onDone={() => setEditing(null)} />
              : (
                <tr key={t.id} style={{ boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 650, color: C.text }}>
                      <i style={{ width: 11, height: 11, borderRadius: "50%", background: t.color }} />{t.name}
                    </span>
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "right", fontFamily: MONO, fontSize: 13 }}>
                    {counts[t.id] ? <button onClick={() => onFilter?.(t.id)} title="Show these contacts" style={{ ...BTN.ghost, padding: "2px 6px", fontFamily: MONO, fontSize: 13 }}>{counts[t.id].toLocaleString("en-IN")}</button> : <span style={{ color: C.textMuted }}>0</span>}
                  </td>
                  <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button onClick={() => setEditing(t.id)} title="Edit" aria-label={`Edit ${t.name}`} style={{ ...BTN.icon, width: 30, height: 30 }}><Pencil size={14} /></button>
                    <button onClick={() => remove(t)} title="Delete" aria-label={`Delete ${t.name}`} style={{ ...BTN.icon, width: 30, height: 30, color: C.errText, marginLeft: 6 }}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditRow({ t, onDone }) {
  const [name, setName] = useState(t.name);
  const [color, setColor] = useState(t.color || TAG_COLORS[0]);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    if (await updateTag(t.id, { name: name.trim(), color })) { showToast("Tag updated", "success"); onDone(); }
    setBusy(false);
  }
  return (
    <tr style={{ boxShadow: `inset 0 1px 0 ${C.surface2}`, background: C.card }}>
      <td colSpan={2} style={{ padding: "10px 14px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") onDone(); }}
            aria-label="Tag name" style={{ ...INPUT, flex: "1 1 180px", width: "auto", padding: "7px 10px" }} />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {TAG_COLORS.map(col => (
              <span key={col} role="button" tabIndex={0} aria-label={`Colour ${col}`} onClick={() => setColor(col)} onKeyDown={e => e.key === "Enter" && setColor(col)}
                style={{ width: 20, height: 20, borderRadius: "50%", background: col, cursor: "pointer", boxShadow: color.toLowerCase() === col ? `0 0 0 2px ${C.card}, 0 0 0 4px ${col}` : "none" }} />
            ))}
            <input type="color" value={color} onChange={e => setColor(e.target.value)} aria-label="Custom colour" style={{ width: 26, height: 26, padding: 0, border: "none", background: "transparent", cursor: "pointer" }} />
          </div>
        </div>
      </td>
      <td style={{ padding: "10px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
        <button onClick={save} disabled={busy || !name.trim()} title="Save" aria-label="Save tag" style={{ ...BTN.icon, width: 30, height: 30, color: C.green }}>{busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={15} />}</button>
        <button onClick={onDone} title="Cancel" aria-label="Cancel" style={{ ...BTN.icon, width: 30, height: 30, marginLeft: 6 }}><X size={14} /></button>
      </td>
    </tr>
  );
}
