// Saved views for Sales → Payments (Dashboard and All payments tabs).
//
// One bar, one hook, one set of range helpers, so the two tabs cannot drift in
// how a view is saved, applied or described. Each tab passes its own
// normalize / canonical / describe for the filters it has.
//
// Ranges are saved as RULES, never resolved dates: "last 30 days" and "since
// 1 Apr" are re-resolved against today whenever the view opens, so a saved view
// keeps ending on the current day. Only "Custom" stores two fixed dates.
// Stored per user, per tab, on the server (migrations 129 + 130).
import { useState, useEffect, useRef } from 'react';
import { Bookmark, BookmarkPlus, Star, Pencil, Trash2, Save, Check, Undo2, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { Button, inputStyle } from '../academy/shared.jsx';
import { useConfirm } from '../../components/ConfirmDialog.jsx';
import { istToday, shiftDay } from '../../components/DateRangeControl.jsx';

export const RANGE_PRESETS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '12 months' },
  { value: 'all', label: 'All time' },
  { value: 'since', label: 'Since a date' },
  { value: 'custom', label: 'Custom' },
];
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const cleanDate = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : '');
export const oneOf = (list, v, dflt) => (list.some(o => o.value === v) ? v : dflt);
export const rollsToToday = (preset) => preset !== 'custom' && preset !== 'all';

/** A range rule → concrete IST dates for the API ('' = no limit). */
export function resolveRange(preset, from, to, since) {
  if (preset === 'all') return { from: '', to: '' };
  if (preset === 'custom') return { from, to };
  const today = istToday();
  if (preset === 'since') return { from: since && since <= today ? since : today, to: today };
  return { from: shiftDay(today, -(Number(preset) - 1)), to: today };
}

export const shortDay = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) : '');
/** Human wording for a range rule, e.g. "1 Apr 2026 → today". */
export function rangeText({ preset, from, to, since }) {
  if (preset === 'since') return since ? `${shortDay(since)} → today` : 'Since a date → today';
  if (preset === 'custom') return from || to ? `${shortDay(from) || '…'} – ${shortDay(to) || '…'}` : 'Custom dates';
  return RANGE_PRESETS.find(p => p.value === preset)?.label || preset;
}

/** The "From [date] to today" box shown when the range is "Since a date". */
export function SinceInput({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontFamily: FONT, fontSize: 15, color: C.textSecondary }}>
      <span>From</span>
      <input type="date" value={value} max={istToday()} onChange={e => onChange(e.target.value)}
        aria-label="Start date" title="Start date (inclusive) — the range always ends today"
        style={{ ...inputStyle, width: 'auto', padding: '7px 10px', fontFamily: MONO }} />
      <span>to <strong style={{ color: C.text }}>today</strong></span>
    </div>
  );
}
/** Start of this month — the starting point offered when "Since a date" is first picked. */
export const monthStart = () => `${istToday().slice(0, 8)}01`;

/**
 * Loads this user's views for one tab and applies the default one, if any.
 * `ready` stays false until that is done, so the tab can hold its first data
 * request and never flash the un-filtered view before the default lands.
 */
export function useSavedViews(scope, applyView) {
  const [presets, setPresets] = useState([]);
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const applyRef = useRef(applyView);
  applyRef.current = applyView;
  useEffect(() => {
    let off = false;
    api.paymentFilterPresets.list(scope)
      .then(r => {
        if (off) return;
        const list = r?.presets || [];
        setPresets(list);
        const d = list.find(p => p.isDefault);
        if (d) { applyRef.current(d.filters); setActiveId(d.id); }
      })
      .catch(() => { /* views are a convenience — the tab still works without them */ })
      .finally(() => { if (!off) setReady(true); });
    return () => { off = true; };
  }, [scope]);
  return { presets, setPresets, ready, activeId, setActiveId };
}

// ── The bar ──────────────────────────────────────────────────────────────────
// Click a saved view to apply it. The active one shows "changed" once any filter
// moves away from what was saved, with Update to overwrite it. One view per tab
// can be the default: the tab opens with it.
export function SavedViewsBar({ scope, views, current, applyView, normalize, canonical, describe }) {
  const { presets, setPresets, ready, activeId, setActiveId } = views;
  const [confirmEl, confirm] = useConfirm();
  const [mode, setMode] = useState(null);       // null | 'save' | 'rename'
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [flash, setFlash] = useState(null);     // short inline confirmation
  const nameRef = useRef(null);

  const cur = canonical(current);
  const active = presets.find(p => p.id === activeId) || presets.find(p => canonical(p.filters) === cur) || null;
  const changed = active ? canonical(active.filters) !== cur : false;

  useEffect(() => { if (mode) nameRef.current?.focus(); }, [mode]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2500); return () => clearTimeout(t); }, [flash]);

  if (!ready) return null;

  const sortList = (list) => list.slice().sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
  const replace = (p, clearOtherDefaults) => setPresets(list => sortList(list.map(x => x.id === p.id ? p
    : (clearOtherDefaults && p.isDefault ? { ...x, isDefault: false } : x))));

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const openSave = () => { setMode('save'); setName(''); setMakeDefault(false); setErr(null); };
  const openRename = () => { setMode('rename'); setName(active.name); setErr(null); };
  const close = () => { setMode(null); setErr(null); };

  const submit = () => run(async () => {
    if (mode === 'save') {
      const r = await api.paymentFilterPresets.create({ scope, name, filters: normalize(current), isDefault: makeDefault });
      setPresets(list => sortList([...list.map(x => (makeDefault ? { ...x, isDefault: false } : x)), r.preset]));
      setActiveId(r.preset.id);
      setFlash(`Saved “${r.preset.name}”.`);
    } else {
      const r = await api.paymentFilterPresets.update(active.id, { name });
      replace(r.preset, false);
      setFlash('Renamed.');
    }
    close();
  });
  const update = () => run(async () => {
    const r = await api.paymentFilterPresets.update(active.id, { filters: normalize(current) });
    replace(r.preset, false);
    setFlash(`Updated “${r.preset.name}”.`);
  });
  const toggleDefault = () => run(async () => {
    const r = await api.paymentFilterPresets.update(active.id, { isDefault: !active.isDefault });
    replace(r.preset, true);
    setFlash(r.preset.isDefault ? `${scope === 'ledger' ? 'All payments' : 'The dashboard'} will open with this view.` : 'No longer the default view.');
  });
  const remove = async () => {
    const ok = await confirm({ title: 'Delete saved view?', body: `“${active.name}” will be removed. The filters on screen stay as they are.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    run(async () => {
      await api.paymentFilterPresets.delete(active.id);
      setPresets(list => list.filter(x => x.id !== active.id));
      setActiveId(null);
    });
  };

  const pill = (on) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
    fontFamily: FONT, fontSize: 14, fontWeight: 600, border: `1px solid ${on ? C.primary : C.border}`,
    background: on ? C.primary : 'transparent', color: on ? '#fff' : C.text, maxWidth: 260,
  });
  const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer',
    color: C.textSecondary, fontFamily: FONT, fontSize: 14, fontWeight: 600, padding: '4px 6px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {confirmEl}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: '.05em',
          textTransform: 'uppercase', color: C.textMuted, fontFamily: FONT }}>
          <Bookmark size={14} /> Saved views
        </span>
        {presets.length === 0 && (
          <span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>None yet — set your filters, then save them.</span>
        )}
        {presets.map(p => {
          const on = active?.id === p.id;
          return (
            <button key={p.id} type="button" aria-pressed={on} disabled={busy}
              onClick={() => { applyView(p.filters); setActiveId(p.id); setMode(null); }}
              title={`${describe(p.filters)}${p.isDefault ? '\nOpens by default' : ''}`} style={pill(on)}>
              {p.isDefault && <Star size={13} fill="currentColor" />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              {on && changed && <span title="Filters changed since this view was saved"
                style={{ width: 7, height: 7, borderRadius: 999, background: '#fff', opacity: .85, flexShrink: 0 }} />}
            </button>
          );
        })}
        <Button variant="ghost" onClick={openSave} disabled={busy} title="Save the date range and filters on screen as a view">
          <BookmarkPlus size={15} /> Save view
        </Button>
      </div>

      {active && !mode && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', fontFamily: FONT, fontSize: 14, color: C.textMuted }}>
          <span style={{ marginRight: 6 }}>
            {changed ? <>Filters changed from <strong style={{ color: C.text }}>{active.name}</strong></>
              : <>Showing <strong style={{ color: C.text }}>{active.name}</strong>: {describe(active.filters)}</>}
          </span>
          {changed && (
            <button type="button" style={{ ...linkBtn, color: C.primary }} onClick={update} disabled={busy}
              title="Overwrite this view with the filters on screen"><Save size={14} /> Update view</button>
          )}
          {changed && (
            <button type="button" style={linkBtn} onClick={() => applyView(active.filters)} disabled={busy}
              title="Put the saved filters back"><Undo2 size={14} /> Revert</button>
          )}
          <button type="button" style={linkBtn} onClick={openRename} disabled={busy}><Pencil size={14} /> Rename</button>
          <button type="button" style={linkBtn} onClick={toggleDefault} disabled={busy}
            title={active.isDefault ? 'Stop opening this tab with this view' : 'Open this tab with this view'}>
            <Star size={14} fill={active.isDefault ? 'currentColor' : 'none'} /> {active.isDefault ? 'Default view' : 'Make default'}
          </button>
          <button type="button" style={{ ...linkBtn, color: 'var(--c-dangerText, #A32D2D)' }} onClick={remove} disabled={busy}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}

      {mode && (
        <form onSubmit={e => { e.preventDefault(); if (!busy) submit(); }}
          style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14,
            display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input ref={nameRef} value={name} onChange={e => setName(e.target.value)} maxLength={60}
              placeholder={mode === 'save' ? 'Name this view, e.g. “UPI since April”' : 'New name'}
              aria-label="View name" style={{ ...inputStyle, flex: '1 1 260px', minWidth: 200 }} />
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} {mode === 'save' ? 'Save view' : 'Rename'}
            </Button>
            <Button variant="ghost" type="button" onClick={close} disabled={busy}>Cancel</Button>
          </div>
          {mode === 'save' && (
            <>
              <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>
                Saves: {describe(current)}
                {rollsToToday(current.preset) ? ' — the end date always moves to today.' : ''}
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, fontFamily: FONT, cursor: 'pointer' }}>
                <input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />
                Open {scope === 'ledger' ? 'All payments' : 'the dashboard'} with this view
              </label>
            </>
          )}
        </form>
      )}

      {err && <div style={{ fontSize: 14, color: 'var(--c-dangerText, #A32D2D)', fontFamily: FONT }}>{err}</div>}
      {flash && !err && <div style={{ fontSize: 14, color: 'var(--c-successText, #0F6E56)', fontFamily: FONT }}>{flash}</div>}
    </div>
  );
}
