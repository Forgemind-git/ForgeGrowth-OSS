-- ─── 000: bootstrap roles + schema ───────────────────────────────────────────
-- Runs before everything else. Idempotent.
--
-- WHY THIS EXISTS
-- These migrations were originally written against a self-hosted Supabase
-- stack, where the roles `anon`, `authenticated` and `service_role` already
-- exist and the `coexistence` schema is created by Supabase's own init. On a
-- plain PostgreSQL server — which is what the bundled docker-compose runs, and
-- what most self-hosters will use — none of that is true, and migration 001
-- fails immediately with:
--
--     ERROR:  role "service_role" does not exist
--
-- Forge Growth does not use PostgREST or row-level security, so these roles are
-- never actually authenticated as. They exist only so the GRANT statements
-- scattered through later migrations resolve. NOLOGIN is deliberate: they must
-- not be usable as connection identities.

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every table in this project is explicitly prefixed `coexistence.`; the schema
-- name is hardcoded throughout the codebase and is NOT configurable.
CREATE SCHEMA IF NOT EXISTS coexistence;

-- The application connects as the owner role, which on the bundled stack is not
-- named `postgres`. Grant it explicitly so later migrations' GRANTs and the
-- runtime's CREATE TABLE IF NOT EXISTS calls both succeed.
DO $$
BEGIN
  EXECUTE format('GRANT ALL ON SCHEMA coexistence TO %I', current_user);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA coexistence TO %I', current_user);
END $$;

GRANT USAGE ON SCHEMA coexistence TO anon, authenticated, service_role;
