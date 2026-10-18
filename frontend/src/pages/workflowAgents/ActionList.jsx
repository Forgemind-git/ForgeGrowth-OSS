// Proposed actions waiting for a person. Shared by the global Approvals page and an
// agent's Results tab. Nothing an agent proposes runs until someone approves it
// here; the server decides who may approve, and says so per row (`can_decide`).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Pencil, ShieldCheck, Clock } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { Button, EmptyState, Modal, inputStyle, StageBadge } from '../academy/shared.jsx';
import { Segmented } from '../academy/shared.jsx';
import { useServerEvents } from '../../hooks/useServerEvents.js';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { notify, showError, showSuccess } from '../../lib/feedback.js';
import { ACTION_STATUS, ACTION_TYPE_LABEL, Pill, ago, when, textareaStyle, JsonBlock, Field } from './wfShared.jsx';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'executed', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
  { value: 'all', label: 'All' },
];

function PayloadPreview({ a }) {
  const p = a.payload || {};
  const box = { fontSize: T.body, color: C.t2, lineHeight: LH.normal };
  switch (a.action_type) {
    case 'send_whatsapp':
      return p.kind === 'template'
        ? <div style={box}>Template <b style={{ fontFamily: MONO }}>{p.template_name}</b>{(p.variables || []).length ? <> with {p.variables.map((v, i) => <code key={i} style={{ fontFamily: MONO, background: C.surfaceMuted, padding: '1px 5px', borderRadius: 4, margin: '0 3px' }}>{v}</code>)}</> : null}</div>
        : <div style={{ ...box, background: C.surfaceInner, border: `1px solid ${C.borderSubtle}`, borderRadius: 10, padding: '10px 12px', whiteSpace: 'pre-wrap' }}>{p.text}</div>;
    case 'tag_contact': return <div style={box}>Add tag <b>{p.tag}</b></div>;
    case 'set_stage': return <div style={{ ...box, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{p.from ? <StageBadge stage={p.from} /> : null}<span>→</span><StageBadge stage={p.to} /></div>;
    case 'assign_rep': return <div style={box}>Make rep <b style={{ fontFamily: MONO }}>#{p.rep_user_id}</b> the owner{p.from_rep_user_id ? <> (was #{p.from_rep_user_id})</> : null}</div>;
    case 'create_task': return <div style={box}><b>{p.title}</b>{p.due_at ? <> · due {when(p.due_at)}</> : null}</div>;
    case 'add_note': return <div style={{ ...box, whiteSpace: 'pre-wrap' }}>{p.note}</div>;
    case 'trigger_automation': return <div style={box}>Run automation <b>{p.flow_name || `#${p.flow_id}`}</b></div>;
    case 'notify_rep': return <div style={box}>{p.rep_user_id ? <>To rep #{p.rep_user_id}: </> : <>To admins: </>}{p.message}</div>;
    default: return <JsonBlock value={p} />;
  }
}

function EditModal({ action, onClose, onApprove }) {
  const p = action.payload || {};
  const [edits, setEdits] = useState(() => Object.fromEntries(action.editable_fields
    .filter(f => !(f === 'text' && p.kind !== 'text') && !(f === 'variables' && p.kind !== 'template'))
    .map(f => [f, f === 'due_at' ? (p.due_at ? toLocalInput(p.due_at) : '') : (p[f] ?? (f === 'variables' ? [] : ''))])));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setEdits(e => ({ ...e, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      const out = { ...edits };
      if (out.due_at) out.due_at = new Date(out.due_at).toISOString();
      await onApprove(out);
      onClose();
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`Edit and approve · ${ACTION_TYPE_LABEL[action.action_type] || action.action_type}`} onClose={onClose} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={CheckCircle2} disabled={busy} onClick={submit}>{busy ? 'Approving…' : 'Approve with changes'}</Button></>}>
      {'text' in edits && <Field label="Message"><textarea rows={6} value={edits.text} onChange={e => set('text', e.target.value)} style={textareaStyle} /></Field>}
      {'variables' in edits && edits.variables.map((v, i) => (
        <Field key={i} label={`Template variable {{${i + 1}}}`}><input value={v} onChange={e => set('variables', edits.variables.map((x, j) => (j === i ? e.target.value : x)))} style={inputStyle} /></Field>
      ))}
      {'title' in edits && <Field label="Task"><input value={edits.title} onChange={e => set('title', e.target.value)} style={inputStyle} /></Field>}
      {'due_at' in edits && <Field label="Due (IST)"><input type="datetime-local" value={edits.due_at} onChange={e => set('due_at', e.target.value)} style={inputStyle} /></Field>}
      {'note' in edits && <Field label="Note"><textarea rows={5} value={edits.note} onChange={e => set('note', e.target.value)} style={textareaStyle} /></Field>}
      {'message' in edits && <Field label="Message to the rep"><textarea rows={4} value={edits.message} onChange={e => set('message', e.target.value)} style={textareaStyle} /></Field>}
      {'tag' in edits && <Field label="Tag"><input value={edits.tag} onChange={e => set('tag', e.target.value)} style={inputStyle} /></Field>}
    </Modal>
  );
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reportOutcomes(outcomes, verb) {
  const ok = outcomes.filter(o => o.ok);
  const bad = outcomes.filter(o => !o.ok);
  if (!bad.length) { showSuccess(`${ok.length} action${ok.length === 1 ? '' : 's'} ${verb}.`); return; }
  const lines = bad.slice(0, 6).map(o => `#${o.id}: ${o.error || o.result?.error || o.status}`);
  notify({ variant: 'error', title: ok.length ? `${ok.length} ${verb}, ${bad.length} did not go through` : 'Nothing went through', message: lines.join('\n') });
}

export default function ActionList({ agentId = null, navigate, showAgent = true }) {
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const out = await api.workflowAgents.actions({ status, agent_id: agentId || undefined, limit: 200 });
      setData(out);
      setSelected(prev => new Set([...prev].filter(id => out.actions.some(a => a.id === id && a.status === 'pending' && a.can_decide))));
    } catch (e) { showError(e.message); setData({ actions: [], total: 0 }); }
  }, [status, agentId]);
  useEffect(() => { setData(null); load(); }, [load]);
  useServerEvents(useCallback((ev) => { if (ev.type === 'workflow-agent-actions' || ev.type === 'workflow-agent-run') load(); }, [load]));

  const decidable = useMemo(() => (data?.actions || []).filter(a => a.status === 'pending' && a.can_decide), [data]);

  const decideMany = async (ids, decision) => {
    if (!ids.length) return;
    if (decision === 'approve') {
      const sends = (data?.actions || []).filter(a => ids.includes(a.id) && a.action_type === 'send_whatsapp').length;
      const ok = await confirm({
        title: `Approve ${ids.length} action${ids.length === 1 ? '' : 's'}?`,
        body: sends ? `${sends} of these send a WhatsApp message to a customer as soon as you approve.` : 'Each one runs as soon as you approve it.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const { outcomes } = await api.workflowAgents.decide(ids, decision);
      reportOutcomes(outcomes, decision === 'approve' ? 'approved' : 'rejected');
      setSelected(new Set());
      await load();
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  };

  const approveWithEdits = async (action, edits) => {
    try {
      const { outcomes } = await api.workflowAgents.approve(action.id, edits);
      reportOutcomes(outcomes, 'approved');
      await load();
    } catch (e) { showError(e.message); throw e; }
  };

  const toggle = (id) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = decidable.length > 0 && decidable.every(a => selected.has(a.id));

  return (
    <div style={{ fontFamily: FONT }}>
      {confirmEl}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <Segmented value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        {status === 'pending' && decidable.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: T.body, color: C.t3, cursor: 'pointer' }}>
              <input type="checkbox" checked={allOn} onChange={() => setSelected(allOn ? new Set() : new Set(decidable.map(a => a.id)))} />
              Select all ({decidable.length})
            </label>
            <Button variant="primary" icon={CheckCircle2} disabled={busy || !selected.size} onClick={() => decideMany([...selected], 'approve')}>Approve {selected.size || ''}</Button>
            <Button variant="danger" icon={XCircle} disabled={busy || !selected.size} onClick={() => decideMany([...selected], 'reject')}>Reject {selected.size || ''}</Button>
          </div>
        )}
      </div>

      {!data ? (
        <div style={{ padding: 30, color: C.textMuted, fontSize: T.body }}>Loading…</div>
      ) : data.actions.length === 0 ? (
        <EmptyState Icon={ShieldCheck} title={status === 'pending' ? 'Nothing waiting for approval' : 'No actions here'} hint={status === 'pending' ? 'When an agent proposes a tag, a stage move, a task or a message, it waits here.' : undefined} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.actions.map(a => (
            <article key={a.id} style={{ background: C.cardBg, border: `1px solid ${selected.has(a.id) ? C.primary : C.border}`, borderRadius: 12, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {a.status === 'pending' && a.can_decide && (
                <input type="checkbox" aria-label="Select" checked={selected.has(a.id)} onChange={() => toggle(a.id)} style={{ marginTop: 4, width: 16, height: 16 }} />
              )}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>{ACTION_TYPE_LABEL[a.action_type] || a.action_type}</span>
                  <Pill meta={ACTION_STATUS[a.status]} fallback={a.status} />
                  {showAgent && (
                    <button type="button" onClick={() => navigate?.('workflow-agents', a.agent_id, 'results')} style={{ background: 'none', border: 'none', padding: 0, cursor: navigate ? 'pointer' : 'default', color: C.textSecondary, fontSize: T.meta, fontFamily: FONT }}>
                      {a.agent_name}
                    </button>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: T.meta, color: C.textMuted }}>{ago(a.created_at)}</span>
                </div>
                {a.contact_id && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: T.body, color: C.t3 }}>
                    <span style={{ fontWeight: W.medium, color: C.text }}>{a.contact_name || `Lead #${a.contact_id}`}</span>
                    {a.contact_phone && <span style={{ fontFamily: MONO, fontSize: T.meta }}>{a.contact_phone}</span>}
                    {a.stage && <StageBadge stage={a.stage} />}
                    <span style={{ fontSize: T.meta, color: C.textMuted }}>Owner: {a.owner_rep_name || 'Unassigned'}</span>
                  </div>
                )}
                <PayloadPreview a={a} />
                {a.reason && <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal }}><b style={{ color: C.t3 }}>Why:</b> {a.reason}</div>}
                {a.status === 'pending' && a.expires_at && (
                  <div style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: T.meta, color: C.warnText }}><Clock size={13} /> Expires {ago(a.expires_at)} ({when(a.expires_at)})</div>
                )}
                {a.status !== 'pending' && (a.decided_by_name || a.result) && (
                  <div style={{ fontSize: T.meta, color: C.textSecondary }}>
                    {a.decided_by_name && <>{a.status === 'rejected' ? 'Rejected' : 'Approved'} by {a.decided_by_name} · {when(a.decided_at)}. </>}
                    {a.result?.error && <span style={{ color: C.dangerText }}>{a.result.error}</span>}
                    {a.result?.ok && a.result?.note && <span>{a.result.note}</span>}
                  </div>
                )}
                {a.status === 'pending' && a.can_decide && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => decideMany([a.id], 'approve')}>Approve</Button>
                    {a.editable_fields.length > 0 && <Button icon={Pencil} disabled={busy} onClick={() => setEditing(a)}>Edit & approve</Button>}
                    <Button variant="danger" icon={XCircle} disabled={busy} onClick={() => decideMany([a.id], 'reject')}>Reject</Button>
                  </div>
                )}
                {a.status === 'pending' && !a.can_decide && (
                  <div style={{ fontSize: T.meta, color: C.textMuted }}>Waiting for an approver. You can see it because it is your lead.</div>
                )}
              </div>
            </article>
          ))}
          {data.total > data.actions.length && <div style={{ fontSize: T.meta, color: C.textMuted }}>Showing {data.actions.length} of {data.total}.</div>}
        </div>
      )}
      {editing && <EditModal action={editing} onClose={() => setEditing(null)} onApprove={(edits) => approveWithEdits(editing, edits)} />}
    </div>
  );
}
