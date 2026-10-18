// Unit tests for services/flowAuthoring.js — the module that lets something
// OTHER than the builder (today: the MCP create_automation tool) write a flow.
//
// The defect this module exists to prevent was live and silent: the tool
// description restated the handle vocabulary as "row:N" long after list handles
// became "row:<section>:<row>". A model followed the schema, the edge matched no
// handle, and `handlePos()` parked it as an orphan — indistinguishable on the
// canvas from a flow that simply ends there. Nothing threw. So the tests that
// matter here are the ones that go red if that documentation drifts again.
//
// No DB, no network.

const { test, describe } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const authoring = require('../src/services/flowAuthoring');
const { expectedHandles } = require('../src/services/flowValidator');

const PKG = path.join(__dirname, '..');
const REPO = path.join(PKG, '..');

/* ── the documentation is generated, not typed ───────────────────────────── */

describe('the tool description is derived from the validator', () => {
  test('it spells list handles the way the validator does', () => {
    const listNode = {
      id: 'x', type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
      directData: { body: '?', sections: [{ title: '', rows: [{ title: 'A' }, { title: 'B' }] }] },
    };
    // The real handles, straight from the authority.
    assert.deepStrictEqual(expectedHandles(listNode), ['row:0:0', 'row:0:1', 'nomatch', 'timeout']);

    const desc = authoring.automationToolDescription();
    assert.ok(desc.includes('row:0:0'), 'the generated description must carry the real per-row handle');
    assert.ok(desc.includes('row:0:1'), 'a two-row list must document BOTH rows, not one per section');
  });

  test('THE REGRESSION: the old per-section spelling cannot reappear', () => {
    const desc = authoring.automationToolDescription();
    // `row:N` as a standalone token is the pre-2026-08-12 form. Matching it
    // loosely would also hit `row:0:0`, so the pattern requires the token to END
    // after one number.
    assert.equal(/"row:\d+"/.test(desc), false,
      'the description documents a per-SECTION list handle; the canvas addresses rows individually');
    assert.equal(/row:N\b/.test(desc), false,
      'literal "row:N" is the stale spelling that shipped a broken vocabulary');
  });

  test('every documented handle really exists on its example node', () => {
    // The whole promise of describeHandles(): it cannot name a handle the
    // validator would not accept, because it asks the validator.
    for (const ex of authoring.HANDLE_EXAMPLES) {
      const real = expectedHandles(ex.node);
      assert.ok(real.length > 0, `${ex.when} produced no handles`);
      assert.deepStrictEqual(
        authoring.describeHandles().find(d => d.when === ex.when).handles, real);
    }
  });

  test('a waiting step with choices branches on nomatch, one without on replied', () => {
    // Guards the distinction that made "Ask a question" dead-end at END OF
    // FLOW: a step offering no choices has no wrong answer.
    const buttons = authoring.HANDLE_EXAMPLES.find(e => e.when.includes('buttons')).node;
    const freeText = authoring.HANDLE_EXAMPLES.find(e => e.when.includes('free text')).node;
    assert.ok(expectedHandles(buttons).includes('nomatch'));
    assert.ok(!expectedHandles(buttons).includes('replied'));
    assert.ok(expectedHandles(freeText).includes('replied'));
    assert.ok(!expectedHandles(freeText).includes('nomatch'));
  });
});

/* ── the policy list cannot offer a step that cannot run ─────────────────── */

describe('authorable node types', () => {
  test('every type offered has an engine handler', () => {
    // AUTHORABLE_TYPES is deliberately a POLICY list (narrower than the engine,
    // so MCP cannot add blocks a person no longer can). It must never drift the
    // OTHER way into offering a step the engine would fail on.
    const engine = fs.readFileSync(path.join(PKG, 'src', 'engine', 'automationEngine.js'), 'utf8');
    const block = engine.slice(engine.indexOf('const NODE_HANDLERS'));
    const handlers = [...block.slice(0, block.indexOf('};')).matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
    assert.ok(handlers.length > 5, `only found ${handlers.length} handlers — has NODE_HANDLERS moved?`);
    for (const t of Object.keys(authoring.AUTHORABLE_TYPES)) {
      assert.ok(handlers.includes(t), `"${t}" is offered to MCP authors but the engine cannot run it`);
    }
  });

  test('it does not offer the blocks removed from the library', () => {
    // ai / ai_agent / api / subflow / handoff still RUN (an imported flow may
    // contain one) but were taken out of the block library on purpose. Deriving
    // this list from NODE_HANDLERS would quietly hand them back.
    for (const gone of ['ai', 'ai_agent', 'api', 'subflow', 'handoff']) {
      assert.ok(!(gone in authoring.AUTHORABLE_TYPES),
        `"${gone}" was removed from the block library; MCP must not re-introduce it`);
    }
  });

  test('every trigger kind that flowValidator blocks on is documented as required', () => {
    // The validator refuses activation when these are blank. If the two lists
    // disagree, a model builds a trigger that can never fire and only finds out
    // at activation.
    const src = fs.readFileSync(path.join(PKG, 'src', 'services', 'flowValidator.js'), 'utf8');
    for (const [kind, def] of Object.entries(authoring.TRIGGER_KINDS)) {
      if (!def.required) continue;
      assert.ok(src.includes(`kind === '${kind}'`),
        `flowValidator does not check the "${kind}" trigger, so marking "${def.required}" required here is a guess`);
    }
  });
});

/* ── mirrors across the process boundary ─────────────────────────────────── */

describe('shapes mirror the builder', () => {
  const builderPath = path.join(REPO, 'frontend', 'src', 'components', 'AutomationBuilderView.jsx');
  const NO_FRONTEND = 'frontend/ not present in this checkout — parity not checked here';
  // Read as TEXT, never required: the builder is ESM/JSX and this suite runs
  // inside the backend image where the frontend may not exist at all.
  const builder = fs.existsSync(builderPath) ? fs.readFileSync(builderPath, 'utf8') : null;

  test('every directType offered exists in the builder', { skip: builder ? false : NO_FRONTEND }, () => {
    for (const dt of Object.keys(authoring.DIRECT_TYPES)) {
      assert.ok(new RegExp(`key\\s*:\\s*"${dt}"`).test(builder),
        `directType "${dt}" is offered to MCP authors but the builder has no such message type`);
    }
  });

  test('every action kind named in the description exists in the builder', { skip: builder ? false : NO_FRONTEND }, () => {
    const desc = authoring.automationToolDescription();
    const kinds = [...desc.matchAll(/"(Set Funnel Stage|Set Lead Field|Add Tag|Remove Tag|Assign to BDA|Send Email|Append to Google Sheet|Create Calendar Event)"/g)]
      .map(m => m[1]);
    assert.ok(kinds.length >= 6, 'the description stopped naming action kinds — this test would pass vacuously');
    for (const k of new Set(kinds)) {
      assert.ok(builder.includes(`kind:"${k}"`),
        `action kind "${k}" is documented for MCP but is not in the builder's ACTION_KINDS`);
    }
  });
});

/* ── normalisation and layout ────────────────────────────────────────────── */

describe('normalizeFlowConfig', () => {
  test('lays nodes out left-to-right by depth instead of stacking them', () => {
    // The other half of "the flow did not look proper": with no coordinates
    // every card rendered on top of the next.
    const cfg = authoring.normalizeFlowConfig({
      nodes: [{ id: 'a', type: 'trigger' }, { id: 'b', type: 'message' }, { id: 'c', type: 'action' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });
    const [a, b, c] = cfg.nodes;
    assert.ok(a.x < b.x && b.x < c.x, 'each step should sit in its own column');
    for (const n of cfg.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has no position`);
    }
  });

  test('two branches of one step get separate rows, not the same point', () => {
    const cfg = authoring.normalizeFlowConfig({
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'q', type: 'condition' },
        { id: 'y', type: 'message' },
        { id: 'n', type: 'message' },
      ],
      edges: [{ from: 't', to: 'q' }, { from: 'q', to: 'y', fromHandle: 'yes' }, { from: 'q', to: 'n', fromHandle: 'no' }],
    });
    const y = cfg.nodes.find(n => n.id === 'y');
    const n = cfg.nodes.find(x => x.id === 'n');
    assert.equal(y.x, n.x, 'both branches are one step deep, so they share a column');
    assert.notEqual(y.y, n.y, 'they must not be drawn on top of each other');
  });

  test('a position the author set is kept', () => {
    const cfg = authoring.normalizeFlowConfig({
      nodes: [{ id: 'a', type: 'trigger', x: 999, y: 777 }, { id: 'b', type: 'message' }],
      edges: [{ from: 'a', to: 'b' }],
    });
    assert.equal(cfg.nodes[0].x, 999);
    assert.equal(cfg.nodes[0].y, 777);
  });

  test('it never invents message content', () => {
    // Filling in a missing body would produce a flow that passes the gate and
    // then sends a customer something nobody wrote.
    const cfg = authoring.normalizeFlowConfig({
      nodes: [{ id: 'a', type: 'message', messageMode: 'direct', directType: 'text' }], edges: [],
    });
    assert.deepStrictEqual(cfg.nodes[0].directData, {});
  });

  test('it does not silently turn the reply wait on', () => {
    // Flipping it would change what the flow DOES. The author is told by the
    // finding instead.
    const cfg = authoring.normalizeFlowConfig({
      nodes: [{ id: 'a', type: 'message', messageMode: 'direct', directType: 'quick_reply',
                directData: { body: 'hi', buttons: [{ title: 'Yes' }] } }],
      edges: [],
    });
    assert.notEqual(cfg.nodes[0].waitForReply, true);
  });

  test('an edge pointing at a node that does not exist is dropped', () => {
    const cfg = authoring.normalizeFlowConfig({
      nodes: [{ id: 'a', type: 'trigger' }],
      edges: [{ from: 'a', to: 'ghost' }],
    });
    assert.deepStrictEqual(cfg.edges, []);
  });
});

/* ── the check that catches the original bug ─────────────────────────────── */

describe('danglingHandles', () => {
  const listFlow = (handle) => ({
    nodes: [
      { id: 't', type: 'trigger', triggerKind: 'keyword', keyword: 'hi' },
      { id: 'm', type: 'message', title: 'Menu', messageMode: 'direct', directType: 'list', waitForReply: true,
        directData: { body: 'Pick one', sections: [{ title: '', rows: [{ title: 'A' }, { title: 'B' }] }] } },
      { id: 'z', type: 'message', messageMode: 'direct', directType: 'text', directData: { body: 'ok' } },
    ],
    edges: [{ from: 't', to: 'm' }, { from: 'm', to: 'z', fromHandle: handle }],
  });

  test('the exact bug: row:0 is reported, and the real handles are named', () => {
    const found = authoring.danglingHandles(listFlow('row:0'));
    assert.equal(found.length, 1);
    assert.equal(found[0].handle, 'row:0');
    assert.match(found[0].fix, /row:0:0/);
    assert.match(found[0].fix, /row:0:1/);
  });

  test('the correct spelling is not reported', () => {
    assert.deepStrictEqual(authoring.danglingHandles(listFlow('row:0:1')), []);
  });

  test('validateFlow alone would NOT have caught it', () => {
    // Why this check exists at all: validateFlow asks whether a handle is
    // WIRED. An edge hanging off a handle that does not exist matches no
    // handle, so it is invisible there — and invisible on the canvas too.
    const { validateFlow } = require('../src/services/flowValidator');
    const result = validateFlow(listFlow('row:0'));
    assert.equal(result.blocking.some(b => String(b.message).includes('row:0')), false,
      'if validateFlow ever does report this, danglingHandles can be simplified');
  });

  test('a step with no outputs says so rather than naming none', () => {
    const found = authoring.danglingHandles({
      nodes: [{ id: 'h', type: 'handoff', title: 'To a person' }, { id: 'z', type: 'message' }],
      edges: [{ from: 'h', to: 'z', fromHandle: 'default' }],
    });
    assert.equal(found.length, 1);
    assert.match(found[0].fix, /no outputs/);
  });
});

// A looping flow is ORDINARY (a menu that re-asks itself on `nomatch`), and
// autoLayout's longest-path relaxation used to spin forever on one. Because
// normalizeFlowConfig runs synchronously on the Express event loop, that took
// the whole backend down for 27h on 2026-08-13 — no crash, so Docker never
// restarted it. These must stay fast; a regression here HANGS `npm test`.
describe('normalizeFlowConfig — cyclic flows terminate', () => {
  // ⚠ TWO separate traps live in this suite, and both are about a test that
  // does not test what it looks like it tests.
  //
  // 1. `test`, not `it`. This file imports only { test, describe }, so these
  //    cases were `it is not defined` and the suite errored at LOAD rather than
  //    running — while the file summary still read "19 pass / 0 fail". The
  //    per-suite result and the file summary disagreed, which is exactly how it
  //    went unnoticed for as long as it did.
  //
  // 2. ⚠ `{ timeout: N }` DOES NOT SAVE YOU HERE, so do not rely on it. The
  //    runner races an ASYNC timer against the test body; this body is
  //    SYNCHRONOUS, so an unbounded relaxation never yields to the event loop,
  //    the timer never fires, and the run hangs until something outside kills
  //    it. Measured: with autoLayout's depth bound removed, this suite marked
  //    `{ timeout: 2000 }` ran for the full 60s outer limit and produced no TAP
  //    output at all. A process, unlike a promise, CAN be killed from outside —
  //    so every cyclic layout below runs in a child and the parent enforces the
  //    deadline.
  const layout = (nodes, edges, ms = 5000) => {
    const mod = JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'flowAuthoring'));
    const script =
      `const a=require(${mod});` +
      `process.stdout.write(JSON.stringify(a.normalizeFlowConfig(` +
      `{nodes:${JSON.stringify(nodes)},edges:${JSON.stringify(edges)}})));`;
    const r = spawnSync(process.execPath, ['-e', script], { timeout: ms, encoding: 'utf8' });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      assert.fail(
        `normalizeFlowConfig did not terminate within ${ms}ms on a cyclic flow. ` +
        `autoLayout's depth bound is gone — see anti-pattern #68: this runs synchronously on the ` +
        `Express event loop, so it takes the whole backend down with no crash and no restart.`
      );
    }
    assert.equal(r.status, 0, `layout child exited ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  test('terminates on a self-loop', () => {
    const cfg = layout(
      [{ id: 't', type: 'trigger' }, { id: 'a', type: 'message' }],
      [{ from: 't', to: 'a' }, { from: 'a', to: 'a', fromHandle: 'nomatch' }],
    );
    assert.equal(cfg.nodes.length, 2);
    cfg.nodes.forEach(n => {
      assert.ok(Number.isFinite(n.x), `${n.id} has no x`);
      assert.ok(Number.isFinite(n.y), `${n.id} has no y`);
    });
  });

  test('terminates on a multi-node cycle back to the trigger', () => {
    const cfg = layout(
      ['t', 'a', 'b', 'c'].map(id => ({ id, type: id === 't' ? 'trigger' : 'message' })),
      [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 't' }],
    );
    assert.equal(cfg.nodes.length, 4);
  });

  test('still honours coordinates the caller pinned, even through a cycle', () => {
    const cfg = layout(
      [{ id: 't', type: 'trigger', x: 999, y: 888 }, { id: 'a', type: 'message' }],
      [{ from: 't', to: 'a' }, { from: 'a', to: 't' }],
    );
    const t = cfg.nodes.find(n => n.id === 't');
    assert.equal(t.x, 999);
    assert.equal(t.y, 888);
  });
});
