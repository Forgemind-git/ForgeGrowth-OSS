import { useState } from "react";
import { X, MessageCircle, MessageSquare, MousePointerClick, Reply, AtSign, Link2 } from "lucide-react";
import { C, FONT, LABEL, INPUT, T } from "../../constants.js";
import { Toggle } from "../UI.jsx";

// Shared bits for the Automations tab (ManyChat-style IG rules).

export const TRIGGERS = [
  { id: "comment",       label: "Comment on a post", short: "Comment",       Icon: MessageCircle,      hint: "Someone comments a keyword on a post or reel." },
  { id: "dm",            label: "Keyword in a DM",   short: "DM keyword",    Icon: MessageSquare,      hint: "Someone sends you a DM containing a keyword." },
  { id: "postback",      label: "Button tap",        short: "Button tap",    Icon: MousePointerClick,  hint: "Someone taps a button or quick reply from another automation." },
  { id: "story_reply",   label: "Story reply",       short: "Story reply",   Icon: Reply,              hint: "Someone replies to one of your stories." },
  { id: "story_mention", label: "Story mention",     short: "Story mention", Icon: AtSign,             hint: "Someone mentions you in their story." },
];
export const triggerMeta = (id) => TRIGGERS.find(t => t.id === id) || TRIGGERS[0];

export const FIELD_TYPES = [
  { value: "name",  label: "Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "text",  label: "Free text" },
];

export const STATUS_STYLE = {
  sent:    { bg: C.greenSoft, color: C.green,     label: "Sent" },
  partial: { bg: C.amberSoft, color: C.amber,     label: "Partly sent" },
  failed:  { bg: C.errBg,     color: C.errText,   label: "Failed" },
  skipped: { bg: C.surface2,  color: C.textMuted, label: "Skipped" },
  pending: { bg: C.blueSoft,  color: C.blue,      label: "Sending" },
};

export function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.pending;
  return <span style={{ display: "inline-flex", padding: "3px 9px", borderRadius: 999, background: s.bg, color: s.color, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>{s.label}</span>;
}

export function Field({ label, hint, style, children }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <label style={LABEL}>{label}</label>}
      {children}
      {hint && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 5, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

export function Section({ Icon, title, hint, right, children }) {
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 18, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: children ? 14 : 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: 0 }}>
          {Icon && <span style={{ width: 30, height: 30, borderRadius: 10, background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={15} strokeWidth={2.2} /></span>}
          <div style={{ minWidth: 0 }}>
            <div style={{ ...T.h3, color: C.text }}>{title}</div>
            {hint && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

export function SettingRow({ title, hint, on, onChange, disabled }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 0" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      <Toggle on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// Type-and-Enter chips (keywords, payloads).
export function ChipsInput({ values = [], onChange, placeholder = "Type and press Enter", disabled, upper = false }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(",").map(s => (upper ? s.trim().toUpperCase() : s.trim())).filter(Boolean);
    if (!parts.length) return;
    onChange([...new Set([...values, ...parts])]);
    setDraft("");
  };
  return (
    <div style={{ ...INPUT, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "7px 8px", opacity: disabled ? .6 : 1 }}>
      {values.map(v => (
        <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 6px 4px 10px", borderRadius: 999, background: C.primarySoft, color: C.primary, fontSize: 13, fontWeight: 650 }}>
          {v}
          {!disabled && <button type="button" onClick={() => onChange(values.filter(x => x !== v))} aria-label={`Remove ${v}`}
            style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 2, display: "inline-flex" }}><X size={13} /></button>}
        </span>
      ))}
      <input value={draft} disabled={disabled} placeholder={values.length ? "" : placeholder}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1)); }}
        onBlur={add}
        style={{ border: "none", outline: "none", background: "transparent", color: C.text, fontFamily: FONT, fontSize: 14, flex: "1 1 120px", minWidth: 100, padding: "4px 2px" }} />
    </div>
  );
}

// ── DM message model ↔ Graph "message" object ───────────────
// UI model: { kind: text|buttons|card|quick, text, buttons[], card{}, quick[] }
export const DM_KINDS = [
  { id: "text",    label: "Text" },
  { id: "buttons", label: "Text + link" },
  { id: "card",    label: "Card" },
  { id: "quick",   label: "Quick replies" },
];

export const emptyDm = () => ({ kind: "text", text: "", buttons: [], card: { title: "", subtitle: "", image_url: "", url: "" }, quick: [] });

const toButton = (b) => b.type === "web_url"
  ? { type: "web_url", url: b.url, title: b.title }
  : { type: "postback", title: b.title, payload: b.payload };

export function dmToGraph(dm) {
  if (!dm) return null;
  const btns = (dm.buttons || []).filter(b => b.title && (b.type === "web_url" ? b.url : b.payload)).map(toButton);
  if (dm.kind === "buttons") {
    if (!dm.text?.trim()) return null;
    return btns.length
      ? { attachment: { type: "template", payload: { template_type: "button", text: dm.text.trim(), buttons: btns } } }
      : { text: dm.text.trim() };
  }
  if (dm.kind === "card") {
    const c = dm.card || {};
    if (!c.title?.trim()) return null;
    const el = { title: c.title.trim() };
    if (c.subtitle?.trim()) el.subtitle = c.subtitle.trim();
    if (c.image_url?.trim()) el.image_url = c.image_url.trim();
    if (c.url?.trim()) el.default_action = { type: "web_url", url: c.url.trim() };
    if (btns.length) el.buttons = btns;
    return { attachment: { type: "template", payload: { template_type: "generic", elements: [el] } } };
  }
  if (dm.kind === "quick") {
    if (!dm.text?.trim()) return null;
    const q = (dm.quick || []).filter(x => x.title && x.payload).map(x => ({ content_type: "text", title: x.title, payload: x.payload }));
    return q.length ? { text: dm.text.trim(), quick_replies: q } : { text: dm.text.trim() };
  }
  return dm.text?.trim() ? { text: dm.text.trim() } : null;
}

const fromButton = (b) => b.type === "web_url"
  ? { type: "web_url", title: b.title || "", url: b.url || "", payload: "" }
  : { type: "postback", title: b.title || "", url: "", payload: b.payload || "" };

export function dmFromGraph(m) {
  const dm = emptyDm();
  if (!m) return dm;
  const p = m.attachment?.payload;
  if (p?.template_type === "button") return { ...dm, kind: "buttons", text: p.text || "", buttons: (p.buttons || []).map(fromButton) };
  if (p?.template_type === "generic") {
    const e = p.elements?.[0] || {};
    return { ...dm, kind: "card", buttons: (e.buttons || []).map(fromButton),
      card: { title: e.title || "", subtitle: e.subtitle || "", image_url: e.image_url || "", url: e.default_action?.url || "" } };
  }
  if (Array.isArray(m.quick_replies) && m.quick_replies.length)
    return { ...dm, kind: "quick", text: m.text || "", quick: m.quick_replies.map(q => ({ title: q.title || "", payload: q.payload || "" })) };
  return { ...dm, text: m.text || "" };
}

// One-line summary of a stored Graph message (rule list).
export function dmSummary(m) {
  if (!m) return null;
  const p = m.attachment?.payload;
  if (p?.template_type === "button") return `Buttons: ${p.text}`;
  if (p?.template_type === "generic") return `Card: ${p.elements?.[0]?.title || ""}`;
  if (m.quick_replies?.length) return `Quick replies: ${m.text}`;
  return m.text || null;
}

// ── Template (the one quick start) ──────────────────────────
// `seed` is merged over a blank rule in RuleEditor (Graph-format fields).
export const TEMPLATES = [
  {
    id: "comment_link", featured: true, Icon: Link2,
    title: "Auto-DM links from comments",
    body: "Reply under the comment and DM a link to everyone who comments a keyword.",
    seed: {
      name: "Auto-DM links from comments", trigger: "comment",
      reply_texts: ["Thanks! Please see DMs.", "Sent you a message! Check it out!", "Nice! Check your DMs!"],
      dm_message: { attachment: { type: "template", payload: { template_type: "button", text: "Hey! Thanks for your interest. Here's the link you asked for:", buttons: [{ type: "web_url", title: "Open link", url: "" }] } } },
    },
  },
];

// Comment trigger is the only one with a public post / comments view.
export const hasPostView = (trigger) => trigger === "comment";

// The conversation the preview phone shows, built from Graph-format rule fields.
export const GATE_DEFAULTS = {
  gate_text: "Thanks for your comment! Tap below and I will send it right over.",
  gate_button: "Send it",
  follow_gate_text: "Almost there! Please follow @{account} first, then tap the button below.",
  collect_done_text: "Thank you! We have your details and will get back to you shortly.",
  followup_text: "Just checking in, did you get a chance to look? Here it is again in case you missed it.",
};
// Follow-up delays (minutes). Capped below Meta's 24 h messaging window.
export const FOLLOWUP_DELAYS = [
  { value: 30, label: "30 minutes" }, { value: 60, label: "1 hour" }, { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" }, { value: 480, label: "8 hours" }, { value: 720, label: "12 hours" },
  { value: 1380, label: "23 hours" },
];
export const delayLabel = (m) => FOLLOWUP_DELAYS.find(d => d.value === Number(m))?.label || (m >= 60 ? `${Math.round(m / 60)} hours` : `${m} minutes`);

// The follow-up as it will be sent (mirrors commentAutomation.followupMessage).
export function followupPreview(r) {
  const text = (r.followup_text || GATE_DEFAULTS.followup_text).trim();
  const p = r.dm_message?.attachment?.payload;
  const links = [...(p?.buttons || []), ...((p?.elements || []).flatMap(e => e.buttons || []))].filter(b => b.type === "web_url").slice(0, 3);
  return r.followup_link !== false && links.length
    ? { attachment: { type: "template", payload: { template_type: "button", text, buttons: links } } }
    : { text };
}

export function buildDmSteps(r, account) {
  const s = [];
  const kw = r.keywords?.[0] || "";
  const collect = Array.isArray(r.collect) ? r.collect : [];
  const gated = r.trigger === "comment" && (r.follow_gate || r.opening_dm || collect.length > 0 || r.followup_enabled);
  if (r.trigger === "dm") s.push({ from: "them", text: kw || "Hi!" });
  else if (r.trigger === "postback") s.push({ from: "them", text: `Taps “${kw || "a button"}”` });
  else if (r.trigger === "story_reply") s.push({ note: "Replied to your story" }, { from: "them", text: kw || "Love this!" });
  else if (r.trigger === "story_mention") s.push({ note: "Mentioned you in their story" });
  if (gated) {
    const btn = r.gate_button || GATE_DEFAULTS.gate_button;
    s.push({ message: { attachment: { type: "template", payload: { template_type: "button", text: r.gate_text || GATE_DEFAULTS.gate_text, buttons: [{ type: "postback", title: btn }] } } } });
    s.push({ from: "them", text: btn });
    if (r.follow_gate) s.push({ note: `Not following @${account || "you"} yet? They're asked to follow and tap again.` });
  }
  if (r.follow_gate && r.trigger !== "comment") s.push({ note: `Not following @${account || "you"} yet? They're asked to follow first, with an “I've followed” button.` });
  if (r.dm_message) s.push({ message: r.dm_message });
  collect.forEach((q, i) => {
    s.push({ message: { text: q.prompt || "…" } });
    s.push({ from: "them", text: q.type === "email" ? "name@example.com" : q.type === "phone" ? "+91 98765 43210" : q.type === "name" ? "Priya" : "…" });
    if (i === collect.length - 1) s.push({ message: { text: r.collect_done_text || GATE_DEFAULTS.collect_done_text } });
  });
  if (r.followup_enabled && r.dm_message && !collect.length) {
    s.push({ note: `${delayLabel(r.followup_delay_min)} later, if they haven't tapped or replied` });
    s.push({ message: followupPreview(r) });
  }
  return s;
}
