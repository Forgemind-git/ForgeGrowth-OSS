-- ─── Migration 081: user-defined tables (Sales → Tables) ────────────────────
--
--  A spreadsheet-style builder: an admin creates a table, defines typed columns,
--  types values into a grid, imports/exports a sheet, and attaches rows to a
--  lead so they surface where that lead is being worked.
--
--  ⚠ NO RUNTIME DDL. "Add field" does not create a Postgres column. Doing that
--  would mean unbounded schema growth, migrations that can never be replayed,
--  and user-supplied text reaching SQL identifiers. Values live in a JSONB bag
--  keyed by an immutable column key — the shape lead_form_submissions.answers
--  already proves in this codebase.
--
--  WHY COLUMNS GET THEIR OWN TABLE rather than a JSONB array on the parent (the
--  shape lead_forms uses): a form has ~10 fields edited as one unit, but a sheet
--  has columns that change independently while hundreds of rows reference them.
--  funnel_stages / clo_funnel_stages are the closer precedent — separate table,
--  sort_order, a dedicated reorder endpoint, and an IMMUTABLE key with an
--  editable label. That immutable-key design exists because renaming used to
--  orphan every row referencing the old key; the same risk applies here, only
--  worse, because the references live inside JSONB where nothing can enforce them.
--
--  DELETING A COLUMN drops the definition and LEAVES the values in place.
--  Precedent being avoided: deleting a contact_field_definitions row silently
--  orphans that key inside every contacts.custom_fields blob, and its delete
--  dialog claims the data is removed — a false statement in shipped code. Here
--  the values survive, so re-adding the same key restores them, and the dialog
--  says so.
--
-- Idempotent + re-runnable. Mirrored by ensureCustomTableTables() in
-- backend/src/routes/customTables.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/081_custom_tables.sql

-- ── custom_tables ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.custom_tables (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  -- 'lead' → each row may point at a lead and shows on that lead's drawer.
  -- NULL   → a standalone list with no attachment.
  links_to    TEXT CHECK (links_to IN ('lead')),
  -- Marks the starter tables seeded on first run, so re-seeding is idempotent
  -- and a user's own tables are never mistaken for them.
  is_seed     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_tables_slug ON coexistence.custom_tables(slug);

-- ── custom_table_columns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.custom_table_columns (
  id         BIGSERIAL PRIMARY KEY,
  table_id   BIGINT NOT NULL REFERENCES coexistence.custom_tables(id) ON DELETE CASCADE,
  -- IMMUTABLE once created. Every stored value is keyed by this, so changing it
  -- would orphan the lot. The label is what users rename.
  column_key TEXT NOT NULL,
  label      TEXT NOT NULL,
  col_type   TEXT NOT NULL DEFAULT 'text',
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  required   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  -- SOFT delete. Hard-deleting would leave the key's values in every row's bag,
  -- and the next column whose label slugifies to the same key would silently
  -- inherit them — a deleted "Course Name" reappearing inside a brand-new
  -- "Course Name" reads as a data breach, not an undo.
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- ⚠ NOT partial on deleted_at. The reflexive `WHERE deleted_at IS NULL` idiom is
-- exactly what would allow the resurrection above: it frees the key for reuse.
-- Keeping the constraint total reserves the key forever, so a collision is
-- caught and the admin is offered the old column back instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_table_columns_key
  ON coexistence.custom_table_columns(table_id, column_key);
CREATE INDEX IF NOT EXISTS idx_custom_table_columns_table
  ON coexistence.custom_table_columns(table_id, sort_order) WHERE deleted_at IS NULL;

-- ── custom_table_rows ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.custom_table_rows (
  id         BIGSERIAL PRIMARY KEY,
  table_id   BIGINT NOT NULL REFERENCES coexistence.custom_tables(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a row that exists only to describe a lead is
  -- meaningless once that lead is gone, and orphans would quietly inflate every
  -- row count. Standalone tables simply never set this.
  lead_id    BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  values     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_custom_table_rows_table ON coexistence.custom_table_rows(table_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_custom_table_rows_lead  ON coexistence.custom_table_rows(lead_id) WHERE lead_id IS NOT NULL;
-- contacts.custom_fields has a GIN index and is searchable; leads.custom_fields
-- has none and is effectively unqueryable. Take the former's lesson up front.
CREATE INDEX IF NOT EXISTS idx_custom_table_rows_values ON coexistence.custom_table_rows USING GIN (values);
