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
        // 46x26 with a 19px knob — the app's one switch shape. ON is the
        // ACCENT, not green: there is a single saturated colour in this design
        // and green is reserved for status. No glow ring: state is the fill.
        width: 46, height: 26, borderRadius: 999, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? C.primary : 'var(--c-fillMuted, #d5d5d0)',
        position: 'relative', transition: 'background .15s',
        opacity: disabled ? 0.6 : 1, padding: 0, flexShrink: 0,
      }}
    >
      <span style={{
        // The knob is white in BOTH themes — it reads against the accent and
        // against the neutral off-track alike, which a themed surface token
        // does not (it goes near-black on dark and vanishes on the red).
        position: 'absolute', top: 3.5, left: checked ? 23.5 : 3.5, width: 19, height: 19,
        borderRadius: 999, background: '#fff', transition: 'left .15s',
        boxShadow: '0 1px 3px rgba(0,0,0,.28)',
      }} />
    </button>
  );
}
