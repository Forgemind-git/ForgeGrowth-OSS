// Memory: what the agent knows beyond its instructions. Items are edited one at a
// time and apply to the next run (they are audited, not versioned). What the agent
// proposes itself waits here for review unless auto-accept is on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, CheckCircle2, XCircle, Archive, RotateCcw, Search, Brain } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, EmptyState, Modal, Segmented, inputStyle } from '../../academy/shared.jsx';
import SearchableSelect from '../../../components/SearchableSelect.jsx';
import { useConfirm } from '../../../components/ConfirmDialog.jsx';
import { showError, showSuccess } from '../../../lib/feedback.js';
import { MEMORY_KIND, Pill, Panel, Notice, textareaStyle, when, Field } from '../wfShared.jsx';

const SOURCE_LABEL = { admin: 'Added by a person', agent_proposed: 'Proposed by the agent', feedback: 'From feedback' };

const STATUS_OPTS = [
  { value: '', label: 'All' },
  { value: 'pending_review', label: 'Needs review' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
];

function LeadPicker({ value, label, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const search = async () => {
    if (!q.trim()) return;
    try { const r = await api.leads.list({ search: q.trim() }); setResults((r.leads || []).slice(0, 25)); } catch (e) { showError(e.message); }
  };
  return (
    <div>
      {value && <div style={{ fontSize: T.body, color: C.text, marginBottom: 8 }}>Selected: <b>{label || `Lead #${value}`}</b></div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={q} placeholder="Search a lead by name or number" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} style={inputStyle} />
        <Button icon={Search} onClick={search}>Find</Button>
      </div>
      {results && (
        <div style={{ marginTop: 8 }}>
          {results.length === 0 ? <div style={{ fontSize: T.meta, color: C.textMuted }}>No leads match.</div> : (
            <SearchableSelect value={value ? String(value) : ''} placeholder="Choose the lead" onChange={(v) => { const l = results.find(x => String(x.id) === v); onChange(v, l?.name || null); }}
              options={results.map(l => ({ value: String(l.id), label: l.name || `Lead #${l.id}`, sublabel: `#${l.id} · ${l.stage || ''}` }))} />
          )}
        </div>
      )}
    </div>
  );
}

function MemoryModal({ item, mode, onClose, onSubmit }) {
  const [form, setForm] = useState(() => ({
    kind: item?.kind || 'pinned', title: item?.title || '', content: item?.content || '',
    contact_id: item?.contact_id || null, contact_name: item?.contact_name || null,
    expires_at: item?.expires_at ? item.expires_at.slice(0, 10) : '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit({
        kind: form.kind, title: form.title, content: form.content,
        contact_id: form.kind === 'contact' ? form.contact_id : null,
        expires_at: form.expires_at ? `${form.expires_at}T23:59:59+05:30` : null,
      });
      onClose();
    } catch { /* the caller already showed the error */ } finally { setBusy(false); }
  };
  const title = mode === 'review' ? 'Review what the agent learned' : item ? 'Edit memory' : 'Add memory';
  return (
    <Modal title={title} onClose={onClose} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={mode === 'review' ? CheckCircle2 : undefined} disabled={busy || !form.title.trim() || !form.content.trim() || (form.kind === 'contact' && !form.contact_id)} onClick={submit}>{busy ? 'Saving…' : mode === 'review' ? 'Approve' : 'Save'}</Button></>}>
      <Field label="Kind" hint={MEMORY_KIND[form.kind]?.hint}>
        <Segmented value={form.kind} onChange={(v) => set('kind', v)} options={Object.entries(MEMORY_KIND).map(([k, m]) => ({ value: k, label: m.label }))} />
      </Field>
      {form.kind === 'contact' && <Field label="Lead"><LeadPicker value={form.contact_id} label={form.contact_name} onChange={(id, name) => { set('contact_id', id); set('contact_name', name); }} /></Field>}
      <Field label="Title"><input value={form.title} maxLength={120} onChange={e => set('title', e.target.value)} style={inputStyle} /></Field>
      <Field label="Content"><textarea rows={7} value={form.content} maxLength={4000} onChange={e => set('content', e.target.value)} style={textareaStyle} /></Field>
      <Field label="Forget after (optional)" hint="Useful for a temporary offer or a batch date."><input type="date" value={form.expires_at} onChange={e => set('expires_at', e.target.value)} style={{ ...inputStyle, maxWidth: 220 }} /></Field>
    </Modal>
  );
}

export default function MemoryTab({ agentId }) {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [modal, setModal] = useState(null);
  const [confirmEl, confirm] = useConfirm();
  const debounce = useRef(null);

  const load = useCallback(async (query = q) => {
    try { setData(await api.workflowAgents.memory(agentId, { status, kind, q: query })); } catch (e) { showError(e.message); }
  }, [agentId, status, kind, q]);
  useEffect(() => { load(); }, [agentId, status, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSearch = (v) => { setQ(v); clearTimeout(debounce.current); debounce.current = setTimeout(() => load(v), 300); };

  const run = async (fn, ok) => { try { await fn(); if (ok) showSuccess(ok); await load(); } catch (e) { showError(e.message); throw e; } };

  const remove = async (m) => {
    const yes = await confirm({ title: `Delete “${m.title}”?`, body: 'The agent stops using it from the next run.', confirmLabel: 'Delete', danger: true });
    if (yes) run(() => api.workflowAgents.deleteMemory(agentId, m.id), 'Deleted.').catch(() => {});
  };

  const items = data?.items || [];
  const pending = items.filter(m => m.status === 'pending_review').length;
  const budget = data?.budget;
  const pct = budget ? Math.min(100, Math.round((budget.approx_tokens / budget.token_budget) * 100)) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      {confirmEl}
      <Panel
        title="Memory"
        hint="Pinned rules and glossary are read on every run. Contact notes are read when the agent looks at that lead. Changes apply to the next run."
        right={<Button variant="primary" icon={Plus} onClick={() => setModal({ mode: 'create' })}>Add memory</Button>}
      >
        {budget && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.meta, color: C.textSecondary, marginBottom: 5 }}>
              <span>Always-read memory: about {budget.approx_tokens.toLocaleString('en-IN')} tokens</span>
              <span style={{ fontFamily: MONO }}>{pct}% of {budget.token_budget.toLocaleString('en-IN')}</span>
            </div>
            <div style={{ height: 8, borderRadius: 99, background: C.surfaceMuted, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: budget.over_budget ? C.primary : pct > 80 ? C.amber : C.successBright }} />
            </div>
            {budget.over_budget && <Notice tone="warn" style={{ marginTop: 10 }}>Memory is over its budget. Every run pays for it, and long memory crowds out the conversations the agent needs to read. Archive what is no longer true.</Notice>}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Segmented value={status} onChange={setStatus} options={STATUS_OPTS.map(o => (o.value === 'pending_review' && pending ? { ...o, label: `Needs review (${pending})` } : o))} />
          <div style={{ minWidth: 170 }}>
            <SearchableSelect value={kind} onChange={setKind} options={[{ value: '', label: 'Every kind' }, ...Object.entries(MEMORY_KIND).map(([k, m]) => ({ value: k, label: m.label }))]} />
          </div>
          <div style={{ position: 'relative', flex: '1 1 220px' }}>
            <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 10, top: 12 }} />
            <input value={q} onChange={e => onSearch(e.target.value)} placeholder="Search text, or a lead's name or number" style={{ ...inputStyle, paddingLeft: 32 }} />
          </div>
        </div>
      </Panel>

      {!data ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : items.length === 0 ? (
        <EmptyState Icon={Brain} title="No memory here" hint="Add the facts and rules this agent should always keep in mind." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map(m => (
            <article key={m.id} style={{ background: C.cardBg, border: `1px solid ${m.status === 'pending_review' ? C.warnBorder : C.border}`, borderRadius: 12, padding: 14, opacity: m.status === 'archived' ? 0.75 : 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill meta={MEMORY_KIND[m.kind]} fallback={m.kind} />
                <span style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }}>{m.title}</span>
                {m.status === 'pending_review' && <Pill meta={{ label: 'Proposed by the agent', color: C.warnText, bg: C.warnBg }} />}
                {m.status === 'archived' && <Pill meta={{ label: 'Archived', color: C.t3, bg: C.surfaceMuted }} />}
                {m.contact_id && <span style={{ fontSize: T.meta, color: C.textSecondary }}>{m.contact_name || `Lead #${m.contact_id}`}</span>}
                <span style={{ marginLeft: 'auto', fontSize: T.meta, color: C.textMuted }}>{SOURCE_LABEL[m.source] || m.source} · {when(m.updated_at)}</span>
              </div>
              <div style={{ fontSize: T.body, color: C.t2, lineHeight: LH.normal, whiteSpace: 'pre-wrap', marginTop: 8 }}>{m.content}</div>
              {m.expires_at && <div style={{ fontSize: T.meta, color: C.textMuted, marginTop: 6 }}>Forgotten after {when(m.expires_at, { time: false })}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {m.status === 'pending_review' ? (
                  <>
                    <Button variant="primary" icon={CheckCircle2} onClick={() => run(() => api.workflowAgents.approveMemory(agentId, m.id), 'Approved. The agent uses it from the next run.').catch(() => {})}>Approve</Button>
                    <Button icon={Pencil} onClick={() => setModal({ mode: 'review', item: m })}>Edit & approve</Button>
                    <Button variant="danger" icon={XCircle} onClick={() => run(() => api.workflowAgents.rejectMemory(agentId, m.id), 'Rejected.').catch(() => {})}>Reject</Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" icon={Pencil} onClick={() => setModal({ mode: 'edit', item: m })}>Edit</Button>
                    {m.status === 'active'
                      ? <Button variant="ghost" icon={Archive} onClick={() => run(() => api.workflowAgents.updateMemory(agentId, m.id, { status: 'archived' }), 'Archived.').catch(() => {})}>Archive</Button>
                      : <Button variant="ghost" icon={RotateCcw} onClick={() => run(() => api.workflowAgents.updateMemory(agentId, m.id, { status: 'active' }), 'Active again.').catch(() => {})}>Use again</Button>}
                    <Button variant="ghost" icon={Trash2} onClick={() => remove(m)}>Delete</Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {modal && (
        <MemoryModal
          item={modal.item} mode={modal.mode} onClose={() => setModal(null)}
          onSubmit={(body) => {
            if (modal.mode === 'create') return run(() => api.workflowAgents.createMemory(agentId, body), 'Added.');
            if (modal.mode === 'review') return run(() => api.workflowAgents.approveMemory(agentId, modal.item.id, body), 'Approved with your edits.');
            return run(() => api.workflowAgents.updateMemory(agentId, modal.item.id, body), 'Saved.');
          }}
        />
      )}
    </div>
  );
}
