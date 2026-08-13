import { describe, it, expect } from 'vitest';
import {
  NODE_W,
  nodeH,
  nodeLayout,
  nodeRows,
  outputHandlesOf,
  tapTargetsOf,
  handlePos,
  inputCY,
  layoutTree,
  makeNode,
  edgePath,
} from '../AutomationBuilderView.jsx';

// ⚠ These tests deliberately assert RELATIONSHIPS, not pixel constants.
//
// The previous version hardcoded every height (96 for a trigger, 118 for a
// condition, ...). The 2026-08-12 type scale moved all of them at once, so
// twenty-two tests failed together and none of them named a real defect — the
// geometry was fine, the expectations were a copy of it. A budget in
// builder/nodeLayout.js is allowed to change; what must not change is that a
// card is tall enough for the rows it draws and that a handle lands on its own
// row. That is what is pinned here.

const qr = (text) => ({ type: 'QUICK_REPLY', text });

describe('nodeH', () => {
  it('never returns less than the 96px floor', () => {
    for (const type of ['trigger', 'delay', 'condition', 'message', 'action', 'handoff']) {
      expect(nodeH({ type })).toBeGreaterThanOrEqual(96);
    }
  });

  it('is tall enough to contain every row it lays out', () => {
    const n = { type: 'message', waitForReply: true, buttons: [qr('A'), qr('B')] };
    const { height, rows } = nodeLayout(n);
    const lastRowBottom = Math.max(...rows.map(r => r.top + r.h));
    expect(height).toBeGreaterThanOrEqual(lastRowBottom);
  });

  it('grows with the number of actions on an action node', () => {
    const none = nodeH({ type: 'action', actions: [] });
    const two = nodeH({ type: 'action', actions: [{}, {}] });
    const ten = nodeH({ type: 'action', actions: new Array(10).fill({}) });
    expect(two).toBeGreaterThan(none);
    expect(ten).toBeGreaterThan(two);
  });

  it('gives a message step more height than a bare trigger — it draws a bubble', () => {
    expect(nodeH({ type: 'message' })).toBeGreaterThan(nodeH({ type: 'trigger' }));
  });

  it('counts the extra "via <number>" header line', () => {
    const plain = nodeH({ type: 'message' });
    const via = nodeH({ type: 'message', whatsappAccountId: 7 });
    expect(via).toBeGreaterThan(plain);
  });
});

describe('outputHandlesOf', () => {
  it('returns ["default"] for a plain step', () => {
    for (const type of ['trigger', 'action', 'delay', 'api', 'unknown']) {
      expect(outputHandlesOf({ type })).toEqual(['default']);
    }
  });

  it('returns ["yes","no"] for condition', () => {
    expect(outputHandlesOf({ type: 'condition' })).toEqual(['yes', 'no']);
  });

  it('returns no handles at all for handoff — it ends the flow', () => {
    expect(outputHandlesOf({ type: 'handoff' })).toEqual([]);
  });

  it('returns ["default"] for a message with no buttons', () => {
    expect(outputHandlesOf({ type: 'message' })).toEqual(['default']);
    expect(outputHandlesOf({ type: 'message', buttons: [] })).toEqual(['default']);
  });

  it('addresses reply buttons per button, and still offers a continue path when not waiting', () => {
    // Buttons with the wait OFF can never fire, so `default` must remain or the
    // step silently dead-ends.
    expect(outputHandlesOf({ type: 'message', buttons: [qr('A'), qr('B')] }))
      .toEqual(['btn:0', 'btn:1', 'default']);
  });

  it('swaps the continue path for nomatch/timeout once the step waits', () => {
    expect(outputHandlesOf({ type: 'message', waitForReply: true, buttons: [qr('A'), qr('B')] }))
      .toEqual(['btn:0', 'btn:1', 'nomatch', 'timeout']);
  });

  it('offers "replied", not "nomatch", when a waiting step gives no choices', () => {
    // A question with no options has no wrong answer — whatever they send IS
    // the answer. Offering only `nomatch` is what made an Ask step dead-end.
    expect(outputHandlesOf({ type: 'message', waitForReply: true }))
      .toEqual(['replied', 'timeout']);
  });

  it('addresses list options per ROW, not per section', () => {
    const n = {
      type: 'message', messageMode: 'direct', directType: 'list',
      directData: { sections: [{ rows: [{ title: 'One' }, { title: 'Two' }] }] },
    };
    expect(outputHandlesOf(n)).toEqual(['row:0:0', 'row:0:1', 'default']);
  });

  it('gives a non-quick-reply button no handle — WhatsApp reports no tap', () => {
    const n = { type: 'message', buttons: [{ type: 'URL', text: 'Open' }, qr('Yes')] };
    expect(outputHandlesOf(n)).toEqual(['btn:1', 'default']);
  });
});

describe('the derived-authority invariant', () => {
  // nodeRows() is the single source of truth; the handle list and the handle
  // positions are derived from it. A handle that cannot be rendered must not
  // exist, and a rendered row must have a reachable handle.
  const samples = [
    { type: 'trigger' },
    { type: 'condition' },
    { type: 'action', actions: [{}] },
    { type: 'message' },
    { type: 'message', waitForReply: true, buttons: [qr('A'), qr('B')] },
    {
      type: 'message', messageMode: 'direct', directType: 'list', waitForReply: true,
      directData: { sections: [{ rows: [{ title: 'One' }, { title: 'Two' }] }] },
    },
    {
      type: 'message', messageMode: 'direct', directType: 'location_request',
      waitForReply: true, directData: {},
    },
  ];

  it('every rendered row with a handle appears in outputHandlesOf', () => {
    for (const n of samples) {
      const rendered = nodeRows(n).map(r => r.handle).filter(Boolean);
      expect(outputHandlesOf(n)).toEqual(rendered);
    }
  });

  it('every tap target that carries a handle is a real output handle', () => {
    for (const n of samples) {
      const handles = new Set(outputHandlesOf(n));
      for (const t of tapTargetsOf(n)) {
        if (t.handle) expect(handles.has(t.handle)).toBe(true);
      }
    }
  });

  it('every handle resolves to its own row centre, never the orphan pile', () => {
    for (const n of samples) {
      const node = { ...n, x: 0, y: 0 };
      const { rows, height } = nodeLayout(node);
      for (const r of rows.filter(r => r.handle)) {
        expect(handlePos(node, 'output', r.handle)).toEqual({ x: NODE_W, y: r.cy });
        expect(r.cy).not.toBe(height);
      }
    }
  });
});

describe('handlePos', () => {
  // LEFT IN, RIGHT OUT — the canvas reads left-to-right since 2026-08-12.
  it('puts the input on the LEFT edge at the card’s vertical middle', () => {
    const n = { type: 'trigger', x: 100, y: 50 };
    expect(handlePos(n, 'input')).toEqual({ x: 100, y: 50 + inputCY(n) });
    expect(inputCY(n)).toBeCloseTo(nodeH(n) / 2, 5);
  });

  it('puts every output on the RIGHT edge', () => {
    const n = { type: 'condition', x: 100, y: 50 };
    expect(handlePos(n, 'output', 'yes').x).toBe(100 + NODE_W);
    expect(handlePos(n, 'output', 'no').x).toBe(100 + NODE_W);
  });

  it('orders condition branches top-to-bottom: matched above not-matched', () => {
    const n = { type: 'condition', x: 0, y: 0 };
    expect(handlePos(n, 'output', 'yes').y).toBeLessThan(handlePos(n, 'output', 'no').y);
  });

  it('stacks button handles down the right edge in button order', () => {
    const n = { type: 'message', x: 0, y: 0, waitForReply: true, buttons: [qr('A'), qr('B'), qr('C')] };
    const ys = ['btn:0', 'btn:1', 'btn:2'].map(h => handlePos(n, 'output', h).y);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    // Evenly pitched — one row height apart, so no two dots collide.
    expect(ys[1] - ys[0]).toBeCloseTo(ys[2] - ys[1], 5);
  });

  it('parks an orphaned handle at the bottom-right so its edge stays deletable', () => {
    const n = { type: 'delay', x: 100, y: 50 };
    expect(handlePos(n, 'output', 'a-button-that-was-deleted'))
      .toEqual({ x: 100 + NODE_W, y: 50 + nodeH(n) });
  });

  it('lands a legacy per-section list handle on that section’s first row', () => {
    const n = {
      type: 'message', x: 0, y: 0, messageMode: 'direct', directType: 'list',
      directData: { sections: [{ rows: [{ title: 'One' }, { title: 'Two' }] }] },
    };
    expect(handlePos(n, 'output', 'row:0')).toEqual(handlePos(n, 'output', 'row:0:0'));
  });
});

describe('makeNode', () => {
  it('creates trigger node with defaults', () => {
    const n = makeNode('trigger', 10, 20, 'n99', []);
    expect(n.type).toBe('trigger');
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
    expect(n.id).toBe('n99');
    expect(n.triggerKind).toBe('keyword');
    expect(n.keyword).toBe('');
  });

  it('creates message node with empty templateId', () => {
    const n = makeNode('message', 0, 0, 'n1', []);
    expect(n.type).toBe('message');
    expect(n.templateId).toBe('');
    expect(n.bindings).toEqual({});
    expect(n.messageMode).toBe('template');
  });

  it('creates condition node with empty rules', () => {
    const n = makeNode('condition', 0, 0, 'n1', []);
    expect(n.matchMode).toBe('all');
    expect(n.rules).toEqual([]);
  });

  it('creates action node with empty actions', () => {
    expect(makeNode('action', 0, 0, 'n1', []).actions).toEqual([]);
  });

  it('creates delay node with default duration', () => {
    const n = makeNode('delay', 0, 0, 'n1', []);
    expect(n.delayMode).toBe('duration');
    expect(n.waitValue).toBe('10');
    expect(n.waitUnit).toBe('minutes');
  });

  it('creates api node with POST default', () => {
    const n = makeNode('api', 0, 0, 'n1', []);
    expect(n.method).toBe('POST');
    // An ARRAY of { k, v } rows, not an object — that is what the header editor
    // renders and what automationEngine's API node reads back.
    expect(n.headers).toEqual([]);
  });

  it('creates subflow node with defaults', () => {
    const n = makeNode('subflow', 0, 0, 'n1', []);
    expect(n.flowId).toBe('');
    expect(n.waitMode).toBe('await');
  });

  it('no longer seeds a Human Handoff node — the block was retired', () => {
    // The type is still RENDERED (saved flows contain it) but it is not
    // creatable, so it has no field defaults. The in-flow block went on
    // 2026-08-12; the Chats-side takeover is untouched.
    const n = makeNode('handoff', 0, 0, 'n1', []);
    expect(n.type).toBe('handoff');
    expect(n.assignMode).toBeUndefined();
  });

  it('handles unknown type gracefully', () => {
    const n = makeNode('unknown', 5, 10, 'nX', []);
    expect(n.type).toBe('unknown');
    expect(n.x).toBe(5);
    expect(n.y).toBe(10);
  });
});

describe('layoutTree', () => {
  it('places a single root node', () => {
    const result = layoutTree([{ id: 'n1', type: 'trigger' }], []);
    expect(result[0].x).toBe(120);
    expect(result[0].y).toBe(60);
  });

  it('places a child to the RIGHT of its parent, one column over', () => {
    const nodes = [{ id: 'n1', type: 'trigger' }, { id: 'n2', type: 'message' }];
    const result = layoutTree(nodes, [{ from: 'n1', to: 'n2' }]);
    const root = result.find(n => n.id === 'n1');
    const child = result.find(n => n.id === 'n2');
    expect(child.x).toBeGreaterThan(root.x + NODE_W);
  });

  it('stacks two siblings in one column, at different heights', () => {
    const nodes = [
      { id: 'n1', type: 'trigger' },
      { id: 'n2', type: 'message' },
      { id: 'n3', type: 'message' },
    ];
    const result = layoutTree(nodes, [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n3' }]);
    const n2 = result.find(n => n.id === 'n2');
    const n3 = result.find(n => n.id === 'n3');
    expect(n2.x).toBe(n3.x);
    expect(n2.y).not.toBe(n3.y);
  });

  it('does not treat a node with an inbound edge as a root', () => {
    const nodes = [{ id: 'n1', type: 'trigger' }, { id: 'n2', type: 'message' }];
    const result = layoutTree(nodes, [{ from: 'n1', to: 'n2' }]);
    expect(result.find(n => n.id === 'n2').x)
      .toBeGreaterThan(result.find(n => n.id === 'n1').x);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const nodes = [{ id: 'n1', type: 'trigger' }, { id: 'n2', type: 'message' }];
    const result = layoutTree(nodes, [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }]);
    expect(result).toHaveLength(2);
  });

  it('handles empty nodes array', () => {
    expect(layoutTree([], [])).toEqual([]);
  });

  it('gives a second unconnected trigger its own band below the first', () => {
    const result = layoutTree([{ id: 'n1', type: 'trigger' }, { id: 'n2', type: 'trigger' }], []);
    expect(result[0].x).toBe(result[1].x);
    expect(result[1].y).toBeGreaterThan(result[0].y);
  });

  it('returns new objects rather than mutating React state in place', () => {
    const nodes = [{ id: 'n1', type: 'trigger' }];
    const result = layoutTree(nodes, []);
    expect(result[0]).not.toBe(nodes[0]);
    expect(nodes[0].x).toBeUndefined();
  });
});

describe('edgePath', () => {
  it('starts at the source and ends at the target', () => {
    const path = edgePath(0, 0, 400, 200);
    expect(path.startsWith('M 0 0')).toBe(true);
    expect(path).toContain('400 200');
  });

  it('draws a straight line when source and target share a row', () => {
    expect(edgePath(0, 100, 400, 100)).toBe('M 0 100 L 400 100');
  });

  it('routes a forward edge through an orthogonal lane with rounded corners', () => {
    const path = edgePath(0, 0, 400, 200);
    expect(path).toContain('Q');      // corner radius
    expect(path).toContain('L');      // the vertical lane
  });

  it('bows a backward edge clear of both cards instead of using a lane', () => {
    // A lane between the cards would land inside one of them.
    const back = edgePath(400, 0, 0, 100);
    expect(back).toContain('C');
    expect(back).not.toContain('Q');
  });

  it('offsets each lane so sibling branches do not overlap', () => {
    expect(edgePath(0, 0, 400, 200, 0)).not.toBe(edgePath(0, 0, 400, 200, 1));
  });
});
