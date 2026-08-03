// Meta standard-event picker + reference guide.
//
// Both read the SAME catalog served by GET /api/capi/config (eventCatalog), so
// the one-line description in the dropdown and the long explanation in the guide
// can never drift apart. Each entry says three different things and the UI keeps
// them visually distinct:
//   meaning       — what the signal claims happened
//   metaBehaviour — what Meta's optimiser does with it
//   messaging     — what it corresponds to in a WhatsApp conversation
import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, Check, Search, Info, Zap, IndianRupee } from 'lucide-react';
import { C, FONT, MONO } from '../constants.js';

// How much weight Meta gives the signal — shown as a small coloured chip so the
// list can be skimmed for "which of these actually moves delivery".
export const STRENGTH_META = {
  high:   { label: 'Strong signal', color: '#0F6E56', bg: '#E1F5EE' },
  medium: { label: 'Medium signal', color: '#854F0B', bg: '#FAEEDA' },
  low:    { label: 'Weak signal',   color: '#6B7280', bg: '#F1F1EE' },
};

function StrengthChip({ strength }) {
  const m = STRENGTH_META[strength] || STRENGTH_META.low;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 5,
      fontSize: 10, fontWeight: 700, letterSpacing: '.03em', color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  );
}

function ValueChip() {
  return (
    <span title="Meta expects a monetary value with this event"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 5,
        fontSize: 10, fontWeight: 700, color: '#0F6E56', background: '#E1F5EE', whiteSpace: 'nowrap' }}>
      <IndianRupee size={9} /> Needs a value
    </span>
  );
}

// Groups the flat catalog into its declared sections, preserving group order.
function useGrouped(catalog, groups, query) {
  return useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    const match = (e) => !q || [e.name, e.group, e.meaning, e.metaBehaviour, e.messaging]
      .some(v => String(v || '').toLowerCase().includes(q));
    const order = groups && groups.length ? groups : [...new Set(catalog.map(e => e.group))];
    return order
      .map(g => ({ group: g, items: catalog.filter(e => e.group === g && match(e)) }))
      .filter(s => s.items.length > 0);
  }, [catalog, groups, query]);
}

/**
 * Grouped, searchable Meta-event picker.
 *
 * Renders like the app's SearchableSelect (same trigger, same popover shape) but
 * with section headers and a description under every option — a bare list of 17
 * capitalised words tells the person nothing about which one to pick.
 */
export function MetaEventSelect({ value, onChange, catalog = [], groups = [], disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open]);
  useEffect(() => { if (open) setQuery(''); }, [open]);

  const sections = useGrouped(catalog, groups, query);
  const selected = catalog.find(e => e.name === value);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled} onClick={() => !disabled && setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 32px 10px 12px',
          borderRadius: 8, border: `1.5px solid ${open ? C.primary : C.border}`, fontSize: 13, fontFamily: FONT,
          color: selected ? C.text : C.textMuted, background: disabled ? C.hover : C.cardBg,
          cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left', position: 'relative',
          outline: 'none', boxSizing: 'border-box',
        }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{selected ? selected.name : 'Choose a Meta event…'}</span>
          {selected && (
            <span style={{ display: 'block', fontSize: 11.5, color: C.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
              {selected.meaning}
            </span>
          )}
        </span>
        <ChevronDown size={14} color={C.textMuted} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: C.cardBg,
          border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadowLg, zIndex: 60,
          overflow: 'hidden', fontFamily: FONT,
        }}>
          <div style={{ padding: 8, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} color={C.textMuted} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Search events…"
                style={{ width: '100%', padding: '7px 9px 7px 28px', borderRadius: 7, border: `1px solid ${C.border}`,
                  fontSize: 12.5, fontFamily: FONT, color: C.text, outline: 'none', background: C.cardBg, boxSizing: 'border-box' }} />
            </div>
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto', padding: 6 }}>
            {sections.length === 0 && (
              <div style={{ padding: '12px 8px', color: C.textMuted, fontSize: 12 }}>No matching event.</div>
            )}
            {sections.map(sec => (
              <div key={sec.group}>
                <div style={{ padding: '8px 8px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
                  textTransform: 'uppercase', color: C.textMuted }}>
                  {sec.group}
                </div>
                {sec.items.map(e => {
                  const on = e.name === value;
                  return (
                    <div key={e.name} onClick={() => { onChange(e.name); setOpen(false); }}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px', borderRadius: 6,
                        cursor: 'pointer', background: on ? C.primaryLight : 'transparent' }}
                      onMouseEnter={ev => { if (!on) ev.currentTarget.style.background = C.hover; }}
                      onMouseLeave={ev => { if (!on) ev.currentTarget.style.background = 'transparent'; }}>
                      <Check size={13} color={C.primary} style={{ flexShrink: 0, marginTop: 3, opacity: on ? 1 : 0 }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{e.name}</span>
                          <StrengthChip strength={e.strength} />
                          {e.expectsValue && <ValueChip />}
                          {e.recommended && (
                            <span title="Fits a WhatsApp funnel"
                              style={{ fontSize: 10, fontWeight: 700, color: C.primary, background: C.primaryLight, padding: '2px 6px', borderRadius: 5 }}>
                              SUITED TO CHAT
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 2, lineHeight: 1.4 }}>{e.meaning}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The reference guide behind the "What do these mean?" button — every Meta
 * signal, what it means, what Meta does with it, and how it maps to a WhatsApp
 * conversation. Same catalog as the picker.
 */
export function MetaEventGuide({ catalog = [], groups = [], selectedName, onPick }) {
  const [query, setQuery] = useState('');
  const sections = useGrouped(catalog, groups, query);

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'flex', gap: 9, padding: '11px 13px', marginBottom: 14, background: C.surfaceAlt,
        border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5 }}>
        <Info size={15} color={C.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          These are Meta&apos;s <strong>standard events</strong> — the fixed vocabulary its optimiser understands.
          When one of your funnel stages is mapped to an event, reaching that stage sends the person&apos;s
          click-to-WhatsApp click ID to Meta labelled with it. Meta then knows which ad produced that outcome and
          shifts budget towards the ads and audiences that produce more of them.
          <strong> A stronger signal steers delivery harder</strong>, so map the stage that genuinely reflects value —
          not the one that happens most often.
        </span>
      </div>

      <div style={{ position: 'relative', marginBottom: 14 }}>
        <Search size={14} color={C.textMuted} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)' }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search all Meta events…"
          style={{ width: '100%', padding: '9px 11px 9px 32px', borderRadius: 8, border: `1.5px solid ${C.border}`,
            fontSize: 13, fontFamily: FONT, color: C.text, outline: 'none', background: C.cardBg, boxSizing: 'border-box' }} />
      </div>

      {sections.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
          No event matches “{query}”.
        </div>
      )}

      {sections.map(sec => (
        <div key={sec.group} style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.text }}>
              {sec.group}
            </span>
            <span style={{ flex: 1, height: 1, background: C.border }} />
            <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>{sec.items.length}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {sec.items.map(e => {
              const on = e.name === selectedName;
              return (
                <div key={e.name}
                  onClick={onPick ? () => onPick(e.name) : undefined}
                  style={{
                    border: `1px solid ${on ? C.primary : C.border}`, borderRadius: 11, padding: '12px 14px',
                    background: on ? C.primaryLight : C.cardBg, cursor: onPick ? 'pointer' : 'default',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 7 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: MONO }}>{e.name}</span>
                    <StrengthChip strength={e.strength} />
                    {e.expectsValue && <ValueChip />}
                    {e.recommended && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.primary, background: on ? C.cardBg : C.primaryLight, padding: '2px 6px', borderRadius: 5 }}>
                        SUITED TO CHAT
                      </span>
                    )}
                    {onPick && (
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: C.primary }}>
                        {on ? 'Selected' : 'Use this'}
                      </span>
                    )}
                  </div>

                  <GuideLine label="What it means" text={e.meaning} />
                  <GuideLine label="How Meta treats it" text={e.metaBehaviour} icon={Zap} />
                  <GuideLine label="In a WhatsApp funnel" text={e.messaging} last />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function GuideLine({ label, text, icon: Icon, last }) {
  if (!text) return null;
  return (
    <div style={{ marginBottom: last ? 0 : 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700,
        letterSpacing: '.05em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 2 }}>
        {Icon && <Icon size={10} />}{label}
      </div>
      <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}
