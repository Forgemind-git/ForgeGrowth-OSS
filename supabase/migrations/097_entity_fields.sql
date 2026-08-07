-- 097: Entity field registry — user-configurable fields for the Leads table,
-- the Sales Log, and per-installment Transactions (the "make every table
-- configurable like Forms" build).
--
-- Design notes (the load-bearing decisions):
--   * ONE registry table for both entities. entity='lead' fields describe the
--     person record (coexistence.leads): system rows mirror REAL columns
--     (system_column set), custom rows store their value in the existing
--     leads.custom_fields JSONB bag (present since 058, GIN-indexed).
--     entity='transaction' fields describe one installment
--     (coexistence.sales_log): system rows mirror its real columns, custom
--     rows store in the NEW sales_log.custom_fields bag added below.
--   * A "sale" is a lead at the won stage, so sale-level custom fields ARE
--     lead fields; the show_in_leads / show_in_sales flags decide which TABLE
--     renders a field (Leads page vs Sales Log page). Registering one real
--     column twice under two entities would let its label drift.
--   * field_key is IMMUTABLE once created (same rule as funnel_stages.stage_key
--     and the retired custom_table_columns.column_key). The label is what
--     admins rename.
--   * Deleting a custom field is a SOFT delete and the unique index below is
--     TOTAL (includes deleted rows): the key stays reserved forever, because a
--     future field re-minting the same key would silently inherit the orphaned
--     values still sitting inside hundreds of custom_fields blobs (081 policy).
--   * System rows can never be deleted or re-typed; only label / options /
--     visibility / order are editable. That is what makes the built-in columns
--     tenant-configurable (rename "Profession", hide "Pincode", edit the
--     dropdown options) without any schema change.
--
-- Idempotent; mirrored by ensureEntityFieldTables() in
-- backend/src/routes/entityFields.js (additive, so either may run first).

CREATE TABLE IF NOT EXISTS coexistence.entity_fields (
  id            BIGSERIAL PRIMARY KEY,
  entity        TEXT NOT NULL CHECK (entity IN ('lead', 'transaction')),
  field_key     TEXT NOT NULL,
  label         TEXT NOT NULL,
  field_type    TEXT NOT NULL DEFAULT 'text',
  options       JSONB NOT NULL DEFAULT '[]',
  required      BOOLEAN NOT NULL DEFAULT FALSE,
  is_system     BOOLEAN NOT NULL DEFAULT FALSE,
  -- The real column a system row mirrors (NULL for custom fields, whose values
  -- live in the entity's custom_fields JSONB keyed by field_key).
  system_column TEXT,
  show_in_leads BOOLEAN NOT NULL DEFAULT FALSE,
  show_in_sales BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order    INT NOT NULL DEFAULT 0,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TOTAL unique — deliberately NOT partial on deleted_at (see header).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_fields_key
  ON coexistence.entity_fields (entity, field_key);
CREATE INDEX IF NOT EXISTS idx_entity_fields_active
  ON coexistence.entity_fields (entity, sort_order) WHERE deleted_at IS NULL;

-- Per-installment custom values. leads.custom_fields already exists (058).
ALTER TABLE coexistence.sales_log
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_sales_log_custom_fields
  ON coexistence.sales_log USING GIN (custom_fields);

-- ── System-row seeds ─────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING so re-running (and every boot's ensure mirror) never
-- overwrites an admin's label/options/visibility edits.
--
-- Lead fields. Visibility mirrors the two tables as they render today:
-- Leads page = Name / WhatsApp / Source / Stage / Follow-ups / BDA / Arrived /
-- Last Activity; Sales Log = Customer identity + profile + Product/Total/Source.
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

-- Transaction (installment) fields. show_in_sales = shown in the transactions
-- table on the sale detail page (show_in_leads is unused for this entity).
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

COMMENT ON TABLE coexistence.entity_fields IS
  'Field registry for the Leads table / Sales Log / Transactions. field_key is immutable; labels/options/visibility are admin-editable. Custom values live in leads.custom_fields / sales_log.custom_fields keyed by field_key. Soft delete reserves the key forever (total unique index).';
