// "New agent" as three plain steps: what should it do, a few questions in everyday
// words, then a review. It sends the answers with the create call, so version 1
// already reflects them. Everything technical (model, tools, output schema, cron)
// keeps its preset default and stays under Advanced in the builder.

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Bot, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH, maskPhone } from '../../constants.js';
import { Button, Segmented, inputStyle } from '../academy/shared.jsx';
import Toggle from '../../components/Toggle.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { notify, showError } from '../../lib/feedback.js';
import { parseCronEditor, buildCron } from './tabs/TriggersTab.jsx';
import { Panel, Notice, Field, MultiPick, ChipInput, NumberInput, textareaStyle, agentIcon, useNarrow } from './wfShared.jsx';

// Goals in the words an admin would use; the preset names stay visible underneath.
const GOALS = {
  lead_signal: { title: 'Tell reps who to contact first', blurb: 'Every morning, each rep gets a ranked list of the leads most likely to buy, why, and what to say.' },
  follow_up_drafter: { title: 'Bring back leads who went quiet', blurb: 'When an interested lead stops replying, it drafts a follow-up message for you to approve.' },
  payment_chaser: { title: 'Chase balances still due', blurb: 'Lists customers who still owe money, each with a polite reminder to approve.' },
  response_time_watcher: { title: 'Catch slow replies', blurb: 'During working hours, flags hot leads nobody has answered and tells the team lead.' },
  reason_finder: { title: 'Learn why leads don’t buy', blurb: 'A weekly report of the reasons, with counts and real quotes.' },
};
const GOAL_ORDER = ['lead_signal', 'follow_up_drafter', 'payment_chaser', 'response_time_watcher', 'reason_finder'];

const DAY_SETS = [
  { value: 'daily', label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { value: 'mon-sat', label: 'Mon–Sat', days: [1, 2, 3, 4, 5, 6] },
  { value: 'weekdays', label: 'Mon–Fri', days: [1, 2, 3, 4, 5] },
  { value: 'mondays', label: 'Mondays', days: [1] },
];
const sameDays = (a, b) => a.length === b.length && a.every(d => b.includes(d));
const pad = (n) => String(n).padStart(2, '0');
const BLANK = /\[[^\]\n]{1,60}\]/;


function Steps({ step }) {
  const labels = ['What it should do', 'Set it up', 'Review'];
  return (
    <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: '0 0 18px', flexWrap: 'wrap' }}>
      {labels.map((l, i) => {
        const n = i + 1; const done = n < step; const on = n === step;
        return (
          <li key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: T.body, fontWeight: on ? W.bold : W.normal, color: on ? C.text : C.textSecondary }}>
            <span style={{ width: 26, height: 26, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: T.meta, fontWeight: W.bold, background: done || on ? C.primary : C.surfaceMuted, color: done || on ? '#fff' : C.t4 }}>
              {done ? <Check size={14} /> : n}
            </span>
            {l}
            {n < 3 && <span style={{ color: C.t8, margin: '0 4px' }}>—</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Question({ title, hint, children }) {
  return (
    <Panel title={title} hint={hint}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </Panel>
  );
}

function ToggleLine({ checked, onChange, children, hint, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: T.bodyLg, color: disabled ? C.textMuted : C.text, lineHeight: LH.snug, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
        {hint && <div style={{ fontSize: T.meta, color: C.textSecondary, marginTop: 3, lineHeight: LH.normal }}>{hint}</div>}
      </div>
    </div>
  );
}

function ScheduleAnswer({ trigger, onChange, label }) {
  const ed = parseCronEditor(trigger.cron);
  const on = trigger.enabled !== false;
  if (ed.mode === 'at') {
    const set = DAY_SETS.find(s => sameDays(s.days, ed.days));
    const update = (next) => onChange({ ...trigger, cron: buildCron(next) });
    return (
      <ToggleLine checked={on} onChange={(v) => onChange({ ...trigger, enabled: v })}>
        <span>{label || 'Run automatically at'}</span>
        <input type="time" aria-label="Time" value={`${pad(ed.hour)}:${pad(ed.minute)}`} disabled={!on}
          onChange={e => { const [h, m] = e.target.value.split(':').map(Number); if (Number.isInteger(h)) update({ ...ed, hour: h, minute: m || 0 }); }}
          style={{ ...inputStyle, width: 130, padding: '6px 9px' }} />
        <div style={{ width: 170 }}>
          <SearchableSelect value={set?.value || 'custom'} onChange={(v) => { const s = DAY_SETS.find(x => x.value === v); if (s) update({ ...ed, days: s.days }); }} disabled={!on}
            options={[...DAY_SETS.map(s => ({ value: s.value, label: s.label })), ...(set ? [] : [{ value: 'custom', label: 'Custom days' }])]} />
        </div>
      </ToggleLine>
    );
  }
  const text = ed.mode === 'every'
    ? `Every ${ed.every} hours from ${pad(ed.from)}:${pad(ed.minute)} to ${pad(ed.to)}:${pad(ed.minute)}, ${DAY_SETS.find(s => sameDays(s.days, ed.days))?.label || 'on set days'}`
    : `On a custom schedule (${trigger.cron})`;
  return (
    <ToggleLine checked={on} onChange={(v) => onChange({ ...trigger, enabled: v })} hint="You can change the timing later under Advanced → Schedule & events.">
      {text}
    </ToggleLine>
  );
}

function EventAnswer({ trigger, onChange }) {
  const on = trigger.enabled !== false;
  const set = (v) => onChange({ ...trigger, enabled: v });
  const f = trigger.filters || {};
  switch (trigger.event) {
    case 'message.inbound':
      return <ToggleLine checked={on} onChange={set} hint={`It waits until the lead has stopped typing for ${trigger.debounce_minutes ?? 10} minutes, so a burst of messages is one update.`}>Also update a lead as soon as they send a message</ToggleLine>;
    case 'lead.quiet':
      return (
        <ToggleLine checked={on} onChange={set}>
          <span>When an interested lead has been quiet for</span>
          <NumberInput value={f.hours_since_last_inbound ?? 48} min={1} max={720} disabled={!on} onChange={(v) => onChange({ ...trigger, filters: { ...f, hours_since_last_inbound: v ?? 48 } })} style={{ width: 90, padding: '6px 9px' }} />
          <span>hours</span>
        </ToggleLine>
      );
    case 'lead.stage_changed': return <ToggleLine checked={on} onChange={set}>When a lead moves to a new funnel stage</ToggleLine>;
    case 'payment.created': return <ToggleLine checked={on} onChange={set}>When a payment arrives</ToggleLine>;
    default: return null;
  }
}

function rupeesFromPaise(p) { return `₹${Math.round(Number(p) / 100).toLocaleString('en-IN')}`; }

export default function CreateAgentWizard({ navigate }) {
  const narrow = useNarrow(700);
  const [step, setStep] = useState(1);
  const [presets, setPresets] = useState(null);
  const [goal, setGoal] = useState(null); // preset key — creation is preset-only
  const [preset, setPreset] = useState(null);
  const [lookups, setLookups] = useState({ team: null, settings: null, templates: null, products: [] });
  const [busy, setBusy] = useState(false);

  // answers
  const [name, setName] = useState('');
  const [triggers, setTriggers] = useState([]);
  const [leadsMode, setLeadsMode] = useState('all');
  const [numbers, setNumbers] = useState(['all']);
  const [lookback, setLookback] = useState(14);
  const [worklist, setWorklist] = useState(true);
  const [whatsapp, setWhatsapp] = useState({ on: false, template: '', send_at: '' });
  const [emails, setEmails] = useState([]);
  const [memory, setMemory] = useState([]);
  const [budget, setBudget] = useState(null);

  useEffect(() => {
    api.workflowAgents.presets().then(setPresets).catch(e => { showError(e.message); setPresets([]); });
    Promise.allSettled([api.workflowAgents.team(), api.workflowAgents.settings(), api.templates.list({ status: 'APPROVED' }), api.products.list()])
      .then(([t, s, tp, p]) => {
        const tplList = Array.isArray(tp.value) ? tp.value : tp.value?.templates || [];
        const seen = new Set();
        setLookups({
          team: t.value || null, settings: s.value || null,
          templates: tplList.filter(x => String(x.status).toUpperCase() === 'APPROVED' && !seen.has(x.name) && seen.add(x.name)),
          products: (p.value?.products || []).filter(x => x.active !== false),
        });
      });
  }, []);

  const choose = async (key) => {
    setGoal(key);
    try {
      const p = await api.workflowAgents.preset(key);
      setPreset(p);
      setName(p.name);
      setTriggers(p.triggers.map(t => ({ ...t })));
      setLookback(p.data_scope?.lookback_days ?? 14);
      setWorklist(p.destinations.some(d => d.type === 'rep_worklist'));
      const wa = p.destinations.find(d => d.type === 'whatsapp_template');
      setWhatsapp({ on: false, template: wa?.template || '', send_at: wa?.send_at || '' });
      setMemory(p.memory.filter(m => BLANK.test(m.content)).map(m => ({ title: m.title, content: m.content })));
      setBudget(p.monthly_budget_inr);
      setStep(2);
    } catch (e) { showError(e.message); }
  };

  const hasDest = (type) => !!preset?.destinations.some(d => d.type === type);
  const templateOk = lookups.templates?.some(t => t.name === whatsapp.template);
  const numbersAssigned = !!lookups.team?.numbers.some(n => n.current_rep_user_id);
  const noKey = lookups.settings && !lookups.settings.anthropic_credentials.length && !lookups.settings.anthropic_env_key;
  const blanksLeft = memory.filter(m => BLANK.test(m.content)).length;

  const problems = useMemo(() => {
    const p = [];
    if (!name.trim()) p.push('Give the agent a name.');
    if (whatsapp.on && !templateOk) p.push('Pick an approved WhatsApp template, or switch the WhatsApp summary off.');
    if (leadsMode === 'some' && (!numbers.length || numbers.includes('all'))) p.push('Pick at least one business number, or choose all leads.');
    return p;
  }, [name, whatsapp, templateOk, leadsMode, numbers]);

  const destinations = () => {
    const out = [{ type: 'results_inbox' }];
    for (const d of preset.destinations) {
      if (d.type === 'results_inbox' || d.type === 'email') continue;
      if (d.type === 'rep_worklist') { if (worklist) out.push(d); continue; }
      if (d.type === 'whatsapp_template') { if (whatsapp.on) out.push({ ...d, template: whatsapp.template, send_at: whatsapp.send_at || null, enabled: true }); continue; }
      out.push(d);
    }
    if (emails.length) out.push({ type: 'email', to: emails, enabled: true });
    return out;
  };

  const buildSetup = () => {
    const setup = {
      triggers,
      destinations: destinations(),
      data_scope: { lookback_days: lookback || 14, business_numbers: leadsMode === 'some' ? numbers : ['all'] },
      monthly_budget_inr: budget || null,
    };
    if (memory.length) setup.memory = memory;
    return setup;
  };

  const create = async () => {
    setBusy(true);
    try {
      const out = await api.workflowAgents.create({ preset_key: goal, name: name.trim(), setup: buildSetup() });
      navigate('workflow-agents', out.agent.id, 'setup');
    } catch (e) {
      const list = e.body?.errors;
      if (Array.isArray(list) && list.length) notify({ variant: 'error', title: 'The agent could not be created', message: list.join('\n') });
      else showError(e.message);
      setBusy(false);
    }
  };

  const fillProducts = (i) => {
    const priced = lookups.products.filter(p => Number(p.default_price_paise) > 0);
    const list = (priced.length ? priced : lookups.products).map(p => (Number(p.default_price_paise) > 0 ? `${p.name} (${rupeesFromPaise(p.default_price_paise)})` : p.name)).join(', ');
    const prices = priced.map(p => Number(p.default_price_paise)).sort((a, b) => a - b);
    const range = prices.length ? (prices[0] === prices[prices.length - 1] ? rupeesFromPaise(prices[0]) : `${rupeesFromPaise(prices[0])}–${rupeesFromPaise(prices[prices.length - 1])}`) : null;
    setMemory(ms => ms.map((m, j) => {
      if (j !== i) return m;
      let c = m.content.replace(/Our products: \[[^\]]*\]/, `Our products: ${list}`);
      if (range) c = c.replace(/Typical price range: \[[^\]]*\]/, `Typical price range: ${range}`);
      return { ...m, content: c };
    }));
  };

  // ── plain-language summary for the review step ─────────────────────────────
  const whenLines = () => {
    const lines = [];
    for (const t of triggers) {
      if (t.enabled === false || t.type === 'manual') continue;
      if (t.type === 'schedule') {
        const ed = parseCronEditor(t.cron);
        if (ed.mode === 'at') lines.push(`At ${pad(ed.hour)}:${pad(ed.minute)} IST, ${(DAY_SETS.find(s => sameDays(s.days, ed.days))?.label || 'on chosen days').toLowerCase()}`);
        else if (ed.mode === 'every') lines.push(`Every ${ed.every} hours from ${pad(ed.from)}:00 to ${pad(ed.to)}:00 IST`);
        else lines.push(`On a custom schedule (${t.cron})`);
      } else if (t.event === 'message.inbound') lines.push('As soon as a lead sends a message');
      else if (t.event === 'lead.quiet') lines.push(`When an interested lead has been quiet for ${t.filters?.hours_since_last_inbound ?? 48} hours`);
      else if (t.event === 'lead.stage_changed') lines.push('When a lead changes stage');
      else if (t.event === 'payment.created') lines.push('When a payment arrives');
    }
    lines.push('Whenever you press Run now');
    return lines;
  };
  const whereLines = () => {
    const lines = ['The Results page for this agent'];
    if (worklist && hasDest('rep_worklist')) lines.push('Each rep’s “My leads today” list');
    if (whatsapp.on) lines.push(`A WhatsApp summary to each rep using “${whatsapp.template}”${whatsapp.send_at ? ` at ${whatsapp.send_at}` : ''}`);
    if (emails.length) lines.push(`An email to ${emails.join(', ')}`);
    return lines;
  };

  const shell = (children, footer) => (
    <div style={{ padding: narrow ? '14px 12px 40px' : '20px 28px 60px', fontFamily: FONT }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <button type="button" onClick={() => navigate('workflow-agents')} aria-label="Back to workflow agents" style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary, padding: 4 }}><ArrowLeft size={20} /></button>
          <span style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text }}>New workflow agent</span>
        </div>
        <Steps step={step} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
        {footer && <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );

  // ── step 1 ────────────────────────────────────────────────────────────────
  if (step === 1) {
    const byKey = new Map((presets || []).map(p => [p.preset_key, p]));
    const cards = [...GOAL_ORDER.filter(k => byKey.has(k)).map(k => ({ key: k, ...GOALS[k], preset: byKey.get(k) }))];
    return shell(
      !presets ? <div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 12 }}>
          {cards.map(c => {
            const Icon = c.preset ? agentIcon(c.preset.icon) : Sparkles;
            return (
              // A div, not a <button>: the app's button styling turns a button into a pill.
              <div key={c.key} role="button" tabIndex={0} onClick={() => choose(c.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(c.key); } }}
                style={{ textAlign: 'left', padding: 16, borderRadius: 14, border: `1.5px solid ${C.border}`, background: C.cardBg, cursor: 'pointer', fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: C.shadowSm }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.primary; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; }}>
                <span style={{ width: 38, height: 38, borderRadius: 10, background: C.primaryLight, color: C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={19} /></span>
                <span style={{ fontSize: T.lead, fontWeight: W.bold, color: C.text, lineHeight: LH.tight }}>{c.title}</span>
                <span style={{ fontSize: T.body, color: C.textSecondary, lineHeight: LH.normal }}>{c.blurb}</span>
                {c.preset && <span style={{ fontSize: T.meta, color: C.textMuted }}>{c.preset.name}</span>}
              </div>
            );
          })}
        </div>
      ),
    );
  }

  // ── step 2 ────────────────────────────────────────────────────────────────
  if (step === 2) {
    const scheduleIdx = triggers.map((t, i) => (t.type === 'schedule' ? i : -1)).filter(i => i >= 0);
    const eventIdx = triggers.map((t, i) => (t.type === 'event' ? i : -1)).filter(i => i >= 0);
    const setTrigger = (i, next) => setTriggers(ts => ts.map((t, j) => (j === i ? next : t)));
    return shell(
      <>
        <Question title="Name">
          <input value={name} maxLength={120} onChange={e => setName(e.target.value)} style={inputStyle} />
        </Question>

        <Question title="When should it run?" hint="Times are Indian Standard Time. You can also run it yourself at any time.">
          {scheduleIdx.map(i => <ScheduleAnswer key={i} trigger={triggers[i]} onChange={(n) => setTrigger(i, n)} />)}
          {eventIdx.map(i => <EventAnswer key={i} trigger={triggers[i]} onChange={(n) => setTrigger(i, n)} />)}
        </Question>

        <Question title="Which leads should it look at?">
          <Segmented value={leadsMode} onChange={setLeadsMode} options={[{ value: 'all', label: 'All leads' }, { value: 'some', label: 'Only leads on certain numbers' }]} />
          {leadsMode === 'some' && lookups.team && (
            <MultiPick value={numbers.includes('all') ? [] : numbers} onChange={(v) => setNumbers(v.filter(x => x !== 'all'))} placeholder="Add a business number"
              options={lookups.team.numbers.map(n => ({ value: String(n.number || '').replace(/\D/g, ''), label: n.label || maskPhone(n.number), sublabel: maskPhone(n.number) }))} />
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: T.bodyLg, color: C.text }}>
            <span>Look at conversations from the last</span>
            <NumberInput value={lookback} min={1} max={365} onChange={(v) => setLookback(v)} style={{ width: 90, padding: '6px 9px' }} />
            <span>days</span>
          </div>
        </Question>

        <Question title="Where should results go?">
          <ToggleLine checked disabled onChange={() => {}}>This agent’s Results page (always)</ToggleLine>
          {hasDest('rep_worklist') && (
            <ToggleLine checked={worklist} onChange={setWorklist} hint={numbersAssigned ? undefined : 'No WhatsApp number is linked to a rep yet, so every lead will show as Unassigned until you set that up.'}>
              Each rep’s “My leads today” list
            </ToggleLine>
          )}
          {hasDest('whatsapp_template') && (
            <>
              <ToggleLine checked={whatsapp.on} onChange={(v) => setWhatsapp(w => ({ ...w, on: v }))} disabled={!lookups.templates?.length}
                hint={lookups.templates?.length ? 'Sent to each rep’s notification phone (set in Team & settings).' : 'Needs an approved WhatsApp template. You can add this later under Advanced.'}>
                Also send each rep a WhatsApp summary
              </ToggleLine>
              {whatsapp.on && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingLeft: 58 }}>
                  <div style={{ minWidth: 240, flex: '1 1 240px' }}>
                    <SearchableSelect value={whatsapp.template} onChange={(v) => setWhatsapp(w => ({ ...w, template: v }))} placeholder="Choose an approved template"
                      options={(lookups.templates || []).map(t => ({ value: t.name, label: t.name, sublabel: `${t.language || ''} ${t.category || ''}`.trim() }))} />
                  </div>
                  <input type="time" aria-label="Send at" value={whatsapp.send_at} onChange={e => setWhatsapp(w => ({ ...w, send_at: e.target.value }))} style={{ ...inputStyle, width: 140 }} />
                </div>
              )}
            </>
          )}
          <Field label="Also email the results to (optional)" style={{ marginBottom: 0 }}>
            <ChipInput value={emails} onChange={setEmails} placeholder="name@company.com, then Enter" normalize={(s) => s.trim().toLowerCase()}
              validate={(v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'That is not an email address.')} />
          </Field>
        </Question>

        {memory.length > 0 && (
          <Question title="Tell it about your business" hint="Replace the parts in [brackets]. The agent reads these on every run.">
            {memory.map((m, i) => (
              <div key={m.title}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>{m.title}</span>
                  {BLANK.test(m.content) && <span style={{ fontSize: T.meta, color: C.warnText }}>needs your input</span>}
                  {m.title === 'Products and pricing' && lookups.products.length > 0 && (
                    <Button variant="ghost" onClick={() => fillProducts(i)} style={{ padding: '4px 9px', fontSize: T.meta, marginLeft: 'auto' }}>Fill from my products</Button>
                  )}
                </div>
                <textarea rows={3} value={m.content} onChange={e => setMemory(ms => ms.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} style={textareaStyle} />
              </div>
            ))}
          </Question>
        )}

        <Question title="Spending limit (optional)" hint="Each run calls Claude and costs money. The agent stops for the month when it reaches this.">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: T.bodyLg, color: C.text, flexWrap: 'wrap' }}>
            <span>Stop after ₹</span>
            <NumberInput value={budget} min={1} step={100} placeholder="No limit" onChange={setBudget} style={{ width: 140, padding: '6px 9px' }} />
            <span>in a month</span>
          </div>
        </Question>
      </>,
      <>
        <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)}>Choose a different goal</Button>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {problems.length > 0 && <span style={{ fontSize: T.meta, color: C.warnText }}>{problems[0]}</span>}
          <Button variant="primary" disabled={problems.length > 0} onClick={() => setStep(3)}>Review <ArrowRight size={15} /></Button>
        </div>
      </>,
    );
  }

  // ── step 3 ────────────────────────────────────────────────────────────────
  const Summary = ({ label, lines }) => (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '170px 1fr', gap: '4px 16px', padding: '10px 0', borderTop: `1px solid ${C.borderSubtle}` }}>
      <div style={{ fontSize: T.label, fontWeight: W.medium, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, paddingTop: 2 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: T.bodyLg, color: C.text, lineHeight: LH.snug }}>{lines.map((l, i) => <span key={i}>{l}</span>)}</div>
    </div>
  );
  const Icon = preset?.preset_key ? agentIcon(preset.icon) : Bot;
  const warnings = [];
  if (noKey) warnings.push('No Anthropic API key is set up yet, so runs will fail until one is added in Admin Settings → AI Models.');
  if (worklist && hasDest('rep_worklist') && !numbersAssigned) warnings.push('No WhatsApp number is linked to a rep, so every lead will be listed as Unassigned.');
  if (blanksLeft) warnings.push(`${blanksLeft} business detail${blanksLeft === 1 ? ' still has' : 's still have'} blanks in [brackets]. The agent will read them as they are.`);

  return shell(
    <>
      <Panel>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, background: C.primaryLight, color: C.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={20} /></span>
          <div>
            <div style={{ fontSize: T.h3, fontWeight: W.bold, color: C.text }}>{name}</div>
            <div style={{ fontSize: T.body, color: C.textSecondary }}>{GOALS[goal]?.blurb}</div>
          </div>
        </div>
        <Summary label="Runs" lines={whenLines()} />
        <Summary label="Looks at" lines={[`${leadsMode === 'some' ? `Leads on ${numbers.length} chosen number${numbers.length === 1 ? '' : 's'}` : 'All leads'}, conversations from the last ${lookback || 14} days`]} />
        <Summary label="Results go to" lines={whereLines()} />
        <Summary label="Spending limit" lines={[budget ? `₹${Number(budget).toLocaleString('en-IN')} a month` : 'No limit']} />
        <Summary label="Changes" lines={['It never changes anything by itself. Tags, stage moves, tasks and messages it suggests wait for approval.']} />
      </Panel>
      {warnings.length > 0
        ? <Notice tone="warn"><div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{warnings.map((w, i) => <span key={i}>{w}</span>)}</div></Notice>
        : <Notice tone="success">Everything needed is in place.</Notice>}
      <Notice tone="info">It is created as a <b>draft</b>: nothing runs until you turn it on. You can try it first with a test run.</Notice>
    </>,
    <>
      <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(2)}>Back</Button>
      <Button variant="primary" icon={CheckCircle2} disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create draft agent'}</Button>
    </>,
  );
}
