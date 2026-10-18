// The app renders at 110% by default (2026-10-16, on request: "at 110% the
// whole application looks neat and clean"). It is done with CSS `zoom` on
// <html> — the variable --fg-zoom in index.css — because every size in this
// app is an inline pixel value, so there is no root font-size to scale.
//
// ⚠ CSS zoom has two side effects, both measured in Chromium 129:
//   1. getBoundingClientRect() and mouse clientX/Y come back in SCREEN pixels
//      (already ×1.1) while any px you SET is zoomed again. So a menu placed at
//      `top: rect.bottom` lands 10% too low. Convert with toLayout() before
//      writing a measured position back into a style.
//   2. Viewport units are zoomed too: 100vh renders as 110% of the window.
//      Every vh/vw in the app is therefore written as
//      calc(Nvh / var(--fg-zoom, 1)).
// The three drag-and-drop canvases (WhatsApp flow builder, its run viewer and
// the Instagram flow builder) undo the zoom on their own root with
// UNZOOM_STYLE, so their pointer maths stays 1:1; they have their own zoom
// controls anyway.

let factor = null;

/** How many screen px one layout px covers right now (1.1 when zoomed). */
export function zoomFactor() {
  if (factor != null) return factor;
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;width:100px;height:1px';
    document.body.appendChild(probe);
    factor = probe.getBoundingClientRect().width / 100 || 1;
    probe.remove();
  } catch (_) { factor = 1; }
  return factor;
}

/** A screen measurement (clientX, a rect edge, innerHeight) → layout px. */
export const toLayout = (v) => v / zoomFactor();

/** Put on a canvas root to render it at 1:1 inside the zoomed app. */
export const UNZOOM_STYLE = { zoom: 'calc(1 / var(--fg-zoom, 1))' };

/**
 * Where a sliding "selected" pill should sit inside its strip, in the strip's
 * own CSS px. Measured from the two rects and scaled by the strip's own
 * rect-to-layout ratio, rather than read from offsetLeft: under CSS zoom some
 * engines/versions report offset* and rects in different units (standardised
 * Chromium: rects zoomed, offsets not; older engines differ), and a pill placed
 * from the wrong one lands ~10% off its item. This form is right either way.
 */
export function pillRect(el, wrap) {
  const e = el.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const k = w.width ? wrap.offsetWidth / w.width : 1;   // rect px → the wrap's CSS px
  return {
    left: Math.round(((e.left - w.left) * k - wrap.clientLeft) * 100) / 100,
    width: Math.round(e.width * k * 100) / 100,
  };
}
