// What the Chat Analyzer knows about the BUSINESS, not just the chat.
//
// Without this the analyser reads a conversation cold and can only say generic
// things ("follow up with the customer"). An admin describes the business and the
// products we actually sell — pasted details: syllabus, fees, batch dates, FAQs,
// how to answer common objections — and every analysis reads it, so it can say
// WHICH product the customer wants and draft follow-ups that mention it.
//
// Stored in chat_analyser_config.business_context + chat_analyser_products
// (migration 126). The block handed to the model is capped (CONTEXT_CHAR_CAP):
// it is sent on EVERY run, so an unbounded paste would multiply the cost of the
// whole feature.

const crypto = require('crypto');
const pool = require('../db');

const CONTEXT_CHAR_CAP = 12000;          // ~3k tokens — about ₹0.04 extra per run on gpt-4o-mini
const BUSINESS_CAP = 3000;

async function loadContext() {
  const { rows: [conf] } = await pool.query(
    `SELECT business_context, context_updated_at, context_updated_by
       FROM coexistence.chat_analyser_config WHERE id = 1`);
  const { rows: products } = await pool.query(
    `SELECT id, name, price_text, details, active, sort_order, course_id, updated_at
       FROM coexistence.chat_analyser_products ORDER BY sort_order, id`);
  return {
    business: conf?.business_context || '',
    updatedAt: conf?.context_updated_at || null,
    updatedBy: conf?.context_updated_by || null,
    products: products.map(p => ({
      id: Number(p.id), name: p.name, price: p.price_text || '', details: p.details || '',
      active: p.active, sortOrder: p.sort_order, courseId: p.course_id ? Number(p.course_id) : null,
      updatedAt: p.updated_at,
    })),
  };
}

/**
 * The text block the model reads, plus a hash of it. The hash is '' when there
 * is no context at all, so analyses made before this feature (context_hash NULL)
 * are not all reported as stale the moment it ships.
 */
function buildBlock(ctx) {
  const business = (ctx.business || '').trim().slice(0, BUSINESS_CAP);
  const active = (ctx.products || []).filter(p => p.active && p.name.trim());
  if (!business && !active.length) return { text: '', hash: '', truncated: false, productNames: [] };

  // Each product gets an equal share of what is left, so one enormous paste
  // cannot squeeze the others out of the prompt entirely.
  const room = Math.max(0, CONTEXT_CHAR_CAP - business.length);
  const share = active.length ? Math.floor(room / active.length) : 0;
  let truncated = (ctx.business || '').trim().length > BUSINESS_CAP;
  const parts = [];
  if (business) parts.push(`ABOUT THE BUSINESS:\n${business}`);
  if (active.length) {
    parts.push('PRODUCTS WE SELL:');
    active.forEach((p, i) => {
      let details = (p.details || '').trim();
      if (details.length > share) { details = `${details.slice(0, share)}…`; truncated = true; }
      parts.push(`${i + 1}. ${p.name.trim()}${p.price ? ` — price: ${p.price}` : ''}${details ? `\n${details}` : ''}`);
    });
  }
  const text = parts.join('\n\n');
  return {
    text, truncated,
    hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
    productNames: active.map(p => p.name.trim()),
  };
}

async function currentBlock() {
  return buildBlock(await loadContext());
}

// ── editing (admin) ───────────────────────────────────────────────────────────

async function setBusiness(text, actor) {
  await pool.query(
    `UPDATE coexistence.chat_analyser_config
        SET business_context = $1, context_updated_at = NOW(), context_updated_by = $2, updated_at = NOW()
      WHERE id = 1`, [String(text || '').slice(0, 20000), actor || null]);
}

function cleanProduct(b) {
  const name = String(b.name || '').trim();
  if (!name) throw Object.assign(new Error('A product needs a name'), { status: 400 });
  return {
    name: name.slice(0, 200),
    price: b.price == null ? null : String(b.price).trim().slice(0, 100) || null,
    details: String(b.details || '').slice(0, 20000),
    active: b.active === undefined ? true : !!b.active,
  };
}

async function touch(actor) {
  await pool.query(`UPDATE coexistence.chat_analyser_config SET context_updated_at = NOW(), context_updated_by = $1 WHERE id = 1`, [actor || null]);
}

async function addProduct(b, actor) {
  const p = cleanProduct(b);
  const { rows: [r] } = await pool.query(
    `INSERT INTO coexistence.chat_analyser_products (name, price_text, details, active, sort_order)
     VALUES ($1,$2,$3,$4, COALESCE((SELECT MAX(sort_order) + 1 FROM coexistence.chat_analyser_products), 0))
     RETURNING id`, [p.name, p.price, p.details, p.active]);
  await touch(actor);
  return Number(r.id);
}

async function updateProduct(id, b, actor) {
  const p = cleanProduct(b);
  const { rowCount } = await pool.query(
    `UPDATE coexistence.chat_analyser_products
        SET name = $2, price_text = $3, details = $4, active = $5, updated_at = NOW()
      WHERE id = $1`, [id, p.name, p.price, p.details, p.active]);
  if (!rowCount) throw Object.assign(new Error('That product no longer exists'), { status: 404 });
  await touch(actor);
}

async function deleteProduct(id, actor) {
  const { rowCount } = await pool.query(`DELETE FROM coexistence.chat_analyser_products WHERE id = $1`, [id]);
  if (!rowCount) throw Object.assign(new Error('That product no longer exists'), { status: 404 });
  await touch(actor);
}

/**
 * Copy Sales → Products into the analyser's list (name, price, description) —
 * only products not already imported, so pressing it twice adds nothing.
 */
async function importFromProducts(actor) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chat_analyser_products (name, price_text, details, active, sort_order, course_id)
     SELECT c.name,
            CASE WHEN c.default_price_paise IS NOT NULL
                 THEN '₹' || to_char(c.default_price_paise / 100.0, 'FM99,99,99,990.##') END,
            COALESCE(c.description, ''), TRUE,
            COALESCE((SELECT MAX(sort_order) FROM coexistence.chat_analyser_products), 0) + ROW_NUMBER() OVER (ORDER BY c.id),
            c.id
       FROM coexistence.courses c
      WHERE c.active IS NOT FALSE
        AND NOT EXISTS (SELECT 1 FROM coexistence.chat_analyser_products p WHERE p.course_id = c.id)
     RETURNING id`);
  if (rows.length) await touch(actor);
  return rows.length;
}

module.exports = {
  loadContext, buildBlock, currentBlock, setBusiness,
  addProduct, updateProduct, deleteProduct, importFromProducts,
  CONTEXT_CHAR_CAP,
};
