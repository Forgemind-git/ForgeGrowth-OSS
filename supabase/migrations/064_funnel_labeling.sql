-- ─── Migration 064: Funnel Labeling & Sales Tracking ─────────────────────────
-- Turns the previously-hardcoded lead funnel into a user-configurable system,
-- adds a managed lead-source list, and a manual Sales Log for converted leads.
-- Builds ON the existing `leads` model (single source of truth) — additive only.
-- Mirrors ensureFunnelTables()/ensureSalesLogTables() in the route files.
-- Idempotent + re-runnable. No fake data — stages seed the CURRENT live keys
-- (leads already reference them) and sources seed only from real lead sources.
--
-- Design note: `funnel_stages.stage_key` is an IMMUTABLE internal id. leads.stage,
-- scoring rules, and the cold-drop engine key off it, so admins can freely
-- rename / recolor / reorder / add / remove stages via the label & order columns
-- without breaking existing rows or logic. The old rigid CHECK is dropped.

-- ── Funnel stages (config-driven, ordered, stable key) ───────────────────────
CREATE TABLE IF NOT EXISTS coexistence.funnel_stages (
  id           BIGSERIAL PRIMARY KEY,
  stage_key    TEXT NOT NULL UNIQUE,            -- immutable internal id (leads.stage references this)
  label        TEXT NOT NULL,                   -- editable display name
  color        TEXT,                            -- editable hex / token
  order_index  INT  NOT NULL,
  is_funnel    BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = branches off the funnel (e.g. cold_lost)
  is_won       BOOLEAN NOT NULL DEFAULT FALSE,  -- the terminal "Paid"/"Enrolled" stage → Sales Log prefill
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,  -- seeded row marker
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_funnel_stages_order ON coexistence.funnel_stages(order_index);

-- Seed the CURRENT live keys/labels/order so the running app keeps working.
-- Admin can rename/reorder/recolor/add/remove later from the settings screen.
INSERT INTO coexistence.funnel_stages (stage_key, label, color, order_index, is_funnel, is_won, is_default) VALUES
  ('new',       'New',          '#64748b', 1, TRUE,  FALSE, TRUE),
  ('contacted', 'Contacted',    '#3b82f6', 2, TRUE,  FALSE, TRUE),
  ('engaged',   'Engaged',      '#8b5cf6', 3, TRUE,  FALSE, TRUE),
  ('hot',       'Hot',          '#f59e0b', 4, TRUE,  FALSE, TRUE),
  ('enrolled',  'Enrolled',     '#22c55e', 5, TRUE,  TRUE,  TRUE),
  ('cold_lost', 'Cold / Lost',  '#ef4444', 6, FALSE, FALSE, TRUE)
ON CONFLICT (stage_key) DO NOTHING;

-- Drop the rigid CHECK that hardcoded the stage set. Validation now happens in
-- the app against funnel_stages. (An optional FK can be added later, once the
-- Meta-ads sync / CSV import paths are confirmed to only ever write valid keys.)
ALTER TABLE coexistence.leads DROP CONSTRAINT IF EXISTS leads_stage_check;

-- ── Funnel sources (managed flat list) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.funnel_sources (
  id         BIGSERIAL PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed ONLY from real sources already present on leads (no invented values).
-- leads.source stays free-text TEXT (Meta-ads sync writes arbitrary values);
-- the UI source dropdown just offers this managed list going forward.
INSERT INTO coexistence.funnel_sources (label)
  SELECT DISTINCT TRIM(source) FROM coexistence.leads
   WHERE source IS NOT NULL AND TRIM(source) <> ''
ON CONFLICT (label) DO NOTHING;

-- ── Sales Log (manual log of paid / converted leads) ─────────────────────────
-- Product = the existing courses registry (course_id → coexistence.courses).
-- Amounts stored in PAISE (consistent with razorpay/payment_links); the API
-- converts ₹↔paise at the boundary.
CREATE TABLE IF NOT EXISTS coexistence.sales_log (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES coexistence.leads(id)   ON DELETE SET NULL,
  student_name  TEXT NOT NULL,
  course_id     BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
  product_label TEXT,                          -- snapshot of the course name at sale time
  amount_paise  BIGINT NOT NULL DEFAULT 0,
  payment_date  DATE NOT NULL,
  funnel_source TEXT,                          -- snapshot of lead.source at sale time
  notes         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_log_date   ON coexistence.sales_log(payment_date);
CREATE INDEX IF NOT EXISTS idx_sales_log_course ON coexistence.sales_log(course_id);
CREATE INDEX IF NOT EXISTS idx_sales_log_lead   ON coexistence.sales_log(lead_id);
