// applyLeadField against a REAL Postgres.
//
//   node --test test/leadFields.integration.test.js
//
// Needs a reachable database. Skips cleanly rather than failing when there is
// none, so `npm test` still works on a machine without one.
//
// This is the half the unit tests cannot cover: whether the UPDATE statements
// actually run. A column named in `WRITABLE_COLUMNS` that does not exist, or a
// RETURNING clause that reads the wrong snapshot, is invisible until the SQL
// meets a real server.
//
// Safety: every lead created here carries a SEED-prefixed number and is deleted
// afterwards. Nothing is written to any pre-existing row.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const pool = require('../src/db');
const registry = require('../src/services/fieldRegistry');
const { WRITABLE_COLUMNS, applyLeadField } = require('../src/services/leadFields');

const SEED = '99900';                 // prefix for every number this file creates
const NUMBER = `91${SEED}12345`;      // 15 digits; last 10 = 0012345 …
const CUSTOM_KEY = 'batch_date';      // registered in before(), dropped in after()
let dbUp = false;
let leadId = null;

describe('applyLeadField', () => {
  before(async () => {
    try {
      await pool.query('SELECT 1');
      await registry.refreshFieldRegistry();
      dbUp = true;
    } catch { dbUp = false; return; }
    await pool.query(`DELETE FROM coexistence.leads WHERE whatsapp_number LIKE $1`, [`%${SEED}%`]);

    // A custom field has to be REGISTERED before anything may write it —
    // applyLeadField refuses an unknown key rather than inventing a column in
    // the bag, so an admin creating the field is part of the setup, not an
    // implementation detail the test can skip. (This is what a deployment
    // does through Admin Settings -> Fields.)
    await pool.query(
      `INSERT INTO coexistence.entity_fields (entity, field_key, label, field_type, show_in_leads)
       VALUES ('lead', $1, 'Batch date', 'date', TRUE)
       ON CONFLICT (entity, field_key) DO UPDATE SET deleted_at = NULL`, [CUSTOM_KEY]
    );
    await registry.refreshFieldRegistry();

    const { rows } = await pool.query(
      `INSERT INTO coexistence.leads (whatsapp_number, name, stage, source)
       VALUES ($1, 'Seed Person', 'new', 'Direct') RETURNING id`, [NUMBER]
    );
    leadId = rows[0].id;
  });

  after(async () => {
    if (dbUp) {
      await pool.query(`DELETE FROM coexistence.leads WHERE whatsapp_number LIKE $1`, [`%${SEED}%`]);
      await pool.query(`DELETE FROM coexistence.entity_fields WHERE entity = 'lead' AND field_key = $1`, [CUSTOM_KEY]);
    }
    await pool.end().catch(() => {});
  });

  const read = async (col) => (await pool.query(
    `SELECT ${col} AS v, custom_fields FROM coexistence.leads WHERE id = $1`, [leadId]
  )).rows[0];

  // ⚠ The decision to skip has to be made INSIDE the test body: describe()
  // bodies run at module load, before before() can probe the database, so a
  // `{skip}` option would read the flag while it is still false.
  const t = (name, fn) => test(name, async (ctx) => {
    if (!dbUp) return ctx.skip('no database');
    await fn(ctx);
  });

  t('every writable column actually exists on leads', async () => {
    // The registry names a `total_paid` column that does not exist. This is the
    // assertion that would have caught it had it ever reached the map.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='coexistence' AND table_name='leads'`
    );
    const cols = new Set(rows.map(r => r.column_name));
    for (const col of Object.values(WRITABLE_COLUMNS)) {
      assert.ok(cols.has(col), `WRITABLE_COLUMNS names "${col}", which is not a column on leads`);
    }
  });

  t('writes a system column and reports the value it replaced', async () => {
    const first = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: 'city', value: 'Chennai' });
    assert.strictEqual(first.status, 'applied');
    assert.strictEqual(first.leadId, leadId);
    assert.strictEqual(first.to, 'Chennai');
    assert.strictEqual((await read('city')).v, 'Chennai');

    // Answering again OVERWRITES — the customer has just told us something
    // newer — and the step must report what it replaced, or an operator
    // looking at the log cannot tell that anything was lost.
    const second = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: 'city', value: 'Madurai' });
    assert.strictEqual(second.from, 'Chennai');
    assert.strictEqual(second.to, 'Madurai');
    assert.strictEqual((await read('city')).v, 'Madurai');
  });

  t('coerces into a typed column instead of failing the statement', async () => {
    const ok = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: 'age', value: ' 31 ' });
    assert.strictEqual(ok.status, 'applied');
    assert.strictEqual((await read('age')).v, 31);

    // The refusal must happen BEFORE the UPDATE — a raw 'thirty' would make
    // Postgres throw, which the engine would surface as a step error with a
    // database message instead of a sentence anyone can act on.
    const bad = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: 'age', value: 'thirty' });
    assert.strictEqual(bad.status, 'error');
    assert.strictEqual((await read('age')).v, 31, 'a refused write must leave the value alone');
  });

  t('writes a custom field into the bag without disturbing its neighbours', async () => {
    await pool.query(
      `UPDATE coexistence.leads SET custom_fields = '{"kept":"yes"}'::jsonb WHERE id = $1`, [leadId]
    );
    const r = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: CUSTOM_KEY, value: '2026-09-01' });
    assert.strictEqual(r.status, 'applied');
    const bag = (await read('city')).custom_fields;
    assert.strictEqual(bag.kept, 'yes', 'an unrelated key was dropped — the merge is not happening in SQL');
    assert.strictEqual(bag[CUSTOM_KEY], '2026-09-01');

    // Re-answering REPLACES rather than appending, and the bag stays an object.
    const again = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: CUSTOM_KEY, value: '2026-10-05' });
    assert.strictEqual(again.from, '2026-09-01');
    const bag2 = (await read('city')).custom_fields;
    assert.ok(!Array.isArray(bag2), 'the bag must never become a jsonb array');
    assert.strictEqual(bag2.batch_date, '2026-10-05');
    assert.strictEqual(Object.keys(bag2).length, 2);
  });

  t('matches the lead on the LAST 10 DIGITS, like every other lookup here', async () => {
    // The same person is stored as 919876543210 in one place and 9876543210 in
    // another; an exact string match would silently find nothing.
    const bare = NUMBER.slice(-10);
    const r = await applyLeadField(pool, { contactNumber: `+${bare}`, fieldKey: 'pincode', value: '600001' });
    assert.strictEqual(r.status, 'applied');
    assert.strictEqual(r.leadId, leadId);
  });

  t('refuses a locked field and writes nothing', async () => {
    const before = await read('stage');
    for (const locked of ['stage', 'whatsapp_number', 'source', 'assigned_to']) {
      const r = await applyLeadField(pool, { contactNumber: NUMBER, fieldKey: locked, value: 'tampered' });
      assert.strictEqual(r.status, 'error', `${locked} must be refused`);
      assert.match(r.error, /not a field an automation can write/);
    }
    const after = await pool.query(
      `SELECT stage, whatsapp_number, source FROM coexistence.leads WHERE id = $1`, [leadId]
    );
    assert.strictEqual(after.rows[0].stage, before.v === undefined ? after.rows[0].stage : 'new');
    assert.strictEqual(after.rows[0].whatsapp_number, NUMBER);
    assert.strictEqual(after.rows[0].source, 'Direct');
  });

  t('skips — never invents a lead — when the number has none', async () => {
    // webhook.js already creates a lead for every inbound customer, so "no
    // lead" means this number never messaged us. Creating one here would be a
    // second creation path with no source attribution.
    const { rows: pre } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.leads');
    const r = await applyLeadField(pool, { contactNumber: '919999000111', fieldKey: 'city', value: 'Nowhere' });
    assert.strictEqual(r.status, 'skipped');
    const { rows: post } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.leads');
    assert.strictEqual(post[0].n, pre[0].n, 'a skipped write must not create a row');
  });

  t('an unusable contact number is an error, not a write against someone else', async () => {
    const r = await applyLeadField(pool, { contactNumber: '123', fieldKey: 'city', value: 'X' });
    assert.strictEqual(r.status, 'error');
  });
});
