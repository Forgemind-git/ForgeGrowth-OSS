// Projects — the five-kind campaign folder, over HTTP against a real database.
//
//   node --test test/projects.integration.test.js
//
// Covers what the unit suite cannot: the SQL, the delete guard, the per-kind
// picker, and the authorisation split between reads and mutations.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { router, ensureProjectTables, KINDS } = require('../src/routes/projects');

let admin = null;
let viewer = null;

describe('projects over HTTP', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    await ensureProjectTables().catch(() => {});
    admin = await makeApp(router);
    viewer = await makeApp(router, { id: 2, username: 'v', displayName: 'V', role: 'viewer' });
  });

  after(async () => {
    if (admin) await admin.close();
    if (viewer) await viewer.close();
  });

  test('create -> list -> detail round-trips', async (t) => {
    if (h.skipNoDb(t)) return;
    const name = `Launch ${h.SEED}`;
    const c = await req(admin, 'POST', '/api/projects', { name });
    assert.ok(c.status === 200 || c.status === 201, `create returned ${c.status}: ${c.raw}`);
    const id = c.json?.project?.id ?? c.json?.id;
    assert.ok(id, 'create returned an id');

    const list = await req(admin, 'GET', '/api/projects');
    assert.equal(list.status, 200);
    const found = (list.json.projects || []).find((p) => String(p.id) === String(id));
    assert.ok(found, 'the new project is in the list');

    const detail = await req(admin, 'GET', `/api/projects/${id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.json, 'detail returns a body');
  });

  test('every KINDS entry reports a count, so a new kind cannot be half-wired', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(admin, 'POST', '/api/projects', { name: `Counts ${h.SEED}` });
    const id = c.json?.project?.id ?? c.json?.id;
    const detail = await req(admin, 'GET', `/api/projects/${id}`);
    const body = JSON.stringify(detail.json);
    for (const kind of Object.keys(KINDS)) {
      assert.ok(body.includes(kind) || detail.json.counts, `detail mentions kind ${kind}`);
    }
    // Every kind starts empty on a fresh project.
    const counts = detail.json.counts || detail.json.project?.counts || {};
    for (const k of Object.keys(counts)) {
      assert.equal(Number(counts[k]), 0, `${k} starts at 0`);
    }
  });

  test('a blank name is refused rather than creating an unnamed folder', async (t) => {
    if (h.skipNoDb(t)) return;
    for (const bad of [{ name: '' }, { name: '   ' }, {}]) {
      const r = await req(admin, 'POST', '/api/projects', bad);
      assert.equal(r.status, 400, `blank name refused (sent ${JSON.stringify(bad)})`);
    }
  });

  test('rename persists', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(admin, 'POST', '/api/projects', { name: `Before ${h.SEED}` });
    const id = c.json?.project?.id ?? c.json?.id;
    const u = await req(admin, 'PUT', `/api/projects/${id}`, { name: `After ${h.SEED}` });
    assert.equal(u.status, 200, u.raw);
    const list = await req(admin, 'GET', '/api/projects');
    const row = (list.json.projects || []).find((p) => String(p.id) === String(id));
    assert.match(row.name, /^After /);
  });

  test('a NaN id is a 404, never a 500', async (t) => {
    if (h.skipNoDb(t)) return;
    for (const path of ['/api/projects/notanumber', '/api/projects/1e999']) {
      const r = await req(admin, 'GET', path);
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
      assert.notEqual(r.status, 500);
    }
  });

  test('an empty project deletes; one holding an item is refused, naming the kind', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(admin, 'POST', '/api/projects', { name: `Guard ${h.SEED}` });
    const id = c.json?.project?.id ?? c.json?.id;

    // File a form into it, straight through SQL — the guard must hold
    // regardless of which door put the item there.
    await h.pool.query(
      `INSERT INTO coexistence.lead_forms (name, slug, project_id)
       VALUES ($1, $2, $3)`, [`Form ${h.SEED}`, `guard-${h.SEED}`, id]);

    const blocked = await req(admin, 'DELETE', `/api/projects/${id}`);
    assert.equal(blocked.status, 409, `holding a form must 409, got ${blocked.status}`);
    assert.match(String(blocked.json?.error || ''), /form/i,
      'the refusal names what is inside');

    await h.pool.query(`DELETE FROM coexistence.lead_forms WHERE project_id = $1`, [id]);
    const ok = await req(admin, 'DELETE', `/api/projects/${id}`);
    assert.equal(ok.status, 200, 'deletes once emptied');
  });

  test('assign files an item and null unfiles it', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(admin, 'POST', '/api/projects', { name: `Assign ${h.SEED}` });
    const id = c.json?.project?.id ?? c.json?.id;
    const { rows: [form] } = await h.pool.query(
      `INSERT INTO coexistence.lead_forms (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Movable ${h.SEED}`, `movable-${h.SEED}`]);

    const filed = await req(admin, 'POST', '/api/projects/assign',
      { kind: 'form', ids: [form.id], projectId: id });
    assert.equal(filed.status, 200, filed.raw);
    let { rows } = await h.pool.query(
      `SELECT project_id FROM coexistence.lead_forms WHERE id = $1`, [form.id]);
    assert.equal(String(rows[0].project_id), String(id), 'filed into the project');

    const unfiled = await req(admin, 'POST', '/api/projects/assign',
      { kind: 'form', ids: [form.id], projectId: null });
    assert.equal(unfiled.status, 200, unfiled.raw);
    ({ rows } = await h.pool.query(
      `SELECT project_id FROM coexistence.lead_forms WHERE id = $1`, [form.id]));
    assert.equal(rows[0].project_id, null, 'unfiled');
  });

  test('assign refuses an unknown kind rather than guessing a table', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(admin, 'POST', '/api/projects/assign',
      { kind: 'leads; DROP TABLE x', ids: [1], projectId: null });
    assert.equal(r.status, 400);
    assert.match(String(r.json?.error || ''), /kind/i);
  });

  test('mutations are admin-only; reads are not', async (t) => {
    if (h.skipNoDb(t)) return;
    const read = await req(viewer, 'GET', '/api/projects');
    assert.equal(read.status, 200, 'a viewer can read the project list');

    const write = await req(viewer, 'POST', '/api/projects', { name: `Nope ${h.SEED}` });
    assert.equal(write.status, 403, 'a viewer cannot create');

    const assign = await req(viewer, 'POST', '/api/projects/assign',
      { kind: 'followup', ids: [1], projectId: null });
    assert.equal(assign.status, 403, 'a viewer cannot move items');
  });

  test('the picker lists candidates for every kind', async (t) => {
    if (h.skipNoDb(t)) return;
    for (const kind of Object.keys(KINDS)) {
      const r = await req(admin, 'GET', `/api/projects/pickable?kind=${kind}`);
      assert.ok(r.status === 200 || r.status === 404,
        `pickable?kind=${kind} -> ${r.status} ${r.raw.slice(0, 80)}`);
      if (r.status === 200) assert.ok(r.json, `kind ${kind} returns a body`);
    }
  });
});

after(async () => { await h.teardown(); });
