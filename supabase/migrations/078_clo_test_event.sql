-- ─── Migration 078: remember the last CLO test-event result ─────────────────
--
--  The readiness checklist has to answer "dataset configured AND test event
--  verified". Configuration is readable from clo_settings, but whether Meta
--  actually ACCEPTED a test event is only known at the moment it is sent — and
--  a result nobody stored is a check nobody can make. Without this the panel
--  could only say "a dataset id exists", which is not the same thing and is
--  exactly the false confidence a readiness check is supposed to prevent.
--
-- Idempotent + re-runnable. Mirrored by ensureCloTables() in routes/clo.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/078_clo_test_event.sql

ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_event_at TIMESTAMPTZ;
ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_ok       BOOLEAN;
ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_error    TEXT;
