import { useState, useEffect, useCallback, useRef } from "react";
import { X, Trash2, ExternalLink, MessageSquare, RefreshCw, Loader2, Check, Plus, BadgeCheck, Clock, Zap, Workflow, ClipboardList, Pencil, Send, Image as ImageIcon } from "lucide-react";
import { api } from "../api.js";
import { relativeTime, C, T, BTN, INPUT, MONO, FONT } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { UnderlineTabs } from "./UI.jsx";
import { SearchableSelect, MultiSelect } from "./Dropdown.jsx";
import { TagPills } from "./TagPicker.jsx";
import { useCrm, createTag, createField, tagOptions, fieldOptions } from "./contacts/crmStore.js";
import { StatusPill } from "./automations/shared.jsx";

// ManyChat-style contact profile: identity + status on the left; tags, notes,
// custom & system fields and the automation timeline on the right, and the
// Instagram conversation in a side drawer INSIDE the pop-up (Open chat). Sales →
// Contacts' profile (pages/sales/ContactProfileModal.jsx) has the same shape.
// Shared by Contacts (row click) and Inbox (chat header). Props kept from the
// old ContactModal so both callers work unchanged.

const PALETTE = [
  ["var(--fc-pink-soft)", "var(--fc-pink)"], ["var(--fc-blue-soft)", "var(--fc-blue)"], ["var(--fc-green-soft)", "var(--fc-green)"],
  ["var(--fc-amber-soft)", "var(--fc-amber)"], ["var(--fc-purple-soft)", "var(--fc-purple)"], ["var(--fc-err-bg)", "var(--fc-err-text)"],
];
function avatarColor(seed) {
  const s = String(seed || "?"); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = (s) => { const p = String(s || "?").replace(/^@/, "").trim().split(/\s+/); return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?"; };
export function Avatar({ pic, label, size = 64, seed, ring }) {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [pic]);
  const [bg, color] = avatarColor(seed ?? label);
  const box = { width: size, height: size, borderRadius: "50%", flexShrink: 0, boxShadow: ring ? `0 0 0 3px var(--fc-card), 0 0 0 5px ${ring}` : "none" };
  if (pic && !err) return <img src={pic} alt="" onError={() => setErr(true)} style={{ ...box, objectFit: "cover", display: "block" }} />;
  return <div style={{ ...box, background: bg, color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.36, fontWeight: 700, fontFamily: FONT }}>{initials(label)}</div>;
}
export const contactLabel = (c) => c?.name || (c?.username ? "@" + c.username : "Instagram user · " + String(c?.peerId || "").slice(-4));
const fmtDate = (v) => (v ? new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : null);

export default function ContactModal({ contact: c0, onClose, onSaved, onDeleted, onOpenChat, isAdmin, confirm }) {
  const [p, setP] = useState(null);
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const crm = useCrm();

  const load = useCallback(() => api.crm.profile(c0.id).then(setP).catch(e => showToast(e.message, "error")), [c0.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const k = (e) => { if (e.key === "Escape") (chatOpen ? setChatOpen(false) : onClose()); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, chatOpen]);

  const c = p?.contact || { ...c0 };
  const label = contactLabel(c);
  const igUrl = c.username ? `https://www.instagram.com/${c.username}/` : null;

  async function act(name, fn, ok) {
    setBusy(name);
    try { await fn(); if (ok) showToast(ok, "success"); await load(); onSaved?.(); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  const saveTags = (tags) => act("tags", () => api.setContactTags(c.id, tags));
  async function remove() {
    const ok = confirm ? await confirm({ title: `Delete ${label}?`, body: "The contact, its tags and fields are removed. Messages are kept; a new DM recreates the contact.", confirmLabel: "Delete", danger: true }) : window.confirm("Delete this contact?");
    if (!ok) return;
    try { await api.deleteContact(c.id); showToast("Contact deleted", "success"); onDeleted?.(); }
    catch (e) { showToast(e.message, "error"); }
  }

  return (
    <div onMouseDown={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1000, background: C.scrim, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
      <div role="dialog" aria-label={`Contact ${label}`} data-testid="contact-profile" style={{ position: "relative", width: "min(1000px, 100%)", height: "min(720px, 100%)", background: C.card, borderRadius: 20, boxShadow: C.shadowLg, display: "flex", overflow: "hidden", flexWrap: "wrap" }}>
        {/* ── left: identity ── */}
        <div style={{ width: 300, flex: "0 0 300px", maxWidth: "100%", background: C.raised, padding: 22, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", overflowY: "auto" }}>
          <Avatar pic={c.profilePic} label={label} seed={c.peerId} size={96} ring={c.windowOpen ? C.green : undefined} />
          <NameEdit c={c} label={label} isAdmin={isAdmin} onSave={(name) => act("name", () => api.updateContact(c.id, { name }), "Name saved")} />
          {c.username && c.name && <a href={igUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13.5, color: C.textSecondary, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>@{c.username} <ExternalLink size={12} /></a>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginTop: 12 }}>
            <Chip tone="green">Subscribed</Chip>
            <Chip tone={c.windowOpen ? "green" : "muted"} title="Instagram lets you message people within 24 hours of their last message">
              <Clock size={11} /> {c.windowOpen ? "24h window open" : "Window closed"}
            </Chip>
            {p?.system?.find(s => s.key === "follows_you")?.state === "on" && <Chip tone="blue"><BadgeCheck size={11} /> Follows you</Chip>}
          </div>
          <div style={{ width: "100%", marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={() => setChatOpen(true)} data-testid="open-chat" style={{ ...BTN.primary, justifyContent: "center" }}><MessageSquare size={15} /> Open chat</button>
            {onOpenChat && <button onClick={() => onOpenChat(c)} style={{ ...BTN.ghost, justifyContent: "center", fontSize: 13 }}>Open in Inbox <ExternalLink size={12} /></button>}
            <button onClick={() => act("refresh", () => api.crm.refresh(c.id), "Updated from Instagram")} disabled={busy === "refresh"} style={{ ...BTN.secondary, justifyContent: "center" }}>
              {busy === "refresh" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Refresh from Instagram
            </button>
          </div>
          <div style={{ width: "100%", marginTop: 20, textAlign: "left" }}>
            <Mini label="Instagram page" value={c.accountUsername ? "@" + c.accountUsername : "—"} />
            <Mini label="Subscribed" value={fmtDate(c.subscribedAt) || "—"} />
            <Mini label="Last interaction" value={c.lastInteractionAt ? relativeTime(c.lastInteractionAt) : "—"} />
            <Mini label="Messages" value={p?.system?.find(s => s.key === "messages")?.value || c.messageCount || "—"} />
            <Mini label="Contact ID" value={String(c.id)} mono />
          </div>
          <span style={{ flex: 1 }} />
          {isAdmin && <button onClick={remove} style={{ ...BTN.ghost, color: C.errText, marginTop: 16 }}><Trash2 size={14} /> Delete contact</button>}
        </div>

        {/* ── right: data ── */}
        <div style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "14px 18px 0 22px", gap: 8 }}>
            <UnderlineTabs value={tab} onChange={setTab} style={{ flex: 1 }} tabs={[
              { id: "overview", label: "Overview" },
              { id: "fields", label: "Fields", count: p ? p.custom.filter(f => f.value != null).length : undefined },
              { id: "activity", label: "Automations", count: p?.activity?.length },
            ]} />
            <button onClick={onClose} style={BTN.icon} aria-label="Close"><X size={16} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px 24px" }}>
            {!p ? <div style={{ display: "flex", justifyContent: "center", padding: 60, color: C.textMuted }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
              : tab === "overview" ? <Overview p={p} crm={crm} isAdmin={isAdmin} saveTags={saveTags} busy={busy}
                  saveNotes={(notes) => act("notes", () => api.updateContact(c.id, { notes }), "Notes saved")} goFields={() => setTab("fields")}
                  checkNow={() => act("refresh", () => api.crm.refresh(c.id), "Updated from Instagram")} />
              : tab === "fields" ? <Fields p={p} crm={crm} isAdmin={isAdmin} setField={(key, value) => act("field", () => api.crm.setField(c.id, key, value), value == null ? "Field cleared" : "Field saved")} />
              : <Activity rows={p.activity} />}
          </div>
        </div>

        {chatOpen && <ChatDrawer contactId={c.id} label={label} pic={c.profilePic} seed={c.peerId} onClose={() => setChatOpen(false)} onSent={load} />}
      </div>
    </div>
  );
}

// The conversation with this contact, inside the profile pop-up. Replies go
// through the Inbox's own /instagram/reply, and only inside Instagram's 24-hour
// window (Meta refuses a free-form message outside it).
function ChatDrawer({ contactId, label, pic, seed, onClose, onSent }) {
  const [t, setT] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scroll = useRef(null);
  const load = useCallback(() => api.crm.messages(contactId).then(setT).catch(e => showToast(e.message, "error")), [contactId]);
  useEffect(() => { load(); const iv = setInterval(load, 12000); return () => clearInterval(iv); }, [load]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [t?.messages?.length]);
  async function send(e) {
    e.preventDefault();
    if (!text.trim() || !t) return;
    setSending(true);
    try { await api.replyInstagram({ accountId: t.accountId, recipientId: t.peerId, text: text.trim() }); setText(""); await load(); onSent?.(); }
    catch (err) { showToast(err.message, "error"); }
    finally { setSending(false); }
  }
  return (
    <div data-testid="chat-drawer" style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: "min(460px, 100%)", background: C.card, boxShadow: "-12px 0 32px rgba(0,0,0,.18)", display: "flex", flexDirection: "column", zIndex: 5 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
        <Avatar pic={pic} label={label} seed={seed} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
          <div style={{ fontSize: 12, color: t?.windowOpen ? C.green : C.textMuted }}>{t ? (t.windowOpen ? "24h window open — you can reply" : "Window closed — they need to message first") : "Loading…"}</div>
        </div>
        <button onClick={onClose} style={BTN.icon} aria-label="Close chat"><X size={15} /></button>
      </div>
      <div ref={scroll} style={{ flex: 1, overflowY: "auto", padding: 14, background: C.raised, display: "flex", flexDirection: "column", gap: 6 }}>
        {!t ? <div style={{ margin: "auto", color: C.textMuted }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></div>
          : t.messages.length === 0 ? <div style={{ margin: "auto", fontSize: 13, color: C.textMuted }}>No messages with this contact yet.</div>
          : t.messages.map(m => {
            const out = m.direction === "outgoing";
            const att = (m.attachments || []).length;
            return (
              <div key={m.id} style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "80%" }}>
                <div style={{ padding: "8px 12px", borderRadius: 14, borderBottomRightRadius: out ? 4 : 14, borderBottomLeftRadius: out ? 14 : 4, background: out ? C.primary : C.card, color: out ? "#fff" : C.text, fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", boxShadow: out ? "none" : `0 0 0 1px ${C.surface2}` }}>
                  {m.text || (att ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: 0.85 }}><ImageIcon size={13} /> {att === 1 ? "Attachment" : `${att} attachments`}</span> : <i style={{ opacity: 0.7 }}>(no text)</i>)}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, textAlign: out ? "right" : "left" }} title={m.ts ? new Date(m.ts).toLocaleString() : ""}>{m.ts ? relativeTime(m.ts) : ""}{out && m.seen ? " · Seen" : ""}</div>
              </div>
            );
          })}
      </div>
      <form onSubmit={send} style={{ display: "flex", gap: 8, padding: 12, boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
        <input value={text} onChange={e => setText(e.target.value)} disabled={!t?.windowOpen || sending}
          placeholder={t?.windowOpen ? "Write a reply…" : "You can reply once they message you again"}
          style={{ ...INPUT, background: C.raised, flex: 1 }} aria-label="Reply" />
        <button type="submit" disabled={!t?.windowOpen || sending || !text.trim()} style={{ ...BTN.primary, opacity: !t?.windowOpen || !text.trim() ? 0.55 : 1 }} aria-label="Send">
          {sending ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />}
        </button>
      </form>
    </div>
  );
}

function NameEdit({ c, label, isAdmin, onSave }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(c.name || "");
  useEffect(() => setV(c.name || ""), [c.name]);
  if (edit) {
    return (
      <form onSubmit={e => { e.preventDefault(); onSave(v.trim()); setEdit(false); }} style={{ display: "flex", gap: 6, marginTop: 14, width: "100%" }}>
        <input autoFocus value={v} onChange={e => setV(e.target.value)} style={{ ...INPUT, textAlign: "center", fontWeight: 700 }} aria-label="Display name" />
        <button type="submit" style={BTN.icon} aria-label="Save name"><Check size={15} /></button>
      </form>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14 }}>
      {c.username && !c.name
        ? <a href={`https://www.instagram.com/${c.username}/`} target="_blank" rel="noreferrer" style={{ ...T.h3, fontSize: 19, color: C.text, textDecoration: "none" }} title="Open on Instagram">{label}</a>
        : <span style={{ ...T.h3, fontSize: 19, color: C.text }}>{label}</span>}
      {isAdmin && <button onClick={() => setEdit(true)} style={{ ...BTN.icon, width: 26, height: 26, background: "transparent" }} aria-label="Edit name"><Pencil size={13} /></button>}
    </div>
  );
}

function Chip({ tone, children, title }) {
  const t = tone === "green" ? [C.greenSoft, C.green] : tone === "blue" ? [C.blueSoft, C.blue] : [C.surface2, C.textMuted];
  return <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 999, background: t[0], color: t[1], fontSize: 12, fontWeight: 700 }}>{children}</span>;
}
function Mini({ label, value, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", boxShadow: `inset 0 -1px 0 ${C.surface2}`, fontSize: 13 }}>
      <span style={{ color: C.textMuted }}>{label}</span>
      <span style={{ color: C.text, fontWeight: 600, fontFamily: mono ? MONO : FONT, textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
const H = ({ children, right }) => <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px" }}><span style={{ ...T.label, color: C.textSecondary, flex: 1 }}>{children}</span>{right}</div>;
const Card = ({ children, style }) => <div style={{ background: C.raised, borderRadius: 14, padding: 14, marginBottom: 16, ...style }}>{children}</div>;

function Overview({ p, crm, isAdmin, saveTags, saveNotes, busy, goFields, checkNow }) {
  const c = p.contact;
  const [notes, setNotes] = useState(c.notes || "");
  useEffect(() => setNotes(c.notes || ""), [c.notes]);
  const sys = Object.fromEntries(p.system.map(s => [s.key, s]));
  const filled = p.custom.filter(f => f.value != null).slice(0, 6);
  return (
    <>
      <H right={busy === "tags" && <Loader2 size={13} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} />}>Tags</H>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {(c.tags || []).length > 0 && <TagPills tagIds={c.tags} allTags={crm.tags} size="md" />}
          <MultiSelect values={c.tags || []} options={tagOptions(crm.tags)} onChange={saveTags} placeholder="+ Add tag" minWidth={130}
            onCreate={isAdmin ? createTag : undefined} createLabel="Create tag" emptyText="No tags yet." />
        </div>
      </Card>

      <FollowCard c={c} sys={sys} busy={busy === "refresh"} onCheck={checkNow} />

      <H>At a glance</H>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 10, marginBottom: 16 }}>
        {["email", "phone", "window", "last_text", "last_seen"].map(k => sys[k] && (
          <div key={k} style={{ background: C.raised, borderRadius: 14, padding: "11px 13px", minWidth: 0 }}>
            <div style={{ fontSize: 12, color: C.textMuted }}>{sys[k].label}</div>
            <div style={{ fontSize: 14, fontWeight: 650, color: sys[k].value ? C.text : C.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sys[k].value || ""}>
              {sys[k].type === "date" ? (sys[k].value ? relativeTime(sys[k].value) : "—") : sys[k].value || "—"}
            </div>
          </div>
        ))}
      </div>

      <H right={<button onClick={goFields} style={{ ...BTN.ghost, padding: "2px 4px", fontSize: 12.5 }}>All fields →</button>}>Custom fields</H>
      <Card>
        {filled.length === 0 ? <div style={{ fontSize: 13, color: C.textMuted }}>Nothing saved yet. Automations fill these when people answer questions.</div>
          : filled.map(f => <Mini key={f.key} label={f.name} value={f.value} />)}
      </Card>

      {p.leads?.length > 0 && (
        <>
          <H>Leads captured</H>
          <Card>
            {p.leads.map(l => (
              <div key={l.id} style={{ fontSize: 13, padding: "6px 0", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
                <b style={{ color: C.text }}>{l.automation || "Automation"}</b> <span style={{ color: C.textMuted }}>· {relativeTime(l.created_at)}</span>
                <div style={{ color: C.textSecondary, marginTop: 2 }}>{Object.entries(l.data || {}).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>
              </div>
            ))}
          </Card>
        </>
      )}

      <H right={busy === "notes" && <Loader2 size={13} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} />}>Notes</H>
      <textarea value={notes} disabled={!isAdmin} onChange={e => setNotes(e.target.value)} onBlur={() => notes !== (c.notes || "") && saveNotes(notes)} rows={4}
        placeholder={isAdmin ? "Private notes for your team (saved when you click away)" : "No notes"} style={{ ...INPUT, background: C.raised, resize: "vertical", lineHeight: 1.45 }} />
    </>
  );
}

// Follow status: filled automatically a few minutes after someone messages you
// (contactsCrm follow sweep, re-checked weekly), or on demand with Check now.
function FollowCard({ c, sys, busy, onCheck }) {
  const v = c.followsYou ?? (sys.follows_you?.state === "on" ? true : sys.follows_you?.state === "off" ? false : null);
  const tone = v === true ? [C.blueSoft, C.blue] : v === false ? [C.surface2, C.textSecondary] : [C.raised, C.textMuted];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, background: tone[0], borderRadius: 14, padding: "12px 14px", marginBottom: 16, flexWrap: "wrap" }}>
      <BadgeCheck size={20} color={tone[1]} />
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontSize: 12, color: C.textMuted }}>Follow status</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: v == null ? C.textMuted : C.text, marginTop: 1 }}>
          {v === true ? "Follows your account" : v === false ? "Doesn't follow your account" : "Not checked yet"}
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
          {c.profileRefreshedAt ? `Checked ${relativeTime(c.profileRefreshedAt)} · re-checked weekly` : "Checked automatically a few minutes after they message you"}
          {sys.business_follows?.value === "Yes" ? " · you follow them" : ""}
        </div>
      </div>
      <button onClick={onCheck} disabled={busy} style={{ ...BTN.secondary, padding: "7px 12px", fontSize: 13 }}>
        {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={13} />} Check now
      </button>
    </div>
  );
}

function Fields({ p, crm, isAdmin, setField }) {
  const [pick, setPick] = useState("");
  const [val, setVal] = useState("");
  const defs = crm.fields.length ? crm.fields : p.custom.map(f => ({ key: f.key, name: f.name, type: f.type }));
  return (
    <>
      <H>Custom fields</H>
      <Card style={{ padding: "6px 14px" }}>
        {p.custom.length === 0 && <div style={{ fontSize: 13, color: C.textMuted, padding: "8px 0" }}>No custom fields yet. Create one below or in Settings → Fields.</div>}
        {p.custom.map(f => <FieldRow key={f.key} f={f} onSave={(v) => setField(f.key, v)} />)}
      </Card>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 22 }}>
        <SearchableSelect value={pick} options={fieldOptions(defs)} onChange={setPick} placeholder="Choose a field" minWidth={180}
          onCreate={isAdmin ? (n) => createField(n) : undefined} createLabel="Create field" />
        <input value={val} onChange={e => setVal(e.target.value)} placeholder="Value" style={{ ...INPUT, background: C.raised, flex: "1 1 160px", width: "auto" }} />
        <button disabled={!pick || !val.trim()} onClick={() => { setField(pick, val); setVal(""); }} style={BTN.primary}><Plus size={14} /> Set</button>
      </div>

      <H>System fields</H>
      <Card style={{ padding: "6px 14px" }}>
        {p.system.map(s => <Mini key={s.key} label={s.label} value={s.type === "date" ? (fmtDate(s.value) || "—") : (s.value || "—")} mono={s.key === "contact_id" || s.key === "ig_user_id"} />)}
      </Card>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: -6, lineHeight: 1.45 }}>
        Follows you, verified and follower count come from Instagram. Click “Refresh from Instagram”; it works once the person has messaged you.
        {p.contact.profileRefreshedAt ? ` Last refreshed ${relativeTime(p.contact.profileRefreshedAt)}.` : ""}
      </div>
    </>
  );
}

function FieldRow({ f, onSave }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(f.value ?? "");
  useEffect(() => setV(f.value ?? ""), [f.value]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", boxShadow: `inset 0 -1px 0 ${C.surface2}`, fontSize: 13.5 }}>
      <span style={{ width: 150, flexShrink: 0, color: C.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.key}>
        {f.name} <span style={{ fontSize: 10.5, color: C.textMuted, fontFamily: MONO }}>{f.type}</span>
      </span>
      {edit ? (
        <form onSubmit={e => { e.preventDefault(); onSave(v === "" ? null : v); setEdit(false); }} style={{ display: "flex", gap: 6, flex: 1 }}>
          <input autoFocus type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={v} onChange={e => setV(e.target.value)} style={{ ...INPUT, background: C.surface, padding: "6px 10px" }} />
          <button type="submit" style={{ ...BTN.icon, width: 30, height: 30 }} aria-label="Save"><Check size={14} /></button>
          <button type="button" onClick={() => setEdit(false)} style={{ ...BTN.icon, width: 30, height: 30 }} aria-label="Cancel"><X size={14} /></button>
        </form>
      ) : (
        <>
          <span onClick={() => setEdit(true)} title="Click to edit" style={{ flex: 1, minWidth: 0, color: f.value != null ? C.text : C.textMuted, fontWeight: f.value != null ? 600 : 400, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.value ?? "Empty"}
          </span>
          {f.value != null && <button onClick={() => onSave(null)} title="Clear" aria-label={`Clear ${f.name}`} style={{ ...BTN.icon, width: 26, height: 26, background: "transparent" }}><X size={13} /></button>}
        </>
      )}
    </div>
  );
}

function Activity({ rows }) {
  if (!rows.length) return <div style={{ fontSize: 13.5, color: C.textMuted, padding: "30px 0", textAlign: "center" }}>No automations have run for this contact yet.</div>;
  return (
    <div style={{ position: "relative" }}>
      {rows.map((r, i) => (
        <div key={r.id} style={{ display: "flex", gap: 12, paddingBottom: 14, position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {r.kind === "flow" ? <Workflow size={14} /> : r.trigger === "capture" ? <ClipboardList size={14} /> : <Zap size={14} />}
            </span>
            {i < rows.length - 1 && <span style={{ width: 2, flex: 1, background: C.surface2, marginTop: 4 }} />}
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 13.5, color: C.text }}>{r.automation}</b>
              <StatusPill status={flowStatus(r.status)} />
              <span style={{ fontSize: 12, color: C.textMuted, marginLeft: "auto" }} title={new Date(r.at).toLocaleString()}>{relativeTime(r.at)}</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 3 }}>
              {r.kind === "flow" ? "Flow" : "Quick automation"} · {String(r.trigger || "").replace(/_/g, " ")}{r.input ? ` · “${r.input}”` : ""}
            </div>
            {r.error && <div style={{ fontSize: 12, color: r.status === "failed" ? C.errText : C.textMuted, marginTop: 3 }}>{r.error}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
// Flow run statuses → the shared pill palette.
const flowStatus = (s) => ({ done: "sent", running: "pending", await_input: "pending", await_reply: "pending", delayed: "pending", stopped: "skipped", expired: "skipped" }[s] || s);
