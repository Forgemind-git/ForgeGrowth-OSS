-- 089_communities.sql — Communities section (WhatsApp groups via Evolution API)
--
-- WHY THIS TABLE HOLDS ONLY A SELECTION, NOT MESSAGES
-- ---------------------------------------------------
-- Group traffic lives in the SEPARATE `evolution` database (Baileys client),
-- which is the only place WhatsApp groups exist at all — the Meta Cloud API
-- that powers the Chats section cannot see a group by design. Copying those
-- messages into `forgegrowth` would create two sources of truth that drift the
-- moment a sync misses. So Communities READS Evolution live (through a
-- read-only role) and this table stores nothing but *which groups to show*.
--
-- Idempotent; re-runnable.

CREATE TABLE IF NOT EXISTS coexistence.community_groups (
  group_jid      TEXT PRIMARY KEY,
  -- The Evolution instance the group belongs to. Stored by NAME because that
  -- is what the Evolution REST API addresses instances by and what an admin
  -- recognises; the numeric id is resolved at query time.
  instance_name  TEXT NOT NULL,
  -- Snapshot of the group subject at the time it was added. The live name is
  -- read from Evolution on every request; this is the fallback for when a
  -- group is deleted there but still referenced here.
  name           TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT NOT NULL DEFAULT 0,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by       BIGINT
);

COMMENT ON TABLE coexistence.community_groups IS
  'Which WhatsApp groups the Communities section displays. Messages are NOT stored here — they are read live from the evolution database via a read-only role.';

CREATE INDEX IF NOT EXISTS idx_community_groups_active
  ON coexistence.community_groups (active, sort_order);

-- No groups are seeded: an install adds the ones it wants to show.
