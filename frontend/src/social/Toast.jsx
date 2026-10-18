import { useState, useEffect } from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { C, FONT } from './constants.js';

let toastId = 0;
const listeners = new Set();

function notify(toast) {
  listeners.forEach(fn => fn(toast));
}

export function showToast(message, type = 'info') {
  notify({ id: ++toastId, message, type });
}

// Toasts are dark name-plates (constant in both themes) with a coloured status icon.
const ICONS = { success: [CheckCircle2, C.green], error: [AlertCircle, '#FCA5A5'], warning: [AlertTriangle, '#FBBF24'], info: [Info, '#93C5FD'] };

export default function Toast() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const fn = (t) => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id));
      }, 3200);
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 2000, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map(t => {
        const [Icon, color] = ICONS[t.type] || ICONS.info;
        return (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: C.plate, color: C.plateText,
            borderRadius: 16, padding: '12px 16px', fontSize: 14, fontWeight: 600, lineHeight: 1.45,
            fontFamily: FONT, boxShadow: C.shadowLg, animation: 'fc-pop-in .2s ease-out both',
            minWidth: 240, maxWidth: 380, backdropFilter: 'blur(6px)',
          }}>
            <Icon size={17} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ minWidth: 0 }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
