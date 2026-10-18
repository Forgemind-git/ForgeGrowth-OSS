-- 124 — Media Library context for chat media.
-- A chat message whose file is byte-identical to a Media Library item is
-- recognised (SHA-256) and cached as kind 'library' (text = the library id, or
-- '' for "not a library file"). Widening only: old code never writes 'library'.
-- Idempotent; the boot ensure in services/chatAnalyser.js does the same.
ALTER TABLE coexistence.chat_message_artifacts DROP CONSTRAINT IF EXISTS chat_message_artifacts_kind_check;
ALTER TABLE coexistence.chat_message_artifacts ADD CONSTRAINT chat_message_artifacts_kind_check
  CHECK (kind IN ('transcript','vision','document','library'));
