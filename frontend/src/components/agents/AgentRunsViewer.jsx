import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronRight, CheckCircle2, AlertCircle, Clock, Cpu, Wrench, MessageSquare, ShieldBan } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';

/**
 * Run history for one agent. Shows recent runs (newest first), expanding a
 * row reveals the per-step trace (LLM calls + tool calls with input/output).
 */
export default function AgentRunsViewer({ agentId }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openDetail, setOpenDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.agents.runs(agentId);
      setRuns(r);
    } catch (e) {
      setError(pretty(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleExpand = async (run) => {
    if (openId === run.id) {
      setOpenId(null);
      setOpenDetail(null);
      return;
    }
    setOpenId(run.id);
    setOpenDetail(null);
    setLoadingDetail(true);
    try {
      const detail = await api.agents.run(agentId, run.id);
      setOpenDetail(detail);
    } catch (e) {
      setError(pretty(e));
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div style={{ marginBottom: 28, padding: 20, background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}`, fontFamily: FONT }}>
      {/* Header — collapsible title + refresh button on the same line. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <button onClick={() => setCollapsed(c => !c)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontFamily: FONT }}>
          <ChevronRight size={15} style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform .15s', color: C.textMuted }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: C.text, letterSpacing: '-.01em' }}>Recent runs</span>
          {runs.length > 0 && <span style={{ fontSize: 14, color: C.textMuted, fontWeight: 600 }}>({runs.length})</span>}
        </button>
        <button onClick={refresh}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 8,
            border: `1px solid ${C.border}`, background: C.cardBg,
            color: C.text, fontSize: 14, fontFamily: FONT, fontWeight: 600,
            cursor: 'pointer',
          }}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>

      {!collapsed && (
      <div style={{ marginTop: 16 }}>
      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 10,
          background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', border: '1px solid var(--c-dangerBorder, #FBC8C8)', fontSize: 14 }}>
          {error}
        </div>
      )}

      {!loading && runs.length === 0 && (
        <div style={{ padding: 16, background: C.surfaceAlt, borderRadius: 8,
          border: `1px dashed ${C.border}`, textAlign: 'center', fontSize: 14, color: C.textSecondary }}>
          No runs yet. Send the agent a WhatsApp message to trigger one.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.map(r => (
          <div key={r.id} style={{ background: C.cardBg, borderRadius: 8, border: `1px solid ${C.border}` }}>
            <button
              onClick={() => handleExpand(r)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <ChevronRight size={13} style={{
                transform: openId === r.id ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform .15s',
                color: C.textMuted,
              }} />
              <StatusIcon status={r.status} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, color: r.status === 'limited' ? C.textSecondary : C.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {/* A 'limited' row carries its reason in errorMessage but is
                      not a failure — prefixing it with "Error:" would report a
                      working limit as a fault. */}
                  {r.status === 'limited'
                    ? `Not answered — ${r.errorMessage || 'usage limit reached'}`
                    : (r.finalReply || (r.errorMessage ? `Error: ${r.errorMessage}` : '(no reply)'))}
                </div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2, fontFamily: MONO }}>
                  {/* A test run consumed no allowance and answers nobody real —
                      saying so here is what keeps the history readable after an
                      afternoon of trying things out. */}
                  {r.isTest && (
                    <span style={{
                      display: 'inline-block', marginRight: 6, padding: '1px 6px', borderRadius: 5,
                      background: 'var(--c-infoBg, #E6EEFC)', color: 'var(--c-infoText, #1D4ED8)',
                      fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
                    }}>TEST</span>
                  )}
                  +{r.contactNumber} · {formatRelative(r.startedAt)} · {durationMs(r)} ·{' '}
                  {(r.totalInputTokens || 0)}↓/{(r.totalOutputTokens || 0)}↑ tok
                </div>
              </div>
            </button>
            {openId === r.id && (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: 12, background: C.surfaceAlt }}>
                {loadingDetail && (
                  <div style={{ fontSize: 14, color: C.textMuted }}>Loading…</div>
                )}
                {openDetail && (
                  <Steps run={openDetail} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      </div>
      )}
    </div>
  );
}

function StatusIcon({ status }) {
  if (status === 'completed') return <CheckCircle2 size={14} color="var(--c-x0f7a38, #0F7A38)" />;
  if (status === 'failed')    return <AlertCircle size={14} color={C.primary} />;
  if (status === 'capped')    return <AlertCircle size={14} color="var(--c-sb45309, #B45309)" />;
  // A usage limit declined to answer. Not an error — a deliberate decision —
  // so it gets its own glyph rather than borrowing the red one.
  if (status === 'limited')   return <ShieldBan size={14} color={C.textMuted} />;
  return <Clock size={14} color={C.textMuted} />;
}

function Steps({ run }) {
  const steps = run.steps || [];
  if (steps.length === 0) {
    return <div style={{ fontSize: 14, color: C.textMuted }}>No steps recorded.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map(s => <Step key={s.id} step={s} />)}
      {run.finalReply && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'var(--c-successBgSoft, #ECFDF5)', border: '1px solid #A7F3D0',
          fontSize: 14, color: 'var(--c-s065f46, #065F46)', display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <MessageSquare size={13} style={{ marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Reply sent</div>
            <div>{run.finalReply}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ step }) {
  const isTool = step.stepType === 'tool_call';
  const Icon = isTool ? Wrench : Cpu;
  const titleColor = step.status === 'error' ? C.primary : C.text;
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: C.cardBg, border: `1px solid ${C.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Icon size={13} color={isTool ? 'var(--c-x0f7a38, #0F7A38)' : 'var(--c-purple, #534AB7)'} />
        <div style={{ fontSize: 14, fontWeight: 700, color: titleColor, flex: 1 }}>
          {isTool ? `Tool: ${step.toolType}` : 'LLM call'}
          {step.status === 'error' && ' · error'}
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, fontFamily: MONO }}>
          {step.latencyMs != null ? `${step.latencyMs}ms` : ''}
        </div>
      </div>
      {step.errorMessage && (
        <div style={{ fontSize: 13, color: C.primary, marginBottom: 6 }}>{step.errorMessage}</div>
      )}
      {step.input && (
        <CollapseBlock label="input" content={step.input} />
      )}
      {step.output && (
        <CollapseBlock label="output" content={step.output} />
      )}
    </div>
  );
}

function CollapseBlock({ label, content }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(content, null, 2);
  const short = json.length > 120 ? json.slice(0, 120) + '…' : json;
  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 13, color: C.textSecondary, fontWeight: 600, fontFamily: FONT,
          padding: 0,
        }}>
        {open ? '▾' : '▸'} {label}
      </button>
      <pre style={{
        margin: '4px 0 0', padding: open ? '8px 10px' : '4px 10px',
        background: C.surfaceAlt, borderRadius: 6,
        fontFamily: MONO, fontSize: 13, color: C.text,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: open ? 240 : 30, overflow: 'auto',
      }}>
        {open ? json : short}
      </pre>
    </div>
  );
}

function durationMs(r) {
  if (!r.startedAt) return '';
  const end = r.endedAt ? new Date(r.endedAt).getTime() : Date.now();
  const ms = end - new Date(r.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleString();
}

function pretty(e) {
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
