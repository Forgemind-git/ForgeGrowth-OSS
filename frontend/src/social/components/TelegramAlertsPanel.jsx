import { useState, useEffect, useCallback } from "react";
import { Loader2, Send, User, Users, Megaphone, Bell, ExternalLink, CheckCircle2, AlertTriangle } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T, relativeTime } from "../constants.js";
import { Toggle } from "./UI.jsx";
import { showToast } from "../Toast.jsx";

// Comment Analyzer → Telegram alerts. When the analyzer labels a comment as
// negative / abusive / a complaint, the bot sends it to the chats ticked here.
// Only chats approved in Settings → Integrations → Telegram can be picked.

const TYPE_ICON = { private: User, group: Users, supergroup: Users, channel: Megaphone };
const PLAT = { instagram: "Instagram" };
const REASON = { negative: "Negative", toxic: "Abusive", complaint: "Complaint" };
const spin = { animation: "spin 1s linear infinite" };

function Section({ children }) { return <div style={{ background: C.raised, borderRadius: 16, padding: "4px 16px" }}>{children}</div>; }
function Row({ title, sub, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0", boxShadow: `inset 0 -1px 0 ${C.surface2}`, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>{title}</div>
        {sub && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}
const Banner = ({ tone, children }) => (
  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: tone === "ok" ? C.greenSoft : tone === "err" ? C.errBg : C.amberSoft, color: tone === "err" ? C.errText : C.text, borderRadius: 14, padding: "12px 14px", fontSize: 13.5, lineHeight: 1.5 }}>
    {tone === "ok" ? <CheckCircle2 size={16} color={C.green} style={{ flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={16} color={tone === "err" ? C.errText : C.amber} style={{ flexShrink: 0, marginTop: 2 }} />}
    <div>{children}</div>
  </div>
);
const link = { color: C.primary, fontWeight: 650 };

export default function TelegramAlertsPanel() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [tg, setTg] = useState(null);
  const [chats, setChats] = useState(null);
  const [an, setAn] = useState(null);
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState("");

  const loadLog = useCallback(() => api.commentAlerts.log(30).then(d => setLog(d.alerts || [])).catch(() => setLog([])), []);
  useEffect(() => {
    api.commentAlerts.get().then(d => { setS(d.settings); setSaved(d.settings); }).catch(e => showToast(e.message, "error"));
    api.telegram.status().then(setTg).catch(() => setTg({ configured: false }));
    api.telegram.chats().then(d => setChats(d.chats || [])).catch(() => setChats([]));
    api.commentAnalyzer.settings().then(d => setAn(d.settings)).catch(() => setAn(null));
    loadLog();
  }, [loadLog]);

  if (!s) return <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={spin} /></div>;
  const set = (patch) => setS(x => ({ ...x, ...patch }));
  const cmp = (o) => o && JSON.stringify({ ...o, enabledAt: null });
  const dirty = cmp(s) !== cmp(saved);
  const approved = (chats || []).filter(c => c.status === "approved");
  const picked = new Set(s.chatIds);
  const toggleChat = (id) => set({ chatIds: picked.has(id) ? s.chatIds.filter(x => x !== id) : [...s.chatIds, id] });
  const stale = s.chatIds.filter(id => !approved.some(c => c.id === id));

  async function save() {
    setBusy("save");
    try { const d = await api.commentAlerts.save(s); setS(d.settings); setSaved(d.settings); showToast(d.settings.enabled ? "Alerts are on" : "Saved", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  async function test() {
    setBusy("test");
    try {
      const r = await api.commentAlerts.test(s.chatIds.filter(id => approved.some(c => c.id === id)));
      const bad = r.results.filter(x => !x.ok);
      if (bad.length) showToast(`Not delivered to ${bad.length} chat${bad.length > 1 ? "s" : ""}: ${bad[0].error}`, "error");
      else showToast(`Test sent to ${r.results.length} chat${r.results.length > 1 ? "s" : ""}${r.usedRealComment ? " (your latest negative comment)" : ""}`, "success");
    } catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  async function enableAnalyzer() {
    setBusy("an");
    try { const d = await api.commentAnalyzer.saveSettings({ ...an, enabled: true }); setAn(d.settings); showToast("Comment Analyzer is on — new comments are analysed automatically", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }

  const tgOk = tg?.configured && tg.status === "connected";
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", fontFamily: FONT }}>
      <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {tg && !tg.configured && <Banner tone="warn">The Telegram bot isn't connected. Add it in <a href="#/social/integrations/telegram" style={link}>Settings → Integrations → Telegram</a>.</Banner>}
        {tg?.configured && !tgOk && <Banner tone="err">The Telegram bot needs attention: {tg.lastError || "it is not connected"}. <a href="#/social/integrations/telegram" style={link}>Open Telegram settings</a>.</Banner>}
        {an && !an.enabled && (
          <Banner tone="warn">
            Alerts need the Comment Analyzer to label new comments, and it is <b>off</b>. Until it is on, no comment is classified and no alert is sent.
            <div style={{ marginTop: 8 }}><button onClick={enableAnalyzer} disabled={busy === "an"} style={{ ...BTN.primary, padding: "7px 13px", fontSize: 13 }}>{busy === "an" && <Loader2 size={13} style={spin} />}Turn the analyzer on</button></div>
          </Banner>
        )}

        <Section>
          <Row title="Send negative comments to Telegram" sub="Each matching comment is sent once to every chat ticked below — usually within a minute of it being posted on Instagram, within ~10 minutes for other platforms.">
            <Toggle on={s.enabled} onChange={v => set({ enabled: v })} />
          </Row>
          <Row title="Negative comments" sub="Sentiment labelled negative — criticism, complaints, disappointment.">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12.5, color: C.textMuted }}>at least</span>
              <input type="number" min={30} max={99} value={Math.round(s.minConfidence * 100)} disabled={!s.negative}
                onChange={e => set({ minConfidence: Math.min(99, Math.max(30, Number(e.target.value) || 60)) / 100 })}
                style={{ ...INPUT, width: 64, padding: "7px 9px", fontFamily: MONO, fontSize: 13 }} />
              <span style={{ fontSize: 12.5, color: C.textMuted }}>% sure</span>
              <Toggle on={s.negative} onChange={v => set({ negative: v })} />
            </div>
          </Row>
          <Row title="Abusive comments" sub="Hateful, harassing or explicit — sent even if the sentiment reads neutral."><Toggle on={s.toxic} onChange={v => set({ toxic: v })} /></Row>
          <Row title="Every complaint" sub="Also send comments labelled as a complaint, even when they aren't strongly negative."><Toggle on={s.complaint} onChange={v => set({ complaint: v })} /></Row>
          <Row title="Ignore comments older than" sub="Old comments analysed later (a backfill, a re-analysis) are never sent.">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="number" min={1} max={720} value={s.maxAgeHours} onChange={e => set({ maxAgeHours: Number(e.target.value) || 48 })} style={{ ...INPUT, width: 72, padding: "7px 9px", fontFamily: MONO, fontSize: 13 }} />
              <span style={{ fontSize: 12.5, color: C.textMuted }}>hours</span>
            </span>
          </Row>
        </Section>

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 2px 0" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>Send to</div>
          <a href="#/social/integrations/telegram" style={{ ...link, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>Manage chats <ExternalLink size={12} /></a>
        </div>
        <Section>
          {chats == null ? <div style={{ padding: 14 }}><Loader2 size={15} color={C.textMuted} style={spin} /></div>
            : !approved.length ? <div style={{ padding: "16px 0", fontSize: 13.5, color: C.textMuted, lineHeight: 1.55 }}>
                No approved chats yet. Ask each person to open {tg?.bot?.link ? <a href={tg.bot.link} target="_blank" rel="noopener noreferrer" style={link}>t.me/{tg.bot.username}</a> : "the bot"} and press Start (or add the bot to a group), then approve them in <a href="#/social/integrations/telegram" style={link}>Telegram settings</a>.
                {(chats || []).some(c => c.status === "pending") && <> <b>{chats.filter(c => c.status === "pending").length} waiting for approval.</b></>}
              </div>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))", gap: 6, padding: "12px 0" }}>
                {approved.map(c => {
                  const on = picked.has(c.id);
                  const Icon = TYPE_ICON[c.type] || User;
                  return (
                    <div key={c.id} role="checkbox" aria-checked={on} tabIndex={0} onClick={() => toggleChat(c.id)} onKeyDown={e => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggleChat(c.id))}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 12, cursor: "pointer", background: on ? C.primaryFaint : C.card, boxShadow: on ? `inset 0 0 0 1.5px ${C.primary}` : "none" }}>
                      <span style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: on ? C.primary : C.surface2, color: C.onAccent }}>
                        {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>}
                      </span>
                      <Icon size={15} color={C.textSecondary} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                        <div style={{ fontSize: 12, color: c.botMember ? C.textMuted : C.errText }}>{c.botMember ? (c.type === "private" ? "Person" : "Group") + (c.username ? ` · @${c.username}` : "") : "Bot removed — can't deliver"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>}
          {stale.length > 0 && <div style={{ fontSize: 12.5, color: C.amber, padding: "0 0 12px" }}>{stale.length} ticked chat{stale.length > 1 ? "s are" : " is"} no longer approved and won't receive alerts.</div>}
        </Section>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={save} disabled={!dirty || busy === "save"} style={{ ...BTN.primary, opacity: dirty ? 1 : .6 }}>{busy === "save" && <Loader2 size={14} style={spin} />}Save</button>
          {dirty && <button onClick={() => setS(saved)} style={BTN.ghost}>Discard</button>}
          <span style={{ flex: 1 }} />
          <button onClick={test} disabled={!tgOk || !s.chatIds.some(id => approved.some(c => c.id === id)) || busy === "test"} style={BTN.secondary}>
            {busy === "test" ? <Loader2 size={14} style={spin} /> : <Send size={14} />} Send a test alert
          </button>
        </div>
      </div>

      <div style={{ flex: "0 1 360px", minWidth: 280, background: C.raised, borderRadius: 16, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Bell size={15} color={C.textSecondary} />
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1 }}>Recent alerts</div>
          <button onClick={loadLog} style={{ ...BTN.ghost, padding: "3px 8px", fontSize: 12.5 }}>Refresh</button>
        </div>
        {log == null ? <Loader2 size={14} color={C.textMuted} style={spin} />
          : !log.length ? <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>No alerts sent yet. Once alerts are on, every negative comment sent shows here.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {log.map(a => (
                <div key={`${a.platform}|${a.commentId}|${a.chatId}`} style={{ background: C.card, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: C.textMuted, marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 650, color: a.status === "sent" ? C.green : C.errText }}>{a.status === "sent" ? "Sent" : a.status === "gave_up" ? "Gave up" : "Failed"}</span>
                    <span>· {REASON[a.reason] || a.reason} · {PLAT[a.platform] || a.platform} → {a.chatName}</span>
                    <span style={{ marginLeft: "auto" }}>{relativeTime(a.sentAt || a.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: C.text, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.text || <i style={{ color: C.textMuted }}>comment no longer stored</i>}</div>
                  {a.error && <div style={{ fontSize: 12, color: C.errText, marginTop: 4 }}>{a.error}</div>}
                </div>
              ))}
            </div>}
      </div>
    </div>
  );
}
