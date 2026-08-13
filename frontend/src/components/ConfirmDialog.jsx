import { useState, useCallback } from 'react';
import { C, FONT } from '../constants.js';

export function useConfirm() {
  const [state, setState] = useState(null);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  const handleConfirm = () => {
    state?.resolve(true);
    setState(null);
  };

  const handleCancel = () => {
    state?.resolve(false);
    setState(null);
  };

  const el = state ? (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
      <div style={{ background: C.cardBg, borderRadius: 14, padding: '24px 24px 20px', width: 360, boxShadow: C.shadowLg }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>{state.title}</div>
        <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>{state.body}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={handleCancel}
            style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, color: C.textSecondary, fontFamily: FONT }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: state.danger ? C.primary : C.purple, color: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 600, fontFamily: FONT }}
          >
            {state.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [el, confirm];
}

export default function ConfirmDialog({ state, onConfirm, onCancel }) {
  if (!state) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
      <div style={{ background: C.cardBg, borderRadius: 14, padding: '24px 24px 20px', width: 360, boxShadow: C.shadowLg }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>{state.title}</div>
        <div style={{ fontSize: 15, color: C.textSecondary, marginBottom: 20, lineHeight: 1.5 }}>{state.body}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, color: C.textSecondary }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: state.danger ? C.primary : C.purple, color: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 600 }}>{state.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
