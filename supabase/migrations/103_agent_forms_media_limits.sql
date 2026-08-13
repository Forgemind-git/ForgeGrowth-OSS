-- 103_agent_forms_media_limits.sql
--
-- Two independent ceilings on what an inbound MEDIA message may cost an agent,
-- plus nothing at all for the new `lead_form` tool type — `agent_tools.tool_type`
-- is free TEXT with no CHECK constraint (migration 044), so a new tool type is
-- purely application-level. That is deliberate and worth stating: do NOT add a
-- CHECK there now, or every future tool type becomes a migration.
--
-- ADDITIVE ONLY. Both columns are nullable with no default, so this can be
-- applied before or after the backend (anti-pattern #39) and every existing
-- agent keeps today's behaviour until someone types a number.
--
-- ⚠ NULL = no limit. 0 is NOT a limit of zero — it is invalid input that both
-- the form control and the server normaliser clear back to NULL (anti-pattern
-- #51). A `NOT NULL DEFAULT 0` here would read to the enforcement code as
-- "zero seconds of audio allowed" and silence every voice note on every
-- existing agent the moment this shipped.
--
-- Idempotent; re-runnable.

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS max_voice_seconds           INT,
  ADD COLUMN IF NOT EXISTS max_images_per_conversation INT;

COMMENT ON COLUMN coexistence.agents.max_voice_seconds IS
  'Longest inbound voice note this agent will transcribe, in seconds. NULL = no limit. '
  'Measured off the downloaded file with ffprobe BEFORE the file is sent to Whisper, so a '
  'ten-minute note costs nothing. A note over the cap is not transcribed; the run still '
  'happens with a synthetic note so the agent can ask for a shorter one instead of going silent.';

COMMENT ON COLUMN coexistence.agents.max_images_per_conversation IS
  'How many inbound images this agent will look at in one conversation. NULL = no limit. '
  'Counted per conversation (bounded by trigger_session_minutes), NOT per message: WhatsApp '
  'delivers each photo as its own message, so a per-message cap could only ever be 1.';
