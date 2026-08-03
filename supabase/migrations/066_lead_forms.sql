-- 066_lead_forms.sql
-- Lead Forms — a no-presets, Google-Forms-style lead-capture builder living in
-- the Chats section. Idempotent (CI applies every migration on a fresh
-- Postgres) — CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS only.
--
-- Tables:
--   lead_forms             — one row per form: name/slug, the field schema
--                            (fields JSONB array — fully custom, no presets),
--                            logo/banner MinIO keys, status.
--   lead_form_submissions  — one row per fill; raw answers JSONB + the
--                            leads.id it was upserted into (source of truth
--                            for the funnel stays coexistence.leads).
--   lead_form_send_tokens  — opaque single-use tokens minted per WhatsApp
--                            recipient so a form link can silently carry
--                            "who this is" without asking for a phone number.
--                            (Minting/consumption wired in a later stage —
--                            table exists now so the submission path can
--                            already resolve a token if one is present.)

CREATE TABLE IF NOT EXISTS coexistence.lead_forms (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT,
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  logo_key         TEXT,
  banner_key       TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  success_message  TEXT,
  default_source   TEXT,
  created_by       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_forms_status ON coexistence.lead_forms(status);

CREATE TABLE IF NOT EXISTS coexistence.lead_form_submissions (
  id             BIGSERIAL PRIMARY KEY,
  form_id        BIGINT NOT NULL REFERENCES coexistence.lead_forms(id) ON DELETE CASCADE,
  lead_id        BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  answers        JSONB NOT NULL DEFAULT '{}'::jsonb,
  phone_number   TEXT,
  send_token     TEXT,
  ip_address     TEXT,
  user_agent     TEXT,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_form ON coexistence.lead_form_submissions(form_id);
CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_lead ON coexistence.lead_form_submissions(lead_id);

CREATE TABLE IF NOT EXISTS coexistence.lead_form_send_tokens (
  token          TEXT PRIMARY KEY,
  form_id        BIGINT NOT NULL REFERENCES coexistence.lead_forms(id) ON DELETE CASCADE,
  phone_number   TEXT NOT NULL,
  contact_name   TEXT,
  broadcast_id   BIGINT REFERENCES coexistence.broadcasts(id) ON DELETE SET NULL,
  wa_account_id  BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_lead_form_send_tokens_form ON coexistence.lead_form_send_tokens(form_id);
