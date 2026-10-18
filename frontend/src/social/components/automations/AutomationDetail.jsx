import { useState, useEffect, useMemo } from "react";
import { ArrowLeft, Pencil, Square, Play, Loader2, Link2, MessageCircle, MessageSquareReply, Send, Hand, ClipboardList, Tag, MousePointerClick, UserPlus, Clock } from "lucide-react";
import { api } from "../../api.js";
import PersonLink from "./PersonLink.jsx";
import { C, FONT, MONO, BTN, T, relativeTime } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { SimPhone } from "./PhonePreview.jsx";
import LeadsTable from "./LeadsTable.jsx";
import { triggerMeta, buildDmSteps, hasPostView, GATE_DEFAULTS, STATUS_STYLE, delayLabel } from "./shared.jsx";

// One automation on one screen: how it works (left), its numbers and recent
// activity (middle), and the phone preview (right). No tabs.
export default function AutomationDetail({ rule: initial, isAdmin, onBack, onEdit, onChanged }) {
  const [rule, setRule] = useState(initial);
  const [pv, setPv] = useState(hasPostView(initial.trigger) ? "comments" : "dm");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState(null);
  const [log, setLog] = useState([]);
  const [leads, setLeads] = useState([]);

  useEffect(() => { setRule(initial); }, [initial]);
  useEffect(() => {
    let alive = true;
    api.automations.insights(rule.id).then(s => alive && setStats(s)).catch(() => alive && setStats(false));
    api.automations.log({ rule_id: rule.id, limit: 20 }).then(r => alive && setLog(r)).catch(() => {});
    if (rule.collect?.length) api.automations.leads({ rule_id: rule.id }).then(r => alive && setLeads(r)).catch(() => {});
    return () => { alive = false; };
  }, [rule.id, rule.collect?.length]);

  async function toggle() {
    setBusy(true);
    try {
      const r = await api.automations.update(rule.id, { active: !rule.active });
      const next = { ...rule, ...r };
      setRule(next); onChanged?.(next);
      showToast(next.active ? "Automation is live" : "Automation stopped", "success");
    } catch (e) { showToast(e.message, "error"); }
    finally { setBusy(false); }
  }

  const steps = useMemo(() => buildDmSteps(rule, rule.account_username), [rule]);
  const [simSlot, setSimSlot] = useState(null);
  const post = rule.media_id ? { thumbnail: rule.media_thumbnail, caption: rule.media_caption, likes: rule.media_likes, comments: rule.media_comments } : { any: true };

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <button onClick={onBack} style={BTN.icon} aria-label="Back to automations" title="Back"><ArrowLeft size={16} /></button>
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ ...T.h3, fontSize: 18, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rule.name}</span>
            <LiveBadge on={rule.active} />
          </div>
          {rule.account_username && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 2 }}>@{rule.account_username}</div>}
        </div>
        {isAdmin && (
          <>
            <button onClick={() => onEdit(rule)} style={BTN.secondary}><Pencil size={14} /> Edit</button>
            <button onClick={toggle} disabled={busy} style={rule.active ? BTN.danger : BTN.primary}>
              {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : rule.active ? <Square size={13} /> : <Play size={14} />}
              {rule.active ? "Stop" : "Go live"}
            </button>
          </>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 280px", maxWidth: 340, minWidth: 0 }}>
          <Label>How it works</Label>
          <Flow rule={rule} onShow={setPv} />
        </div>

        <div style={{ flex: "2 1 380px", minWidth: 0 }}>
          {/* Test it: when the phone column is too narrow for "What happened" beside
              the phone, SimPhone renders it here — next to the phone, not under it. */}
          <div ref={setSimSlot} />
          <Label>Results</Label>
          <Metrics rule={rule} stats={stats} />
          {stats?.daily && <Trend rows={stats.daily} />}
          <Label style={{ marginTop: 22 }}>Recent activity</Label>
          <Activity rows={log} isAdmin={isAdmin} />
          {rule.collect?.length > 0 && (
            <>
              <Label style={{ marginTop: 22 }}>Leads</Label>
              <LeadsTable rows={leads} />
            </>
          )}
        </div>

        <div style={{ flex: "1 0 300px", maxWidth: "100%", display: "flex", justifyContent: "center", position: "sticky", top: 12 }}>
          <SimPhone rule={rule} account={rule.account_username} post={post} view={pv} onView={setPv} previewSteps={steps} timelineSlot={simSlot} />
        </div>
      </div>
    </div>
  );
}

export function LiveBadge({ on }) {
  return (
    <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 750, letterSpacing: ".04em", flexShrink: 0,
      background: on ? C.primary : C.surface2, color: on ? C.onAccent : C.textMuted }}>{on ? "LIVE" : "OFF"}</span>
  );
}

function Label({ children, style }) {
  return <div style={{ ...T.label, color: C.textMuted, marginBottom: 10, ...style }}>{children}</div>;
}

// ── left: the automation as a short vertical flow ────────────
function Flow({ rule, onShow }) {
  const isComment = rule.trigger === "comment";
  const collect = Array.isArray(rule.collect) ? rule.collect : [];
  const gated = isComment && (rule.opening_dm || rule.follow_gate || collect.length > 0 || rule.followup_enabled);
  const m = rule.dm_message;
  const p = m?.attachment?.payload;
  const dmText = p?.template_type === "button" ? p.text : p?.template_type === "generic" ? p.elements?.[0]?.title : m?.text;
  const buttons = (p?.template_type === "button" ? p.buttons : p?.template_type === "generic" ? p.elements?.[0]?.buttons : null) || m?.quick_replies || [];
  const words = rule.keywords || [];
  const replies = rule.reply_texts || [];

  const items = [];
  items.push({
    Icon: isComment ? MessageCircle : triggerMeta(rule.trigger).Icon, view: isComment ? "post" : "dm",
    title: isComment ? (rule.media_id ? "Comment on this post" : "Comment on any post") : triggerMeta(rule.trigger).label,
    body: (
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {isComment && rule.media_id && rule.media_thumbnail && <img src={rule.media_thumbnail} alt="" style={{ width: 40, height: 50, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />}
        {rule.trigger === "story_mention" ? null
          : words.length ? <Chips words={words} />
          : <span style={{ fontSize: 13, color: C.textMuted }}>Any word</span>}
      </div>
    ),
  });
  if (isComment && replies.length) items.push({
    Icon: MessageSquareReply, view: "comments", title: "Replies publicly",
    body: <Quote text={replies[0]} more={replies.length - 1} />,
  });
  if (gated) items.push({
    Icon: Hand, view: "dm", title: rule.follow_gate ? "Opening DM + follow check" : "Opening DM",
    body: <Quote text={rule.gate_text || GATE_DEFAULTS.gate_text} lines={2} />,
  });
  if (rule.follow_gate && !isComment) items.push({
    Icon: UserPlus, view: "dm", title: "Asks non-followers to follow first",
    body: <Quote text={(rule.follow_gate_text || GATE_DEFAULTS.follow_gate_text).replace(/\{account\}/g, rule.account_username || "us")} lines={2} />,
  });
  if (m) items.push({
    Icon: Send, view: "dm", title: buttons.some(b => b.type === "web_url") ? "Sends a DM with a link" : "Sends a DM",
    body: (
      <>
        {dmText && <Quote text={dmText} lines={2} />}
        {buttons.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {buttons.map((b, i) => (
              <span key={i} title={b.url || b.payload || ""} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, background: C.surface2, fontSize: 12.5, fontWeight: 600, color: C.text }}>
                {b.type === "web_url" ? <Link2 size={12} color={C.blue} /> : <MousePointerClick size={12} color={C.textMuted} />}{b.title}
              </span>
            ))}
          </div>
        )}
      </>
    ),
  });
  if (collect.length) items.push({
    Icon: ClipboardList, view: "dm", title: `Asks ${collect.length} question${collect.length > 1 ? "s" : ""}`,
    body: <span style={{ fontSize: 13, color: C.textSecondary }}>{collect.map(q => q.label || q.type).join(", ")}</span>,
  });
  if (rule.tags?.length) items.push({ Icon: Tag, title: `Tags the contact`, body: <span style={{ fontSize: 13, color: C.textSecondary }}>{rule.tags.length} tag{rule.tags.length > 1 ? "s" : ""}</span> });
  if (rule.followup_enabled && m && !collect.length) items.push({
    Icon: Clock, view: "dm", title: `Follows up after ${delayLabel(rule.followup_delay_min)}`,
    body: (
      <>
        <Quote text={rule.followup_text || GATE_DEFAULTS.followup_text} lines={2} />
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>Only if they haven't tapped the link or replied{isComment ? " · counted from their tap on the opening message" : ""}</div>
      </>
    ),
  });

  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: "6px 14px" }}>
      {items.map((it, i) => (
        <div key={i} onClick={() => it.view && onShow(it.view)} style={{ display: "flex", gap: 12, padding: "12px 0", cursor: it.view ? "pointer" : "default", position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
            <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center" }}><it.Icon size={15} /></span>
            {i < items.length - 1 && <span style={{ position: "absolute", top: 46, bottom: -10, width: 2, background: C.surface2, left: 14 }} />}
          </div>
          <div style={{ minWidth: 0, flex: 1, paddingTop: 5 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>{it.title}</div>
            {it.body}
          </div>
        </div>
      ))}
    </div>
  );
}

function Quote({ text, more = 0, lines = 1 }) {
  return (
    <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.45 }}>
      <span style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", whiteSpace: "pre-line" }}>{text}</span>
      {more > 0 && <span style={{ color: C.textMuted, fontSize: 12 }}>+{more} more wording{more > 1 ? "s" : ""}</span>}
    </div>
  );
}

function Chips({ words }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {words.map(w => <span key={w} style={{ padding: "3px 9px", borderRadius: 999, background: C.primarySoft, color: C.primary, fontSize: 12.5, fontWeight: 650 }}>{w}</span>)}
    </div>
  );
}

// ── middle: numbers, trend, activity ─────────────────────────
function Metrics({ rule, stats }) {
  const loading = stats === null;
  const old = stats === false;   // backend without the insights endpoint
  const s = stats || {};
  const items = [
    { label: "Sends", value: old ? rule.fired : s.sends, hint: "DMs delivered (follow-ups counted separately)", sub: s.followups ? `+${s.followups} follow-up${s.followups > 1 ? "s" : ""}` : null },
    { label: "Clicks", value: old ? rule.clicks : s.clicks, hint: "People who tapped a link in the DM (counted since link tracking started)" },
    { label: "CTR", value: old ? null : s.ctr, suffix: "%", hint: "People who tapped a link ÷ DMs sent with a link" },
    { label: "Leads", value: old ? rule.leads : s.leads, hint: "People who answered every question" },
  ];
  return (
    <div style={{ background: C.raised, borderRadius: 16, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
      {items.map((m, i) => (
        <div key={m.label} title={m.hint} style={{ padding: "16px 14px 16px 18px", minWidth: 0, boxShadow: i ? `inset 1px 0 0 ${C.surface2}` : "none" }}>
          <div style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 600 }}>{m.label}</div>
          <div style={{ ...T.metricSm, fontFamily: MONO, color: m.value == null ? C.textMuted : C.text, marginTop: 6 }}>
            {loading ? <Loader2 size={18} color={C.textMuted} style={{ animation: "spin 1s linear infinite" }} />
              : m.value == null ? "–" : <>{Number(m.value).toLocaleString("en-IN")}{m.suffix || ""}</>}
          </div>
          {m.sub && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{m.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// Daily sends (+ clicks) — only drawn once there's more than a day or two of data.
function Trend({ rows }) {
  const active = rows.filter(r => r.sends || r.clicks).length;
  if (active < 3) return null;
  const max = Math.max(1, ...rows.map(r => Math.max(r.sends, r.clicks)));
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: "14px 16px 10px", marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 70 }}>
        {rows.map(r => (
          <div key={r.day} title={`${r.day}: ${r.sends} sent · ${r.clicks} clicked`} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", gap: 1 }}>
            <div style={{ flex: 1, height: `${(r.sends / max) * 100}%`, minHeight: r.sends ? 2 : 0, background: C.primarySoft, borderRadius: 2 }} />
            <div style={{ flex: 1, height: `${(r.clicks / max) * 100}%`, minHeight: r.clicks ? 2 : 0, background: C.primary, borderRadius: 2 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textMuted, marginTop: 6 }}>
        <span>{rows.length} days ago</span>
        <span style={{ display: "inline-flex", gap: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: C.primarySoft }} />Sends</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: C.primary }} />Clicks</span>
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

// Profile picture when we have one (IG CDN links expire → fall back to the initial).
function PersonAvatar({ row }) {
  const [broken, setBroken] = useState(false);
  const box = { width: 30, height: 30, borderRadius: "50%", flexShrink: 0 };
  if (row.profile_pic && !broken) return <img src={row.profile_pic} alt="" onError={() => setBroken(true)} style={{ ...box, objectFit: "cover" }} />;
  return (
    <span style={{ ...box, background: C.surface2, color: C.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
      {(row.username || row.name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

function Activity({ rows, isAdmin }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <div style={{ background: C.raised, borderRadius: 16, padding: 20, fontSize: 13.5, color: C.textMuted, textAlign: "center" }}>Nothing yet. People who trigger this automation show up here.</div>;
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div style={{ background: C.raised, borderRadius: 16, padding: "4px 16px" }}>
      {shown.map((l, i) => {
        const st = STATUS_STYLE[l.status] || STATUS_STYLE.pending;
        return (
          <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", boxShadow: i ? `inset 0 1px 0 ${C.surface2}` : "none" }}>
            <PersonAvatar row={l} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <PersonLink row={l} isAdmin={isAdmin} />
                {l.username && l.name && <span style={{ color: C.textMuted }}> · {l.name}</span>}
                <span style={{ color: C.textMuted }}> {l.trigger === "gate" ? "tapped the button" : l.trigger === "followup" ? "follow-up" : l.input_text ? `“${l.input_text}”` : ""}</span>
              </div>
              {l.status !== "sent" && l.error && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.error}>{l.error}</div>}
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 650, color: st.color, flexShrink: 0 }}>
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: st.color }} />{st.label}
            </span>
            <span style={{ fontSize: 12, color: C.textMuted, width: 64, textAlign: "right", flexShrink: 0 }} title={new Date(l.created_at).toLocaleString()}>{relativeTime(l.created_at)}</span>
          </div>
        );
      })}
      {rows.length > 6 && (
        <button type="button" onClick={() => setAll(a => !a)} style={{ ...BTN.ghost, width: "100%", justifyContent: "center", padding: "10px 0", fontSize: 13 }}>
          {all ? "Show less" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
