-- ─── Migration 077: Conversion Leads Optimisation (CLO) ─────────────────────
--
--  WHAT CLO IS: a Meta Ads performance goal that consumes down-funnel CRM stage
--  data delivered over the Conversions API, so delivery optimises toward leads
--  that become customers rather than leads that merely fill a form.
--
--    CAPI without CLO  = reporting only, delivery unchanged
--    CLO without CAPI  = no data
--    Both are required.
--
--  ⚠ SCOPE: CLO works with Facebook/Instagram LEAD ADS (Instant Forms) ONLY.
--  It does NOT work with Click-to-WhatsApp. This is a SEPARATE integration from
--  the CTWA Conversions API in migration 073 — different action_source
--  ('system_generated' vs 'business_messaging'), different identifier (Meta
--  lead id vs ctwa_clid), different attribution window (28d vs 7d), and it MUST
--  post to a different dataset. Nothing here touches capi_* tables.
--
--  ⚠ PRECONDITION, stated plainly: at the time of writing this instance has NO
--  Lead Ads. Every ad set is CONVERSATIONS / LANDING_PAGE_VIEWS / PROFILE_VISIT,
--  and no lead carries a Meta lead id. These tables are therefore correct but
--  inert until Instant Form campaigns run and their leads are ingested. The
--  readiness endpoint reports exactly that rather than pretending otherwise.
--
--  Single-tenant: this app has no workspace concept — every config table is a
--  singleton id=1 row (capi_config, meta_ads_config, mcp_settings). clo_settings
--  follows that convention instead of carrying a workspace_id that would only
--  ever hold one value.
--
-- Idempotent + re-runnable. Mirrored by ensureCloTables() in routes/clo.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/077_clo.sql

-- ── clo_funnel_stages — the ordered ladder mapped onto Meta event names ──────
CREATE TABLE IF NOT EXISTS coexistence.clo_funnel_stages (
  id                     BIGSERIAL PRIMARY KEY,
  -- Immutable once events exist: event_name is matched by string against the
  -- funnel configured in Meta, so renaming a live key orphans everything sent.
  stage_key              TEXT NOT NULL,
  event_name             TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  sort_order             INT  NOT NULL DEFAULT 0,
  -- Which Forge Growth funnel_stages.stage_key values land a lead on this rung.
  crm_status_values      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_optimisation_target BOOLEAN NOT NULL DEFAULT FALSE,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_stage_key ON coexistence.clo_funnel_stages(stage_key);
CREATE INDEX IF NOT EXISTS idx_clo_stage_order ON coexistence.clo_funnel_stages(sort_order);

-- "Exactly one optimisation target" enforced structurally rather than by
-- application code. A partial unique index over a constant permits at most one
-- row with the flag set, so two targets cannot exist even via a direct SQL edit.
--
-- NOTE: the spec also listed clo_settings.optimisation_stage_id. That would be a
-- second copy of the same fact, and a restated fact can drift where a derived
-- one cannot (see the repo's own "derive, never restate" lesson). The settings
-- API therefore RETURNS optimisationStageId, derived from this flag, rather than
-- storing it twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_single_target
  ON coexistence.clo_funnel_stages((is_optimisation_target)) WHERE is_optimisation_target;

-- ── clo_settings — singleton ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.clo_settings (
  id                     INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  -- Must be a DIFFERENT dataset from the CTWA one: Meta treats a CRM dataset and
  -- a web/messaging dataset as separate event sources, and mixing them corrupts
  -- both funnels.
  dataset_id             TEXT,
  -- The system-user token, AES-256-GCM encrypted at rest by util/crypto.js —
  -- the repo's existing secret mechanism, which is what access_token_ref means
  -- here. Never returned by the API, never written into clo_events.payload.
  access_token_encrypted TEXT,
  lead_event_source      TEXT NOT NULL DEFAULT 'Forge Growth',
  graph_api_version      TEXT NOT NULL DEFAULT 'v21.0',
  test_event_code        TEXT,
  -- Defaults TRUE so a freshly configured install builds and stores payloads
  -- without anything reaching Meta until this is explicitly switched off.
  dry_run                BOOLEAN NOT NULL DEFAULT TRUE,
  -- Cursor over coexistence.lead_events, mirroring the CTWA sweeper. Stage
  -- changes are written by five different code paths, three with raw SQL, so a
  -- cursor is the only integration point that cannot be bypassed by a future one.
  last_event_id          BIGINT NOT NULL DEFAULT 0,
  last_flush_at          TIMESTAMPTZ,
  last_flush_error       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO coexistence.clo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── clo_events — outbox + audit log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.clo_events (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  meta_lead_id  TEXT,
  stage_id      BIGINT REFERENCES coexistence.clo_funnel_stages(id) ON DELETE CASCADE,
  event_name    TEXT NOT NULL,
  event_time    TIMESTAMPTZ NOT NULL,
  -- Token is stripped before storage; assert on this in tests.
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed','skipped_duplicate',
                                    'skipped_out_of_window','skipped_no_identifier','dry_run')),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  meta_response JSONB,
  fbtrace_id    TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "A lead may only fire each stage once" — scoped to SENT rows.
--
-- A blanket UNIQUE(lead_id, stage_id) would enforce the same guarantee but make
-- the audit log unable to do its job: a skipped_duplicate row could not be
-- inserted alongside the sent row that caused the skip, and the diagnostics
-- panel exists precisely to explain why volume is lower than expected. Scoping
-- to status='sent' keeps the real guarantee (never double-send) while letting
-- every skip and failure be recorded against the lead it concerns.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_events_sent
  ON coexistence.clo_events(lead_id, stage_id) WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_clo_events_status  ON coexistence.clo_events(status);
CREATE INDEX IF NOT EXISTS idx_clo_events_created ON coexistence.clo_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clo_events_lead    ON coexistence.clo_events(lead_id);
-- The flush worker's hot path: claim pending rows oldest-first.
CREATE INDEX IF NOT EXISTS idx_clo_events_pending
  ON coexistence.clo_events(created_at) WHERE status = 'pending';

-- ── leads: Meta Lead Ads identifiers (additive, all nullable) ────────────────
-- Nothing populates these yet — ingesting Instant Form leads is a separate
-- integration. They exist now so the dispatcher, readiness check and backfill
-- can be written and tested against the real column names.
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_lead_id         TEXT;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_lead_created_at TIMESTAMPTZ;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_ad_id           TEXT;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_campaign_id     TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_meta_lead_id
  ON coexistence.leads(meta_lead_id) WHERE meta_lead_id IS NOT NULL;
