import { useState, useEffect } from "react";
import { Plus, Send, Calendar as CalIcon, List as ListIcon, ChevronLeft, ChevronRight, Ban, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { usePublishJobs } from "../hooks/usePublishJobs.js";
import { C, T, BTN, FONT, MONO, relativeTime } from "../constants.js";
import { PageHeader, Card, Badge, PlatformBadge, DataQualityBadge, PillTabs, EmptyState } from "../components/UI.jsx";
import { SearchableSelect, MultiSelect } from "../components/Dropdown.jsx";
import { useScope } from "../components/scope/scopeStore.js";
import DefaultViewButton from "../components/scope/DefaultViewButton.jsx";
import { PLATFORMS, PLATFORM_ORDER } from "../data/mockData.js";
import { useConfirm } from "../ConfirmDialog.jsx";
import { showToast } from "../Toast.jsx";
import ComposerModal from "../components/ComposerModal.jsx";
import { postTypeDef } from "../data/postTypes.js";

// Status chips: tinted fill + colour text. Canceled/draft sit on the neutral surface-2.
const STATUS_STYLE = {
  draft:          { label: "Draft",        bg: C.surface2,   color: C.textSecondary },
  pending_review: { label: "Needs review", bg: C.purpleSoft, color: C.purple },
  rejected:       { label: "Rejected",     bg: C.errBg,      color: C.errText },
  queued:         { label: "Queued",       bg: C.amberSoft,  color: C.amber },
  publishing:     { label: "Publishing",   bg: C.blueSoft,   color: C.blue, pulse: true },
  published:      { label: "Published",    bg: C.greenSoft,  color: C.green },
  failed:         { label: "Failed",       bg: C.errBg,      color: C.errText },
  canceled:       { label: "Canceled",     bg: C.surface2,   color: C.textMuted },
};

// The date a job sits on in the calendar: scheduled time, else published, else created.
const jobDate = (j) => j.scheduledAt && j.scheduleType === "scheduled" ? j.scheduledAt : (j.publishedAt || j.createdAt);
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
// FilterPill options are status labels; map back to the status value for the query.
const STATUS_FILTERS = Object.values(STATUS_STYLE).map(s => s.label);
const labelToStatus = (lbl) =>
  Object.keys(STATUS_STYLE).find(k => STATUS_STYLE[k].label === lbl) || null;

const th = { textAlign: "left", padding: "10px 14px", ...T.label, color: C.textSecondary, whiteSpace: "nowrap" };
const td = { padding: "10px 14px", verticalAlign: "middle" };
// 30px round icon button for row actions; hover moves the FILL only.
const iconBtn = { ...BTN.icon, width: 30, height: 30 };
const smallPill = { padding: "6px 12px", borderRadius: 999, border: "none", fontSize: 12.5, fontWeight: 650, fontFamily: FONT, cursor: "pointer", whiteSpace: "nowrap" };

export default function PublishPage({ user }) {
  const isAdmin = user?.role === "admin";
  const [statusLabel, setStatusLabel] = useState(null);   // FilterPill value (label) or null = All
  const [view, setView] = useState("list");               // 'list' | 'calendar'
  const [showComposer, setShowComposer] = useState(false);
  const [composerDate, setComposerDate] = useState(null);  // prefill scheduled date from a calendar click
  const [ConfirmDialog, confirm] = useConfirm();

  // List view honours the status filter; calendar always shows everything.
  const { data, loading, error, refetch } =
    usePublishJobs({ status: view === "list" && statusLabel ? labelToStatus(statusLabel) : undefined });
  // Accounts filter — starts from the "My accounts" preset (Instagram per account, other platforms whole).
  const scope = useScope();
  const [acc, setAcc] = useState([]);
  useEffect(() => { if (scope.loaded) setAcc(scope.tokens); }, [scope.loaded, scope.tokens.join(",")]);
  const accOpts = [];
  for (const p of PLATFORM_ORDER) {
    const list = scope.accounts.filter(a => a.platform === p);
    if (!list.length) continue;
    if (p === "instagram") for (const a of list) accOpts.push({ value: `instagram|${a.accountId}`, label: a.username ? `@${a.username}` : a.label, group: "Instagram" });
    else accOpts.push({ value: p, label: list[0].label || PLATFORMS[p]?.name, group: PLATFORMS[p]?.name });
  }
  const jobToken = (j) => j.platform === "instagram" ? `instagram|${j.accountId}` : j.platform;
  const jobs = (data || []).filter(j => !acc.length || acc.includes(jobToken(j)));

  const openComposer = (dateIso = null) => { setComposerDate(dateIso); setShowComposer(true); };

  const promoteJob = async (j) => {
    try { await api.promotePublishJob(j.id); showToast("Draft queued for publishing", "success"); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  };
  const approveJob = async (j) => {
    try { await api.approvePublishJob(j.id); showToast("Approved — publishing", "success"); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  };
  const rejectJob = async (j) => {
    const ok = await confirm({ title: "Reject this post?", body: `${j.accountLabel || j.platform}: it won't be published. The author can see it was rejected.`, confirmLabel: "Reject", danger: true });
    if (!ok) return;
    try { await api.rejectPublishJob(j.id); showToast("Post rejected", "success"); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  };

  const cancelJob = async (j) => {
    const ok = await confirm({ title: "Cancel this post?", body: `The ${j.postType} to ${j.accountLabel || j.platform} will not be published.`, confirmLabel: "Cancel post", danger: true });
    if (!ok) return;
    try { await api.cancelPublishJob(j.id); showToast("Post canceled", "success"); refetch(); }
    catch (e) { showToast(e.message, "error"); }
  };
  const deleteJob = async (j) => {
    const livePost = j.status === "published" && !j.simulated;
    const isIg = j.platform === "instagram";
    const ok = await confirm(livePost
      ? (isIg
          ? { title: "Delete this post?",
              body: "Instagram doesn't allow deleting posts via API, so this removes it from ForgeGrowth only. Remove it in the Instagram app and ForgeGrowth will sync it out automatically.",
              confirmLabel: "Remove from ForgeGrowth", danger: true }
          : { title: "Delete this post?",
              body: `This permanently deletes the post on ${j.platform} and removes it from ForgeGrowth (log + Content Library). This can't be undone.`,
              confirmLabel: "Delete post", danger: true })
      : { title: "Delete log entry?", body: "This removes it from the log permanently.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      const r = await api.deletePublishJob(j.id);
      if (livePost && r?.platformDeleted) showToast(`Post deleted from ${j.platform}`, "success");
      else if (livePost && r?.alreadyGone) showToast(`Post was already removed on ${j.platform} — cleared from ForgeGrowth`, "success");
      else if (livePost && r?.reason) showToast(r.reason, "info");
      else showToast(livePost ? "Post removed from ForgeGrowth" : "Entry deleted", "success");
      refetch();
    } catch (e) {
      // 400 = platform refused the delete (post kept so it won't falsely vanish).
      showToast(e.message, "error");
    }
  };

  const hoverFill = {
    onMouseEnter: e => { e.currentTarget.style.background = C.surface2; },
    onMouseLeave: e => { e.currentTarget.style.background = C.surface; },
  };

  return (
    <div>
      {ConfirmDialog}
      <PageHeader cycle="Distribution" title="Publish"
        right={<>
          <DefaultViewButton tokens={acc} />
          <MultiSelect label="Accounts" values={acc} options={accOpts} onChange={setAcc} placeholder="All" />
          <ViewToggle view={view} setView={setView} />
          {view === "list" && <SearchableSelect label="Status" value={statusLabel} options={STATUS_FILTERS} onChange={setStatusLabel} allLabel="All" />}
          <button onClick={() => openComposer()} style={BTN.primary}><Plus size={15} strokeWidth={2.4} /> New Post</button>
        </>} />

      {error && <div style={{ background: C.errBg, color: C.errText, padding: '12px 14px', borderRadius: 12, fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {view === "calendar" ? (
        <CalendarView jobs={jobs} onPickDay={(iso) => openComposer(iso)} />
      ) : loading && !data ? (
        <Card><div style={{ color: C.textMuted, fontSize: 14, padding: 20 }}>Loading…</div></Card>
      ) : jobs.length === 0 ? (
        <Card style={{ padding: "24px 20px" }}>
          <EmptyState Icon={Send} title={(data || []).length ? "No posts for these accounts" : "No posts yet"}
            body={(data || []).length ? `${(data || []).length} post${(data || []).length === 1 ? " is" : "s are"} on other accounts. Change the Accounts filter to see ${(data || []).length === 1 ? "it" : "them"}.` : "Create your first post to any connected platform."}
            action={<button onClick={() => setShowComposer(true)} style={BTN.primary}><Plus size={15} strokeWidth={2.4} /> New Post</button>} />
        </Card>
      ) : (
        // The table sits directly on the pane: the raised header strip + row hover are
        // what separate it, so it must not be wrapped in a raised card.
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontFamily: FONT }}>
            <thead>
              <tr>
                {["Platform", "Account", "Type", "Status", "Schedule", "Created", "Error", ""].map((h, i) => <th key={i} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => {
                const s = STATUS_STYLE[j.status] || STATUS_STYLE.queued;
                const def = postTypeDef(j.platform, j.postType);
                const canCancel = j.status === "queued";
                return (
                  <tr key={j.id}>
                    <td style={td}><PlatformBadge platform={j.platform} /></td>
                    <td style={{ ...td, fontSize: 14, color: C.text, fontWeight: 650, whiteSpace: "nowrap" }}>{j.accountLabel || "—"}</td>
                    <td style={{ ...td, fontSize: 13.5, color: C.textSecondary }}>{def?.label || j.postType}</td>
                    <td style={td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {s.pulse && <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color, animation: "pulse 1s infinite" }} />}
                        <Badge label={s.label} bg={s.bg} color={s.color} />
                        {j.simulated && j.status === "published" && <DataQualityBadge kind="simulated" />}
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: MONO, fontSize: 12.5, color: C.textSecondary, whiteSpace: "nowrap" }}>
                      {j.scheduleType === "scheduled" && j.scheduledAt
                        ? new Date(j.scheduledAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
                        : "Immediate"}
                    </td>
                    <td style={{ ...td, fontSize: 13, color: C.textMuted, whiteSpace: "nowrap" }}>{relativeTime(j.createdAt)}</td>
                    <td style={{ ...td, maxWidth: 200 }}>
                      {j.error
                        ? <span title={j.error} style={{ fontSize: 12.5, color: C.errText, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 190, display: "inline-block" }}>{j.error}</span>
                        : j.result?.warning
                        ? <span title={j.result.warning} style={{ fontSize: 12.5, color: C.amber, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 190, display: "inline-block" }}>{j.result.warning}</span>
                        : <span style={{ color: C.textMuted }}>—</span>}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {j.status === "pending_review" && isAdmin && <>
                          <button onClick={() => approveJob(j)} style={{ ...smallPill, background: C.green, color: C.onAccent }}>Approve</button>
                          <button onClick={() => rejectJob(j)} style={{ ...smallPill, background: C.errBg, color: C.errText }}>Reject</button>
                        </>}
                        {j.status === "draft" && isAdmin && <button onClick={() => promoteJob(j)} style={{ ...smallPill, background: C.primary, color: C.onAccent }}>Publish</button>}
                        {canCancel && <button onClick={() => cancelJob(j)} title="Cancel" style={iconBtn} {...hoverFill}><Ban size={14} /></button>}
                        <button onClick={() => deleteJob(j)} title="Delete" style={iconBtn} {...hoverFill}><Trash2 size={14} /></button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showComposer && (
        <ComposerModal
          initialScheduledAt={composerDate}
          isMember={!isAdmin}
          onClose={() => setShowComposer(false)}
          onCreated={() => { setShowComposer(false); setComposerDate(null); refetch(); }}
        />
      )}
    </div>
  );
}

// ── List/Calendar view toggle (level-2 pill strip) ────────────
function ViewToggle({ view, setView }) {
  return (
    <PillTabs size="sm" value={view} onChange={setView}
      tabs={[{ id: "list", label: "List", Icon: ListIcon }, { id: "calendar", label: "Calendar", Icon: CalIcon }]} />
  );
}

// ── Content calendar (month grid) ─────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function CalendarView({ jobs, onPickDay }) {
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });

  // Bucket jobs by their calendar day.
  const byDay = new Map();
  for (const j of jobs) {
    const d = jobDate(j); if (!d) continue;
    const key = ymd(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(j);
  }

  const first = new Date(cursor.y, cursor.m, 1);
  const startPad = first.getDay();                       // leading blanks
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayKey = ymd(today);
  const go = (delta) => setCursor(c => { const m = c.m + delta; return { y: c.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 }; });

  const navBtn = { ...BTN.icon, width: 30, height: 30, background: C.surface2, color: C.text };

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ ...T.h3, color: C.text }}>{MONTHS[cursor.m]} {cursor.y}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setCursor({ y: today.getFullYear(), m: today.getMonth() })} style={{ ...BTN.secondary, padding: "6px 14px", fontSize: 13 }}>Today</button>
          <button onClick={() => go(-1)} style={navBtn} title="Previous month"><ChevronLeft size={16} /></button>
          <button onClick={() => go(1)} style={navBtn} title="Next month"><ChevronRight size={16} /></button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
        {DOW.map(d => <div key={d} style={{ ...T.label, color: C.textMuted, textAlign: "center", padding: "2px 0" }}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const dayJobs = byDay.get(key) || [];
          const isToday = key === todayKey;
          const isPast = new Date(cursor.y, cursor.m, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
          return (
            <div key={i}
              onClick={() => { if (!isPast) onPickDay(`${key}T09:00`); }}
              title={isPast ? "" : "Schedule a post on this day"}
              style={{ minHeight: 92, borderRadius: 12, padding: 8, background: isToday ? C.primarySoft : C.surface, cursor: isPast ? "default" : "pointer", display: "flex", flexDirection: "column", gap: 4, opacity: isPast ? 0.6 : 1, transition: "background .14s" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: isToday ? C.primary : C.textSecondary, fontFamily: MONO }}>{d}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, overflow: "hidden" }}>
                {dayJobs.slice(0, 3).map(j => {
                  const s = STATUS_STYLE[j.status] || STATUS_STYLE.queued;
                  return (
                    <div key={j.id} title={`${j.accountLabel || j.platform} · ${s.label}`}
                      style={{ display: "flex", alignItems: "center", gap: 5, background: s.bg, borderRadius: 999, padding: "2px 7px 2px 3px", overflow: "hidden" }}>
                      <PlatformBadge platform={j.platform} size="sm" />
                      <span style={{ fontSize: 11.5, fontWeight: 650, color: s.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j.accountLabel || j.platform}</span>
                    </div>
                  );
                })}
                {dayJobs.length > 3 && <span style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 650 }}>+{dayJobs.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
