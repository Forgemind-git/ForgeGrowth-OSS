// Entity-field registry (migration 097) — admin-configurable fields for the
// Leads table, the Sales Log and per-installment Transactions. Mounted under
// /api with authMiddleware in index.js.
//
// Reads are open to any authed user (the pages render columns from this);
// every mutation is adminOnly. Every mutation refreshes the shared in-process
// cache (services/fieldRegistry.js) — same pattern as routes/funnel.js.
//
// Endpoints:
//   GET    /entity-fields                whole registry + the sale variable tokens
//   POST   /entity-fields                add a custom field (server slugifies label → key)  [admin]
//   PUT    /entity-fields/reorder        { entity, ids: [...] } → sort_order               [admin]
//   PUT    /entity-fields/:id            relabel / options / visibility (key immutable)    [admin]
//   DELETE /entity-fields/:id            soft-delete a CUSTOM field (values kept)          [admin]
//   POST   /entity-fields/:id/restore    bring a soft-deleted field back (values reappear) [admin]

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const registry = require('../services/fieldRegistry');

const router = Router();

const ENTITIES = ['lead', 'transaction'];
// Same widget types as the Forms builder — one vocabulary across the app.
const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'date', 'dropdown', 'radio', 'checkbox', 'boolean'];
const NEEDS_OPTIONS = ['dropdown', 'radio', 'checkbox'];
// Keys the variable resolver derives without a registry row — a custom field
// minting one would silently shadow the token everyone already uses. The
// transaction list is DERIVED from the computed {{sale.*}} tokens so the two
// can never drift (resolveSaleKey's switch wins over a custom bag key).
const { SALE_TOKENS } = require('../services/variables');
const RESERVED_KEYS = {
  lead: ['first_name', 'phone'],
  transaction: SALE_TOKENS.map(t => t.key),
};

// ── self-healing bootstrap (additive mirror of migration 097) ─────────────────
async function ensureEntityFieldTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.entity_fields (
      id            BIGSERIAL PRIMARY KEY,
      entity        TEXT NOT NULL CHECK (entity IN ('lead', 'transaction')),
      field_key     TEXT NOT NULL,
      label         TEXT NOT NULL,
      field_type    TEXT NOT NULL DEFAULT 'text',
      options       JSONB NOT NULL DEFAULT '[]',
      required      BOOLEAN NOT NULL DEFAULT FALSE,
      is_system     BOOLEAN NOT NULL DEFAULT FALSE,
      system_column TEXT,
      show_in_leads BOOLEAN NOT NULL DEFAULT FALSE,
      show_in_sales BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order    INT NOT NULL DEFAULT 0,
      deleted_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // TOTAL unique (includes soft-deleted rows): a deleted key stays reserved so
  // a future field can never silently inherit orphaned custom_fields values.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_fields_key
    ON coexistence.entity_fields (entity, field_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entity_fields_active
    ON coexistence.entity_fields (entity, sort_order) WHERE deleted_at IS NULL;`);
  await pool.query(`ALTER TABLE coexistence.sales_log
    ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_log_custom_fields
    ON coexistence.sales_log USING GIN (custom_fields);`);

  // System-row seeds — DO NOTHING so admin edits are never overwritten at boot.
  await pool.query(`
    INSERT INTO coexistence.entity_fields
      (entity, field_key, label, field_type, options, is_system, system_column, show_in_leads, show_in_sales, sort_order)
    VALUES
      ('lead', 'name',             'Name',          'text',     '[]', TRUE, 'name',              TRUE,  TRUE,  1),
      ('lead', 'whatsapp_number',  'WhatsApp',      'phone',    '[]', TRUE, 'whatsapp_number',   TRUE,  TRUE,  2),
      ('lead', 'email',            'Email',         'email',    '[]', TRUE, 'email',             FALSE, TRUE,  3),
      ('lead', 'age',              'Age',           'number',   '[]', TRUE, 'age',               FALSE, TRUE,  4),
      ('lead', 'profession',       'Profession',    'dropdown',
         '["Student","Engineer","Freelancer","Business Owner","Marketing Professional","Other"]',
         TRUE, 'profession', FALSE, TRUE, 5),
      ('lead', 'pincode',          'Pincode',       'text',     '[]', TRUE, 'pincode',           FALSE, TRUE,  6),
      ('lead', 'city',             'City',          'text',     '[]', TRUE, 'city',              FALSE, FALSE, 7),
      ('lead', 'source',           'Source',        'dropdown', '[]', TRUE, 'source',            TRUE,  TRUE,  8),
      ('lead', 'stage',            'Stage',         'dropdown', '[]', TRUE, 'stage',             TRUE,  FALSE, 9),
      ('lead', 'follow_up_count',  'Follow-ups',    'number',   '[]', TRUE, 'follow_up_count',   TRUE,  FALSE, 10),
      ('lead', 'assigned_to',      'BDA',           'text',     '[]', TRUE, 'assigned_user_id',  TRUE,  FALSE, 11),
      ('lead', 'paid_course',      'Product',       'text',     '[]', TRUE, 'paid_course',       FALSE, TRUE,  12),
      ('lead', 'total_paid',       'Total Paid',    'number',   '[]', TRUE, 'total_paid',        FALSE, TRUE,  13),
      ('lead', 'payment_date',     'Payment Date',  'date',     '[]', TRUE, 'payment_date',      FALSE, FALSE, 14),
      ('lead', 'created_at',       'Arrived',       'date',     '[]', TRUE, 'created_at',        TRUE,  FALSE, 15),
      ('lead', 'last_activity_at', 'Last Activity', 'date',     '[]', TRUE, 'last_activity_at',  TRUE,  FALSE, 16)
    ON CONFLICT (entity, field_key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO coexistence.entity_fields
      (entity, field_key, label, field_type, options, is_system, system_column, show_in_leads, show_in_sales, sort_order)
    VALUES
      ('transaction', 'payment_date', 'Date',    'date',     '[]', TRUE, 'payment_date',  FALSE, TRUE,  1),
      ('transaction', 'amount',       'Amount',  'number',   '[]', TRUE, 'amount_paise',  FALSE, TRUE,  2),
      ('transaction', 'method',       'Method',  'dropdown',
         '["UPI","Card","Cash","Bank Transfer","Other"]',
         TRUE, 'method', FALSE, TRUE, 3),
      ('transaction', 'notes',        'Note',    'textarea', '[]', TRUE, 'notes',         FALSE, TRUE,  4),
      ('transaction', 'product',      'Product', 'text',     '[]', TRUE, 'product_label', FALSE, FALSE, 5)
    ON CONFLICT (entity, field_key) DO NOTHING;
  `);
  await registry.refreshFieldRegistry();
}

// slugify a label into a stable field_key. Suffixes past ACTIVE rows; a match
// on a soft-DELETED row is reported to the caller instead (restore, don't
// re-mint — the old values would reappear under the new field).
async function uniqueFieldKey(entity, label) {
  const base = String(label || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field';
  const { rows: [deleted] } = await pool.query(
    `SELECT id, label FROM coexistence.entity_fields
      WHERE entity = $1 AND field_key = $2 AND deleted_at IS NOT NULL`, [entity, base]);
  if (deleted) return { conflict: { id: Number(deleted.id), label: deleted.label, key: base } };
  let key = base;
  for (let n = 2; ; n++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM coexistence.entity_fields WHERE entity = $1 AND field_key = $2`, [entity, key]);
    if (!rows.length) return { key };
    key = `${base}_${n}`;
  }
}

function cleanOptions(fieldType, options) {
  if (!NEEDS_OPTIONS.includes(fieldType)) return [];
  const list = (Array.isArray(options) ? options : [])
    .map(o => String(o ?? '').trim()).filter(Boolean);
  return [...new Set(list)];
}

const fieldOut = (f) => f; // registry getters already return the camelCase shape

// ── read ──────────────────────────────────────────────────────────────────────
router.get('/entity-fields', (req, res) => {
  const { SALE_TOKENS } = require('../services/variables');
  res.json({
    fields: { lead: registry.fields('lead'), transaction: registry.fields('transaction') },
    saleTokens: SALE_TOKENS,
  });
});

// ── create (custom fields only — system rows are seeded) ──────────────────────
router.post('/entity-fields', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (!ENTITIES.includes(b.entity)) return res.status(400).json({ error: 'Invalid entity' });
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: 'A field needs a label' });
    const fieldType = FIELD_TYPES.includes(b.fieldType) ? b.fieldType : 'text';
    const options = cleanOptions(fieldType, b.options);
    if (NEEDS_OPTIONS.includes(fieldType) && !options.length) {
      return res.status(400).json({ error: 'Add at least one option for a choice field' });
    }
    const keyed = await uniqueFieldKey(b.entity, label);
    if (keyed.conflict) {
      return res.status(409).json({
        error: `A deleted field ("${keyed.conflict.label}") already owns this name — its old values would reappear under a new field. Restore it instead, or pick a different name.`,
        restorableId: keyed.conflict.id,
      });
    }
    if ((RESERVED_KEYS[b.entity] || []).includes(keyed.key)) {
      return res.status(400).json({ error: `"${keyed.key}" is a reserved variable name — pick a different label.` });
    }
    const { rows: [mx] } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS m FROM coexistence.entity_fields WHERE entity = $1`, [b.entity]);
    const { rows: [r] } = await pool.query(
      `INSERT INTO coexistence.entity_fields
         (entity, field_key, label, field_type, options, required, is_system, show_in_leads, show_in_sales, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,$8,$9) RETURNING *`,
      [b.entity, keyed.key, label, fieldType, JSON.stringify(options), b.required === true,
       b.showInLeads === true, b.showInSales !== false, Number(mx.m) + 1]);
    await registry.refreshFieldRegistry();
    res.status(201).json({ field: fieldOut(registry.fieldByKey(b.entity, r.field_key)) });
  } catch (err) {
    console.error('[entity-fields] create error:', err.message);
    res.status(500).json({ error: 'Failed to create the field' });
  }
});

// ── reorder (per entity) ──────────────────────────────────────────────────────
router.put('/entity-fields/reorder', adminOnly, async (req, res) => {
  try {
    const { entity } = req.body || {};
    if (!ENTITIES.includes(entity)) return res.status(400).json({ error: 'Invalid entity' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n, 10)) : [];
    if (!ids.length || ids.some(n => !Number.isFinite(n))) return res.status(400).json({ error: 'ids required' });
    // Must be a permutation of this entity's ACTIVE fields — a partial list
    // would leave duplicate sort_order values behind.
    const { rows: current } = await pool.query(
      `SELECT id FROM coexistence.entity_fields WHERE entity = $1 AND deleted_at IS NULL`, [entity]);
    const have = new Set(current.map(r => Number(r.id)));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some(n => !have.has(n))) {
      return res.status(400).json({ error: 'The order list must contain exactly this entity’s fields.' });
    }
    await pool.query(
      `UPDATE coexistence.entity_fields f
          SET sort_order = x.ord, updated_at = NOW()
         FROM (SELECT * FROM unnest($2::bigint[]) WITH ORDINALITY) AS x(id, ord)
        WHERE f.id = x.id AND f.entity = $1`,
      [entity, ids]);
    await registry.refreshFieldRegistry();
    res.json({ ok: true });
  } catch (err) {
    console.error('[entity-fields] reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder fields' });
  }
});

// ── update (field_key immutable; system rows keep their type) ─────────────────
router.put('/entity-fields/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Field not found' });
    const { rows: [f] } = await pool.query(
      `SELECT * FROM coexistence.entity_fields WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!f) return res.status(404).json({ error: 'Field not found' });

    const b = req.body || {};
    const sets = [], vals = [];
    const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (b.label !== undefined) {
      const label = String(b.label || '').trim();
      if (!label) return res.status(400).json({ error: 'Label cannot be empty' });
      set('label', label);
    }
    // Type is editable on CUSTOM fields only (values are stored as strings, so
    // a widget change is safe); a system row's type mirrors a real column.
    let fieldType = f.field_type;
    if (b.fieldType !== undefined && !f.is_system) {
      if (!FIELD_TYPES.includes(b.fieldType)) return res.status(400).json({ error: 'Invalid field type' });
      fieldType = b.fieldType;
      set('field_type', fieldType);
    }
    if (b.options !== undefined) {
      const options = cleanOptions(fieldType, b.options);
      if (NEEDS_OPTIONS.includes(fieldType) && !options.length) {
        return res.status(400).json({ error: 'Add at least one option for a choice field' });
      }
      set('options', JSON.stringify(options));
    }
    if (b.required !== undefined) set('required', b.required === true);
    if (b.showInLeads !== undefined) set('show_in_leads', b.showInLeads === true);
    if (b.showInSales !== undefined) set('show_in_sales', b.showInSales === true);
    if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) set('sort_order', Number(b.sortOrder));
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    await pool.query(
      `UPDATE coexistence.entity_fields SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    await registry.refreshFieldRegistry();
    res.json({ field: fieldOut(registry.fields(f.entity).find(x => x.id === id)) });
  } catch (err) {
    console.error('[entity-fields] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the field' });
  }
});

// ── soft delete (custom only; values are KEPT and the key stays reserved) ─────
router.delete('/entity-fields/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Field not found' });
    const { rows: [f] } = await pool.query(
      `SELECT is_system FROM coexistence.entity_fields WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!f) return res.status(404).json({ error: 'Field not found' });
    if (f.is_system) return res.status(400).json({ error: 'Built-in fields cannot be deleted — hide them from the table instead.' });
    await pool.query(
      `UPDATE coexistence.entity_fields SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [id]);
    await registry.refreshFieldRegistry();
    res.json({ ok: true });
  } catch (err) {
    console.error('[entity-fields] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the field' });
  }
});

// ── restore a soft-deleted field (its stored values become visible again) ─────
router.post('/entity-fields/:id/restore', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Field not found' });
    const { rowCount } = await pool.query(
      `UPDATE coexistence.entity_fields SET deleted_at = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NOT NULL`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'No deleted field with that id' });
    await registry.refreshFieldRegistry();
    res.json({ ok: true });
  } catch (err) {
    console.error('[entity-fields] restore error:', err.message);
    res.status(500).json({ error: 'Failed to restore the field' });
  }
});

module.exports = { router, ensureEntityFieldTables };
