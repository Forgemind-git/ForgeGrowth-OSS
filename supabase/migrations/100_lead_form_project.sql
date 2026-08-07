-- 100_lead_form_project.sql — Forms join Projects.
--
-- The fifth kind a project can hold, after templates / automations / agents
-- (094) and follow-up sequences (096). Same linkage every time: a nullable
-- project_id with an FK ON DELETE RESTRICT, because a project is someone's
-- campaign and deleting it must never silently unfile its toolkit — the
-- delete route refuses with a message naming what is still inside.
--
-- Additive and idempotent, so it is safe to apply before OR after the backend
-- (ensureProjectTables() mirrors it at boot by iterating the KINDS map).
ALTER TABLE coexistence.lead_forms
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_forms_project_id_fkey') THEN
    ALTER TABLE coexistence.lead_forms
      ADD CONSTRAINT lead_forms_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lead_forms_project
  ON coexistence.lead_forms (project_id);
