// Notes layer for the Conversion API tab.
//
// Every control on that tab gets its explanation from the SAME backend catalog
// (capi.NOTE_CATALOG), so guidance is uniform instead of some controls being
// documented and others left to guesswork. Two shapes:
//
//   <NoteChip>   a small "What's this?" affordance next to a control
//   <NotePanel>  the expanded explanation, inline or in a modal
import { useState } from 'react';
import { HelpCircle, X, Info } from 'lucide-react';
import { C, FONT } from '../constants.js';

// Small inline "what is this" trigger that expands in place. Used beside a
// control where opening a modal would lose the person's place.
export function NoteChip({ note, label = "What's this?" }) {
  const [open, setOpen] = useState(false);
  if (!note) return null;
  return (
    <>
      <button onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', color: C.primary, fontFamily: FONT, fontSize: 12, fontWeight: 600,
        }}>
        <HelpCircle size={13} /> {open ? 'Hide' : label}
      </button>
      {open && <NoteBody note={note} style={{ marginTop: 9 }} />}
    </>
  );
}

// The explanation itself — a title plus one paragraph per point.
export function NoteBody({ note, style }) {
  if (!note) return null;
  const paras = Array.isArray(note.body) ? note.body : [note.body];
  return (
    <div style={{
      padding: '12px 14px', background: C.surfaceAlt, border: `1px solid ${C.border}`,
      borderRadius: 10, fontFamily: FONT, ...style,
    }}>
      {note.title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
          <Info size={14} color={C.textMuted} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.03em', color: C.text }}>{note.title}</span>
        </div>
      )}
      {paras.map((p, i) => (
        <p key={i} style={{
          margin: i === paras.length - 1 ? 0 : '0 0 8px',
          fontSize: 12.5, lineHeight: 1.55, color: C.textSecondary,
        }}>
          {p}
        </p>
      ))}
    </div>
  );
}

// A persistent explanatory banner for the top of a section — same copy source,
// used where the guidance should always be visible rather than opt-in.
export function NoteBanner({ note, tone = 'neutral', style }) {
  if (!note) return null;
  const tones = {
    neutral: { bg: C.surfaceAlt, border: C.border, color: C.textSecondary, icon: C.textMuted },
    warn: { bg: '#FFF8E6', border: '#F0DCA8', color: '#6B5312', icon: '#B7791F' },
  };
  const t = tones[tone] || tones.neutral;
  const paras = Array.isArray(note.body) ? note.body : [note.body];
  return (
    <div style={{
      display: 'flex', gap: 9, padding: '11px 13px', background: t.bg,
      border: `1px solid ${t.border}`, borderRadius: 10, fontFamily: FONT, ...style,
    }}>
      <Info size={15} color={t.icon} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        {note.title && <div style={{ fontSize: 12.5, fontWeight: 700, color: t.color, marginBottom: 3 }}>{note.title}</div>}
        {paras.map((p, i) => (
          <p key={i} style={{ margin: i === paras.length - 1 ? 0 : '0 0 6px', fontSize: 12.5, lineHeight: 1.55, color: t.color }}>{p}</p>
        ))}
      </div>
    </div>
  );
}

// Full-screen reference for a group of notes — the "everything about this tab"
// view, reached from the page header.
export function NotesModal({ notes, order, onClose }) {
  const keys = (order || Object.keys(notes || {})).filter(k => notes?.[k]);
  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(720px, 100%)', maxHeight: '88vh', overflowY: 'auto', background: C.cardBg, borderRadius: 14, boxShadow: C.shadowLg, fontFamily: FONT }}>
        <div style={{ position: 'sticky', top: 0, background: C.cardBg, padding: '18px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>How the Conversion API works</span>
          <button onClick={onClose} style={{ background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 7, padding: '5px 7px', cursor: 'pointer', color: C.textSecondary, display: 'inline-flex' }}>
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {keys.map(k => <NoteBody key={k} note={notes[k]} />)}
        </div>
      </div>
    </div>
  );
}
