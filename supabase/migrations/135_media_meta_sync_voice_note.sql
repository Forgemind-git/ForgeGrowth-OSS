-- 135: remember whether a library file's copy at Meta is a voice note.
--
-- Library audio is uploaded to Meta as a voice note in WhatsApp's own layout
-- (services/outboundAudio.js prepareVoiceNote), or — when too long for the
-- 512 KB voice-note limit — as ordinary M4A audio. The send queue reads this to
-- add `voice: true` for exactly the voice-note copies: a voice-note file sent
-- without it, or an M4A sent with it, does not play as intended.
--
-- Default false is right for every existing row: copies uploaded before this
-- change are ordinary audio (or not audio at all).

ALTER TABLE coexistence.media_meta_sync
  ADD COLUMN IF NOT EXISTS is_voice_note BOOLEAN NOT NULL DEFAULT false;

-- The send queue looks a copy up by its Meta media id on every audio send.
CREATE INDEX IF NOT EXISTS idx_media_meta_sync_meta_media_id
  ON coexistence.media_meta_sync (meta_media_id) WHERE meta_media_id IS NOT NULL;
