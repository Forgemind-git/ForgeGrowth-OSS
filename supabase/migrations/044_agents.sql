-- 044: AI Agents — LLM-driven WhatsApp handlers with tool use.
--
-- An "agent" routes inbound WhatsApp messages on a bound WA account through
-- an LLM tool-use loop. Reuses the existing AI Models + Integrations rows the
-- workspace already has:
--   - agents.ai_model_id  → coexistence.ai_models(id)  (decryptable API key)
--   - agent_tools.config  → references coexistence.integrations rows by
--                          provider (e.g. 'google_sheets') — workspace has at
--                          most one per provider (see 043_integrations.sql).
--
-- Precedence with existing keyword automations is enforced in
-- backend/src/services/agentRouter.js: the webhook runs evaluateTriggers()
-- first; only inbound messages with no matching automation hit the agent.

CREATE TABLE IF NOT EXISTS coexistence.agents (
  id                       BIGSERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  system_prompt            TEXT NOT NULL,
  ai_model_id              BIGINT REFERENCES coexistence.ai_models(id) ON DELETE SET NULL,
  llm_model                TEXT NOT NULL,                -- model id within the ai_models row (e.g. 'gpt-4o' or 'claude-sonnet-4-6')
  wa_account_id            BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  is_active                BOOLEAN NOT NULL DEFAULT FALSE,
  context_window_messages  INT NOT NULL DEFAULT 20,
  max_tool_iterations      INT NOT NULL DEFAULT 6,
  created_by               BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one ACTIVE agent per WhatsApp account. Drafts/paused can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_active_per_account
  ON coexistence.agents (wa_account_id)
  WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS coexistence.agent_tools (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     BIGINT NOT NULL REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  tool_type    TEXT NOT NULL,            -- 'google_sheets' in v1; future: 'gmail','google_calendar','http',...
  config       JSONB NOT NULL,           -- shape per tool_type; for google_sheets: {spreadsheet_id, spreadsheet_name, sheet_name, ops}
  is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_agent
  ON coexistence.agent_tools (agent_id);

-- One row per inbound message that an agent handled.
CREATE TABLE IF NOT EXISTS coexistence.agent_runs (
  id                   BIGSERIAL PRIMARY KEY,
  agent_id             BIGINT NOT NULL REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  wa_account_id        BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  contact_number       TEXT NOT NULL,
  inbound_message_id   TEXT,
  status               TEXT NOT NULL CHECK (status IN ('running','completed','failed','capped')),
  total_input_tokens   INT,
  total_output_tokens  INT,
  final_reply          TEXT,
  error_message        TEXT,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started
  ON coexistence.agent_runs (agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_contact
  ON coexistence.agent_runs (contact_number, started_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.agent_run_steps (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES coexistence.agent_runs(id) ON DELETE CASCADE,
  step_index      INT NOT NULL,
  step_type       TEXT NOT NULL CHECK (step_type IN ('llm_call','tool_call')),
  tool_type       TEXT,                          -- set when step_type='tool_call'
  input           JSONB,
  output          JSONB,
  status          TEXT NOT NULL CHECK (status IN ('ok','error')),
  latency_ms      INT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
  ON coexistence.agent_run_steps (run_id, step_index);
