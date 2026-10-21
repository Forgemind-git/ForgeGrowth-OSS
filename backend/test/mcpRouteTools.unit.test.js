// The tools declared as data (src/services/mcpRouteTools.js). No DB, no network.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { z } = require('zod');
const { ROUTE_TOOLS, buildInputSchema } = require('../src/services/mcpRouteTools');
const { buildCall, SERVICES } = require('../src/services/mcpRouteToolRunner');
const mcpService = require('fs').readFileSync(require('path').join(__dirname, '../src/services/mcpService.js'), 'utf8');

// mcpService is read as TEXT: requiring it pulls in the BullMQ send queue,
// whose Redis handle keeps the event loop alive and hangs `npm test`.
function resolveArea(path) {
  const src = mcpService.slice(mcpService.indexOf('const PROXY_AREAS = ['));
  const block = src.slice(0, src.indexOf('\n];') + 2);
  const areas = eval(block.replace('const PROXY_AREAS =', '(') + ')');
  return areas.find(a => a.test.test(path))?.cap || null;
}

describe('every shared tool is well-formed', () => {
  test('names are unique snake_case', () => {
    const names = ROUTE_TOOLS.map(t => t.name);
    assert.strictEqual(new Set(names).size, names.length);
    for (const n of names) assert.match(n, /^[a-z][a-z_]+$/);
  });

  test('each tool has exactly one implementation, and a service one exists', () => {
    for (const t of ROUTE_TOOLS) {
      assert.ok(!!t.route !== !!t.service, `${t.name} needs exactly one of route / service`);
      if (t.service) assert.ok(SERVICES[t.service], `${t.name} → missing service ${t.service}`);
    }
  });

  test('every path placeholder is a required param', () => {
    for (const t of ROUTE_TOOLS.filter(x => x.route)) {
      for (const [, k] of t.route.path.matchAll(/\{([a-zA-Z_]+)\}/g)) {
        assert.ok(t.params[k]?.required, `${t.name}: {${k}} must be a required param`);
      }
    }
  });

  test('every schema builds', () => {
    for (const t of ROUTE_TOOLS) z.object(buildInputSchema(z, t.params));
  });

  test('a required param is required, an optional one accepts null', () => {
    const s = z.object(buildInputSchema(z, { id: { type: 'id', required: true }, q: { type: 'string' } }));
    assert.ok(!s.safeParse({}).success);
    assert.ok(s.safeParse({ id: 3, q: null }).success);
  });
});

describe('buildCall', () => {
  const spec = (name) => ROUTE_TOOLS.find(t => t.name === name);

  test('fills and encodes path placeholders', () => {
    const c = buildCall(spec('social_update_agent_tool'), { id: 4, toolId: 'a/b', changes: { x: 1 } });
    assert.strictEqual(c.path, '/social/agents/4/tools/a%2Fb');
    assert.deepStrictEqual(c.body, { x: 1 });
  });

  test('a missing placeholder is refused, never sent as "undefined"', () => {
    assert.throws(() => buildCall(spec('get_lead'), {}), /id is required/);
  });

  test('only listed query keys are sent', () => {
    const c = buildCall(spec('get_funnel_chart'), { source: 'ig', bogus: 'x', from: null });
    assert.deepStrictEqual(c.query, { source: 'ig' });
  });

  test('a body "from" arg must be an object', () => {
    assert.throws(() => buildCall(spec('social_create_flow'), { flow: [1] }), /must be an object/);
  });

  test('rename sends only the label', () => {
    const c = buildCall(spec('rename_wa_number'), { id: 2, label: 'Sales desk', other: 1 });
    assert.deepStrictEqual(c, { method: 'PUT', path: '/whatsapp-accounts/2/label', query: undefined, body: { label: 'Sales desk' } });
  });
});

describe('nothing here reaches a credential or moves money', () => {
  test('no route tool points at an admin-only API area', () => {
    for (const t of ROUTE_TOOLS.filter(x => x.route)) {
      const path = t.route.path.replace(/\{[^}]+\}/g, '1');
      if (t.name === 'rename_wa_number') continue; // display label only, gated by its own category
      if (['get_conversion_api_status', 'list_conversion_events'].includes(t.name)) {
        assert.strictEqual(t.route.method, 'GET', `${t.name} must stay read-only`);
        continue;
      }
      assert.notStrictEqual(resolveArea(path), 'area_admin', `${t.name} reaches ${path}, an admin-tier path`);
    }
  });

  test('Social credentials and settings resolve to the admin area, not Social', () => {
    assert.strictEqual(resolveArea('/social/credentials'), 'area_admin');
    assert.strictEqual(resolveArea('/social/mcp/keys'), 'area_admin');
    assert.strictEqual(resolveArea('/social/settings'), 'area_admin');
    assert.strictEqual(resolveArea('/social/agents/3'), 'area_social');
    assert.strictEqual(resolveArea('/social/ig-automations/flows'), 'area_social');
  });

  test('no shared tool writes to payments, capi or payment requests', () => {
    for (const t of ROUTE_TOOLS.filter(x => x.route && x.route.method !== 'GET')) {
      assert.doesNotMatch(t.route.path, /^\/(capi|payment-requests|razorpay|marketing\/clo)/, t.name);
    }
  });
});
