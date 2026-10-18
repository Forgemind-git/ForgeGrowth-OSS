-- 129: Sales → Payments → Dashboard — saved filter presets.
--
-- One row per saved filter combination, private to the user who saved it.
-- `filters` is the dashboard's own state (date range, grouping, split, status,
-- method, amount range, one-per-payer, search). A rolling range is stored as
-- the RULE ("since 2026-04-01 to today", "last 30 days"), never as two fixed
-- dates, so opening the preset next month still ends on that day.
-- `is_default` = open the dashboard with this preset; at most one per user.
--
-- Additive + idempotent; routes/paymentFilterPresets.js ensurePresetTables()
-- mirrors it at boot.

CREATE TABLE IF NOT EXISTS coexistence.payment_filter_presets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_name
  ON coexistence.payment_filter_presets (user_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_default
  ON coexistence.payment_filter_presets (user_id) WHERE is_default;
