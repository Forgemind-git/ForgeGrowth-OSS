// Output: the JSON shape every run must return, where results go, and who approves
// what the agent proposes. The schema is enforced: a run whose answer does not
// match gets two chances to fix it, then fails.

import { useEffect, useState } from 'react';
import { Plus, Trash2, Inbox, ListChecks, MessageCircle, Send, Mail, Webhook, Lock } from 'lucide-react';
import { api } from '../../../api.js';
import { C, FONT, MONO, T, W, LH } from '../../../constants.js';
import { Button, Segmented, inputStyle } from '../../academy/shared.jsx';
import SearchableSelect from '../../../components/SearchableSelect.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { Panel, Notice, Field, ChipInput, NumberInput } from '../wfShared.jsx';

const DEST_META = {
  results_inbox: { Icon: Inbox, title: 'Results inbox', hint: 'Every run is kept on the Results tab. Always on.' },
  rep_worklist: { Icon: ListChecks, title: 'Rep worklist', hint: 'Each rep sees their own leads on “My leads today”, grouped by who owns the lead right now.' },
  whatsapp_template: { Icon: MessageCircle, title: 'WhatsApp template', hint: 'Sends an approved template: each rep gets their own lead count on their notify phone, or fixed numbers get the team total.' },
  telegram: { Icon: Send, title: 'Telegram', hint: 'Posts the result to a Telegram chat. The bot token is set in Team & settings.' },
  email: { Icon: Mail, title: 'Email', hint: 'Sends the result as text through the connected Gmail account.' },
  webhook: { Icon: Webhook, title: 'Webhook', hint: 'POSTs the JSON output, signed with X-Forge-Signature (HMAC-SHA256 of the body).' },
};

const NEW_DEST = {
  rep_worklist: { type: 'rep_worklist', split_by: 'owner_rep', enabled: true },
  whatsapp_template: { type: 'whatsapp_template', to: 'rep', numbers: [], template: '', send_at: null, enabled: true },
  telegram: { type: 'telegram', chat_id: '', format: 'summary', enabled: true },
  email: { type: 'email', to: [], format: 'text', enabled: true },
  webhook: { type: 'webhook', url: '', secret: '', enabled: true },
};

function DestinationBody({ d, onChange, templates }) {
  const set = (k, v) => onChange({ ...d, [k]: v });
  switch (d.type) {
    case 'whatsapp_template':
      return (
        <>
          <Field label="Send to">
            <Segmented value={d.to} onChange={(v) => set('to', v)} options={[{ value: 'rep', label: 'Each rep (their own leads)' }, { value: 'numbers', label: 'Fixed numbers' }]} />
          </Field>
          {d.to === 'numbers' && (
            <Field label="Numbers" hint="With country code, e.g. 919876543210.">
              <ChipInput value={d.numbers} onChange={(v) => set('numbers', v)} placeholder="Add a number" normalize={(s) => s.replace(/\D/g, '')} validate={(v) => (v.length < 10 ? 'Include the country code.' : null)} />
            </Field>
          )}
          {d.to === 'rep' && <Notice tone="info" style={{ marginBottom: 12 }}>Reps without a notify phone in Team & settings are skipped, and the delivery log says so.</Notice>}
          <Field label="Approved template">
            <SearchableSelect value={d.template} onChange={(v) => set('template', v)} placeholder={templates ? 'Choose a template' : 'Loading templates…'} emptyText="No approved templates"
              options={(templates || []).map(t => ({ value: t.name, label: t.name, sublabel: `${t.language || ''} ${t.category || ''}`.trim() }))} />
          </Field>
          <Field label="Send at (IST)" hint="Empty = as soon as the run finishes. This is an internal digest, so it does not wait for approval.">
            <input type="time" value={d.send_at || ''} onChange={e => set('send_at', e.target.value || null)} style={{ ...inputStyle, maxWidth: 160 }} />
          </Field>
          <div style={{ fontSize: T.meta, color: C.textMuted, marginBottom: 12, lineHeight: LH.normal }}>
            Template variables are filled in this order, as many as the template has: rep name (or “Team”), number of leads, number of hot leads, top three leads, run date.
          </div>
        </>
      );
    case 'telegram':
      return (
        <>
          <Field label="Chat ID" hint="The group or channel id, e.g. -1001234567890. Add the bot to the chat first."><input value={d.chat_id} onChange={e => set('chat_id', e.target.value)} style={{ ...inputStyle, fontFamily: MONO, maxWidth: 300 }} /></Field>
          <Field label="What to post"><Segmented value={d.format} onChange={(v) => set('format', v)} options={[{ value: 'summary', label: 'Summary' }, { value: 'full', label: 'Full result' }]} /></Field>
        </>
      );
    case 'email':
      return (
        <Field label="Send to">
          <ChipInput value={d.to} onChange={(v) => set('to', v)} placeholder="name@company.com" normalize={(s) => s.trim().toLowerCase()} validate={(v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'That is not an email address.')} />
        </Field>
      );
    case 'webhook':
      return (
        <>
          <Field label="URL"><input value={d.url || ''} onChange={e => set('url', e.target.value)} placeholder="https://…" style={{ ...inputStyle, fontFamily: MONO }} /></Field>
          <Field label="Signing secret (optional)" hint="Used to compute X-Forge-Signature so the receiver can check the request came from here."><input type="password" autoComplete="new-password" value={d.secret || ''} onChange={e => set('secret', e.target.value)} style={{ ...inputStyle, fontFamily: MONO, maxWidth: 360 }} /></Field>
        </>
      );
    default:
      return null;
  }
}

export default function OutputTab({ draft, patchDraft, schemaError }) {
  const [templates, setTemplates] = useState(null);
  useEffect(() => {
    api.templates.list({ status: 'APPROVED' })
      .then(r => {
        const list = Array.isArray(r) ? r : r?.templates || [];
        const seen = new Set();
        setTemplates(list.filter(t => String(t.status).toUpperCase() === 'APPROVED' && !seen.has(t.name) && seen.add(t.name)));
      })
      .catch(() => setTemplates([]));
  }, []);

  const dests = draft.destinations || [];
  const rules = draft.approval_rules || {};
  const batching = draft.runtime?.batching || {};
  const setDest = (i, next) => patchDraft('destinations', (list) => list.map((d, j) => (j === i ? next : d)));
  const removeDest = (i) => patchDraft('destinations', (list) => list.filter((_, j) => j !== i));
  const addDest = (type) => patchDraft('destinations', (list) => [...(list || [{ type: 'results_inbox' }]), { ...NEW_DEST[type] }]);
  const setRules = (k, v) => patchDraft('approval_rules', (r) => ({ ...(r || {}), [k]: v }));
  const setBatching = (k, v) => patchDraft('runtime', (r) => ({ ...(r || {}), batching: { ...(r?.batching || {}), [k]: v } }));
  const approvers = rules.approvers || ['admin'];
  const hasWorklist = dests.some(d => d.type === 'rep_worklist');

  const formatSchema = () => {
    try { patchDraft('output_schema_text', JSON.stringify(JSON.parse(draft.output_schema_text), null, 2)); } catch { /* the error is already shown */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: FONT }}>
      <Panel title="Output schema" hint="JSON Schema for the object the agent must return. Runs are checked against it, and quotes it cites are checked against the real messages."
        right={<Button onClick={formatSchema} disabled={!!schemaError}>Format</Button>}>
        <textarea value={draft.output_schema_text} onChange={e => patchDraft('output_schema_text', e.target.value)} spellCheck={false}
          style={{ width: '100%', minHeight: 360, boxSizing: 'border-box', padding: 12, borderRadius: 10, border: `1.5px solid ${schemaError ? C.primary : C.border}`, background: C.cardBg, color: C.text, fontFamily: MONO, fontSize: T.meta, lineHeight: LH.snug, resize: 'vertical', outline: 'none' }} />
        {schemaError ? <Notice tone="danger" style={{ marginTop: 10 }}>{schemaError}</Notice> : <div style={{ fontSize: T.meta, color: C.successText, marginTop: 6 }}>Valid JSON.</div>}
      </Panel>

      <Panel title="Where results go">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {dests.map((d, i) => {
            const meta = DEST_META[d.type] || { Icon: Inbox, title: d.type };
            const locked = d.type === 'results_inbox';
            return (
              <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: locked || d.type === 'rep_worklist' ? 0 : 12 }}>
                  <meta.Icon size={18} color={C.t4} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: T.bodyLg, fontWeight: W.medium, color: C.text }}>{meta.title}</div>
                    <div style={{ fontSize: T.meta, color: C.textSecondary, lineHeight: LH.normal }}>{meta.hint}</div>
                  </div>
                  {locked ? <Lock size={15} color={C.textMuted} /> : (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Toggle checked={d.enabled !== false} onChange={(v) => setDest(i, { ...d, enabled: v })} />
                      <Button variant="ghost" icon={Trash2} aria-label="Remove destination" onClick={() => removeDest(i)} style={{ padding: '6px 9px' }} />
                    </div>
                  )}
                </div>
                {!locked && <DestinationBody d={d} onChange={(next) => setDest(i, next)} templates={templates} />}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {Object.keys(NEW_DEST).filter(t => t !== 'rep_worklist' || !hasWorklist).map(t => (
            <Button key={t} icon={Plus} onClick={() => addDest(t)}>{DEST_META[t].title}</Button>
          ))}
        </div>
      </Panel>

      <Panel title="Approvals" hint="Anything this agent proposes (a tag, a stage move, a task, a message) waits for one of these people.">
        <Field label="Who can approve">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { key: 'admin', label: 'Admins', hint: 'Always included.' },
              { key: 'team_lead', label: 'Team leads', hint: 'For leads owned by someone in their team.' },
              { key: 'owner_rep', label: 'The rep who owns the lead', hint: 'For their own leads only.' },
            ].map(a => (
              <label key={a.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: a.key === 'admin' ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={a.key === 'admin' || approvers.includes(a.key)} disabled={a.key === 'admin'}
                  onChange={() => setRules('approvers', approvers.includes(a.key) ? approvers.filter(x => x !== a.key) : [...new Set(['admin', ...approvers, a.key])])} style={{ marginTop: 3 }} />
                <span><span style={{ fontSize: T.body, fontWeight: W.medium, color: C.text }}>{a.label}</span> <span style={{ fontSize: T.meta, color: C.textSecondary }}>{a.hint}</span></span>
              </label>
            ))}
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Field label="Proposals expire after (hours)" hint="An expired proposal can no longer be approved.">
            <NumberInput value={rules.expire_hours ?? 24} min={1} max={336} onChange={(v) => setRules('expire_hours', v ?? 24)} style={{ maxWidth: 140 }} />
          </Field>
          {hasWorklist && (
            <Field label="Reps can send suggested messages themselves" hint="On: a rep's Send on their own lead goes out at once. Off: it waits for approval like everything else.">
              <Toggle checked={rules.rep_can_send_suggested === true} onChange={(v) => setRules('rep_can_send_suggested', v)} />
            </Field>
          )}
        </div>
      </Panel>

      <Panel title="Large lists" hint="For agents that look at many leads: split them into batches, analyse each batch, then merge. Costs more model turns but keeps each one focused.">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Field label="Work in batches"><Toggle checked={batching.enabled === true} onChange={(v) => setBatching('enabled', v)} /></Field>
          {batching.enabled && (
            <>
              <Field label="Leads per batch"><NumberInput value={batching.batch_size ?? 25} min={5} max={50} onChange={(v) => setBatching('batch_size', v ?? 25)} style={{ maxWidth: 120 }} /></Field>
              <Field label="Most leads per run"><NumberInput value={batching.max_candidates ?? 150} min={10} max={400} onChange={(v) => setBatching('max_candidates', v ?? 150)} style={{ maxWidth: 120 }} /></Field>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
