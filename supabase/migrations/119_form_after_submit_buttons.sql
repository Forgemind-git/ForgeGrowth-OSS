-- Reply buttons (and a picture) on the after-submit message.
--
-- A reply button is not a link button: tapping it arrives as an ordinary
-- inbound, which is what lets a paused automation carry on from there. That is
-- the whole point — a link button ends the conversation, a reply button
-- continues it.
ALTER TABLE coexistence.lead_forms
  ADD COLUMN IF NOT EXISTS after_submit_wa_buttons  JSONB,
  ADD COLUMN IF NOT EXISTS after_submit_wa_media_id BIGINT;
