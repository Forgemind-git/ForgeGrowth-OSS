// CLO integration tests — the gates, and the full path from a stage change to a
// 'sent' row with Meta mocked out.
//
//   node --test test/clo.integration.test.js
//
// Needs a reachable database. Skips cleanly rather than failing when there is
// none, so `npm test` still works on a machine without one.
//
// Safety: every row created is namespaced by SEED and deleted afterwards, the
// settings row is saved and restored, and global fetch is stubbed for the whole
// file so a bug cannot reach Meta even if the dry-run logic were wrong.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const pool = require('../src/db');
const d = require('../src/services/cloDispatcher');

const SEED = '__clo_itest__';
const LEAD_ID = '1234567890123456';
let savedSettings = null;
let stageId = null;
let dbUp = false;

// Every Meta call in this file goes here instead of the network.
const realFetch = globalThis.fetch;
let metaCalls = [];
let metaReply = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'TRACE123' } };

function stubFetch() {
  globalThis.fetch = async (url, opts) => {
    metaCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    return {
      ok: metaReply.ok,
      status: metaReply.status,
      json: async () => metaReply.body,
    };
  };
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch {
    console.log('  (no database reachable — integration tests skipped)');
    return;
  }
  stubFetch();

  const { rows } = await pool.query(`SELECT * FROM coexistence.clo_settings WHERE id = 1`);
  savedSettings = rows[0];

  const { rows: st } = await pool.query(
    `INSERT INTO coexistence.clo_funnel_stages (stage_key, event_name, display_name, sort_order, crm_status_values, active)
     VALUES ($1, 'QualifiedLead', 'Test stage', 998, '["hot"]'::jsonb, TRUE) RETURNING id`, [SEED]);
  stageId = st[0].id;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!dbUp) return;
  await pool.query(`DELETE FROM coexistence.clo_events WHERE stage_id = $1`, [stageId]).catch(() => {});
  await pool.query(`DELETE FROM coexistence.clo_events WHERE lead_id IN (SELECT id FROM coexistence.leads WHERE source = $1)`, [SEED]).catch(() => {});
  await pool.query(`DELETE FROM coexistence.clo_funnel_stages WHERE stage_key = $1`, [SEED]).catch(() => {});
  await pool.query(`DELETE FROM coexistence.leads WHERE source = $1`, [SEED]).catch(() => {});
  if (savedSettings) {
    await pool.query(
      `UPDATE coexistence.clo_settings
          SET enabled=$1, dry_run=$2, last_event_id=$3, dataset_id=$4, access_token_encrypted=$5
        WHERE id=1`,
      [savedSettings.enabled, savedSettings.dry_run, savedSettings.last_event_id,
       savedSettings.dataset_id, savedSettings.access_token_encrypted]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

// flush() deliberately batches EVERY pending row, so a row left behind by an
// earlier test lands in the next test's batch and its assertions on batch size
// become wrong. Clearing this suite's rows between tests is what makes each one
// independent — the batching itself is correct behaviour, not a bug.
beforeEach(async () => {
  metaCalls = [];
  metaReply = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'TRACE123' } };
  if (!dbUp) return;
  await pool.query(
    `DELETE FROM coexistence.clo_events
      WHERE lead_id IN (SELECT id FROM coexistence.leads WHERE source = $1)`, [SEED]).catch(() => {});
});

let leadSeq = 0;
async function makeLead({ metaLeadId = LEAD_ID, agoDays = 0, phone, email } = {}) {
  leadSeq += 1;
  const created = new Date(Date.now() - agoDays * 86400000).toISOString();
  const { rows } = await pool.query(
    `INSERT INTO coexistence.leads (name, whatsapp_number, email, stage, source, meta_lead_id, meta_lead_created_at, created_at)
     VALUES ($1,$2,$3,'new',$4,$5,$6,$6) RETURNING id`,
    [`${SEED} ${leadSeq}`, phone === undefined ? `9977${String(leadSeq).padStart(6, '0')}` : phone,
     email ?? null, SEED, metaLeadId, created]);
  return rows[0].id;
}

async function setSettings(patch) {
  const cols = Object.keys(patch).map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(`UPDATE coexistence.clo_settings SET ${cols} WHERE id = 1`, Object.values(patch));
}

// The skip decision has to be made INSIDE the test body. describe() bodies run
// at module load, before before() has had a chance to probe the database, so
// passing { skip: !dbUp } to test() would read dbUp while it is still false and
// skip the entire suite on a machine that does have a database.
const dbTest = (name, fn) => test(name, async (t) => {
  if (!dbUp) return t.skip('no database');
  await fn(t);
});

describe('eligibility gates', () => {
  dbTest('disabled feature produces no row at all', async () => {
    await setSettings({ enabled: false });
    const lead = await makeLead();
    const r = await d.enqueue(lead, 'hot');
    assert.strictEqual(r.status, 'noop');
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM coexistence.clo_events WHERE lead_id=$1`, [lead]);
    assert.strictEqual(rows[0].n, 0, 'a disabled feature must not write anything');
  });

  dbTest('an unmapped status produces no row', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const lead = await makeLead();
    assert.strictEqual((await d.enqueue(lead, 'contacted')).status, 'noop');
  });

  dbTest('dry run stores the payload but sends nothing', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const lead = await makeLead();
    const r = await d.enqueue(lead, 'hot');
    assert.strictEqual(r.status, 'dry_run');
    assert.strictEqual(r.row.payload.action_source, 'system_generated');
    assert.strictEqual(r.row.payload.user_data.lead_id, LEAD_ID);
    assert.strictEqual(metaCalls.length, 0, 'dry run must not call Meta');
  });

  dbTest('the 28-day boundary: 27d23h is in, 28d01h is out', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const inside = await makeLead({ agoDays: 27 + 23 / 24 });
    const outside = await makeLead({ agoDays: 28 + 1 / 24 });
    assert.strictEqual((await d.enqueue(inside, 'hot')).status, 'dry_run');
    assert.strictEqual((await d.enqueue(outside, 'hot')).status, 'skipped_out_of_window');
  });

  dbTest('no identifier at all is skipped with its own reason', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const lead = await makeLead({ metaLeadId: null, phone: '', email: null });
    assert.strictEqual((await d.enqueue(lead, 'hot')).status, 'skipped_no_identifier');
  });

  dbTest('a lead with no Meta id still goes out on hashed phone', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const lead = await makeLead({ metaLeadId: null });
    const r = await d.enqueue(lead, 'hot');
    assert.strictEqual(r.status, 'dry_run');
    assert.match(r.row.payload.user_data.ph, /^[a-f0-9]{64}$/);
    assert.strictEqual(r.row.payload.user_data.lead_id, undefined);
  });
});

describe('full path: stage change to sent', () => {
  dbTest('queues, transmits, and marks sent', async () => {
    await setSettings({
      enabled: true, dry_run: false,
      dataset_id: '999888777666555',
      access_token_encrypted: require('../src/util/crypto').encrypt('TEST_TOKEN'),
    });
    const lead = await makeLead();

    const q = await d.enqueue(lead, 'hot');
    assert.strictEqual(q.status, 'pending');

    metaReply = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'TRACE123' } };
    const f = await d.flush();
    assert.strictEqual(f.sent, 1);
    assert.strictEqual(metaCalls.length, 1);

    // The event that actually went over the wire.
    const sentEvent = metaCalls[0].body.data[0];
    assert.strictEqual(sentEvent.action_source, 'system_generated');
    assert.strictEqual(sentEvent.lead_event_source, 'Forge Growth');
    assert.strictEqual(sentEvent.user_data.lead_id, LEAD_ID);

    const { rows } = await pool.query(
      `SELECT status, attempts, fbtrace_id, sent_at FROM coexistence.clo_events WHERE lead_id=$1`, [lead]);
    assert.strictEqual(rows[0].status, 'sent');
    assert.strictEqual(rows[0].fbtrace_id, 'TRACE123');
    assert.ok(rows[0].sent_at);
  });

  dbTest('the same lead and stage is never sent twice', async () => {
    await setSettings({ enabled: true, dry_run: true });
    const lead = await makeLead();
    await pool.query(
      `INSERT INTO coexistence.clo_events (lead_id, stage_id, event_name, event_time, status)
       VALUES ($1,$2,'QualifiedLead',NOW(),'sent')`, [lead, stageId]);
    assert.strictEqual((await d.enqueue(lead, 'hot')).status, 'skipped_duplicate');
  });

  dbTest('a second pending row cannot be queued for the same pair', async () => {
    // Two pending rows in one flush batch would both try to become 'sent',
    // trip the unique index, and fail the entire batch.
    await setSettings({ enabled: true, dry_run: false, dataset_id: '999888777666555' });
    const lead = await makeLead();
    assert.strictEqual((await d.enqueue(lead, 'hot')).status, 'pending');
    assert.strictEqual((await d.enqueue(lead, 'hot')).status, 'skipped_duplicate');
  });

  dbTest('a 4xx from Meta is terminal, not retried forever', async () => {
    await setSettings({
      enabled: true, dry_run: false, dataset_id: '999888777666555',
      access_token_encrypted: require('../src/util/crypto').encrypt('TEST_TOKEN'),
    });
    const lead = await makeLead();
    await d.enqueue(lead, 'hot');

    metaReply = { ok: false, status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } };
    const f = await d.flush();
    assert.strictEqual(f.failed, 1);
    assert.strictEqual(f.retryable, false);

    const { rows } = await pool.query(`SELECT status, last_error FROM coexistence.clo_events WHERE lead_id=$1`, [lead]);
    assert.strictEqual(rows[0].status, 'failed', '4xx must not stay pending');
    assert.match(rows[0].last_error, /Invalid parameter/);
  });

  dbTest('a 5xx leaves the row pending for the next run', async () => {
    await setSettings({
      enabled: true, dry_run: false, dataset_id: '999888777666555',
      access_token_encrypted: require('../src/util/crypto').encrypt('TEST_TOKEN'),
    });
    const lead = await makeLead();
    await d.enqueue(lead, 'hot');

    metaReply = { ok: false, status: 503, body: { error: { message: 'Service unavailable' } } };
    const f = await d.flush();
    assert.strictEqual(f.retryable, true);

    const { rows } = await pool.query(`SELECT status, attempts FROM coexistence.clo_events WHERE lead_id=$1`, [lead]);
    assert.strictEqual(rows[0].status, 'pending', 'a transient failure must stay queued');
    assert.strictEqual(rows[0].attempts, 1);
  });
});

describe('secrets never reach storage', () => {
  dbTest('no stored payload contains a token', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.clo_events
        WHERE payload::text ILIKE '%access_token%'
           OR payload::text ILIKE '%TEST_TOKEN%'
           OR COALESCE(meta_response::text,'') ILIKE '%TEST_TOKEN%'`);
    assert.strictEqual(rows[0].n, 0);
  });
});
