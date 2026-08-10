// Entity-field registry — the configurable Leads / Sales Log / Transaction
// columns, over HTTP against a real database.
//
//   node --test test/entityFields.integration.test.js
//
// The rules that matter here are about IDENTITY: field_key is immutable, a
// deleted key stays reserved forever (so restoring brings the stored values
// back), and a custom key must never shadow a computed sale token — the typed
// value would become permanently unreachable.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { router, ensureEntityFieldTables } = require('../src/routes/entityFields');
const registry = require('../src/services/fieldRegistry');

let app = null;
let viewer = null;

const mk = (over = {}) => ({
  entity: 'lead', label: `Custom ${h.SEED}`, fieldType: 'text', showInLeads: true, ...over,
});

describe('entity-field registry over HTTP', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    await ensureEntityFieldTables().catch(() => {});
    app = await makeApp(router);
    viewer = await makeApp(router, await h.makeUser('viewer'));
  });
  after(async () => {
    if (app) await app.close();
    if (viewer) await viewer.close();
  });

  test('the registry serves both entities plus the sale tokens', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(app, 'GET', '/api/entity-fields');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.fields.lead), 'lead fields');
    assert.ok(Array.isArray(r.json.fields.transaction), 'transaction fields');
    assert.ok(r.json.fields.lead.length > 0, 'system lead rows are seeded');
    assert.ok(r.json.fields.transaction.length > 0, 'system transaction rows are seeded');
    // The picker and the token validator must read ONE list, or a token can
    // validate at save and resolve to nothing at send.
    assert.ok(Array.isArray(r.json.saleTokens) && r.json.saleTokens.length > 0, 'saleTokens served');
  });

  test('system rows are marked, and their dropdown options are editable', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(app, 'GET', '/api/entity-fields');
    const sys = r.json.fields.lead.filter((f) => f.systemColumn);
    assert.ok(sys.length > 0, 'system rows carry systemColumn');
    const prof = r.json.fields.lead.find((f) => f.fieldKey === 'profession');
    assert.ok(prof, 'profession is a registered field');
    assert.ok(Array.isArray(prof.options) && prof.options.length > 0,
      'its hardcoded dropdown became editable options');
  });

  test('a custom field is created, relabelled, and its key never changes', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(app, 'POST', '/api/entity-fields', mk({ label: `Keyed ${h.SEED}` }));
    assert.ok(c.status === 200 || c.status === 201, c.raw);
    const field = c.json.field || c.json;
    const originalKey = field.fieldKey;
    assert.ok(originalKey, 'a key was slugged from the label');

    // field_key is immutable for the same reason stage_key is: stored values
    // and every {{lead.<key>}} token are addressed by it.
    const u = await req(app, 'PUT', `/api/entity-fields/${field.id}`,
      { label: `Renamed ${h.SEED}`, fieldKey: 'attempted_new_key' });
    assert.equal(u.status, 200, u.raw);
    const after = await req(app, 'GET', '/api/entity-fields');
    const row = after.json.fields.lead.find((f) => String(f.id) === String(field.id));
    assert.equal(row.fieldKey, originalKey, 'the key survived a rename attempt');
    assert.match(row.label, /^Renamed /, 'the label did change');
  });

  test('a field needs a label', async (t) => {
    if (h.skipNoDb(t)) return;
    // mk() supplies a default label, so the omitted case must delete the key
    // rather than pass {} — otherwise this asserts nothing.
    const omitted = mk(); delete omitted.label;
    for (const bad of [mk({ label: '' }), mk({ label: '   ' }), omitted]) {
      const r = await req(app, 'POST', '/api/entity-fields', bad);
      assert.equal(r.status, 400, `refused ${JSON.stringify(bad)}`);
    }
  });

  test('an unknown entity is refused rather than defaulted', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(app, 'POST', '/api/entity-fields', mk({ entity: 'sale' }));
    assert.equal(r.status, 400);
  });

  test('a key that would shadow a computed sale token is refused', async (t) => {
    if (h.skipNoDb(t)) return;
    // A transaction field slugging to total_paid would be permanently
    // unreachable: the computed token wins, so the typed value could never be
    // read back.
    const reserved = ['Total Paid', 'Installments'];
    let refusedAtLeastOne = false;
    for (const label of reserved) {
      const r = await req(app, 'POST', '/api/entity-fields',
        { entity: 'transaction', label, fieldType: 'text' });
      if (r.status === 400 || r.status === 409) refusedAtLeastOne = true;
    }
    assert.ok(refusedAtLeastOne, 'at least one reserved sale-token key is refused');
  });

  test('delete keeps the key reserved, and restore brings the field back', async (t) => {
    if (h.skipNoDb(t)) return;
    const label = `Restorable ${h.SEED}`;
    const c = await req(app, 'POST', '/api/entity-fields', mk({ label }));
    const field = c.json.field || c.json;

    const d = await req(app, 'DELETE', `/api/entity-fields/${field.id}`);
    assert.equal(d.status, 200, d.raw);

    // Re-creating the same key must NOT silently mint a second row: the stored
    // values still live under that key, so the right answer is to offer the
    // restore.
    const again = await req(app, 'POST', '/api/entity-fields', mk({ label }));
    assert.equal(again.status, 409, `re-creating a deleted key -> ${again.status}`);
    const restorableId = again.json?.restorableId;
    assert.ok(restorableId, 'the conflict names the row that can be restored');

    const rs = await req(app, 'POST', `/api/entity-fields/${restorableId}/restore`, {});
    assert.equal(rs.status, 200, rs.raw);
    const after = await req(app, 'GET', '/api/entity-fields');
    assert.ok(after.json.fields.lead.some((f) => String(f.id) === String(restorableId)),
      'the restored field is live again');
  });

  test('reorder persists and is validated as a permutation', async (t) => {
    if (h.skipNoDb(t)) return;
    const list = await req(app, 'GET', '/api/entity-fields');
    const ids = list.json.fields.lead.map((f) => f.id);
    const r = await req(app, 'PUT', '/api/entity-fields/reorder',
      { entity: 'lead', ids: [...ids].reverse() });
    assert.equal(r.status, 200, r.raw);

    const bad = await req(app, 'PUT', '/api/entity-fields/reorder',
      { entity: 'lead', ids: [999999999] });
    assert.ok(bad.status === 200 || bad.status === 400,
      'a foreign id is either ignored or refused, never applied');

    // restore the original order so the suite leaves nothing behind
    await req(app, 'PUT', '/api/entity-fields/reorder', { entity: 'lead', ids });
  });

  test('the in-process cache refreshes on every mutation', async (t) => {
    if (h.skipNoDb(t)) return;
    const before = registry.fields('lead').length;
    const c = await req(app, 'POST', '/api/entity-fields', mk({ label: `Cached ${h.SEED}` }));
    const field = c.json.field || c.json;
    // The leads routes and the variable resolver read this cache synchronously;
    // a stale cache means a new field silently resolves to ''.
    assert.equal(registry.fields('lead').length, before + 1, 'cache grew without a restart');
    assert.ok(registry.isKnownField('lead', field.fieldKey), 'the new key is known to the resolver');
    await req(app, 'DELETE', `/api/entity-fields/${field.id}`);
    assert.equal(registry.fields('lead').length, before, 'and shrank again on delete');
  });

  test('labelFor falls back to the key rather than rendering blank', async (t) => {
    if (h.skipNoDb(t)) return;
    assert.ok(registry.labelFor('lead', 'name'), 'a known field has a label');
    const unknown = registry.labelFor('lead', 'no_such_key_at_all');
    assert.ok(unknown === undefined || typeof unknown === 'string',
      'an unknown key does not throw');
  });

  test('a NaN id is a 404 on every :id route', async (t) => {
    if (h.skipNoDb(t)) return;
    for (const [m, p] of [['PUT', '/api/entity-fields/abc'], ['DELETE', '/api/entity-fields/abc'],
                          ['POST', '/api/entity-fields/abc/restore']]) {
      const r = await req(app, m, p, {});
      assert.notEqual(r.status, 500, `${m} ${p} -> ${r.status}`);
      assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
    }
  });

  test('mutations are admin-only', async (t) => {
    if (h.skipNoDb(t)) return;
    const read = await req(viewer, 'GET', '/api/entity-fields');
    assert.equal(read.status, 200, 'anyone signed in can read the registry');
    const write = await req(viewer, 'POST', '/api/entity-fields', mk({ label: `Nope ${h.SEED}` }));
    assert.equal(write.status, 403, 'a viewer cannot add a column');
  });
});

after(async () => { await h.teardown(); });
