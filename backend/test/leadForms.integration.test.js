// Lead forms, with the star-rating and section field types, over HTTP against
// a real database.
//
//   node --test test/leadForms.integration.test.js
//
// A field type is a contract across FIVE consumers, and sanitizeFields
// DOWNGRADES an unknown type to 'text' rather than erroring — so a type added
// in only some of them ships as a plain text box with no warning anywhere.
// These tests walk the type through all of them: the whitelist, the public
// payload, the required check, the stored shape, the export and the dashboard.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { router, publicRouter, ensureLeadFormTables, FIELD_TYPES } = require('../src/routes/leadForms');

let app = null;
let pub = null;

const ratingField = (over = {}) => ({
  key: 'how_was_it', label: 'How was it?', type: 'rating', scale: 5, required: false, ...over,
});
const sectionField = (over = {}) => ({
  key: 'about_you', label: 'About you', type: 'section', ...over,
});

// POST creates the shell only — it ignores `fields`, which are set by PUT — and
// a form starts as 'draft', so the public routes 404 until it is published.
// Both facts are easy to miss and make every downstream assertion misleading.
async function newForm(fields, over = {}) {
  const c = await req(app, 'POST', '/api/lead-forms', { name: `Form ${h.SEED}`, ...over });
  if (c.status !== 200 && c.status !== 201) return { status: c.status, raw: c.raw, form: null };
  const id = (c.json.form || c.json).id;
  const u = await req(app, 'PUT', `/api/lead-forms/${id}`, { fields, status: 'published', ...over });
  return { status: u.status, raw: u.raw, form: u.json?.form || u.json };
}

// The public payload is a hand-picked subset of the field, NOT the whole row —
// miss a key here and a 4-star form renders five stars to the respondent.
async function publicForm(slug) {
  const r = await req(pub, 'GET', `/api/public/lead-forms/${slug}`);
  return { status: r.status, json: r.json, raw: r.raw };
}
async function submit(slug, answers, extra = {}) {
  return req(pub, 'POST', `/api/public/lead-forms/${slug}/submit`, { answers, ...extra });
}

describe('lead forms: rating + section field types', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    await ensureLeadFormTables().catch(() => {});
    app = await makeApp(router);
    pub = await makeApp(publicRouter);
  });
  after(async () => {
    if (app) await app.close();
    if (pub) await pub.close();
  });

  test('rating and section are on the FIELD_TYPES whitelist', async (t) => {
    if (h.skipNoDb(t)) return;
    // sanitizeFields downgrades an unknown type to 'text' silently, so being
    // absent here is not an error anywhere — it is just a text box.
    assert.ok(FIELD_TYPES.includes('rating'), 'rating is a known type');
    assert.ok(FIELD_TYPES.includes('section'), 'section is a known type');
  });

  test('a rating field survives the round-trip with its scale intact', async (t) => {
    if (h.skipNoDb(t)) return;
    const { status, form, raw } = await newForm([ratingField({ scale: 4, feedback: true })]);
    assert.ok(status === 200 || status === 201, raw);
    const saved = (form.fields || []).find((f) => f.key === 'how_was_it');
    assert.equal(saved.type, 'rating', 'not downgraded to text');
    assert.equal(Number(saved.scale), 4, 'the admin-chosen scale persisted');
    assert.equal(saved.feedback, true, 'the feedback box flag persisted');
  });

  test('an unknown type IS downgraded to text — the documented behaviour', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([{ key: 'k', label: 'L', type: 'star_rating' }]);
    const saved = (form.fields || [])[0];
    assert.equal(saved.type, 'text',
      'confirms why a new type must be added to the whitelist, not just the UI');
  });

  test('an invalid scale is NORMALISED to the default by the REST route', async (t) => {
    if (h.skipNoDb(t)) return;
    // ⚠ The two doors disagree, deliberately recorded here rather than assumed:
    // the REST builder coerces an unknown scale to 5 (same forgiving posture as
    // the unknown-type downgrade above), while the MCP layer REJECTS it with a
    // 400. So an admin who types 7 gets a five-star field with no warning, and
    // an assistant doing the same gets an error. If that is ever unified, this
    // test is the one that should change.
    const { status, form, raw } = await newForm([ratingField({ scale: 7 })]);
    assert.ok(status === 200 || status === 201, raw);
    const saved = form.fields.find((f) => f.key === 'how_was_it');
    assert.equal(Number(saved.scale), 5, 'coerced to the default, not stored as 7');
  });

  test('the PUBLIC payload carries scale and feedback', async (t) => {
    if (h.skipNoDb(t)) return;
    // This is the subset bug: the respondent's browser renders from THIS, so a
    // missing scale silently draws five stars on a four-star question.
    const { form } = await newForm([ratingField({ scale: 4, feedback: true, feedbackLabel: 'Why?' })]);
    const p = await publicForm(form.slug);
    assert.equal(p.status, 200, p.raw);
    const f = (p.json.fields || p.json.form?.fields || []).find((x) => x.key === 'how_was_it');
    assert.ok(f, 'the rating field reached the public payload');
    assert.equal(Number(f.scale), 4, 'scale survived to the public payload');
    assert.equal(f.feedback, true, 'feedback flag survived');
    assert.equal(f.feedbackLabel, 'Why?', 'the editable prompt survived');
  });

  test('rating and section are forced to mapsTo = null SERVER-SIDE', async (t) => {
    if (h.skipNoDb(t)) return;
    // Hiding it in the builder is not enough — an API or MCP caller could
    // otherwise write a rating OBJECT into leads.name.
    const { form } = await newForm([
      ratingField({ mapsTo: 'name' }),
      sectionField({ mapsTo: 'email', required: true }),
    ]);
    const rating = form.fields.find((f) => f.type === 'rating');
    const section = form.fields.find((f) => f.type === 'section');
    assert.ok(!rating.mapsTo, `rating mapsTo forced null, got ${rating.mapsTo}`);
    assert.ok(!section.mapsTo, `section mapsTo forced null, got ${section.mapsTo}`);
    assert.ok(!section.required,
      'a required heading would block every submission on an unanswerable question');
  });

  test('required means the STAR — feedback alone does not satisfy it', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([ratingField({ required: true, feedback: true })]);

    const noStar = await submit(form.slug, { how_was_it: { rating: null, feedback: 'typed a lot' } });
    assert.equal(noStar.status, 400, 'feedback with no star is still unanswered');

    const starred = await submit(form.slug, { how_was_it: { rating: 4 } });
    assert.ok(starred.status === 200 || starred.status === 201, starred.raw);
  });

  test('a star outside the scale is a 400, not a clamp', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([ratingField({ scale: 4, required: true })]);
    const over = await submit(form.slug, { how_was_it: { rating: 5 } });
    assert.equal(over.status, 400, '5 on a 4-star field is refused');
    // and is NOT recorded as a 4
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.lead_form_submissions WHERE form_id = $1`, [form.id]);
    assert.equal(rows[0].n, 0, 'nothing was stored');
  });

  test('the submission row keeps the STRUCTURED answer', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([ratingField({ feedback: true })]);
    const r = await submit(form.slug, { how_was_it: { rating: 4, feedback: 'loved it' } });
    assert.ok(r.status === 200 || r.status === 201, r.raw);
    const { rows } = await h.pool.query(
      `SELECT answers FROM coexistence.lead_form_submissions WHERE form_id = $1`, [form.id]);
    const a = rows[0].answers.how_was_it;
    assert.equal(typeof a, 'object', 'stored as an object, not flattened');
    assert.equal(a.rating, 4);
    assert.equal(a.feedback, 'loved it');
  });

  test('a section never blocks a submission and stores no answer', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([
      sectionField(),
      { key: 'nm', label: 'Name', type: 'text', required: true },
    ]);
    const r = await submit(form.slug, { nm: 'Asha' });
    assert.ok(r.status === 200 || r.status === 201, r.raw);
    const { rows } = await h.pool.query(
      `SELECT answers FROM coexistence.lead_form_submissions WHERE form_id = $1`, [form.id]);
    assert.ok(!rows[0].answers.about_you, 'a heading collects nothing');
  });

  test('the CSV export renders a rating as text, never [object Object]', async (t) => {
    if (h.skipNoDb(t)) return;
    const { form } = await newForm([ratingField({ feedback: true }), sectionField()]);
    await submit(form.slug, { how_was_it: { rating: 3, feedback: 'ok' } });
    const r = await req(app, 'GET', `/api/lead-forms/${form.id}/submissions/export`);
    assert.equal(r.status, 200, r.raw);
    assert.ok(!r.raw.includes('[object Object]'), 'no object literal in the CSV');
    assert.ok(r.raw.includes('3/5'), `the score is readable: ${r.raw.slice(0, 200)}`);
    assert.ok(!r.raw.includes('About you'), 'a section takes no export column');
  });

  test('the dashboard averages over RATED responses only', async (t) => {
    if (h.skipNoDb(t)) return;
    // Dividing by every submission drags the score down each time someone
    // skips an optional question.
    const { form } = await newForm([ratingField({ scale: 5 })]);
    await submit(form.slug, { how_was_it: { rating: 5 } });
    await submit(form.slug, { how_was_it: { rating: 3 } });
    await submit(form.slug, {});                       // skipped — must not count
    const r = await req(app, 'GET', `/api/lead-forms/${form.id}/dashboard`);
    assert.equal(r.status, 200, r.raw);
    const rb = (r.json.ratingBreakdown || {})['how_was_it'];
    assert.ok(rb, `ratingBreakdown is keyed by field key: ${JSON.stringify(r.json.ratingBreakdown)}`);
    assert.equal(Number(rb.responses), 2, 'only the rated responses count');
    assert.equal(Number(rb.average).toFixed(2), '4.00', '(5+3)/2, not /3');
  });

  test('the dashboard seeds the whole scale with zeroes', async (t) => {
    if (h.skipNoDb(t)) return;
    // "nobody gave us a 1" is a result, not an absent option.
    const { form } = await newForm([ratingField({ scale: 4 })]);
    await submit(form.slug, { how_was_it: { rating: 4 } });
    const r = await req(app, 'GET', `/api/lead-forms/${form.id}/dashboard`);
    const rb = (r.json.ratingBreakdown || {})['how_was_it'];
    const counts = rb.counts || {};
    const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);
    assert.deepEqual(keys, [1, 2, 3, 4], `every star on the scale is present: ${JSON.stringify(counts)}`);
    assert.equal(Number(counts[1]), 0, 'an ungiven star reads 0, not missing');
    assert.equal(Number(counts[4]), 1);
  });

  test('the dashboard returns the comments themselves', async (t) => {
    if (h.skipNoDb(t)) return;
    // "3.4 average, 12 comments" with none shown forces someone into the CSV
    // to learn anything.
    const { form } = await newForm([ratingField({ feedback: true })]);
    await submit(form.slug, { how_was_it: { rating: 2, feedback: 'too slow' } });
    const r = await req(app, 'GET', `/api/lead-forms/${form.id}/dashboard`);
    const rb = (r.json.ratingBreakdown || {})['how_was_it'];
    const comments = JSON.stringify(rb.feedback || []);
    assert.ok(comments.includes('too slow'), `the comment is served: ${comments}`);
    assert.equal(Number(rb.withFeedback), 1, 'and is counted separately from the rating count');
  });

  test('a rating still submits when the form is link-only (no phone)', async (t) => {
    if (h.skipNoDb(t)) return;
    // A phone-less response is a supported outcome; the rating must not
    // reintroduce a hard requirement.
    const { form } = await newForm([ratingField({ required: true })], { formType: 'link' });
    const r = await submit(form.slug, { how_was_it: { rating: 5 } });
    assert.ok(r.status === 200 || r.status === 201, r.raw);
    const { rows } = await h.pool.query(
      `SELECT phone_number, lead_id FROM coexistence.lead_form_submissions WHERE form_id = $1`, [form.id]);
    assert.equal(rows[0].phone_number, null, 'anonymous response stored');
    assert.equal(rows[0].lead_id, null, 'and it did not become a lead');
  });

  test('every FIELD_TYPES entry round-trips without being downgraded', async (t) => {
    if (h.skipNoDb(t)) return;
    const fields = FIELD_TYPES.map((type, i) => ({
      key: `f_${i}`, label: `Field ${i}`, type,
      ...(type === 'dropdown' || type === 'radio' || type === 'checkbox'
        ? { options: ['a', 'b'] } : {}),
    }));
    const { form, status, raw } = await newForm(fields);
    assert.ok(status === 200 || status === 201, raw);
    const got = (form.fields || []).map((f) => f.type);
    assert.deepEqual(got, FIELD_TYPES, 'no type was silently rewritten');
  });
});

after(async () => { await h.teardown(); });
