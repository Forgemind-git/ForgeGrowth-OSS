-- 070_broadcast_scheduling.sql
--
-- Scheduled broadcasts. The docs claimed a DRAFT → SCHEDULED → SENDING flow but
-- the status CHECK never allowed 'SCHEDULED' and nothing ever polled for due
-- rows, so scheduling did not exist. This adds it.
--
-- `scheduled_at` is TIMESTAMPTZ (absolute instant), NOT a wall-clock string —
-- the UI sends an ISO instant so a send fires at the right moment regardless of
-- the server's or the operator's timezone. 6:00 PM IST == 12:30 UTC.
--
-- Idempotent / re-runnable.

ALTER TABLE coexistence.broadcasts
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- Widen the status CHECK to admit SCHEDULED.
ALTER TABLE coexistence.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE coexistence.broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status::text = ANY (ARRAY[
    'DRAFT'::varchar, 'SCHEDULED'::varchar, 'SENDING'::varchar,
    'SENT'::varchar, 'FAILED'::varchar
  ]::text[]));

-- The scheduler polls this every minute; a partial index keeps that lookup on
-- the handful of pending rows instead of the whole table.
CREATE INDEX IF NOT EXISTS idx_broadcasts_due
  ON coexistence.broadcasts (scheduled_at)
  WHERE status = 'SCHEDULED';
