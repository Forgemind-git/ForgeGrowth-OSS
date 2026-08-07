-- 099_mcp_tool_categories.sql
--
-- Category-based MCP tool gating.
--
-- Every MCP tool now belongs to exactly one CATEGORY (see
-- backend/src/services/mcpCatalog.js), and the category is what an admin
-- switches on or off in Admin Settings -> MCP Tools. Previously the gate was a
-- flat list of 20 capability keys that mixed functional caps with the
-- generic-proxy area caps, so a single key like `discovery` gated ten unrelated
-- tools across templates, media, agents and Google Drive.
--
-- ADDITIVE ONLY, so this migration is safe to apply BEFORE the backend deploy:
-- the running backend does not read `categories` and keeps using `capabilities`
-- exactly as it does today.
--
-- THE SEED IS DELIBERATELY NOT DONE HERE. Seeding needs the tool->category map
-- and the "needs ALL of its legacy caps" rule, both of which live in
-- mcpCatalog.js. Re-expressing that in SQL would create two implementations of
-- one rule, and the half that drifts fails silently (the exact trap already
-- documented for message_norm). Instead ensureMcpTables() seeds it once at boot
-- from the existing capabilities, so a live connector behaves identically.
--
-- NULL therefore means "never seeded". Once seeded the column is non-null and
-- is never re-seeded, so an admin who deliberately switches a category OFF does
-- not have it switched back on by the next backend restart.
--
-- `capabilities` is NOT dropped. It still gates which internal API paths the
-- generic `forgechat_request` proxy may reach (PROXY_AREAS) — that is the one
-- job the area caps were actually designed for.

ALTER TABLE coexistence.mcp_settings
  ADD COLUMN IF NOT EXISTS categories JSONB;

COMMENT ON COLUMN coexistence.mcp_settings.categories IS
  'Per-category MCP tool switches, keyed by mcpCatalog.js CATEGORIES.key. NULL = not yet seeded; ensureMcpTables() seeds it once from capabilities at boot. Gates named tools. capabilities still gates the forgechat_request proxy areas.';
