// The domains this install answers to.
//
// Implemented once here because two very different callers need the same answer
// and must never disagree: the CORS origin check (every browser request) and
// Caddy's on-demand-TLS `ask` endpoint (every first TLS handshake for a new
// hostname). If those two drifted apart you would get a site that holds a valid
// certificate and then refuses its own API calls with a generic 500 — which
// reads as "the app is broken", not as a configuration mismatch.
//
// See routes/domains.js for the HTTP surface and supabase/migrations/109 for why
// this lives in the database rather than in .env.

const pool = require('../db');

/* ------------------------------------------------------------------ table */

async function ensureDomainTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.custom_domains (
        id            BIGSERIAL PRIMARY KEY,
        hostname      TEXT NOT NULL UNIQUE,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        added_by      BIGINT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_asked_at TIMESTAMPTZ,
        last_seen_at  TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS custom_domains_active_idx
        ON coexistence.custom_domains (hostname) WHERE is_active
    `);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------- normalise */

// One spelling reaches storage and lookup, or the Host header will not match
// what an admin typed. Strips scheme, port, path, trailing dot and case — all of
// which describe the same host and none of which appear in a Host header the way
// a person types them.
function normalizeHostname(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  h = h.split('/')[0];                            // path
  h = h.split('@').pop();                         // stray credentials
  if (h.startsWith('[')) {                        // bracketed IPv6 keeps its brackets
    const close = h.indexOf(']');
    if (close > 0) h = h.slice(0, close + 1);
  } else {
    h = h.split(':')[0];                          // port
  }
  h = h.replace(/\.$/, '');                       // fully-qualified trailing dot
  return h;
}

// Deliberately strict, because every accepted value becomes something Caddy will
// try to obtain a public certificate for. A wildcard or a bare label cannot get
// one, so refusing here turns a silent ACME failure into an immediate message.
function validateHostname(host) {
  if (!host) return 'Enter a domain, for example crm.example.com';
  if (host.length > 253) return 'That domain is too long';
  if (host === 'localhost') return 'localhost does not need to be added — it always works';
  if (!/^[a-z0-9.-]+$/.test(host)) return 'A domain can only contain letters, numbers, dots and hyphens';
  if (host.includes('..') || host.startsWith('-') || host.startsWith('.') || host.endsWith('-')) {
    return 'That does not look like a valid domain';
  }
  if (!host.includes('.')) return 'Use the full domain, for example crm.example.com';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return 'A certificate cannot be issued for an IP address — use a domain name';
  }
  if (host.startsWith('*')) return 'Wildcard domains are not supported';
  return null;
}

/* ----------------------------------------------------------------- lookup */

// CORS consults this on every browser request, so it cannot be a query each
// time. A short TTL rather than explicit invalidation because the cost of being
// ten seconds stale is that a just-added domain waits ten seconds, while the
// cost of a missed invalidation is a domain that never works until a restart.
let cache = { at: 0, hosts: new Set() };
const CACHE_MS = 10_000;

async function activeHostnames() {
  if (Date.now() - cache.at < CACHE_MS) return cache.hosts;
  try {
    const { rows } = await pool.query(
      'SELECT hostname FROM coexistence.custom_domains WHERE is_active'
    );
    cache = { at: Date.now(), hosts: new Set(rows.map((r) => r.hostname)) };
  } catch (err) {
    // A database blip must not lock every browser out of the app. Serve the last
    // known set and try again on the next request.
    console.error('[domains] could not refresh the domain list:', err.message);
    cache.at = Date.now();
  }
  return cache.hosts;
}

function invalidateCache() {
  cache = { at: 0, hosts: cache.hosts };
}

async function isApproved(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  return (await activeHostnames()).has(h);
}

// The origins CORS should accept, derived from the same list. Both schemes are
// returned: the app cannot know from here whether a proxy in front terminates
// TLS, and offering only https would break a plain-HTTP install the moment an
// admin added its domain.
async function allowedOriginsFromDb() {
  const out = [];
  for (const h of await activeHostnames()) {
    out.push(`https://${h}`, `http://${h}`);
  }
  return out;
}

/* ------------------------------------------------------------------ writes */

async function listDomains() {
  const { rows } = await pool.query(`
    SELECT id,
           hostname,
           is_active     AS "isActive",
           created_at    AS "createdAt",
           last_asked_at AS "lastAskedAt",
           last_seen_at  AS "lastSeenAt"
      FROM coexistence.custom_domains
     ORDER BY hostname
  `);
  return rows;
}

async function addDomain(rawHost, userId) {
  const hostname = normalizeHostname(rawHost);
  const problem = validateHostname(hostname);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO coexistence.custom_domains (hostname, added_by)
          VALUES ($1, $2)
     ON CONFLICT (hostname)
     DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING id, hostname, is_active AS "isActive", created_at AS "createdAt"`,
    [hostname, userId || null]
  );
  invalidateCache();
  return rows[0];
}

async function setActive(id, isActive) {
  const { rows } = await pool.query(
    `UPDATE coexistence.custom_domains
        SET is_active = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, hostname, is_active AS "isActive"`,
    [id, !!isActive]
  );
  invalidateCache();
  return rows[0] || null;
}

async function removeDomain(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.custom_domains WHERE id = $1',
    [id]
  );
  invalidateCache();
  return rowCount > 0;
}

// Best-effort stamps. Never awaited by the caller and never allowed to throw:
// these are diagnostics, and a failed UPDATE must not turn into a refused
// certificate or a rejected request.
function stampAsked(hostname) {
  pool.query(
    'UPDATE coexistence.custom_domains SET last_asked_at = NOW() WHERE hostname = $1',
    [hostname]
  ).catch(() => {});
}

function stampSeen(hostname) {
  pool.query(
    'UPDATE coexistence.custom_domains SET last_seen_at = NOW() WHERE hostname = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL \'5 minutes\')',
    [hostname]
  ).catch(() => {});
}

module.exports = {
  ensureDomainTables,
  normalizeHostname,
  validateHostname,
  isApproved,
  allowedOriginsFromDb,
  activeHostnames,
  invalidateCache,
  listDomains,
  addDomain,
  setActive,
  removeDomain,
  stampAsked,
  stampSeen,
};
