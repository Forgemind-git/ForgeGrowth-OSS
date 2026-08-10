// Shared harness for the DB-backed integration suites.
//
// Every suite here talks to a REAL Postgres, because the thing worth testing in
// a route file is the SQL — a mocked pool would assert that we wrote the query
// we wrote, which proves nothing. Where there is no database the suites skip
// cleanly, so `npm test` still passes on a laptop that has only checked the
// repo out.
//
// ⚠ THE SKIP DECISION MUST BE MADE INSIDE THE TEST BODY, never as a
// `describe(..., { skip })` option. describe() callbacks run at module load,
// before before() can probe the database, so the option reads the flag while it
// is still false and skips the whole suite on a machine that HAS a database —
// the tests then "pass" everywhere by never running. This is the same trap the
// original CLO suite documented; keep using dbUp() inside each test.

const pool = require('../../src/db');

// Namespace for every row these suites create, so a crashed run is greppable
// and a cleanup can never touch real data.
//
// ⚠ IT IS PER-FILE, derived from the running test file's name. `node --test`
// runs test FILES CONCURRENTLY, and cleanup()/dropUsers() delete by
// `LIKE '%SEED%'` — with one shared namespace the first suite to finish wipes
// the WhatsApp account, users and formats the others are still using. The
// symptom is a handful of unrelated failures that all pass when the files are
// run one at a time, which reads as flakiness rather than as a harness bug.
const path = require('node:path');
const entry = process.argv[1] ? path.basename(process.argv[1]).replace(/\W+/g, '_') : 'shared';
const SEED = `__itest_${entry}__`;

let probed = false;
let up = false;

// ⚠ REQUIRE_DB=1 turns "no database" from a skip into a hard failure.
//
// Skipping is right on a laptop and wrong in CI: a workflow that runs `npm test`
// without a Postgres service reports every DB-backed suite as skipped and the
// job goes green, so the pipeline certifies a build that was never tested. The
// switch is opt-in, so nothing changes for a contributor running tests locally.
async function probe() {
  if (probed) return up;
  probed = true;
  try {
    await pool.query('SELECT 1');
    up = true;
  } catch (err) {
    up = false;
    if (process.env.REQUIRE_DB === '1') {
      throw new Error(
        `REQUIRE_DB=1 but no database is reachable (${err.message}). ` +
        'CI must not report skipped integration suites as a pass.'
      );
    }
  }
  return up;
}

function dbUp() {
  return up;
}

// Guard for the top of every test body: returns true when the test should stop.
// t.skip() marks it skipped rather than passed, so a machine with no database
// reports "skipped", not a false green.
function skipNoDb(t) {
  if (!up) {
    t.skip('no database reachable');
    return true;
  }
  return false;
}

// Delete anything this run created. Ordered child-first: these tables are
// FK-linked and a parent-first delete would be refused rather than cascading.
async function cleanup() {
  if (!up) return;
  const q = (sql, params = []) => pool.query(sql, params).catch(() => {});
  await q(`DELETE FROM coexistence.follow_up_log      WHERE enrollment_id IN (
             SELECT e.id FROM coexistence.follow_up_enrollments e
               JOIN coexistence.follow_up_sequences s ON s.id = e.sequence_id
              WHERE s.name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.follow_up_enrollments WHERE sequence_id IN (
             SELECT id FROM coexistence.follow_up_sequences WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.follow_up_steps     WHERE sequence_id IN (
             SELECT id FROM coexistence.follow_up_sequences WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.follow_up_sequences WHERE name LIKE $1`, [`%${SEED}%`]);

  await q(`DELETE FROM coexistence.wa_link_hits    WHERE wa_link_id IN (
             SELECT id FROM coexistence.wa_links WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.wa_link_clicks  WHERE target_id IN (
             SELECT t.id FROM coexistence.wa_link_targets t
               JOIN coexistence.wa_links l ON l.id = t.wa_link_id WHERE l.name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.wa_link_targets WHERE wa_link_id IN (
             SELECT id FROM coexistence.wa_links WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.wa_links        WHERE name LIKE $1`, [`%${SEED}%`]);

  // Forms: submissions first — they carry the FK. Missing this leaked 105 rows
  // across one afternoon of runs, because a form that is never deleted is not
  // an error anywhere; it just quietly accumulates.
  await q(`DELETE FROM coexistence.lead_form_submissions WHERE form_id IN (
             SELECT id FROM coexistence.lead_forms WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.lead_form_tokens WHERE form_id IN (
             SELECT id FROM coexistence.lead_forms WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.lead_forms      WHERE name LIKE $1`, [`%${SEED}%`]);

  await q(`DELETE FROM coexistence.entity_fields   WHERE label LIKE $1`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.lead_events     WHERE lead_id IN (
             SELECT id FROM coexistence.leads WHERE name LIKE $1)`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.leads           WHERE name LIKE $1`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.message_templates WHERE name LIKE $1`, [`%${SEED.replace(/_/g, '\\_')}%`]);
  await q(`DELETE FROM coexistence.projects        WHERE name LIKE $1`, [`%${SEED}%`]);
  await q(`DELETE FROM coexistence.whatsapp_accounts WHERE display_name LIKE $1`, [`%${SEED}%`]);
}

// A lead is the join key for follow-ups, variables and message-format
// attribution, so most suites need one. Digits-only phone, per the invariant.
async function makeLead({ phone, name = `Lead ${SEED}`, stage = null, extra = {} } = {}) {
  const stageKey = stage || (await firstStageKey());
  const cols = ['whatsapp_number', 'name', 'stage'];
  const vals = [phone, name, stageKey];
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO coexistence.leads (${cols.join(', ')}) VALUES (${ph})
     ON CONFLICT (whatsapp_number) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`, vals);
  return rows[0];
}

async function firstStageKey() {
  const { rows } = await pool.query(
    `SELECT stage_key FROM coexistence.funnel_stages
      WHERE active = TRUE ORDER BY order_index LIMIT 1`);
  return rows[0]?.stage_key || 'new';
}

async function wonStageKey() {
  const { rows } = await pool.query(
    `SELECT stage_key FROM coexistence.funnel_stages
      WHERE active = TRUE AND is_won = TRUE ORDER BY order_index LIMIT 1`);
  return rows[0]?.stage_key || null;
}

// A REAL user row. requirePermission() re-loads the user from the database to
// honour per-user overrides, so a stub req.user with an id that does not exist
// is rejected as 401 "user not found" — which looks like a passing
// authorisation test while actually testing nothing. Suites that exercise a
// permission gate need a row that is really there.
async function makeUser(role = 'viewer') {
  const username = `itest_${role}_${SEED}`;
  // `password` holds a bcrypt hash in real rows. A literal that is not a valid
  // hash is deliberate here: it can never authenticate, so this row cannot
  // become a login even if a cleanup is missed.
  const { rows } = await pool.query(
    `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role, is_active)
     VALUES ($1, $2, 'not-a-usable-hash', $3, $4, TRUE)
     ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE
     RETURNING id, username, display_name, role`,
    [username, `${username}@example.com`, `ITest ${role}`, role]);
  return { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name, role: rows[0].role };
}

async function dropUsers() {
  // Scoped by the per-file SEED alone — it is already unique, and it keeps this
  // delete from reaching another suite's user row while that suite is running.
  await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE $1`,
    [`%${SEED}%`]).catch(() => {});
}

// Close every handle the suite opened. Without this the pg pool (and, for any
// suite that pulls in the send queue, its Redis connection) keeps the event
// loop alive and `npm test` hangs with no output — TAP is buffered through a
// pipe, so it looks like the run froze rather than finished.
async function teardown() {
  await cleanup();
  await dropUsers();
  await pool.end().catch(() => {});
}

module.exports = {
  pool, SEED, probe, dbUp, skipNoDb, cleanup, teardown,
  makeLead, makeUser, dropUsers, firstStageKey, wonStageKey,
};
