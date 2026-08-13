// ─── Product tags: what this customer has bought, visible in Chats ───────────
//
// The Chats tag filter can only segment on `contacts.tags`, while what someone
// BOUGHT lives on `leads.paid_course`. So each product owns a managed tag that
// is mirrored onto the customer's contact rows when a sale records it — the
// same shape as the funnel-stage mirror (migration 082), for the same reason.
//
// ⚠ THE TAG ID IS KEYED ON THE PRODUCT'S IMMUTABLE ID, NEVER ITS NAME.
// `contacts.tags` is DENORMALISED: renaming a product must rewrite the copy
// inside every blob, and a name-keyed id would orphan them all instead. Same
// rule as funnel `stage_key` and `custom_table_columns.column_key`.
//
// ⚠ AUTO-APPLIED ONLY. There is no manual picker for these — they are excluded
// from the tag pickers exactly like Funnel Stage. A tag that means "bought X"
// is worthless the moment someone can set it by hand: the Chats filter would
// no longer answer "who bought X", it would answer "who did somebody tag".
//
// ⚠ AT MOST ONE per contact. A second sale REPLACES the tag rather than adding
// to it, matching the funnel-stage rule. (If multi-product segmentation is ever
// wanted, the single write below is the one place to change — drop the
// category_id filter from the strip half.)

const pool = require('../db');
const bus = require('../events');

const CATEGORY_ID = 'cat-product';
const CATEGORY_NAME = 'Product';
const CATEGORY_DESC = "Auto-managed: mirrors the product a customer bought so Chats can filter by it. Applied from the Sales Log. Edit the names in Admin Settings -> Funnel -> Products.";
const COLOR = '#6A3FAF';

const tagIdFor = (productId) => `tag-product-${productId}`;

const DIGITS = (col) => `regexp_replace(${col}, '[^0-9]', '', 'g')`;

async function ensureProductTagTables() {
  // Shares the GIN index the funnel tags added; harmless if it already exists.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON coexistence.contacts USING GIN (tags)`);
  await syncProductTagCatalog();
}

/**
 * One tag per product, in the managed category. Idempotent — runs at boot and
 * after every product write, so a rename reaches the denormalised copies.
 */
async function syncProductTagCatalog() {
  const { rows: products } = await pool.query(
    `SELECT id, name FROM coexistence.courses WHERE active = TRUE ORDER BY id`);

  await pool.query(
    `INSERT INTO coexistence.categories (id, name, description)
     VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()`,
    [CATEGORY_ID, CATEGORY_NAME, CATEGORY_DESC]);

  for (const p of products) {
    const id = tagIdFor(p.id);
    await pool.query(
      `INSERT INTO coexistence.tags (id, name, color, category_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, updated_at = NOW()`,
      [id, p.name, COLOR, CATEGORY_ID]);
    await propagateTagToContacts(id, p.name, COLOR);
  }

  // A deleted or deactivated product must not leave a stale tag on anyone.
  const liveIds = products.map(p => tagIdFor(p.id));
  const { rows: dead } = await pool.query(
    `SELECT id FROM coexistence.tags WHERE category_id = $1 AND NOT (id = ANY($2::text[]))`,
    [CATEGORY_ID, liveIds]);
  for (const d of dead) {
    await stripTagFromContacts(d.id);
    await pool.query(`DELETE FROM coexistence.tags WHERE id = $1`, [d.id]);
  }
  return { products: products.length, removed: dead.length };
}

/** Rewrite the denormalised copy of one tag inside every contacts.tags blob. */
async function propagateTagToContacts(tagId, name, color) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.contacts
        SET tags = (
              SELECT COALESCE(jsonb_agg(
                CASE WHEN t->>'id' = $1
                     THEN t || jsonb_build_object('name', $2::text, 'color', $3::text, 'category_id', $4::text)
                     ELSE t END), '[]'::jsonb)
                FROM jsonb_array_elements(tags) t),
            updated_at = NOW()
      WHERE tags @> jsonb_build_array(jsonb_build_object('id', $1::text))`,
    [tagId, name, color, CATEGORY_ID]);
  return rowCount;
}

async function stripTagFromContacts(tagId) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.contacts
        SET tags = (
              SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
                FROM jsonb_array_elements(tags) t
               WHERE t->>'id' <> $1),
            updated_at = NOW()
      WHERE tags @> jsonb_build_array(jsonb_build_object('id', $1::text))`,
    [tagId]);
  return rowCount;
}

/**
 * Mirror ONE lead's purchased product onto every contact row for that number.
 *
 * ⚠ The product is matched by NAME because `leads.paid_course` is TEXT — the
 * same join productSales.js makes, deliberately, since that is the column the
 * Sales Log itself writes. A renamed product therefore stops matching sales
 * recorded under the old name; the catalog sync above keeps the TAG correct,
 * but a `paid_course_id` FK is the real fix and is the natural follow-up.
 */
async function syncLeadProductTag(leadId) {
  if (!leadId) return { updated: 0 };
  const { rows } = await pool.query(
    `SELECT l.whatsapp_number, c.id AS product_id, c.name AS product_name
       FROM coexistence.leads l
       LEFT JOIN coexistence.courses c
         ON lower(btrim(c.name)) = lower(btrim(l.paid_course)) AND c.active = TRUE
      WHERE l.id = $1`, [leadId]);
  const lead = rows[0];
  if (!lead || !lead.whatsapp_number) return { updated: 0 };
  // No matching product → no tag, but any previous one is still cleared so the
  // contact never shows a purchase they no longer have.
  const tag = lead.product_id
    ? { id: tagIdFor(lead.product_id), name: lead.product_name, color: COLOR, category_id: CATEGORY_ID }
    : null;
  return applyProductTagByNumber(lead.whatsapp_number, tag);
}

/**
 * The single write. Strips whatever product-category tag the contact had and
 * appends the new one in ONE statement.
 *
 * ⚠ Merged IN SQL, never read-modify-write in JS — two concurrent writers would
 * otherwise clobber each other's tags. Non-product tags survive because the
 * filter is on category_id.
 */
async function applyProductTagByNumber(number, tag) {
  const digits = String(number || '').replace(/[^0-9]/g, '');
  if (!digits) return { updated: 0 };
  const { rows } = await pool.query(
    `UPDATE coexistence.contacts
        SET tags = COALESCE((
              SELECT jsonb_agg(t)
                FROM jsonb_array_elements(COALESCE(tags, '[]'::jsonb)) t
               WHERE t->>'category_id' IS DISTINCT FROM $2), '[]'::jsonb)
              || COALESCE($3::jsonb, '[]'::jsonb),
            updated_at = NOW()
      WHERE ${DIGITS('contact_number')} = $1
      RETURNING wa_number, contact_number`,
    [digits, CATEGORY_ID, tag ? JSON.stringify([tag]) : null]);
  for (const r of rows) {
    bus.emit('contact-saved', { waNumber: r.wa_number, contactNumber: r.contact_number });
  }
  return { updated: rows.length, contacts: rows };
}

/** Backfill / repair: re-mirror every lead that records a product. */
async function syncAllProductTags({ limit = 100000 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.leads
      WHERE paid_course IS NOT NULL AND btrim(paid_course) <> ''
      ORDER BY id LIMIT $1`, [limit]);
  let updated = 0;
  for (const r of rows) {
    try { updated += (await syncLeadProductTag(r.id)).updated; }
    catch (err) { console.error(`[product-tags] lead ${r.id}:`, err.message); }
  }
  return { leads: rows.length, contactsUpdated: updated };
}

module.exports = {
  CATEGORY_ID, CATEGORY_NAME, tagIdFor,
  ensureProductTagTables, syncProductTagCatalog,
  syncLeadProductTag, applyProductTagByNumber, syncAllProductTags,
};
