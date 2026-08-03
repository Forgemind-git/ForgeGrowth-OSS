-- 039_automation_folders.sql
-- Folders for organizing automations (chatbots).
-- A chatbot belongs to at most one folder (folder_id NULL = ungrouped / root).
-- ON DELETE RESTRICT: a folder cannot be dropped while it still holds automations
-- (the API also blocks this with a friendly 409 before reaching the FK).

CREATE TABLE IF NOT EXISTS coexistence.automation_folders (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE coexistence.chatbots
  ADD COLUMN IF NOT EXISTS folder_id BIGINT
  REFERENCES coexistence.automation_folders(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_chatbots_folder_id
  ON coexistence.chatbots(folder_id);
