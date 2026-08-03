-- 060_ads_creatives_social.sql — per-ad creatives (campaign drill-in) + a
-- ForgeSocial API connection and a local cache of its posts, so each Meta ad can
-- be linked to the organic ForgeSocial post it promotes (Instagram media id join).
-- Idempotent + re-runnable.
--
-- Apply:  docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/060_ads_creatives_social.sql

-- ── campaign_ads — one row per Meta ad, with its creative content ────────────────
CREATE TABLE IF NOT EXISTS coexistence.campaign_ads (
  id                     BIGSERIAL PRIMARY KEY,
  ad_external_id         TEXT NOT NULL,            -- Meta ad id
  campaign_external_id   TEXT NOT NULL,            -- Meta campaign id → campaigns.external_id
  name                   TEXT,
  status                 TEXT,
  spend                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  leads                  INT NOT NULL DEFAULT 0,
  impressions            BIGINT NOT NULL DEFAULT 0,
  clicks                 BIGINT NOT NULL DEFAULT 0,
  creative_thumbnail_url TEXT,
  creative_title         TEXT,
  creative_body          TEXT,
  object_type            TEXT,                     -- VIDEO | SHARE | PHOTO | ...
  ig_media_id            TEXT,                     -- effective_instagram_media_id (join key)
  ig_permalink           TEXT,
  story_id               TEXT,                     -- effective_object_story_id ({page}_{post})
  account_id             TEXT,
  last_synced_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_ads_ad ON coexistence.campaign_ads(ad_external_id);
CREATE INDEX IF NOT EXISTS idx_campaign_ads_campaign ON coexistence.campaign_ads(campaign_external_id);
CREATE INDEX IF NOT EXISTS idx_campaign_ads_igmedia  ON coexistence.campaign_ads(ig_media_id) WHERE ig_media_id IS NOT NULL;

-- ── social_posts — local cache of ForgeSocial posts (fetched via its API) ────────
CREATE TABLE IF NOT EXISTS coexistence.social_posts (
  id               BIGSERIAL PRIMARY KEY,
  external_id      TEXT NOT NULL,                  -- IG media id / platform post id (join key)
  platform         TEXT,
  account_username TEXT,
  caption          TEXT,
  permalink        TEXT,
  thumbnail_url    TEXT,
  post_type        TEXT,
  post_date        DATE,
  views            BIGINT NOT NULL DEFAULT 0,
  likes            BIGINT NOT NULL DEFAULT 0,
  comments         BIGINT NOT NULL DEFAULT 0,
  shares           BIGINT NOT NULL DEFAULT 0,
  saves            BIGINT NOT NULL DEFAULT 0,
  engagements      BIGINT NOT NULL DEFAULT 0,
  clicks           BIGINT NOT NULL DEFAULT 0,
  score            INT,
  last_synced_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_posts_external ON coexistence.social_posts(external_id);

-- ── forgesocial_config — singleton connection (encrypted API key) ────────────────
CREATE TABLE IF NOT EXISTS coexistence.forgesocial_config (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key_encrypted  TEXT,
  base_url           TEXT NOT NULL DEFAULT 'https://social.example.com',
  status             TEXT NOT NULL DEFAULT 'disconnected'
                       CHECK (status IN ('disconnected','connected','error')),
  last_error         TEXT,
  last_synced_at     TIMESTAMPTZ,
  post_count         INT NOT NULL DEFAULT 0,
  connected_by       BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO coexistence.forgesocial_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
