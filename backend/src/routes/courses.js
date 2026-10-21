// ─── Products ────────────────────────────────────────────────────────────────
// A PRODUCT is anything you sell — a course, a consulting engagement, a
// template pack, a webinar — with an optional headline price. A sale names its
// product (leads.paid_course); per-product revenue is aggregated from the
// manual sales store (services/productSales.js).
//
// ⚠ NAMING: the table is `coexistence.courses` and its foreign key is
// `course_id`, because this shipped as a courses-only feature. Everything a
// user or an API client sees now says "product" (migration 084). The table was
// deliberately NOT renamed — `courses.id` is referenced by sales_log, i.e. the
// money-attribution path, and renaming buys nothing visible. Read `course` as `product` throughout this file.
//
// Routes are served under BOTH /products (canonical) and /courses (kept so
// existing MCP clients and integrations do not break) — see P() below.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const productTags = require('./../services/productTags');

// ⚠ The 'products' PAGE KEY is gone (2026-08-12) — the editor moved into Admin
// Settings → Funnel, which is admin-gated. So these routes can no longer gate
// on adminOnly: that key matches no page, and every
// non-admin would be refused a product list the Sales Log needs to render.
//
// READS are open to any signed-in user (a product name and price are not
// sensitive, and sales entry and the funnel need them).
// WRITES are adminOnly, matching the one screen that can reach them.
// A product's sales/payments/revenue come from the manual sales store — see the
// header comment in that file.
const { productTotals, unattributedTotals } = require('../services/productSales');

const router = Router();

async function ensureCourseTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.courses (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      thumbnail_url TEXT,
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE coexistence.courses ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;`);
  // Migration 084 — the product's own headline price, in paise: what you would
  // normally charge and what pre-fills a manual sale.
  await pool.query(`ALTER TABLE coexistence.courses ADD COLUMN IF NOT EXISTS default_price_paise BIGINT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_course TEXT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_amount_paise BIGINT;`);
  // Sale profile fields (migration 065).
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS age        INT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS profession TEXT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS pincode    TEXT;`);
  // Migration 116: manual payment-status override on a sale (NULL = derived).
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS payment_status TEXT;`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_payment_status_check') THEN
      ALTER TABLE coexistence.leads ADD CONSTRAINT leads_payment_status_check
        CHECK (payment_status IS NULL OR payment_status IN ('paid', 'partial', 'unpaid'));
    END IF;
  END $$;`);
}

// Every route answers on BOTH prefixes. `/products` is canonical (what the app
// and the docs use); `/courses` is kept so already-connected MCP clients and
// any external integration keep working rather than 404-ing after the rename.
const P = (suffix = '') => [`/products${suffix}`, `/courses${suffix}`];

// Rupees in, paise out. Returns undefined for "not provided" so a PATCH-style
// update can tell "leave it alone" apart from "clear it", and null for an
// explicit clear — a product is allowed to have no price.
function priceToPaise(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const paise = Math.round(Number(v) * 100);
  if (!Number.isFinite(paise) || paise < 0) return NaN;   // caller rejects
  return paise;
}

// ── CRUD: products (each with its live revenue) ───────────────────────────────
router.get(P(), async (req, res) => {
  try {
    const { rows: courses } = await pool.query(`SELECT id, name, description, thumbnail_url, active, default_price_paise, created_at FROM coexistence.courses ORDER BY name`);
    const totals = await productTotals();
    const byId = {};
    totals.forEach(t => { byId[t.id] = t; });
    const products = courses.map(c => {
      const t = byId[c.id] || { sales_count: 0, payment_count: 0, revenue_paise: 0 };
      return {
        ...c,
        sales_count: t.sales_count,
        payment_count: t.payment_count,
        revenue_paise: t.revenue_paise,
      };
    });
    // `courses` is a deprecated alias of the same array — an MCP client calling
    // the old path through the generic proxy still reads the key it expects.
    res.json({ products, courses: products });
  } catch (err) {
    console.error('[products] list error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

router.post(P(), adminOnly, async (req, res) => {
  try {
    const { name, description, thumbnailUrl, defaultPrice } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });
    const paise = priceToPaise(defaultPrice);
    if (Number.isNaN(paise)) return res.status(400).json({ error: 'Enter a valid default price, or leave it blank' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.courses (name, description, thumbnail_url, default_price_paise)
       VALUES ($1, $2, $3, $4) RETURNING id, name, description, thumbnail_url, active, default_price_paise, created_at`,
      [name.trim(), description?.trim() || null, thumbnailUrl?.trim() || null, paise ?? null]
    );
    // Mint this product's tag now, so it is usable the moment it exists.
    await productTags.syncProductTagCatalog().catch(e => console.error('[product-tags]', e.message));
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[products] create error:', err.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put(P('/:id'), adminOnly, async (req, res) => {
  try {
    const { name, description, thumbnailUrl, active, defaultPrice } = req.body || {};
    const sets = ['updated_at = NOW()']; const params = []; let i = 1;
    if (name != null) { sets.push(`name = $${i++}`); params.push(name.trim()); }
    if (description !== undefined) { sets.push(`description = $${i++}`); params.push(description?.trim() || null); }
    if (thumbnailUrl !== undefined) { sets.push(`thumbnail_url = $${i++}`); params.push(thumbnailUrl?.trim() || null); }
    if (active != null) { sets.push(`active = $${i++}`); params.push(!!active); }
    if (defaultPrice !== undefined) {
      const paise = priceToPaise(defaultPrice);
      if (Number.isNaN(paise)) return res.status(400).json({ error: 'Enter a valid default price, or leave it blank' });
      sets.push(`default_price_paise = $${i++}`); params.push(paise);
    }
    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE coexistence.courses SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, description, thumbnail_url, active, default_price_paise`, params);
    // ⚠ The tag's name is DENORMALISED into every contacts.tags blob, so a
    // rename has to rewrite them. syncProductTagCatalog does that; skipping it
    // would leave contacts showing the product's old name forever.
    await productTags.syncProductTagCatalog().catch(e => console.error('[product-tags]', e.message));
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[products] update error:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete(P('/:id'), adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.courses WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    // The product is gone; its tag must leave every contact carrying it.
    await productTags.syncProductTagCatalog().catch(e => console.error('[product-tags]', e.message));
    res.json({ ok: true });
  } catch (err) {
    console.error('[products] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── Per-product revenue (from the sales store) ────────────────────────────────
router.get(P('/revenue'), async (req, res) => {
  try {
    const products = await productTotals();
    const { unattributed } = await unattributedTotals();
    res.json({
      products, courses: products,   // `courses` = deprecated alias, see the list route
      unattributed,                  // a sale with no Product set
    });
  } catch (err) {
    console.error('[products] revenue error:', err.message);
    res.status(500).json({ error: 'Failed to load product revenue' });
  }
});

module.exports = { router, ensureCourseTables };
