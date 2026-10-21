// Setup: the page an agent opens on. It says in plain words what the agent does,
// then walks through what is still missing before it can be turned on. Every
// technical setting stays under Advanced.

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, ArrowRight, Play, KeyRound, Users, FileText, FlaskConical, Power, MessageCircle, Save } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, T, W, LH } from '../../../constants.js';
import { Button } from '../../academy/shared.jsx';
import { useConfirm } from '../../../components/ConfirmDialog.jsx';
import { showError, showSuccess } from '../../../lib/feedback.js';
import { Panel, Notice, textareaStyle } from '../wfShared.jsx';

const BLANK = /\[[^\]\n]{1,60}\]/;

const DEST_WORDS = {
  results_inbox: 'this agent’s Results page',
  rep_worklist: 'each rep’s “My leads today” list',
  whatsapp_template: 'a WhatsApp summary',
  email: 'email',
  webhook: 'a webhook',
};

function Step({ done, icon: Icon, title, detail, children, optional }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '14px 0', borderTop: `1px solid ${C.borderSubtle}` }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>{done ? <CheckCircle2 size={22} color={C.successText} /> : <Circle size={22} color={C.t8} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon size={16} color={C.t4} />
          <span style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: done ? C.textSecondary : C.text }}>{title}</span>
          {optional && <span style={{ fontSize: T.meta, color: C.textMuted }}>optional</span>}
        </div>
        {detail && <div style={{ fontSize: T.body, color: C.textSecondary, lineHeight: LH.normal, marginTop: 3 }}>{detail}</div>}
        {children && <div style={{ marginTop: 10 }}>{children}</div>}
      </div>
    </div>
  );
}

export default function SetupTab({ agentId, agent, version, triggerSummary, lookups, isAdmin, navigate, reload, dirty, goTab, onTurnOn }) {
  const [memory, setMemory] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [templates, setTemplates] = useState(null);
  const [lastTest, setLastTest] = useState(undefined);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    const [m, tp, runs] = await Promise.allSettled([
      api.workflowAgents.memory(agentId, { status: 'active' }),
      api.templates.list({ status: 'APPROVED' }),
      api.workflowAgents.runs(agentId, { trigger: 'test', limit: 5 }),
    ]);
    setMemory(m.value?.items || []);
    const list = Array.isArray(tp.value) ? tp.value : tp.value?.templates || [];
    setTemplates(list.filter(t => String(t.status).toUpperCase() === 'APPROVED').map(t => t.name));
    setLastTest(runs.value?.runs?.[0] || null);
  }, [agentId]);
  useEffect(() => { load(); }, [load]);

  const dests = (version?.destinations || []).filter(d => d.enabled !== false);
  const wa = dests.find(d => d.type === 'whatsapp_template');
  const needsReps = dests.some(d => d.type === 'rep_worklist' || d.type === 'whatsapp_template');
  const blanks = (memory || []).filter(m => m.kind !== 'contact' && BLANK.test(m.content));

  const keyReady = lookups.settings ? (lookups.settings.anthropic_credentials.length > 0 || lookups.settings.anthropic_env_key) : null;
  const repsReady = lookups.team ? lookups.team.numbers.some(n => n.current_rep_user_id) : null;
  const templateReady = wa ? templates === null ? null : templates.includes(wa.template) : true;
  const testReady = lastTest ? lastTest.status === 'succeeded' : false;
  const isOn = agent.status === 'active';

  const saveMemory = async (m) => {
    try {
      await api.workflowAgents.updateMemory(agentId, m.id, { content: drafts[m.id] ?? m.content });
      showSuccess('Saved. The agent uses it from its next run.');
      setDrafts(d => { const n = { ...d }; delete n[m.id]; return n; });
      load();
    } catch (e) { showError(e.message); }
  };

  const turnOffWhatsapp = async () => {
    const ok = await confirm({ title: 'Stop the WhatsApp summary?', body: 'Results still go to the Results page and the other places you chose. You can add it back under Advanced → Results & delivery.', confirmLabel: 'Stop it' });
    if (!ok) return;
    try {
      const config = { ...version, destinations: version.destinations.filter(d => d.type !== 'whatsapp_template') };
      await api.workflowAgents.saveVersion(agentId, config, 'Turned off the WhatsApp summary from Setup');
      showSuccess('WhatsApp summary turned off.');
      await reload();
    } catch (e) { showError(e.message); }
  };

  const required = [keyReady !== false, blanks.length === 0, !needsReps || repsReady !== false, templateReady !== false];
  const readyCount = required.filter(Boolean).length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start', fontFamily: FONT }}>
      {confirmEl}
      <Panel title="What this agent does">
        <div style={{ fontSize: T.bodyLg, color: C.text, lineHeight: LH.normal }}>{agent.description || 'No description yet.'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <div>
            <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>Runs</div>
            <div style={{ fontSize: T.body, color: C.text, marginTop: 2 }}>{(triggerSummary || []).join(' · ') || 'Only when run by hand'}</div>
          </div>
          <div>
            <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>Results go to</div>
            <div style={{ fontSize: T.body, color: C.text, marginTop: 2 }}>{dests.map(d => DEST_WORDS[d.type] || d.type).join(', ')}</div>
          </div>
          <div>
            <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>Changes</div>
            <div style={{ fontSize: T.body, color: C.text, marginTop: 2 }}>Never by itself. Anything it suggests waits in Approvals.</div>
          </div>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <Button onClick={() => goTab('triggers')}>Change when it runs</Button>
            <Button onClick={() => goTab('data')}>Change which leads</Button>
            <Button onClick={() => goTab('output')}>Change where results go</Button>
            <Button onClick={() => goTab('instructions')}>Edit instructions</Button>
          </div>
        )}
      </Panel>

      <Panel title="Get it ready" hint={isOn ? 'This agent is on.' : `${readyCount} of ${required.length} required steps done. It stays a draft until you turn it on.`}>
        {dirty && <Notice tone="warn" style={{ marginBottom: 10 }}>You have unsaved changes in Advanced. Save or discard them before using the buttons here.</Notice>}

        {keyReady !== null && (
          <Step done={keyReady} icon={KeyRound} title="Connect Claude" detail={keyReady ? 'An Anthropic API key is set up.' : 'Add an Anthropic API key. Without it every run stops straight away.'}>
            {!keyReady && isAdmin && <Button icon={ArrowRight} onClick={() => navigate('admin-settings', 'ai-models')}>Add the key</Button>}
          </Step>
        )}

        <Step done={memory !== null && blanks.length === 0} icon={FileText} title="Fill in your business details"
          detail={memory === null ? 'Checking…' : blanks.length ? 'Replace the parts in [brackets]. The agent reads these on every run.' : 'Nothing left in [brackets].'}>
          {blanks.map(m => (
            <div key={m.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: T.body, fontWeight: W.medium, color: C.text, marginBottom: 5 }}>{m.title}</div>
              <textarea rows={3} value={drafts[m.id] ?? m.content} onChange={e => setDrafts(d => ({ ...d, [m.id]: e.target.value }))} style={textareaStyle} />
              <div style={{ marginTop: 6 }}><Button icon={Save} disabled={(drafts[m.id] ?? m.content) === m.content} onClick={() => saveMemory(m)}>Save</Button></div>
            </div>
          ))}
        </Step>

        {needsReps && repsReady !== null && (
          <Step done={repsReady} icon={Users} title="Link WhatsApp numbers to reps"
            detail={repsReady ? 'At least one number has a rep.' : 'Say which rep handles each business number, so leads are listed under the right person instead of “Unassigned”.'}>
            {!repsReady && isAdmin && <Button icon={ArrowRight} onClick={() => navigate('workflow-agents', 'settings')}>Set up the team</Button>}
          </Step>
        )}

        {wa && (
          <Step done={templateReady === true} icon={MessageCircle} title="WhatsApp summary template"
            detail={templateReady ? `Uses the approved template “${wa.template}”.` : `The template “${wa.template}” is not an approved template, so this summary would be skipped every time.`}>
            {templateReady === false && isAdmin && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => goTab('output')}>Choose a template</Button>
                <Button variant="ghost" disabled={dirty} onClick={turnOffWhatsapp}>Turn the summary off</Button>
              </div>
            )}
          </Step>
        )}

        <Step done={testReady} icon={FlaskConical} title="Try it with a test run" optional
          detail={lastTest === undefined ? 'Checking…' : lastTest ? (testReady ? 'The last test run finished.' : `The last test run ${lastTest.status === 'failed' ? 'failed' : 'has not finished'}. ${lastTest.error ? lastTest.error : ''}`) : 'A test reads live data but changes and sends nothing. It shows exactly what the agent would produce.'}>
          <Button icon={Play} onClick={() => goTab('test')}>{lastTest ? 'Open tests' : 'Run a test'}</Button>
        </Step>

        <Step done={isOn} icon={Power} title="Turn it on" detail={isOn ? 'It runs on its schedule and events.' : 'Start its schedule and events. You can pause it at any time.'}>
          {!isOn && isAdmin && <Button variant="primary" icon={Power} onClick={onTurnOn}>Turn on</Button>}
        </Step>
      </Panel>
    </div>
  );
}
