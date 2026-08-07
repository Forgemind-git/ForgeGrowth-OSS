-- 092_payment_templates.sql
-- Payment-link TEMPLATES: send a payment link outside WhatsApp's 24-hour window.
--
-- WHY THIS EXISTS
-- Migration 091 shipped payment links delivered as free-form text. WhatsApp
-- refuses free-form text more than 24h after the customer's last message, so a
-- customer who goes quiet for a day could not be sent a link at all. Only an
-- approved template can reach them. This adds the piece that makes that work.
--
-- ⚠ THE BUTTON URL MUST BE OURS, NOT RAZORPAY'S.
-- Meta bakes a URL button's base into the template at APPROVAL time. Pointing it
-- at Razorpay's short-link domain would mean that the day Razorpay changes its
-- short-link format (this account issues https://rzp.io/rzp/… today; older
-- accounts issue https://rzp.io/i/…), every approved template breaks and needs
-- days of re-approval. A base we own — https://<host>/pay/{{1}} — never changes,
-- and the token resolves to whatever the gateway is issuing right now.
--
-- This mirrors the Lead Forms mechanism exactly (`/f/{{1}}` + mintSendToken),
-- which is already proven in production here.

-- ── The token behind /pay/<token> ───────────────────────────────────────────
-- One per payment request, so the redirect is a single indexed lookup and a
-- token can never be ambiguous about which link it opens.
ALTER TABLE coexistence.payment_requests
  ADD COLUMN IF NOT EXISTS public_token     TEXT,
  ADD COLUMN IF NOT EXISTS click_count      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_clicked_at  TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_public_token
  ON coexistence.payment_requests(public_token)
  WHERE public_token IS NOT NULL;

COMMENT ON COLUMN coexistence.payment_requests.public_token IS
  'Opaque token behind the public /pay/<token> redirect. It is the {{n}} value '
  'of a payment template''s URL button. Deliberately NOT the razorpay_link_id: '
  'that would put a gateway identifier in a customer-visible URL and tie an '
  'approved Meta template to Razorpay''s short-link format.';

-- Backfill tokens for links already raised, so an existing request can be
-- re-sent through a template.
--
-- gen_random_uuid() is BUILT INTO Postgres 13+ and needs no extension.
-- gen_random_bytes() would have been the obvious choice but it lives in
-- pgcrypto, which is NOT installed on this instance — verified the hard way.
-- Runtime tokens come from Node's crypto.randomBytes; this is backfill only.
UPDATE coexistence.payment_requests
   SET public_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 18)
 WHERE public_token IS NULL;

-- ── The watch remembers which template to fall back to ─────────────────────
-- A reminder fired 10 minutes later is usually inside the 24h window; one fired
-- after a long wait is not. Stored ON THE WATCH rather than re-derived at sweep
-- time, because the automation node's config is not reachable from there — and
-- because the template that was correct when the link went out is the one that
-- should chase it, even if the node has since been edited.
ALTER TABLE coexistence.payment_watches
  ADD COLUMN IF NOT EXISTS template_id BIGINT
    REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;

-- ── Broadcasts: a payment blast needs to know WHAT it is charging for ───────
-- The template is a reusable shell (it carries the button, not the price), so
-- the amount comes from whatever sends it — here, the broadcast row.
ALTER TABLE coexistence.broadcasts
  ADD COLUMN IF NOT EXISTS payment_course_id   BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_amount_paise BIGINT,
  ADD COLUMN IF NOT EXISTS payment_purpose      TEXT;

COMMENT ON COLUMN coexistence.broadcasts.payment_amount_paise IS
  'Set only when the chosen template carries a payment button. Every recipient '
  'gets their OWN live payment link for this amount at dispatch time, which is '
  'why the send screen states the total exposure and requires typed confirmation.';

-- ── Agent + automation template binding ────────────────────────────────────
-- Which template to fall back to when the 24h window is shut. Nullable: an
-- agent with no template simply reports that it could not reach the customer,
-- which is the honest outcome rather than a silent failure.
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS payment_template_id BIGINT
    REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_requests_token_lookup
  ON coexistence.payment_requests(public_token) WHERE public_token IS NOT NULL;
