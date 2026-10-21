import { X, Plus, Trash2, Link2, ArrowRight, Copy } from "lucide-react";
import { C, FONT, INPUT, BTN, T } from "../../constants.js";
import { Toggle, PillTabs } from "../UI.jsx";
import { SearchableSelect, MultiSelect } from "../Dropdown.jsx";
import { ChipsInput, SettingRow } from "../automations/shared.jsx";
import { PostPicker } from "../automations/RuleEditor.jsx";
import { NODE_TYPES, TRIGGER_KINDS, newTrigger, rid } from "./flowDefs.js";
import { createTag, createField } from "../contacts/crmStore.js";

// Right-hand editor for the selected step. `node.data` is edited in place via onChange(data).
export default function NodePanel({ node, onChange, onClose, onDelete, onDuplicate, ctx, readOnly }) {
  const def = NODE_TYPES[node.type];
  const d = node.data || {};
  const set = (patch) => onChange({ ...d, ...patch });
  const Editor = EDITORS[node.type];
  return (
    <div style={{ width: 360, maxWidth: "100%", height: "100%", background: "var(--fs-node-bg)", borderRadius: 16, display: "flex", flexDirection: "column", fontFamily: FONT, boxShadow: "0 0 0 1px var(--fs-node-ring), var(--fs-node-shadow)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", boxShadow: `inset 0 -1px 0 ${C.surface2}` }}>
        <def.Icon size={16} color={C[def.ink]} />
        <span style={{ ...T.h3, color: C.text, flex: 1 }}>{def.label}</span>
        {node.type !== "trigger" && !readOnly && <button type="button" onClick={onDuplicate} style={{ ...BTN.icon, width: 30, height: 30 }} title="Duplicate step" aria-label="Duplicate step"><Copy size={14} /></button>}
        {node.type !== "trigger" && !readOnly && <button type="button" onClick={onDelete} style={{ ...BTN.icon, width: 30, height: 30, color: C.errText }} title="Delete step" aria-label="Delete step"><Trash2 size={14} /></button>}
        <button type="button" onClick={onClose} style={{ ...BTN.icon, width: 30, height: 30 }} title="Close" aria-label="Close"><X size={15} /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        <fieldset disabled={readOnly} style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
          {Editor ? <Editor d={d} set={set} ctx={ctx} node={node} /> : null}
        </fieldset>
      </div>
    </div>
  );
}

const Label = ({ children, style }) => <div style={{ ...T.label, color: C.textSecondary, margin: "14px 0 6px", ...style }}>{children}</div>;
const Hint = ({ children }) => <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, lineHeight: 1.4 }}>{children}</div>;
const Box = ({ children, style }) => <div style={{ background: C.surface, borderRadius: 12, padding: 12, marginBottom: 10, ...style }}>{children}</div>;
const inp = { ...INPUT, background: C.raised };
const small = { ...BTN.secondary, padding: "6px 12px", fontSize: 12.5 };
const iconBtn = { ...BTN.icon, width: 28, height: 28, background: C.raised };
// Keep a value saved before field definitions existed visible in the picker.
const withCurrent = (opts = [], v) => (v && !opts.some(o => o.value === v) ? [...opts, { value: v, label: v }] : opts);
const mapAt = (arr, i, patch) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x));
const VARS_HINT = "Use {first_name}, {username} or any saved field like {email}.";

// ── trigger ──
function TriggerEditor({ d, set, ctx }) {
  const ts = d.triggers || [];
  const used = new Set(ts.map(t => t.kind));
  const upd = (i, patch) => set({ triggers: mapAt(ts, i, patch) });
  return (
    <>
      {ts.length === 0 && <Hint>Pick what starts this automation.</Hint>}
      {ts.map((t, i) => {
        const k = TRIGGER_KINDS.find(x => x.id === t.kind);
        return (
          <Box key={t.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {k && <k.Icon size={15} color={C.green} />}
              <b style={{ flex: 1, fontSize: 14, color: C.text }}>{k?.label}</b>
              <button type="button" onClick={() => set({ triggers: ts.filter((_, j) => j !== i) })} style={iconBtn} aria-label="Remove trigger"><Trash2 size={13} /></button>
            </div>
            {t.kind === "called" && <CalledHint ctx={ctx} />}
            {t.kind === "comment" && (
              <>
                <Label>On</Label>
                <PillTabs size="sm" value={t.postMode} onChange={v => upd(i, { postMode: v })} tabs={[{ id: "one", label: "A specific post" }, { id: "any", label: "Any post" }, { id: "next", label: "Next post" }]} />
                {t.postMode === "one" && <div style={{ marginTop: 10 }}><PostPicker posts={ctx.posts} value={t.mediaId} onChange={v => upd(i, { mediaId: v })} /></div>}
                {t.postMode === "next" && <Hint>Locks onto the first post or reel you publish after going live.</Hint>}
              </>
            )}
            {(t.kind === "comment" || t.kind === "dm" || t.kind === "story_reply") && (
              <>
                <Label>{t.kind === "comment" ? "Comment has" : "Message has"}</Label>
                {t.kind !== "dm" && <PillTabs size="sm" value={t.anyWord ? "any" : "some"} onChange={v => upd(i, { anyWord: v === "any" })} tabs={[{ id: "some", label: "Specific words" }, { id: "any", label: "Any word" }]} />}
                {(t.kind === "dm" || !t.anyWord) && <div style={{ marginTop: 8 }}><ChipsInput values={t.keywords || []} onChange={v => upd(i, { keywords: v })} placeholder="Type a word, press Enter" /></div>}
                <Label>Ignore if it contains</Label>
                <ChipsInput values={t.exclude || []} onChange={v => upd(i, { exclude: v })} placeholder="Optional, e.g. spam" />
              </>
            )}
            {t.kind === "comment" && (
              <>
                <Label>Public reply under the comment</Label>
                {(t.replyTexts || []).map((r, j) => (
                  <div key={j} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input value={r} onChange={e => upd(i, { replyTexts: t.replyTexts.map((x, k2) => (k2 === j ? e.target.value : x)) })} style={inp} maxLength={300} />
                    <button type="button" onClick={() => upd(i, { replyTexts: t.replyTexts.filter((_, k2) => k2 !== j) })} style={iconBtn} aria-label="Remove reply"><X size={13} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => upd(i, { replyTexts: [...(t.replyTexts || []), ""] })} style={small}><Plus size={13} /> Add a reply</button>
                <Hint>One is picked at random. Leave empty to only DM.</Hint>
                <SettingRow title="Once per person per post" on={t.oncePerUser !== false} onChange={v => upd(i, { oncePerUser: v })} />
                <SettingRow title="Also answer replies to comments" on={!!t.includeReplies} onChange={v => upd(i, { includeReplies: v })} />
              </>
            )}
            {t.kind === "story_mention" && <Hint>Runs when someone mentions your account in their story.</Hint>}
          </Box>
        );
      })}
      <Label>Add a trigger</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {TRIGGER_KINDS.filter(k => !used.has(k.id)).map(k => (
          <button key={k.id} type="button" onClick={() => set({ triggers: [...ts, newTrigger(k.id)] })} style={small}><k.Icon size={13} /> {k.label}</button>
        ))}
      </div>
    </>
  );
}

// Who sends people into this automation (their "Start another Automation" steps).
function CalledHint({ ctx }) {
  const callers = (ctx.flows || []).filter(f => (f.graph?.nodes || []).some(n => n.type === "goto" && String(n.data?.flowId) === String(ctx.flowId)));
  return (
    <>
      <Hint>No comment or DM starts this. It runs when a “Start another Automation” step in another automation sends someone here, in the same conversation, with their fields and tags. Set it live so those steps can start it.</Hint>
      <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 8 }}>
        {!ctx.flowId ? "Save it first, then pick it in another automation's “Start another Automation” step."
          : callers.length ? <>Started from: {callers.map(f => <b key={f.id} style={{ color: C.text }}>{f.name}{f.active ? "" : " (off)"}</b>).reduce((a, b) => [a, ", ", b])}</>
          : "No automation starts this one yet. Add a “Start another Automation” step in one and pick this."}
      </div>
    </>
  );
}

// ── message ──
function ButtonsEditor({ buttons = [], onChange }) {
  return (
    <>
      {buttons.map((b, i) => (
        <div key={b.id} style={{ background: C.raised, borderRadius: 10, padding: 8, marginTop: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={b.title} maxLength={20} onChange={e => onChange(mapAt(buttons, i, { title: e.target.value }))} placeholder="Button text" style={{ ...INPUT, flex: 1 }} />
            <button type="button" onClick={() => onChange(buttons.filter((_, j) => j !== i))} style={{ ...iconBtn, background: C.surface }} aria-label="Remove button"><Trash2 size={13} /></button>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
            <PillTabs size="sm" value={b.kind} onChange={v => onChange(mapAt(buttons, i, { kind: v }))} tabs={[{ id: "next", label: "Next step", Icon: ArrowRight }, { id: "url", label: "Open link", Icon: Link2 }]} />
            {b.kind === "url" && <input value={b.url} onChange={e => onChange(mapAt(buttons, i, { url: e.target.value.trim() }))} placeholder="https://…" style={{ ...INPUT, flex: "1 1 140px" }} />}
          </div>
        </div>
      ))}
      {buttons.length < 3 && <button type="button" onClick={() => onChange([...buttons, { id: rid(), title: "", kind: "next", url: "" }])} style={{ ...small, marginTop: 8, background: C.raised }}><Plus size={13} /> Add button</button>}
    </>
  );
}

function MessageEditor({ d, set }) {
  const blocks = d.blocks || [];
  const upd = (i, patch) => set({ blocks: mapAt(blocks, i, patch) });
  const add = (type) => set({ blocks: [...blocks, type === "text" ? { id: rid(), type, text: "", buttons: [] } : type === "image" ? { id: rid(), type, url: "" } : { id: rid(), type: "card", title: "", subtitle: "", image_url: "", url: "", buttons: [] }] });
  const qrs = d.quickReplies || [];
  return (
    <>
      {blocks.map((b, i) => (
        <Box key={b.id}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <span style={{ ...T.label, color: C.textMuted, flex: 1 }}>{b.type === "text" ? "Text" : b.type === "image" ? "Image" : "Card"}</span>
            <button type="button" onClick={() => set({ blocks: blocks.filter((_, j) => j !== i) })} style={iconBtn} aria-label="Remove block"><Trash2 size={13} /></button>
          </div>
          {b.type === "text" && (
            <>
              <textarea value={b.text} rows={4} maxLength={1000} onChange={e => upd(i, { text: e.target.value })} placeholder="Write your message…" style={{ ...inp, resize: "vertical", lineHeight: 1.45 }} />
              <div style={{ fontSize: 11, color: C.textMuted, textAlign: "right", marginTop: 3 }}>{(b.text || "").length} / {(b.buttons || []).length ? 640 : 1000}</div>
              <ButtonsEditor buttons={b.buttons} onChange={v => upd(i, { buttons: v })} />
            </>
          )}
          {b.type === "image" && <input value={b.url} onChange={e => upd(i, { url: e.target.value.trim() })} placeholder="Public image URL (https://…)" style={inp} />}
          {b.type === "card" && (
            <>
              <input value={b.title} maxLength={80} onChange={e => upd(i, { title: e.target.value })} placeholder="Title" style={{ ...inp, marginBottom: 6 }} />
              <input value={b.subtitle} maxLength={80} onChange={e => upd(i, { subtitle: e.target.value })} placeholder="Subtitle" style={{ ...inp, marginBottom: 6 }} />
              <input value={b.image_url} onChange={e => upd(i, { image_url: e.target.value.trim() })} placeholder="Image URL" style={{ ...inp, marginBottom: 6 }} />
              <input value={b.url} onChange={e => upd(i, { url: e.target.value.trim() })} placeholder="Opens when tapped (optional)" style={inp} />
              <ButtonsEditor buttons={b.buttons} onChange={v => upd(i, { buttons: v })} />
            </>
          )}
        </Box>
      ))}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button type="button" onClick={() => add("text")} style={small}><Plus size={13} /> Text</button>
        <button type="button" onClick={() => add("image")} style={small}><Plus size={13} /> Image</button>
        <button type="button" onClick={() => add("card")} style={small}><Plus size={13} /> Card</button>
      </div>
      <Hint>{VARS_HINT} Max 3 buttons per text or card.</Hint>

      <Label style={{ marginTop: 20 }}>Quick replies</Label>
      {qrs.map((q, i) => (
        <div key={q.id} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input value={q.title} maxLength={20} onChange={e => set({ quickReplies: mapAt(qrs, i, { title: e.target.value })})} placeholder="Reply chip" style={INPUT} />
          <button type="button" onClick={() => set({ quickReplies: qrs.filter((_, j) => j !== i) })} style={{ ...iconBtn, background: C.surface }} aria-label="Remove quick reply"><X size={13} /></button>
        </div>
      ))}
      {qrs.length < 13 && <button type="button" onClick={() => set({ quickReplies: [...qrs, { id: rid(), title: "" }] })} style={small}><Plus size={13} /> Add quick reply</button>}
      <Hint>Tappable chips under the last text. Each one can lead to its own next step.</Hint>

      <NoReplyEditor nr={d.noReply} onChange={noReply => set({ noReply })} />
    </>
  );
}

// "If they don't respond": an extra output on the message, taken when the person
// hasn't tapped a button / link or written back in time (≤ 23 h, Meta's window).
function NoReplyEditor({ nr, onChange }) {
  const v = nr || { enabled: false, amount: 4, unit: "hours" };
  const max = v.unit === "hours" ? 23 : 1380, min = v.unit === "hours" ? 1 : 15;
  return (
    <div style={{ marginTop: 20 }}>
      <SettingRow title="If they don't respond" hint="Adds a “No response” path to follow up on." on={!!v.enabled}
        onChange={on => onChange({ ...v, enabled: on })} />
      {v.enabled && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: C.textSecondary }}>within</span>
            <input type="number" min={min} max={max} value={v.amount} style={{ ...inp, width: 80 }}
              onChange={e => onChange({ ...v, amount: e.target.value === "" ? "" : Math.min(max, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
              onBlur={() => onChange({ ...v, amount: Math.min(max, Math.max(min, Number(v.amount) || min)) })} />
            <SearchableSelect value={v.unit} onChange={unit => onChange({ ...v, unit, amount: unit === "hours" ? Math.min(23, Math.max(1, Math.round((Number(v.amount) || 60) / 60))) : Math.min(1380, Math.max(15, (Number(v.amount) || 1) * 60)) })}
              options={[{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }]} />
          </div>
          <Hint>Connect the “No response” output on the step to what should happen next, e.g. a reminder. It's skipped if they tap a button or link, or write back, in time. Up to 23 hours: Instagram only allows messages within 24 hours of their last message. Not used after a comment's private reply.</Hint>
        </>
      )}
    </div>
  );
}

function CollectEditor({ d, set, ctx }) {
  return (
    <>
      <Label style={{ marginTop: 0 }}>Question</Label>
      <textarea value={d.prompt} rows={3} onChange={e => set({ prompt: e.target.value })} style={{ ...INPUT, resize: "vertical" }} />
      <Label>Expected answer</Label>
      <SearchableSelect fullWidth value={d.kind} onChange={v => set({ kind: v, field: d.field || v })}
        options={[{ value: "text", label: "Any text" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone number" }, { value: "number", label: "Number" }, { value: "url", label: "Link" }, { value: "name", label: "Name" }]} />
      <Label>Save answer as</Label>
      <SearchableSelect fullWidth value={d.field} options={withCurrent(ctx.fields, d.field)} onChange={v => set({ field: v })} placeholder="Choose or create a field"
        onCreate={(n) => createField(n, ["email", "phone", "number", "url"].includes(d.kind) ? d.kind : "text")} createLabel="Create field" />
      <Hint>Reuse it later as {"{" + (d.field || "email") + "}"} or in a Condition.</Hint>
      <Label>If the answer looks wrong</Label>
      <input value={d.retryText} onChange={e => set({ retryText: e.target.value })} placeholder="That doesn't look right. Please try again." style={INPUT} />
      <Label>Skip button (optional)</Label>
      <input value={d.skipLabel} maxLength={20} onChange={e => set({ skipLabel: e.target.value })} placeholder="e.g. Skip" style={INPUT} />
      <Hint>They can type STOP to end. Waits up to 24 hours for an answer.</Hint>
    </>
  );
}

// AI Step: any OpenRouter chat model (Settings → OpenRouter). Empty = the default model.
function AiEditor({ d, set, ctx }) {
  const ai = ctx.aiModels || { connected: false, models: [] };
  const fmt = (n) => n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return (
    <>
      <Label style={{ marginTop: 0 }}>AI model</Label>
      {!ai.connected
        ? <Hint>Connect OpenRouter in Settings → OpenRouter to use AI steps.</Hint>
        : <>
            <SearchableSelect fullWidth value={d.model || ""} placeholder={`Default · ${ai.defaultModel}`} onChange={v => set({ model: v || "" })}
              options={[{ value: "", label: `Default · ${ai.defaultModel}` }, ...ai.models.map(m => ({ value: m.id, label: m.name || m.id, sublabel: `${m.id} · $${fmt(m.inPerM)} / $${fmt(m.outPerM)} per 1M tokens` }))]} />
            <Hint>Runs through OpenRouter. Spend shows under Settings → OpenRouter.</Hint>
          </>}
      <Label>Instructions</Label>
      <textarea value={d.instructions} rows={7} onChange={e => set({ instructions: e.target.value })} style={{ ...INPUT, resize: "vertical", lineHeight: 1.45 }} />
      <Hint>The AI sees the last few messages of the chat and replies once. {VARS_HINT}</Hint>
      <SettingRow title="Send the reply" hint="Off: only save it to a field." on={d.send !== false} onChange={v => set({ send: v })} />
      <Label>Also save reply as (optional)</Label>
      <input value={d.saveTo} onChange={e => set({ saveTo: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="e.g. ai_answer" style={INPUT} />
    </>
  );
}

const ACTIONS = [
  { value: "add_tag", label: "Add tag" }, { value: "remove_tag", label: "Remove tag" },
  { value: "set_field", label: "Set field" }, { value: "clear_field", label: "Clear field" },
  { value: "notify", label: "Notify the team" }, { value: "http", label: "Webhook / HTTP request" },
  { value: "sheet", label: "Add a Google Sheet row" }, { value: "stop_ai", label: "Keep the AI agent quiet" },
];
function ActionEditor({ d, set, ctx }) {
  const acts = d.actions || [];
  const upd = (i, patch) => set({ actions: mapAt(acts, i, patch) });
  return (
    <>
      {acts.map((a, i) => (
        <Box key={a.id}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <div style={{ flex: 1 }}><SearchableSelect fullWidth value={a.kind} options={ACTIONS} onChange={v => upd(i, { kind: v })} /></div>
            <button type="button" onClick={() => set({ actions: acts.filter((_, j) => j !== i) })} style={iconBtn} aria-label="Remove action"><Trash2 size={13} /></button>
          </div>
          {(a.kind === "add_tag" || a.kind === "remove_tag") && <MultiSelect values={a.tags || []} options={ctx.tags} onChange={v => upd(i, { tags: v })} placeholder="Choose tags" onCreate={a.kind === "add_tag" ? createTag : undefined} createLabel="Create tag" emptyText="No tags yet." />}
          {(a.kind === "set_field" || a.kind === "clear_field") && <div style={{ marginBottom: 6 }}><SearchableSelect fullWidth value={a.key || ""} options={withCurrent(ctx.fields, a.key)} onChange={v => upd(i, { key: v })} placeholder="Choose or create a field" onCreate={a.kind === "set_field" ? (n) => createField(n) : undefined} createLabel="Create field" /></div>}
          {a.kind === "set_field" && <input value={a.value || ""} onChange={e => upd(i, { value: e.target.value })} placeholder="Value, e.g. hot lead" style={inp} />}
          {a.kind === "notify" && (
            <>
              <input value={a.title || ""} onChange={e => upd(i, { title: e.target.value })} placeholder="Title, e.g. New lead" style={{ ...inp, marginBottom: 6 }} />
              <input value={a.body || ""} onChange={e => upd(i, { body: e.target.value })} placeholder="Message, e.g. @{username} wants a call" style={inp} />
              <Hint>Shows in the bell in the top bar for your team.</Hint>
            </>
          )}
          {a.kind === "http" && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <SearchableSelect value={a.method || "POST"} options={["POST", "GET", "PUT"]} onChange={v => upd(i, { method: v })} minWidth={90} />
                <input value={a.url || ""} onChange={e => upd(i, { url: e.target.value.trim() })} placeholder="https://your-endpoint…" style={{ ...inp, flex: 1 }} />
              </div>
              <textarea value={a.body || ""} rows={3} onChange={e => upd(i, { body: e.target.value })} placeholder={'{"username":"{username}","email":"{email}"}'} style={{ ...inp, resize: "vertical", fontFamily: "monospace", fontSize: 12.5 }} />
              <input value={a.saveTo || ""} onChange={e => upd(i, { saveTo: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="Save response as (optional)" style={{ ...inp, marginTop: 6 }} />
            </>
          )}
          {a.kind === "sheet" && (
            <>
              <input value={a.sheetId || ""} onChange={e => upd(i, { sheetId: e.target.value.trim() })} placeholder="Google Sheet ID" style={{ ...inp, marginBottom: 6 }} />
              <input value={a.tab || ""} onChange={e => upd(i, { tab: e.target.value })} placeholder="Tab name, e.g. Leads" style={{ ...inp, marginBottom: 6 }} />
              <input value={a.columns || ""} onChange={e => upd(i, { columns: e.target.value })} placeholder="{username}, {name}, {phone}" style={inp} />
              <Hint>{ctx.meta?.sheetsConfigured ? <>Share the sheet with <b>{ctx.meta.sheetsEmail}</b> as Editor.</> : "Google Sheets isn't set up on the server yet."}</Hint>
            </>
          )}
          {a.kind === "stop_ai" && <Hint>Your AI agent won't auto-reply to this person while the automation runs.</Hint>}
        </Box>
      ))}
      <button type="button" onClick={() => set({ actions: [...acts, { id: rid(), kind: "add_tag", tags: [] }] })} style={small}><Plus size={13} /> Add action</button>
    </>
  );
}

const SUBJECTS = [
  { value: "tag", label: "Tag" }, { value: "field", label: "Saved field" }, { value: "follows", label: "Follows your account" },
  { value: "last_text", label: "Their last message" }, { value: "time", label: "Time of day (IST)" },
];
function ConditionEditor({ d, set, ctx }) {
  const rules = d.rules || [];
  const upd = (i, patch) => set({ rules: mapAt(rules, i, patch) });
  return (
    <>
      <Label style={{ marginTop: 0 }}>Contact must match</Label>
      <PillTabs size="sm" value={d.match || "all"} onChange={v => set({ match: v })} tabs={[{ id: "all", label: "All rules" }, { id: "any", label: "Any rule" }]} />
      <div style={{ marginTop: 12 }}>
        {rules.map((r, i) => (
          <Box key={r.id}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><SearchableSelect fullWidth value={r.subject} options={SUBJECTS} onChange={v => upd(i, { subject: v, op: v === "field" ? "eq" : v === "tag" ? "has" : "is" })} /></div>
              <button type="button" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} style={iconBtn} aria-label="Remove rule"><Trash2 size={13} /></button>
            </div>
            {r.subject === "tag" && (
              <div style={{ display: "flex", gap: 6 }}>
                <SearchableSelect value={r.op} options={[{ value: "has", label: "has" }, { value: "not", label: "doesn't have" }]} onChange={v => upd(i, { op: v })} minWidth={120} />
                <div style={{ flex: 1 }}><SearchableSelect fullWidth value={r.key} options={ctx.tags} onChange={v => upd(i, { key: v })} placeholder="Tag" onCreate={createTag} createLabel="Create tag" /></div>
              </div>
            )}
            {r.subject === "field" && (
              <>
                <div style={{ marginBottom: 6 }}><SearchableSelect fullWidth value={r.key || ""} options={withCurrent(ctx.fields, r.key)} onChange={v => upd(i, { key: v })} placeholder="Choose a field" /></div>
                <div style={{ display: "flex", gap: 6 }}>
                  <SearchableSelect value={r.op} onChange={v => upd(i, { op: v })} minWidth={120}
                    options={[{ value: "eq", label: "is" }, { value: "neq", label: "is not" }, { value: "contains", label: "contains" }, { value: "set", label: "is set" }, { value: "unset", label: "is empty" }, { value: "gt", label: "greater than" }, { value: "lt", label: "less than" }]} />
                  {!["set", "unset"].includes(r.op) && <input value={r.value || ""} onChange={e => upd(i, { value: e.target.value })} placeholder="Value" style={{ ...inp, flex: 1 }} />}
                </div>
              </>
            )}
            {r.subject === "follows" && <SearchableSelect fullWidth value={r.op} options={[{ value: "is", label: "follows you" }, { value: "not", label: "doesn't follow you" }]} onChange={v => upd(i, { op: v })} />}
            {r.subject === "last_text" && (
              <div style={{ display: "flex", gap: 6 }}>
                <SearchableSelect value={r.op} options={[{ value: "is", label: "contains" }, { value: "not", label: "doesn't contain" }]} onChange={v => upd(i, { op: v })} minWidth={130} />
                <input value={r.value || ""} onChange={e => upd(i, { value: e.target.value })} placeholder="yes, sure, ok" style={{ ...inp, flex: 1 }} />
              </div>
            )}
            {r.subject === "time" && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <SearchableSelect value={r.op} options={[{ value: "is", label: "between" }, { value: "not", label: "outside" }]} onChange={v => upd(i, { op: v })} minWidth={110} />
                <input type="number" min={0} max={23} value={r.from ?? 9} onChange={e => upd(i, { from: Number(e.target.value) })} style={{ ...inp, width: 70 }} />
                <span style={{ color: C.textMuted, fontSize: 13 }}>to</span>
                <input type="number" min={0} max={24} value={r.to ?? 18} onChange={e => upd(i, { to: Number(e.target.value) })} style={{ ...inp, width: 70 }} />
                <span style={{ color: C.textMuted, fontSize: 13 }}>h</span>
              </div>
            )}
          </Box>
        ))}
      </div>
      <button type="button" onClick={() => set({ rules: [...rules, { id: rid(), subject: "tag", op: "has", key: "" }] })} style={small}><Plus size={13} /> Add rule</button>
      <Hint>“Follows you” asks Instagram; if it can't tell, the contact is treated as following.</Hint>
    </>
  );
}

function RandomizerEditor({ d, set }) {
  const vs = d.variants || [];
  const total = vs.reduce((a, v) => a + (Number(v.weight) || 0), 0) || 1;
  return (
    <>
      {vs.map((v, i) => (
        <div key={v.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input value={v.label} maxLength={20} onChange={e => set({ variants: mapAt(vs, i, { label: e.target.value }) })} style={{ ...INPUT, flex: 1 }} />
          <input type="number" min={0} max={100} value={v.weight} onChange={e => set({ variants: mapAt(vs, i, { weight: Number(e.target.value) }) })} style={{ ...INPUT, width: 74 }} />
          <span style={{ fontSize: 12, color: C.textMuted, width: 36 }}>{Math.round(((Number(v.weight) || 0) / total) * 100)}%</span>
          {vs.length > 2 && <button type="button" onClick={() => set({ variants: vs.filter((_, j) => j !== i) })} style={{ ...iconBtn, background: C.surface }} aria-label="Remove path"><X size={13} /></button>}
        </div>
      ))}
      {vs.length < 6 && <button type="button" onClick={() => set({ variants: [...vs, { id: rid(), label: String.fromCharCode(65 + vs.length), weight: 50 }] })} style={small}><Plus size={13} /> Add path</button>}
      <Hint>Each person is sent down one path at random, by weight. Up to 6 paths.</Hint>
    </>
  );
}

function FollowEditor({ d, set }) {
  return (
    <>
      <Label style={{ marginTop: 0 }}>If they don't follow you, send</Label>
      <textarea value={d.askText || ""} rows={3} maxLength={640} onChange={e => set({ askText: e.target.value })} placeholder="Almost there! Please follow @{account} first, then tap the button below." style={{ ...INPUT, resize: "vertical" }} />
      <Label>Button</Label>
      <input value={d.button || ""} maxLength={20} onChange={e => set({ button: e.target.value })} placeholder="I've followed" style={inp} />
      <Hint>Tapping it (or replying) checks again. Once they follow, the flow continues on “Follows”.</Hint>
      <Label>Ask at most</Label>
      <SearchableSelect value={Math.min(5, Math.max(1, Number(d.maxAsks) || 2))} onChange={v => set({ maxAsks: v })}
        options={[1, 2, 3, 4, 5].map(n => ({ value: n, label: `${n} time${n > 1 ? "s" : ""}` }))} />
      <Hint>Then it takes “Still not following”. Leave that unconnected to simply stop.</Hint>
      <Label>First DM after a comment</Label>
      <textarea value={d.openText || ""} rows={2} maxLength={640} onChange={e => set({ openText: e.target.value })} placeholder="Thanks! Tap below to continue." style={{ ...INPUT, resize: "vertical", marginBottom: 6 }} />
      <input value={d.openButton || ""} maxLength={20} onChange={e => set({ openButton: e.target.value })} placeholder="Continue" style={inp} />
      <Hint>Instagram can't tell us who follows until they've tapped or replied, so when this is the private reply to a comment this goes first and the check runs on their tap. Uses {"{account}"} for your handle. If Instagram can't answer, they're treated as following.</Hint>
    </>
  );
}

function DelayEditor({ d, set }) {
  return (
    <>
      <Label style={{ marginTop: 0 }}>Wait</Label>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="number" min={1} value={d.amount} onChange={e => set({ amount: Math.max(1, Number(e.target.value) || 1) })} style={{ ...INPUT, width: 90 }} />
        <SearchableSelect value={d.unit} options={[{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" }]} onChange={v => set({ unit: v })} />
      </div>
      <Hint>Instagram only allows messages within 24 hours of the person's last message. A longer wait means the next message won't send unless they write again.</Hint>
    </>
  );
}

const isCalledOnly = (f) => {
  const ts = (f.graph?.nodes || []).find(n => n.type === "trigger")?.data?.triggers || [];
  return ts.length > 0 && ts.every(t => t.kind === "called");
};
function GotoEditor({ d, set, ctx }) {
  const flows = [...(ctx.flows || [])].sort((a, b) => (isCalledOnly(b) - isCalledOnly(a)) || (b.active - a.active));
  const target = flows.find(f => String(f.id) === String(d.flowId));
  return (
    <>
      <Label style={{ marginTop: 0 }}>Continue in</Label>
      <SearchableSelect fullWidth value={String(d.flowId || "")} placeholder="Choose an automation"
        options={flows.map(f => ({ value: String(f.id), label: f.name, sublabel: `${f.active ? "Live" : "Off"} · ${isCalledOnly(f) ? "Started by another automation" : "Has its own trigger"}` }))}
        onChange={v => set({ flowId: v, flowName: flows.find(f => String(f.id) === v)?.name || "" })} />
      {target && !target.active && <div style={{ fontSize: 12.5, color: C.amber, marginTop: 8, lineHeight: 1.4 }}>“{target.name}” is off. Set it live, or this step does nothing.</div>}
      {target && !isCalledOnly(target) && <Hint>“{target.name}” also starts on its own trigger. For steps that should only run from here, use an automation whose trigger is “Started by another automation”.</Hint>}
      <Hint>The person continues at the first step of that automation, in the same conversation, with their fields and tags. Only live automations on this account can be started. A chain that keeps starting itself stops after 5 jumps.</Hint>
      {!flows.length && <Hint>No other automations on this account yet.</Hint>}
    </>
  );
}

const EDITORS = { trigger: TriggerEditor, message: MessageEditor, collect: CollectEditor, ai: AiEditor, action: ActionEditor, condition: ConditionEditor, randomizer: RandomizerEditor, delay: DelayEditor, goto: GotoEditor, follow: FollowEditor };
