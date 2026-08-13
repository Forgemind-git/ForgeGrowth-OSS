// Field manager for one registry entity — the admin UI behind Admin Settings →
// Fields → "Leads & Sales Log" / "Transactions" (migration 097).
//
// System rows (the built-in columns) can be relabelled, have their dropdown
// options edited, be shown/hidden per table and reordered — never deleted or
// re-typed. Custom rows are fully editable; deleting one is a SOFT delete that
// keeps every stored value and reserves the key forever (restoring brings the
// values back), and the confirm copy says exactly that.

import { useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, Lock } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';
import { showError, showSuccess } from '../lib/feedback.js';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import SearchableSelect from './SearchableSelect.jsx';
import Toggle from './Toggle.jsx';
import { useFieldRegistry, refreshFieldRegistry } from '../hooks/useFieldRegistry.js';
import { Button, Badge, Field, inputStyle, Modal, EmptyState } from '../pages/academy/shared.jsx';

const FIELD_TYPE_OPTS = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Multiple choice' },
  { value: 'checkbox', label: 'Checkboxes (multi)' },
  { value: 'boolean', label: 'Yes / No' },
];
const NEEDS_OPTIONS = ['dropdown', 'radio', 'checkbox'];

const typeBadge = {
  text: { c: 'var(--c-s1d4ed8, #1D4ED8)', bg: 'var(--c-infoBg, #E8EFFF)' }, textarea: { c: 'var(--c-s1d4ed8, #1D4ED8)', bg: 'var(--c-infoBg, #E8EFFF)' },
  email: { c: 'var(--c-s7a5500, #7A5500)', bg: 'var(--c-warnBgSoft, #FFF8E1)' }, phone: { c: 'var(--c-s7a5500, #7A5500)', bg: 'var(--c-warnBgSoft, #FFF8E1)' },
  number: { c: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E3F5EF)' }, date: { c: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E3F5EF)' },
  dropdown: { c: 'var(--c-s6d28d9, #6D28D9)', bg: 'var(--c-purpleBg, #F1EBFF)' }, radio: { c: 'var(--c-s6d28d9, #6D28D9)', bg: 'var(--c-purpleBg, #F1EBFF)' },
  checkbox: { c: 'var(--c-s6d28d9, #6D28D9)', bg: 'var(--c-purpleBg, #F1EBFF)' }, boolean: { c: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' },
};

const th = { textAlign: 'left', fontSize: 13, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', padding: '8px 8px', whiteSpace: 'nowrap' };
const td = { padding: '9px 8px', fontSize: 15, fontFamily: FONT, verticalAlign: 'middle' };
const iconBtn = { background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '4px 6px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' };

/**
 * `surface` splits the lead registry into the two TABLES it drives.
 *
 * A sale IS an enrolled lead, so both tables read the same `entity='lead'`
 * rows — but which columns each one shows is two independent flags
 * (`show_in_leads` / `show_in_sales`). They used to share one section with two
 * toggle columns, which made "add a column to the Sales Log" a job of finding
 * the right one of two switches on the right row. Now each table is its own
 * section with ONE switch, and adding a field from inside a section turns that
 * section's flag on by default.
 *
 * The list is deliberately NOT filtered to the fields already shown — you
 * cannot switch on a column you cannot see.
 */
export default function EntityFieldsManager({ entity, surface = null }) {
  const isLead = entity === 'lead';
  // Which flag this section owns. Transactions have only ever had one.
  const flagKey = surface === 'leads' ? 'showInLeads' : 'showInSales';
  const reg = useFieldRegistry();
  const fields = isLead ? reg.lead : reg.transaction;
  const [modal, setModal] = useState(null); // { field? } — null closed, {} = add
  const [confirmEl, confirm] = useConfirm();

  const mutate = async (fn, okMsg) => {
    try { await fn(); if (okMsg) showSuccess(okMsg); await refreshFieldRegistry(); }
    catch (e) { showError(e.message); }
  };

  const move = (idx, dir) => {
    const next = fields.slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    // Fallback rows (failed registry load) have id null — nothing to persist.
    if (next.some(f => f.id == null)) return;
    mutate(() => api.entityFields.reorder(entity, next.map(f => f.id)));
  };

  const setShow = (f, key, val) => {
    if (f.id == null) return showError('Fields are still loading — try again in a moment.');
    mutate(() => api.entityFields.update(f.id, { [key]: val }));
  };

  const remove = async (f) => {
    const ok = await confirm({
      title: 'Delete field',
      body: `Delete "${f.label}"? Values already stored under it are KEPT (hidden, not erased) and the internal name "${f.fieldKey}" stays reserved — restoring the field brings the values back. Steps or forms using {{lead.${f.fieldKey}}} will stop resolving.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    mutate(() => api.entityFields.delete(f.id), 'Field deleted (values kept)');
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT, maxWidth: 560 }}>
          {!isLead
            ? 'Fields of one transaction (installment) — shown in the sale detail’s transactions table and the Add Transaction form.'
            : surface === 'leads'
              ? 'Columns of the Leads list. A sale is an enrolled lead, so these are the same underlying fields the Sales Log uses — the switch here only controls what the Leads list shows. Built-in fields can be renamed and hidden, never deleted.'
              : 'Columns of the Sales Log. Same underlying fields as the Leads list; the switch here only controls what the Sales Log shows. Built-in fields can be renamed and hidden, never deleted.'}
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setModal({})}>Add field</Button>
      </div>

      {fields.length === 0 ? <EmptyState title="No fields" /> : (
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                <th style={{ ...th, width: 60 }} />
                <th style={th}>Field</th>
                <th style={th}>Type</th>
                <th style={th}>Options</th>
                <th style={{ ...th, textAlign: 'center' }}>Shown</th>
                <th style={{ ...th, width: 90, textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {fields.map((f, idx) => (
                <tr key={f.fieldKey} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', gap: 3 }}>
                      <button title="Move up" style={iconBtn} onClick={() => move(idx, -1)} disabled={idx === 0}><ChevronUp size={13} /></button>
                      <button title="Move down" style={iconBtn} onClick={() => move(idx, +1)} disabled={idx === fields.length - 1}><ChevronDown size={13} /></button>
                    </span>
                  </td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontWeight: 600 }}>{f.label}</span>
                      {f.isSystem && <Lock size={12} color={C.textMuted} title="Built-in field — rename/hide only" />}
                    </span>
                    <div style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO }}>{f.fieldKey}</div>
                  </td>
                  <td style={td}>
                    <Badge label={FIELD_TYPE_OPTS.find(o => o.value === f.fieldType)?.label || f.fieldType}
                      color={(typeBadge[f.fieldType] || typeBadge.text).c}
                      bg={(typeBadge[f.fieldType] || typeBadge.text).bg} />
                  </td>
                  <td style={{ ...td, color: C.textSecondary, fontSize: 14, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {NEEDS_OPTIONS.includes(f.fieldType)
                      ? (f.options?.length ? f.options.join(' · ') : <span style={{ color: C.textMuted }}>from app config</span>)
                      : '—'}
                  </td>
                  {/* One switch, owning only this section's flag. */}
                  <td style={{ ...td, textAlign: 'center' }}>
                    <span style={{ display: 'inline-flex' }}>
                      <Toggle checked={!!f[flagKey]} onChange={v => setShow(f, flagKey, v)} />
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button title="Edit field" style={iconBtn} onClick={() => setModal({ field: f })}><Pencil size={13} /></button>{' '}
                    {!f.isSystem && (
                      <button title="Delete field" style={{ ...iconBtn, color: C.primary }} onClick={() => remove(f)}><Trash2 size={13} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <FieldModal entity={entity} field={modal.field} isLead={isLead} surface={surface}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refreshFieldRegistry(); }} />
      )}
      {confirmEl}
    </div>
  );
}

function FieldModal({ entity, field, isLead, surface, onClose, onSaved }) {
  const editing = !!field;
  const system = field?.isSystem === true;
  const [label, setLabel] = useState(field?.label || '');
  const [fieldType, setFieldType] = useState(field?.fieldType || 'text');
  const [optionsText, setOptionsText] = useState((field?.options || []).join('\n'));
  const [required, setRequired] = useState(field?.required === true);
  // A NEW field defaults to being shown on the table you added it from — a
  // field that appears nowhere after you create it reads as a failed save.
  // Both switches stay available so one field can serve both tables.
  const [showInLeads, setShowInLeads] = useState(field ? field.showInLeads : (isLead && surface === 'leads'));
  const [showInSales, setShowInSales] = useState(field ? field.showInSales : (!isLead || surface === 'sales'));
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  const needsOptions = NEEDS_OPTIONS.includes(fieldType);
  // Source/stage options come from the funnel config, not this registry —
  // hide the options editor for those two system rows so nobody edits a list
  // that nothing reads.
  const optionsFromAppConfig = system && ['source', 'stage'].includes(field?.fieldKey);

  const save = async () => {
    if (!label.trim()) return showError('A field needs a label');
    const options = optionsText.split('\n').map(s => s.trim()).filter(Boolean);
    if (needsOptions && !optionsFromAppConfig && !options.length) return showError('Add at least one option (one per line)');
    setSaving(true);
    try {
      if (editing) {
        const body = { label: label.trim(), required, showInLeads, showInSales };
        if (!system) body.fieldType = fieldType;
        if (needsOptions && !optionsFromAppConfig) body.options = options;
        await api.entityFields.update(field.id, body);
      } else {
        await api.entityFields.create({ entity, label: label.trim(), fieldType, options, required, showInLeads, showInSales });
      }
      showSuccess(editing ? 'Field updated' : 'Field added');
      onSaved();
    } catch (e) {
      const restorableId = e.body?.restorableId;
      if (restorableId != null) {
        // A soft-deleted field owns this name — offer the restore instead of
        // minting a new field that would inherit the old values.
        setSaving(false);
        const ok = await confirm({
          title: 'Restore the old field?',
          body: e.message, confirmLabel: 'Restore field',
        });
        if (!ok) return;
        try { await api.entityFields.restore(restorableId); showSuccess('Field restored — its old values are visible again'); onSaved(); }
        catch (e2) { showError(e2.message); }
        return;
      }
      showError(e.message);
    } finally { setSaving(false); }
  };

  return (
    <Modal title={editing ? `Edit field — ${field.label}` : 'Add field'} onClose={onClose} width={480}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Add field'}</Button>
      </>}>
      <Field label="Label" hint={editing ? `Internal name stays "${field.fieldKey}" — renaming never breaks stored values or variables.` : 'The internal name is minted from this once and never changes.'}>
        <input autoFocus value={label} onChange={e => setLabel(e.target.value)} style={inputStyle} placeholder="e.g. Batch, Counselor, GST invoice no." />
      </Field>
      <Field label="Type" hint={system ? 'Built-in fields keep their type.' : undefined}>
        {system ? (
          <div style={{ ...inputStyle, background: C.pageBg, color: C.textSecondary }}>{FIELD_TYPE_OPTS.find(o => o.value === fieldType)?.label || fieldType}</div>
        ) : (
          <SearchableSelect value={fieldType} onChange={setFieldType} options={FIELD_TYPE_OPTS} />
        )}
      </Field>
      {needsOptions && !optionsFromAppConfig && (
        <Field label="Options" hint="One per line — these become the dropdown/choice values everywhere the field appears.">
          <textarea rows={4} value={optionsText} onChange={e => setOptionsText(e.target.value)}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} placeholder={'Option A\nOption B'} />
        </Field>
      )}
      {optionsFromAppConfig && (
        <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT, margin: '2px 0 12px' }}>
          This field&rsquo;s options are managed in Admin Settings → Funnel.
        </div>
      )}
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
        {isLead && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontFamily: FONT, color: C.text }}>
            <Toggle checked={showInLeads} onChange={setShowInLeads} /> Show on Leads
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontFamily: FONT, color: C.text }}>
          <Toggle checked={showInSales} onChange={setShowInSales} /> {isLead ? 'Show on Sales Log' : 'Show in transactions table'}
        </label>
        {!system && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontFamily: FONT, color: C.text }}>
            <Toggle checked={required} onChange={setRequired} /> Required
          </label>
        )}
      </div>
      {confirmEl}
    </Modal>
  );
}
