-- 058_ai_academy.sql
-- AI Academy Dashboard — the shared funnel data model that Marketing, Sales, and
-- Chats are three views over. Embedded in the ForgeGrowth backend (coexistence
-- schema), NOT a separate service. Everything is idempotent (CI applies every
-- migration on a fresh Postgres) — CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS only, never DROP.
--
-- Tables:
--   leads                  — the source of truth (Marketing = acquisition view,
--                            Sales = conversion view, Chats = operational layer).
--   resources              — "share" materials: is_dynamic=false → Content Library,
--                            is_dynamic=true → Live Links (batch webinar/payment/group).
--   collect_fields         — per-stage data-capture field definitions.
--   campaigns              — ad spend & ROI (EP-CTWA pull later; manual/seed now).
--   webinars               — batch schedule + registration/attendance funnel.
--   webinar_registrations  — per-lead registration + attendance.
--   bda_activity_log       — raw ground-truth activity feed (BDA Performance aggregates it).
--   agent_config           — singleton: Layer-1 + passive-scorer settings, score rules,
--                            stage thresholds (incl. cold_after_follow_ups, default 3).
--   lead_events            — append-only audit (stage/score changes, triggers, opens).
--
-- Also extends team_members (migration 003) with role / whatsapp_agent_id / active.

-- ── leads ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.leads (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT,
  whatsapp_number       TEXT NOT NULL UNIQUE,
  email                 TEXT,
  city                  TEXT,
  role                  TEXT,
  source                TEXT,
  goal                  TEXT,
  webinar_slot          TEXT,
  referred_by           TEXT,
  stage                 TEXT NOT NULL DEFAULT 'new'
                          CHECK (stage IN ('new','contacted','engaged','hot','enrolled','cold_lost')),
  score                 INT NOT NULL DEFAULT 0,
  assigned_bda          TEXT,   -- team_members.id / bda id (roster attribution)
  assigned_user_id      BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  follow_up_count       INT NOT NULL DEFAULT 0,   -- CONSECUTIVE streak since last reply
  last_inbound_at       TIMESTAMPTZ,
  last_outbound_at      TIMESTAMPTZ,
  last_activity_at      TIMESTAMPTZ,
  stage_changed_at      TIMESTAMPTZ,
  score_override_note   TEXT,
  has_whatsapp_thread   BOOLEAN NOT NULL DEFAULT FALSE,
  custom_fields         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- After-sale / onboarding (Sales → Onboarding). Populated once stage='enrolled'.
  payment_date          DATE,
  form_status           TEXT NOT NULL DEFAULT 'pending' CHECK (form_status IN ('pending','complete')),
  zip                   TEXT,
  state                 TEXT,
  batch_assigned        TEXT,
  tool_access           BOOLEAN NOT NULL DEFAULT FALSE,
  batch_group_added     BOOLEAN NOT NULL DEFAULT FALSE,
  prebatch_reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_stage           ON coexistence.leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_source          ON coexistence.leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_user   ON coexistence.leads(assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned_bda    ON coexistence.leads(assigned_bda) WHERE assigned_bda IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_custom_fields   ON coexistence.leads USING GIN (custom_fields);

-- ── resources ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.resources (
  id                  BIGSERIAL PRIMARY KEY,
  title               TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'Link'
                        CHECK (type IN ('PDF','Video','Link','Testimonial','Payment','Calendar','Community')),
  stage_tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_url            TEXT,
  is_dynamic          BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_phrases     JSONB NOT NULL DEFAULT '[]'::jsonb,
  applicable_stage    TEXT,          -- for the trigger-word library view
  opens               INT NOT NULL DEFAULT 0,
  clicks              INT NOT NULL DEFAULT 0,
  sends               INT NOT NULL DEFAULT 0,
  replies_after_send  INT NOT NULL DEFAULT 0,
  is_retired          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_dynamic ON coexistence.resources(is_dynamic);

-- ── collect_fields ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.collect_fields (
  id                 BIGSERIAL PRIMARY KEY,
  stage              TEXT,
  label              TEXT NOT NULL,
  field_type         TEXT NOT NULL DEFAULT 'Text'
                       CHECK (field_type IN ('Text','Choice','Auto','Document')),
  maps_to_lead_column TEXT,
  collected_by       TEXT NOT NULL DEFAULT 'bot' CHECK (collected_by IN ('bot','BDA','webhook')),
  sort_order         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── campaigns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.campaigns (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  platform         TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  spend            NUMERIC(14,2) NOT NULL DEFAULT 0,
  leads_generated  INT NOT NULL DEFAULT 0,
  enrollments      INT NOT NULL DEFAULT 0,
  start_date       DATE,
  end_date         DATE,
  external_id      TEXT,   -- EP-CTWA campaign id (nullable; live pull later)
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ctwa')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── webinars ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.webinars (
  id                BIGSERIAL PRIMARY KEY,
  batch_name        TEXT NOT NULL,
  date              TIMESTAMPTZ,
  landing_page_url  TEXT,
  registrations     INT NOT NULL DEFAULT 0,
  attended          INT NOT NULL DEFAULT 0,
  no_shows          INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── webinar_registrations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.webinar_registrations (
  id                        BIGSERIAL PRIMARY KEY,
  lead_id                   BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  webinar_id                BIGINT NOT NULL REFERENCES coexistence.webinars(id) ON DELETE CASCADE,
  attended                  BOOLEAN NOT NULL DEFAULT FALSE,
  attendance_form_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  reminded                  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, webinar_id)
);

CREATE INDEX IF NOT EXISTS idx_webinar_reg_webinar ON coexistence.webinar_registrations(webinar_id);

-- ── bda_activity_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.bda_activity_log (
  id                    BIGSERIAL PRIMARY KEY,
  ts                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bda                   TEXT,
  lead_id               BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  action                TEXT NOT NULL DEFAULT 'message_sent'
                          CHECK (action IN ('message_sent','trigger_fired','stage_note')),
  trigger_phrase        TEXT,
  response_time_seconds INT,
  note                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_bda_activity_bda  ON coexistence.bda_activity_log(bda, ts DESC);
CREATE INDEX IF NOT EXISTS idx_bda_activity_lead ON coexistence.bda_activity_log(lead_id, ts DESC);

-- ── agent_config (singleton) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.agent_config (
  id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  layer1_settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  passive_scorer_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  score_rules             JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage_thresholds        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill the singleton row with sensible defaults (score bands 25/50/75,
-- cold-drop after 3 follow-ups, and a starter rulebook).
INSERT INTO coexistence.agent_config (id, layer1_settings, passive_scorer_settings, score_rules, stage_thresholds)
VALUES (
  1,
  '{"greeting":"Hi! Welcome to the AI Academy 👋","qualifyingQuestion":"What''s your main goal — a job, freelancing, or building your own product?","languageDetection":true,"voiceNoteTranscription":true}'::jsonb,
  '{"enabled":true,"autoStageMove":true}'::jsonb,
  '[
     {"category":"Response Behavior","rule":"Replies within 1 hour","points":10},
     {"category":"Response Behavior","rule":"Replies within 24 hours","points":5},
     {"category":"Engagement Depth","rule":"Opened a shared resource","points":8},
     {"category":"Engagement Depth","rule":"Attended a webinar","points":20},
     {"category":"Intent Signals","rule":"Asked about pricing / payment","points":15},
     {"category":"Intent Signals","rule":"Asked about the next batch","points":12},
     {"category":"Negative Signals","rule":"3 follow-ups with no reply","points":-15},
     {"category":"Negative Signals","rule":"Said not interested","points":-25}
   ]'::jsonb,
  '{"cold_after_follow_ups":3,"bands":{"cold":0,"warm":25,"hot":50,"priority":75}}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ── lead_events (append-only audit) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.lead_events (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lead_id     BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL
                CHECK (event_type IN ('stage_changed','score_changed','trigger_fired','resource_opened','message_sent')),
  from_value  TEXT,
  to_value    TEXT,
  actor       TEXT
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON coexistence.lead_events(lead_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_type ON coexistence.lead_events(event_type, ts DESC);

-- ── team_members extension ────────────────────────────────────────────────────
-- team_members is created by migration 003. Re-create its base shape defensively
-- (031-style) so this file is self-sufficient on a fresh CI database, then add
-- the roster columns the AI Academy roster / BDA attribution needs.
CREATE TABLE IF NOT EXISTS coexistence.team_members (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  phone_number        TEXT,
  bda_id              TEXT UNIQUE,
  address             TEXT,
  email               TEXT,
  profile_picture_url TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE coexistence.team_members ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE coexistence.team_members ADD COLUMN IF NOT EXISTS whatsapp_agent_id TEXT;
ALTER TABLE coexistence.team_members ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
