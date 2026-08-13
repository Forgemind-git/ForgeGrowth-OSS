// Shared scaffolding for AI Academy pages — page shell, buttons, badges, and
// formatting. Keeps every Marketing/Sales page visually identical (blueprint §A).
import { useState } from 'react';
import { Inbox, X } from 'lucide-react';
import { C, FONT, MONO } from '../../constants.js';
import { funnelStageMeta, stageTextColor } from '../../hooks/useFunnelConfig.js';
import { useTheme } from '../../theme.jsx';

// Stage colors line up with the funnel (cool → warm → won; cold branches red-grey).
export const STAGE_META = {
  new:       { label: 'New',       color: 'var(--c-infoBright, #2563eb)', bg: 'var(--c-infoBg, #E7F0FE)' },
  contacted: { label: 'Contacted', color: 'var(--c-s7c3aed, #7c3aed)', bg: 'var(--c-purpleBg, #EEEDFE)' },
  engaged:   { label: 'Engaged',   color: 'var(--c-s0891b2, #0891b2)', bg: 'var(--c-se0f7fa, #E0F7FA)' },
  hot:       { label: 'Hot',       color: '#E8A317', bg: 'var(--c-warnBg, #FAEEDA)' },
  enrolled:  { label: 'Enrolled',  color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E1F5EE)' },
  cold_lost: { label: 'Cold / Lost', color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' },
};
export const STAGE_ORDER = ['new', 'contacted', 'engaged', 'hot', 'enrolled', 'cold_lost'];

// DEPRECATED: sources are now user-configurable — use `useFunnelConfig().sources`
// (or `funnelSourceOptions()`) instead. Kept only as an emergency fallback.
export const SOURCE_OPTIONS = ['CTWA Ad', 'Instagram', 'YouTube', 'Referral', 'Webinar', 'WhatsApp Direct'];

export function PageShell({ title, subtitle, actions, children }) {
  // Fill the whole main area at every display size — no max-width cap, no centering.
  return (
    <div style={{ padding: '22px 28px 60px', fontFamily: FONT, width: '100%', minWidth: 0, flex: 1, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.text }}>{title}</h1>
          {subtitle && <div style={{ fontSize: 15, color: C.textSecondary, marginTop: 4 }}>{subtitle}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Button({ variant = 'secondary', children, icon: Icon, ...p }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderRadius: 8, fontFamily: FONT, fontWeight: 600, fontSize: 15, cursor: p.disabled ? 'not-allowed' : 'pointer',
    padding: '9px 15px', transition: 'background .15s, opacity .15s', opacity: p.disabled ? 0.55 : 1, whiteSpace: 'nowrap',
  };
  const variants = {
    primary: { background: C.primary, color: '#fff', border: 'none' },
    secondary: { background: C.cardBg, color: C.text, border: `1.5px solid ${C.border}` },
    ghost: { background: 'transparent', color: C.textSecondary, border: 'none' },
    danger: { background: C.cardBg, color: C.primary, border: '1.5px solid #F3C6C6' },
  };
  const hoverBg = { primary: C.primaryHover, secondary: C.hover, ghost: C.hover, danger: C.primaryLight };
  const restBg = { primary: C.primary, secondary: C.cardBg, ghost: 'transparent', danger: C.cardBg };
  return (
    <button {...p} style={{ ...base, ...variants[variant], ...p.style }}
      onMouseEnter={e => { if (!p.disabled) e.currentTarget.style.background = hoverBg[variant]; }}
      onMouseLeave={e => { e.currentTarget.style.background = restBg[variant]; }}>
      {Icon && <Icon size={15} />}{children}
    </button>
  );
}

export function Badge({ label, color, bg, style }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 99, fontFamily: FONT, fontSize: 13, fontWeight: 600, color, background: bg, whiteSpace: 'nowrap', ...style }}>
      {label}
    </span>
  );
}

export function StageBadge({ stage }) {
  // Reads the live funnel config (renames/recolors reflect here); falls back to
  // the static STAGE_META for the seeded defaults before config loads.
  const m = funnelStageMeta(stage) || STAGE_META[stage] || STAGE_META.new;
  const { effective } = useTheme();
  // The stage's own colour is the TINT; the text is that hue retargeted to a
  // lightness that can actually be read on it. See stageTextColor.
  return <Badge label={m.label} color={stageTextColor(m.color, effective === 'dark')} bg={m.bg} />;
}

export function EmptyState({ Icon = Inbox, title = 'Nothing here yet', hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 20px', textAlign: 'center', fontFamily: FONT }}>
      <Icon size={38} color={C.textMuted} strokeWidth={1.5} style={{ opacity: 0.6 }} />
      <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginTop: 12 }}>{title}</div>
      {hint && <div style={{ fontSize: 15, color: C.textMuted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// Segmented control (period/range toggle).
export function Segmented({ options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', background: C.hover, borderRadius: 9, padding: 3, gap: 2 }}>
      {options.map(o => {
        const on = value === o.value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: FONT,
              fontSize: 14, fontWeight: on ? 700 : 500, background: on ? C.cardBg : 'transparent',
              color: on ? C.text : C.textSecondary, boxShadow: on ? C.shadowSm : 'none', transition: 'all .15s' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Table vs Board for All Leads.
 *
 * Rendered by BOTH LeadsPage and PipelinePage from this one definition, because
 * they are two renderings of the same tab: if each drew its own toggle they
 * would drift in wording or position and switching would feel like navigating
 * between two features, which is exactly what demoting Pipeline from a tab was
 * meant to stop.
 */
export function LeadsViewToggle({ view, onChange }) {
  if (!onChange) return null;
  return (
    <Segmented
      value={view}
      onChange={onChange}
      options={[{ value: 'list', label: 'Table' }, { value: 'board', label: 'Board' }]}
    />
  );
}

// Table shell — consistent header + row styling.
export function Table({ columns, rows, renderRow, onRowClick, empty, keyOf }) {
  if (!rows || rows.length === 0) return empty || <EmptyState />;
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 12, background: C.cardBg }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ textAlign: c.align || 'left', padding: '11px 14px', fontSize: 13, fontWeight: 700,
                letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf ? keyOf(r) : i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              style={{ cursor: onRowClick ? 'pointer' : 'default', transition: 'background .12s' }}
              onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = C.hover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              {renderRow(r, i)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, mono, align = 'left', color, bold, style }) {
  return (
    <td style={{ padding: '11px 14px', fontSize: 15, color: color || C.text, borderBottom: `1px solid ${C.border}`,
      fontFamily: mono ? MONO : FONT, textAlign: align, fontWeight: bold ? 600 : 400, whiteSpace: 'nowrap', ...style }}>
      {children}
    </td>
  );
}

export function fmtINR(n) {
  const v = Number(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(1)}K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
}

export function daysSince(ts) {
  if (!ts) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000));
}

// Small labeled input + modal shell reused by create/edit forms.
export function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'block', marginBottom: 13 }}>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textSecondary, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

export const inputStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 8, border: `1.5px solid ${C.border}`,
  fontSize: 15, fontFamily: FONT, color: C.text, outline: 'none', boxSizing: 'border-box', background: C.cardBg,
};

// preventBackdropClose: when true, clicking the dimmed backdrop does nothing —
// the modal only closes via the header back button (if showBackButton) or the
// caller's own footer buttons. Off by default so every other Modal caller keeps
// today's click-outside-to-close behavior.
export function Modal({ title, onClose, children, footer, width = 480, preventBackdropClose = false, showBackButton = false }) {
  return (
    <div onClick={preventBackdropClose ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, fontFamily: FONT, padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.cardBg, borderRadius: 14, width, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', boxShadow: C.shadowLg }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{title}</span>
          {showBackButton && (
            <button title="Back" onClick={onClose} style={{ background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' }}>
              <X size={15} />
            </button>
          )}
        </div>
        <div style={{ padding: 22 }}>{children}</div>
        {footer && <div style={{ padding: '14px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'flex-end', gap: 9 }}>{footer}</div>}
      </div>
    </div>
  );
}
