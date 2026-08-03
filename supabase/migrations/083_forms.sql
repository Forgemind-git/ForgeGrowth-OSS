-- 083_forms.sql
-- Forms — the Lead Forms feature grows an explicit FORM TYPE and remembers its
-- WhatsApp send setup. Idempotent (CI applies every migration on a fresh
-- Postgres) — ADD COLUMN IF NOT EXISTS / guarded constraint only.
--
-- Two types, and the difference is who the respondent is:
--   'link'     — shared as a plain URL. Nobody is identified up front, so a
--                phone number is OPTIONAL: the respondent may volunteer one
--                through a field the builder mapped to phone, and if they
--                don't, lead_form_submissions.phone_number stays NULL.
--   'whatsapp' — sent through an approved template whose URL button carries a
--                per-recipient token (lead_form_send_tokens), so the phone is
--                known before a single question is answered.
--
-- Why a column and not "does it have a token?": the type decides what the
-- BUILDER offers and what the public page demands, both of which are needed
-- before any submission exists. It cannot be inferred after the fact.

ALTER TABLE coexistence.lead_forms
  ADD COLUMN IF NOT EXISTS form_type     TEXT NOT NULL DEFAULT 'link',
  -- The account a WhatsApp form sends from, and the approved template that
  -- carries its link. Both SET NULL rather than CASCADE — deleting a WhatsApp
  -- account or a template must never delete the form or its responses.
  ADD COLUMN IF NOT EXISTS wa_account_id BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_id   BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;

-- Guarded so re-running never errors on an already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lead_forms_form_type_check'
       AND conrelid = 'coexistence.lead_forms'::regclass
  ) THEN
    ALTER TABLE coexistence.lead_forms
      ADD CONSTRAINT lead_forms_form_type_check CHECK (form_type IN ('link','whatsapp'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lead_forms_type ON coexistence.lead_forms(form_type);

-- Backfill: a form that has already minted send tokens was demonstrably used
-- over WhatsApp, so the 'link' default would misdescribe it. Only touches rows
-- still sitting on the default, so a deliberate later change is never undone.
UPDATE coexistence.lead_forms f
   SET form_type = 'whatsapp'
 WHERE f.form_type = 'link'
   AND EXISTS (SELECT 1 FROM coexistence.lead_form_send_tokens t WHERE t.form_id = f.id);
