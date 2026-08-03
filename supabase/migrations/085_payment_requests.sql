-- ─── Migration 085: Payment requests (Razorpay links minted BY ForgeGrowth) ───
-- Mirrors ensurePaymentRequestTables() in backend/src/routes/paymentRequests.js
-- (runtime source of truth). Idempotent.
--
-- WHY THIS EXISTS
-- Until now the Razorpay integration was receive-only: razorpay_config held a
-- webhook secret and nothing else, so a link created in the Razorpay dashboard
-- arrived here with `notes: null` and `reference_id: ""` and could only be
-- attributed by GUESSING from its rupee amount (courses.matchLink). That fails
-- for part payments (two people paying 5000 toward different products collide),
-- is impossible for open "pay what you like" amounts, and mis-attributes when
-- the payer checks out with a phone that isn't their WhatsApp number.
--
-- Proof from live data before this migration — plink_ExampleLinkId01, ₹3,000,
-- "N8n + whatsapp course", paid 2026-07-14: matched_lead_id NULL, course_id
-- NULL. The link was addressed to +919876543210 but PAID by 919876500000, and
-- the payer email came through as Razorpay's placeholder void@razorpay.com — so
-- both branches of matchPayer (phone, email) failed on the same record.
--
-- The fix is to mint the link ourselves and stamp our own id on it, turning an
-- INFERRED join key (amount) into an EXPLICIT one (razorpay_link_id).

-- ── 1. API credentials on the existing singleton config ──────────────────────
-- The webhook secret verifies INBOUND events; these are for OUTBOUND calls to
-- Razorpay's API. Separate concerns, separate status fields: a working webhook
-- must not imply working API access (that conflation is exactly what made
-- "connected" misleading — key_id was empty the whole time).
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS key_secret_encrypted TEXT;
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS key_mode      TEXT NOT NULL DEFAULT 'test';
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_status    TEXT NOT NULL DEFAULT 'not_configured';
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_last_error TEXT;
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_checked_at TIMESTAMPTZ;

-- CHECKs added separately so a re-run on a table that already has them is a
-- no-op rather than an error (ADD CONSTRAINT has no IF NOT EXISTS).
DO $$ BEGIN
  ALTER TABLE coexistence.razorpay_config
    ADD CONSTRAINT razorpay_config_key_mode_check CHECK (key_mode IN ('test','live'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE coexistence.razorpay_config
    ADD CONSTRAINT razorpay_config_api_status_check
    CHECK (api_status IN ('not_configured','connected','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. One row per link ForgeGrowth mints ────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.payment_requests (
  id                 BIGSERIAL PRIMARY KEY,

  -- WHO. lead_id is the live link; the three snapshot columns are deliberately
  -- duplicated rather than joined, because deleting a sale deletes the lead
  -- (leads.id is reused by a returning customer) and a payment record that
  -- forgets who paid is worse than useless for reconciliation. Same reasoning
  -- as razorpay_events.matched_lead_name.
  lead_id            BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  customer_name      TEXT,
  customer_phone     TEXT,               -- digits-only
  customer_email     TEXT,

  -- WHAT FOR. course_id = the product (table is still `courses`, see migration
  -- 084). product_label survives the product being deleted.
  course_id          BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
  product_label      TEXT,
  purpose            TEXT,               -- free-text note: "2nd instalment", "advance", "workshop seat"

  -- HOW MUCH.
  --   fixed   → amount_paise is the exact charge.
  --   partial → amount_paise is the FULL price; min_amount_paise is the least
  --             they may pay now (Razorpay's first_min_partial_amount).
  --   open    → amount_paise is a SUGGESTED figure. Razorpay requires an amount
  --             on every link, so "pay what you like" is modelled as a partial
  --             link with a low minimum — there is no true amount-less link.
  kind               TEXT NOT NULL DEFAULT 'fixed',
  amount_paise       BIGINT NOT NULL,
  min_amount_paise   BIGINT,
  currency           TEXT NOT NULL DEFAULT 'INR',

  -- RAZORPAY SIDE. razorpay_link_id is THE join key that makes attribution
  -- exact. UNIQUE so a replayed webhook can never fan out across rows.
  razorpay_link_id   TEXT UNIQUE,
  reference_id       TEXT,               -- our 'fg-req-<id>', also stored on Razorpay
  short_url          TEXT,
  description        TEXT,               -- what the payer sees at checkout

  -- STATE. amount_paid_paise accumulates across instalments on a partial link.
  status             TEXT NOT NULL DEFAULT 'created',
  amount_paid_paise  BIGINT NOT NULL DEFAULT 0,
  expire_by          TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,

  -- Set when Razorpay never CONFIRMED the create (a timeout, not a refusal).
  -- The row is kept rather than deleted in that case, because the link may well
  -- exist on Razorpay's side and deleting our copy would orphan a live link.
  sync_error         TEXT,

  -- PROVENANCE. Set when the request came from a ForgeGrowth form submission
  -- rather than being typed by a BDA.
  form_id            BIGINT,
  form_submission_id BIGINT,

  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE coexistence.payment_requests
    ADD CONSTRAINT payment_requests_kind_check CHECK (kind IN ('fixed','partial','open'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE coexistence.payment_requests
    ADD CONSTRAINT payment_requests_status_check
    CHECK (status IN ('created','partially_paid','paid','cancelled','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Kept as a separate ALTER as well, so a database that got the table from an
-- earlier run of this file still picks the column up.
ALTER TABLE coexistence.payment_requests ADD COLUMN IF NOT EXISTS sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_requests_lead    ON coexistence.payment_requests(lead_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status  ON coexistence.payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_created ON coexistence.payment_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_requests_course  ON coexistence.payment_requests(course_id);
-- Digits-only phone, so the Sales Log / lead lookup can find a request raised
-- before the lead existed.
CREATE INDEX IF NOT EXISTS idx_payment_requests_phone   ON coexistence.payment_requests(customer_phone);

-- ── 3. Bind the event log back to the request ────────────────────────────────
-- FK-less on purpose, matching course_id / payment_link_id / matched_lead_id on
-- the same table: razorpay_events is an append-only audit trail that must
-- outlive anything it points at.
ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS payment_request_id BIGINT;
ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS razorpay_link_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_rzp_events_request ON coexistence.razorpay_events(payment_request_id);
CREATE INDEX IF NOT EXISTS idx_rzp_events_plink   ON coexistence.razorpay_events(razorpay_link_id);

COMMENT ON TABLE coexistence.payment_requests IS
  'Razorpay payment links minted by ForgeGrowth. razorpay_link_id is the exact join key that replaces amount-guessing (courses.matchLink) for links we created.';
