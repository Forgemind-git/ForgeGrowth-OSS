-- 120_whatsapp_flows.sql
--
-- Native WhatsApp forms (Meta "Flows").
--
-- whatsapp_flows       one row per Flow created on Meta. The Flow is GENERATED
--                      from a lead form (form_id), so its questions can never
--                      exist anywhere the Responses table does not know about.
-- whatsapp_flow_sends  one row per Flow MESSAGE sent. `flow_token` travels to
--                      WhatsApp inside the message and comes back inside the
--                      submission, so it is the exact join from "someone
--                      submitted" to "which automation run is waiting for it".
--
-- ⚠ A Flow submission is claimed with
--     UPDATE … SET submitted_at = NOW() WHERE flow_token = $1 AND submitted_at IS NULL
-- so a webhook Meta delivers twice resumes the waiting run exactly once.
--
-- Additive and idempotent; the backend's ensureWhatsappFlowTables() mirrors it at boot.

BEGIN;

CREATE TABLE IF NOT EXISTS coexistence.whatsapp_flows (
  id                 BIGSERIAL PRIMARY KEY,
  wa_account_id      BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  waba_id            TEXT NOT NULL,
  meta_flow_id       TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'DRAFT',
  form_id            BIGINT REFERENCES coexistence.lead_forms(id) ON DELETE SET NULL,
  screen_id          TEXT NOT NULL DEFAULT 'REGISTRATION',
  flow_json          JSONB,
  validation_errors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview_url        TEXT,
  preview_expires_at TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_flows_form ON coexistence.whatsapp_flows (form_id);

CREATE TABLE IF NOT EXISTS coexistence.whatsapp_flow_sends (
  flow_token         TEXT PRIMARY KEY,
  whatsapp_flow_id   BIGINT REFERENCES coexistence.whatsapp_flows(id) ON DELETE SET NULL,
  meta_flow_id       TEXT NOT NULL,
  execution_id       BIGINT REFERENCES coexistence.automation_executions(id) ON DELETE SET NULL,
  node_id            TEXT,
  wa_number          TEXT NOT NULL,
  contact_number     TEXT NOT NULL,
  local_message_id   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at       TIMESTAMPTZ,
  submit_message_id  TEXT,
  submission_id      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_sends_contact
  ON coexistence.whatsapp_flow_sends (wa_number, contact_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_sends_execution
  ON coexistence.whatsapp_flow_sends (execution_id);

COMMIT;
