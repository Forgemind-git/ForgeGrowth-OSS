// "My leads today": a rep's own ranked leads from the Lead Signal agent, built to be
// used on a phone between calls. Leads are grouped by who owns them NOW (resolved
// by the server), so a lead reassigned after the morning run moves with it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Phone, MessageCircle, CheckCircle2, XCircle, AlertOctagon, BadgeIndianRupee, Send, Bell, ListTodo, Quote, Clock, Sparkles, RefreshCw,
} from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../constants.js';
import { Button, EmptyState, StageBadge } from '../academy/shared.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { useServerEvents } from '../../hooks/useServerEvents.js';
import { showError, showSuccess, showInfo } from '../../lib/feedback.js';
import { LEAD_LABEL, Pill, Notice, CopyButton, when, ago } from './wfShared.jsx';

const OUTCOMES = [
  { key: 'called', label: 'Called', Icon: Phone },
  { key: 'messaged', label: 'Messaged', Icon: MessageCircle },
  { key: 'converted', label: 'Converted', Icon: BadgeIndianRupee },
  { key: 'not_interested', label: 'Not interested', Icon: XCircle },
  { key: 'wrong_signal', label: 'Wrong signal', Icon: AlertOctagon },
];

function LeadCard({ card, agentId, runId, canSendDirectly, navigate, onChanged }) {
  const [feedback, setFeedback] = useState(card.feedback?.outcome || null);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const record = async (outcome) => {
    try {
      await api.workflowAgents.feedback({ agent_id: agentId, run_id: card.run_id, contact_id: card.contact_id, outcome });
      setFeedback(outcome);
    } catch (e) { showError(e.message); }
  };

  const send = async () => {
    const usingTemplate = !card.window_open;
    const ok = await confirm({
      title: `Send to ${card.name}?`,
      body: usingTemplate
        ? `The 24-hour window is closed, so the approved template “${card.suggested_template}” is sent instead of the text.${canSendDirectly ? '' : ' It waits for approval first.'}`
        : canSendDirectly ? 'It goes out on WhatsApp straight away.' : 'It waits for an approver before it goes out.',
      confirmLabel: 'Send',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const out = await api.workflowAgents.sendSuggested({ agent_id: agentId, run_id: card.run_id, contact_id: card.contact_id });
      if (out.status === 'executed') { showSuccess('Sent.'); record('messaged'); } else if (out.status === 'pending') showInfo('Sent for approval. It goes out once an approver says yes.');
      else if (out.status === 'failed') showError(out.result?.error || 'The message could not be sent.');
      onChanged?.();
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  };

  const doneTask = async (task) => {
    try { await api.workflowAgents.updateTask(task.id, 'done'); onChanged?.(); } catch (e) { showError(e.message); }
  };

  const label = LEAD_LABEL[card.label];
  const canSend = card.window_open ? !!card.suggested_message : !!card.suggested_template;

  return (
    <article style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderLeft: `4px solid ${label?.color || C.border}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {confirmEl}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill meta={label} fallback={card.label} />
        {card.score != null && <span style={{ fontFamily: MONO, fontSize: T.body, fontWeight: W.bold, color: C.text }}>{card.score}</span>}
        <span style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.name}</span>
        {card.live_update && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: T.meta, color: C.infoText }}><Sparkles size={13} />Updated {ago(card.updated_at)}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: T.meta, color: C.textSecondary }}>
        <span style={{ fontFamily: MONO }}>{card.phone}</span>
        {card.stage && <StageBadge stage={card.stage} />}
        {card.product && <span>{card.product}</span>}
        {card.best_contact_time && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Clock size={13} />Best: {card.best_contact_time}</span>}
      </div>

      <div style={{ fontSize: T.bodyLg, color: C.t2, lineHeight: LH.normal }}>{card.reason}</div>
      {(card.top_signal || (card.blocker && card.blocker !== 'none')) && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: T.meta }}>
          {card.top_signal && <span style={{ color: C.successText }}>Signal: {card.top_signal}</span>}
          {card.blocker && card.blocker !== 'none' && <span style={{ color: C.warnText }}>Blocker: {card.blocker.replace(/_/g, ' ')}</span>}
        </div>
      )}

      {card.evidence?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {card.evidence.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: C.surfaceInner, border: `1px solid ${C.borderSubtle}`, borderRadius: 10, padding: '8px 10px' }}>
              <Quote size={14} color={C.textMuted} style={{ flexShrink: 0, marginTop: 3 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: T.body, color: C.t2, lineHeight: LH.normal, wordBreak: 'break-word' }}>{e.quote}</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 3, fontSize: T.meta, color: C.textMuted }}>
                  {e.at && <span>{when(e.at)}</span>}
                  {e.chat && <button type="button" onClick={() => navigate('chats', e.chat.wa_number, e.chat.contact_number)} style={{ background: 'none', border: 'none', padding: 0, color: C.primary, cursor: 'pointer', fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium }}>Open chat</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(card.suggested_message || card.suggested_template) && (
        <div style={{ border: `1px dashed ${C.borderStrong}`, borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: T.label, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted }}>Suggested next message</div>
          {card.suggested_message && <div style={{ fontSize: T.body, color: C.text, whiteSpace: 'pre-wrap', lineHeight: LH.normal }}>{card.suggested_message}</div>}
          <div style={{ fontSize: T.meta, color: card.window_open ? C.successText : C.warnText }}>
            {card.window_open
              ? `WhatsApp window open${card.window_expires_at ? ` until ${when(card.window_expires_at)}` : ''}: you can send this text.`
              : card.suggested_template ? `Window closed: only the template “${card.suggested_template}” can be sent.` : 'Window closed and no template is suggested: call, or send a template from the chat.'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {card.suggested_message && <CopyButton text={card.suggested_message} />}
            <Button variant="primary" icon={Send} disabled={busy || !canSend} onClick={send}>{busy ? 'Sending…' : canSendDirectly ? 'Send' : 'Send for approval'}</Button>
            {card.chat && <Button icon={MessageCircle} onClick={() => navigate('chats', card.chat.wa_number, card.chat.contact_number)}>Open chat</Button>}
          </div>
        </div>
      )}

      {card.open_tasks?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {card.open_tasks.map(t => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.body, color: C.t2 }}>
              <ListTodo size={15} color={C.t4} />
              <span style={{ flex: 1, minWidth: 0 }}>{t.title}{t.due_at ? <span style={{ color: C.textMuted, fontSize: T.meta }}> · due {when(t.due_at)}</span> : null}</span>
              <Button variant="ghost" icon={CheckCircle2} onClick={() => doneTask(t)} style={{ padding: '4px 8px', fontSize: T.meta }}>Done</Button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: `1px solid ${C.borderSubtle}`, paddingTop: 10 }}>
        {OUTCOMES.map(o => {
          const on = feedback === o.key;
          return (
            <button key={o.key} type="button" onClick={() => record(o.key)}
              style={{ display: 'inline-flex', gap: 5, alignItems: 'center', padding: '8px 11px', borderRadius: 999, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg, color: on ? C.dangerText : C.t3, cursor: 'pointer', fontFamily: FONT, fontSize: T.meta, fontWeight: W.medium }}>
              <o.Icon size={14} />{o.label}
            </button>
          );
        })}
      </div>
    </article>
  );
}

export default function WorklistPage({ user, navigate }) {
  const isAdmin = user?.role === 'admin';
  const [agentId, setAgentId] = useState('');
  const [repId, setRepId] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reps, setReps] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tasks, setTasks] = useState([]);
  const [notes, setNotes] = useState([]);

  const load = useCallback(async () => {
    try {
      const [w, t, n] = await Promise.all([
        api.workflowAgents.worklist({ agent_id: agentId, rep_id: repId }),
        api.workflowAgents.tasks('open').catch(() => ({ tasks: [] })),
        api.workflowAgents.notifications(false).catch(() => ({ notifications: [] })),
      ]);
      setData(w); setTasks(t.tasks || []); setNotes(n.notifications || []); setError(null);
    } catch (e) { setError(e.message); }
  }, [agentId, repId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (isAdmin) api.workflowAgents.team().then(t => setReps(t.reps.filter(r => r.active))).catch(() => setReps([])); }, [isAdmin]);
  useServerEvents(useCallback((ev) => { if (ev.type === 'workflow-agent-run' || ev.type === 'workflow-agent-actions') load(); }, [load]));

  const cards = data?.cards || [];
  const counts = useMemo(() => cards.reduce((m, c) => ({ ...m, [c.label]: (m[c.label] || 0) + 1 }), {}), [cards]);
  const shown = filter === 'all' ? cards : cards.filter(c => c.label === filter);
  const unread = notes.filter(n => !n.read_at);
  const cardTaskIds = new Set(cards.flatMap(c => (c.open_tasks || []).map(t => t.id)));
  const otherTasks = tasks.filter(t => !cardTaskIds.has(t.id));

  const markAllRead = async () => {
    try { await api.workflowAgents.markNotificationsRead([]); load(); } catch (e) { showError(e.message); }
  };

  return (
    <div className="wf-worklist" style={{ padding: '20px 28px 60px', fontFamily: FONT, width: '100%', boxSizing: 'border-box', minWidth: 0 }}>
      <style>{`@media (max-width: 640px) { .wf-worklist { padding: 12px 12px 48px !important; } }`}</style>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <div style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text }}>My leads today</div>
          <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 2 }}>
            {data?.run ? `From ${data.agent?.name} · ${when(data.run.finished_at)}` : data?.agent ? `${data.agent.name} has not produced a list yet.` : ''}
          </div>
        </div>
        {data?.agents?.length > 1 && (
          <div style={{ minWidth: 200 }}>
            <SearchableSelect value={agentId || data.agent?.id || ''} onChange={setAgentId} options={data.agents.map(a => ({ value: a.id, label: a.name }))} />
          </div>
        )}
        {isAdmin && reps.length > 0 && (
          <div style={{ minWidth: 200 }}>
            <SearchableSelect value={repId} onChange={setRepId} placeholder="My own list"
              options={[{ value: '', label: 'My own list' }, { value: 'unassigned', label: 'Unassigned leads' }, ...reps.map(r => ({ value: r.id, label: r.name }))]} />
          </div>
        )}
        <Button variant="ghost" icon={RefreshCw} onClick={load} aria-label="Refresh" style={{ padding: '8px 10px' }} />
      </div>

      {error && <Notice tone="danger" style={{ marginBottom: 12 }}>{error}</Notice>}

      {unread.length > 0 && (
        <div style={{ background: C.cardBg, border: `1px solid ${C.infoBorder}`, borderRadius: 12, padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <Bell size={16} color={C.infoText} />
            <span style={{ fontSize: T.body, fontWeight: W.bold, color: C.text, flex: 1 }}>{unread.length} new notification{unread.length === 1 ? '' : 's'}</span>
            <Button variant="ghost" onClick={markAllRead} style={{ padding: '4px 8px', fontSize: T.meta }}>Mark all read</Button>
          </div>
          {unread.slice(0, 5).map(n => (
            <div key={n.id} style={{ fontSize: T.body, color: C.t2, padding: '4px 0', lineHeight: LH.normal }}>
              <b>{n.title}</b>{n.body ? ` · ${n.body}` : ''} <span style={{ color: C.textMuted, fontSize: T.meta }}>{ago(n.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {!data && !error ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : data && (
        <>
          {cards.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {[{ key: 'all', label: `All ${cards.length}` }, ...Object.entries(LEAD_LABEL).filter(([k]) => counts[k]).map(([k, m]) => ({ key: k, label: `${m.label} ${counts[k]}` }))].map(f => (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                  style={{ padding: '7px 12px', borderRadius: 999, border: `1.5px solid ${filter === f.key ? C.primary : C.border}`, background: filter === f.key ? C.primaryLight : C.cardBg, color: filter === f.key ? C.dangerText : C.t3, cursor: 'pointer', fontFamily: FONT, fontSize: T.body, fontWeight: W.medium }}>
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {shown.length === 0 ? (
            <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12 }}>
              <EmptyState Icon={Sparkles}
                title={data.note || (data.run ? 'No leads for you in this list' : 'No list yet')}
                hint={data.run ? 'Leads appear here when they are yours right now. Check back after the next run.' : 'The list appears after the agent’s first scheduled run.'} />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 12 }}>
              {shown.map(c => <LeadCard key={c.contact_id} card={c} agentId={data.agent.id} runId={data.run?.id} canSendDirectly={data.can_send_directly} navigate={navigate} onChanged={load} />)}
            </div>
          )}

          {otherTasks.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text, marginBottom: 8 }}>My other follow-ups</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {otherTasks.map(t => (
                  <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
                    <ListTodo size={16} color={C.t4} />
                    <span style={{ flex: 1, minWidth: 180, fontSize: T.body, color: C.t2 }}><b>{t.title}</b> · {t.name} <span style={{ fontFamily: MONO, fontSize: T.meta, color: C.textMuted }}>{t.phone}</span></span>
                    {t.due_at && <span style={{ fontSize: T.meta, color: C.textMuted }}>due {when(t.due_at)}</span>}
                    <Button variant="ghost" icon={CheckCircle2} onClick={async () => { try { await api.workflowAgents.updateTask(t.id, 'done'); load(); } catch (e) { showError(e.message); } }} style={{ padding: '4px 8px', fontSize: T.meta }}>Done</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
