-- 047: Claude Console — per-agent allowlist + per-run cost.
--
-- Powers the standalone Claude control panel (claude. subdomain):
--   - claude_allowlist: which WhatsApp numbers may drive each Claude agent.
--     Replaces the flat file as the source of truth (the claude_code provider
--     enforces it; the runner file becomes redundant). Per-agent so different
--     bots/numbers can have different permitted senders.
--   - agent_runs.cost_usd: Claude Code reports total_cost_usd per turn. The
--     claude_code provider doesn't use token-billing the way hosted-API agents
--     do, so we persist the CLI's reported cost here to power per-user usage.
--     Nullable + additive — existing (anthropic/openai) agents leave it NULL.

CREATE TABLE IF NOT EXISTS coexistence.claude_allowlist (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    BIGINT NOT NULL REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,                 -- digits only, E.164 without '+'
  label       TEXT,                          -- e.g. person's name
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_claude_allowlist_agent
  ON coexistence.claude_allowlist (agent_id);

ALTER TABLE coexistence.agent_runs
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC;

-- Seed: migrate the existing flat-file number onto the live Claude agent
-- (the one bound to a claude_code model). Idempotent.
INSERT INTO coexistence.claude_allowlist (agent_id, phone, label)
SELECT a.id, '919876543210', 'Owner'
  FROM coexistence.agents a
  JOIN coexistence.ai_models m ON m.id = a.ai_model_id
 WHERE m.provider = 'claude_code'
ON CONFLICT (agent_id, phone) DO NOTHING;
