import { useState } from "react";
import { Plus, Archive, ArchiveRestore, Trash2, Loader2, Braces } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { PageHeader } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";
import { useCrm, reloadCrm } from "../components/contacts/crmStore.js";

// Settings → Fields: custom contact fields (ManyChat "Custom User Fields").
// Values are filled by automations (Ask a Question / Set field) or by hand in a
// contact's profile, and reused as {key} variables and in conditions / filters.
const TYPE_LABEL = { text: "Text", number: "Number", date: "Date", boolean: "True / False", email: "Email", phone: "Phone", url: "Link" };

const SYSTEM_FIELDS = [
  ["Follow status", "Whether they follow your Instagram account. Checked automatically a few minutes after they message you, then weekly."],
  ["You follow them", "Whether your account follows them (same check)."],
  ["Name · Username · Profile photo", "From Instagram. {first_name} and {username} work in messages."],
  ["Subscribed", "When they first messaged you."],
  ["Last interaction", "Their last message to you."],
  ["24h window", "Open for 24 hours after their last message; Instagram only lets you message them inside it."],
  ["Messages", "Total messages in the conversation."],
  ["Verified · Follower count", "From Instagram, with the follow check."],
];

export function FieldsTab({ embedded } = {}) {
  const crm = useCrm();
  const [ConfirmDialog, confirm] = useConfirm();
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { await api.crm.createField({ name: name.trim(), type, description: desc.trim() || undefined }); setName(""); setDesc(""); await reloadCrm(); showToast("Field created", "success"); }
    catch (err) { showToast(err.message, "error"); }
    finally { setBusy(false); }
  }
  async function archive(f, archived) {
    try { await api.crm.updateField(f.key, { archived }); await reloadCrm(); }
    catch (err) { showToast(err.message, "error"); }
  }
  async function remove(f) {
    if (!await confirm({ title: `Delete “${f.name}”?`, body: `Its value is removed from ${f.used} contact${f.used === 1 ? "" : "s"}. Automations that save to {${f.key}} will start the field again.`, confirmLabel: "Delete", danger: true })) return;
    try { await api.crm.deleteField(f.key); await reloadCrm(); showToast("Field deleted", "success"); }
    catch (err) { showToast(err.message, "error"); }
  }

  const active = crm.fields.filter(f => !f.archived);
  const archived = crm.fields.filter(f => f.archived);
  const types = (crm.types.length ? crm.types : Object.keys(TYPE_LABEL)).map(t => ({ value: t, label: TYPE_LABEL[t] || t }));

  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      {!embedded && <PageHeader title="Fields" sub="Custom fields store details about each contact — email, budget, city, anything you ask in an automation." />}

      <form onSubmit={create} style={{ background: C.raised, borderRadius: 16, padding: 16, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 18 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New field name, e.g. Budget" aria-label="Field name" style={{ ...INPUT, flex: "1 1 200px", width: "auto" }} />
        <SearchableSelect value={type} options={types} onChange={setType} minWidth={140} />
        <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description (optional)" aria-label="Description" style={{ ...INPUT, flex: "2 1 220px", width: "auto" }} />
        <button type="submit" disabled={!name.trim() || busy} style={BTN.primary}>{busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={14} />} Create field</button>
      </form>

      <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Name", "Variable", "Type", "Contacts", ""].map((h, i) => <th key={i} style={{ textAlign: i === 3 ? "right" : "left", padding: "11px 14px", fontSize: 12, fontWeight: 650, color: C.textMuted }}>{h}</th>)}</tr></thead>
          <tbody>
            {!crm.loaded && <tr><td colSpan={5} style={{ padding: 30, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /></td></tr>}
            {crm.loaded && active.length === 0 && <tr><td colSpan={5} style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No fields yet. Create one above, or let an automation's “Ask a Question” step create it.</td></tr>}
            {active.map(f => <FieldRow key={f.key} f={f} onArchive={() => archive(f, true)} />)}
          </tbody>
        </table>
      </div>

      {archived.length > 0 && (
        <>
          <button onClick={() => setShowArchived(s => !s)} style={{ ...BTN.ghost, marginTop: 14 }}><Archive size={14} /> {showArchived ? "Hide" : "Show"} archived ({archived.length})</button>
          {showArchived && (
            <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden", marginTop: 8, opacity: .85 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
                {archived.map(f => <FieldRow key={f.key} f={f} archived onArchive={() => archive(f, false)} onDelete={() => remove(f)} />)}
              </tbody></table>
            </div>
          )}
        </>
      )}
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "26px 0 4px" }}>System fields</div>
      <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 10 }}>Filled by ForgeGrowth and Instagram for every contact. Use them in filters and automation conditions.</div>
      <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
          {SYSTEM_FIELDS.map(([n, d]) => (
            <tr key={n} style={{ boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
              <td style={{ padding: "10px 14px", fontSize: 14, fontWeight: 650, color: C.text, width: "34%" }}>{n}</td>
              <td style={{ padding: "10px 14px", fontSize: 13, color: C.textSecondary }}>{d}</td>
            </tr>
          ))}
        </tbody></table>
      </div>

      <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 14, lineHeight: 1.5, display: "flex", gap: 6 }}>
        <Braces size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        Use a field in any automation message as its variable, e.g. “Thanks {"{first_name}"}, we'll email {"{email}"}”. Archive a field to stop using it; delete is available once it's archived.
      </div>
    </div>
  );
}

function FieldRow({ f, archived, onArchive, onDelete }) {
  return (
    <tr style={{ boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
      <td style={{ padding: "11px 14px" }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>{f.name}</div>
        {f.description && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{f.description}</div>}
      </td>
      <td style={{ padding: "11px 14px", fontFamily: MONO, fontSize: 12.5, color: C.textSecondary }}>{"{" + f.key + "}"}</td>
      <td style={{ padding: "11px 14px", fontSize: 13, color: C.textSecondary }}>{TYPE_LABEL[f.type] || f.type}</td>
      <td style={{ padding: "11px 14px", fontSize: 13, fontFamily: MONO, textAlign: "right" }}>{f.used}</td>
      <td style={{ padding: "11px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
        <button onClick={onArchive} title={archived ? "Restore" : "Archive"} aria-label={archived ? `Restore ${f.name}` : `Archive ${f.name}`} style={{ ...BTN.icon, width: 30, height: 30 }}>{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
        {archived && <button onClick={onDelete} title="Delete" aria-label={`Delete ${f.name}`} style={{ ...BTN.icon, width: 30, height: 30, color: C.errText, marginLeft: 6 }}><Trash2 size={14} /></button>}
      </td>
    </tr>
  );
}
