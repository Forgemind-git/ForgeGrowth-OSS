// Follow-up sequences over HTTP against a real database.
//
//   node --test test/followups.integration.test.js
//
// The rules worth protecting here are the ones whose failure is SILENT: a
// string "false" activating a live sender, a step whose token never resolves,
// and a reorder that reshapes steps under a lead mid-run.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { router } = require('../src/routes/followUps');

let app = null;
let viewer = null;

async function newSeq(name = `Seq ${h.SEED}`) {
  const r = await req(app, 'POST', '/api/follow-up-sequences', { name });
  return r.json?.sequence?.id ?? r.json?.id;
}
async function addTextStep(id, body = 'Hello there', delayMinutes = 60) {
  return req(app, 'POST', `/api/follow-up-sequences/${id}/steps`,
    { messageKind: 'text', body, delayMinutes });
}

describe('follow-up sequences over HTTP', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    app = await makeApp(router);
    viewer = await makeApp(router, await h.makeUser('viewer'));
  });
  after(async () => {
    if (app) await app.close();
    if (viewer) await viewer.close();
  });

  test('create -> list -> detail -> delete', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    assert.ok(id, 'created');

    const list = await req(app, 'GET', '/api/follow-up-sequences');
    assert.equal(list.status, 200);
    assert.ok((list.json.sequences || []).some((s) => String(s.id) === String(id)));

    const detail = await req(app, 'GET', `/api/follow-up-sequences/${id}`);
    assert.equal(detail.status, 200);

    const del = await req(app, 'DELETE', `/api/follow-up-sequences/${id}`);
    assert.equal(del.status, 200);
    const gone = await req(app, 'GET', `/api/follow-up-sequences/${id}`);
    assert.equal(gone.status, 404, 'deleted sequence is gone');
  });

  test('a new sequence is INACTIVE — activation is never implicit', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    const { rows } = await h.pool.query(
      `SELECT active FROM coexistence.follow_up_sequences WHERE id = $1`, [id]);
    assert.equal(rows[0].active, false, 'ships off');
  });

  test('the string "false" cannot activate a live sender', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id);
    // "false" is truthy in JS. A loose check here would switch on a sender that
    // messages real customers, which is why the route demands a real boolean.
    for (const bad of ['false', 'true', 1, 0, 'yes']) {
      const r = await req(app, 'PUT', `/api/follow-up-sequences/${id}`, { active: bad });
      assert.equal(r.status, 400, `active: ${JSON.stringify(bad)} must be refused`);
    }
    const good = await req(app, 'PUT', `/api/follow-up-sequences/${id}`, { active: true });
    assert.equal(good.status, 200, 'a real boolean is accepted');
  });

  test('a sequence with no steps cannot be activated', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    const r = await req(app, 'PUT', `/api/follow-up-sequences/${id}`, { active: true });
    assert.equal(r.status, 400);
    assert.match(String(r.json?.error || ''), /step/i, 'the refusal says why');
  });

  test('an unknown token is refused at SAVE, not left to fail at send', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    const bad = await addTextStep(id, 'Hi {{lead.definitely_not_a_field}}');
    assert.equal(bad.status, 400, 'unknown token refused');
    assert.match(String(bad.json?.error || ''), /token|variable|field/i);

    const good = await addTextStep(id, 'Hi {{lead.name}}, still interested?');
    assert.ok(good.status === 200 || good.status === 201, good.raw);
  });

  test('every documented token shape is accepted', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    for (const tok of ['{{name}}', '{{first_name}}', '{{phone}}', '{{lead.name}}',
                       '{{lead.stage}}', '{{sale.total_paid}}']) {
      const r = await addTextStep(id, `Msg ${tok}`);
      assert.ok(r.status === 200 || r.status === 201, `${tok} accepted: ${r.raw.slice(0, 120)}`);
    }
  });

  test('a text step with an empty body is refused', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    for (const body of ['', '   ']) {
      const r = await addTextStep(id, body);
      assert.equal(r.status, 400, `empty body refused (${JSON.stringify(body)})`);
    }
  });

  test('a template step needs a template, and a missing one is named', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    const none = await req(app, 'POST', `/api/follow-up-sequences/${id}/steps`,
      { messageKind: 'template', delayMinutes: 30 });
    assert.equal(none.status, 400);
    assert.match(String(none.json?.error || ''), /template/i);

    const ghost = await req(app, 'POST', `/api/follow-up-sequences/${id}/steps`,
      { messageKind: 'template', templateId: 999999999, delayMinutes: 30 });
    assert.equal(ghost.status, 400);
    assert.match(String(ghost.json?.error || ''), /no longer exists|template/i);
  });

  test('steps reorder, and the new order persists', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id, 'first', 10);
    await addTextStep(id, 'second', 20);
    const { rows: before } = await h.pool.query(
      `SELECT id FROM coexistence.follow_up_steps WHERE sequence_id = $1 ORDER BY step_order, id`, [id]);
    assert.equal(before.length, 2);
    const reversed = [before[1].id, before[0].id];

    const r = await req(app, 'PUT', `/api/follow-up-sequences/${id}/steps/reorder`, { ids: reversed });
    assert.equal(r.status, 200, r.raw);
    const { rows: after } = await h.pool.query(
      `SELECT id FROM coexistence.follow_up_steps WHERE sequence_id = $1 ORDER BY step_order, id`, [id]);
    assert.deepEqual(after.map((x) => x.id), reversed, 'order swapped');
  });

  test('reorder refuses a list that is not a permutation of the real steps', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id, 'only');
    const { rows } = await h.pool.query(
      `SELECT id FROM coexistence.follow_up_steps WHERE sequence_id = $1`, [id]);
    // A partial or foreign list would silently drop or steal steps.
    for (const ids of [[], [999999999], [rows[0].id, 999999999]]) {
      const r = await req(app, 'PUT', `/api/follow-up-sequences/${id}/steps/reorder`, { ids });
      assert.equal(r.status, 400, `refused ${JSON.stringify(ids)}`);
    }
  });

  test('a step updates and deletes', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id, 'original', 15);
    const { rows } = await h.pool.query(
      `SELECT id FROM coexistence.follow_up_steps WHERE sequence_id = $1`, [id]);
    const stepId = rows[0].id;

    const u = await req(app, 'PUT', `/api/follow-up-steps/${stepId}`,
      { body: 'edited', delayMinutes: 45, messageKind: 'text' });
    assert.equal(u.status, 200, u.raw);
    const { rows: after } = await h.pool.query(
      `SELECT body, delay_minutes FROM coexistence.follow_up_steps WHERE id = $1`, [stepId]);
    assert.equal(after[0].body, 'edited');
    assert.equal(Number(after[0].delay_minutes), 45);

    const d = await req(app, 'DELETE', `/api/follow-up-steps/${stepId}`);
    assert.equal(d.status, 200);
  });

  test('enrollments and log endpoints answer for a real sequence', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id);
    for (const p of [`/api/follow-up-sequences/${id}/enrollments`, `/api/follow-up-sequences/${id}/log`]) {
      const r = await req(app, 'GET', p);
      assert.equal(r.status, 200, `${p} -> ${r.status}`);
    }
  });

  test('manual enroll requires real lead ids', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id);
    for (const body of [{}, { leadIds: [] }, { leadIds: 'nope' }]) {
      const r = await req(app, 'POST', `/api/follow-up-sequences/${id}/enroll`, body);
      assert.ok(r.status === 400 || r.status === 200,
        `enroll ${JSON.stringify(body)} -> ${r.status}`);
      if (r.status === 200) assert.equal(Number(r.json?.enrolled || 0), 0, 'nothing enrolled');
    }
  });

  test('a real lead enrolls exactly once, and re-enrolling does not duplicate', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id);
    await req(app, 'PUT', `/api/follow-up-sequences/${id}`, { active: true });
    const lead = await h.makeLead({ phone: `9199${Date.now() % 100000000}`, name: `Enrollee ${h.SEED}` });

    const first = await req(app, 'POST', `/api/follow-up-sequences/${id}/enroll`, { leadIds: [lead.id] });
    assert.equal(first.status, 200, first.raw);
    const second = await req(app, 'POST', `/api/follow-up-sequences/${id}/enroll`, { leadIds: [lead.id] });
    assert.equal(second.status, 200, second.raw);

    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.follow_up_enrollments
        WHERE sequence_id = $1 AND lead_id = $2 AND status = 'active'`, [id, lead.id]);
    assert.equal(rows[0].n, 1, 'never two live runs for one lead (partial unique index)');
  });

  test('an enrollment can be stopped', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    await addTextStep(id);
    await req(app, 'PUT', `/api/follow-up-sequences/${id}`, { active: true });
    const lead = await h.makeLead({ phone: `9198${Date.now() % 100000000}`, name: `Stoppable ${h.SEED}` });
    await req(app, 'POST', `/api/follow-up-sequences/${id}/enroll`, { leadIds: [lead.id] });
    const { rows } = await h.pool.query(
      `SELECT id FROM coexistence.follow_up_enrollments WHERE sequence_id = $1 AND lead_id = $2`,
      [id, lead.id]);
    if (!rows.length) return; // nothing enrolled (no active stage match) — nothing to stop
    const r = await req(app, 'POST', `/api/follow-up-enrollments/${rows[0].id}/stop`, {});
    assert.equal(r.status, 200, r.raw);
    const { rows: after } = await h.pool.query(
      `SELECT status FROM coexistence.follow_up_enrollments WHERE id = $1`, [rows[0].id]);
    assert.notEqual(after[0].status, 'active', 'no longer running');
  });

  test('NaN ids are 404s across every :id route', async (t) => {
    if (h.skipNoDb(t)) return;
    const paths = [
      ['GET', '/api/follow-up-sequences/abc'],
      ['PUT', '/api/follow-up-sequences/abc'],
      ['DELETE', '/api/follow-up-sequences/abc'],
      ['POST', '/api/follow-up-sequences/abc/steps'],
      ['PUT', '/api/follow-up-steps/abc'],
      ['DELETE', '/api/follow-up-steps/abc'],
      ['GET', '/api/follow-up-sequences/abc/enrollments'],
      ['GET', '/api/follow-up-sequences/abc/log'],
      ['POST', '/api/follow-up-enrollments/abc/stop'],
    ];
    for (const [m, p] of paths) {
      const r = await req(app, m, p, {});
      assert.notEqual(r.status, 500, `${m} ${p} must not 500 (got ${r.status})`);
      assert.ok(r.status === 404 || r.status === 400, `${m} ${p} -> ${r.status}`);
    }
  });

  test('the log limit is clamped rather than trusted', async (t) => {
    if (h.skipNoDb(t)) return;
    const id = await newSeq();
    const r = await req(app, 'GET', `/api/follow-up-sequences/${id}/log?limit=999999999`);
    assert.equal(r.status, 200);
    assert.ok((r.json.log || r.json.entries || []).length <= 1000, 'clamped');
  });

  test('writes are admin-only', async (t) => {
    if (h.skipNoDb(t)) return;
    // A real, non-admin user row — not a stub id, which requirePermission()
    // would reject as 401 "user not found" and so prove nothing.
    const r = await req(viewer, 'POST', '/api/follow-up-sequences', { name: `Nope ${h.SEED}` });
    assert.equal(r.status, 403, `a real viewer must be forbidden, got ${r.status}`);
  });
});

after(async () => { await h.teardown(); });
