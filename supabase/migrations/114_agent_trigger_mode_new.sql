-- 114_agent_trigger_mode_new.sql
--
-- Allow trigger_mode = 'new' ("New conversations only") on agents.
--
-- Migration 050 created agents_trigger_mode_check as IN ('any','keyword').
-- The 'new' mode was added later: agentRouter.js implements it in full (a
-- contact engages only when they have no earlier inbound to that number, then
-- the session window keeps the conversation going), agentService.js validates
-- it, and AgentEditor.jsx offers it as a pill. Only the CHECK was never
-- widened -- so picking "New conversations only" in the UI always failed with
-- "Failed to update agent" and a constraint violation in the log, with nothing
-- on screen saying why.
--
-- Widening a CHECK is permissive: every existing row is 'any' or 'keyword' and
-- stays valid, so this cannot fail on live data. 050 guards its ADD with
-- IF NOT EXISTS, so it will not recreate the narrow version afterwards.
--
-- Idempotent: safe to re-run.

ALTER TABLE coexistence.agents
  DROP CONSTRAINT IF EXISTS agents_trigger_mode_check;

ALTER TABLE coexistence.agents
  ADD CONSTRAINT agents_trigger_mode_check
  CHECK (trigger_mode IN ('any', 'keyword', 'new'));
