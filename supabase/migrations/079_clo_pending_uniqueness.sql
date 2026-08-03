-- ─── Migration 079: one ACTIVE CLO event per (lead, stage) ──────────────────
--
--  BUG THIS FIXES, found while building the backfill:
--
--  uq_clo_events_sent guarantees a lead can only be SENT once per stage. It does
--  not stop two rows sitting in 'pending' for the same pair — which the backfill
--  makes easy, because it replays the same stage transitions the scheduled sweep
--  is already picking up.
--
--  flush() marks a whole batch sent in ONE UPDATE. Two pending rows for the same
--  (lead, stage) in that batch would both try to become 'sent', the partial
--  unique index would reject the statement, and the ENTIRE BATCH would fail —
--  not just the duplicate. So a harmless-looking double-enqueue could stall
--  every conversion behind it.
--
--  Widening uniqueness to cover 'pending' as well as 'sent' makes the duplicate
--  impossible to insert in the first place. The application also checks before
--  inserting (gate 3), but a check-then-insert is not atomic and the backfill
--  can run concurrently with the sweep — this index is what actually holds.
--
--  uq_clo_events_sent is kept alongside it. It is strictly subsumed, but it is
--  the index that states the business rule ("never send the same lead's stage
--  twice"), and a future change that relaxes the pending case should not be able
--  to quietly relax that one too.
--
-- Idempotent + re-runnable. Mirrored by ensureCloTables() in routes/clo.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/079_clo_pending_uniqueness.sql

-- Clear any duplicate pending rows before the index goes on, keeping the oldest.
DELETE FROM coexistence.clo_events a
 USING coexistence.clo_events b
 WHERE a.status = 'pending' AND b.status IN ('sent', 'pending')
   AND a.lead_id = b.lead_id AND a.stage_id = b.stage_id
   AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_events_active
  ON coexistence.clo_events(lead_id, stage_id) WHERE status IN ('sent', 'pending');
