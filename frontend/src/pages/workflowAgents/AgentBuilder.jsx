// The agent builder: one agent, ten tabs, routed as #/workflow-agents/<id>/<tab>.
//
// Two kinds of settings with two save paths, on purpose:
//  - the agent row (name, model, limits) is edited in place via PATCH;
//  - everything the agent DOES (instructions, tools, scope, triggers, output) is a
//    VERSION: Save writes a new immutable version with a change note, so a bad
//    edit can be compared and restored.
// Memory is neither: it is edited item by item and applies to the next run.
// The Test tab runs the UNSAVED draft, which is how an admin sees the effect of a
// change before saving it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Save, Play, Pause, Undo2, LayoutDashboard, ListChecks, ChevronDown, ChevronRight, FileText, Brain, Wrench, ShieldHalf, Clock, Send, FlaskConical, History, Inbox,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, T, W } from '../../constants.js';
import { Button, Modal, inputStyle } from '../academy/shared.jsx';
import PillStrip from '../../components/PillStrip.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { notify, showError, showInfo, showSuccess } from '../../lib/feedback.js';
import { AGENT_STATUS, Pill, Notice, agentIcon, stableStringify, useNarrow, Field } from './wfShared.jsx';
import OverviewTab from './tabs/OverviewTab.jsx';
import SetupTab from './tabs/SetupTab.jsx';
import InstructionsTab from './tabs/InstructionsTab.jsx';
import MemoryTab from './tabs/MemoryTab.jsx';
import ToolsTab from './tabs/ToolsTab.jsx';
import DataScopeTab from './tabs/DataScopeTab.jsx';
import TriggersTab from './tabs/TriggersTab.jsx';
import OutputTab from './tabs/OutputTab.jsx';
import TestTab from './tabs/TestTab.jsx';
import RunsTab from './tabs/RunsTab.jsx';
import ResultsTab from './tabs/ResultsTab.jsx';

// Everyday tabs first; the settings that need some understanding of how agents
// work sit behind "Advanced". Tab ids are unchanged, so old links still open.
const PRIMARY_TABS = [
  { id: 'setup', label: 'Setup', Icon: ListChecks },
  { id: 'test', label: 'Test', Icon: FlaskConical },
  { id: 'results', label: 'Results & approvals', Icon: Inbox },
  { id: 'runs', label: 'Runs', Icon: History },
];
const ADVANCED_TABS = [
  { id: 'instructions', label: 'Instructions', Icon: FileText },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'triggers', label: 'Schedule & events', Icon: Clock },
  { id: 'data', label: 'Which leads', Icon: ShieldHalf },
  { id: 'output', label: 'Results & delivery', Icon: Send },
  { id: 'tools', label: 'Tools', Icon: Wrench },
  { id: 'overview', label: 'Model & budget', Icon: LayoutDashboard },
];
const TABS = [...PRIMARY_TABS, ...ADVANCED_TABS];
const ADVANCED_IDS = new Set(ADVANCED_TABS.map(t => t.id));
const CONFIG_TABS = new Set(['overview', 'instructions', 'tools', 'data', 'triggers', 'output']);
const CONFIG_KEYS = ['instructions', 'output_schema', 'tool_config', 'data_scope', 'triggers', 'destinations', 'approval_rules', 'runtime'];
const SETTINGS_KEYS = ['name', 'description', 'model', 'effort', 'temperature', 'max_tool_calls', 'max_tokens_per_run', 'max_output_tokens', 'monthly_budget_inr', 'credential_id', 'auto_accept_memory'];

function draftFromVersion(v) {
  const d = Object.fromEntries(CONFIG_KEYS.map(k => [k, v ? JSON.parse(JSON.stringify(v[k] ?? null)) : null]));
  d.instructions = d.instructions || '';
  d.tool_config = d.tool_config || [];
  d.data_scope = d.data_scope || {};
  d.triggers = d.triggers || [];
  d.destinations = d.destinations || [{ type: 'results_inbox' }];
  d.approval_rules = d.approval_rules || { approvers: ['admin'], expire_hours: 24, rep_can_send_suggested: false };
  d.runtime = d.runtime || { batching: { enabled: false, batch_size: 25, max_candidates: 150 } };
  return { ...d, output_schema_text: JSON.stringify(v?.output_schema || { type: 'object', properties: {} }, null, 2) };
}

const settingsFromAgent = (a) => Object.fromEntries(SETTINGS_KEYS.map(k => [k, a?.[k] ?? null]));

export default function AgentBuilder({ agentId, tab: routeTab, runId, user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const tab = TABS.some(t => t.id === routeTab) ? routeTab : 'setup';
  const [showAdvanced, setShowAdvanced] = useState(ADVANCED_IDS.has(tab));
  useEffect(() => { if (ADVANCED_IDS.has(tab)) setShowAdvanced(true); }, [tab]);
  const narrow = useNarrow(760);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [settings, setSettings] = useState(null);
  const [lookups, setLookups] = useState({ catalog: null, settings: null, team: null });
  const [saving, setSaving] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const out = await api.workflowAgents.get(agentId);
      setData(out);
      setDraft(draftFromVersion(out.version));
      setSettings(settingsFromAgent(out.agent));
      setLoadError(null);
    } catch (e) { setLoadError(e.message); }
  }, [agentId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    // Settings and team are admin-only on the server; a viewer simply gets fewer pickers.
    Promise.allSettled([
      api.workflowAgents.catalog(),
      isAdmin ? api.workflowAgents.settings() : Promise.reject(new Error('not admin')),
      isAdmin ? api.workflowAgents.team() : Promise.reject(new Error('not admin')),
    ]).then(([c, s, t]) => {
      if (!alive) return;
      setLookups({ catalog: c.value || null, settings: s.value || null, team: t.value || null });
    });
    return () => { alive = false; };
  }, [isAdmin]);

  // ── dirty state ─────────────────────────────────────────────────────────────
  const schema = useMemo(() => {
    if (!draft) return { value: null, error: null };
    try {
      const v = JSON.parse(draft.output_schema_text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: null, error: 'The output schema must be a JSON object.' };
      return { value: v, error: null };
    } catch (e) { return { value: null, error: `The output schema is not valid JSON: ${e.message}` }; }
  }, [draft]);

  const configFromDraft = useCallback(() => {
    if (!draft) return null;
    const c = Object.fromEntries(CONFIG_KEYS.map(k => [k, draft[k]]));
    c.output_schema = schema.value ?? draft.output_schema;
    return c;
  }, [draft, schema]);

  const configDirty = useMemo(() => {
    if (!draft || !data) return false;
    const saved = Object.fromEntries(CONFIG_KEYS.map(k => [k, data.version?.[k] ?? null]));
    if (schema.error) return true;
    return stableStringify(configFromDraft()) !== stableStringify({ ...saved, output_schema: data.version?.output_schema || { type: 'object', properties: {} } });
  }, [draft, data, schema, configFromDraft]);

  const settingsDirty = useMemo(() => !!(settings && data) && stableStringify(settings) !== stableStringify(settingsFromAgent(data.agent)), [settings, data]);
  const dirty = configDirty || settingsDirty;

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const patchDraft = useCallback((key, value) => setDraft(d => ({ ...d, [key]: typeof value === 'function' ? value(d[key]) : value })), []);
  const patchSettings = useCallback((key, value) => setSettings(s => ({ ...s, [key]: value })), []);

  // What a test run uses: the saved agent with every unsaved edit laid over it.
  const buildOverride = useCallback(() => {
    const config = configFromDraft();
    const agent = Object.fromEntries(SETTINGS_KEYS.filter(k => k !== 'name' && k !== 'description').map(k => [k, settings?.[k]]));
    return { ...config, agent };
  }, [configFromDraft, settings]);

  // ── save ────────────────────────────────────────────────────────────────────
  const reportSaveError = (e) => {
    const list = e.body?.errors;
    if (Array.isArray(list) && list.length) notify({ variant: 'error', title: 'This version cannot be saved yet', message: list.slice(0, 10).join('\n') });
    else showError(e.message);
  };

  const saveSettings = async () => {
    const patch = Object.fromEntries(SETTINGS_KEYS.filter(k => stableStringify(settings[k]) !== stableStringify(data.agent[k])).map(k => [k, settings[k]]));
    if (!Object.keys(patch).length) return;
    const out = await api.workflowAgents.update(agentId, patch);
    setData(d => ({ ...d, agent: out.agent }));
    setSettings(settingsFromAgent(out.agent));
  };

  const startSave = async () => {
    if (schema.error) { showError(schema.error); return; }
    if (configDirty) { setChangeNote(''); setNoteOpen(true); return; }
    setSaving(true);
    try { await saveSettings(); showSuccess('Saved.'); } catch (e) { reportSaveError(e); } finally { setSaving(false); }
  };

  const finishSave = async () => {
    setSaving(true);
    try {
      if (settingsDirty) await saveSettings();
      const out = await api.workflowAgents.saveVersion(agentId, configFromDraft(), changeNote.trim());
      setNoteOpen(false);
      setData(out);
      setDraft(draftFromVersion(out.version));
      setSettings(settingsFromAgent(out.agent));
      if (out.unchanged) showInfo('Nothing changed, so no new version was created.');
      else showSuccess(`Saved as version ${out.version?.version}.`);
    } catch (e) { reportSaveError(e); } finally { setSaving(false); }
  };

  const discard = async () => {
    const ok = await confirm({ title: 'Discard unsaved changes?', body: 'The agent goes back to its last saved version.', confirmLabel: 'Discard', danger: true });
    if (!ok) return;
    setDraft(draftFromVersion(data.version));
    setSettings(settingsFromAgent(data.agent));
  };

  const setStatus = async (status) => {
    if (status === 'active') {
      const ok = await confirm({
        title: 'Turn this agent on?',
        body: `Its schedules and events start running with version ${data.version?.version ?? '—'}. Each run calls Claude and costs money.${dirty ? ' Unsaved changes are NOT included — save first if you want them.' : ''}`,
        confirmLabel: 'Turn on',
      });
      if (!ok) return;
    }
    try {
      const out = await api.workflowAgents.update(agentId, { status });
      setData(d => ({ ...d, agent: out.agent }));
      showSuccess(status === 'active' ? 'The agent is on.' : status === 'paused' ? 'The agent is paused. Nothing runs until you resume it.' : 'Moved back to draft.');
    } catch (e) { showError(e.message); }
  };

  const remove = async () => {
    const ok = await confirm({ title: `Delete "${data.agent.name}"?`, body: 'Its versions, memory, runs and pending approvals are deleted too. This cannot be undone.', confirmLabel: 'Delete agent', danger: true });
    if (!ok) return;
    try { await api.workflowAgents.delete(agentId); showSuccess('Agent deleted.'); navigate('workflow-agents'); } catch (e) { showError(e.message); }
  };

  const goTab = (id) => navigate('workflow-agents', agentId, id);

  if (loadError && !data) {
    return (
      <div style={{ padding: 28, fontFamily: FONT }}>
        <Button variant="ghost" icon={ArrowLeft} onClick={() => navigate('workflow-agents')}>Workflow agents</Button>
        <div style={{ marginTop: 16 }}><Notice tone="danger">{loadError}</Notice></div>
      </div>
    );
  }
  if (!data || !draft || !settings) return <div style={{ padding: 28, fontFamily: FONT, color: C.textMuted, fontSize: T.body }}>Loading agent…</div>;

  const Icon = agentIcon(data.agent.icon);
  const common = { agentId, agent: data.agent, version: data.version, draft, patchDraft, settings, patchSettings, lookups, isAdmin, navigate, reload: load, dirty };

  const renderTab = () => {
    switch (tab) {
      case 'setup': return <SetupTab {...common} triggerSummary={data.trigger_summary} goTab={goTab} onTurnOn={() => setStatus('active')} />;
      case 'overview': return <OverviewTab {...common} triggerSummary={data.trigger_summary} onDelete={remove} />;
      case 'instructions': return <InstructionsTab {...common} currentConfig={configFromDraft} />;
      case 'memory': return <MemoryTab {...common} />;
      case 'tools': return <ToolsTab {...common} />;
      case 'data': return <DataScopeTab {...common} />;
      case 'triggers': return <TriggersTab {...common} onRunNow={() => goTab('runs')} />;
      case 'output': return <OutputTab {...common} schemaError={schema.error} />;
      case 'test': return <TestTab {...common} buildOverride={buildOverride} schemaError={schema.error} />;
      case 'runs': return <RunsTab {...common} runId={runId} />;
      case 'results': return <ResultsTab {...common} />;
      default: return null;
    }
  };

  const readOnly = !isAdmin && CONFIG_TABS.has(tab);

  return (
    <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', minHeight: '100%', width: '100%', minWidth: 0 }}>
      {confirmEl}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: C.pageBg, borderBottom: `1px solid ${C.border}`, padding: narrow ? '12px 14px 0' : '14px 28px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <button type="button" onClick={() => navigate('workflow-agents')} aria-label="Back to workflow agents" style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 4 }}>
            <ArrowLeft size={20} />
          </button>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: C.primaryLight, color: C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={19} />
          </span>
          <div style={{ minWidth: 0, flex: '1 1 200px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{settings.name || data.agent.name}</span>
              <Pill meta={AGENT_STATUS[data.agent.status]} fallback={data.agent.status} />
              <span style={{ fontSize: T.meta, color: C.textMuted }}>v{data.version?.version ?? '—'}</span>
              {dirty && <span style={{ fontSize: T.meta, fontWeight: W.medium, color: C.warnText }}>Unsaved changes</span>}
            </div>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
              {data.agent.status === 'active'
                ? <Button icon={Pause} onClick={() => setStatus('paused')}>Pause</Button>
                : <Button icon={Play} onClick={() => setStatus('active')}>{data.agent.status === 'paused' ? 'Resume' : 'Turn on'}</Button>}
              {dirty && <Button variant="ghost" icon={Undo2} onClick={discard}>Discard</Button>}
              <Button variant="primary" icon={Save} disabled={!dirty || saving} onClick={startSave}>{saving ? 'Saving…' : dirty ? (configDirty ? 'Save version' : 'Save') : 'Saved'}</Button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', overflowX: 'auto', paddingBottom: 10 }}>
          <PillStrip items={PRIMARY_TABS} value={tab} onChange={goTab} persistKey={`wf-agent-tabs-${agentId}`} />
          <button type="button" onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: ADVANCED_IDS.has(tab) ? C.primary : C.textSecondary, fontFamily: FONT, fontSize: T.body, fontWeight: W.medium, padding: '6px 8px' }}>
            {showAdvanced ? <ChevronDown size={16} /> : <ChevronRight size={16} />}Advanced
          </button>
        </div>
        {showAdvanced && (
          <div style={{ overflowX: 'auto', paddingBottom: 10 }}>
            <PillStrip items={ADVANCED_TABS} value={tab} onChange={goTab} size="sm" persistKey={`wf-agent-adv-${agentId}`} />
          </div>
        )}
      </div>

      <div style={{ padding: narrow ? '16px 14px 60px' : '20px 28px 60px', minWidth: 0 }}>
        {readOnly && <Notice tone="info" style={{ marginBottom: 14 }}>Only admins can change an agent. You can read its setup, run history and results.</Notice>}
        <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
          {renderTab()}
        </fieldset>
      </div>

      {noteOpen && (
        <Modal title={`Save version ${(data.version?.version || 0) + 1}`} onClose={() => !saving && setNoteOpen(false)} width={520}
          footer={<><Button variant="ghost" disabled={saving} onClick={() => setNoteOpen(false)}>Cancel</Button><Button variant="primary" icon={Save} disabled={saving} onClick={finishSave}>{saving ? 'Saving…' : 'Save version'}</Button></>}>
          <Field label="What changed? (optional)" hint="Shown in the version history so the next person knows why.">
            <input autoFocus value={changeNote} maxLength={500} onChange={e => setChangeNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') finishSave(); }} placeholder="e.g. Stop flagging leads who already paid" style={inputStyle} />
          </Field>
          {data.agent.status === 'active' && <Notice tone="info">The agent is on, so its next scheduled or event run uses this version.</Notice>}
        </Modal>
      )}
    </div>
  );
}
