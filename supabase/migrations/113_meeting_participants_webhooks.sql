-- 113 — Participants that do not depend on Zoom, and outgoing meeting webhooks.
--
-- TWO problems, one migration.
--
-- 1. THE PARTICIPANT LIST WAS EMPTY ON EVERY MEETING, and Zoom was never going
--    to fix it. `meeting_participants` was written by exactly one caller —
--    zoomSync — and Zoom has never been connected here (client_credentials on a
--    General app mints a token carrying only marketplace scopes; every meeting
--    endpoint then answers 401/124). Even fully connected it would cover less
--    than half: 15 of the 28 imported recordings are Zoom, the other 13 are
--    Google Meet, which Zoom cannot see at all.
--
--    Fathom already carries the answer and we were discarding it: 26 of 28
--    recordings name 2-5 distinct speakers in the transcript, each with a
--    display name and often a matched calendar-invitee email. So a participant
--    row now records WHERE it came from, and a Fathom-derived one records what
--    a transcript can actually prove — that this person spoke, how many turns
--    they took, and when they first and last spoke.
--
--    ⚠ `source` is on the row, not the meeting, because one meeting can have
--    both: a Zoom row is a JOIN (with real join/leave times, one per rejoin), a
--    Fathom row is a PERSON who was heard. They answer different questions and
--    must not overwrite each other — the derivation only ever replaces rows it
--    owns (source = 'fathom').
--
-- 2. NOTHING COULD BE TRIGGERED WHEN A MEETING LANDED. Meeting Notes was
--    read-only in both directions: Fathom and Zoom push into it, and nothing
--    pushed out. `meeting_webhooks` lets an agent be called the moment a
--    recording arrives, with `meeting_webhook_deliveries` as the log — a
--    fire-and-forget POST with no record of what happened is unsupportable the
--    first time somebody asks "did it fire?".

BEGIN;

/* ------------------------- participants: provenance ---------------------- */

ALTER TABLE coexistence.meeting_participants
  ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'zoom',
  ADD COLUMN IF NOT EXISTS is_speaker    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_invitee    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS segment_count INT,
  ADD COLUMN IF NOT EXISTS first_offset  TEXT,
  ADD COLUMN IF NOT EXISTS last_offset   TEXT;

ALTER TABLE coexistence.meeting_participants DROP CONSTRAINT IF EXISTS meeting_participants_source_check;
ALTER TABLE coexistence.meeting_participants
  ADD CONSTRAINT meeting_participants_source_check CHECK (source IN ('zoom','fathom','manual'));

-- ⚠ The old index keyed on (meeting, zoom_participant_id, name, join_time). A
-- Fathom row has neither a participant id nor a join time, so two people with
-- the same display name from DIFFERENT sources would collide on it. Adding
-- `source` keeps each source's rows independent, which is the whole point of
-- the column.
DROP INDEX IF EXISTS coexistence.uq_meeting_participant_join;
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_participant_join
  ON coexistence.meeting_participants
     (meeting_id, source, COALESCE(zoom_participant_id, ''), COALESCE(lower(name), ''),
      COALESCE(join_time, 'epoch'::timestamptz));

CREATE INDEX IF NOT EXISTS idx_meeting_participants_source
  ON coexistence.meeting_participants (meeting_id, source);

/* --------------------------- outgoing webhooks --------------------------- */

CREATE TABLE IF NOT EXISTS coexistence.meeting_webhooks (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  -- Signing secret, stored encrypted like every other credential here. The
  -- receiver verifies with the same Standard Webhooks scheme we already use to
  -- verify Fathom's inbound deliveries, so there is one signature format in
  -- this codebase rather than two.
  secret_encrypted TEXT,
  events           JSONB NOT NULL DEFAULT '[]'::jsonb,
  headers          JSONB NOT NULL DEFAULT '{}'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  -- Health, reported separately from `active` for the same reason the Fathom
  -- panel reports API and webhook health separately: a switch that is on tells
  -- you nothing about whether the last delivery arrived.
  last_status      TEXT,
  last_error       TEXT,
  last_delivery_at TIMESTAMPTZ,
  created_by       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.meeting_webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    BIGINT NOT NULL REFERENCES coexistence.meeting_webhooks(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  -- FK-less on purpose, like razorpay_events: the log outlives what it points
  -- at, and a delivery that fired is a fact even after the meeting is deleted.
  meeting_id    BIGINT,
  event_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INT  NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  http_status   INT,
  error         TEXT,
  payload       JSONB,
  response_body TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ
);

ALTER TABLE coexistence.meeting_webhook_deliveries DROP CONSTRAINT IF EXISTS meeting_webhook_deliveries_status_check;
ALTER TABLE coexistence.meeting_webhook_deliveries
  ADD CONSTRAINT meeting_webhook_deliveries_status_check
  CHECK (status IN ('pending','sent','failed','gave_up'));

-- ⚠ THE DEDUPE THAT STOPS A RE-SYNC RE-FIRING EVERY WEBHOOK. `event_id` is
-- derived from (event, meeting, and for update events the content that
-- changed), so the hourly Fathom sync — which re-reads a 48h overlap window on
-- every tick and therefore "updates" the same meetings repeatedly — cannot
-- deliver the same thing again and again. It is a UNIQUE INDEX rather than a
-- check in the emitter because two ticks can overlap.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_webhook_delivery_event
  ON coexistence.meeting_webhook_deliveries (webhook_id, event_id);

CREATE INDEX IF NOT EXISTS idx_meeting_webhook_deliveries_due
  ON coexistence.meeting_webhook_deliveries (next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_meeting_webhook_deliveries_recent
  ON coexistence.meeting_webhook_deliveries (webhook_id, created_at DESC);

COMMIT;
