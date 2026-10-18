// A medium-sized month grid for picking ONE day — replaces the browser's tiny
// native date input in the follow-up window (reported as too small to hit).
//
// Days are IST calendar days as 'YYYY-MM-DD' (lib/followUpDates.js). Past days
// before `min` are shown but disabled; today is ringed; the chosen day filled.
// Days that already hold a follow-up can be dotted via `marked`.
import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { C, FONT, T, W } from '../constants.js';
import { monthGrid, MONTH_NAMES, todayIST } from '../lib/followUpDates.js';

const WD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export default function DateGrid({ value, onChange, min = null, marked = null, cell = 40 }) {
  const today = todayIST();
  const [month, setMonth] = useState((value || today).slice(0, 7));
  // Follow the value when something outside picks a day in another month
  // (a quick pick, the AI suggestion).
  useEffect(() => { if (value) setMonth(value.slice(0, 7)); }, [value]);

  const grid = monthGrid(`${month}-01`);
  // Only as many rows as the month needs — 5 most months, 6 when it spills.
  const rows = grid.slice(35).some(d => d.slice(0, 7) === month) ? 6 : 5;
  const days = grid.slice(0, rows * 7);
  const shift = (n) => {
    const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const minMonth = min ? min.slice(0, 7) : null;

  return (
    <div data-testid="date-grid" style={{ fontFamily: FONT, userSelect: 'none', width: cell * 7 + 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <NavBtn onClick={() => shift(-1)} disabled={minMonth && month <= minMonth} title="Previous month"><ChevronLeft size={17} /></NavBtn>
        <div style={{ fontSize: T.bodyLg, fontWeight: W.bold, color: C.text }} data-testid="date-grid-month">
          {MONTH_NAMES[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}
        </div>
        <NavBtn onClick={() => shift(1)} title="Next month"><ChevronRight size={17} /></NavBtn>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${cell}px)`, gap: 2, padding: '0 6px' }}>
        {WD.map(d => (
          <div key={d} style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: T.label, fontWeight: W.bold, color: C.textMuted }}>{d}</div>
        ))}
        {days.map(d => {
          const inMonth = d.slice(0, 7) === month;
          const disabled = !!min && d < min;
          const selected = d === value;
          const isToday = d === today;
          const dot = marked && marked.has(d);
          return (
            <button
              key={d}
              type="button"
              data-date={d}
              disabled={disabled}
              onClick={() => onChange(d)}
              aria-pressed={selected}
              aria-label={d}
              style={{
                width: cell, height: cell, borderRadius: 10, position: 'relative',
                border: isToday && !selected ? `1.5px solid ${C.primary}` : '1.5px solid transparent',
                background: selected ? C.primary : 'transparent',
                color: selected ? '#fff' : disabled ? C.textMuted : inMonth ? C.text : C.textMuted,
                opacity: disabled ? 0.35 : inMonth ? 1 : 0.55,
                fontSize: T.body, fontWeight: selected || isToday ? W.heavy : W.medium,
                cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: FONT,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={e => { if (!disabled && !selected) e.currentTarget.style.background = 'var(--c-hover)'; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
            >
              {Number(d.slice(8))}
              {dot && !selected && <span style={{ position: 'absolute', bottom: 5, width: 4, height: 4, borderRadius: '50%', background: C.primary }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavBtn({ children, disabled, ...p }) {
  return (
    <button type="button" disabled={disabled} {...p} style={{
      width: 32, height: 32, borderRadius: 9, border: `1.5px solid ${C.border}`, background: 'transparent',
      color: C.text, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.35 : 1,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>{children}</button>
  );
}
