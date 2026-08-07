-- 091_chat_payments.sql
-- Payments inside the Chats section: a Payment node in the Automation builder
-- and payment tools for AI Agents.
--
-- Additive + idempotent. Every new capability defaults OFF, so applying this
-- ahead of the code changes nothing for the running app.
--
-- THREE THINGS THIS ADDS, AND WHY EACH ONE IS LOAD-BEARING
--
-- 1. payment_requests learns which CHAT it came from.
--    The table already resolves WHO paid (lead_id, plus forge_lead_id stamped
--    into Razorpay notes). It does not know WHICH THREAD to answer on. On a
--    multi-WABA instance "reply to the payer" is unanswerable without the
--    business number, and a lead's digits are not guaranteed to equal any
--    contacts.contact_number (the Sales Log already had to learn this).
--
-- 2. automation_executions learns WHAT its pause is waiting for.
--    webhook.js resumes *every* paused execution on the contact's next inbound
--    message. Without a kind, a customer typing "ok" while a payment link is
--    outstanding would consume the payment wait AND — because that path
--    `continue`s past fresh trigger evaluation — get no reply at all.
--
-- 3. payment_watches is the single queue both features run on.
--    Kept separate from payment_requests on purpose: that table mirrors the
--    GATEWAY (what Razorpay says), this one holds FLOW state (who is waiting,
--    when to chase, when to give up). One row can be watched by an automation
--    execution and an agent independently.

-- ── 1. payment_requests: the chat thread + where the request came from ───────
ALTER TABLE coexistence.payment_requests
  ADD COLUMN IF NOT EXISTS wa_number      TEXT,
  ADD COLUMN IF NOT EXISTS contact_number TEXT,
  ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS automation_id  BIGINT,
  ADD COLUMN IF NOT EXISTS execution_id   BIGINT,
  ADD COLUMN IF NOT EXISTS node_id        TEXT,
  ADD COLUMN IF NOT EXISTS agent_id       BIGINT;

COMMENT ON COLUMN coexistence.payment_requests.source IS
  'manual | automation | agent | form — who raised this link.';

-- ⚠ MONEY SAFETY. createPaymentLink is deliberately never retried, but nothing
-- stopped the same automation node running twice (a re-trigger, a resumed walk,
-- two webhook deliveries) and minting a SECOND live link the customer could
-- also pay. This index makes that impossible at the database, not in a code
-- path someone can later restructure around.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_exec_node
  ON coexistence.payment_requests(execution_id, node_id)
  WHERE execution_id IS NOT NULL AND node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_requests_thread
  ON coexistence.payment_requests(wa_number, contact_number);
CREATE INDEX IF NOT EXISTS idx_payment_requests_agent
  ON coexistence.payment_requests(agent_id) WHERE agent_id IS NOT NULL;

-- Backfill the thread for links already raised from Sales → Payments, so the
-- Payments page can deep-link into the chat for historical rows too. Matches on
-- the last 10 digits (the same person is stored with and without a country code
-- across the two tables) and takes the most recently touched thread.
-- A correlated subquery, NOT `FROM LATERAL (...)`: in UPDATE ... FROM, the
-- target table is not visible to a LATERAL item, so referencing pr.customer_phone
-- inside it fails with "invalid reference to FROM-clause entry".
UPDATE coexistence.payment_requests pr
   SET wa_number = (
         SELECT ct.wa_number FROM coexistence.contacts ct
          WHERE right(regexp_replace(ct.contact_number, '\D', '', 'g'), 10)
              = right(regexp_replace(pr.customer_phone, '\D', '', 'g'), 10)
          ORDER BY ct.updated_at DESC NULLS LAST LIMIT 1),
       contact_number = (
         SELECT ct.contact_number FROM coexistence.contacts ct
          WHERE right(regexp_replace(ct.contact_number, '\D', '', 'g'), 10)
              = right(regexp_replace(pr.customer_phone, '\D', '', 'g'), 10)
          ORDER BY ct.updated_at DESC NULLS LAST LIMIT 1)
 WHERE pr.wa_number IS NULL
   AND length(regexp_replace(COALESCE(pr.customer_phone, ''), '\D', '', 'g')) >= 10
   AND EXISTS (
         SELECT 1 FROM coexistence.contacts ct
          WHERE right(regexp_replace(ct.contact_number, '\D', '', 'g'), 10)
              = right(regexp_replace(pr.customer_phone, '\D', '', 'g'), 10));

-- ── 2. automation_executions: distinguish a reply-wait from a payment-wait ───
ALTER TABLE coexistence.automation_executions
  ADD COLUMN IF NOT EXISTS awaiting_kind TEXT NOT NULL DEFAULT 'reply';

COMMENT ON COLUMN coexistence.automation_executions.awaiting_kind IS
  'reply = resumed by the customer''s next inbound message (webhook.js). '
  'payment = resumed ONLY by the payment sweeper. The inbound-message resume '
  'path must filter on this or it will steal a payment wait.';

CREATE INDEX IF NOT EXISTS idx_executions_awaiting
  ON coexistence.automation_executions(wa_number, contact_number, awaiting_kind)
  WHERE status = 'paused';

-- ── 3. payment_watches: the one queue driving paid / chase / give-up ─────────
CREATE TABLE IF NOT EXISTS coexistence.payment_watches (
  id                  BIGSERIAL PRIMARY KEY,
  payment_request_id  BIGINT NOT NULL
                        REFERENCES coexistence.payment_requests(id) ON DELETE CASCADE,

  -- Who is waiting. 'automation' resumes a paused execution down a branch;
  -- 'agent' just messages the customer.
  watcher_kind        TEXT   NOT NULL,
  execution_id        BIGINT,
  node_id             TEXT,
  agent_id            BIGINT,

  -- The thread to answer on. Stored here rather than re-derived at fire time:
  -- a contact can be renumbered (contacts/change-number) and we must still
  -- reply where the conversation actually happened.
  wa_number           TEXT   NOT NULL,
  contact_number      TEXT   NOT NULL,

  status              TEXT   NOT NULL DEFAULT 'watching',

  -- Chase configuration. follow_up_at is the NEXT due time and is pushed
  -- forward after each send, so one column drives repeat reminders.
  follow_up_at        TIMESTAMPTZ,
  follow_up_every_min INT,
  follow_up_count     INT    NOT NULL DEFAULT 0,
  follow_up_max       INT    NOT NULL DEFAULT 1,
  follow_up_text      TEXT,
  last_follow_up_at   TIMESTAMPTZ,

  -- What to say when it lands, and when to stop waiting.
  confirm_text        TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,
  resolved_at         TIMESTAMPTZ,
  last_error          TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_watches_kind_check') THEN
    ALTER TABLE coexistence.payment_watches
      ADD CONSTRAINT payment_watches_kind_check
      CHECK (watcher_kind IN ('automation', 'agent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_watches_status_check') THEN
    ALTER TABLE coexistence.payment_watches
      ADD CONSTRAINT payment_watches_status_check
      CHECK (status IN ('watching', 'paid', 'timeout', 'cancelled', 'error'));
  END IF;
END $$;

-- A payment request is watched at most once per waiter. Without this a retried
-- tool call or a re-entered node would double-chase the same customer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_watches_exec
  ON coexistence.payment_watches(payment_request_id, execution_id, node_id)
  WHERE execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_watches_agent
  ON coexistence.payment_watches(payment_request_id, agent_id)
  WHERE agent_id IS NOT NULL AND execution_id IS NULL;

-- The sweeper's own access path: only ever scans rows still being watched.
CREATE INDEX IF NOT EXISTS idx_payment_watches_open
  ON coexistence.payment_watches(status, follow_up_at, expires_at)
  WHERE status = 'watching';
CREATE INDEX IF NOT EXISTS idx_payment_watches_request
  ON coexistence.payment_watches(payment_request_id);

-- ── 4. Agents: opt in to payments, with the amount authority spelled out ─────
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_config   JSONB   NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN coexistence.agents.payment_config IS
  'Amount authority + chase settings for the agent payment tools. Keys: '
  'allowCustomAmount (bool, default false — products only), minAmountPaise, '
  'maxAmountPaise, productIds (int[], empty = every product), followUpEnabled, '
  'followUpMinutes, followUpMax, followUpText, confirmText, expiryHours. '
  'An LLM must never be able to name its own price without a cap — see '
  'validatePaymentConfig() in services/agentService.js.';
