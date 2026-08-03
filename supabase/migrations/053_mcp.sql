-- 053: External MCP access — API keys + capability gating.
--
-- Lets an external MCP server (Claude Desktop) drive the Agent builder over a
-- bearer token instead of the JWT login cookie. Two tables:
--   - mcp_api_keys: bearer keys for MCP clients. We store only the SHA-256 hash;
--     the plaintext (fck_live_…) is shown once at creation and never again.
--   - mcp_settings: a singleton row with a master switch + per-capability
--     toggles. The bearer middleware reads it on every request, so the Admin
--     Settings → MCP Tools toggles truly gate access.

CREATE TABLE IF NOT EXISTS coexistence.mcp_api_keys (
  id           BIGSERIAL PRIMARY KEY,
  label        TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,              -- e.g. 'fck_live_AbCd' for display
  key_last4    TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,       -- sha256(plaintext) hex
  is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_by   BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Singleton settings row (id is pinned to 1).
CREATE TABLE IF NOT EXISTS coexistence.mcp_settings (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  master_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities   JSONB NOT NULL DEFAULT '{
    "discovery": true,
    "create_agent": true,
    "update_agent": true,
    "manage_tools": true,
    "delete": true
  }'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.mcp_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
