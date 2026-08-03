-- 041: Persist the Media Library source behind a template's media header.
--
-- Background: media-header templates (IMAGE/VIDEO/DOCUMENT) only stored
-- `media_handle` — Meta's single-use resumable-upload handle, which is NOT a
-- viewable URL and is consumed when the template is submitted. As a result the
-- builder preview lost the image after submitting, and the broadcast preview
-- had no way to render the header media at all.
--
-- This column keeps a stable pointer to the originating Media Library row so we
-- can (a) re-render the preview anytime via the auth-proxied download URL and
-- (b) auto-prefill the media when broadcasting that template.
ALTER TABLE coexistence.message_templates
  ADD COLUMN IF NOT EXISTS header_media_library_id BIGINT
    REFERENCES coexistence.media_library(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_message_templates_header_media
  ON coexistence.message_templates(header_media_library_id);
