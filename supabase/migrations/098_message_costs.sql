-- 098_message_costs.sql
--
-- MESSAGE COSTS — what we owe Meta, per template and per message type.
-- Purely ADDITIVE (nothing is renamed or dropped), so it is safe to apply
-- BEFORE the backend ships: the running image simply ignores the new tables
-- and columns.
--
-- Meta sends a `pricing` object on EVERY status webhook (billable, category,
-- pricing_type) and this app threw it away: status records deliberately never
-- become chat rows, so the object survived only inside the webhook_events
-- audit blob. message_billing_events is its permanent home.
--
-- The money amount is NOT in that webhook. It comes from the WABA's
-- `pricing_analytics` field, cached in waba_pricing_daily, from which the
-- per-message unit rate is DERIVED (cost / volume) rather than restated in a
-- hand-maintained rate card. That matters: measured on a real account, India
-- utility billed at 0.1150 while Germany utility billed at 4.0322 for the
-- same category — a single hardcoded rate would under-report by ~97%.


-- Exact template attribution, stamped at SEND time.
--
-- Reverse-engineering "which template was this?" afterwards does not work:
-- chat_history.template_meta is written by seven different call sites with
-- inconsistent shapes (some carry `name`, the automation-engine carousel path
-- carries only header/footer/buttons), so a name lookup silently misses. One
-- column written by the single shared insertPendingRow() cannot drift.
ALTER TABLE coexistence.chat_history
  ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;
-- Which subsystem sent it (broadcast / automation / follow_up / agent / manual /
-- mcp / payment). Needed for "how many runs" to be attributable to a surface.
ALTER TABLE coexistence.chat_history
  ADD COLUMN IF NOT EXISTS send_origin TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_history_template
  ON coexistence.chat_history(template_id) WHERE template_id IS NOT NULL;

-- One row per message Meta reported a price for. PK is the wamid, which is what
-- makes this idempotent: Meta sends sent/delivered/read for the same message
-- (and redelivers each), so an append-only log would triple-count. Measured on
-- this account: 165 'delivered' receipts covering 149 distinct messages.
--
-- The billing trigger is DELIVERY, not send — Meta charges when a template
-- message is delivered — so `billed` is set from the delivered receipt.
CREATE TABLE IF NOT EXISTS coexistence.message_billing_events (
  message_id        TEXT PRIMARY KEY,
  waba_id           TEXT,
  phone_number_id   TEXT,
  wa_number         TEXT,
  recipient_number  TEXT,
  -- marketing | utility | authentication | service | referral_conversion
  category          TEXT,
  -- regular | free_customer_service | free_entry_point | free_referral_conversion
  pricing_type      TEXT,
  pricing_model     TEXT,
  billable          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Calling code digits taken from the recipient number ('91'), and the ISO2 it
  -- maps to ('IN'). NULL country is expected and handled: the rate lookup then
  -- falls back to the day's blended rate for that category rather than guessing.
  recipient_cc      TEXT,
  country_code      TEXT,
  -- The message as we sent it, for the message-type breakdown.
  message_kind      TEXT,
  template_id       BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
  -- Snapshot: a deleted template must not erase its own historical cost.
  template_name     TEXT,
  send_origin       TEXT,
  -- Highest delivery status seen. 'delivered' or beyond means Meta billed it.
  status            TEXT,
  delivered_at      TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  day               DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_day
  ON coexistence.message_billing_events(day DESC);
CREATE INDEX IF NOT EXISTS idx_billing_template
  ON coexistence.message_billing_events(template_id, day DESC) WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_billable
  ON coexistence.message_billing_events(day DESC, category) WHERE billable;
CREATE INDEX IF NOT EXISTS idx_billing_waba
  ON coexistence.message_billing_events(waba_id, day DESC);

-- Meta's AUTHORITATIVE cost, straight from the WABA's pricing_analytics field.
-- This is the number the invoice is built from; everything per-template is our
-- own attribution multiplied by a rate derived from here.
--
-- tier is NOT NULL DEFAULT '' rather than nullable so it can sit in the primary
-- key — Meta only populates it for volume-tier-affected buckets.
CREATE TABLE IF NOT EXISTS coexistence.waba_pricing_daily (
  waba_id           TEXT NOT NULL,
  day               DATE NOT NULL,
  country           TEXT NOT NULL DEFAULT '',
  pricing_category  TEXT NOT NULL DEFAULT '',
  pricing_type      TEXT NOT NULL DEFAULT '',
  tier              TEXT NOT NULL DEFAULT '',
  volume            BIGINT NOT NULL DEFAULT 0,
  cost              NUMERIC(16,6) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'INR',
  last_fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (waba_id, day, country, pricing_category, pricing_type, tier)
);

CREATE INDEX IF NOT EXISTS idx_waba_pricing_day
  ON coexistence.waba_pricing_daily(day DESC);

-- Per-WABA sync state. Its whole purpose is to record UNREADABLE accounts
-- honestly: on this instance the stored token returns "Application does not
-- have permission for this action" for one of the three WABAs. Reporting that
-- account's spend as Rs 0 would be a lie the dashboard tells every day.
CREATE TABLE IF NOT EXISTS coexistence.waba_pricing_sync (
  waba_id         TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('unknown','ok','unauthorized','error')),
  last_error      TEXT,
  last_synced_at  TIMESTAMPTZ,
  currency        TEXT NOT NULL DEFAULT 'INR',
  -- ⚠ EVERY phone number Meta has on this WABA, whether or not it is connected
  -- to this app. This is what explains the gap between Meta's total and our
  -- per-template attribution: pricing_analytics bills per WABA, while we can
  -- only attribute messages we actually saw a receipt for.
  --
  -- Measured on a real account: a WABA carrying THREE numbers with only one
  -- connected here accounted for the entire message-count difference. Without
  -- this column that discrepancy looks like a bug in the cost engine, and
  -- someone would "fix" a correct number.
  phone_numbers   JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FALLBACK ONLY — never the primary source.
--
-- Used for messages Meta has not yet reported a cost for (today's traffic, and
-- the gap before the next daily sync), so a fresh send is not silently costed
-- at zero. Editable in Admin Settings.
--
-- Seeded with Meta's published INDIA rates as of Jul 2026 purely as a worked
-- example (marketing 0.8631, utility 0.1150 — confirmed exactly against real
-- pricing_analytics data). This is NOT a rate card the app depends on: real
-- per-message rates are always DERIVED from Meta (cost/volume, see
-- util/costSql.js), and a country with no row here falls through to the day's
-- blended rate rather than reading zero. Add or edit rows for your own
-- countries in Admin Settings; the currency column is per-row, not global.
CREATE TABLE IF NOT EXISTS coexistence.whatsapp_rate_fallback (
  id          SERIAL PRIMARY KEY,
  country     TEXT NOT NULL,
  category    TEXT NOT NULL,
  rate        NUMERIC(10,4) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'INR',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  CONSTRAINT uq_rate_fallback UNIQUE (country, category)
);

INSERT INTO coexistence.whatsapp_rate_fallback (country, category, rate, currency) VALUES
  ('IN', 'marketing',           0.8631, 'INR'),
  ('IN', 'utility',             0.1150, 'INR'),
  ('IN', 'authentication',      0.1150, 'INR'),
  ('IN', 'service',             0.0000, 'INR'),
  ('IN', 'referral_conversion', 0.0000, 'INR')
ON CONFLICT (country, category) DO NOTHING;

-- Singleton config for the cost tracker.
CREATE TABLE IF NOT EXISTS coexistence.message_cost_config (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  currency            TEXT NOT NULL DEFAULT 'INR',
  -- India bills 18% GST on top of Meta's rates. Displayed as a separate line
  -- rather than folded into the per-message cost, so our figures stay directly
  -- comparable with what pricing_analytics reports (which is pre-tax).
  tax_percent         NUMERIC(6,3) NOT NULL DEFAULT 18.0,
  show_tax            BOOLEAN NOT NULL DEFAULT TRUE,
  last_pricing_sync_at TIMESTAMPTZ,
  backfilled_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.message_cost_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE coexistence.message_billing_events IS
  'One row per priced message, keyed by wamid. Source: the pricing object on Meta status webhooks, which carries category/billable but no amount. Amounts come from waba_pricing_daily.';
COMMENT ON TABLE coexistence.waba_pricing_daily IS
  'Meta pricing_analytics cache. Authoritative for money owed; per-message unit rates are derived from cost/volume here, never hardcoded.';
