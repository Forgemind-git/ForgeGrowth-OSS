import { useState, useEffect, useRef } from "react";
import { Play, Loader2, ExternalLink, Lightbulb, MessageCircleReply, ShieldAlert, Sparkles, X, Plus, RotateCcw, Reply, Send, CheckCheck, Bookmark, BookmarkCheck } from "lucide-react";
import { api } from "../api.js";
import { C, FONT, MONO, BTN, INPUT, T, relativeTime } from "../constants.js";
import { showToast } from "../Toast.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { PageHeader, UnderlineTabs, PlatformPill, Toggle, EmptyState } from "../components/UI.jsx";
import { SearchableSelect, MultiSelect } from "../components/Dropdown.jsx";
import TelegramAlertsPanel from "../components/TelegramAlertsPanel.jsx";

// Comment Analyzer: TypeSafe Jev (via OpenRouter, Settings → OpenRouter) labels
// every comment — sentiment, what the person is doing, insightful / needs reply /
// abusive. Short, keyword (comment-automation) and repeated comments are filtered
// before any call to save tokens; the Settings tab shows exactly what gets sent.

const PLATFORMS = [["instagram", "Instagram"]];
const PLAT_NAME = Object.fromEntries(PLATFORMS);
// Why a commenter has no name: the platform API withheld it (not something we dropped).
const HIDDEN_AUTHOR = {
  instagram: "Instagram doesn't share this commenter's username with the app. It needs Advanced Access for instagram_business_manage_comments (Meta App Review). Live webhook comments and comments you've replied to with @username do show the name.",
};
const SENT = {
  positive: { label: "Positive", bg: C.greenSoft, fg: C.green },
  neutral: { label: "Neutral", bg: C.surface2, fg: C.textSecondary },
  negative: { label: "Negative", bg: C.errBg, fg: C.errText },
};
const CAT = {
  praise: "Praise", question: "Question", lead: "Lead / wants to buy", feedback: "Feedback / idea", complaint: "Complaint",
  request: "Asks for link / DM", spam: "Spam", other: "Other",
};
const REASON = {
  too_short: "Too short", emoji_only: "Emoji only", automation_keyword: "Automation keyword", repeated: "Repeated",
  link: "Contains a link", empty: "Empty",
};
const DAYS = [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "365", label: "Last 12 months" }];

export default function CommentAnalyzerPage({ user }) {
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState("results");
  return (
    <div style={{ fontFamily: FONT }}>
      <PageHeader title="Comment Analyzer" sub="Every comment across your accounts, labelled by AI — what people feel, ask and suggest." />
      {isAdmin && <UnderlineTabs value={tab} onChange={setTab} style={{ marginBottom: 18 }} tabs={[{ id: "results", label: "Results" }, { id: "settings", label: "Settings" }, { id: "alerts", label: "Telegram alerts" }]} />}
      {tab === "results" || !isAdmin ? <Results isAdmin={isAdmin} goSettings={() => setTab("settings")} /> : tab === "alerts" ? <TelegramAlertsPanel /> : <SettingsTab />}
    </div>
  );
}

// ───────────────────────── Results ─────────────────────────
function Results({ isAdmin, goSettings }) {
  const [platform, setPlatform] = useState("");
  const [acc, setAcc] = useState([]);                  // selected account tokens (empty = all)
  const [accounts, setAccounts] = useState([]);
  const [days, setDays] = useState("90");
  const [saved, setSaved] = useState(undefined);       // this user's default view (null = none)
  useEffect(() => {
    api.commentAnalyzer.accounts().then(d => setAccounts(d.accounts || [])).catch(() => {});
    // Own saved view first; otherwise start from the "My accounts" preset (top bar).
    Promise.all([api.commentAnalyzer.view().catch(() => ({ view: null })), api.getScope().catch(() => ({ tokens: [] })), api.commentAnalyzer.accounts().catch(() => ({ accounts: [] }))])
      .then(([d, sc, ac]) => {
        const v = d.view;
        if (v) { setPlatform(v.platform || ""); setAcc(v.accounts || []); setDays(v.days || "90"); }
        else if (sc.tokens?.length) {
          // IG tokens match exactly; single-account platforms map to all of that platform's analyzer accounts.
          const t = new Set(sc.tokens);
          setAcc((ac.accounts || []).filter(a => t.has(a.value) || t.has(a.platform)).map(a => a.value));
        }
        setSaved(v || null);
      });
  }, []);
  const ready = saved !== undefined;
  const account = acc.join(",");
  const current = { platform, accounts: acc, days };
  const isDefault = saved ? JSON.stringify({ platform: saved.platform || "", accounts: saved.accounts || [], days: saved.days || "90" }) === JSON.stringify(current) : false;
  async function saveDefault() {
    try { const d = await api.commentAnalyzer.saveView(current); setSaved(d.view); showToast("Saved as your default view", "success"); }
    catch (e) { showToast(e.message, "error"); }
  }
  async function clearDefault() {
    try { await api.commentAnalyzer.saveView({ clear: true }); setSaved(null); setPlatform(""); setAcc([]); setDays("90"); setPage(0); showToast("Default view cleared", "success"); }
    catch (e) { showToast(e.message, "error"); }
  }
  const [sum, setSum] = useState(null);
  const [f, setF] = useState({ sentiment: "", category: "", flag: "", q: "", status: "done", reason: "" });
  const [list, setList] = useState(null);
  const [page, setPage] = useState(0);
  const [running, setRunning] = useState(false);
  const PAGE = 50;

  const loadSum = () => api.commentAnalyzer.summary({ platform: platform || undefined, account: account || undefined, days }).then(setSum).catch(e => showToast(e.message, "error"));
  const loadList = () => api.commentAnalyzer.results({ platform: platform || undefined, account: account || undefined, days, ...clean(f), limit: PAGE, offset: page * PAGE }).then(setList).catch(e => showToast(e.message, "error"));
  useEffect(() => { if (ready) loadSum(); }, [ready, platform, account, days]);
  useEffect(() => { if (ready) { setList(null); loadList(); } }, [ready, platform, account, days, f, page]);
  useEffect(() => { if (!ready) return; const t = setInterval(loadSum, 60000); return () => clearInterval(t); }, [ready, platform, account, days]);

  async function runNow() {
    setRunning(true);
    try {
      const r = await api.commentAnalyzer.run();
      if (r.busy) showToast("Already running — results appear in a moment", "info");
      else showToast(r.stopped && !r.analyzed ? r.stopped : `Analysed ${r.analyzed}, reused ${r.reused}, skipped ${r.skipped}${r.stopped ? ` · ${r.stopped}` : ""}`, r.stopped && !r.analyzed ? "error" : "success");
      loadSum(); loadList();
    } catch (e) { showToast(e.message, "error"); }
    finally { setRunning(false); }
  }

  const setFilter = (patch) => { setPage(0); setF(x => ({ ...x, ...patch })); };
  const analyzed = sum?.analyzed || 0;
  const pct = (n) => analyzed ? Math.round((n || 0) * 100 / analyzed) : 0;
  const skippedTotal = sum?.skipped || 0;

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <SearchableSelect value={platform} options={PLATFORMS.map(([v, l]) => ({ value: v, label: l }))} onChange={v => { setPage(0); setPlatform(v || ""); setAcc(a => v ? a.filter(t => t.startsWith(v + "|")) : a); }} allLabel="All platforms" label="Platform" />
        <MultiSelect values={acc} options={accounts.filter(a => !platform || a.platform === platform).map(a => ({ value: a.value, label: a.label, group: PLAT_NAME[a.platform] }))}
          onChange={v => { setPage(0); setAcc(v); }} placeholder="All accounts" label="Accounts" />
        <SearchableSelect value={days} options={DAYS} onChange={v => { setPage(0); setDays(v || "90"); }} label="Period" />
        {ready && (isDefault
          ? <span title="Opens with this view every time" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 650, color: C.green, padding: "0 4px" }}>
              <BookmarkCheck size={14} /> Default view
              <button onClick={clearDefault} style={{ ...BTN.ghost, padding: "4px 8px", fontSize: 12.5 }}>Clear</button>
            </span>
          : <button onClick={saveDefault} title="Open the Comment Analyzer with these platforms, accounts and period every time" style={{ ...BTN.ghost, padding: "7px 10px", fontSize: 13, color: C.primary }}>
              <Bookmark size={14} /> {saved ? "Update default view" : "Save as default view"}
            </button>)}
        <span style={{ flex: 1 }} />
        {sum?.lastRun && <span style={{ fontSize: 12.5, color: C.textMuted }}>Last run {relativeTime(sum.lastRun.at)}{sum.pending ? ` · ${sum.pending.toLocaleString("en-IN")} waiting` : ""}</span>}
        {isAdmin && <button onClick={runNow} disabled={running || sum?.running} style={BTN.primary}>{running || sum?.running ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={14} />} Run now</button>}
      </div>

      {sum && analyzed === 0 && skippedTotal === 0 ? (
        <div style={{ background: C.raised, borderRadius: 16 }}>
          <EmptyState Icon={Sparkles} title="No comments analysed yet"
            body={isAdmin ? "Connect OpenRouter in Settings → OpenRouter, turn the analyzer on in the Settings tab, then click Run now. New comments are analysed every 10 minutes." : "An admin needs to turn the analyzer on."}
            action={isAdmin && <button onClick={goSettings} style={BTN.secondary}>Open settings</button>} />
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))", gap: 10, marginBottom: 12 }}>
            <Kpi label="Analysed" value={analyzed} sub={sum?.reused ? `${sum.reused.toLocaleString("en-IN")} reused from repeats` : "comments"} />
            <Kpi label="Positive" value={`${pct(sum?.sentiment?.positive)}%`} sub={`${(sum?.sentiment?.positive || 0).toLocaleString("en-IN")} comments`} color={C.green} onClick={() => setFilter({ status: "done", sentiment: "positive", flag: "", reason: "" })} />
            <Kpi label="Negative" value={`${pct(sum?.sentiment?.negative)}%`} sub={`${(sum?.sentiment?.negative || 0).toLocaleString("en-IN")} comments`} color={C.errText} onClick={() => setFilter({ status: "done", sentiment: "negative", flag: "", reason: "" })} />
            <Kpi label="Insightful" value={sum?.insightful || 0} sub="ideas, corrections, requests" Icon={Lightbulb} color={C.amber} onClick={() => setFilter({ status: "done", flag: "insightful", sentiment: "", reason: "" })} />
            <Kpi label="Need a reply" value={sum?.needs_reply || 0} sub="worth answering" Icon={MessageCircleReply} color={C.blue} onClick={() => setFilter({ status: "done", flag: "needs_reply", sentiment: "", reason: "" })} />
            <Kpi label="Skipped" value={skippedTotal} sub="filtered before AI (no tokens)" onClick={() => setFilter({ status: "skipped", sentiment: "", category: "", flag: "" })} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 10, marginBottom: 16 }}>
            <Panel title="Sentiment over time">
              <SentimentBar s={sum?.sentiment} />
              <Trend rows={sum?.trend || []} />
            </Panel>
            <Panel title="What people are doing">
              <Bars rows={Object.entries(sum?.category || {}).map(([k, n]) => ({ k, label: CAT[k] || k, n }))} total={analyzed} active={f.category}
                onPick={(k) => setFilter({ status: "done", category: f.category === k ? "" : k })} />
            </Panel>
            <Panel title="Skipped before AI">
              {Object.keys(sum?.skipped_by || {}).length === 0 ? <div style={{ fontSize: 13, color: C.textMuted }}>Nothing skipped.</div>
                : <Bars rows={Object.entries(sum.skipped_by).map(([k, n]) => ({ k, label: REASON[k] || k, n }))} total={skippedTotal} muted active={f.status === "skipped" ? f.reason : ""}
                  onPick={(k) => setFilter({ status: "skipped", reason: f.reason === k ? "" : k, sentiment: "", category: "", flag: "" })} />}
            </Panel>
          </div>

          {/* list */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <SearchInput value={f.q} onChange={(q) => setFilter({ q })} />
            {f.status === "done" ? <>
              <SearchableSelect value={f.sentiment} options={Object.entries(SENT).map(([v, x]) => ({ value: v, label: x.label }))} onChange={v => setFilter({ sentiment: v || "" })} allLabel="Any sentiment" label="Sentiment" />
              <SearchableSelect value={f.category} options={Object.entries(CAT).map(([v, l]) => ({ value: v, label: l }))} onChange={v => setFilter({ category: v || "" })} allLabel="Any type" label="Type" />
              <SearchableSelect value={f.flag} options={[{ value: "insightful", label: "Insightful" }, { value: "needs_reply", label: "Needs a reply" }, { value: "toxic", label: "Abusive" }]} onChange={v => setFilter({ flag: v || "" })} allLabel="Any" label="Flag" />
            </> : <SearchableSelect value={f.reason} options={Object.entries(REASON).map(([v, l]) => ({ value: v, label: l }))} onChange={v => setFilter({ reason: v || "" })} allLabel="Any reason" label="Reason" />}
            <SearchableSelect value={f.status} options={[{ value: "done", label: "Analysed" }, { value: "skipped", label: "Skipped" }]} onChange={v => setFilter({ status: v || "done", sentiment: "", category: "", flag: "", reason: "" })} label="Show" />
            <span style={{ flex: 1 }} />
            {list && <span style={{ fontSize: 13, color: C.textMuted }}><b style={{ color: C.text, fontFamily: MONO }}>{list.total.toLocaleString("en-IN")}</b> comments</span>}
          </div>

          <div style={{ background: C.raised, borderRadius: 16, overflow: "hidden" }}>
            {!list && <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /></div>}
            {list && list.rows.length === 0 && <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No comments match.</div>}
            {list?.rows.map(r => <CommentRow key={r.platform + r.commentId} r={r} />)}
          </div>
          {list && list.total > PAGE && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, marginTop: 12 }}>
              <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={BTN.secondary}>Previous</button>
              <span style={{ fontSize: 13, color: C.textMuted }}>Page {page + 1} of {Math.ceil(list.total / PAGE)}</span>
              <button disabled={(page + 1) * PAGE >= list.total} onClick={() => setPage(p => p + 1)} style={BTN.secondary}>Next</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null));

function SearchInput({ value, onChange }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const t = setTimeout(() => v !== value && onChange(v), 350); return () => clearTimeout(t); }, [v]);
  return <input value={v} onChange={e => setV(e.target.value)} placeholder="Search comments" aria-label="Search comments" style={{ ...INPUT, flex: "1 1 200px", width: "auto", maxWidth: 300 }} />;
}

function Kpi({ label, value, sub, color, Icon, onClick }) {
  return (
    <div onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={e => onClick && e.key === "Enter" && onClick()}
      className={onClick ? "ca-kpi" : undefined} style={{ background: C.raised, borderRadius: 16, padding: "14px 16px", cursor: onClick ? "pointer" : "default", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 650, color: C.textMuted }}>{Icon && <Icon size={13} color={color} />}{label}</div>
      <div style={{ ...T.metricSm, color: color || C.text, marginTop: 6 }}>{typeof value === "number" ? value.toLocaleString("en-IN") : value}</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{sub}</div>
      <style>{".ca-kpi:hover{background:var(--fc-surface) !important}"}</style>
    </div>
  );
}
function Panel({ title, children }) {
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: 16, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}
function SentimentBar({ s = {} }) {
  const tot = (s.positive || 0) + (s.neutral || 0) + (s.negative || 0);
  if (!tot) return <div style={{ fontSize: 13, color: C.textMuted }}>No data yet.</div>;
  return (
    <>
      <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", background: C.surface2 }}>
        {["positive", "neutral", "negative"].map(k => s[k] ? <div key={k} title={`${SENT[k].label}: ${s[k]}`} style={{ width: `${s[k] * 100 / tot}%`, background: SENT[k].fg }} /> : null)}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        {["positive", "neutral", "negative"].map(k => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: C.textSecondary }}>
            <i style={{ width: 8, height: 8, borderRadius: "50%", background: SENT[k].fg }} />{SENT[k].label} <b style={{ fontFamily: MONO, color: C.text }}>{Math.round((s[k] || 0) * 100 / tot)}%</b>
          </span>
        ))}
      </div>
    </>
  );
}
function Trend({ rows }) {
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map(r => r.positive + r.neutral + r.negative), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 90, marginTop: 14 }}>
      {rows.slice(-45).map(r => {
        const t = r.positive + r.neutral + r.negative;
        return (
          <div key={r.day} title={`${r.day}: ${r.positive} positive · ${r.neutral} neutral · ${r.negative} negative`} style={{ flex: 1, minWidth: 3, height: `${Math.max(4, t * 100 / max)}%`, display: "flex", flexDirection: "column-reverse", borderRadius: 3, overflow: "hidden" }}>
            {["positive", "neutral", "negative"].map(k => r[k] ? <div key={k} style={{ height: `${r[k] * 100 / t}%`, background: SENT[k].fg }} /> : null)}
          </div>
        );
      })}
    </div>
  );
}
function Bars({ rows, total, onPick, active, muted }) {
  const max = Math.max(...rows.map(r => r.n), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.sort((a, b) => b.n - a.n).map(r => (
        <div key={r.k} onClick={() => onPick?.(r.k)} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && onPick?.(r.k)}
          style={{ cursor: "pointer", opacity: active && active !== r.k ? .5 : 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.text, fontWeight: active === r.k ? 700 : 550 }}>
            <span>{r.label}</span><span style={{ fontFamily: MONO, color: C.textSecondary }}>{r.n.toLocaleString("en-IN")} · {total ? Math.round(r.n * 100 / total) : 0}%</span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: C.surface2, marginTop: 4 }}>
            <div style={{ width: `${r.n * 100 / max}%`, height: "100%", borderRadius: 999, background: muted ? C.textMuted : C.primary }} />
          </div>
        </div>
      ))}
    </div>
  );
}
function Pill({ bg, fg, children, title }) {
  return <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 650, padding: "3px 9px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>;
}
// Reply through the same endpoint as the Inbox.
function sendReply(r, text) {
  return api.replyInstagramComment(r.commentId, { accountId: r.accountId, message: text });
}

function CommentRow({ r }) {
  const s = SENT[r.sentiment];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState([]);
  const replied = r.replied || sent.length > 0;
  async function submit() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await sendReply(r, t); setSent(x => [...x, t]); setText(""); setOpen(false); showToast("Reply sent", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 16px", boxShadow: `inset 0 -1px 0 ${C.surface2}`, alignItems: "flex-start" }}>
      {r.postThumbnail ? <img src={r.postThumbnail} alt="" loading="lazy" style={{ width: 44, height: 44, borderRadius: 10, objectFit: "cover", flexShrink: 0, background: C.surface2 }} onError={e => { e.currentTarget.style.visibility = "hidden"; }} />
        : <div style={{ width: 44, height: 44, borderRadius: 10, background: C.surface2, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12.5, color: C.textMuted }}>
          {r.author
            ? <b style={{ color: C.text, fontSize: 13.5 }}>{r.platform === "instagram" ? "@" + r.author : r.author}</b>
            : <b style={{ color: C.textSecondary, fontSize: 13.5 }} title={HIDDEN_AUTHOR[r.platform] || ""}>{(PLAT_NAME[r.platform] || "Social") + " user"}</b>}
          <span>·</span><span>{r.ts ? relativeTime(r.ts) : ""}</span>
          {r.parentId && <><span>·</span><span>reply</span></>}
        </div>
        <div style={{ fontSize: 14, color: C.text, marginTop: 3, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.text}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
          <PlatformPill platform={r.platform} />
          {r.status === "skipped" ? <Pill bg={C.surface2} fg={C.textSecondary}>Skipped · {REASON[r.skipReason] || r.skipReason}</Pill> : <>
            {s && <Pill bg={s.bg} fg={s.fg} title={r.sentimentConf != null ? `${Math.round(r.sentimentConf * 100)}% likely` : ""}>{s.label}</Pill>}
            {r.category && <Pill bg={C.surface2} fg={C.text} title={r.categoryConf != null ? `${Math.round(r.categoryConf * 100)}% likely` : ""}>{CAT[r.category] || r.category}</Pill>}
            {r.insightful >= 0.7 && <Pill bg={C.amberSoft} fg={C.amber}><Lightbulb size={11} /> Insightful</Pill>}
            {r.needsReply >= 0.7 && <Pill bg={C.blueSoft} fg={C.blue}><MessageCircleReply size={11} /> Needs reply</Pill>}
            {r.toxic >= 0.7 && <Pill bg={C.errBg} fg={C.errText}><ShieldAlert size={11} /> Abusive</Pill>}
            {r.reused && <span title="Same text as an earlier comment — its result was reused (no tokens)" style={{ fontSize: 11.5, color: C.textMuted }}>reused</span>}
          </>}
        </div>
        {r.postCaption && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>On: {r.postCaption}</div>}
        {sent.map((t, i) => (
          <div key={i} style={{ marginTop: 8, padding: "7px 11px", borderRadius: 12, background: C.primarySoft, color: C.text, fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <b style={{ color: C.primary, fontSize: 12 }}>You replied · </b>{t}
          </div>
        ))}
        {open && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" }}>
            <textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={`Reply to ${r.author ? (r.platform === "instagram" ? "@" + r.author : r.author) : "this comment"}…`}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") setOpen(false); }}
              style={{ ...INPUT, flex: 1, resize: "vertical", lineHeight: 1.4, fontSize: 13.5 }} />
            <button onClick={submit} disabled={!text.trim() || busy} style={{ ...BTN.primary, padding: "9px 14px" }}>{busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={14} />} Send</button>
            <button onClick={() => setOpen(false)} aria-label="Cancel reply" style={{ ...BTN.icon, width: 34, height: 34 }}><X size={14} /></button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
        {replied && !open && <span title="You've replied to this comment" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 650, color: C.green }}><CheckCheck size={13} /> Replied</span>}
        {!open && <button onClick={() => setOpen(true)} style={{ ...BTN.secondary, padding: "6px 12px", fontSize: 13 }}><Reply size={13} /> Reply</button>}
      </div>
      {r.postPermalink && <a href={r.postPermalink} target="_blank" rel="noreferrer" title="Open post" aria-label="Open post" style={{ ...BTN.icon, width: 30, height: 30, textDecoration: "none" }}><ExternalLink size={14} /></a>}
    </div>
  );
}

// ───────────────────────── Settings ─────────────────────────
function SettingsTab() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [pv, setPv] = useState(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [busy, setBusy] = useState("");
  const [or, setOr] = useState(null);
  const [accts, setAccts] = useState(null);
  const [ConfirmDialog, confirm] = useConfirm();
  const seq = useRef(0);

  useEffect(() => {
    api.commentAnalyzer.settings().then(d => { setS(d.settings); setSaved(d.settings); }).catch(e => showToast(e.message, "error"));
    api.openRouter.status().then(setOr).catch(() => setOr({ connected: false }));
    api.commentAnalyzer.accounts().then(d => setAccts(d.accounts || [])).catch(() => setAccts([]));
  }, []);
  // live preview of what these (unsaved) settings would send
  useEffect(() => {
    if (!s) return;
    const id = ++seq.current;
    setPvBusy(true);
    const t = setTimeout(() => api.commentAnalyzer.preview(s).then(d => id === seq.current && setPv(d)).catch(() => {}).finally(() => id === seq.current && setPvBusy(false)), 450);
    return () => clearTimeout(t);
  }, [s]);

  if (!s) return <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={16} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /></div>;
  const set = (patch) => setS(x => ({ ...x, ...patch }));
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);

  async function save() {
    setBusy("save");
    try { const d = await api.commentAnalyzer.saveSettings(s); setS(d.settings); setSaved(d.settings); showToast("Settings saved", "success"); }
    catch (e) { showToast(e.message, "error"); }
    finally { setBusy(""); }
  }
  async function reset(scope) {
    const ok = await confirm(scope === "all"
      ? { title: "Re-analyse everything?", body: "All results are cleared and every comment goes through the filters again. Comments that pass are sent to the AI again, which costs tokens.", confirmLabel: "Clear all results", danger: true }
      : { title: "Re-check skipped comments?", body: "Comments that were skipped are checked again with the current settings. Any that now pass will be analysed on the next run.", confirmLabel: "Re-check" });
    if (!ok) return;
    try { const r = await api.commentAnalyzer.reset(scope); showToast(`${r.removed.toLocaleString("en-IN")} results cleared`, "success"); setS(x => ({ ...x })); }
    catch (e) { showToast(e.message, "error"); }
  }
  const addKw = (k) => { const n = String(k || "").trim().toLowerCase(); if (n && !s.keywords.includes(n)) set({ keywords: [...s.keywords, n] }); };

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      {ConfirmDialog}
      <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {or && !or.connected && (
          <div style={{ background: C.amberSoft, color: C.text, borderRadius: 14, padding: "12px 14px", fontSize: 13.5 }}>
            OpenRouter isn't connected. Add the API key in <a href="#/social/settings/openrouter" style={{ color: C.primary, fontWeight: 650 }}>Settings → OpenRouter</a>.
          </div>
        )}
        <Section>
          <Row title="Analyse new comments automatically" sub="Runs every 10 minutes on comments that haven't been analysed yet.">
            <Toggle on={s.enabled} onChange={v => set({ enabled: v })} />
          </Row>
          <Row title="Model" sub="TypeSafe Jev returns labels with probabilities, not text — fast and very cheap.">
            <input value={s.model} onChange={e => set({ model: e.target.value })} aria-label="Model" style={{ ...INPUT, width: 220, fontFamily: MONO, fontSize: 13 }} />
          </Row>
          <Row title="Look back" sub="Older comments are never analysed.">
            <Num value={s.sinceDays} onChange={v => set({ sinceDays: v })} suffix="days" />
          </Row>
          <Row title="Daily limit" sub="Stops for the day after this many AI calls.">
            <Num value={s.dailyLimit} onChange={v => set({ dailyLimit: v })} suffix="calls" width={90} />
          </Row>
          <Row title="Analyse Instagram DMs" sub="Labels each conversation from the person's last 5 messages, again whenever they write. Powers the sentiment filter in Inbox → Messages. Message text is sent to OpenRouter / TypeSafe for labelling.">
            <Toggle on={s.analyzeDms} onChange={v => set({ analyzeDms: v })} />
          </Row>
          <Row title="Send the post caption too" sub="Better labels (adds a few tokens per comment).">
            <Toggle on={s.includeCaption} onChange={v => set({ includeCaption: v })} />
          </Row>
        </Section>

        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "6px 2px 0" }}>Accounts to analyse</div>
        <AccountPicker accounts={accts} selected={s.accounts} onChange={(list) => set({ accounts: list })} />

        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "6px 2px 0" }}>Skip these comments (no tokens)</div>
        <Section>
          <Row title="Fewer words than" sub={`“nice”, “super bro” are skipped; comments with ${s.minWords}+ words are analysed.`}>
            <Num value={s.minWords} onChange={v => set({ minWords: v })} suffix="words" />
          </Row>
          <Row title="Emoji-only comments"><Toggle on={s.skipEmojiOnly} onChange={v => set({ skipEmojiOnly: v })} /></Row>
          <Row title="Comments with a link" sub="Usually spam or self-promotion."><Toggle on={s.skipLinks} onChange={v => set({ skipLinks: v })} /></Row>
          <Row title="Comment-automation keywords" sub={`Short comments (up to ${s.keywordMaxWords} words) that contain a keyword your automations react to, like “link” or “price pls”.`}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Num value={s.keywordMaxWords} onChange={v => set({ keywordMaxWords: v })} suffix="words max" width={56} />
              <Toggle on={s.skipAutomationKeywords} onChange={v => set({ skipAutomationKeywords: v })} />
            </div>
          </Row>
          <div style={{ padding: "4px 0 12px" }}>
            {s.skipAutomationKeywords && pv?.keywords?.length > 0 && (
              <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 8 }}>From your automations: {pv.keywords.filter(k => !s.keywords.includes(k)).join(", ") || "—"}</div>
            )}
            <KeywordInput values={s.keywords} onAdd={addKw} onRemove={(k) => set({ keywords: s.keywords.filter(x => x !== k) })} />
            {pv?.topRepeated?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 6 }}>Most repeated short comments — click to add as a keyword:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {pv.topRepeated.filter(t => !s.keywords.includes(t.text)).map(t => (
                    <button key={t.text} onClick={() => addKw(t.text)} style={{ ...BTN.secondary, padding: "4px 10px", fontSize: 12.5 }}>
                      <Plus size={12} /> {t.text} <span style={{ fontFamily: MONO, color: C.textMuted }}>{t.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Row title="Repeated comments" sub={`Same text ${s.repeatThreshold}+ times.`}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Num value={s.repeatThreshold} onChange={v => set({ repeatThreshold: v })} suffix="times" width={56} />
              <SearchableSelect value={s.repeated} onChange={v => set({ repeated: v })} minWidth={180} options={[
                { value: "reuse", label: "Analyse once, reuse" }, { value: "skip", label: "Skip them" }, { value: "analyze", label: "Analyse every one" }]} />
            </div>
          </Row>
        </Section>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={save} disabled={!dirty || busy === "save"} style={BTN.primary}>{busy === "save" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : null} Save settings</button>
          {dirty && <button onClick={() => setS(saved)} style={BTN.ghost}>Discard</button>}
          <span style={{ flex: 1 }} />
          <button onClick={() => reset("skipped")} style={BTN.secondary}><RotateCcw size={14} /> Re-check skipped</button>
          <button onClick={() => reset("all")} style={BTN.ghost}>Re-analyse all</button>
        </div>
      </div>

      {/* preview */}
      <div style={{ flex: "0 1 320px", minWidth: 260, position: "sticky", top: 12, background: C.raised, borderRadius: 16, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1 }}>With these settings</div>
          {pvBusy && <Loader2 size={13} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} />}
        </div>
        {!pv ? <div style={{ fontSize: 13, color: C.textMuted }}>Calculating…</div> : <>
          <div style={{ fontSize: 12.5, color: C.textMuted }}>Comments in the last {s.sinceDays} days</div>
          <div style={{ ...T.metricSm, color: C.text, marginBottom: 12 }}>{pv.total.toLocaleString("en-IN")}</div>
          <PvRow label="Sent to AI" n={pv.send} total={pv.total} strong />
          <PvRow label="Repeats reusing a result" n={pv.reused} total={pv.total} />
          {Object.entries(pv.skipped).sort((a, b) => b[1] - a[1]).map(([k, n]) => <PvRow key={k} label={`Skipped · ${REASON[k] || k}`} n={n} total={pv.total} muted />)}
          {pv.dms && <PvRow label="DM conversations" n={pv.dms.conversations} total={Math.max(pv.dms.conversations, pv.total)} strong />}
          <div style={{ boxShadow: `inset 0 1px 0 ${C.surface2}`, marginTop: 12, paddingTop: 12 }}>
            <div style={{ fontSize: 12.5, color: C.textMuted }}>Estimated cost for these</div>
            {(() => { const v = pv.estInr + (pv.dms?.estInr || 0); return <div style={{ ...T.metricSm, color: C.text }}>₹{v < 100 ? v.toFixed(2) : v.toFixed(0)}</div>; })()}
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>≈ ₹{(pv.perCallUsd * pv.inrRate).toFixed(4)} per comment · ${pv.estUsd.toFixed(4)}</div>
          </div>
        </>}
      </div>
    </div>
  );
}

// Pick the accounts (per platform) the analyzer runs on. `selected` null = every account.
function AccountPicker({ accounts, selected, onChange }) {
  if (!accounts) return <Section><div style={{ padding: 14 }}><Loader2 size={15} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} /></div></Section>;
  const all = accounts.map(a => a.value);
  const sel = new Set(selected ?? all);
  const toggle = (vals, on) => { const n = new Set(sel); vals.forEach(v => on ? n.add(v) : n.delete(v)); onChange(all.filter(v => n.has(v))); };
  return (
    <Section>
      {PLATFORMS.map(([p, name]) => {
        const list = accounts.filter(a => a.platform === p);
        if (!list.length) return null;
        const onCount = list.filter(a => sel.has(a.value)).length;
        return (
          <div key={p} style={{ padding: "12px 0", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <PlatformPill platform={p} />
              <span style={{ fontSize: 12.5, color: C.textMuted, flex: 1 }}>{onCount} of {list.length} selected</span>
              <button onClick={() => toggle(list.map(a => a.value), onCount < list.length)} style={{ ...BTN.ghost, padding: "3px 8px", fontSize: 12.5 }}>{onCount < list.length ? "Select all" : "Clear"}</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))", gap: 6 }}>
              {list.map(a => {
                const on = sel.has(a.value);
                return (
                  <div key={a.value} role="checkbox" aria-checked={on} tabIndex={0} onClick={() => toggle([a.value], !on)} onKeyDown={e => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle([a.value], !on))}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: 12, cursor: "pointer", background: on ? C.primaryFaint : C.card, boxShadow: on ? `inset 0 0 0 1.5px ${C.primary}` : "none" }}>
                    <span style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", background: on ? C.primary : C.surface2, color: C.onAccent }}>
                      {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 650, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>{a.comments.toLocaleString("en-IN")} comments · {a.recent.toLocaleString("en-IN")} in 30 days{a.hidden ? " · hidden in Inbox" : ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 12, color: C.textMuted, padding: "10px 0" }}>Only comments on the selected accounts are analysed. Results already saved for other accounts stay visible.</div>
    </Section>
  );
}

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
function Num({ value, onChange, suffix, width = 64 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input type="number" value={value} min={0} onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} style={{ ...INPUT, width, padding: "7px 9px", fontFamily: MONO, fontSize: 13 }} />
      {suffix && <span style={{ fontSize: 12.5, color: C.textMuted, whiteSpace: "nowrap" }}>{suffix}</span>}
    </span>
  );
}
function KeywordInput({ values, onAdd, onRemove }) {
  const [v, setV] = useState("");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", background: C.card, borderRadius: 12, padding: 8 }}>
      {values.map(k => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "4px 5px 4px 10px", borderRadius: 999, background: C.primarySoft, color: C.primary, fontSize: 12.5, fontWeight: 650 }}>
          {k}<button onClick={() => onRemove(k)} aria-label={`Remove ${k}`} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", display: "inline-flex", padding: 2 }}><X size={12} /></button>
        </span>
      ))}
      <input value={v} onChange={e => setV(e.target.value)} placeholder={values.length ? "Add keyword" : "Your own keywords, e.g. link, price, interested"}
        onKeyDown={e => { if ((e.key === "Enter" || e.key === ",") && v.trim()) { e.preventDefault(); onAdd(v); setV(""); } if (e.key === "Backspace" && !v && values.length) onRemove(values[values.length - 1]); }}
        onBlur={() => { if (v.trim()) { onAdd(v); setV(""); } }}
        style={{ border: "none", outline: "none", background: "transparent", flex: "1 1 160px", fontSize: 13.5, color: C.text, fontFamily: FONT, padding: "4px 4px" }} />
    </div>
  );
}
function PvRow({ label, n, total, strong, muted }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: strong ? C.text : C.textSecondary, fontWeight: strong ? 700 : 550 }}>
        <span>{label}</span><span style={{ fontFamily: MONO }}>{n.toLocaleString("en-IN")}</span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: C.surface2, marginTop: 4 }}>
        <div style={{ width: `${total ? n * 100 / total : 0}%`, height: "100%", borderRadius: 999, background: strong ? C.primary : muted ? C.textMuted : C.blue }} />
      </div>
    </div>
  );
}
