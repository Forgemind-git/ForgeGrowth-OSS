-- 096_follow_up_project.sql — follow-up sequences join Projects.
--
-- Same linkage the templates / automations / agents got in 094: a nullable
-- project_id, FK ON DELETE RESTRICT (a project is someone's campaign — deleting
-- it must not silently unfile its toolkit). Additive; idempotent; mirrored by
-- ensureProjectTables() at boot (which iterates the KINDS map).
ALTER TABLE coexistence.follow_up_sequences
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_sequences_project_id_fkey') THEN
    ALTER TABLE coexistence.follow_up_sequences
      ADD CONSTRAINT follow_up_sequences_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_follow_up_seq_project
  ON coexistence.follow_up_sequences (project_id);
