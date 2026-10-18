// Test playground: run the UNSAVED draft on live data without changing anything.
// Write tools are simulated, nothing is delivered, and the run is marked as a test,
// so an admin can see the effect of an edit before saving it.

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Play } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, inputStyle } from '../../academy/shared.jsx';
import { showError } from '../../../lib/feedback.js';
import { useServerEvents } from '../../../hooks/useServerEvents.js';
import RunView from '../RunView.jsx';
import { Panel, Notice, Field, RUN_STATUS, Pill, when, rupees, textareaStyle, useNarrow } from '../wfShared.jsx';

const todayIst = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

export default function TestTab({ agentId, isAdmin, dirty, buildOverride, schemaError, navigate }) {
  const narrow = useNarrow(1100);
  const [pretend, setPretend] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState([]);
  const [active, setActive] = useState(null);

  const loadRecent = useCallback(async () => {
    try {
      const r = await api.workflowAgents.runs(agentId, { trigger: 'test', limit: 12 });
      setRecent(r.runs || []);
      setActive(a => a || r.runs?.[0]?.id || null);
    } catch (e) { showError(e.message); }
  }, [agentId]);
  useEffect(() => { loadRecent(); }, [loadRecent]);
  useServerEvents(useCallback((ev) => { if (ev.type === 'workflow-agent-run' && String(ev.data?.agentId) === String(agentId)) loadRecent(); }, [agentId, loadRecent]));

  const start = async () => {
    if (schemaError) { showError(schemaError); return; }
    let triggerPayload = {};
    if (payload.trim()) {
      try { triggerPayload = JSON.parse(payload); } catch (e) { showError(`The trigger payload is not valid JSON: ${e.message}`); return; }
    }
    setBusy(true);
    try {
      const { run } = await api.workflowAgents.run(agentId, { dry_run: true, pretend_date: pretend || null, config_override: buildOverride(), trigger_payload: triggerPayload });
      setActive(run.id);
      loadRecent();
    } catch (e) {
      const list = e.body?.errors;
      showError(Array.isArray(list) && list.length ? list.join('\n') : e.message);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '320px minmax(0, 1fr)', gap: 16, alignItems: 'start', fontFamily: FONT }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Panel title="Test run" hint="Uses everything on screen, saved or not.">
          <Notice tone="info" style={{ marginBottom: 12 }}>
            Reads live data but changes nothing: proposals are simulated and nothing is sent. It still calls Claude, so it costs the same as a real run.
          </Notice>
          {dirty && <div style={{ fontSize: T.meta, color: C.warnText, marginBottom: 10 }}>Includes your unsaved changes.</div>}
          <Field label="Pretend today is" hint="Leave empty for today. Leads created after that day are hidden.">
            <input type="date" value={pretend} max={todayIst()} onChange={e => setPretend(e.target.value)} style={inputStyle} />
          </Field>
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: T.meta, color: C.textSecondary }}>Trigger payload (optional)</summary>
            <textarea rows={4} value={payload} onChange={e => setPayload(e.target.value)} placeholder={'{ "lead_id": "123" }'} spellCheck={false} style={{ ...textareaStyle, fontFamily: MONO, fontSize: T.meta, marginTop: 8 }} />
          </details>
          {isAdmin
            ? <Button variant="primary" icon={Play} disabled={busy} onClick={start} style={{ width: '100%' }}>{busy ? 'Starting…' : 'Run test'}</Button>
            : <div style={{ fontSize: T.meta, color: C.textMuted }}>Only admins can start a test run.</div>}
        </Panel>

        <Panel title="Recent test runs" bodyStyle={{ padding: 8 }}>
          {recent.length === 0 ? <div style={{ fontSize: T.body, color: C.textMuted, padding: 10 }}>No test runs yet.</div> : recent.map(r => (
            <button key={r.id} type="button" onClick={() => setActive(r.id)}
              style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'center', padding: '9px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT, background: String(active) === String(r.id) ? C.selectedTint : 'transparent' }}>
              <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>#{r.id}</span>
              <span style={{ fontSize: T.body, color: C.text, flex: 1 }}>{when(r.queued_at)}</span>
              <span style={{ fontSize: T.meta, color: C.textSecondary, fontFamily: MONO }}>{rupees(r.cost_inr)}</span>
              <Pill meta={RUN_STATUS[r.status]} fallback={r.status} />
            </button>
          ))}
        </Panel>
      </div>

      <div style={{ minWidth: 0 }}>
        {active ? <RunView key={active} runId={active} isAdmin={isAdmin} navigate={navigate} onRerun={(run) => { setActive(run.id); loadRecent(); }} /> : (
          <Panel>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 10px', textAlign: 'center' }}>
              <FlaskConical size={34} color={C.textMuted} />
              <div style={{ fontSize: T.lead, fontWeight: W.medium, color: C.text }}>Run a test to see the trace and the output side by side</div>
              <div style={{ fontSize: T.body, color: C.textSecondary, lineHeight: LH.normal, maxWidth: 460 }}>Change the instructions, tools or data access, run a test, and compare it with the last one.</div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
