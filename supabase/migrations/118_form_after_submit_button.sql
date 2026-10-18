-- The after-submit message can carry a tappable button instead of leaving the
-- URL loose in the text. A link in body text is easy to miss and easy to
-- mistype; a button is the same affordance the rest of the flow uses.
--
-- Two columns rather than one JSON blob: each is a single value the UI edits
-- directly, and a NULL url simply means "no button", which is the default.
ALTER TABLE coexistence.lead_forms
  ADD COLUMN IF NOT EXISTS after_submit_wa_button_text TEXT,
  ADD COLUMN IF NOT EXISTS after_submit_wa_button_url  TEXT;
