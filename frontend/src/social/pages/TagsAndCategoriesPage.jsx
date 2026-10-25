import { useState } from "react";
import { Plus, Pencil, Trash2, X, Save, Tag as TagIcon, FolderOpen } from "lucide-react";
import { api } from "../api.js";
import { useApi } from "../hooks/useApi.js";
import { C, T, BTN, INPUT, LABEL, FONT, MONO } from "../constants.js";
import { Card, Badge, PillTabs, EmptyState } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";

// 10-color preset palette — mirrors Forgechat for visual continuity.
// Stored tag colours must be #rrggbb (the API validates), so the presets are literal hexes.
export const TAG_COLOR_PRESETS = [
  "#dc2626", "#ea580c", "#d97706", "#16a34a", "#0891b2",
  "#1d4ed8", "#7c3aed", "#db2777", "#6b6b73", "#000000",
];

// Chip preview of a tag: fill = colour at ~10%, text = colour (the app's chip recipe).
const tagChipStyle = (color) => ({
  display: "inline-block", padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 650,
  background: `color-mix(in srgb, ${color} 14%, transparent)`, color, whiteSpace: "nowrap", fontFamily: FONT,
});

// ── Shared mini helpers ────────────────────────────────────────
// The Settings page above already names the section, so this row only counts
// what is listed and holds the add button.
function SectionHeader({ title, count, actionLabel, onAction }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, minHeight: 38 }}>
      <div style={{ ...T.small, color: C.textMuted }}>
        {typeof count === "number" ? `${count} ${count === 1 ? title.toLowerCase().replace(/ies$/, "y").replace(/s$/, "") : title.toLowerCase()}` : null}
      </div>
      {actionLabel && (
        <button onClick={onAction} style={BTN.primary}>
          <Plus size={15} /> {actionLabel}
        </button>
      )}
    </div>
  );
}

// Inline form panel (collapsible) for add / edit — a card on the pane, round close.
function FormPanel({ title, onClose, children }) {
  return (
    <Card style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ ...T.h3, color: C.text }}>{title}</div>
        <button onClick={onClose} title="Close" aria-label="Close" style={BTN.icon}><X size={15} /></button>
      </div>
      {children}
    </Card>
  );
}

function Label({ children }) {
  return <div style={LABEL}>{children}</div>;
}
function TextInput({ value, onChange, placeholder, autoFocus }) {
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} style={INPUT} />;
}
function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
    style={{ ...INPUT, resize: "vertical", lineHeight: 1.5 }} />;
}
function SaveCancel({ onSave, onCancel, busy, label = "Save" }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
      <button onClick={onCancel} disabled={busy} style={{ ...BTN.secondary, opacity: busy ? .5 : 1, cursor: busy ? "wait" : "pointer" }}>
        Cancel
      </button>
      <button onClick={onSave} disabled={busy} style={{ ...BTN.primary, opacity: busy ? .5 : 1, cursor: busy ? "wait" : "pointer" }}>
        <Save size={14} /> {busy ? "Saving…" : label}
      </button>
    </div>
  );
}
function ErrorNote({ children, style }) {
  return <div style={{ background: C.errBg, color: C.errText, padding: "10px 14px", borderRadius: 12, fontSize: 13, marginBottom: 14, ...style }}>{children}</div>;
}

// A list row: no fill of its own, hover surface, radius 12, 4px apart.
const ROW = { display: "grid", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12, fontFamily: FONT, transition: "background .14s" };
const rowHover = {
  onMouseEnter: e => { e.currentTarget.style.background = C.surface; },
  onMouseLeave: e => { e.currentTarget.style.background = "transparent"; },
};
const HEAD = { ...T.label, color: C.textSecondary, padding: "8px 14px 6px", display: "grid", gap: 12 };
const RowActions = ({ onEdit, onDelete }) => (
  <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
    <button onClick={onEdit} title="Edit" aria-label="Edit" style={{ ...BTN.icon, width: 30, height: 30 }}><Pencil size={14} /></button>
    <button onClick={onDelete} title="Delete" aria-label="Delete" style={{ ...BTN.icon, width: 30, height: 30, background: C.errBg, color: C.errText }}><Trash2 size={14} /></button>
  </div>
);

// ── Category tab ─────────────────────────────────────────────
export function CategoryTab() {
  const { data, loading, error, refetch } = useApi(() => api.getCategories(), []);
  const categories = data?.categories || [];
  const [editing, setEditing] = useState(null);   // null = closed, "new" = add, {id} = edit
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [ConfirmDialog, confirm] = useConfirm();

  const open = (cat) => {
    setEditing(cat || "new");
    setName(cat?.name || "");
    setDescription(cat?.description || "");
    setFormErr(null);
  };
  const close = () => { setEditing(null); setName(""); setDescription(""); setFormErr(null); };

  const save = async () => {
    if (!name.trim()) { setFormErr("Name is required"); return; }
    setSaving(true); setFormErr(null);
    try {
      if (editing === "new") await api.createCategory({ name: name.trim(), description: description.trim() });
      else                   await api.updateCategory(editing.id, { name: name.trim(), description: description.trim() });
      close();
      refetch();
    } catch (e) { setFormErr(e.message); } finally { setSaving(false); }
  };

  const del = async (cat) => {
    const ok = await confirm({
      title: "Delete this category?",
      body: cat.tagCount > 0
        ? `"${cat.name}" has ${cat.tagCount} tag${cat.tagCount === 1 ? "" : "s"} that will also be deleted. Contacts will keep these tag ids in their data until you re-tag them.`
        : `Removes "${cat.name}". This can't be undone.`,
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try { await api.deleteCategory(cat.id); refetch(); } catch (e) { alert(e.message); }
  };

  const cols = "1.5fr 2fr 90px 90px";

  return (
    <div>
      {ConfirmDialog}
      <SectionHeader icon={FolderOpen} title="Categories" count={categories.length}
        actionLabel="Add Category" onAction={() => open(null)} />

      {error && <ErrorNote>{error}</ErrorNote>}

      {editing && (
        <FormPanel title={editing === "new" ? "New category" : `Edit “${editing.name}”`} onClose={close}>
          {formErr && <ErrorNote>{formErr}</ErrorNote>}
          <div style={{ marginBottom: 14 }}>
            <Label>Name</Label>
            <TextInput value={name} onChange={setName} placeholder="e.g. Lead status" autoFocus />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={setDescription} placeholder="What this category is for (optional)" />
          </div>
          <SaveCancel onSave={save} onCancel={close} busy={saving} label={editing === "new" ? "Create" : "Save changes"} />
        </FormPanel>
      )}

      <Card padding={6}>
        {loading && !data ? (
          <div style={{ padding: 24, ...T.small, color: C.textMuted }}>Loading…</div>
        ) : categories.length === 0 ? (
          <EmptyState Icon={FolderOpen} title="No categories yet" body='Create one to start grouping your tags (e.g. "Lead status", "Customer type").' />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ ...HEAD, gridTemplateColumns: cols }}>
              <div>Name</div><div>Description</div><div>Tags</div><div style={{ textAlign: "right" }}>Actions</div>
            </div>
            {categories.map(c => (
              <div key={c.id} {...rowHover} style={{ ...ROW, gridTemplateColumns: cols }}>
                <div style={{ ...T.h3, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                <div style={{ ...T.small, color: C.textSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.description || "—"}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: C.textSecondary }}>{c.tagCount}</div>
                <RowActions onEdit={() => open(c)} onDelete={() => del(c)} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Tags tab ─────────────────────────────────────────────────
export function TagsTab() {
  const { data, loading, error, refetch } = useApi(() => api.getTags(), []);
  const { data: catData } = useApi(() => api.getCategories(), []);
  const tags = data?.tags || [];
  const categories = catData?.categories || [];

  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLOR_PRESETS[0]);
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState(null);
  const [filterCat, setFilterCat] = useState("");
  const [ConfirmDialog, confirm] = useConfirm();

  const open = (tag) => {
    setEditing(tag || "new");
    setName(tag?.name || "");
    setColor(tag?.color || TAG_COLOR_PRESETS[0]);
    setCategoryId(tag?.categoryId || categories[0]?.id || "");
    setFormErr(null);
  };
  const close = () => { setEditing(null); setName(""); setColor(TAG_COLOR_PRESETS[0]); setCategoryId(""); setFormErr(null); };

  const save = async () => {
    if (!name.trim())      { setFormErr("Name is required"); return; }
    if (!categoryId)       { setFormErr("Category is required"); return; }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) { setFormErr("Color must be a #rrggbb hex"); return; }
    setSaving(true); setFormErr(null);
    try {
      const body = { name: name.trim(), color, categoryId };
      if (editing === "new") await api.createTag(body);
      else                   await api.updateTag(editing.id, body);
      close();
      refetch();
    } catch (e) { setFormErr(e.message); } finally { setSaving(false); }
  };

  const del = async (tag) => {
    const ok = await confirm({
      title: "Delete this tag?",
      body: `Removes "${tag.name}". Contacts that have this tag will keep the id internally but it won't display anymore.`,
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try { await api.deleteTag(tag.id); refetch(); } catch (e) { alert(e.message); }
  };

  const visibleTags = filterCat ? tags.filter(t => t.categoryId === filterCat) : tags;
  const canAdd = categories.length > 0;
  const cols = "2fr 1.5fr 130px 90px";
  const swatchOn = (c) => color.toLowerCase() === c.toLowerCase();

  return (
    <div>
      {ConfirmDialog}
      <SectionHeader icon={TagIcon} title="Tags" count={tags.length}
        actionLabel={canAdd ? "Add Tag" : undefined} onAction={canAdd ? () => open(null) : undefined} />

      {!canAdd && (
        <div style={{ padding: "12px 16px", borderRadius: 12, marginBottom: 14, background: C.amberSoft, color: C.amber, ...T.small, fontWeight: 550 }}>
          You need at least one category before you can create tags. Add one under <strong>Instagram categories</strong> first.
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {editing && (
        <FormPanel title={editing === "new" ? "New tag" : `Edit “${editing.name}”`} onClose={close}>
          {formErr && <ErrorNote>{formErr}</ErrorNote>}
          <div style={{ marginBottom: 14 }}>
            <Label>Tag name</Label>
            <TextInput value={name} onChange={setName} placeholder="e.g. Hot lead" autoFocus />
          </div>
          <div style={{ marginBottom: 14 }}>
            <Label>Color</Label>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {/* Colour picker: the selected swatch is ringed in the card colour — a picker, not an outline. */}
              {TAG_COLOR_PRESETS.map(c => (
                <button key={c} onClick={() => setColor(c)} title={c} aria-label={c} aria-pressed={swatchOn(c)}
                  style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: c, cursor: "pointer", padding: 0, flexShrink: 0, boxShadow: swatchOn(c) ? `0 0 0 2px ${C.raised}, 0 0 0 4px ${c}` : "none", transition: "box-shadow .12s" }} />
              ))}
              <label title="Custom colour" style={{ position: "relative", width: 26, height: 26, borderRadius: "50%", background: C.surface2, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, overflow: "hidden", marginLeft: 4 }}>
                <Plus size={14} color={C.textSecondary} />
                <input type="color" value={color} onChange={e => setColor(e.target.value)} aria-label="Custom colour"
                  style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer", border: "none", padding: 0 }} />
              </label>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: 4 }}>
                <span style={tagChipStyle(color)}>{name.trim() || "Preview"}</span>
                <span style={{ fontSize: 12.5, fontFamily: MONO, color: C.textMuted }}>{color}</span>
              </span>
            </div>
          </div>
          <div>
            <Label>Category</Label>
            <SearchableSelect fullWidth value={categoryId} onChange={v => setCategoryId(v)} placeholder="Choose a category…"
              options={categories.map(c => ({ value: c.id, label: c.name }))} />
          </div>
          <SaveCancel onSave={save} onCancel={close} busy={saving} label={editing === "new" ? "Create" : "Save changes"} />
        </FormPanel>
      )}

      {/* Category filter — a pill strip, solid accent on the active one */}
      {categories.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <PillTabs size="sm" value={filterCat} onChange={setFilterCat}
            tabs={[{ id: "", label: "All" }, ...categories.map(c => ({ id: c.id, label: c.name }))]} />
        </div>
      )}

      <Card padding={6}>
        {loading && !data ? (
          <div style={{ padding: 24, ...T.small, color: C.textMuted }}>Loading…</div>
        ) : visibleTags.length === 0 ? (
          <EmptyState Icon={TagIcon} title={tags.length === 0 ? "No tags yet" : "No tags in this category"}
            body={tags.length === 0 ? "Create one to start labeling contacts (e.g. Hot lead, Customer, VIP)." : undefined} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ ...HEAD, gridTemplateColumns: cols }}>
              <div>Tag</div><div>Category</div><div>Created</div><div style={{ textAlign: "right" }}>Actions</div>
            </div>
            {visibleTags.map(t => (
              <div key={t.id} {...rowHover} style={{ ...ROW, gridTemplateColumns: cols }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: t.color, flexShrink: 0 }} />
                  <span style={tagChipStyle(t.color)}>{t.name}</span>
                </div>
                <div style={{ ...T.small, color: C.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.categoryName || "—"}</div>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.textMuted }}>{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—"}</div>
                <RowActions onEdit={() => open(t)} onDelete={() => del(t)} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
