-- ─── Migration 075: customer information on conversions + performance tracking ───
--
--  WHY CUSTOMER INFO: a CTWA conversion currently carries only the click id. That
--  is enough to ATTRIBUTE the sale to an ad, but Meta also wants to know WHO
--  converted so it can match the person to a profile and find more like them.
--  Meta calls these "customer information parameters"; the more of them match,
--  the better the optimiser and any lookalike built from the events.
--
--  ⚠ EVERY personal value is SHA-256 hashed after normalisation before it leaves
--  this server. Meta requires it and never receives the plaintext. The ONE
--  exception is ctwa_clid, which Meta specifies as a raw click identifier — it is
--  not personal data, it is their own token.
--
--  Only Meta's fixed set of match keys improves matching. Age and profession are
--  NOT in that set, so they can only ride along as custom_data (visible in Events
--  Manager, ignored for matching) — send_custom_properties controls that, and the
--  UI labels it as non-matching so nobody mistakes it for a stronger signal.
--
--  WHY DAILY AD STATS: campaign_ads.spend is a LIFETIME total (date_preset=maximum),
--  so there is no way to say what an ad cost in a given week — which makes any
--  before/after comparison of cost-per-lead impossible. ad_daily_stats stores one
--  row per ad per day (time_increment=1), which is the only honest basis for
--  comparing the period before Conversion API was switched on with the period after.
--
--  capi_config.enabled_at is that boundary: the moment the master switch first
--  went on. Set once and never overwritten by later off/on toggles, so the
--  comparison keeps measuring from the real start.
--
-- Idempotent + re-runnable. Mirrored by ensureCtwaTables() in routes/ctwa.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/075_capi_customer_info.sql

-- ── capi_config: customer-information settings + the before/after boundary ───
ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS send_customer_info     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS send_custom_properties BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS enabled_at             TIMESTAMPTZ;

-- Which match keys are permitted to leave. Defaults turn on the keys Meta rates
-- highest AND that this CRM actually collects; ct/st are off because nothing
-- populates city/state today, and a toggle that can never fire is just noise.
ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS customer_fields JSONB NOT NULL DEFAULT
    '{"ph":true,"em":true,"fn":true,"ln":true,"zp":true,"country":true,"external_id":true,"ct":false,"st":false}'::jsonb;

-- ── capi_events: which match keys actually went with each transmission ───────
-- request_payload already holds the full body, but it is hashed and nested; a
-- flat list is what makes the history table answer "was this a strong event?"
-- at a glance, and lets the UI show match quality without parsing the payload.
ALTER TABLE coexistence.capi_events
  ADD COLUMN IF NOT EXISTS match_keys JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── ad_daily_stats — per-ad, per-day spend/results from Meta ─────────────────
CREATE TABLE IF NOT EXISTS coexistence.ad_daily_stats (
  id                   BIGSERIAL PRIMARY KEY,
  ad_external_id       TEXT NOT NULL,
  adset_external_id    TEXT,
  campaign_external_id TEXT,
  stat_date            DATE NOT NULL,
  spend                NUMERIC(14,2) NOT NULL DEFAULT 0,
  impressions          BIGINT NOT NULL DEFAULT 0,
  clicks               BIGINT NOT NULL DEFAULT 0,
  leads                INT    NOT NULL DEFAULT 0,   -- Meta's messaging-conversations-started
  account_id           TEXT,
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_daily_stats
  ON coexistence.ad_daily_stats(ad_external_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_date
  ON coexistence.ad_daily_stats(stat_date);
CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_campaign
  ON coexistence.ad_daily_stats(campaign_external_id);

-- Backfill the boundary for an instance where sending was already switched on
-- before this migration: use the first successful transmission as the start.
UPDATE coexistence.capi_config c
   SET enabled_at = (SELECT MIN(created_at) FROM coexistence.capi_events WHERE status = 'sent')
 WHERE c.id = 1
   AND c.enabled_at IS NULL
   AND EXISTS (SELECT 1 FROM coexistence.capi_events WHERE status = 'sent');
