-- 082_funnel_tags.sql — mirror each lead's funnel stage onto its WhatsApp
-- contact as a tag, so the Chats section (which can only filter on
-- contacts.tags) can segment by funnel stage.
--
-- Additive and idempotent. Creates no lead/contact data; the tag rows and the
-- contacts.tags blobs are written by services/funnelTags.js, which also mirrors
-- this file at boot via ensureFunnelTagTables().
--
-- NOTE ON IDS: the managed category is 'cat-funnel-stage' and each tag is
-- 'tag-funnel-<stage_key>'. They are derived from the IMMUTABLE stage_key, never
-- from the editable label, so renaming a stage cannot orphan a tag that is
-- already denormalised inside hundreds of contacts.tags blobs.

BEGIN;

-- Cursor for the lead_events sweeper. Eight code paths write leads.stage and
-- several use raw SQL, so tags are kept in step by walking the append-only
-- event log rather than by hooking each call site (same pattern as capi_config
-- and clo_settings).
CREATE TABLE IF NOT EXISTS coexistence.funnel_tag_state (
  id            SMALLINT PRIMARY KEY DEFAULT 1,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT funnel_tag_state_singleton CHECK (id = 1)
);

INSERT INTO coexistence.funnel_tag_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Rename propagation rewrites every contacts.tags blob containing a given tag
-- id; the containment lookup that finds them needs a GIN index.
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin
  ON coexistence.contacts USING GIN (tags);

COMMIT;
