-- ─── Migration 061: Razorpay webhook integration ─────────────────────────────
-- Receives + verifies Razorpay payment/refund webhooks and links captured
-- payments to CRM leads/contacts. Mirrors ensureRazorpayTables() in
-- backend/src/routes/razorpay.js (runtime source of truth). Idempotent.

-- Singleton config: the AES-encrypted webhook secret + optional key id + status.
CREATE TABLE IF NOT EXISTS coexistence.razorpay_config (
  id                       INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  webhook_secret_encrypted TEXT,
  key_id                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'disconnected'
                             CHECK (status IN ('connected','disconnected','error')),
  last_event_at            TIMESTAMPTZ,
  last_error               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coexistence.razorpay_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Append-only event log. `razorpay_event_id` (x-razorpay-event-id header) is the
-- idempotency key so retried deliveries don't double-process.
CREATE TABLE IF NOT EXISTS coexistence.razorpay_events (
  id                     BIGSERIAL PRIMARY KEY,
  received_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  razorpay_event_id      TEXT UNIQUE,
  event_type             TEXT,
  entity_type            TEXT,               -- payment | refund
  payment_id             TEXT,
  order_id               TEXT,
  refund_id              TEXT,
  amount_paise           BIGINT,
  currency               TEXT,
  status                 TEXT,               -- captured | failed | refunded | processed …
  payer_email            TEXT,
  payer_contact          TEXT,               -- digits-only
  method                 TEXT,               -- upi | card | netbanking …
  notes                  JSONB,
  signature_valid        BOOLEAN NOT NULL DEFAULT FALSE,
  match_method           TEXT,               -- phone | email | null
  matched_lead_id        BIGINT,
  matched_lead_name      TEXT,
  matched_contact_number TEXT,
  matched_contact_name   TEXT,
  remote_ip              TEXT,
  payload                JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rzp_events_received ON coexistence.razorpay_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_rzp_events_payment  ON coexistence.razorpay_events(payment_id);
