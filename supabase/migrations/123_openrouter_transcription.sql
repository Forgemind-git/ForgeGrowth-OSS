-- 123 — Voice-note transcription moves from OpenAI Whisper to OpenRouter
-- (microsoft/mai-transcribe-2). Idempotent; the boot ensure in
-- services/chatAnalyser.js performs the same steps.
--
-- Existing transcripts in chat_message_artifacts are KEPT and stay reusable —
-- a voice note transcribed by Whisper is never paid for again. Only notes with
-- no usable transcript go to the new model.

ALTER TABLE coexistence.chat_analyser_config
  ALTER COLUMN transcribe_model SET DEFAULT 'microsoft/mai-transcribe-2';

UPDATE coexistence.chat_analyser_config
   SET transcribe_model = 'microsoft/mai-transcribe-2', updated_at = NOW()
 WHERE transcribe_model IS DISTINCT FROM 'microsoft/mai-transcribe-2';

-- Rate card is only used to ESTIMATE untranscribed notes (a real call records the
-- cost OpenRouter reports). Measured 2026-09-23: $0.000417 for a 15 s note =
-- $0.00167 per minute. Replaced only while it still holds the Whisper entry, so
-- a later admin edit is never overwritten by a re-run.
UPDATE coexistence.chat_analyser_config
   SET rate_card = jsonb_set(rate_card, '{audio}',
         '{"microsoft/mai-transcribe-2":{"perMinute":0.00167},"default":{"perMinute":0.00167}}'::jsonb)
 WHERE rate_card->'audio' ? 'whisper-1';
