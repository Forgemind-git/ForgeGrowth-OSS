-- ─── Migration 062: Courses & payment-link registry ──────────────────────────
-- Register each Razorpay payment link/page (course + price variant + exact
-- amount) so incoming payments are auto-attributed to the course actually sold.
-- Mirrors ensureCourseTables() in backend/src/routes/courses.js. Idempotent.

CREATE TABLE IF NOT EXISTS coexistence.courses (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  thumbnail_url TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE coexistence.courses ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- One row per payment link / price variant of a course. amount_paise is the
-- primary match key; match_text disambiguates two links that share an amount.
CREATE TABLE IF NOT EXISTS coexistence.payment_links (
  id           BIGSERIAL PRIMARY KEY,
  course_id    BIGINT NOT NULL REFERENCES coexistence.courses(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  match_text   TEXT,
  url          TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_links_amount ON coexistence.payment_links(amount_paise) WHERE active;

-- Attribution columns on the event log + the paid course on the lead.
ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS course_id       BIGINT;
ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS payment_link_id BIGINT;
ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS description     TEXT;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_course       TEXT;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS paid_amount_paise BIGINT;
