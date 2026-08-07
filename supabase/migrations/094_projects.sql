-- 094_projects.sql — Projects: one folder for a campaign's whole toolkit
--
-- A campaign is never one asset. "Run the Applied AI launch" means a broadcast
-- TEMPLATE, an AI AGENT that answers the people who reply to it, and an
-- AUTOMATION that follows up. Those three lived in three unrelated lists with
-- no way to see them as one thing.
--
-- ⚠ This GENERALISES the existing automation_folders table rather than adding a
-- second grouping beside it. That table shipped with migration 039 and a full
-- file-manager UI, and was never used: 0 folders, and every chatbots.folder_id
-- is NULL. Adding `projects` alongside it would have given automations TWO
-- independent groupings — exactly the confusion this feature exists to remove.
-- Because the table is empty the rename carries no data risk.
--
-- ⚠ DEPLOY ORDERING — THIS MIGRATION MUST NOT RUN AHEAD OF THE BACKEND.
-- Unlike an additive migration (093, 085 …), this one RENAMES things the
-- running code reads: automation_folders -> projects and chatbots.folder_id ->
-- chatbots.project_id. Applying it while the old image is still up makes
-- `GET /automation-folders` AND `GET /chatbots` throw "relation/column does not
-- exist" — i.e. the whole Automations page 500s, not just the folder feature.
-- Verified the hard way during development: applied early, live Automations
-- broke, reverted, re-applied at deploy.
--
-- The rule is the inverse of the additive one:
--   additive columns -> migration FIRST, then the backend
--   renames/drops    -> backend and migration TOGETHER (or backend first)
-- Deploy: docker compose build forgegrowth-backend forgegrowth-frontend
--         && apply this file && docker compose up -d forgegrowth-*
--
-- Idempotent; re-runnable.

BEGIN;

-- ── automation_folders -> projects ───────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'coexistence' AND table_name = 'automation_folders')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'coexistence' AND table_name = 'projects') THEN
    ALTER TABLE coexistence.automation_folders RENAME TO projects;
  END IF;
END $$;

-- Fresh installs that never had migration 039.
CREATE TABLE IF NOT EXISTS coexistence.projects (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE coexistence.projects
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS color       TEXT,
  ADD COLUMN IF NOT EXISTS archived    BOOLEAN NOT NULL DEFAULT FALSE;

-- ── chatbots.folder_id -> chatbots.project_id ────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'coexistence' AND table_name = 'chatbots'
                AND column_name = 'folder_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'coexistence' AND table_name = 'chatbots'
                AND column_name = 'project_id') THEN
    ALTER TABLE coexistence.chatbots RENAME COLUMN folder_id TO project_id;
  END IF;
END $$;

ALTER TABLE coexistence.chatbots
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

-- ── The two new members of a project ─────────────────────────────────────────
ALTER TABLE coexistence.message_templates
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS project_id BIGINT;

-- ON DELETE RESTRICT on all three, matching what migration 039 already did for
-- automations: deleting a project that still holds assets is refused (409)
-- rather than silently unfiling a campaign's toolkit. The API reports which
-- kinds are still inside so the user knows what to move.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chatbots_project_id_fkey') THEN
    -- Migration 039 created this FK under its old name; rename rather than
    -- re-create so we never briefly drop referential integrity.
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chatbots_folder_id_fkey') THEN
      ALTER TABLE coexistence.chatbots RENAME CONSTRAINT chatbots_folder_id_fkey TO chatbots_project_id_fkey;
    ELSE
      ALTER TABLE coexistence.chatbots
        ADD CONSTRAINT chatbots_project_id_fkey FOREIGN KEY (project_id)
        REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_project_id_fkey') THEN
    ALTER TABLE coexistence.message_templates
      ADD CONSTRAINT message_templates_project_id_fkey FOREIGN KEY (project_id)
      REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_project_id_fkey') THEN
    ALTER TABLE coexistence.agents
      ADD CONSTRAINT agents_project_id_fkey FOREIGN KEY (project_id)
      REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chatbots_project          ON coexistence.chatbots (project_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_project ON coexistence.message_templates (project_id);
CREATE INDEX IF NOT EXISTS idx_agents_project            ON coexistence.agents (project_id);

COMMENT ON TABLE coexistence.projects IS
  'A campaign workspace grouping message templates + automations + AI agents. Was automation_folders (migration 039, never used) until 094.';

COMMIT;
