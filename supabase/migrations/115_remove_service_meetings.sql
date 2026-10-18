-- 115_remove_service_meetings.sql
--
-- Remove the Service section (Meetings) entirely, and with it the Fathom and
-- Zoom integrations. Requested outright: eliminate the Service part including
-- meetings, and disconnect Zoom and Fathom completely from Forge Growth.
--
-- This is DESTRUCTIVE, unlike the Tables/Scoring removal which left its schema
-- in place. It follows the e-commerce removal (migration 101) instead: the
-- feature is gone, so its tables go with it.
--
-- ⚠ DEPLOY ORDER: BACKEND FIRST, THEN THIS MIGRATION.
-- routes/meetings.js owned ensureMeetingTables(), which recreated every one of
-- these tables at boot. Dropping them while the old image is still running
-- would simply hand them back on the next restart. Deploy-first is safe because
-- the new code never names them.
--
-- What is destroyed (backed up first to
-- /root/backup-system/manual/forgegrowth_pre_service_removal_*.sql, restore
-- verified on a scratch database):
--   meetings                    35 rows (32 transcripts, 31 summaries)
--   meeting_participants        89 rows
--   meeting_folders              1 row
--   meeting_webhooks             0 rows
--   meeting_webhook_deliveries   0 rows
--   fathom_config                1 row (encrypted API key + webhook secret)
--   zoom_config                  1 row (encrypted S2S credentials + token)
--
-- Nothing irreplaceable: no meeting was renamed, annotated or starred, so every
-- row was a mirror of a Fathom recording that still exists in Fathom. Dropping
-- the two config rows is what "disconnect completely" means on our side — the
-- stored credentials cease to exist here. Revoking the Fathom API key and the
-- Zoom app itself has to be done in those accounts; this cannot reach them.
--
-- Order matters: children before parents. meeting_webhook_deliveries FKs
-- meeting_webhooks, meeting_participants FKs meetings, and meetings FKs
-- meeting_folders. CASCADE would do it regardless, but naming the order keeps
-- the intent readable and fails loudly if something unexpected still points here.
--
-- Idempotent: safe to re-run.

DROP TABLE IF EXISTS coexistence.meeting_webhook_deliveries CASCADE;
DROP TABLE IF EXISTS coexistence.meeting_webhooks         CASCADE;
DROP TABLE IF EXISTS coexistence.meeting_participants     CASCADE;
DROP TABLE IF EXISTS coexistence.meetings                 CASCADE;
DROP TABLE IF EXISTS coexistence.meeting_folders          CASCADE;
DROP TABLE IF EXISTS coexistence.fathom_config            CASCADE;
DROP TABLE IF EXISTS coexistence.zoom_config              CASCADE;
