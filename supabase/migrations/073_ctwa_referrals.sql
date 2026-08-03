-- ─── Migration 073: Click-to-WhatsApp attribution ────────────────────────────
-- Every inbound WhatsApp message that came from a click-to-WhatsApp ad carries
-- a `referral` object (ctwa_clid, source_id = the Meta AD id, source_url,
-- headline/body, media_type + image/video/thumbnail urls). The webhook already
-- parses it but only ever stored it inside chat_history.raw_payload.
-- `ctwa_referrals` promotes it to a first-class row so the ad → conversation →
-- lead → stage → revenue chain is queryable, joined to campaign_ads on
-- source_id = ad_external_id.
--
--   ctwa_referrals   — one row per CLICK (not per message). Keeps rows with no
--                      ctwa_clid too (organic post CTAs).
--
-- Idempotent + re-runnable. Mirrored by ensureCtwaTables() in
-- backend/src/routes/ctwa.js so a fresh deploy self-heals.

-- ── CTWA referrals: one row per ad click that opened a conversation ──────────
CREATE TABLE IF NOT EXISTS coexistence.ctwa_referrals (
  id                BIGSERIAL PRIMARY KEY,

  -- Meta's click id. NULL for organic post CTAs (source_type='post') and for
  -- older payloads — those rows are analytics-only, never transmittable.
  ctwa_clid         TEXT,

  -- who + where
  contact_number    TEXT NOT NULL,
  lead_id           BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  wa_number         TEXT,
  phone_number_id   TEXT,
  waba_id           TEXT,
  message_id        TEXT,                 -- wamid of the message that carried it

  -- the ad / post it came from
  source_id         TEXT,                 -- Meta AD id → campaign_ads.ad_external_id
  source_type       TEXT,                 -- 'ad' | 'post'
  source_url        TEXT,
  platform          TEXT,                 -- derived: Instagram | Facebook | Other

  -- creative the person actually saw
  headline          TEXT,
  body              TEXT,
  media_type        TEXT,                 -- 'image' | 'video'
  image_url         TEXT,
  video_url         TEXT,
  thumbnail_url     TEXT,
  welcome_message   TEXT,

  clicked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- first message time
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per click. A repeat ad click mints a NEW clid, so this dedupes the
-- follow-up messages that repeat the same referral without collapsing real
-- second clicks. message_id covers the clid-less (organic) rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ctwa_referrals_clid
  ON coexistence.ctwa_referrals (ctwa_clid) WHERE ctwa_clid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ctwa_referrals_msg
  ON coexistence.ctwa_referrals (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_contact  ON coexistence.ctwa_referrals (contact_number);
CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_lead     ON coexistence.ctwa_referrals (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_source   ON coexistence.ctwa_referrals (source_id);
CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_clicked  ON coexistence.ctwa_referrals (clicked_at DESC);
