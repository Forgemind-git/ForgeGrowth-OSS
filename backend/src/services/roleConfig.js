// ─── User roles: admin / sales / service, and any role you add ───────────────
//
// Roles used to be a hardcoded map in permissions.js plus a CHECK constraint on
// forgecrm_users.role, so adding one meant a code change AND a migration. They
// are now rows, editable in Admin Settings → Users, on the same stable-key
// design as funnel_stages:
//
//   role_key   IMMUTABLE. forgecrm_users.role stores this, and `admin` is
//              compared against it in ~40 places. Renaming it would silently
//              orphan every user holding it, so only the LABEL is editable.
//   pages      the page keys this role may reach, on top of which each user's
//              own permissions JSONB can grant/revoke.
//
// ⚠ `admin` IS NOT ORDINARY DATA.
// isAdmin() and the adminOnly middleware compare against the literal 'admin',
// and this settings screen is itself admin-gated. If an admin could delete the
// role, or edit its page list, they could lock every user — including
// themselves — out of the only screen that could undo it. So the admin row is
// `is_system`: relabel it freely, but it cannot be deleted, deactivated, or
// have its page list narrowed. Same shape as the funnel's "you cannot delete
// the only won stage" guard.
//
// ⚠ THIS CACHE IS NOT THE VALIDATOR.
// Anything that VALIDATES a role key must read the table, not this cache — a
// cache is warm in the running app and empty everywhere else, so a validator
// built on it silently accepts anything wherever it has not been loaded.
// (Learned from sanitizeStageKeys; see feedback-cache-backed-validation.)

const pool = require('../db');

// Seeded once. After that the rows are the authority — re-running the ensure
// must never rewrite an admin's edits.
const SEED = [
  {
    key: 'admin', label: 'Admin', isSystem: true, sort: 0,
    description: 'Full access to everything, including these settings.',
  },
  {
    key: 'sales', label: 'Sales', isSystem: false, sort: 1,
    description: 'Works the funnel: their own leads, sales log and payments.',
    pages: [
      'home', 'chats', 'pipelines',
      'sales-pipeline', 'leads', 'onboarding',
      'sales-funnel', 'sales-log',
      'payments',
      'admin-settings:general',
    ],
  },
  {
    key: 'service', label: 'Service', isSystem: false, sort: 2,
    description: 'Answers conversations. Reads the funnel but does not sell.',
    pages: [
      'home', 'chats',
      'leads', 'sales-funnel',
      'template-builder', 'media-library',
      'admin-settings:general',
    ],
  },
];

async function ensureRoleTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.user_roles (
      role_key    TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      description TEXT,
      pages       JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_system   BOOLEAN NOT NULL DEFAULT FALSE,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order  INT NOT NULL DEFAULT 100,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);

  // The old CHECK froze the role list into the schema. Dropping it is what
  // makes "add a role" a row insert rather than a migration — exactly why the
  // funnel work dropped the equivalent CHECK on leads.stage.
  await pool.query(`
    ALTER TABLE coexistence.forgecrm_users
      DROP CONSTRAINT IF EXISTS forgecrm_users_role_check;`);

  const { PAGES } = require('../permissions');
  for (const r of SEED) {
    // ⚠ DO NOTHING is wrong here. Migration 107 inserts these rows with an
    // EMPTY page list (it cannot know the live PAGES array), so a plain
    // DO NOTHING leaves Sales and Service granting NOTHING — they exist, they
    // are assignable, and every holder logs in to an empty app. Fill the pages
    // only while they are still empty, which is the first boot after the
    // migration; an admin's later edit is never overwritten.
    //
    // Admin is refreshed every boot on purpose: its list must be every page,
    // and a page added later would otherwise leave it stale. (isAdmin()
    // short-circuits the check anyway — this keeps the stored row honest.)
    await pool.query(
      `INSERT INTO coexistence.user_roles (role_key, label, description, pages, is_system, sort_order)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (role_key) DO UPDATE
          SET pages = EXCLUDED.pages, updated_at = NOW()
        WHERE coexistence.user_roles.pages = '[]'::jsonb
           OR coexistence.user_roles.is_system = TRUE`,
      [r.key, r.label, r.description,
       JSON.stringify(r.isSystem ? PAGES : (r.pages || [])), r.isSystem, r.sort],
    );
  }

  // Carry the pre-107 roles across. Nothing else referenced them, and on this
  // instance there were none — the UPDATE is here so a copy of the database
  // taken before the rename lands on a valid role instead of an orphan.
  await pool.query(`UPDATE coexistence.forgecrm_users SET role='sales'   WHERE role='bda_sales';`);
  await pool.query(`UPDATE coexistence.forgecrm_users SET role='service' WHERE role='viewer';`);

  await refreshRoles();
}

// ── cache ────────────────────────────────────────────────────────────────────
let _roles = [];

async function refreshRoles() {
  try {
    const { rows } = await pool.query(
      `SELECT role_key, label, description, pages, is_system, active, sort_order
         FROM coexistence.user_roles ORDER BY sort_order, label`);
    _roles = rows.map(rowToRole);
  } catch (err) {
    console.error('[roles] refresh failed:', err.message);
  }
  return _roles;
}

const rowToRole = (r) => ({
  key: r.role_key,
  label: r.label,
  description: r.description || '',
  // The admin row's stored list is a snapshot; isAdmin() short-circuits every
  // check anyway, so the live PAGES list is the honest answer for it.
  pages: r.role_key === 'admin'
    ? require('../permissions').PAGES.slice()
    : (Array.isArray(r.pages) ? r.pages : []),
  isSystem: r.is_system === true,
  active: r.active !== false,
  sortOrder: Number(r.sort_order || 100),
});

const roles = () => _roles;
const activeRoles = () => _roles.filter(r => r.active);
const roleByKey = (key) => _roles.find(r => r.key === String(key || '')) || null;
const pagesForRole = (key) => (roleByKey(key)?.pages) || [];

/**
 * Is this a role a user may be given?
 *
 * ⚠ Reads the TABLE, never the cache. A validator on a cache accepts anything
 * wherever the cache is cold, and "role: banana" would then be stored and
 * resolve to no pages at all — a user who can log in and reach nothing.
 */
async function isAssignableRole(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.user_roles WHERE role_key = $1 AND active = TRUE`, [k]);
  return rows.length > 0;
}

module.exports = {
  ensureRoleTables, refreshRoles,
  roles, activeRoles, roleByKey, pagesForRole, isAssignableRole,
  SEED,
};
