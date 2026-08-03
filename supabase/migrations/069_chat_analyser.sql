-- ─── Migration 069: Chat Analyser ────────────────────────────────────────────
-- LLM analysis of lead WhatsApp conversations → a suggested score/stage (never
-- auto-applied) plus two hand-editable "context boxes" (per-lead + one global
-- master brief) that the user pastes into an AI agent's system prompt.
--
--   chat_analyser_config  — singleton (id=1): model ref, nightly schedule, caps,
--                           and the GLOBAL master brief.
--   chat_analysis         — ONE row per lead, updated in place = current verdict.
--   chat_analysis_runs    — append-only: every run (incl. failures), token usage,
--                           and the pre-run context text (= the revert source).
--
-- Context boxes are stored as TWO columns and never merged in storage:
--   *_human   — typed by a person. NO code path ever overwrites this.
--   *_machine — rewritten wholesale by each run, hard-capped in length.
-- Display / Copy = human block + machine block concatenated.
--
-- Idempotent + re-runnable. Mirrored by ensureChatAnalyserTables() in
-- backend/src/services/chatAnalyser.js.

-- ── singleton config + master brief ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.chat_analyser_config (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,

  -- model: NULL/NULL means "auto-pick the cheapest connected model at run time"
  credential_id               INT REFERENCES coexistence.ai_models(id) ON DELETE SET NULL,
  model_id                    TEXT,

  -- nightly batch
  nightly_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  nightly_hour_ist            INT NOT NULL DEFAULT 3 CHECK (nightly_hour_ist BETWEEN 0 AND 23),
  nightly_max_conversations   INT NOT NULL DEFAULT 200 CHECK (nightly_max_conversations BETWEEN 1 AND 2000),
  last_nightly_run_at         TIMESTAMPTZ,
  last_nightly_ist_date       DATE,          -- compare-and-set guard: one batch per IST day
  last_nightly_batch_id       UUID,

  -- transcript / cost controls
  min_messages                INT NOT NULL DEFAULT 4,
  transcript_message_cap      INT NOT NULL DEFAULT 60,
  transcript_char_cap         INT NOT NULL DEFAULT 12000,

  -- GLOBAL master agent-context brief
  master_context_human        TEXT NOT NULL DEFAULT '',
  master_context_machine      TEXT NOT NULL DEFAULT '',
  master_context_updated_at   TIMESTAMPTZ,
  master_context_edited_at    TIMESTAMPTZ,
  master_context_edited_by    TEXT,
  master_stale                BOOLEAN NOT NULL DEFAULT FALSE,  -- set by single manual runs
  master_running_since        TIMESTAMPTZ,                     -- claim lock for the synthesis pass

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.chat_analyser_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── current verdict, one row per lead ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.chat_analysis (
  id                      BIGSERIAL PRIMARY KEY,
  lead_id                 BIGINT NOT NULL UNIQUE
                            REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  wa_number               TEXT,          -- business number the newest message came from
  contact_number          TEXT NOT NULL, -- customer number as stored in chat_history

  -- ── verdict ──
  suggested_score         INT   CHECK (suggested_score IS NULL OR suggested_score BETWEEN 0 AND 100),
  -- a funnel_stages.stage_key. Deliberately NO FK: stages are user-editable and
  -- deletable; a FK would block stage deletion. Validated in-app via cfg.isValidStage().
  suggested_stage         TEXT,
  confidence              NUMERIC(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  intent                  TEXT CHECK (intent IS NULL OR intent IN ('high','medium','low','none')),
  sentiment               TEXT CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','negative')),
  summary                 TEXT,
  stage_reason            TEXT,
  score_reason            TEXT,
  next_action             TEXT,
  risk                    TEXT,
  objections              JSONB NOT NULL DEFAULT '[]'::jsonb,
  buying_signals          JSONB NOT NULL DEFAULT '[]'::jsonb,
  topics                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  rules_matched           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{rule, points, source, evidence}]

  -- ── per-conversation context box ──
  context_machine         TEXT NOT NULL DEFAULT '',
  context_human           TEXT NOT NULL DEFAULT '',
  context_edited_at       TIMESTAMPTZ,
  context_edited_by       TEXT,

  -- ── suggestion lifecycle ──
  suggestion_state        TEXT NOT NULL DEFAULT 'pending'
                            CHECK (suggestion_state IN ('pending','applied','dismissed')),
  applied_stage           TEXT,
  applied_score           INT,
  applied_at              TIMESTAMPTZ,
  applied_by              TEXT,
  dismissed_at            TIMESTAMPTZ,
  dismissed_by            TEXT,

  -- ── staleness key: powers "stale — 6 new messages since" ──
  last_message_id         BIGINT,        -- chat_history.id of the newest analysed message
  last_message_at         TIMESTAMPTZ,
  analysed_message_count  INT NOT NULL DEFAULT 0,
  transcript_truncated    BOOLEAN NOT NULL DEFAULT FALSE,

  -- ── run bookkeeping ──
  last_run_id             BIGINT,
  last_run_at             TIMESTAMPTZ,
  last_status             TEXT NOT NULL DEFAULT 'ok' CHECK (last_status IN ('ok','error')),
  last_error              TEXT,
  run_count               INT NOT NULL DEFAULT 0,
  model_used              TEXT,
  running_since           TIMESTAMPTZ,   -- claim lock; expires after 5 min (crash-safe)

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_analysis_state   ON coexistence.chat_analysis(suggestion_state);
CREATE INDEX IF NOT EXISTS idx_chat_analysis_lastrun ON coexistence.chat_analysis(last_run_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_analysis_status  ON coexistence.chat_analysis(last_status) WHERE last_status = 'error';
CREATE INDEX IF NOT EXISTS idx_chat_analysis_contact ON coexistence.chat_analysis(contact_number);

-- ── append-only run log (history + failures + revert source) ─────────────────
CREATE TABLE IF NOT EXISTS coexistence.chat_analysis_runs (
  id                      BIGSERIAL PRIMARY KEY,
  lead_id                 BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  batch_id                UUID,          -- NULL for a single manual run
  kind                    TEXT NOT NULL DEFAULT 'conversation'
                            CHECK (kind IN ('conversation','master')),
  trigger                 TEXT NOT NULL CHECK (trigger IN ('manual','bulk','nightly')),
  actor                   TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('ok','error','skipped')),
  error                   TEXT,
  provider                TEXT,
  model_id                TEXT,
  credential_id           INT,
  prompt_tokens           INT,
  completion_tokens       INT,
  total_tokens            INT,
  elapsed_ms              INT,
  messages_analysed       INT,
  transcript_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
  suggested_score         INT,
  suggested_stage         TEXT,
  parsed                  JSONB,
  raw_response            TEXT,          -- capped at 4000 chars in app code
  context_before          TEXT,          -- chat_analysis.context_machine BEFORE this run  → revert
  master_context_before   TEXT,          -- config.master_context_machine BEFORE this run  → revert
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_car_lead   ON coexistence.chat_analysis_runs(lead_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_car_batch  ON coexistence.chat_analysis_runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_car_errors ON coexistence.chat_analysis_runs(started_at DESC) WHERE status = 'error';

-- ── join keys: leads.whatsapp_number ↔ chat_history.contact_number ───────────
-- Formats can diverge (+91…, 91…, bare 10-digit). routes/leadForms.js already
-- matches on the last 10 digits; these expression indexes make that join cheap.
CREATE INDEX IF NOT EXISTS idx_chat_history_key10
  ON coexistence.chat_history ((right(regexp_replace(contact_number,'\D','','g'),10)));
CREATE INDEX IF NOT EXISTS idx_leads_key10
  ON coexistence.leads ((right(regexp_replace(whatsapp_number,'\D','','g'),10)));
