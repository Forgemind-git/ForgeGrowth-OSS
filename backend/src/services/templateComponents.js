/**
 * Shared builders for Meta template `components`.
 *
 * WHY SHARED
 * ----------
 * `executeMessageNode` was the ONLY send path in the codebase that never
 * emitted a `{type:'header'}` component. Every automation using an approved
 * template with an IMAGE / VIDEO / DOCUMENT header was therefore refused by
 * Meta (error 132012) on every single send, while the execution step logged
 * success. The broadcast path had it right; the engine simply never grew it.
 *
 * The fix is a shared function rather than a second copy, because a second copy
 * is exactly how the two halves drift — and the drifted half fails AT META,
 * days later, as an opaque rejection.
 */

const MEDIA_HEADER_TYPES = ['IMAGE', 'VIDEO', 'DOCUMENT'];

/**
 * The header component for a template, or null when none is needed.
 *
 * Meta's rules:
 *   - A media header REQUIRES the media as a runtime parameter. Omit it and the
 *     send is rejected with 132012.
 *   - A TEXT header needs a parameter ONLY when it contains a {{n}}.
 *   - A static TEXT header, or NONE, needs no component at all.
 *
 * @param {object} template        row from message_templates
 * @param {string|null} headerMediaId  per-account Meta media id (already resolved)
 * @param {string|null} headerText     resolved text for a {{n}} TEXT header
 */
function buildHeaderComponent(template, headerMediaId, headerText) {
  const ht = String(template?.header_type || 'NONE').toUpperCase();

  if (MEDIA_HEADER_TYPES.includes(ht)) {
    // No media id means we could not resolve one. Returning null here lets the
    // caller decide — sending without it would be a guaranteed Meta rejection,
    // so the caller should refuse rather than enqueue a doomed message.
    if (!headerMediaId) return null;
    const key = ht.toLowerCase(); // image | video | document
    return { type: 'header', parameters: [{ type: key, [key]: { id: headerMediaId } }] };
  }

  if (ht === 'TEXT' && /\{\{\s*\d+\s*\}\}/.test(String(template?.header_text || ''))) {
    // `headerText == null` means the CALLER could not resolve the variable —
    // broadcasts, for instance, maps body variables only and has no value for a
    // header one. Emitting a placeholder there would send a space where the
    // customer should see their name, which is worse than the existing
    // rejection. Only emit when the caller actually resolved something.
    if (headerText == null) return null;
    // Meta rejects an EMPTY parameter, so a resolution that came back blank
    // falls back to a single space rather than dropping the component (which
    // would itself be a rejection, since the approved template declares a
    // variable).
    return { type: 'header', parameters: [{ type: 'text', text: String(headerText) || ' ' }] };
  }

  return null;
}

/** True when this template cannot be sent without a resolved media id. */
function needsHeaderMedia(template) {
  return MEDIA_HEADER_TYPES.includes(String(template?.header_type || 'NONE').toUpperCase());
}

module.exports = { buildHeaderComponent, needsHeaderMedia, MEDIA_HEADER_TYPES };
