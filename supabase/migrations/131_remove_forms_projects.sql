-- 131_remove_forms_projects.sql
--
-- Removes the Forms feature (lead forms, their responses, uploads, send tokens,
-- the WhatsApp forms / Meta Flows generated from them, the form settings) and
-- the Projects feature (campaign folders for templates, automations, agents and
-- forms) — code AND data, on request, 2026-10-16.
--
-- ⚠ DEPLOY ORDER: BACKEND FIRST, THEN THIS MIGRATION. The old image recreates
-- these tables at boot (ensureLeadFormTables / ensureWhatsappFlowTables /
-- ensureProjectTables) and names project_id in its chatbot / template / agent
-- queries, so dropping them under it would break the Automations, Templates and
-- AI Agents pages and then partly undo itself on the next restart. The new code
-- names none of this, so running it before the drop is safe.
--
-- Untouched on purpose:
--   * claude_agent_settings.project_id / claude_projects — the Claude console's
--     own "project" concept, unrelated to these campaign folders.
--   * leads.custom_fields values that forms once wrote — they are lead data now.
--   * automation_executions.awaiting_kind 'flow' in its CHECK — harmless.
--
-- Idempotent: IF EXISTS throughout.

BEGIN;

-- Forms -----------------------------------------------------------------------
DROP TABLE IF EXISTS coexistence.whatsapp_flow_sends;
DROP TABLE IF EXISTS coexistence.whatsapp_flows;
DROP TABLE IF EXISTS coexistence.lead_form_files;
DROP TABLE IF EXISTS coexistence.lead_form_send_tokens;
DROP TABLE IF EXISTS coexistence.lead_form_submissions;
ALTER TABLE coexistence.broadcasts       DROP COLUMN IF EXISTS lead_form_id;
ALTER TABLE coexistence.payment_requests DROP COLUMN IF EXISTS form_id;
ALTER TABLE coexistence.payment_requests DROP COLUMN IF EXISTS form_submission_id;
DROP TABLE IF EXISTS coexistence.lead_forms;
DROP TABLE IF EXISTS coexistence.form_settings;

-- An AI agent's "fill a form" tool points at a form that no longer exists.
DELETE FROM coexistence.agent_tools WHERE tool_type = 'lead_form';

-- Projects --------------------------------------------------------------------
ALTER TABLE coexistence.chatbots          DROP COLUMN IF EXISTS project_id;
ALTER TABLE coexistence.message_templates DROP COLUMN IF EXISTS project_id;
ALTER TABLE coexistence.agents            DROP COLUMN IF EXISTS project_id;
DROP TABLE IF EXISTS coexistence.projects;
-- automation_folders was renamed to projects by 094; drop a leftover too.
DROP TABLE IF EXISTS coexistence.automation_folders;

-- Page keys -------------------------------------------------------------------
-- Stale keys in a role's page list are harmless, but they would keep showing in
-- the role editor as permissions for pages that no longer exist.
UPDATE coexistence.user_roles
   SET pages = pages - 'lead-forms' - 'projects'
 WHERE pages ?| ARRAY['lead-forms', 'projects'];

COMMIT;
