-- 048: Multi-agent platform — project (scope) registry + per-agent scope link.
--
-- Each Claude agent is now bound to a "project" = a scope: a working directory
-- the runner mounts + an optional DB schema it can read (via a per-schema
-- read-only role). The runner derives:
--   cwd     = /projects/<key>          (mounted in docker-compose)
--   db url  = env CLAUDE_DB_URL_<KEY>  (per-schema read-only role)
--   HOME    = /agents/<agent_id>/home  (isolated memory/sessions/skills/config)
--
-- Registering a NEW project is an admin infra step: add the row here (or via
-- the Console), add the /projects/<key> mount + CLAUDE_DB_URL_<KEY> env to the
-- runner, and recreate it. This is the safe trade for never mounting /root.

CREATE TABLE IF NOT EXISTS coexistence.claude_projects (
  id             BIGSERIAL PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,          -- 'forgetask' (also the mount + env suffix)
  label          TEXT NOT NULL,                 -- 'ForgeTask'
  container_path TEXT NOT NULL,                 -- '/projects/forgetask'
  db_schema      TEXT,                          -- 'forgetask' (NULL = no DB access)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-agent settings (side table — does not touch the shared agents table).
CREATE TABLE IF NOT EXISTS coexistence.claude_agent_settings (
  agent_id    BIGINT PRIMARY KEY REFERENCES coexistence.agents(id) ON DELETE CASCADE,
  project_id  BIGINT REFERENCES coexistence.claude_projects(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the three known Forge apps (schema + source dir both verified to exist).
INSERT INTO coexistence.claude_projects (key, label, container_path, db_schema) VALUES
  ('forgetask', 'ForgeTask', '/projects/forgetask', 'forgetask'),
  ('forgefms',  'ForgeFMS',  '/projects/forgefms',  'forgefms'),
  ('forgechat', 'ForgeChat', '/projects/forgechat', 'coexistence')
ON CONFLICT (key) DO NOTHING;

-- Bind the existing Claude agent (id 1, the ForgeTask bot) to the forgetask project.
INSERT INTO coexistence.claude_agent_settings (agent_id, project_id)
SELECT a.id, p.id
  FROM coexistence.agents a
  JOIN coexistence.ai_models m ON m.id = a.ai_model_id AND m.provider = 'claude_code'
  CROSS JOIN coexistence.claude_projects p
 WHERE p.key = 'forgetask'
ON CONFLICT (agent_id) DO NOTHING;
