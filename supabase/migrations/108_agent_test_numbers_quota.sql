-- 108: agent test numbers + a per-person usage quota over a rolling window.
--
-- Two independent additions to coexistence.agents, plus one column on
-- agent_runs. Every column is nullable or carries a default, so the pre-108
-- backend ignores all of them — additive, safe to apply before OR after the
-- deploy (anti-pattern #39 only inverts for renames and drops).
--
-- ── 1. Test numbers ─────────────────────────────────────────────────────────
--
-- A phone number you can use to exercise the agent on real WhatsApp before it
-- answers anybody else. A test number:
--   * reaches the agent even while it is still a DRAFT (is_active = FALSE), so
--     you can try it end to end without putting it in front of customers;
--   * is exempt from every usage limit, so you can test it over and over —
--     which is the whole point, and is why "just add yourself as a lead" is
--     not the same thing;
--   * has its runs stamped is_test, so test traffic never reads as customer
--     traffic in the run history or in any count a limit is measured against.
--
-- Triggers and funnel gating still apply to a test number. Those are what you
-- are testing; exempting them would prove the agent works in a mode it will
-- never run in.
--
-- ⚠ Stored as a JSONB array of {number, label}. `number` is digits-only and is
--   matched on its LAST 10 DIGITS, exactly like every other phone join in this
--   codebase (the same person is 9876543210 here and 919876543210 there).
--
-- ── 2. Per-person quota over a rolling window ───────────────────────────────
--
-- max_replies_per_conversation (migration 102) already caps one SITTING: it
-- counts runs since the last silence of trigger_session_minutes. It cannot
-- answer "how often may this person come back?", because the moment they go
-- quiet their budget refills. So someone can take 20 replies now, wait half an
-- hour, and take 20 more, all day.
--
-- These two are the other question — an allowance per person that refills on a
-- CLOCK you choose, not on a silence:
--   quota_replies       — replies to one person within the window.
--   quota_conversations — separate conversations one person may start within
--                         the window (a conversation being a run opening after
--                         a silence of trigger_session_minutes).
--
-- ⚠ NULL = unlimited, never 0 (see 102). The window columns are NOT NULL with
--   a default because a window on its own does nothing — it only has meaning
--   once one of the two quota numbers above is set.
--
-- ⚠ The window is stored as value + unit and converted to minutes in ONE place
--   (agentLimits.windowMinutes). Storing a derived minutes column alongside it
--   would be a restated fact that can go stale (anti-pattern #22), and storing
--   only minutes would lose "1 day" vs "1440 minutes" in the UI.

ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS test_numbers          JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quota_replies         INT,
  ADD COLUMN IF NOT EXISTS quota_conversations   INT,
  ADD COLUMN IF NOT EXISTS quota_window_value    INT  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quota_window_unit     TEXT NOT NULL DEFAULT 'days',
  -- Hand the conversation to a human when the quota runs out. FALSE by
  -- default, unlike limit_handoff: someone who has used their allowance for
  -- today is being asked to come back, not escalated — defaulting this to TRUE
  -- would push every rate-limited person into Chats.
  ADD COLUMN IF NOT EXISTS quota_handoff         BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE coexistence.agents DROP CONSTRAINT IF EXISTS agents_quota_window_unit_check;
ALTER TABLE coexistence.agents ADD CONSTRAINT agents_quota_window_unit_check
  CHECK (quota_window_unit IN ('minutes','hours','days'));

COMMENT ON COLUMN coexistence.agents.test_numbers IS
  'JSONB [{number,label}]. Reaches the agent even as a draft, exempt from all usage limits, runs stamped is_test. Matched on the last 10 digits.';
COMMENT ON COLUMN coexistence.agents.quota_replies IS
  'NULL = unlimited. Replies to ONE person within quota_window_*. Refills on a clock, unlike max_replies_per_conversation which refills on silence.';
COMMENT ON COLUMN coexistence.agents.quota_conversations IS
  'NULL = unlimited. Separate conversations one person may start within quota_window_*.';

-- A test run must be invisible to every count a limit is measured against, and
-- distinguishable in the run history — otherwise a morning of testing eats the
-- day's budget and then reads as real customer activity.
ALTER TABLE coexistence.agent_runs
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN coexistence.agent_runs.is_test IS
  'TRUE when the inbound came from one of the agent''s test_numbers. Excluded from every usage-limit count.';

-- The quota queries scan one contact's recent runs for one agent; the window
-- is capped at 30 days in code, so this covers every lookup they can make.
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_contact_started
  ON coexistence.agent_runs (agent_id, contact_number, started_at DESC);
