import { useState, useEffect, useRef } from "react";
import { Camera, Film, Mic, Link2, Paperclip, Play, Search, X, MessageSquare, CornerDownRight, ExternalLink, Send, Trash2, ChevronDown, ChevronUp, Clock, Pencil, Reply as ReplyIcon, CheckCheck } from "lucide-react";
import { api } from '../api.js';
import { useApi } from '../hooks/useApi.js';
import { relativeTime, C, FONT, T, BTN } from '../constants.js';
import { PageHeader, Badge, Card, UnderlineTabs, EmptyState as UIEmptyState } from '../components/UI.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { SearchableSelect } from '../components/Dropdown.jsx';
import TagPicker, { useTagsAndCategories } from '../components/TagPicker.jsx';
import ContactModal from '../components/ContactModal.jsx';
import { useScope } from '../components/scope/scopeStore.js';
import { InboxToolsProvider, CannedReplyButton, SaveReplyButton, AssignControl, slaLabel } from '../components/InboxTools.jsx';

const IG = { color: "#C13584", bg: C.pinkSoft, textOnBg: C.pink };
// Outgoing bubble = the accent; attachments that sit beside an outgoing bubble use the soft tint.
const OUT_BG = C.primary, OUT_TEXT = C.onAccent;
const OUT_SOFT_BG = C.primarySoft, OUT_SOFT_TEXT = C.primary;

// Local helpers — every control here is fill-only (no outline); state is a tint.
const CHIP = (active, accent = C.primary) => ({
  fontSize: 12.5, fontFamily: FONT, fontWeight: 650, padding: "6px 13px", borderRadius: 999, cursor: "pointer", border: "none",
  background: active ? accent : C.surface, color: active ? C.onAccent : C.textSecondary, whiteSpace: "nowrap", transition: "background .14s, color .14s",
});
const COUNT_CHIP = (on) => ({ fontSize: 11.5, fontWeight: 700, fontFamily: FONT, padding: "1px 7px", borderRadius: 999, background: on ? C.primary : C.surface2, color: on ? C.onAccent : C.textSecondary, lineHeight: 1.5 });
// A composed field: the WRAPPER carries the fill + radius; the input inside is bare.
const FIELD_WRAP = { display: "flex", alignItems: "center", gap: 8, background: C.surface, borderRadius: 12, padding: "8px 12px", minWidth: 0 };
const BARE_INPUT = { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", borderRadius: 0, padding: 0, fontSize: 13.5, fontFamily: FONT, color: C.text };
// List rows: no fill of their own; hover = surface, selected = the faint tint.
const ROW_BG = (active) => active ? C.primaryFaint : "transparent";

const shortId = (id) => (!id ? "—" : id.length > 10 ? id.slice(0, 6) + "…" + id.slice(-4) : id);
const initials = (s) => {
  if (!s) return "?";
  const p = s.replace(/^@/, "").trim().split(/\s+/);
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?";
};

// Deterministic [bg, text] avatar color from a stable seed (peer id / username).
// Instagram only exposes a DM peer's real photo inside the 24h window after THEY
// message — most peers (comment→auto-DM recipients) have no fetchable pic, so a
// distinct generated color per person keeps the inbox readable, like Gmail/Slack.
const AVATAR_PALETTE = [
  ["var(--fc-pink-soft)", "var(--fc-pink)"], ["var(--fc-blue-soft)", "var(--fc-blue)"], ["var(--fc-green-soft)", "var(--fc-green)"],
  ["var(--fc-amber-soft)", "var(--fc-amber)"], ["var(--fc-purple-soft)", "var(--fc-purple)"], ["var(--fc-err-bg)", "var(--fc-err-text)"],
  ["var(--fc-blue-soft)", "var(--fc-blue)"], ["var(--fc-amber-soft)", "var(--fc-amber)"], ["var(--fc-blue-soft)", "var(--fc-blue)"],
  ["var(--fc-purple-soft)", "var(--fc-purple)"],
];
function avatarColor(seed) {
  const s = String(seed || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
const accountLabel = (id, accounts) => {
  const a = accounts.find(x => x.accountId === id);
  return a ? (a.name || (a.username ? "@" + a.username : shortId(id))) : shortId(id);
};
// Display name for a DM peer — resolved name/username (no "@"), else a clean
// fallback (Instagram blocks profile access for users who never messaged the account).
const peerLabel = (c) =>
  c.peerName || c.peerUsername || (c.peerId ? "Instagram user · " + String(c.peerId).slice(-4) : "Instagram user");

function Avatar({ pic, label, size = 44, seed, ring = false }) {
  const [err, setErr] = useState(false);
  const [bg, color] = avatarColor(seed != null ? seed : label);
  const inner = (pic && !err)
    ? <img src={pic} alt="" onError={() => setErr(true)}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block" }} />
    : <div style={{ width: size, height: size, borderRadius: "50%", background: bg, color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(11.5, size * 0.36), fontWeight: 700, fontFamily: FONT }}>
        {initials(label)}
      </div>;
  if (!ring) return <div style={{ flexShrink: 0 }}>{inner}</div>;
  // Instagram story-style gradient ring (decorative — every IG-DM avatar gets it).
  // A 50% brand-colour avatar ring is the one outline the system allows.
  return (
    <div style={{ flexShrink: 0, padding: 2.5, borderRadius: "50%", background: "linear-gradient(135deg,#F58529 0%,#DD2A7B 55%,var(--fc-purple) 100%)" }}>
      <div style={{ padding: 2, borderRadius: "50%", background: C.card }}>{inner}</div>
    </div>
  );
}

function AccountTag({ id, accounts }) {
  if (!id) return null;
  return <Badge label={accountLabel(id, accounts)} bg="var(--fc-blue-soft)" color="var(--fc-blue)" />;
}

// ── Attachment rendering (Instagram-style) ───────────────────
const openUrl = (url) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };

// Short label for the conversation-list preview
// Backfilled DMs may still carry the Conversations-API shape ({ data: [...] })
// until the backend's one-time normalise runs; read both.
function normAtts(atts) {
  if (Array.isArray(atts)) return atts;
  return (atts?.data || []).map(a =>
    a.image_data?.url ? { type: "image", payload: { url: a.image_data.url } }
    : a.video_data?.url ? { type: "video", payload: { url: a.video_data.url } }
    : a.generic_template ? { type: "template", payload: { generic: { elements: [{ title: a.generic_template.title, subtitle: a.generic_template.subtitle, image_url: a.generic_template.media_url, buttons: a.generic_template.cta || [] }] } } }
    : null).filter(Boolean);
}

function attPreview(atts) {
  const a = normAtts(atts)[0];
  if (!a) return "";
  switch (a.type) {
    case "image":         return "Photo";
    case "video":         return "Video";
    case "audio":         return "Voice message";
    case "ig_reel":       return "Reel";
    case "ig_post":       return "Post";
    case "share": case "story_mention": case "story_reply": return "Shared";
    case "template":      return (a.payload?.generic?.elements?.[0]?.title?.slice(0, 30) || "Shared message");
    default:              return "Attachment";
  }
}

function AttachChip({ icon, label, url, out }) {
  return (
    <div onClick={() => openUrl(url)} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 12, background: out ? OUT_SOFT_BG : C.surface2, color: out ? OUT_SOFT_TEXT : C.textSecondary, border: "none", fontSize: 12.5, fontWeight: 600, cursor: url ? "pointer" : "default", maxWidth: 240 }}>
      <span style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
}

function AttachImage({ url, out }) {
  const [err, setErr] = useState(false);
  // Reset on url change: incoming attachments start as a CDN URL and flip to a
  // localized /api/uploads/ path once downloaded. Without this, a failed first
  // load would stay "unavailable" until a full page refresh (live polls reuse
  // this same instance and keep the stale err state).
  useEffect(() => { setErr(false); }, [url]);
  if (!url || err) return <AttachChip icon={<Camera size={15} />} label="Photo unavailable" out={out} />;
  return <img src={url} alt="attachment" onError={() => setErr(true)} onClick={() => openUrl(url)}
    style={{ maxWidth: 240, maxHeight: 280, borderRadius: 16, objectFit: "cover", cursor: "pointer", display: "block", background: C.surface2 }} />;
}

function AttachVideo({ url, out }) {
  const [err, setErr] = useState(false);
  useEffect(() => { setErr(false); }, [url]);
  if (!url || err) return <AttachChip icon={<Film size={15} />} label="Video unavailable" out={out} />;
  return <video src={url} controls onError={() => setErr(true)}
    style={{ maxWidth: 240, maxHeight: 300, borderRadius: 16, display: "block", background: C.plate }} />;
}

// Shared reel / post / story — IG-style media card with a play badge
// instagram.com/reel/<code>/ or /p/<code>/ → Instagram's official embed page.
function igEmbedUrl(url) {
  const m = /instagram\.com\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/i.exec(url || "");
  return m ? `https://www.instagram.com/${m[1].startsWith("reel") ? "reel" : m[1]}/${m[2]}/embed/` : null;
}

// A shared reel / post / story, shown the way Instagram shows it: the real
// embedded reel (playable) when we have its permalink, else the post image,
// else a branded placeholder card.
function ShareCard({ url, title, kind }) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [url]);
  const label = kind === "ig_reel" ? "Reel" : (kind === "story_mention" || kind === "story_reply" || kind === "ig_story") ? "Story" : "Post";
  const embed = igEmbedUrl(url);
  const isImage = !embed && url && !imgFailed && /lookaside|fbcdn|cdninstagram|\/api\/uploads\//i.test(url);
  const footer = (
    <div style={{ padding: "8px 11px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ ...T.label, color: C.pink }}>{label} · Instagram</span>
        {(embed || url) && <span onClick={() => openUrl(url)} style={{ fontSize: 12, fontWeight: 650, color: C.blue, cursor: "pointer" }}>Open</span>}
      </div>
      {title && <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.4, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-line" }}>{title}</div>}
    </div>
  );
  if (embed) {
    return (
      <div style={{ width: 270, borderRadius: 16, overflow: "hidden", background: C.surface2 }}>
        <div style={{ height: kind === "ig_reel" ? 540 : 470, overflow: "hidden", background: "#fff" }}>
          <iframe src={embed} title={`Instagram ${label.toLowerCase()}`} loading="lazy" scrolling="no" allowFullScreen
            allow="autoplay; encrypted-media; picture-in-picture; clipboard-write"
            style={{ width: "100%", height: kind === "ig_reel" ? 620 : 560, border: 0, display: "block" }} />
        </div>
        {footer}
      </div>
    );
  }
  if (isImage) {
    return (
      <div onClick={() => openUrl(url)} style={{ width: 244, borderRadius: 16, overflow: "hidden", background: C.surface2, cursor: "pointer" }}>
        <img src={url} alt="" loading="lazy" onError={() => setImgFailed(true)} style={{ width: "100%", maxHeight: 320, objectFit: "cover", display: "block" }} />
        {footer}
      </div>
    );
  }
  return (
    <div onClick={() => openUrl(url)} style={{ width: 244, borderRadius: 16, overflow: "hidden", background: C.surface2, cursor: url ? "pointer" : "default" }}>
      <div style={{ height: 124, background: "linear-gradient(135deg,#F58529,#DD2A7B,var(--fc-purple))", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 46, height: 46, borderRadius: "50%", background: "rgba(255,255,255,.92)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Play size={20} color={IG.color} fill={IG.color} />
        </div>
      </div>
      {footer}
    </div>
  );
}

// Generic template element (ManyChat-style card with optional image + buttons)
function TemplateCard({ el }) {
  const url = el.default_action?.url || el.buttons?.find(b => b.url)?.url;
  return (
    <div onClick={() => openUrl(url)} style={{ width: 244, borderRadius: 16, overflow: "hidden", background: C.surface2, cursor: url ? "pointer" : "default" }}>
      {el.image_url && <img src={el.image_url} alt="" onError={e => { e.currentTarget.style.display = "none"; }} style={{ width: "100%", height: 132, objectFit: "cover", display: "block" }} />}
      <div style={{ padding: "9px 11px" }}>
        {el.title && <div style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{el.title}</div>}
        {el.subtitle && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 3, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{el.subtitle}</div>}
        {el.buttons?.filter(b => b.title).length > 0 && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
            {el.buttons.filter(b => b.title).map((b, i) => (
              <div key={i} onClick={e => { e.stopPropagation(); openUrl(b.url); }} style={{ textAlign: "center", padding: "6px 10px", borderRadius: 999, background: C.primarySoft, color: C.primary, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{b.title}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Attachment({ att, out }) {
  const type = att?.type;
  const p = att?.payload || {};
  if (type === "image") return <AttachImage url={p.url} out={out} />;
  if (type === "video") return <AttachVideo url={p.url} out={out} />;
  if (type === "audio") return p.url ? <audio src={p.url} controls style={{ maxWidth: 240, height: 40 }} /> : <AttachChip icon={<Mic size={15} />} label="Voice message" out={out} />;
  if (type === "ig_reel" || type === "ig_post" || type === "ig_story" || type === "share" || type === "story_mention" || type === "story_reply")
    return <ShareCard url={p.url} title={p.title} kind={type} />;
  if (type === "template") {
    const els = p.generic?.elements || [];
    if (!els.length) return <AttachChip icon={<Link2 size={15} />} label="Shared message" out={out} />;
    return <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{els.map((el, i) => <TemplateCard key={i} el={el} />)}</div>;
  }
  if (type === "file") return <AttachChip icon={<Paperclip size={15} />} label={p.title || "File"} url={p.url} out={out} />;
  return <AttachChip icon={<Paperclip size={15} />} label={type ? type.replace(/_/g, " ") : "Attachment"} url={p.url} out={out} />;
}

// ── Conversation list (left pane) ────────────────────────────
// IG-DM status line, driven entirely by data we already have:
//   outgoing + seen   → "Seen [time]"
//   outgoing + unseen → "Sent [time]"
//   incoming, 1 unread→ "[preview] · [time]"  (bold)
//   incoming, n>1     → "[n] new messages · [time]"  (bold)
//   incoming, read    → "[preview] · [time]"  (muted)
function convStatus(c) {
  const m = c.last;
  const t = relativeTime(m.ts || m.createdAt);
  const unread = c.unread || 0;
  if (m.direction === "outgoing") {
    if (m.seen) return { text: "Seen", time: m.seenAt ? relativeTime(m.seenAt) : t, strong: false };
    return { text: "Sent", time: t, strong: false };
  }
  if (unread > 1) return { text: `${unread} new messages`, time: t, strong: true };
  const preview = m.text || attPreview(m.attachments) || "Sent you a message";
  return { text: preview, time: t, strong: unread > 0 };
}

// Unread count — the small green pill from the reference list rows.
const UnreadPill = ({ n }) => n > 0 ? (
  <span title={`${n} unread`} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, fontFamily: FONT, padding: "2px 7px", borderRadius: 999, background: C.green, color: "#fff", minWidth: 18, textAlign: "center", lineHeight: 1.5 }}>
    {n > 99 ? "99+" : n}
  </span>
) : null;

function ConversationList({ conversations, activeKey, onSelect, accounts, showAccount }) {
  if (conversations.length === 0) {
    return <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>No conversations yet.</div>;
  }
  return conversations.map(c => {
    const active = c.key === activeKey;
    const name = peerLabel(c);
    const unread = c.unread || 0;
    const status = convStatus(c);
    return (
      <button key={c.key} onClick={() => onSelect(c.key)}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.surface; }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "none", borderRadius: 14, cursor: "pointer", background: ROW_BG(active), fontFamily: FONT, textAlign: "left", transition: "background .14s" }}>
        <Avatar pic={c.peerPic} label={name} seed={c.peerId || c.peerUsername || name} size={44} ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span style={{ ...T.h3, fontWeight: unread ? 780 : 650, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{name}</span>
            <span style={{ fontSize: 12.5, fontWeight: 650, color: C.primary, whiteSpace: "nowrap", flexShrink: 0 }}>{status.time}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginTop: 2 }}>
            <span style={{ ...T.small, color: status.strong ? C.text : C.textMuted, fontWeight: status.strong ? 650 : 450, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
              {status.text}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              {showAccount && <AccountTag id={c.accountId} accounts={accounts} />}
              <UnreadPill n={unread} />
            </span>
          </div>
        </div>
      </button>
    );
  });
}

// ── Message thread + composer (right pane) ───────────────────
// New in this iteration:
//   - In-conversation search (toggleable search bar in header, filters bubbles)
//   - Reply-to-message (per-message Reply action; quoted preview in composer
//     + sent as a normal message prefixed with `> {quote}\n` since IG Direct's
//     Graph API doesn't support real threaded replies, only Messenger Platform
//     does — the quote convention works on both client + IG app side)
//   - Edit-contact button in header → opens the shared ContactModal
//   - "Reactions" — IG Graph API doesn't support SENDING reactions for Direct
//     (Messenger Platform-only). Receiving reactions arrives via webhook
//     `message.reaction` and is displayed inline on the parent message bubble.
function ChatThread({ conv, accounts, onSent, allTags, categories, isAdmin, refreshContacts, openContactModal }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [contact, setContact] = useState(null);
  // In-conversation search
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatQuery, setChatQuery]   = useState("");
  // Reply-to-message: holds the message being replied to (null = no reply)
  const [replyTo, setReplyTo] = useState(null);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);

  useEffect(() => { setText(""); setErr(null); setReplyTo(null); setSearchOpen(false); setChatQuery(""); }, [conv?.key]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conv?.key, conv?.thread.length]);
  useEffect(() => {
    if (!conv) { setContact(null); return; }
    let cancelled = false;
    api.getContacts({ account: conv.accountId, peer: conv.peerId, limit: 1 })
      .then(r => { if (!cancelled) setContact(r.contacts?.[0] || null); })
      .catch(() => { if (!cancelled) setContact(null); });
    return () => { cancelled = true; };
  }, [conv?.accountId, conv?.peerId]);

  if (!conv) {
    return (
      <div style={{ ...THREAD_PANE, alignItems: "center", justifyContent: "center", color: C.textMuted, gap: 10 }}>
        <span style={{ width: 40, height: 40, borderRadius: 12, background: C.primarySoft, color: C.primary, display: "flex", alignItems: "center", justifyContent: "center" }}><MessageSquare size={19} strokeWidth={2.2} /></span>
        <div style={{ ...T.small, fontWeight: 600 }}>Select a conversation</div>
      </div>
    );
  }

  const name = peerLabel(conv);
  let lastOutgoingId = null;
  for (const m of conv.thread) if (m.direction === "outgoing") lastOutgoingId = m.id;

  // Quote a snippet of the message being replied to. IG Direct has no threaded
  // reply API, so we prepend the convention used by most chat clients: `> snippet\n\nreply`.
  // Reads naturally for the recipient and gives our UI something to scope to.
  const buildQuotedText = (replyMsg, body) => {
    if (!replyMsg) return body;
    const snippet = (replyMsg.text || "(attachment)").replace(/\s+/g, " ").slice(0, 180);
    const who = replyMsg.direction === "outgoing" ? "You" : (peerLabel(conv) || "Them");
    return `> ${who}: ${snippet}\n\n${body}`;
  };
  const send = async () => {
    if (!text.trim()) return;
    setSending(true); setErr(null);
    try {
      await api.replyInstagram({ accountId: conv.accountId, recipientId: conv.peerId, text: buildQuotedText(replyTo, text.trim()) });
      setText(""); setReplyTo(null); onSent?.();
    } catch (e) { setErr(e.message); } finally { setSending(false); }
  };
  const saveContactTags = async (next) => {
    if (!contact) return;
    const r = await api.setContactTags(contact.id, next);
    setContact(c => c ? { ...c, tags: r.tags || next } : c);
  };

  // In-conversation search: filter to messages whose text matches.
  const q = chatQuery.trim().toLowerCase();
  const visibleThread = q
    ? conv.thread.filter(m => (m.text || "").toLowerCase().includes(q))
    : conv.thread;

  return (
    <div style={THREAD_PANE}>
      {/* Conversation header — same 80px box-height as Accounts/Chats panes.
          Top row: avatar + name + via + action icons (Search, Edit contact).
          Bottom row: tag picker OR (when search is open) the search input.   */}
      <div style={{ ...PANE_HEADER_STYLE, height: "auto", padding: "12px 14px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <Avatar pic={conv.peerPic} label={name} seed={conv.peerId || conv.peerUsername || name} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...T.h3, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {conv.peerName && conv.peerUsername ? conv.peerUsername + " · " : ""}via {accountLabel(conv.accountId, accounts)}
            </div>
          </div>
          <button onClick={() => { setSearchOpen(o => !o); setChatQuery(""); }}
            title={searchOpen ? "Close search" : "Search in conversation"}
            style={{ ...BTN.icon, background: searchOpen ? C.primarySoft : C.surface, color: searchOpen ? C.primary : C.textSecondary }}>
            <Search size={16} />
          </button>
          {contact && (
            <button onClick={() => openContactModal?.(contact)} title="Edit contact" style={BTN.icon}>
              <Pencil size={16} />
            </button>
          )}
        </div>
        {/* Second row: tag picker (or the in-conversation search) on the left,
            assign / resolve / note pills on the right. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34 }}>
          <div style={{ flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
            {searchOpen ? (
              <div className="fc-searchfield" style={{ ...FIELD_WRAP, padding: "6px 12px" }}>
                <Search size={13} color={C.textMuted} />
                <input value={chatQuery} onChange={e => setChatQuery(e.target.value)} autoFocus
                  placeholder="Search messages in this conversation…"
                  style={{ ...BARE_INPUT, fontSize: 13 }} />
                {q && <span style={{ fontSize: 12, color: C.textMuted, fontFamily: "var(--fc-font-mono)" }}>{visibleThread.length}</span>}
                {chatQuery && (
                  <button onClick={() => setChatQuery("")} title="Clear" style={{ display: "flex", border: "none", background: "transparent", cursor: "pointer", padding: 0 }}>
                    <X size={13} color={C.textMuted} />
                  </button>
                )}
              </div>
            ) : (contact && allTags
              ? <TagPicker tagIds={contact.tags || []} allTags={allTags} categories={categories} onSave={saveContactTags} />
              : <div style={{ fontSize: 12.5, color: C.textMuted, fontFamily: FONT }}>{contact === null ? "Loading…" : "—"}</div>)}
          </div>
          {conv.peerId && <AssignControl itemType="conversation" itemId={`${conv.accountId}|${conv.peerId}`} platform="instagram" />}
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ marginTop: "auto" }} />
        {q && visibleThread.length === 0 && (
          <div style={{ textAlign: "center", color: C.textMuted, fontSize: 14, padding: "20px 0" }}>No messages match "{chatQuery}".</div>
        )}
        {visibleThread.map(m => {
          const out = m.direction === "outgoing";
          const showSeen = out && m.id === lastOutgoingId && m.seen && !q;
          const atts = normAtts(m.attachments);
          const hasText = !!(m.text && m.text.trim());
          const ts = relativeTime(m.ts || m.createdAt);
          return (
            <div key={m.id}
              className="ig-msg-row"
              style={{ display: "flex", flexDirection: out ? "row-reverse" : "row", alignItems: "flex-end", alignSelf: out ? "flex-end" : "flex-start", maxWidth: "82%", gap: 6 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start", gap: 4, minWidth: 0 }}>
                {atts.map((a, i) => <Attachment key={i} att={a} out={out} />)}
                {(hasText || atts.length === 0) && (
                  <div style={{ maxWidth: "100%", padding: "9px 12px", borderRadius: out ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: out ? OUT_BG : C.surface2, color: out ? OUT_TEXT : C.text, fontSize: 14, lineHeight: 1.45, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                    {hasText ? m.text : <span style={{ fontStyle: "italic", opacity: .75 }}>Message not supported here</span>}
                    <div style={{ fontSize: 11.5, color: out ? OUT_TEXT : C.textMuted, opacity: out ? .78 : 1, marginTop: 3, textAlign: "right", fontFamily: "var(--fc-font-mono)" }}>{ts}</div>
                  </div>
                )}
                {!hasText && atts.length > 0 && (
                  <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: "var(--fc-font-mono)", marginRight: 2 }}>{ts}</div>
                )}
                {showSeen && (
                  <div style={{ fontSize: 12, color: C.primary, marginRight: 2, fontFamily: FONT, fontWeight: 650 }}>
                    ✓✓ Seen{m.seenAt ? " · " + relativeTime(m.seenAt) : ""}
                  </div>
                )}
              </div>
              {/* Hover-only Reply action (appears on the side of each bubble).
                  Adds the message to replyTo state; composer shows a quoted
                  preview that the user can dismiss. */}
              <button className="ig-msg-action" onClick={() => { setReplyTo(m); composerRef.current?.focus(); }}
                title="Reply to this message"
                style={{ ...BTN.icon, width: 28, height: 28, background: C.surface2, color: C.textSecondary, alignSelf: "center", opacity: 0, transition: "opacity .12s" }}>
                <ReplyIcon size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* composer — a composed field: the wrapper carries the fill, the input is bare */}
      <div style={{ padding: "8px 14px 12px", flexShrink: 0 }}>
        {err && <div style={{ fontSize: 12.5, color: C.errText, marginBottom: 6 }}>{err}</div>}
        {replyTo && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "6px 6px 6px 12px", borderRadius: 12, background: C.primarySoft }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...T.label, color: C.primary, marginBottom: 2 }}>
                Replying to {replyTo.direction === "outgoing" ? "yourself" : (peerLabel(conv) || "them")}
              </div>
              <div style={{ fontSize: 13, color: C.textSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {replyTo.text || "(attachment)"}
              </div>
            </div>
            <button onClick={() => setReplyTo(null)} title="Cancel reply" style={{ ...BTN.icon, width: 28, height: 28, background: "transparent", color: C.primary }}>
              <X size={14} />
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <CannedReplyButton onInsert={(b) => setText(t => t ? t + " " + b : b)} peerName={peerLabel(conv)} />
          <div className="fc-searchfield" style={{ ...FIELD_WRAP, flex: 1, padding: "0 14px", height: 40 }}>
            <input ref={composerRef} value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !sending) send(); if (e.key === "Escape" && replyTo) setReplyTo(null); }}
              placeholder={replyTo ? "Type your reply…" : "Type a reply…"}
              style={{ ...BARE_INPUT, fontSize: 14 }} />
          </div>
          <button onClick={send} disabled={sending || !text.trim()} title={sending ? "Sending…" : "Send"} aria-label="Send"
            style={{ ...BTN.icon, width: 40, height: 40, background: !text.trim() ? C.surface2 : C.primary, color: !text.trim() ? C.textMuted : C.onAccent, cursor: sending || !text.trim() ? "not-allowed" : "pointer", transition: "background .14s" }}>
            <Send size={16} strokeWidth={2.2} />
          </button>
        </div>
        <div style={{ marginTop: 4, paddingLeft: 42 }}><SaveReplyButton text={text} /></div>
      </div>
    </div>
  );
}

// The thread column is the one column that carries a fill: a raised card on the pane.
const THREAD_PANE = { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.raised, borderRadius: 16, overflow: "hidden" };

function AccountFilter({ accounts, value, onChange, inline }) {
  if (accounts.length < 1) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", ...(inline ? {} : { marginBottom: 16 }) }}>
      {!inline && <span style={{ ...T.label, color: C.textMuted, marginRight: 2 }}>Account</span>}
      <button onClick={() => onChange(null)} style={CHIP(!value)}>All accounts</button>
      {accounts.map(a => (
        <button key={a.accountId} onClick={() => onChange(a.accountId)} style={CHIP(value === a.accountId)}>
          {a.name || (a.username ? "@" + a.username : shortId(a.accountId))}
        </button>
      ))}
    </div>
  );
}

function InstagramInbox({ isAdmin, deepLink }) {
  const [tab, setTab] = useState("messages");
  const [account, setAccount] = useState(null);     // null = "All accounts" (Comments tab only; Messages auto-picks first)
  const [activeKey, setActiveKey] = useState(null);
  const [query, setQuery] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);   // chat-list filter (Messages tab)
  const [editingContact, setEditingContact] = useState(null); // chat-header Edit opens the shared ContactModal
  const [deepCommentMedia, setDeepCommentMedia] = useState(null); // post to auto-expand in Comments
  // Pending sessionStorage handoff from Contacts page "Go to chat" — applied
  // once accounts + conversations are loaded so the right account + activeKey are set.
  const [pendingOpenChat, setPendingOpenChat] = useState(() => {
    try {
      const raw = sessionStorage.getItem("forgesocial.openIgChat");
      if (raw) { sessionStorage.removeItem("forgesocial.openIgChat"); return JSON.parse(raw); }
    } catch (_) {}
    return null;
  });
  // Always fetch ALL accounts' data so per-account unread badges stay accurate
  // when an account is selected (was: filter at the API by ?account=, which made
  // other accounts' unread counts go stale). Client-side filter below handles
  // the selection. 500 = the endpoint's max limit; ample for typical IG inbox.
  // Poll every 12s so new DMs/comments appear live (IG DMs arrive via webhook
  // server-side; the UI still needs to re-read the DB). Silent refetch — no flicker.
  const { data, loading, error, refetch } = useApi(() => api.getInstagramInbox(500, null), [], { pollMs: 12000 });
  const [ConfirmDialog, confirm] = useConfirm();
  // Tags + categories — loaded once at the Inbox level and passed down to the
  // chat-header tag picker (per-conversation) and the per-conversation contact lookup.
  const { tags: allTags, categories } = useTagsAndCategories();

  // "My accounts" preset (top bar): Instagram accounts outside it are hidden here.
  const scope = useScope();
  const everyAccount = data?.accounts || [];
  const scopedIds = new Set(everyAccount.filter(a => scope.hasIg(a.accountId)).map(a => a.accountId));
  const useScoped = scope.active && scopedIds.size > 0;
  const accounts = useScoped ? everyAccount.filter(a => scopedIds.has(a.accountId)) : everyAccount;
  const allMessages = (data?.messages || []).filter(m => !useScoped || scopedIds.has(m.accountId));
  const allComments = (data?.comments || []).filter(c => !useScoped || scopedIds.has(c.accountId));
  // A selected account that left the preset falls back to the first preset account.
  useEffect(() => { if (useScoped && account && !scopedIds.has(account)) setAccount(accounts[0]?.accountId || null); }, [useScoped, account, [...scopedIds].join(",")]);

  // Per-account filter (client-side, always against the unfiltered set so badges
  // reflect every account regardless of which one is selected).
  const messages = account ? allMessages.filter(m => m.accountId === account) : allMessages;
  const comments = account ? allComments.filter(c => c.accountId === account) : allComments;

  // Per-account unread count for the AccountPane badges
  const unreadByAccount = new Map();
  let unreadAll = 0;
  for (const m of allMessages) {
    if (m.direction === "incoming" && !m.readByUs) {
      unreadByAccount.set(m.accountId, (unreadByAccount.get(m.accountId) || 0) + 1);
      unreadAll++;
    }
  }

  // group messages into conversations (keyed by account + counterparty)
  const convMap = new Map();
  for (const m of messages) {
    const key = `${m.accountId}|${m.peerId}`;
    let c = convMap.get(key);
    if (!c) { c = { key, accountId: m.accountId, peerId: m.peerId, peerName: null, peerUsername: null, peerPic: null, msgs: [] }; convMap.set(key, c); }
    c.msgs.push(m);
    if (!c.peerName && m.peerName) c.peerName = m.peerName;
    if (!c.peerUsername && m.peerUsername) c.peerUsername = m.peerUsername;
    if (!c.peerPic && m.peerPic) c.peerPic = m.peerPic;
  }
  const conversations = [...convMap.values()]
    .map(c => ({
      ...c,
      last: c.msgs[0],
      thread: [...c.msgs].reverse(),
      unread: c.msgs.filter(m => m.direction === "incoming" && !m.readByUs).length,
    }))
    .sort((a, b) => new Date(b.last.ts || b.last.createdAt) - new Date(a.last.ts || a.last.createdAt));

  // keep a valid active conversation
  useEffect(() => {
    if (conversations.length === 0) { if (activeKey) setActiveKey(null); return; }
    if (!conversations.some(c => c.key === activeKey)) setActiveKey(conversations[0].key);
  }, [conversations.map(c => c.key).join(","), activeKey]);

  // Messages tab has no "All accounts" picker — auto-select the first connected
  // account on first load (and after a Comments-tab "All" selection bleeds across).
  // Comments tab keeps the "All accounts" chip option so multi-account viewing works there.
  useEffect(() => {
    if (tab === "messages" && account === null && accounts.length > 0) {
      setAccount(accounts[0].accountId);
    }
  }, [tab, account, accounts.length]);

  // Consume the "Go to chat" handoff from the Contacts page once messages have
  // loaded. Sets the right account, switches to Messages, and selects the
  // target conversation. Cleared after one shot.
  useEffect(() => {
    if (!pendingOpenChat) return;
    if (!accounts.length || !allMessages.length) return;
    const { accountId, peerId } = pendingOpenChat;
    setTab("messages");
    setAccount(accountId);
    setActiveKey(`${accountId}|${peerId}`);
    setPendingOpenChat(null);
  }, [pendingOpenChat, accounts.length, allMessages.length]);

  // React to a notification deep-link. DM → reuse the proven pendingOpenChat path
  // (it waits for messages to load before selecting the conversation). Comment →
  // switch to the Comments tab, scope the account, and flag the post to expand.
  useEffect(() => {
    if (!deepLink || deepLink.platform !== "instagram") return;
    if (deepLink.kind === "dm" && deepLink.peerId) {
      setPendingOpenChat({ accountId: deepLink.accountId, peerId: deepLink.peerId });
    } else if (deepLink.kind === "comment") {
      setTab("comments");
      if (deepLink.accountId) setAccount(deepLink.accountId);
      setDeepCommentMedia(deepLink.mediaId || null);
    }
  }, [deepLink]);

  // Search + unread filters on the chat list (Messages tab middle pane).
  const q = query.trim().toLowerCase();
  let visibleConversations = q
    ? conversations.filter(c =>
        [peerLabel(c), c.peerUsername, c.peerId, c.last?.text].filter(Boolean).join(" ").toLowerCase().includes(q))
    : conversations;
  if (unreadOnly) visibleConversations = visibleConversations.filter(c => (c.unread || 0) > 0);
  const totalUnread = conversations.reduce((s, c) => s + (c.unread || 0), 0);

  const activeConv = conversations.find(c => c.key === activeKey) || null;

  // Opening a conversation clears its unread badge (marks incoming msgs read by us)
  useEffect(() => {
    if (!activeConv || !activeConv.unread) return;
    api.markInstagramRead({ accountId: activeConv.accountId, peerId: activeConv.peerId })
      .then(() => refetch())
      .catch(() => {});
  }, [activeKey, activeConv?.unread]);

  return (
    <div className="fc-fill" style={{ overflow: "hidden" }}>
      {ConfirmDialog}
      <div style={{ flexShrink: 0 }}>
        <PageHeader cycle="Instagram" title="Inbox"
          right={<button className="settings-btn" onClick={refetch} disabled={loading}><span style={{ opacity: loading ? 0.5 : 1 }}>↻</span> Refresh</button>} />

        {error && <div style={{ background: C.errBg, color: C.errText, padding: '12px 14px', borderRadius: 12, fontSize: 13.5, marginBottom: 16 }}>{error}</div>}

        {/* Tab strip only — account filter lives inside each tab now (left pane
            for Messages, chip row for Comments) so it never shifts the header. */}
        <UnderlineTabs style={{ marginBottom: 12 }} value={tab} onChange={setTab}
          tabs={[{ id: "messages", label: "Messages", count: conversations.length }, { id: "comments", label: "Comments", count: comments.length }]} />
      </div>

      {tab === "messages" ? (
        // 3-column layout: Accounts | Chats | Conversation (mirrors Forgechat's chat page).
        // All three column headers share PANE_HEADER_HEIGHT (80px, 2-row pattern: label
        // strip + control strip) so they line up visually. The columns sit ON the
        // content pane with no fill of their own; only the thread column is a raised card.
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, overflow: "hidden" }}>
          <AccountPane
            accounts={accounts}
            selectedAccount={account}
            onSelect={setAccount}
            unreadByAccount={unreadByAccount}
            query={accountQuery} setQuery={setAccountQuery}
          />
          <ChatListPane
            conversations={visibleConversations}
            activeKey={activeKey}
            onSelect={setActiveKey}
            accounts={accounts}
            account={account}
            query={query} setQuery={setQuery}
            unreadOnly={unreadOnly} setUnreadOnly={setUnreadOnly}
            totalUnread={totalUnread}
            loading={loading && !data}
            chatCount={conversations.length}
          />
          <ChatThread conv={activeConv} accounts={accounts} onSent={refetch}
            allTags={allTags} categories={categories}
            isAdmin={isAdmin}
            openContactModal={(c) => setEditingContact(c)}
            refreshContacts={refetch} />
        </div>
      ) : (
        <IgCommentsByPost
          comments={comments} accounts={everyAccount} chipAccounts={accounts}
          selectedAccount={account} setAccount={setAccount}
          isAdmin={isAdmin} refetch={refetch} confirm={confirm}
          initialOpenId={deepCommentMedia}
        />
      )}
      {/* Shared ContactModal for the chat-header Edit action. Re-uses the same
          component the ContactsPage uses (single source of truth for the modal). */}
      {editingContact && (
        <ContactModal contact={editingContact} onClose={() => setEditingContact(null)}
          onSaved={() => refetch()}
          onDeleted={() => { setEditingContact(null); refetch(); }}
          isAdmin={isAdmin} allTags={allTags} categories={categories} confirm={confirm} />
      )}
    </div>
  );
}

// Shared header height for the 3 panes in IG Messages so they line up visually.
// 2-row pattern inside: label/meta strip + control (search/picker) strip.
const PANE_HEADER_HEIGHT = 80;
const PANE_HEADER_STYLE = {
  height: PANE_HEADER_HEIGHT, minHeight: PANE_HEADER_HEIGHT, flexShrink: 0,
  padding: "10px 14px",
  display: "flex", flexDirection: "column", justifyContent: "center", gap: 8,
};
const PaneLabelRow = ({ label, right }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 18 }}>
    <span style={{ ...T.label, color: C.textMuted }}>{label}</span>
    {right}
  </div>
);
const SearchInput = ({ value, onChange, placeholder, compact }) => (
  <div className="fc-searchfield" style={{ ...FIELD_WRAP, padding: compact ? "7px 12px" : "8px 12px", flex: "1 1 auto" }}>
    <Search size={14} color={C.textMuted} style={{ flexShrink: 0 }} />
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      style={{ ...BARE_INPUT, fontSize: 13 }} />
    {value && (
      <button onClick={() => onChange("")} title="Clear"
        style={{ display: "flex", border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}>
        <X size={13} color={C.textMuted} />
      </button>
    )}
  </div>
);

// ── AccountPane (leftmost column of IG Messages) ─────────────────────────
// Mirrors Forgechat's NumberSidebar pattern: title + search + scrolling list.
// Each row = one connected IG account. Click sets the filter for the rest of
// the layout. No "All accounts" pseudo-row — Messages always works against a
// single account (auto-picked on first load).
function AccountPane({ accounts, selectedAccount, onSelect, unreadByAccount, query, setQuery }) {
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? accounts.filter(a => [a.name, a.username, a.accountId].filter(Boolean).join(" ").toLowerCase().includes(q))
    : accounts;

  function Row({ active, label, sublabel, unread, onClick, seed, pic }) {
    return (
      <button onClick={onClick}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.surface; }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "none", borderRadius: 14, background: ROW_BG(active), cursor: "pointer", fontFamily: FONT, textAlign: "left", transition: "background .14s" }}>
        <Avatar pic={pic} label={label} seed={seed || label} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...T.h3, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
          {sublabel && <div style={{ ...T.small, fontSize: 13, color: C.textMuted, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sublabel}</div>}
        </div>
        <UnreadPill n={unread} />
      </button>
    );
  }

  return (
    <div style={{ width: 240, minWidth: 220, display: "flex", flexDirection: "column" }}>
      <div style={PANE_HEADER_STYLE}>
        <PaneLabelRow label="Accounts" right={<span style={COUNT_CHIP(false)}>{accounts.length}</span>} />
        <div style={{ display: "flex" }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search accounts…" compact />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "0 4px 8px" }}>
        {filtered.map(a => {
          const label = a.name || (a.username ? "@" + a.username : shortId(a.accountId));
          const sublabel = a.username ? "@" + a.username : null;
          return <Row key={a.accountId} active={selectedAccount === a.accountId} label={label} sublabel={sublabel}
            unread={unreadByAccount.get(a.accountId) || 0} seed={a.accountId}
            onClick={() => onSelect(a.accountId)} />;
        })}
        {filtered.length === 0 && q && (
          <div style={{ padding: "30px 14px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>No accounts match “{query}”.</div>
        )}
      </div>
    </div>
  );
}

// ── ChatListPane (middle column) ─────────────────────────────────────────
// 2-row header: "CHATS" label + count chip on top; search box + Unread filter
// pill on the second row. Below the header is the scrolling chat list.
function ChatListPane({ conversations, activeKey, onSelect, accounts, account, query, setQuery, unreadOnly, setUnreadOnly, totalUnread, loading, chatCount }) {
  const q = (query || "").trim();
  return (
    <div style={{ width: 340, minWidth: 280, display: "flex", flexDirection: "column" }}>
      <div style={PANE_HEADER_STYLE}>
        <PaneLabelRow label="Chats" right={<span style={COUNT_CHIP(unreadOnly)}>{conversations.length}</span>} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search chats…" compact />
          <button onClick={() => setUnreadOnly(v => !v)}
            title={unreadOnly ? "Show all chats" : "Show only unread chats"}
            style={{ ...CHIP(unreadOnly), display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", fontSize: 12, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: unreadOnly ? C.onAccent : C.primary, flexShrink: 0 }} />
            Unread{totalUnread > 0 ? ` · ${totalUnread}` : ""}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "0 4px 8px" }}>
        {loading
          ? <div style={{ padding: 20, color: C.textMuted, fontSize: 14 }}>Loading…</div>
          : conversations.length === 0 && q
            ? <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>No chats match “{query}”.</div>
            : conversations.length === 0 && unreadOnly
              ? <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>No unread chats. <button onClick={() => setUnreadOnly(false)} style={{ background: "none", border: "none", padding: 0, color: C.primary, fontWeight: 700, fontFamily: FONT, fontSize: 14, cursor: "pointer", textDecoration: "underline" }}>Show all</button></div>
              : conversations.length === 0
                ? <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>No conversations yet{account ? " for this account" : ""}.</div>
                : <ConversationList conversations={conversations} activeKey={activeKey} onSelect={onSelect} accounts={accounts} showAccount={!account} />}
      </div>
    </div>
  );
}

// Wraps the shared CommentsByPost with IG-specific identity, normalizer, and
// reply/delete dispatch (IG reply needs accountId context for multi-account).
// Renders its own account-chip row above the post list (the IG Messages tab
// owns the account picker in its left pane — Comments needs its own).
function IgCommentsByPost({ comments, accounts, chipAccounts = accounts, selectedAccount, setAccount, isAdmin, refetch, confirm, initialOpenId }) {
  // Build a username→accountId map so we can mark our own replies as "ours".
  // An IG reply posted via /api/instagram/comments/:id/reply lands back in the
  // ingest with the account's own username as `fromUsername`.
  const ourUsernames = new Set(accounts.filter(a => a.username).map(a => a.username));

  const igMeta = { name: "Instagram", color: IG.color, bg: IG.bg, textOnBg: IG.textOnBg };

  const norm = (c) => ({
    id: c.id, commentId: c.commentId,
    groupId: c.mediaId, parentId: c.parentId,
    name: c.fromUsername ? "@" + c.fromUsername : "Instagram user",
    pic: null,                                       // IG webhook gives no commenter pic
    text: c.text, ts: c.ts || c.createdAt,
    // like_count arrives via the comments sync (webhook rows fill in next pass);
    // there's no API to LIKE an IG comment, so it renders as a read-only count.
    likes: c.likeCount || 0, liked: false,
    ours: c.fromUsername && ourUsernames.has(c.fromUsername),
    permalink: c.mediaPermalink || null, kind: "Post",
    postThumbnail: c.mediaThumbnail || null,
    postCaption:   c.mediaCaption   || null,
    postPermalink: c.mediaPermalink || null,
    postDate:      c.mediaDate      || null,
    accountId:     c.accountId,                      // carried for the reply dispatch
  });

  async function handleReply(comment, text) {
    await api.replyInstagramComment(comment.commentId, { accountId: comment.accountId, message: text });
    refetch();
  }

  async function handleDelete(comment, onStart) {
    const ok = await confirm({ title: "Delete this comment?", body: "This permanently removes the comment from Instagram. This can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    onStart?.();
    await api.deleteInstagramComment(comment.commentId);
    refetch();
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {chipAccounts.length > 1 && (
        <div style={{ flexShrink: 0, marginBottom: 12 }}>
          <AccountFilter accounts={chipAccounts} value={selectedAccount} onChange={setAccount} inline />
        </div>
      )}
      <CommentsByPost
        raw={comments} norm={norm}
        platform="instagram" meta={igMeta}
        onReply={handleReply}
        onDelete={isAdmin ? handleDelete : undefined}
        initialOpenId={initialOpenId}
        emptyTitle="No comments yet"
        emptySub="Comments on your Instagram posts will appear here once they're received."
      />
    </div>
  );
}

function EmptyState({ title, sub }) {
  return (
    <Card style={{ padding: "40px 20px" }}>
      <UIEmptyState Icon={MessageSquare} title={title} body={sub} style={{ padding: 0 }} />
    </Card>
  );
}

// One comment line (top-level or reply). Top-level rows get a Reply toggle;
// admins get a Delete action on every row.
function PlatformCommentRow({ comment: c, onReplyClick, onDelete, isReply, badges }) {
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState(null);

  const del = async () => {
    setErr(null);
    try {
      // onDelete handles the confirm dialog, then calls onStart() before the API
      // call so the busy label only shows once the user has actually confirmed.
      await onDelete(c, () => setDeleting(true));
    } catch (e) { setErr(e.message); setDeleting(false); }
    // on success the row unmounts (filtered from the list), so no reset needed
  };

  return (
    <div style={{ display: "flex", gap: 12, padding: isReply ? "10px 14px 10px 0" : "12px 14px", alignItems: "flex-start", opacity: deleting ? 0.5 : 1 }}>
      <Avatar pic={c.pic} label={c.name} seed={c.commentId || c.name} size={isReply ? 30 : 36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.name}</span>
          {badges}
          {c.ours && <Badge label="Your reply" bg={C.primarySoft} color={C.primary} />}
          {isReply && !c.ours && <Badge label="Reply" bg={C.amberSoft} color={C.amber} />}
          {/* Read-only count: Instagram has no API to like a comment */}
          {c.likes > 0 && <span style={{ fontSize: 12.5, color: C.textMuted }}>{c.likes} {c.likes === 1 ? "like" : "likes"}</span>}
        </div>
        <div style={{ fontSize: 14, color: c.text ? C.textSecondary : C.textMuted, lineHeight: 1.45, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{c.text || "(no text)"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 6 }}>
          {onReplyClick && (
            <button onClick={onReplyClick} style={{ ...ACTION_LINK, color: C.primary }}>
              <CornerDownRight size={13} /> Reply
            </button>
          )}
          {onDelete && (
            <button onClick={del} disabled={deleting} style={{ ...ACTION_LINK, color: "var(--fc-err-text)", cursor: deleting ? "wait" : "pointer" }}>
              <Trash2 size={13} /> {deleting ? "Deleting…" : "Delete"}
            </button>
          )}
        </div>
        {err && <div style={{ fontSize: 12.5, color: C.errText, marginTop: 5 }}>{err}</div>}
      </div>
      <span style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap", flexShrink: 0, marginTop: 2, fontFamily: "var(--fc-font-mono)" }}>{relativeTime(c.ts)}</span>
    </div>
  );
}
// Text-only action inside a comment row (Reply / Delete): no fill, weight carries it.
const ACTION_LINK = { display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "transparent", fontSize: 12.5, fontWeight: 700, fontFamily: FONT, cursor: "pointer", padding: 0 };

// ── CommentsByPost: the comments workspace ──────────────────────────────
// Used by InstagramInbox's Comments tab.
//   1. A summary strip — how many comments and how many still need a reply.
//      Every tile is also a one-click filter.
//   2. Posts on the left ("All posts" first), each with its count and how many
//      are waiting — so you can work post by post or across everything.
//   3. The comments themselves on the right, one card each, with the reply box
//      already open underneath — no expanding a post to find them.
// "Needs reply" = a top-level comment by someone else with no reply from us.
const STATUS_TABS = [
  { k: "needs", l: "Needs reply" },
  { k: "all", l: "All" },
  { k: "replied", l: "Replied" },
];
const RANGES = [
  { value: "all", label: "All time" }, { value: "1", label: "Last 24 hours" }, { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" },
];
const PAGE = 60;

function CommentsByPost({
  raw, norm,
  platform, meta,
  onReply, onDelete, initialOpenId,
  emptyTitle = "No comments yet",
  emptySub   = "Comments on your posts will appear here.",
}) {
  const [query, setQuery]       = useState("");
  const [range, setRange]       = useState("all");
  const [status, setStatus]     = useState("needs");
  const [postId, setPostId]     = useState(null);      // null = all posts
  const [sort, setSort]         = useState("newest");
  const [limit, setLimit]       = useState(PAGE);
  const [postQuery, setPostQuery] = useState("");
  const listRef = useRef(null);

  // Deep-link from a notification: open that post with every filter cleared.
  useEffect(() => {
    if (!initialOpenId) return;
    setPostId(initialOpenId); setStatus("all"); setQuery(""); setRange("all");
  }, [initialOpenId]);
  useEffect(() => { setLimit(PAGE); listRef.current?.scrollTo?.({ top: 0 }); }, [postId, status, query, range, sort]);

  const all = raw.map(norm);

  // Group by post; split top-level vs replies; surface orphan replies as top-level.
  const groups = new Map();
  for (const c of all) {
    const gid = c.groupId || "_";
    if (!groups.has(gid)) groups.set(gid, { id: gid, kind: c.kind, postThumbnail: null, postCaption: null, postPermalink: null, postDate: null, top: [], replies: new Map() });
    const g = groups.get(gid);
    for (const k of ["postThumbnail", "postCaption", "postPermalink", "postDate"]) if (!g[k] && c[k]) g[k] = c[k];
    if (!g.postPermalink && c.permalink) g.postPermalink = c.permalink;
    if (c.parentId) { if (!g.replies.has(c.parentId)) g.replies.set(c.parentId, []); g.replies.get(c.parentId).push(c); }
    else g.top.push(c);
  }
  for (const g of groups.values()) {
    const ids = new Set(g.top.map(c => c.commentId));
    for (const [pid, arr] of [...g.replies]) if (!ids.has(pid)) { g.top.push(...arr); g.replies.delete(pid); }
  }

  // One flat list of conversations (a top-level comment + its replies), with everything the filters need.
  const cutoff = range === "all" ? 0 : Date.now() - parseInt(range, 10) * 864e5;
  const items = [];
  for (const g of groups.values()) for (const c of g.top) {
    const replies = [...(g.replies.get(c.commentId) || [])].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    items.push({
      c, g, replies,
      needs: !c.ours && !replies.some(r => r.ours),
      ts: +new Date(c.ts || 0),
    });
  }
  const inRange = items.filter(i => !cutoff || i.ts >= cutoff);
  const people = inRange.filter(i => !i.c.ours);

  // Summary counts (people's comments in the chosen time range, all posts).
  const count = (fn) => people.filter(fn).length;
  const sum = {
    total: people.length,
    needs: count(i => i.needs),
    replied: count(i => !i.needs),
  };

  // Posts rail: per-post totals honour the time range only (not the other filters), so it reads as an index.
  const posts = [...groups.values()].map(g => {
    const its = inRange.filter(i => i.g === g && !i.c.ours);
    const latest = Math.max(0, ...inRange.filter(i => i.g === g).map(i => i.ts));
    return { g, total: its.length, needs: its.filter(i => i.needs).length, latest };
  }).filter(p => p.total > 0 || p.g.id === postId)
    .sort((a, b) => (b.needs > 0) - (a.needs > 0) || b.latest - a.latest);
  const pq = postQuery.trim().toLowerCase();
  const shownPosts = pq ? posts.filter(p => (p.g.postCaption || "").toLowerCase().includes(pq)) : posts;

  // Apply filters for the feed.
  const q = query.trim().toLowerCase();
  let feed = inRange.filter(i => {
    if (postId && i.g.id !== postId) return false;
    if (status === "needs" && !i.needs) return false;
    if (status === "replied" && (i.needs || i.c.ours)) return false;
    if (q && !((i.c.text || "").toLowerCase().includes(q) || (i.c.name || "").toLowerCase().includes(q) || i.replies.some(r => (r.text || "").toLowerCase().includes(q)))) return false;
    return true;
  });
  feed.sort((a, b) => sort === "oldest" ? a.ts - b.ts : b.ts - a.ts);
  const selected = postId ? groups.get(postId) : null;

  const resetFilters = () => { setStatus("all"); setQuery(""); setRange("all"); };

  if (groups.size === 0) return <EmptyState title={emptyTitle} sub={emptySub} />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 1 · Summary */}
      <div style={{ flexShrink: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <SumTile label="Comments" value={sum.total} sub={range === "all" ? "all time" : RANGES.find(r => r.value === range)?.label.toLowerCase()}
          active={status === "all"} onClick={() => setStatus("all")} />
        <SumTile label="Need a reply" value={sum.needs} tone="primary" sub={sum.total ? `${Math.round(sum.needs * 100 / sum.total)}% of comments` : ""}
          active={status === "needs"} onClick={() => setStatus("needs")} />
        <SumTile label="Replied" value={sum.replied} tone="green" sub={sum.total ? `${Math.round(sum.replied * 100 / sum.total)}% of comments` : ""} active={status === "replied"} onClick={() => setStatus("replied")} />
      </div>

      {/* 2 · Toolbar */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", background: C.surface, borderRadius: 999, padding: 3 }}>
          {STATUS_TABS.map(t => {
            const n = t.k === "needs" ? sum.needs : t.k === "replied" ? sum.replied : sum.total;
            const on = status === t.k;
            return (
              <button key={t.k} onClick={() => setStatus(t.k)} style={{ border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 13, fontWeight: 650, padding: "6px 13px", borderRadius: 999, background: on ? C.primary : "transparent", color: on ? C.onAccent : C.textSecondary, display: "inline-flex", gap: 6, alignItems: "center" }}>
                {t.l}<span style={{ fontSize: 11.5, fontWeight: 700, opacity: .85 }}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="fc-searchfield" style={{ ...FIELD_WRAP, padding: "0 12px", height: 36, flex: "1 1 220px", maxWidth: 360 }}>
          <Search size={15} color={C.textMuted} style={{ flexShrink: 0 }} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search comments or names…" style={{ ...BARE_INPUT, fontSize: 13.5 }} />
          {query && <button onClick={() => setQuery("")} title="Clear" style={{ display: "flex", border: "none", background: "transparent", cursor: "pointer", padding: 0 }}><X size={15} color={C.textMuted} /></button>}
        </div>
        <SearchableSelect value={range} onChange={setRange} options={RANGES} minWidth={150} />
        <SearchableSelect value={sort} onChange={setSort} minWidth={150} options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]} />
      </div>
      {/* 3 · Posts | Comments */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12 }}>
        <div style={{ width: 300, flexShrink: 0, background: C.raised, borderRadius: 16, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "12px 12px 8px", flexShrink: 0 }}>
            <div className="fc-searchfield" style={{ ...FIELD_WRAP, padding: "0 10px", height: 34 }}>
              <Search size={14} color={C.textMuted} />
              <input value={postQuery} onChange={e => setPostQuery(e.target.value)} placeholder="Find a post…" style={{ ...BARE_INPUT, fontSize: 13 }} />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
            <PostRow active={!postId} onClick={() => setPostId(null)} title="All posts" total={sum.total} needs={sum.needs} meta={meta} all />
            {shownPosts.map(p => (
              <PostRow key={p.g.id} active={postId === p.g.id} onClick={() => setPostId(p.g.id)} g={p.g} total={p.total} needs={p.needs} meta={meta} />
            ))}
            {!shownPosts.length && <div style={{ padding: 14, fontSize: 13, color: C.textMuted }}>No post matches.</div>}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {selected && <SelectedPostBar g={selected} meta={meta} platform={platform} onClear={() => setPostId(null)} />}
          <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 2 }}>
            <div style={{ fontSize: 13, color: C.textMuted, padding: "2px 2px 0" }}>
              {feed.length.toLocaleString("en-IN")} comment{feed.length === 1 ? "" : "s"}
              {status === "needs" ? " waiting for a reply" : status === "replied" ? " you've replied to" : ""}
              {selected ? " on this post" : ""}
            </div>
            {feed.length === 0 ? (
              <Card style={{ padding: "36px 20px" }}>
                <UIEmptyState Icon={status === "needs" ? CheckCheck : MessageSquare}
                  title={status === "needs" && !q ? "All caught up" : "No comments match"}
                  body={status === "needs" && !q ? "Every comment here has a reply. New ones will show up at the top." : "Try a different filter or a wider time range."}
                  action={(q || status !== "all" || range !== "all") && <button onClick={resetFilters} style={BTN.secondary}>Show all comments</button>}
                  style={{ padding: 0 }} />
              </Card>
            ) : feed.slice(0, limit).map(i => (
              <CommentCard key={i.c.commentId || i.c.id} item={i} showPost={!postId} meta={meta}
                onReply={onReply} onDelete={onDelete} onOpenPost={() => setPostId(i.g.id)} />
            ))}
            {feed.length > limit && <button onClick={() => setLimit(l => l + PAGE)} style={{ ...BTN.secondary, alignSelf: "center", margin: "4px 0 10px" }}>Show {Math.min(PAGE, feed.length - limit)} more</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

const TONES = {
  primary: ["var(--fc-primary-soft)", "var(--fc-primary)"], green: ["var(--fc-green-soft)", "var(--fc-green)"],
};
function SumTile({ label, value, sub, tone, active, onClick }) {
  const [, fg] = TONES[tone] || [C.surface2, C.text];
  return (
    <button onClick={onClick} title={`Show: ${label}`}
      style={{ textAlign: "left", border: "none", fontFamily: FONT, cursor: "pointer", borderRadius: 16, padding: "12px 14px", minHeight: 88,
        background: active ? C.primaryFaint : C.raised, boxShadow: active ? `inset 0 0 0 1.5px ${C.primary}` : "none" }}>
      <div style={{ ...T.label, color: C.textSecondary }}>{label}</div>
      <div style={{ ...T.metricSm, color: tone ? fg : C.text, marginTop: 4 }}>{value.toLocaleString("en-IN")}</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minHeight: 16 }}>{sub || "\u00a0"}</div>
    </button>
  );
}

function PostThumb({ g, meta, size = 44 }) {
  const [err, setErr] = useState(false);
  if (g?.postThumbnail && !err) return <img src={g.postThumbnail} alt="" onError={() => setErr(true)} style={{ width: size, height: size, borderRadius: 10, objectFit: "cover", flexShrink: 0, background: C.surface2 }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: meta.bg || C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><MessageSquare size={size * 0.42} color={meta.textOnBg || C.textMuted} /></div>;
}
const postTitle = (g) => (g.postCaption || "").trim() || `${g.kind || "Post"} · ${shortId(g.id)}`;

function PostRow({ active, onClick, g, title, total, needs, meta, all }) {
  return (
    <button onClick={onClick} style={{ border: "none", cursor: "pointer", fontFamily: FONT, textAlign: "left", display: "flex", gap: 10, alignItems: "center", padding: 8, borderRadius: 12,
      background: active ? C.primaryFaint : "transparent", boxShadow: active ? `inset 0 0 0 1.5px ${C.primary}` : "none" }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.surface; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
      {all ? <div style={{ width: 44, height: 44, borderRadius: 10, background: C.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><MessageSquare size={18} color={C.textSecondary} /></div>
        : <PostThumb g={g} meta={meta} />}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: all ? 700 : 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title || postTitle(g)}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{total} comment{total === 1 ? "" : "s"}{!all && g.postDate ? ` · ${relativeTime(g.postDate)}` : ""}</div>
      </div>
      {needs > 0 && <span title={`${needs} waiting for a reply`} style={{ fontSize: 11.5, fontWeight: 750, minWidth: 22, textAlign: "center", padding: "2px 7px", borderRadius: 999, background: C.primary, color: C.onAccent, flexShrink: 0 }}>{needs}</span>}
    </button>
  );
}

function SelectedPostBar({ g, meta, platform, onClear }) {
  return (
    <div style={{ flexShrink: 0, display: "flex", gap: 12, alignItems: "center", background: C.raised, borderRadius: 16, padding: 10, marginBottom: 10 }}>
      <PostThumb g={g} meta={meta} size={52} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: C.text, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{postTitle(g)}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{g.postDate ? `Posted ${relativeTime(g.postDate)}` : g.kind}</div>
      </div>
      <AssignControl itemType="post" itemId={String(g.id)} platform={platform} compact />
      {g.postPermalink && <a href={g.postPermalink} target="_blank" rel="noopener noreferrer" style={{ ...BTN.secondary, padding: "7px 12px", fontSize: 13, textDecoration: "none" }}>Open post <ExternalLink size={12} /></a>}
      <button onClick={onClear} aria-label="Show all posts" title="Show all posts" style={{ ...BTN.icon, width: 32, height: 32 }}><X size={15} /></button>
    </div>
  );
}

// One comment conversation: the comment, its replies, and an always-ready reply box.
function CommentCard({ item: i, showPost, meta, onReply, onDelete, onOpenPost }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [sentFlash, setSentFlash] = useState(false);
  const c = i.c;
  const canReply = !!onReply && !c.ours;

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true); setErr(null);
    try { await onReply(c, text.trim()); setText(""); setFocused(false); setSentFlash(true); setTimeout(() => setSentFlash(false), 4000); }
    catch (e) { setErr(e.message); }
    finally { setSending(false); }
  };
  const statusChip = c.ours ? null : i.needs
    ? <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: C.primarySoft, color: C.primary }}>Needs reply{slaLabel(c.ts) ? ` · ${slaLabel(c.ts).replace(/^awaiting\s*/i, "")}` : ""}</span>
    : <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: C.greenSoft, color: C.green, display: "inline-flex", alignItems: "center", gap: 4 }}><CheckCheck size={12} />Replied</span>;

  return (
    <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden", boxShadow: i.needs ? `inset 3px 0 0 ${C.primary}` : "none", flexShrink: 0 }}>
      {showPost && (
        <button onClick={onOpenPost} title="Show only this post's comments" style={{ width: "100%", border: "none", cursor: "pointer", fontFamily: FONT, textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: C.surface, color: C.textMuted, fontSize: 12.5 }}>
          <PostThumb g={i.g} meta={meta} size={22} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>On: {postTitle(i.g)}</span>
        </button>
      )}
      <PlatformCommentRow comment={c} onDelete={onDelete}
        badges={statusChip} />
      {i.replies.length > 0 && (
        <div style={{ margin: "0 14px 6px 62px", borderLeft: `2px solid ${C.surface2}` }}>
          {i.replies.map(r => <div key={r.commentId || r.id} style={{ paddingLeft: 10 }}><PlatformCommentRow comment={r} onDelete={onDelete} isReply /></div>)}
        </div>
      )}
      {canReply && (
        <div style={{ padding: "4px 14px 12px 62px" }}>
          {err && <div style={{ fontSize: 12.5, color: C.errText, marginBottom: 6 }}>Couldn't send: {err}</div>}
          {sentFlash && <div style={{ fontSize: 12.5, color: C.green, fontWeight: 650, marginBottom: 6, display: "flex", gap: 5, alignItems: "center" }}><CheckCheck size={13} /> Reply posted</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <CannedReplyButton onInsert={(b) => { setText(t => t ? t + " " + b : b); setFocused(true); }} peerName={c.name?.replace(/^@/, "")} />
            <div className="fc-searchfield" style={{ ...FIELD_WRAP, flex: 1, alignItems: "stretch", padding: "8px 12px" }}>
              <textarea value={text} onChange={e => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => !text && setFocused(false)}
                rows={focused || text ? 2 : 1}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={`Reply to ${c.name || "this comment"}…`}
                style={{ ...BARE_INPUT, fontSize: 13.5, resize: "none", lineHeight: 1.45, width: "100%" }} />
            </div>
            <button onClick={send} disabled={sending || !text.trim()}
              style={{ ...BTN.primary, padding: "9px 16px", fontSize: 13, background: !text.trim() ? C.surface2 : C.primary, color: !text.trim() ? C.textMuted : C.onAccent, cursor: sending || !text.trim() ? "not-allowed" : "pointer" }}>
              <Send size={13} /> {sending ? "Sending…" : "Reply"}
            </button>
          </div>
          {(focused || text) && <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 12, color: C.textMuted }}>Enter to send · Shift+Enter for a new line</span><SaveReplyButton text={text} /></div>}
        </div>
      )}
    </div>
  );
}

export default function InboxPage({ user }) {
  const [deepLink, setDeepLink] = useState(null);

  // Consume a notification deep-link and hand the target (chat peer / comment
  // post) to the Instagram view. Two entry points: a sessionStorage handoff on
  // mount (fresh navigation), and a window event while already mounted
  // (clicking a notification from inside the Inbox).
  useEffect(() => {
    const apply = (m) => {
      if (!m || m.platform !== "instagram") return;
      setDeepLink({ ...m, _t: Date.now() });  // new object each time → child effects refire
    };
    try {
      const raw = sessionStorage.getItem("forgesocial.inboxDeepLink");
      if (raw) { sessionStorage.removeItem("forgesocial.inboxDeepLink"); apply(JSON.parse(raw)); }
    } catch (_) {}
    const onEvt = (e) => apply(e.detail);
    window.addEventListener("forgesocial:inbox-deeplink", onEvt);
    return () => window.removeEventListener("forgesocial:inbox-deeplink", onEvt);
  }, []);

  return (
    <InboxToolsProvider>
      <InstagramInbox isAdmin={user?.role === "admin"} deepLink={deepLink} />
    </InboxToolsProvider>
  );
}
