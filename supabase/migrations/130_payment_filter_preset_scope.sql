-- 130: saved payment views per TAB.
--
-- Saved views (129) were Dashboard-only. The All payments tab gets its own, with
-- a different set of filters, so each view now records which tab it belongs to.
-- Names and the "open by default" choice are unique per user PER TAB.
--
-- Additive + idempotent: existing rows become 'dashboard' (all were saved there).
-- The index swap only widens the keys, so the 129-era backend keeps working.
-- routes/paymentFilterPresets.js ensurePresetTables() mirrors it at boot.

ALTER TABLE coexistence.payment_filter_presets
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'dashboard';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_filter_presets_scope_check') THEN
    ALTER TABLE coexistence.payment_filter_presets
      ADD CONSTRAINT payment_filter_presets_scope_check CHECK (scope IN ('dashboard', 'ledger'));
  END IF;
END $$;

DROP INDEX IF EXISTS coexistence.uq_payment_filter_presets_name;
DROP INDEX IF EXISTS coexistence.uq_payment_filter_presets_default;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_scope_name
  ON coexistence.payment_filter_presets (user_id, scope, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_filter_presets_scope_default
  ON coexistence.payment_filter_presets (user_id, scope) WHERE is_default;
