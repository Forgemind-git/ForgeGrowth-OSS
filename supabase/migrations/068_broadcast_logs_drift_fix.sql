-- 068_broadcast_logs_drift_fix.sql
-- Schema-drift fix, unrelated to Lead Forms. coexistence.broadcast_logs was
-- missing wa_message_id/error_message (added to the live forgecrm database
-- via an undocumented hotfix that never got a migration file, so ForgeGrowth
-- — cloned earlier — never received it) and still had the original
-- ('PENDING','SENT','FAILED') status CHECK, while the app code writes
-- lowercase statuses ('sent','delivered','read','failed'). Together these
-- made every broadcast send/test fail with "column error_message does not
-- exist" or a status CHECK violation. Brings the constraint in line with the
-- live forgecrm schema exactly.

ALTER TABLE coexistence.broadcast_logs
  ADD COLUMN IF NOT EXISTS wa_message_id TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE coexistence.broadcast_logs DROP CONSTRAINT IF EXISTS broadcast_logs_status_check;
ALTER TABLE coexistence.broadcast_logs
  ADD CONSTRAINT broadcast_logs_status_check
  CHECK (status IN ('PENDING','sent','delivered','read','failed'));
