-- 106_remove_deprecated_blocks.sql — 2026-08-12
--
-- Removes the schema behind two features deleted in the same change:
--   1. Follow-up Sequences (migrations 095 + 096) — the whole feature.
--   2. The automation Payment NODE (part of migration 091) — its watch table.
--
-- ⚠ DEPLOY ORDER: this migration ships WITH the backend, never before it.
-- The pre-106 image reads follow_up_log on every failed send (sendQueue), joins
-- follow_up_log on every lead list (leads.js), and its boot ensure recreates
-- payment_watches. Applying it under the old image would throw on those paths
-- and would partly undo itself.
--
-- ⚠ WHAT IS DELIBERATELY *NOT* TOUCHED
--   • coexistence.team_members — the Team Members PAGE was removed, not the
--     data. Both live rows carry phone numbers that match registered WhatsApp
--     business numbers, and routes/messages.js reads them to LABEL those
--     numbers in the Chats sidebar. bda.js and MCP get_bda_activity read it
--     too, and Admin Settings → Team members is still a full CRUD surface.
--   • leads.follow_up_count — the consecutive-chase streak the cold-drop
--     engine reads. Kept (frozen; its only writer was the follow-up engine).
--   • chatbots.webhook_secret — unused now that the Webhook Received / API
--     Event triggers are gone, but left so an automation exported from an
--     instance that still has them imports without error.
--   • payment_requests and everything behind Sales → Payments / the /pay/
--     redirect / payment templates. Only the automation NODE went.
--
-- Idempotent: safe to re-run.

BEGIN;

-- ── 1. Follow-up Sequences ───────────────────────────────────────────────────
-- Dropped child-first for readability; CASCADE covers the FKs either way.
DROP TABLE IF EXISTS coexistence.follow_up_log         CASCADE;
DROP TABLE IF EXISTS coexistence.follow_up_enrollments CASCADE;
DROP TABLE IF EXISTS coexistence.follow_up_steps       CASCADE;
DROP TABLE IF EXISTS coexistence.follow_up_sequences   CASCADE;
-- The enrollment cursor over lead_events (singleton row).
DROP TABLE IF EXISTS coexistence.follow_up_state       CASCADE;

-- ── 2. The automation Payment node's watch table ─────────────────────────────
-- Its only two writers were that node and the agent payment tools (removed
-- with migration 104), so nothing could open a watch any more.
DROP TABLE IF EXISTS coexistence.payment_watches CASCADE;

-- ── 3. Hide the now-frozen Follow-ups column on the Leads table ──────────────
-- entity_fields.follow_up_count maps to leads.follow_up_count, which nothing
-- increments now — every lead reads 0. A column of permanent zeros labelled
-- "Follow-ups" after removing the Follow-ups feature is worse than no column.
-- The registry row survives, so Admin Settings → Fields can show it again.
UPDATE coexistence.entity_fields
   SET show_in_leads = FALSE, updated_at = NOW()
 WHERE entity = 'lead' AND field_key = 'follow_up_count' AND show_in_leads = TRUE;

COMMIT;
