// Social → Messenger: messages people send to our Facebook Pages.
//
// Two columns on the content pane — conversations | thread — like the
// Instagram inbox. Data comes from /api/social/messenger/* (backend
// messenger.js), which polls each Page's conversations and also takes live
// webhook events. Every state where nothing can show (no Page connected, the
// Page token lacks pages_messaging) says why instead of rendering an empty list.
import { useState, useEffect, useMemo, useRef } from "react";
import { Search, Send, X, RefreshCw, MessageCircle, ExternalLink, Paperclip, Film, Mic, AlertTriangle, Clock, Image as ImageIcon } from "lucide-react";
import { api } from "../api.js";
import { relativeTime, C, FONT, T, BTN } from "../constants.js";
import { PageHeader, EmptyState } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";

const FB = "#0866FF";
const FIELD_WRAP = { display: "flex", alignItems: "center", gap: 8, background: C.surface, borderRadius: 12, padding: "8px 12px", minWidth: 0 };
const BARE_INPUT = { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", padding: 0, fontSize: 13.5, fontFamily: FONT, color: C.text };
const THREAD_PANE = { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.raised, borderRadius: 16, overflow: "hidden" };

const initials = (s) => String(s || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
const peerLabel = (c) => c?.peerName || (c?.peerId ? "Messenger user · " + String(c.peerId).slice(-4) : "Messenger user");

function Avatar({ pic, label, size = 44 }) {
  const [err, setErr] = useState(false);
  if (pic && !err) return <img src={pic} alt="" onError={() => setErr(true)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, background: C.blueSoft, color: C.blue, display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.max(11.5, size * 0.36), fontWeight: 700, fontFamily: FONT }}>
      {initials(label)}
    </div>
  );
}

function attSummary(atts) {
  const a = Array.isArray(atts) ? atts[0] : null;
  if (!a) return "";
  return { image: "Photo", gif: "GIF", video: "Video", audio: "Voice message", sticker: "Sticker", link: "Link" }[a.type] || "Attachment";
}

function Attachment({ a, out }) {
  const fg = out ? C.onAccent : C.text;
  if ((a.type === "image" || a.type === "gif" || a.type === "sticker") && a.url) {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" style={{ display: "block" }}>
        <img src={a.url} alt="" style={{ maxWidth: a.type === "sticker" ? 120 : 260, maxHeight: 260, borderRadius: 14, display: "block", objectFit: "cover" }} />
      </a>
    );
  }
  if (a.type === "video" && a.url) return <video src={a.url} controls preload="metadata" style={{ maxWidth: 280, maxHeight: 260, borderRadius: 14 }} />;
  if (a.type === "audio" && a.url) return <audio src={a.url} controls preload="metadata" style={{ maxWidth: 260 }} />;
  const Icon = a.type === "video" ? Film : a.type === "audio" ? Mic : a.type === "image" ? ImageIcon : Paperclip;
  const body = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 14, background: out ? C.primary : C.surface2, color: fg, fontSize: 13.5, fontWeight: 600 }}>
      <Icon size={14} /> {a.name || attSummary([a])}
    </span>
  );
  return a.url ? <a href={a.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{body}</a> : body;
}

function ConversationRow({ c, active, onClick, showPage, pageName }) {
  const out = c.last?.direction === "outgoing";
  const preview = c.last?.text || attSummary(c.last?.attachments) || "Message";
  return (
    <button onClick={onClick}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.surface; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "none", borderRadius: 14, cursor: "pointer", background: active ? C.primaryFaint : "transparent", fontFamily: FONT, textAlign: "left" }}>
      <Avatar pic={c.peerPic} label={peerLabel(c)} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <span style={{ ...T.h3, fontWeight: c.unread ? 780 : 650, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{peerLabel(c)}</span>
          <span style={{ fontSize: 12.5, fontWeight: 650, color: C.primary, whiteSpace: "nowrap", flexShrink: 0 }}>{relativeTime(c.last?.ts)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginTop: 2 }}>
          <span style={{ ...T.small, color: c.unread ? C.text : C.textMuted, fontWeight: c.unread ? 650 : 450, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {out ? "You: " : ""}{preview}
          </span>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            {showPage && pageName && <span style={{ fontSize: 11, fontWeight: 650, padding: "1px 7px", borderRadius: 999, background: C.surface2, color: C.textSecondary, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pageName}</span>}
            {c.unread > 0 && <span title={`${c.unread} unread`} style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: C.green, color: "#fff", minWidth: 18, textAlign: "center", lineHeight: 1.5 }}>{c.unread > 99 ? "99+" : c.unread}</span>}
          </span>
        </div>
      </div>
    </button>
  );
}

function Thread({ conv, pageName, onSent }) {
  const [messages, setMessages] = useState(null);
  const [err, setErr] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const scrollRef = useRef(null);
  const key = conv ? conv.key : null;

  const load = () => {
    if (!conv) return;
    api.getMessengerThread(conv.pageId, conv.peerId)
      .then(r => { setMessages(r.messages || []); setErr(null); })
      .catch(e => setErr(e.message));
  };
  useEffect(() => { setMessages(null); setSendErr(null); setText(""); load(); }, [key]);
  // Follow new messages arriving while the thread is open (the list polls).
  useEffect(() => { if (conv && messages) load(); }, [conv?.last?.ts]);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages?.length, key]);

  if (!conv) {
    return <div style={{ ...THREAD_PANE, alignItems: "center", justifyContent: "center" }}>
      <EmptyState Icon={MessageCircle} title="Pick a conversation" body="Messages people send to your Facebook Page appear here." />
    </div>;
  }

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setSendErr(null);
    try {
      await api.replyMessenger({ pageId: conv.pageId, peerId: conv.peerId, text: body });
      setText("");
      load(); onSent?.();
    } catch (e) { setSendErr(e.message); }
    finally { setSending(false); }
  };

  const lastOutgoing = (messages || []).filter(m => m.direction === "outgoing").slice(-1)[0];
  return (
    <div style={THREAD_PANE}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", flexShrink: 0 }}>
        <Avatar pic={conv.peerPic} label={peerLabel(conv)} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...T.h3, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{peerLabel(conv)}</div>
          <div style={{ fontSize: 12.5, color: C.textMuted }}>Messenger{pageName ? ` · to ${pageName}` : ""}</div>
        </div>
        {conv.link && (
          <a href={conv.link} target="_blank" rel="noreferrer" title="Open in Facebook" style={{ ...BTN.icon, textDecoration: "none" }}>
            <ExternalLink size={15} />
          </a>
        )}
      </div>

      <div ref={scrollRef} data-testid="messenger-thread" style={{ flex: 1, overflowY: "auto", padding: "8px 18px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ marginTop: "auto" }} />
        {err && <div style={{ color: C.errText, fontSize: 13.5, textAlign: "center" }}>{err}</div>}
        {!messages && !err && <div style={{ color: C.textMuted, fontSize: 13.5, textAlign: "center" }}>Loading…</div>}
        {(messages || []).map(m => {
          const out = m.direction === "outgoing";
          const atts = Array.isArray(m.attachments) ? m.attachments : [];
          const hasText = !!(m.text && m.text.trim());
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start", alignSelf: out ? "flex-end" : "flex-start", maxWidth: "78%", gap: 4 }}>
              {atts.map((a, i) => <Attachment key={i} a={a} out={out} />)}
              {(hasText || !atts.length) && (
                <div style={{ padding: "9px 12px", borderRadius: out ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: out ? C.primary : C.surface2, color: out ? C.onAccent : C.text, fontSize: 14, lineHeight: 1.45, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                  {hasText ? m.text : <span style={{ fontStyle: "italic", opacity: .75 }}>Message not supported here</span>}
                </div>
              )}
              <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: "var(--fc-font-mono)" }}>
                {relativeTime(m.ts)}{out && m.sent_by_name ? ` · ${m.sent_by_name}` : ""}{out && m.id === lastOutgoing?.id && m.seen ? " · Seen" : ""}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: "8px 14px 12px", flexShrink: 0 }}>
        {!conv.windowOpen && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", borderRadius: 12, background: C.amberSoft, color: C.amber, fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
            <Clock size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Facebook only allows a reply within 24 hours of the person's last message. This conversation is past that, so reply from the Facebook Page inbox.</span>
          </div>
        )}
        {sendErr && <div style={{ fontSize: 12.5, color: C.errText, marginBottom: 6 }}>{sendErr}</div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="fc-searchfield" style={{ ...FIELD_WRAP, flex: 1, padding: "0 14px", height: 40, opacity: conv.windowOpen ? 1 : .6 }}>
            <input value={text} onChange={e => setText(e.target.value)} disabled={!conv.windowOpen}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={conv.windowOpen ? "Reply on Messenger…" : "Reply window closed"}
              style={{ ...BARE_INPUT, fontSize: 14 }} />
          </div>
          <button onClick={send} disabled={sending || !text.trim() || !conv.windowOpen} title={sending ? "Sending…" : "Send"} aria-label="Send"
            style={{ ...BTN.icon, width: 40, height: 40, background: !text.trim() || !conv.windowOpen ? C.surface2 : C.primary, color: !text.trim() || !conv.windowOpen ? C.textMuted : C.onAccent, cursor: sending || !text.trim() || !conv.windowOpen ? "not-allowed" : "pointer" }}>
            <Send size={16} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MessengerPage({ onOpenIntegrations }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState("");
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [activeKey, setActiveKey] = useState(null);

  const load = (force = false) => {
    setLoading(true);
    const p = force ? api.syncMessenger().catch(() => {}).then(() => api.getMessengerInbox({ sync: 0 })) : api.getMessengerInbox();
    return p.then(r => { setData(r); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); const t = setInterval(() => load(), 20000); return () => clearInterval(t); }, []);

  const pages = data?.pages || [];
  const pageName = (id) => pages.find(p => p.pageId === id)?.name || null;
  const conversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.conversations || []).filter(c =>
      (!page || c.pageId === page) &&
      (!unreadOnly || c.unread > 0) &&
      (!q || peerLabel(c).toLowerCase().includes(q) || String(c.last?.text || "").toLowerCase().includes(q)));
  }, [data, page, query, unreadOnly]);
  const active = (data?.conversations || []).find(c => c.key === activeKey) || null;
  const totalUnread = (data?.conversations || []).filter(c => !page || c.pageId === page).reduce((s, c) => s + (c.unread || 0), 0);

  // Opening a conversation clears its unread badge.
  useEffect(() => {
    if (!active || !active.unread) return;
    api.markMessengerRead({ pageId: active.pageId, peerId: active.peerId }).then(() => load()).catch(() => {});
  }, [activeKey, active?.unread]);

  const problems = pages.filter(p => p.error);
  const notConfigured = data && !data.configured && !(data.conversations || []).length;

  return (
    <div className="fc-fill" style={{ overflow: "hidden" }}>
      <div style={{ flexShrink: 0 }}>
        <PageHeader cycle="Facebook Messenger" title="Messenger"
          sub={data?.configured ? `${pages.length} Page${pages.length === 1 ? "" : "s"} connected` : null}
          right={<>
            {pages.length > 1 && (
              <SearchableSelect value={page} onChange={setPage} placeholder="All Pages"
                options={[{ value: "", label: "All Pages" }, ...pages.map(p => ({ value: p.pageId, label: p.name || p.pageId }))]}
                triggerStyle={{ minWidth: 170 }} />
            )}
            <button className="settings-btn" onClick={() => load(true)} disabled={loading}>
              <RefreshCw size={14} style={{ opacity: loading ? .5 : 1 }} /> Refresh
            </button>
          </>} />
        {error && <div style={{ background: C.errBg, color: C.errText, padding: "12px 14px", borderRadius: 12, fontSize: 13.5, marginBottom: 12 }}>{error}</div>}
        {problems.map(p => (
          <div key={p.pageId} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.amberSoft, color: C.amber, padding: "10px 14px", borderRadius: 12, fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ flex: 1 }}><b>{p.name || p.pageId}:</b> {p.error}</span>
            {onOpenIntegrations && <button onClick={onOpenIntegrations} style={{ ...BTN.secondary, padding: "6px 12px", fontSize: 13 }}>Open Integrations</button>}
          </div>
        ))}
      </div>

      {notConfigured ? (
        <EmptyState Icon={MessageCircle} title="Connect a Facebook Page"
          body={'Messenger shows the messages people send to your Facebook Page. Connect the Page in Settings → Integrations → Facebook and allow "Manage and access Page conversations in Messenger".'}
          action={onOpenIntegrations && <button onClick={onOpenIntegrations} style={BTN.primary}>Connect Facebook</button>} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, overflow: "hidden" }}>
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 4px 10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ ...T.label, color: C.textMuted }}>Chats · {conversations.length}</span>
                <button onClick={() => setUnreadOnly(u => !u)}
                  style={{ border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 8, background: unreadOnly ? C.primary : C.surface2, color: unreadOnly ? C.onAccent : C.textSecondary }}>
                  Unread{totalUnread ? ` · ${totalUnread}` : ""}
                </button>
              </div>
              <div className="fc-searchfield" style={FIELD_WRAP}>
                <Search size={14} color={C.textMuted} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name or message" style={BARE_INPUT} />
                {query && <button onClick={() => setQuery("")} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex" }}><X size={13} color={C.textMuted} /></button>}
              </div>
            </div>
            <div data-testid="messenger-list" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {!data && <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>Loading…</div>}
              {data && conversations.length === 0 && (
                <div style={{ padding: "40px 16px", textAlign: "center", color: C.textMuted, fontSize: 14 }}>
                  {(data.conversations || []).length ? "No conversations match." : "No Messenger conversations yet."}
                </div>
              )}
              {conversations.map(c => (
                <ConversationRow key={c.key} c={c} active={c.key === activeKey} onClick={() => setActiveKey(c.key)}
                  showPage={pages.length > 1 && !page} pageName={pageName(c.pageId)} />
              ))}
            </div>
          </div>
          <Thread conv={active} pageName={active ? pageName(active.pageId) : null} onSent={() => load()} />
        </div>
      )}
    </div>
  );
}
