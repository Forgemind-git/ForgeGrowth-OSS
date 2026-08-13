import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, Trash2, Loader2, AlertCircle, ExternalLink, Download,
  Images, Settings2, Brain, Wrench, Gauge, History,
  Mic, ImagePlus, Type } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, downloadJson, slugifyName } from '../../constants.js';
import { notify } from '../../lib/feedback.js';
import DeleteConfirmModal from '../DeleteConfirmModal.jsx';
import SearchableSelect from '../SearchableSelect.jsx';
import InfoDot from '../InfoDot.jsx';
import Toggle from '../Toggle.jsx';
import AgentToolsList from './AgentToolsList.jsx';
import AgentRunsViewer from './AgentRunsViewer.jsx';
import AgentLivePreview from './AgentLivePreview.jsx';
import AgentMediaGroups from './AgentMediaGroups.jsx';
import { modelsForProvider, providerDisplay } from './modelCatalog.js';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';

// Pre-filled into the "what to send at the limit" box for a new agent. It is a
// suggestion sitting in an editable field, not a fallback — clearing it means
// send nothing, and the backend has no default of its own that could put these
// words back in front of a customer after the operator deleted them.
//
// ⚠ Declared ABOVE BLANK, which reads it: a const is in the temporal dead zone
// until its own line runs, so declaring it below would throw at module load.
const DEFAULT_LIMIT_MESSAGE =
  'Thanks for all your questions. Let me get someone from our team to help you from here.';

// The rolling-window units, in the same order and with the same names the
// backend accepts (agentLimits.WINDOW_UNITS). A unit offered here that the
// server does not know would silently fall back to days — the window on screen
// and the window applied must be the same one.
const QUOTA_WINDOW_UNITS = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

// Plain-English echo of the allowance, so nobody has to assemble three
// controls in their head to know what they just set.
function quotaSummary(f) {
  const parts = [];
  if (f.quotaReplies != null) parts.push(`${f.quotaReplies} ${f.quotaReplies === 1 ? 'reply' : 'replies'}`);
  if (f.quotaConversations != null) parts.push(`${f.quotaConversations} ${f.quotaConversations === 1 ? 'conversation' : 'conversations'}`);
  if (parts.length === 0) return 'No allowance set — this window does nothing yet.';
  const v = f.quotaWindowValue || 1;
  const unit = v === 1 ? String(f.quotaWindowUnit || 'days').replace(/s$/, '') : (f.quotaWindowUnit || 'days');
  return `${parts.join(' and ')} per person every ${v} ${unit}.`;
}

// Set a cap and, if this is the moment one is switched ON with no closing line
// written, suggest one. Pre-filling only for a brand new agent missed the
// commoner case — adding a cap to an agent that already exists — and left them
// with a cap that goes silent. Clearing the box afterwards is a deliberate
// "send nothing" and is never undone: the suggestion only fires on the
// null -> set transition.
function setCap(f, key, v) {
  const turningOn = v != null && f[key] == null;
  return {
    ...f,
    [key]: v,
    limitReachedMessage: (turningOn && !String(f.limitReachedMessage || '').trim())
      ? DEFAULT_LIMIT_MESSAGE
      : f.limitReachedMessage,
  };
}

/**
 * The five things you configure on an agent, in the order you meet them:
 * who it is and when it answers · which brain and what to say · what it can
 * do · how far it may go · what it has actually done.
 */
const AGENT_TABS = [
  { key: 'setup',    label: 'Setup',    icon: Settings2, hint: 'Name, WhatsApp number and when it engages' },
  { key: 'ai',       label: 'AI',       icon: Brain,     hint: 'Model, instructions, and what it understands' },
  { key: 'tools',    label: 'Tools',    icon: Wrench,    hint: 'What it can do mid-conversation' },
  { key: 'limits',   label: 'Limits',   icon: Gauge,     hint: 'How much it may spend and say' },
  { key: 'activity', label: 'Activity', icon: History,   hint: 'Recent runs' },
];

const BLANK = {
  name: '',
  description: '',
  systemPrompt: 'You are a helpful WhatsApp assistant. Keep replies concise.',
  aiModelId: '',
  llmModel: '',
  waAccountId: '',
  isActive: false,
  contextWindowMessages: 20,
  maxToolIterations: 6,
  // null = unlimited, never 0. The closing line is pre-filled so a cap set in
  // a hurry still says something to the customer; clearing the box is a
  // deliberate "send nothing" and is honoured as one.
  maxRepliesPerConversation: null,
  maxRepliesPerMinute: null,
  maxRunsPerDay: null,
  limitReachedMessage: DEFAULT_LIMIT_MESSAGE,
  limitHandoff: true,
  // Rolling per-person allowance. null = unlimited; the window only means
  // something once one of the two numbers above it is set.
  quotaReplies: null,
  quotaConversations: null,
  quotaWindowValue: 1,
  quotaWindowUnit: 'days',
  quotaHandoff: false,
  // [{ number, label }] — numbers that may exercise this agent while it is
  // still a draft, exempt from every usage limit.
  testNumbers: [],
  transcribeAudio: false,
  maxVoiceSeconds: null,
  acceptImages: false,
  maxImagesPerConversation: null,
  triggerMode: 'any',
  triggerKeyword: '',
  triggerMatchType: 'contains',
  triggerCaseSensitive: false,
  triggerSessionMinutes: 30,
  // Engage only leads sitting at these funnel stages / carrying these tags.
  // Empty = no restriction, which is what every existing agent has.
  triggerStageKeys: [],
  triggerTagIds: [],
  mediaGroups: [],
};

export default function AgentEditor({ agentId, waAccounts, user, navigate, onDone, onCancel }) {
  // `liveId` is the agent's real id. It starts as the prop (null in create
  // mode) but flips to a real id the moment we auto-persist a draft — e.g. when
  // the operator adds a tool before the first explicit save. A ref mirrors it so
  // async callbacks (tool add → reload) read the latest id without stale closures.
  const [liveId, setLiveId] = useState(agentId);
  const liveIdRef = useRef(agentId);
  const setLive = (id) => { liveIdRef.current = id; setLiveId(id); };
  const isCreate = liveId == null;
  const [form, setForm] = useState(BLANK);
  const [aiModels, setAiModels] = useState([]);
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingLive, setTogglingLive] = useState(false);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(false);
  // The editor was one long scroll of eight unrelated cards, so the relationship
  // between them — and how many there even were — was invisible. Local state,
  // not a route: AiAgentBuilderPage holds the open agent in `editingId` rather
  // than the hash, so there is nothing to refresh back INTO and a routed tab
  // would be a promise the page cannot keep.
  const [tab, setTab] = useState('setup');

  // Declared here, above every consumer — the funnel trigger control and
  // buildPayload both read it. Keeping it beside the other top-level state
  // avoids the const-below-its-use shape that has whited out a page here before.
  const isAdmin = user?.role === 'admin';

  // The capabilities built into every agent. Only Send media is built in now —
  // updating the CRM, taking payments, escalating to a human and writing a
  // closing summary were removed, because an agent here collects data rather
  // than acting on the business. Everything else the agent can do is an
  // attached tool (a form's table, a spreadsheet, an HTTP endpoint).
  //
  // ⚠ Each row carries its OWN settings via renderConfig, and those settings
  // exist nowhere else. They used to sit in a separate block at the top of the
  // tab while this list re-described them read-only underneath — so every
  // capability appeared twice and neither copy was where you would look for it.
  // If you add a capability here, its settings belong in its renderConfig, not
  // in a second card.
  //
  // Declared ABOVE the `if (loading) return` below — a const referenced by JSX
  // that sits above its own declaration throws on every render and whites out
  // the page (anti-pattern #44).
  const builtIns = [
    {
      key: 'media', label: 'Send media', icon: Images, iconColor: '#2563EB', iconBg: 'var(--c-infoBg, #E6EEFC)',
      // No switch: this is on exactly when there is something to send, so a
      // separate toggle would either lie or mean "delete my groups".
      on: (form.mediaGroups || []).length > 0,
      onDesc: `Can send ${(form.mediaGroups || []).length} pre-set group(s) of files and links`,
      offDesc: 'Add files and links the agent can send during a chat',
      renderConfig: () => (
        <AgentMediaGroups
          waAccountId={form.waAccountId}
          value={form.mediaGroups}
          onChange={(groups) => setForm(f => ({ ...f, mediaGroups: groups }))}
        />
      ),
    },
  ];

  // Declared above every early return below — a const referenced by JSX that
  // sits above its own declaration throws on every render and whites out the
  // page (anti-pattern #44).
  const hasQuota = form.quotaReplies != null || form.quotaConversations != null;
  const hasClosingCap = hasQuota || form.maxRepliesPerConversation != null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [models, a] = await Promise.all([
        api.aiModels.list().catch(() => []),
        agentId == null ? Promise.resolve(null) : api.agents.get(agentId),
      ]);
      setAiModels(models);
      if (a) {
        setForm({
          name: a.name || '',
          description: a.description || '',
          systemPrompt: a.systemPrompt || '',
          aiModelId: a.aiModelId ? String(a.aiModelId) : '',
          aiProvider: a.aiProvider || '',
          llmModel: a.llmModel || '',
          waAccountId: a.waAccountId || '',
          isActive: !!a.isActive,
          contextWindowMessages: a.contextWindowMessages || 20,
          maxToolIterations: a.maxToolIterations || 6,
          // `?? null`, never `|| null` — the API sends null for unlimited and a
          // number otherwise, and both must round-trip untouched.
          maxRepliesPerConversation: a.maxRepliesPerConversation ?? null,
          maxRepliesPerMinute: a.maxRepliesPerMinute ?? null,
          maxRunsPerDay: a.maxRunsPerDay ?? null,
          limitReachedMessage: a.limitReachedMessage ?? '',
          limitHandoff: a.limitHandoff !== false,
          quotaReplies: a.quotaReplies ?? null,
          quotaConversations: a.quotaConversations ?? null,
          quotaWindowValue: a.quotaWindowValue ?? 1,
          quotaWindowUnit: a.quotaWindowUnit || 'days',
          quotaHandoff: a.quotaHandoff === true,
          testNumbers: Array.isArray(a.testNumbers) ? a.testNumbers : [],
          transcribeAudio: !!a.transcribeAudio,
          maxVoiceSeconds: a.maxVoiceSeconds ?? null,
          acceptImages: !!a.acceptImages,
          maxImagesPerConversation: a.maxImagesPerConversation ?? null,
          triggerMode: a.triggerMode || 'any',
          triggerKeyword: a.triggerKeyword || '',
          triggerMatchType: a.triggerMatchType || 'contains',
          triggerCaseSensitive: !!a.triggerCaseSensitive,
          triggerSessionMinutes: a.triggerSessionMinutes || 30,
          triggerStageKeys: Array.isArray(a.triggerStageKeys) ? a.triggerStageKeys : [],
          triggerTagIds: Array.isArray(a.triggerTagIds) ? a.triggerTagIds : [],
          mediaGroups: Array.isArray(a.mediaGroups) ? a.mediaGroups : [],
        });
        setTools(a.tools || []);
      }
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Reload ONLY the tools list (after add/remove/toggle) without re-fetching the
  // whole agent — so an in-progress edit to the form isn't clobbered. Reads the
  // live id from the ref so it works right after a draft was auto-created.
  const reloadTools = useCallback(async () => {
    const id = liveIdRef.current;
    if (id == null) return;
    try {
      const a = await api.agents.get(id);
      setTools(a.tools || []);
    } catch { /* leave existing tools on a transient fetch error */ }
  }, []);

  // Guarantee the agent exists (returns its id), creating it as a draft from the
  // current form if it hasn't been saved yet. This is what lets tools be added
  // before the first explicit save — same "persist a draft" pattern as the
  // "Save draft & go to Integrations" button.
  const ensureSaved = useCallback(async () => {
    if (liveIdRef.current != null) return liveIdRef.current;
    const payload = buildPayload();
    if (!payload.name?.trim()) payload.name = 'Untitled agent';
    const created = await api.agents.create(payload);
    setLive(created.id);
    return created.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // Prefer the live registry row; fall back to the binding loaded with the
  // agent so an already-bound agent still renders its model even if the
  // registry list is momentarily empty (failed fetch) — without that fallback
  // the editor would show the "not integrated" card and a save would silently
  // demote a working agent to a draft.
  const selectedModelRow = aiModels.find(m => String(m.id) === String(form.aiModelId))
    || (form.aiModelId && form.aiProvider ? { id: form.aiModelId, provider: form.aiProvider, label: null } : null);
  const modelOptions = modelsForProvider(selectedModelRow?.provider);
  const hasModelSelected = !!(form.aiModelId && form.llmModel);
  // Only treat the workspace as "no provider connected" when the registry is
  // genuinely empty AND this agent isn't already bound to one.
  const showNotIntegrated = aiModels.length === 0 && !form.aiModelId;
  // Registry rows to offer, always including the agent's current binding.
  const modelRowOptions = (selectedModelRow && !aiModels.some(m => String(m.id) === String(selectedModelRow.id)))
    ? [...aiModels, selectedModelRow]
    : aiModels;

  // When the registry credential changes, snap the model dropdown to the first
  // model of that provider (the previously-selected model may belong to the
  // other provider).
  const setAiModelId = (id) => {
    const row = aiModels.find(m => String(m.id) === String(id));
    const first = modelsForProvider(row?.provider)[0]?.value || '';
    setForm(f => ({ ...f, aiModelId: id, llmModel: first }));
  };

  // Build the create/update payload from the form. `status` is derived: an
  // agent with a model fully chosen is 'active' (can be toggled on); otherwise
  // it's saved as a 'draft'.
  const buildPayload = (overrides = {}) => {
    const complete = !!(form.aiModelId && form.llmModel);
    const status = overrides.status || (complete ? 'active' : 'draft');
    return {
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      aiModelId: form.aiModelId || null,
      llmModel: form.llmModel || null,
      status,
      waAccountId: form.waAccountId || null,
      isActive: status === 'active' ? form.isActive : false,
      contextWindowMessages: form.contextWindowMessages,
      maxToolIterations: form.maxToolIterations,
      maxRepliesPerConversation: form.maxRepliesPerConversation,
      maxRepliesPerMinute: form.maxRepliesPerMinute,
      maxRunsPerDay: form.maxRunsPerDay,
      limitReachedMessage: form.limitReachedMessage,
      limitHandoff: form.limitHandoff,
      quotaReplies: form.quotaReplies,
      quotaConversations: form.quotaConversations,
      quotaWindowValue: form.quotaWindowValue,
      quotaWindowUnit: form.quotaWindowUnit,
      quotaHandoff: form.quotaHandoff,
      testNumbers: form.testNumbers,
      transcribeAudio: form.transcribeAudio,
      maxVoiceSeconds: form.maxVoiceSeconds,
      acceptImages: form.acceptImages,
      maxImagesPerConversation: form.maxImagesPerConversation,
      triggerMode: form.triggerMode,
      triggerKeyword: form.triggerKeyword,
      triggerMatchType: form.triggerMatchType,
      triggerCaseSensitive: form.triggerCaseSensitive,
      triggerSessionMinutes: form.triggerSessionMinutes,
      // Sent only by an admin — a non-admin's editor never renders the control,
      // and the server refuses the field outright rather than trusting that.
      ...(isAdmin ? {
        triggerStageKeys: form.triggerStageKeys,
        triggerTagIds: form.triggerTagIds,
      } : {}),
      mediaGroups: form.mediaGroups,
      ...overrides,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = buildPayload();
      const existing = liveIdRef.current;
      if (existing == null) {
        const created = await api.agents.create(payload);
        onDone(created.id);
      } else {
        // Covers both a normal edit AND a create where a draft was already
        // auto-persisted (e.g. the operator added a tool first).
        await api.agents.update(existing, payload);
        onDone(existing);
      }
    } catch (e) {
      setError(prettyError(e));
      setSaving(false);
    }
  };

  // "Go Live": activate (or deactivate) the agent from the header. Activating
  // does a full save first so the current config is persisted AND live in one
  // step; it needs a chosen model (the DB also enforces one active agent per
  // number — a 409 surfaces if another is already live).
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    const id = liveIdRef.current;
    if (id == null) { setError('Save the agent first, then export it.'); return; }
    setExporting(true);
    try {
      const data = await api.agents.exportOne(id);
      downloadJson(`agent-${slugifyName(form.name)}`, data);
    } catch (e) {
      notify(prettyError(e));
    } finally {
      setExporting(false);
    }
  };

  const handleToggleLive = async () => {
    const next = !form.isActive;
    if (next && !hasModelSelected) {
      setError('Connect an AI model and pick a model before going live.');
      return;
    }
    setTogglingLive(true);
    setError('');
    try {
      await api.agents.update(liveIdRef.current, buildPayload({ isActive: next }));
      setForm(f => ({ ...f, isActive: next }));
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setTogglingLive(false);
    }
  };

  // "Go to Integrations": persist whatever the operator has entered as a draft
  // so nothing is lost, then jump to Integrations → AI Models to connect a
  // provider key. On return they reopen the draft and finish it.
  const handleGoToIntegrations = async () => {
    if (!navigate) return;
    setSaving(true);
    setError('');
    try {
      const payload = buildPayload({ status: 'draft', isActive: false });
      if (!payload.name?.trim()) payload.name = 'Untitled agent';
      if (liveIdRef.current == null) {
        const created = await api.agents.create(payload);
        setLive(created.id);
      } else {
        await api.agents.update(liveIdRef.current, payload);
      }
      navigate('admin-settings', 'integrations', 'ai-models');
    } catch (e) {
      setError(prettyError(e));
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await api.agents.delete(liveIdRef.current);
      setPendingDelete(false);
      onDone();
    } catch (e) {
      setError(prettyError(e));
      setPendingDelete(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 8, color: C.textMuted, fontSize: 15 }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  // TWO INDEPENDENT PANES, not a sticky column inside one big scroller.
  // Sticky only holds until the sticky box's own bottom is reached, so nested
  // inside a 3-screen scroller with a top offset the preview still drifted
  // (measured: 62px). Splitting the scroll means the right pane is simply
  // never scrolled, and everything above it in the form no longer steals its
  // height — the phone gets the full pane whatever the form is doing.
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, width: '100%', fontFamily: FONT }}>
      {/* LEFT — a flex column: the form scrolls, the action bar is a real
          footer BENEATH it, not a sticky box inside it.
          `position: sticky; bottom: 0` only pins the bar to the bottom of the
          scrollport while the form keeps scrolling UNDERNEATH it, which is
          what made it read as hovering over the middle of the page. A footer
          that is a sibling of the scroller ends the scrollport above itself,
          so nothing can ever pass under it. minHeight:0 is load-bearing: a
          flex child defaults to min-height:auto and would refuse to shrink,
          leaving the inner div unable to scroll at all. */}
      <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px 24px', boxSizing: 'border-box' }}>
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16,
          background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', border: '1px solid var(--c-dangerBorder, #FBC8C8)', fontSize: 15 }}>
          {error}
        </div>
      )}

      {/* Header — agent name + live status, with a Go Live / deactivate toggle. */}
      {!isCreate && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {form.name || 'Agent'}
            </div>
            <div style={{ fontSize: 14, color: form.isActive ? 'var(--c-successText, #0F6E56)' : C.textMuted, fontWeight: 600, marginTop: 2 }}>
              {form.isActive ? '● Live — answering WhatsApp messages' : 'Inactive — not answering messages'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              title="Download this agent as a JSON file you can import elsewhere"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '9px 16px', borderRadius: 99,
                border: `1px solid ${C.border}`, background: C.cardBg,
                color: C.text, fontSize: 15, fontFamily: FONT, fontWeight: 600, whiteSpace: 'nowrap',
                cursor: exporting ? 'wait' : 'pointer', opacity: exporting ? 0.6 : 1,
              }}
            >
              {exporting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={13} />}
              Export
            </button>
            <button
              type="button"
              onClick={handleToggleLive}
              disabled={togglingLive || (!form.isActive && !hasModelSelected)}
              title={!form.isActive && !hasModelSelected ? 'Connect & pick an AI model first' : (form.isActive ? 'Deactivate this agent' : 'Activate this agent')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '10px 20px', borderRadius: 99,
                border: form.isActive ? '1.5px solid #1D9E75' : 'none',
                background: form.isActive ? 'var(--c-successBg, #E1F5EE)' : '#1D9E75',
                color: form.isActive ? 'var(--c-successText, #0F6E56)' : '#fff',
                fontSize: 15, fontFamily: FONT, fontWeight: 700, whiteSpace: 'nowrap',
                cursor: (togglingLive || (!form.isActive && !hasModelSelected)) ? 'not-allowed' : 'pointer',
                opacity: (togglingLive || (!form.isActive && !hasModelSelected)) ? 0.6 : 1,
              }}
            >
              {togglingLive
                ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                : <span style={{ width: 8, height: 8, borderRadius: 99, background: form.isActive ? '#1D9E75' : 'var(--c-surface, #fff)' }} />}
              {togglingLive ? 'Saving…' : (form.isActive ? 'Live' : 'Go Live')}
            </button>
          </div>
        </div>
      )}

      {/* The form itself. The preview is a sibling of this whole scroll
          column now, so nothing in here can push it down. */}
      <div>
        <div style={{ minWidth: 0 }}>

      <TabStrip tabs={AGENT_TABS} value={tab} onChange={setTab} />

      {tab === 'setup' && (
      <Section title="Identity" subtitle="What this agent is called, and which WhatsApp number it answers on.">
        <FieldRow>
          <Field label="Name *" info="Shown in the agents list. Just a label for you — the customer never sees it.">
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Booking Assistant" style={inputStyle} />
          </Field>
          <Field label="Description" info="An optional note about what this agent does. For your reference only.">
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="What does this agent do?" style={inputStyle} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="WhatsApp account" info="The number the agent answers on. Only one agent can be active per number. Media the agent sends is read from this number's Media Library.">
            <SearchableSelect
              value={form.waAccountId || ''}
              onChange={(val) => setForm(f => ({ ...f, waAccountId: val }))}
              placeholder="— None —"
              searchPlaceholder="Search accounts…"
              options={[{ value: '', label: '— None —' }, ...waAccounts.map(w => ({ value: String(w.id), label: `${w.displayName}${w.displayPhoneNumber ? ` (+${w.displayPhoneNumber})` : ''}` }))]}
            />
          </Field>
        </FieldRow>
      </Section>
      )}

      {/* What used to be one "Advanced settings" dropdown holding nine unrelated
          controls. Its contents now sit on the tab that owns them — the toggles
          are the same controls, just findable. Burying a capability behind a
          collapsible is what made the payment tools read as missing once
          already (anti-pattern #38). */}
      {/* Limits is the only tab that still needs this shared card. The AI tab's
          understanding controls moved into the Model section beside the model
          picker (they were a two-checkbox card floating in a screen of empty
          space), and every Tools control moved inside its own tool row. */}
      {tab === 'limits' && (
        <div style={{ marginBottom: 28, padding: '16px 20px', background: C.cardBg, borderRadius: 10, border: `1px solid ${C.border}` }}>
            <FieldRow>
              <Field label="Context window (messages)" info="How many recent messages from the chat are fed to the model on each turn. Higher = more memory, but costs more per reply.">
                <input type="number" min={1} max={100}
                  value={form.contextWindowMessages}
                  onChange={e => setForm(f => ({ ...f, contextWindowMessages: parseInt(e.target.value, 10) || 20 }))}
                  style={inputStyle} />
              </Field>
              <Field label="Max tool iterations" info="Hard cap on how many times the model can call a tool (Sheets, send media, …) while handling one message. Stops runaway loops.">
                <input type="number" min={1} max={20}
                  value={form.maxToolIterations}
                  onChange={e => setForm(f => ({ ...f, maxToolIterations: parseInt(e.target.value, 10) || 6 }))}
                  style={inputStyle} />
              </Field>
            </FieldRow>

            {/* Usage limits. Three separate ceilings because each catches
                something the others cannot: a total cannot see a burst, and
                neither can see a broadcast backfire. */}
            <div data-cap="limits" style={{ borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>
                Usage limits
                <InfoDot text="Stops one person — or one busy day — using up the agent. Leave a box blank for no limit. A blocked message never reaches the model, so it costs nothing." />
              </div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12 }}>
                Leave blank for no limit. A blocked message costs nothing — the agent is never called.
              </div>

              <FieldRow>
                <Field label="Replies per conversation" info="How many times the agent answers one person in a single conversation. The count resets once the chat has been quiet for the session length set under Trigger.">
                  <LimitInput
                    value={form.maxRepliesPerConversation}
                    max={500}
                    onChange={v => setForm(f => setCap(f, 'maxRepliesPerConversation', v))}
                  />
                </Field>
                <Field label="Replies per minute" info="Flood guard for someone firing off many messages at once. Skipped messages still reach the model as context in the next reply, so nothing the customer said is lost — it just doesn't earn its own answer.">
                  <LimitInput
                    value={form.maxRepliesPerMinute}
                    max={60}
                    onChange={v => setForm(f => ({ ...f, maxRepliesPerMinute: v }))}
                  />
                </Field>
              </FieldRow>

              <Field label="Replies per day (all conversations)" info="A ceiling across everyone this agent talks to, reset at midnight IST. This is the one that protects you after a broadcast: message 500 people, 300 reply within ten minutes, and every one of those conversations looks perfectly normal on its own.">
                <LimitInput
                  value={form.maxRunsPerDay}
                  max={100000}
                  onChange={v => setForm(f => ({ ...f, maxRunsPerDay: v }))}
                />
              </Field>

              {/* ── Per person, over time ──────────────────────────────────
                  A separate question from the cap above, which is why both
                  exist. That one asks how long ONE SITTING may run and refills
                  the moment the chat goes quiet — so the same person can take
                  the whole allowance again half an hour later, all day. This
                  one refills on a clock you choose. */}
              <div style={{ borderTop: `1px dashed ${C.border}`, marginTop: 16, paddingTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>
                  How often one person may come back
                  <InfoDot text="An allowance per person that refills on a clock, not on a silence. Set 3 replies every 24 hours and someone gets three answers a day however they spread them out — they cannot go quiet for half an hour and start again." />
                </div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12 }}>
                  Blank for no limit. Test numbers are exempt, so you can still try the agent as often as you like.
                </div>

                <FieldRow>
                  <Field label="Replies per person" info="How many answers one person may have inside the window below, no matter how many separate chats they spread them across.">
                    <LimitInput
                      value={form.quotaReplies}
                      max={10000}
                      onChange={v => setForm(f => setCap(f, 'quotaReplies', v))}
                    />
                  </Field>
                  <Field label="Conversations per person" info="How many separate sittings one person may start inside the window. A sitting begins when they message after the quiet period set under Trigger. Someone already mid-conversation is never cut off by this — only a NEW one is refused.">
                    <LimitInput
                      value={form.quotaConversations}
                      max={10000}
                      onChange={v => setForm(f => setCap(f, 'quotaConversations', v))}
                    />
                  </Field>
                </FieldRow>

                <Field label="Refills every" info="The window both numbers above are measured over. It counts backwards from right now — 24 hours means the last 24 hours, not since midnight.">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="number" min={1} max={999}
                      value={form.quotaWindowValue}
                      onChange={e => {
                        const n = parseInt(e.target.value, 10);
                        setForm(f => ({ ...f, quotaWindowValue: Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 1 }));
                      }}
                      style={{ ...inputStyle, width: 90, flex: '0 0 auto' }}
                    />
                    <div style={{ flex: '0 0 170px' }}>
                      <SearchableSelect
                        value={form.quotaWindowUnit}
                        onChange={v => setForm(f => ({ ...f, quotaWindowUnit: v }))}
                        options={QUOTA_WINDOW_UNITS}
                      />
                    </div>
                    <div style={{ fontSize: 13, color: C.textMuted }}>
                      {quotaSummary(form)}
                    </div>
                  </div>
                </Field>

                {hasQuota && (
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginTop: 4 }}>
                    <input
                      type="checkbox"
                      checked={form.quotaHandoff}
                      onChange={e => setForm(f => ({ ...f, quotaHandoff: e.target.checked }))}
                      style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer' }}
                    />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
                        Also hand these chats to a human
                      </div>
                      {/* Off by default, unlike the conversation cap's version:
                          someone who has used today's allowance is being asked
                          to come back, not escalated. Turning this on for a
                          tight quota puts everyone who hits it into Chats. */}
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
                        {form.quotaHandoff
                          ? 'The chat is paused and waits for a person in Chats.'
                          : 'The agent simply stops answering until their allowance refills.'}
                      </div>
                    </div>
                  </label>
                )}
              </div>

              {/* One closing line for "the agent has stopped here", shown as
                  soon as any cap with a customer-visible consequence is set.
                  Which ceiling stopped it is an operator-facing detail and is
                  recorded on the run, not spelled out to the customer. */}
              {hasClosingCap && (
                <div style={{ marginTop: 14, paddingLeft: 12, borderLeft: `2px solid ${C.border}` }}>
                  <Field label="What to send when it stops" info="Sent once each time someone runs out — once per conversation for the cap above, once per window for the allowance. Leave blank to send nothing, but going quiet looks the same to a customer as being ignored.">
                    <textarea
                      value={form.limitReachedMessage}
                      onChange={e => setForm(f => ({ ...f, limitReachedMessage: e.target.value }))}
                      rows={2}
                      placeholder="Leave blank to send nothing"
                      style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
                    />
                  </Field>
                  {form.maxRepliesPerConversation != null && (
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginTop: 10 }}>
                      <input
                        type="checkbox"
                        checked={form.limitHandoff}
                        onChange={e => setForm(f => ({ ...f, limitHandoff: e.target.checked }))}
                        style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer' }}
                      />
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 600, color: C.text }}>
                          Pause the bot and leave the chat for a human
                          <InfoDot text="Applies to the replies-per-conversation cap. Stops the agent on this conversation and surfaces it in Chats, where anyone can reply. Someone clicks 'Return to bot' when they're done. Without this the agent simply stops answering and starts again once the chat has been idle." />
                        </div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
                          {form.limitHandoff
                            ? 'The conversation is paused and waits for a person in Chats. Nobody is auto-assigned — pick it up from the inbox.'
                            : 'The agent goes quiet for the rest of the conversation and starts again once the chat has been idle.'}
                        </div>
                      </div>
                    </label>
                  )}
                </div>
              )}
            </div>
        </div>
      )}

      {/* The model picker and what the agent can understand, side by side.
          These were two stacked cards, and the understanding one held exactly
          two checkboxes — so the tab opened on a screen of mostly empty space
          and still had to be scrolled. Two columns that wrap at narrow widths
          fill it without shrinking anything. */}
      {tab === 'ai' && (
      <Section title="Brain" subtitle="Which model answers, and what kinds of message it can understand. API keys live in Integrations → AI Models, not on the agent.">
        {showNotIntegrated ? (
          <NotIntegratedCard onGo={handleGoToIntegrations} saving={saving} canGo={!!navigate} />
        ) : (
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 300px', minWidth: 0 }}>
              <Field label="AI Model *" info="The connected provider credential (from Integrations → AI Models) this agent uses.">
                <SearchableSelect
                  value={form.aiModelId}
                  onChange={setAiModelId}
                  placeholder="— Select —"
                  searchPlaceholder="Search providers…"
                  options={modelRowOptions.map(m => ({ value: String(m.id), label: providerDisplay(m.provider, m.label) }))}
                />
              </Field>
              {selectedModelRow && (
                <div style={{ marginTop: 12 }}>
                  <Field label="Model *">
                    <SearchableSelect
                      value={form.llmModel}
                      onChange={(val) => setForm(f => ({ ...f, llmModel: val }))}
                      placeholder="— Select —"
                      options={modelOptions.map(m => ({ value: m.value, label: m.label }))}
                    />
                  </Field>
                </div>
              )}
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>
                Need another provider?{' '}
                <a
                  href="#/admin-settings/integrations/ai-models"
                  onClick={(e) => { if (navigate) { e.preventDefault(); handleGoToIntegrations(); } }}
                  style={{ color: C.primary, fontWeight: 600, textDecoration: 'none' }}
                >
                  Manage AI Models <ExternalLink size={10} style={{ verticalAlign: 'middle' }} />
                </a>
              </div>
            </div>

            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <UnderstandingConfig form={form} setForm={setForm} />
            </div>
          </div>
        )}
      </Section>
      )}

      {tab === 'setup' && (
      <Section title="Trigger" subtitle="Which incoming messages this agent picks up. Everything else on this number falls through to your keyword automations.">
        <TriggerConfig form={form} setForm={setForm} isAdmin={isAdmin} />
      </Section>
      )}

      {tab === 'ai' && (
      <Section title="Instructions" subtitle="The agent uses this as its system prompt on every turn.">
        <textarea
          value={form.systemPrompt}
          onChange={e => setForm(f => ({ ...f, systemPrompt: e.target.value }))}
          rows={8}
          placeholder="You are a helpful WhatsApp assistant..."
          style={{ ...inputStyle, fontFamily: MONO, fontSize: 15, lineHeight: 1.5, resize: 'vertical', minHeight: 140 }}
        />
      </Section>
      )}

      {/* ONE card, ONE list. Built-in abilities and attached tools are the same
          kind of thing to the person reading this — "what can it do?" — and each
          row opens its own settings, so nothing about a tool lives anywhere but
          inside its row. */}
      {tab === 'tools' && (
      <Section
        title="What this agent can do"
        subtitle="Everything the agent can do mid-conversation. Switch something on, then open its row to set it up. Adding a tool before the first save will save this agent as a draft automatically."
      >
        <AgentToolsList
          agentId={liveId} tools={tools} onChange={reloadTools} ensureAgentId={ensureSaved}
          builtIns={builtIns}
        />
      </Section>
      )}

      {tab === 'activity' && !isCreate && <AgentRunsViewer agentId={liveId} />}
      {tab === 'activity' && isCreate && (
        <Section title="Activity">
          <div style={{ fontSize: 15, color: C.textMuted }}>
            Run history appears here once the agent has been saved and has handled its first message.
          </div>
        </Section>
      )}

        </div>
      </div>
      </div>

      <ActionBar
        isCreate={isCreate}
        saving={saving}
        onSave={handleSave}
        onCancel={onCancel}
        onDelete={isAdmin && !isCreate ? () => setPendingDelete(true) : null}
      />
      </div>

      {/* RIGHT — pinned pane. Full height of the editor area, never scrolls,
          never resizes. The phone stretches to fill it. */}
      <aside style={{
        flex: '0 0 326px', height: '100%', minHeight: 0,
        borderLeft: `1px solid ${C.border}`, background: C.sidebarBg,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 8, padding: '14px 12px 16px', boxSizing: 'border-box', overflow: 'hidden',
      }}>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--c-t6, #888)', fontWeight: 700, flexShrink: 0 }}>
          Live test chat
        </div>
        <div style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', justifyContent: 'center' }}>
          <AgentLivePreview
            agentId={isCreate ? null : liveId}
            headerTitle={form.name}
            canTest={!isCreate}
            fill
          />
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 1.4, maxWidth: 290, flexShrink: 0 }}>
          Runs the live model — not sent to WhatsApp, not saved to run history. Sheets tools hit the real spreadsheet.
        </div>

        {/* Sits directly under the test chat because it answers the next
            question that chat raises: "now try it on a real phone". */}
        <TestNumbersPanel
          agentId={isCreate ? null : liveId}
          value={form.testNumbers}
          onChange={(list) => setForm(f => ({ ...f, testNumbers: list }))}
        />
      </aside>

      <DeleteConfirmModal
        open={pendingDelete}
        title="Delete this agent?"
        message="This permanently removes the agent and its run history. WhatsApp messages to its bound number will fall back to keyword automations only."
        confirmText="Delete agent"
        onCancel={() => setPendingDelete(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

/* ---------- shared bits ---------- */

// Shown in the Model section when the workspace has no AI provider connected.
// "Go to Integrations" persists the in-progress agent as a draft first (handled
// by the caller) so nothing entered so far is lost.
function NotIntegratedCard({ onGo, saving, canGo }) {
  return (
    <div style={{
      padding: 18, borderRadius: 10, background: 'var(--c-surfaceAlt)',
      border: `1px dashed ${C.border}`, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: C.text, fontWeight: 700, fontSize: 15 }}>
        <AlertCircle size={15} color="var(--c-sb45309, #B45309)" /> No AI model connected
      </div>
      <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.55, marginBottom: 14 }}>
        Agents need a connected <strong>Anthropic</strong> or <strong>OpenAI</strong> key. Connect one
        under <strong>Integrations → AI Models</strong>, then come back and pick it here.
        Your progress is saved as a draft when you go.
      </div>
      <button
        type="button"
        onClick={onGo}
        disabled={saving || !canGo}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '9px 14px', borderRadius: 8, border: 'none',
          background: C.primary, color: '#fff',
          fontSize: 15, fontFamily: FONT, fontWeight: 700,
          cursor: (saving || !canGo) ? 'not-allowed' : 'pointer',
          opacity: (saving || !canGo) ? 0.6 : 1,
        }}
      >
        {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <ExternalLink size={13} />}
        Save draft &amp; go to Integrations
      </button>
    </div>
  );
}

/* ---------- built-in capability settings ---------- */
/*
 * These are the settings behind three of the Tools rows. They live as their own
 * components purely so the row that owns them can render them: a capability's
 * settings must not exist in a second place, which is what made the Tools tab
 * unreadable before (a block of toggles at the top, a read-only list of the same
 * toggles at the bottom, and Media stranded between them).
 */

/**
 * What kinds of message the agent can understand, and how much of each it will
 * accept. Sits beside the model picker because the two decide the same thing
 * together — a vision model with images switched off sees nothing, and images
 * switched on with a text-only model is money for no benefit.
 */
function UnderstandingConfig({ form, setForm }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.textSecondary,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
        <span>What it can understand</span>
        <InfoDot text="Text always works. Voice notes and images each cost extra per message — a voice note is billed per minute of audio and an image per picture — so each has its own ceiling." />
      </div>

      {/* Text is stated rather than offered: there is no switch for it, and a
          row of two toggles with no mention of text reads as though the agent
          might not handle typing. */}
      <MediaKindRow
        icon={Type}
        title="Text"
        subtitle="Always on — a typed message is what the agent is for."
      />

      <MediaKindRow
        icon={Mic}
        title="Voice notes"
        subtitle={form.transcribeAudio
          ? 'Transcribed with OpenAI Whisper and handled like a typed message.'
          : 'Off — a voice note gets no reply. Needs an OpenAI key in Integrations.'}
        info="Incoming WhatsApp voice notes are transcribed to text with OpenAI Whisper and handled like a typed message. It reuses the OpenAI key from Integrations → AI Models, so connect one there first."
        checked={form.transcribeAudio}
        onChange={(next) => setForm(f => ({ ...f, transcribeAudio: next }))}
      >
        <Field
          label="Longest voice note (seconds)"
          info="Measured off the actual file before it is transcribed, so a long note costs you nothing. Someone sending a ten-minute ramble is told to keep it short or type instead — the agent never goes quiet on them. Leave blank to accept any length."
        >
          <LimitInput
            value={form.maxVoiceSeconds}
            max={3600}
            onChange={v => setForm(f => ({ ...f, maxVoiceSeconds: v }))}
          />
        </Field>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, lineHeight: 1.5 }}>
          120 is about two minutes of speech — long enough for a real question, short enough not to be a monologue.
        </div>
      </MediaKindRow>

      <MediaKindRow
        icon={ImagePlus}
        title="Images"
        subtitle={form.acceptImages
          ? 'The agent sees the picture. Use a vision model (GPT-4o, Claude).'
          : 'Off — a photo is ignored, though any caption on it still counts as text.'}
        info="An incoming WhatsApp image is sent to the agent's model (with any caption) so it can see the picture. Use a vision-capable model such as GPT-4o or Claude. Every image adds tokens."
        checked={form.acceptImages}
        onChange={(next) => setForm(f => ({ ...f, acceptImages: next }))}
      >
        <Field
          label="Images per conversation"
          info="How many pictures the agent will look at in one conversation, counted per conversation and not per message — WhatsApp sends each photo as its own message, so a per-message limit could only ever be 1. Past the limit the agent says it cannot look at more and asks them to describe it. Leave blank to accept any number."
        >
          <LimitInput
            value={form.maxImagesPerConversation}
            max={1000}
            onChange={v => setForm(f => ({ ...f, maxImagesPerConversation: v }))}
          />
        </Field>
      </MediaKindRow>
    </div>
  );
}

/**
 * One kind of message the agent may receive. A switch-less row (Text) renders as
 * a plain statement; the settings only appear once the kind is switched on,
 * since a ceiling on something that is off is noise.
 */
function MediaKindRow({ icon: Icon, title, subtitle, info, checked, onChange, children }) {
  const hasSwitch = typeof onChange === 'function';
  const on = hasSwitch ? !!checked : true;
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: 9, padding: '10px 12px', marginBottom: 8,
      background: on ? C.cardBg : 'var(--c-surfaceAlt)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon size={14} style={{ flexShrink: 0, color: on ? C.textSecondary : C.textMuted }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 700, color: on ? C.text : C.textSecondary }}>
            {title}
            {info && <InfoDot text={info} />}
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 1, lineHeight: 1.45 }}>{subtitle}</div>
        </div>
        {hasSwitch && <Toggle checked={!!checked} onChange={onChange} />}
      </div>
      {on && hasSwitch && children && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          {children}
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none',
  boxSizing: 'border-box',
};

// `...rest` is forwarded so callers can attach a data- attribute (the Tools card
// scrolls to a capability by one). Without the spread the attribute would be
// silently dropped and the jump would just do nothing.
function Section({ title, subtitle, children, rightSlot, ...rest }) {
  return (
    <div {...rest} style={{ marginBottom: 28, padding: 20, background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: C.text, letterSpacing: '-.01em' }}>{title}</span>
          {subtitle && <InfoDot text={subtitle} width={260} />}
        </div>
        {rightSlot}
      </div>
      {children}
    </div>
  );
}

/**
 * The editor's section switcher.
 *
 * Underline tabs rather than a segmented pill: five items with icons do not fit
 * a pill at 13-inch widths without shrinking the labels back into the
 * unreadable range this change exists to get out of. The strip scrolls
 * horizontally on a narrow window instead of wrapping to two rows, which would
 * push the form down every time the window narrowed.
 */
function TabStrip({ tabs, value, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: 2, marginBottom: 20,
      borderBottom: `1px solid ${C.border}`,
      overflowX: 'auto', overflowY: 'hidden', flexShrink: 0,
    }}>
      {tabs.map(t => {
        const on = t.key === value;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            title={t.hint}
            onClick={() => onChange(t.key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 14px', border: 'none', background: 'transparent',
              borderBottom: `2px solid ${on ? C.primary : 'transparent'}`,
              marginBottom: -1,
              color: on ? C.primary : C.textSecondary,
              fontSize: 15, fontFamily: FONT, fontWeight: on ? 700 : 600,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <Icon size={14} /> {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Numbers that may exercise this agent on real WhatsApp.
 *
 * A test number does three things, and the panel says all three because the
 * name alone only implies the first:
 *   - reaches the agent while it is still a DRAFT, so you can run the whole
 *     path end to end before it answers a customer;
 *   - is exempt from every usage limit, so you can try it as many times as you
 *     like — which is the actual reason this exists;
 *   - has its runs marked TEST, so an afternoon of trying things out neither
 *     eats anyone's allowance nor reads later as customer activity.
 *
 * Triggers and funnel gating still apply. Those are what you are testing; an
 * agent that answered a test number regardless would prove it works in a mode
 * it will never run in.
 *
 * ⚠ Numbers are stored digits-only and matched on their LAST 10 DIGITS, so
 * "+91 98765 43210" and "9876543210" are the same tester. The panel strips
 * everything else as you add, rather than accepting a string that would
 * silently never match.
 */
function TestNumbersPanel({ agentId, value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState('');
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  // Live chat state per number. A paused chat is the one way a correctly
  // configured test number still gets no reply, and the router returns BEFORE
  // logging anything in that case — so without this the Activity tab shows
  // silence with no explanation.
  const [status, setStatus] = useState([]);
  const [resuming, setResuming] = useState('');

  const loadStatus = useCallback(async () => {
    if (agentId == null) { setStatus([]); return; }
    try { setStatus(await api.agents.testNumberStatus(agentId)); }
    catch { /* a status probe must never break the panel */ }
  }, [agentId]);
  useEffect(() => { loadStatus(); }, [loadStatus, list.length]);

  const statusFor = (number) => {
    const key = String(number).slice(-10);
    return status.find(s => String(s.number || '').slice(-10) === key) || null;
  };

  const resume = async (st) => {
    if (!st?.waNumber || !st?.contactNumber) return;
    setResuming(st.number);
    try {
      await api.agentConversation.resume(st.waNumber, st.contactNumber);
      await loadStatus();
    } catch (e) {
      notify(prettyError(e));
    } finally {
      setResuming('');
    }
  };

  const add = () => {
    const digits = draft.replace(/\D/g, '');
    if (digits.length < 7) { setErr('Enter a full phone number, with country code.'); return; }
    if (list.some(n => String(n.number || '').slice(-10) === digits.slice(-10))) {
      setErr('That number is already on the list.');
      return;
    }
    if (list.length >= 20) { setErr('Twenty test numbers is the maximum.'); return; }
    onChange([...list, { number: digits, label: label.trim() || null }]);
    setDraft(''); setLabel(''); setErr('');
  };

  return (
    <div style={{
      flexShrink: 0, width: '100%', maxWidth: 300, boxSizing: 'border-box',
      border: `1px solid ${C.border}`, borderRadius: 10, background: C.cardBg,
      padding: '10px 12px', fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.text }}>
        Test numbers
        <InfoDot text="Real phone numbers you can message the agent from. They reach it even while it is still a draft, they are exempt from every usage limit so you can test over and over, and their runs are marked TEST so they never count as customer traffic. The trigger and any funnel gating still apply." />
      </div>

      {list.length > 0 && (
        <div style={{ maxHeight: 108, overflowY: 'auto', margin: '8px 0 4px' }}>
          {list.map((n) => (
            <div key={n.number} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0',
              borderBottom: `1px solid ${C.borderSubtle || C.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontFamily: MONO, color: C.text }}>+{n.number}</div>
                {n.label && <div style={{ fontSize: 11, color: C.textMuted }}>{n.label}</div>}
                {(() => {
                  const st = statusFor(n.number);
                  if (!st?.paused) return null;
                  // A LIMIT pause lifts itself on this number's next message —
                  // saying "paused" without that would send someone hunting in
                  // Chats for a problem that is already solved.
                  if (!st.needsResume) {
                    return (
                      <div style={{ fontSize: 11, color: 'var(--c-successText, #0F6E56)', marginTop: 2 }}>
                        Was paused by a limit — clears on the next message
                      </div>
                    );
                  }
                  return (
                    <div style={{ fontSize: 11, color: 'var(--c-orangeText, #E65100)', marginTop: 2 }}>
                      Chat taken over by a person — the agent stays quiet
                      <button
                        type="button"
                        onClick={() => resume(st)}
                        disabled={resuming === n.number}
                        style={{
                          marginLeft: 6, padding: '1px 7px', borderRadius: 5,
                          border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                          color: C.text, fontFamily: FONT, fontSize: 11, fontWeight: 700,
                          cursor: resuming === n.number ? 'default' : 'pointer',
                        }}
                      >{resuming === n.number ? '…' : 'Return to bot'}</button>
                    </div>
                  );
                })()}
              </div>
              <button
                type="button"
                onClick={() => onChange(list.filter(x => x.number !== n.number))}
                title="Remove"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted, padding: 2, lineHeight: 0 }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value); setErr(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="91 98765 43210"
          style={{ ...inputStyle, flex: 1, minWidth: 0, fontSize: 13, padding: '7px 9px' }}
        />
        <button
          type="button" onClick={add}
          style={{
            flexShrink: 0, padding: '7px 11px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', fontFamily: FONT, fontSize: 13,
            fontWeight: 700, cursor: 'pointer',
          }}
        >Add</button>
      </div>
      <input
        value={label}
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        placeholder="Whose phone? (optional)"
        style={{ ...inputStyle, marginTop: 6, fontSize: 13, padding: '7px 9px' }}
      />

      {err && <div style={{ fontSize: 12, color: C.dangerText || C.primary, marginTop: 6 }}>{err}</div>}
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, lineHeight: 1.45 }}>
        Applies once you press Save. Message the agent's WhatsApp number from one of these phones.
      </div>
    </div>
  );
}

/**
 * A number box where EMPTY means "no limit".
 *
 * Empty is the ONLY way to express unlimited: a typed 0 clears back to no
 * limit rather than being stored, because "0 replies allowed" is a reading
 * someone could reasonably expect from it and it would silence the agent. The
 * backend applies the same rule, so a value typed here and a value posted by
 * an API client cannot mean different things.
 */
function LimitInput({ value, max, onChange }) {
  return (
    <input
      type="number"
      min={1}
      max={max}
      value={value ?? ''}
      placeholder="No limit"
      onChange={e => {
        const raw = e.target.value;
        if (raw === '') return onChange(null);
        const n = parseInt(raw, 10);
        onChange(Number.isFinite(n) && n > 0 ? Math.min(n, max) : null);
      }}
      style={inputStyle}
    />
  );
}

function FieldRow({ children }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
      {children}
    </div>
  );
}

// Field-level description now lives in an info icon next to the label (`info`),
// not as a paragraph under the input.
function Field({ label, info, children }) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.textSecondary,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        <span>{label}</span>{info && <InfoDot text={info} />}
      </div>
      {children}
    </div>
  );
}

/* ---------- Trigger config ---------- */

// Mode toggle (Any message / Keyword) + keyword settings. Styled to the agent
// builder (pills + fields), not the automation flow-canvas node.
function TriggerConfig({ form, setForm, isAdmin }) {
  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const mode = form.triggerMode || 'any';
  const isKeyword = mode === 'keyword';
  return (
    <div>
      <FieldRow>
        <Field label="When does it run?" info="Any message: replies to every inbound on its number. New conversations only: engages a contact ONLY on their first-ever message (a new lead), then keeps replying to that conversation — it never joins conversations that already existed. Keyword: engages only when a message matches a keyword, then keeps replying for the session.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Pill active={mode === 'any'} onClick={() => set({ triggerMode: 'any' })}>Any message</Pill>
            <Pill active={mode === 'new'} onClick={() => set({ triggerMode: 'new' })}>New conversations only</Pill>
            <Pill active={isKeyword} onClick={() => set({ triggerMode: 'keyword' })}>Keyword</Pill>
          </div>
        </Field>
      </FieldRow>

      {mode === 'new' && (
        <>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: -4, marginBottom: 8, lineHeight: 1.5 }}>
            The agent answers a contact only on their <strong>first message</strong> to this number, then continues that conversation for the session window below. Existing/ongoing chats are left untouched.
          </div>
          <FieldRow>
            <Field label="Session window (minutes)" info="After the agent engages a new conversation, it keeps handling that contact's messages for this long since their last message — so it holds the back-and-forth.">
              <input
                type="number" min={1} max={1440}
                value={form.triggerSessionMinutes}
                onChange={e => set({ triggerSessionMinutes: parseInt(e.target.value, 10) || 30 })}
                style={inputStyle}
              />
            </Field>
          </FieldRow>
        </>
      )}

      {isKeyword && (
        <>
          <FieldRow>
            <Field label="Keyword *" info="The word or phrase the contact must send to wake the agent up.">
              <input
                value={form.triggerKeyword}
                onChange={e => set({ triggerKeyword: e.target.value.slice(0, 200) })}
                placeholder="e.g. price, book, support"
                style={inputStyle}
              />
            </Field>
            <Field label="Match type" info="Exact: the whole message equals the keyword. Contains: the keyword appears anywhere. Starts with: the message begins with the keyword.">
              <div style={{ display: 'flex', gap: 8 }}>
                <Pill active={form.triggerMatchType === 'exact'} onClick={() => set({ triggerMatchType: 'exact' })}>Exact</Pill>
                <Pill active={form.triggerMatchType === 'contains'} onClick={() => set({ triggerMatchType: 'contains' })}>Contains</Pill>
                <Pill active={form.triggerMatchType === 'starts'} onClick={() => set({ triggerMatchType: 'starts' })}>Starts with</Pill>
              </div>
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Session window (minutes)" info="After the keyword engages the agent, it keeps handling that contact's messages for this long since their last message — so it can hold a back-and-forth without re-typing the keyword.">
              <input
                type="number" min={1} max={1440}
                value={form.triggerSessionMinutes}
                onChange={e => set({ triggerSessionMinutes: parseInt(e.target.value, 10) || 30 })}
                style={inputStyle}
              />
            </Field>
            <Field label="Case sensitive" info="When on, 'PRICE' and 'price' are treated as different. Usually leave this off.">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.triggerCaseSensitive}
                  onChange={e => set({ triggerCaseSensitive: e.target.checked })}
                  style={{ width: 16, height: 16, cursor: 'pointer' }} />
                <span style={{ fontSize: 15, color: C.text }}>Match exact letter case</span>
              </label>
            </Field>
          </FieldRow>
        </>
      )}

      <FunnelGate form={form} setForm={setForm} isAdmin={isAdmin} />
    </div>
  );
}

/**
 * Narrow the trigger to a part of the funnel.
 *
 * ANDed with the message trigger above, never OR'd: the keyword decides WHEN a
 * message is interesting, this decides WHOSE messages are. So "price" from a
 * lead at the Hot stage runs the agent, while the same word from someone
 * already enrolled falls through to a person.
 *
 * Admin-only, and enforced server-side rather than merely hidden — deciding
 * which customers get answered by a machine and which get a human is not a
 * decision a non-admin should be able to make with a crafted request.
 */
function FunnelGate({ form, setForm, isAdmin }) {
  const { stages, loading } = useFunnelConfig();
  const [tags, setTags] = useState([]);
  const stageKeys = form.triggerStageKeys || [];
  const tagIds = form.triggerTagIds || [];
  const gated = stageKeys.length > 0 || tagIds.length > 0;

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api.tags.list()
      .then(list => { if (alive) setTags(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setTags([]); });
    return () => { alive = false; };
  }, [isAdmin]);

  const toggle = (key, value) => setForm(f => {
    const cur = f[key] || [];
    return { ...f, [key]: cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value] };
  });

  // A non-admin sees the RESULT — otherwise the agent behaves in a way their
  // screen cannot explain — but no controls.
  if (!isAdmin) {
    if (!gated) return null;
    return (
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.55 }}>
          An admin has limited this agent to part of the funnel
          {stageKeys.length > 0 ? ` (${stageKeys.length} stage${stageKeys.length === 1 ? '' : 's'})` : ''}
          {tagIds.length > 0 ? `${stageKeys.length > 0 ? ' and' : ''} ${tagIds.length} tag${tagIds.length === 1 ? '' : 's'}` : ''}.
          Only people matching that also get a reply.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 2 }}>
        Only for part of the funnel
        <InfoDot text="Adds a second condition on TOP of the trigger above. Both must be true: the message has to match the trigger AND the person has to be at one of the stages (or carry one of the tags) you pick. Leave everything unpicked and the agent answers regardless of where someone sits — which is how it behaves today." />
        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
          color: C.textMuted, background: 'var(--c-surfaceAlt)', borderRadius: 20, padding: '2px 7px' }}>
          Admin only
        </span>
      </div>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        {gated
          ? 'Someone who matches none of these gets no reply from the agent — their message is left for a person.'
          : 'Nothing picked: the agent answers anyone whose message matches the trigger above.'}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.textSecondary,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 7 }}>
        Funnel stage
      </div>
      {loading ? (
        <div style={{ fontSize: 14, color: C.textMuted }}>Loading stages…</div>
      ) : stages.length === 0 ? (
        <div style={{ fontSize: 14, color: C.textMuted }}>No funnel stages configured yet.</div>
      ) : (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {stages.map(s => (
            <Chip key={s.stageKey} active={stageKeys.includes(s.stageKey)}
              onClick={() => toggle('triggerStageKeys', s.stageKey)}>
              {s.label}
            </Chip>
          ))}
        </div>
      )}

      {tags.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: C.textSecondary,
            textTransform: 'uppercase', letterSpacing: '.04em', margin: '14px 0 7px' }}>
            Or a tag
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {tags.map(t => (
              <Chip key={t.id} active={tagIds.includes(t.id)} onClick={() => toggle('triggerTagIds', t.id)}>
                {t.name}
              </Chip>
            ))}
          </div>
        </>
      )}

      {gated && (
        <button type="button" onClick={() => setForm(f => ({ ...f, triggerStageKeys: [], triggerTagIds: [] }))}
          style={{ marginTop: 12, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 14, fontFamily: FONT, fontWeight: 600, color: C.primary }}>
          Clear — answer everyone
        </button>
      )}
    </div>
  );
}

// A small multi-select chip. Deliberately not a Pill: those are single-choice
// and look it, and reading a row of Pills as "pick several" is the misreading
// this shape avoids.
function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      style={{
        padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
        border: `1.5px solid ${active ? C.primary : C.border}`,
        background: active ? 'var(--c-dangerBgSoft, #FEF1F1)' : C.cardBg,
        color: active ? C.primary : C.text,
        fontSize: 14, fontFamily: FONT, fontWeight: active ? 700 : 500,
      }}>
      {children}
    </button>
  );
}

function Pill({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
        border: `1.5px solid ${active ? C.primary : C.border}`,
        background: active ? 'var(--c-dangerBgSoft, #FEF1F1)' : C.cardBg,
        color: active ? C.primary : C.text,
        fontSize: 15, fontFamily: FONT, fontWeight: active ? 700 : 500,
      }}>
      {children}
    </button>
  );
}

function ActionBar({ isCreate, saving, onSave, onCancel, onDelete }) {
  return (
    // flexShrink:0 so the footer keeps its height however long the form gets —
    // it is the sibling of the scroll area, not a child of it, so it can never
    // be scrolled past or scrolled under.
    <div style={{
      flexShrink: 0,
      background: C.pageBg, padding: '14px 24px',
      borderTop: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end',
    }}>
      {onDelete && (
        <button type="button" onClick={onDelete}
          style={{
            marginRight: 'auto',
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '10px 14px', borderRadius: 8,
            border: '1px solid var(--c-dangerBorder, #FBC8C8)', background: 'var(--c-surface, #fff)',
            color: C.primary, fontSize: 15, fontFamily: FONT, fontWeight: 600,
            cursor: 'pointer',
          }}>
          <Trash2 size={13} /> Delete
        </button>
      )}
      <button type="button" onClick={onCancel}
        style={{
          padding: '10px 14px', borderRadius: 8,
          border: `1px solid ${C.border}`, background: C.cardBg,
          color: C.text, fontSize: 15, fontFamily: FONT, fontWeight: 600,
          cursor: 'pointer',
        }}>
        Cancel
      </button>
      <button type="button" onClick={onSave} disabled={saving}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '10px 18px', borderRadius: 8,
          border: 'none', background: C.primary, color: '#fff',
          fontSize: 15, fontFamily: FONT, fontWeight: 700,
          cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
        }}>
        {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />}
        {isCreate ? 'Create agent' : 'Save changes'}
      </button>
    </div>
  );
}

function prettyError(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  try {
    const m = msg.match(/^\d+\s+(.+)$/);
    if (m) {
      const body = JSON.parse(m[1]);
      if (body && body.error) return body.error;
    }
  } catch { /* fall through */ }
  return msg;
}
