-- Migration 045: backing columns for fully-wired automation nodes.
--
-- lead_score        — integer score on each contact, driven by the "Update Lead
--                     Score" action and the AI Lead Qualify node, and usable in
--                     Condition nodes. Defaults 0 so existing contacts compare.
-- chatbots.webhook_secret — per-automation signing secret for the Webhook /
--                     API-Event trigger. The automation's public webhook URL is
--                     /api/automations/<id>/webhook and callers sign with this.

ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS lead_score INTEGER NOT NULL DEFAULT 0;

ALTER TABLE coexistence.chatbots
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
