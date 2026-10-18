-- ─── Migration 112: Zoom joins Meeting Notes — one meeting, many sources ─────
-- Mirrors ensureMeetingTables() in backend/src/routes/meetings.js (the runtime
-- source of truth, which self-heals at boot). Idempotent + additive.
--
-- WHAT CHANGED CONCEPTUALLY
-- Migration 111 assumed one meeting had one origin: Fathom recorded it, or a
-- person typed it. Zoom breaks that assumption in the useful direction — the
-- SAME call is a Zoom occurrence (who joined, when they left, what was said in
-- chat) and a Fathom recording (transcript, summary). Those are two views of one
-- event, so they must be ONE ROW, not two.
--
-- ⚠ THE LOAD-BEARING RULE OF THIS MIGRATION: THE TWO SYNCS MUST MERGE, NEVER
-- DUPLICATE. Both run on timers and either may see a meeting first, so each
-- upsert looks for the other's row before inserting its own. The join key is the
-- ZOOM MEETING ID, which Fathom already stores inside `meeting_url`
-- (https://us06web.zoom.us/j/84303867326?pwd=…) — measured on live data: 16 of
-- 28 imported meetings carry one.
--
-- ⚠ AND IT IS NOT KEYED ON THAT ALONE. A Zoom meeting id is REUSED by every
-- occurrence of a recurring meeting — a weekly call has one id and many
-- instances — while the UUID is unique per occurrence. Matching on the id alone
-- would staple Tuesday's transcript onto last week's participant list. So the
-- id narrows the candidates and the TIME WINDOW picks the occurrence, and
-- `zoom_uuid` (unique) is what a Zoom row is actually keyed on.

-- ── 1. Zoom connection ───────────────────────────────────────────────────────
-- Two auth modes, because Zoom has two kinds of app and they are not
-- interchangeable:
--   's2s'   — Server-to-Server OAuth: account_id + client id/secret, no browser
--             consent, reads the whole account. The right mode for "track every
--             meeting" unattended.
--   'oauth' — a General app: authorization-code with a browser consent, scoped
--             to the user who consented.
-- ⚠ A General app's CLIENT-CREDENTIALS token cannot read meetings at all. It is
-- minted happily and then every meeting endpoint answers 401 code 124, "This API
-- does not support client credentials for authorization" — verified against the
-- live credentials. So there is no third, credentials-only mode to add later.
CREATE TABLE IF NOT EXISTS coexistence.zoom_config (
  id                       INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auth_mode                TEXT NOT NULL DEFAULT 's2s',
  client_id                TEXT,
  client_secret_encrypted  TEXT,
  account_id               TEXT,               -- s2s only
  redirect_uri             TEXT,               -- oauth only
  -- oauth tokens. ⚠ Zoom ROTATES the refresh token on every use and invalidates
  -- the old one, so a refresh that fails to persist the new value permanently
  -- breaks the connection. Both are written in the same UPDATE as the expiry.
  access_token_encrypted   TEXT,
  refresh_token_encrypted  TEXT,
  token_expires_at         TIMESTAMPTZ,
  scopes                   JSONB,
  zoom_user_id             TEXT,
  account_email            TEXT,
  status                   TEXT NOT NULL DEFAULT 'not_configured',
  last_error               TEXT,
  sync_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at           TIMESTAMPTZ,
  last_sync_added          INT NOT NULL DEFAULT 0,
  last_sync_updated        INT NOT NULL DEFAULT 0,
  -- Zoom webhooks carry their own secret token, and health is reported
  -- separately from the API for the same reason Fathom's is: a working pull
  -- must never imply a working push.
  webhook_secret_encrypted TEXT,
  webhook_status           TEXT NOT NULL DEFAULT 'not_configured',
  webhook_last_error       TEXT,
  last_webhook_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE coexistence.zoom_config
    ADD CONSTRAINT zoom_config_auth_mode_check CHECK (auth_mode IN ('s2s','oauth'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coexistence.zoom_config
    ADD CONSTRAINT zoom_config_status_check CHECK (status IN ('not_configured','connected','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE coexistence.zoom_config
    ADD CONSTRAINT zoom_config_webhook_status_check CHECK (webhook_status IN ('not_configured','ok','error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO coexistence.zoom_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 2. Zoom's view of a meeting, on the row 111 already owns ─────────────────
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_uuid          TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_meeting_id    TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_host_email    TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_join_url      TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_topic         TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_agenda        TEXT;
-- 'scheduled' = it exists but has not happened; 'finished' = it has.
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_state         TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_duration_min  INT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_timezone      TEXT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_total_minutes INT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS zoom_synced_at     TIMESTAMPTZ;
-- Denormalised so the LIST can say "9 people, 24 messages" without loading two
-- child tables for every row. Recomputed on every Zoom sync, never by hand.
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS participant_count  INT;
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS chat_message_count INT;
-- Why chat is or is not available for THIS meeting, so an empty tab can explain
-- itself instead of looking broken. See services/zoomSync.js CHAT_STATES.
ALTER TABLE coexistence.meetings ADD COLUMN IF NOT EXISTS chat_state         TEXT;

-- Unique per OCCURRENCE. Nullable, so the many Fathom-only and manual rows are
-- unaffected (Postgres allows many NULLs in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_zoom_uuid
  ON coexistence.meetings (zoom_uuid) WHERE zoom_uuid IS NOT NULL;
-- NOT unique: every occurrence of a recurring meeting shares this id. It is the
-- lookup that finds candidates for the merge, never the key.
CREATE INDEX IF NOT EXISTS idx_meetings_zoom_meeting_id
  ON coexistence.meetings (zoom_meeting_id) WHERE zoom_meeting_id IS NOT NULL;

-- 'zoom' joins the origins. `source` records where a row STARTED; a row that
-- carries both a fathom_recording_id and a zoom_uuid is showing both, whichever
-- of the two syncs happened to create it.
DO $$ BEGIN
  ALTER TABLE coexistence.meetings DROP CONSTRAINT IF EXISTS meetings_source_check;
  ALTER TABLE coexistence.meetings
    ADD CONSTRAINT meetings_source_check CHECK (source IN ('fathom','manual','zoom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Who was in the room ──────────────────────────────────────────────────
-- ⚠ ONE ROW PER JOIN, NOT PER PERSON. Somebody who drops out and comes back is
-- two rows, and collapsing them would lose exactly the "when they came, when
-- they left" the participant list exists to show. The uniqueness therefore
-- includes join_time.
CREATE TABLE IF NOT EXISTS coexistence.meeting_participants (
  id                  BIGSERIAL PRIMARY KEY,
  meeting_id          BIGINT NOT NULL REFERENCES coexistence.meetings(id) ON DELETE CASCADE,
  zoom_participant_id TEXT,
  zoom_user_id        TEXT,
  name                TEXT,
  email               TEXT,
  join_time           TIMESTAMPTZ,
  leave_time          TIMESTAMPTZ,
  duration_seconds    INT,
  is_host             BOOLEAN NOT NULL DEFAULT FALSE,
  device              TEXT,
  location            TEXT,
  leave_reason        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_participant_join
  ON coexistence.meeting_participants
     (meeting_id, COALESCE(zoom_participant_id, ''), COALESCE(name, ''), COALESCE(join_time, 'epoch'));
CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting
  ON coexistence.meeting_participants (meeting_id, join_time);

-- ── 4. What was said in the chat ────────────────────────────────────────────
-- ⚠ In-meeting chat is NOT a REST resource. Zoom delivers it as a CHAT file
-- attached to the CLOUD RECORDING, so it exists only for meetings that were
-- recorded to the cloud, and only with the cloud_recording scope. That is a
-- Zoom limitation, not a gap here — `meetings.chat_state` records which of
-- those it is so the tab can say so.
CREATE TABLE IF NOT EXISTS coexistence.meeting_chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  meeting_id   BIGINT NOT NULL REFERENCES coexistence.meetings(id) ON DELETE CASCADE,
  sender       TEXT,
  recipient    TEXT,
  message      TEXT NOT NULL,
  sent_at      TIMESTAMPTZ,
  offset_label TEXT,             -- the raw "10:04:23" the chat file carries
  seq          INT NOT NULL,     -- order within the file; the only stable sort
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Re-parsing the same chat file must not double the conversation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_chat_seq
  ON coexistence.meeting_chat_messages (meeting_id, seq);
CREATE INDEX IF NOT EXISTS idx_meeting_chat_meeting
  ON coexistence.meeting_chat_messages (meeting_id, seq);
