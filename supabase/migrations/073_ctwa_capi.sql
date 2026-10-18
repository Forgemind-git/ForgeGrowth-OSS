-- ─── Migration 073: Click-to-WhatsApp attribution + Meta Conversions API ─────
-- Closes the ad loop. Two halves that share one join key — Meta's CTWA click id.
--
--   READ  side (Click-to-WhatsApp tab): every inbound WhatsApp message that came
--         from a click-to-WhatsApp ad carries a `referral` object (ctwa_clid,
--         source_id = the Meta AD id, source_url, headline/body, media_type +
--         image/video/thumbnail urls). The webhook already parses it but only
--         ever stored it inside chat_history.raw_payload. `ctwa_referrals`
--         promotes it to a first-class row so the ad → conversation → lead →
--         stage → revenue chain is queryable, joined to campaign_ads on
--         source_id = ad_external_id.
--
--   WRITE side (Conversion API tab): when a lead reaches a mapped funnel stage
--         we POST that click id back to Meta as a standard conversion event
--         (Purchase / Lead / …) so its optimiser learns which clicks pay off.
--
--   ctwa_referrals   — one row per CLICK (not per message). Keeps rows with no
--                      ctwa_clid too (organic post CTAs) — they show in the tab
--                      but can never be transmitted.
--   capi_config      — singleton (id=1): master on/off, test-vs-live mode.
--   capi_datasets    — per-WABA Meta dataset id (the CAPI POST target).
--   capi_event_map   — funnel stage_key → Meta event_name (+ value rule).
--   capi_events      — append-only transmission log = the tab's history table.
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

-- ── Conversions API: singleton config ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.capi_config (
  id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- MASTER SWITCH. Default OFF: turning this on starts writing real conversion
  -- signals into the ad account, which changes how Meta spends money.
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'test' routes every event through Meta's test_event_code so it appears in
  -- Events Manager → Test Events WITHOUT counting toward optimisation.
  mode                TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  test_event_code     TEXT,

  default_currency    TEXT NOT NULL DEFAULT 'INR',

  -- Don't attribute a conversion to a click older than this (a click from six
  -- months ago is not what closed today's sale).
  max_click_age_days  INT NOT NULL DEFAULT 90 CHECK (max_click_age_days BETWEEN 1 AND 365),

  -- Sweeper cursor into lead_events. Enabling the master switch jumps this to
  -- the current MAX(id) so flipping it on never replays months of history.
  last_event_id       BIGINT NOT NULL DEFAULT 0,

  -- One-shot marker for the default stage→event mappings below. Guarding on
  -- "has this ever been seeded" rather than "is capi_event_map empty" is what
  -- stops an admin's deliberate deletion of every mapping from being undone by
  -- the next backend restart (ensureCtwaTables re-runs the same seed).
  mappings_seeded     BOOLEAN NOT NULL DEFAULT FALSE,

  last_sent_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.capi_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Per-WABA dataset (the POST target: /{dataset_id}/events) ─────────────────
CREATE TABLE IF NOT EXISTS coexistence.capi_datasets (
  waba_id         TEXT PRIMARY KEY,
  label           TEXT,                   -- WhatsApp account display name, for UI
  dataset_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'missing'
                    CHECK (status IN ('missing', 'linked', 'error')),
  discovered_at   TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Funnel stage → Meta standard event ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.capi_event_map (
  id            BIGSERIAL PRIMARY KEY,

  -- References funnel_stages.stage_key — the IMMUTABLE key, never the label, so
  -- renaming/reordering a stage in Funnel Settings never breaks a mapping.
  stage_key     TEXT NOT NULL UNIQUE,
  event_name    TEXT NOT NULL,

  -- how to fill custom_data.value
  --   none       → send no value (correct for Lead / Contact / …)
  --   sale_total → the lead's real paid total (Razorpay captured + manual), ₹
  --   fixed      → always fixed_value
  value_mode    TEXT NOT NULL DEFAULT 'none'
                  CHECK (value_mode IN ('none', 'sale_total', 'fixed')),
  fixed_value   NUMERIC(14,2),
  currency      TEXT NOT NULL DEFAULT 'INR',

  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the two mappings that match this funnel, ONCE (guarded by the
-- mappings_seeded marker, so deleting a mapping later is respected) and ONLY for
-- stage keys that actually exist — never invent funnel data.
INSERT INTO coexistence.capi_event_map (stage_key, event_name, value_mode, active)
SELECT s.stage_key,
       CASE WHEN s.is_won THEN 'Purchase' ELSE 'Lead' END,
       CASE WHEN s.is_won THEN 'sale_total' ELSE 'none' END,
       TRUE
  FROM coexistence.funnel_stages s
 WHERE (s.is_won OR s.stage_key = 'hot')
   AND NOT (SELECT mappings_seeded FROM coexistence.capi_config WHERE id = 1)
ON CONFLICT (stage_key) DO NOTHING;

UPDATE coexistence.capi_config SET mappings_seeded = TRUE WHERE id = 1;

-- ── Transmission log (append-only) = the tab's history table ─────────────────
CREATE TABLE IF NOT EXISTS coexistence.capi_events (
  id                BIGSERIAL PRIMARY KEY,

  lead_id           BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  referral_id       BIGINT REFERENCES coexistence.ctwa_referrals(id) ON DELETE SET NULL,
  contact_number    TEXT,
  lead_name         TEXT,                 -- denormalised so the log survives deletes
  ctwa_clid         TEXT,

  stage_key         TEXT,
  event_name        TEXT NOT NULL,
  -- Deterministic per (lead, event) so a resend is DEDUPED by Meta rather than
  -- counted twice. Not UNIQUE here: retries are separate audit rows on purpose.
  event_id          TEXT NOT NULL,
  event_time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  dataset_id        TEXT,
  waba_id           TEXT,
  value             NUMERIC(14,2),
  currency          TEXT,
  mode              TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  triggered_by      TEXT NOT NULL DEFAULT 'stage_change'
                      CHECK (triggered_by IN ('stage_change', 'manual', 'resend', 'test')),

  status            TEXT NOT NULL DEFAULT 'failed'
                      CHECK (status IN ('sent', 'failed', 'skipped')),
  skip_reason       TEXT,                 -- why it never left the building
  http_status       INT,
  events_received   INT,
  fbtrace_id        TEXT,
  request_payload   JSONB,
  response          JSONB,
  error             TEXT,
  attempt           INT NOT NULL DEFAULT 1,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capi_events_created ON coexistence.capi_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capi_events_lead    ON coexistence.capi_events (lead_id);
CREATE INDEX IF NOT EXISTS idx_capi_events_status  ON coexistence.capi_events (status);
-- The auto-fire dedupe guard reads this: has this lead already had this event sent?
CREATE INDEX IF NOT EXISTS idx_capi_events_dedupe
  ON coexistence.capi_events (lead_id, event_name) WHERE status = 'sent';
