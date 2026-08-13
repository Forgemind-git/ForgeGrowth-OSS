import { C } from '../constants.js';

// Shared on/off switch — { checked, onChange(nextBool), disabled }. Same
// contract as AdminSettingsPage's file-local Toggle (onChange receives the NEW
// boolean). Two local copies already exist (AdminSettingsPage, CapiCustomerInfo
// with a different prop name); new pages should import THIS one rather than
// adding a fourth.
export default function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!checked} disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 38, height: 22, borderRadius: 999, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? C.green : 'var(--c-borderStrong, #cfcfca)',
        position: 'relative', transition: 'background .15s',
        opacity: disabled ? 0.6 : 1, padding: 0, flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2, width: 18, height: 18,
        borderRadius: 999, background: 'var(--c-surface, #fff)', transition: 'left .15s',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)',
      }} />
    </button>
  );
}
