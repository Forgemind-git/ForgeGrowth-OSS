-- 095_follow_up_sequences.sql — Follow-up Sequences (Chats → Follow-ups)
--
-- Timed follow-up message sequences for leads. A lead is enrolled automatically
-- when it ENTERS a sequence's trigger funnel stage (observed via the
-- lead_events cursor — never hooks in the stage write paths), or manually from
-- the UI. Each step waits delay_minutes after the previous one, then sends an
-- approved template (from the template's own WhatsApp account) or free text
-- (on the lead's existing thread, only while the 24h window is open).
--
-- Additive only — safe to apply before or after the backend that uses it.
-- Idempotent; re-runnable.

-- One sequence = a named, activatable chain of steps.
CREATE TABLE IF NOT EXISTS coexistence.follow_up_sequences (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  -- Default OFF: a sequence sends real WhatsApp messages; activation is explicit.
  active                BOOLEAN NOT NULL DEFAULT FALSE,
  -- Stage whose ENTRY auto-enrolls a lead. NULL = manual-only sequence.
  -- Keyed on the immutable funnel_stages.stage_key, never the editable label.
  trigger_stage_key     TEXT,
  -- Stop rules, evaluated when each step comes due.
  stop_on_reply         BOOLEAN NOT NULL DEFAULT TRUE,
  stop_on_stage_change  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ordered steps. delay_minutes counts from the PREVIOUS step's due time
-- (or from enrollment for the first step).
CREATE TABLE IF NOT EXISTS coexistence.follow_up_steps (
  id                 BIGSERIAL PRIMARY KEY,
  sequence_id        BIGINT NOT NULL REFERENCES coexistence.follow_up_sequences(id) ON DELETE CASCADE,
  step_order         INT NOT NULL DEFAULT 0,
  delay_minutes      INT NOT NULL DEFAULT 1440 CHECK (delay_minutes >= 1),
  message_kind       TEXT NOT NULL DEFAULT 'template' CHECK (message_kind IN ('template', 'text')),
  -- INTEGER (not BIGINT): message_templates.id is integer; FK types must match.
  template_id        INTEGER REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
  template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  body               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_follow_up_steps_seq
  ON coexistence.follow_up_steps (sequence_id, step_order);

-- One row per (sequence, lead) run. next_send_at drives the due processor.
CREATE TABLE IF NOT EXISTS coexistence.follow_up_enrollments (
  id                       BIGSERIAL PRIMARY KEY,
  sequence_id              BIGINT NOT NULL REFERENCES coexistence.follow_up_sequences(id) ON DELETE CASCADE,
  lead_id                  BIGINT NOT NULL REFERENCES coexistence.leads(id) ON DELETE CASCADE,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'completed', 'replied', 'stage_changed', 'stopped')),
  stage_key_at_enrollment  TEXT,
  next_step_order          INT NOT NULL DEFAULT 0,
  next_send_at             TIMESTAMPTZ,
  fail_count               INT NOT NULL DEFAULT 0,
  enrolled_by              TEXT NOT NULL DEFAULT 'auto:stage',
  enrolled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at             TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  stop_reason              TEXT
);
-- At most one LIVE run of a sequence per lead. (History rows are kept —
-- auto-enrollment additionally refuses any lead with a prior row, so a lead
-- bouncing back into a stage is never chased twice automatically; manual
-- re-enrollment remains possible.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_enroll_active
  ON coexistence.follow_up_enrollments (sequence_id, lead_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_follow_up_enroll_due
  ON coexistence.follow_up_enrollments (next_send_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_follow_up_enroll_lead
  ON coexistence.follow_up_enrollments (lead_id);

-- Append-only outcome log: every attempted step lands here — sent, or skipped/
-- failed WITH ITS REASON, plus a row for each stop. This is the page's history.
CREATE TABLE IF NOT EXISTS coexistence.follow_up_log (
  id               BIGSERIAL PRIMARY KEY,
  enrollment_id    BIGINT NOT NULL REFERENCES coexistence.follow_up_enrollments(id) ON DELETE CASCADE,
  sequence_id      BIGINT NOT NULL,
  lead_id          BIGINT NOT NULL,
  step_id          BIGINT,
  step_order       INT,
  status           TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed', 'stopped')),
  reason           TEXT,
  local_message_id TEXT,
  ts               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_follow_up_log_seq ON coexistence.follow_up_log (sequence_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_follow_up_log_enroll ON coexistence.follow_up_log (enrollment_id);

-- Enrollment cursor over lead_events (own singleton — cursors are never shared
-- between features). Seeded at the CURRENT max event id so switching the
-- feature on can never replay months of historical stage changes into
-- mass enrollment: only stage entries AFTER this point enroll anyone.
CREATE TABLE IF NOT EXISTS coexistence.follow_up_state (
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_event_id BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO coexistence.follow_up_state (id, last_event_id)
SELECT 1, COALESCE((SELECT MAX(id) FROM coexistence.lead_events), 0)
ON CONFLICT (id) DO NOTHING;
