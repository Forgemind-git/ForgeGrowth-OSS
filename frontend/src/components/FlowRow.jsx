// FlowRow — KPI cards laid out in the order things happen, left to right, with
// an arrow between each step and a small step caption above each card
// ("1 · Came in", "2 · Reached out", …). Used by Sales → Home and Marketing →
// Overview so a dashboard reads as a journey rather than a pile of numbers.
//
//   steps  [{ key, step: 'Came in', node: <KpiCard …/> }]
import { ChevronRight } from 'lucide-react';
import { C, FONT } from '../constants.js';

export default function FlowRow({ steps, minWidth = 170, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap', gap: 6, ...style }}>
      {steps.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'stretch', gap: 6, flex: `1 1 0`, minWidth }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, fontFamily: FONT, margin: '0 0 6px 2px', whiteSpace: 'nowrap' }}>
              <span style={{ color: C.primary }}>{i + 1}</span> · {s.step}
            </div>
            <div style={{ flex: 1, display: 'grid', minWidth: 0 }}>{s.node}</div>
          </div>
          {i < steps.length - 1 && (
            <div aria-hidden style={{ display: 'flex', alignItems: 'center', paddingTop: 20, color: C.textMuted, flexShrink: 0 }}>
              <ChevronRight size={18} strokeWidth={2.4} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
