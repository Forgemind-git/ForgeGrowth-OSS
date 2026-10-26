/**
 * Authoring an automation flow from OUTSIDE the builder (today: the MCP
 * `create_automation` tool).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A person building a flow drags a block out of the library, so the block's
 * `defaults` decide its shape and the canvas draws whatever handles that shape
 * produces. An MCP client has none of that: it hand-writes the JSON. So every
 * rule the library encodes as a default has to be stated somewhere the model
 * can read, and every handle name has to be spelled exactly.
 *
 * ⚠ THE BUG THIS EXISTS TO PREVENT — and it was live.
 * `create_automation`'s description RESTATED the handle vocabulary as
 * "default|yes|no|btn:N|row:N". `row:N` was the pre-2026-08-12 spelling: list
 * handles are addressed per ROW and are `row:<section>:<row>`. A model
 * following the schema therefore emitted `row:0`, and `handlePos()` parks a
 * handle it cannot resolve at the card's bottom-right as an orphan. Nothing
 * throws — an edge that matches no handle is indistinguishable from "the flow
 * ends here" — so the flow simply arrived wrong in the builder.
 *
 * That is the same defect the preview simulator was fixed for, in a second copy
 * nobody updated. The fix is the same one: DERIVE, never restate.
 * `describeHandles()` below runs the real `expectedHandles()` over canonical
 * example nodes, so the text the model reads is produced by the same function
 * the validator gates on. They cannot disagree.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not re-implement validation. `flowValidator.validateFlow` is the one
 * gate, and `mcpService.createAutomation` runs it directly.
 */

const { expectedHandles, labelForHandle } = require('./flowValidator');

/* ── What an MCP client is allowed to build ──────────────────────────────── */

/**
 * ⚠ A POLICY LIST, not a derived one — deliberately.
 *
 * The engine still has handlers for `ai`, `api` and `subflow`, and flows
 * imported from another instance may contain them, so they keep running. But
 * all three were taken OUT of the block library on 2026-08-11: agents are built
 * in the AI Agents section, not dropped into a flow. Deriving this list from
 * `NODE_HANDLERS` would quietly hand an MCP client the ability to add blocks a
 * person can no longer add, re-introducing exactly what was removed.
 *
 * `handoff` is likewise absent from the library and is not offered here.
 *
 * Correctness is not left to this comment: test/flowAuthoring.unit.test.js
 * asserts every type listed here HAS an engine handler, so the policy can never
 * drift into offering a step that cannot run.
 */
const AUTHORABLE_TYPES = {
  trigger: 'Starts the flow. Exactly one per automation.',
  message: 'Sends something, and can wait for the customer to reply.',
  condition: 'Branches on contact data, tags, AI output or the time.',
  action: 'Changes the lead or contact — funnel stage, tags, a field, an owner.',
  delay: 'Waits before the next step.',
};

/**
 * Trigger kinds the ENGINE evaluates. Mirrors `TRIGGER_KINDS` in
 * AutomationBuilderView.jsx (the two ship as separate Docker images and cannot
 * import each other). `required` names the field without which the trigger can
 * never fire — which is what `flowValidator` blocks activation on, so these two
 * lists must agree and the unit test asserts they do.
 */
const TRIGGER_KINDS = {
  keyword:    { required: 'keyword',      note: 'Also takes matchType: exact|contains|starts (default exact) and caseSensitive. Optional landingSource (e.g. "claude-landing") fires it only for people whose landing-page details are stored, and exposes those details as {{form_name}} / {{form_summary}}.' },
  tagApplied: { required: 'tag',          note: 'Also takes tagDirection: added|removed and fireOncePerTag.' },
  newContact: { required: null,           note: 'Fires the first time a number ever messages in.' },
  anyMessage: { required: null,           note: 'Fires on every inbound message. Use sparingly.' },
};

/**
 * Message shapes. `messageMode:'template'` sends an approved WhatsApp template
 * (works any time); `messageMode:'direct'` sends free-form content, which Meta
 * only delivers INSIDE the 24-hour window.
 *
 * `fields` are the keys inside `directData`. Mirrors `DIRECT_MSG_TYPES` in the
 * builder; the unit test asserts every key here exists there.
 */
const DIRECT_TYPES = {
  text:        { fields: ['body'], note: 'Plain text.' },
  image:       { fields: ['mediaLibraryId', 'url', 'caption'], note: 'Prefer mediaLibraryId from list_media.' },
  video:       { fields: ['mediaLibraryId', 'url', 'caption'], note: 'Prefer mediaLibraryId from list_media.' },
  audio:       { fields: ['mediaLibraryId', 'url'], note: 'No caption — Meta drops it on audio.' },
  document:    { fields: ['mediaLibraryId', 'url', 'caption', 'filename'], note: 'Give a filename so it shows a proper name.' },
  contact:     { fields: ['name', 'phone'], note: 'A saveable contact card.' },
  quick_reply: { fields: ['body', 'buttons'], note: 'buttons: [{title:"Yes"},{title:"No"}] — max 3, each ≤20 chars, all different. ALWAYS set waitForReply:true.' },
  list:        { fields: ['body', 'button_text', 'sections'], note: 'sections: [{title:"", rows:[{title:"Option 1", description:""}]}] — 10 rows TOTAL across all sections, not per section. ALWAYS set waitForReply:true.' },
  cta_url:     { fields: ['body', 'button_text', 'url'], note: 'A tappable link. WhatsApp reports NOTHING when it is tapped, so it cannot branch.' },
};

/* ── Handles, derived ─────────────────────────────────────────────────────── */

/**
 * Canonical example nodes, one per branching shape. These are fed to the REAL
 * `expectedHandles()` so the documented vocabulary is generated rather than
 * typed — the whole point of this module.
 */
const HANDLE_EXAMPLES = [
  { when: 'any step that does not ask anything (message, action, delay, trigger)',
    node: { id: 'x', type: 'action' } },
  { when: 'a condition',
    node: { id: 'x', type: 'condition' } },
  { when: 'Ask a question — free text, waitForReply:true, no choices offered',
    node: { id: 'x', type: 'message', messageMode: 'direct', directType: 'text', waitForReply: true, directData: { body: '?' } } },
  { when: 'Ask with buttons — waitForReply:true, 2 buttons',
    node: { id: 'x', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
            directData: { body: '?', buttons: [{ title: 'Yes' }, { title: 'No' }] } } },
  { when: 'Ask with a list — waitForReply:true, 1 section of 2 rows',
    node: { id: 'x', type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
            directData: { body: '?', sections: [{ title: '', rows: [{ title: 'A' }, { title: 'B' }] }] } } },
  { when: 'a template message carrying 2 QUICK_REPLY buttons, waitForReply:true',
    node: { id: 'x', type: 'message', messageMode: 'template', templateId: '1', waitForReply: true,
            buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'No' }] } },
];

/** The handle list for each canonical shape, produced by the real function. */
function describeHandles() {
  return HANDLE_EXAMPLES.map(ex => ({
    when: ex.when,
    handles: expectedHandles(ex.node),
    labels: expectedHandles(ex.node).map(h => labelForHandle(ex.node, h)),
  }));
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

const NODE_W = 300;
const COL_GAP = 90;
const ROW_GAP = 60;
const START_X = 120;
const START_Y = 120;

/**
 * Roughly how tall a card will be, used ONLY to space rows apart.
 *
 * ⚠ This is an ESTIMATE and must never be used to position an edge. The
 * frontend's `nodeLayout()` is the authority for real geometry and recomputes
 * every anchor on render; a second copy of those pixel budgets here would be
 * the drift this module exists to prevent. It mirrors only the shape of that
 * budget — a header, an optional bubble, then one line per output row — so
 * a ten-row list menu gets the vertical space it needs instead of overlapping
 * the card beneath it.
 */
function estimateHeight(n) {
  const rows = expectedHandles(n).length || 1;
  const head = 90;
  const bubble = n && n.type === 'message' ? 74 : 0;
  const extra = n && n.type === 'action' ? (n.actions || []).length * 26 : 0;
  return Math.max(96, head + bubble + extra + 10 + rows * 45 + 12);
}

/**
 * Fill in `x`/`y` for any node that lacks them, laying the flow out
 * left-to-right in the direction the canvas now reads.
 *
 * A node that already carries numeric coordinates KEEPS them: the caller may
 * have positioned it deliberately, and silently moving it would be the same
 * class of overreach as an unrelated edit wiping a field.
 *
 * Depth comes from the edges (breadth-first from the trigger), so a branch
 * lands in its own column rather than every card stacking on the origin —
 * which is what an omitted coordinate produced before, and is half of why an
 * MCP-built flow "did not look proper".
 */
function autoLayout(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return list;

  const byId = new Map(list.map(n => [n.id, n]));
  const depth = new Map();
  const start = list.find(n => n.type === 'trigger') || list[0];

  // ⚠ A flow may legitimately LOOP BACK — a menu that re-asks itself on
  // `nomatch`, a "not now" branch returning to the offer. The relaxation below
  // keeps the deepest path, and on a cycle `d` grows without bound, so the
  // "already seen" guard never fires and this walk never terminates. That is
  // not a hang in a worker: `validateAutomation` runs synchronously ON THE
  // EXPRESS EVENT LOOP, so one looping flow submitted over MCP takes the whole
  // app down — no crash, no OOM, so Docker never restarts it either.
  //
  // A simple path visits each node at most once, so no acyclic flow can reach
  // depth `list.length`. Stopping there is therefore a no-op for every valid
  // layout and a hard bound for a cyclic one.
  const MAX_DEPTH = list.length;
  const queue = [[start.id, 0]];
  while (queue.length) {
    const [id, d] = queue.shift();
    if (!byId.has(id)) continue;
    if (d >= MAX_DEPTH) continue;
    // `>=` keeps the DEEPEST path's column, so a step reached both directly and
    // via a branch sits after the branch rather than beside its own source.
    if (depth.has(id) && depth.get(id) >= d) continue;
    depth.set(id, d);
    (Array.isArray(edges) ? edges : [])
      .filter(e => e && e.from === id && e.to)
      .forEach(e => queue.push([e.to, d + 1]));
  }
  // Anything the trigger cannot reach still needs somewhere to sit; park it in
  // a column of its own rather than on top of the flow.
  const maxDepth = depth.size ? Math.max(...depth.values()) : 0;
  list.forEach(n => { if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1); });

  const columns = new Map();
  list.forEach(n => {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  });

  for (const [d, col] of columns) {
    let y = START_Y;
    for (const n of col) {
      const h = estimateHeight(n);
      if (!Number.isFinite(n.x)) n.x = START_X + d * (NODE_W + COL_GAP);
      if (!Number.isFinite(n.y)) n.y = y;
      y += h + ROW_GAP;
    }
  }
  return list;
}

/* ── Normalisation ────────────────────────────────────────────────────────── */

let seq = 0;
const genId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Bring a hand-written config up to the shape the builder and engine expect.
 *
 * Deliberately NARROW: it fills in what is structurally required (an id, a
 * position, the `directData` container) and nothing else. It does NOT guess at
 * content — a missing message body stays missing so `validateFlow` reports it,
 * because inventing one would produce a flow that passes the gate and then
 * sends a customer something nobody wrote.
 */
function normalizeFlowConfig(config = {}) {
  const nodes = (Array.isArray(config.nodes) ? config.nodes : []).map(raw => {
    const n = { ...(raw || {}) };
    if (!n.id) n.id = genId();
    if (n.type === 'message') {
      if (!n.messageMode) n.messageMode = n.templateId ? 'template' : 'direct';
      if (n.messageMode === 'direct') {
        if (!n.directType) n.directType = 'text';
        if (!n.directData || typeof n.directData !== 'object') n.directData = {};
      }
      // A step that offers choices but does not wait cannot branch on them —
      // the commonest way to hand-write a dead flow, and `validateFlow` blocks
      // activation on it. Left as the author wrote it (never silently flipped):
      // turning the wait on would change what the flow DOES, and the author is
      // told about it by the finding instead.
    }
    if (n.type === 'action' && !Array.isArray(n.actions)) n.actions = [];
    if (n.type === 'condition' && !Array.isArray(n.rules)) n.rules = [];
    return n;
  });

  const ids = new Set(nodes.map(n => n.id));
  const edges = (Array.isArray(config.edges) ? config.edges : [])
    .filter(e => e && ids.has(e.from) && ids.has(e.to))
    .map(e => ({ from: e.from, to: e.to, fromHandle: e.fromHandle || 'default' }));

  autoLayout(nodes, edges);
  return { ...config, nodes, edges };
}

/**
 * Edges the author wrote that name a handle the node does not have.
 *
 * `validateFlow` cannot report these: it checks whether a handle is WIRED, and
 * an edge hanging off a handle that does not exist simply never matches one. It
 * is invisible there and invisible on the canvas too (the orphan is parked at
 * the card's bottom-right), which is precisely how `row:0` went unnoticed. So
 * it is surfaced here, naming the handles the node really has.
 */
function danglingHandles(config = {}) {
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = [];
  for (const e of edges) {
    const n = byId.get(e.from);
    if (!n) continue;
    const handle = e.fromHandle || 'default';
    const valid = expectedHandles(n);
    if (!valid.includes(handle)) {
      out.push({
        nodeId: n.id,
        handle,
        message: `Step "${n.title || n.id}" has no output called "${handle}", so that connection can never be followed.`,
        fix: valid.length
          ? `Use one of: ${valid.join(', ')}.`
          : 'This step has no outputs — it ends the flow.',
      });
    }
  }
  return out;
}

/* ── The tool description, generated ──────────────────────────────────────── */

/**
 * The `create_automation` description string, BUILT from the definitions above
 * rather than typed out beside them.
 *
 * ⚠ This is the whole point. The previous description was hand-written prose in
 * two transports, and it drifted from `nodeLayout`/`flowValidator` without
 * anything failing — a stale `row:N` produced a flow that saved cleanly and
 * arrived broken. Generating it means the day a handle changes, every word the
 * model reads changes with it, in both transports at once.
 */
function automationToolDescription() {
  const types = Object.entries(AUTHORABLE_TYPES).map(([k, v]) => `${k} (${v})`).join('; ');
  const triggers = Object.entries(TRIGGER_KINDS)
    .map(([k, v]) => `${k}${v.required ? ` — REQUIRES "${v.required}"` : ''}`).join('; ');
  const direct = Object.entries(DIRECT_TYPES)
    .map(([k, v]) => `${k}: directData{${v.fields.join(', ')}}${v.note ? ` — ${v.note}` : ''}`).join(' | ');
  const handles = describeHandles()
    .map(h => `${h.when} -> ${h.handles.map(x => `"${x}"`).join(', ')}`).join(' | ');

  return [
    'Build a WhatsApp automation flow (a chatbot) from a nodes/edges graph. Always lands as a DRAFT.',
    '',
    'CONFIG: { nodes:[...], edges:[{from, to, fromHandle}] }. Positions are assigned automatically — do NOT send x/y.',
    '',
    `NODE TYPES — ${types}.`,
    'Every node needs a unique "id" and a "title" (the label shown on the card).',
    '',
    `TRIGGER (exactly one, type:"trigger"): set triggerKind to one of — ${triggers}.`,
    '',
    'MESSAGE (type:"message"): either messageMode:"template" + templateId (an APPROVED template; works any time),',
    'or messageMode:"direct" + directType + directData (free-form; Meta only delivers this INSIDE the 24-hour window).',
    `directType shapes — ${direct}`,
    '',
    '⚠ waitForReply — set waitForReply:true on any step that ASKS something. Without it the flow sends the message and',
    'walks straight on, so the buttons/list options can never be branched on. A step that offers choices with the wait',
    'off is refused. Add waitTimeoutHours (default 24).',
    '',
    'PACING — trigger messageGapSeconds (0-60) = seconds between consecutive messages, counted from when the previous one',
    'reached WhatsApp. A message may set its own gapSeconds (0-120) to override that for itself alone; on the first message',
    'of a run it waits from the start of the run.',
    '',
    `⚠ fromHandle — the exact names, per step shape: ${handles}.`,
    '"nomatch" = they typed something instead of tapping; "replied" = the answer to a free-text question; "timeout" = no',
    'reply in time. A URL / call / copy-code button has NO handle: WhatsApp never reports those taps, so it cannot branch.',
    '',
    'ACTION (type:"action"): actions:[{kind, value}] — kinds: "Set Funnel Stage", "Set Lead Field" (also takes "field";',
    'use value "{{answer}}" to store what the customer just typed), "Add Tag", "Remove Tag", "Assign to BDA", "Send Email",',
    '"Append to Google Sheet", "Create Calendar Event".',
    '',
    'The flow is checked before it is written and REFUSED if it would be broken at runtime, naming each problem and its',
    'fix. Unfinished-but-working things come back as warnings[]. Draw the flow back to the user and get a yes before creating.',
  ].join('\n');
}

module.exports = {
  AUTHORABLE_TYPES, TRIGGER_KINDS, DIRECT_TYPES,
  HANDLE_EXAMPLES, describeHandles, automationToolDescription,
  autoLayout, estimateHeight, normalizeFlowConfig, danglingHandles,
};
