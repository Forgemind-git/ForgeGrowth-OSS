/* ══════════════════════════════════════════════════════════════════════
   Simulator kit — the ONE look every WhatsApp preview in the app shares.

   It is the automation flow builder's simulator (AutomationBuilderView's
   SimPanel) taken apart into reusable pieces, so the AI-agent test chat, the
   template builder preview and the broadcast previews read as the same tool:

     SimShell  — the card: a header (title or Preview/Test tabs + icon
                 actions), a raised status strip, a hint line, the phone.
     PhoneFrame— the dark phone with the notch strip, chat header, wallpaper
                 and composer.
     Bubble    — one chat bubble. Business messages arrive on the LEFT in the
                 incoming colour; the customer's own messages sit on the right
                 in the outgoing green — exactly what the customer sees.
     ChatDay / ChatNote / ChatEmpty — the small in-chat labels.

   Change the look HERE. A preview that draws its own phone or bubbles is how
   these drifted apart in the first place.
   ══════════════════════════════════════════════════════════════════════ */
import { RotateCcw, X } from 'lucide-react';
import { FONT, MONO } from '../../constants.js';
import PillStrip from '../PillStrip.jsx';

// Surface tokens. --fs-* are defined for `.fg-flow, .fg-sim` in styles/forge.css.
export const SIM = {
  card: 'var(--fs-node-bg)',
  cardShadow: '0 0 0 1px var(--fs-node-ring), var(--fs-node-shadow)',
  raised: 'var(--fc-raised)',
  surface: 'var(--fc-surface)',
  surface2: 'var(--fc-surface-2)',
  text: 'var(--fc-text)',
  text2: 'var(--fc-text-secondary)',
  muted: 'var(--fc-text-muted)',
  primary: 'var(--fc-primary)',
  onAccent: 'var(--fc-on-accent)',
  green: 'var(--fc-green)',
  amber: 'var(--fc-amber)',
};

// Chat tokens — the phone's own colours.
export const WA = {
  phoneFont: "-apple-system, 'SF Pro Display', system-ui, sans-serif",
  incoming: 'var(--c-chatIncoming, #fff)',
  outgoing: 'var(--c-sdcf8c6, #DCF8C6)',
  text: 'var(--c-t1, #111)',
  time: 'var(--c-s667781, #667781)',
  link: 'var(--c-s027eb5, #027EB5)',
  button: '#00A5F4',
  shadow: '0 1px 1px rgba(0,0,0,.07)',
  divider: '1px solid rgba(0,0,0,.06)',
};

export const nowHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/* ── icon button (same shape as the flow builder's IconBtn) ─────────── */
export function SimIconBtn({ children, onClick, title, disabled, style, ...rest }) {
  return (
    <button
      type="button" {...rest} onClick={onClick} title={title} aria-label={title} disabled={disabled}
      style={{
        width: 30, height: 30, border: 'none', background: SIM.surface, borderRadius: 999,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, color: SIM.text2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
        ...style,
      }}
    >{children}</button>
  );
}
export const RestartBtn = (props) => <SimIconBtn title="Start over" {...props}><RotateCcw size={14} /></SimIconBtn>;
export const CloseBtn = (props) => <SimIconBtn title="Close preview" {...props}><X size={14} /></SimIconBtn>;

/* ── the card ───────────────────────────────────────────────────────── */
/**
 * @param title    plain heading when there are no tabs
 * @param tabs     [{id,label}] → a PillStrip (tab / onTab control it)
 * @param actions  nodes on the right of the header (SimIconBtn etc.)
 * @param bar      extra controls inside the raised strip (play, speed…)
 * @param status   left text of the strip;  meta = right text (mono)
 * @param hint     one muted line above the phone
 * @param fill     stretch to the parent's height (the phone grows with it)
 * @param body     'phone' (default) centres children; 'raw' renders them as-is
 */
export function SimShell({
  title, tabs, tab, onTab, actions, bar, status, meta, hint, children, footer,
  width = 340, fill = false, body = 'phone', testId, style,
}) {
  const strip = bar || status != null || meta != null;
  return (
    <div className="fg-sim" data-testid={testId} style={{
      width, maxWidth: '100%', ...(fill ? { height: '100%', minHeight: 0 } : null),
      background: SIM.card, borderRadius: 16, boxShadow: SIM.cardShadow,
      display: 'flex', flexDirection: 'column', fontFamily: FONT, overflow: 'hidden',
      flexShrink: 0, boxSizing: 'border-box', ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px', flexShrink: 0, minHeight: 30 }}>
        {tabs
          ? <PillStrip size="sm" value={tab} onChange={onTab} items={tabs} />
          : <span style={{ fontSize: 13.5, fontWeight: 700, color: SIM.text, paddingLeft: 4 }}>{title}</span>}
        <span style={{ flex: 1 }} />
        {actions}
      </div>

      {strip && (
        <div style={{ margin: '0 12px 10px', background: SIM.raised, borderRadius: 12, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
          {bar}
          {(status != null || meta != null) && (
            <div style={{ width: '100%', fontSize: 11.5, color: SIM.muted, display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: bar ? 2 : 0 }}>
              <span data-testid="sim-status">{status}</span>
              <span style={{ fontFamily: MONO }}>{meta}</span>
            </div>
          )}
        </div>
      )}

      {body === 'raw' ? children : (
        <div style={fill
          ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 12px 14px' }
          : { padding: '0 12px 14px' }}>
          {hint && <div style={{ fontSize: 12, color: SIM.muted, textAlign: 'center', lineHeight: 1.4, marginBottom: 10, flexShrink: 0 }}>{hint}</div>}
          <div style={fill
            ? { flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }
            : { display: 'flex', justifyContent: 'center' }}>
            {children}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}

/* ── the phone ──────────────────────────────────────────────────────── */
// `height` is the whole phone's height; the chat body scrolls inside it so
// nothing ever spills out. `inputBar` swaps the static composer for a real
// one; `bodyRef` exposes the scroller so callers can follow new messages.
export function PhoneFrame({
  children, headerTitle = 'Your Business', headerSubtitle = 'online',
  height = 620, width = 300, inputBar, bodyRef, bodyTestId, avatar,
}) {
  const initial = (avatar || headerTitle || 'F').trim().charAt(0).toUpperCase() || 'F';
  return (
    <div data-testid="sim-phone" style={{
      width, maxWidth: '100%', height, background: '#1d2027', borderRadius: 46, padding: 10,
      boxShadow: '0 18px 40px rgba(0,0,0,.18)', boxSizing: 'border-box', flexShrink: 0, margin: '0 auto',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ background: '#075E54', borderRadius: 37, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative', fontFamily: WA.phoneFont }}>
        {/* status strip + notch */}
        <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', flexShrink: 0, color: '#fff', fontSize: 13, fontWeight: 650 }}>
          <span>{nowHM()}</span>
          <span style={{ width: 74, height: 20, borderRadius: 12, background: '#111' }} />
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <svg width="15" height="10" viewBox="0 0 17 11"><rect x="0" y="6.5" width="3" height="4.5" rx=".7" fill="#fff"/><rect x="4" y="4.5" width="3" height="6.5" rx=".7" fill="#fff"/><rect x="8" y="2.5" width="3" height="8.5" rx=".7" fill="#fff"/><rect x="12" y=".5" width="3" height="10.5" rx=".7" fill="#fff"/></svg>
            <svg width="22" height="11" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3" fill="none" stroke="#fff" strokeOpacity=".45"/><rect x="24.5" y="4" width="1.5" height="5" rx=".6" fill="#fff" fillOpacity=".45"/><rect x="2" y="2" width="20" height="9" rx="1.7" fill="#fff"/></svg>
          </span>
        </div>
        {/* chat header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 10px', color: '#fff', flexShrink: 0 }}>
          <span style={{ fontSize: 22, lineHeight: 1, opacity: .9, marginRight: -2 }}>‹</span>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: SIM.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</div>
            <div style={{ fontSize: 11.5, opacity: .82, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerSubtitle}</div>
          </div>
          <svg width="20" height="14" viewBox="0 0 20 14"><rect x=".5" y="1.5" width="13" height="11" rx="2.5" fill="none" stroke="#fff" strokeWidth="1.4"/><path d="M14 5.5 L19 3 L19 11 L14 8.5 Z" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round"/></svg>
          <svg width="15" height="15" viewBox="0 0 15 15"><path d="M3 1 L5 1 L6.5 4.5 L5 6 C 6 8, 7 9, 9 10 L 10.5 8.5 L 14 10 L 14 12 C 14 13, 13 14, 12 14 C 6 14, 1 9, 1 3 C 1 2, 2 1, 3 1 Z" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round"/></svg>
        </div>

        <div ref={bodyRef} data-testid={bodyTestId} style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--c-chatWall)', backgroundImage: 'var(--c-chatPattern)', padding: '10px 8px', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>

        {/* composer + home indicator */}
        <div style={{ background: 'var(--c-xf0f0f0, #F0F0F0)', flexShrink: 0, position: 'relative' }}>
          {inputBar || (
            <div style={{ padding: '7px 9px 20px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, background: 'var(--c-surface, #fff)', borderRadius: 99, padding: '7px 12px', fontSize: 12.5, color: 'var(--c-t7, #999)', fontFamily: FONT }}>Message</div>
              <div style={{ width: 30, height: 30, background: 'var(--c-waGreen, #25D366)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9 22,2" fill="currentColor" stroke="none"/></svg>
              </div>
            </div>
          )}
          <div style={{ position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)', width: 110, height: 4, background: '#111', borderRadius: 99, opacity: .85, pointerEvents: 'none' }} />
        </div>
      </div>
    </div>
  );
}

/* ── in-chat pieces ─────────────────────────────────────────────────── */
export function ChatDay({ label = 'TODAY' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, flexShrink: 0 }}>
      <span style={{ background: 'var(--c-infoBg, #E1F2FA)', color: 'var(--c-s3c6678, #3C6678)', fontSize: 11, padding: '2px 9px', borderRadius: 99, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

// A system line in the chat (the flow builder uses these for waits/skips).
export function ChatNote({ children, tone = 'warn' }) {
  const t = tone === 'error'
    ? { bg: 'var(--c-dangerBg, #FCEBEB)', fg: 'var(--c-dangerText, #A32D2D)' }
    : { bg: 'var(--c-warnBgSoft, #FFF8E1)', fg: 'var(--c-s7a5c00, #7A5C00)' };
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0', flexShrink: 0 }}>
      <div style={{ background: t.bg, color: t.fg, fontSize: 11, padding: '3px 10px', borderRadius: 10, fontWeight: 600, maxWidth: '90%', textAlign: 'center', lineHeight: 1.4, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

export function ChatEmpty({ children }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 12, color: WA.time, padding: '24px 14px', lineHeight: 1.5, whiteSpace: 'pre-line', fontFamily: FONT }}>
      {children}
    </div>
  );
}

export const bubbleText = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' };

/**
 * One bubble.
 * @param from     'bot' (business → left, incoming) | 'user' (customer → right, green)
 * @param media    node drawn edge-to-edge above the text (image, video…)
 * @param buttons  [{label, icon?, onClick?, disabled?}] — WhatsApp reply/URL buttons
 * @param below    small caption under the bubble (e.g. "Template · name")
 */
export function Bubble({ from = 'bot', media, children, buttons, time, below, maxWidth = '82%', testId }) {
  const isUser = from === 'user';
  const hasBody = children != null && children !== false && children !== '';
  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', marginBottom: 4, flexShrink: 0 }}>
      <div style={{
        background: isUser ? WA.outgoing : WA.incoming,
        borderRadius: isUser ? '8px 0 8px 8px' : '0 8px 8px 8px',
        maxWidth, fontSize: 13, color: WA.text, lineHeight: 1.4, overflow: 'hidden',
        boxShadow: WA.shadow, fontFamily: FONT,
      }}>
        {media && <div style={{ padding: 3 }}>{media}</div>}
        <div style={{ padding: media && !hasBody ? '0 9px 4px' : '5px 9px' }}>
          {hasBody && <div style={bubbleText}>{children}</div>}
          <div style={{ fontSize: 11, color: WA.time, textAlign: 'right', marginTop: 2 }}>{time || nowHM()}</div>
        </div>
        {buttons && buttons.length > 0 && buttons.map((b, i) => (
          <button key={i} type="button" onClick={b.onClick} disabled={b.disabled || !b.onClick}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
              padding: '8px 9px', border: 'none', borderTop: WA.divider, color: WA.button, fontSize: 13,
              fontWeight: 600, background: 'transparent', fontFamily: 'inherit',
              cursor: b.onClick && !b.disabled ? 'pointer' : 'default', opacity: b.disabled ? 0.4 : 1,
            }}>
            {b.icon}{b.label}
          </button>
        ))}
      </div>
      {below && <div style={{ fontSize: 11, color: WA.time, marginTop: 3, padding: '0 2px', fontFamily: FONT }}>{below}</div>}
    </div>
  );
}

// Media drawn inside a bubble (edge-to-edge, rounded to the bubble).
export const mediaStyle = { display: 'block', width: '100%', maxWidth: 236, borderRadius: 6 };

export function DocChip({ name, kind = 'PDF', href }) {
  const inner = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--c-surfaceInner, #F5F5F0)', borderRadius: 6, padding: '6px 8px', minWidth: 170 }}>
      <div style={{ width: 28, height: 34, background: 'var(--c-surface, #fff)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 1px 2px rgba(0,0,0,.15)', fontSize: 9, fontWeight: 800, color: '#e94235' }}>{String(kind).slice(0, 4)}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: WA.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name || 'Document'}</div>
        <div style={{ fontSize: 11, color: WA.time, textTransform: 'uppercase' }}>{kind}</div>
      </div>
    </div>
  );
  return href ? <a href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>{inner}</a> : inner;
}
