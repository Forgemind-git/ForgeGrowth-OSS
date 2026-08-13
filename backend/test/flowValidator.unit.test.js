const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateFlow, expectedHandles } = require('../src/services/flowValidator');

/**
 * ONE fixture, checked by BOTH sides.
 *
 * `flowValidator.expectedHandles` (backend) and `nodeLayout.outputHandlesOf`
 * (frontend) are an unavoidable mirror — the two ship as separate Docker images
 * so neither can import the other. If they drift, the canvas draws a handle the
 * engine cannot resolve, which is the exact class of bug this whole change
 * exists to remove. So the drift is asserted rather than hoped for.
 */
const FIXTURE = [
  { name: 'template with three quick replies, waiting',
    node: { id: 'a', type: 'message', messageMode: 'template', waitForReply: true,
      buttons: [{ type: 'QUICK_REPLY', text: 'One' }, { type: 'QUICK_REPLY', text: 'Two' }, { type: 'QUICK_REPLY', text: 'Three' }] } },
  { name: 'template mixing a URL button with quick replies',
    node: { id: 'b', type: 'message', messageMode: 'template', waitForReply: true,
      buttons: [{ type: 'URL', text: 'Pay' }, { type: 'QUICK_REPLY', text: 'Later' }] } },
  { name: 'template with no buttons, not waiting',
    node: { id: 'c', type: 'message', messageMode: 'template', buttons: [] } },
  { name: 'direct quick_reply, waiting',
    node: { id: 'd', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { buttons: [{ title: 'Yes' }, { title: 'No' }] } } },
  { name: 'direct list, one section with three rows',
    node: { id: 'e', type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
      directData: { sections: [{ title: 'S', rows: [{ title: 'r1' }, { title: 'r2' }, { title: 'r3' }] }] } } },
  { name: 'direct list across two sections',
    node: { id: 'f', type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
      directData: { sections: [{ rows: [{ title: 'a' }] }, { rows: [{ title: 'b' }, { title: 'c' }] }] } } },
  { name: 'plain text, not waiting',
    node: { id: 'g', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'hi' } } },
  { name: 'plain text, waiting for a free-text answer',
    node: { id: 'h', type: 'message', messageMode: 'direct', directType: 'text', waitForReply: true, directData: { body: 'name?' } } },
  { name: 'call to action', node: { id: 'i', type: 'message', messageMode: 'direct', directType: 'cta_url', directData: { url: 'https://x.com', button_text: 'Go', body: 'b' } } },
  { name: 'ask for location, waiting', node: { id: 'j', type: 'message', messageMode: 'direct', directType: 'location_request', waitForReply: true, directData: { body: 'where?' } } },
  { name: 'ask for location, not waiting', node: { id: 'k', type: 'message', messageMode: 'direct', directType: 'location_request', directData: { body: 'where?' } } },
  { name: 'sticker', node: { id: 'l', type: 'message', messageMode: 'direct', directType: 'sticker', directData: { mediaLibraryId: 3 } } },
  { name: 'condition', node: { id: 'm', type: 'condition' } },
  { name: 'handoff ends the flow', node: { id: 'p', type: 'handoff' } },
  { name: 'ai agent', node: { id: 'q', type: 'ai_agent' } },
  { name: 'delay', node: { id: 'r', type: 'delay' } },
];

test('backend and frontend agree on every node shape', async () => {
  const mod = await import(
    path.resolve(__dirname, '../../frontend/src/components/builder/nodeLayout.js')
  );
  let checked = 0;
  for (const { name, node } of FIXTURE) {
    const back = expectedHandles(node);
    const front = mod.outputHandlesOf(node);
    assert.deepStrictEqual(
      back, front,
      `handle drift on "${name}"\n  backend : ${JSON.stringify(back)}\n  frontend: ${JSON.stringify(front)}`
    );
    checked++;
  }
  assert.strictEqual(checked, FIXTURE.length);
});

test('a list branches per ROW, not per section', () => {
  // The UI has always promised one output per row while outputHandlesOf emitted
  // one per SECTION, so a one-section five-row menu could not branch at all.
  const node = FIXTURE.find(f => f.name === 'direct list, one section with three rows').node;
  assert.deepStrictEqual(expectedHandles(node).slice(0, 3), ['row:0:0', 'row:0:1', 'row:0:2']);
});

test('a URL button gets no handle, a quick reply keeps its ORIGINAL index', () => {
  const node = FIXTURE.find(f => f.name === 'template mixing a URL button with quick replies').node;
  const h = expectedHandles(node);
  assert.ok(!h.includes('btn:0'), 'the URL button must not be branchable');
  assert.ok(h.includes('btn:1'), 'the quick reply keeps index 1, matching the payload injector');
});

/**
 * The preview simulator's tap targets must be a SUBSET of the handles the
 * canvas can draw an edge to.
 *
 * This is the assertion the list defect needed. The simulator built its own
 * handle list inline and emitted `row:<section>` long after the canvas moved to
 * `row:<section>:<row>` — so tapping any option in a correctly wired menu
 * matched no edge and the run reported END OF FLOW. Nothing threw, because a
 * handle that matches no edge is indistinguishable from "the flow finished".
 * `tapTargetsOf` now derives from the same helpers `nodeRows` does; this keeps
 * it that way.
 */
test('every tappable option resolves to a handle the canvas can wire', async () => {
  const mod = await import(
    path.resolve(__dirname, '../../frontend/src/components/builder/nodeLayout.js')
  );
  let tappable = 0;
  for (const { name, node } of FIXTURE) {
    const wired = new Set(mod.outputHandlesOf(node));
    for (const t of mod.tapTargetsOf(node)) {
      assert.ok(typeof t.label === 'string' && t.label.length > 0, `unlabelled tap target on "${name}"`);
      if (t.handle === null) continue;          // shown, but WhatsApp reports no tap
      assert.ok(wired.has(t.handle), `"${name}" offers a tap on ${t.handle}, which no connector can be drawn to`);
      tappable++;
    }
  }
  assert.ok(tappable > 0, 'fixture must contain at least one tappable step');
});

test('a list offers one DISTINCT tap target per row, addressed per row', async () => {
  const mod = await import(
    path.resolve(__dirname, '../../frontend/src/components/builder/nodeLayout.js')
  );
  // One section, three rows: the shape that could not branch at all.
  const one = FIXTURE.find(f => f.name === 'direct list, one section with three rows').node;
  assert.deepStrictEqual(
    mod.tapTargetsOf(one).map(t => t.handle),
    ['row:0:0', 'row:0:1', 'row:0:2'],
    'per-section handles would collapse all three rows onto row:0'
  );
  // Across sections, the row index restarts — so a FLAT index is not the handle.
  const two = FIXTURE.find(f => f.name === 'direct list across two sections').node;
  const handles = mod.tapTargetsOf(two).map(t => t.handle);
  assert.deepStrictEqual(handles, ['row:0:0', 'row:1:0', 'row:1:1']);
  assert.strictEqual(new Set(handles).size, handles.length, 'two rows share a handle');
});

const flow = (nodes, edges) => ({ nodes, edges });
const codes = (r) => r.blocking.map(b => b.code);

test('a flow with no trigger cannot go live', () => {
  const r = validateFlow(flow([{ id: 'm', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'hi' } }], []));
  assert.ok(codes(r).includes('NO_TRIGGER'));
  assert.strictEqual(r.ok, false);
});

test('a second trigger is refused, because only the first ever fires', () => {
  const r = validateFlow(flow([
    { id: 't1', type: 'trigger', triggerKind: 'keyword', keyword: 'a' },
    { id: 't2', type: 'trigger', triggerKind: 'keyword', keyword: 'b' },
  ], []));
  assert.ok(codes(r).includes('MULTI_TRIGGER'));
});

// ⚠ THE LINE: a MISSING wire warns, a wire that can NEVER fire blocks.
// Half-built is how every flow starts, so an incomplete one must still be
// allowed to go live — refusing over it made Enable unreachable while building.
test('an unwired branch WARNS but does not block activation', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: 'pick', buttons: [{ title: 'Yes' }, { title: 'No' }] } },
  ], [{ from: 't', to: 'm' }]));
  const unwired = r.warnings.filter(b => b.code === 'UNWIRED_BRANCH');
  assert.strictEqual(unwired.length, 2);
  // The message must name the BUTTON, not the handle id.
  assert.ok(unwired[0].message.includes('Yes'), unwired[0].message);
  assert.strictEqual(r.blocking.filter(b => b.code === 'UNWIRED_BRANCH').length, 0);
  assert.ok(r.ok, 'an incomplete but sendable flow must be allowed to activate');
});

test('a missing fallback and a missing timeout only warn', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'text', waitForReply: true,
      directData: { body: 'what is your name?' } },
  ], [{ from: 't', to: 'm' }]));
  const w = r.warnings.map(x => x.code);
  assert.ok(w.includes('NO_FALLBACK'), JSON.stringify(w));
  assert.ok(w.includes('NO_TIMEOUT'), JSON.stringify(w));
  assert.strictEqual(r.blocking.length, 0);
  assert.ok(r.ok);
});

// The other half of the line: a step that Meta will REFUSE still blocks, so a
// flow can never go live sending a message that cannot be delivered.
test('an empty body on an interactive step still blocks', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: '', buttons: [{ title: 'Yes' }] } },
  ], [{ from: 't', to: 'm' }]));
  assert.ok(r.blocking.map(b => b.code).includes('META_BODY_REQUIRED'));
  assert.ok(!r.ok);
});

// Offering buttons and wiring NONE of them is merely unfinished. Wiring one and
// leaving the wait off is a connection that can never carry anything.
test('wait-off buttons warn when nothing is wired, block when something is', () => {
  const nodes = [
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply',
      directData: { body: 'pick', buttons: [{ title: 'Yes' }] } },
  ];
  const unwired = validateFlow(flow(nodes, [{ from: 't', to: 'm' }]));
  assert.ok(unwired.warnings.map(b => b.code).includes('NO_WAIT_ON_BRANCHING'));
  assert.ok(unwired.ok, 'unwired buttons with the wait off must not block');

  const wired = validateFlow(flow(nodes, [{ from: 't', to: 'm' }, { from: 'm', to: 'x', fromHandle: 'btn:0' }]));
  assert.ok(wired.blocking.map(b => b.code).includes('NO_WAIT_ON_BRANCHING'));
  assert.ok(!wired.ok, 'a wired branch that can never fire must block');
});

test('buttons with the wait off are refused — the branches could never fire', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply',
      directData: { body: 'pick', buttons: [{ title: 'Yes' }] } },
  ], [{ from: 't', to: 'm' }, { from: 'm', to: 'x', fromHandle: 'btn:0' }]));
  assert.ok(codes(r).includes('NO_WAIT_ON_BRANCHING'));
});

test('a branch off a link button is refused', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'template', templateId: 1, waitForReply: true,
      buttons: [{ type: 'URL', text: 'Pay now' }] },
  ], [{ from: 't', to: 'm' }, { from: 'm', to: 'z', fromHandle: 'btn:0' }]),
  { templatesById: { 1: { id: 1, name: 'T', status: 'APPROVED' } } });
  assert.ok(codes(r).includes('URL_BUTTON_BRANCH'));
});

test('Meta caps are enforced: 3 buttons, 20-char titles, 10 list rows total', () => {
  const many = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: 'x', buttons: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] } },
  ], [{ from: 't', to: 'm' }]));
  assert.ok(codes(many).includes('META_LIMIT_BUTTONS'));

  const long = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: 'x', buttons: [{ title: 'x'.repeat(21) }] } },
  ], [{ from: 't', to: 'm' }]));
  assert.ok(codes(long).includes('META_LIMIT_BUTTON_TITLE'));

  // 6 + 6 = 12 rows across two sections. The cap is TOTAL, not per section —
  // the limit people most often get wrong because it reads per-section.
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ title: `r${i}` }));
  const bigList = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
      directData: { body: 'x', sections: [{ rows: rows(6) }, { rows: rows(6) }] } },
  ], [{ from: 't', to: 'm' }]));
  assert.ok(codes(bigList).includes('META_LIMIT_LIST_ROWS'));
});

test('two buttons with the same label are refused', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: 'x', buttons: [{ title: 'Yes' }, { title: 'yes' }] } },
  ], [{ from: 't', to: 'm' }]));
  assert.ok(codes(r).includes('META_DUPLICATE_BUTTON'));
});

test('a nomatch pointing at its own step loops forever', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'text', waitForReply: true, directData: { body: 'q' } },
  ], [{ from: 't', to: 'm' }, { from: 'm', to: 'm', fromHandle: 'nomatch' }]));
  assert.ok(codes(r).includes('SELF_LOOP'));
});

test('a complete flow passes, and saving is never gated', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'quick_reply', waitForReply: true,
      directData: { body: 'Pick one', buttons: [{ title: 'Yes' }, { title: 'No' }] } },
    { id: 'y', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'great' } },
    { id: 'n', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'no worries' } },
    { id: 'f', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'sorry?' } },
    { id: 'w', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'still there?' } },
    { id: 'h', type: 'handoff' },
  ], [
    { from: 't', to: 'm' },
    { from: 'm', to: 'y', fromHandle: 'btn:0' },
    { from: 'm', to: 'n', fromHandle: 'btn:1' },
    { from: 'm', to: 'f', fromHandle: 'nomatch' },
    { from: 'm', to: 'w', fromHandle: 'timeout' },
    { from: 'y', to: 'h' },
  ]));
  assert.deepStrictEqual(codes(r), [], JSON.stringify(r.blocking, null, 2));
  assert.strictEqual(r.ok, true);
});

test('two edges on one handle warn but do not block', () => {
  const r = validateFlow(flow([
    { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
    { id: 'm', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'hi' } },
  ], [{ from: 't', to: 'm' }, { from: 'm', to: 'a' }, { from: 'm', to: 'b' }]));
  assert.ok(r.warnings.some(w => w.code === 'FANOUT_TRUNCATED'));
  assert.ok(!codes(r).includes('FANOUT_TRUNCATED'));
});
