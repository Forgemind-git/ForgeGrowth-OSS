-- 104_agent_form_tables.sql
--
-- Two independent additions, both additive and idempotent, so this migration
-- may be applied before OR after the backend that uses it.
--
--   A. lead_form_submissions.created_by_agent_id
--      Who filed this row. NULL = a human (the public /f/<slug> page, an import,
--      a broadcast token fill) — which is every row that exists today.
--
--      This is what makes "the agent may update a row IT created" enforceable.
--      Without it the agent could only ever append, or it could rewrite a row a
--      customer typed themselves — and there would be no way to tell the two
--      apart after the fact.
--
--   B. agents.trigger_stage_keys / trigger_tag_ids
--      Which funnel stages / contact tags this agent is allowed to engage.
--      Empty array = no restriction, which is the behaviour every existing
--      agent has, so this changes nothing until an admin picks something.
--
--      ⚠ Stage is stored as the IMMUTABLE funnel_stages.stage_key, never the
--      label and never the row id — the same rule the stage-tag mirror, the
--      CAPI event map and the cold-drop engine follow. Renaming a stage in
--      Funnel Settings must not silently stop an agent answering anybody.

BEGIN;

-- ── A. who filed a form response ────────────────────────────────────────────
ALTER TABLE coexistence.lead_form_submissions
  ADD COLUMN IF NOT EXISTS created_by_agent_id BIGINT
    REFERENCES coexistence.agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN coexistence.lead_form_submissions.created_by_agent_id IS
  'The AI agent that filed this response, or NULL when a human did. An agent may only update rows it created; ON DELETE SET NULL so deleting an agent orphans its rows rather than destroying customer answers.';

-- Partial: the agent-authored rows are the small minority, and the only query
-- that uses this ("the row THIS agent last created for THIS lead") always
-- filters on a non-null id.
CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_agent
  ON coexistence.lead_form_submissions (created_by_agent_id, form_id, lead_id)
  WHERE created_by_agent_id IS NOT NULL;

-- ── B. funnel-aware agent triggers ──────────────────────────────────────────
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS trigger_stage_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS trigger_tag_ids    JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN coexistence.agents.trigger_stage_keys IS
  'Funnel stage_keys this agent may engage. Empty = any stage. Stored as the immutable stage_key, never the editable label.';
COMMENT ON COLUMN coexistence.agents.trigger_tag_ids IS
  'contacts.tags ids this agent may engage (includes the managed tag-funnel-<stage_key> mirror). Empty = any tag.';

COMMIT;
