import { useState, useEffect, useMemo, useRef } from "react";
import { RefreshCw, Filter, X, Plus, Trash2, Download, Users, Clock, BadgeCheck, Bookmark, Tag as TagIcon, Loader2, ChevronUp, ChevronDown, Columns3, Pencil, ArrowUpDown } from "lucide-react";
import { api } from "../api.js";
import { relativeTime, C, T, BTN, INPUT, MONO, FONT } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { PageHeader, UnderlineTabs } from "../components/UI.jsx";
import TagsManager from "../components/contacts/TagsManager.jsx";
import { FieldsTab } from "./ContactFieldsPage.jsx";
import { SearchableSelect, MultiSelect } from "../components/Dropdown.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { TagPills } from "../components/TagPicker.jsx";
import ContactModal, { Avatar, contactLabel } from "../components/ContactModal.jsx";
import { useScope } from "../components/scope/scopeStore.js";
import { useCrm, createTag, createField, tagOptions, fieldOptions } from "../components/contacts/crmStore.js";

// ManyChat-style Contacts: saved segments + tags in a left rail, a rule-based
// filter (tags, custom fields, system fields; all / any), bulk actions, and the
// contact profile (components/ContactModal.jsx). Data: /api/crm/contacts.

const DAY = 86400000;
const SUBJECTS = [
  { value: "tag", label: "Tag" },
  { value: "field", label: "Custom field" },
  { value: "window", label: "Messaging window" },
  { value: "follows", label: "Follows your account" },
  { value: "last_interaction", label: "Last interaction" },
  { value: "subscribed", label: "Subscribed" },
  { value: "messages", label: "Messages" },
];
const newRule = (subject = "tag") => ({ id: Math.random().toString(36).slice(2, 8), subject,
  op: { tag: "has", field: "is", window: "open", follows: "yes", last_interaction: "within", subscribed: "within", messages: "gt" }[subject], value: subject === "last_interaction" || subject === "subscribed" ? "7" : "", key: "" });

function matchRule(c, r) {
  const fv = (k) => (c.fields?.[k] ?? "");
  switch (r.subject) {
    case "tag": { const has = (c.tags || []).includes(r.value); return r.op === "not" ? !has : has; }
    case "field": {
      if (!r.key) return true;
      const v = String(fv(r.key)).toLowerCase(), w = String(r.value || "").toLowerCase();
      return r.op === "set" ? v !== "" : r.op === "unset" ? v === "" : r.op === "not" ? v !== w : r.op === "contains" ? v.includes(w)
        : r.op === "gt" ? Number(v) > Number(r.value) : r.op === "lt" ? Number(v) < Number(r.value) : v === w;
    }
    case "window": return r.op === "open" ? c.windowOpen : !c.windowOpen;
    case "follows": return r.op === "yes" ? c.followsYou === true : r.op === "no" ? c.followsYou === false : c.followsYou == null;
    case "last_interaction":
    case "subscribed": {
      const t = r.subject === "subscribed" ? c.subscribedAt : c.lastInteractionAt;
      if (!t) return r.op === "older";
      const age = Date.now() - new Date(t).getTime(), d = Number(r.value || 0) * DAY;
      return r.op === "within" ? age <= d : age > d;
    }
    case "messages": return r.op === "gt" ? Number(c.messageCount) > Number(r.value || 0) : Number(c.messageCount) < Number(r.value || 0);
    default: return true;
  }
}
const ruleText = (r, crm) => {
  if (r.subject === "tag") return `${r.op === "not" ? "No tag" : "Tag"}: ${crm.tags.find(t => t.id === r.value)?.name || "…"}`;
  if (r.subject === "field") return `${crm.fields.find(f => f.key === r.key)?.name || r.key || "Field"} ${{ is: "is", not: "is not", contains: "contains", set: "is set", unset: "is empty", gt: ">", lt: "<" }[r.op]} ${["set", "unset"].includes(r.op) ? "" : r.value}`;
  if (r.subject === "window") return r.op === "open" ? "24h window open" : "24h window closed";
  if (r.subject === "follows") return r.op === "yes" ? "Follows you" : r.op === "no" ? "Doesn't follow you" : "Follow status unknown";
  if (r.subject === "last_interaction") return `Last interaction ${r.op === "within" ? "within" : "over"} ${r.value} days${r.op === "within" ? "" : " ago"}`;
  if (r.subject === "subscribed") return `Subscribed ${r.op === "within" ? "within" : "over"} ${r.value} days${r.op === "within" ? "" : " ago"}`;
  if (r.subject === "messages") return `Messages ${r.op === "gt" ? ">" : "<"} ${r.value || 0}`;
  return r.subject;
};

export default function ContactsPage({ user }) {
  const isAdmin = user?.role === "admin";
  const crm = useCrm();
  const [ConfirmDialog, confirm] = useConfirm();
  const [rows, setRows] = useState(null);
  const [account, setAccount] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState({ match: "all", rules: [] });
  const [segment, setSegment] = useState(null);       // active saved segment id (or preset key)
  const [segments, setSegments] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [sort, setSort] = useState({ key: "last", dir: -1 });
  const [cols, setCols] = useState([]);                // custom field keys shown as columns
  const [showFilter, setShowFilter] = useState(false);
  const [view, setView] = useState("contacts");        // contacts | tags | fields
  const [editTag, setEditTag] = useState(null);

  const load = () => api.crm.contacts(account || undefined).then(d => setRows(d.contacts)).catch(e => showToast(e.message, "error"));
  useEffect(() => { setRows(null); load(); }, [account]);
  useEffect(() => { api.crm.segments().then(setSegments).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(load, 300000); return () => clearInterval(t); }, [account]);

  // "My accounts" preset (top bar): contacts of Instagram accounts outside it are hidden.
  const scope = useScope();
  const all = useMemo(() => (rows || []).filter(c => scope.hasIg(c.accountId)), [rows, scope.tokens.join(",")]);
  const accounts = useMemo(() => {
    const m = new Map();
    for (const c of all) if (!m.has(c.accountId)) m.set(c.accountId, c.accountUsername ? "@" + c.accountUsername : c.accountId);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [all]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = all.filter(c => !needle || [c.name, c.username, c.peerId, ...Object.values(c.fields || {})].some(v => String(v || "").toLowerCase().includes(needle)));
    if (filter.rules.length) list = list.filter(c => filter.match === "any" ? filter.rules.some(r => matchRule(c, r)) : filter.rules.every(r => matchRule(c, r)));
    const val = (c) => sort.key === "name" ? contactLabel(c).toLowerCase() : sort.key === "subscribed" ? new Date(c.subscribedAt || 0).getTime()
      : sort.key === "messages" ? Number(c.messageCount) : sort.key === "follows" ? (c.followsYou === true ? 2 : c.followsYou === false ? 1 : 0) : new Date(c.lastInteractionAt || c.lastSeenAt || 0).getTime();
    return [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  }, [all, q, filter, sort]);

  const tagCounts = useMemo(() => { const m = {}; for (const c of all) for (const t of c.tags || []) m[t] = (m[t] || 0) + 1; return m; }, [all]);
  const presets = [
    { id: "all", label: "All", Icon: Users, filter: { match: "all", rules: [] }, n: all.length },
    { id: "window", label: "Window open", Icon: Clock, filter: { match: "all", rules: [{ ...newRule("window"), op: "open" }] }, n: all.filter(c => c.windowOpen).length },
    { id: "follows", label: "Follow you", Icon: BadgeCheck, filter: { match: "all", rules: [{ ...newRule("follows"), op: "yes" }] }, n: all.filter(c => c.followsYou === true).length },
  ];
  const applyPreset = (id, f) => { setSegment(id); setFilter(JSON.parse(JSON.stringify(f))); setSelected(new Set()); };
  const filterTag = (tagId) => applyPreset("tag:" + tagId, { match: "all", rules: [{ ...newRule("tag"), value: tagId }] });

  async function saveSegment() {
    const name = window.prompt("Name this segment", "");
    if (!name?.trim()) return;
    try { const s = await api.crm.saveSegment({ name: name.trim(), filter }); setSegments(x => [...x, s]); setSegment("seg:" + s.id); showToast("Segment saved", "success"); }
    catch (e) { showToast(e.message, "error"); }
  }
  async function deleteSegment(s) {
    if (!await confirm({ title: `Delete segment “${s.name}”?`, body: "Only the saved filter is removed. Contacts stay.", confirmLabel: "Delete", danger: true })) return;
    await api.crm.deleteSegment(s.id).catch(() => {});
    setSegments(x => x.filter(y => y.id !== s.id));
    if (segment === "seg:" + s.id) applyPreset("all", presets[0].filter);
  }

  const allVisibleSelected = shown.length > 0 && shown.every(c => selected.has(c.id));
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(shown.map(c => c.id)));
  const toggle = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const open = all.find(c => c.id === openId);

  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      <PageHeader title="Contacts" sub={rows ? `${all.length.toLocaleString("en-IN")} people who messaged your Instagram accounts` : "Loading…"}
        right={<div style={{ display: "flex", gap: 8 }}>
          {accounts.length > 1 && <SearchableSelect value={account} options={accounts} onChange={v => setAccount(v || "")} allLabel="All accounts" label="Account" />}
          <button onClick={load} style={BTN.icon} title="Refresh" aria-label="Refresh"><RefreshCw size={15} /></button>
        </div>} />

      {isAdmin && <UnderlineTabs value={view} onChange={(v) => { setView(v); setEditTag(null); }} style={{ marginBottom: 16 }} tabs={[
        { id: "contacts", label: "Contacts", count: rows ? all.length : undefined },
        { id: "tags", label: "Tags", count: crm.tags.length },
        { id: "fields", label: "Custom fields", count: crm.fields.filter(f => !f.archived).length },
      ]} />}

      {view === "tags" && <TagsManager counts={tagCounts} confirm={confirm} editId={editTag} onFilter={(id) => { setView("contacts"); filterTag(id); }} />}
      {view === "fields" && <FieldsTab embedded />}

      {view === "contacts" && <div>
        {/* One toolbar instead of a rail (2026-10-16, "make it minimal"): the
            quick views, a tag, a saved segment and the sort are each one
            control; the full rule builder stays behind "More filters". */}
        <div style={{ minWidth: 0 }}>
          <div data-testid="contacts-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, @username or any field" aria-label="Search contacts" style={{ ...INPUT, flex: "1 1 220px", width: "auto", maxWidth: 320 }} />
            <div role="group" aria-label="Quick view" style={{ display: "inline-flex", gap: 4, padding: 3, borderRadius: 12, background: C.surface }}>
              {presets.map(p => {
                const on = segment === p.id || (!segment && p.id === "all" && !filter.rules.length);
                return (
                  <button key={p.id} onClick={() => applyPreset(p.id, p.filter)} aria-pressed={on}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 13, fontWeight: on ? 700 : 600, background: on ? C.card : "transparent", color: on ? C.text : C.textSecondary, boxShadow: on ? C.shadowSm : "none" }}>
                    <p.Icon size={13} />{p.label}<span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>{p.n.toLocaleString("en-IN")}</span>
                  </button>
                );
              })}
            </div>
            {crm.tags.length > 0 && (
              <SearchableSelect value={String(segment || "").startsWith("tag:") ? segment.slice(4) : ""} allLabel="Any tag" placeholder="Tag" minWidth={140}
                options={crm.tags.map(t => ({ value: t.id, label: `${t.name} · ${tagCounts[t.id] || 0}` }))}
                onChange={v => (v ? filterTag(v) : applyPreset("all", presets[0].filter))} />
            )}
            {segments.length > 0 && (
              <SearchableSelect value={String(segment || "").startsWith("seg:") ? segment.slice(4) : ""} allLabel="No segment" placeholder="Segment" minWidth={150}
                options={segments.map(sg => ({ value: String(sg.id), label: sg.name }))}
                onChange={v => { const sg = segments.find(x => String(x.id) === String(v)); sg ? applyPreset("seg:" + sg.id, sg.filter) : applyPreset("all", presets[0].filter); }} />
            )}
            <SearchableSelect value={`${sort.key}:${sort.dir}`} minWidth={190} label={<ArrowUpDown size={13} />}
              options={SORTS} onChange={v => { const [key, dir] = String(v).split(":"); setSort({ key, dir: Number(dir) }); }} />
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowFilter(o => !o)} style={{ ...BTN.secondary, background: filter.rules.length ? C.primarySoft : C.surface2, color: filter.rules.length ? C.primary : C.text }}>
                <Filter size={14} /> More filters{filter.rules.length ? ` · ${filter.rules.length}` : ""}
              </button>
              {showFilter && <FilterBuilder filter={filter} crm={crm} onChange={(f) => { setFilter(f); setSegment(null); }} onClose={() => setShowFilter(false)} />}
            </div>
            <ColumnPicker cols={cols} setCols={setCols} crm={crm} />
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: C.textMuted }}><b style={{ color: C.text, fontFamily: MONO }}>{shown.length.toLocaleString("en-IN")}</b> shown</span>
          </div>

          {filter.rules.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
              {filter.rules.map((r, i) => (
                <span key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 6px 5px 11px", borderRadius: 999, background: C.primarySoft, color: C.primary, fontSize: 12.5, fontWeight: 650 }}>
                  {i > 0 && <span style={{ opacity: .7, marginRight: 2 }}>{filter.match === "any" ? "or" : "and"}</span>}{ruleText(r, crm)}
                  <button onClick={() => { setFilter(f => ({ ...f, rules: f.rules.filter(x => x.id !== r.id) })); setSegment(null); }} aria-label="Remove filter" style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", display: "inline-flex", padding: 2 }}><X size={12} /></button>
                </span>
              ))}
              <button onClick={() => applyPreset("all", presets[0].filter)} style={{ ...BTN.ghost, padding: "4px 6px", fontSize: 12.5 }}>Clear</button>
              {isAdmin && !String(segment || "").startsWith("seg:") && <button onClick={saveSegment} style={{ ...BTN.ghost, padding: "4px 6px", fontSize: 12.5, color: C.primary }}><Bookmark size={13} /> Save as segment</button>}
              {isAdmin && String(segment || "").startsWith("seg:") && (() => { const sg = segments.find(x => "seg:" + x.id === segment); return sg ? <button onClick={() => deleteSegment(sg)} style={{ ...BTN.ghost, padding: "4px 6px", fontSize: 12.5, color: C.errText }}><Trash2 size={13} /> Delete segment</button> : null; })()}
            </div>
          )}

          {selected.size > 0 && <BulkBar ids={[...selected]} crm={crm} isAdmin={isAdmin} confirm={confirm} rows={all} cols={cols}
            onDone={() => { setSelected(new Set()); load(); }} onClear={() => setSelected(new Set())} />}

          <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ width: 36, padding: "10px 0 10px 14px" }}><Check on={allVisibleSelected} onClick={toggleAll} label="Select all" /></th>
                    <Th k="name" sort={sort} setSort={setSort}>Contact</Th>
                    <th style={th}>Status</th>
                    <Th k="follows" sort={sort} setSort={setSort}>Follows you</Th>
                    <th style={th}>Tags</th>
                    {cols.map(k => <th key={k} style={th}>{crm.fields.find(f => f.key === k)?.name || k}</th>)}
                    <Th k="last" sort={sort} setSort={setSort}>Last interaction</Th>
                    <Th k="subscribed" sort={sort} setSort={setSort}>Subscribed</Th>
                    <Th k="messages" sort={sort} setSort={setSort} right>Msgs</Th>
                  </tr>
                </thead>
                <tbody>
                  {!rows && <tr><td colSpan={8 + cols.length} style={{ padding: 40, textAlign: "center", color: C.textMuted }}><Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /></td></tr>}
                  {rows && shown.length === 0 && <tr><td colSpan={8 + cols.length} style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 14 }}>{all.length ? "No contacts match." : "No contacts yet. They appear when people DM your Instagram accounts."}</td></tr>}
                  {shown.slice(0, 500).map(c => (
                    <tr key={c.id} onClick={() => setOpenId(c.id)} className="fs-crow" style={{ cursor: "pointer", background: selected.has(c.id) ? C.primaryFaint : "transparent" }}>
                      <td style={{ padding: "10px 0 10px 14px" }} onClick={e => { e.stopPropagation(); toggle(c.id); }}><Check on={selected.has(c.id)} label={`Select ${contactLabel(c)}`} /></td>
                      <td style={td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          <Avatar pic={c.profilePic} label={contactLabel(c)} seed={c.peerId} size={34} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{contactLabel(c)}</div>
                            <div style={{ fontSize: 12, color: C.textMuted }}>{c.username ? "@" + c.username : "No username"}{accounts.length > 1 && c.accountUsername ? ` · via @${c.accountUsername}` : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td style={td}>
                        <span title={c.windowOpen ? "Can be messaged (within 24h of their last message)" : "Outside the 24h messaging window"} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 650, color: c.windowOpen ? C.green : C.textMuted, whiteSpace: "nowrap" }}>
                          <i style={{ width: 7, height: 7, borderRadius: "50%", background: c.windowOpen ? C.green : C.textMuted }} />{c.windowOpen ? "Open" : "Closed"}
                        </span>
                      </td>
                      <td style={td}><FollowBadge v={c.followsYou} /></td>
                      <td style={td}><TagPills tagIds={c.tags} allTags={crm.tags} maxShown={3} /></td>
                      {cols.map(k => <td key={k} style={{ ...td, fontSize: 13, color: C.textSecondary, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.fields?.[k] ?? <span style={{ color: C.textMuted }}>—</span>}</td>)}
                      <td style={{ ...td, fontSize: 13, color: C.textSecondary, whiteSpace: "nowrap" }}>{c.lastInteractionAt ? relativeTime(c.lastInteractionAt) : "—"}</td>
                      <td style={{ ...td, fontSize: 13, color: C.textSecondary, whiteSpace: "nowrap" }}>{c.subscribedAt ? new Date(c.subscribedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" }) : "—"}</td>
                      <td style={{ ...td, fontSize: 13, fontFamily: MONO, textAlign: "right", paddingRight: 16 }}>{c.messageCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length > 500 && <div style={{ padding: 12, fontSize: 12.5, color: C.textMuted, textAlign: "center" }}>Showing the first 500 of {shown.length}. Narrow it down with a filter.</div>}
          </div>
        </div>
      </div>}

      {open && (
        <ContactModal contact={open} onClose={() => setOpenId(null)} onSaved={load} onDeleted={() => { setOpenId(null); load(); }} isAdmin={isAdmin} confirm={confirm}
          onOpenChat={(c) => {
            try { sessionStorage.setItem("forgesocial.openIgChat", JSON.stringify({ accountId: c.accountId, peerId: c.peerId })); } catch (_) {}
            window.location.hash = "#/social/inbox";
            setOpenId(null);
          }} />
      )}
      <style>{".fs-crow:hover{background:var(--fc-surface) !important}.fs-crow td{box-shadow:inset 0 1px 0 var(--fc-surface-2)}"}</style>
    </div>
  );
}

// Sort options for the toolbar — the column headers still sort too.
const SORTS = [
  { value: "last:-1", label: "Last interaction · newest" },
  { value: "last:1", label: "Last interaction · oldest" },
  { value: "subscribed:-1", label: "Subscribed · newest" },
  { value: "subscribed:1", label: "Subscribed · oldest" },
  { value: "name:1", label: "Name · A–Z" },
  { value: "messages:-1", label: "Most messages" },
  { value: "follows:-1", label: "Follows you first" },
];

const th = { textAlign: "left", padding: "10px 12px", fontSize: 12, fontWeight: 650, color: C.textMuted, whiteSpace: "nowrap" };
const td = { padding: "10px 12px", verticalAlign: "middle" };

function Th({ k, sort, setSort, children, right }) {
  const on = sort.key === k;
  return (
    <th style={{ ...th, textAlign: right ? "right" : "left", paddingRight: right ? 16 : 12, cursor: "pointer", color: on ? C.text : C.textMuted }} onClick={() => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : -1 }))}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>{children}{on && (sort.dir < 0 ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}</span>
    </th>
  );
}

function Check({ on, onClick, label }) {
  return (
    <span role="checkbox" aria-checked={on} aria-label={label} tabIndex={0} onClick={onClick} onKeyDown={e => e.key === " " && onClick?.()}
      style={{ width: 17, height: 17, borderRadius: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", background: on ? C.primary : C.surface2, color: C.onAccent }}>
      {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>}
    </span>
  );
}

// Follow status — filled automatically (contactsCrm follow sweep) once someone has messaged you.
function FollowBadge({ v }) {
  if (v == null) return <span title="Not checked yet. ForgeGrowth checks automatically after they message you." style={{ fontSize: 12.5, color: C.textMuted }}>—</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, fontWeight: 650, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap",
      background: v ? C.blueSoft : C.surface2, color: v ? C.blue : C.textSecondary }}>
      {v && <BadgeCheck size={12} />}{v ? "Following" : "Not following"}
    </span>
  );
}

function usePopoverDismiss(ref, onClose) {
  useEffect(() => {
    const d = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.("[data-fc-pop]")) onClose(); };
    const t = setTimeout(() => document.addEventListener("mousedown", d), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", d); };
  }, [ref, onClose]);
}

function FilterBuilder({ filter, crm, onChange, onClose }) {
  const ref = useRef(null);
  usePopoverDismiss(ref, onClose);
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(filter.rules.length ? filter : { match: "all", rules: [newRule("tag")] })));
  const upd = (i, patch) => setF(x => ({ ...x, rules: x.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  return (
    <div ref={ref} style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 30, width: 560, maxWidth: "min(calc(90vw / var(--fg-zoom, 1)), calc(calc(100vw / var(--fg-zoom, 1)) - 420px))", background: C.card, borderRadius: 16, boxShadow: C.shadowLg, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Contacts that match</span>
        <SearchableSelect value={f.match} options={[{ value: "all", label: "all rules" }, { value: "any", label: "any rule" }]} onChange={v => setF(x => ({ ...x, match: v }))} minWidth={110} />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...BTN.icon, width: 28, height: 28 }} aria-label="Close"><X size={14} /></button>
      </div>
      {f.rules.map((r, i) => (
        <div key={r.id} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", background: C.raised, borderRadius: 12, padding: 8, marginBottom: 6 }}>
          <SearchableSelect value={r.subject} options={SUBJECTS} onChange={v => upd(i, { ...newRule(v), id: r.id })} minWidth={150} />
          {r.subject === "tag" && <>
            <SearchableSelect value={r.op} options={[{ value: "has", label: "has" }, { value: "not", label: "doesn't have" }]} onChange={v => upd(i, { op: v })} minWidth={120} />
            <SearchableSelect value={r.value} options={tagOptions(crm.tags)} onChange={v => upd(i, { value: v })} placeholder="Tag" minWidth={140} />
          </>}
          {r.subject === "field" && <>
            <SearchableSelect value={r.key} options={fieldOptions(crm.fields)} onChange={v => upd(i, { key: v })} placeholder="Field" minWidth={140} />
            <SearchableSelect value={r.op} onChange={v => upd(i, { op: v })} minWidth={110}
              options={[{ value: "is", label: "is" }, { value: "not", label: "is not" }, { value: "contains", label: "contains" }, { value: "set", label: "is set" }, { value: "unset", label: "is empty" }, { value: "gt", label: ">" }, { value: "lt", label: "<" }]} />
            {!["set", "unset"].includes(r.op) && <input value={r.value} onChange={e => upd(i, { value: e.target.value })} placeholder="Value" style={{ ...INPUT, background: C.card, width: 130 }} />}
          </>}
          {r.subject === "window" && <SearchableSelect value={r.op} options={[{ value: "open", label: "is open" }, { value: "closed", label: "is closed" }]} onChange={v => upd(i, { op: v })} minWidth={120} />}
          {r.subject === "follows" && <SearchableSelect value={r.op} options={[{ value: "yes", label: "yes" }, { value: "no", label: "no" }, { value: "unknown", label: "unknown" }]} onChange={v => upd(i, { op: v })} minWidth={110} />}
          {(r.subject === "last_interaction" || r.subject === "subscribed") && <>
            <SearchableSelect value={r.op} options={[{ value: "within", label: "within the last" }, { value: "older", label: "more than" }]} onChange={v => upd(i, { op: v })} minWidth={140} />
            <input type="number" min={0} value={r.value} onChange={e => upd(i, { value: e.target.value })} style={{ ...INPUT, background: C.card, width: 70 }} />
            <span style={{ fontSize: 13, color: C.textMuted }}>days{r.op === "older" ? " ago" : ""}</span>
          </>}
          {r.subject === "messages" && <>
            <SearchableSelect value={r.op} options={[{ value: "gt", label: "more than" }, { value: "lt", label: "fewer than" }]} onChange={v => upd(i, { op: v })} minWidth={120} />
            <input type="number" min={0} value={r.value} onChange={e => upd(i, { value: e.target.value })} style={{ ...INPUT, background: C.card, width: 80 }} />
          </>}
          <span style={{ flex: 1 }} />
          <button onClick={() => setF(x => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))} style={{ ...BTN.icon, width: 28, height: 28, background: "transparent" }} aria-label="Remove rule"><X size={13} /></button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => setF(x => ({ ...x, rules: [...x.rules, newRule("tag")] }))} style={{ ...BTN.secondary, padding: "7px 12px", fontSize: 13 }}><Plus size={13} /> Add rule</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => { onChange({ match: "all", rules: [] }); onClose(); }} style={{ ...BTN.ghost, fontSize: 13 }}>Reset</button>
        <button onClick={() => { onChange({ ...f, rules: f.rules.filter(r => r.subject !== "tag" || r.value).filter(r => r.subject !== "field" || r.key) }); onClose(); }} style={{ ...BTN.primary, padding: "7px 14px", fontSize: 13 }}>Apply</button>
      </div>
    </div>
  );
}

function ColumnPicker({ cols, setCols, crm }) {
  if (!crm.fields.length) return null;
  return <MultiSelect values={cols} options={fieldOptions(crm.fields)} onChange={v => setCols(v.slice(0, 4))} placeholder="Field columns" label={<Columns3 size={13} />} minWidth={150} />;
}

function BulkBar({ ids, crm, isAdmin, confirm, onDone, onClear, rows, cols }) {
  const [action, setAction] = useState("add_tag");
  const [tags, setTags] = useState([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function apply() {
    if (action === "export") return exportCsv();
    if (action === "delete" && !await confirm({ title: `Delete ${ids.length} contacts?`, body: "Their tags and fields are removed. Messages are kept.", confirmLabel: "Delete", danger: true })) return;
    setBusy(true);
    try {
      const r = await api.crm.bulk({ ids, action, tags, key, value });
      showToast(action === "delete" ? `${r.deleted} deleted` : `${r.updated} updated`, "success");
      setTags([]); setValue("");
      onDone();
    } catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }
  function exportCsv() {
    const sel = rows.filter(r => ids.includes(r.id));
    const keys = crm.fields.map(f => f.key);
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Contact ID", "Name", "Username", "Instagram user ID", "Account", "Tags", "Subscribed", "Last interaction", "Messages", "Follows you", ...crm.fields.map(f => f.name)];
    const lines = sel.map(c => [c.id, c.name, c.username ? "@" + c.username : "", c.peerId, c.accountUsername, (c.tags || []).map(t => crm.tags.find(x => x.id === t)?.name || t).join("; "),
      c.subscribedAt, c.lastInteractionAt, c.messageCount, c.followsYou == null ? "" : c.followsYou ? "Yes" : "No", ...keys.map(k => c.fields?.[k])].map(esc).join(","));
    const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `instagram-contacts-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const options = [
    { value: "add_tag", label: "Add tag" }, { value: "remove_tag", label: "Remove tag" },
    { value: "set_field", label: "Set field" }, { value: "clear_field", label: "Clear field" },
    { value: "export", label: "Export CSV" }, ...(isAdmin ? [{ value: "delete", label: "Delete contacts" }] : []),
  ];
  const ready = action === "export" || action === "delete" || ((action === "add_tag" || action === "remove_tag") ? tags.length : action === "clear_field" ? key : key && value);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", background: C.primarySoft, borderRadius: 14, padding: "8px 10px", marginBottom: 10 }}>
      <b style={{ fontSize: 13.5, color: C.primary, padding: "0 4px" }}>{ids.length} selected</b>
      <SearchableSelect value={action} options={options} onChange={setAction} minWidth={140} />
      {(action === "add_tag" || action === "remove_tag") && <MultiSelect values={tags} options={tagOptions(crm.tags)} onChange={setTags} placeholder="Choose tags" onCreate={isAdmin && action === "add_tag" ? createTag : undefined} createLabel="Create tag" />}
      {(action === "set_field" || action === "clear_field") && <SearchableSelect value={key} options={fieldOptions(crm.fields)} onChange={setKey} placeholder="Field" minWidth={140} onCreate={isAdmin && action === "set_field" ? createField : undefined} createLabel="Create field" />}
      {action === "set_field" && <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value" style={{ ...INPUT, background: C.card, width: 150 }} />}
      <button onClick={apply} disabled={!ready || busy} style={{ ...(action === "delete" ? BTN.danger : BTN.primary), padding: "8px 14px", fontSize: 13, opacity: ready ? 1 : .55 }}>
        {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : action === "export" ? <Download size={13} /> : action === "delete" ? <Trash2 size={13} /> : <TagIcon size={13} />} Apply
      </button>
      <span style={{ flex: 1 }} />
      <button onClick={onClear} style={{ ...BTN.ghost, padding: "6px 8px", fontSize: 13 }}>Deselect</button>
    </div>
  );
}
