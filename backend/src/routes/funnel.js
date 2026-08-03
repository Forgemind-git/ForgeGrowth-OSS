// Funnel labeling config + viewer (migration 064). Mounted under /api with
// authMiddleware in index.js.
//
// The funnel stages/sources were previously hardcoded; this makes them
// user-configurable while keeping a stable internal stage_key (see
// services/funnelConfig.js). Reads are open to any authed user; mutations are
// adminOnly. Every mutation refreshes the shared in-process cache.
//
// Endpoints:
//   GET    /funnel/config                 { stages[], sources[] } — the whole UI reads this
//   GET    /funnel/chart                  funnel counts per stage (filter: source, date range)
//   POST   /funnel/stages                 add stage (server slugifies label → stage_key)   [admin]
//   PUT    /funnel/stages/reorder         { order: [id,...] } → order_index                 [admin]
//   PUT    /funnel/stages/:id             rename / recolor / toggle is_won (key immutable)  [admin]
//   DELETE /funnel/stages/:id             remove (409 if leads reference it / last won)     [admin]
//   GET    /funnel/sources                list sources (active + inactive)                  [admin]
//   POST   /funnel/sources                add source                                        [admin]
//   PUT    /funnel/sources/:id            rename / toggle active                            [admin]
//   DELETE /funnel/sources/:id            remove (or soft-deactivate if in use)             [admin]

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const cfg = require('../services/funnelConfig');

const router = Router();

// ── self-healing table bootstrap (mirror of migration 064) ────────────────────
async function ensureFunnelTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.funnel_stages (
      id           BIGSERIAL PRIMARY KEY,
      stage_key    TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL,
      color        TEXT,
      order_index  INT  NOT NULL,
      is_funnel    BOOLEAN NOT NULL DEFAULT TRUE,
      is_won       BOOLEAN NOT NULL DEFAULT FALSE,
      is_default   BOOLEAN NOT NULL DEFAULT FALSE,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funnel_stages_order ON coexistence.funnel_stages(order_index);`);
  // Seed the current live keys if the table is empty (keeps the app working).
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.funnel_stages`);
  if (!rows[0].n) {
    await pool.query(`
      INSERT INTO coexistence.funnel_stages (stage_key, label, color, order_index, is_funnel, is_won, is_default) VALUES
        ('new',       'New',         '#64748b', 1, TRUE,  FALSE, TRUE),
        ('contacted', 'Contacted',   '#3b82f6', 2, TRUE,  FALSE, TRUE),
        ('engaged',   'Engaged',     '#8b5cf6', 3, TRUE,  FALSE, TRUE),
        ('hot',       'Hot',         '#f59e0b', 4, TRUE,  FALSE, TRUE),
        ('enrolled',  'Enrolled',    '#22c55e', 5, TRUE,  TRUE,  TRUE),
        ('cold_lost', 'Cold / Lost', '#ef4444', 6, FALSE, FALSE, TRUE)
      ON CONFLICT (stage_key) DO NOTHING;
    `);
  }
  await pool.query(`ALTER TABLE coexistence.leads DROP CONSTRAINT IF EXISTS leads_stage_check;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.funnel_sources (
      id         BIGSERIAL PRIMARY KEY,
      label      TEXT NOT NULL UNIQUE,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Seed sources only from real lead sources already present (no invented values).
  await pool.query(`
    INSERT INTO coexistence.funnel_sources (label)
      SELECT DISTINCT TRIM(source) FROM coexistence.leads
       WHERE source IS NOT NULL AND TRIM(source) <> ''
    ON CONFLICT (label) DO NOTHING;
  `);
  await cfg.refreshFunnelConfig();
}

// slugify a label into a stable stage_key; ensure uniqueness against existing keys.
async function uniqueStageKey(label) {
  const base = String(label || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'stage';
  let key = base;
  for (let n = 2; ; n++) {
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.funnel_stages WHERE stage_key = $1`, [key]);
    if (!rows.length) return key;
    key = `${base}_${n}`;
  }
}

const isAdmin = (req) => req.user?.role === 'admin';

// ── config (whole UI reads this) ──────────────────────────────────────────────
router.get('/funnel/config', (req, res) => {
  res.json({ stages: cfg.stages(), sources: cfg.sources() });
});

// ── funnel chart (counts per funnel stage, filterable) ────────────────────────
router.get('/funnel/chart', async (req, res) => {
  try {
    const { source, from, to } = req.query;
    const dateField = req.query.dateField === 'created_at' ? 'created_at' : 'stage_changed_at';
    const where = ['1=1'];
    const params = [];
    // Non-admins only see their own leads (mirrors the board scope).
    if (!isAdmin(req)) { params.push(parseInt(req.user.id, 10)); where.push(`assigned_user_id = $${params.length}`); }
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    if (from) { params.push(from); where.push(`${dateField} >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`${dateField} < ($${params.length}::date + INTERVAL '1 day')`); }

    const { rows } = await pool.query(
      `SELECT stage, COUNT(*)::int AS n FROM coexistence.leads WHERE ${where.join(' AND ')} GROUP BY stage`,
      params
    );
    const counts = {};
    for (const r of rows) counts[r.stage] = r.n;

    // Emit funnel stages in configured order; include branch-off stages separately.
    const funnel = cfg.stages().filter(s => s.isFunnel).map(s => ({
      stageKey: s.stageKey, label: s.label, color: s.color, order: s.orderIndex, count: counts[s.stageKey] || 0,
    }));
    const branches = cfg.stages().filter(s => !s.isFunnel).map(s => ({
      stageKey: s.stageKey, label: s.label, color: s.color, order: s.orderIndex, count: counts[s.stageKey] || 0,
    }));
    res.json({ funnel, branches });
  } catch (err) {
    console.error('[funnel] chart error:', err.message);
    res.status(500).json({ error: 'Failed to load funnel chart' });
  }
});

// ── stage CRUD (admin) ────────────────────────────────────────────────────────
router.post('/funnel/stages', adminOnly, async (req, res) => {
  try {
    const { label, color, isFunnel, isWon } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'Label is required' });
    const key = await uniqueStageKey(label);
    const { rows: mx } = await pool.query(`SELECT COALESCE(MAX(order_index), 0) AS m FROM coexistence.funnel_stages`);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.funnel_stages (stage_key, label, color, order_index, is_funnel, is_won)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [key, String(label).trim(), color || null, Number(mx[0].m) + 1, isFunnel !== false, isWon === true]
    );
    await cfg.refreshFunnelConfig();
    res.status(201).json({ id: Number(rows[0].id), stageKey: key });
  } catch (err) {
    console.error('[funnel] stage create error:', err.message);
    res.status(500).json({ error: 'Failed to create stage' });
  }
});

router.put('/funnel/stages/reorder', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: 'order[] of stage ids is required' });
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(`UPDATE coexistence.funnel_stages SET order_index = $1, updated_at = NOW() WHERE id = $2`,
        [i + 1, parseInt(order[i], 10)]);
    }
    await client.query('COMMIT');
    await cfg.refreshFunnelConfig();
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[funnel] stage reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder stages' });
  } finally {
    client.release();
  }
});

router.put('/funnel/stages/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, color, isFunnel, isWon } = req.body || {};
    const sets = [], vals = [];
    if (label !== undefined) {
      if (!String(label).trim()) return res.status(400).json({ error: 'Label cannot be empty' });
      vals.push(String(label).trim()); sets.push(`label = $${vals.length}`);
    }
    if (color !== undefined) { vals.push(color || null); sets.push(`color = $${vals.length}`); }
    if (isFunnel !== undefined) { vals.push(isFunnel === true); sets.push(`is_funnel = $${vals.length}`); }
    if (isWon !== undefined) { vals.push(isWon === true); sets.push(`is_won = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    const { rowCount } = await pool.query(
      `UPDATE coexistence.funnel_stages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Stage not found' });
    await cfg.refreshFunnelConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('[funnel] stage update error:', err.message);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

router.delete('/funnel/stages/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: st } = await pool.query(
      `SELECT stage_key, is_won FROM coexistence.funnel_stages WHERE id = $1`, [id]);
    if (!st.length) return res.status(404).json({ error: 'Stage not found' });
    const key = st[0].stage_key;
    // Guard: never orphan leads.
    const { rows: used } = await pool.query(`SELECT 1 FROM coexistence.leads WHERE stage = $1 LIMIT 1`, [key]);
    if (used.length) return res.status(409).json({ error: 'Cannot delete: leads are currently in this stage. Move them first.' });
    // Guard: keep at least one "won" stage so Sales Log prefill / conversion logic has a terminal.
    if (st[0].is_won) {
      const { rows: won } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.funnel_stages WHERE is_won AND active`);
      if (won[0].n <= 1) return res.status(409).json({ error: 'Cannot delete the only "won" stage. Mark another stage as won first.' });
    }
    await pool.query(`DELETE FROM coexistence.funnel_stages WHERE id = $1`, [id]);
    await cfg.refreshFunnelConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('[funnel] stage delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete stage' });
  }
});

// ── source CRUD (admin) ───────────────────────────────────────────────────────
router.get('/funnel/sources', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, active,
              (SELECT COUNT(*)::int FROM coexistence.leads WHERE source = fs.label) AS lead_count
         FROM coexistence.funnel_sources fs ORDER BY label`);
    res.json({ sources: rows.map(r => ({ id: Number(r.id), label: r.label, active: r.active, leadCount: r.lead_count })) });
  } catch (err) {
    console.error('[funnel] sources list error:', err.message);
    res.status(500).json({ error: 'Failed to load sources' });
  }
});

router.post('/funnel/sources', adminOnly, async (req, res) => {
  try {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Label is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.funnel_sources (label) VALUES ($1)
       ON CONFLICT (label) DO UPDATE SET active = TRUE, updated_at = NOW() RETURNING id`, [label]);
    await cfg.refreshFunnelConfig();
    res.status(201).json({ id: Number(rows[0].id), label });
  } catch (err) {
    console.error('[funnel] source create error:', err.message);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

router.put('/funnel/sources/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { label, active } = req.body || {};
    const sets = [], vals = [];
    if (label !== undefined) {
      if (!String(label).trim()) return res.status(400).json({ error: 'Label cannot be empty' });
      vals.push(String(label).trim()); sets.push(`label = $${vals.length}`);
    }
    if (active !== undefined) { vals.push(active === true); sets.push(`active = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    const { rowCount } = await pool.query(
      `UPDATE coexistence.funnel_sources SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Source not found' });
    await cfg.refreshFunnelConfig();
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A source with that name already exists' });
    console.error('[funnel] source update error:', err.message);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

router.delete('/funnel/sources/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: src } = await pool.query(`SELECT label FROM coexistence.funnel_sources WHERE id = $1`, [id]);
    if (!src.length) return res.status(404).json({ error: 'Source not found' });
    const { rows: used } = await pool.query(`SELECT 1 FROM coexistence.leads WHERE source = $1 LIMIT 1`, [src[0].label]);
    if (used.length) {
      // In use — soft-deactivate (keeps historical lead.source values intact) rather than hard delete.
      await pool.query(`UPDATE coexistence.funnel_sources SET active = FALSE, updated_at = NOW() WHERE id = $1`, [id]);
      await cfg.refreshFunnelConfig();
      return res.json({ ok: true, deactivated: true });
    }
    await pool.query(`DELETE FROM coexistence.funnel_sources WHERE id = $1`, [id]);
    await cfg.refreshFunnelConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('[funnel] source delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

module.exports = { router, ensureFunnelTables };
