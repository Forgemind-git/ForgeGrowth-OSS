-- 050_agent_triggers_media.sql
-- Brings coexistence.agents up to the ported Forge-Chat agent builder:
--   status (draft|active), keyword trigger gating, and media groups.
-- FORGECHAT already has ai_model_id/llm_model, so this only adds the new bits.
-- Additive + idempotent.

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS status                  TEXT    NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS trigger_mode            TEXT    NOT NULL DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS trigger_keyword         TEXT,
  ADD COLUMN IF NOT EXISTS trigger_match_type      TEXT    NOT NULL DEFAULT 'contains',
  ADD COLUMN IF NOT EXISTS trigger_case_sensitive  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS trigger_session_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS media_groups            JSONB   NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_status_check') THEN
    ALTER TABLE coexistence.agents ADD CONSTRAINT agents_status_check CHECK (status IN ('draft', 'active'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_trigger_mode_check') THEN
    ALTER TABLE coexistence.agents ADD CONSTRAINT agents_trigger_mode_check CHECK (trigger_mode IN ('any', 'keyword'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_trigger_match_type_check') THEN
    ALTER TABLE coexistence.agents ADD CONSTRAINT agents_trigger_match_type_check CHECK (trigger_match_type IN ('exact', 'contains', 'starts'));
  END IF;
END $$;

-- Agents missing a model are drafts; complete ones stay active (the default).
UPDATE coexistence.agents SET status = 'draft' WHERE ai_model_id IS NULL OR llm_model IS NULL;
