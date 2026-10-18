// Read-only connection to the SEPARATE `evolution` database.
//
// WhatsApp GROUPS only exist here. The Chats section runs on the Meta Cloud
// API, which by design delivers 1:1 customer conversations and never group
// traffic — so the Communities section reads a different database entirely.
//
// READ-ONLY IS ENFORCED BY POSTGRES, NOT BY THIS FILE.
// The `forgegrowth_ro` role is granted SELECT only and carries
// `default_transaction_read_only = on`, so an accidental INSERT/UPDATE/DELETE
// is refused by the server even if someone writes one here. Evolution owns
// that data; we are a guest in it.
//
// The pool is OPTIONAL. If the credentials are absent the export is null and
// the Communities routes answer with a clear "not configured" message — a
// missing or down Evolution must never take the rest of the backend with it.

const { Pool } = require('pg');

const PASSWORD = process.env.EVOLUTION_RO_PASSWORD || '';

function buildPool() {
  if (!PASSWORD) {
    console.warn('[evolutionDb] EVOLUTION_RO_PASSWORD not set — Communities section disabled');
    return null;
  }
  const pool = new Pool({
    host: process.env.EVOLUTION_DB_HOST || 'evolution-postgres',
    port: parseInt(process.env.EVOLUTION_DB_PORT || '5432', 10),
    database: process.env.EVOLUTION_DB_NAME || 'evolution',
    user: process.env.EVOLUTION_DB_USER || 'forgegrowth_ro',
    password: PASSWORD,
    ssl: false,
    // Deliberately small: this is a browsing surface, not a hot path, and the
    // pool must never starve Evolution's own connections.
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'forgegrowth-communities-ro',
  });

  // An unreachable Evolution is an expected state (container restart, network
  // blip), not a crash. Log and let the next query surface it to the caller.
  pool.on('error', (err) => {
    console.error('[evolutionDb] pool error:', err.message);
  });

  return pool;
}

const evolutionPool = buildPool();

module.exports = evolutionPool;
