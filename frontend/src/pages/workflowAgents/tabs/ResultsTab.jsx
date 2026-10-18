// Results & approvals: what this agent found, run by run, and what it proposed that
// still needs a decision. Feedback on a whole run is admin-only; reps rate single
// leads from their worklist.

import { useCallback, useEffect, useState } from 'react';
import { ThumbsUp, ThumbsDown, AlertOctagon, ExternalLink, Inbox } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W } from '../../../constants.js';
import { Button, EmptyState } from '../../academy/shared.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { useServerEvents } from '../../../hooks/useServerEvents.js';
import { showError, showSuccess } from '../../../lib/feedback.js';
import ActionList from '../ActionList.jsx';
import { Panel, Collapsible, MiniMarkdown, RUN_STATUS, TRIGGER_LABEL, Pill, when, rupees } from '../wfShared.jsx';

function Feedback({ run }) {
  const [given, setGiven] = useState(null);
  const rate = async (rating) => {
    try { await api.workflowAgents.feedback({ run_id: run.id, rating }); setGiven(rating); showSuccess('Thanks, feedback recorded.'); } catch (e) { showError(e.message); }
  };
  if (given) return <span style={{ fontSize: T.meta, color: C.successText }}>Feedback recorded.</span>;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: T.meta, color: C.textMuted }}>Was this run useful?</span>
      <Button variant="ghost" icon={ThumbsUp} onClick={() => rate('useful')} style={{ padding: '5px 9px', fontSize: T.meta }}>Useful</Button>
      <Button variant="ghost" icon={ThumbsDown} onClick={() => rate('not_useful')} style={{ padding: '5px 9px', fontSize: T.meta }}>Not useful</Button>
      <Button variant="ghost" icon={AlertOctagon} onClick={() => rate('wrong')} style={{ padding: '5px 9px', fontSize: T.meta }}>Wrong</Button>
    </div>
  );
}

export default function ResultsTab({ agentId, isAdmin, navigate }) {
  const [includeTests, setIncludeTests] = useState(false);
  const [results, setResults] = useState(null);

  const load = useCallback(async () => {
    try { const r = await api.workflowAgents.results(agentId, { include_tests: includeTests ? '1' : '' }); setResults(r.results || []); } catch (e) { showError(e.message); }
  }, [agentId, includeTests]);
  useEffect(() => { load(); }, [load]);
  useServerEvents(useCallback((ev) => { if (ev.type === 'workflow-agent-run' && String(ev.data?.agentId) === String(agentId)) load(); }, [agentId, load]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: FONT }}>
      <Panel title="Waiting for a decision" hint="Nothing this agent proposes happens until someone approves it.">
        <ActionList agentId={agentId} navigate={navigate} showAgent={false} />
      </Panel>

      <Panel title="Results" right={<label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: T.meta, color: C.textSecondary }}><Toggle checked={includeTests} onChange={setIncludeTests} />Show test runs</label>}>
        {!results ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : results.length === 0 ? (
          <EmptyState Icon={Inbox} title="No results yet" hint="When a run finishes, what it found appears here." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {results.map((r, i) => (
              <Collapsible key={r.id} defaultOpen={i === 0}
                title={(
                  <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: W.bold }}>{when(r.finished_at)}</span>
                    <span style={{ fontWeight: W.normal, color: C.textSecondary }}>{TRIGGER_LABEL[r.trigger_type] || r.trigger_type}</span>
                    <Pill meta={RUN_STATUS[r.status]} fallback={r.status} />
                    {r.pending_actions > 0 && <Pill meta={{ label: `${r.pending_actions} waiting`, color: C.warnText, bg: C.warnBg }} />}
                  </span>
                )}
                right={<span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>{rupees(r.cost_inr)}</span>}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <MiniMarkdown text={r.output_markdown || ''} />
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${C.borderSubtle}`, paddingTop: 10 }}>
                    {isAdmin && !r.dry_run ? <Feedback run={r} /> : <span />}
                    <Button variant="ghost" icon={ExternalLink} onClick={() => navigate('workflow-agents', agentId, 'runs', r.id)} style={{ padding: '5px 9px', fontSize: T.meta }}>Open run</Button>
                  </div>
                </div>
              </Collapsible>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
