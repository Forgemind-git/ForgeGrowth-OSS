-- 105_broadcast_series.sql — repeating broadcasts.
--
-- One-off scheduling (migration 070) answers "send this at 6pm". A series
-- answers "every Monday at 10am, message whoever has arrived since last time".
-- Those are different enough to need their own row: a one-off has a frozen
-- recipient list and fires once, a series has an audience RULE and fires until
-- you stop it.
--
-- ⚠ A series NEVER sends anything itself. Each run CREATES a normal
-- `broadcasts` row and hands it to the existing `dispatchBroadcast()`, so a
-- repeating send appears in the Bulk Message list with its own delivery stats
-- and there is exactly ONE sender in the codebase. Everything the one-off path
-- enforces — WABA match, billing block, the 24h window — applies unchanged.
--
-- Additive and idempotent; safe to apply before or after the backend.

BEGIN;

CREATE TABLE IF NOT EXISTS coexistence.broadcast_series (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT FALSE,

  -- What to send. Mirrors the broadcast columns this clones into each run.
  -- ⚠ Deliberately NO payment_* columns. A payment template mints a LIVE
  -- Razorpay link per recipient; a repeating loop that does that is the
  -- re-runnable-money-action trap. The route refuses such a template outright.
  from_number       TEXT NOT NULL,
  message_type      TEXT NOT NULL DEFAULT 'template',
  template_id       BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
  variable_mapping  JSONB NOT NULL DEFAULT '{}'::jsonb,
  body              TEXT,
  url               TEXT,
  media_library_id  BIGINT REFERENCES coexistence.media_library(id) ON DELETE SET NULL,
  caption           TEXT,

  -- WHO, as a rule rather than a list — re-evaluated on every run.
  --   { scope:'number'|'all', waNumber, tagIds:[], arrivedWithinDays, notRepliedForDays }
  -- Windows are RELATIVE on purpose: an absolute date range would match the
  -- identical people every week, which is not what "repeating" means.
  audience          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- WHEN: { kind:'daily'|'weekly'|'monthly', daysOfWeek:[1..7], dayOfMonth:1-31, timeOfDay:'HH:MM' }
  -- timeOfDay is wall-clock Asia/Kolkata, the timezone every other schedule in
  -- this app is expressed in.
  recurrence        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ⚠ Default TRUE. Without it, "every Monday message recent arrivals" hits
  -- last Monday's people again, every week, forever. Turning it off is a
  -- deliberate choice for a genuine repeat reminder to a fixed cohort.
  skip_already_sent BOOLEAN NOT NULL DEFAULT TRUE,

  -- Per-run blast ceiling. A rule that suddenly matches thousands (an import,
  -- a viral ad) must not become the largest send this account has ever made
  -- without anyone deciding that.
  max_per_run       INT NOT NULL DEFAULT 500,

  -- A series MUST be able to end. An unbounded repeating blast to real
  -- customers should not be expressible; the route requires one of these.
  ends_on           DATE,
  max_runs          INT,
  runs_count        INT NOT NULL DEFAULT 0,

  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  last_error        TEXT,

  created_by        BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claim query's index: only ACTIVE rows are ever due.
CREATE INDEX IF NOT EXISTS idx_broadcast_series_due
  ON coexistence.broadcast_series (next_run_at)
  WHERE active AND next_run_at IS NOT NULL;

-- One row per fired run, pointing at the real broadcast it created.
CREATE TABLE IF NOT EXISTS coexistence.broadcast_series_runs (
  id               BIGSERIAL PRIMARY KEY,
  series_id        BIGINT NOT NULL REFERENCES coexistence.broadcast_series(id) ON DELETE CASCADE,
  broadcast_id     BIGINT REFERENCES coexistence.broadcasts(id) ON DELETE SET NULL,
  ran_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient_count  INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'sent',   -- sent | skipped | failed
  note             TEXT
);
CREATE INDEX IF NOT EXISTS idx_broadcast_series_runs_series
  ON coexistence.broadcast_series_runs (series_id, ran_at DESC);

-- The don't-repeat ledger. UNIQUE is the guard, not an application check: two
-- overlapping ticks must not both decide the same person is unsent.
CREATE TABLE IF NOT EXISTS coexistence.broadcast_series_sends (
  series_id       BIGINT NOT NULL REFERENCES coexistence.broadcast_series(id) ON DELETE CASCADE,
  contact_number  TEXT NOT NULL,
  first_sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (series_id, contact_number)
);

COMMENT ON TABLE coexistence.broadcast_series IS
  'A repeating broadcast. Each run creates a real broadcasts row and dispatches it through dispatchBroadcast() — a series never sends anything itself.';
COMMENT ON COLUMN coexistence.broadcast_series.audience IS
  'Rule re-evaluated every run. Windows are relative (arrivedWithinDays / notRepliedForDays), never absolute dates.';
COMMENT ON TABLE coexistence.broadcast_series_sends IS
  'Who this series has already reached. The PRIMARY KEY is the don''t-repeat guard; an application-level check would race between overlapping ticks.';

COMMIT;
