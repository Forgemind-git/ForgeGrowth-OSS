// DateRangeControl — the one date-range picker for the Marketing surfaces
// (Overview, Campaigns, Click-to-WhatsApp).
//
// Presets (7 / 30 / 90 days, All time) plus a Custom from–to pair. The preset
// strip is PillStrip, the segmented control every page already uses; the custom
// pair is DateFromTo, which Sales → Payments also renders so there is one date
// pair in the product rather than one per page.
//
// The chosen range is shared by all three Marketing pages and survives a refresh
// (useMarketingRange → localStorage). Storage can throw (private windows, blocked
// site data), so every read and write is guarded and the default still renders.
//
// Dates are IST calendar days and both ends are INCLUSIVE — the backend
// (util/dateRange.js) interprets them the same way.
import { useState, useCallback } from 'react';
import { CalendarDays, XCircle, Info } from 'lucide-react';
import PillStrip from './PillStrip.jsx';
import { C, FONT, T, W } from '../constants.js';

export const RANGE_PRESETS = [
  { id: '7', label: '7 days', title: 'The last 7 days' },
  { id: '30', label: '30 days', title: 'The last 30 days' },
  { id: '90', label: '90 days', title: 'The last 90 days' },
  { id: 'all', label: 'All time', title: 'Everything, with no date limit' },
  { id: 'custom', label: 'Custom', title: 'Pick your own start and end date' },
];

const PRESET_IDS = new Set(RANGE_PRESETS.map(p => p.id));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORAGE_KEY = 'forgegrowth.marketingRange';
export const DEFAULT_RANGE = { preset: '30', from: '', to: '' };

/** Today as YYYY-MM-DD in India, whatever the browser's own timezone is. */
export function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Shift a YYYY-MM-DD by whole days, as calendar arithmetic (no DST drift). */
export function shiftDay(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Anything read from storage or props, coerced into a valid range. */
export function normalizeRange(v) {
  if (!v || typeof v !== 'object' || !PRESET_IDS.has(v.preset)) return { ...DEFAULT_RANGE };
  return {
    preset: v.preset,
    from: typeof v.from === 'string' && DATE_RE.test(v.from) ? v.from : '',
    to: typeof v.to === 'string' && DATE_RE.test(v.to) ? v.to : '',
  };
}

/**
 * Query params for the API. Always explicit — `days: 'all'` rather than nothing —
 * because /marketing/overview falls back to 30 days when no range is sent, and a
 * page labelled "All time" must never quietly show 30 days.
 */
export function rangeParams(v) {
  const r = normalizeRange(v);
  if (r.preset === 'custom') {
    if (!r.from && !r.to) return { days: 'all' };
    const out = {};
    if (r.from) out.from = r.from;
    if (r.to) out.to = r.to;
    return out;
  }
  return { days: r.preset };
}

const shortDate = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Human wording for the range, for sentences like "Leads created in …". */
export function rangeLabel(v) {
  const r = normalizeRange(v);
  if (r.preset === 'all') return 'all time';
  if (r.preset !== 'custom') return `the last ${r.preset} days`;
  if (r.from && r.to) return r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`;
  if (r.from) return `${shortDate(r.from)} onwards`;
  if (r.to) return `everything up to ${shortDate(r.to)}`;
  return 'all time';
}

/** The shared Marketing range, persisted across pages and refreshes. */
export function useMarketingRange() {
  const [range, setRangeState] = useState(() => {
    try { return normalizeRange(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { return { ...DEFAULT_RANGE }; }
  });
  const setRange = useCallback((next) => {
    const r = normalizeRange(next);
    setRangeState(r);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)); } catch { /* storage blocked — keep in memory */ }
  }, []);
  return [range, setRange];
}

const dateInputStyle = {
  width: 142, padding: '6px 9px', borderRadius: 8, border: `1.5px solid ${C.border}`,
  fontSize: T.body, fontFamily: FONT, color: C.text, outline: 'none', boxSizing: 'border-box', background: C.cardBg,
};

/**
 * A from–to date pair. `min`/`max` stop an impossible range (end before start)
 * from being expressible at all, rather than accepting it and matching nothing.
 */
export function DateFromTo({ from, to, setFrom, setTo, clearable = true }) {
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontFamily: FONT, fontSize: T.body, color: C.textSecondary }}>
      <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} title="From date (inclusive)" style={dateInputStyle} />
      <span>to</span>
      <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} title="To date (inclusive — the whole day counts)" style={dateInputStyle} />
      {clearable && (from || to) && (
        <button type="button" onClick={() => { setFrom(''); setTo(''); }} title="Clear dates"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'inline-flex', padding: 2 }}>
          <XCircle size={14} />
        </button>
      )}
    </div>
  );
}

export default function DateRangeControl({ value, onChange }) {
  const r = normalizeRange(value);

  const pick = (id) => {
    if (id === 'custom') {
      // Open Custom already filled with a valid 30-day window (ending today), so
      // switching to it never leaves a half-empty range fetching everything.
      const to = r.to || istToday();
      const from = r.from || shiftDay(to, -29);
      onChange({ preset: 'custom', from, to });
    } else {
      onChange({ ...r, preset: id });
    }
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/* A labelled group, so the range reads as a filter rather than a second,
          unrelated set of tabs beside the page's other controls. */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 4px 4px 11px',
        border: `1.5px solid ${C.border}`, borderRadius: 11, background: C.cardBg }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: T.meta,
          fontWeight: W.bold, letterSpacing: '.04em', textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
          <CalendarDays size={14} /> Period
        </span>
        <PillStrip items={RANGE_PRESETS} value={r.preset} onChange={pick} size="sm" />
      </div>
      {r.preset === 'custom' && (
        <DateFromTo from={r.from} to={r.to}
          setFrom={(from) => onChange({ ...r, from })}
          setTo={(to) => onChange({ ...r, to })} />
      )}
    </div>
  );
}

/**
 * The spend honesty banner. Renders only when the numbers need a caveat:
 * the range starts before the oldest per-day spend Meta has given us (or there
 * is none at all), so spend and cost figures for the range are incomplete.
 * `coverage` is the backend's spendCoverage object.
 */
export function SpendCoverageNote({ coverage, style }) {
  if (!coverage || coverage.basis !== 'daily' || !coverage.partial || !coverage.note) return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 13px', marginBottom: 12,
      background: 'var(--c-warnBgSoft, #FFF8E6)', border: '1px solid var(--c-warnBorder, #F0DCA8)', borderRadius: 9,
      fontFamily: FONT, fontSize: T.body, color: 'var(--c-warnDeep, #6B5312)', lineHeight: 1.5, ...style }}>
      <Info size={15} style={{ flexShrink: 0, marginTop: 2 }} />
      <span><strong>Spend is incomplete for this range.</strong> {coverage.note}</span>
    </div>
  );
}
