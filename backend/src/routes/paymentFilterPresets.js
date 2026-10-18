// Sales → Payments → Dashboard — saved filter presets (migration 129).
//
//   GET    /payment-filter-presets?scope=dashboard|ledger   my presets for that tab, default first
//   POST   /payment-filter-presets  {scope, name, filters, isDefault?}
//   PUT    /payment-filter-presets/:id {name?, filters?, isDefault?}
//   DELETE /payment-filter-presets/:id
//
// `scope` = which Payments tab the view belongs to (migration 130): Dashboard or
// All payments. Names and the default are unique per user per tab.
//
// Private to the user who saved them: every query is scoped by req.user.id, so
// one person's presets can neither be listed nor changed by another. The
// filters object belongs to the page; the server only checks it is a plain
// object of sane size. Not exposed over MCP — a viewing preference has no
// meaning for a connector (PROXY_AREAS is default-deny, so it stays closed).

const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');

const router = Router();

const MAX_PRESETS = 50;
const MAX_NAME = 60;
const MAX_FILTERS_BYTES = 4000;
const SCOPES = ['dashboard', 'ledger'];

async function ensurePresetTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.payment_filter_presets (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_default  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // 130: scope per tab. The old indexes were per user; the new ones per user per tab.
  await pool.query(`ALTER TABLE coexistence.payment_filter_presets
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'dashboard'`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_filter_presets_scope_check') THEN
      ALTER TABLE coexistence.payment_filter_presets
        ADD CONSTRAINT payment_filter_presets_scope_check CHECK (scope IN ('dashboard', 'ledger'));
    END IF;
  END $$`);
  await pool.query('DROP INDEX IF EXISTS coexistence.uq_payment_filter_presets_name');
  await pool.query('DROP INDEX IF EXISTS coexistence.uq_payment_filter_presets_default');
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_scope_name
    ON coexistence.payment_filter_presets (user_id, scope, lower(name))`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_scope_default
    ON coexistence.payment_filter_presets (user_id, scope) WHERE is_default`);
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function cleanName(v) {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw bad('Give the preset a name.');
  if (n.length > MAX_NAME) throw bad(`Keep the name under ${MAX_NAME} characters.`);
  return n;
}
function cleanFilters(v) {
  // An array passes `typeof === 'object'` — refuse it explicitly.
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('filters must be an object.');
  const s = JSON.stringify(v);
  if (s.length > MAX_FILTERS_BYTES) throw bad('That filter combination is too large to save.');
  return s;
}
// A missing scope means the Dashboard — that is what every pre-130 caller meant.
function cleanScope(v) {
  if (v === undefined || v === null || v === '') return 'dashboard';
  if (!SCOPES.includes(v)) throw bad(`scope must be one of: ${SCOPES.join(', ')}.`);
  return v;
}
function cleanBool(v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw bad('isDefault must be true or false.');
  return v;
}

const rowOut = (r) => ({
  id: Number(r.id), scope: r.scope, name: r.name, filters: r.filters || {}, isDefault: r.is_default,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'You already have a preset with that name — pick another or update that one.' });
    if (!e.status) console.error('[payment-filter-presets]', req.method, req.path, e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong — try again' });
  }
};

const gate = requirePermission('payments');

router.get('/payment-filter-presets', gate, wrap(async (req) => {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.payment_filter_presets WHERE user_id = $1 AND scope = $2
      ORDER BY is_default DESC, lower(name)`, [req.user.id, cleanScope(req.query.scope)]);
  return { presets: rows.map(rowOut) };
}));

router.post('/payment-filter-presets', gate, wrap(async (req) => {
  const b = req.body || {};
  const scope = cleanScope(b.scope);
  const name = cleanName(b.name);
  const filters = cleanFilters(b.filters);
  const isDefault = cleanBool(b.isDefault) === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ n }] } = await client.query(
      'SELECT COUNT(*)::int AS n FROM coexistence.payment_filter_presets WHERE user_id = $1 AND scope = $2', [req.user.id, scope]);
    if (n >= MAX_PRESETS) throw bad(`You can keep up to ${MAX_PRESETS} presets — delete one first.`);
    if (isDefault) {
      await client.query(`UPDATE coexistence.payment_filter_presets SET is_default = FALSE
        WHERE user_id = $1 AND scope = $2 AND is_default`, [req.user.id, scope]);
    }
    const { rows: [r] } = await client.query(
      `INSERT INTO coexistence.payment_filter_presets (user_id, scope, name, filters, is_default)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`, [req.user.id, scope, name, filters, isDefault]);
    await client.query('COMMIT');
    return { preset: rowOut(r) };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));

router.put('/payment-filter-presets/:id', gate, wrap(async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Preset not found.', 404);
  const b = req.body || {};
  const name = b.name !== undefined ? cleanName(b.name) : undefined;
  const filters = b.filters !== undefined ? cleanFilters(b.filters) : undefined;
  const isDefault = cleanBool(b.isDefault);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault === true) {
      // Only the other views on the SAME tab stop being the default.
      await client.query(`UPDATE coexistence.payment_filter_presets p SET is_default = FALSE
         FROM coexistence.payment_filter_presets t
        WHERE t.id = $2 AND t.user_id = $1
          AND p.user_id = $1 AND p.scope = t.scope AND p.is_default AND p.id <> $2`, [req.user.id, id]);
    }
    // Omitted fields stay as they are (COALESCE on NULL params).
    const { rows: [r] } = await client.query(
      `UPDATE coexistence.payment_filter_presets
          SET name = COALESCE($3, name),
              filters = COALESCE($4::jsonb, filters),
              is_default = COALESCE($5, is_default),
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *`, [id, req.user.id, name ?? null, filters ?? null, isDefault ?? null]);
    if (!r) throw bad('Preset not found.', 404);
    await client.query('COMMIT');
    return { preset: rowOut(r) };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));

router.delete('/payment-filter-presets/:id', gate, wrap(async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Preset not found.', 404);
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.payment_filter_presets WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!rowCount) throw bad('Preset not found.', 404);
  return { ok: true };
}));

module.exports = { router, ensurePresetTables };
