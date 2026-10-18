-- 090_community_media.sql — permanent, self-owned copies of Communities media.
--
-- WHY THIS EXISTS
-- ---------------
-- Group media reached us in three states, none of which is a durable guarantee:
--   1. Archived by Evolution into ITS OWN MinIO bucket — durable today (no
--      lifecycle rule), but owned by a service we do not control.
--   2. Not archived, but WhatsApp still serves it — WhatsApp bakes an expiry
--      into every media URL (the `oe=` parameter, ~26 days from send). After
--      that the file is unrecoverable, permanently.
--   3. Not archived and past that expiry — already lost.
--
-- Evolution only began copying media on 2026-05-30, and DOCUMENTS only from
-- 2026-07-30, so state 2 is not hypothetical: it is how every document sent
-- before 30 July was lost. This table records files we have copied into OUR
-- bucket, so Communities stops depending on either WhatsApp's retention or
-- Evolution's bucket.
--
-- Idempotent; re-runnable.

CREATE TABLE IF NOT EXISTS coexistence.community_media (
  -- Evolution's `Message.id` (its own row id, not the WhatsApp message id).
  message_id     TEXT PRIMARY KEY,
  instance_name  TEXT NOT NULL,
  group_jid      TEXT NOT NULL,
  -- Object key inside the app's own MinIO bucket. NULL while a copy is still
  -- being attempted or has permanently failed — the row then exists purely to
  -- record that we tried, so a dead file is not retried forever.
  object_key     TEXT,
  mime_type      TEXT,
  bytes          BIGINT,
  -- Where the bytes came from: 'evolution_s3' (cheap, already decrypted) or
  -- 'whatsapp' (decrypted on demand before its URL expired).
  source         TEXT,
  sent_at        TIMESTAMPTZ,
  stored_at      TIMESTAMPTZ,
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE coexistence.community_media IS
  'Permanent copies of WhatsApp group media held in the app''s own bucket, so Communities does not depend on WhatsApp retention or on Evolution''s bucket.';

CREATE INDEX IF NOT EXISTS idx_community_media_group
  ON coexistence.community_media (group_jid);

-- Finds rows still worth retrying: no object yet and not yet given up on.
CREATE INDEX IF NOT EXISTS idx_community_media_pending
  ON coexistence.community_media (attempts) WHERE object_key IS NULL;
