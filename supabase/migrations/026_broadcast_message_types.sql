-- Add support for non-template message types in broadcasts
-- (text, link, image, video, audio, document)

-- IF NOT EXISTS on every ADD COLUMN: re-applying the whole migration set is the
-- documented upgrade path, and a bare ADD COLUMN aborts the file on the second
-- run. ALTER ... DROP NOT NULL is already idempotent.
ALTER TABLE coexistence.broadcasts
  ALTER COLUMN template_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'template',
  ADD COLUMN IF NOT EXISTS body TEXT,
  ADD COLUMN IF NOT EXISTS url TEXT,
  ADD COLUMN IF NOT EXISTS media_library_id BIGINT,
  ADD COLUMN IF NOT EXISTS caption TEXT;
