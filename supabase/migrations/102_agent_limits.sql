-- 102: AI agent usage limits + duplicate-run guard.
--
-- Three independent ceilings, each NULL = unlimited, plus a fix for a live
-- defect where one inbound message could produce two replies.
--
-- ⚠ NULL means unlimited, NOT 0. A NOT NULL DEFAULT 0 would read as "this
--   agent may send zero replies" to the enforcement code and would silence
--   every existing agent the moment this shipped. There is no value of 0 that
--   is meaningful here, so NULL carries "off" unambiguously.
--
-- ⚠ Additive only — every column is nullable or has a default, so the
--   pre-102 backend simply ignores them. Safe to apply BEFORE the deploy
--   (anti-pattern #39: only renames/drops must ship with the image).

ALTER TABLE coexistence.agents
  -- How many replies the agent may send inside ONE conversation. A
  -- conversation ends when the chat has been quiet for trigger_session_minutes
  -- (the same session window the router already uses to decide whether a
  -- keyword/new-contact agent stays engaged) — so a lead who comes back
  -- tomorrow gets a fresh budget, and a lead spamming right now does not.
  ADD COLUMN IF NOT EXISTS max_replies_per_conversation INT,

  -- Flood guard. A total cap does NOT cover this: 15 messages in 20 seconds
  -- are all inside a budget of 20, and each one is its own LLM call and its
  -- own reply. Throttled messages are still written to chat_history, so the
  -- model sees them as context on the next reply — nothing is lost, they just
  -- do not each earn a dedicated answer.
  ADD COLUMN IF NOT EXISTS max_replies_per_minute INT,

  -- Systemic backstop, counted per agent per IST day. The scenario this
  -- exists for is a broadcast: message 500 people, 300 reply within ten
  -- minutes, the agent runs 300+ times. Every one of those conversations is
  -- individually normal, so the per-conversation cap cannot see it.
  ADD COLUMN IF NOT EXISTS max_runs_per_day INT,

  -- Sent once when a conversation hits its reply cap. Empty/NULL sends
  -- nothing. Going silent mid-conversation is indistinguishable from the
  -- business ignoring the customer, which is why this defaults to a sentence.
  ADD COLUMN IF NOT EXISTS limit_reached_message TEXT,

  -- On hitting the cap, hand the conversation to a human via the agent's
  -- existing round-robin pool (agents.handoff_user_ids). TRUE by default: a
  -- lead who asked 20 questions is usually interested, so the cap is better
  -- as a routing rule than as a dead end.
  ADD COLUMN IF NOT EXISTS limit_handoff BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN coexistence.agents.max_replies_per_conversation IS
  'NULL = unlimited. Replies allowed per conversation; resets after trigger_session_minutes of quiet.';
COMMENT ON COLUMN coexistence.agents.max_replies_per_minute IS
  'NULL = unlimited. Flood guard. Throttled messages stay in chat_history and reach the model as context.';
COMMENT ON COLUMN coexistence.agents.max_runs_per_day IS
  'NULL = unlimited. Per-agent runs per IST day across all conversations.';

-- A blocked message is recorded as a run row with status='limited' so the
-- operator can SEE why the agent went quiet, rather than reading a flatline in
-- the run history and having to guess. These rows carry no tokens and no cost;
-- they are excluded from the daily-run count for exactly that reason.
ALTER TABLE coexistence.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE coexistence.agent_runs ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running','completed','failed','capped','limited'));

-- ── Duplicate-run guard (a live defect, independent of the limits above) ────
--
-- webhook.js builds incomingRecords from the PARSED payload, not from rows
-- that were newly inserted, and routeIfActive() has no dedupe. So a Meta
-- re-delivery — or the Webhook History replay button — runs the agent again on
-- a message it already answered and sends the customer a SECOND reply.
--
-- The guard is an index rather than an `if` because two concurrent webhook
-- deliveries would both pass a SELECT-then-INSERT check (anti-pattern #33: put
-- the guard where a refactor cannot move it).
DO $$
DECLARE dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT agent_id, inbound_message_id
      FROM coexistence.agent_runs
     WHERE inbound_message_id IS NOT NULL
     GROUP BY 1,2 HAVING COUNT(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE EXCEPTION
      'Cannot add uq_agent_runs_inbound: % (agent_id, inbound_message_id) pair(s) already duplicated. '
      'Each is a message the agent answered twice. Review them, then keep the earliest of each with: '
      'DELETE FROM coexistence.agent_runs a USING coexistence.agent_runs b '
      'WHERE a.agent_id = b.agent_id AND a.inbound_message_id = b.inbound_message_id '
      'AND a.inbound_message_id IS NOT NULL AND a.id > b.id;', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_inbound
  ON coexistence.agent_runs (agent_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;
