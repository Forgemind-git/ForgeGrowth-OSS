-- Google integrations: Sheets / Calendar / Gmail.
--
-- Two-tier model:
--   1. google_oauth_credentials  — one row holding the workspace's OAuth
--      Client ID + Client Secret (encrypted). Admin enters these once via
--      the Integrations tab. Used to mint per-provider OAuth flows.
--   2. integrations              — one row per connected Google service
--      (provider in google_sheets | google_calendar | gmail). Holds the
--      AES-encrypted access + refresh tokens, expiry, granted scopes, and
--      the connected account's email/name so the UI can show
--      "Connected as user@gmail.com".
--   3. oauth_states              — short-lived CSRF nonces created by
--      /integrations/oauth/start and consumed by /oauth/callback. Single
--      use; reaper deletes >15 min old rows.

CREATE TABLE IF NOT EXISTS coexistence.google_oauth_credentials (
  id SERIAL PRIMARY KEY,
  client_id_encrypted TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  updated_by BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.integrations (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google_sheets','google_calendar','gmail')),
  account_email TEXT,
  account_name TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expiry_at TIMESTAMPTZ,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'connected',   -- connected | error | revoked
  last_error TEXT,
  last_used_at TIMESTAMPTZ,
  connected_by BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider)
);

CREATE INDEX IF NOT EXISTS integrations_provider_idx ON coexistence.integrations(provider);

CREATE TABLE IF NOT EXISTS coexistence.oauth_states (
  id SERIAL PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  user_id BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_states_state_idx ON coexistence.oauth_states(state);
CREATE INDEX IF NOT EXISTS oauth_states_created_idx ON coexistence.oauth_states(created_at);
