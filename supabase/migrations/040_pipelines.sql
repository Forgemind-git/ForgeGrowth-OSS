-- 040_pipelines.sql
-- Sales pipelines (Kanban deal board) for ForgeChat.
--
-- Three tables in the coexistence schema:
--   pipelines        — a named board (e.g. "Sales Pipeline")
--   pipeline_stages  — ordered columns within a pipeline (editable per pipeline);
--                      is_won / is_lost flag the terminal columns, probability (0-100)
--                      feeds the Weighted Value KPI.
--   deals            — cards. A deal optionally links to a CRM contact
--                      (wa_number + contact_number) and an assignee (forgecrm_users).
--                      status mirrors the stage it sits in (open|won|lost); won_at /
--                      lost_at are stamped when it lands in a terminal stage and power
--                      the "Won/Lost This Month" KPIs.
--
-- Stage deletion is blocked by the API (409) while the stage still holds deals.
-- Deleting a pipeline cascades to its stages and deals.

CREATE TABLE IF NOT EXISTS coexistence.pipelines (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.pipeline_stages (
  id           BIGSERIAL PRIMARY KEY,
  pipeline_id  BIGINT NOT NULL REFERENCES coexistence.pipelines(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6B7280',
  sort_order   INT NOT NULL DEFAULT 0,
  probability  INT NOT NULL DEFAULT 0,
  is_won       BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline
  ON coexistence.pipeline_stages(pipeline_id, sort_order);

CREATE TABLE IF NOT EXISTS coexistence.deals (
  id                  BIGSERIAL PRIMARY KEY,
  pipeline_id         BIGINT NOT NULL REFERENCES coexistence.pipelines(id) ON DELETE CASCADE,
  stage_id            BIGINT NOT NULL REFERENCES coexistence.pipeline_stages(id) ON DELETE RESTRICT,
  title               TEXT NOT NULL,
  value               NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'INR',
  contact_wa_number   TEXT,
  contact_number      TEXT,
  contact_name        TEXT,
  assigned_user_id    BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  expected_close_date DATE,
  notes               TEXT,
  sort_order          INT NOT NULL DEFAULT 0,
  won_at              TIMESTAMPTZ,
  lost_at             TIMESTAMPTZ,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON coexistence.deals(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage    ON coexistence.deals(stage_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_deals_status   ON coexistence.deals(status);
