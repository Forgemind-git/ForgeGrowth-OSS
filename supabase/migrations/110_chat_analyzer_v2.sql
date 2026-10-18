-- ─── Migration 110: Chat Analyzer v2 ─────────────────────────────────────────
-- Revives the Chat Analyser (migration 069, code removed 2026-07-31 in 0fba39d)
-- and extends it in four ways:
--
--   1. MEDIA. 069 only ever put a placeholder in the transcript ("[voice note]").
--      Voice notes, images and PDFs are now really read, per a per-run choice of
--      modalities.
--   2. INCREMENTAL. 069 re-sent the WHOLE conversation on every run.
--   3. CONVERSATIONS, NOT LEADS. 069 keyed on leads.id, so a chat with no lead —
--      and every WhatsApp GROUP — was unreachable.
--   4. COST. Runs are billed by OpenAI; nothing recorded what they cost.
--
-- ⚠ THE COVERAGE LEDGER IS PER MODALITY, NOT PER CONVERSATION.
-- A single "last analysed message id" watermark is the obvious design and it is
-- silently WRONG here: if messages 1-100 were covered as text-only and images
-- are switched on afterwards, one watermark reports 1-100 as done and every
-- image in them is skipped for good — no error, just an analysis missing the
-- thing the user turned on to see. Hence UNIQUE (source, conversation_key,
-- modality): each modality advances on its own.
--
-- ⚠ ARTIFACTS ARE CACHED FOREVER, KEYED ON THE MESSAGE.
-- Transcribing a voice note costs money per minute and its text can never
-- change, so chat_message_artifacts is UNIQUE on (source, message_key, kind).
-- This is also a live bug fix beyond the analyser: agentEngine's
-- transcribeInboundIfAudio writes a transcript into chat_history.message_body
-- and never reads it back, so every agent run re-pays Whisper on the same
-- audio. Measured on this instance: 529 audio messages, 26 with a persisted
-- transcript.
--
-- Idempotent + re-runnable. Mirrored by ensureChatAnalyserTables() in
-- backend/src/services/chatAnalyser.js.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables from 069, recreated if this instance never ran it.
--    (On the Forge Growth instance they exist and hold 300 + 426 rows.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coexistence.chat_analyser_config (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  credential_id               INT REFERENCES coexistence.ai_models(id) ON DELETE SET NULL,
  model_id                    TEXT,
  nightly_enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  nightly_hour_ist            INT NOT NULL DEFAULT 3 CHECK (nightly_hour_ist BETWEEN 0 AND 23),
  nightly_max_conversations   INT NOT NULL DEFAULT 200 CHECK (nightly_max_conversations BETWEEN 1 AND 2000),
  last_nightly_run_at         TIMESTAMPTZ,
  last_nightly_ist_date       DATE,
  last_nightly_batch_id       UUID,
  min_messages                INT NOT NULL DEFAULT 4,
  transcript_message_cap      INT NOT NULL DEFAULT 60,
  transcript_char_cap         INT NOT NULL DEFAULT 12000,
  master_context_human        TEXT NOT NULL DEFAULT '',
  master_context_machine      TEXT NOT NULL DEFAULT '',
  master_context_updated_at   TIMESTAMPTZ,
  master_context_edited_at    TIMESTAMPTZ,
  master_context_edited_by    TEXT,
  master_stale                BOOLEAN NOT NULL DEFAULT FALSE,
  master_running_since        TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.chat_analyser_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS coexistence.chat_analysis (
  id                      BIGSERIAL PRIMARY KEY,
  lead_id                 BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  wa_number               TEXT,
  contact_number          TEXT,
  suggested_score         INT,
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
  rules_matched           JSONB NOT NULL DEFAULT '[]'::jsonb,
  context_machine         TEXT NOT NULL DEFAULT '',
  context_human           TEXT NOT NULL DEFAULT '',
  context_edited_at       TIMESTAMPTZ,
  context_edited_by       TEXT,
  suggestion_state        TEXT NOT NULL DEFAULT 'pending'
                            CHECK (suggestion_state IN ('pending','applied','dismissed')),
  applied_stage           TEXT,
  applied_score           INT,
  applied_at              TIMESTAMPTZ,
  applied_by              TEXT,
  dismissed_at            TIMESTAMPTZ,
  dismissed_by            TEXT,
  last_message_id         BIGINT,
  last_message_at         TIMESTAMPTZ,
  analysed_message_count  INT NOT NULL DEFAULT 0,
  transcript_truncated    BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_id             BIGINT,
  last_run_at             TIMESTAMPTZ,
  last_status             TEXT NOT NULL DEFAULT 'ok' CHECK (last_status IN ('ok','error')),
  last_error              TEXT,
  run_count               INT NOT NULL DEFAULT 0,
  model_used              TEXT,
  running_since           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.chat_analysis_runs (
  id                      BIGSERIAL PRIMARY KEY,
  lead_id                 BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  batch_id                UUID,
  kind                    TEXT NOT NULL DEFAULT 'conversation',
  trigger                 TEXT NOT NULL,
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
  raw_response            TEXT,
  context_before          TEXT,
  master_context_before   TEXT,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at             TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. chat_analysis: lead-keyed  →  conversation-keyed.
--
--    069 declared lead_id NOT NULL UNIQUE. That is exactly what made a chat
--    without a lead, and every group, impossible to analyse. The lead link is
--    kept (it is how the funnel-stage suggestion is applied) but it is now a
--    nullable ATTRIBUTE of the conversation rather than its identity.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE coexistence.chat_analysis
  ADD COLUMN IF NOT EXISTS source           TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS conversation_key TEXT,
  ADD COLUMN IF NOT EXISTS display_name     TEXT,
  -- Groups have many speakers and no single lead, so a funnel-stage verdict is
  -- meaningless there. These two carry what a group analysis is actually for.
  ADD COLUMN IF NOT EXISTS participants     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS open_questions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which modalities the CURRENT verdict was built from. Without this the UI
  -- cannot honestly say "this summary has not looked at the voice notes".
  ADD COLUMN IF NOT EXISTS modalities       JSONB NOT NULL DEFAULT '["text"]'::jsonb;

DO $$
BEGIN
  -- Backfill before the constraints change, so existing rows satisfy them.
  UPDATE coexistence.chat_analysis
     SET conversation_key = right(regexp_replace(contact_number, '\D', '', 'g'), 10)
   WHERE conversation_key IS NULL AND contact_number IS NOT NULL;

  -- Any row still without a key cannot be addressed by the new model; park it
  -- on its lead id rather than deleting somebody's analysis.
  UPDATE coexistence.chat_analysis
     SET conversation_key = 'lead:' || lead_id
   WHERE conversation_key IS NULL AND lead_id IS NOT NULL;

  DELETE FROM coexistence.chat_analysis WHERE conversation_key IS NULL;

  ALTER TABLE coexistence.chat_analysis ALTER COLUMN lead_id DROP NOT NULL;
  ALTER TABLE coexistence.chat_analysis ALTER COLUMN contact_number DROP NOT NULL;
EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
END $$;

ALTER TABLE coexistence.chat_analysis
  DROP CONSTRAINT IF EXISTS chat_analysis_lead_id_key;

ALTER TABLE coexistence.chat_analysis
  DROP CONSTRAINT IF EXISTS chat_analysis_source_check;
ALTER TABLE coexistence.chat_analysis
  ADD  CONSTRAINT chat_analysis_source_check CHECK (source IN ('chat','community'));

ALTER TABLE coexistence.chat_analysis
  ALTER COLUMN conversation_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_analysis_conversation
  ON coexistence.chat_analysis (source, conversation_key);

CREATE INDEX IF NOT EXISTS idx_chat_analysis_state   ON coexistence.chat_analysis(suggestion_state);
CREATE INDEX IF NOT EXISTS idx_chat_analysis_lastrun ON coexistence.chat_analysis(last_run_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_analysis_status  ON coexistence.chat_analysis(last_status) WHERE last_status = 'error';
CREATE INDEX IF NOT EXISTS idx_chat_analysis_contact ON coexistence.chat_analysis(contact_number);
CREATE INDEX IF NOT EXISTS idx_chat_analysis_lead    ON coexistence.chat_analysis(lead_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Per-message artifact cache — the "never pay twice" store.
--
--    One row per (message, kind). A voice note is transcribed ONCE, ever, and
--    every later run — whatever its date range, keyword or modality set —
--    reuses that text. Same for a vision description and a PDF's text.
--
--    `status` distinguishes the three non-successes that must not be retried
--    blindly: 'empty' (a scanned PDF has no text layer — retrying costs money
--    and returns empty again), 'skipped' (over a cap), 'failed' (transient).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coexistence.chat_message_artifacts (
  id                BIGSERIAL PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('chat','community')),
  message_key       TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('transcript','vision','document')),
  conversation_key  TEXT,
  text              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','empty','failed','skipped')),
  error             TEXT,
  provider          TEXT,
  model             TEXT,
  prompt_tokens     INT,
  completion_tokens INT,
  audio_seconds     NUMERIC(10,2),
  bytes             BIGINT,
  -- USD micro-dollars (1e-6). Integer money: a NUMERIC rupee figure here would
  -- invite rounding per row and drift against the dashboard total.
  cost_micros       BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_artifacts
  ON coexistence.chat_message_artifacts (source, message_key, kind);
CREATE INDEX IF NOT EXISTS idx_cma_conversation
  ON coexistence.chat_message_artifacts (source, conversation_key, kind);
CREATE INDEX IF NOT EXISTS idx_cma_cost
  ON coexistence.chat_message_artifacts (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Coverage ledger — per conversation PER MODALITY.
--
--    Only a FULL run advances coverage. A scoped run (an explicit date range or
--    keyword) is a one-off answer and deliberately leaves this untouched, which
--    is what keeps the watermark monotonic and therefore trustworthy.
--
--    Two watermark columns because the two sources order differently:
--      chat      → chat_history.id, a bigserial. Exact, delta is `id > seq`.
--      community → Evolution's Message.id is a text cuid with no order, so the
--                  only ordering key is messageTimestamp (unix SECONDS). Ties
--                  within one second are real in a group, so the delta there is
--                  `>= epoch` and the boundary second is re-read. Re-reading a
--                  message is cheap (its artifacts are cached); losing one is
--                  silent and permanent. Prefer the duplicate.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coexistence.chat_analysis_coverage (
  id                     BIGSERIAL PRIMARY KEY,
  source                 TEXT NOT NULL CHECK (source IN ('chat','community')),
  conversation_key       TEXT NOT NULL,
  modality               TEXT NOT NULL
                           CHECK (modality IN ('text','image','audio','document')),
  covered_through_seq    BIGINT,
  covered_through_epoch  BIGINT,
  covered_through_at     TIMESTAMPTZ,
  covered_from_at        TIMESTAMPTZ,
  covered_message_count  INT NOT NULL DEFAULT 0,
  last_run_id            BIGINT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_analysis_coverage
  ON coexistence.chat_analysis_coverage (source, conversation_key, modality);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Runs: conversation-keyed, scope-aware, cost-aware.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE coexistence.chat_analysis_runs
  ADD COLUMN IF NOT EXISTS source               TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS conversation_key     TEXT,
  -- {from,to,keyword} — null for a full run. A run carrying a scope never
  -- advances coverage and never overwrites the rolling verdict.
  ADD COLUMN IF NOT EXISTS scope                JSONB,
  ADD COLUMN IF NOT EXISTS is_scoped            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_incremental       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS modalities           JSONB NOT NULL DEFAULT '["text"]'::jsonb,
  ADD COLUMN IF NOT EXISTS new_messages         INT,
  ADD COLUMN IF NOT EXISTS reused_artifacts     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_artifacts        INT NOT NULL DEFAULT 0,
  -- Split deliberately: the LLM call and the media extraction are billed by
  -- different meters (tokens vs minutes of audio), and the dashboard has to be
  -- able to say which one the money went to.
  ADD COLUMN IF NOT EXISTS llm_cost_micros      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS artifact_cost_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS result               JSONB;

DO $$
BEGIN
  UPDATE coexistence.chat_analysis_runs r
     SET conversation_key = a.conversation_key
    FROM coexistence.chat_analysis a
   WHERE r.conversation_key IS NULL AND r.lead_id = a.lead_id;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- 'group' joins the kinds; 'mcp' joins the triggers. Both CHECKs are replaced
-- rather than added to, so re-running lands on the same definition.
ALTER TABLE coexistence.chat_analysis_runs
  DROP CONSTRAINT IF EXISTS chat_analysis_runs_kind_check;
ALTER TABLE coexistence.chat_analysis_runs
  ADD  CONSTRAINT chat_analysis_runs_kind_check
       CHECK (kind IN ('conversation','group','master'));

ALTER TABLE coexistence.chat_analysis_runs
  DROP CONSTRAINT IF EXISTS chat_analysis_runs_trigger_check;
ALTER TABLE coexistence.chat_analysis_runs
  ADD  CONSTRAINT chat_analysis_runs_trigger_check
       CHECK (trigger IN ('manual','bulk','nightly','mcp'));

ALTER TABLE coexistence.chat_analysis_runs
  DROP CONSTRAINT IF EXISTS chat_analysis_runs_source_check;
ALTER TABLE coexistence.chat_analysis_runs
  ADD  CONSTRAINT chat_analysis_runs_source_check CHECK (source IN ('chat','community'));

CREATE INDEX IF NOT EXISTS idx_car_lead   ON coexistence.chat_analysis_runs(lead_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_car_batch  ON coexistence.chat_analysis_runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_car_errors ON coexistence.chat_analysis_runs(started_at DESC) WHERE status = 'error';
CREATE INDEX IF NOT EXISTS idx_car_conv   ON coexistence.chat_analysis_runs(source, conversation_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_car_when   ON coexistence.chat_analysis_runs(started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Config: modality defaults, caps, and the rate card.
--
--    ⚠ OPENAI RETURNS TOKEN COUNTS, NEVER A PRICE. Unlike the Meta message-cost
--    work (migration 098), which reads a real per-message rate back from
--    pricing_analytics, there is no API here that reports what a call cost. So
--    every rupee figure in this feature is COMPUTED from the rate card below
--    and is an ESTIMATE — which is exactly why the card is editable and why the
--    UI labels it as such. A hardcoded rate would go stale the day OpenAI
--    changes pricing and would then lie silently and forever.
--
--    Rates are USD per 1,000,000 tokens, except whisper which is USD/minute.
--    Defaults are OpenAI list prices as of 2026-08.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE coexistence.chat_analyser_config
  ADD COLUMN IF NOT EXISTS analyse_text       BOOLEAN NOT NULL DEFAULT TRUE,
  -- All three media switches default OFF. They cost money per item, and the
  -- brief was explicit that transcription must not be mandatory.
  ADD COLUMN IF NOT EXISTS analyse_images     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS analyse_audio      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS analyse_documents  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vision_model       TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  ADD COLUMN IF NOT EXISTS transcribe_model   TEXT NOT NULL DEFAULT 'whisper-1',
  -- Per-run media ceilings. NULL is not offered: unlike a usage limit, "no
  -- ceiling" on a paid per-item loop is not a state anyone should be able to
  -- express by leaving a box empty.
  ADD COLUMN IF NOT EXISTS max_media_per_run  INT NOT NULL DEFAULT 25
                                                CHECK (max_media_per_run BETWEEN 0 AND 500),
  ADD COLUMN IF NOT EXISTS max_audio_seconds  INT NOT NULL DEFAULT 300
                                                CHECK (max_audio_seconds BETWEEN 5 AND 3600),
  ADD COLUMN IF NOT EXISTS max_image_bytes    BIGINT NOT NULL DEFAULT 5242880,
  ADD COLUMN IF NOT EXISTS max_document_chars INT NOT NULL DEFAULT 8000
                                                CHECK (max_document_chars BETWEEN 200 AND 100000),
  ADD COLUMN IF NOT EXISTS bulk_max           INT NOT NULL DEFAULT 100
                                                CHECK (bulk_max BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS usd_to_inr         NUMERIC(10,4) NOT NULL DEFAULT 88.0,
  ADD COLUMN IF NOT EXISTS rate_card          JSONB NOT NULL DEFAULT '{
    "text": {
      "gpt-4o-mini":  { "in": 0.15, "out": 0.60 },
      "gpt-4o":       { "in": 2.50, "out": 10.00 },
      "gpt-4.1-mini": { "in": 0.40, "out": 1.60 },
      "default":      { "in": 0.15, "out": 0.60 }
    },
    "audio":  { "whisper-1": { "perMinute": 0.006 }, "default": { "perMinute": 0.006 } },
    "vision": { "gpt-4o-mini": { "in": 0.15, "out": 0.60 }, "default": { "in": 0.15, "out": 0.60 } }
  }'::jsonb;

-- 069 shipped the nightly batch ON. It is re-introduced OFF: this build can now
-- spend money on transcription and vision, so an unattended batch must be a
-- deliberate choice rather than something a deploy switches on for you.
UPDATE coexistence.chat_analyser_config SET nightly_enabled = FALSE WHERE id = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. MCP capability. PROXY_AREAS is default-deny, so without this the routes
--    are unreachable from an MCP client even with the master switch on.
--    COALESCE keeps an admin's existing choices untouched.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE coexistence.mcp_settings
  ALTER COLUMN capabilities SET DEFAULT '{
    "discovery": false, "create_agent": false, "update_agent": false,
    "manage_tools": false, "delete": false,
    "read_messages": false, "send_messages": false,
    "area_contacts": false, "area_messaging": false, "area_broadcasts": false,
    "area_automations": false, "area_admin": false, "area_insights": false,
    "area_leads": false, "area_marketing": false, "area_resources": false,
    "area_courses": false, "area_payments": false, "area_leadforms": false,
    "area_chat_analysis": false
  }'::jsonb;

UPDATE coexistence.mcp_settings
   SET capabilities = capabilities || jsonb_build_object(
         'area_chat_analysis', COALESCE(capabilities->'area_chat_analysis', 'false'::jsonb))
 WHERE id = 1;

COMMENT ON TABLE coexistence.chat_message_artifacts IS
  'Derived text per message per kind (transcript/vision/document). UNIQUE on (source, message_key, kind) so a voice note is transcribed once ever. Never truncate this to "re-run clean" — it is the cost saving.';
COMMENT ON TABLE coexistence.chat_analysis_coverage IS
  'How far each conversation has been analysed, PER MODALITY. A single watermark would silently skip media in messages already covered as text-only.';
