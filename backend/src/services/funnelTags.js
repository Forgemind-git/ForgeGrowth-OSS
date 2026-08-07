// Funnel-stage tags on WhatsApp contacts.
//
// WHY THIS EXISTS
// The Chats section can only filter on `contacts.tags`. The funnel lives on
// `leads.stage`. So to filter chats by "who is Enrolled" we mirror each lead's
// current stage onto its contact row as a tag, inside one managed category.
//
// THREE INVARIANTS, each learned the hard way elsewhere in this codebase:
//
//  1. A tag id is derived from the IMMUTABLE `funnel_stages.stage_key`, never
//     from the editable label. Renaming "Enrolled" -> "Paid" must not orphan
//     the tag already sitting inside hundreds of contacts.tags blobs. Same rule
//     as stage_key itself and custom_table_columns.column_key.
//
//  2. `contacts.tags` is DENORMALISED - every contact stores its own copy of
//     {id,name,color,category_id}. A rename therefore has to rewrite every
//     blob, not just the `tags` row. (PUT /tags/:id historically did not, which
//     is why renaming a tag silently kept showing the old name in Chats.)
//
//  3. Every write merges IN SQL. A read-modify-write in JS leaves a window
//     where two concurrent taggers each discard the other's edit - the exact
//     race already documented for custom-table row updates.
const pool = require('../db');
const bus = require('../events');

const CATEGORY_ID = 'cat-funnel-stage';
const CATEGORY_NAME = 'Funnel Stage';
const CATEGORY_DESC = 'Auto-managed: mirrors each lead\'s current funnel stage so Chats can filter by it. Edit the names in Admin Settings -> Funnel.';

// Derived from the immutable stage_key - see invariant 1.
const tagIdFor = (stageKey) => `tag-funnel-${stageKey}`;

// Digits-only comparison: leads.whatsapp_number is stored digits-only but
// contact_number has arrived from several places over time.
const DIGITS = `regexp_replace(%s, '[^0-9]', '', 'g')`;

async function ensureFunnelTagTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.funnel_tag_state (
      id            SMALLINT PRIMARY KEY DEFAULT 1,
      last_event_id BIGINT NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT funnel_tag_state_singleton CHECK (id = 1)
    )`);
  await pool.query(`INSERT INTO coexistence.funnel_tag_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Containment lookups drive the rename propagation below.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON coexistence.contacts USING GIN (tags)`);
}

// Create/refresh the managed category and one tag per funnel stage. Idempotent;
// safe to run at boot and after any funnel-config write.
async function syncFunnelTagCatalog() {
  const { rows: stages } = await pool.query(
    `SELECT stage_key, label, color FROM coexistence.funnel_stages WHERE active = TRUE ORDER BY order_index`);
  if (!stages.length) return { stages: 0 };

  await pool.query(
    `INSERT INTO coexistence.categories (id, name, description)
     VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()`,
    [CATEGORY_ID, CATEGORY_NAME, CATEGORY_DESC]);

  for (const s of stages) {
    const id = tagIdFor(s.stage_key);
    const color = s.color || '#6B7280';
    await pool.query(
      `INSERT INTO coexistence.tags (id, name, color, category_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, updated_at = NOW()`,
      [id, s.label, color, CATEGORY_ID]);
    // Push the (possibly renamed) label/colour into every contact that already
    // carries this tag - invariant 2.
    await propagateTagToContacts(id, s.label, color, CATEGORY_ID);
  }

  // A stage that no longer exists must not leave a stale tag behind.
  const liveIds = stages.map(s => tagIdFor(s.stage_key));
  const { rows: dead } = await pool.query(
    `SELECT id FROM coexistence.tags WHERE category_id = $1 AND NOT (id = ANY($2::text[]))`,
    [CATEGORY_ID, liveIds]);
  for (const d of dead) {
    await stripTagFromContacts(d.id);
    await pool.query(`DELETE FROM coexistence.tags WHERE id = $1`, [d.id]);
  }
  return { stages: stages.length, removed: dead.length };
}

// Rewrite the denormalised copy of one tag inside every contacts.tags blob.
// Used by the funnel catalog AND by PUT /tags/:id so manual tags behave the same.
async function propagateTagToContacts(tagId, name, color, categoryId) {
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
    [tagId, name, color, categoryId]);
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

// Mirror ONE lead's current stage onto every contact row for that phone number.
// A person can exist under several business numbers; they are the same human, so
// all of their rows get the tag.
async function syncLeadStageTag(leadId) {
  if (!leadId) return { updated: 0 };
  const { rows } = await pool.query(
    `SELECT l.whatsapp_number, l.stage, s.label, s.color
       FROM coexistence.leads l
       LEFT JOIN coexistence.funnel_stages s ON s.stage_key = l.stage AND s.active = TRUE
      WHERE l.id = $1`, [leadId]);
  const lead = rows[0];
  if (!lead || !lead.whatsapp_number) return { updated: 0 };
  // A stage with no funnel_stages row (hand-set value) gets no tag, but any
  // previous funnel tag is still cleared so the contact never shows a stale one.
  const tag = lead.label
    ? { id: tagIdFor(lead.stage), name: lead.label, color: lead.color || '#6B7280', category_id: CATEGORY_ID }
    : null;
  return applyFunnelTagByNumber(lead.whatsapp_number, tag);
}

// The single write. Removes whatever funnel-category tag the contact had and
// appends the new one, in ONE statement - invariant 3. Non-funnel tags survive
// untouched because the filter is on category_id.
async function applyFunnelTagByNumber(number, tag) {
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
      WHERE ${DIGITS.replace('%s', 'contact_number')} = $1
      RETURNING wa_number, contact_number`,
    [digits, CATEGORY_ID, tag ? JSON.stringify([tag]) : null]);
  for (const r of rows) {
    bus.emit('contact-saved', { waNumber: r.wa_number, contactNumber: r.contact_number });
  }
  return { updated: rows.length, contacts: rows };
}

// Backfill / repair: re-mirror every lead. Idempotent, so it doubles as the
// "something drifted" repair button.
async function syncAllLeadTags({ limit = 100000 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.leads ORDER BY id LIMIT $1`, [limit]);
  let updated = 0;
  for (const r of rows) {
    const res = await syncLeadStageTag(r.id).catch(() => ({ updated: 0 }));
    updated += res.updated;
  }
  return { leads: rows.length, contactsUpdated: updated };
}

// Keep tags in step with stage changes by walking lead_events, NOT by hooking
// each call site: eight code paths write leads.stage and several do it with raw
// SQL. A cursor covers all of them, and any future one, for free. This is the
// reference implementation of that pattern — follow it for anything else that
// must react to a stage change.
async function sweepStageEvents({ batch = 500 } = {}) {
  const { rows: cfgRows } = await pool.query(
    `SELECT last_event_id FROM coexistence.funnel_tag_state WHERE id = 1`);
  const cursor = Number(cfgRows[0]?.last_event_id || 0);
  const { rows: events } = await pool.query(
    `SELECT id, lead_id FROM coexistence.lead_events
      WHERE id > $1 AND event_type = 'stage_changed'
      ORDER BY id LIMIT $2`, [cursor, batch]);
  if (!events.length) return { processed: 0, cursor };

  const leadIds = [...new Set(events.map(e => Number(e.lead_id)).filter(Boolean))];
  let updated = 0;
  for (const id of leadIds) {
    const res = await syncLeadStageTag(id).catch(err => {
      console.error('[funnel-tags] sync failed for lead', id, err.message);
      return { updated: 0 };
    });
    updated += res.updated;
  }
  const newCursor = Number(events[events.length - 1].id);
  await pool.query(
    `UPDATE coexistence.funnel_tag_state SET last_event_id = $1, updated_at = NOW() WHERE id = 1`,
    [newCursor]);
  return { processed: events.length, leads: leadIds.length, contactsUpdated: updated, cursor: newCursor };
}

// Any lead change kicks a sweep within seconds so a tag appears in Chats while
// the user is still looking at it. Debounced, so a bulk stage move fires ONE
// sweep rather than one per lead. The interval in index.js stays as the safety
// net for anything that changed a stage without emitting.
let _kickTimer = null;
function kickSweep(delay = 3000) {
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    sweepStageEvents().catch(err => console.error('[funnel-tags] sweep failed:', err.message));
  }, delay);
  if (typeof _kickTimer.unref === 'function') _kickTimer.unref();
}
bus.on('lead-changed', () => kickSweep());

module.exports = {
  CATEGORY_ID, CATEGORY_NAME, tagIdFor, kickSweep,
  ensureFunnelTagTables, syncFunnelTagCatalog, syncLeadStageTag,
  applyFunnelTagByNumber, syncAllLeadTags, sweepStageEvents,
  propagateTagToContacts, stripTagFromContacts,
};
