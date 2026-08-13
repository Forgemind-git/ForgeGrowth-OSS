/**
 * Resolve which output handle a customer's reply should follow.
 *
 * WHY THIS EXISTS
 * ---------------
 * The builder has always let you draw one edge per button (`btn:0`, `btn:1`, …)
 * and the settings panel tells the operator to wire each one. The engine never
 * read them: `resumeAutomation` selected the next node with
 *
 *     edges.filter(e => e.from === awaiting_node_id
 *                    && (!e.fromHandle || e.fromHandle === 'default'))
 *
 * so a node whose only edges were `btn:N` matched NOTHING, `startNodeId` came
 * back null, and the execution closed as `status='success'` having sent nothing.
 * A fully-wired three-button flow and an empty one produced byte-identical
 * execution records, which is why it was never noticed.
 *
 * THE SHAPE THAT MATTERS
 * ----------------------
 * Every button-bearing node in this instance's production data is
 * `messageMode: 'template'`, so the tap arrives as Meta `type: 'button'` with
 * `button.payload === button.text === the visible label` — NOT as
 * `interactive.button_reply.id`. A resolver that only understood the
 * interactive shape would pass review and fix nothing that is live. Hence the
 * label path below is not a nicety; for existing traffic it is the only path.
 *
 * RESOLUTION ORDER
 * ----------------
 *   1. Our own injected payload `fg:<nodeId>:<index>` — exact, and survives a
 *      button being renamed or an approved translation being served.
 *   2. The reply id Meta echoes, matched against the ids the engine minted.
 *   3. The visible label, normalised.
 *
 * Returns a handle string (`btn:2`, `row:0:3`) or null when the reply is not a
 * tap we can attribute — the caller then falls back to `nomatch`.
 */

/**
 * ⚠ Normalisation must be IDENTICAL on both sides or matching fails SILENTLY —
 * no error, the branch simply never fires. The `limit` is not cosmetic: the
 * engine slices titles before handing them to Meta (20 for a quick-reply
 * button, 24 for a list row), so Meta echoes back the TRUNCATED title. Compare
 * an untruncated stored title against a truncated echo and a long button never
 * matches itself.
 *
 * Same class of hazard as messageFormats.normalizeMessage, where the JS and SQL
 * implementations must agree exactly.
 */
const norm = (s, limit) => {
  const t = String(s == null ? '' : s).trim();
  return (limit ? t.slice(0, limit) : t).toLowerCase();
};

/** Meta caps applied at send time, mirrored here so both sides truncate alike. */
const BUTTON_TITLE_CAP = 20; // interactive reply button
const LIST_TITLE_CAP = 24;   // interactive list row

/** Build the payload we inject into a template's quick-reply buttons. */
const buildQuickReplyPayload = (nodeId, index) =>
  `fg:${nodeId}:${index}`.slice(0, 128);

/** Parse a payload we injected. Returns {nodeId, index} or null. */
const parseQuickReplyPayload = (raw) => {
  const m = /^fg:(.+):(\d+)$/.exec(String(raw == null ? '' : raw));
  return m ? { nodeId: m[1], index: Number(m[2]) } : null;
};

/**
 * A template button only produces an inbound webhook when it is a QUICK_REPLY.
 * A URL / PHONE_NUMBER / COPY_CODE tap tells us nothing — Meta sends no message
 * at all — so a branch drawn from one is a wire that can never carry anything.
 * The builder must not offer a handle there, and this resolver must never
 * return one.
 */
const isQuickReply = (b) => String(b?.type || '').toUpperCase() === 'QUICK_REPLY';

function resolveTemplateButton(node, record) {
  const buttons = Array.isArray(node.buttons) ? node.buttons : [];
  if (buttons.length === 0) return null;

  // 1. Our injected payload.
  const injected = parseQuickReplyPayload(record.reply_id);
  if (injected) {
    // A payload naming a DIFFERENT node is a tap on an older message that
    // happens to have arrived while this execution was paused. Attributing it
    // here would route the flow off a button the customer tapped somewhere
    // else entirely, so it is explicitly not a match.
    if (injected.nodeId !== node.id) return null;
    return isQuickReply(buttons[injected.index]) ? `btn:${injected.index}` : null;
  }

  // 2/3. Label match. `index` is the position in the FULL button array —
  // including URL buttons — because that is what outputHandlesOf emits and what
  // the payload injector uses, so mixed button sets stay aligned.
  const echoed = norm(record.reply_label || record.message_body);
  if (!echoed) return null;
  for (let i = 0; i < buttons.length; i++) {
    if (!isQuickReply(buttons[i])) continue;
    const label = norm(buttons[i]?.text || buttons[i]?.title);
    if (label && label === echoed) return `btn:${i}`;
  }
  return null;
}

function resolveDirectQuickReply(node, record) {
  const dd = node.directData || {};
  const buttons = Array.isArray(dd.buttons) ? dd.buttons : [];
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] || {};
    // The engine mints `btn_<i>` when the button carries no explicit id.
    const mintedId = String(b.id || `btn_${i}`).slice(0, 256);
    if (record.reply_id && mintedId === record.reply_id) return `btn:${i}`;
  }
  // Fall back to the label, truncated exactly as the sender truncated it.
  const echoed = norm(record.reply_label || record.message_body, BUTTON_TITLE_CAP);
  if (!echoed) return null;
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] || {};
    const label = norm(b.title || b.text, BUTTON_TITLE_CAP);
    if (label && label === echoed) return `btn:${i}`;
  }
  return null;
}

function resolveDirectList(node, record) {
  const dd = node.directData || {};
  const sections = Array.isArray(dd.sections) ? dd.sections : [];
  // Handles are `row:<sectionIndex>:<rowIndex>` against the STORED arrays.
  // The engine skips empty-titled rows when sending, but its default id is
  // derived from (si, ri) directly rather than a running counter, so a skipped
  // row does not shift the ids of the rows after it.
  for (let si = 0; si < sections.length; si++) {
    const rows = Array.isArray(sections[si]?.rows) ? sections[si].rows : [];
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri] || {};
      const mintedId = (String(r.id || '').trim() || `s${si}_r${ri}`).slice(0, 200);
      if (record.reply_id && mintedId === record.reply_id) return `row:${si}:${ri}`;
    }
  }
  const echoed = norm(record.reply_label || record.message_body, LIST_TITLE_CAP);
  if (!echoed) return null;
  for (let si = 0; si < sections.length; si++) {
    const rows = Array.isArray(sections[si]?.rows) ? sections[si].rows : [];
    for (let ri = 0; ri < rows.length; ri++) {
      const label = norm(rows[ri]?.title, LIST_TITLE_CAP);
      if (label && label === echoed) return `row:${si}:${ri}`;
    }
  }
  return null;
}

/**
 * @param {object} node   the paused node, as stored in chatbots.config
 * @param {object} record the inbound message record from parseMetaPayload
 * @returns {string|null} an output handle, or null when unattributable
 */
function resolveReplyHandle(node, record) {
  if (!node || !record) return null;
  if (node.type !== 'message') return null;

  // A shared location is not a "tap" — it arrives as an ordinary
  // type:'location' inbound with no reply_kind — so it has to be resolved
  // BEFORE the reply_kind guard below, or asking for a location could only
  // ever fall through to nomatch and the success branch would be dead.
  if (node.messageMode === 'direct' && node.directType === 'location_request') {
    return record.message_type === 'location' ? 'shared' : null;
  }

  // A step that offered NO choices is a free-text question: whatever they sent
  // is the answer, so it follows `replied`. Falling to `nomatch` here (as the
  // first version did) meant an "Ask a question" step had no live branch at
  // all and visibly dead-ended.
  const offersChoices =
    (node.messageMode === 'direct' && (node.directType === 'quick_reply' || node.directType === 'list')) ||
    (node.messageMode !== 'direct' && Array.isArray(node.buttons) && node.buttons.some(isQuickReply));
  if (!offersChoices) return node.waitForReply === true ? 'replied' : null;

  // Free text on a step that DID offer choices is a genuine no-match, and
  // belongs on `nomatch` — which the caller decides, not a failure logged here.
  if (!record.reply_kind) return null;

  if (node.messageMode === 'direct') {
    if (node.directType === 'quick_reply') return resolveDirectQuickReply(node, record);
    if (node.directType === 'list') return resolveDirectList(node, record);
    return null;
  }
  // Template mode is the default (makeNode sets messageMode: 'template'), so
  // treat anything not explicitly 'direct' as a template.
  return resolveTemplateButton(node, record);
}

/**
 * Every stored spelling of a resolved handle, most specific first.
 *
 * `row:<section>:<row>` is the correct granularity — the UI has always promised
 * "one output per row" while `outputHandlesOf` actually emitted one per
 * SECTION, so a one-section five-row list (the commonest shape) could not
 * branch at all. Migrating to the precise form is safe because ZERO `row:`
 * edges exist in any stored flow, but a config imported from another instance
 * may carry the old spelling, so both are accepted on READ. Only the new form
 * is ever written.
 */
function handleAliases(handle) {
  if (!handle) return [];
  const m = /^row:(\d+):(\d+)$/.exec(handle);
  return m ? [handle, `row:${m[1]}`] : [handle];
}

module.exports = {
  resolveReplyHandle,
  handleAliases,
  buildQuickReplyPayload,
  parseQuickReplyPayload,
  isQuickReply,
  norm,
  BUTTON_TITLE_CAP,
  LIST_TITLE_CAP,
};
