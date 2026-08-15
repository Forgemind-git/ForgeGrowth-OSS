-- Domains this install answers to, editable from Admin Settings.
--
-- Why a table rather than an env var: CORS_ORIGIN and TLS_DOMAIN are read from
-- .env, which the backend container cannot see (compose passes env_file at
-- container CREATION and never mounts the file) and cannot change without being
-- recreated from the host. So a "type your domain here" box backed by .env would
-- save a value that never takes effect — the exact shape of failure this repo
-- keeps warning about.
--
-- Read from the database instead, this is live: adding a row widens CORS on the
-- next request, and tells the bundled Caddy it may obtain a certificate for that
-- hostname the first time a browser asks for it (its on-demand `ask` endpoint
-- checks this table). No restart, and the app never gains control of the host.

CREATE TABLE IF NOT EXISTS coexistence.custom_domains (
  id           BIGSERIAL PRIMARY KEY,
  -- Bare hostname, lowercase, no scheme and no port. Normalised on write so a
  -- lookup by the Host header can be a plain equality rather than a guess.
  hostname     TEXT NOT NULL UNIQUE,
  -- Off keeps the row (and its history) while refusing new certificates and
  -- dropping it out of CORS — the reversible version of deleting it.
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  added_by     BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last time Caddy asked whether it could issue for this name. Absent long
  -- after a domain was added is the signal that DNS is not pointing here yet,
  -- which is the single most common reason a custom domain "does not work".
  last_asked_at TIMESTAMPTZ,
  -- Last time a request actually arrived carrying this Host. Proves the whole
  -- path end to end — DNS, proxy, certificate — in a way no config check can.
  last_seen_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS custom_domains_active_idx
  ON coexistence.custom_domains (hostname) WHERE is_active;
