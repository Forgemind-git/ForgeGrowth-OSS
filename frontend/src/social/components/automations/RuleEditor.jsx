import { useState, useEffect, useMemo } from "react";
import { Save, Trash2, Loader2, Plus, Check, ExternalLink, ChevronDown, X, MessageCircle, MessageSquareReply, Hand, Send, AtSign, MousePointerClick, MessageSquare, Reply, UserPlus, Clock } from "lucide-react";
import { api } from "../../api.js";
import { C, FONT, INPUT, BTN, T } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { useConfirm } from "../../ConfirmDialog.jsx";
import { Toggle, PillTabs } from "../UI.jsx";
import { SearchableSelect, MultiSelect } from "../Dropdown.jsx";
import { useCrm, createTag } from "../contacts/crmStore.js";
import MessageBuilder from "./MessageBuilder.jsx";
import { SimPhone } from "./PhonePreview.jsx";
import {
  TRIGGERS, FIELD_TYPES, GATE_DEFAULTS, FOLLOWUP_DELAYS, Field, SettingRow, ChipsInput,
  dmToGraph, dmFromGraph, buildDmSteps, hasPostView,
} from "./shared.jsx";

const MATCH_TYPES = [
  { value: "contains",    label: "Contains the word" },
  { value: "exact",       label: "Is exactly the word" },
  { value: "starts_with", label: "Starts with the word" },
];

// `seed` (a template) fills a new rule; an existing `rule` always wins.
function fromRule(rule, accountId, seed) {
  const r = rule || seed || null;
  return {
    name: r?.name || "",
    account_id: rule?.account_id || accountId || "",
    trigger: r?.trigger || "comment",
    media_id: r?.media_id || "",
    postMode: r?.media_id ? "one" : rule ? "any" : "one",
    keywords: r?.keywords || [],
    wordMode: r?.keywords?.length || (!rule && ["comment", "dm"].includes(r?.trigger || "comment")) ? "some" : "any",
    match_type: r?.match_type || "contains",
    replyOn: rule ? !!rule.reply_texts?.length : (seed ? !!seed.reply_texts?.length : true),
    reply_texts: r?.reply_texts?.length ? r.reply_texts : ["Thanks! Please see DMs.", "Sent you a message! Check it out!"],
    dm: dmFromGraph(r?.dm_message),
    dm_fallback_text: r?.dm_fallback_text || "",
    once_per_user: rule ? !!rule.once_per_user : true,
    include_replies: !!rule?.include_replies,
    active: rule ? !!rule.active : true,
    tags: r?.tags || [],
    opening_dm: !!r?.opening_dm,
    follow_gate: !!r?.follow_gate,
    gate_text: r?.gate_text || "",
    gate_button: r?.gate_button || "",
    follow_gate_text: r?.follow_gate_text || "",
    collect: Array.isArray(r?.collect) ? r.collect : [],
    collect_done_text: r?.collect_done_text || "",
    sheet_id: r?.sheet_id || "",
    sheet_tab: r?.sheet_tab || "",
    followup_enabled: !!r?.followup_enabled,
    followup_delay_min: r?.followup_delay_min || 240,
    followup_text: r?.followup_text || "",
    followup_link: r?.followup_link !== false,
  };
}

// UI state → the API body (Graph-format message). Also drives the preview.
function toBody(f) {
  const isComment = f.trigger === "comment";
  const keyed = isComment || f.trigger === "dm" || f.trigger === "story_reply";
  return {
    name: f.name.trim(), account_id: f.account_id, trigger: f.trigger,
    media_id: isComment && f.postMode === "one" ? (f.media_id || null) : null,
    keywords: f.trigger === "postback" ? f.keywords : keyed && f.wordMode === "some" ? f.keywords : [],
    match_type: f.match_type,
    reply_texts: isComment && f.replyOn ? f.reply_texts.map(s => s.trim()).filter(Boolean) : [],
    dm_message: dmToGraph(f.dm),
    dm_fallback_text: f.dm.kind !== "text" ? (f.dm_fallback_text.trim() || null) : null,
    once_per_user: f.once_per_user, include_replies: f.include_replies, active: f.active,
    tags: f.tags,
    opening_dm: isComment && (f.opening_dm || f.follow_gate || f.collect.length > 0 || f.followup_enabled),
    follow_gate: f.follow_gate,
    gate_text: f.gate_text.trim() || null, gate_button: f.gate_button.trim() || null,
    follow_gate_text: f.follow_gate_text.trim() || null,
    collect: f.collect, collect_done_text: f.collect_done_text.trim() || null,
    sheet_id: f.sheet_id.trim() || null, sheet_tab: f.sheet_tab.trim() || null,
    followup_enabled: f.followup_enabled, followup_delay_min: Number(f.followup_delay_min) || 240,
    followup_text: f.followup_enabled ? (f.followup_text.trim() || GATE_DEFAULTS.followup_text) : (f.followup_text.trim() || null),
    followup_link: f.followup_link,
  };
}

const TRIGGER_TITLE = {
  comment: "When someone comments on",
  dm: "When someone DMs you",
  postback: "When someone taps a button",
  story_reply: "When someone replies to your story",
  story_mention: "When someone mentions you in their story",
};
const TRIGGER_ICON = { comment: MessageCircle, dm: MessageSquare, postback: MousePointerClick, story_reply: Reply, story_mention: AtSign };

export default function RuleEditor({ rule, seed, accounts, defaultAccount, meta, isAdmin, onDone, onCancel }) {
  const [f, setF] = useState(() => fromRule(rule, defaultAccount, seed));
  const [posts, setPosts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [pv, setPv] = useState(hasPostView(f.trigger) ? "post" : "dm");
  const [more, setMore] = useState(() => !!(rule && (rule.collect?.length || rule.tags?.length || rule.include_replies)));
  const [ConfirmDialog, confirm] = useConfirm();
  const { tags: allTags } = useCrm();
  const set = (patch) => setF(prev => ({ ...prev, ...patch }));
  const ro = !isAdmin;

  useEffect(() => {
    if (!f.account_id) { setPosts([]); return; }
    api.automations.posts(f.account_id).then(setPosts).catch(() => setPosts([]));
  }, [f.account_id]);
  useEffect(() => { if (!hasPostView(f.trigger)) setPv("dm"); }, [f.trigger]);

  const account = accounts.find(a => a.account_id === f.account_id);
  const isComment = f.trigger === "comment";
  const keyed = isComment || f.trigger === "dm" || f.trigger === "story_reply";
  // Follow check, questions and the follow-up all need them to tap first (Meta: one private reply, then nothing until they respond).
  const forcedOpening = isComment && (f.follow_gate || f.collect.length > 0 || f.followup_enabled);
  const openingOn = isComment && (f.opening_dm || forcedOpening);
  const body = useMemo(() => toBody(f), [f]);
  // Preview + simulator show link/reply buttons as soon as they have a title, before the URL is filled in.
  const simRule = useMemo(() => ({ ...body, dm_message: dmToGraph({ ...f.dm,
    buttons: f.dm.buttons.map(b => ({ ...b, url: b.url || "https://", payload: b.payload || "_" })) }) }), [body, f.dm]);
  const steps = useMemo(() => buildDmSteps(simRule, account?.username), [simRule, account]);
  const selectedPost = posts.find(p => p.id === f.media_id);
  const previewPost = f.postMode === "any" ? { any: true } : selectedPost || null;

  function validate() {
    if (!f.name.trim()) return "Give the automation a name.";
    if (!f.account_id) return "Pick the Instagram account.";
    if (isComment && f.postMode === "one" && !f.media_id) return "Pick the post or reel, or choose “Any post”.";
    if (keyed && f.wordMode === "some" && !f.keywords.length) return "Add at least one word, or choose “Any word”.";
    if (f.trigger === "dm" && !f.keywords.length) return "Add at least one keyword. Without one it would answer every DM.";
    if (f.trigger === "postback" && !f.keywords.length) return "Add the button code(s) this automation answers.";
    if (f.dm.kind !== "text" && !body.dm_message) return "Finish the DM: it needs text (or a card title).";
    if ((f.dm.buttons || []).some(b => b.type === "web_url" && b.title && !/^https?:\/\//i.test(b.url || ""))) return "Every link button needs a full link starting with https://";
    if (!body.dm_message && !f.collect.length && !body.reply_texts.length) return "Add something to send: a DM, questions or a public reply.";
    if (f.collect.some(q => !q.prompt.trim())) return "Every question needs its wording.";
    if (f.followup_enabled && !body.dm_message) return "A follow-up needs a DM to follow up on.";
    if ((f.sheet_id && !f.sheet_tab) || (!f.sheet_id && f.sheet_tab)) return "For Google Sheets, fill in both the sheet ID and the tab name.";
    return null;
  }

  async function save() {
    const err = validate();
    if (err) { showToast(err, "error"); return; }
    setSaving(true);
    try {
      const saved = rule?.id ? await api.automations.update(rule.id, body) : await api.automations.create(body);
      showToast(rule?.id ? "Automation saved" : (body.active ? "Automation is live" : "Automation created"), "success");
      onDone(saved);
    } catch (e) { showToast(e.message, "error"); }
    finally { setSaving(false); }
  }

  async function remove() {
    const ok = await confirm({ title: "Delete this automation?", body: `“${rule.name}” stops immediately. Its activity log is deleted too; captured leads are kept.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await api.automations.remove(rule.id); showToast("Automation deleted", "success"); onDone(null); }
    catch (e) { showToast(e.message, "error"); }
  }

  const accountOptions = accounts.map(a => ({ value: a.account_id, label: "@" + a.username, sublabel: a.name || undefined }));
  const triggerOptions = TRIGGERS.map(t => ({ value: t.id, label: t.label }));
  const tagOptions = allTags.map(t => ({ value: t.id, label: t.name }));
  const show = (v) => () => setPv(v);
  const [simTesting, setSimTesting] = useState(false);

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
      {ConfirmDialog}
      {/* While testing, the form gives up some width so "What happened" fits beside the phone. */}
      <div style={{ flex: "1 1 460px", minWidth: 0, maxWidth: simTesting ? 500 : 620, transition: "max-width .2s" }}>

        {/* Name · account · trigger */}
        <div style={{ background: C.raised, borderRadius: 16, padding: "14px 16px 16px", marginBottom: 14 }}>
          <input value={f.name} disabled={ro} onChange={e => set({ name: e.target.value })} placeholder="Name this automation"
            style={{ ...INPUT, background: "transparent", padding: "2px 0 10px", fontSize: 19, fontWeight: 750, letterSpacing: "-0.02em" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 10 }}>
            <SearchableSelect fullWidth value={f.account_id} options={accountOptions} onChange={v => set({ account_id: v, media_id: "" })} disabled={ro} placeholder="Instagram account" />
            <SearchableSelect fullWidth value={f.trigger} options={triggerOptions} disabled={ro}
              onChange={v => set({ trigger: v, keywords: v === f.trigger ? f.keywords : [], wordMode: v === "dm" ? "some" : f.wordMode })} />
          </div>
        </div>

        {/* 1 · trigger */}
        <StepCard Icon={TRIGGER_ICON[f.trigger] || MessageCircle} title={TRIGGER_TITLE[f.trigger]} onFocus={show(isComment ? "post" : "dm")}>
          {isComment && (
            <>
              <PillTabs size="sm" value={f.postMode} onChange={v => { if (!ro) { set({ postMode: v }); setPv("post"); } }}
                tabs={[{ id: "one", label: "This post" }, { id: "any", label: "Any post" }]} />
              {f.postMode === "one" && <div style={{ marginTop: 12 }}><PostPicker posts={posts} value={f.media_id} onChange={v => set({ media_id: v })} disabled={ro} /></div>}
            </>
          )}
          {keyed && (
            <div style={{ marginTop: isComment ? 16 : 0 }} onFocusCapture={show(isComment ? "comments" : "dm")}>
              {isComment && <SubLabel>That has</SubLabel>}
              {f.trigger !== "dm" && (
                <PillTabs size="sm" value={f.wordMode} onChange={v => { if (!ro) { set({ wordMode: v }); setPv(isComment ? "comments" : "dm"); } }}
                  tabs={[{ id: "some", label: "These words" }, { id: "any", label: "Any word" }]} />
              )}
              {(f.trigger === "dm" || f.wordMode === "some") && (
                <div style={{ marginTop: f.trigger === "dm" ? 0 : 10 }}>
                  <ChipsInput values={f.keywords} onChange={v => set({ keywords: v })} disabled={ro} placeholder="Type a word, press Enter (e.g. AI, price)" />
                </div>
              )}
            </div>
          )}
          {f.trigger === "postback" && (
            <ChipsInput upper values={f.keywords} onChange={v => set({ keywords: v })} disabled={ro} placeholder="Button code, e.g. QUOTE" />
          )}
        </StepCard>

        {/* 2 · public reply */}
        {isComment && (
          <StepCard Icon={MessageSquareReply} title="Reply under the comment" onFocus={show("comments")}
            right={<Toggle on={f.replyOn} onChange={v => { set({ replyOn: v }); setPv("comments"); }} disabled={ro} />}>
            {f.replyOn && (
              <>
                {f.reply_texts.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input value={t} disabled={ro} maxLength={300}
                      onChange={e => set({ reply_texts: f.reply_texts.map((x, j) => j === i ? e.target.value : x) })} style={INPUT} placeholder="Thanks! Please see DMs." />
                    {!ro && f.reply_texts.length > 1 && <button type="button" onClick={() => set({ reply_texts: f.reply_texts.filter((_, j) => j !== i) })} style={BTN.icon} aria-label="Remove wording"><X size={14} /></button>}
                  </div>
                ))}
                {!ro && f.reply_texts.length < 8 && <button type="button" onClick={() => set({ reply_texts: [...f.reply_texts, ""] })} style={{ ...BTN.ghost, padding: "4px 2px", fontSize: 13 }}><Plus size={14} /> Add a wording</button>}
                <Hint>One is picked at random each time.</Hint>
              </>
            )}
          </StepCard>
        )}

        {/* 3 · opening message (optional) */}
        {isComment && (
          <StepCard Icon={Hand} title="Opening message first" onFocus={show("dm")}
            right={<Toggle on={openingOn} onChange={v => { set({ opening_dm: v }); setPv("dm"); }} disabled={ro || forcedOpening} />}>
            {openingOn ? (
              <>
                <textarea value={f.gate_text} disabled={ro} rows={2} maxLength={640} onChange={e => set({ gate_text: e.target.value })} placeholder={GATE_DEFAULTS.gate_text} style={{ ...INPUT, resize: "vertical", marginBottom: 8 }} />
                <input value={f.gate_button} disabled={ro} maxLength={20} onChange={e => set({ gate_button: e.target.value })} placeholder={`Button: ${GATE_DEFAULTS.gate_button}`} style={INPUT} />
                <SettingRow title="Only for followers" hint="Asks them to follow before sending the DM." on={f.follow_gate} onChange={v => set({ follow_gate: v })} disabled={ro} />
                {f.follow_gate && (
                  <textarea value={f.follow_gate_text} disabled={ro} rows={2} maxLength={640} onChange={e => set({ follow_gate_text: e.target.value })} placeholder={GATE_DEFAULTS.follow_gate_text} style={{ ...INPUT, resize: "vertical" }} />
                )}
              </>
            ) : <Hint style={{ marginTop: 0 }}>Off: the DM below goes out straight away.</Hint>}
          </StepCard>
        )}

        {/* 3b · follow check (DM / story / button triggers — they just messaged us) */}
        {!isComment && (
          <StepCard Icon={UserPlus} title="Ask for a follow first" onFocus={show("dm")}
            right={<Toggle on={f.follow_gate} onChange={v => { set({ follow_gate: v }); setPv("dm"); }} disabled={ro} />}>
            {f.follow_gate ? (
              <>
                <textarea value={f.follow_gate_text} disabled={ro} rows={2} maxLength={640} onChange={e => set({ follow_gate_text: e.target.value })} placeholder={GATE_DEFAULTS.follow_gate_text} style={{ ...INPUT, resize: "vertical" }} />
                <Hint>People who don't follow you get this with an “I've followed” button. The DM below goes out once they follow. If Instagram can't tell, they get the DM anyway.</Hint>
              </>
            ) : <Hint style={{ marginTop: 0 }}>Off: everyone gets the DM below.</Hint>}
          </StepCard>
        )}

        {/* 4 · the DM */}
        <StepCard Icon={Send} title="Send a DM" onFocus={show("dm")}>
          <MessageBuilder dm={f.dm} onChange={dm => set({ dm })} disabled={ro} />
        </StepCard>

        {/* 5 · follow-up */}
        <StepCard Icon={Clock} title="Follow up if they don't respond" last onFocus={show("dm")}
          right={<Toggle on={f.followup_enabled} onChange={v => { set({ followup_enabled: v, followup_text: v && !f.followup_text ? GATE_DEFAULTS.followup_text : f.followup_text }); setPv("dm"); }} disabled={ro} />}>
          {f.followup_enabled ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ fontSize: 13.5, color: C.textSecondary }}>Wait</span>
                <SearchableSelect value={Number(f.followup_delay_min)} options={FOLLOWUP_DELAYS} onChange={v => set({ followup_delay_min: v })} disabled={ro} />
                <span style={{ fontSize: 13.5, color: C.textSecondary }}>then send:</span>
              </div>
              <textarea value={f.followup_text} disabled={ro} rows={2} maxLength={640} onChange={e => set({ followup_text: e.target.value })} placeholder={GATE_DEFAULTS.followup_text} style={{ ...INPUT, resize: "vertical" }} />
              {(f.dm.buttons || []).some(b => b.type === "web_url") && (
                <SettingRow title="Include the link buttons again" on={f.followup_link} onChange={v => set({ followup_link: v })} disabled={ro} />
              )}
              <Hint>
                Only sent if they haven't tapped the link or replied by then. Instagram allows it within 24 hours of their last message, so later ones are skipped.
                {isComment && " For comments this turns on the opening message: Instagram allows one private reply to a comment and nothing more until they tap, so the follow-up counts from their tap."}
              </Hint>
            </>
          ) : <Hint style={{ marginTop: 0 }}>Off: no second message.</Hint>}
        </StepCard>

        {/* More */}
        <button type="button" onClick={() => setMore(m => !m)} style={{ ...BTN.ghost, padding: "8px 2px", margin: "6px 0 8px" }}>
          <ChevronDown size={15} style={{ transform: more ? "rotate(180deg)" : "none", transition: "transform .15s" }} /> More options
        </button>
        {more && (
          <div style={{ background: C.raised, borderRadius: 16, padding: "6px 16px 16px", marginBottom: 16 }}>
            {keyed && f.wordMode === "some" && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 0" }}>
                <div style={{ fontSize: 14, fontWeight: 650, color: C.text }}>Word match</div>
                <SearchableSelect value={f.match_type} options={MATCH_TYPES} onChange={v => set({ match_type: v })} disabled={ro} />
              </div>
            )}
            {isComment && (
              <>
                <SettingRow title="Once per person per post" on={f.once_per_user} onChange={v => set({ once_per_user: v })} disabled={ro} />
                <SettingRow title="Also answer replies to comments" on={f.include_replies} onChange={v => set({ include_replies: v })} disabled={ro} />
              </>
            )}
            {f.dm.kind !== "text" && (
              <Field label="Plain-text backup" hint="Sent if Instagram rejects the buttons or card." style={{ marginTop: 10 }}>
                <textarea value={f.dm_fallback_text} disabled={ro} rows={2} onChange={e => set({ dm_fallback_text: e.target.value })} style={{ ...INPUT, resize: "vertical" }} placeholder="Here's the link: https://…" />
              </Field>
            )}
            <Field label="Tag the contact" style={{ marginTop: 10 }}>
              <MultiSelect values={f.tags} options={tagOptions} onChange={v => !ro && set({ tags: v })} placeholder="No tags" onCreate={ro ? undefined : createTag} createLabel="Create tag" emptyText="No tags yet." />
            </Field>

            <div style={{ ...LABEL_STYLE, marginTop: 6 }}>Ask questions after the DM</div>
            {f.collect.map((q, i) => (
              <div key={i} style={{ background: C.surface, borderRadius: 12, padding: 10, marginBottom: 8 }} onFocus={show("dm")}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <SearchableSelect value={q.type} options={FIELD_TYPES} disabled={ro} minWidth={110}
                    onChange={v => set({ collect: f.collect.map((x, j) => j === i ? { ...x, type: v, key: v === "text" ? (x.key || "answer") : v, label: FIELD_TYPES.find(t => t.value === v)?.label } : x) })} />
                  {q.type === "text" && <input value={q.label || ""} disabled={ro} maxLength={40} onChange={e => set({ collect: f.collect.map((x, j) => j === i ? { ...x, label: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "answer" } : x) })} placeholder="Column name" style={{ ...INPUT, background: C.raised, width: "auto", flex: "1 1 140px" }} />}
                  <span style={{ flex: 1 }} />
                  {!ro && <button type="button" onClick={() => set({ collect: f.collect.filter((_, j) => j !== i) })} style={BTN.icon} aria-label="Remove question"><Trash2 size={14} /></button>}
                </div>
                <input value={q.prompt} disabled={ro} maxLength={1000} onChange={e => set({ collect: f.collect.map((x, j) => j === i ? { ...x, prompt: e.target.value } : x) })}
                  placeholder={q.type === "email" ? "What's your email address?" : q.type === "phone" ? "What's the best number to reach you on?" : q.type === "name" ? "What's your name?" : "What are you looking for?"} style={{ ...INPUT, background: C.raised }} />
              </div>
            ))}
            {!ro && f.collect.length < 6 && (
              <button type="button" onClick={() => { set({ collect: [...f.collect, { type: f.collect.length ? "phone" : "name", key: f.collect.length ? "phone" : "name", label: f.collect.length ? "Phone" : "Name", prompt: "" }] }); setPv("dm"); }} style={{ ...BTN.secondary, padding: "7px 14px", fontSize: 13 }}><Plus size={14} /> Add a question</button>
            )}
            {f.collect.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <textarea value={f.collect_done_text} disabled={ro} rows={2} onChange={e => set({ collect_done_text: e.target.value })} placeholder={`After the last answer: ${GATE_DEFAULTS.collect_done_text}`} style={{ ...INPUT, resize: "vertical", marginBottom: 10 }} />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 8 }}>
                  <input value={f.sheet_id} disabled={ro} onChange={e => set({ sheet_id: e.target.value })} style={INPUT} placeholder="Google Sheet ID (optional)" />
                  <input value={f.sheet_tab} disabled={ro} onChange={e => set({ sheet_tab: e.target.value })} style={INPUT} placeholder="Sheet tab name" />
                </div>
                {(f.sheet_id || f.sheet_tab) && (
                  <Hint>{meta?.sheetsConfigured ? <>Share the sheet with <b>{meta.sheetsEmail}</b> as Editor.</> : "Google Sheets isn't set up on the server yet, so leads only go to the Leads tab."}</Hint>
                )}
                <Hint>Answers are checked and saved under Leads. Typing STOP ends it.</Hint>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ position: "sticky", bottom: 0, zIndex: 2, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "12px 0 16px", background: C.card }}>
          {isAdmin && rule?.id && <button type="button" onClick={remove} style={{ ...BTN.ghost, color: C.errText, padding: "10px 8px" }}><Trash2 size={15} /> Delete</button>}
          <span style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 650, color: f.active ? C.green : C.textMuted }}>
            {f.active ? "Live" : "Off"}
            <Toggle on={f.active} onChange={v => set({ active: v })} disabled={ro} />
          </span>
          {onCancel && <button type="button" onClick={onCancel} style={BTN.secondary}>Cancel</button>}
          {isAdmin && <button type="button" onClick={save} disabled={saving} style={BTN.primary}>{saving ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={15} />} {rule?.id ? "Save" : f.active ? "Save & go live" : "Save"}</button>}
        </div>
      </div>

      <div style={{ flex: "1 1 320px", display: "flex", justifyContent: "center", position: "sticky", top: 12 }}>
        <SimPhone rule={simRule} account={account?.username} post={previewPost} view={pv} onView={setPv} previewSteps={steps} onTestingChange={setSimTesting} />
      </div>
    </div>
  );
}

const LABEL_STYLE = { ...T.label, color: C.textSecondary, marginBottom: 8 };
const SubLabel = ({ children }) => <div style={LABEL_STYLE}>{children}</div>;
const Hint = ({ children, style }) => <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 8, lineHeight: 1.4, ...style }}>{children}</div>;

// One step of the automation: icon + title (+ a toggle on the right), joined to the next step by a short line.
export function StepCard({ Icon, title, right, children, onFocus, last }) {
  return (
    <div onFocusCapture={onFocus}>
      <div style={{ background: C.raised, borderRadius: 16, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: children ? 12 : 0 }}>
          <span style={{ width: 30, height: 30, borderRadius: "50%", background: C.primarySoft, color: C.primary, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={15} /></span>
          <span style={{ flex: 1, fontSize: 15.5, fontWeight: 750, letterSpacing: "-0.01em", color: C.text }}>{title}</span>
          {right}
        </div>
        {children}
      </div>
      {!last && <div style={{ width: 2, height: 14, background: C.surface2, marginLeft: 30 }} />}
    </div>
  );
}

export function PostPicker({ posts, value, onChange, disabled }) {
  const [open, setOpen] = useState(!value);
  const chosen = posts.find(p => p.id === value);
  if (value && !open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {chosen?.thumbnail
          ? <img src={chosen.thumbnail} alt="" style={{ width: 72, height: 90, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} />
          : <div style={{ width: 72, height: 90, borderRadius: 10, background: C.surface2, flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{chosen?.caption || `Post ${value.slice(-6)}`}</div>
          {!disabled && <button type="button" onClick={() => setOpen(true)} style={{ ...BTN.secondary, padding: "6px 12px", fontSize: 13, marginTop: 8 }}>Change post</button>}
        </div>
      </div>
    );
  }
  const pick = (id) => { onChange(id); setOpen(false); };
  const tile = (on) => ({ position: "relative", borderRadius: 10, overflow: "hidden", cursor: disabled ? "default" : "pointer", background: C.surface2, aspectRatio: "4 / 5",
    outline: on ? `2.5px solid ${C.primary}` : "none", outlineOffset: -2.5, border: "none", padding: 0, width: "100%" });
  const tick = <span style={{ position: "absolute", top: 5, right: 5, width: 20, height: 20, borderRadius: "50%", background: C.primary, color: C.onAccent, display: "flex", alignItems: "center", justifyContent: "center" }}><Check size={12} strokeWidth={3} /></span>;
  if (!posts.length && !value) return <div style={{ fontSize: 13, color: C.textMuted }}>No synced posts for this account yet. They appear after the next sync.</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: 6, maxHeight: 280, overflowY: "auto", paddingRight: 2 }}>
      {posts.map(p => (
        <button type="button" key={p.id} title={(p.caption || "").slice(0, 120)} onClick={() => !disabled && pick(p.id)} style={tile(value === p.id)}>
          {p.thumbnail ? <img src={p.thumbnail} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            : <span style={{ fontSize: 11, color: C.textMuted, padding: 6, display: "block" }}>{(p.caption || "Post").slice(0, 40)}</span>}
          {value === p.id && tick}
          {p.permalink && <a href={p.permalink} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} title="Open on Instagram"
            style={{ position: "absolute", bottom: 4, right: 4, width: 20, height: 20, borderRadius: "50%", background: "rgba(0,0,0,.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}><ExternalLink size={10} /></a>}
        </button>
      ))}
      {value && !posts.some(p => p.id === value) && (
        <div style={{ ...tile(true), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: C.textMuted, padding: 6, textAlign: "center" }}>Post {value.slice(-6)}{tick}</div>
      )}
    </div>
  );
}
