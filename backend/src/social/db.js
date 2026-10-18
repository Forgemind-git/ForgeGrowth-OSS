const socialEnv = require('./env');
const { Pool, types } = require('pg');

// The Social section's own pool: same database as ForgeGrowth, its own schema
// (search_path = social, public), so the ported ForgeSocial SQL runs unchanged.
//
// ForgeSocial parsed dates as strings and bigints as numbers by calling
// pg.types.setTypeParser — which is GLOBAL to the pg module and would silently
// change every ForgeGrowth query result in this shared process. These parsers
// are therefore scoped to this pool only, via the per-pool `types` option.
const DATE_OID = 1082;
const INT8_OID = 20;
const socialTypes = {
  getTypeParser(oid, format) {
    if (oid === DATE_OID) return v => v;
    if (oid === INT8_OID) return v => parseInt(v, 10);
    return types.getTypeParser(oid, format);
  },
};

const schema = socialEnv.DB_SCHEMA;
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid SOCIAL_DB_SCHEMA: ${schema}`);

const common = {
  types: socialTypes,
  max: 5,
  idleTimeoutMillis: 30000,
  application_name: 'forgegrowth-social',
};

const pool = socialEnv.SUPABASE_DATABASE_URL
  ? new Pool({
      ...common,
      connectionString: socialEnv.SUPABASE_DATABASE_URL,
      ssl: socialEnv.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  : new Pool({
      ...common,
      // Same rule as src/db.js — POSTGRES_* wins, DB_* is accepted — so the
      // Social section always lands in the database the rest of the app uses.
      host: socialEnv.POSTGRES_HOST || socialEnv.DB_HOST || 'localhost',
      port: parseInt(socialEnv.POSTGRES_PORT || socialEnv.DB_PORT || '5432', 10),
      database: socialEnv.POSTGRES_DB || socialEnv.DB_NAME || 'postgres',
      user: socialEnv.POSTGRES_USER || socialEnv.DB_USER || 'postgres',
      password: socialEnv.POSTGRES_PASSWORD || socialEnv.DB_PASSWORD || '',
      ssl: socialEnv.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

pool.on('connect', (client) => {
  client.query(`SET search_path TO ${schema}, public`).catch(err => {
    console.error('[social] search_path set failed', err.message);
  });
});

pool.on('error', (err) => {
  console.error('[social] pg pool error', err.message);
});

pool.schema = schema;
module.exports = pool;
