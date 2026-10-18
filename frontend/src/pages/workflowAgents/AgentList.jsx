// The agents list: one card per agent with what it does, when it runs, how its last
// run went, and what it has cost this month. "New agent" starts from a preset or
// from blank.

import { useCallback, useEffect, useState } from 'react';
import { Plus, Settings2, Workflow, Clock, ShieldCheck, Brain, Bot } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { Button, EmptyState, Modal, PageShell, inputStyle } from '../academy/shared.jsx';
import { useServerEvents } from '../../hooks/useServerEvents.js';
import { showError } from '../../lib/feedback.js';
import { AGENT_STATUS, RUN_STATUS, Pill, Notice, Field, agentIcon, rupees, when, ago } from './wfShared.jsx';

function AgentCard({ a, onOpen, navigate }) {
  const Icon = agentIcon(a.icon);
  return (
    <article
      role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, cursor: 'pointer', boxShadow: C.shadowSm, minWidth: 0 }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = C.shadowMd; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = C.shadowSm; }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, background: C.primaryLight, color: C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={20} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text }}>{a.name}</span>
            <Pill meta={AGENT_STATUS[a.status]} fallback={a.status} />
          </div>
          {a.description && <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal, marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.description}</div>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(a.trigger_summary.length ? a.trigger_summary : ['By hand']).map((t, i) => (
          <span key={i} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: T.meta, padding: '3px 9px', borderRadius: 999, background: C.surfaceMuted, color: C.t3 }}><Clock size={12} />{t}</span>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, borderTop: `1px solid ${C.borderSubtle}`, paddingTop: 12 }}>
        <div>
          <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>Last run</div>
          <div style={{ marginTop: 4 }}>{a.last_run ? <><Pill meta={RUN_STATUS[a.last_run.status]} fallback={a.last_run.status} /><div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 3 }}>{ago(a.last_run.at)}</div></> : <span style={{ fontSize: T.body, color: C.textMuted }}>Never</span>}</div>
        </div>
        <div>
          <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>This month</div>
          <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text, fontFamily: MONO, marginTop: 4 }}>{rupees(a.cost_this_month_inr)}</div>
          <div style={{ fontSize: T.meta, color: C.textSecondary }}>{a.runs_this_month} run{a.runs_this_month === 1 ? '' : 's'}{a.monthly_budget_inr ? ` of ${rupees(a.monthly_budget_inr)}` : ''}</div>
        </div>
        <div>
          <div style={{ fontSize: T.label, color: C.textMuted, letterSpacing: '.04em', textTransform: 'uppercase' }}>Next run</div>
          <div style={{ fontSize: T.body, color: a.next_scheduled_run ? C.text : C.textMuted, marginTop: 4 }}>{a.next_scheduled_run ? when(a.next_scheduled_run) : a.status === 'active' ? 'On events only' : 'Off'}</div>
        </div>
      </div>

      {(a.pending_approvals > 0 || a.pending_memory > 0) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {a.pending_approvals > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); navigate('workflow-agents', a.id, 'results'); }}
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.warnBorder}`, background: C.warnBg, color: C.warnText, cursor: 'pointer', fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium }}>
              <ShieldCheck size={14} />{a.pending_approvals} waiting for approval
            </button>
          )}
          {a.pending_memory > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); navigate('workflow-agents', a.id, 'memory'); }}
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.infoBorder}`, background: C.infoBg, color: C.infoText, cursor: 'pointer', fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium }}>
              <Brain size={14} />{a.pending_memory} memory to review
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function AgentList({ user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const [agents, setAgents] = useState(null);
  const [setup, setSetup] = useState(null);

  const load = useCallback(async () => {
    try { setAgents((await api.workflowAgents.list()).agents); } catch (e) { showError(e.message); setAgents([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!isAdmin) return;
    // Two facts that silently change what every agent produces; say them up front.
    Promise.allSettled([api.workflowAgents.settings(), api.workflowAgents.team()]).then(([s, t]) => {
      setSetup({
        noKey: s.value ? !s.value.anthropic_credentials.length && !s.value.anthropic_env_key : false,
        noAssignments: t.value ? !t.value.numbers.some(n => n.current_rep_user_id) : false,
      });
    });
  }, [isAdmin]);
  useServerEvents(useCallback((ev) => { if (ev.type === 'workflow-agent-run' || ev.type === 'workflow-agent-actions') load(); }, [load]));

  return (
    <PageShell
      subtitle="Agents that read your leads, chats, sales and ads on a schedule or when something happens, and propose what to do next. Nothing they propose happens until someone approves it."
      actions={isAdmin && (
        <>
          <Button icon={Settings2} onClick={() => navigate('workflow-agents', 'settings')}>Team & settings</Button>
          <Button variant="primary" icon={Plus} onClick={() => navigate('workflow-agents', 'new')}>New agent</Button>
        </>
      )}
    >
      {setup?.noKey && (
        <Notice tone="danger" style={{ marginBottom: 12 }}>
          No Anthropic API key is set up, so runs will fail.{' '}
          <button type="button" onClick={() => navigate('admin-settings', 'ai-models')} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Add one in Admin Settings → AI Models</button> (provider: Anthropic).
        </Notice>
      )}
      {setup?.noAssignments && (
        <Notice tone="warn" style={{ marginBottom: 12 }}>
          No business number is assigned to a rep yet, so agents that group leads by rep put every lead under “Unassigned”.{' '}
          <button type="button" onClick={() => navigate('workflow-agents', 'settings')} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Set up reps and numbers</button>.
        </Notice>
      )}

      {!agents ? <div style={{ fontSize: T.body, color: C.textMuted, padding: 20 }}>Loading…</div> : agents.length === 0 ? (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14 }}>
          <EmptyState Icon={Workflow} title="No workflow agents yet" hint={isAdmin ? 'Start from a preset like Lead Signal, which lists each rep’s most likely buyers every morning.' : 'An admin can create one.'} />
          {isAdmin && <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 28 }}><Button variant="primary" icon={Plus} onClick={() => navigate('workflow-agents', 'new')}>New agent</Button></div>}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))', gap: 14 }}>
          {agents.map(a => <AgentCard key={a.id} a={a} navigate={navigate} onOpen={() => navigate('workflow-agents', a.id, 'setup')} />)}
        </div>
      )}

    </PageShell>
  );
}
