// ============================================================
// constants.js — ForgeGrowth Design Tokens
// ============================================================

// Every colour resolves through a CSS custom property (see theme/tokens.css), so
// flipping data-theme on <html> re-themes the app without a re-render. The legacy
// names stay so call sites keep compiling; NOTE cardBg bridges to --fc-raised
// because the content pane itself is --fc-card (a card on a pane must step up).
const v = (n) => `var(--fc-${n})`;
export const C = {
  pageBg:       v('page'),
  sidebarBg:    v('sidebar'),
  headerBg:     v('header'),
  headerText:   v('header-text'),
  headerMuted:  v('header-muted'),
  headerBorder: 'transparent',
  headerSurface:v('header-surface'),
  cardBg:       v('raised'),
  card:         v('card'),
  raised:       v('raised'),
  surface:      v('surface'),
  surface2:     v('surface-2'),
  border:       v('border'),          // transparent — borderless by design
  borderStrong: v('border-strong'),
  fillMuted:    v('surface-2'),
  text:         v('text'),
  textSecondary:v('text-secondary'),
  textMuted:    v('text-muted'),
  primary:      v('primary'),
  primaryHover: v('primary-hover'),
  primarySoft:  v('primary-soft'),
  primaryFaint: v('primary-faint'),
  onAccent:     v('on-accent'),
  purple:       v('purple'),
  purpleSoft:   v('purple-soft'),
  green:        v('green'),
  greenSoft:    v('green-soft'),
  amber:        v('amber'),
  amberSoft:    v('amber-soft'),
  blue:         v('blue'),
  blueSoft:     v('blue-soft'),
  pink:         v('pink'),
  pinkSoft:     v('pink-soft'),
  errBg:        v('err-bg'),
  errText:      v('err-text'),
  plate:        v('plate'),
  plateText:    v('plate-text'),
  hoverBg:      v('surface'),
  scrim:        v('scrim'),
  shadowSm:     v('shadow-sm'),
  shadowMd:     v('shadow-md'),
  shadowLg:     v('shadow-lg'),
};

// Type scale — weight carries hierarchy, not size.
export const T = {
  metric:   { fontSize: 38, fontWeight: 780, letterSpacing: '-0.03em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  metricSm: { fontSize: 26, fontWeight: 780, letterSpacing: '-0.03em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  h1:       { fontSize: 38, fontWeight: 780, letterSpacing: '-0.03em', lineHeight: 1.12 },
  h2:       { fontSize: 26, fontWeight: 780, letterSpacing: '-0.03em', lineHeight: 1.3 },
  h3:       { fontSize: 16, fontWeight: 650, letterSpacing: '-0.02em', lineHeight: 1.3 },
  body:     { fontSize: 15, fontWeight: 450, lineHeight: 1.5 },
  bodyBold: { fontSize: 15, fontWeight: 780, lineHeight: 1.5 },
  small:    { fontSize: 14, fontWeight: 450, lineHeight: 1.45 },
  label:    { fontSize: 12, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.04em', lineHeight: 1.2 },
};

// Shared control recipes (pills, no borders, fill-only separation).
export const RADIUS = { lg: 24, md: 16, sm: 12, pill: 999 };
export const BTN = {
  primary:   { padding: '10px 18px', borderRadius: 999, border: 'none', background: v('primary'), color: v('on-accent'), fontSize: 14, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' },
  secondary: { padding: '10px 18px', borderRadius: 999, border: 'none', background: v('surface-2'), color: v('text'), fontSize: 14, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' },
  ghost:     { padding: '10px 18px', borderRadius: 999, border: 'none', background: 'transparent', color: v('text-secondary'), fontSize: 14, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' },
  danger:    { padding: '10px 18px', borderRadius: 999, border: 'none', background: v('err-bg'), color: v('err-text'), fontSize: 14, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' },
  icon:      { width: 34, height: 34, borderRadius: 999, border: 'none', background: v('surface'), color: v('text-secondary'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0 },
};
export const INPUT = { padding: '10px 12px', borderRadius: 12, border: 'none', fontSize: 14, fontFamily: 'inherit', background: v('surface'), color: v('text'), outline: 'none', width: '100%', boxSizing: 'border-box' };
export const CARD  = { background: v('raised'), borderRadius: 16, padding: 18 };
export const POPOVER = { background: v('raised'), borderRadius: 16, boxShadow: v('shadow-lg'), padding: 6 };
export const LABEL = { ...T.label, color: v('text-secondary'), display: 'block', marginBottom: 6 };


export const FONT = "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const MONO = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const STATUS_COLORS = {
  'To-do':       { bg: C.purpleSoft, color: C.purple },
  'In-Progress': { bg: C.amberSoft,  color: C.amber },
  'Hold':        { bg: C.amberSoft,  color: C.amber },
  'Submitted':   { bg: C.greenSoft,  color: C.green },
  'Approved':    { bg: C.greenSoft,  color: C.green },
  'Dropped':     { bg: C.surface2,   color: C.textMuted },
  'Unknown':     { bg: C.surface2,   color: C.textMuted },
};

export const PRIORITY_COLORS = {
  'High':   { bg: C.errBg,     color: C.errText },
  'Medium': { bg: C.amberSoft, color: C.amber },
  'Low':    { bg: C.greenSoft, color: C.green },
};

export const APPROVAL_COLORS = {
  'Approved':   { bg: C.greenSoft, color: C.green },
  'Pending':    { bg: C.amberSoft, color: C.amber },
  'Correction': { bg: C.amberSoft, color: C.amber },
  'Rejected':   { bg: C.errBg,     color: C.errText },
};

export const PROJECT_PALETTE = [
  { bg: C.blueSoft,   color: C.blue },
  { bg: C.greenSoft,  color: C.green },
  { bg: C.purpleSoft, color: C.purple },
  { bg: C.amberSoft,  color: C.amber },
  { bg: C.errBg,      color: C.errText },
  { bg: C.pinkSoft,   color: C.pink },
  { bg: C.blueSoft,   color: C.blue },
  { bg: C.amberSoft,  color: C.amber },
];

export const STATUS_LIST   = ['To-do', 'In-Progress', 'Hold', 'Submitted', 'Approved', 'Dropped'];
export const PRIORITY_LIST = ['Low', 'Medium', 'High'];
export const APPROVAL_LIST = ['Pending', 'Approved', 'Correction', 'Rejected'];
export const PERIODS       = ['Today', 'Yesterday', 'This Week', 'This Month', 'All'];

export function isOverdue(task) {
  if (!task?.dueDate) return false;
  if (['Submitted', 'Approved', 'Dropped'].includes(task.status)) return false;
  const due = new Date(`${task.dueDate}T${(task.dueTime || '23:59').slice(0, 5)}:00`);
  return due.getTime() < Date.now();
}

export function formatMins(n) {
  const m = Math.max(0, Math.round(Number(n) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

export function formatSecs(n) {
  const t = Math.max(0, Math.round(Number(n) || 0));
  if (t < 60) return `${t}s`;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function relativeTime(ts) {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const secs = Math.floor((Date.now() - d) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const _istFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const istDateStr = d => _istFmt.format(d instanceof Date ? d : new Date(d));
