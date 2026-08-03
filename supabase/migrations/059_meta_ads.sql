-- 059_meta_ads.sql — Meta Marketing API connection for the Campaigns dashboard.
-- Lets an admin connect a Meta (Facebook) Ads token and sync real campaign
-- spend/results into coexistence.campaigns. Idempotent + re-runnable (CI applies
-- every migration on a fresh Postgres).
--
-- Apply:  docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/059_meta_ads.sql

-- ── widen campaigns.source to allow 'meta' (synced from Meta Ads) ───────────────
ALTER TABLE coexistence.campaigns DROP CONSTRAINT IF EXISTS campaigns_source_check;
ALTER TABLE coexistence.campaigns
  ADD CONSTRAINT campaigns_source_check CHECK (source IN ('manual','ctwa','meta'));

-- ── extra columns Meta sync populates (nullable; manual rows leave them NULL) ────
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS objective       TEXT;
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS account_id      TEXT;
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS account_name    TEXT;
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS impressions     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS clicks          BIGINT NOT NULL DEFAULT 0;
ALTER TABLE coexistence.campaigns ADD COLUMN IF NOT EXISTS last_synced_at  TIMESTAMPTZ;

-- external_id is Meta's campaign id for synced rows — unique so sync UPSERTs,
-- partial so multiple manual rows (external_id IS NULL) are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_external_id
  ON coexistence.campaigns(external_id) WHERE external_id IS NOT NULL;

-- ── meta_ads_config — singleton connection record (encrypted token) ─────────────
CREATE TABLE IF NOT EXISTS coexistence.meta_ads_config (
  id                     INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token_encrypted TEXT,                       -- AES-256-GCM (util/crypto)
  app_id                 TEXT,
  token_type             TEXT,                        -- USER | SYSTEM (from debug_token)
  token_meta             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- scopes, expiry, data-access expiry
  ad_account_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["act_123", ...] chosen to sync
  status                 TEXT NOT NULL DEFAULT 'disconnected'
                           CHECK (status IN ('disconnected','connected','error')),
  last_error             TEXT,
  last_synced_at         TIMESTAMPTZ,
  connected_by           BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.meta_ads_config (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
