import { useState, useEffect, useMemo, useRef } from "react";
import { Bot, Loader2, Save, ChevronDown, RotateCcw, AlertCircle, CheckCircle2, Trash2, Eye } from "lucide-react";
import { api } from "../../api.js";
import { C, FONT, MONO, BTN, INPUT, T } from "../../constants.js";
import { showToast } from "../../Toast.jsx";
import { useConfirm } from "../../ConfirmDialog.jsx";
import { PillTabs, Toggle } from "../UI.jsx";
import { SearchableSelect } from "../Dropdown.jsx";
import { Field, SettingRow } from "../automations/shared.jsx";
import PhonePreview from "../automations/PhonePreview.jsx";
import { IG_TONES, IG_LANGUAGES, igInitialAnswers, igMissingAnswers, IG_AGENT_CAPABILITIES } from "./igQuickAgents.js";

const TRIGGERS = [
  { value: "any", label: "Every message" },
  { value: "keyword", label: "Only when they send a keyword" },
];

/**
 * Quick Instagram AI agent — one page, the Instagram twin of the WhatsApp Quick
 * AI Agent and laid out like Social's Quick Automation editor (form left,
 * phone right, sticky Live + Save bar).
 *
 * New from a preset (`template`): plain questions compose the instructions.
 * Reopened (`agent`): there is no preset to rebuild from, so the stored
 * instructions are shown as the operator's own text.
 *
 * The test chat calls POST /agents/:id/test — the real agent, nothing sent —
 * so it needs a saved agent, and it always answers with the SAVED version.
 */
export default function IgAgentEditor({ template, agent, accounts, defaultAccount, isAdmin, onCancel, onDone }) {
  const editing = !!agent;
  const [ConfirmDialog, confirm] = useConfirm();
  const [id, setId] = useState(agent?.id ?? null);
  const [name, setName] = useState(agent?.name ?? template?.name ?? "");
  const [accountId, setAccountId] = useState(agent?.accountId ?? defaultAccount ?? "");
  const [replyDms, setReplyDms] = useState(agent ? agent.replyDms : !!template?.replyDms);
  const [replyComments, setReplyComments] = useState(agent ? agent.replyComments : !!template?.replyComments);
  const [triggerMode, setTriggerMode] = useState(agent?.triggerMode ?? template?.triggerMode ?? "any");
  const [keyword, setKeyword] = useState(agent?.triggerKeyword ?? template?.keyword ?? "");
  const [answers, setAnswers] = useState(() => igInitialAnswers(template));
  const [tone, setTone] = useState("friendly");
  const [language, setLanguage] = useState("match");
  const [customPrompt, setCustomPrompt] = useState(agent ? agent.systemPrompt : null);
  const [showPrompt, setShowPrompt] = useState(editing);
  const [ai, setAi] = useState(null); // { connected, defaultModel, models }
  const [model, setModel] = useState(agent?.llmModel ?? "");
  const [live, setLive] = useState(!!(agent?.isActive && agent?.status === "active"));
  const [saving, setSaving] = useState(false);
  const [savedSig, setSavedSig] = useState(null);
  const [view, setView] = useState(template?.replyDms === false && template?.replyComments ? "comments" : "dm");
  const [dm, setDm] = useState([]);           // PhonePreview DM steps
  const [comments, setComments] = useState([]); // PhonePreview comment rows
  const [history, setHistory] = useState([]); // [{role, content}] for the DM test
  const nameRef = useRef(null);
  // An agent built elsewhere (MCP / an AI Models row) keeps its own model.
  const ownModel = !!agent?.aiModelId;

  useEffect(() => {
    api.automations.flowAiModels().catch(() => ({ connected: false, models: [] })).then(r => {
      setAi(r);
      setModel(m => m || r.defaultModel || "");
    });
    if (!editing) nameRef.current?.focus();
  }, []);

  const composed = useMemo(() => template ? template.build(answers, { tone, language, dms: replyDms, comments: replyComments }) : "", [template, answers, tone, language, replyDms, replyComments]);
  const systemPrompt = customPrompt ?? composed;
  const account = accounts.find(a => a.account_id === accountId);

  const missing = [
    ...(!name.trim() ? ["a name"] : []),
    ...(!accountId ? ["an Instagram account"] : []),
    ...(!replyDms && !replyComments ? ["DMs or comments to reply to"] : []),
    ...(triggerMode === "keyword" && !keyword.trim() ? ["the keyword"] : []),
    ...(customPrompt == null ? igMissingAnswers(template, answers).map(l => l.toLowerCase()) : []),
    ...(!systemPrompt.trim() ? ["instructions"] : []),
    ...(!ownModel && !ai?.connected ? ["an OpenRouter connection"] : []),
    ...(!ownModel && !model ? ["an AI model"] : []),
  ];
  const canGoLive = missing.length === 0;

  const body = (wantLive) => ({
    name: name.trim() || template?.name || "Instagram agent",
    description: template?.body ?? agent?.description ?? "",
    systemPrompt,
    ...(ownModel ? {} : { aiModelId: null, llmModel: model || null }),
    status: wantLive ? "active" : "draft",
    isActive: wantLive,
    platform: "instagram",
    accountId: accountId || null,
    accountLabel: account ? "@" + account.username : null,
    replyDms, replyComments,
    triggerMode,
    triggerKeyword: triggerMode === "keyword" ? keyword.trim() : "",
    triggerMatchType: "contains",
    ...(editing ? {} : { capabilities: IG_AGENT_CAPABILITIES, humanize: true }),
  });
  // What the saved agent looks like — the test chat warns when the form differs.
  const sig = JSON.stringify(body(false));
  const dirty = id != null && savedSig !== null && savedSig !== sig;
  useEffect(() => { if (editing && savedSig === null) setSavedSig(sig); }, [editing, sig, savedSig]);

  async function save(wantLive) {
    setSaving(true);
    try {
      const b = body(wantLive);
      const saved = id == null ? await api.agents.create(b) : await api.agents.update(id, b);
      setId(saved.id);
      setSavedSig(JSON.stringify(body(false)));
      setLive(!!(saved.isActive && saved.status === "active"));
      showToast(wantLive ? "Saved and live — it is answering Instagram now" : "Saved. Try it in the phone", "success");
      return saved;
    } catch (e) { showToast(e.message, "error"); return null; }
    finally { setSaving(false); }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete “${name}”?`, body: "It stops replying immediately and can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await api.agents.remove(id); showToast("Agent deleted", "success"); onDone?.(); }
    catch (e) { showToast(e.message, "error"); }
  }

  // ── test chat (Social's Instagram phone, driven by the real agent) ──
  const note = (text) => ({ note: text });
  async function ask(messages) {
    const r = await api.agents.test(id, messages);
    return String(r.reply || "").trim() || "(no reply)";
  }
  async function sendDm(text) {
    if (id == null) { setDm(s => [...s, { from: "them", text }, note("Save the agent first, then test it here.")]); return; }
    const next = [...history, { role: "user", content: text }];
    setHistory(next);
    setDm(s => [...s, { from: "them", text }, { typing: true }]);
    try {
      const reply = await ask(next);
      setHistory(h => [...h, { role: "assistant", content: reply }]);
      setDm(s => [...s.filter(x => !x.typing), { message: { text: reply } }]);
    } catch (e) {
      setHistory(h => h.slice(0, -1));
      setDm(s => [...s.filter(x => !x.typing), note(e.message)]);
    }
  }
  async function sendComment(text) {
    if (id == null) { setComments(s => [...s, { text }, note("Save the agent first, then test it here.")]); return; }
    setComments(s => [...s, { text }]);
    try {
      // The same framing the live comment sweep uses (agentDispatch.replyToComment).
      const reply = await ask([{ role: "user", content: `A user left this comment on your instagram post:\n\n"${text}"\n\nWrite a brief, friendly public reply.` }]);
      setComments(s => [...s, { text: reply, ours: true }]);
    } catch (e) { setComments(s => [...s, note(e.message)]); }
  }
  function restart() { setDm([]); setComments([]); setHistory([]); }

  const views = [
    ...(replyDms ? [{ id: "dm", label: "DM" }] : []),
    ...(replyComments ? [{ id: "comments", label: "Comments" }] : []),
  ];
  const shownView = views.find(v => v.id === view) ? view : (views[0]?.id || "dm");
  const sim = { trigger: "dm", send: sendDm, comment: sendComment, comments };
  const set = (k) => (v) => setAnswers(a => ({ ...a, [k]: v }));
  const fields = template?.fields || [];

  const modelOptions = (ai?.models || []).map(m => ({ value: m.id, label: m.name || m.id, sublabel: m.id === ai.defaultModel ? "Recommended" : `$${m.inPerM}/M in · $${m.outPerM}/M out` }));
  if (model && !modelOptions.some(o => o.value === model)) modelOptions.unshift({ value: model, label: model });

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }} data-testid="ig-agent-editor">
      {ConfirmDialog}
      <div style={{ flex: "1 1 460px", minWidth: 0, maxWidth: 620 }}>
        {/* Name · account · when it replies */}
        <div style={{ background: C.raised, borderRadius: 16, padding: "14px 16px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, ...T.label, color: C.textMuted, marginBottom: 6 }}>
            <Bot size={13} /> {template ? `Quick AI agent · ${template.title}` : "Instagram AI agent"}
          </div>
          <input ref={nameRef} value={name} onChange={e => setName(e.target.value)} placeholder="Name your agent" aria-label="Agent name" data-testid="ig-agent-name"
            style={{ ...INPUT, background: "transparent", padding: "2px 0 10px", fontSize: 19, fontWeight: 750, letterSpacing: "-0.02em" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 10 }}>
            <SearchableSelect fullWidth value={accountId} onChange={setAccountId} placeholder="Instagram account"
              options={accounts.map(a => ({ value: a.account_id, label: "@" + a.username }))} />
            <SearchableSelect fullWidth value={triggerMode} onChange={setTriggerMode} options={TRIGGERS} />
          </div>
          {triggerMode === "keyword" && (
            <input value={keyword} onChange={e => setKeyword(e.target.value.slice(0, 200))} placeholder="Keyword, e.g. PRICE" data-testid="ig-agent-keyword" style={{ ...INPUT, marginTop: 10 }} />
          )}
          <div style={{ marginTop: 6 }}>
            <SettingRow title="Reply to DMs" hint="Answers people who message the account." on={replyDms} onChange={(v) => { setReplyDms(v); if (v) setView("dm"); }} />
            <SettingRow title="Reply to comments" hint="Posts a short public reply under new comments on your posts and reels." on={replyComments} onChange={(v) => { setReplyComments(v); if (v && !replyDms) setView("comments"); }} />
          </div>
        </div>

        {/* About the business — preset questions (new agents only). */}
        {template && (
          <div style={{ background: C.raised, borderRadius: 16, padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 15.5, fontWeight: 750, color: C.text }}>About your business</div>
            <div style={{ fontSize: 12.5, color: C.textMuted, margin: "2px 0 12px" }}>
              {customPrompt != null ? "You edited the instructions by hand, so these answers no longer change them." : "Your answers become the agent’s instructions."}
            </div>
            {fields.map(f => (
              <Field key={f.key} label={<>{f.label}{f.required && <span style={{ color: C.primary }}> *</span>}</>}>
                {f.multiline
                  ? <textarea value={answers[f.key]} onChange={e => set(f.key)(e.target.value)} placeholder={f.placeholder} rows={2} data-answer={f.key} disabled={customPrompt != null} style={{ ...INPUT, resize: "vertical" }} />
                  : <input value={answers[f.key]} onChange={e => set(f.key)(e.target.value)} placeholder={f.placeholder} data-answer={f.key} disabled={customPrompt != null} style={INPUT} />}
              </Field>
            ))}
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <Field label="Tone" style={{ marginBottom: 0 }}><PillTabs size="sm" value={tone} onChange={setTone} tabs={IG_TONES.map(t => ({ id: t.id, label: t.label }))} /></Field>
              <Field label="Language" style={{ marginBottom: 0 }}><PillTabs size="sm" value={language} onChange={setLanguage} tabs={IG_LANGUAGES.map(l => ({ id: l.id, label: l.label }))} /></Field>
            </div>
          </div>
        )}

        {/* Instructions — folded for presets, open when reopening an agent. */}
        <div style={{ background: C.raised, borderRadius: 16, padding: 16, marginBottom: 14 }}>
          <button type="button" onClick={() => setShowPrompt(o => !o)} data-testid="ig-agent-show-prompt"
            style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", border: "none", background: "transparent", padding: 0, cursor: "pointer", fontFamily: FONT, fontSize: 15, fontWeight: 750, color: C.text }}>
            <ChevronDown size={15} style={{ transform: showPrompt ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
            Instructions it will follow
            <span style={{ fontWeight: 500, color: C.textMuted, fontSize: 12.5 }}>{template ? (customPrompt != null ? "· edited by you" : "· written from your answers") : ""}</span>
            {template && customPrompt != null && (
              <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); setCustomPrompt(null); }}
                style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, color: C.primary, fontSize: 12.5, fontWeight: 700 }}>
                <RotateCcw size={12} /> Use my answers again
              </span>
            )}
          </button>
          {showPrompt && (
            <textarea value={systemPrompt} onChange={e => setCustomPrompt(e.target.value)} rows={10} data-testid="ig-agent-prompt"
              style={{ ...INPUT, marginTop: 10, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, resize: "vertical" }} />
          )}
        </div>

        {/* Model — OpenRouter, pre-picked. */}
        <div style={{ background: C.raised, borderRadius: 16, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 750, color: C.text, marginBottom: 10 }}>AI model</div>
          {ownModel ? (
            <div style={{ fontSize: 13, color: C.textSecondary }}>Uses <b>{agent.aiModelLabel || agent.aiProvider}</b> · {agent.llmModel} (set up outside the quick editor).</div>
          ) : !ai ? (
            <div style={{ fontSize: 13, color: C.textMuted }}><Loader2 size={13} style={{ animation: "spin 1s linear infinite", verticalAlign: "text-bottom" }} /> Loading models…</div>
          ) : !ai.connected ? (
            <div data-testid="ig-agent-no-ai" style={{ fontSize: 13, color: C.errText, background: C.errBg, borderRadius: 10, padding: "10px 12px", lineHeight: 1.45 }}>
              <AlertCircle size={13} style={{ verticalAlign: "text-bottom" }} /> OpenRouter isn’t connected, so this agent can be saved but not switched on.{" "}
              <a href="#/social/settings/openrouter" style={{ color: "inherit", fontWeight: 700 }}>Connect it in Settings → OpenRouter</a>
            </div>
          ) : (
            <SearchableSelect fullWidth value={model} onChange={setModel} options={modelOptions} placeholder="Pick a model" searchPlaceholder="Search models…" />
          )}
          {!ownModel && ai?.connected && <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 6 }}>Runs on your OpenRouter key — spend shows in Settings → OpenRouter.</div>}
        </div>

        {/* Actions */}
        <div style={{ position: "sticky", bottom: -40, /* minus .social-root's bottom padding; see RuleEditor */ zIndex: 2, padding: "10px 0 16px", background: C.card }}>
          <div data-testid="ig-agent-missing" style={{ fontSize: 12.5, color: canGoLive ? C.green : C.textMuted, marginBottom: 8, lineHeight: 1.4 }}>
            {canGoLive ? <><CheckCircle2 size={13} style={{ verticalAlign: "text-bottom" }} /> Ready to go live</> : <>To go live: add {missing.join(", ")}.</>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            {isAdmin && id != null && <button type="button" onClick={remove} style={{ ...BTN.ghost, color: C.errText, padding: "10px 8px" }}><Trash2 size={15} /> Delete</button>}
            <span style={{ flex: 1 }} />
            <span title={canGoLive ? "Answer Instagram as soon as you save" : `Still needed: ${missing.join(", ")}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 650, color: live && canGoLive ? C.green : C.textMuted }}>
              {live && canGoLive ? "Live" : "Off"}
              <Toggle on={live && canGoLive} onChange={setLive} disabled={!canGoLive || !isAdmin} />
            </span>
            <button type="button" onClick={onCancel} style={BTN.secondary}>{id != null ? "Done" : "Cancel"}</button>
            {isAdmin && (
              <button type="button" data-testid="ig-agent-save" onClick={() => save(live && canGoLive)} disabled={saving} style={BTN.primary}>
                {saving ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={15} />}
                {live && canGoLive ? (id != null ? "Save" : "Save & go live") : (id != null ? "Save" : "Save draft")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Phone — the real agent, nothing is sent. */}
      <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, position: "sticky", top: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: C.text }}><Eye size={14} /> Test it</span>
          <button type="button" onClick={restart} style={{ ...BTN.icon, width: 30, height: 30 }} title="Start over" aria-label="Start over"><RotateCcw size={14} /></button>
        </div>
        <PhonePreview view={shownView} onView={setView} views={views.length ? views : [{ id: "dm", label: "DM" }]}
          account={account?.username} post={{ any: true }} steps={dm} sim={sim} />
        <div data-testid="ig-agent-test-hint" style={{ fontSize: 12, color: dirty ? C.amber : C.textMuted, textAlign: "center", maxWidth: 300, lineHeight: 1.45 }}>
          {id == null ? "Press Save draft, then message or comment like a follower would. Nothing is sent."
            : dirty ? "You have unsaved changes — the test answers with the last saved version. Save to test them."
            : shownView === "comments" ? "Comment like a follower would. The agent’s public reply appears under it. Nothing is posted."
            : "Message the agent like a follower would. Nothing is sent to Instagram."}
        </div>
      </div>
    </div>
  );
}
