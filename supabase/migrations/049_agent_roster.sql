-- 049: Multiple Claude agents per WhatsApp number + in-chat /agent switching.
--
-- Roster (many-to-many): an agent can be offered on several numbers; a number
-- can offer several agents. One per number is the default (used until the
-- contact picks one). Per-contact binding records the chosen agent.
--
-- Routing (agentRouter, claude path): /agent -> send roster list message;
-- list-reply `agent:<id>` -> set binding + confirm; otherwise route to the
-- contact's binding -> the number's default -> first in roster.

CREATE TABLE IF NOT EXISTS coexistence.claude_number_agents (
  wa_account_id BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,
  agent_id      BIGINT NOT NULL REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wa_account_id, agent_id)
);
-- At most one default agent per number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_agents_one_default
  ON coexistence.claude_number_agents (wa_account_id) WHERE is_default = TRUE;

CREATE TABLE IF NOT EXISTS coexistence.claude_chat_agent (
  wa_account_id  BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,
  contact_number TEXT NOT NULL,
  agent_id       BIGINT NOT NULL REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wa_account_id, contact_number)
);

-- Seed the roster from existing claude agents (each becomes the default on its
-- current wa_account). Reusable-across-numbers additions happen via the Console.
INSERT INTO coexistence.claude_number_agents (wa_account_id, agent_id, is_default)
SELECT a.wa_account_id, a.id, TRUE
  FROM coexistence.agents a
  JOIN coexistence.ai_models m ON m.id = a.ai_model_id AND m.provider = 'claude_code'
 WHERE a.wa_account_id IS NOT NULL
ON CONFLICT (wa_account_id, agent_id) DO NOTHING;
