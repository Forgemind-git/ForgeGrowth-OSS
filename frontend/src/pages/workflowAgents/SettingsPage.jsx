// Team & settings for workflow agents (admin). Reps are identified by user and
// employee id, never by phone, and which rep holds which business number is kept
// as dated history: numbers get handed from one rep to another, and a lead that
// wrote in last month still belongs to whoever held the number then.

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Trash2, Pencil, Save, Users, Phone, KeyRound } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO, T, W, LH, maskPhone } from '../../constants.js';
import { Button, Modal, PageShell, Table, Td, inputStyle } from '../academy/shared.jsx';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { showError, showSuccess } from '../../lib/feedback.js';
import { Panel, Notice, Field, NumberInput, Collapsible, when } from './wfShared.jsx';

const WEEK = [{ n: 1, l: 'Mon' }, { n: 2, l: 'Tue' }, { n: 3, l: 'Wed' }, { n: 4, l: 'Thu' }, { n: 5, l: 'Fri' }, { n: 6, l: 'Sat' }, { n: 7, l: 'Sun' }];

function HoursEditor({ value, onChange }) {
  const v = value || { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {WEEK.map(d => {
          const on = v.days.includes(d.n);
          return (
            <button key={d.n} type="button" onClick={() => onChange({ ...v, days: on ? v.days.filter(x => x !== d.n) : [...v.days, d.n].sort() })}
              style={{ minWidth: 46, padding: '6px 8px', borderRadius: 8, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : C.cardBg, color: on ? C.dangerText : C.t3, cursor: 'pointer', fontFamily: FONT, fontSize: T.body }}>
              {d.l}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="time" value={v.start} onChange={e => onChange({ ...v, start: e.target.value })} style={{ ...inputStyle, width: 130 }} />
        <span style={{ color: C.textMuted }}>to</span>
        <input type="time" value={v.end} onChange={e => onChange({ ...v, end: e.target.value })} style={{ ...inputStyle, width: 130 }} />
        <span style={{ fontSize: T.meta, color: C.textMuted }}>IST</span>
      </div>
    </div>
  );
}

function RepModal({ rep, teams, defaultHours, onClose, onSave }) {
  const [form, setForm] = useState({ team_id: rep.team_id || '', employee_id: rep.employee_id || '', notify_phone: rep.notify_phone || '', custom: !!rep.working_hours, working_hours: rep.working_hours || defaultHours });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await onSave({ team_id: form.team_id || null, employee_id: form.employee_id || null, notify_phone: form.notify_phone || null, working_hours: form.custom ? form.working_hours : null });
      onClose();
    } catch { /* shown by caller */ } finally { setBusy(false); }
  };
  return (
    <Modal title={`${rep.name}`} onClose={onClose} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button></>}>
      <Field label="Team">
        <SearchableSelect value={String(form.team_id || '')} onChange={(v) => set('team_id', v)} options={[{ value: '', label: 'No team' }, ...teams.map(t => ({ value: t.id, label: t.name }))]} />
      </Field>
      <Field label="Employee ID" hint="The stable id reports use. A phone number is never used to identify a rep.">
        <input value={form.employee_id} maxLength={40} onChange={e => set('employee_id', e.target.value)} style={{ ...inputStyle, fontFamily: MONO, maxWidth: 240 }} />
      </Field>
      <Field label="Phone for agent notifications" hint="Where WhatsApp digests for this rep are sent. With country code.">
        <input value={form.notify_phone} inputMode="tel" onChange={e => set('notify_phone', e.target.value)} placeholder="919876543210" style={{ ...inputStyle, fontFamily: MONO, maxWidth: 240 }} />
      </Field>
      <Field label="Working hours">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: T.body, color: C.t2, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.custom} onChange={e => set('custom', e.target.checked)} />
            Different from the workspace default
          </label>
          {form.custom && <HoursEditor value={form.working_hours} onChange={(v) => set('working_hours', v)} />}
        </div>
      </Field>
    </Modal>
  );
}

export default function SettingsPage({ navigate }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [team, setTeam] = useState(null);
  const [newTeam, setNewTeam] = useState('');
  const [editingRep, setEditingRep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.workflowAgents.settings(), api.workflowAgents.team()]);
      setSettings(s); setTeam(t);
      setForm({ business_name: s.business_name || '', default_working_hours: s.default_working_hours, usd_to_inr: s.usd_to_inr, rate_card: s.rate_card || {}, telegram_bot_token: '' });
    } catch (e) { showError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async () => {
    setBusy(true);
    try {
      const patch = { business_name: form.business_name, default_working_hours: form.default_working_hours || null, usd_to_inr: form.usd_to_inr, rate_card: form.rate_card };
      if (form.telegram_bot_token.trim()) patch.telegram_bot_token = form.telegram_bot_token.trim();
      const s = await api.workflowAgents.updateSettings(patch);
      setSettings(s); setForm(f => ({ ...f, telegram_bot_token: '' }));
      showSuccess('Settings saved.');
    } catch (e) { showError(e.message); } finally { setBusy(false); }
  };

  const clearTelegram = async () => {
    const ok = await confirm({ title: 'Remove the Telegram bot token?', body: 'Telegram destinations stop sending until a token is added again.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try { setSettings(await api.workflowAgents.updateSettings({ telegram_bot_token: '' })); showSuccess('Token removed.'); } catch (e) { showError(e.message); }
  };

  const teamCall = async (fn, msg) => { try { setTeam(await fn()); if (msg) showSuccess(msg); } catch (e) { showError(e.message); throw e; } };

  const assign = async (number, repUserId) => {
    const rep = team.reps.find(r => r.id === repUserId);
    const ok = await confirm({
      title: repUserId ? `Give ${number.label || maskPhone(number.number)} to ${rep?.name}?` : `Unassign ${number.label || maskPhone(number.number)}?`,
      body: 'From now on, leads who write to this number belong to the new holder. Leads who wrote before keep the rep who held it then.',
      confirmLabel: repUserId ? 'Assign' : 'Unassign',
    });
    if (!ok) return;
    teamCall(() => api.workflowAgents.assignNumber(number.id, repUserId || null), 'Number assigned.').catch(() => {});
  };

  if (!settings || !team || !form) {
    return <PageShell><div style={{ fontSize: T.body, color: C.textMuted }}>Loading…</div></PageShell>;
  }

  const repName = (id) => team.reps.find(r => r.id === String(id))?.name || (id ? `User #${id}` : 'Nobody');
  const activeReps = team.reps.filter(r => r.active);

  return (
    <PageShell
      heading="Workflow agents · Team & settings"
      actions={<Button variant="ghost" icon={ArrowLeft} onClick={() => navigate('workflow-agents')}>Back to agents</Button>}
    >
      {confirmEl}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Panel title="Workspace" right={<Button variant="primary" icon={Save} disabled={busy} onClick={saveSettings}>{busy ? 'Saving…' : 'Save'}</Button>}>
            {!settings.anthropic_credentials.length && !settings.anthropic_env_key && (
              <Notice tone="danger" style={{ marginBottom: 14 }}>
                <KeyRound size={14} style={{ verticalAlign: -2 }} /> No Anthropic API key yet. Agents need one to run.{' '}
                <button type="button" onClick={() => navigate('admin-settings', 'ai-models')} style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>Add it in AI Models</button>.
              </Notice>
            )}
            <Field label="Business name" hint="Agents use it as {{business_name}}.">
              <input value={form.business_name} maxLength={120} onChange={e => setForm(f => ({ ...f, business_name: e.target.value }))} style={inputStyle} />
            </Field>
            <Field label="Default working hours" hint="Used when a rep has no hours of their own, for example to judge response times.">
              <HoursEditor value={form.default_working_hours} onChange={(v) => setForm(f => ({ ...f, default_working_hours: v }))} />
            </Field>
            <Field label="Telegram bot token" hint={settings.telegram_configured ? 'A token is saved. Paste a new one to replace it.' : 'From @BotFather. Stored encrypted and never shown again.'}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" autoComplete="new-password" value={form.telegram_bot_token} placeholder={settings.telegram_configured ? '••••••••  (saved)' : '123456:ABC…'} onChange={e => setForm(f => ({ ...f, telegram_bot_token: e.target.value }))} style={{ ...inputStyle, fontFamily: MONO }} />
                {settings.telegram_configured && <Button variant="danger" icon={Trash2} onClick={clearTelegram} aria-label="Remove token" />}
              </div>
            </Field>
          </Panel>

          <Panel title="Costs" hint="Claude bills in US dollars per million tokens. These rates turn each run's tokens into rupees; change them if pricing changes." right={<Button variant="primary" icon={Save} disabled={busy} onClick={saveSettings}>Save</Button>}>
            <Field label="1 US dollar in rupees"><NumberInput value={form.usd_to_inr} min={1} step={0.01} onChange={(v) => setForm(f => ({ ...f, usd_to_inr: v }))} style={{ maxWidth: 160 }} /></Field>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: T.body }}>
                <thead><tr>{['Model', 'Input $/M', 'Output $/M'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: T.label, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {settings.models.map(m => {
                    const r = form.rate_card[m.id] || {};
                    const setRate = (k, v) => setForm(f => {
                      const cur = { input: m.input_usd_per_mtok, output: m.output_usd_per_mtok, ...(f.rate_card[m.id] || {}) };
                      return { ...f, rate_card: { ...f.rate_card, [m.id]: { ...cur, [k]: v ?? (k === 'input' ? m.input_usd_per_mtok : m.output_usd_per_mtok) } } };
                    });
                    return (
                      <tr key={m.id} style={{ borderTop: `1px solid ${C.borderSubtle}` }}>
                        <td style={{ padding: '6px 8px', color: C.text }}>{m.label}</td>
                        <td style={{ padding: '6px 8px' }}><NumberInput value={r.input ?? m.input_usd_per_mtok} min={0} step={0.01} onChange={(v) => setRate('input', v)} style={{ width: 110 }} /></td>
                        <td style={{ padding: '6px 8px' }}><NumberInput value={r.output ?? m.output_usd_per_mtok} min={0} step={0.01} onChange={(v) => setRate('output', v)} style={{ width: 110 }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Teams" hint="A team lead can see and approve their team's leads.">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {team.teams.length === 0 && <div style={{ fontSize: T.body, color: C.textMuted }}>No teams yet.</div>}
              {team.teams.map(t => (
                <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px' }}>
                  <Users size={16} color={C.t4} />
                  <span style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text, flex: '1 1 120px' }}>{t.name}</span>
                  <div style={{ minWidth: 200 }}>
                    <SearchableSelect value={t.lead_user_id || ''} onChange={(v) => teamCall(() => api.workflowAgents.saveTeam({ id: t.id, name: t.name, lead_user_id: v || null }), 'Team lead updated.').catch(() => {})}
                      options={[{ value: '', label: 'No team lead' }, ...activeReps.map(r => ({ value: r.id, label: r.name }))]} />
                  </div>
                  <Button variant="ghost" icon={Trash2} aria-label={`Delete ${t.name}`} onClick={async () => {
                    const ok = await confirm({ title: `Delete team "${t.name}"?`, body: 'Its reps stay; they just have no team.', confirmLabel: 'Delete', danger: true });
                    if (ok) teamCall(() => api.workflowAgents.deleteTeam(t.id), 'Team deleted.').catch(() => {});
                  }} style={{ padding: '6px 9px' }} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newTeam} maxLength={80} placeholder="New team name" onChange={e => setNewTeam(e.target.value)} style={inputStyle}
                onKeyDown={e => { if (e.key === 'Enter' && newTeam.trim()) teamCall(() => api.workflowAgents.saveTeam({ name: newTeam.trim() }), 'Team added.').then(() => setNewTeam('')).catch(() => {}); }} />
              <Button icon={Plus} disabled={!newTeam.trim()} onClick={() => teamCall(() => api.workflowAgents.saveTeam({ name: newTeam.trim() }), 'Team added.').then(() => setNewTeam('')).catch(() => {})}>Add</Button>
            </div>
          </Panel>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Panel title="Business numbers" hint="Who handles each WhatsApp number now. Changing it closes the previous holder's period instead of rewriting history.">
            {team.numbers.length === 0 ? <div style={{ fontSize: T.body, color: C.textMuted }}>No WhatsApp numbers are connected.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {team.numbers.map(n => (
                  <div key={n.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px' }}>
                    <Phone size={16} color={C.t4} />
                    <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                      <div style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text }}>{n.label || 'WhatsApp number'}</div>
                      <div style={{ fontSize: T.meta, color: C.textSecondary, fontFamily: MONO }}>{maskPhone(n.number)}{n.since ? <span style={{ fontFamily: FONT }}> · since {when(n.since)}</span> : null}</div>
                    </div>
                    <div style={{ minWidth: 210 }}>
                      <SearchableSelect value={n.current_rep_user_id || ''} onChange={(v) => { if ((v || null) !== (n.current_rep_user_id || null)) assign(n, v); }}
                        options={[{ value: '', label: 'Nobody (unassigned)' }, ...activeReps.map(r => ({ value: r.id, label: r.name, sublabel: r.employee_id ? `Emp ${r.employee_id}` : r.role }))]} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {team.assignment_history.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Collapsible title={`History (${team.assignment_history.length})`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {team.assignment_history.map(h => {
                      const num = team.numbers.find(n => n.id === h.business_number_id);
                      return (
                        <div key={h.id} style={{ fontSize: T.meta, color: C.t3, lineHeight: LH.normal }}>
                          <b style={{ color: C.text }}>{num?.label || maskPhone(num?.number)}</b> · {repName(h.rep_user_id)} · {when(h.from)} → {h.to ? when(h.to) : 'now'}{h.note ? ` · ${h.note}` : ''}
                        </div>
                      );
                    })}
                  </div>
                </Collapsible>
              </div>
            )}
          </Panel>

          <Panel title="Reps" hint="Everyone who can own a lead. Click a row to set their team, employee id, notification phone and hours." bodyStyle={{ padding: 0 }}>
            <Table
              keyOf={(r) => r.id}
              rows={team.reps}
              onRowClick={(r) => setEditingRep(r)}
              columns={[{ label: 'Name' }, { label: 'Team' }, { label: 'Emp ID' }, { label: 'Notify phone' }, { label: '' }]}
              renderRow={(r) => (
                <>
                  <Td bold color={r.active ? C.text : C.textMuted}>{r.name}{!r.active && <span style={{ fontSize: T.meta, fontWeight: W.normal }}> (inactive)</span>}</Td>
                  <Td>{team.teams.find(t => t.id === r.team_id)?.name || <span style={{ color: C.textMuted }}>—</span>}</Td>
                  <Td mono>{r.employee_id || <span style={{ color: C.textMuted }}>—</span>}</Td>
                  <Td mono>{r.notify_phone ? maskPhone(r.notify_phone) : <span style={{ color: C.textMuted }}>—</span>}</Td>
                  <Td align="right"><Pencil size={14} color={C.t4} /></Td>
                </>
              )}
            />
          </Panel>
        </div>
      </div>

      {editingRep && (
        <RepModal rep={editingRep} teams={team.teams} defaultHours={settings.default_working_hours || { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00' }}
          onClose={() => setEditingRep(null)}
          onSave={(patch) => teamCall(() => api.workflowAgents.updateRep(editingRep.id, patch), 'Rep saved.')} />
      )}
    </PageShell>
  );
}
