// Color tokens map to CSS variables (defined per-theme in index.css) so the
// whole app re-themes when <html data-theme> flips. Fallbacks = light values,
// so colors still render even if the stylesheet hasn't loaded.
export const C = {
  pageBg: 'var(--c-pageBg, #F7F7F3)',
  sidebarBg: 'var(--c-sidebarBg, #FAF9F5)',
  sidebarBorder: 'var(--c-sidebarBorder, #E5E5E0)',
  headerBg: 'var(--c-headerBg, #0F0F10)',
  headerText: 'var(--c-headerText, #F5F5F2)',
  headerMuted: 'var(--c-headerMuted, #A1A1AA)',
  headerBorder: 'var(--c-headerBorder, rgba(255,255,255,.12))',
  headerSurface: 'var(--c-headerSurface, rgba(255,255,255,.06))',
  cardBg: 'var(--c-cardBg, #ffffff)',
  border: 'var(--c-border, #E5E5E0)',
  borderDark: 'var(--c-borderDark, #d1d7db)',
  text: 'var(--c-text, #111111)',
  textSecondary: 'var(--c-textSecondary, #6B7280)',
  textMuted: 'var(--c-textMuted, #667180)',
  primary: 'var(--c-primary, #dc2626)',
  primaryHover: 'var(--c-primaryHover, #b91c1c)',
  primaryLight: 'var(--c-primaryLight, #FCEBEB)',
  primaryText: 'var(--c-primaryText, #111b21)',
  purple: 'var(--c-purple, #534AB7)',
  green: 'var(--c-green, #0F6E56)',
  amber: 'var(--c-amber, #E8A317)',
  shadowSm: 'var(--c-shadowSm, 0 1px 2px rgba(0,0,0,.08))',
  shadowMd: 'var(--c-shadowMd, 0 8px 24px rgba(0,0,0,.06))',
  shadowLg: 'var(--c-shadowLg, 0 20px 60px rgba(0,0,0,.15))',
  waBg: 'var(--c-waBg, #e5ddd5)',
  // neutral surface aliases (used when migrating literal-heavy views)
  surface: 'var(--c-surface, #ffffff)',
  surfaceAlt: 'var(--c-surfaceAlt, #F7F7F3)',
  hover: 'var(--c-hover, #EFEEE6)',
  // The wallpaper is a data-URI SVG: var() cannot be interpolated INSIDE the
  // encoded string, so the whole url() is the token and index.css swaps it
  // per theme. Hardcoding it here is what left light-grey squares showing
  // through the dark chat background.
  waBgPattern: 'var(--c-chatPattern)',

  // ── Surfaces ──────────────────────────────────────────────────────────
  surfaceInner: 'var(--c-surfaceInner, #FAFAF7)',
  surfaceSection: 'var(--c-surfaceSection, #F8F7F2)',
  surfaceMuted: 'var(--c-surfaceMuted, #F1F1EE)',
  surfaceSubtle: 'var(--c-surfaceSubtle, #EEEDE8)',
  borderSubtle: 'var(--c-borderSubtle, #EEEEE8)',
  borderStrong: 'var(--c-borderStrong, #D5D5D0)',
  divider: 'var(--c-divider, #F0F0EA)',
  rowSep: 'var(--c-rowSep, #F5F5F0)',

  // ── Text ramp (t1 strongest → t8 faintest) ────────────────────────────
  t1: 'var(--c-t1, #111111)',
  t2: 'var(--c-t2, #222222)',
  t3: 'var(--c-t3, #444444)',
  t4: 'var(--c-t4, #666666)',
  t5: 'var(--c-t5, #737373)',
  t6: 'var(--c-t6, #7B7B7B)',
  t7: 'var(--c-t7, #878787)',
  t8: 'var(--c-t8, #9A9A9A)',

  // ── Semantic pairs — <name>Text is always legible on <name>Bg ─────────
  dangerText: 'var(--c-dangerText, #A32D2D)',
  dangerStrong: 'var(--c-dangerStrong, #991b1b)',
  dangerBg: 'var(--c-dangerBg, #FCEBEB)',
  dangerBgSoft: 'var(--c-dangerBgSoft, #FDF6F6)',
  dangerBorder: 'var(--c-dangerBorder, #F8C8C8)',
  successText: 'var(--c-successText, #0F6E56)',
  successBright: 'var(--c-successBright, #1D9E75)',
  successBg: 'var(--c-successBg, #E1F5EE)',
  successBgSoft: 'var(--c-successBgSoft, #E4F3EE)',
  successBorder: 'var(--c-successBorder, #B8DCCF)',
  warnText: 'var(--c-warnText, #854F0B)',
  warnDeep: 'var(--c-warnDeep, #6B5312)',
  warnBg: 'var(--c-warnBg, #FAEEDA)',
  warnBgSoft: 'var(--c-warnBgSoft, #FFF8E1)',
  warnBorder: 'var(--c-warnBorder, #F0DCA8)',
  orangeText: 'var(--c-orangeText, #E65100)',
  orangeBg: 'var(--c-orangeBg, #FFF3E0)',
  orangeBorder: 'var(--c-orangeBorder, #FFB74D)',
  infoText: 'var(--c-infoText, #1565C0)',
  infoBright: 'var(--c-infoBright, #2563eb)',
  infoBg: 'var(--c-infoBg, #E3F2FD)',
  infoBorder: 'var(--c-infoBorder, #BBDEFB)',

  // ── Chat surfaces ─────────────────────────────────────────────────────
  chatHeaderBg: 'var(--c-chatHeaderBg, #008069)',
  chatHeaderText: 'var(--c-chatHeaderText, #ffffff)',
  rowActive: 'var(--c-rowActive, #f0f2f5)',
  rowHover: 'var(--c-rowHover, #f5f6f6)',
  avatarBg: 'var(--c-avatarBg, #dfe5e7)',
  avatarText: 'var(--c-avatarText, #54656f)',
  waGreen: 'var(--c-waGreen, #25D366)',
  purpleBg: 'var(--c-purpleBg, #EEEDFE)',
  navy: 'var(--c-navy, #1B2A4E)',
  navyBg: 'var(--c-navyBg, #E5EAF2)',
  teal: 'var(--c-teal, #00796B)',
  tealBg: 'var(--c-tealBg, #DDF1EE)',
  pink: 'var(--c-pink, #9C2153)',
  pinkBg: 'var(--c-pinkBg, #FBE5EE)',
  successTint: 'var(--c-successTint, #F0FAF6)',
  selectedTint: 'var(--c-selectedTint, #FFF7F7)',
  watermark: 'var(--c-watermark, #dddddd)',
};

export const CHAT = {
  incomingBg: 'var(--c-incomingBg, #ffffff)',
  incomingText: 'var(--c-incomingText, #111b21)',
  outgoingBg: 'var(--c-outgoingBg, #d9fdd3)',
  outgoingText: 'var(--c-outgoingText, #111b21)',
  chatBg: 'var(--c-chatBg, #e5ddd5)',
  bubbleRadius: '7.5px',
  bubblePadding: '6px 7px 8px 9px',
  statusDelivered: 'var(--c-statusDelivered, #53bdeb)',
  statusRead: 'var(--c-statusRead, #53bdeb)',
  statusSent: 'var(--c-statusSent, #8696a0)',
};

export const FONT = "'DM Sans', system-ui, sans-serif";
export const MONO = "'DM Mono', monospace";

/**
 * TYPE SCALE — the single authority for every text size in the app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this, there was no scale at all: ~2,300 hand-typed `fontSize:` values
 * across 30 distinct sizes, of which 1,774 were 13px or smaller and 211 were
 * 10.5px or below. Measured in a real browser, 32% of all rendered text sat
 * under 13px — 86% of it inside the automation builder. A design system only
 * governs the code that ASKS it for a value, and a hand-typed pixel number asks
 * nothing. (Same failure the colour tokens had; see anti-pattern #46.)
 *
 * The steps are deliberately few. Every extra step is a decision someone has to
 * make correctly at 200 call sites, and the old 30-size spread is what that
 * looks like when nobody does.
 *
 *   micro   11  hard FLOOR for real UI text. Only for a badge count or a
 *               timestamp sitting beside something bigger. Never body copy.
 *   label   12  uppercase letterspaced column heads, eyebrow labels, chips.
 *   meta    13  secondary lines under a title; dense table cells.
 *   body    14  the default. If you are unsure, this is the answer.
 *   bodyLg  15  primary rows people scan — nav items, list titles, form values.
 *   lead    16  the strongest line in a card; sub-section headings.
 *   h3      18  panel and card titles.
 *   h2      22  section titles.
 *   h1      30  page titles.
 *   kpi     40  a single number that is the point of its card.
 *
 * WEIGHTS: 500 is the lightest weight allowed for anything a user reads. The
 * old distribution was polarised (596 at 700, 472 at 600, only 50 at 500) with
 * nothing in the readable middle, which is why text read as either shouting or
 * vanishing.
 *
 * ⚠ Anything whose geometry is COMPUTED from a font size must move with it.
 * `components/builder/nodeLayout.js` budgets canvas rows in fixed pixels
 * (HEAD_H / ROW_H / SYS_H / BODY_H); raising type there without raising those
 * puts the first row on top of the subtitle, which that file already records
 * happening once.
 *
 * The WhatsApp phone mocks are NOT exempt, and deliberately so. Real WhatsApp
 * renders a message body around 15px and a bubble timestamp around 11px, which
 * is exactly what this scale produces for them — the old mocks were at 13/9,
 * i.e. a shrunken phone rather than an accurate one. If a mock ever does need
 * its own smaller scale, give it one explicitly; do not reintroduce loose
 * literals to achieve it.
 */
export const T = {
  micro: 11,
  label: 12,
  meta: 13,
  body: 14,
  bodyLg: 15,
  lead: 16,
  h3: 18,
  h2: 22,
  h1: 30,
  kpi: 40,
};

/** Weights, named by role so a call site says what it means. */
export const W = {
  normal: 500,   // the lightest weight permitted for readable text
  medium: 600,   // list titles, nav items, emphasis inside a sentence
  bold: 700,     // card and section titles
  heavy: 800,    // page titles and KPI numbers
};

/** Line heights. Small text needs proportionally MORE leading, not less. */
export const LH = {
  tight: 1.25,   // headings and KPI numbers
  snug: 1.4,     // list rows, table cells
  normal: 1.55,  // body copy and help text
};


export const TIME_RANGES = [
  { key: '1h', label: '1h' },
  { key: '6h', label: '6h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '14d', label: '14d' },
  { key: '30d', label: '30d' },
];

export function relativeTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// Mask a phone number for display — keep the first 2 and last 3 digits, star the
// rest (e.g. "919876543210" -> "91*******330", "93xxxxx678" -> "93*****678").
// Used directly for non-interactive contexts (<option>, strings); the
// MaskedNumber component wraps this with click-to-reveal for JSX.
export function maskPhone(raw) {
  const s = String(raw ?? '');
  const digits = s.replace(/\D/g, '');
  if (digits.length <= 5) return s; // too short to meaningfully mask
  return digits.slice(0, 2) + '*'.repeat(digits.length - 5) + digits.slice(-3);
}

// Trigger a client-side download of a JS object as a pretty-printed .json file.
export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.json') ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Slugify a name into a safe filename fragment.
export function slugifyName(name) {
  return String(name || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export';
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}
