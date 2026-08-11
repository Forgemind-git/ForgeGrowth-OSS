#!/usr/bin/env node
//
// Apply every migration this image carries, in filename order, then exit.
//
// WHY THIS EXISTS ALONGSIDE scripts/migrate.sh
// -------------------------------------------
// migrate.sh shells out to `docker compose exec postgres psql` and reads the SQL
// off the host's repo. That is fine when you have the source tree — and useless
// for the image-only install, which has no repo and no psql on the host. This
// runner uses the `pg` client the backend already depends on and reads the
// migrations baked into the image at /app/migrations, so `docker compose up` on
// a machine holding nothing but a compose file brings up a correct schema.
//
// Both paths are safe to mix: they apply the same files in the same order, and
// the ledger below is advisory rather than authoritative (see IDEMPOTENCE).
//
// IDEMPOTENCE
// -----------
// Every migration in this project is required to be re-runnable (CREATE TABLE IF
// NOT EXISTS, guarded ALTERs) because re-running them is the documented upgrade
// path. So the ledger is an optimisation — it stops us replaying 88 files on
// every container start — and NOT a correctness guarantee. A file missing from
// the ledger but already applied must still succeed, which is exactly what
// idempotence buys. That is why a failure here is loud: it means a migration is
// not actually idempotent, and that is a bug in the migration.
//
// CONCURRENCY
// -----------
// Two backend containers starting at once would otherwise both run the same
// CREATE TABLE and one would lose. A session-level advisory lock serialises
// them: the second waits, then finds the ledger already populated and does
// nothing. The lock is taken on the connection and released when it closes.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// A constant, arbitrary key. Any other process using advisory locks on this
// database must not reuse it.
const LOCK_KEY = 8472_1990;

const LEDGER = 'public.forgegrowth_migrations';

function migrationsDir() {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // Baked location inside the image.
  const baked = '/app/migrations';
  if (fs.existsSync(baked)) return baked;
  // Running from a source checkout (npm script, not a container).
  return path.resolve(__dirname, '../../supabase/migrations');
}

function clientConfig() {
  // Deliberately mirrors backend/src/db.js, including its POSTGRES_* / DB_*
  // dual-prefix rule. Diverging here would produce a container that migrates
  // one database and then serves another.
  if (process.env.SUPABASE_DATABASE_URL) {
    return {
      connectionString: process.env.SUPABASE_DATABASE_URL,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
  }
  const env = process.env;
  return {
    host: env.POSTGRES_HOST || env.DB_HOST || 'localhost',
    port: parseInt(env.POSTGRES_PORT || env.DB_PORT || '5432', 10),
    database: env.POSTGRES_DB || env.DB_NAME || 'postgres',
    user: env.POSTGRES_USER || env.DB_USER || 'postgres',
    password: env.POSTGRES_PASSWORD || env.DB_PASSWORD || '',
    ssl: env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'forgegrowth-migrate',
  };
}

// Postgres is reachable seconds after its container reports "started". Compose
// healthchecks cover the bundled stack, but an external database (DEPLOY.md's
// path) has no such gate, so wait rather than crash-loop.
async function connectWithRetry(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    const client = new Client(clientConfig());
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i === attempts) {
        // err.code, not just err.message: a refused connection surfaces as
        // ECONNREFUSED with an EMPTY message, so reporting the message alone
        // produced "database unreachable after 30 attempts:" and named nothing.
        const why = err.code || err.message || 'unknown error';
        throw new Error(
          `database unreachable after ${attempts} attempts (${why}). ` +
          `Tried ${process.env.POSTGRES_HOST || process.env.DB_HOST || 'localhost'}:` +
          `${process.env.POSTGRES_PORT || process.env.DB_PORT || '5432'}.`
        );
      }
      if (i === 1) console.log(`[migrate] waiting for database… (${err.code || err.message})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`migrations directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`no .sql files in ${dir}`);
  }

  const client = await connectWithRetry();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const { rows } = await client.query(`SELECT filename FROM ${LEDGER}`);
    const done = new Set(rows.map((r) => r.filename));
    const pending = files.filter((f) => !done.has(f));

    if (pending.length === 0) {
      console.log(`[migrate] ${files.length} migration(s) already applied; nothing to do.`);
      return;
    }
    console.log(`[migrate] applying ${pending.length} of ${files.length} migration(s) from ${dir}`);

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      process.stdout.write(`[migrate]   ${file.padEnd(46)}`);
      try {
        // Sent as ONE simple-query message, which is what makes this atomic
        // without a wrapper: Postgres runs a multi-statement string in an
        // implicit transaction, so a failure at statement 9 rolls back 1-8.
        //
        // ⚠ Do not add an explicit BEGIN/COMMIT around this. Three migrations
        // (082, 093, 094) open and close their own transaction, and a wrapper's
        // COMMIT boundary would then be decided by the file rather than by us —
        // the file's COMMIT would close the outer transaction early and every
        // later statement would run unprotected.
        await client.query(sql);
        // Recorded separately, and therefore not atomic with the DDL above. That
        // is deliberate and safe: if the process dies in this gap the migration
        // is applied but unrecorded, so the next start simply re-applies an
        // idempotent file. The reverse (recorded but not applied) is the
        // dangerous ordering, and it cannot happen this way round.
        await client.query(`INSERT INTO ${LEDGER} (filename) VALUES ($1)
                            ON CONFLICT (filename) DO NOTHING`, [file]);
        console.log('ok');
      } catch (err) {
        console.log('FAILED');
        throw new Error(
          `migration ${file} failed: ${err.message}\n` +
          'Every migration here must be idempotent (re-runnable). If this file ' +
          'was already applied by hand or by scripts/migrate.sh, the failure means ' +
          'it is not — fix the migration rather than skipping it.'
        );
      }
    }
    console.log(`[migrate] applied ${pending.length} migration(s).`);
  } finally {
    // Releases the advisory lock with it.
    await client.end().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[migrate] ${err.message}`);
    process.exit(1);
  },
);
