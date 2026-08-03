-- ─── Migration 087: Razorpay payment ledger (the PULL half) ──────────────────
-- Mirrors ensurePaymentLedgerTables() in backend/src/services/razorpayLedger.js
-- (runtime source of truth). Idempotent.
--
-- WHY THIS EXISTS
-- The Razorpay integration was push-only. A webhook can only ever know about
-- events sent AFTER it was configured, so everything before that was invisible.
-- Measured against the live account on 2026-08-02, the moment API keys were
-- added: Razorpay held 324 captured payments worth ₹474,959 going back to
-- 2025-02-07, while ForgeGrowth knew about 12 (₹53,992). 312 real payments —
-- ₹420,967 — existed nowhere in this dashboard.
--
-- A pull also covers the ongoing failure mode a webhook cannot: an event
-- Razorpay never successfully delivered (our outage, a wrong URL for an hour,
-- a Cloudflare challenge) is lost forever with no trace. Re-reading the ledger
-- self-heals that.
--
-- ⚠ WHY A SEPARATE TABLE, NOT razorpay_events
-- razorpay_events is the WEBHOOK AUDIT TRAIL and is aggregated by the revenue,
-- Sales Log and CTWA ROAS paths. Writing 1.5 years of historical payments into
-- it would silently move numbers across the whole app and, through the
-- captured-payment handler, retroactively enrol hundreds of people and mirror
-- won-stage tags onto their WhatsApp contacts. This table is deliberately a
-- read-only LEDGER: it records what Razorpay has, changes no CRM state, and can
-- be dropped without affecting anything else. Attribution stays an explicit,
-- separate decision.
CREATE TABLE IF NOT EXISTS coexistence.razorpay_payments (
  payment_id             TEXT PRIMARY KEY,          -- Razorpay's pay_… id
  order_id               TEXT,
  invoice_id             TEXT,

  status                 TEXT,                      -- created|authorized|captured|refunded|failed
  amount_paise           BIGINT NOT NULL DEFAULT 0,
  amount_refunded_paise  BIGINT NOT NULL DEFAULT 0,
  currency               TEXT,
  method                 TEXT,                      -- upi|card|netbanking|wallet…
  captured               BOOLEAN,

  description            TEXT,
  payer_email            TEXT,
  payer_contact          TEXT,
  notes                  JSONB,

  fee_paise              BIGINT,
  tax_paise              BIGINT,
  error_code             TEXT,
  error_description      TEXT,

  -- Razorpay's own creation time (UNIX seconds in the API, stored as a real
  -- timestamp here). NOT the row's insert time — the whole point is history.
  paid_at                TIMESTAMPTZ,

  -- Best-effort link to CRM records. Filled by the matcher where it is
  -- confident; left NULL otherwise. NULL is a normal, expected value here and
  -- must never be treated as an error — most 2025 payments predate the funnel.
  matched_lead_id        BIGINT,
  matched_lead_name      TEXT,
  match_method           TEXT,                      -- phone|email|payment_link|null

  raw                    JSONB,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rzp_payments_paid_at ON coexistence.razorpay_payments(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_rzp_payments_status  ON coexistence.razorpay_payments(status);
CREATE INDEX IF NOT EXISTS idx_rzp_payments_contact ON coexistence.razorpay_payments(payer_contact);
CREATE INDEX IF NOT EXISTS idx_rzp_payments_lead    ON coexistence.razorpay_payments(matched_lead_id);

-- Sync bookkeeping on the existing singleton config.
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_synced_at    TIMESTAMPTZ;
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_sync_error   TEXT;
ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_synced_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON TABLE coexistence.razorpay_payments IS
  'Read-only ledger of every payment Razorpay holds, pulled via the API. Separate from razorpay_events (the webhook audit trail) so importing history cannot mutate CRM state or move revenue figures that aggregate that table.';
