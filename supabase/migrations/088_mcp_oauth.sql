-- ─── Migration 088: OAuth 2.1 authorization server for the MCP connector ─────
-- Mirrors ensureMcpOAuthTables() in backend/src/routes/mcpOAuth.js (runtime
-- source of truth). Idempotent.
--
-- WHY THIS EXISTS
-- The MCP endpoint authenticated with a key embedded in the URL
-- (/api/mcp/http/<key>). That works, but it is not OAuth, and it puts a
-- long-lived credential in a URL — which ends up in browser history, logs and
-- referrers. Claude's connector dialog expects an OAuth Client ID / Client
-- Secret, and MCP's own spec (2025-06-18) requires OAuth 2.1 for HTTP
-- transports.
--
-- Until now frontend/nginx.conf deliberately returned 404 for every OAuth
-- discovery path, because the SPA catch-all was answering those probes with
-- index.html and the connector concluded an authorization server existed —
-- producing "Couldn't register with forge growth's sign-in service." That 404
-- block is replaced by a proxy to these endpoints.
--
-- WHAT CLAUDE REQUIRES (verified against the MCP spec + Anthropic's docs)
--   * grant types authorization_code + refresh_token. NOT client_credentials —
--     Claude requires an interactive browser flow.
--   * PKCE with S256, advertised in the AS metadata.
--   * redirect_uri https://claude.ai/api/mcp/auth_callback for web/desktop/
--     mobile. Claude Code uses loopback on an EPHEMERAL port, so localhost
--     redirects must be matched port-agnostically.
--   * RFC 9728 protected-resource metadata + a WWW-Authenticate header on 401.
--   * RFC 8707 `resource` parameter, and the token audience must be validated.

-- ── Registered clients ───────────────────────────────────────────────────────
-- A client is created in Admin Settings and its id/secret pasted into Claude's
-- Advanced settings. Dynamic Client Registration is also supported at runtime
-- (see /register), which produces rows here with dynamically_registered = TRUE.
CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_clients (
  id                     BIGSERIAL PRIMARY KEY,
  client_id              TEXT NOT NULL UNIQUE,
  -- SHA-256 only, exactly like mcp_api_keys. The plaintext secret is shown
  -- once at creation and never recoverable.
  client_secret_hash     TEXT,
  name                   TEXT NOT NULL,
  redirect_uris          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which MCP capabilities a token from this client may exercise is NOT stored
  -- here: capabilities stay global in mcp_settings, so revoking one there
  -- applies to every client at once. A per-client copy would drift.
  is_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  dynamically_registered BOOLEAN NOT NULL DEFAULT FALSE,
  created_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at           TIMESTAMPTZ
);

-- ── Authorization codes (single use, short lived) ────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  -- PKCE. code_challenge is REQUIRED — a code with no challenge is refused
  -- rather than downgraded, since silently allowing the plain flow is exactly
  -- the interception hole PKCE exists to close.
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  -- RFC 8707. Recorded at authorize time and copied onto the token so the
  -- audience can be validated when the token is later presented.
  resource              TEXT,
  scope                 TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  -- Set on first exchange. A REPLAYED code must be detected, not merely
  -- ignored: OAuth 2.1 requires revoking the tokens already issued from it.
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON coexistence.mcp_oauth_codes(expires_at);

-- ── Issued tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_tokens (
  id                  BIGSERIAL PRIMARY KEY,
  access_token_hash   TEXT NOT NULL UNIQUE,
  refresh_token_hash  TEXT UNIQUE,
  client_id           TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  -- The audience this token is valid for. Checked on every MCP request: a
  -- token issued for another resource must be rejected, never passed through.
  resource            TEXT,
  scope               TEXT,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client  ON coexistence.mcp_oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expiry  ON coexistence.mcp_oauth_tokens(access_expires_at);

COMMENT ON TABLE coexistence.mcp_oauth_clients IS
  'OAuth clients for the MCP connector. Capabilities are NOT per-client — they stay global in mcp_settings so revoking one applies everywhere.';
COMMENT ON COLUMN coexistence.mcp_oauth_tokens.resource IS
  'RFC 8707 audience. Validated on every MCP request; a token minted for another resource is rejected rather than passed through.';
