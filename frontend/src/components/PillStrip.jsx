import { pillRect } from '../lib/uiZoom.js';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { FONT } from '../constants.js';

/**
 * PillStrip — THE segmented control (Forge borderless §4 / §6).
 *
 * A translucent strip holds BARE items; ONE accent pill sits behind the
 * selected item and SLIDES to the next one (left + width animate, 220ms) while
 * the ink of the two items cross-fades. Items never carry a fill of their own —
 * giving each item its own active background is what makes a selection POP
 * instead of glide, and a strip whose inactive items are grey pills is a row of
 * buttons, not a switch.
 *
 * Every segmented control in the product renders this: the header mode switch
 * (`onBar`), view switches, range pickers, filter strips, tab strips inside
 * modals and popovers. Two implementations of a strip is how one of them ends
 * up popping — do not hand-roll another.
 *
 *   items   [{ id, label, Icon?, title?, badge? }]
 *   value   the selected id        onChange(id)
 *   onBar   white-alpha fills for the black top bar
 *   size    'md' 34px | 'sm' 30px | 'bar' 32px
 *   grow    items share the width (flex: 1)
 *   shape   'pill' (default) | 'block' — block uses the card/nav-row corner
 *           scale (12px strip, 8px selection) so a strip can sit among blocks
 *   disabled  the whole strip is inert (locked field, save in flight)
 *   persistKey  a strip that is REMOUNTED by the switch it drives (Table/Board
 *           renders two different pages, each mounting its own copy) has no
 *           previous position to slide from. With a key, the last measured
 *           pill rect is remembered in module scope and the fresh mount starts
 *           there, so the pill still glides instead of popping into place.
 */
// Last pill rect per persistKey, so a remounted strip can slide from it.
const remembered = new Map();

export default function PillStrip({ items, value, onChange, onBar = false, size = 'md', shape = 'pill', grow = false, disabled = false, persistKey, style, itemStyle, title }) {
  const refs = useRef(new Map());
  const wrapRef = useRef(null);
  const [pill, setPill] = useState(() => (persistKey && remembered.get(persistKey)) || null); // { left, width } of the selected item
  const [ready, setReady] = useState(() => !!(persistKey && remembered.has(persistKey))); // no slide on a first paint with nothing to slide from

  const measure = () => {
    const el = refs.current.get(value);
    if (!el || !wrapRef.current) { setPill(null); return; }
    const next = pillRect(el, wrapRef.current);
    setPill(next);
    if (persistKey) remembered.set(persistKey, next);
  };
  const itemsKey = items.map(i => `${i.id}|${i.label ?? ''}|${i.badge ?? ''}`).join('||');
  useLayoutEffect(() => {
    measure();
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, itemsKey]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !wrapRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const h = size === 'bar' ? 32 : size === 'sm' ? 30 : 34;
  const padX = size === 'bar' ? 16 : size === 'sm' ? 12 : 15;
  const inactiveInk = onBar ? 'rgba(255,255,255,.72)' : 'var(--fc-text-secondary)';
  const hoverInk = onBar ? '#fff' : 'var(--fc-text)';
  const outerRadius = shape === 'block' ? 'var(--fc-r-md)' : 999;
  const innerRadius = shape === 'block' ? 'var(--fc-r-sm)' : 999;

  return (
    <div ref={wrapRef} role="tablist" title={title} className="fc-pillstrip" style={{
      position: 'relative', display: grow ? 'flex' : 'inline-flex', alignItems: 'center', gap: 2, padding: 4,
      borderRadius: outerRadius, background: onBar ? 'rgba(255,255,255,.08)' : 'var(--fc-surface)', maxWidth: '100%', opacity: disabled ? .6 : 1, ...style,
    }}>
      {/* the sliding accent pill — one element, behind every item */}
      {pill && (
        <span aria-hidden className="fc-pillstrip-pill" style={{
          position: 'absolute', top: 4, bottom: 4, left: pill.left, width: pill.width, borderRadius: innerRadius,
          background: 'var(--fc-primary)', pointerEvents: 'none',
          transition: ready ? 'left .22s cubic-bezier(.2,0,.2,1), width .22s cubic-bezier(.2,0,.2,1)' : 'none',
        }} />
      )}
      {items.map(({ id, label, Icon, title: itemTitle, badge }) => {
        const on = id === value;
        return (
          <button key={id} type="button"
            ref={el => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
            role="tab" aria-selected={on} title={itemTitle} disabled={disabled} onClick={() => { if (!disabled) onChange(id); }}
            // Hover moves only the INK of an inactive item, and restores the
            // same token the resting style uses, so the two cannot drift.
            onMouseEnter={e => { if (!on) e.currentTarget.style.color = hoverInk; }}
            onMouseLeave={e => { if (!on) e.currentTarget.style.color = inactiveInk; }}
            style={{
              position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              height: h, padding: `0 ${padX}px`, borderRadius: innerRadius, border: 'none', background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: FONT, fontSize: 14, whiteSpace: 'nowrap', fontWeight: on ? 700 : 550,
              color: on ? 'var(--fc-on-accent)' : inactiveInk, transition: 'color .18s ease', flex: grow ? 1 : undefined, ...itemStyle,
            }}>
            {Icon && (React.isValidElement(Icon) ? Icon : <Icon size={15} strokeWidth={on ? 2.4 : 2} />)}
            {label}
            {badge != null && badge !== 0 && badge !== '' && (
              <span style={{
                fontSize: 12, fontWeight: 780, lineHeight: 1, padding: '3px 6px', borderRadius: 999,
                background: on ? 'rgba(255,255,255,.22)' : 'var(--fc-surface-2)', color: on ? 'var(--fc-on-accent)' : 'var(--fc-text)',
              }}>{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// The same strip on the black top bar — centre it with position:absolute; left:50%.
// Block corners, so the header switch matches the cards and nav rows around it.
export const HeaderSegmented = (props) => <PillStrip onBar size="bar" shape="block" {...props} />;
