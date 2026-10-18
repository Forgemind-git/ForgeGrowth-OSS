-- 132_sale_refunds.sql — refunds recorded against a sale (2026-10-16).
--
-- A sale is an enrolled lead; a refund is money given back to that person,
-- usually outside the gateway (bank transfer / UPI), so Razorpay's own refund
-- field does not see it. Several refunds per sale are allowed. Amounts in
-- PAISE like every other money column; rupees are converted at the API.
-- Additive and idempotent; routes/salesLog.js ensureSalesLogTables() mirrors it.

CREATE TABLE IF NOT EXISTS coexistence.sale_refunds (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  refunded_on   DATE NOT NULL,
  method        TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sale_refunds_lead ON coexistence.sale_refunds (lead_id);
