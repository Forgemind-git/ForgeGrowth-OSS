// Chats → Follow-ups — configure timed follow-up sequences for leads.
//
// A sequence = ordered steps, each "wait N (minutes/hours/days), then send".
// Leads auto-enroll when they ENTER the sequence's trigger funnel stage
// (observed server-side via the lead_events cursor — activating a sequence
// never enrolls anyone retroactively), and can be enrolled manually. A step is
// either an approved TEMPLATE (always deliverable; sent from the template's
// own WhatsApp number) or free TEXT (sent on the lead's existing thread, only
// while the 24h window is open — otherwise skipped and logged).
//
// Detail is a routed sub-part (#/follow-up-sequence/<id>) so refresh keeps the
// view and the nav item stays highlighted — same pattern as the Sales Log.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ListChecks, Plus, ArrowLeft, Trash2, Pencil, ChevronUp, ChevronDown,
  Search, UserPlus, MessageSquareText, LayoutTemplate, StopCircle, Clock,
  FolderKanban,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showSuccess, showError } from '../lib/feedback.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import SortControl from '../components/SortControl.jsx';
import { sortList, DEFAULT_SORT } from '../lib/listSort.js';
import Toggle from '../components/Toggle.jsx';
import MaskedNumber from '../components/MaskedNumber.jsx';
import { useFunnelConfig } from '../hooks/useFunnelConfig.js';
import { useFieldRegistry } from '../hooks/useFieldRegistry.js';
import {
  PageShell, Button, Badge, Table, Td, StageBadge, Segmented, EmptyState,
  Field, inputStyle, Modal, fmtDate,
} from './academy/shared.jsx';
import { Shimmer } from '../components/charts.jsx';

// ── Small helpers ────────────────────────────────────────────────────────────

const fmtDelay = (mins) => {
  const m = Number(mins) || 0;
  if (m % 1440 === 0 && m > 0) { const d = m / 1440; return `${d} day${d === 1 ? '' : 's'}`; }
  if (m % 60 === 0 && m > 0) { const h = m / 60; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${m} min`;
};

const fmtDateTime = (ts) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch { return '—'; }
};

// Human sentences for engine reason codes — every skip carries its why.
const REASONS = {
  lead_replied: 'Lead replied',
  left_enrollment_stage: 'Stage changed',
  manual: 'Stopped manually',
  outside_24h_window: 'Outside the 24h window',
  no_thread: 'No chat thread yet',
  no_whatsapp_number: 'No WhatsApp number',
  empty_message: 'Empty message',
  template_missing: 'Template was deleted',
  template_not_approved: 'Template not approved',
  template_has_no_account: 'Template has no WhatsApp account',
  media_header_not_supported: 'Media-header template not supported',
  carousel_not_supported: 'Carousel template not supported',
  gave_up_after_3_attempts: 'Gave up after 3 failed attempts',
  lead_missing: 'Lead no longer exists',
  ended_after_failed_step: 'Ended after a failed step',
};
const reasonText = (r) => REASONS[r]
  || (r ? String(r).replace(/^account_blocked: /, 'Account blocked: ').replace(/^no_account: /, 'No account: ') : '');

const ENROLL_STATUS_META = {
  active: { label: 'In progress', color: '#1D4ED8', bg: '#E8EFFF' },
  completed: { label: 'Completed', color: '#0F6E56', bg: '#E3F5EF' },
  replied: { label: 'Replied', color: '#0F6E56', bg: '#E3F5EF' },
  stage_changed: { label: 'Stage changed', color: '#6B7280', bg: '#F1F1EE' },
  stopped: { label: 'Stopped', color: '#6B7280', bg: '#F1F1EE' },
};
const LOG_STATUS_META = {
  sent: { label: 'Sent', color: '#0F6E56', bg: '#E3F5EF' },
  skipped: { label: 'Skipped', color: '#7A5500', bg: '#FFF8E1' },
  failed: { label: 'Failed', color: '#A32D2D', bg: '#FCEBEB' },
  stopped: { label: 'Stopped', color: '#6B7280', bg: '#F1F1EE' },
};
const StatusPill = ({ meta }) => (meta ? <Badge label={meta.label} color={meta.color} bg={meta.bg} /> : null);

// Max {{n}} index in a template body → how many variable inputs to render.
const templateVarCount = (body) => {
  let max = 0;
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body || ''))) max = Math.max(max, parseInt(m[1], 10));
  return max;
};

// Templates the engine can actually send: approved, not carousel, no media
// header, no {{n}} in a TEXT header, and no button that needs a send-time
// value (dynamic URL like payment/form templates, COPY_CODE) — the engine
// builds ONLY body parameters, so any other variable slot fails at Meta.
const HAS_VAR = /\{\{\s*\d+\s*\}\}/;
const usableTemplate = (t) => {
  if (String(t.status || '').toUpperCase() !== 'APPROVED') return false;
  if (String(t.template_type || '').toUpperCase() === 'CAROUSEL') return false;
  const ht = String(t.header_type || '').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht)) return false;
  if (ht === 'TEXT' && HAS_VAR.test(t.header_text || '')) return false;
  const buttons = Array.isArray(t.buttons) ? t.buttons : [];
  return !buttons.some(b => {
    const type = String(b?.type || '').toUpperCase();
    return type === 'COPY_CODE' || (type === 'URL' && HAS_VAR.test(String(b?.value || '')));
  });
};

// ── Root: list ⇄ detail by sub-part ─────────────────────────────────────────

export default function FollowUpSequencePage({ user, navigate, subParts = [] }) {
  const sub = subParts[0];
  if (sub && /^\d+$/.test(sub)) {
    return <SequenceDetail id={sub} navigate={navigate} user={user} />;
  }
  return <SequenceList navigate={navigate} user={user} />;
}

// ── List view ────────────────────────────────────────────────────────────────

const SEQ_FIELDS = { created: s => s.createdAt, updated: s => s.updatedAt, name: s => s.name };

function SequenceList({ navigate, user }) {
  const [sequences, setSequences] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const isAdmin = user?.role === 'admin';

  const sortedSequences = useMemo(
    () => (sequences ? sortList(sequences, sort, SEQ_FIELDS) : sequences),
    [sequences, sort]
  );

  const load = useCallback(async () => {
    try {
      const { sequences } = await api.followUps.list();
      setSequences(sequences);
    } catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (seq, next) => {
    try {
      await api.followUps.update(seq.id, { active: next });
      setSequences(list => list.map(s => (s.id === seq.id ? { ...s, active: next } : s)));
      showSuccess(next
        ? `"${seq.name}" is live — leads entering its stage will now be followed up.`
        : `"${seq.name}" paused. Nobody new enrolls and due steps hold until it is switched back on.`);
    } catch (e) { showError(e.message); }
  };

  return (
    <PageShell
      title="Follow-ups"
      subtitle="Automatic follow-up sequences for leads — enroll on funnel-stage entry or by hand, send templates or texts on a schedule, stop the moment they reply."
      actions={<>
        {/* Sorting is a reading aid, so it is not admin-gated the way creating is. */}
        <SortControl value={sort} onChange={setSort} />
        {isAdmin && <Button variant="primary" icon={Plus} onClick={() => setShowNew(true)}>New Sequence</Button>}
      </>}
    >
      {loading ? <Shimmer height={280} radius={12} /> : (
        <Table
          columns={[
            { label: 'Sequence' }, { label: 'Enrolls on' }, { label: 'Project' }, { label: 'Steps', align: 'center' },
            { label: 'In progress', align: 'center' }, { label: 'Finished', align: 'center' },
            { label: 'Messages sent', align: 'center' }, { label: 'Active' }, { label: 'Created' },
          ]}
          rows={sortedSequences} keyOf={s => s.id}
          onRowClick={(s) => navigate && navigate('follow-up-sequence', String(s.id))}
          empty={<EmptyState Icon={ListChecks} title="No follow-up sequences yet"
            hint="Create one, add timed steps, then switch it on — leads entering the chosen funnel stage are followed up automatically." />}
          renderRow={(s) => (
            <>
              <Td bold>
                {s.name}
                {s.description && <div style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 400, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>}
              </Td>
              <Td>{s.triggerStageKey
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Entering <StageBadge stage={s.triggerStageKey} /></span>
                : <span style={{ color: C.textMuted }}>Manual only</span>}</Td>
              <Td>{s.projectName
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.textSecondary }}>
                    <FolderKanban size={13} color={C.primary} /> {s.projectName}
                  </span>
                : <span style={{ color: C.textMuted }}>—</span>}</Td>
              <Td align="center" mono>{s.stepCount}</Td>
              <Td align="center" mono color={s.activeCount > 0 ? '#1D4ED8' : C.textMuted}>{s.activeCount}</Td>
              <Td align="center" mono color={C.textSecondary}>{s.finishedCount}</Td>
              <Td align="center" mono color={s.sentCount > 0 ? C.green : C.textMuted}>{s.sentCount}</Td>
              <Td>
                <div onClick={e => e.stopPropagation()}>
                  <Toggle checked={s.active} disabled={!isAdmin} onChange={(next) => toggleActive(s, next)} />
                </div>
              </Td>
              <Td color={C.textSecondary}>{fmtDate(s.createdAt)}</Td>
            </>
          )}
        />
      )}

      {showNew && (
        <SequenceModal
          onClose={() => setShowNew(false)}
          onSaved={(created) => { setShowNew(false); navigate && navigate('follow-up-sequence', String(created.id)); }}
        />
      )}
    </PageShell>
  );
}

// ── Create / edit sequence settings modal ────────────────────────────────────

function SequenceModal({ sequence, onClose, onSaved }) {
  const { stages } = useFunnelConfig();
  const [name, setName] = useState(sequence?.name || '');
  const [description, setDescription] = useState(sequence?.description || '');
  const [stageKey, setStageKey] = useState(sequence?.triggerStageKey || '');
  const [projectId, setProjectId] = useState(sequence?.projectId ? String(sequence.projectId) : '');
  const [projects, setProjects] = useState([]);
  const [stopOnReply, setStopOnReply] = useState(sequence ? sequence.stopOnReply : true);
  const [stopOnStageChange, setStopOnStageChange] = useState(sequence ? sequence.stopOnStageChange : true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.projects.list().then(({ projects }) => setProjects((projects || []).filter(p => !p.archived)))
      .catch(() => setProjects([]));
  }, []);

  const save = async () => {
    if (!name.trim()) return showError('Give the sequence a name.');
    setSaving(true);
    try {
      const body = {
        name: name.trim(), description: description.trim() || null,
        triggerStageKey: stageKey || null, stopOnReply, stopOnStageChange,
        projectId: projectId ? Number(projectId) : null,
      };
      const saved = sequence
        ? await api.followUps.update(sequence.id, body)
        : await api.followUps.create(body);
      onSaved(saved);
    } catch (e) { showError(e.message); setSaving(false); }
  };

  const toggleRow = (label, hint, val, set) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: `1px solid ${C.border}` }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, fontFamily: FONT }}>{label}</div>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, fontFamily: FONT }}>{hint}</div>
      </div>
      <Toggle checked={val} onChange={set} />
    </div>
  );

  return (
    <Modal title={sequence ? 'Sequence settings' : 'New follow-up sequence'} onClose={onClose} width={520}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (sequence ? 'Save' : 'Create sequence')}</Button>
      </>}>
      <Field label="Name">
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. New lead warm-up" />
      </Field>
      <Field label="Description (optional)">
        <input style={inputStyle} value={description} onChange={e => setDescription(e.target.value)} placeholder="What this sequence is for" />
      </Field>
      <Field label="Auto-enroll leads entering stage"
        hint="Only leads that ENTER the stage while the sequence is live — never retroactively. Pick Manual only to enroll by hand.">
        <SearchableSelect value={stageKey} onChange={setStageKey}
          options={[{ value: '', label: 'Manual only' }, ...stages.map(s => ({ value: s.stageKey, label: s.label }))]}
          placeholder="Manual only" />
      </Field>
      <Field label="Project (optional)" hint="File this sequence in a campaign's project, next to its templates, automations and agents.">
        <SearchableSelect value={projectId} onChange={setProjectId}
          options={[{ value: '', label: 'No project' }, ...projects.map(pr => ({ value: String(pr.id), label: pr.name }))]}
          placeholder="No project" />
      </Field>
      {toggleRow('Stop when the lead replies',
        'Any inbound message from the lead ends their run — the follow-up did its job.', stopOnReply, setStopOnReply)}
      {toggleRow('Stop when the lead changes stage',
        'Leaving the stage they were enrolled in ends their run.', stopOnStageChange, setStopOnStageChange)}
      {!sequence && (
        <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, marginTop: 10 }}>
          The sequence starts <b>paused</b> — add steps, then switch it on from the list or its page.
        </div>
      )}
    </Modal>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────

function SequenceDetail({ id, navigate, user }) {
  const [seq, setSeq] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [enrollTab, setEnrollTab] = useState('active');
  const [enrollments, setEnrollments] = useState(null);
  const [log, setLog] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [stepModal, setStepModal] = useState(null); // null | { step? } — {} = new
  const [showEnroll, setShowEnroll] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      setSeq(await api.followUps.get(id));
    } catch (e) {
      if (e.status === 404) setNotFound(true); else showError(e.message);
    }
  }, [id]);
  const loadEnrollments = useCallback(async () => {
    try {
      const { enrollments } = await api.followUps.enrollments(id, enrollTab);
      setEnrollments(enrollments);
    } catch (e) { showError(e.message); }
  }, [id, enrollTab]);
  const loadLog = useCallback(async () => {
    try {
      const { log } = await api.followUps.log(id);
      setLog(log);
    } catch { /* the Activity card shows its own empty state */ }
  }, [id]);

  useEffect(() => { load(); loadLog(); }, [load, loadLog]);
  useEffect(() => { loadEnrollments(); }, [loadEnrollments]);
  useEffect(() => {
    api.templates.list().then(rows => setTemplates(rows || [])).catch(() => setTemplates([]));
  }, []);

  const templateName = (tid) => {
    if (tid == null) return 'deleted template';
    const t = templates.find(x => Number(x.id) === Number(tid));
    return t ? t.name : `template #${tid}`;
  };

  const back = () => navigate && navigate('follow-up-sequence');

  if (notFound) {
    return (
      <PageShell title="Follow-ups">
        <Button variant="ghost" icon={ArrowLeft} onClick={back}>All sequences</Button>
        <EmptyState Icon={ListChecks} title="Sequence not found" hint="It may have been deleted." />
      </PageShell>
    );
  }
  if (!seq) return <PageShell title="Follow-ups"><Shimmer height={320} radius={12} /></PageShell>;

  const toggleActive = async (next) => {
    try {
      const saved = await api.followUps.update(seq.id, { active: next });
      setSeq(s => ({ ...s, active: saved.active }));
      showSuccess(next ? 'Sequence is live.' : 'Sequence paused — due steps hold until it is switched back on.');
    } catch (e) { showError(e.message); }
  };

  const removeSequence = async () => {
    const ok = await confirm({
      title: `Delete "${seq.name}"?`,
      body: 'Steps, enrollment history and the activity log go with it. Live enrollments must be stopped first.',
      confirmLabel: 'Delete sequence', danger: true,
    });
    if (!ok) return;
    try { await api.followUps.delete(seq.id); back(); }
    catch (e) { showError(e.message); }
  };

  const moveStep = async (idx, dir) => {
    const ids = seq.steps.map(s => s.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    try { await api.followUps.reorderSteps(seq.id, ids); load(); }
    catch (e) { showError(e.message); }
  };

  const deleteStep = async (step, idx) => {
    const ok = await confirm({
      title: `Remove step ${idx + 1}?`,
      body: 'This step will no longer be sent. (While leads are mid-sequence the server refuses step changes — stop them first.)',
      confirmLabel: 'Remove step', danger: true,
    });
    if (!ok) return;
    try { await api.followUps.deleteStep(step.id); load(); }
    catch (e) { showError(e.message); }
  };

  const stopEnrollment = async (en) => {
    const ok = await confirm({
      title: `Stop following up ${en.leadName || 'this lead'}?`,
      body: 'No further steps will be sent to this lead from this sequence.',
      confirmLabel: 'Stop follow-ups', danger: true,
    });
    if (!ok) return;
    try { await api.followUps.stopEnrollment(en.id); loadEnrollments(); load(); }
    catch (e) { showError(e.message); }
  };

  const card = (title, right, children) => (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: C.textSecondary, fontFamily: FONT }}>{title}</div>
        <div style={{ display: 'flex', gap: 8 }}>{right}</div>
      </div>
      {children}
    </div>
  );

  return (
    <PageShell
      title={seq.name}
      subtitle={seq.description || 'Follow-up sequence'}
      actions={<>
        <Button variant="ghost" icon={ArrowLeft} onClick={back}>All sequences</Button>
        {isAdmin && <Button variant="secondary" icon={Pencil} onClick={() => setShowSettings(true)}>Settings</Button>}
        {isAdmin && <Button variant="danger" icon={Trash2} onClick={removeSequence}>Delete</Button>}
      </>}
    >
      {confirmEl}

      {/* Status strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', padding: '12px 16px', marginBottom: 16, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Toggle checked={seq.active} disabled={!isAdmin} onChange={toggleActive} />
          <span style={{ fontSize: 13.5, fontWeight: 700, color: seq.active ? C.green : C.textSecondary }}>
            {seq.active ? 'Live' : 'Paused'}
          </span>
        </div>
        <span style={{ fontSize: 13, color: C.textSecondary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {seq.triggerStageKey
            ? <>Auto-enrolls leads entering <StageBadge stage={seq.triggerStageKey} /></>
            : 'Manual enrollment only'}
        </span>
        {seq.projectName && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: C.textSecondary, fontFamily: FONT }}>
            <FolderKanban size={13} color={C.primary} /> {seq.projectName}
          </span>
        )}
        <span style={{ fontSize: 12.5, color: C.textMuted, fontFamily: MONO }}>
          {seq.activeCount} in progress · {seq.finishedCount} finished · {seq.sentCount} sent
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div>
          {card('Steps', isAdmin && <Button variant="secondary" icon={Plus} onClick={() => setStepModal({})}>Add step</Button>, (
            !seq.steps.length ? (
              <EmptyState Icon={Clock} title="No steps yet" hint="Add the first step — the sequence cannot go live without one." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {seq.steps.map((st, i) => (
                  <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 10 }}>
                    <span style={{ width: 24, height: 24, borderRadius: 999, background: '#F1F1EE', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.textSecondary, flexShrink: 0 }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0, fontFamily: FONT }}>
                      <div style={{ fontSize: 13, color: C.textSecondary }}>
                        Wait <b style={{ color: C.text }}>{fmtDelay(st.delayMinutes)}</b>{i === 0 ? ' after enrollment' : ' after the previous step'}, then send
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 13.5, fontWeight: 600, color: C.text, overflow: 'hidden' }}>
                        {st.messageKind === 'template'
                          ? <><LayoutTemplate size={14} color={C.purple} style={{ flexShrink: 0 }} /> <span style={{ fontFamily: MONO, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{templateName(st.templateId)}</span></>
                          : <><MessageSquareText size={14} color={C.green} style={{ flexShrink: 0 }} /> <span style={{ fontWeight: 400, fontSize: 12.5, color: C.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.body}</span></>}
                      </div>
                    </div>
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <IconBtn title="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}><ChevronUp size={14} /></IconBtn>
                        <IconBtn title="Move down" disabled={i === seq.steps.length - 1} onClick={() => moveStep(i, 1)}><ChevronDown size={14} /></IconBtn>
                        <IconBtn title="Edit" onClick={() => setStepModal({ step: st })}><Pencil size={13} /></IconBtn>
                        <IconBtn title="Remove" danger onClick={() => deleteStep(st, i)}><Trash2 size={13} /></IconBtn>
                      </div>
                    )}
                  </div>
                ))}
                <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT, marginTop: 2 }}>
                  Text steps go out on the lead's chat thread only while the 24-hour window is open — otherwise the step is skipped (and logged) and the next one stays on schedule. Templates always deliver, from the WhatsApp number they were approved on. After 3 unanswered follow-ups (Funnel setting) a lead is moved to Cold/Lost automatically.
                </div>
              </div>
            )
          ))}

          {card('Activity', null, (
            !log ? <Shimmer height={80} radius={8} /> : !log.length ? (
              <EmptyState Icon={ListChecks} title="Nothing yet" hint="Every sent, skipped and stopped step will appear here with its reason." />
            ) : (
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {log.map(row => (
                  <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px', borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>
                    <StatusPill meta={LOG_STATUS_META[row.status]} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{row.leadName || `lead #${row.leadId}`}</span>
                      {row.stepOrder != null && <span style={{ fontSize: 11.5, color: C.textMuted }}> · step {row.stepOrder + 1}</span>}
                      {row.reason && <span style={{ fontSize: 11.5, color: C.textMuted }}> · {reasonText(row.reason)}</span>}
                    </div>
                    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, flexShrink: 0 }}>{fmtDateTime(row.ts)}</span>
                  </div>
                ))}
              </div>
            )
          ))}
        </div>

        <div>
          {card('Leads in this sequence', isAdmin && (
            <Button variant="secondary" icon={UserPlus} onClick={() => setShowEnroll(true)}>Enroll leads</Button>
          ), (
            <>
              <div style={{ marginBottom: 10 }}>
                <Segmented value={enrollTab} onChange={setEnrollTab}
                  options={[{ value: 'active', label: 'In progress' }, { value: 'finished', label: 'Finished' }]} />
              </div>
              {!enrollments ? <Shimmer height={120} radius={8} /> : !enrollments.length ? (
                <EmptyState Icon={UserPlus} title={enrollTab === 'active' ? 'Nobody in progress' : 'Nothing finished yet'}
                  hint={enrollTab === 'active'
                    ? (seq.triggerStageKey ? 'Leads enroll when they enter the trigger stage while the sequence is live — or enroll some by hand.' : 'Enroll leads by hand to start following up.')
                    : 'Completed, replied and stopped runs land here.'} />
              ) : (
                <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                  {enrollments.map(en => (
                    <div key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderBottom: `1px solid ${C.border}`, fontFamily: FONT }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {en.leadName || 'Unnamed'} <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted, fontWeight: 400 }}><MaskedNumber number={en.leadNumber} /></span>
                        </div>
                        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                          {en.status === 'active'
                            ? <>Step {en.nextStepOrder + 1} · next {fmtDateTime(en.nextSendAt)}</>
                            : <>{en.stopReason ? reasonText(en.stopReason) : ''} · {fmtDateTime(en.finishedAt)}</>}
                        </div>
                      </div>
                      <StatusPill meta={ENROLL_STATUS_META[en.status]} />
                      {en.status === 'active' && isAdmin && (
                        <IconBtn title="Stop following up this lead" danger onClick={() => stopEnrollment(en)}>
                          <StopCircle size={14} />
                        </IconBtn>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ))}
        </div>
      </div>

      {showSettings && (
        <SequenceModal sequence={seq} onClose={() => setShowSettings(false)}
          onSaved={(saved) => { setShowSettings(false); setSeq(s => ({ ...s, ...saved })); }} />
      )}
      {stepModal && (
        <StepModal sequenceId={seq.id} step={stepModal.step} templates={templates}
          onClose={() => setStepModal(null)}
          onSaved={() => { setStepModal(null); load(); }} />
      )}
      {showEnroll && (
        <EnrollModal sequence={seq} onClose={() => setShowEnroll(false)}
          onEnrolled={(r) => {
            setShowEnroll(false);
            showSuccess(`Enrolled ${r.enrolled} lead${r.enrolled === 1 ? '' : 's'}${r.skipped ? ` — ${r.skipped} already in this sequence` : ''}.`);
            loadEnrollments(); load();
          }} />
      )}
    </PageShell>
  );
}

function IconBtn({ title, onClick, disabled, danger, children }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '4px 7px',
        cursor: disabled ? 'not-allowed' : 'pointer', color: danger ? C.primary : C.textSecondary,
        display: 'inline-flex', opacity: disabled ? 0.4 : 1 }}>
      {children}
    </button>
  );
}

// ── Step modal ───────────────────────────────────────────────────────────────

// The quick per-lead variables (the engine's legacy aliases). Chips insert the
// token at the cursor — no need to type {{...}} by hand.
const STEP_VARS = [
  { token: 'name', label: 'Name' },
  { token: 'first_name', label: 'First name' },
  { token: 'phone', label: 'Phone' },
  { token: 'email', label: 'Email' },
  { token: 'source', label: 'Source' },
  { token: 'stage', label: 'Stage' },
];

// System lead fields whose token is a short legacy alias rather than lead.<key>
// (the alias is what the engine has always filled — keep inserting it).
const LEAD_ALIAS = { name: 'name', whatsapp_number: 'phone', email: 'email', source: 'source', stage: 'stage' };

const chipStyle = {
  padding: '3px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: C.cardBg,
  cursor: 'pointer', fontSize: 11.5, fontWeight: 600, fontFamily: FONT, color: C.purple,
};

// Insert-variable bar: the six quick chips + an "All variables" picker grouped
// by TABLE — Leads (registry fields incl. custom), Sales Log (payment tokens +
// transaction fields, read from the lead's latest installment), and one group
// per Form (resolved from the lead's latest submission to that form). Save-time
// validation on the backend rejects any token this picker would not produce.
function VarChips({ onInsert }) {
  const { lead: leadFields, transactionCustom, saleTokens } = useFieldRegistry();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [forms, setForms] = useState(null); // null = not loaded yet

  useEffect(() => {
    if (!open || forms != null) return;
    api.leadForms.list()
      .then(r => setForms(r.forms || []))
      .catch(() => setForms([]));
  }, [open, forms]);

  const groups = [
    {
      title: 'Leads',
      items: [
        { token: 'first_name', label: 'First name' },
        ...leadFields.map(f => ({
          token: f.isSystem && LEAD_ALIAS[f.fieldKey] ? LEAD_ALIAS[f.fieldKey] : `lead.${f.fieldKey}`,
          label: f.label,
        })),
      ],
    },
    {
      title: 'Sales Log',
      items: [
        ...saleTokens.map(t => ({ token: `sale.${t.key}`, label: t.label })),
        // A custom key colliding with a computed token would shadow-lose (the
        // backend now reserves those keys, but pre-existing rows stay safe).
        ...transactionCustom
          .filter(f => !saleTokens.some(t => t.key === f.fieldKey))
          .map(f => ({ token: `sale.${f.fieldKey}`, label: `${f.label} (last transaction)` })),
      ],
    },
    ...(forms || [])
      .filter(fm => Array.isArray(fm.fields) && fm.fields.length)
      .map(fm => ({
        title: `Form: ${fm.name}`,
        hint: 'From the lead’s latest submission',
        items: fm.fields
          // Only token-safe keys — a key with a space would mint a chip whose
          // token neither validates nor resolves (backend now enforces this
          // charset at save; this guards forms created before that).
          .filter(ff => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(String(ff.key || '')))
          .map(ff => ({ token: `form.${fm.slug}.${ff.key}`, label: ff.label || ff.key })),
      })),
  ];

  const q = search.trim().toLowerCase();
  const filtered = groups
    .map(g => ({ ...g, items: q ? g.items.filter(it => it.label.toLowerCase().includes(q) || it.token.toLowerCase().includes(q)) : g.items }))
    .filter(g => g.items.length);

  const pick = (token) => { onInsert(token); setOpen(false); setSearch(''); };

  return (
    <div style={{ margin: '2px 0 14px' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
          Insert variable
        </span>
        {STEP_VARS.map(v => (
          <button key={v.token} type="button" title={`Inserts {{${v.token}}} — filled per lead at send time`}
            onClick={() => pick(v.token)} style={chipStyle}>
            {v.label}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(o => !o)}
          title="Every variable, grouped by table: Leads, Sales Log, and each Form"
          style={{ ...chipStyle, color: C.text, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          All variables {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 10, background: C.cardBg, overflow: 'hidden' }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} color={C.textMuted} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)' }} />
              <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search fields…"
                style={{ width: '100%', padding: '7px 9px 7px 28px', borderRadius: 7, border: `1px solid ${C.border}`, fontFamily: FONT, fontSize: 12.5, outline: 'none', background: C.pageBg, color: C.text, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ maxHeight: 230, overflowY: 'auto', padding: '6px 8px 10px' }}>
            {forms == null && <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, padding: '6px 4px' }}>Loading forms…</div>}
            {filtered.map(g => (
              <div key={g.title} style={{ marginTop: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT, padding: '4px 4px 5px' }}>
                  {g.title}{g.hint && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>· {g.hint}</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {g.items.map(it => (
                    <button key={it.token} type="button" title={`Inserts {{${it.token}}}`}
                      onClick={() => pick(it.token)} style={chipStyle}>
                      {it.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!filtered.length && forms != null && (
              <div style={{ fontSize: 12, color: C.textMuted, fontFamily: FONT, padding: '6px 4px' }}>No fields match.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Insert {{token}} at the cursor of the given element, keeping focus there.
function insertTokenAt(el, current, apply, token) {
  const tok = `{{${token}}}`;
  const v = current || '';
  const start = el?.selectionStart ?? v.length;
  const end = el?.selectionEnd ?? start;
  apply(v.slice(0, start) + tok + v.slice(end));
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    const pos = start + tok.length;
    try { el.setSelectionRange(pos, pos); } catch { /* not all inputs support it */ }
  });
}

const UNIT_OPTIONS = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];
const toMinutes = (value, unit) => Math.round(Number(value) * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1));
const fromMinutes = (mins) => {
  const m = Number(mins) || 0;
  if (m >= 1440 && m % 1440 === 0) return { value: m / 1440, unit: 'days' };
  if (m >= 60 && m % 60 === 0) return { value: m / 60, unit: 'hours' };
  return { value: m, unit: 'minutes' };
};

function StepModal({ sequenceId, step, templates, onClose, onSaved }) {
  const initial = step ? fromMinutes(step.delayMinutes) : { value: 1, unit: 'days' };
  const [value, setValue] = useState(String(initial.value));
  const [unit, setUnit] = useState(initial.unit);
  const [kind, setKind] = useState(step?.messageKind || 'template');
  const [templateId, setTemplateId] = useState(step?.templateId ? String(step.templateId) : '');
  const [variables, setVariables] = useState(step?.templateVariables || []);
  const [body, setBody] = useState(step?.body || '');
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef(null);
  const varRefs = useRef([]);
  const [focusedVar, setFocusedVar] = useState(0); // which variable input the chips insert into

  const usable = templates.filter(usableTemplate);
  const selected = templates.find(t => String(t.id) === String(templateId));
  const varCount = selected ? templateVarCount(selected.body) : 0;

  const save = async () => {
    const mins = toMinutes(value, unit);
    if (!Number.isFinite(mins) || mins < 1) return showError('The wait must be at least 1 minute.');
    setSaving(true);
    try {
      const payload = {
        delayMinutes: mins, messageKind: kind,
        templateId: kind === 'template' ? Number(templateId) || null : null,
        // If the templates list has not loaded, `selected` is undefined and
        // varCount reads 0 — keep the stored variables instead of wiping them.
        templateVariables: kind !== 'template' ? []
          : selected ? Array.from({ length: varCount }, (_, i) => variables[i] || '')
          : variables,
        body: kind === 'text' ? body : null,
      };
      if (step) await api.followUps.updateStep(step.id, payload);
      else await api.followUps.addStep(sequenceId, payload);
      onSaved();
    } catch (e) { showError(e.message); setSaving(false); }
  };

  return (
    <Modal title={step ? 'Edit step' : 'Add step'} onClose={onClose} width={520}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save step'}</Button>
      </>}>
      <Field label="Wait before sending" hint="Counted from enrollment for the first step, from the previous step otherwise.">
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="number" min={1} value={value} onChange={e => setValue(e.target.value)}
            style={{ ...inputStyle, width: 110 }} />
          <div style={{ width: 140 }}>
            <SearchableSelect value={unit} onChange={setUnit} options={UNIT_OPTIONS} />
          </div>
        </div>
      </Field>

      <Field label="Message">
        <Segmented value={kind} onChange={setKind}
          options={[{ value: 'template', label: 'Template' }, { value: 'text', label: 'Free text' }]} />
      </Field>

      {kind === 'template' ? (
        <>
          <Field label="Template"
            hint="Approved, text-only templates. Sent from the WhatsApp number the template was approved on — always delivers, no 24h window needed.">
            <SearchableSelect
              value={templateId}
              onChange={(v) => { setTemplateId(v); setVariables([]); }}
              options={usable.map(t => ({
                value: String(t.id),
                label: `${t.name} (${t.category || 'UTILITY'})`,
                sublabel: [t.whatsappAccountName || t.whatsappAccountPhone, t.language].filter(Boolean).join(' · '),
              }))}
              placeholder="Pick a template…" searchPlaceholder="Search templates…"
              emptyText="No approved text-only templates" />
          </Field>
          {selected && (
            <div style={{ padding: '10px 12px', background: C.pageBg, borderRadius: 8, fontSize: 12.5, color: C.textSecondary, fontFamily: FONT, whiteSpace: 'pre-wrap', marginBottom: 12 }}>
              {selected.body}
            </div>
          )}
          {varCount > 0 && Array.from({ length: varCount }, (_, i) => (
            <Field key={i} label={`Variable {{${i + 1}}}`}>
              <input style={inputStyle} value={variables[i] || ''}
                ref={el => { varRefs.current[i] = el; }}
                onFocus={() => setFocusedVar(i)}
                onChange={e => setVariables(vs => { const next = vs.slice(); next[i] = e.target.value; return next; })}
                placeholder={`Value for {{${i + 1}}}`} />
            </Field>
          ))}
          {varCount > 0 && (
            <VarChips onInsert={(token) => {
              const i = Math.min(focusedVar, varCount - 1);
              insertTokenAt(varRefs.current[i], variables[i] || '',
                (nv) => setVariables(vs => { const next = vs.slice(); next[i] = nv; return next; }),
                token);
            }} />
          )}
        </>
      ) : (
        <>
          <Field label="Text message"
            hint="Sent on the lead's existing chat thread — only while the 24-hour window is open; otherwise the step is skipped and logged.">
            <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
              ref={bodyRef}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }}
              placeholder={'Hi {{first_name}}, just checking in…'} />
          </Field>
          <VarChips onInsert={(token) => insertTokenAt(bodyRef.current, body, setBody, token)} />
        </>
      )}
    </Modal>
  );
}

// ── Manual enroll modal ──────────────────────────────────────────────────────

function EnrollModal({ sequence, onClose, onEnrolled }) {
  const [search, setSearch] = useState('');
  const [leads, setLeads] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stale = false; // a slower earlier response must not overwrite newer results
    const t = setTimeout(async () => {
      try {
        const params = search.trim() ? { search: search.trim() } : {};
        const { leads } = await api.leads.list(params);
        if (!stale) setLeads((leads || []).slice(0, 50));
      } catch (e) { if (!stale) showError(e.message); }
    }, search ? 300 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [search]);

  const toggle = (id) => setPicked(p => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const enroll = async () => {
    if (!picked.size) return showError('Pick at least one lead.');
    setSaving(true);
    try { onEnrolled(await api.followUps.enroll(sequence.id, [...picked])); }
    catch (e) { showError(e.message); setSaving(false); }
  };

  return (
    <Modal title={`Enroll leads into "${sequence.name}"`} onClose={onClose} width={540}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={enroll} disabled={saving || !picked.size}>
          {saving ? 'Enrolling…' : `Enroll ${picked.size || ''} lead${picked.size === 1 ? '' : 's'}`}
        </Button>
      </>}>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <Search size={15} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search leads by name or number…"
          style={{ ...inputStyle, paddingLeft: 34 }} autoFocus />
      </div>
      <div style={{ maxHeight: 320, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 10 }}>
        {!leads ? <div style={{ padding: 14 }}><Shimmer height={60} radius={8} /></div>
          : !leads.length ? <EmptyState Icon={Search} title="No leads match" />
          : leads.map(l => (
            <div key={l.id} onClick={() => toggle(l.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', fontFamily: FONT }}>
              <input type="checkbox" checked={picked.has(l.id)} readOnly style={{ pointerEvents: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.name || 'Unnamed'}</div>
                <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}><MaskedNumber number={l.whatsappNumber} /></div>
              </div>
              <StageBadge stage={l.stage} />
            </div>
          ))}
      </div>
      <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT, marginTop: 10 }}>
        The first step goes out {sequence.steps?.length ? <b>{fmtDelay(sequence.steps[0].delayMinutes)}</b> : 'its wait'} after enrollment. Leads already running this sequence are skipped.
      </div>
    </Modal>
  );
}
