import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Loader2, Send, Check, Ban, Clock, Trash2, Users, User, Megaphone, ExternalLink, KeyRound, ShieldCheck, MessageSquare, Bell } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T, relativeTime } from "../constants.js";
import { PageHeader, EmptyState } from "../components/UI.jsx";
import { SearchableSelect } from "../components/Dropdown.jsx";
import { showToast } from "../Toast.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";

// Settings → Integrations → Telegram. One bot: its token (replaceable), who may
// talk to it, and every chat it has had — approve/block a chat and read or
// reply to it.

const STATUS = {
  approved: { label: "Approved", bg: C.greenSoft, fg: C.green, Icon: Check },
  pending: { label: "Waiting for approval", bg: C.amberSoft, fg: C.amber, Icon: Clock },
  blocked: { label: "Blocked", bg: C.errBg, fg: C.errText, Icon: Ban },
};
const TYPE_ICON = { private: User, group: Users, supergroup: Users, channel: Megaphone };
const TYPE_LABEL = { private: "Person", group: "Group", supergroup: "Group", channel: "Channel" };
const spin = { animation: "spin 1s linear infinite" };

function Card({ title, Icon, children, right }) {
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 18, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        {Icon && <span style={{ width: 32, height: 32, borderRadius: 10, background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon size={16} /></span>}
        <div style={{ ...T.h3, color: C.text, flex: 1 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function Pill({ status }) {
  const s = STATUS[status] || STATUS.pending;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: s.bg, color: s.fg, fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}><s.Icon size={12} />{s.label}</span>;
}
const Note = ({ children, tone }) => (
  <div style={{ padding: "10px 12px", borderRadius: 12, background: tone === "err" ? C.errBg : tone === "warn" ? C.amberSoft : C.surface, color: tone === "err" ? C.errText : C.textSecondary, fontSize: 13, lineHeight: 1.55, fontWeight: tone === "err" ? 600 : 450 }}>{children}</div>
);

export default function TelegramPage() {
  const [st, setSt] = useState(null);
  const [chats, setChats] = useState(null);
  const [sel, setSel] = useState(null);
  const [ConfirmDialog, confirm] = useConfirm();

  const loadStatus = useCallback(() => api.telegram.status().then(setSt).catch(e => showToast(e.message, "error")), []);
  const loadChats = useCallback(() => api.telegram.chats().then(d => setChats(d.chats || [])).catch(() => {}), []);
  useEffect(() => { loadStatus(); loadChats(); }, [loadStatus, loadChats]);
  // Poll while open — new chats and messages arrive through the bot, not this page.
  useEffect(() => { const t = setInterval(() => { loadChats(); loadStatus(); }, 6000); return () => clearInterval(t); }, [loadChats, loadStatus]);

  const selected = chats?.find(c => c.id === sel) || null;
  return (
    <div style={{ fontFamily: FONT }}>
      {ConfirmDialog}
      <a href="#/social/integrations" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.textSecondary, fontSize: 13.5, fontWeight: 600, textDecoration: "none", marginBottom: 10 }}><ArrowLeft size={14} /> Integrations</a>
      <PageHeader cycle="Telegram bot" sub="Connect a Telegram bot and choose which people and groups it talks to." />
      {!st ? <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={spin} /></div> : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))", gap: 14, marginBottom: 18 }}>
          <ConnectionCard st={st} onChange={(s) => { setSt(s); loadChats(); }} confirm={confirm} />
          <AccessCard st={st} onChange={setSt} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 2px 10px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>Chats</div>
          <span style={{ fontSize: 12.5, color: C.textMuted }}>{st.chats.approved} approved · {st.chats.pending} waiting · {st.chats.blocked} blocked</span>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
          <ChatList chats={chats} sel={sel} onSel={setSel} bot={st.bot} configured={st.configured} />
          <div style={{ flex: "1 1 460px", minWidth: 0 }}>
            {selected ? <ChatViewer key={selected.id} chat={selected} onChanged={() => { loadChats(); loadStatus(); }} onDeleted={() => { setSel(null); loadChats(); loadStatus(); }} confirm={confirm} />
              : <div style={{ background: C.raised, borderRadius: 16, height: "100%", minHeight: 360, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <EmptyState Icon={MessageSquare} title="Pick a chat" body="Everything people send the bot, and every alert it sends, shows up here." />
                </div>}
          </div>
        </div>
      </>}
    </div>
  );
}

function ConnectionCard({ st, onChange, confirm }) {
  const [editing, setEditing] = useState(!st.configured);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState(null);
  useEffect(() => { if (!st.configured) setEditing(true); }, [st.configured]);

  async function save() {
    setBusy("save"); setErr(null);
    try { const s = await api.telegram.connect(token); onChange(s); setToken(""); setEditing(false); showToast(`Connected to @${s.bot?.username}`, "success"); }
    catch (e) { setErr(e.message); }
    finally { setBusy(""); }
  }
  async function disconnect() {
    const ok = await confirm({ title: "Disconnect the Telegram bot?", body: "The token is removed and no more alerts are sent. Chats and their history stay, and come back if you reconnect the same bot.", confirmLabel: "Disconnect", danger: true });
    if (!ok) return;
    setBusy("disc");
    try { onChange(await api.telegram.disconnect()); showToast("Telegram disconnected", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  const ok = st.configured && st.status === "connected";
  return (
    <Card title="Connection" Icon={KeyRound} right={st.configured && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, color: ok ? C.green : C.errText }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: ok ? C.green : C.errText }} />{ok ? "Connected" : "Needs attention"}</span>}>
      {st.configured && st.bot && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12, background: C.surface, marginBottom: 12 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "#229ED92e", color: "#229ED9", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 }}>TG</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text }}>{st.bot.name}</div>
            <div style={{ fontSize: 13, color: C.textSecondary }}>@{st.bot.username} · token <span style={{ fontFamily: MONO, fontSize: 12 }}>{st.tokenMasked}</span></div>
          </div>
          {st.bot.link && <a href={st.bot.link} target="_blank" rel="noopener noreferrer" style={{ ...BTN.secondary, padding: "7px 12px", fontSize: 13, textDecoration: "none" }}><ExternalLink size={13} /> Open</a>}
        </div>
      )}
      {st.configured && st.lastError && <div style={{ marginBottom: 12 }}><Note tone="err">{st.lastError}</Note></div>}
      {st.configured && st.polling === "disabled" && <div style={{ marginBottom: 12 }}><Note tone="warn">Receiving messages is switched off on this server (SOCIAL_TELEGRAM_POLLING=off). Alerts still send; new chats won't appear.</Note></div>}
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 650, color: C.textSecondary, textTransform: "uppercase", letterSpacing: ".04em" }}>Bot token</label>
          <input value={token} onChange={e => setToken(e.target.value)} placeholder="123456789:AAH…" autoComplete="off" name="tg-bot-token" spellCheck={false}
            style={{ ...INPUT, fontFamily: MONO, fontSize: 13 }} onKeyDown={e => e.key === "Enter" && token.trim() && save()} />
          <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.5 }}>From <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: C.primary, fontWeight: 650 }}>@BotFather</a> → your bot → API Token. It is checked with Telegram before it is saved, and stored encrypted.</div>
          {err && <Note tone="err">{err}</Note>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={!token.trim() || busy === "save"} style={{ ...BTN.primary, opacity: !token.trim() ? .6 : 1 }}>{busy === "save" && <Loader2 size={14} style={spin} />}{st.configured ? "Replace token" : "Connect"}</button>
            {st.configured && <button onClick={() => { setEditing(false); setToken(""); setErr(null); }} style={BTN.ghost}>Cancel</button>}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => setEditing(true)} style={BTN.secondary}><KeyRound size={14} /> Change token</button>
          <button onClick={disconnect} disabled={busy === "disc"} style={BTN.danger}>{busy === "disc" && <Loader2 size={14} style={spin} />}Disconnect</button>
        </div>
      )}
    </Card>
  );
}

function AccessCard({ st, onChange }) {
  const [mode, setMode] = useState(st.accessMode);
  const [reply, setReply] = useState(st.pendingReply);
  const [busy, setBusy] = useState(false);
  const dirty = mode !== st.accessMode || reply !== st.pendingReply;
  async function save() {
    setBusy(true);
    try { const s = await api.telegram.saveAccess({ accessMode: mode, pendingReply: reply }); onChange(s); setMode(s.accessMode); setReply(s.pendingReply); showToast("Saved", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <Card title="Who the bot answers" Icon={ShieldCheck}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SearchableSelect value={mode} onChange={setMode} fullWidth options={[
          { value: "approved", label: "Only chats I approve (recommended)" },
          { value: "everyone", label: "Anyone who messages the bot" },
        ]} />
        <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55 }}>
          {mode === "approved"
            ? "A new person or group shows up below as “Waiting for approval”. The bot tells them to wait and does nothing else until you approve them. Blocked chats are never answered."
            : "Anyone who opens the bot is approved straight away and can use its commands."}
        </div>
        {mode === "approved" && <>
          <label style={{ fontSize: 12, fontWeight: 650, color: C.textSecondary, textTransform: "uppercase", letterSpacing: ".04em" }}>Reply to a chat waiting for approval</label>
          <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3} style={{ ...INPUT, resize: "vertical", lineHeight: 1.5 }} />
        </>}
        <Note>
          <b>To add someone:</b> they open {st.bot?.link ? <a href={st.bot.link} target="_blank" rel="noopener noreferrer" style={{ color: C.primary, fontWeight: 650 }}>t.me/{st.bot.username}</a> : "the bot"} and press Start. <b>To add a group:</b> add the bot to the group as a member. Then approve it below.
        </Note>
        <div><button onClick={save} disabled={!dirty || busy} style={{ ...BTN.primary, opacity: dirty ? 1 : .6 }}>{busy && <Loader2 size={14} style={spin} />}Save</button></div>
      </div>
    </Card>
  );
}

function ChatList({ chats, sel, onSel, configured }) {
  const [q, setQ] = useState("");
  const list = (chats || []).filter(c => !q || (c.name + " " + (c.username || "") + " " + c.id).toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ flex: "0 1 340px", minWidth: 280, background: C.raised, borderRadius: 16, padding: 10, display: "flex", flexDirection: "column", maxHeight: 640 }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats" style={{ ...INPUT, marginBottom: 8 }} />
      <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        {chats == null ? <div style={{ padding: 20, textAlign: "center" }}><Loader2 size={15} color={C.textMuted} style={spin} /></div>
          : !list.length ? <div style={{ padding: "26px 12px", textAlign: "center", fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>{chats.length ? "No chat matches." : configured ? "No one has messaged the bot yet. Open the bot in Telegram and press Start." : "Connect the bot first."}</div>
          : list.map(c => {
            const Icon = TYPE_ICON[c.type] || User;
            const on = c.id === sel;
            return (
              <button key={c.id} onClick={() => onSel(c.id)} style={{ textAlign: "left", border: "none", cursor: "pointer", fontFamily: FONT, padding: "10px 11px", borderRadius: 12, background: on ? C.primaryFaint : "transparent", boxShadow: on ? `inset 0 0 0 1.5px ${C.primary}` : "none", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: C.surface2, color: C.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={16} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.name}</span>
                    <span style={{ fontSize: 11.5, color: C.textMuted, flexShrink: 0 }}>{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
                  </span>
                  <span style={{ display: "block", fontSize: 12.5, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: "2px 0 5px" }}>{c.lastDirection === "out" ? "Bot: " : ""}{c.lastText || "—"}</span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><Pill status={c.status} />{!c.botMember && <span style={{ fontSize: 11.5, color: C.errText, fontWeight: 650 }}>bot removed</span>}</span>
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}

function ChatViewer({ chat, onChanged, onDeleted, confirm }) {
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const endRef = useRef(null);
  const lastId = useRef(null);
  const load = useCallback(() => api.telegram.messages(chat.id).then(d => setMsgs(d.messages || [])).catch(e => showToast(e.message, "error")), [chat.id]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const last = msgs?.[msgs.length - 1]?.id;
    if (last && last !== lastId.current) { lastId.current = last; endRef.current?.scrollIntoView({ block: "end" }); }
  }, [msgs]);

  async function setStatus(status) {
    setBusy(status);
    try { await api.telegram.setChat(chat.id, { status }); onChanged(); showToast(status === "approved" ? "Approved — they can now receive alerts" : status === "blocked" ? "Blocked" : "Moved back to waiting", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  async function send() {
    if (!text.trim()) return;
    setBusy("send");
    try { await api.telegram.send(chat.id, text); setText(""); await load(); onChanged(); }
    catch (e) { showToast(e.message, "error"); await load(); }
    finally { setBusy(""); }
  }
  async function remove() {
    const ok = await confirm({ title: `Remove ${chat.name}?`, body: "The chat and its history are deleted here. If they message the bot again they come back as waiting for approval.", confirmLabel: "Remove chat", danger: true });
    if (!ok) return;
    try { await api.telegram.deleteChat(chat.id); onDeleted(); }
    catch (e) { showToast(e.message, "error"); }
  }
  const Icon = TYPE_ICON[chat.type] || User;
  return (
    <div style={{ background: C.raised, borderRadius: 16, display: "flex", flexDirection: "column", height: 640, minWidth: 0 }}>
      <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, background: C.surface2, color: C.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon size={17} /></span>
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{chat.name}</div>
          <div style={{ fontSize: 12.5, color: C.textMuted }}>{TYPE_LABEL[chat.type] || chat.type}{chat.username ? ` · @${chat.username}` : ""} · id <span style={{ fontFamily: MONO }}>{chat.id}</span></div>
        </div>
        <Pill status={chat.status} />
        <div style={{ display: "flex", gap: 6 }}>
          {chat.status !== "approved" && <button onClick={() => setStatus("approved")} disabled={!!busy} style={{ ...BTN.primary, padding: "7px 13px", fontSize: 13 }}>{busy === "approved" ? <Loader2 size={13} style={spin} /> : <Check size={13} />} Approve</button>}
          {chat.status !== "blocked" && <button onClick={() => setStatus("blocked")} disabled={!!busy} style={{ ...BTN.secondary, padding: "7px 13px", fontSize: 13 }}><Ban size={13} /> Block</button>}
          {chat.status === "blocked" && <button onClick={() => setStatus("pending")} disabled={!!busy} style={{ ...BTN.secondary, padding: "7px 13px", fontSize: 13 }}>Unblock</button>}
          <button onClick={remove} aria-label="Remove chat" title="Remove chat" style={{ ...BTN.icon, width: 32, height: 32 }}><Trash2 size={14} /></button>
        </div>
      </div>
      {!chat.botMember && <div style={{ padding: "8px 16px" }}><Note tone="warn">The bot can't reach this chat — it was removed from the group, or the person blocked it. Alerts to it will fail until they add it back.</Note></div>}
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {msgs == null ? <div style={{ margin: "auto" }}><Loader2 size={15} color={C.textMuted} style={spin} /></div>
          : !msgs.length ? <div style={{ margin: "auto", fontSize: 13, color: C.textMuted }}>No messages yet.</div>
          : msgs.map(m => <Bubble key={m.id} m={m} />)}
        <div ref={endRef} />
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8, boxShadow: `inset 0 1px 0 ${C.surface2}` }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={1} disabled={chat.status !== "approved"}
          placeholder={chat.status === "approved" ? "Message as the bot…" : "Approve this chat to message it"}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ ...INPUT, resize: "none", lineHeight: 1.45, minHeight: 42, maxHeight: 120 }} />
        <button onClick={send} disabled={chat.status !== "approved" || !text.trim() || busy === "send"} aria-label="Send" style={{ ...BTN.primary, padding: "0 16px", opacity: chat.status !== "approved" || !text.trim() ? .55 : 1 }}>{busy === "send" ? <Loader2 size={15} style={spin} /> : <Send size={15} />}</button>
      </div>
    </div>
  );
}

function Bubble({ m }) {
  const time = new Date(m.ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  if (m.kind === "system" && m.direction === "in") {
    return <div style={{ alignSelf: "center", fontSize: 12, color: C.textMuted, background: C.surface, padding: "4px 10px", borderRadius: 999 }}>{m.text} · {time}</div>;
  }
  const out = m.direction === "out";
  const alert = m.kind === "alert";
  const failed = m.status === "failed";
  const bg = failed ? C.errBg : alert ? C.pinkSoft : out ? C.primarySoft : C.surface;
  const label = out ? ({ alert: m.meta?.test ? "Test alert" : "Alert", manual: "You", reply: "Bot reply", system: "Bot" }[m.kind] || "Bot") : (m.fromName || "Them");
  return (
    <div style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "78%", minWidth: 0 }}>
      <div style={{ fontSize: 11.5, color: C.textMuted, margin: out ? "0 4px 3px 0" : "0 0 3px 4px", textAlign: out ? "right" : "left", display: "flex", gap: 6, justifyContent: out ? "flex-end" : "flex-start", alignItems: "center" }}>
        {alert && <Bell size={11} />}<span style={{ fontWeight: 650 }}>{label}</span><span>{time}</span>
      </div>
      <div style={{ background: bg, color: failed ? C.errText : C.text, padding: "9px 12px", borderRadius: 14, fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
      {failed && <div style={{ fontSize: 12, color: C.errText, marginTop: 3, textAlign: out ? "right" : "left", fontWeight: 600 }}>Not delivered: {m.error}</div>}
    </div>
  );
}
