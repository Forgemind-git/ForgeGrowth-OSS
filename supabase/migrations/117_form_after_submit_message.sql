-- A WhatsApp message sent to the respondent once they submit the form.
--
-- The form's post-submit REDIRECT hands the browser somewhere; it leaves
-- nothing in the chat. For a registration that ends in a payment, the link has
-- to be in WhatsApp too — that is where the customer comes back to it.
--
-- Idempotent; mirrored by ensureLeadFormTables() so a boot self-heals it.
ALTER TABLE coexistence.lead_forms
  ADD COLUMN IF NOT EXISTS after_submit_wa_text TEXT;

COMMENT ON COLUMN coexistence.lead_forms.after_submit_wa_text IS
  'Sent on WhatsApp after a submission that resolves to a phone and a business number (from the send token). NULL = send nothing.';
