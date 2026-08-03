// App-level host for the global feedback bus (lib/feedback.js). Renders a single
// centered modal for errors / successes / info — the replacement for native
// alert() popups across ForgeChat. Mount once near the App root.
import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { C, FONT } from '../constants.js';
import { _subscribe } from '../lib/feedback.js';

const VARIANTS = {
  error:   { color: '#A32D2D', bg: '#FCEBEB', Icon: AlertCircle,  title: 'Something went wrong' },
  success: { color: '#0F6E56', bg: '#E1F5EE', Icon: CheckCircle2, title: 'Done' },
  info:    { color: '#1D4ED8', bg: '#E8F0FE', Icon: Info,         title: 'Notice' },
};

export default function FeedbackModal() {
  const [entry, setEntry] = useState(null);

  useEffect(() => _subscribe(setEntry), []);

  useEffect(() => {
    if (!entry) return;
    const onKey = (e) => { if (e.key === 'Escape') setEntry(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry]);

  if (!entry) return null;
  const v = VARIANTS[entry.variant] || VARIANTS.error;
  const Icon = v.Icon;
  const close = () => setEntry(null);

  return (
    <div
      onClick={close}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 4000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        style={{
          background: 'var(--c-cardBg, #ffffff)', borderRadius: 14, boxShadow: C.shadowLg,
          width: '100%', maxWidth: 420, fontFamily: FONT, overflow: 'hidden',
        }}
      >
        <div style={{ padding: '22px 22px 18px', display: 'flex', gap: 14 }}>
          <div style={{
            flexShrink: 0, width: 40, height: 40, borderRadius: 10, background: v.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={20} color={v.color} strokeWidth={2.2} />
          </div>
          <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 5 }}>
              {entry.title || v.title}
            </div>
            <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {entry.message}
            </div>
          </div>
          <button
            onClick={close}
            aria-label="Close"
            style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, padding: 2, height: 'fit-content' }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: '0 22px 20px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={close}
            autoFocus
            style={{
              padding: '9px 22px', borderRadius: 9, border: 'none', cursor: 'pointer',
              fontFamily: FONT, fontSize: 13, fontWeight: 700, background: v.color, color: '#fff',
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
