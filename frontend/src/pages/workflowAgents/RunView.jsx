// One run: status and cost up top, then the output beside the step-by-step trace.
// Polls while the run is queued or running (the SSE event only fires at the end),
// so a test run's tool calls appear as they happen.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cpu, Wrench, CornerDownRight, ShieldCheck, Brain, Info, CheckCircle2, XCircle, RotateCcw, Square,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { Button, Segmented } from '../academy/shared.jsx';
import { useServerEvents } from '../../hooks/useServerEvents.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { showError, showSuccess } from '../../lib/feedback.js';
import {
  RUN_STATUS, TRIGGER_LABEL, ACTION_STATUS, ACTION_TYPE_LABEL, Pill, Stat, Notice, JsonBlock, MiniMarkdown, Collapsible,
  rupees, when, duration, compact, useNarrow,
} from './wfShared.jsx';

const LIVE = new Set(['queued', 'running']);

const STEP_META = {
  model: { Icon: Cpu, label: 'Model turn' },
  tool_call: { Icon: Wrench, label: 'Tool call' },
  tool_result: { Icon: CornerDownRight, label: 'Tool result' },
  validation: { Icon: ShieldCheck, label: 'Output check' },
  memory_proposal: { Icon: Brain, label: 'Memory proposal' },
  action_proposal: { Icon: CheckCircle2, label: 'Action proposal' },
  info: { Icon: Info, label: 'Note' },
};

function stepSummary(s) {
  const o = s.output || {};
  if (s.type === 'model') {
    if (o.error) return `Error: ${o.error}`;
    const bits = [];
    if (o.stop_reason) bits.push(o.stop_reason.replace('_', ' '));
    if (o.usage) bits.push(`${compact((o.usage.input || 0) + (o.usage.cacheRead || 0) + (o.usage.cacheWrite || 0))} in / ${compact(o.usage.output || 0)} out`);
    if (Array.isArray(o.tool_calls) && o.tool_calls.length) bits.push(o.tool_calls.join(', '));
    if (o.served_by) bits.push(`served by ${o.served_by}`);
    return bits.join(' · ');
  }
  if (s.type === 'tool_result') return o.error ? `${o.error}: ${o.message || ''}` : 'OK';
  if (s.type === 'validation') return o.ok ? `Passed${o.evidence ? ` · evidence ${o.evidence.verified}/${o.evidence.total} verified` : ''}` : `${(o.errors || []).length} problem(s)`;
  if (s.type === 'info') {
    if (o.budget) return `Budget reached: ${o.budget.replace(/_/g, ' ')}`;
    if (o.batching) return `Batching ${o.candidates} candidates in groups of ${o.batch_size}`;
  }
  return '';
}

function Trace({ steps }) {
  if (!steps.length) return <div style={{ fontSize: T.body, color: C.textMuted, padding: 12 }}>No steps yet.</div>;
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map(s => {
        const m = STEP_META[s.type] || STEP_META.info;
        const failed = (s.type === 'tool_result' && s.output?.error) || (s.type === 'model' && s.output?.error) || (s.type === 'validation' && s.output && !s.output.ok);
        return (
          <li key={s.id}>
            <Collapsible
              title={(
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                  <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted, minWidth: 22 }}>{s.step}</span>
                  <m.Icon size={15} color={failed ? C.dangerText : C.t4} />
                  <span style={{ fontWeight: W.medium }}>{s.tool_key ? <span style={{ fontFamily: MONO }}>{s.tool_key}</span> : m.label}</span>
                  <span style={{ color: failed ? C.dangerText : C.textSecondary, fontWeight: W.normal, overflow: 'hidden', textOverflow: 'ellipsis' }}>{stepSummary(s)}</span>
                </span>
              )}
              right={s.duration_ms != null ? <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>{duration(s.duration_ms)}</span> : null}
            >
              {s.input != null && <><div style={{ fontSize: T.label, color: C.textMuted, margin: '4px 0' }}>INPUT</div><JsonBlock value={s.input} maxChars={4000} /></>}
              {s.output != null && <><div style={{ fontSize: T.label, color: C.textMuted, margin: '8px 0 4px' }}>OUTPUT</div><JsonBlock value={s.output} maxChars={4000} /></>}
            </Collapsible>
          </li>
        );
      })}
    </ol>
  );
}

function Output({ run }) {
  const [view, setView] = useState('readable');
  const checks = run.checks || {};
  if (!run.output && !run.output_markdown) {
    return <div style={{ fontSize: T.body, color: C.textMuted, padding: 12 }}>{LIVE.has(run.status) ? 'The output appears when the run finishes.' : 'This run produced no output.'}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented value={view} onChange={setView} options={[{ value: 'readable', label: 'Readable' }, { value: 'json', label: 'JSON' }]} />
        {run.output_valid === true && <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', color: C.successText, fontSize: T.meta }}><CheckCircle2 size={15} /> Matches the output schema</span>}
        {run.output_valid === false && <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', color: C.dangerText, fontSize: T.meta }}><XCircle size={15} /> Does not match the output schema</span>}
        {typeof checks.total === 'number' && (
          <span style={{ fontSize: T.meta, color: checks.failures?.length ? C.warnText : C.textSecondary }}>
            Evidence: {checks.verified}/{checks.total} quotes found in the chats
          </span>
        )}
      </div>
      {Array.isArray(run.validation_errors) && run.validation_errors.length > 0 && (
        <Notice tone="warn">{run.validation_errors.slice(0, 8).map((e, i) => <div key={i} style={{ fontFamily: MONO, fontSize: T.meta }}>{typeof e === 'string' ? e : JSON.stringify(e)}</div>)}</Notice>
      )}
      {checks.failures?.length > 0 && (
        <Collapsible title={`${checks.failures.length} quote(s) did not match the cited message${checks.removed ? ' and were removed' : ''}`}>
          <JsonBlock value={checks.failures} />
        </Collapsible>
      )}
      {view === 'readable'
        ? <div style={{ padding: '4px 2px' }}><MiniMarkdown text={run.output_markdown || ''} /></div>
        : <JsonBlock value={run.output} maxChars={20000} />}
    </div>
  );
}

export default function RunView({ runId, isAdmin, navigate, onRerun, sideBySide = true }) {
  const [run, setRun] = useState(null);
  const [steps, setSteps] = useState([]);
  const [tab, setTab] = useState('output');
  const [error, setError] = useState(null);
  const [confirmEl, confirm] = useConfirm();
  const narrow = useNarrow(1100);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.workflowAgents.getRun(runId), api.workflowAgents.runSteps(runId)]);
      setRun(r); setSteps(s.steps || []); setError(null);
      return r;
    } catch (e) { setError(e.message); return null; }
  }, [runId]);

  useEffect(() => {
    let stop = false;
    setRun(null); setSteps([]);
    const tick = async () => {
      const r = await load();
      if (!stop && r && LIVE.has(r.status)) timer.current = setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer.current); };
  }, [load]);

  useServerEvents(useCallback((ev) => {
    if (ev.type === 'workflow-agent-run' && String(ev.data?.runId) === String(runId)) load();
  }, [runId, load]));

  const cancel = async () => {
    const ok = await confirm({ title: 'Cancel this run?', body: 'It stops at its next step. Anything it already proposed stays in the approvals queue.', confirmLabel: 'Cancel run', danger: true });
    if (!ok) return;
    try { await api.workflowAgents.cancelRun(runId); showSuccess('Run cancelled.'); load(); } catch (e) { showError(e.message); }
  };
  const rerun = async () => {
    try {
      const { run: next } = await api.workflowAgents.rerun(runId);
      showSuccess(run.dry_run ? 'Test run queued again with the same settings.' : 'Run queued again with the same saved version.');
      onRerun?.(next);
    } catch (e) { showError(e.message); }
  };

  if (error && !run) return <Notice tone="danger">{error}</Notice>;
  if (!run) return <div style={{ padding: 20, color: C.textMuted, fontSize: T.body, fontFamily: FONT }}>Loading run…</div>;

  const tokensIn = (run.input_tokens || 0) + (run.cache_read_tokens || 0) + (run.cache_write_tokens || 0);
  const columns = sideBySide && !narrow;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT }}>
      {confirmEl}
      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text }}>Run #{run.id}</span>
          <Pill meta={RUN_STATUS[run.status]} fallback={run.status} />
          <span style={{ fontSize: T.body, color: C.textSecondary }}>{TRIGGER_LABEL[run.trigger_type] || run.trigger_type}{run.dry_run ? ' · nothing was changed or sent' : ''}</span>
          {run.pretend_date && <span style={{ fontSize: T.meta, color: C.warnText }}>Pretending today is {run.pretend_date}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {isAdmin && LIVE.has(run.status) && <Button variant="danger" icon={Square} onClick={cancel}>Cancel</Button>}
            {isAdmin && !LIVE.has(run.status) && <Button icon={RotateCcw} onClick={rerun}>Run again</Button>}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 14 }}>
          <Stat label="Started" value={when(run.started_at || run.queued_at)} />
          <Stat label="Duration" value={LIVE.has(run.status) ? '…' : duration(run.duration_ms)} />
          <Stat label="Tokens" value={`${compact(tokensIn)} / ${compact(run.output_tokens)}`} sub={run.cache_read_tokens ? `${compact(run.cache_read_tokens)} from cache` : 'in / out'} />
          <Stat label="Tool calls" value={run.tool_calls ?? 0} />
          <Stat label="Cost" value={rupees(run.cost_inr)} />
          <Stat label="Model" value={<span style={{ fontSize: T.body }}>{run.model || '—'}</span>} />
        </div>
        {run.error && <Notice tone={run.status === 'budget_stopped' ? 'warn' : 'danger'}>{run.error}</Notice>}
      </div>

      {columns ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
          <Box title="Output"><Output run={run} /></Box>
          <Box title={`Trace · ${steps.length} step${steps.length === 1 ? '' : 's'}`}><Trace steps={steps} /></Box>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'output', label: 'Output' }, { value: 'trace', label: `Trace (${steps.length})` }]} />
          <Box>{tab === 'output' ? <Output run={run} /> : <Trace steps={steps} />}</Box>
        </div>
      )}

      {(run.actions?.length > 0 || run.deliveries?.length > 0) && (
        <Box title="What this run proposed and where it went">
          {run.actions?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {run.actions.map(a => (
                <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.body, flexWrap: 'wrap' }}>
                  <span style={{ color: C.text }}>{ACTION_TYPE_LABEL[a.action_type] || a.action_type}</span>
                  {a.contact_id && <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>lead #{a.contact_id}</span>}
                  <Pill meta={ACTION_STATUS[a.status]} fallback={a.status} />
                </div>
              ))}
              {navigate && run.actions.some(a => a.status === 'pending') && (
                <div><Button variant="ghost" onClick={() => navigate('workflow-agent-approvals')}>Open approvals</Button></div>
              )}
            </div>
          )}
          {run.deliveries?.map(d => (
            <div key={d.destination_index} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.body, flexWrap: 'wrap', padding: '4px 0' }}>
              <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.t3 }}>{d.type}</span>
              <span style={{ color: d.status === 'failed' ? C.dangerText : d.status === 'sent' ? C.successText : C.textSecondary }}>{d.status}</span>
              {d.error && <span style={{ color: C.dangerText, fontSize: T.meta }}>{d.error}</span>}
            </div>
          ))}
        </Box>
      )}
    </div>
  );
}

function Box({ title, children }) {
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, minWidth: 0 }}>
      {title && <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, marginBottom: 10, lineHeight: LH.tight }}>{title}</div>}
      {children}
    </div>
  );
}
