-- ─── Migration 111: Service section — Meeting Notes (Fathom) ──────────────────
-- Mirrors ensureMeetingTables() in backend/src/routes/meetings.js (the runtime
-- source of truth, which self-heals at boot). Idempotent + additive: nothing
-- here drops or rewrites an existing object, so either deploy order is safe.
--
-- WHAT THIS IS
-- A third workspace ("Service") whose first surface is Meeting Notes: the
-- recordings Fathom takes of real calls, pulled into ForgeGrowth so they can be
-- read, renamed, annotated and filed alongside the customer they are about.
--
-- ⚠ THE LOAD-BEARING DECISION: A SYNC MUST NEVER OVERWRITE A HUMAN EDIT.
-- Fathom is the upstream and it is re-read on a timer, so the naive UPSERT
-- ("write every column from the API") silently reverts every rename and every
-- note somebody typed — with no error, minutes later, while they are looking at
-- something else. That is why the editable fields are SEPARATE columns from the
-- upstream ones:
--     title        (editable)  vs  fathom_title   (whatever Fathom last said)
--     notes_md     (editable)  vs  summary_md     (Fathom's own summary)
-- and each carries an `*_overridden` flag. Sync always refreshes the upstream
-- column; it writes the editable one ONLY while the flag is false. Clearing an
-- edit therefore restores the upstream value rather than blanking the row.
--
-- ⚠ A DELETE MUST NOT RESURRECT ITSELF. Hard-deleting a Fathom-sourced row just
-- means the next sync re-inserts it, which reads as "delete does nothing". So a
-- synced meeting is HIDDEN (the row survives, carrying the flag), and only a
-- manually-created one is really deleted. The upsert respects `hidden`.

-- ── 1. Integration config — one row, id = 1 ──────────────────────────────────
-- Both secrets are AES-256-GCM encrypted with util/crypto (same key as the Meta
-- and Razorpay credentials). The API key authenticates our OUTBOUND pulls; the
-- webhook secret verifies INBOUND deliveries. They are separate concerns with
-- separate status fields for the same reason razorpay_config had to split them:
-- a working webhook must never imply working API access, or "connected" becomes
-- a badge nobody can trust.
CREATE TABLE IF NOT EXISTS coexistence.fathom_config (
  id                       INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key_encrypted        TEXT,
  webhook_secret_encrypted TEXT,
  -- API-side health
  status                   TEXT NOT NULL DEFAULT 'not_configured',
  last_error               TEXT,
  account_email            TEXT,
  -- Sync bookkeeping. last_synced_at is the incremental watermark; the counters
  -- are what the Integrations panel reports so "it ran" is a number, not a tick.
  last_synced_at           TIMESTAMPTZ,
  last_sync_added          INT NOT NULL DEFAULT 0,
  last_sync_updated        INT NOT NULL DEFAULT 0,
  sync_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Webhook-side health, deliberately independent of `status` above.
  webhook_status           TEXT NOT NULL DEFAULT 'not_configured',
  webhook_last_error       TEXT,
  last_webhook_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE coexistence.fathom_config
    ADD CONSTRAINT fathom_config_status_check
    CHECK (status IN ('not_configured','connected','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE coexistence.fathom_config
    ADD CONSTRAINT fathom_config_webhook_status_check
    CHECK (webhook_status IN ('not_configured','ok','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO coexistence.fathom_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 2. Folders ───────────────────────────────────────────────────────────────
-- FLAT, deliberately. A parent_id would let a folder be dragged inside its own
-- descendant, and walking that cycle is the unbounded-loop class this codebase
-- has already paid for once. Flat folders answer the actual request ("file the
-- recordings") with no walk to bound.
CREATE TABLE IF NOT EXISTS coexistence.meeting_folders (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. Meetings ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.meetings (
  id                  BIGSERIAL PRIMARY KEY,

  -- 'fathom' = pulled from the recorder (sync or webhook). 'manual' = somebody
  -- typed it here. The distinction decides what may be edited, what a re-sync
  -- may overwrite and whether DELETE hides or removes.
  source              TEXT NOT NULL DEFAULT 'manual',

  -- The join key for BOTH ingest paths (the timed sync and the webhook), which
  -- is what lets them share ONE upsert function. UNIQUE, nullable — a manual
  -- meeting has none, and Postgres allows many NULLs in a unique column.
  fathom_recording_id BIGINT UNIQUE,
  fathom_call_id      TEXT,
  fathom_url          TEXT,
  share_url           TEXT,
  meeting_url         TEXT,

  -- Editable vs upstream (see the header note).
  title               TEXT NOT NULL,
  fathom_title        TEXT,
  title_overridden    BOOLEAN NOT NULL DEFAULT FALSE,
  notes_md            TEXT,
  notes_overridden    BOOLEAN NOT NULL DEFAULT FALSE,
  summary_md          TEXT,

  meeting_type        TEXT,
  transcript          JSONB,
  -- The flattened transcript. Stored rather than derived because it is what the
  -- search filter and the copy-all button read, and re-flattening a 2-hour call
  -- on every keystroke of a search box is not free.
  transcript_text     TEXT,
  transcript_language TEXT,
  action_items        JSONB,
  invitees            JSONB,
  recorded_by         JSONB,

  scheduled_start_time TIMESTAMPTZ,
  scheduled_end_time   TIMESTAMPTZ,
  recording_start_time TIMESTAMPTZ,
  recording_end_time   TIMESTAMPTZ,
  -- When this meeting HAPPENED, for sorting and filtering. One column so every
  -- list agrees; populated from the best timestamp the source offers.
  occurred_at          TIMESTAMPTZ,

  folder_id           BIGINT REFERENCES coexistence.meeting_folders(id) ON DELETE SET NULL,
  starred             BOOLEAN NOT NULL DEFAULT FALSE,
  -- A deleted Fathom meeting. The row stays so the next sync recognises it and
  -- leaves it alone instead of re-inserting what somebody just removed.
  hidden              BOOLEAN NOT NULL DEFAULT FALSE,

  created_by          BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE coexistence.meetings
    ADD CONSTRAINT meetings_source_check CHECK (source IN ('fathom','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_meetings_occurred    ON coexistence.meetings (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_folder      ON coexistence.meetings (folder_id);
CREATE INDEX IF NOT EXISTS idx_meetings_visible     ON coexistence.meetings (hidden, occurred_at DESC);
