import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Mail, X, Sparkles, ArrowUpRight } from 'lucide-react';
import { C, FONT, MONO } from '../constants.js';

// "Want it customised?" — the way someone running the open-source build reaches
// Forgemind. One definition of the contact details, used by the card above the
// sidebar's Collapse control and by the button beside the avatar in the top bar
// (the only entry point on a phone, where the sidebar is a bottom tab bar).
const EMAIL = 'contact@forgemind.in';
const WHATSAPP = '919342245724';
const WHATSAPP_LABEL = '+91 93422 45724';
const WHATSAPP_TEXT = "Hi Forgemind! I'm using Forge Growth and I'd like to customise it for my business. Can we talk?";
const EMAIL_SUBJECT = 'Customising Forge Growth';
const EMAIL_BODY = "Hi Forgemind team,\n\nI'm using the open-source Forge Growth and I'd like to customise it for my business.\n\nWhat I'm looking for:\n\n\nThanks,\n";

const WHATSAPP_URL = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(WHATSAPP_TEXT)}`;
const MAIL_URL = `mailto:${EMAIL}?subject=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(EMAIL_BODY)}`;

// lucide-react ships no brand marks, so the WhatsApp glyph is drawn here.
export function WhatsAppGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2zm5.8 14.1c-.24.68-1.42 1.3-1.96 1.35-.5.05-.97.23-3.27-.68-2.77-1.09-4.52-3.92-4.66-4.1-.13-.18-1.11-1.48-1.11-2.82 0-1.34.7-2 .95-2.27.25-.27.54-.34.72-.34h.52c.17 0 .39-.06.61.47.24.56.79 1.93.86 2.07.07.14.11.3.02.48-.09.18-.14.3-.27.46-.14.16-.29.36-.41.48-.14.14-.28.29-.12.56.16.27.71 1.17 1.52 1.9 1.05.93 1.93 1.22 2.2 1.36.27.14.43.11.59-.07.16-.18.68-.79.86-1.07.18-.27.36-.23.61-.14.25.09 1.59.75 1.86.89.27.14.45.2.52.32.07.11.07.66-.17 1.33z" />
    </svg>
  );
}

function ContactRow({ href, Icon, tint, title, value, newTab }) {
  return (
    <a
      href={href}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener noreferrer' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
        borderRadius: 14, background: 'var(--fc-surface)', textDecoration: 'none',
        transition: 'background .15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--fc-surface-2)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--fc-surface)'; }}
    >
      <span style={{
        width: 38, height: 38, borderRadius: 999, flexShrink: 0, background: tint, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icon size={19} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: C.text }}>{title}</span>
        <span style={{ display: 'block', fontSize: 13, color: C.textSecondary, fontFamily: MONO, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      </span>
      <ArrowUpRight size={16} color={C.textMuted} style={{ flexShrink: 0 }} />
    </a>
  );
}

export function ContactDialog({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portalled to <body>: opened from the sidebar, a fixed overlay would
  // otherwise be trapped by the pane's own stacking context.
  return createPortal(
    <div className="fc-ui" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 400,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: FONT,
    }}>
      <div role="dialog" aria-label="Contact Forgemind" onClick={e => e.stopPropagation()} style={{
        width: 400, maxWidth: '100%', background: 'var(--fc-raised)', borderRadius: 'var(--fc-r-lg)',
        boxShadow: 'var(--fc-shadow-lg)', padding: 22, animation: 'fc-pop-in .2s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 40, height: 40, borderRadius: 999, flexShrink: 0, background: C.primary, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Sparkles size={19} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Customise Forge Growth</div>
            <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4, lineHeight: 1.5 }}>
              Need a feature, an integration or a setup built for your business? The Forgemind team can do it for you.
            </div>
          </div>
          <button type="button" title="Close" onClick={onClose} style={{
            background: 'var(--fc-surface)', border: 'none', borderRadius: 999, width: 30, height: 30, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.textSecondary,
          }}><X size={16} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
          <ContactRow href={WHATSAPP_URL} newTab Icon={WhatsAppGlyph} tint={C.waGreen} title="Chat on WhatsApp" value={WHATSAPP_LABEL} />
          <ContactRow href={MAIL_URL} Icon={Mail} tint={C.primary} title="Send an email" value={EMAIL} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// The card above the sidebar's Collapse control. Collapsed, it shrinks to a
// single icon in the rail, like every other row there.
export function SidebarContactCard({ collapsed }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Customise Forge Growth — contact Forgemind"
        style={collapsed ? {
          width: '100%', padding: '12px 0', border: 'none', borderRadius: 999, background: 'transparent',
          color: C.primary, cursor: 'pointer', display: 'flex', justifyContent: 'center', marginBottom: 2,
        } : {
          width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', marginBottom: 6,
          border: 'none', borderRadius: 16, background: 'var(--fc-surface)', cursor: 'pointer',
          textAlign: 'left', fontFamily: FONT, transition: 'background .15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = collapsed ? C.hover : 'var(--fc-surface-2)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = collapsed ? 'transparent' : 'var(--fc-surface)'; }}
      >
        {collapsed ? <Sparkles size={18} strokeWidth={2.2} /> : (
          <>
            <span style={{
              width: 32, height: 32, borderRadius: 999, flexShrink: 0, background: C.primary, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Sparkles size={16} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: C.text }}>Want it customised?</span>
              <span style={{ display: 'block', fontSize: 12.5, color: C.textSecondary, marginTop: 1 }}>Contact Forgemind</span>
            </span>
          </>
        )}
      </button>
      {open && <ContactDialog onClose={() => setOpen(false)} />}
    </>
  );
}
