-- 067_lead_form_broadcast_link.sql
-- Stage 2 of Lead Forms: lets a broadcast carry per-recipient form links. When
-- a broadcast is linked to a lead form, the send path (routes/broadcasts.js)
-- mints a coexistence.lead_form_send_tokens row per recipient and fills it
-- into the template's dynamic URL button, so tapping the link silently
-- identifies the recipient (no phone number asked on the form).

ALTER TABLE coexistence.broadcasts
  ADD COLUMN IF NOT EXISTS lead_form_id BIGINT REFERENCES coexistence.lead_forms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_lead_form ON coexistence.broadcasts(lead_form_id) WHERE lead_form_id IS NOT NULL;
