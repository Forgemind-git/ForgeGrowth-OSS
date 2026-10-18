// Runs: every run of this agent with its status, cost and trigger. Opening one
// shows the trace; the run id is in the URL so a link can be shared.

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, History } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T } from '../../../constants.js';
import { Button, EmptyState, Table, Td, inputStyle } from '../../academy/shared.jsx';
import SearchableSelect from '../../../components/SearchableSelect.jsx';
import { useServerEvents } from '../../../hooks/useServerEvents.js';
import { showError } from '../../../lib/feedback.js';
import RunView from '../RunView.jsx';
import { RUN_STATUS, TRIGGER_LABEL, Pill, when, rupees, duration, compact } from '../wfShared.jsx';

const PAGE = 50;

export default function RunsTab({ agentId, runId, isAdmin, navigate }) {
  const [filters, setFilters] = useState({ status: '', trigger: '', from: '', to: '' });
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.workflowAgents.runs(agentId, { ...filters, limit: PAGE, offset: page * PAGE })); } catch (e) { showError(e.message); }
  }, [agentId, filters, page]);
  useEffect(() => { if (!runId) load(); }, [load, runId]);
  useServerEvents(useCallback((ev) => { if (!runId && ev.type === 'workflow-agent-run' && String(ev.data?.agentId) === String(agentId)) load(); }, [agentId, runId, load]));

  if (runId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontFamily: FONT }}>
        <div><Button variant="ghost" icon={ArrowLeft} onClick={() => navigate('workflow-agents', agentId, 'runs')}>All runs</Button></div>
        <RunView key={runId} runId={runId} isAdmin={isAdmin} navigate={navigate} onRerun={(run) => navigate('workflow-agents', agentId, 'runs', run.id)} />
      </div>
    );
  }

  const set = (k, v) => { setPage(0); setFilters(f => ({ ...f, [k]: v })); };
  const total = data?.total || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONT }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={filters.status} onChange={(v) => set('status', v)} options={[{ value: '', label: 'Any status' }, ...Object.entries(RUN_STATUS).map(([value, m]) => ({ value, label: m.label }))]} />
        </div>
        <div style={{ minWidth: 170 }}>
          <SearchableSelect value={filters.trigger} onChange={(v) => set('trigger', v)} options={[{ value: '', label: 'Any trigger' }, ...Object.entries(TRIGGER_LABEL).map(([value, label]) => ({ value, label }))]} />
        </div>
        <input type="date" aria-label="From" value={filters.from} onChange={e => set('from', e.target.value)} style={{ ...inputStyle, width: 160 }} />
        <span style={{ color: C.textMuted }}>to</span>
        <input type="date" aria-label="To" value={filters.to} min={filters.from || undefined} onChange={e => set('to', e.target.value)} style={{ ...inputStyle, width: 160 }} />
      </div>

      {!data ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : (
        <Table
          keyOf={(r) => r.id}
          rows={data.runs}
          empty={<EmptyState Icon={History} title="No runs match" hint="Runs from schedules, events, Run now and tests all appear here." />}
          onRowClick={(r) => navigate('workflow-agents', agentId, 'runs', r.id)}
          columns={[{ label: 'Run' }, { label: 'Started' }, { label: 'Trigger' }, { label: 'Status' }, { label: 'Took', align: 'right' }, { label: 'Tokens', align: 'right' }, { label: 'Tools', align: 'right' }, { label: 'Cost', align: 'right' }]}
          renderRow={(r) => (
            <>
              <Td mono color={C.textMuted}>#{r.id}</Td>
              <Td>{when(r.started_at || r.queued_at)}</Td>
              <Td>{TRIGGER_LABEL[r.trigger_type] || r.trigger_type}{r.pretend_date ? <span style={{ color: C.warnText, fontSize: T.meta }}> · as of {r.pretend_date}</span> : null}</Td>
              <Td><Pill meta={RUN_STATUS[r.status]} fallback={r.status} /></Td>
              <Td mono align="right">{duration(r.duration_ms)}</Td>
              <Td mono align="right">{compact((r.input_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0) + (r.output_tokens || 0))}</Td>
              <Td mono align="right">{r.tool_calls ?? 0}</Td>
              <Td mono align="right">{rupees(r.cost_inr)}</Td>
            </>
          )}
        />
      )}
      {total > PAGE && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', fontSize: T.meta, color: C.textSecondary }}>
          <span style={{ fontFamily: MONO }}>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
          <Button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Newer</Button>
          <Button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)}>Older</Button>
        </div>
      )}
    </div>
  );
}
