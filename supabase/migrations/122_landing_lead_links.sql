-- 122_landing_lead_links.sql
--
-- Landing-page visitor → the WhatsApp conversation they start.
--
-- An ads landing page keeps the details a visitor fills
-- in its OWN lead service. When that visitor then messages on WhatsApp, a
-- keyword automation with `landingSource` set looks their stored record up by
-- phone (services/landingLeads.js), copies the details onto the lead, reads
-- them back as the first message, and runs alone for that message.
--
-- One row per visitor welcomed. It is:
--   - the once-per-visitor guard (UNIQUE source + landing_lead_id) — a second tap
--     of the WhatsApp button must not resend a 15-minute video, and Meta's
--     webhook retries must not either; an index, not a SELECT-then-INSERT,
--     because two deliveries of one message would both pass a check;
--   - the audit trail of which conversation each landing visitor became.
--
-- Additive and idempotent. Mirrored at boot by landingLeads.ensureLandingTables().

CREATE TABLE IF NOT EXISTS coexistence.landing_lead_links (
  id               BIGSERIAL PRIMARY KEY,
  source           TEXT NOT NULL,          -- LANDING_SOURCES key, e.g. 'claude-landing'
  landing_lead_id  TEXT NOT NULL,          -- the landing page's own visitor id
  lead_id          BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  wa_number        TEXT,                   -- business number the message arrived on
  contact_number   TEXT,
  message_id       TEXT,                   -- the inbound message that started it
  automation_id    BIGINT,                 -- FK-less: the audit row outlives the flow
  matched_by       TEXT,                   -- 'sender_phone' | 'typed_phone'
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_landing_lead_links_visitor
  ON coexistence.landing_lead_links (source, landing_lead_id);

-- The same person filling the page from two browsers has two landing ids;
-- the 24-hour same-contact check reads this index.
CREATE INDEX IF NOT EXISTS idx_landing_lead_links_contact
  ON coexistence.landing_lead_links (source, contact_number, created_at DESC);

COMMENT ON TABLE coexistence.landing_lead_links IS
  'Landing-page visitors matched to the WhatsApp conversation they started (services/landingLeads.js). One row per visitor welcomed; UNIQUE(source, landing_lead_id) stops a second welcome.';
