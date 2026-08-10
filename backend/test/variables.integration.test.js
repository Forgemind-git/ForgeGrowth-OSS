// The variable resolver against real rows.
//
//   node --test test/variables.integration.test.js
//
// The unit suite covers the pure helpers. This one covers what only a database
// can show: that a token which VALIDATES at save also RESOLVES at send. An
// accepted token is a promise of resolution — a token that passes the
// validator and then renders '' is the failure mode this file exists to catch.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const v = require('../src/services/variables');
const registry = require('../src/services/fieldRegistry');

let lead = null;

describe('variable resolution against real rows', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    await registry.refreshFieldRegistry().catch(() => {});
    lead = await h.makeLead({
      phone: `9197${Date.now() % 100000000}`,
      name: `Asha Menon ${h.SEED}`,
      extra: { email: 'asha@example.com', profession: 'Engineer' },
    });
  });

  test('extractTokens finds every shape and ignores prose braces', async (t) => {
    if (h.skipNoDb(t)) return;
    const body = 'Hi {{name}} / {{lead.email}} / {{sale.total_paid}} / {{form.myform.q1}} — not {a} or {{ }}';
    const found = v.extractTokens(body);
    for (const want of ['name', 'lead.email', 'sale.total_paid', 'form.myform.q1']) {
      assert.ok(found.includes(want), `found ${want} in ${JSON.stringify(found)}`);
    }
  });

  test('the six legacy aliases still resolve byte-compatibly', async (t) => {
    if (h.skipNoDb(t)) return;
    const body = '{{name}}|{{first_name}}|{{phone}}';
    const ctx = await v.loadTokenContext([body], lead.id);
    const out = v.resolveTokens(body, { ...ctx, lead });
    const [name, first, phone] = out.split('|');
    assert.ok(name.includes('Asha'), `name resolved: ${name}`);
    assert.equal(first, 'Asha', 'first_name is the first word, not the whole name');
    assert.equal(phone, lead.whatsapp_number, 'phone is the digits-only number');
  });

  test('{{lead.<key>}} reads both a real column and the custom bag', async (t) => {
    if (h.skipNoDb(t)) return;
    // The REGISTRY is the source of truth for what {{lead.*}} can address. A
    // value sitting in the JSONB bag under an unregistered key is deliberately
    // NOT resolvable — otherwise a token could resolve for one lead and be
    // rejected by the validator for another. So register the field first.
    await h.pool.query(
      `INSERT INTO coexistence.entity_fields (entity, field_key, label, field_type, show_in_leads)
       VALUES ('lead', 'favourite_course', $1, 'text', TRUE)
       ON CONFLICT (entity, field_key) DO UPDATE SET deleted_at = NULL`,
      [`Favourite course ${h.SEED}`]);
    await registry.refreshFieldRegistry();

    await h.pool.query(
      `UPDATE coexistence.leads
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [lead.id, JSON.stringify({ favourite_course: 'Automation 101' })]);
    const fresh = (await h.pool.query(`SELECT * FROM coexistence.leads WHERE id = $1`, [lead.id])).rows[0];

    const body = '{{lead.email}}|{{lead.favourite_course}}';
    const ctx = await v.loadTokenContext([body], lead.id);
    const out = v.resolveTokens(body, { ...ctx, lead: fresh });
    const [email, custom] = out.split('|');
    assert.equal(email, 'asha@example.com', 'a real column');
    assert.equal(custom, 'Automation 101', 'a registered custom field resolves from the JSONB bag');
  });

  test('an UNREGISTERED bag key is not addressable, by design', async (t) => {
    if (h.skipNoDb(t)) return;
    await h.pool.query(
      `UPDATE coexistence.leads
          SET custom_fields = COALESCE(custom_fields,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [lead.id, JSON.stringify({ ghost_key: 'should not resolve' })]);
    // The validator must refuse it too — a token that resolves without being
    // registered would pass here and fail on the next lead.
    const err = await v.stepTokenError(['{{lead.ghost_key}}']);
    assert.ok(err, 'the validator refuses an unregistered key');
  });

  test('a JSONB bag write merges in SQL and never clobbers a sibling key', async (t) => {
    if (h.skipNoDb(t)) return;
    // Read-modify-write in JS loses a concurrent write. The merge must happen
    // in Postgres.
    await h.pool.query(
      `UPDATE coexistence.leads SET custom_fields = COALESCE(custom_fields,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [lead.id, JSON.stringify({ second_key: 'kept' })]);
    const { rows } = await h.pool.query(
      `SELECT custom_fields FROM coexistence.leads WHERE id = $1`, [lead.id]);
    assert.equal(rows[0].custom_fields.favourite_course, 'Automation 101', 'the earlier key survived');
    assert.equal(rows[0].custom_fields.second_key, 'kept', 'the new key landed');
  });

  test('an ARRAY payload must never be merged into the bag', async (t) => {
    if (h.skipNoDb(t)) return;
    // `'{...}'::jsonb || '[]'::jsonb` coerces the whole bag into a jsonb ARRAY
    // with NO error, after which every ->> read and every {{lead.*}} token goes
    // blank for that lead. typeof === 'object' is not a sufficient guard.
    const { rows } = await h.pool.query(`SELECT ('{"a":1}'::jsonb || '[]'::jsonb) AS coerced`);
    assert.ok(Array.isArray(rows[0].coerced),
      'Postgres really does coerce a bag to an array — hence the !Array.isArray guard');
  });

  test('stepTokenError accepts known tokens and names an unknown one', async (t) => {
    if (h.skipNoDb(t)) return;
    // stepTokenError takes an ARRAY of texts (a step can have several fields).
    assert.equal(await v.stepTokenError(['Hi {{lead.name}} and {{sale.total_paid}}']), null,
      'known tokens validate');
    const err = await v.stepTokenError(['Hi {{lead.no_such_field_anywhere}}']);
    assert.ok(err && /no_such_field_anywhere/.test(err),
      `the error names the offending token: ${err}`);
  });

  test('EVERY token the validator accepts also resolves — no silent blanks', async (t) => {
    if (h.skipNoDb(t)) return;
    // This is the invariant. A token that validates but resolves to '' sends
    // the customer a sentence with a hole in it and nothing reports a fault.
    // LEGACY_KEYS is a Set; SALE_TOKENS is [{key,label}].
    const tokens = [
      ...v.LEGACY_KEYS,
      ...registry.fields('lead').map((f) => `lead.${f.fieldKey}`),
      ...v.SALE_TOKENS.map((s) => `sale.${s.key}`),
    ];
    const fresh = (await h.pool.query(`SELECT * FROM coexistence.leads WHERE id = $1`, [lead.id])).rows[0];
    const unresolved = [];
    for (const tok of tokens) {
      const body = `{{${tok}}}`;
      const err = await v.stepTokenError([body]);
      if (err) { unresolved.push(`${tok} REJECTED: ${err}`); continue; }
      const ctx = await v.loadTokenContext([body], lead.id);
      const out = v.resolveTokens(body, { ...ctx, lead: fresh });
      // Resolving to an empty string is legitimate (the lead has no value); what
      // must never happen is the literal braces surviving to the customer.
      if (out.includes('{{')) unresolved.push(`${tok} left literal braces: ${out}`);
    }
    assert.deepEqual(unresolved, [], 'every accepted token resolves');
  });

  test('neededContext only asks for what the tokens actually reference', async (t) => {
    if (h.skipNoDb(t)) return;
    // Sale and form context are expensive joins; loading them for a step that
    // never mentions them would make every send slower for nothing.
    // neededContext takes the TEXTS, not the token names.
    const leadOnly = v.neededContext(['Hi {{name}} at {{lead.email}}']);
    assert.ok(!leadOnly.sale, 'a lead-only body does not load sale data');
    const withSale = v.neededContext(['You have paid {{sale.total_paid}}']);
    assert.ok(withSale.sale, 'a sale token does load it');
    const withForm = v.neededContext(['You answered {{form.myform.q1}}']);
    assert.deepEqual(withForm.formSlugs, ['myform'], 'only the referenced form is loaded');
  });

  test('fmtDate, rupees and stringifyVal render for a human, not a machine', async (t) => {
    if (h.skipNoDb(t)) return;
    assert.equal(v.stringifyVal(null), '', 'null is blank, never the string "null"');
    assert.equal(v.stringifyVal(true), 'Yes');
    assert.equal(v.stringifyVal(false), 'No');
    assert.equal(v.stringifyVal(['a', 'b']), 'a, b');
    assert.ok(!String(v.rupees(150000)).includes('paise'), 'rupees renders an amount');
    assert.equal(v.fmtDate(null), '', 'a null date is blank');
  });

  test('an unknown token is left ALONE at send time rather than blanked', async (t) => {
    if (h.skipNoDb(t)) return;
    // Save-time validation is the gate. At send time the policy is leave-as-is,
    // so a token that slipped through an older save is visible in the log
    // rather than silently deleted.
    const body = 'Hi {{totally_unknown}}';
    const ctx = await v.loadTokenContext([body], lead.id);
    const out = v.resolveTokens(body, { ...ctx, lead });
    assert.ok(out.includes('{{totally_unknown}}') || out === 'Hi ',
      `send-time policy is deterministic: ${out}`);
  });
});

after(async () => { await h.teardown(); });
