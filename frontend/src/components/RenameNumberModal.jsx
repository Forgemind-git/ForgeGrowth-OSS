import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, maskPhone } from '../constants.js';

// Rename a WhatsApp business number — DISPLAY LABEL ONLY (migration 133).
// The real number, its Meta id and Meta's verified name never change; the
// label is what every list and "send from" picker shows. Blank = go back to
// the account name. Shared by Chats → WhatsApp Numbers and Admin Settings →
// WhatsApp Accounts, so the two places cannot word or validate it differently.
export const LABEL_MAX = 60;

export default function RenameNumberModal({ accountId, phone, currentLabel, accountName, onClose, onSaved }) {
  const [value, setValue] = useState(currentLabel || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (next) => {
    setSaving(true); setError('');
    try {
      const saved = await api.whatsappAccounts.setLabel(accountId, next);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not rename this number.');
    } finally {
      setSaving(false);
    }
  };

  const tooLong = value.trim().length > LABEL_MAX;
  const unchanged = value.trim() === (currentLabel || '').trim();

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div role="dialog" aria-label="Rename number" style={{
        width: 440, maxWidth: '100%', background: 'var(--c-cardBg)', color: C.text,
        borderRadius: 16, padding: 20, fontFamily: FONT, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Rename number</span>
          <button onClick={onClose} title="Close" style={{
            border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
            width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
          Number {maskPhone(phone)}{accountName ? <> · account “{accountName}”</> : null}.
          The label only changes what this app shows. The phone number and the name customers see on WhatsApp stay the same.
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (!tooLong && !saving) save(value.trim() || null); }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: C.t3 || C.textMuted, display: 'block', marginBottom: 6 }}>
            Label
          </label>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={accountName || 'e.g. Acme – Sales desk'}
            maxLength={LABEL_MAX + 20}
            style={{
              width: '100%', boxSizing: 'border-box', height: 42, padding: '0 12px', fontSize: 15,
              fontFamily: FONT, color: C.text, background: 'var(--c-inputBg, var(--c-cardBg))',
              border: `1px solid ${tooLong ? 'var(--c-dangerText)' : C.borderDark}`, borderRadius: 10, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: tooLong ? 'var(--c-dangerText)' : C.textMuted, marginTop: 6 }}>
            <span>{tooLong ? `Keep it to ${LABEL_MAX} characters.` : 'Leave blank to use the account name.'}</span>
            <span>{value.trim().length}/{LABEL_MAX}</span>
          </div>
          {error && <div style={{ marginTop: 10, fontSize: 14, color: 'var(--c-dangerText)' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 18 }}>
            <button type="button" disabled={saving || !currentLabel} onClick={() => save(null)} style={btn(false, saving || !currentLabel)}>
              Use account name
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={onClose} style={btn(false, false)}>Cancel</button>
              <button type="submit" disabled={saving || tooLong || unchanged} style={btn(true, saving || tooLong || unchanged)}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function btn(primary, disabled) {
  return {
    height: 38, padding: '0 14px', borderRadius: 10, fontSize: 14, fontWeight: 600, fontFamily: FONT,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: primary ? 'none' : `1px solid ${C.borderDark}`,
    background: primary ? C.primary : 'transparent', color: primary ? '#fff' : C.text,
  };
}
