// Triggers: when the agent runs. Schedules are cron in IST, built from a simple
// editor (raw cron stays available); events run for one lead at a time, debounced
// so a burst of messages makes one run, not ten.

import { useState } from 'react';
import { Plus, Trash2, Clock, Zap, Hand, Play } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, Segmented, inputStyle } from '../../academy/shared.jsx';
import SearchableSelect from '../../../components/SearchableSelect.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { useConfirm } from '../../../components/ConfirmDialog.jsx';
import { useFunnelConfig } from '../../../hooks/useFunnelConfig.js';
import { showError, showSuccess } from '../../../lib/feedback.js';
import { Panel, Notice, MultiPick, NumberInput, EVENT_LABEL, Field } from '../wfShared.jsx';

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];
const MESSAGE_TYPES = [
  { value: 'text', label: 'Text' }, { value: 'voice_note', label: 'Voice note' }, { value: 'image', label: 'Image' },
  { value: 'document', label: 'Document' }, { value: 'video', label: 'Video' }, { value: 'interactive_reply', label: 'Button / list reply' },
];

// ── cron <-> editor ───────────────────────────────────────────────────────────

function expandDays(field) {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set();
  for (const part of field.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    for (let d = a; d <= b; d += 1) out.add(d % 7);
  }
  return [...out];
}

function daysField(days) {
  const set = new Set(days.map(d => d % 7));
  if (set.size === 7 || set.size === 0) return '*';
  const sorted = [...set].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return contiguous && sorted.length > 2 ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(',');
}

const pad = (n) => String(n).padStart(2, '0');

/** Read a cron into the editor's shape; anything unusual stays in "custom". */
export function parseCronEditor(cron) {
  const p = String(cron || '').trim().split(/\s+/);
  if (p.length === 5 && p[2] === '*' && p[3] === '*') {
    const days = expandDays(p[4]);
    if (days && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) return { mode: 'at', minute: Number(p[0]), hour: Number(p[1]), days };
    const step = /^(\d+)-(\d+)\/(\d+)$/.exec(p[1]);
    if (days && /^\d+$/.test(p[0]) && step) return { mode: 'every', minute: Number(p[0]), from: Number(step[1]), to: Number(step[2]), every: Number(step[3]), days };
  }
  return { mode: 'custom', cron: String(cron || '') };
}

export function buildCron(e) {
  if (e.mode === 'at') return `${e.minute} ${e.hour} * * ${daysField(e.days)}`;
  if (e.mode === 'every') return `${e.minute} ${e.from}-${e.to}/${Math.max(1, e.every)} * * ${daysField(e.days)}`;
  return e.cron;
}

export function describeSchedule(e) {
  const dayText = (days) => {
    const f = daysField(days);
    if (f === '*') return 'every day';
    if (f === '1-5') return 'Mon–Fri';
    if (f === '1-6') return 'Mon–Sat';
    return DAYS.filter(d => days.includes(d.n)).map(d => d.label).join(', ');
  };
  if (e.mode === 'at') return `At ${pad(e.hour)}:${pad(e.minute)} IST, ${dayText(e.days)}`;
  if (e.mode === 'every') return `Every ${e.every} h from ${pad(e.from)}:${pad(e.minute)} to ${pad(e.to)}:${pad(e.minute)} IST, ${dayText(e.days)}`;
  return 'Custom cron, evaluated in IST';
}

function DayPicker({ days, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {DAYS.map(d => {
        const on = days.includes(d.n);
        return (
          <button key={d.n} type="button" onClick={() => onChange(on ? days.filter(x => x !== d.n) : [...days, d.n])}
            style={{ minWidth: 48, padding: '7px 10px', borderRadius: 8, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg, color: on ? C.dangerText : C.t3, cursor: 'pointer', fontFamily: FONT, fontSize: T.body, fontWeight: W.medium }}>
            {d.label}
          </button>
        );
      })}
    </div>
  );
}

function ScheduleEditor({ trigger, onChange }) {
  const [editor, setEditor] = useState(() => parseCronEditor(trigger.cron));
  const update = (next) => { setEditor(next); onChange({ ...trigger, cron: buildCron(next) }); };
  const switchMode = (mode) => {
    if (mode === editor.mode) return;
    if (mode === 'at') update({ mode: 'at', hour: 8, minute: 0, days: [1, 2, 3, 4, 5, 6, 0] });
    else if (mode === 'every') update({ mode: 'every', minute: 0, from: 10, to: 18, every: 2, days: [1, 2, 3, 4, 5, 6] });
    else update({ mode: 'custom', cron: buildCron(editor) });
  };
  const time = editor.mode === 'at' ? `${pad(editor.hour)}:${pad(editor.minute)}` : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Segmented value={editor.mode} onChange={switchMode} options={[{ value: 'at', label: 'At a time' }, { value: 'every', label: 'Every few hours' }, { value: 'custom', label: 'Cron' }]} />
      {editor.mode === 'at' && (
        <>
          <Field label="Time (IST)"><input type="time" value={time} onChange={e => { const [h, m] = e.target.value.split(':').map(Number); if (Number.isInteger(h)) update({ ...editor, hour: h, minute: m || 0 }); }} style={{ ...inputStyle, maxWidth: 160 }} /></Field>
          <Field label="Days"><DayPicker days={editor.days} onChange={(days) => update({ ...editor, days })} /></Field>
        </>
      )}
      {editor.mode === 'every' && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Every (hours)"><NumberInput value={editor.every} min={1} max={12} onChange={(v) => update({ ...editor, every: v || 1 })} style={{ width: 110 }} /></Field>
            <Field label="From hour"><NumberInput value={editor.from} min={0} max={23} onChange={(v) => update({ ...editor, from: Math.min(23, Math.max(0, v ?? 0)) })} style={{ width: 110 }} /></Field>
            <Field label="Until hour"><NumberInput value={editor.to} min={0} max={23} onChange={(v) => update({ ...editor, to: Math.min(23, Math.max(0, v ?? 23)) })} style={{ width: 110 }} /></Field>
            <Field label="At minute"><NumberInput value={editor.minute} min={0} max={59} onChange={(v) => update({ ...editor, minute: Math.min(59, Math.max(0, v ?? 0)) })} style={{ width: 110 }} /></Field>
          </div>
          {editor.from > editor.to && <Notice tone="warn">The start hour is after the end hour, so this never runs.</Notice>}
          <Field label="Days"><DayPicker days={editor.days} onChange={(days) => update({ ...editor, days })} /></Field>
        </>
      )}
      {editor.mode === 'custom' && (
        <Field label="Cron expression" hint="minute hour day-of-month month day-of-week, in IST. Example: 30 10 * * 1-6">
          <input value={editor.cron} onChange={e => update({ mode: 'custom', cron: e.target.value })} style={{ ...inputStyle, fontFamily: MONO, maxWidth: 320 }} />
        </Field>
      )}
      <div style={{ fontSize: T.body, color: C.t2 }}>{describeSchedule(editor)} · <span style={{ fontFamily: MONO, color: C.textMuted }}>{trigger.cron}</span></div>
    </div>
  );
}

function EventEditor({ trigger, onChange }) {
  const { stages } = useFunnelConfig();
  const f = trigger.filters || {};
  const setFilter = (key, value) => {
    const next = { ...f };
    if (value == null || (Array.isArray(value) && (value.length === 0 || value.includes('all'))) || value === false) delete next[key]; else next[key] = value;
    onChange({ ...trigger, filters: next });
  };
  const stageOptions = stages.map(s => ({ value: s.stageKey, label: s.label }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="When">
        <SearchableSelect value={trigger.event} onChange={(v) => onChange({ ...trigger, event: v, filters: {}, debounce_minutes: v === 'lead.quiet' ? 0 : trigger.debounce_minutes ?? 10 })}
          options={Object.entries(EVENT_LABEL).map(([value, label]) => ({ value, label }))} />
      </Field>
      {trigger.event === 'message.inbound' && (
        <Field label="Only these message types" hint="Leave empty for any message.">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MESSAGE_TYPES.map(m => {
              const on = (f.message_type || []).includes(m.value);
              return (
                <button key={m.value} type="button" onClick={() => setFilter('message_type', on ? f.message_type.filter(x => x !== m.value) : [...(f.message_type || []), m.value])}
                  style={{ padding: '6px 10px', borderRadius: 8, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg, color: on ? C.dangerText : C.t3, cursor: 'pointer', fontFamily: FONT, fontSize: T.body }}>
                  {m.label}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      {trigger.event === 'lead.stage_changed' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label="Moved to"><MultiPick allLabel="Any stage" value={f.to?.length ? f.to : ['all']} onChange={(v) => setFilter('to', v)} options={stageOptions} /></Field>
          <Field label="Moved from"><MultiPick allLabel="Any stage" value={f.from?.length ? f.from : ['all']} onChange={(v) => setFilter('from', v)} options={stageOptions} /></Field>
        </div>
      )}
      {trigger.event === 'lead.quiet' && (
        <Field label="Hours since the lead last wrote" hint="Checked every minute; each quiet spell runs once.">
          <NumberInput value={f.hours_since_last_inbound ?? 48} min={1} max={720} onChange={(v) => setFilter('hours_since_last_inbound', v ?? 48)} style={{ maxWidth: 140 }} />
        </Field>
      )}
      {trigger.event === 'payment.created' && (
        <Field label="Minimum amount (₹)" hint="Leave empty for any payment.">
          <NumberInput value={f.min_amount_rupees ?? null} min={0} onChange={(v) => setFilter('min_amount_rupees', v)} style={{ maxWidth: 160 }} />
        </Field>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="Only for leads at these stages"><MultiPick allLabel="Any stage" value={f.stage_in?.length ? f.stage_in : ['all']} onChange={(v) => setFilter('stage_in', v)} options={stageOptions} /></Field>
        <Field label="Skip customers who already bought">
          <Toggle checked={f.stage_not_won === true} onChange={(v) => setFilter('stage_not_won', v || null)} />
        </Field>
      </div>
      {trigger.event !== 'lead.quiet' && (
        <Field label="Wait for the lead to stop (minutes)" hint="Messages that arrive inside this window join one run for that lead.">
          <NumberInput value={trigger.debounce_minutes ?? 10} min={0} max={1440} onChange={(v) => onChange({ ...trigger, debounce_minutes: v ?? 0 })} style={{ maxWidth: 140 }} />
        </Field>
      )}
    </div>
  );
}

const TYPE_META = {
  schedule: { Icon: Clock, title: 'On a schedule' },
  event: { Icon: Zap, title: 'When something happens' },
  manual: { Icon: Hand, title: 'By hand' },
};

export default function TriggersTab({ agentId, agent, version, draft, patchDraft, isAdmin, dirty, navigate }) {
  const triggers = draft.triggers || [];
  const [confirmEl, confirm] = useConfirm();
  const [running, setRunning] = useState(false);
  const setAt = (i, next) => patchDraft('triggers', (list) => list.map((t, j) => (j === i ? next : t)));
  const removeAt = (i) => patchDraft('triggers', (list) => list.filter((_, j) => j !== i));
  const add = (type) => patchDraft('triggers', (list) => [...(list || []), type === 'schedule'
    ? { type: 'schedule', cron: '0 8 * * *', timezone: 'Asia/Kolkata', enabled: true }
    : type === 'event' ? { type: 'event', event: 'message.inbound', filters: {}, debounce_minutes: 10, enabled: true }
      : { type: 'manual', enabled: true }]);

  const manual = triggers.find(t => t.type === 'manual' && t.enabled !== false);

  const runNow = async () => {
    const ok = await confirm({
      title: 'Run this agent now?',
      body: `It runs saved version ${version?.version ?? ''} on live data: proposals are filed for approval and results are delivered to the destinations.${dirty ? ' Your unsaved changes are not included; use the Test tab to try them.' : ''} It calls Claude and costs money.`,
      confirmLabel: 'Run now',
    });
    if (!ok) return;
    setRunning(true);
    try {
      const { run } = await api.workflowAgents.run(agentId, { dry_run: false });
      showSuccess('Run started.');
      navigate('workflow-agents', agentId, 'runs', run.id);
    } catch (e) { showError(e.message); } finally { setRunning(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      {confirmEl}
      {agent.status !== 'active' && (
        <Notice tone="warn">This agent is {agent.status}. Schedules and events only run while it is on{manual ? ', but you can still run it by hand' : ''}.</Notice>
      )}
      {triggers.length === 0 && <Notice tone="info">No triggers yet. Add a schedule, an event, or allow running it by hand.</Notice>}
      {triggers.map((t, i) => {
        const meta = TYPE_META[t.type] || TYPE_META.manual;
        return (
          <Panel key={i}
            title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><meta.Icon size={17} color={C.t4} />{meta.title}</span>}
            right={<>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: T.meta, color: C.textSecondary }}><Toggle checked={t.enabled !== false} onChange={(v) => setAt(i, { ...t, enabled: v })} />{t.enabled !== false ? 'On' : 'Off'}</span>
              <Button variant="ghost" icon={Trash2} onClick={() => removeAt(i)} aria-label="Remove trigger" style={{ padding: '6px 9px' }} />
            </>}
          >
            {t.type === 'schedule' && <ScheduleEditor trigger={t} onChange={(next) => setAt(i, next)} />}
            {t.type === 'event' && <EventEditor trigger={t} onChange={(next) => setAt(i, next)} />}
            {t.type === 'manual' && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontSize: T.body, color: C.t2, lineHeight: LH.normal, flex: '1 1 260px' }}>An admin can start a full run at any time. To try changes without affecting anyone, use the Test tab.</div>
                {isAdmin && <Button variant="primary" icon={Play} disabled={running || t.enabled === false} onClick={runNow}>{running ? 'Starting…' : 'Run now'}</Button>}
              </div>
            )}
          </Panel>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button icon={Plus} onClick={() => add('schedule')}>Add schedule</Button>
        <Button icon={Plus} onClick={() => add('event')}>Add event</Button>
        {!triggers.some(t => t.type === 'manual') && <Button icon={Plus} onClick={() => add('manual')}>Allow running by hand</Button>}
      </div>
    </div>
  );
}
