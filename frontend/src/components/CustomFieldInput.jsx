// One input widget for a registry custom field, switched on its fieldType —
// shared by the Sales Log's Add Sale / Add Transaction / edit forms. Values
// are stored as strings (arrays for checkbox, boolean for Yes/No), matching
// what the JSONB bag and the variable resolver expect.

import { C, FONT, MONO } from '../constants.js';
import SearchableSelect from './SearchableSelect.jsx';
import Toggle from './Toggle.jsx';
import { inputStyle } from '../pages/academy/shared.jsx';

export default function CustomFieldInput({ field, value, onChange }) {
  const type = field.fieldType;

  if (type === 'dropdown' || type === 'radio') {
    return (
      <SearchableSelect
        value={value ?? ''}
        onChange={onChange}
        options={[{ value: '', label: '— Not set —' }, ...(field.options || []).map(o => ({ value: o, label: o }))]}
        placeholder="— Not set —"
      />
    );
  }

  if (type === 'checkbox') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (opt) => onChange(arr.includes(opt) ? arr.filter(x => x !== opt) : [...arr, opt]);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', padding: '4px 0' }}>
        {(field.options || []).map(opt => (
          <label key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontFamily: FONT, color: C.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={arr.includes(opt)} onChange={() => toggle(opt)} />
            {opt}
          </label>
        ))}
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <div style={{ padding: '4px 0' }}>
        <Toggle checked={value === true} onChange={onChange} />
      </div>
    );
  }

  if (type === 'textarea') {
    return (
      <textarea rows={2} value={value ?? ''} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT }} placeholder={field.placeholder || ''} />
    );
  }

  const htmlType = type === 'number' ? 'number' : type === 'date' ? 'date' : type === 'email' ? 'email' : 'text';
  return (
    <input type={htmlType} value={value ?? ''} onChange={e => onChange(e.target.value)}
      style={{ ...inputStyle, ...(type === 'number' || type === 'phone' ? { fontFamily: MONO } : {}) }}
      placeholder={field.placeholder || ''} />
  );
}
