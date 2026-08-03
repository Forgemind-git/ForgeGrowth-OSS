// ─── Products & payment-link registry ────────────────────────────────────────
// A PRODUCT is anything you sell — a course, a consulting engagement, a
// template pack, a webinar. You register each Razorpay payment link/page once
// (product + price variant + its exact amount, optionally a disambiguating
// text). Incoming payments are then auto-attributed to a product by AMOUNT
// (+ optional text match). A captured payment: (1) stores the product + amount
// on the matched lead, and (2) tags the matched contact with the product name.
// Per-product revenue is aggregated from the attributed events.
//
// ⚠ NAMING: the table is `coexistence.courses` and its foreign key is
// `course_id`, because this shipped as a courses-only feature. Everything a
// user or an API client sees now says "product" (migration 084). The table was
// deliberately NOT renamed — `courses.id` is referenced by payment_links,
// sales_log and razorpay_events, i.e. the money-attribution path, and renaming
// buys nothing visible. Read `course` as `product` throughout this file.
//
// Routes are served under BOTH /products (canonical) and /courses (kept so
// existing MCP clients and integrations do not break) — see mountOn() below.
//
// Exposes helpers used by the Razorpay webhook (routes/razorpay.js):
//   ensureCourseTables, matchLink, applyCoursePayment, reattributeForLink

const { Router } = require('express');
const pool = require('../db');
const bus = require('../events');
const { requirePermission } = require('../middleware/access');

const router = Router();

function genId(prefix) { return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`; }

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
  // Migration 084 — the product's own headline price, in paise. Distinct from
  // payment_links.amount_paise: that matches a real payment by exact amount,
  // this is what you would normally charge and what pre-fills a manual sale.
  await pool.query(`ALTER TABLE coexistence.courses ADD COLUMN IF NOT EXISTS default_price_paise BIGINT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.payment_links (
      id           BIGSERIAL PRIMARY KEY,
      course_id    BIGINT NOT NULL REFERENCES coexistence.courses(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,          -- price variant label (Full / Early bird / WhatsApp 50% …)
      amount_paise BIGINT NOT NULL,        -- exact price of THIS link (the primary match key)
      match_text   TEXT,                   -- optional substring to disambiguate same-amount links
      url          TEXT,                   -- optional, for your reference
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_amount ON coexistence.payment_links(amount_paise) WHERE active;`);
  // Attribution columns on the event log + the lead.
  await pool.query(`ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS course_id BIGINT;`);
  await pool.query(`ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS payment_link_id BIGINT;`);
  await pool.query(`ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS description TEXT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_course TEXT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_amount_paise BIGINT;`);
  // Sales Log profile fields (migration 065) — mirror the Razorpay payment-page form.
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS age        INT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS profession TEXT;`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS pincode    TEXT;`);
}

// Resolve an amount (+ description/notes text) to a registered course link.
// Prefers a link whose match_text is present AND found in the text, so a
// specific rule wins over a generic same-amount link.
async function matchLink(amountPaise, text = '') {
  if (amountPaise == null) return null;
  const { rows } = await pool.query(
    `SELECT pl.id AS payment_link_id, pl.label, pl.course_id, c.name AS course_name
       FROM coexistence.payment_links pl
       JOIN coexistence.courses c ON c.id = pl.course_id
      WHERE pl.active AND c.active AND pl.amount_paise = $1
        AND (pl.match_text IS NULL OR pl.match_text = '' OR position(lower(pl.match_text) IN lower($2)) > 0)
      ORDER BY (pl.match_text IS NOT NULL AND pl.match_text <> '') DESC, pl.id ASC
      LIMIT 1`,
    [amountPaise, text || '']
  );
  return rows[0] || null;
}

// Ensure a CRM tag named after the course exists (under a "Courses" category).
async function ensureCourseTag(courseName) {
  let cat = (await pool.query(`SELECT id FROM coexistence.categories WHERE lower(name) = lower($1) LIMIT 1`, ['Courses'])).rows[0];
  if (!cat) {
    const cid = genId('cat');
    await pool.query(`INSERT INTO coexistence.categories (id, name, description) VALUES ($1, 'Courses', 'Course purchases')`, [cid]);
    cat = { id: cid };
  }
  let tag = (await pool.query(`SELECT id, name, color, category_id FROM coexistence.tags WHERE lower(name) = lower($1) LIMIT 1`, [courseName])).rows[0];
  if (!tag) {
    const tid = genId('tag');
    tag = (await pool.query(
      `INSERT INTO coexistence.tags (id, name, color, category_id) VALUES ($1, $2, '#0F6E56', $3)
       RETURNING id, name, color, category_id`,
      [tid, courseName, cat.id]
    )).rows[0];
  }
  return tag;
}

// Side-effects of a CAPTURED course payment: stamp the lead + tag the contact.
async function applyCoursePayment({ leadId, contactNumber, courseName, amountPaise }) {
  if (!courseName) return;
  if (leadId) {
    await pool.query(
      `UPDATE coexistence.leads SET paid_course = $2, paid_amount_paise = $3, updated_at = NOW() WHERE id = $1`,
      [leadId, courseName, amountPaise]
    );
    bus.emit('lead-changed', { id: leadId, reason: 'course_payment' });
  }
  if (contactNumber) {
    const tag = await ensureCourseTag(courseName);
    await pool.query(
      `UPDATE coexistence.contacts
          SET tags = COALESCE(tags, '[]'::jsonb) || $2::jsonb, updated_at = NOW()
        WHERE contact_number = $1
          AND NOT (COALESCE(tags, '[]'::jsonb) @> $3::jsonb)`,
      [contactNumber, JSON.stringify([tag]), JSON.stringify([{ id: tag.id }])]
    );
    bus.emit('contact-saved', { contactNumber });
  }
}

// Backfill: when a link is registered/edited, attribute past matching events
// (that aren't attributed yet) and run side-effects for captured ones.
async function reattributeForLink(linkId) {
  const link = (await pool.query(
    `SELECT pl.*, c.name AS course_name, c.active AS course_active
       FROM coexistence.payment_links pl JOIN coexistence.courses c ON c.id = pl.course_id
      WHERE pl.id = $1`, [linkId]
  )).rows[0];
  if (!link || !link.active || !link.course_active) return { updated: 0 };
  const { rows } = await pool.query(
    `UPDATE coexistence.razorpay_events e
        SET course_id = $1, payment_link_id = $2
      WHERE e.course_id IS NULL
        AND e.amount_paise = $3
        AND ($4 = '' OR position(lower($4) IN lower(COALESCE(e.description, '') || ' ' || COALESCE(e.notes::text, ''))) > 0)
      RETURNING e.event_type, e.matched_lead_id, e.matched_contact_number, e.amount_paise`,
    [link.course_id, link.id, link.amount_paise, link.match_text || '']
  );
  for (const ev of rows) {
    if (ev.event_type === 'payment.captured') {
      await applyCoursePayment({ leadId: ev.matched_lead_id, contactNumber: ev.matched_contact_number, courseName: link.course_name, amountPaise: ev.amount_paise });
    }
  }
  return { updated: rows.length };
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

// ── CRUD: products (each with its price-variant links + live revenue) ─────────
router.get(P(), requirePermission('products'), async (req, res) => {
  try {
    const { rows: courses } = await pool.query(`SELECT id, name, description, thumbnail_url, active, default_price_paise, created_at FROM coexistence.courses ORDER BY name`);
    const { rows: links } = await pool.query(
      `SELECT pl.id, pl.course_id, pl.label, pl.amount_paise, pl.match_text, pl.url, pl.active,
              COALESCE(SUM(e.amount_paise) FILTER (WHERE e.event_type = 'payment.captured'), 0)::bigint AS revenue_paise,
              COUNT(DISTINCT e.payment_id) FILTER (WHERE e.status = 'captured')::int AS paid_count
         FROM coexistence.payment_links pl
         LEFT JOIN coexistence.razorpay_events e ON e.payment_link_id = pl.id
        GROUP BY pl.id ORDER BY pl.amount_paise DESC`
    );
    const byCourse = {};
    links.forEach(l => { (byCourse[l.course_id] = byCourse[l.course_id] || []).push(l); });
    const products = courses.map(c => ({ ...c, links: byCourse[c.id] || [] }));
    // `courses` is a deprecated alias of the same array — an MCP client calling
    // the old path through the generic proxy still reads the key it expects.
    res.json({ products, courses: products });
  } catch (err) {
    console.error('[products] list error:', err.message);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

router.post(P(), requirePermission('products'), async (req, res) => {
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
    res.status(201).json({ ...rows[0], links: [] });
  } catch (err) {
    console.error('[products] create error:', err.message);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put(P('/:id'), requirePermission('products'), async (req, res) => {
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
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[products] update error:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete(P('/:id'), requirePermission('products'), async (req, res) => {
  try {
    // Detach attributed events first (FK-less columns) so history keeps its rows.
    await pool.query(`UPDATE coexistence.razorpay_events SET course_id = NULL, payment_link_id = NULL WHERE course_id = $1`, [req.params.id]);
    const { rowCount } = await pool.query(`DELETE FROM coexistence.courses WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[products] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── CRUD: payment links (price variants) ──────────────────────────────────────
router.post(P('/:id/links'), requirePermission('products'), async (req, res) => {
  try {
    const { label, amountRupees, matchText, url } = req.body || {};
    const amountPaise = Math.round(Number(amountRupees) * 100);
    if (!label || !label.trim()) return res.status(400).json({ error: 'A price-variant label is required' });
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) return res.status(400).json({ error: 'A valid amount is required' });
    const course = (await pool.query(`SELECT id FROM coexistence.courses WHERE id = $1`, [req.params.id])).rows[0];
    if (!course) return res.status(404).json({ error: 'Product not found' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.payment_links (course_id, label, amount_paise, match_text, url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.params.id, label.trim(), amountPaise, matchText?.trim() || null, url?.trim() || null]
    );
    const { updated } = await reattributeForLink(rows[0].id);
    res.status(201).json({ id: rows[0].id, backfilled: updated });
  } catch (err) {
    console.error('[courses] add link error:', err.message);
    res.status(500).json({ error: 'Failed to add payment link' });
  }
});

router.put('/payment-links/:id', requirePermission('products'), async (req, res) => {
  try {
    const { label, amountRupees, matchText, url, active } = req.body || {};
    const sets = ['updated_at = NOW()']; const params = []; let i = 1;
    if (label != null) { sets.push(`label = $${i++}`); params.push(label.trim()); }
    if (amountRupees != null) { const p = Math.round(Number(amountRupees) * 100); if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Invalid amount' }); sets.push(`amount_paise = $${i++}`); params.push(p); }
    if (matchText !== undefined) { sets.push(`match_text = $${i++}`); params.push(matchText?.trim() || null); }
    if (url !== undefined) { sets.push(`url = $${i++}`); params.push(url?.trim() || null); }
    if (active != null) { sets.push(`active = $${i++}`); params.push(!!active); }
    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE coexistence.payment_links SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment link not found' });
    const { updated } = await reattributeForLink(rows[0].id);
    res.json({ id: rows[0].id, backfilled: updated });
  } catch (err) {
    console.error('[courses] update link error:', err.message);
    res.status(500).json({ error: 'Failed to update payment link' });
  }
});

router.delete('/payment-links/:id', requirePermission('products'), async (req, res) => {
  try {
    await pool.query(`UPDATE coexistence.razorpay_events SET payment_link_id = NULL WHERE payment_link_id = $1`, [req.params.id]);
    const { rowCount } = await pool.query(`DELETE FROM coexistence.payment_links WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Payment link not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[courses] delete link error:', err.message);
    res.status(500).json({ error: 'Failed to delete payment link' });
  }
});

// ── Per-product revenue ───────────────────────────────────────────────────────
router.get(P('/revenue'), requirePermission('products'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.active,
              COALESCE(SUM(e.amount_paise) FILTER (WHERE e.event_type = 'payment.captured'), 0)::bigint AS revenue_paise,
              COUNT(DISTINCT e.payment_id) FILTER (WHERE e.status = 'captured')::int AS paid_count,
              COUNT(DISTINCT e.payment_id) FILTER (WHERE e.status = 'failed')::int   AS failed_count
         FROM coexistence.courses c
         LEFT JOIN coexistence.razorpay_events e ON e.course_id = c.id
        GROUP BY c.id ORDER BY revenue_paise DESC, c.name`
    );
    const { rows: [unattr] } = await pool.query(
      `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE event_type = 'payment.captured'), 0)::bigint AS revenue_paise,
              COUNT(DISTINCT payment_id) FILTER (WHERE status = 'captured')::int AS paid_count
         FROM coexistence.razorpay_events WHERE course_id IS NULL`
    );
    const products = rows.map(r => ({ ...r, revenue_paise: Number(r.revenue_paise) }));
    res.json({
      products, courses: products,   // `courses` = deprecated alias, see the list route
      unattributed: { revenue_paise: Number(unattr.revenue_paise), paid_count: unattr.paid_count },
    });
  } catch (err) {
    console.error('[products] revenue error:', err.message);
    res.status(500).json({ error: 'Failed to load product revenue' });
  }
});

module.exports = { router, ensureCourseTables, matchLink, applyCoursePayment, reattributeForLink };
