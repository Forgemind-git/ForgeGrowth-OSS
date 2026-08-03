-- ─── Migration 074: Ad sets under campaigns + ForgeSocial removal ────────────
--
--  WHY AD SETS: Meta's hierarchy is Campaign → Ad Set → Ad. We only ever stored
--  the two ends of it, so the Campaigns page could show "22 ads" but never WHICH
--  targeting/budget bucket each ad belonged to — the layer where the actual
--  optimisation decisions live (audience, placement, optimisation goal, budget).
--  Without it you cannot tell whether a weak ad is a weak creative or a weak
--  ad set, which is the whole point of looking at a campaign.
--
--  Ad-set spend is fetched at level=adset rather than summed from its ads: Meta
--  attributes some campaign-level costs at the ad-set tier, so a SUM() over ads
--  quietly under-reports. Both numbers are stored; the UI shows Meta's own.
--
--  FORGESOCIAL: the ForgeSocial integration is removed from Forge Growth. Its
--  two tables are dropped — social_posts is a re-fetchable cache and
--  forgesocial_config holds only the (now unused) encrypted API key. Nothing
--  else references them once routes/marketing.js drops the ad↔post join.
--
-- Idempotent + re-runnable. Mirrored by ensureAdSetTables() in
-- backend/src/routes/marketing.js so a fresh deploy self-heals.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/074_ad_sets.sql

-- ── campaign_adsets — one row per Meta ad set ────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.campaign_adsets (
  id                   BIGSERIAL PRIMARY KEY,
  adset_external_id    TEXT NOT NULL,          -- Meta ad set id
  campaign_external_id TEXT NOT NULL,          -- → campaigns.external_id
  name                 TEXT,
  status               TEXT,                   -- normalised: active | paused
  effective_status     TEXT,                   -- Meta's raw value
  optimization_goal    TEXT,                   -- what this ad set bids towards
  billing_event        TEXT,
  daily_budget         NUMERIC(14,2),
  lifetime_budget      NUMERIC(14,2),
  spend                NUMERIC(14,2) NOT NULL DEFAULT 0,
  leads                INT    NOT NULL DEFAULT 0,
  impressions          BIGINT NOT NULL DEFAULT 0,
  clicks               BIGINT NOT NULL DEFAULT 0,
  reach                BIGINT NOT NULL DEFAULT 0,
  start_date           DATE,
  end_date             DATE,
  account_id           TEXT,
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_adsets_adset
  ON coexistence.campaign_adsets(adset_external_id);
CREATE INDEX IF NOT EXISTS idx_campaign_adsets_campaign
  ON coexistence.campaign_adsets(campaign_external_id);

-- ── campaign_ads gains its parent ad set ─────────────────────────────────────
-- Nullable: ads synced before this migration have no ad set until the next sync,
-- and the UI groups those under an explicit "Ungrouped" bucket rather than
-- hiding them.
ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS adset_external_id TEXT;
ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS adset_name        TEXT;
CREATE INDEX IF NOT EXISTS idx_campaign_ads_adset
  ON coexistence.campaign_ads(adset_external_id) WHERE adset_external_id IS NOT NULL;

-- ── ForgeSocial removal ──────────────────────────────────────────────────────
DROP TABLE IF EXISTS coexistence.social_posts;
DROP TABLE IF EXISTS coexistence.forgesocial_config;
