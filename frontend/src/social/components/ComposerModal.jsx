import { useState, useEffect, useRef } from "react";
import { X, Upload, Check, Zap, Clock } from "lucide-react";
import { api } from "../api.js";
import { useApi } from "../hooks/useApi.js";
import { C, T, BTN, INPUT, FONT } from "../constants.js";
import { PLATFORMS, PLATFORM_ORDER } from "../data/mockData.js";
import { PlatformBadge } from "./UI.jsx";
import { SearchableSelect } from "./Dropdown.jsx";
import { showToast } from "../Toast.jsx";
import { postTypesFor, postTypeDef, fieldDef } from "../data/postTypes.js";

// ── shared inline-style helpers ───────────────────────────────
const lbl = { ...T.label, color: C.textSecondary, marginBottom: 8 };
const inp = { ...INPUT };
// Selectable card: surface off, accent-soft on — never an outline.
const selCard = (active) => ({ borderRadius: 12, padding: "10px 12px", cursor: "pointer", background: active ? C.primarySoft : C.surface, transition: "background .12s" });
// Tinted note boxes (info / warning).
const note = { background: C.amberSoft, color: C.amber, padding: "10px 14px", borderRadius: 12, fontSize: 13, fontWeight: 550, lineHeight: 1.45 };

const blankForm = {
  platform: null, accountSel: [],                 // [{accountId,accountLabel}] — multi = cross-post
  scheduleType: "immediate", scheduledAt: "",
  postType: null, media: [], details: {},
};

export default function ComposerModal({ onClose, onCreated, initialScheduledAt, isMember }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(() => initialScheduledAt
    ? { ...blankForm, scheduleType: "scheduled", scheduledAt: initialScheduledAt }
    : blankForm);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  // Changing platform invalidates accounts + everything downstream.
  const setPlatform = (platform) => set({ platform, accountSel: [], postType: null, media: [], details: {} });
  // Changing post type invalidates the (type-specific) media + details.
  const setPostType = (postType) => set({ postType, media: [], details: {} });

  const valid = isStepValid(step, form);
  const isLast = step === 4;
  const crossCount = form.accountSel.length;

  const submit = async (asDraft = false) => {
    setSubmitting(true); setErr(null);
    try {
      const r = await api.createPublishJob(buildPayload(form, asDraft));
      const n = r?.count || 1;
      const partial = r?.errors?.length ? ` (${r.errors.length} skipped)` : "";
      showToast(
        r?.pendingReview ? `Submitted for review${n > 1 ? ` ×${n}` : ""}${partial}`
        : asDraft ? `Saved as draft${n > 1 ? ` ×${n}` : ""}`
        : form.scheduleType === "scheduled" ? `Scheduled${n > 1 ? ` to ${n} accounts` : ""}${partial}`
        : `Queued${n > 1 ? ` to ${n} accounts` : ""}${partial}`,
        r?.errors?.length ? "info" : "success");
      onCreated();
    } catch (e) { setErr(e.message); }
    finally { setSubmitting(false); }
  };

  const disabledBtn = (off) => ({ opacity: off ? .5 : 1, cursor: off ? "not-allowed" : "pointer" });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.42)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1500, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 24, width: 640, maxWidth: "94%", maxHeight: "calc(90vh / var(--fg-zoom, 1))", display: "flex", flexDirection: "column", boxShadow: C.shadowLg, fontFamily: FONT, animation: "fc-pop-in .2s ease-out both" }}>
        {/* Header + progress (fixed) */}
        <div style={{ padding: "24px 24px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ ...T.h2, fontSize: 22, color: C.text }}>New Post</div>
            <button onClick={onClose} title="Close" style={{ ...BTN.icon, width: 32, height: 32 }}><X size={16} /></button>
          </div>
          <StepBar step={step} labels={["Platform", "Schedule", "Post type", "Details"]} />
        </div>

        {/* Body (scrolls) */}
        <div style={{ padding: "18px 24px", overflowY: "auto", flex: 1 }}>
          {step === 1 && <PlatformAccountStep form={form} setPlatform={setPlatform} set={set} />}
          {step === 2 && <ScheduleStep form={form} set={set} />}
          {step === 3 && <PostTypeStep form={form} setPostType={setPostType} />}
          {step === 4 && <DetailsStep form={form} set={set} />}
          {err && <div style={{ background: C.errBg, color: C.errText, padding: "10px 14px", borderRadius: 12, fontSize: 13, marginTop: 14 }}>{err}</div>}
        </div>

        {/* Footer (fixed) — separated by spacing, not a rule */}
        <div style={{ padding: "6px 24px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button onClick={() => step === 1 ? onClose() : setStep(step - 1)} style={BTN.secondary}>{step === 1 ? "Cancel" : "Back"}</button>
          {!isLast
            ? <button onClick={() => valid && setStep(step + 1)} disabled={!valid} style={{ ...BTN.primary, ...disabledBtn(!valid) }}>Next</button>
            : <div style={{ display: "flex", gap: 8 }}>
                {!isMember && <button onClick={() => submit(true)} disabled={!valid || submitting} style={{ ...BTN.secondary, ...disabledBtn(!valid || submitting) }} title="Save without publishing — promote it later from the Publish log">Save draft</button>}
                <button onClick={() => submit(false)} disabled={!valid || submitting} style={{ ...BTN.primary, ...disabledBtn(!valid || submitting) }}>{submitting ? "Submitting…" : (isMember ? "Submit for review" : (form.scheduleType === "scheduled" ? "Schedule" : (crossCount > 1 ? `Publish ×${crossCount}` : "Publish")))}</button>
              </div>}
        </div>
      </div>
    </div>
  );
}

// ── StepBar: a pill stepper — done = accent, current = accent-soft, todo = surface-2 ──
function StepBar({ step, labels }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {labels.map((l, i) => {
        const n = i + 1;
        const state = step === n ? "current" : step > n ? "done" : "todo";
        const bg = state === "done" ? C.primary : state === "current" ? C.primarySoft : C.surface2;
        const color = state === "done" ? C.onAccent : state === "current" ? C.primary : C.textSecondary;
        return (
          <div key={n} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, height: 32, borderRadius: 999, background: bg, color, transition: "background .2s, color .2s" }}>
            <span style={{ width: 18, height: 18, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", background: state === "done" ? "rgba(255,255,255,.22)" : state === "current" ? C.primary : C.surface2, color: state === "todo" ? C.textSecondary : C.onAccent, fontSize: 11.5, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {state === "done" ? <Check size={11} strokeWidth={3} /> : n}
            </span>
            <span style={{ ...T.label, fontWeight: state === "todo" ? 600 : 700 }}>{l}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: platform + account ────────────────────────────────
function PlatformAccountStep({ form, setPlatform, set }) {
  const { data: accounts, loading } = useApi(() => api.getPublishAccounts(), []);
  const list = accounts || [];
  const platformAccounts = form.platform ? list.filter(a => a.platform === form.platform) : [];

  const card = (active) => ({ ...selCard(active), display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "14px 8px 12px" });
  const chip = (active) => ({ fontSize: 13, fontWeight: active ? 700 : 600, padding: "7px 14px", borderRadius: 999, cursor: "pointer", border: "none", background: active ? C.primary : C.surface, color: active ? C.onAccent : C.textSecondary, fontFamily: FONT, transition: "background .12s" });

  return (
    <div>
      <div style={lbl}>Choose a platform</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, marginBottom: 22 }}>
        {PLATFORM_ORDER.map(key => (
          <div key={key} onClick={() => setPlatform(key)} style={card(form.platform === key)}>
            <PlatformBadge platform={key} size="lg" />
            <span style={{ fontSize: 12.5, fontWeight: 650, color: form.platform === key ? C.primary : C.textSecondary }}>{PLATFORMS[key].name}</span>
          </div>
        ))}
      </div>

      {form.platform && form.platform !== "instagram" && (
        <div style={{ ...note, marginBottom: 16 }}>
          {PLATFORMS[form.platform].name} publishing is live. If a post fails with a permission error, reconnect the {PLATFORMS[form.platform].name} account in{" "}
          <a href="#/social/integrations" style={{ color: C.primary, fontWeight: 700 }}>Integrations</a> to grant the publishing permission.
        </div>
      )}

      {form.platform && (
        <>
          <div style={lbl}>Account{platformAccounts.length > 1 ? "s · select one or more to cross-post" : ""}</div>
          {loading ? (
            <div style={{ fontSize: 13, color: C.textMuted }}>Loading accounts…</div>
          ) : platformAccounts.length === 0 ? (
            <div style={note}>
              No connected {PLATFORMS[form.platform].name} account.{" "}
              <a href="#/social/integrations" style={{ color: C.primary, fontWeight: 700 }}>Connect one in Integrations →</a>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {platformAccounts.map(a => {
                const id = a.accountId || a.platform;   // single-account platforms have null accountId
                const disabled = a.canPublish === false; // registered from webhook, never OAuth-connected
                const on = form.accountSel.some(s => s.accountId === a.accountId);
                const toggle = () => {
                  if (disabled) return;
                  const next = on ? form.accountSel.filter(s => s.accountId !== a.accountId)
                                  : [...form.accountSel, { accountId: a.accountId, accountLabel: a.label }];
                  set({ accountSel: next });
                };
                return (
                  <button key={id} disabled={disabled}
                    title={disabled ? "Not connected for publishing — reconnect this account in Integrations" : ""}
                    onClick={toggle}
                    style={{ ...chip(on), ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}) }}>
                    {on ? "✓ " : ""}{a.label}{disabled ? " · connect" : ""}
                  </button>
                );
              })}
            </div>
          )}
          {form.accountSel.length > 1 && (
            <div style={{ fontSize: 12.5, color: C.primary, fontWeight: 650, marginTop: 10 }}>
              Cross-posting the same content to {form.accountSel.length} accounts — one post each.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Step 2: schedule ──────────────────────────────────────────
function ScheduleStep({ form, set }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minLocal = new Date(Date.now() + 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const card = (active) => ({ ...selCard(active), flex: 1, padding: "14px 16px" });
  const past = form.scheduleType === "scheduled" && form.scheduledAt && new Date(form.scheduledAt).getTime() <= Date.now();
  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <div onClick={() => set({ scheduleType: "immediate" })} style={card(form.scheduleType === "immediate")}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: form.scheduleType === "immediate" ? C.primary : C.text, display: "flex", alignItems: "center", gap: 7 }}><Zap size={16} /> Publish now</div>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4 }}>Queue immediately for publishing.</div>
        </div>
        <div onClick={() => set({ scheduleType: "scheduled" })} style={card(form.scheduleType === "scheduled")}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: form.scheduleType === "scheduled" ? C.primary : C.text, display: "flex", alignItems: "center", gap: 7 }}><Clock size={16} /> Schedule</div>
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4 }}>Pick a future date &amp; time.</div>
        </div>
      </div>
      {form.scheduleType === "scheduled" && (
        <div>
          <div style={lbl}>Date &amp; time</div>
          <input type="datetime-local" min={minLocal} value={form.scheduledAt}
            onChange={e => set({ scheduledAt: e.target.value })} style={inp} />
          <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 6 }}>Times shown in your local timezone ({tz}).</div>
          {past && <div style={{ background: C.errBg, color: C.errText, padding: "8px 12px", borderRadius: 12, fontSize: 13, marginTop: 8 }}>Pick a time in the future.</div>}
        </div>
      )}
    </div>
  );
}

// ── Step 3: post type ─────────────────────────────────────────
function PostTypeStep({ form, setPostType }) {
  const types = postTypesFor(form.platform);
  const card = (active) => ({ ...selCard(active), display: "flex", flexDirection: "column", gap: 6, padding: "14px 16px" });
  return (
    <div>
      <div style={lbl}>Post type for {PLATFORMS[form.platform].name}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
        {types.map(t => {
          const Icon = t.icon;
          const on = form.postType === t.id;
          return (
            <div key={t.id} onClick={() => setPostType(t.id)} style={card(on)}>
              <Icon size={20} color={C.primary} strokeWidth={2} />
              <div style={{ fontSize: 13.5, fontWeight: 700, color: on ? C.primary : C.text }}>{t.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Composer helpers: caption templates + hashtag groups ──────
function ComposerHelpers({ form, def, setDetail }) {
  const { data: templates } = useApi(() => api.getContentTemplates(), []);
  const { data: groups } = useApi(() => api.getHashtagGroups(), []);
  const tpl = templates || [];
  const grp = groups || [];

  // Which field holds the main caption text, and whether there's a hashtags field.
  const captionField = ["caption", "text", "description"].find(f => def.fields.includes(f));
  const hasHashtags = def.fields.includes("hashtags");

  const applyTemplate = (id) => {
    const t = tpl.find(x => String(x.id) === String(id));
    if (t && captionField) setDetail(captionField, t.body);
  };
  const applyGroup = (id) => {
    const g = grp.find(x => String(x.id) === String(id));
    if (!g) return;
    const tags = Array.isArray(g.tags) ? g.tags : [];
    if (hasHashtags) {
      const cur = Array.isArray(form.details.hashtags) ? form.details.hashtags : [];
      const merged = [...new Set([...cur, ...tags])].slice(0, 30);
      setDetail("hashtags", merged);
    } else if (captionField) {
      const cur = form.details[captionField] || "";
      const tagStr = tags.map(t => "#" + String(t).replace(/^#/, "")).join(" ");
      setDetail(captionField, (cur ? cur + "\n\n" : "") + tagStr);
    }
  };

  if (!tpl.length && !grp.length) return null;          // nothing to offer yet
  if (!captionField && !hasHashtags) return null;       // nowhere to apply them

  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
      {tpl.length > 0 && captionField && (
        <div style={{ minWidth: 180 }}>
          <SearchableSelect value={null} placeholder="Insert caption template…"
            options={tpl.map(t => ({ value: String(t.id), label: t.name }))}
            onChange={applyTemplate} />
        </div>
      )}
      {grp.length > 0 && (
        <div style={{ minWidth: 180 }}>
          <SearchableSelect value={null} placeholder="Add hashtag group…"
            options={grp.map(g => ({ value: String(g.id), label: `${g.name} (${(g.tags || []).length})` }))}
            onChange={applyGroup} />
        </div>
      )}
    </div>
  );
}

// ── Step 4: details (data-driven) ─────────────────────────────
function DetailsStep({ form, set }) {
  const def = postTypeDef(form.platform, form.postType);
  const setDetail = (fid, v) => set({ details: { ...form.details, [fid]: v } });
  if (!def) return null;
  return (
    <div>
      <ComposerHelpers form={form} def={def} setDetail={setDetail} />
      {def.fields.map(fid => {
        const f = fieldDef(fid);
        if (!f) return null;
        if (f.control === "media") {
          // The reel cover is a SEPARATE selection from the post's main media —
          // bind it to details.thumbnail; every other media field is the main media.
          if (fid === "thumbnail")
            return <MediaPicker key={fid} field={f} value={form.details.thumbnail || []} onChange={(items) => setDetail("thumbnail", items)} />;
          return <MediaPicker key={fid} field={f} value={form.media} onChange={(items) => set({ media: items })} />;
        }
        return <FieldControl key={fid} field={f} value={form.details[fid]} onChange={(v) => setDetail(fid, v)} />;
      })}
      {form.platform === "instagram" && (
        <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Location tagging, licensed music, polls, and AI labels aren't available through Instagram's publishing API, so they can't be set here.
        </div>
      )}
    </div>
  );
}

function FieldControl({ field, value, onChange }) {
  const wrap = { marginBottom: 14 };
  const head = <div style={lbl}>{field.label}{field.required && <span style={{ color: C.primary }}> *</span>}</div>;
  switch (field.control) {
    case "textarea":
      return <div style={wrap}>{head}
        <textarea rows={field.rows || 3} maxLength={field.maxLength} placeholder={field.placeholder} value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...inp, resize: "vertical", lineHeight: 1.5 }} />
        {field.maxLength && <div style={{ fontSize: 12, color: C.textMuted, textAlign: "right", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{(value || "").length}/{field.maxLength}</div>}
      </div>;
    case "text": case "url":
      return <div style={wrap}>{head}
        <input type={field.control === "url" ? "url" : "text"} maxLength={field.maxLength} placeholder={field.placeholder} value={value || ""} onChange={e => onChange(e.target.value)} style={inp} />
      </div>;
    case "select":
      return <div style={wrap}>{head}
        <SearchableSelect fullWidth value={value ?? field.default} options={field.options} onChange={v => onChange(v)} placeholder={field.placeholder || "Select…"} />
      </div>;
    case "toggle":
      return <label style={{ ...wrap, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={value ?? field.default ?? false} onChange={e => onChange(e.target.checked)} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>{field.label}</span>
      </label>;
    case "tags":
      return <TagsInput field={field} value={value || []} onChange={onChange} head={head} wrap={wrap} />;
    default:
      return null;
  }
}

// ── Tags input (chips on Enter) — a composed field: the wrapper carries the fill ──
function TagsInput({ field, value, onChange, head, wrap }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div style={wrap}>{head}
      <div className="fc-searchfield" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", borderRadius: 12, padding: "6px 10px", minHeight: 42, boxSizing: "border-box", background: C.surface }}>
        {value.map(t => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: C.surface2, borderRadius: 999, padding: "4px 6px 4px 10px", fontSize: 12.5, fontWeight: 600, color: C.textSecondary }}>
            {t}
            <button type="button" onClick={() => onChange(value.filter(x => x !== t))} title="Remove"
              style={{ display: "flex", padding: 2, border: "none", background: "transparent", color: C.textMuted, borderRadius: 999, cursor: "pointer" }}><X size={11} strokeWidth={2.5} /></button>
          </span>
        ))}
        <input value={draft} placeholder={field.placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          onBlur={add}
          style={{ flex: 1, minWidth: 120, height: 26, border: "none", outline: "none", background: "transparent", borderRadius: 0, padding: 0, fontSize: 14, fontFamily: FONT, color: C.text }} />
      </div>
    </div>
  );
}

// ── Media picker (library grid + upload, saved to library) ────
function MediaPicker({ field, value, onChange }) {
  const { data, refetch } = useApi(() => api.getMedia(), []);
  const all = data || [];
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const selectedIds = new Set(value.map(m => m.id));

  const items = all.filter(m => {
    if (field.imageOnly) return m.coverType !== "video";
    if (field.videoOnly) return m.coverType === "video";
    return true;
  });

  const toggle = (item) => {
    if (field.multi) onChange(selectedIds.has(item.id) ? value.filter(m => m.id !== item.id) : [...value, item]);
    else onChange(selectedIds.has(item.id) ? [] : [item]);
  };

  const upload = async (fileList) => {
    const files = Array.from(fileList || []).filter(f => /^(image|video)\//.test(f.type));
    if (!files.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      (field.multi ? files : [files[0]]).forEach(f => fd.append("files", f));
      await api.uploadMedia(fd);                 // saved into the Media library
      const fresh = await api.getMedia();        // re-pull (newest first)
      refetch();
      const newItem = fresh[0];
      if (newItem) onChange(field.multi ? [...value, newItem] : [newItem]);
      showToast("Media uploaded to library", "success");
    } catch (e) { showToast(e.message, "error"); }
    finally { setUploading(false); }
  };

  // Ctrl+V paste support (Forge universal pattern)
  useEffect(() => {
    const onPaste = e => { const fl = Array.from(e.clipboardData?.files || []); if (fl.length) { upload(fl); e.preventDefault(); } };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={lbl}>{field.label}{field.required && <span style={{ color: C.primary }}> *</span>}
        <span style={{ fontWeight: 500, color: C.textMuted, textTransform: "none", letterSpacing: 0 }}> · {field.multi ? "select one or more" : "select one"}</span>
      </div>

      <div onClick={() => inputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}
        style={{ borderRadius: 12, padding: "14px", textAlign: "center", cursor: "pointer", background: C.surface, marginBottom: 10, fontSize: 13, fontWeight: 550, color: C.textSecondary, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Upload size={15} color={C.primary} /> {uploading ? "Uploading…" : "Upload new (click, drag, or Ctrl+V) — saved to Media library"}
        <input ref={inputRef} type="file" accept={field.accept} multiple={field.multi} style={{ display: "none" }}
          onChange={e => { upload(e.target.files); e.target.value = ""; }} />
      </div>

      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: C.textMuted, padding: "8px 0" }}>No matching media in your library yet — upload above.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, maxHeight: 200, overflowY: "auto" }}>
          {items.map(m => {
            const on = selectedIds.has(m.id);
            return (
              <div key={m.id} onClick={() => toggle(m)} title={m.title} style={{ position: "relative", borderRadius: 12, overflow: "hidden", cursor: "pointer", lineHeight: 0, background: C.surface2 }}>
                {m.coverType === "video"
                  ? <video src={m.coverUrl} muted style={{ width: "100%", height: 72, objectFit: "cover", display: "block", background: C.surface2, opacity: on ? .85 : 1 }} />
                  : <img src={m.coverUrl} alt="" style={{ width: "100%", height: 72, objectFit: "cover", display: "block", opacity: on ? .85 : 1 }} />}
                {/* Picked = an INSET accent ring drawn over the thumbnail (not a border). */}
                {on && <span style={{ position: "absolute", inset: 0, borderRadius: 12, boxShadow: `inset 0 0 0 2px ${C.primary}`, pointerEvents: "none" }} />}
                {on && <span style={{ position: "absolute", top: 5, right: 5, width: 18, height: 18, borderRadius: "50%", background: C.primary, color: C.onAccent, display: "flex", alignItems: "center", justifyContent: "center" }}><Check size={11} strokeWidth={3} /></span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── validation + payload ──────────────────────────────────────
function isStepValid(step, form) {
  if (step === 1) return !!form.platform && form.accountSel.length > 0;
  if (step === 2) {
    if (form.scheduleType === "immediate") return true;
    if (!form.scheduledAt) return false;
    return new Date(form.scheduledAt).getTime() > Date.now();
  }
  if (step === 3) return !!form.postType;
  if (step === 4) {
    const def = postTypeDef(form.platform, form.postType);
    if (!def) return false;
    return def.fields.every(fid => {
      const f = fieldDef(fid);
      if (!f || !f.required) return true;
      if (f.control === "media") return form.media.length > 0;
      const v = form.details[fid];
      if (f.control === "tags") return Array.isArray(v) && v.length >= (f.minItems || 1);
      return v != null && String(v).trim() !== "";
    });
  }
  return false;
}

function buildPayload(form, asDraft = false) {
  const def = postTypeDef(form.platform, form.postType);
  const details = { ...form.details };
  // apply select/toggle defaults the user never touched
  (def?.fields || []).forEach(fid => {
    const f = fieldDef(fid);
    if (f && f.control !== "media" && details[fid] === undefined && f.default !== undefined) details[fid] = f.default;
  });
  // Secondary media (reel cover) → send just the media id; drop the bulky object.
  if (Array.isArray(details.thumbnail)) {
    details.thumbnailMediaId = details.thumbnail[0]?.id ?? null;
    delete details.thumbnail;
  }
  const sel = form.accountSel.length ? form.accountSel : [{ accountId: form.accountId, accountLabel: form.accountLabel }];
  // All selected accounts are the same platform + post type, so each target shares
  // the post type; caption/media/details are shared at the top level (fan-out).
  const targets = sel.map(s => ({
    platform: form.platform, accountId: s.accountId, accountLabel: s.accountLabel, postType: form.postType,
  }));
  return {
    // single-post fields (back-compat) = the first target
    platform: form.platform, accountId: targets[0].accountId, accountLabel: targets[0].accountLabel,
    postType: form.postType,
    targets,                                  // fan-out list (N jobs)
    scheduleType: asDraft ? "draft" : form.scheduleType,
    scheduledAt: form.scheduleType === "scheduled" ? new Date(form.scheduledAt).toISOString() : null,
    caption: details.caption || details.text || null,
    mediaIds: form.media.map(m => m.id),
    details,
  };
}
