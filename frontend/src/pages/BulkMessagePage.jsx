import { useState, useEffect, useMemo, useRef } from 'react';
import { notify } from '../lib/feedback.js';
// ⚠ Every icon used anywhere in this file must be listed here. A missing lucide
// import is an undefined component reference: the bundler does not catch it and
// it throws at RENDER. With a page-level error boundary in place that shows as
// "This page ran into a problem" and fires NO `pageerror` — only a
// console.error — so a harness that watches pageerror alone reports it clean.
import { Send, ArrowLeft, Trash2, Loader2, Clock, Users, Phone, FileText, Repeat, X, CheckCircle, Eye, Search, ChevronDown, ChevronLeft, ChevronRight, Filter, Plus, Play, Library, Image, Video, Music, CalendarDays, MousePointerClick, Pencil, Copy } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO, formatDate, formatTime, maskPhone } from '../constants.js';
import MaskedNumber from '../components/MaskedNumber.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import WhatsAppPreview from '../components/WhatsAppPreview.jsx';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import TagMultiSelect from '../components/TagMultiSelect.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import AccountHealthBanner from '../components/AccountHealthBanner.jsx';
import { useTableSelection, SelectAllCheckbox, RowCheckbox, BulkDeleteButton, runBulkDelete } from '../components/TableSelection.jsx';

const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'SCHEDULED', label: 'Scheduled' },
  { key: 'SENDING', label: 'Sending' },
  { key: 'SENT', label: 'Sent' },
  { key: 'PARTIAL', label: 'Partial' },
  { key: 'FAILED', label: 'Failed' },
  // Not a broadcast status — a separate view of the repeating SCHEDULES, which
  // are their own thing. Kept in the same strip because "what have I got going
  // out?" is one question, and each run of a series also appears as a normal
  // broadcast in the other tabs.
  { key: 'SERIES', label: 'Repeating' },
];

function StatusBadge({ status }) {
  const config = {
    DRAFT:     { bg: 'var(--c-surfaceMuted, #f3f4f6)', color: 'var(--c-textSecondary)', border: '#e5e7eb', dot: '#9ca3af' },
    SCHEDULED: { bg: 'var(--c-purpleBg, #ede9fe)', color: 'var(--c-s5b21b6, #5b21b6)', border: '#ddd6fe', dot: 'var(--c-s7c3aed, #7c3aed)' },
    SENDING:   { bg: 'var(--c-sdbeafe, #dbeafe)', color: 'var(--c-s1e40af, #1e40af)', border: '#bfdbfe', dot: 'var(--c-s3b82f6, #3b82f6)' },
    SENT:      { bg: 'var(--c-sd1fae5, #d1fae5)', color: 'var(--c-s065f46, #065f46)', border: '#a7f3d0', dot: '#10b981' },
    PARTIAL:   { bg: 'var(--c-sfef3c7, #fef3c7)', color: 'var(--c-s92400e, #92400e)', border: '#fde68a', dot: '#f59e0b' },
    FAILED:    { bg: 'var(--c-dangerBg, #fee2e2)', color: 'var(--c-dangerStrong, #991b1b)', border: '#fecaca', dot: 'var(--c-sef4444, #ef4444)' },
  };
  const c = config[status] || config.SENT;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 99,
      background: c.bg, color: c.color,
      fontSize: 13, fontWeight: 700, fontFamily: FONT,
      border: `1px solid ${c.border}`,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 99,
        background: c.dot,
        display: 'inline-block',
      }} />
      {status}
    </span>
  );
}

function ActionBadge({ action }) {
  const isTest = action === 'TEST';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4,
      background: isTest ? 'var(--c-sfef3c7, #fef3c7)' : 'var(--c-sdbeafe, #dbeafe)',
      color: isTest ? 'var(--c-s92400e, #92400e)' : 'var(--c-s1e40af, #1e40af)',
      fontSize: 13, fontWeight: 700, fontFamily: FONT,
      border: `1px solid ${isTest ? '#fde68a' : '#bfdbfe'}`,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {isTest ? 'Test' : 'Broadcast'}
    </span>
  );
}

function LogStatusBadge({ status }) {
  const colors = {
    PENDING: { bg: 'var(--c-surfaceMuted, #f3f4f6)', color: 'var(--c-textSecondary)', border: '#e5e7eb' },
    SENT: { bg: 'var(--c-sd1fae5, #d1fae5)', color: 'var(--c-s065f46, #065f46)', border: '#a7f3d0' },
    FAILED: { bg: 'var(--c-dangerBg, #fee2e2)', color: 'var(--c-dangerStrong, #991b1b)', border: '#fecaca' },
  };
  const c = colors[status] || colors.PENDING;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4,
      background: c.bg, color: c.color,
      fontSize: 13, fontWeight: 600, fontFamily: FONT,
      border: `1px solid ${c.border}`,
    }}>
      {status}
    </span>
  );
}

function TagBadge({ tag }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 4,
      background: tag.color,
      color: '#fff',
      border: `1px solid ${tag.color}`,
      fontSize: 13, fontWeight: 700,
      fontFamily: FONT,
    }}>
      {tag.name}
    </span>
  );
}

function BroadcastMessagePreview({ messageType, body, url, mediaLibraryId, caption, mediaItems }) {
  const selectedMedia = mediaItems.find(m => String(m.id) === String(mediaLibraryId));
  const resolvedBody = (body || url || caption || '').replace(/\{\{name\}\}/g, 'John Doe').replace(/\{\{contact_number\}\}/g, '+91 98765 43210');

  return (
    <div style={{ width: 278, background: 'linear-gradient(155deg, var(--c-sd8d8de, #D8D8DE) 0%, #A6A6AD 30%, #82828A 58%, var(--c-sbfbfc5, #BFBFC5) 82%, #6E6E76 100%)', borderRadius: 52, padding: 3.5, boxShadow: '0 22px 50px rgba(0,0,0,.28), 0 4px 10px rgba(0,0,0,.10), inset 0 0 0 0.5px rgba(255,255,255,.55), inset 0 -2px 4px rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#000', borderRadius: 48.5, padding: 2, flex: 1, minHeight: 280, display: 'flex', flexDirection: 'column', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,.12)' }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: 46.5, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#075E54' }}>
          {/* Chat header */}
          <div style={{ background: '#075E54', paddingTop: 50, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, color: '#fff', fontFamily: "-apple-system, 'SF Pro Display', system-ui, sans-serif", flexShrink: 0, position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#fff', fontSize: 22, lineHeight: 1, opacity: .9, marginRight: -2 }}>‹</span>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg,#1D9E75,#0F6E56)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>F</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Your Business</div>
                <div style={{ fontSize: 12, opacity: .82, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>online</div>
              </div>
            </div>
          </div>
          {/* Chat body */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--c-chatWall)', padding: '10px 7px', backgroundImage: 'var(--c-chatPattern)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
              <span style={{ background: 'var(--c-infoBg, #E1F2FA)', color: 'var(--c-s3c6678, #3C6678)', fontSize: 11, padding: '2px 9px', borderRadius: 99, fontWeight: 600 }}>TODAY</span>
            </div>
            <div style={{ marginLeft: 'auto', maxWidth: '88%', minWidth: '55%' }}>
              <div style={{ background: 'var(--c-sdcf8c6, #DCF8C6)', borderRadius: '7.5px 7.5px 0 7.5px', padding: '6px 7px 5px 9px', boxShadow: '0 1px 0.5px rgba(11,20,26,.13)', position: 'relative', marginRight: 8 }}>
                <div style={{ position: 'absolute', bottom: 0, right: -8, width: 0, height: 0, borderStyle: 'solid', borderWidth: '0 0 9px 9px', borderColor: 'transparent transparent #DCF8C6 transparent' }} />

                {messageType === 'image' && selectedMedia && (
                  <img src={api.mediaLibrary.downloadUrl(selectedMedia.id)} alt="" style={{ margin: '-6px -7px 6px -9px', borderRadius: '7.5px 7.5px 0 0', height: 120, width: 'calc(100% + 16px)', objectFit: 'cover', display: 'block' }} />
                )}
                {messageType === 'video' && selectedMedia && (
                  <div style={{ margin: '-6px -7px 6px -9px', borderRadius: '7.5px 7.5px 0 0', height: 120, position: 'relative', overflow: 'hidden' }}>
                    <video src={api.mediaLibrary.downloadUrl(selectedMedia.id)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} preload="metadata" muted />
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                      <div style={{ width: 38, height: 38, borderRadius: 99, background: 'rgba(255,255,255,.15)', border: '1.5px solid rgba(255,255,255,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Play size={16} color="white" fill="white" />
                      </div>
                    </div>
                  </div>
                )}
                {messageType === 'audio' && selectedMedia && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#0F6E56', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Music size={14} color="#fff" />
                    </div>
                    <div style={{ flex: 1, height: 4, background: 'rgba(0,0,0,0.1)', borderRadius: 2 }} />
                    <span style={{ fontSize: 12, color: 'var(--c-textSecondary)' }}>0:15</span>
                  </div>
                )}
                {messageType === 'document' && selectedMedia && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 8px', background: 'rgba(0,0,0,.06)', borderRadius: 6 }}>
                    <div style={{ width: 34, height: 38, background: 'var(--c-cardBg)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,.15)' }}>
                      <FileText size={16} color="#9e9e9e" />
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)', fontFamily: FONT }}>{selectedMedia.name || 'Document'}</div>
                      <div style={{ fontSize: 11, color: 'var(--c-textMuted)', fontFamily: FONT }}>PDF</div>
                    </div>
                  </div>
                )}

                {resolvedBody && (
                  <div style={{ fontSize: 15, color: 'var(--c-text)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: FONT }}>{resolvedBody}</div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, marginTop: 2, marginBottom: -1 }}>
                  <span style={{ fontSize: 12, color: 'var(--c-textSecondary)', fontFamily: FONT }}>9:41</span>
                  <svg width="16" height="11" viewBox="0 0 16 11" fill="none"><path d="M1 5.5L5 9.5L11.5 1" stroke="#53BDEB" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 5.5L9 9.5L15.5 1" stroke="#53BDEB" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A from/to date filter that sits inline in the recipient toolbar.
 *
 * Collapsed to a chip until used, because two always-open date ranges next to
 * a search box and a tag picker is a wall of empty inputs. The chip shows the
 * active range, so a filter can never be silently narrowing the list while
 * looking switched off.
 */
// A small inline choice. Deliberately a set of buttons and not a dropdown: with
// two or three short options, a dropdown hides the answer you are looking at.
function Segmented({ value, onChange, options, title }) {
  return (
    <div title={title} style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      {options.map(opt => {
        const active = value === opt.k;
        return (
          <button
            key={opt.k}
            onClick={() => onChange(opt.k)}
            style={{
              padding: '8px 12px', border: 'none', cursor: 'pointer', fontFamily: FONT,
              fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
              background: active ? C.primary : 'var(--c-cardBg)',
              color: active ? '#fff' : C.textSecondary,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function DateRangeFilter({ label, title, from, to, onFrom, onTo }) {
  const [open, setOpen] = useState(false);
  const active = !!(from || to);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const short = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
  const summary = !active ? label
    : from && to ? `${label}: ${short(from)} – ${short(to)}`
    : from ? `${label}: from ${short(from)}`
    : `${label}: until ${short(to)}`;

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title={title}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 8,
          border: `1px solid ${active ? C.primary : C.border}`,
          background: active ? C.primaryLight : 'var(--c-cardBg)',
          color: active ? C.primary : C.textSecondary,
          cursor: 'pointer', fontSize: 14, fontWeight: 600, fontFamily: FONT, whiteSpace: 'nowrap',
        }}
      >
        <CalendarDays size={13} /> {summary}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 60,
          background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 10,
          boxShadow: C.shadowLg, padding: 12, minWidth: 250, fontFamily: FONT,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
            {label} between
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={from} max={to || undefined} onChange={e => onFrom(e.target.value)}
              style={{ flex: 1, padding: '7px 8px', borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT, background: 'var(--c-cardBg)', color: C.text }} />
            <span style={{ fontSize: 14, color: C.textMuted }}>to</span>
            {/* `min={from}` stops an impossible range being expressible at all,
                rather than accepting it and silently matching nobody. */}
            <input type="date" value={to} min={from || undefined} onChange={e => onTo(e.target.value)}
              style={{ flex: 1, padding: '7px 8px', borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT, background: 'var(--c-cardBg)', color: C.text }} />
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 7, lineHeight: 1.5 }}>{title}</div>
          {active && (
            <button type="button" onClick={() => { onFrom(''); onTo(''); }}
              style={{ marginTop: 9, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: C.primary, fontFamily: FONT }}>
              Clear this range
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * An absolute instant (what the API stores) back into the LOCAL wall-clock
 * string a `datetime-local` input needs. The exact inverse of the
 * `toISOString()` the composer applies on save — reopening a scheduled
 * broadcast must show the time it will actually fire, in the reader's own zone.
 */
function toLocalInputValue(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Manual vs Scheduled, plus the quick ways of saying "when".
 *
 * ⚠ Everything here produces a LOCAL wall-clock string in the exact shape a
 * `datetime-local` input uses (`YYYY-MM-DDTHH:mm`), which the caller converts
 * once with `toISOString()`. Building an ISO string here instead would bake in
 * a timezone twice and land the send hours off.
 *
 * The presets are conveniences over the same field, not separate modes: every
 * one of them just fills the datetime box, so what will happen is always
 * visible and always editable. A preset that set hidden state would leave the
 * operator trusting a label instead of reading a time.
 */
function ScheduleSection({ mode, onMode, value, onValue, recurrence, onRecurrence, endsOn, onEndsOn, maxRuns, onMaxRuns, skipAlreadySent, onSkipAlreadySent }) {
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const atTime = (dayOffset, hh, mm = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return local(d);
  };
  // Next occurrence of a weekday (0=Sun). Always in the FUTURE: picking
  // "Monday" on a Monday afternoon must mean next Monday, not a time today
  // that has already passed and would fire on the very next tick.
  const nextWeekday = (dow, hh = 10) => {
    const d = new Date();
    let delta = (dow - d.getDay() + 7) % 7;
    if (delta === 0) {
      const candidate = new Date(d); candidate.setHours(hh, 0, 0, 0);
      if (candidate <= d) delta = 7;
    }
    d.setDate(d.getDate() + delta);
    d.setHours(hh, 0, 0, 0);
    return local(d);
  };

  const now = new Date();
  const presets = [
    { label: 'In 1 hour', v: local(new Date(now.getTime() + 60 * 60 * 1000)) },
    { label: 'Today 6pm', v: atTime(0, 18), hide: now.getHours() >= 18 },
    { label: 'Tomorrow 10am', v: atTime(1, 10) },
    { label: 'Tomorrow 6pm', v: atTime(1, 18) },
  ].filter(p => !p.hide);

  const WEEK = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
  const isPast = value && new Date(value).getTime() <= Date.now();

  const pill = (on) => ({
    padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
    border: `1.5px solid ${on ? C.primary : C.border}`,
    background: on ? C.primaryLight : 'var(--c-cardBg)',
    color: on ? C.primary : C.text,
    fontSize: 15, fontFamily: FONT, fontWeight: on ? 700 : 500,
  });
  const chip = (on) => ({
    padding: '6px 11px', borderRadius: 20, cursor: 'pointer',
    border: `1px solid ${on ? C.primary : C.border}`,
    background: on ? C.primaryLight : 'var(--c-cardBg)',
    color: on ? C.primary : C.textSecondary,
    fontSize: 14, fontFamily: FONT, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap',
  });

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
        When should this send?
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: mode === 'manual' ? 0 : 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onMode('manual')} style={pill(mode === 'manual')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><MousePointerClick size={14} /> Manually</span>
        </button>
        <button type="button" onClick={() => onMode('scheduled')} style={pill(mode === 'scheduled')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> At a scheduled time</span>
        </button>
        <button type="button" onClick={() => onMode('repeating')} style={pill(mode === 'repeating')}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Repeat size={14} /> Repeating</span>
        </button>
      </div>

      {mode === 'manual' ? (
        <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginTop: 6 }}>
          Nothing is sent until you press Broadcast Now. You can still save it as a draft.
        </div>
      ) : mode === 'repeating' ? (
        <RepeatConfig
          recurrence={recurrence} onRecurrence={onRecurrence}
          endsOn={endsOn} onEndsOn={onEndsOn}
          maxRuns={maxRuns} onMaxRuns={onMaxRuns}
          skipAlreadySent={skipAlreadySent} onSkipAlreadySent={onSkipAlreadySent}
        />
      ) : (
        <div style={{ background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {presets.map(p => (
              <button key={p.label} type="button" onClick={() => onValue(p.v)} style={chip(value === p.v)}>{p.label}</button>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Or a day next week — 10am
          </div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            {WEEK.map(([lbl, dow]) => {
              const v = nextWeekday(dow);
              return <button key={lbl} type="button" onClick={() => onValue(v)} style={chip(value === v)}>{lbl}</button>;
            })}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
            Exact date &amp; time
          </div>
          <input
            type="datetime-local"
            value={value}
            min={local(new Date())}
            onChange={e => onValue(e.target.value)}
            style={{
              width: '100%', padding: '9px 10px', borderRadius: 8,
              border: `1px solid ${isPast ? C.primary : C.border}`,
              background: 'var(--c-cardBg)', color: C.text, fontSize: 15,
              fontFamily: FONT, outline: 'none', boxSizing: 'border-box',
            }}
          />
          {/* The backend rejects a past time with a 400 — say so here rather
              than letting someone press Schedule and read an error. */}
          {isPast && (
            <div style={{ fontSize: 13, color: C.primary, fontFamily: FONT, marginTop: 6, fontWeight: 600 }}>
              That time has already passed — pick a future one.
            </div>
          )}
          {value && !isPast && (
            <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT, marginTop: 7 }}>
              Sends automatically on{' '}
              <strong style={{ color: C.text }}>
                {new Date(value).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </strong>
              {' '}· your local time.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How often a repeating broadcast fires, and when it stops.
 *
 * ⚠ The end condition is REQUIRED (the backend refuses a series without one).
 * A repeating blast to real customers with no end should not be expressible,
 * so this asks for it up front rather than letting the save fail.
 *
 * `timeOfDay` is wall-clock IST — the timezone every schedule in this app is
 * expressed in — so it is sent as "HH:MM" and never converted here.
 */
function RepeatConfig({ recurrence, onRecurrence, endsOn, onEndsOn, maxRuns, onMaxRuns, skipAlreadySent, onSkipAlreadySent }) {
  const r = recurrence || {};
  const set = (patch) => onRecurrence({ ...r, ...patch });
  // ISO weekday numbering (1=Mon … 7=Sun) — matches Postgres `isodow`, so the
  // two never need translating between.
  const WEEK = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 7]];
  const days = Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [];
  const toggleDay = (d) => set({ daysOfWeek: days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort() });

  const chip = (on) => ({
    padding: '6px 11px', borderRadius: 20, cursor: 'pointer',
    border: `1px solid ${on ? C.primary : C.border}`,
    background: on ? C.primaryLight : 'var(--c-cardBg)',
    color: on ? C.primary : C.textSecondary,
    fontSize: 14, fontFamily: FONT, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap',
  });
  const lbl = { fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 };
  const inp = {
    padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
    background: 'var(--c-cardBg)', color: C.text, fontSize: 15, fontFamily: FONT, outline: 'none',
  };
  const hasEnd = !!endsOn || !!maxRuns;

  return (
    <div style={{ background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={lbl}>How often</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => set({ kind: k })} style={chip(r.kind === k)}>{label}</button>
        ))}
      </div>

      {r.kind === 'weekly' && (
        <>
          <div style={lbl}>On these days</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            {WEEK.map(([label, d]) => (
              <button key={d} type="button" onClick={() => toggleDay(d)} style={chip(days.includes(d))}>{label}</button>
            ))}
          </div>
        </>
      )}

      {r.kind === 'monthly' && (
        <>
          <div style={lbl}>On day of the month</div>
          {/* Capped at 28 so every month can actually fire it — a series set to
              the 31st would silently skip February and every 30-day month,
              which reads as "it stopped working". */}
          <input type="number" min={1} max={28} value={r.dayOfMonth || ''}
            onChange={e => set({ dayOfMonth: e.target.value })}
            style={{ ...inp, width: 100, marginBottom: 12 }} />
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: -6, marginBottom: 12 }}>
            1–28, so every month can fire it.
          </div>
        </>
      )}

      <div style={lbl}>At what time</div>
      <input type="time" value={r.timeOfDay || ''} onChange={e => set({ timeOfDay: e.target.value })}
        style={{ ...inp, width: 140, marginBottom: 12 }} />

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 2 }}>
        <div style={lbl}>Until when</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={endsOn || ''} min={new Date().toISOString().slice(0, 10)}
            onChange={e => onEndsOn(e.target.value)} style={{ ...inp, flex: '1 1 150px' }} />
          <span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>or after</span>
          <input type="number" min={1} placeholder="runs" value={maxRuns || ''}
            onChange={e => onMaxRuns(e.target.value)} style={{ ...inp, width: 90 }} />
          <span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>runs</span>
        </div>
        {!hasEnd && (
          <div style={{ fontSize: 13, color: C.primary, fontWeight: 600, fontFamily: FONT, marginTop: 7 }}>
            Set one of these. A repeating broadcast with no end would keep messaging people forever.
          </div>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', marginTop: 12 }}>
        <input type="checkbox" checked={skipAlreadySent !== false}
          onChange={e => onSkipAlreadySent(e.target.checked)}
          style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer' }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: FONT }}>
            Never message the same person twice
          </div>
          <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginTop: 2, lineHeight: 1.5 }}>
            {skipAlreadySent !== false
              ? 'Each run only reaches people this schedule has not messaged before — so "everyone who arrived recently" means the new ones, not last week\'s list again.'
              : 'Every run messages everyone who matches, including people it has already reached. Only turn this off for a genuine repeat reminder.'}
          </div>
        </div>
      </label>
    </div>
  );
}

/**
 * The audience of a REPEATING broadcast — a rule, not a ticked list.
 *
 * ⚠ This exists because a frozen list cannot express what recurrence is FOR.
 * "Every Monday, message whoever arrived last week" has a different answer each
 * Monday; ticking 50 boxes today would just re-send to those same 50 forever.
 *
 * The windows are RELATIVE ("in the last N days") for the same reason: an
 * absolute date range would match the identical people on every run.
 *
 * Preview goes through the SAME resolver the run uses, so it cannot promise an
 * audience different from the one that actually gets messaged.
 */
function AudienceRule({ categories, tags, tagIds, onTagIds, arrivedWithinDays, onArrivedWithinDays,
                        notRepliedForDays, onNotRepliedForDays, scope, fromNumber, preview, onPreview }) {
  const [busy, setBusy] = useState(false);
  const lbl = { fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 };
  const inp = {
    padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
    background: 'var(--c-cardBg)', color: C.text, fontSize: 15, fontFamily: FONT, outline: 'none', width: 90,
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const r = await api.broadcastSeries.previewRule({
        fromNumber,
        audience: {
          scope, waNumber: fromNumber, tagIds,
          arrivedWithinDays: arrivedWithinDays || null,
          notRepliedForDays: notRepliedForDays || null,
        },
      });
      onPreview(r);
    } catch (e) {
      notify(e.message || 'Could not preview this audience');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT, lineHeight: 1.55, marginBottom: 12 }}>
        A repeating broadcast works out its own audience <strong>every time it runs</strong>, so there is no list to
        tick here. Describe who it should reach and it re-checks on each run.
      </div>

      <div style={lbl}>With any of these tags</div>
      <div style={{ marginBottom: 14 }}>
        <TagMultiSelect categories={categories} tags={tags} selectedIds={tagIds} onChange={onTagIds} minWidth={200} />
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <div>
          <div style={lbl}>Arrived in the last</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="number" min={1} placeholder="any" value={arrivedWithinDays}
              onChange={e => onArrivedWithinDays(e.target.value)} style={inp} />
            <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>days</span>
          </div>
        </div>
        <div>
          <div style={lbl}>Has not replied for</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="number" min={1} placeholder="any" value={notRepliedForDays}
              onChange={e => onNotRepliedForDays(e.target.value)} style={inp} />
            <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>days</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginTop: 8, lineHeight: 1.5 }}>
        Leave a box empty to ignore it. Someone who has never replied counts as “has not replied”.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" onClick={runPreview} disabled={busy}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: `1px solid ${C.border}`,
            background: 'var(--c-cardBg)', color: C.text, cursor: busy ? 'wait' : 'pointer',
            fontSize: 14, fontWeight: 600, fontFamily: FONT,
          }}>
          {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Users size={13} />}
          Who matches right now?
        </button>
        {preview && (
          <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>
            <strong style={{ color: C.text }}>{preview.count}</strong> match today
            {preview.sample?.length ? ` — ${preview.sample.slice(0, 3).map(p => p.name).filter(Boolean).join(', ')}${preview.count > 3 ? '…' : ''}` : ''}
          </span>
        )}
      </div>
      {/* The preview cannot apply the already-messaged filter, because the
          schedule does not exist yet. Said plainly rather than quietly
          overstating what the first run will reach. */}
      {preview && (
        <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, marginTop: 6, lineHeight: 1.5 }}>
          Today's count. Later runs also skip anyone this schedule has already messaged.
        </div>
      )}
    </div>
  );
}

const DOW = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

/** Plain-English summary of a recurrence rule, so nobody has to read JSON. */
function describeRecurrence(r = {}) {
  const at = r.timeOfDay ? ` at ${r.timeOfDay}` : '';
  if (r.kind === 'daily') return `Every day${at}`;
  if (r.kind === 'weekly') {
    const days = (r.daysOfWeek || []).map(d => DOW[d]).filter(Boolean).join(', ');
    return `Every ${days || 'week'}${at}`;
  }
  if (r.kind === 'monthly') return `Day ${r.dayOfMonth} of each month${at}`;
  return 'Not set';
}

/**
 * The repeating schedules, with their run history.
 *
 * Each row is a SCHEDULE, not a send — the sends it produced appear in the
 * other tabs as ordinary broadcasts with their own delivery stats.
 */
// ⚠ Mirrors EDITABLE_STATUSES in routes/broadcasts.js. Anything not in this
// list has already been handed to Meta, so there is nothing an edit could
// change — the server refuses it too, and the UI must not offer a button the
// server will reject.
const EDITABLE_BROADCAST_STATUSES = ['DRAFT', 'SCHEDULED'];

function SeriesList({ series, onChanged, isAdmin, onEdit }) {
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirmEl, confirm] = useConfirm();

  const open = async (id) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    try { setDetail(await api.broadcastSeries.get(id)); } catch { /* row still renders */ }
  };

  const toggle = async (s) => {
    setBusy(s.id);
    try {
      await api.broadcastSeries.setActive(s.id, !s.active);
      await onChanged();
    } catch (e) { notify(e.message || 'Could not change the schedule'); }
    finally { setBusy(null); }
  };

  const runNow = async (s) => {
    const ok = await confirm({
      title: 'Run this now?',
      body: `"${s.name}" will work out who matches right now and message them for real. This counts as one of its runs.`,
      confirmLabel: 'Run now', danger: true,
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      const r = await api.broadcastSeries.runNow(s.id);
      notify({ variant: 'success', message: r.sent ? `Sent to ${r.count} recipient(s).` : 'Nobody matched the rule right now, so nothing was sent.' });
      await onChanged();
    } catch (e) { notify(e.message || 'Could not run it'); }
    finally { setBusy(null); }
  };

  const remove = async (s) => {
    const ok = await confirm({
      title: 'Delete this schedule?',
      body: `"${s.name}" stops repeating and its history is removed. Broadcasts it already sent are NOT deleted — they stay in the list with their delivery stats.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try { await api.broadcastSeries.delete(s.id); await onChanged(); }
    catch (e) { notify(e.message || 'Could not delete'); }
  };

  if (series.length === 0) {
    return (
      <div style={{ background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}`, padding: 48, textAlign: 'center' }}>
        <Repeat size={30} color={C.textMuted} style={{ opacity: 0.5, marginBottom: 10 }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 4, fontFamily: FONT }}>No repeating broadcasts</div>
        <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>
          Create one with "New Broadcast", then pick <strong>Repeating</strong> under "When should this send?".
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {series.map(s => (
        <div key={s.id} style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: FONT }}>{s.name}</span>
                <span style={{
                  fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                  padding: '2px 8px', borderRadius: 20,
                  background: s.active ? 'var(--c-successBg, #E3F5EF)' : 'var(--c-surfaceMuted, #F1F1EE)',
                  color: s.active ? 'var(--c-successText, #0F6E56)' : C.textMuted,
                }}>{s.active ? 'On' : 'Paused'}</span>
              </div>
              <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT, marginTop: 3 }}>
                {describeRecurrence(s.recurrence)} · from <MaskedNumber number={s.fromNumber} prefix="+" />
              </div>
            </div>

            <div style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT, minWidth: 150 }}>
              {/* An ACTIVE series shows its next fire; a paused one must not —
                  a "next run" on something switched off is a promise it will
                  not keep. */}
              {s.active && s.nextRunAt
                ? <>Next: <strong style={{ color: C.text }}>{new Date(s.nextRunAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</strong></>
                : <span style={{ color: C.textMuted }}>Not scheduled</span>}
              <div style={{ marginTop: 2 }}>
                {s.runsCount} run(s) · {s.reached ?? 0} people reached
                {s.maxRuns ? ` · stops after ${s.maxRuns}` : s.endsOn ? ` · until ${s.endsOn}` : ''}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => toggle(s)} disabled={busy === s.id}
                style={{
                  padding: '7px 13px', borderRadius: 8, cursor: 'pointer',
                  border: `1.5px solid ${s.active ? C.border : C.purple}`,
                  background: 'var(--c-cardBg)', color: s.active ? C.textSecondary : C.purple,
                  fontSize: 14, fontWeight: 700, fontFamily: FONT, whiteSpace: 'nowrap',
                }}>
                {busy === s.id ? '…' : s.active ? 'Pause' : 'Switch on'}
              </button>
              {isAdmin && (
                <button type="button" onClick={() => runNow(s)} disabled={busy === s.id} title="Run one now"
                  style={{ padding: '7px 11px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                  <Play size={13} />
                </button>
              )}
              <button type="button" onClick={() => onEdit?.(s)} title="Edit"
                style={{ padding: '7px 11px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Pencil size={13} />
              </button>
              <button type="button" onClick={() => open(s.id)} title="History"
                style={{ padding: '7px 11px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Eye size={13} />
              </button>
              <button type="button" onClick={() => remove(s)} title="Delete"
                style={{ padding: '7px 11px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', color: C.primary, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {s.lastError && (
            <div style={{ padding: '8px 16px', background: 'var(--c-dangerBg, #FCEBEB)', color: 'var(--c-dangerText, #A32D2D)', fontSize: 14, fontFamily: FONT, borderTop: `1px solid ${C.border}` }}>
              Last run failed: {s.lastError}
            </div>
          )}

          {openId === s.id && (
            <div style={{ borderTop: `1px solid ${C.border}`, padding: '12px 16px', background: 'var(--c-surfaceAlt)' }}>
              {!detail ? (
                <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>Loading history…</div>
              ) : (detail.runs || []).length === 0 ? (
                <div style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>It has not run yet.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, fontFamily: FONT }}>
                  <thead>
                    <tr style={{ color: C.textMuted, textAlign: 'left' }}>
                      <th style={{ padding: '4px 6px', fontWeight: 600 }}>When</th>
                      <th style={{ padding: '4px 6px', fontWeight: 600 }}>Result</th>
                      <th style={{ padding: '4px 6px', fontWeight: 600 }}>Reached</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.runs.map(r => (
                      <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ padding: '6px' }}>{new Date(r.ranAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</td>
                        <td style={{ padding: '6px' }}>
                          <span style={{ color: r.status === 'failed' ? C.primary : r.status === 'skipped' ? C.textMuted : 'var(--c-successText, #0F6E56)', fontWeight: 600 }}>
                            {r.status}
                          </span>
                          {r.note ? <span style={{ color: C.textMuted }}> — {r.note}</span> : null}
                        </td>
                        <td style={{ padding: '6px', fontFamily: MONO }}>{r.recipientCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
      {confirmEl}
    </div>
  );
}

function KpiCards({ metrics }) {
  const { totalRecipients, totalSent, totalDelivered, totalRead } = metrics;

  const cards = [
    { key: 'recipients', label: 'Recipients', value: totalRecipients, color: 'var(--c-primary, #dc2626)', bg: 'var(--c-dangerBg, #FCEBEB)', icon: Users },
    { key: 'sent', label: 'Sent', value: totalSent, color: 'var(--c-infoBright, #2563eb)', bg: 'var(--c-infoBg, #E3F2FD)', icon: Send },
    { key: 'delivered', label: 'Received', value: totalDelivered, color: 'var(--c-successText, #0F6E56)', bg: 'var(--c-successBg, #E1F5EE)', icon: CheckCircle },
    { key: 'read', label: 'Read', value: totalRead, color: 'var(--c-s7c3aed, #7c3aed)', bg: 'var(--c-purpleBg, #EDE9FE)', icon: Eye },
  ];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 16,
      marginBottom: 24,
    }}>
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.key}
            style={{
              background: C.cardBg,
              borderRadius: 12,
              border: `1px solid ${C.border}`,
              padding: '20px 24px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: card.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <Icon size={20} color={card.color} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontFamily: FONT }}>
                {card.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: card.color, fontFamily: FONT, lineHeight: 1 }}>
                {card.value}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatSentTo(log) {
  if (log.action === 'TEST') {
    return `Test: ${log.sent_to}`;
  }
  // Aggregated broadcast log from backend already has formatted count
  if (log.sent_to && log.sent_to.includes('contact')) {
    return log.sent_to;
  }
  const count = log.sent_to ? log.sent_to.split(',').filter(Boolean).length : 0;
  if (count === 0) return 'Broadcast';
  if (count === 1) return '1 recipient';
  return `${count} recipients`;
}

export default function BulkMessagePage({ onNavigate, user }) {
  const [view, setView] = useState('list'); // 'list' | 'detail'
  const [broadcasts, setBroadcasts] = useState([]);
  const [series, setSeries] = useState([]);
  const [filterStatus, setFilterStatus] = useState('all');
  const [loading, setLoading] = useState(false);
  const [selectedBroadcast, setSelectedBroadcast] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [repeatModal, setRepeatModal] = useState(false);
  const [repeatSending, setRepeatSending] = useState(false);
  const [repeatTestNumber, setRepeatTestNumber] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ open: false, broadcast: null });
  const [selectedLog, setSelectedLog] = useState(null);

  // ─── New Broadcast Modal State ──────────────────────────────────────────────
  const [newBroadcastModal, setNewBroadcastModal] = useState(false);
  const [newBroadcastFrom, setNewBroadcastFrom] = useState('');
  const [newBroadcastTemplateId, setNewBroadcastTemplateId] = useState('');
  const [newBroadcastName, setNewBroadcastName] = useState('');
  // Scheduled send. Held as a `datetime-local` string (local wall-clock, no zone);
  // converted to an absolute ISO instant at submit so the backend fires at the
  // right moment regardless of server timezone.
  // 'manual' = it goes when you press the button. 'scheduled' = it goes at the
  // moment you pick, fired by the backend's own minute tick.
  //
  // This used to be implicit — three footer buttons, one of them next to a bare
  // datetime input — so "will this send now or later?" was answered by which
  // button you happened to press. Making it an explicit choice means the
  // primary action can state what it is about to do.
  const [sendMode, setSendMode] = useState('manual');
  // The composer is two steps, not one long scroll: WHAT you are sending, then
  // WHO gets it. The send mode lives at the top of step 1 because it changes
  // what step 2 even is — a ticked list for a one-off, an audience RULE for a
  // repeating send.
  const [composerStep, setComposerStep] = useState('message'); // 'message' | 'recipients'
  // Set when the composer was opened on an existing broadcast (draft/scheduled)
  // or an existing series. null = creating a new one.
  const [editing, setEditing] = useState(null); // { kind: 'broadcast'|'series', id, status }
  // Repeating-broadcast state. Kept beside the schedule rather than in a
  // separate modal: it is the same "when does this send?" decision.
  const [recurrence, setRecurrence] = useState({ kind: 'weekly', timeOfDay: '10:00', daysOfWeek: [1] });
  const [seriesEndsOn, setSeriesEndsOn] = useState('');
  const [seriesMaxRuns, setSeriesMaxRuns] = useState('');
  const [seriesSkipSent, setSeriesSkipSent] = useState(true);
  // ⚠ For a repeating send the ticked recipient list is meaningless — the
  // audience must be re-resolved each run. These are the RULE.
  const [ruleArrivedWithinDays, setRuleArrivedWithinDays] = useState('');
  const [ruleNotRepliedForDays, setRuleNotRepliedForDays] = useState('');
  const [rulePreview, setRulePreview] = useState(null);
  const [newBroadcastScheduleAt, setNewBroadcastScheduleAt] = useState('');
  const [newBroadcastTestNumber, setNewBroadcastTestNumber] = useState('');
  const [newBroadcasting, setNewBroadcasting] = useState(false);
  const [newBroadcastSendingTest, setNewBroadcastSendingTest] = useState(false);
  const [newBroadcastVariableMapping, setNewBroadcastVariableMapping] = useState({});
  // Per-variable "custom text" mode: when true the user types a literal value
  // (e.g. a static business name) instead of mapping to a contact field.
  const [customVarMode, setCustomVarMode] = useState({});
  const [newBroadcastMessageType, setNewBroadcastMessageType] = useState('template');
  const [newBroadcastBody, setNewBroadcastBody] = useState('');
  const [newBroadcastUrl, setNewBroadcastUrl] = useState('');
  const [newBroadcastMediaLibraryId, setNewBroadcastMediaLibraryId] = useState('');
  const [newBroadcastMediaItems, setNewBroadcastMediaItems] = useState([]);
  const [newBroadcastCaption, setNewBroadcastCaption] = useState('');
  const [newBroadcastMediaLoading, setNewBroadcastMediaLoading] = useState(false);
  const [newTestNumberSearch, setNewTestNumberSearch] = useState('');
  const [newTestNumberOpen, setNewTestNumberOpen] = useState(false);
  const newTestNumRef = useRef(null);
  const [showBroadcastConfirm, setShowBroadcastConfirm] = useState(false);

  const [numbers, setNumbers] = useState([]);
  const [selectedNumber, setSelectedNumber] = useState('');
  const [recipientScope, setRecipientScope] = useState('number'); // 'number' | 'all'
  // Payment broadcasts: the template carries the button, the broadcast carries
  // the price (chosen design — one template serves every product).
  const [payProductId, setPayProductId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payPurpose, setPayPurpose] = useState('');
  const [payProducts, setPayProducts] = useState([]);
  const [payConfirm, setPayConfirm] = useState(null);   // {status} while the typed gate is open
  const [payConfirmText, setPayConfirmText] = useState('');
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [contactFilterTagIds, setContactFilterTagIds] = useState([]);
  // Two independent ranges, because they answer different questions: "everyone
  // who came in during the Diwali campaign" vs "everyone who has gone quiet".
  const [arrivedFrom, setArrivedFrom] = useState('');
  const [arrivedTo, setArrivedTo] = useState('');
  const [repliedFrom, setRepliedFrom] = useState('');
  const [repliedTo, setRepliedTo] = useState('');
  // Has this person ever written to us at all? A date range cannot express
  // "never", because there is no date to compare — `last_inbound_at` is NULL.
  const [replyState, setReplyState] = useState('any');   // 'any' | 'replied' | 'never'
  // ⚠ Facet semantics: ANY within a category, ALL across categories. A contact
  // carries at most one tag per category, so "every selected tag" would be
  // unsatisfiable the moment two stages are picked — a filter that can only
  // ever return nobody. 'any' (the pre-existing behaviour) stays available.
  const [tagMatchMode, setTagMatchMode] = useState('all'); // 'all' | 'any'
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [selectedContactNumbers, setSelectedContactNumbers] = useState(new Set());

  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [linkedAccount, setLinkedAccount] = useState(null); // { id, displayName, wabaId, ... }
  const [accountLookupDone, setAccountLookupDone] = useState(false);

  // Load numbers on mount
  useEffect(() => {
    api.numbers()
      .then(data => {
        setNumbers(data);
        if (data.length > 0) setSelectedNumber(data[0].wa_number);
      })
      .catch(() => setNumbers([]));
  }, []);

  // Close the test-number combobox when clicking outside of it.
  useEffect(() => {
    if (!newTestNumberOpen) return;
    const onDown = (e) => { if (newTestNumRef.current && !newTestNumRef.current.contains(e.target)) setNewTestNumberOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [newTestNumberOpen]);

  // Load contacts for the recipient picker. In 'all' scope we pull every contact
  // across all business numbers (deduped); in 'number' scope just the selected one.
  useEffect(() => {
    if (recipientScope === 'all') {
      setContactsLoading(true);
      api.allSavedContacts()
        .then(data => setContacts(data.map(c => ({ ...c, tags: c.tags || [] }))))
        .catch(() => setContacts([]))
        .finally(() => setContactsLoading(false));
      return;
    }
    if (!selectedNumber) { setContacts([]); return; }
    setContactsLoading(true);
    api.savedContacts(selectedNumber)
      .then(data => setContacts(data.map(c => ({ ...c, tags: c.tags || [] }))))
      .catch(() => setContacts([]))
      .finally(() => setContactsLoading(false));
  }, [selectedNumber, recipientScope]);

  // Load categories, tags, templates when modal opens
  useEffect(() => {
    if (!newBroadcastModal) return;
    Promise.all([
      api.categories.list().catch(() => []),
      api.tags.list().catch(() => []),
      api.templates.list().catch(() => []),
    ]).then(([cats, tgs, tpls]) => {
      setCategories(cats);
      setTags(tgs);
      setTemplates(tpls.filter(t => t.status === 'APPROVED'));
    });
  }, [newBroadcastModal]);

  // Resolve the WhatsApp account that owns the chosen "from" number, so we can
  // (1) filter templates to the matching WABA and (2) warn if the number isn't
  // registered. Re-runs whenever the from-number changes.
  useEffect(() => {
    if (!newBroadcastFrom) {
      setLinkedAccount(null);
      setAccountLookupDone(false);
      return;
    }
    setAccountLookupDone(false);
    fetch(`/api/whatsapp-accounts/by-phone/${encodeURIComponent(newBroadcastFrom)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => setLinkedAccount(data))
      .catch(() => setLinkedAccount(null))
      .finally(() => setAccountLookupDone(true));
  }, [newBroadcastFrom]);

  // Filter approved templates to those belonging to the linked account's WABA.
  // If no linked account, show nothing (forces the user to fix the number).
  const eligibleTemplates = linkedAccount
    ? templates.filter(t => t.whatsappAccountId === linkedAccount.id)
    : [];

  // A schedule is only usable if it exists AND is still in the future. Checked
  // here as well as in ScheduleSection's own warning, because the backend 400s
  // a past time and the button must not offer to do something that will fail.
  //
  // Declared ABOVE the JSX that reads it — a const referenced before its own
  // declaration line throws on every render and whites out the page.
  const scheduleReady = !!newBroadcastScheduleAt && new Date(newBroadcastScheduleAt).getTime() > Date.now();

  // A series needs a complete recurrence AND an end. Mirrors the backend's own
  // refusals so the button never offers to do something that will 400.
  const seriesReady = (() => {
    const r = recurrence || {};
    if (!r.kind || !/^\d{1,2}:\d{2}$/.test(String(r.timeOfDay || ''))) return false;
    if (r.kind === 'weekly' && !(Array.isArray(r.daysOfWeek) && r.daysOfWeek.length)) return false;
    if (r.kind === 'monthly' && !(Number(r.dayOfMonth) >= 1 && Number(r.dayOfMonth) <= 28)) return false;
    return !!(seriesEndsOn || seriesMaxRuns);
  })();

  // `ignoreRecipients` is for a repeating broadcast: it has no ticked list at
  // all — its audience is a rule resolved at each run — so requiring one here
  // would make the Create button permanently dead in that mode.
  const isBroadcastFormInvalid = ({ ignoreRecipients = false } = {}) => {
    if (!newBroadcastFrom || newBroadcasting) return true;
    if (!ignoreRecipients && selectedRecipients.length === 0) return true;
    if (newBroadcastMessageType === 'template' && !selectedTemplate) return true;
    if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return true;
    if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return true;
    if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return true;
    if (headerMediaType && !newBroadcastMediaLibraryId) return true;
    return false;
  };

  // Reset modal state when closed
  const closeNewBroadcastModal = () => {
    setNewBroadcastModal(false);
    setNewBroadcastFrom('');
    setNewBroadcastTemplateId('');
    setNewBroadcastName('');
    setNewBroadcastScheduleAt('');
    setSendMode('manual');
    setRecurrence({ kind: 'weekly', timeOfDay: '10:00', daysOfWeek: [1] });
    setSeriesEndsOn(''); setSeriesMaxRuns(''); setSeriesSkipSent(true);
    setRuleArrivedWithinDays(''); setRuleNotRepliedForDays(''); setRulePreview(null);
    setNewBroadcastTestNumber('');
    setNewBroadcastVariableMapping({});
    setCustomVarMode({});
    setNewBroadcastMessageType('template');
    setNewBroadcastBody('');
    setNewBroadcastUrl('');
    setNewBroadcastMediaLibraryId('');
    setPayProductId(''); setPayAmount(''); setPayPurpose('');
    setPayConfirm(null); setPayConfirmText('');
    setNewBroadcastMediaItems([]);
    setNewBroadcastCaption('');
    setNewBroadcastMediaLoading(false);
    setNewTestNumberSearch('');
    setNewTestNumberOpen(false);
    setSelectedContactNumbers(new Set());
    setContactSearch('');
    setContactFilterTagIds([]);
    setTagMatchMode('all');
    setReplyState('any');
    setShowSelectedOnly(false);
    setArrivedFrom(''); setArrivedTo(''); setRepliedFrom(''); setRepliedTo('');
    setComposerStep('message');
    setEditing(null);
  };

  /**
   * Open the composer on an EXISTING broadcast.
   *
   * `mode: 'edit'` writes back to the same row; `mode: 'duplicate'` prefills the
   * same content and leaves `editing` null, so saving creates a new draft. That
   * is what a sent broadcast gets instead of an Edit button: its messages are
   * already with Meta, so there is nothing an edit could change about them, and
   * a button that pretended otherwise would be worse than no button.
   */
  const openComposerFor = async (row, { mode = 'edit' } = {}) => {
    try {
      const b = await api.broadcasts.get(row.id);
      const full = b?.broadcast || b;
      setNewBroadcastModal(true);
      setComposerStep('message');
      setEditing(mode === 'edit' ? { kind: 'broadcast', id: full.id, status: full.status } : null);

      setNewBroadcastFrom(full.from_number || '');
      setSelectedNumber(full.from_number || '');
      setNewBroadcastName(mode === 'duplicate' ? `Copy of ${full.name || `#${full.id}`}` : (full.name || ''));
      setNewBroadcastMessageType(full.message_type || 'template');
      setNewBroadcastTemplateId(full.template_id ? String(full.template_id) : '');
      setNewBroadcastVariableMapping(full.variable_mapping || {});
      setNewBroadcastBody(full.body || '');
      setNewBroadcastUrl(full.url || '');
      setNewBroadcastMediaLibraryId(full.media_library_id ? String(full.media_library_id) : '');
      setNewBroadcastCaption(full.caption || '');
      setNewBroadcastTestNumber(full.test_number || '');
      setPayProductId(full.payment_course_id ? String(full.payment_course_id) : '');
      setPayAmount(full.payment_amount_paise != null ? String(full.payment_amount_paise / 100) : '');
      setPayPurpose(full.payment_purpose || '');

      // A duplicate always starts as a manual draft: inheriting a scheduled time
      // that has since passed would produce a copy that either refuses to save
      // or fires the moment it is created.
      if (mode === 'edit' && full.scheduled_at && new Date(full.scheduled_at).getTime() > Date.now()) {
        setSendMode('scheduled');
        setNewBroadcastScheduleAt(toLocalInputValue(full.scheduled_at));
      } else {
        setSendMode('manual');
        setNewBroadcastScheduleAt('');
      }

      const recips = Array.isArray(full.recipient_numbers) ? full.recipient_numbers : [];
      setSelectedContactNumbers(new Set(recips.map(r => r.contact_number || r.number || r)));
    } catch (e) {
      notify(e.message || 'Could not open that broadcast');
    }
  };

  /** Open the composer on an existing repeating series. */
  const openSeriesEditor = async (row) => {
    try {
      const r = await api.broadcastSeries.get(row.id);
      const sx = r?.series || r;
      setNewBroadcastModal(true);
      setComposerStep('message');
      setEditing({ kind: 'series', id: sx.id, status: sx.active ? 'ACTIVE' : 'PAUSED' });
      setSendMode('repeating');
      setNewBroadcastName(sx.name || '');
      setNewBroadcastFrom(sx.fromNumber || sx.from_number || '');
      setSelectedNumber(sx.fromNumber || sx.from_number || '');
      setNewBroadcastMessageType(sx.messageType || sx.message_type || 'template');
      setNewBroadcastTemplateId((sx.templateId || sx.template_id) ? String(sx.templateId || sx.template_id) : '');
      setNewBroadcastVariableMapping(sx.variableMapping || sx.variable_mapping || {});
      setNewBroadcastBody(sx.body || '');
      setNewBroadcastUrl(sx.url || '');
      setNewBroadcastMediaLibraryId((sx.mediaLibraryId || sx.media_library_id) ? String(sx.mediaLibraryId || sx.media_library_id) : '');
      setNewBroadcastCaption(sx.caption || '');
      if (sx.recurrence) setRecurrence(sx.recurrence);
      setSeriesEndsOn(sx.endsOn || sx.ends_on || '');
      setSeriesMaxRuns(sx.maxRuns != null ? String(sx.maxRuns) : (sx.max_runs != null ? String(sx.max_runs) : ''));
      setSeriesSkipSent((sx.skipAlreadySent ?? sx.skip_already_sent) !== false);
      const aud = sx.audience || {};
      setRecipientScope(aud.scope === 'all' ? 'all' : 'number');
      setContactFilterTagIds(Array.isArray(aud.tagIds) ? aud.tagIds : []);
      setRuleArrivedWithinDays(aud.arrivedWithinDays != null ? String(aud.arrivedWithinDays) : '');
      setRuleNotRepliedForDays(aud.notRepliedForDays != null ? String(aud.notRepliedForDays) : '');
      setRulePreview(null);
    } catch (e) {
      notify(e.message || 'Could not open that schedule');
    }
  };

  const loadSeries = async () => {
    try {
      const r = await api.broadcastSeries.list();
      setSeries(Array.isArray(r?.series) ? r.series : []);
    } catch { setSeries([]); }
  };

  const loadBroadcasts = async () => {
    setLoading(true);
    try {
      // SERIES is a view of the schedules, not a broadcast status — asking the
      // broadcasts endpoint for it would return nothing and read as "no
      // repeating broadcasts" when several exist.
      const statusArg = (filterStatus === 'all' || filterStatus === 'SERIES') ? '' : filterStatus;
      const [data] = await Promise.all([api.broadcasts.list(statusArg), loadSeries()]);
      setBroadcasts(data);
    } catch (err) {
      console.error('Failed to load broadcasts:', err);
      setBroadcasts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBroadcasts();
  }, [filterStatus]);

  // Load media library items when message type is a media type, OR when a
  // template with a media header (IMAGE/VIDEO/DOCUMENT) is selected — both need
  // a Media Library pick. Filter to the relevant media type.
  useEffect(() => {
    const mediaTypes = ['image', 'video', 'audio', 'document'];
    let neededType = null;
    if (mediaTypes.includes(newBroadcastMessageType)) {
      neededType = newBroadcastMessageType;
    } else if (newBroadcastMessageType === 'template') {
      const tpl = templates.find(t => t.id.toString() === newBroadcastTemplateId);
      const ht = String(tpl?.header_type || '').toLowerCase();
      if (['image', 'video', 'document'].includes(ht)) neededType = ht;
    }
    if (!neededType) {
      setNewBroadcastMediaItems([]);
      return;
    }
    setNewBroadcastMediaLoading(true);
    api.mediaLibrary.list()
      .then(res => {
        const filtered = (res.media || []).filter(m => m.mediaType === neededType);
        setNewBroadcastMediaItems(filtered);
        // For a media-header template, auto-prefill the picker with the media the
        // template was built with (if it still exists in the library), so the
        // user doesn't have to re-select it. They can still override.
        if (newBroadcastMessageType === 'template') {
          const tpl = templates.find(t => t.id.toString() === newBroadcastTemplateId);
          const savedId = tpl?.header_media_library_id;
          if (savedId && filtered.some(m => String(m.id) === String(savedId))) {
            setNewBroadcastMediaLibraryId(prev => prev || String(savedId));
          }
        }
      })
      .catch(() => setNewBroadcastMediaItems([]))
      .finally(() => setNewBroadcastMediaLoading(false));
  }, [newBroadcastMessageType, newBroadcastTemplateId, templates]);

  const openDetail = async (broadcast) => {
    setDetailLoading(true);
    setView('detail');
    try {
      const data = await api.broadcasts.get(broadcast.id);
      setSelectedBroadcast(data);
    } catch (err) {
      notify('Failed to load broadcast details');
      setView('list');
    } finally {
      setDetailLoading(false);
    }
  };

  // Live-refresh the broadcast detail while the view is open. Meta sends
  // `sent` → `delivered` → `read` webhooks for each recipient over several
  // seconds/minutes; without polling, the Delivery Summary stays frozen at
  // whatever the values were when the modal opened. Stop polling when every
  // recipient has reached a terminal state (read or failed).
  useEffect(() => {
    if (view !== 'detail' || !selectedBroadcast?.id) return;
    const isTerminal = (b) => {
      const r = b?.statusRollup || {};
      const total = r.total || 0;
      if (total === 0) return false;
      const terminal = (r.read || 0) + (r.failed || 0);
      return terminal >= total;
    };
    if (isTerminal(selectedBroadcast)) return;
    const tick = async () => {
      try {
        const data = await api.broadcasts.get(selectedBroadcast.id);
        setSelectedBroadcast(prev => prev && prev.id === data.id ? data : prev);
      } catch { /* swallow — next tick retries */ }
    };
    const intervalId = setInterval(tick, 4000);
    return () => clearInterval(intervalId);
  }, [view, selectedBroadcast?.id, selectedBroadcast?.statusRollup?.read, selectedBroadcast?.statusRollup?.failed, selectedBroadcast?.statusRollup?.total]);

  const handleDelete = async () => {
    const b = deleteModal.broadcast;
    if (!b) return;
    try {
      await api.broadcasts.delete(b.id);
      setBroadcasts(prev => prev.filter(x => x.id !== b.id));
      setDeleteModal({ open: false, broadcast: null });
      if (selectedBroadcast?.id === b.id) {
        setView('list');
        setSelectedBroadcast(null);
      }
    } catch (err) {
      notify('Failed to delete broadcast: ' + err.message);
    }
  };

  const sel = useTableSelection(broadcasts);

  const handleBulkDelete = async (ids) => {
    await runBulkDelete(ids, (id) => api.broadcasts.delete(id), {
      label: 'broadcast',
      onSuccess: (deletedIds) => {
        const set = new Set(deletedIds);
        setBroadcasts(prev => prev.filter(b => !set.has(b.id)));
        if (selectedBroadcast?.id && set.has(selectedBroadcast.id)) {
          setView('list');
          setSelectedBroadcast(null);
        }
      },
    });
  };

  const handleRepeatBroadcast = async () => {
    if (!selectedBroadcast) return;
    setRepeatSending(true);
    try {
      const data = await api.broadcasts.send(selectedBroadcast.id);
      setSelectedBroadcast(data);
      setRepeatModal(false);
      setRepeatTestNumber('');
      loadBroadcasts();
    } catch (err) {
      notify('Failed to repeat broadcast: ' + err.message);
    } finally {
      setRepeatSending(false);
    }
  };

  const handleRepeatTest = async () => {
    if (!selectedBroadcast || !repeatTestNumber.trim()) return;
    setSendingTest(true);
    try {
      const data = await api.broadcasts.test(selectedBroadcast.id, repeatTestNumber.trim());
      setSelectedBroadcast(data);
      setRepeatTestNumber('');
      notify(`Test message sent to ${repeatTestNumber.trim()}`);
    } catch (err) {
      notify('Test failed: ' + err.message);
    } finally {
      setSendingTest(false);
    }
  };

  const recipientCount = (b) => {
    try {
      const arr = typeof b.recipient_numbers === 'string'
        ? JSON.parse(b.recipient_numbers)
        : b.recipient_numbers;
      return Array.isArray(arr) ? arr.length : 0;
    } catch { return 0; }
  };

  const formatRecipients = (b) => {
    const count = recipientCount(b);
    if (count === 0) return '0 contacts';
    if (count === 1) return '1 contact';
    return `${count} contacts`;
  };

  const templateForPreview = (b) => {
    if (!b) return null;
    return {
      header_type: b.header_type,
      header_text: b.header_text,
      // The media chosen for this broadcast (resolved at send time) drives the
      // header-media preview for IMAGE/VIDEO/DOCUMENT templates.
      header_media_library_id: b.media_library_id || null,
      body: b.template_body || b.body,
      footer: b.template_footer || b.footer,
      buttons: typeof b.template_buttons === 'string'
        ? JSON.parse(b.template_buttons || '[]')
        : (b.template_buttons || b.buttons || []),
    };
  };

  // Compute metrics from broadcast data — the backend's statusRollup now
  // returns cumulative funnel buckets (sent = ever-sent, delivered = ever-delivered,
  // read = read), so we use them directly. Don't sum — that double-counts.
  const getMetrics = (b) => {
    const totalRecipients = recipientCount(b);
    const r = b.statusRollup || b.status_rollup || {};
    return {
      totalRecipients,
      totalSent: r.sent || 0,
      totalDelivered: r.delivered || 0,
      totalRead: r.read || 0,
      totalFailed: r.failed || 0,
      totalPending: r.pending || 0,
      rollupTotal: r.total || totalRecipients,
    };
  };

  // ─── New Broadcast Modal Helpers ────────────────────────────────────────────
  // Extract template variables {{1}}, {{2}}, etc.
  const extractVars = (t) => {
    const m = [...(t || '').matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(m.map(x => x[1]))].sort((a, b) => +a - +b);
  };

  // Resolve template variables using mapping + first selected contact for live preview
  const resolvePreviewText = (text, mapping, contact) => {
    if (!text || !contact) return text || '';
    return text.replace(/\{\{(\d+)\}\}/g, (_, v) => {
      const field = mapping[v];
      if (!field) return `{{${v}}}`;
      if (field === 'name') return contact.name || `{{${v}}}`;
      if (field === 'contact_number') return maskPhone(contact.contact_number) || `{{${v}}}`;
      if (field.startsWith('custom_fields.')) {
        const id = field.split('.')[1];
        return contact.custom_fields?.[id] || `{{${v}}}`;
      }
      if (field.startsWith('category_tag.')) {
        const catId = field.split('.')[1];
        const tag = contact.tags?.find(t => t.category_id == catId);
        return tag?.name || `{{${v}}}`;
      }
      // Any other non-empty value is a literal "Custom text" the user typed —
      // show it verbatim (backend resolveTemplateParam passes it through too).
      return field || `{{${v}}}`;
    });
  };

  const selectedTemplate = templates.find(t => t.id.toString() === newBroadcastTemplateId);
  // 'image' | 'video' | 'document' when the selected template has a media header
  // (which requires a header image at send time), else null.
  const headerMediaType = (() => {
    if (newBroadcastMessageType !== 'template' || !selectedTemplate) return null;
    const ht = String(selectedTemplate.header_type || '').toUpperCase();
    return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht) ? ht.toLowerCase() : null;
  })();
  const selectedRecipients = contacts.filter(c => selectedContactNumbers.has(c.contact_number));
  const previewTemplate = selectedTemplate ? {
    ...selectedTemplate,
    body: resolvePreviewText(selectedTemplate.body, newBroadcastVariableMapping, selectedRecipients[0]),
    header_text: selectedTemplate.header_type === 'TEXT' ? resolvePreviewText(selectedTemplate.header_text, newBroadcastVariableMapping, selectedRecipients[0]) : selectedTemplate.header_text,
    // Show the chosen header media in the preview — the broadcast picker value
    // takes precedence, falling back to the media saved on the template itself.
    header_media_library_id: headerMediaType
      ? (newBroadcastMediaLibraryId || selectedTemplate.header_media_library_id || null)
      : null,
  } : null;

  const templateVars = useMemo(() => {
    if (!selectedTemplate) return [];
    const bodyVars = extractVars(selectedTemplate.body);
    const headerVars = selectedTemplate.header_type === 'TEXT' ? extractVars(selectedTemplate.header_text) : [];
    return [...new Set([...headerVars, ...bodyVars])].sort((a, b) => +a - +b);
  }, [selectedTemplate]);

  // Available contact fields for variable mapping
  const contactFieldOptions = useMemo(() => {
    const opts = [
      { value: 'name', label: 'Contact Name' },
      { value: 'contact_number', label: 'Phone Number' },
    ];
    categories.forEach(cat => {
      opts.push({ value: `category_tag.${cat.id}`, label: cat.name });
    });
    return opts;
  }, [categories]);

  // Date-range filters.
  //
  // ⚠ A range is INCLUSIVE of both ends, so the `to` bound has to be the END of
  // that day. Comparing a timestamp against the bare date string would exclude
  // everyone who arrived after midnight on the last day — i.e. almost all of
  // them — and the filter would look like it merely "found fewer people".
  const inDateRange = (value, from, to) => {
    if (!from && !to) return true;
    if (!value) return false;            // no date = cannot be inside a range
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) return false;
    if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
    if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
    return true;
  };

  // Selected tag ids grouped by the category they belong to. Built from the ONE
  // `contactFilterTagIds` array the payload and the audience rule already use —
  // a second per-category state would be a copy free to drift from it.
  const selectedTagsByCategory = (() => {
    const byId = new Map(tags.map(t => [t.id, t]));
    const groups = new Map();
    for (const id of contactFilterTagIds) {
      const t = byId.get(id);
      const key = t?.category_id ?? '__none__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    return groups;
  })();

  const matchesTagFilter = (c) => {
    if (contactFilterTagIds.length === 0) return true;
    const own = new Set((c.tags || []).map(t => t.id));
    if (tagMatchMode === 'any') return contactFilterTagIds.some(id => own.has(id));
    // 'all' = one match from EVERY category that has a selection.
    for (const ids of selectedTagsByCategory.values()) {
      if (!ids.some(id => own.has(id))) return false;
    }
    return true;
  };

  const filteredContacts = contacts.filter(c => {
    const matchesSearch = !contactSearch ||
      c.contact_number.includes(contactSearch) ||
      (c.name && c.name.toLowerCase().includes(contactSearch.toLowerCase()));
    const matchesTag = matchesTagFilter(c);
    const matchesArrived = inDateRange(c.created_at, arrivedFrom, arrivedTo);
    // `last_inbound_at` is the customer's OWN last message — never updated_at,
    // which the funnel stage-tag sweep bumps on hundreds of rows at once.
    const matchesReplied = inDateRange(c.last_inbound_at, repliedFrom, repliedTo);
    const matchesReplyState = replyState === 'any'
      || (replyState === 'replied' ? !!c.last_inbound_at : !c.last_inbound_at);
    // A view, not a filter: it never changes who is selected, only who is shown.
    const matchesSelectedOnly = !showSelectedOnly || selectedContactNumbers.has(c.contact_number);
    return matchesSearch && matchesTag && matchesArrived && matchesReplied
      && matchesReplyState && matchesSelectedOnly;
  });

  // Every filter, in one place. The Clear button, the "N of M match" counter and
  // the empty state all read this — three hand-kept copies is how the empty
  // state came to claim "no saved contacts" while 334 sat behind a date range.
  const activeFilterCount =
    (contactSearch ? 1 : 0) + (contactFilterTagIds.length > 0 ? 1 : 0)
    + (arrivedFrom || arrivedTo ? 1 : 0) + (repliedFrom || repliedTo ? 1 : 0)
    + (replyState !== 'any' ? 1 : 0) + (showSelectedOnly ? 1 : 0);
  const clearAllFilters = () => {
    setContactSearch(''); setContactFilterTagIds([]);
    setArrivedFrom(''); setArrivedTo(''); setRepliedFrom(''); setRepliedTo('');
    setReplyState('any'); setShowSelectedOnly(false);
  };

  const allSelected = filteredContacts.length > 0 && filteredContacts.every(c => selectedContactNumbers.has(c.contact_number));
  const someSelected = filteredContacts.some(c => selectedContactNumbers.has(c.contact_number)) && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedContactNumbers(prev => {
        const next = new Set(prev);
        filteredContacts.forEach(c => next.delete(c.contact_number));
        return next;
      });
    } else {
      setSelectedContactNumbers(prev => {
        const next = new Set(prev);
        filteredContacts.forEach(c => next.add(c.contact_number));
        return next;
      });
    }
  };

  const toggleSelectOne = (contactNumber) => {
    setSelectedContactNumbers(prev => {
      const next = new Set(prev);
      if (next.has(contactNumber)) next.delete(contactNumber);
      else next.add(contactNumber);
      return next;
    });
  };

  const getTagInfo = (tagRef) => tags.find(t => t.id === tagRef.id) || tagRef;

  const handleNewBroadcastTest = async () => {
    const testNo = String(newBroadcastTestNumber || '').replace(/\D/g, '');
    // The test number is independent of the recipient list — a test must work
    // even when "TO" has nothing selected.
    if (!testNo || !newBroadcastFrom) return;
    if (testNo.length < 7) { notify('Enter a valid test phone number (digits only, at least 7 digits).'); return; }
    if (newBroadcastMessageType === 'template' && !selectedTemplate) return;
    if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return;
    if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return;
    if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return;
    if (headerMediaType && !newBroadcastMediaLibraryId) return;
    setNewBroadcastSendingTest(true);
    try {
      const payload = {
        from_number: newBroadcastFrom,
        recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
        status: 'DRAFT',
        test_number: testNo,
        name: newBroadcastName.trim() || undefined,
        message_type: newBroadcastMessageType,
      };
      if (newBroadcastMessageType === 'template') {
        payload.template_id = selectedTemplate.id;
        payload.variable_mapping = newBroadcastVariableMapping;
        if (headerMediaType && newBroadcastMediaLibraryId) payload.media_library_id = Number(newBroadcastMediaLibraryId);
        if (isPaymentBroadcast) {
          payload.payment_course_id = payProductId ? Number(payProductId) : null;
          payload.payment_amount = payAmountNum;      // rupees; backend stores paise
          payload.payment_purpose = payPurpose.trim() || undefined;
        }
      } else if (newBroadcastMessageType === 'text') {
        payload.body = newBroadcastBody;
      } else if (newBroadcastMessageType === 'link') {
        payload.url = newBroadcastUrl;
      } else if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType)) {
        payload.media_library_id = Number(newBroadcastMediaLibraryId);
        payload.caption = newBroadcastCaption || undefined;
      }
      const broadcast = await api.broadcasts.create(payload);
      await api.broadcasts.test(broadcast.id, testNo);
      notify(`Test sent to ${testNo}. Check that WhatsApp to confirm delivery.`);
    } catch (err) {
      notify('Test failed: ' + err.message);
    } finally {
      setNewBroadcastSendingTest(false);
    }
  };

  useEffect(() => {
    let alive = true;
    api.products.list()
      .then(r => {
        if (!alive) return;
        const raw = Array.isArray(r) ? r : (r?.products || []);
        setPayProducts(raw.filter(p => p.active !== false).map(p => ({
          id: p.id, name: p.name,
          price: p.default_price_paise != null ? Number(p.default_price_paise) / 100 : null,
        })));
      })
      .catch(() => { if (alive) setPayProducts([]); });
    return () => { alive = false; };
  }, []);

  // Does the chosen template mint a live payment link per recipient?
  const isPaymentBroadcast = newBroadcastMessageType === 'template' && !!selectedTemplate?.hasPaymentButton;
  const payAmountNum = payAmount === '' ? null : Number(payAmount);
  const payTotal = isPaymentBroadcast && payAmountNum ? payAmountNum * selectedRecipients.length : 0;

  // Repeating broadcasts create a SERIES, never a broadcast. Separate function
  // rather than a branch inside handleNewBroadcastSave, because almost nothing
  // is shared: no recipient list, no scheduled_at, a different endpoint, and it
  // must never touch /send.
  const handleCreateSeries = async () => {
    if (isBroadcastFormInvalid({ ignoreRecipients: true })) return;
    setNewBroadcasting(true);
    try {
      const payload = {
        name: newBroadcastName.trim() || `${newBroadcastMessageType} series`,
        fromNumber: newBroadcastFrom,
        messageType: newBroadcastMessageType,
        recurrence,
        endsOn: seriesEndsOn || null,
        maxRuns: seriesMaxRuns || null,
        skipAlreadySent: seriesSkipSent,
        audience: {
          scope: recipientScope,
          waNumber: newBroadcastFrom,
          tagIds: contactFilterTagIds,
          arrivedWithinDays: ruleArrivedWithinDays || null,
          notRepliedForDays: ruleNotRepliedForDays || null,
        },
      };
      if (newBroadcastMessageType === 'template') {
        payload.templateId = selectedTemplate?.id;
        payload.variableMapping = newBroadcastVariableMapping;
        if (headerMediaType && newBroadcastMediaLibraryId) payload.mediaLibraryId = Number(newBroadcastMediaLibraryId);
      } else if (newBroadcastMessageType === 'text') {
        payload.body = newBroadcastBody;
      } else if (newBroadcastMessageType === 'link') {
        payload.url = newBroadcastUrl;
      } else if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType)) {
        payload.mediaLibraryId = Number(newBroadcastMediaLibraryId);
        payload.caption = newBroadcastCaption || undefined;
      }
      const created = editing?.kind === 'series'
        ? await api.broadcastSeries.update(editing.id, payload)
        : await api.broadcastSeries.create(payload);
      const wasEdit = editing?.kind === 'series';
      closeNewBroadcastModal();
      await loadSeries();
      if (wasEdit) {
        notify({ variant: 'success', message: `"${created?.name || payload.name}" updated.` });
        setNewBroadcasting(false);
        return;
      }
      // Created PAUSED on purpose — something that messages real customers on a
      // timer gets one deliberate press to start.
      notify({
        variant: 'success',
        message: `"${created.name}" saved and paused. Review it under Repeating, then switch it on to start.`,
      });
    } catch (e) {
      notify(e.message || 'Could not create the repeating broadcast');
    } finally {
      setNewBroadcasting(false);
    }
  };

  const handleNewBroadcastSave = async (status) => {
    if (!newBroadcastFrom || selectedRecipients.length === 0) return;
    if (newBroadcastMessageType === 'template' && !selectedTemplate) return;
    if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return;
    if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return;
    if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return;
    if (headerMediaType && !newBroadcastMediaLibraryId) return;
    if (isPaymentBroadcast) {
      if (!payAmountNum || payAmountNum < 1) {
        notify('This template carries a payment button — set the product or amount each recipient will be charged.');
        return;
      }
      // Every recipient gets their OWN live payment link, so the person sending
      // must see the total exposure and type it back before anything is minted.
      if (status === 'SENT' && payConfirmText !== 'CREATE LINKS') {
        setPayConfirm({ status });
        return;
      }
    }
    setNewBroadcasting(true);
    try {
      const payload = {
        from_number: newBroadcastFrom,
        recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
        status,
        test_number: newBroadcastTestNumber || undefined,
        name: newBroadcastName.trim() || undefined,
        message_type: newBroadcastMessageType,
      };
      if (newBroadcastMessageType === 'template') {
        payload.template_id = selectedTemplate.id;
        payload.variable_mapping = newBroadcastVariableMapping;
        if (headerMediaType && newBroadcastMediaLibraryId) payload.media_library_id = Number(newBroadcastMediaLibraryId);
      } else if (newBroadcastMessageType === 'text') {
        payload.body = newBroadcastBody;
      } else if (newBroadcastMessageType === 'link') {
        payload.url = newBroadcastUrl;
      } else if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType)) {
        payload.media_library_id = Number(newBroadcastMediaLibraryId);
        payload.caption = newBroadcastCaption || undefined;
      }
      // SCHEDULED never calls /send — the backend's minute tick fires it when
      // scheduled_at arrives. Sending here would defeat the whole point.
      if (status === 'SCHEDULED') {
        const when = new Date(newBroadcastScheduleAt);
        if (isNaN(when.getTime())) { notify('Pick a valid date and time to schedule.'); setNewBroadcasting(false); return; }
        if (when.getTime() <= Date.now()) { notify('Pick a time in the future to schedule.'); setNewBroadcasting(false); return; }
        payload.scheduled_at = when.toISOString();
      }

      // Editing writes back to the same row; the payload is identical, so the
      // two paths cannot drift into saving different things.
      //
      // ⚠ On an edit, `scheduled_at` is sent EVERY time — including as null for
      // a manual send. Omitting it would leave a stale time on a broadcast the
      // operator has just switched back to manual, and the backend derives the
      // status from that field.
      let broadcast;
      if (editing?.kind === 'broadcast') {
        if (status !== 'SCHEDULED') payload.scheduled_at = null;
        delete payload.status;
        broadcast = await api.broadcasts.update(editing.id, payload);
      } else {
        broadcast = await api.broadcasts.create(payload);
      }
      if (status === 'SENT') {
        await api.broadcasts.send(broadcast.id);
        notify(`Broadcast sent to ${selectedRecipients.length} contact(s) from ${newBroadcastFrom}!`);
      } else if (status === 'SCHEDULED') {
        notify(`Scheduled for ${new Date(newBroadcastScheduleAt).toLocaleString()} — ${selectedRecipients.length} recipient(s). It will send automatically.`);
      } else {
        notify(editing ? 'Changes saved' : 'Broadcast saved as draft');
      }
      closeNewBroadcastModal();
      loadBroadcasts();
    } catch (err) {
      notify(status === 'SENT' ? 'Broadcast failed: ' + err.message : 'Save failed: ' + err.message);
    } finally {
      setNewBroadcasting(false);
    }
  };

  // Declared HERE, above the first early return, because the LIST view renders
  // it. `const` is in the temporal dead zone until its declaration executes, so
  // while this lived further down (in the detail-view section) every render of
  // the list view threw "Cannot access 'payConfirmModal' before initialization"
  // and — with no error boundary in this app — blanked the whole page.
  // Every value it reads (payConfirm, payConfirmText, selectedRecipients,
  // payAmountNum, payTotal, handleNewBroadcastSave) is already defined above.
  const payConfirmModal = payConfirm && (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 4000, padding: 20 }}
      onClick={() => { setPayConfirm(null); setPayConfirmText(''); }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.cardBg, borderRadius: 14, padding: 26,
        maxWidth: 460, width: '100%', boxShadow: C.shadowLg, fontFamily: FONT }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 10 }}>
          Create {selectedRecipients.length} live payment links?
        </div>
        <div style={{ fontSize: 15, color: C.textSecondary, lineHeight: 1.6 }}>
          Each of the <strong>{selectedRecipients.length}</strong> recipients gets their own Razorpay
          link for <strong>₹{payAmountNum ? payAmountNum.toLocaleString('en-IN') : 0}</strong> — a total of{' '}
          <strong style={{ fontFamily: MONO }}>₹{payTotal.toLocaleString('en-IN')}</strong> in links that
          can really be paid. They cannot be un-sent.
        </div>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 16, marginBottom: 7 }}>
          Type <strong style={{ fontFamily: MONO, color: C.text }}>CREATE LINKS</strong> to continue.
        </div>
        <input autoFocus value={payConfirmText} onChange={e => setPayConfirmText(e.target.value)}
          placeholder="CREATE LINKS"
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: `1.5px solid ${C.border}`,
            borderRadius: 8, fontSize: 15, fontFamily: MONO, background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={() => { setPayConfirm(null); setPayConfirmText(''); }}
            style={{ padding: '9px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent',
              color: C.text, fontSize: 15, fontFamily: FONT, cursor: 'pointer' }}>Cancel</button>
          <button
            disabled={payConfirmText !== 'CREATE LINKS'}
            onClick={() => { const st = payConfirm.status; setPayConfirm(null); handleNewBroadcastSave(st); }}
            style={{ padding: '9px 16px', borderRadius: 8, border: 'none',
              background: payConfirmText === 'CREATE LINKS' ? '#0F6E56' : C.border,
              color: '#fff', fontSize: 15, fontWeight: 600, fontFamily: FONT,
              cursor: payConfirmText === 'CREATE LINKS' ? 'pointer' : 'not-allowed' }}>
            Create and send
          </button>
        </div>
      </div>
    </div>
  );

  // ─── LIST VIEW ──────────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div style={{ padding: '24px 28px', fontFamily: FONT }}>
        {payConfirmModal}
        <AccountHealthBanner />
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Bulk Messages</h1>
            <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>Manage your broadcast campaigns and drafts</p>
          </div>
          <button
            onClick={() => {
              setNewBroadcastModal(true);
              setNewBroadcastFrom(selectedNumber || '');
            }}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none',
              background: C.primary, color: '#fff', cursor: 'pointer',
              fontSize: 15, fontWeight: 700, fontFamily: FONT,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Plus size={16} /> New Broadcast
          </button>
        </div>

        {/* Filter Tabs + bulk-delete */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
          {FILTER_TABS.map(tab => {
            const active = filterStatus === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setFilterStatus(tab.key)}
                style={{
                  padding: '7px 16px', borderRadius: 8, border: `1.5px solid ${active ? C.primary : C.border}`,
                  background: active ? C.primary : 'var(--c-cardBg)', color: active ? '#fff' : C.textSecondary,
                  cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONT,
                }}
              >
                {tab.label}
                {tab.key !== 'all' && (
                  <span style={{
                    marginLeft: 6, fontSize: 13, fontWeight: 700,
                    background: active ? 'rgba(255,255,255,.2)' : C.primaryLight,
                    color: active ? '#fff' : C.primary,
                    padding: '1px 7px', borderRadius: 99,
                  }}>
                    {tab.key === 'SERIES' ? series.length : broadcasts.filter(b => b.status === tab.key).length}
                  </span>
                )}
              </button>
            );
          })}
          </div>
          <BulkDeleteButton sel={sel} label="broadcast" onConfirm={(ids) => handleBulkDelete(ids)} />
        </div>

        {/* Table */}
        {filterStatus === 'SERIES' ? (
          <SeriesList
            series={series}
            onChanged={loadBroadcasts}
            isAdmin={user?.role === 'admin'}
            onEdit={openSeriesEditor}
          />
        ) : (
        <div style={{ background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
            <thead>
              <tr style={{ background: 'var(--c-surfaceInner, #fafaf9)', borderBottom: `1px solid ${C.border}` }}>
                <th style={{ padding: '12px 16px', width: 40 }}><SelectAllCheckbox sel={sel} /></th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Broadcast</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recipients</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Template</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</th>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last Activity</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} style={{ padding: 40, textAlign: 'center', color: C.textMuted }}>
                    <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
                    <div style={{ fontSize: 15 }}>Loading broadcasts…</div>
                  </td>
                </tr>
              ) : broadcasts.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 48, textAlign: 'center' }}>
                    <div style={{ fontSize: 36, marginBottom: 10 }}>📡</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 4 }}>No broadcasts yet</div>
                    <div style={{ fontSize: 14, color: C.textMuted }}>Click "New Broadcast" to create your first campaign</div>
                  </td>
                </tr>
              ) : (
                broadcasts.map(b => (
                  <tr
                    key={b.id}
                    onClick={() => openDetail(b)}
                    style={{
                      borderBottom: `1px solid ${C.border}`,
                      cursor: 'pointer',
                      transition: 'background .15s',
                      background: sel.isSelected(b.id) ? 'var(--c-dangerBgSoft, #FDF6F6)' : 'transparent',
                    }}
                    onMouseEnter={e => { if (!sel.isSelected(b.id)) e.currentTarget.style.background = 'var(--c-xfafaf9, #fafaf9)'; }}
                    onMouseLeave={e => { if (!sel.isSelected(b.id)) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 16px', width: 40 }} onClick={(e) => e.stopPropagation()}>
                      <RowCheckbox sel={sel} id={b.id} label={b.name || `Broadcast #${b.id}`} />
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ fontWeight: 600, color: C.text, fontSize: 15 }}>{b.name || b.template_name || 'Untitled'} #{b.id}</div>
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{b.template_name || '—'} · {formatDate(b.created_at)}</div>
                    </td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}><MaskedNumber number={b.from_number} prefix="+" /></td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{formatRecipients(b)}</td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary }}>{b.template_name || '—'}</td>
                    <td style={{ padding: '12px 16px' }}><StatusBadge status={b.status} /></td>
                    <td style={{ padding: '12px 16px', color: C.textSecondary, fontSize: 14 }}>
                      {b.last_activity ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Clock size={12} /> {formatDate(b.last_activity)} {formatTime(b.last_activity)}
                        </span>
                      ) : (
                        <span style={{ color: C.textMuted }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {/* Edit appears only while the broadcast can still
                          change. On a sent one it would be a control that
                          silently does nothing — Duplicate is the honest
                          answer there, and it is offered on every row. */}
                      {EDITABLE_BROADCAST_STATUSES.includes(b.status) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openComposerFor(b, { mode: 'edit' }); }}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textSecondary, padding: 4, borderRadius: 4 }}
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); openComposerFor(b, { mode: 'duplicate' }); }}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textSecondary, padding: 4, borderRadius: 4 }}
                        title={EDITABLE_BROADCAST_STATUSES.includes(b.status) ? 'Duplicate' : 'Already sent — duplicate it to send a corrected copy'}
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, broadcast: b }); }}
                        style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, padding: 4, borderRadius: 4,
                        }}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* Delete Modal */}
        <DeleteConfirmModal
          open={deleteModal.open}
          title="Delete Broadcast"
          message={deleteModal.broadcast ? `Are you sure you want to delete broadcast "${deleteModal.broadcast.name || deleteModal.broadcast.template_name || 'Untitled'} #${deleteModal.broadcast.id}"? This action cannot be undone.` : ''}
          confirmText="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteModal({ open: false, broadcast: null })}
        />

        {/* ─── NEW BROADCAST MODAL ───────────────────────────────────────────── */}
        {newBroadcastModal && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 200, fontFamily: FONT,
          }}>
            {/* ⚠ The card is a fixed-height flex COLUMN and only the step body
                scrolls. The whole card used to be `overflowY:auto`, which put
                the footer — and the send-mode choice, which sat below the
                recipient table — under a scroll: the first decision was the
                last thing you met. `minHeight:0` on the scroller is
                load-bearing (a flex child defaults to min-height:auto and will
                not shrink, so its child can never scroll). */}
            <div style={{
              background: C.cardBg, borderRadius: 14,
              width: 1100, height: '92vh',
              boxShadow: C.shadowLg, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}>
              {/* Modal Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0', flexShrink: 0 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>
                  <Send size={18} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 8, color: C.primary }} />
                  {editing
                    ? (editing.kind === 'series' ? 'Edit repeating broadcast' : 'Edit broadcast')
                    : 'New Broadcast'}
                </div>
                <button onClick={closeNewBroadcastModal} style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
                }}><X size={20} /></button>
              </div>

              {/* Step toggle — the two questions, in the order you answer them.
                  Step 2 is reachable at any time: someone editing an existing
                  broadcast usually wants the audience, not the message. */}
              <div style={{ display: 'flex', gap: 8, padding: '14px 24px 0', flexShrink: 0 }}>
                {[
                  { k: 'message', n: 1, label: 'Message', hint: 'When, and what you send' },
                  { k: 'recipients', n: 2, label: sendMode === 'repeating' ? 'Audience' : 'Recipients', hint: sendMode === 'repeating' ? 'The rule, re-checked each run' : 'Who receives it' },
                ].map(st => {
                  const active = composerStep === st.k;
                  const count = st.k === 'recipients' && sendMode !== 'repeating' ? selectedRecipients.length : null;
                  return (
                    <button
                      key={st.k}
                      onClick={() => setComposerStep(st.k)}
                      style={{
                        flex: 1, textAlign: 'left', cursor: 'pointer', fontFamily: FONT,
                        padding: '10px 14px', borderRadius: 10,
                        border: `1.5px solid ${active ? C.primary : C.border}`,
                        background: active ? 'var(--c-primaryLight)' : 'var(--c-cardBg)',
                        display: 'flex', alignItems: 'center', gap: 10,
                      }}
                    >
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                        background: active ? C.primary : 'var(--c-surfaceMuted, #eee)',
                        color: active ? '#fff' : C.textSecondary,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 700,
                      }}>{st.n}</span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: active ? C.primary : C.text }}>
                          {st.label}{count != null && count > 0 ? ` · ${count}` : ''}
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: C.textMuted }}>{st.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* The one scrolling region. */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

              {/* ── STEP 1 — Message ─────────────────────────────────────── */}
              {composerStep === 'message' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 24, padding: '20px 24px' }}>
                {/* LEFT — Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                  {/* WHEN — first, because it decides what the rest of the
                      composer even is: a one-off takes a ticked recipient list,
                      a repeating send takes an audience rule instead. It used to
                      sit under the recipient table, below the fold. */}
                  <ScheduleSection
                    mode={sendMode}
                    onMode={setSendMode}
                    value={newBroadcastScheduleAt}
                    onValue={setNewBroadcastScheduleAt}
                    recurrence={recurrence} onRecurrence={setRecurrence}
                    endsOn={seriesEndsOn} onEndsOn={setSeriesEndsOn}
                    maxRuns={seriesMaxRuns} onMaxRuns={setSeriesMaxRuns}
                    skipAlreadySent={seriesSkipSent} onSkipAlreadySent={setSeriesSkipSent}
                  />

                  {/* Broadcast Name */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Broadcast Name</div>
                    <input
                      type="text"
                      value={newBroadcastName}
                      onChange={e => setNewBroadcastName(e.target.value)}
                      placeholder="e.g. April Fee Reminder"
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 15,
                        fontFamily: FONT, color: C.text, outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>

                  {/* From */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From (WhatsApp Number)</div>
                    <SearchableSelect
                      value={newBroadcastFrom}
                      onChange={(val) => { setNewBroadcastFrom(val); setSelectedNumber(val); setNewBroadcastTemplateId(''); }}
                      options={numbers.map(n => ({ value: String(n.wa_number), label: n.display_name || maskPhone(n.wa_number) }))}
                      placeholder="Select a WhatsApp number..."
                      searchPlaceholder="Search numbers..."
                    />
                    {/* Linked account status — shown once the lookup resolves */}
                    {newBroadcastFrom && accountLookupDone && (
                      linkedAccount ? (
                        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--c-successText, #0F6E56)', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 4 }}>
                          ✓ Linked to <strong>{linkedAccount.displayName}</strong> · WABA {linkedAccount.wabaId}
                          {!linkedAccount.isActive && <span style={{ color: 'var(--c-orangeText, #E65100)', marginLeft: 6 }}>(inactive)</span>}
                        </div>
                      ) : (
                        <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--c-orangeBg, #FFF3E0)', border: `1px solid var(--c-orangeBorder, #FFB74D)`, borderRadius: 6, fontSize: 13, color: 'var(--c-orangeText, #E65100)', fontFamily: FONT }}>
                          ⚠ This number isn't linked to a WhatsApp Account. Broadcasts can't be sent until you register it in Settings → WhatsApp Accounts.
                        </div>
                      )
                    )}
                    {newBroadcastFrom && linkedAccount && (
                      <AccountHealthBanner phone={newBroadcastFrom} style={{ marginTop: 8, marginBottom: 0 }} />
                    )}
                  </div>

                  {/* To */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>To ({selectedRecipients.length} selected)</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 100, overflowY: 'auto', padding: '10px 12px', background: 'var(--c-hover)', borderRadius: 8, border: `1.5px solid ${C.border}` }}>
                      {selectedRecipients.length === 0 && (
                        <span style={{ fontSize: 14, color: C.textMuted, fontFamily: FONT }}>Select contacts from the table below</span>
                      )}
                      {selectedRecipients.map(c => (
                        <span key={c.contact_number} style={{ fontSize: 13, color: C.textSecondary, background: 'var(--c-cardBg)', padding: '3px 10px', borderRadius: 99, border: `1px solid ${C.border}`, fontFamily: FONT, fontWeight: 500 }}>
                          {c.name} (<MaskedNumber number={c.contact_number} prefix="+" />)
                        </span>
                      ))}
                    </div>
                  </div>

                  {isPaymentBroadcast && (
                    <div style={{ background: 'var(--c-successBgSoft, #EDF6F1)', border: '1px solid #9CC9B4', borderRadius: 10, padding: '14px 16px' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-successText, #0F6E56)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                        Payment template
                      </div>
                      <div style={{ fontSize: 14, color: 'var(--c-s3c6656, #3C6656)', lineHeight: 1.55, marginBottom: 12 }}>
                        Every recipient gets their <strong>own live Razorpay link</strong> for the amount below,
                        created when the broadcast is sent.
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Product</div>
                          <SearchableSelect
                            value={payProductId}
                            onChange={(v) => {
                              setPayProductId(v);
                              // Fill the amount from the product, but never clobber a
                              // figure someone typed on purpose.
                              const p = payProducts.find(x => String(x.id) === String(v));
                              const prev = payProducts.find(x => String(x.id) === String(payProductId));
                              if (p?.price != null && (payAmount === '' || (prev && String(payAmount) === String(prev.price)))) {
                                setPayAmount(String(p.price));
                              }
                            }}
                            placeholder="— None (amount only) —"
                            options={payProducts.map(p => ({ value: String(p.id), label: p.name, sublabel: p.price != null ? `₹${p.price.toLocaleString('en-IN')}` : 'no price set' }))}
                          />
                        </div>
                        <div style={{ flex: '0 1 160px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Amount (₹)</div>
                          <input type="number" min={1} value={payAmount} onChange={e => setPayAmount(e.target.value)}
                            placeholder="5499"
                            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1.5px solid ${payAmountNum ? C.border : '#C4534F'}`, borderRadius: 8, fontSize: 15, fontFamily: MONO, background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' }} />
                        </div>
                        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Purpose (internal)</div>
                          <input value={payPurpose} onChange={e => setPayPurpose(e.target.value)} placeholder="August fee"
                            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: FONT, background: 'var(--c-cardBg)', color: 'var(--c-text)', outline: 'none' }} />
                        </div>
                      </div>
                      {payTotal > 0 && (
                        <div style={{ marginTop: 12, fontSize: 14, color: 'var(--c-successText, #0F6E56)', fontWeight: 600 }}>
                          {selectedRecipients.length} recipient(s) × ₹{payAmountNum.toLocaleString('en-IN')} ={' '}
                          <span style={{ fontFamily: MONO }}>₹{payTotal.toLocaleString('en-IN')}</span> of live payment links
                        </div>
                      )}
                    </div>
                  )}

                  {/* Message Type */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Type</div>
                    <SearchableSelect
                      value={newBroadcastMessageType}
                      onChange={(val) => setNewBroadcastMessageType(val)}
                      options={[
                        { value: 'template', label: 'Template Message' },
                        { value: 'text', label: 'Text Message' },
                        { value: 'link', label: 'Link Message' },
                        { value: 'image', label: 'Image Message' },
                        { value: 'video', label: 'Video Message' },
                        { value: 'audio', label: 'Audio Message' },
                        { value: 'document', label: 'Document Message' },
                      ]}
                      placeholder="Select message type..."
                    />
                  </div>

                  {/* Template Fields */}
                  {newBroadcastMessageType === 'template' && (
                    <>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Template</div>
                        <SearchableSelect
                          value={newBroadcastTemplateId}
                          onChange={(val) => { setNewBroadcastTemplateId(val); setNewBroadcastVariableMapping({}); setCustomVarMode({}); setNewBroadcastMediaLibraryId(''); }}
                          options={eligibleTemplates.map(t => ({ value: String(t.id), label: `${t.name} (${t.category})`, sublabel: t.language || t.lang || '' }))}
                          placeholder="Select a template..."
                          searchPlaceholder="Search templates..."
                          emptyText="No templates found"
                          createLabel="Create new template"
                          onCreate={() => onNavigate?.('template-builder', 'new')}
                        />
                        {!newBroadcastFrom ? (
                          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>Pick a sending number first.</div>
                        ) : !linkedAccount && accountLookupDone ? (
                          <div style={{ fontSize: 13, color: 'var(--c-orangeText, #E65100)', marginTop: 4, fontFamily: FONT }}>Templates are scoped to a WhatsApp Account — register the number above first.</div>
                        ) : eligibleTemplates.length === 0 && linkedAccount ? (
                          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>No approved templates for <strong>{linkedAccount.displayName}</strong>. Create one in Template Builder.</div>
                        ) : null}
                      </div>

                      {/* Header media — required for IMAGE/VIDEO/DOCUMENT header templates */}
                      {headerMediaType && (
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            Header {headerMediaType} <span style={{ color: C.primary }}>*</span>
                          </div>
                          <SearchableSelect
                            value={newBroadcastMediaLibraryId}
                            onChange={(val) => setNewBroadcastMediaLibraryId(val)}
                            disabled={newBroadcastMediaLoading}
                            options={newBroadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                            placeholder={newBroadcastMediaLoading ? 'Loading...' : `— Select ${headerMediaType} —`}
                            searchPlaceholder={`Search ${headerMediaType}...`}
                          />
                          {newBroadcastMediaItems.length === 0 && !newBroadcastMediaLoading ? (
                            <div style={{ fontSize: 13, color: 'var(--c-orangeText, #E65100)', marginTop: 4, fontFamily: FONT }}>
                              This template has a {headerMediaType} header — upload a {headerMediaType} to the Media Library first.
                            </div>
                          ) : (
                            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                              This template has a {headerMediaType} header — pick the {headerMediaType} to send in the header.
                            </div>
                          )}
                          {newBroadcastMediaLibraryId && headerMediaType === 'image' && (
                            <img
                              src={api.mediaLibrary.downloadUrl(Number(newBroadcastMediaLibraryId))}
                              alt=""
                              style={{ marginTop: 8, width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' }}
                            />
                          )}
                        </div>
                      )}

                      {templateVars.length > 0 && (
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Variable Mapping</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {templateVars.map(v => {
                              const fieldVals = new Set(contactFieldOptions.map(o => o.value));
                              const curVal = newBroadcastVariableMapping[v] || '';
                              const isCustom = customVarMode[v] || (curVal !== '' && !fieldVals.has(curVal));
                              return (
                              <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: "'DM Mono', monospace", background: 'var(--c-hover)', padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap' }}>{'{{' + v + '}}'}</span>
                                <span style={{ fontSize: 14, color: C.textMuted }}>→</span>
                                <div style={{ flex: 1, minWidth: 160 }}>
                                  <SearchableSelect
                                    value={isCustom ? '__custom__' : curVal}
                                    onChange={(val) => {
                                      if (val === '__custom__') {
                                        setCustomVarMode(prev => ({ ...prev, [v]: true }));
                                        setNewBroadcastVariableMapping(prev => ({ ...prev, [v]: '' }));
                                      } else {
                                        setCustomVarMode(prev => ({ ...prev, [v]: false }));
                                        setNewBroadcastVariableMapping(prev => ({ ...prev, [v]: val }));
                                      }
                                    }}
                                    options={[
                                      ...contactFieldOptions.map(opt => ({ value: opt.value, label: opt.label })),
                                      { value: '__custom__', label: 'Custom text…' },
                                    ]}
                                    placeholder="Select contact field..."
                                    searchPlaceholder="Search fields..."
                                    triggerStyle={{ padding: '8px 28px 8px 10px', borderRadius: 6, fontSize: 14 }}
                                  />
                                </div>
                                {isCustom && (
                                  <input
                                    type="text"
                                    autoFocus
                                    value={curVal}
                                    onChange={e => setNewBroadcastVariableMapping(prev => ({ ...prev, [v]: e.target.value }))}
                                    placeholder={`Type the value for {{${v}}}`}
                                    style={{
                                      flexBasis: '100%', padding: '8px 10px', borderRadius: 6,
                                      border: `1.5px solid ${C.primary}`, fontSize: 14,
                                      fontFamily: FONT, color: C.text, background: 'var(--c-cardBg)', outline: 'none',
                                    }}
                                  />
                                )}
                              </div>
                              );
                            })}
                          </div>
                          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6, fontFamily: FONT }}>
                            Map each variable to a contact field, or choose <strong>Custom text…</strong> to type a fixed value (same for every recipient).
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Text Fields */}
                  {newBroadcastMessageType === 'text' && (
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Text</div>
                      <textarea
                        value={newBroadcastBody}
                        onChange={e => setNewBroadcastBody(e.target.value)}
                        placeholder="Type your message here..."
                        rows={4}
                        style={{
                          width: '100%', padding: '10px 12px', borderRadius: 8,
                          border: `1.5px solid ${C.border}`, fontSize: 15,
                          fontFamily: FONT, color: C.text, outline: 'none',
                          boxSizing: 'border-box', resize: 'vertical',
                        }}
                      />
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                        Use {'{{name}}'} and {'{{contact_number}}'} for dynamic values per recipient.
                      </div>
                    </div>
                  )}

                  {/* Link Fields */}
                  {newBroadcastMessageType === 'link' && (
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Link URL</div>
                      <input
                        type="text"
                        value={newBroadcastUrl}
                        onChange={e => setNewBroadcastUrl(e.target.value)}
                        placeholder="https://example.com"
                        style={{
                          width: '100%', padding: '10px 12px', borderRadius: 8,
                          border: `1.5px solid ${C.border}`, fontSize: 15,
                          fontFamily: FONT, color: C.text, outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                        The link will be sent as a text message with preview enabled.
                      </div>
                    </div>
                  )}

                  {/* Media Fields (image/video/audio/document) */}
                  {['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && (
                    <>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Select from Media Library</div>
                        <SearchableSelect
                          value={newBroadcastMediaLibraryId}
                          onChange={(val) => setNewBroadcastMediaLibraryId(val)}
                          disabled={newBroadcastMediaLoading}
                          options={newBroadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                          placeholder={newBroadcastMediaLoading ? 'Loading...' : `— Select ${newBroadcastMessageType} —`}
                          searchPlaceholder={`Search ${newBroadcastMessageType}...`}
                        />
                        {newBroadcastMediaItems.length === 0 && !newBroadcastMediaLoading && (
                          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                            No {newBroadcastMessageType}s in the Media Library. Upload one from the Media tab first.
                          </div>
                        )}
                      </div>

                      {/* Media Preview */}
                      {newBroadcastMediaLibraryId && (
                        <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, background: 'var(--c-hover)' }}>
                          {newBroadcastMessageType === 'image' ? (
                            <img
                              src={api.mediaLibrary.downloadUrl(Number(newBroadcastMediaLibraryId))}
                              alt=""
                              style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }}
                            />
                          ) : newBroadcastMessageType === 'video' ? (
                            <div style={{ position: 'relative', width: '100%', height: 140 }}>
                              <video
                                src={api.mediaLibrary.downloadUrl(Number(newBroadcastMediaLibraryId))}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                preload="metadata"
                                muted
                              />
                              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
                                <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <Play size={16} color="var(--c-t1, #111)" fill="var(--c-t1, #111)" />
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                              <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--c-successBg, #E1F5EE)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--c-successText, #0F6E56)' }}>
                                {newBroadcastMessageType === 'audio' ? <Music size={20} /> : <FileText size={20} />}
                              </div>
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: FONT }}>
                                  {newBroadcastMediaItems.find(m => String(m.id) === String(newBroadcastMediaLibraryId))?.name || 'Media'}
                                </div>
                                <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT, textTransform: 'capitalize' }}>
                                  {newBroadcastMessageType}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {newBroadcastMessageType !== 'audio' && (
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Caption (optional)</div>
                          <input
                            type="text"
                            value={newBroadcastCaption}
                            onChange={e => setNewBroadcastCaption(e.target.value)}
                            placeholder="Optional caption..."
                            style={{
                              width: '100%', padding: '10px 12px', borderRadius: 8,
                              border: `1.5px solid ${C.border}`, fontSize: 15,
                              fontFamily: FONT, color: C.text, outline: 'none',
                              boxSizing: 'border-box',
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}

                  {/* Test Number */}
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test Number</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {/* Searchable Dropdown */}
                      <div ref={newTestNumRef} style={{ flex: 1, position: 'relative' }}>
                        <input
                          value={newBroadcastTestNumber}
                          onChange={e => { setNewBroadcastTestNumber(e.target.value); if (!newTestNumberOpen) setNewTestNumberOpen(true); }}
                          onFocus={() => setNewTestNumberOpen(true)}
                          placeholder="Type any number or pick a contact…"
                          inputMode="tel"
                          style={{
                            width: '100%', padding: '10px 32px 10px 12px', borderRadius: 8,
                            border: `1.5px solid ${C.border}`, fontSize: 15, fontFamily: FONT,
                            color: C.text, background: 'var(--c-cardBg)', outline: 'none', boxSizing: 'border-box',
                          }}
                        />
                        <ChevronDown size={14} color={C.textMuted} onClick={() => setNewTestNumberOpen(o => !o)} style={{ position: 'absolute', right: 10, top: '50%', transform: `translateY(-50%) ${newTestNumberOpen ? 'rotate(180deg)' : ''}`, cursor: 'pointer' }} />
                        {newTestNumberOpen && (() => {
                          const q = (newBroadcastTestNumber || '').toLowerCase().trim();
                          const qDigits = q.replace(/\D/g, '');
                          const fromNum = (newBroadcastFrom || '').replace(/\D/g, '');
                          // Guard the digit check with `qDigits &&` — "".includes("") is
                          // always true, which otherwise makes a name search match every row.
                          const matchNum = (num) => num && num !== fromNum;
                          const matchQ = (num, name) => !q || (qDigits && num.includes(qDigits)) || (name || '').toLowerCase().includes(q);
                          const allContacts = contacts.filter(c => {
                            const num = (c.contact_number || '').replace(/\D/g, '');
                            return matchNum(num) && matchQ(num, c.name);
                          });
                          // Team members are gone; saved contacts are the only
                          // suggestion source now.
                          const allMembers = [];
                          const CAP = 50;
                          const contactSugs = allContacts.slice(0, CAP);
                          const memberSugs = allMembers.slice(0, CAP);
                          const hiddenCount = (allContacts.length - contactSugs.length) + (allMembers.length - memberSugs.length);
                          const pick = (number) => { setNewBroadcastTestNumber(String(number || '').replace(/\D/g, '')); setNewTestNumberOpen(false); };
                          const Row = ({ name, number }) => (
                            <div
                              onMouseDown={(e) => { e.preventDefault(); pick(number); }}
                              style={{ padding: '8px 12px', cursor: 'pointer', fontFamily: FONT, borderBottom: `1px solid ${C.border}` }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--c-xf9fafb, #f9fafb)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                            >
                              <div style={{ fontWeight: 600, color: C.text, fontSize: 15 }}>{name}</div>
                              <div style={{ fontSize: 13, color: C.textMuted }}>{maskPhone(number)}</div>
                            </div>
                          );
                          return (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: C.shadowMd, zIndex: 50, maxHeight: 320, overflowY: 'auto' }}>
                              {contactSugs.length > 0 && (
                                <div style={{ padding: '7px 12px 3px', fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contacts</div>
                              )}
                              {contactSugs.map(c => <Row key={'c' + c.contact_number} name={c.name || maskPhone(c.contact_number)} number={c.contact_number} />)}
                              {memberSugs.length > 0 && (
                                <div style={{ padding: '7px 12px 3px', fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>WhatsApp numbers</div>
                              )}
                              {memberSugs.map(tm => <Row key={'m' + tm.id} name={tm.name} number={tm.phone_number} />)}
                              {hiddenCount > 0 && (
                                <div style={{ padding: '8px 12px', fontSize: 13, color: C.textMuted, fontFamily: FONT, textAlign: 'center' }}>
                                  +{hiddenCount} more — keep typing to narrow
                                </div>
                              )}
                              {contactSugs.length === 0 && memberSugs.length === 0 && (
                                <div style={{ padding: '10px 12px', fontSize: 14, color: C.textMuted, fontFamily: FONT }}>
                                  {qDigits.length >= 7 ? 'No match — press Send Test to use this number' : 'Type a full number, or search a saved contact'}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <button
                        onClick={handleNewBroadcastTest}
                        disabled={(() => {
                          if (!newBroadcastTestNumber.trim() || !newBroadcastFrom || newBroadcastSendingTest) return true;
                          if (newBroadcastMessageType === 'template' && !selectedTemplate) return true;
                          if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return true;
                          if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return true;
                          if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return true;
                          if (headerMediaType && !newBroadcastMediaLibraryId) return true;
                          return false;
                        })()}
                        style={{
                          padding: '10px 16px', borderRadius: 8, border: 'none',
                          background: C.primary, color: '#fff',
                          cursor: (() => {
                            if (!newBroadcastTestNumber.trim() || !newBroadcastFrom || newBroadcastSendingTest) return 'not-allowed';
                            if (newBroadcastMessageType === 'template' && !selectedTemplate) return 'not-allowed';
                            if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return 'not-allowed';
                            if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return 'not-allowed';
                            if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return 'not-allowed';
                            return 'pointer';
                          })(),
                          fontSize: 14, fontWeight: 700, fontFamily: FONT,
                          opacity: (() => {
                            if (!newBroadcastTestNumber.trim() || !newBroadcastFrom || newBroadcastSendingTest) return 0.5;
                            if (newBroadcastMessageType === 'template' && !selectedTemplate) return 0.5;
                            if (newBroadcastMessageType === 'text' && !newBroadcastBody.trim()) return 0.5;
                            if (newBroadcastMessageType === 'link' && !newBroadcastUrl.trim()) return 0.5;
                            if (['image', 'video', 'audio', 'document'].includes(newBroadcastMessageType) && !newBroadcastMediaLibraryId) return 0.5;
                            return 1;
                          })(),
                          display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                        }}
                      >
                        {newBroadcastSendingTest ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                        Send Test
                      </button>
                    </div>
                  </div>
                </div>

                {/* RIGHT — WhatsApp Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--c-t6, #888)', fontFamily: FONT }}>Live Preview</div>
                  {newBroadcastMessageType === 'template' ? (
                    <WhatsAppPreview template={previewTemplate} minHeight={280} emptyText="Select a template&#10;to preview" />
                  ) : (
                    <BroadcastMessagePreview
                      messageType={newBroadcastMessageType}
                      body={newBroadcastBody}
                      url={newBroadcastUrl}
                      mediaLibraryId={newBroadcastMediaLibraryId}
                      caption={newBroadcastCaption}
                      mediaItems={newBroadcastMediaItems}
                    />
                  )}
                </div>
              </div>

              )}

              {/* ── STEP 2 — Recipients ──────────────────────────────────── */}
              {composerStep === 'recipients' && (
              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                    {sendMode === 'repeating' ? 'Who it reaches, every run' : 'Select Recipients'}
                  </div>
                  {/* Recipient scope: this number's contacts vs every contact across all numbers */}
                  <div style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                    {[{ k: 'number', label: 'This number' }, { k: 'all', label: 'All numbers' }].map(opt => {
                      const active = recipientScope === opt.k;
                      return (
                        <button
                          key={opt.k}
                          onClick={() => { if (recipientScope !== opt.k) { setRecipientScope(opt.k); setSelectedContactNumbers(new Set()); } }}
                          style={{
                            padding: '7px 14px', border: 'none', cursor: 'pointer', fontFamily: FONT,
                            fontSize: 14, fontWeight: 700,
                            background: active ? C.primary : 'var(--c-cardBg)',
                            color: active ? '#fff' : C.textSecondary,
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {sendMode === 'repeating' ? (
                  <AudienceRule
                    categories={categories} tags={tags}
                    tagIds={contactFilterTagIds} onTagIds={setContactFilterTagIds}
                    arrivedWithinDays={ruleArrivedWithinDays} onArrivedWithinDays={setRuleArrivedWithinDays}
                    notRepliedForDays={ruleNotRepliedForDays} onNotRepliedForDays={setRuleNotRepliedForDays}
                    scope={recipientScope}
                    fromNumber={newBroadcastFrom}
                    preview={rulePreview} onPreview={setRulePreview}
                  />
                ) : (<>
                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'var(--c-chatPanel)', borderRadius: 8,
                    padding: '8px 12px', flex: 1, minWidth: 200, maxWidth: 360,
                  }}>
                    <Search size={16} color={C.textMuted} />
                    <input
                      value={contactSearch}
                      onChange={e => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      style={{
                        flex: 1, border: 'none', background: 'transparent',
                        fontSize: 15, fontFamily: FONT, outline: 'none', color: C.text,
                      }}
                    />
                  </div>

                  {/* One picker per tag CATEGORY — "Funnel Stage", "Product",
                      whatever the workspace has defined — instead of a single
                      flat list of every tag. The table already renders a column
                      per category, so this is the filter that matches what is
                      on screen. All of them write into the ONE
                      `contactFilterTagIds` array the payload and the audience
                      rule already use; a per-category state would be a second
                      copy free to drift. */}
                  {categories.map(cat => {
                    const catTags = tags.filter(t => t.category_id === cat.id);
                    if (catTags.length === 0) return null;
                    const catIds = catTags.map(t => t.id);
                    const mine = contactFilterTagIds.filter(id => catIds.includes(id));
                    return (
                      <TagMultiSelect
                        key={cat.id}
                        categories={[cat]}
                        tags={catTags}
                        selectedIds={mine}
                        placeholder={cat.name}
                        onChange={next => setContactFilterTagIds([
                          ...contactFilterTagIds.filter(id => !catIds.includes(id)),
                          ...next,
                        ])}
                        minWidth={150}
                      />
                    );
                  })}
                  {(() => {
                    const loose = tags.filter(t => !categories.some(c => c.id === t.category_id));
                    if (loose.length === 0) return null;
                    const looseIds = loose.map(t => t.id);
                    return (
                      <TagMultiSelect
                        categories={[]} tags={loose}
                        selectedIds={contactFilterTagIds.filter(id => looseIds.includes(id))}
                        placeholder="Other tags"
                        onChange={next => setContactFilterTagIds([
                          ...contactFilterTagIds.filter(id => !looseIds.includes(id)),
                          ...next,
                        ])}
                        minWidth={150}
                      />
                    );
                  })()}

                  {/* Only worth showing once more than one tag is picked — with
                      one selected the two modes are identical. */}
                  {contactFilterTagIds.length > 1 && (
                    <Segmented
                      value={tagMatchMode}
                      onChange={setTagMatchMode}
                      title="A contact carries at most one tag per category, so 'all' means one match from every category you have filtered on — not every tag at once, which nobody could satisfy."
                      options={[
                        { k: 'all', label: 'Match all' },
                        { k: 'any', label: 'Match any' },
                      ]}
                    />
                  )}

                  <DateRangeFilter
                    label="Arrived"
                    title="When the person first appeared here"
                    from={arrivedFrom} to={arrivedTo}
                    onFrom={setArrivedFrom} onTo={setArrivedTo}
                  />
                  <DateRangeFilter
                    label="Last replied"
                    title="When they last messaged us — not when their record was last touched"
                    from={repliedFrom} to={repliedTo}
                    onFrom={setRepliedFrom} onTo={setRepliedTo}
                  />

                  {/* "Never replied" cannot be a date range — there is no date
                      to compare against, so a range silently excludes exactly
                      the people a re-engagement blast is for. */}
                  <Segmented
                    value={replyState}
                    onChange={setReplyState}
                    title="Has this person ever written to us?"
                    options={[
                      { k: 'any', label: 'Anyone' },
                      { k: 'replied', label: 'Has replied' },
                      { k: 'never', label: 'Never replied' },
                    ]}
                  />

                  {/* A view, not a filter: it never changes the selection, only
                      which rows are shown — which is what makes it safe to
                      leave on while you tick more people off. */}
                  <button
                    onClick={() => setShowSelectedOnly(v => !v)}
                    disabled={selectedRecipients.length === 0 && !showSelectedOnly}
                    title="Show only the people you have already ticked"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '8px 12px', borderRadius: 8,
                      border: `1px solid ${showSelectedOnly ? C.primary : C.border}`,
                      background: showSelectedOnly ? 'var(--c-primaryLight)' : 'var(--c-cardBg)',
                      color: showSelectedOnly ? C.primary : C.textSecondary,
                      cursor: (selectedRecipients.length === 0 && !showSelectedOnly) ? 'not-allowed' : 'pointer',
                      opacity: (selectedRecipients.length === 0 && !showSelectedOnly) ? 0.5 : 1,
                      fontSize: 14, fontWeight: 600, fontFamily: FONT,
                    }}
                  >
                    <CheckCircle size={13} /> Selected only
                  </button>

                  {activeFilterCount > 0 && (
                    <button
                      onClick={clearAllFilters}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '8px 12px', borderRadius: 8,
                        border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                        cursor: 'pointer', fontSize: 14, fontWeight: 600,
                        color: C.textSecondary, fontFamily: FONT,
                      }}
                    >
                      <X size={12} /> Clear {activeFilterCount > 1 ? `(${activeFilterCount})` : ''}
                    </button>
                  )}

                  {/* How much the filters actually cut. Without this you cannot
                      tell "the range matched 12 people" from "the range is
                      wrong and matched almost nobody". */}
                  {activeFilterCount > 0 && (
                    <span style={{ fontSize: 14, color: C.textSecondary, fontFamily: FONT }}>
                      {filteredContacts.length} of {contacts.length} match
                    </span>
                  )}

                  {selectedRecipients.length > 0 && (
                    <span style={{
                      fontSize: 14, fontWeight: 600, color: C.primary,
                      background: C.primaryLight, padding: '6px 12px', borderRadius: 8,
                    }}>
                      {selectedRecipients.length} selected
                    </span>
                  )}
                </div>

                {/* Contacts Table */}
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 15 }}>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                        <tr style={{ background: 'var(--c-hover)' }}>
                          <th style={{ padding: '12px 8px 12px 16px', textAlign: 'center', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}`, width: 40 }}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={el => { if (el) el.indeterminate = someSelected; }}
                              onChange={toggleSelectAll}
                              style={{ cursor: 'pointer', width: 16, height: 16 }}
                            />
                          </th>
                          <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Name</th>
                          <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Phone</th>
                          {categories.map(cat => (
                            <th key={cat.id} style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>{cat.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {contactsLoading && contacts.length === 0 && (
                          <tr>
                            <td colSpan={3 + categories.length} style={{ padding: 40, textAlign: 'center', color: C.textMuted }}>
                              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
                              <div style={{ fontSize: 15 }}>Loading contacts…</div>
                            </td>
                          </tr>
                        )}
                        {!contactsLoading && filteredContacts.length === 0 && (
                          <tr>
                            <td colSpan={3 + categories.length} style={{ padding: 40, textAlign: 'center', color: C.textMuted, fontSize: 15 }}>
                              {/* ⚠ This must count EVERY filter, date ranges
                                  included. It used to test only the search box
                                  and the tag picker, so filtering by date alone
                                  produced "No saved contacts for this number" —
                                  a flat lie when 334 of them exist and merely
                                  fall outside the range. An empty state that
                                  misdiagnoses is worse than none. */}
                              {activeFilterCount > 0
                                ? `No contacts match your filters${contacts.length ? ` — ${contacts.length} available` : ''}`
                                : 'No saved contacts for this number'}
                            </td>
                          </tr>
                        )}
                        {filteredContacts.map(c => {
                          const isSelected = selectedContactNumbers.has(c.contact_number);
                          return (
                            <tr key={c.contact_number} style={{ background: isSelected ? 'var(--c-primaryLight)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                              onClick={() => toggleSelectOne(c.contact_number)}
                              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--c-xf9fafb, #f9fafb)'; }}
                              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'var(--c-cardBg)'; }}
                            >
                              <td style={{ padding: '12px 8px 12px 16px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelectOne(c.contact_number)}
                                  style={{ cursor: 'pointer', width: 16, height: 16 }}
                                />
                              </td>
                              <td style={{ padding: '12px 16px', fontWeight: 600, color: C.text }}>{c.name}</td>
                              <td style={{ padding: '12px 16px', color: C.textSecondary }}><MaskedNumber number={c.contact_number} prefix="+" /></td>
                              {categories.map(cat => {
                                const tag = (c.tags || []).find(t => t.category_id === cat.id);
                                const info = tag ? getTagInfo(tag) : null;
                                return (
                                  <td key={cat.id} style={{ padding: '12px 16px' }}>
                                    {info ? <TagBadge tag={info} /> : <span style={{ color: C.textMuted, fontSize: 14 }}>—</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                </>)}
              </div>
              )}
              </div>

              {/* Footer Buttons */}
              <div style={{
                display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between',
                padding: '16px 24px 20px', borderTop: `1px solid ${C.border}`, flexShrink: 0,
              }}>
                {/* Selected-recipient count — visible right next to the Broadcast button */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontFamily: FONT, color: selectedRecipients.length > 0 ? C.text : C.textMuted, fontWeight: 600 }}>
                  <Users size={15} color={selectedRecipients.length > 0 ? C.primary : C.textMuted} />
                  {selectedRecipients.length > 0
                    ? <span><strong>{selectedRecipients.length}</strong> recipient{selectedRecipients.length === 1 ? '' : 's'} selected</span>
                    : <span>No recipients selected</span>}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={closeNewBroadcastModal} style={{
                  padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
                  background: 'transparent', cursor: 'pointer', fontSize: 15,
                  fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                }}>Cancel</button>
                {composerStep === 'recipients' && (
                  <button
                    onClick={() => setComposerStep('message')}
                    style={{
                      padding: '10px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                      background: 'transparent', cursor: 'pointer', fontSize: 15,
                      fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  ><ChevronLeft size={14} /> Back</button>
                )}
                {/* A repeating send has no draft — a series is created live and
                    then paused, which is a different thing from a draft
                    broadcast, so offering one here would be a button with
                    nothing behind it. */}
                {sendMode !== 'repeating' && (
                  <button
                    /* ⚠ On an EDIT this must keep the mode that is on screen.
                       Saving a scheduled broadcast as a DRAFT would silently
                       un-schedule it — the operator pressed "Save changes", not
                       "cancel the send". */
                    onClick={() => handleNewBroadcastSave(editing && sendMode === 'scheduled' ? 'SCHEDULED' : 'DRAFT')}
                    disabled={isBroadcastFormInvalid()}
                    title={selectedRecipients.length === 0 ? 'Pick who it goes to first' : undefined}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: `1.5px solid ${C.primary}`,
                      background: 'var(--c-cardBg)', color: C.primary,
                      cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      opacity: isBroadcastFormInvalid() ? 0.5 : 1,
                    }}
                  >
                    {editing ? 'Save changes' : 'Save as Draft'}
                  </button>
                )}
                {/* ONE primary action, and it says what it will do. The
                    schedule input moved into the body (ScheduleSection) — a
                    datetime box wedged between two buttons made "now or later?"
                    a question you answered by aiming carefully. */}
                {composerStep === 'message' ? (
                  <button
                    onClick={() => setComposerStep('recipients')}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: C.primary, color: '#fff', cursor: 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                    }}
                  >
                    Next: {sendMode === 'repeating' ? 'Audience' : 'Recipients'} <ChevronRight size={14} />
                  </button>
                ) : sendMode === 'repeating' ? (
                  <button
                    onClick={handleCreateSeries}
                    disabled={isBroadcastFormInvalid({ ignoreRecipients: true }) || !seriesReady}
                    title={!seriesReady ? 'Set how often it repeats and when it ends' : undefined}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: (isBroadcastFormInvalid({ ignoreRecipients: true }) || !seriesReady) ? 'var(--c-borderStrong, #ccc)' : C.purple,
                      color: '#fff',
                      cursor: (isBroadcastFormInvalid({ ignoreRecipients: true }) || !seriesReady) ? 'not-allowed' : 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                    }}
                  >
                    {newBroadcasting && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    <Repeat size={14} /> Create schedule
                  </button>
                ) : sendMode === 'scheduled' ? (
                  <button
                    onClick={() => handleNewBroadcastSave('SCHEDULED')}
                    disabled={isBroadcastFormInvalid() || !scheduleReady}
                    title={!newBroadcastScheduleAt ? 'Pick a time above first' : undefined}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: (isBroadcastFormInvalid() || !scheduleReady) ? 'var(--c-borderStrong, #ccc)' : C.purple,
                      color: '#fff', cursor: (isBroadcastFormInvalid() || !scheduleReady) ? 'not-allowed' : 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                    }}
                  >
                    {newBroadcasting && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    <Clock size={14} /> Schedule{selectedRecipients.length > 0 ? ` (${selectedRecipients.length})` : ''}
                  </button>
                ) : (
                  <button
                    onClick={() => { if (!isBroadcastFormInvalid()) setShowBroadcastConfirm(true); }}
                    disabled={isBroadcastFormInvalid()}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: isBroadcastFormInvalid() ? 'var(--c-borderStrong, #ccc)' : C.primary,
                      color: '#fff', cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {newBroadcasting && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    <Send size={14} /> Broadcast Now{selectedRecipients.length > 0 ? ` (${selectedRecipients.length})` : ''}
                  </button>
                )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Broadcast confirmation */}
        {showBroadcastConfirm && (
          <div onClick={() => setShowBroadcastConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, fontFamily: FONT }}>
            <div onClick={e => e.stopPropagation()} style={{ background: 'var(--c-cardBg)', borderRadius: 14, width: 420, boxShadow: C.shadowLg, padding: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--c-dangerBg, #FCEBEB)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Send size={18} color={C.primary} />
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Send this broadcast?</div>
              </div>
              <div style={{ fontSize: 15, color: C.textSecondary, lineHeight: 1.6, marginBottom: 18 }}>
                You're about to send this message to <strong style={{ color: C.text }}>{selectedRecipients.length}</strong> recipient{selectedRecipients.length === 1 ? '' : 's'} from <strong style={{ color: C.text }}>{maskPhone(newBroadcastFrom)}</strong>.
                {newBroadcastMessageType === 'template' && selectedTemplate ? <> Template: <strong style={{ color: C.text }}>{selectedTemplate.name}</strong>.</> : null}
                <br />This action cannot be undone.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowBroadcastConfirm(false)} style={{ padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', fontSize: 15, fontWeight: 600, color: C.textSecondary, fontFamily: FONT }}>Cancel</button>
                <button
                  onClick={() => { setShowBroadcastConfirm(false); handleNewBroadcastSave('SENT'); }}
                  disabled={newBroadcasting}
                  style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: C.primary, color: '#fff', cursor: newBroadcasting ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Send size={14} /> Yes, Broadcast Now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── DETAIL VIEW ────────────────────────────────────────────────────────────
  const b = selectedBroadcast;
  const tpl = templateForPreview(b);
  const metrics = b ? getMetrics(b) : null;



  return (
    <div style={{ padding: '24px 28px', fontFamily: FONT }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => { setView('list'); setSelectedBroadcast(null); }}
            style={{
              border: `1px solid ${C.border}`, background: 'var(--c-cardBg)', borderRadius: 8,
              padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              color: C.textSecondary, fontSize: 15, fontWeight: 600, fontFamily: FONT,
            }}
          >
            <ArrowLeft size={14} /> Back
          </button>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>
              {b?.name || b?.template_name || 'Broadcast'} #{b?.id}
            </h1>
            <p style={{ fontSize: 14, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>
              Created {b?.created_at ? formatDate(b.created_at) : '—'}
            </p>
          </div>
          {b && <StatusBadge status={b.status} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Same rule as the list row: Edit only while it can still change. */}
          {b && EDITABLE_BROADCAST_STATUSES.includes(b.status) && (
            <button
              onClick={() => { setView('list'); setSelectedBroadcast(null); openComposerFor(b, { mode: 'edit' }); }}
              style={{
                padding: '10px 16px', borderRadius: 8, border: `1.5px solid ${C.primary}`,
                background: 'var(--c-cardBg)', color: C.primary, cursor: 'pointer',
                fontSize: 15, fontWeight: 700, fontFamily: FONT,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Pencil size={14} /> Edit
            </button>
          )}
          {b && (
            <button
              onClick={() => { setView('list'); setSelectedBroadcast(null); openComposerFor(b, { mode: 'duplicate' }); }}
              title={EDITABLE_BROADCAST_STATUSES.includes(b.status)
                ? 'Start a new draft from this one'
                : 'Already sent — this starts a new draft with the same content'}
              style={{
                padding: '10px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'var(--c-cardBg)', color: C.textSecondary, cursor: 'pointer',
                fontSize: 15, fontWeight: 700, fontFamily: FONT,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <Copy size={14} /> Duplicate
            </button>
          )}
          <button
            onClick={() => { setRepeatModal(true); setRepeatTestNumber(b?.test_number || ''); }}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none',
              background: C.primary, color: '#fff', cursor: 'pointer',
              fontSize: 15, fontWeight: 700, fontFamily: FONT,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Repeat size={14} /> Repeat Broadcast
          </button>
        </div>
      </div>

      {detailLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80, flexDirection: 'column', gap: 12 }}>
          <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: C.textMuted }} />
          <div style={{ fontSize: 15, color: C.textMuted }}>Loading broadcast details…</div>
        </div>
      ) : !b ? (
        <div style={{ textAlign: 'center', padding: 60, color: C.textMuted }}>Broadcast not found</div>
      ) : (
        <>
          {/* KPI Cards */}
          <KpiCards metrics={metrics} />

          {/* Info + Preview Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 24, marginBottom: 28 }}>
            {/* Info Card */}
            <div style={{ background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Broadcast Details</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text }}>
                    <Phone size={12} color={C.textMuted} /> <MaskedNumber number={b.from_number} prefix="+" />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Template</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text }}>
                    <FileText size={12} color={C.textMuted} /> {b.template_name || '—'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recipients</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, color: C.text }}>
                    <Users size={12} color={C.textMuted} /> {formatRecipients(b)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Created</div>
                  <div style={{ fontSize: 15, color: C.text }}>{formatDate(b.created_at)} {formatTime(b.created_at)}</div>
                </div>
                {b.test_number && (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test Number</div>
                    <div style={{ fontSize: 15, color: C.text }}><MaskedNumber number={b.test_number} prefix="+" /></div>
                  </div>
                )}
              </div>
            </div>

            {/* Preview */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--c-t6, #888)', fontFamily: FONT }}>Template Preview</div>
              <WhatsAppPreview template={tpl} />
            </div>
          </div>

          {/* Activity Log */}
          <div style={{ background: C.cardBg, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Activity Log</div>
              <div style={{ fontSize: 14, color: C.textMuted }}>{(b.logs || []).length} entries</div>
            </div>

            {(b.logs || []).length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>📋</div>
                <div style={{ fontSize: 15, color: C.textMuted }}>No activity yet. Send a test or broadcast to see entries here.</div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
                <thead>
                  <tr style={{ background: 'var(--c-surfaceInner, #fafaf9)', borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Action</th>
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sent To</th>
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</th>
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sent At</th>
                  </tr>
                </thead>
                <tbody>
                  {(b.logs || []).map(log => (
                    <tr
                      key={log.id}
                      onClick={() => setSelectedLog(log)}
                      style={{
                        borderBottom: `1px solid ${C.border}`,
                        cursor: 'pointer',
                        transition: 'background .15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--c-xfafaf9, #fafaf9)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '10px 16px' }}><ActionBadge action={log.action} /></td>
                      <td style={{ padding: '10px 16px', color: C.textSecondary, fontSize: 15 }}>{formatSentTo(log)}</td>
                      <td style={{ padding: '10px 16px' }}><LogStatusBadge status={log.status} /></td>
                      <td style={{ padding: '10px 16px', color: C.textSecondary, fontSize: 14 }}>
                        {formatDate(log.sent_at)} {formatTime(log.sent_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Activity Log Detail Modal */}
      {selectedLog && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            width: 480, maxHeight: '80vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
            display: 'flex', flexDirection: 'column',
            padding: '24px 24px 20px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Activity Details</div>
              <button onClick={() => setSelectedLog(null)} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Action</div>
                <ActionBadge action={selectedLog.action} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sent To</div>
                <div style={{ fontSize: 15, color: C.text, fontFamily: FONT, wordBreak: 'break-all' }}>{selectedLog.sent_to}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</div>
                <LogStatusBadge status={selectedLog.status} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sent At</div>
                <div style={{ fontSize: 15, color: C.text, fontFamily: FONT }}>{formatDate(selectedLog.sent_at)} {formatTime(selectedLog.sent_at)}</div>
              </div>
              {selectedLog.action === 'BROADCAST' && b?.statusRollup && (
                <div style={{
                  background: 'var(--c-surfaceInner, #fafaf9)', borderRadius: 8, padding: 12, border: `1px solid ${C.border}`,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Delivery Summary</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{b.statusRollup.total || 0}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Total</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--c-s3b82f6, #3b82f6)' }}>{b.statusRollup.sent || 0}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Sent</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981' }}>{b.statusRollup.delivered || 0}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Delivered</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--c-successBright, #059669)' }}>{b.statusRollup.read || 0}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Read</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--c-sef4444, #ef4444)' }}>{b.statusRollup.failed || 0}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Failed</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setSelectedLog(null)} style={{
                padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: 'transparent', cursor: 'pointer', fontSize: 15,
                fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
              }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Repeat Broadcast Modal */}
      {repeatModal && b && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            width: 820, maxHeight: '90vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>
                <Repeat size={18} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 8, color: C.primary }} />
                Repeat Broadcast
              </div>
              <button onClick={() => { setRepeatModal(false); setRepeatTestNumber(''); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={20} /></button>
            </div>

            {/* Two-column body */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 24, padding: '20px 24px' }}>
              {/* LEFT — Test number + actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Readonly summary */}
                <div style={{
                  background: 'var(--c-surfaceInner, #fafaf9)', borderRadius: 8, padding: 12, border: `1px solid ${C.border}`,
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Broadcast Summary</div>
                  <div style={{ fontSize: 15, color: C.text, fontFamily: FONT }}>
                    <strong>From:</strong> <MaskedNumber number={b.from_number} prefix="+" />
                  </div>
                  <div style={{ fontSize: 15, color: C.text, fontFamily: FONT }}>
                    <strong>To:</strong> {formatRecipients(b)}
                  </div>
                  <div style={{ fontSize: 15, color: C.text, fontFamily: FONT }}>
                    <strong>Template:</strong> {b.template_name || '—'}
                  </div>
                </div>

                {/* Test Number */}
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test Number</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={repeatTestNumber}
                      onChange={e => setRepeatTestNumber(e.target.value)}
                      placeholder="+919876543210"
                      style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 15,
                        fontFamily: FONT, color: C.text, outline: 'none',
                      }}
                    />
                    <button
                      onClick={handleRepeatTest}
                      disabled={!repeatTestNumber.trim() || sendingTest}
                      style={{
                        padding: '10px 16px', borderRadius: 8, border: 'none',
                        background: C.primary, color: '#fff',
                        cursor: (!repeatTestNumber.trim() || sendingTest) ? 'not-allowed' : 'pointer',
                        fontSize: 14, fontWeight: 700, fontFamily: FONT,
                        opacity: (!repeatTestNumber.trim() || sendingTest) ? 0.5 : 1,
                        display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                      }}
                    >
                      {sendingTest ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                      Send Test
                    </button>
                  </div>
                </div>

                <div style={{ flex: 1 }} />

                {/* Bottom Buttons */}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                  <button onClick={() => { setRepeatModal(false); setRepeatTestNumber(''); }} style={{
                    padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 15,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Cancel</button>
                  <button
                    onClick={handleRepeatBroadcast}
                    disabled={repeatSending}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: repeatSending ? 'var(--c-borderStrong, #ccc)' : C.primary,
                      color: '#fff', cursor: repeatSending ? 'not-allowed' : 'pointer',
                      fontSize: 15, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {repeatSending && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    <Send size={14} /> Broadcast Now
                  </button>
                </div>
              </div>

              {/* RIGHT — Preview */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'var(--c-t6, #888)', fontFamily: FONT }}>Template Preview</div>
                <WhatsAppPreview template={tpl} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
