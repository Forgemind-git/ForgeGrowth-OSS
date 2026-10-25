// Workflow Agents — schema (migration 121).
//
// ⚠ THIS STRING IS THE SOURCE OF TRUTH. supabase/migrations/121_workflow_agents.sql
// is generated from it (`node scripts/print-workflow-agents-ddl.js`), and
// test/workflowAgents.unit.test.js fails if the two ever differ. The
// backend image does not contain supabase/migrations, so the boot ensure cannot
// read the .sql file — a hand-kept second copy is exactly how migrations and
// boot ensures have drifted in this repo before.
//
// Naming: every module table is `workflow_agent*`. `agents`, `agent_runs`,
// `agent_run_steps`, `agent_tools` and `agent_config` already belong to the
// customer-facing AI Agents feature (docs/agents/DATA_MAP.md §6).
//
// Additive and idempotent: IF NOT EXISTS everywhere, CHECKs guarded by name,
// no DROP of anything that existed before this migration.

const pool = require('../../db');

const DDL = String.raw`-- 121: Workflow Agents module + the smallest fixes for the data gaps it needs.
-- Generated from backend/src/services/workflowAgents/schema.js — edit there.
-- Additive and idempotent. See docs/agents/DATA_MAP.md §7 for the gap list.

-- ── G1: reps, teams, number-assignment history ────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.rep_teams (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  lead_user_id  BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rep_teams_name ON coexistence.rep_teams (lower(name));

ALTER TABLE coexistence.forgecrm_users ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES coexistence.rep_teams(id) ON DELETE SET NULL;
ALTER TABLE coexistence.forgecrm_users ADD COLUMN IF NOT EXISTS employee_id TEXT;
ALTER TABLE coexistence.forgecrm_users ADD COLUMN IF NOT EXISTS working_hours JSONB;
ALTER TABLE coexistence.forgecrm_users ADD COLUMN IF NOT EXISTS notify_phone TEXT;

-- One row per period a rep owned a business number. valid_to NULL = current.
-- Time-bounded so reassigning a number never moves old leads with it.
CREATE TABLE IF NOT EXISTS coexistence.rep_number_assignments (
  id                   BIGSERIAL PRIMARY KEY,
  whatsapp_account_id  BIGINT NOT NULL REFERENCES coexistence.whatsapp_accounts(id) ON DELETE CASCADE,
  user_id              BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  valid_from           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to             TIMESTAMPTZ,
  assigned_by          BIGINT,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rep_number_assignments_period_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rep_number_assignments_open
  ON coexistence.rep_number_assignments (whatsapp_account_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_rep_number_assignments_account
  ON coexistence.rep_number_assignments (whatsapp_account_id, valid_from);

-- ── G2: sender attribution (read side) ────────────────────────────────────────
-- The sender-type classifier matches automation message steps to chat rows by
-- time (DATA_MAP §4.2); this keeps that lookup off a sequential scan.
CREATE INDEX IF NOT EXISTS idx_automation_steps_message_created
  ON coexistence.automation_execution_steps (created_at) WHERE node_type = 'message';

-- ── G4: transcript language ───────────────────────────────────────────────────
ALTER TABLE coexistence.chat_message_artifacts ADD COLUMN IF NOT EXISTS language TEXT;

-- ── G6: internal notes on a lead ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.lead_notes (
  id                  BIGSERIAL PRIMARY KEY,
  lead_id             BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  body                TEXT NOT NULL,
  author_user_id      BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  source              TEXT NOT NULL DEFAULT 'user',
  workflow_action_id  BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_notes_source_check CHECK (source IN ('user', 'agent'))
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON coexistence.lead_notes (lead_id, created_at DESC);

-- ── G7: opt-out ───────────────────────────────────────────────────────────────
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS opt_out_reason TEXT;

-- ── G13: the module ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.workflow_agents (
  id                   BIGSERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  description          TEXT,
  icon                 TEXT,
  preset_key           TEXT,
  status               TEXT NOT NULL DEFAULT 'draft',
  credential_id        INTEGER REFERENCES coexistence.ai_models(id) ON DELETE SET NULL,
  model                TEXT NOT NULL DEFAULT 'claude-opus-5',
  temperature          NUMERIC(3,2) NOT NULL DEFAULT 0.2,
  effort               TEXT NOT NULL DEFAULT 'high',
  max_tool_calls       INTEGER NOT NULL DEFAULT 40,
  max_tokens_per_run   INTEGER NOT NULL DEFAULT 200000,
  max_output_tokens    INTEGER NOT NULL DEFAULT 32000,
  monthly_budget_inr   NUMERIC(12,2),
  auto_accept_memory   BOOLEAN NOT NULL DEFAULT FALSE,
  current_version_id   BIGINT,
  created_by           BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agents_status_check CHECK (status IN ('draft', 'active', 'paused')),
  CONSTRAINT workflow_agents_effort_check CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  CONSTRAINT workflow_agents_temperature_check CHECK (temperature >= 0 AND temperature <= 1),
  CONSTRAINT workflow_agents_limits_check CHECK (max_tool_calls BETWEEN 1 AND 500 AND max_tokens_per_run BETWEEN 1000 AND 5000000 AND max_output_tokens BETWEEN 1000 AND 128000)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agents_slug ON coexistence.workflow_agents (slug);

-- Immutable snapshot: every save is a new row (trigger below refuses UPDATE).
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_versions (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  instructions    TEXT NOT NULL DEFAULT '',
  output_schema   JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_config     JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_scope      JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggers        JSONB NOT NULL DEFAULT '[]'::jsonb,
  destinations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approval_rules  JSONB NOT NULL DEFAULT '{}'::jsonb,
  runtime         JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_note     TEXT,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agent_versions ON coexistence.workflow_agent_versions (agent_id, version);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_agents_current_version_fk') THEN
    ALTER TABLE coexistence.workflow_agents
      ADD CONSTRAINT workflow_agents_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES coexistence.workflow_agent_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION coexistence.workflow_agent_versions_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'workflow_agent_versions rows are immutable; save a new version instead';
END
$fn$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_workflow_agent_versions_immutable') THEN
    CREATE TRIGGER trg_workflow_agent_versions_immutable
      BEFORE UPDATE ON coexistence.workflow_agent_versions
      FOR EACH ROW EXECUTE FUNCTION coexistence.workflow_agent_versions_immutable();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_memory (
  id                  BIGSERIAL PRIMARY KEY,
  agent_id            BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  lead_id             BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  content             TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'admin',
  status              TEXT NOT NULL DEFAULT 'active',
  proposed_by_run_id  BIGINT,
  expires_at          TIMESTAMPTZ,
  created_by          BIGINT,
  updated_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_memory_kind_check CHECK (kind IN ('pinned', 'learned', 'contact', 'glossary')),
  CONSTRAINT workflow_agent_memory_source_check CHECK (source IN ('admin', 'agent_proposed', 'feedback')),
  CONSTRAINT workflow_agent_memory_status_check CHECK (status IN ('active', 'pending_review', 'archived')),
  CONSTRAINT workflow_agent_memory_contact_check CHECK (kind <> 'contact' OR lead_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_memory_agent ON coexistence.workflow_agent_memory (agent_id, status, kind);

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_runs (
  id                  BIGSERIAL PRIMARY KEY,
  agent_id            BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  agent_version_id    BIGINT REFERENCES coexistence.workflow_agent_versions(id) ON DELETE SET NULL,
  trigger_type        TEXT NOT NULL,
  trigger_key         TEXT,
  trigger_payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run             BOOLEAN NOT NULL DEFAULT FALSE,
  pretend_date        DATE,
  config_snapshot     JSONB,
  status              TEXT NOT NULL DEFAULT 'queued',
  requested_by        BIGINT,
  queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  model               TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  cost_inr            NUMERIC(12,4) NOT NULL DEFAULT 0,
  output              JSONB,
  output_markdown     TEXT,
  output_valid        BOOLEAN,
  validation_errors   JSONB,
  checks              JSONB,
  error               TEXT,
  cursor              JSONB,
  CONSTRAINT workflow_agent_runs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'budget_stopped')),
  CONSTRAINT workflow_agent_runs_trigger_check CHECK (trigger_type IN ('schedule', 'event', 'manual', 'test'))
);
-- Idempotency: one run per (agent, trigger key), whatever its outcome. A schedule
-- slot, an event debounce window or a quiet-lead watermark fires at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agent_runs_trigger_key
  ON coexistence.workflow_agent_runs (agent_id, trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_agent_runs_agent ON coexistence.workflow_agent_runs (agent_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_runs_status ON coexistence.workflow_agent_runs (status);

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_run_steps (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES coexistence.workflow_agent_runs(id) ON DELETE CASCADE,
  step         INTEGER NOT NULL,
  type         TEXT NOT NULL,
  tool_key     TEXT,
  input        JSONB,
  output       JSONB,
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_run_steps_type_check CHECK (type IN ('model', 'tool_call', 'tool_result', 'memory_proposal', 'action_proposal', 'validation', 'info'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_run_steps_run ON coexistence.workflow_agent_run_steps (run_id, step);

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_actions (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT REFERENCES coexistence.workflow_agent_runs(id) ON DELETE CASCADE,
  agent_id      BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,
  lead_id       BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason        TEXT,
  dedupe_key    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  requested_by  BIGINT,
  decided_by    BIGINT,
  decided_at    TIMESTAMPTZ,
  executing_at  TIMESTAMPTZ,
  executed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_actions_type_check CHECK (action_type IN ('tag_contact', 'set_stage', 'assign_rep', 'create_task', 'send_whatsapp', 'add_note', 'trigger_automation', 'notify_rep')),
  CONSTRAINT workflow_agent_actions_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agent_actions_dedupe
  ON coexistence.workflow_agent_actions (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_agent_actions_status ON coexistence.workflow_agent_actions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_feedback (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT REFERENCES coexistence.workflow_agent_runs(id) ON DELETE SET NULL,
  agent_id    BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  lead_id     BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  item_ref    TEXT,
  rating      TEXT NOT NULL,
  outcome     TEXT,
  comment     TEXT,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_feedback_rating_check CHECK (rating IN ('useful', 'not_useful', 'converted', 'wrong')),
  CONSTRAINT workflow_agent_feedback_outcome_check CHECK (outcome IS NULL OR outcome IN ('called', 'messaged', 'converted', 'not_interested', 'wrong_signal'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_feedback_agent ON coexistence.workflow_agent_feedback (agent_id, created_at DESC);

-- Follow-up tasks created by approved create_task actions (no tasks table existed).
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_tasks (
  id                BIGSERIAL PRIMARY KEY,
  agent_id          BIGINT REFERENCES coexistence.workflow_agents(id) ON DELETE SET NULL,
  action_id         BIGINT REFERENCES coexistence.workflow_agent_actions(id) ON DELETE SET NULL,
  lead_id           BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  assignee_user_id  BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  due_at            TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'open',
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_tasks_status_check CHECK (status IN ('open', 'done', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_tasks_assignee ON coexistence.workflow_agent_tasks (assignee_user_id, status, due_at);

-- In-app notifications created by approved notify_rep actions.
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  agent_id    BIGINT REFERENCES coexistence.workflow_agents(id) ON DELETE SET NULL,
  action_id   BIGINT REFERENCES coexistence.workflow_agent_actions(id) ON DELETE SET NULL,
  lead_id     BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_notifications_user ON coexistence.workflow_agent_notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_deliveries (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             BIGINT NOT NULL REFERENCES coexistence.workflow_agent_runs(id) ON DELETE CASCADE,
  destination_index  INTEGER NOT NULL,
  type               TEXT NOT NULL,
  status             TEXT NOT NULL,
  detail             JSONB,
  error              TEXT,
  scheduled_for      TIMESTAMPTZ,
  attempts           INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_deliveries_status_check CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_deliveries_due ON coexistence.workflow_agent_deliveries (scheduled_for) WHERE status = 'scheduled';
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agent_deliveries ON coexistence.workflow_agent_deliveries (run_id, destination_index);

-- Debounce buffer for event triggers: one waiting row per (agent, trigger, lead).
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_pending_events (
  id             BIGSERIAL PRIMARY KEY,
  agent_id       BIGINT NOT NULL REFERENCES coexistence.workflow_agents(id) ON DELETE CASCADE,
  trigger_index  INTEGER NOT NULL,
  event          TEXT NOT NULL,
  lead_id        BIGINT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fire_at        TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'waiting',
  run_id         BIGINT,
  CONSTRAINT workflow_agent_pending_events_status_check CHECK (status IN ('waiting', 'fired', 'dropped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_agent_pending_waiting
  ON coexistence.workflow_agent_pending_events (agent_id, trigger_index, lead_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_workflow_agent_pending_fire ON coexistence.workflow_agent_pending_events (status, fire_at);

-- Singleton: event cursors (seeded at the current max so enabling the module
-- never replays history), cost settings and the Telegram bot token.
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_settings (
  id                            INTEGER PRIMARY KEY DEFAULT 1,
  business_name                 TEXT,
  default_working_hours         JSONB NOT NULL DEFAULT '{"days":[1,2,3,4,5,6],"start":"10:00","end":"19:00"}'::jsonb,
  usd_to_inr                    NUMERIC(10,4) NOT NULL DEFAULT 88,
  rate_card                     JSONB NOT NULL DEFAULT '{}'::jsonb,
  telegram_bot_token_encrypted  TEXT,
  last_chat_history_id          BIGINT NOT NULL DEFAULT 0,
  last_lead_event_id            BIGINT NOT NULL DEFAULT 0,
  last_razorpay_event_id        BIGINT NOT NULL DEFAULT 0,
  last_sales_log_id             BIGINT NOT NULL DEFAULT 0,
  cursors_seeded                BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_agent_settings_singleton CHECK (id = 1)
);
ALTER TABLE coexistence.workflow_agent_settings ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE coexistence.workflow_agent_settings ADD COLUMN IF NOT EXISTS default_working_hours JSONB NOT NULL DEFAULT '{"days":[1,2,3,4,5,6],"start":"10:00","end":"19:00"}'::jsonb;
INSERT INTO coexistence.workflow_agent_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
UPDATE coexistence.workflow_agent_settings SET
  last_chat_history_id   = COALESCE((SELECT MAX(id) FROM coexistence.chat_history), 0),
  last_lead_event_id     = COALESCE((SELECT MAX(id) FROM coexistence.lead_events), 0),
  last_razorpay_event_id = COALESCE((SELECT MAX(id) FROM coexistence.razorpay_events), 0),
  last_sales_log_id      = COALESCE((SELECT MAX(id) FROM coexistence.sales_log), 0),
  cursors_seeded = TRUE, updated_at = NOW()
WHERE id = 1 AND cursors_seeded = FALSE;

-- Ready-made agent configurations. Rows are upserted at boot from
-- services/workflowAgents/presets.js; creating an agent COPIES a row's config,
-- so editing an agent never changes its preset (and vice versa).
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_presets (
  preset_key   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  config       JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Who changed what, and when: memory edits, agent settings, restores, decisions.
CREATE TABLE IF NOT EXISTS coexistence.workflow_agent_audit (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    BIGINT,
  entity      TEXT NOT NULL,
  entity_id   BIGINT,
  action      TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  user_id     BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_audit_agent ON coexistence.workflow_agent_audit (agent_id, created_at DESC);
`;

// One run at a time, across processes. The DDL takes locks on several shared
// tables (leads, forgecrm_users, whatsapp_accounts…) in its own order, so two
// runs at once — two backends booting, or the test files that each call this —
// can deadlock each other ('deadlock detected'). A transaction-scoped advisory
// lock queues the second run behind the first; it releases on COMMIT/ROLLBACK.
const DDL_LOCK_KEY = 0x57414744; // 'WAGD'

async function ensureWorkflowAgentTables() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [DDL_LOCK_KEY]);
    await client.query(DDL);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { DDL, ensureWorkflowAgentTables };
