-- 134_remove_custom_domains.sql
--
-- Removes the custom-domains feature (Admin Settings -> Domain): the allow-list
-- the CORS check and Caddy's on-demand-TLS `ask` endpoint read, and the
-- Traefik dynamic-config writer behind it. Code AND data, alongside 131's
-- removal of Forms and Projects.
--
-- What replaces it is what every install already has: TLS_DOMAIN / CORS_ORIGIN
-- in .env (see docs/reverse-proxy.md). A domain that was only ever added in
-- that screen stops being accepted once this backend is running — add it to
-- CORS_ORIGIN before upgrading.
--
-- ⚠ DEPLOY ORDER: BACKEND FIRST, THEN THIS MIGRATION. The old image recreates
-- the table at boot (ensureDomainTables) and reads it on every CORS check.
--
-- Idempotent: IF EXISTS throughout.

BEGIN;

DROP TABLE IF EXISTS coexistence.custom_domains;

-- A stale key in a role's page list is harmless, but it would keep showing in
-- the role editor as a permission for a page that no longer exists.
UPDATE coexistence.user_roles
   SET pages = pages - 'domains'
 WHERE pages ? 'domains';

COMMIT;
