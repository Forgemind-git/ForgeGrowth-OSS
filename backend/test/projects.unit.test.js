// Unit tests for Projects — the campaign folder a template / automation /
// agent / follow-up / form is filed under. No DB, no network.
//
// The theme here is MIRRORS. A project's kinds are described in places that
// must agree — the route's KINDS map (the authority), the MCP tool schemas in
// BOTH transports, and the Projects page's render list — and none of them
// errors when it falls behind. A kind missing from a tool schema is rejected
// by zod before anyone sees a useful message; a kind missing from the page
// silently has no UI while the backend happily counts it. So parity is
// asserted, not assumed.
//
// ⚠ This file deliberately does NOT require services/mcpService. That module
// pulls in the BullMQ send queue, whose Redis connection keeps the event loop
// alive forever — requiring it here would hang `npm test` for the whole repo,
// not just this file. Where a fact about mcpService matters, it is read as
// TEXT (same technique as mcpCatalog.unit.test.js uses for the transports).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { KINDS, parseAssignArgs } = require('../src/routes/projects');
const catalog = require('../src/services/mcpCatalog');

const ROUTE_KINDS = Object.keys(KINDS).sort();
const PKG = path.join(__dirname, '..');
const REPO = path.join(PKG, '..');

function readIfPresent(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

describe('project kinds stay in step across their mirrors', () => {
  test('forms are a kind, backed by lead_forms', () => {
    assert.ok(ROUTE_KINDS.includes('form'));
    assert.strictEqual(KINDS.form.table, 'lead_forms');
  });

  test('every kind declares what the UI and the delete refusal need', () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
      assert.ok(spec.countKey, `${kind} has no countKey — its card badge would read undefined`);
      assert.ok(spec.noun && spec.plural, `${kind} has no noun/plural for the delete refusal`);
    }
    const keys = Object.values(KINDS).map(k => k.countKey);
    assert.strictEqual(new Set(keys).size, keys.length, 'two kinds share a countKey');
  });

  // Both transports declare the kinds as a zod enum. A kind absent there cannot
  // be moved over MCP at all, however correct the backend is.
  for (const [label, rel] of [
    ['HTTP', ['src', 'mcpHttp.js']],
    ['stdio', ['..', 'mcp-server', 'src', 'index.js']],
  ]) {
    test(`the move_to_project schema over ${label} offers every kind`, (t) => {
      const src = readIfPresent(path.join(PKG, ...rel));
      // The stdio server lives outside the backend package, so it is absent
      // inside the backend Docker image where this suite normally runs. A
      // missing file is not evidence of drift — and a check that goes red for
      // environmental reasons gets muted, which is the same as no check.
      if (src == null) return t.skip(`${rel.join('/')} not present in this checkout`);
      const m = src.match(/kind:\s*z\.enum\(\[([^\]]+)\]\)/);
      assert.ok(m, `no move_to_project kind enum found in the ${label} transport`);
      const enumKinds = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]).sort();
      assert.deepStrictEqual(enumKinds, ROUTE_KINDS);
    });
  }

  test('the Projects page renders every kind, under the key the API returns', (t) => {
    const src = readIfPresent(path.join(REPO, 'frontend', 'src', 'pages', 'ProjectsPage.jsx'));
    if (src == null) return t.skip('frontend/ not present in this checkout');
    const rows = [...src.matchAll(/\{\s*kind:\s*'([a-z]+)',\s*key:\s*'([a-z]+)'/g)];
    assert.deepStrictEqual(rows.map(r => r[1]).sort(), ROUTE_KINDS);
    // Wrong count key = a badge stuck on 0 while the card below lists real items.
    assert.deepStrictEqual(rows.map(r => r[2]).sort(),
      Object.values(KINDS).map(k => k.countKey).sort());
  });
});

describe('parseAssignArgs — the one guard both doors run', () => {
  const rejects = (args, re) => assert.throws(() => parseAssignArgs(args), (err) => {
    assert.match(err.message, re);
    assert.strictEqual(err.status, 400);
    return true;
  });

  test('an unknown kind is named back with the valid ones', () =>
    rejects({ kind: 'campaign', ids: [1] }, /kind must be one of:.*form/));

  test('a missing kind is refused rather than defaulted', () =>
    rejects({ ids: [1] }, /kind must be one of/));

  test('no ids is refused, naming what was expected', () =>
    rejects({ kind: 'form', ids: [] }, /at least one form/));

  test('ids that are not numbers do not become a silent no-op move', () =>
    rejects({ kind: 'form', ids: ['abc'] }, /at least one form/));

  // Coercing this to null would quietly UNFILE everything the caller meant to
  // file — the opposite of the request, reported as success.
  test('a non-numeric projectId is refused, never treated as "unfile"', () =>
    rejects({ kind: 'form', ids: [1], projectId: 'launch campaign' }, /projectId must be a project id/));

  test('numeric strings from a JSON client are accepted', () =>
    assert.deepStrictEqual(parseAssignArgs({ kind: 'form', ids: ['7', 8], projectId: '3' }),
      { kind: 'form', ids: [7, 8], projectId: 3 }));

  test('duplicate ids are collapsed', () =>
    assert.deepStrictEqual(parseAssignArgs({ kind: 'form', ids: [5, 5, 5], projectId: 1 }).ids, [5]));

  test('a bare id is accepted as well as an array', () =>
    assert.deepStrictEqual(parseAssignArgs({ kind: 'form', ids: 4, projectId: 1 }).ids, [4]));

  // All three spellings of "no project" must land on the same normalised null,
  // or one of them reaches Postgres as NaN.
  for (const [label, v] of [['null', null], ['omitted', undefined], ['empty string', '']]) {
    test(`projectId ${label} means unfile`, () =>
      assert.strictEqual(parseAssignArgs({ kind: 'form', ids: [1], projectId: v }).projectId, null));
  }
});

describe('the MCP gate covers the new tools', () => {
  test('both project tools sit in the projects category', () => {
    assert.deepStrictEqual(catalog.toolsInCategory('projects'), ['list_projects', 'move_to_project']);
  });

  // Default-deny: a category absent from stored settings must read as off, so
  // a category introduced by a deploy is never live until an admin enables it.
  test('they are refused when the category is off, unset, or a truthy string', () => {
    for (const name of ['list_projects', 'move_to_project']) {
      assert.strictEqual(catalog.isToolAllowed(name, {}), false);
      assert.strictEqual(catalog.isToolAllowed(name, { projects: false }), false);
      assert.strictEqual(catalog.isToolAllowed(name, { projects: 'true' }), false);
      assert.strictEqual(catalog.isToolAllowed(name, { projects: true }), true);
    }
  });

  test('the refusal names the switch to flip', () => {
    assert.match(catalog.toolDeniedMessage('move_to_project'), /Projects/);
  });

  // The named tools and the generic proxy must grant the same reach, or one is
  // a way around the other: /projects resolves to area_broadcasts, so that is
  // what this category seeds from.
  test('the category seeds from the area /projects proxies under', () => {
    const cat = catalog.CATEGORIES.find(c => c.key === 'projects');
    assert.deepStrictEqual(cat.legacyCaps, ['area_broadcasts']);
    const svc = fs.readFileSync(path.join(PKG, 'src', 'services', 'mcpService.js'), 'utf8');
    const area = svc.match(/cap:\s*'area_broadcasts'[^\n]*test:\s*(\/\^[^\n]*?\/)[,\s]*\}/);
    assert.ok(area, 'could not locate the area_broadcasts proxy rule');
    // PROXY_AREAS is default-deny, so an unmatched path is refused outright.
    for (const p of ['/projects', '/projects/assign', '/projects-items/form']) {
      assert.ok(new RegExp(area[1].slice(1, -1)).test(p), `${p} resolves to no proxy area`);
    }
  });
});
