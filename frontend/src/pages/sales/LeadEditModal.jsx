// Edit one lead in place — the same modal from the Leads table (row click /
// pencil) and the Pipeline board's lead drawer, so both surfaces offer the
// identical set of fields and cannot drift.
//
// Profile fields write through PUT /leads/:id (dynamic SET, custom fields as a
// MERGE so a concurrent editor's keys survive). A STAGE change goes through
// PUT /leads/:id/move instead — that route writes the lead_events audit row
// the CAPI / CLO / stage-tag dispatchers read; a raw column write here would
// move the lead and starve every one of them.
import { useState, useEffect } from 'react';
import { api } from '../../api.js';
import { C, MONO } from '../../constants.js';
import { showError, showSuccess } from '../../lib/feedback.js';
import SearchableSelect from '../../components/SearchableSelect.jsx';
import CustomFieldInput from '../../components/CustomFieldInput.jsx';
import { useFunnelConfig } from '../../hooks/useFunnelConfig.js';
import { useFieldRegistry } from '../../hooks/useFieldRegistry.js';
import { Modal, Field, inputStyle, Button } from '../academy/shared.jsx';

const DEFAULT_PROFESSIONS = ['Student', 'Engineer', 'Freelancer', 'Business Owner', 'Marketing Professional', 'Other'];
const withEmpty = (opts, label = '— Not set —') => [{ value: '', label }, ...opts.map(o => ({ value: o, label: o }))];

export default function LeadEditModal({ lead, isAdmin, onClose, onSaved }) {
  const { sources, stages } = useFunnelConfig();
  const { leadCustom, byKey } = useFieldRegistry();
  const lbl = (key, fallback) => byKey('lead', key)?.label || fallback;
  const professionOpts = withEmpty(byKey('lead', 'profession')?.options?.length ? byKey('lead', 'profession').options : DEFAULT_PROFESSIONS);

  const [form, setForm] = useState({
    name: lead.name || '',
    whatsappNumber: lead.whatsappNumber || '',
    email: lead.email || '',
    city: lead.city || '',
    age: lead.age ?? '',
    profession: lead.profession || '',
    pincode: lead.pincode || '',
    source: lead.source || '',
    stage: lead.stage || '',
    paidCourse: lead.paidCourse || '',
    assignedUserId: lead.assignedUserId ? String(lead.assignedUserId) : '',
  });
  const [cf, setCf] = useState(() => Object.fromEntries(leadCustom.map(f => [f.fieldKey, lead.customFields?.[f.fieldKey] ?? ''])));
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e?.target ? e.target.value : e }));

  useEffect(() => { api.products.list().then(r => setProducts(r.products || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!isAdmin) return;
    api.users.list()
      .then(rows => setUsers((rows || []).filter(u => u.isActive !== false && ['admin', 'bda_sales'].includes(u.role))))
      .catch(() => setUsers([]));
  }, [isAdmin]);

  // Custom fields the registry knows but this lead's bag has not seen yet
  // still get an input — that is how a value gets onto them the first time.
  useEffect(() => {
    setCf(prev => {
      const next = { ...prev };
      for (const f of leadCustom) if (!(f.fieldKey in next)) next[f.fieldKey] = lead.customFields?.[f.fieldKey] ?? '';
      return next;
    });
  }, [leadCustom, lead.customFields]);

  const stageOpts = stages.map(s => ({ value: s.stageKey, label: s.label }));
  if (form.stage && !stageOpts.some(o => o.value === form.stage)) stageOpts.push({ value: form.stage, label: form.stage });
  const productOpts = [
    { value: '', label: '— None —' },
    ...products.map(p => ({ value: p.name, label: p.name })),
    ...(form.paidCourse && !products.some(p => p.name === form.paidCourse) ? [{ value: form.paidCourse, label: form.paidCourse }] : []),
  ];
  const userOpts = [
    { value: '', label: 'Unassigned' },
    ...(users || []).map(u => ({ value: String(u.id), label: u.displayName || u.username || u.email, sublabel: u.role === 'admin' ? 'Admin' : 'BDA' })),
  ];

  async function save() {
    if (String(form.whatsappNumber).replace(/\D/g, '').length < 7) return showError('A valid WhatsApp number is required');
    for (const f of leadCustom) {
      if (!f.required) continue;
      const v = cf[f.fieldKey];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return showError(`"${f.label}" is required`);
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        whatsappNumber: form.whatsappNumber.trim(),
        email: form.email.trim(),
        city: form.city.trim(),
        age: form.age === '' ? '' : Number(form.age),
        profession: form.profession,
        pincode: form.pincode.trim(),
        source: form.source,
        paidCourse: form.paidCourse,
        customFieldsMerge: cf,
      };
      if (isAdmin) payload.assignedUserId = form.assignedUserId || null;
      let { lead: updated } = await api.leads.update(lead.id, payload);
      if (form.stage && form.stage !== lead.stage) {
        ({ lead: updated } = await api.leads.move(lead.id, form.stage));
      }
      showSuccess('Lead updated');
      onSaved && onSaved(updated);
    } catch (e) {
      showError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit lead" onClose={onClose} width={620}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
      </>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label={lbl('name', 'Name')}><input autoFocus style={inputStyle} value={form.name} onChange={set('name')} /></Field>
        </div>
        <Field label={`${lbl('whatsapp_number', 'WhatsApp')} *`}><input style={{ ...inputStyle, fontFamily: MONO }} value={form.whatsappNumber} onChange={set('whatsappNumber')} placeholder="91XXXXXXXXXX" /></Field>
        <Field label={lbl('email', 'Email')}><input type="email" style={inputStyle} value={form.email} onChange={set('email')} /></Field>
        <Field label={lbl('stage', 'Stage')} hint={form.stage !== lead.stage ? 'The stage change is recorded on the lead’s timeline.' : undefined}>
          <SearchableSelect value={form.stage} onChange={set('stage')} options={stageOpts} placeholder="Stage" />
        </Field>
        <Field label={lbl('source', 'Source')}>
          <SearchableSelect value={form.source} onChange={set('source')} options={withEmpty(sources)} placeholder="— Not set —" />
        </Field>
        <Field label={lbl('city', 'City')}><input style={inputStyle} value={form.city} onChange={set('city')} /></Field>
        <Field label={lbl('age', 'Age')}><input type="number" min="0" style={{ ...inputStyle, fontFamily: MONO }} value={form.age} onChange={set('age')} /></Field>
        <Field label={lbl('profession', 'Profession')}>
          <SearchableSelect value={form.profession} onChange={set('profession')} options={professionOpts} placeholder="— Not set —" />
        </Field>
        <Field label={lbl('pincode', 'Pincode')}><input style={{ ...inputStyle, fontFamily: MONO }} value={form.pincode} onChange={set('pincode')} /></Field>
        <Field label={lbl('paid_course', 'Product')}>
          <SearchableSelect value={form.paidCourse} onChange={set('paidCourse')} options={productOpts} placeholder="— None —" />
        </Field>
        {isAdmin && (
          <Field label={lbl('assigned_to', 'Assigned to')}>
            <SearchableSelect value={form.assignedUserId} onChange={set('assignedUserId')} options={userOpts} placeholder={users == null ? 'Loading…' : 'Unassigned'} disabled={users == null} />
          </Field>
        )}
        {leadCustom.map(f => (
          <Field key={f.fieldKey} label={f.required ? `${f.label} *` : f.label}>
            <CustomFieldInput field={f} value={cf[f.fieldKey]} onChange={v => setCf(prev => ({ ...prev, [f.fieldKey]: v }))} />
          </Field>
        ))}
      </div>
      {!isAdmin && (
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>Only an admin can change who a lead is assigned to.</div>
      )}
    </Modal>
  );
}
