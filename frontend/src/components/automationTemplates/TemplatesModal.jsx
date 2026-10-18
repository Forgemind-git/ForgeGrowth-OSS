import { useEffect, useMemo, useRef, useState } from "react";
import {
  X, Plus, Search, Zap, Workflow, FileText, ArrowLeft, Loader2, Info, Trash2, ChevronRight,
  ShoppingBag, LifeBuoy, CalendarCheck, GraduationCap, Building2, Stethoscope, UtensilsCrossed,
  Plane, Sparkles, Megaphone, HeartHandshake, MessageSquare, Link2, UserPlus, Inbox, Tag,
  LayoutGrid, Clock, ListChecks, ExternalLink, Paperclip,
} from "lucide-react";
import { C, FONT, T, W, LH, maskPhone } from "../../constants.js";
import { api } from "../../api.js";
import { notify } from "../../lib/feedback.js";
import SearchableSelect from "../SearchableSelect.jsx";
import { useFunnelConfig } from "../../hooks/useFunnelConfig.js";
import { TEMPLATES, INDUSTRIES, GOALS, TRIGGERS, defaultValues, buildTemplate } from "./catalog.js";
import { happyPath, LIMITS } from "./flowKit.js";

/**
 * "New automation" for WhatsApp, ManyChat-style: a template gallery filtered by
 * industry → sub-division, goal or trigger, a Start-from-scratch menu, and a
 * Quick-setup screen per template with a live WhatsApp preview.
 *
 * A template is only a starting point: it is created as a DRAFT through the
 * ordinary create call and opened in the builder, where the flow's own
 * activation check still decides whether it can go live.
 */

const ICONS = { ShoppingBag, LifeBuoy, CalendarCheck, GraduationCap, Building2, Stethoscope, UtensilsCrossed, Plane, Sparkles, Megaphone, HeartHandshake };
const TRIGGER_ICON = { keyword: MessageSquare, link: Link2, newContact: UserPlus, anyMessage: Inbox, tagApplied: Tag };
const TRIGGER_LABEL = Object.fromEntries(TRIGGERS.map((t) => [t.id, t.label]));
const INDUSTRY_LABEL = Object.fromEntries(INDUSTRIES.map((i) => [i.id, i.label]));
const MATCH_OPTIONS = [
  { value: "exact", label: "Exact match", sublabel: "The whole message is the keyword" },
  { value: "contains", label: "Contains", sublabel: "The keyword appears anywhere in the message" },
  { value: "starts", label: "Starts with", sublabel: "The message begins with the keyword" },
];

const V = {
  card: "var(--fc-card, #fff)", raised: "var(--fc-raised, #f4f4f2)", surface: "var(--fc-surface, rgba(0,0,0,.05))",
  surface2: "var(--fc-surface-2, rgba(0,0,0,.09))", text: "var(--fc-text, #0b0b0b)", text2: "var(--fc-text-secondary, #4d4d55)",
  muted: "var(--fc-text-muted, #6b6b73)", primary: "var(--fc-primary, #dc2626)", soft: "var(--fc-primary-soft, rgba(220,38,38,.12))",
  scrim: "var(--fc-scrim, rgba(0,0,0,.45))", shadow: "var(--fc-shadow-lg, 0 24px 48px rgba(0,0,0,.12))",
};
const btn = (kind = "secondary") => ({
  display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 8, border: "none", cursor: "pointer",
  fontFamily: FONT, fontSize: T.body, fontWeight: W.medium, whiteSpace: "nowrap",
  background: kind === "primary" ? V.primary : kind === "ghost" ? "transparent" : V.surface2,
  color: kind === "primary" ? "#fff" : V.text,
});
const iconBtn = { width: 36, height: 36, borderRadius: 8, border: "none", background: V.surface, color: V.text2, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };
const input = { width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8, border: "none", background: V.surface, color: V.text, fontFamily: FONT, fontSize: T.body, outline: "none" };
const label = { display: "block", fontSize: T.label, fontWeight: W.bold, color: V.text2, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 };

export default function TemplatesModal({ open, onClose, onCreated, onBlank }) {
  const [view, setView] = useState({ name: "gallery" });
  useEffect(() => { if (open) setView({ name: "gallery" }); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector("[data-tpl-menu-open]")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  return (
    <div onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 220, background: V.scrim, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: FONT }}>
      <style>{`
        .fg-tpl-card{transition:box-shadow .15s, transform .15s}
        .fg-tpl-card:hover{box-shadow:0 0 0 2px var(--fc-primary, #dc2626);transform:translateY(-1px)}
        .fg-tpl-side:hover{background:var(--fc-surface, rgba(0,0,0,.05))}
        .fg-tpl-row:hover{background:var(--fc-surface, rgba(0,0,0,.05)) !important}
        @media (max-width: 820px){ .fg-tpl-sidebar{display:none !important} .fg-tpl-setup{flex-direction:column !important} .fg-tpl-preview{width:auto !important} }
      `}</style>
      <div role="dialog" aria-label="Automation templates"
        style={{ width: "min(1220px, 100%)", height: "min(820px, 100%)", background: V.card, borderRadius: 16, boxShadow: V.shadow, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {view.name === "gallery" ? (
          <Gallery onClose={onClose} onPick={(tpl) => setView({ name: "setup", tpl })} onScratch={(kind) => (kind ? setView({ name: "setup", tpl: scratchTemplate(kind) }) : onBlank())} />
        ) : (
          <Setup tpl={view.tpl} onBack={() => setView({ name: "gallery" })} onClose={onClose} onCreated={onCreated} />
        )}
      </div>
    </div>
  );
}

// ─── Gallery ──────────────────────────────────────────────────────────────
function Gallery({ onClose, onPick, onScratch }) {
  const [filter, setFilter] = useState({ type: "all" });
  const [q, setQ] = useState("");
  const [openInd, setOpenInd] = useState(null);

  const match = (t) => {
    if (filter.type === "industry" && t.industry !== filter.id) return false;
    if (filter.type === "sub" && !(t.industry === filter.industry && t.sub === filter.id)) return false;
    if (filter.type === "goal" && t.goal !== filter.id) return false;
    if (filter.type === "trigger" && t.trigger.kind !== filter.id) return false;
    const s = q.trim().toLowerCase();
    if (s && !`${t.title} ${t.body} ${INDUSTRY_LABEL[t.industry]}`.toLowerCase().includes(s)) return false;
    return true;
  };
  const shown = TEMPLATES.filter(match);
  const recommended = filter.type === "all" && !q.trim() ? shown.filter((t) => t.popular).slice(0, 6) : [];
  const rest = recommended.length ? shown.filter((t) => !recommended.includes(t)) : shown;
  const heading = filter.type === "all" ? "All templates"
    : filter.type === "industry" ? INDUSTRY_LABEL[filter.id]
    : filter.type === "sub" ? `${INDUSTRY_LABEL[filter.industry]} · ${INDUSTRIES.find((i) => i.id === filter.industry).subs.find((s) => s.id === filter.id).label}`
    : filter.type === "goal" ? GOALS.find((g) => g.id === filter.id).label : TRIGGER_LABEL[filter.id];

  const isOn = (type, id, extra) => filter.type === type && filter.id === id && (!extra || filter.industry === extra);
  const side = (key, text, active, onClick, Icon, indent) => (
    <button key={key} type="button" onClick={onClick} className="fg-tpl-side"
      style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", padding: indent ? "7px 10px 7px 36px" : "8px 10px", borderRadius: 8, border: "none", cursor: "pointer", fontFamily: FONT,
        fontSize: indent ? T.meta : T.body, background: active ? V.surface2 : "transparent", color: active ? V.text : V.text2, fontWeight: active ? W.bold : W.medium }}>
      {Icon && <Icon size={16} style={{ flexShrink: 0, color: active ? V.primary : V.muted }} />}
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", boxShadow: `inset 0 -1px 0 ${V.surface2}` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T.h2, fontWeight: W.heavy, color: V.text, letterSpacing: "-.02em" }}>WhatsApp automation templates</div>
          <div style={{ fontSize: T.meta, color: V.muted, marginTop: 2 }}>
            {TEMPLATES.length} ready-made flows by industry. Pick one, fill a few details, and it opens in the builder as a draft.
          </div>
        </div>
        <ScratchMenu onScratch={onScratch} />
        <button type="button" onClick={onClose} style={iconBtn} aria-label="Close"><X size={18} /></button>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div className="fg-tpl-sidebar" style={{ width: 252, flexShrink: 0, padding: 12, overflowY: "auto", boxShadow: `inset -1px 0 0 ${V.surface2}` }}>
          {side("all", "All templates", filter.type === "all", () => setFilter({ type: "all" }), LayoutGrid)}
          <SideHead>By industry</SideHead>
          {INDUSTRIES.map((ind) => {
            const Icon = ICONS[ind.icon];
            const expanded = openInd === ind.id || filter.industry === ind.id || (filter.type === "industry" && filter.id === ind.id);
            return (
              <div key={ind.id}>
                {side(ind.id, ind.label, isOn("industry", ind.id), () => { setFilter({ type: "industry", id: ind.id }); setOpenInd(ind.id); }, Icon)}
                {expanded && ind.subs.map((s) => side(`${ind.id}.${s.id}`, s.label, isOn("sub", s.id, ind.id), () => setFilter({ type: "sub", id: s.id, industry: ind.id }), null, true))}
              </div>
            );
          })}
          <SideHead>By goal</SideHead>
          {GOALS.map((g) => side(`g.${g.id}`, g.label, isOn("goal", g.id), () => setFilter({ type: "goal", id: g.id })))}
          <SideHead>By trigger</SideHead>
          {TRIGGERS.map((t) => side(`t.${t.id}`, t.label, isOn("trigger", t.id), () => setFilter({ type: "trigger", id: t.id }), TRIGGER_ICON[t.id]))}
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "18px 22px 28px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <div style={{ fontSize: T.h3, fontWeight: W.bold, color: V.text, flex: 1, minWidth: 180 }}>{heading}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: V.surface, borderRadius: 8, padding: "8px 12px", width: 340, maxWidth: "100%" }}>
              <Search size={15} color="var(--fc-text-muted, #6b6b73)" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search WhatsApp templates…" aria-label="Search templates"
                style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontFamily: FONT, fontSize: T.body, color: V.text }} />
              {q && <button type="button" onClick={() => setQ("")} style={{ ...iconBtn, width: 22, height: 22, background: "transparent" }} aria-label="Clear search"><X size={14} /></button>}
            </div>
          </div>
          {recommended.length > 0 && <><SectionHead>Recommended</SectionHead><Grid items={recommended} onPick={onPick} /></>}
          <SectionHead>{recommended.length ? "Discover more templates" : `${shown.length} template${shown.length === 1 ? "" : "s"}`}</SectionHead>
          {rest.length ? <Grid items={rest} onPick={onPick} />
            : <div style={{ color: V.muted, fontSize: T.body, padding: "24px 4px" }}>No templates match. Try another filter, or Start from scratch.</div>}
        </div>
      </div>
    </>
  );
}

const SideHead = ({ children }) => <div style={{ fontSize: T.label, fontWeight: W.bold, color: V.muted, textTransform: "uppercase", letterSpacing: ".06em", margin: "18px 10px 6px" }}>{children}</div>;
const SectionHead = ({ children }) => <div style={{ fontSize: T.lead, fontWeight: W.bold, color: V.text, margin: "2px 0 12px" }}>{children}</div>;

function Grid({ items, onPick }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))", gap: 12, marginBottom: 26 }}>
      {items.map((t) => {
        const TIcon = TRIGGER_ICON[t.trigger.kind] || MessageSquare;
        return (
          <button key={t.id} type="button" onClick={() => onPick(t)} className="fg-tpl-card" data-template={t.id}
            style={{ display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "left", minHeight: 176, padding: 16, borderRadius: 16, border: "none", cursor: "pointer", fontFamily: FONT, background: V.raised, color: V.text }}>
            <div style={{ fontSize: T.label, fontWeight: W.bold, color: V.muted, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>{INDUSTRY_LABEL[t.industry]}</div>
            <div style={{ fontSize: T.lead, fontWeight: W.bold, lineHeight: LH.tight, letterSpacing: "-.01em" }}>{t.title}</div>
            <div style={{ fontSize: T.meta, color: V.text2, marginTop: 6, lineHeight: LH.normal, flex: 1 }}>{t.body}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: T.label, color: V.text2, fontWeight: W.medium, flexWrap: "wrap" }}>
              {t.kind === "quick" ? <Zap size={14} /> : <Workflow size={14} />}
              {t.kind === "quick" ? "Quick setup" : "Flow Builder"}
              <span style={{ color: V.muted }}>·</span>
              <TIcon size={13} /> {TRIGGER_LABEL[t.trigger.kind]}
              {t.popular && <span style={{ marginLeft: "auto", padding: "2px 7px", borderRadius: 5, background: V.primary, color: "#fff", fontSize: T.micro, fontWeight: W.heavy, letterSpacing: ".04em" }}>POPULAR</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ScratchMenu({ onScratch }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown); window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }} {...(open ? { "data-tpl-menu-open": "" } : {})}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={btn("secondary")}><Plus size={16} /> Start from scratch</button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 5, width: 290, background: V.card, borderRadius: 16, boxShadow: V.shadow, padding: 6 }}>
          <div style={{ ...label, color: V.muted, padding: "8px 10px 4px", margin: 0 }}>Start with a trigger</div>
          {TRIGGERS.map((t) => {
            const Icon = TRIGGER_ICON[t.id];
            return <MenuRow key={t.id} Icon={Icon} title={t.label} sub={t.desc} onClick={() => { setOpen(false); onScratch(t.id); }} />;
          })}
          <div style={{ height: 1, background: V.surface2, margin: "6px 4px" }} />
          <div style={{ ...label, color: V.muted, padding: "8px 10px 4px", margin: 0 }}>Build your own way</div>
          <MenuRow Icon={FileText} title="Blank canvas" sub="Name it and design every step yourself" onClick={() => { setOpen(false); onScratch(null); }} />
        </div>
      )}
    </div>
  );
}

function MenuRow({ Icon, title, sub, onClick }) {
  return (
    <button type="button" onClick={onClick} className="fg-tpl-row"
      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, color: V.text, borderRadius: 8, textAlign: "left" }}>
      <Icon size={17} style={{ color: V.text2, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: T.body, fontWeight: W.medium }}>{title}</div>
        {sub && <div style={{ fontSize: T.label, color: V.muted, marginTop: 1 }}>{sub}</div>}
      </div>
    </button>
  );
}

/** "Start with a trigger" = a template whose flow is just that trigger. */
function scratchTemplate(kind) {
  const defaults = { keyword: { keyword: "", matchType: "exact" }, link: { trackingCode: "" }, tagApplied: { tag: "" } }[kind] || {};
  return {
    id: `scratch_${kind}`, scratch: true, title: `New ${TRIGGER_LABEL[kind].toLowerCase()} automation`, kind: "flow",
    body: `Starts when: ${TRIGGERS.find((t) => t.id === kind).desc.toLowerCase()}. Add the steps in the builder.`,
    industry: null, trigger: { kind, ...defaults }, fields: [],
    build(v, ctx) {
      return { nodes: [{ id: "trigger1", type: "trigger", x: 160, y: 160, title: "Trigger", sub: "", triggerAccounts: v.__trigger.accounts || [],
        ...triggerNodeFields(kind, v.__trigger) }], edges: [] };
    },
  };
}
function triggerNodeFields(kind, t) {
  if (kind === "keyword") return { triggerKind: "keyword", keyword: t.keyword || "", matchType: t.matchType || "exact", caseSensitive: false, triggerDirection: "inbound", landingSource: "" };
  if (kind === "link") return { triggerKind: "link", trackingCode: t.trackingCode || "" };
  if (kind === "tagApplied") return { triggerKind: "tagApplied", tag: t.tag || "", tagDirection: "added", fireOncePerTag: true };
  return { triggerKind: kind };
}

// ─── Quick setup ──────────────────────────────────────────────────────────
function Setup({ tpl, onBack, onClose, onCreated }) {
  const [v, setV] = useState(() => defaultValues(tpl));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [numbers, setNumbers] = useState([]);
  const [tags, setTags] = useState(null);
  const [media, setMedia] = useState(null);
  const { stages } = useFunnelConfig();
  const stageKeys = useMemo(() => stages.map((s) => s.stageKey), [stages]);
  const needsTags = tpl.trigger.kind === "tagApplied" || tpl.fields.some((f) => f.type === "tag");
  const needsMedia = tpl.fields.some((f) => f.type === "media");

  useEffect(() => {
    api.numbers().then((r) => setNumbers(Array.isArray(r) ? r : [])).catch(() => setNumbers([]));
    if (needsTags) api.tags.list().then((r) => setTags(Array.isArray(r) ? r : [])).catch(() => setTags([]));
    if (needsMedia) api.mediaLibrary.list().then((r) => setMedia(r?.media || [])).catch(() => setMedia([]));
  }, [needsTags, needsMedia]);

  const set = (key, val) => { setV((p) => ({ ...p, [key]: val })); setErrors((e) => ({ ...e, [key]: undefined })); };
  const setTrig = (patch) => { setV((p) => ({ ...p, __trigger: { ...p.__trigger, ...patch } })); setErrors((e) => ({ ...e, __trigger: undefined })); };

  const config = useMemo(() => {
    try { return buildTemplate(tpl, v, { stageKeys }); } catch { return null; }
  }, [tpl, v, stageKeys]);
  const stats = useMemo(() => {
    if (!config) return null;
    const msgs = config.nodes.filter((n) => n.type === "message");
    return { steps: config.nodes.length - 1, messages: msgs.length, questions: msgs.filter((n) => n.waitForReply).length,
      branches: config.edges.filter((e) => /^(btn|row)/.test(e.fromHandle || "")).length };
  }, [config]);

  const validate = () => {
    const e = {};
    if (!String(v.__name || "").trim()) e.__name = "Give the automation a name.";
    const k = tpl.trigger.kind;
    if (k === "keyword" && !String(v.__trigger.keyword || "").trim()) e.__trigger = "Type the keyword customers will send.";
    if (k === "link" && !String(v.__trigger.trackingCode || "").trim()) e.__trigger = "Set the tracking code carried in your link.";
    if (k === "tagApplied" && !v.__trigger.tag) e.__trigger = "Choose the tag that starts this flow.";
    tpl.fields.forEach((f) => {
      const val = v[f.key];
      if (f.type === "url" && val && !/^https?:\/\/\S+\.\S+/.test(String(val).trim())) e[f.key] = "Use a full link starting with https://";
      if (f.type === "url" && !val && !tpl.fields.some((o) => o.type === "media" && v[o.key])) e[f.key] = "This link is sent to customers — add one.";
      if ((f.type === "options") && !(val || []).some((x) => String(x).trim())) e[f.key] = "Add at least one option.";
      if ((f.type === "rows" || f.type === "faqs") && !(val || []).some((x) => String(x?.title || "").trim())) e[f.key] = "Add at least one item.";
      if (f.type === "faqs" && (val || []).some((x) => x?.title && !String(x.answer || "").trim())) e[f.key] = "Every question needs an answer.";
      if (f.type === "options" && new Set((val || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)).size !== (val || []).filter((x) => String(x).trim()).length) e[f.key] = "Options must all be different.";
    });
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const create = async () => {
    if (!validate()) return;
    if (!config) { notify("This template could not be built — check the details."); return; }
    setSaving(true);
    try {
      const data = await api.chatbots.create({
        name: String(v.__name).trim(), description: tpl.body, status: "draft",
        trigger_type: tpl.trigger.kind, config,
      });
      onCreated(data);
    } catch (err) {
      notify(err.message || "Could not create the automation.");
      setSaving(false);
    }
  };

  const TIcon = TRIGGER_ICON[tpl.trigger.kind] || MessageSquare;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", boxShadow: `inset 0 -1px 0 ${V.surface2}` }}>
        <button type="button" onClick={onBack} style={iconBtn} aria-label="Back to templates"><ArrowLeft size={18} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: T.label, color: V.muted, fontWeight: W.bold, textTransform: "uppercase", letterSpacing: ".05em" }}>
            {tpl.scratch ? "Start from scratch" : `${INDUSTRY_LABEL[tpl.industry]} · ${tpl.kind === "quick" ? "Quick setup" : "Flow Builder"}`}
          </div>
          <div style={{ fontSize: T.h3, fontWeight: W.bold, color: V.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tpl.title}</div>
        </div>
        <button type="button" onClick={onClose} style={iconBtn} aria-label="Close"><X size={18} /></button>
      </div>

      <div className="fg-tpl-setup" style={{ display: "flex", flex: 1, minHeight: 0, overflow: "auto" }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 24px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: T.body, color: V.text2, lineHeight: LH.normal }}>{tpl.body}</div>

          <Field label="Automation name" error={errors.__name}>
            <input style={input} value={v.__name} onChange={(e) => set("__name", e.target.value)} maxLength={120} />
          </Field>

          <Panel title="How it starts" Icon={TIcon} sub={TRIGGERS.find((t) => t.id === tpl.trigger.kind)?.desc}>
            {tpl.trigger.kind === "keyword" && (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 10 }}>
                <Field label="Keyword" error={errors.__trigger}>
                  <input style={input} value={v.__trigger.keyword || ""} onChange={(e) => setTrig({ keyword: e.target.value })} placeholder="e.g. PRICE" />
                </Field>
                <Field label="Match">
                  <SearchableSelect value={v.__trigger.matchType || "exact"} onChange={(val) => setTrig({ matchType: val })} options={MATCH_OPTIONS} />
                </Field>
              </div>
            )}
            {tpl.trigger.kind === "link" && (
              <Field label="Tracking code" error={errors.__trigger}>
                <input style={input} value={v.__trigger.trackingCode || ""} onChange={(e) => setTrig({ trackingCode: e.target.value.replace(/\s+/g, "") })} placeholder="e.g. QR01" />
                <Hint>Put this code in your link's pre-filled text: wa.me/91XXXXXXXXXX?text=Hi%20{v.__trigger.trackingCode || "QR01"}</Hint>
              </Field>
            )}
            {tpl.trigger.kind === "tagApplied" && (
              <Field label="When this tag is added" error={errors.__trigger}>
                <SearchableSelect value={v.__trigger.tag || ""} onChange={(val) => setTrig({ tag: val })} placeholder={tags === null ? "Loading tags…" : "Choose a tag"}
                  options={(tags || []).map((t) => ({ value: t.name, label: t.name, sublabel: t.category_name || undefined }))} emptyText="No tags yet — create one in Admin Settings → Tags." />
              </Field>
            )}
            {(tpl.trigger.kind === "newContact" || tpl.trigger.kind === "anyMessage") && (
              <Hint>{tpl.trigger.kind === "newContact" ? "Runs once, on a contact's first message." : "Runs on every inbound message on the chosen number."}</Hint>
            )}
            <Field label="WhatsApp number">
              <SearchableSelect value={(v.__trigger.accounts || [])[0] || ""} onChange={(val) => setTrig({ accounts: val ? [val] : [] })}
                options={[{ value: "", label: "All numbers" }, ...numbers.filter((n) => n.wa_number).map((n) => ({ value: n.wa_number, label: n.display_name || maskPhone(n.wa_number), sublabel: maskPhone(n.wa_number) }))]} />
            </Field>
          </Panel>

          {tpl.fields.length > 0 && (
            <Panel title="Your details" Icon={ListChecks} sub="Pre-filled with examples — change anything. Every message stays editable in the builder.">
              {tpl.fields.map((f) => <FieldInput key={f.key} f={f} value={v[f.key]} onChange={(val) => set(f.key, val)} error={errors[f.key]} tags={tags} media={media} />)}
            </Panel>
          )}

          {(tpl.note || tpl.windowNote) && (
            <div style={{ display: "flex", gap: 10, padding: "12px 14px", borderRadius: 8, background: V.surface, color: V.text2, fontSize: T.meta, lineHeight: LH.normal }}>
              <Info size={16} style={{ flexShrink: 0, marginTop: 2, color: V.muted }} />
              <div>
                {tpl.note && <div>{tpl.note}</div>}
                {tpl.windowNote && <div style={{ marginTop: tpl.note ? 6 : 0 }}>This flow starts the conversation, so its first message only reaches people who messaged you in the last 24 hours. For anyone else, switch the first step to an approved template in the builder.</div>}
              </div>
            </div>
          )}
        </div>

        <aside className="fg-tpl-preview" style={{ width: 400, flexShrink: 0, padding: "20px 22px", background: V.raised, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: T.body, fontWeight: W.bold, color: V.text }}>Preview</div>
            <div style={{ fontSize: T.label, color: V.muted }}>main path, as the customer sees it</div>
          </div>
          <ChatPreview config={config} tpl={tpl} v={v} />
          {stats && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[[stats.steps, "steps"], [stats.messages, "messages"], [stats.questions, "questions"], [stats.branches, "branches"]].map(([n, l]) => (
                <span key={l} style={{ padding: "4px 9px", borderRadius: 6, background: V.surface2, fontSize: T.label, color: V.text2, fontWeight: W.medium }}><b style={{ color: V.text }}>{n}</b> {l}</span>
              ))}
            </div>
          )}
        </aside>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", boxShadow: `inset 0 1px 0 ${V.surface2}`, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: T.meta, color: V.muted }}>Saved as a <b style={{ color: V.text2 }}>draft</b> and opened in the builder — nothing is sent until you switch it on.</div>
        <button type="button" onClick={onBack} style={btn("ghost")}>Back</button>
        <button type="button" onClick={create} disabled={saving} style={{ ...btn("primary"), opacity: saving ? 0.7 : 1 }} data-testid="tpl-create">
          {saving ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <ChevronRight size={16} />} Create automation
        </button>
      </div>
    </>
  );
}

const Hint = ({ children }) => <div style={{ fontSize: T.label, color: V.muted, marginTop: 6, lineHeight: LH.normal }}>{children}</div>;

function Field({ label: text, error, children }) {
  return (
    <div>
      <span style={label}>{text}</span>
      {children}
      {error && <div style={{ fontSize: T.label, color: "var(--fc-err-text, #A32D2D)", marginTop: 6, fontWeight: W.medium }}>{error}</div>}
    </div>
  );
}

function Panel({ title, sub, Icon, children }) {
  return (
    <div style={{ background: V.raised, borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {Icon && <span style={{ width: 32, height: 32, borderRadius: 8, background: V.soft, color: V.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={17} /></span>}
        <div>
          <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: V.text }}>{title}</div>
          {sub && <div style={{ fontSize: T.meta, color: V.muted, marginTop: 2, lineHeight: LH.snug }}>{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function FieldInput({ f, value, onChange, error, tags, media }) {
  if (f.type === "textarea") return <Field label={f.label} error={error}><textarea style={{ ...input, resize: "vertical", lineHeight: LH.normal }} rows={3} value={value || ""} onChange={(e) => onChange(e.target.value)} />{f.help && <Hint>{f.help}</Hint>}</Field>;
  if (f.type === "tag") return (
    <Field label={f.label} error={error}>
      <SearchableSelect value={value || ""} onChange={(val) => onChange(val)} placeholder={tags === null ? "Loading tags…" : "No tag"}
        options={[{ value: "", label: "No tag" }, ...(tags || []).map((t) => ({ value: t.name, label: t.name, sublabel: t.category_name || undefined }))]} />
      {f.help && <Hint>{f.help}</Hint>}
    </Field>
  );
  if (f.type === "media") {
    const items = (media || []).filter((m) => !f.mediaType || m.mediaType === f.mediaType);
    return (
      <Field label={f.label} error={error}>
        <SearchableSelect value={value?.mediaLibraryId ? String(value.mediaLibraryId) : ""} placeholder={media === null ? "Loading Media Library…" : "None"}
          onChange={(val) => { const m = items.find((x) => String(x.id) === String(val)); onChange(m ? { mediaLibraryId: m.id, name: m.originalName || m.name } : null); }}
          options={[{ value: "", label: "None" }, ...items.map((m) => ({ value: String(m.id), label: m.name || m.originalName, sublabel: m.originalName }))]}
          emptyText="Nothing in the Media Library yet." />
        {f.help && <Hint>{f.help}</Hint>}
      </Field>
    );
  }
  if (f.type === "options") return <ListEditor f={f} value={value || []} onChange={onChange} error={error} kind="options" />;
  if (f.type === "rows" || f.type === "faqs") return <ListEditor f={f} value={value || []} onChange={onChange} error={error} kind={f.type} />;
  return (
    <Field label={f.label} error={error}>
      <input style={input} type={f.type === "url" ? "url" : "text"} value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={f.type === "url" ? "https://" : ""} />
      {f.help && <Hint>{f.help}</Hint>}
    </Field>
  );
}

function ListEditor({ f, value, onChange, error, kind }) {
  const max = f.max || 9;
  const titleMax = kind === "options" ? (f.maxLen || LIMITS.button) : LIMITS.row;
  const update = (i, patch) => onChange(value.map((x, j) => (j === i ? (kind === "options" ? patch : { ...x, ...patch }) : x)));
  const remove = (i) => onChange(value.filter((_, j) => j !== i));
  const addItem = () => onChange([...value, kind === "options" ? "" : kind === "faqs" ? { title: "", answer: "" } : { title: "", description: "" }]);
  return (
    <Field label={f.label} error={error}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {value.map((item, i) => {
          const title = kind === "options" ? item : item.title || "";
          return (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ width: 22, paddingTop: 10, fontSize: T.label, color: V.muted, fontWeight: W.bold, textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ position: "relative" }}>
                  <input style={{ ...input, paddingRight: 52 }} value={title} maxLength={titleMax} placeholder={kind === "faqs" ? "Question shown in the menu" : "Title"}
                    onChange={(e) => update(i, kind === "options" ? e.target.value : { title: e.target.value })} />
                  <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: T.micro, color: V.muted }}>{title.length}/{titleMax}</span>
                </div>
                {kind === "rows" && <input style={input} value={item.description || ""} maxLength={LIMITS.rowDesc} placeholder="Short description (optional)" onChange={(e) => update(i, { description: e.target.value })} />}
                {kind === "faqs" && <textarea style={{ ...input, resize: "vertical", lineHeight: LH.normal }} rows={2} value={item.answer || ""} placeholder="Answer sent when they pick it" onChange={(e) => update(i, { answer: e.target.value })} />}
              </div>
              <button type="button" onClick={() => remove(i)} style={{ ...iconBtn, background: "transparent", marginTop: 2 }} aria-label={`Remove ${i + 1}`} disabled={value.length <= 1}><Trash2 size={15} /></button>
            </div>
          );
        })}
        {value.length < max && (
          <button type="button" onClick={addItem} style={{ ...btn("ghost"), alignSelf: "flex-start", padding: "6px 10px", color: V.primary }}><Plus size={15} /> Add</button>
        )}
      </div>
      <Hint>{kind === "options" ? `Up to ${max}, ${titleMax} characters each (WhatsApp's limit).` : `Up to ${max}. WhatsApp shows ${LIMITS.row}-character titles.`}</Hint>
    </Field>
  );
}

// ─── WhatsApp preview ─────────────────────────────────────────────────────
function fmt(text) {
  return String(text || "").split(/(\*[^*\n]+\*)/g).map((p, i) => (/^\*[^*\n]+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b> : <span key={i}>{p}</span>));
}
const fill = (s) => String(s || "").replace(/\{\{\s*first_name\s*\}\}/g, "Priya").replace(/\{\{\s*name\s*\}\}/g, "Priya Sharma").replace(/\{\{\s*answer\s*\}\}/g, "‹their answer›");

function ChatPreview({ config, tpl, v }) {
  const steps = useMemo(() => (config ? happyPath(config, 16) : []), [config]);
  const items = [];
  const t = v.__trigger || {};
  const opener = tpl.trigger.kind === "keyword" ? (t.keyword || "…")
    : tpl.trigger.kind === "link" ? `Hi ${t.trackingCode || ""}`.trim()
    : tpl.trigger.kind === "tagApplied" ? null : "Hi";
  if (opener) items.push({ who: "them", text: opener });
  else items.push({ who: "sys", text: `Tag “${t.tag || "…"}” added` });
  steps.slice(1).forEach((n) => {
    if (n.type === "delay") return;
    if (n.type === "condition") { items.push({ who: "sys", text: "Outside business hours" }); return; }
    if (n.type === "action") {
      n.actions.forEach((a) => items.push({ who: "sys", text: a.kind === "Set Funnel Stage" ? `Lead → ${a.value.replace("_", " ")}` : a.kind === "Set Lead Field" ? `Saved as ${a.field}` : `Tagged “${a.value}”` }));
      return;
    }
    const dd = n.directData || {};
    if (n.type !== "message") return;
    if (["document", "image", "video", "audio"].includes(n.directType)) { items.push({ who: "us", doc: dd.filename || "File", text: dd.caption }); return; }
    items.push({ who: "us", text: fill(dd.body), buttons: n.directType === "quick_reply" ? dd.buttons.map((b) => b.title) : null,
      list: n.directType === "list" ? dd.button_text : null, cta: n.directType === "cta_url" ? dd.button_text : null });
    if (n.waitForReply) {
      const reply = n.directType === "quick_reply" ? dd.buttons[0]?.title : n.directType === "list" ? dd.sections?.[0]?.rows?.[0]?.title : "(their answer)";
      items.push({ who: "them", text: reply, typed: n.directType === "text" });
    }
  });
  return (
    <div data-testid="tpl-preview" style={{ flex: 1, minHeight: 280, borderRadius: 16, overflowY: "auto", background: "var(--c-chatWall, #efeae2)", backgroundImage: "var(--c-chatPattern)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((it, i) => {
        if (it.who === "sys") return <div key={i} style={{ alignSelf: "center", padding: "3px 10px", borderRadius: 6, background: "rgba(0,0,0,.08)", color: "var(--c-t4, #555)", fontSize: T.micro, fontWeight: W.medium }}>{it.text}</div>;
        const mine = it.who === "them"; // customer's own phone: their messages on the right
        return (
          <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "86%" }}>
            <div style={{ background: mine ? "var(--c-outgoingBg, #d9fdd3)" : "var(--c-incomingBg, #fff)", color: "var(--c-text, #111)", borderRadius: 8, padding: "7px 10px", fontSize: T.meta, lineHeight: LH.snug, whiteSpace: "pre-wrap", boxShadow: "0 1px 1px rgba(0,0,0,.08)", fontStyle: it.typed ? "italic" : "normal" }}>
              {it.doc && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(0,0,0,.05)", marginBottom: it.text ? 6 : 0 }}><Paperclip size={14} /> {it.doc}</div>}
              {it.text && fmt(it.text)}
            </div>
            {(it.buttons || it.list || it.cta) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 3 }}>
                {(it.buttons || [it.list || it.cta]).map((b, j) => (
                  <div key={j} style={{ background: "var(--c-incomingBg, #fff)", borderRadius: 8, padding: "7px 10px", textAlign: "center", color: "var(--c-waLink, #027eb5)", fontSize: T.meta, fontWeight: W.medium, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                    {it.cta ? <ExternalLink size={13} /> : it.list ? <ListChecks size={13} /> : null}{b}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!steps.length && <div style={{ color: V.muted, fontSize: T.meta, textAlign: "center", marginTop: 40 }}><Clock size={16} /> Add a trigger to preview</div>}
    </div>
  );
}
