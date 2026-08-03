-- 055_agent_crm_handoff_close.sql
-- Turns the AI agent into a first-class CRM actor. Three feature groups, all
-- additive + idempotent:
--   1. CRM write-back  — agent may tag/assign/score/edit its own contact.
--   2. Human handoff   — agent (or a keyword, or a BDA) can hand a conversation
--                        to a human; the bot then stays silent until resumed.
--   3. Close summary   — after a conversation goes idle, summarise + log it.

-- ── Agent config ──────────────────────────────────────────────────────────
ALTER TABLE coexistence.agents
  -- 1. CRM write-back
  ADD COLUMN IF NOT EXISTS crm_tools_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  -- 2. Human handoff
  ADD COLUMN IF NOT EXISTS handoff_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_user_ids   JSONB   NOT NULL DEFAULT '[]'::jsonb, -- eligible BDAs for round-robin
  ADD COLUMN IF NOT EXISTS handoff_keywords   TEXT,                                  -- comma-separated keywords that trigger handoff (optional)
  ADD COLUMN IF NOT EXISTS handoff_rr_pointer INTEGER NOT NULL DEFAULT -1,           -- round-robin cursor (last assigned index)
  -- 3. Conversation-close summary
  ADD COLUMN IF NOT EXISTS close_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS close_idle_minutes     INTEGER NOT NULL DEFAULT 30;

-- ── Per-conversation state (a contact row == one conversation) ─────────────
ALTER TABLE coexistence.contacts
  -- bot ↔ human switch. routeIfActive() skips the agent while agent_paused.
  ADD COLUMN IF NOT EXISTS agent_paused        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_paused_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS agent_paused_by     TEXT,            -- 'agent' | 'keyword' | 'manual:<userId>'
  -- close-summary bookkeeping
  ADD COLUMN IF NOT EXISTS agent_close_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_last_run_at   TIMESTAMPTZ;

-- Fast lookup for the close-summary sweeper.
CREATE INDEX IF NOT EXISTS idx_contacts_agent_close_pending
  ON coexistence.contacts (agent_last_run_at)
  WHERE agent_close_pending = TRUE;
