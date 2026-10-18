-- 109_forms_v2.sql
-- Forms v2 — multi-page conditional forms, file uploads, image blocks, a
-- customisable submit button with a post-submit destination, submission email
-- alerts, and iframe embedding.
--
-- ADDITIVE ONLY (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS), so it
-- is safe to apply BEFORE the new backend: the running image simply never names
-- the new columns. That is deliberate — the rename in migration 094 had to ship
-- WITH its backend and took out an unrelated page when it did not.
-- Idempotent: CI applies every migration on a fresh Postgres.
--
-- ── the model ───────────────────────────────────────────────────────────────
-- ONE FLAT ANSWER TABLE, WHATEVER THE FLOW. `lead_forms.fields` stays the
-- single ordered array it has always been and `lead_form_submissions` keeps one
-- row per respondent with one JSONB answers bag. Pages and branches decide what
-- a person is ASKED; they do not shard where the answers land. That is what
-- keeps the Responses table, the CSV export, the dashboard breakdown and the
-- {{form.<slug>.<key>}} resolver working with no change — and it is what "multiple
-- pages but as one long table" means in practice.
--
--   pages  [{ id, title, description }]        — ordered; index order is the default "next"
--   fields  … + { pageId }                     — a field with no pageId belongs to page 1
--   rules  [{ id, fromPageId, match, conditions:[{fieldKey, op, value}], goToPageId }]
--
-- The evaluator is services/formFlow.js (mirrored at lib/formFlow.js). Rules on
-- a page are first-match-wins, and `goToPageId` may be the sentinel '__end__'.

ALTER TABLE coexistence.lead_forms
  -- Flow. Empty arrays mean "one page, no branches", which is exactly what
  -- every form built before this migration already is — so nothing needs
  -- backfilling and no existing form changes behaviour.
  ADD COLUMN IF NOT EXISTS pages              JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rules              JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Submit button. NULL label/colour mean "use the defaults" rather than a
  -- stored copy of them: re-theming the app should move a button nobody
  -- deliberately customised.
  ADD COLUMN IF NOT EXISTS submit_label       TEXT,
  ADD COLUMN IF NOT EXISTS submit_color       TEXT,

  -- What happens AFTER a successful submission. 'message' is today's behaviour
  -- (show success_message, which already exists — this migration deliberately
  -- does not add a second thank-you field).
  --
  -- ⚠ The redirect happens only once the response is SAVED. The button is never
  -- an <a href>: a link navigates on click and can tear the page down mid-POST,
  -- losing the very lead the redirect exists to hand over.
  ADD COLUMN IF NOT EXISTS post_submit_action TEXT    NOT NULL DEFAULT 'message',
  ADD COLUMN IF NOT EXISTS redirect_url       TEXT,
  -- The number the RESPONDENT is sent to chat with, and the text pre-filled in
  -- their WhatsApp composer. Distinct from wa_account_id, which is the business
  -- number a WhatsApp-type form is SENT FROM.
  ADD COLUMN IF NOT EXISTS wa_target_number   TEXT,
  ADD COLUMN IF NOT EXISTS wa_prefill_text    TEXT,

  -- Notify on fill. Recipients are a JSONB array of addresses; delivery goes
  -- through the already-connected Gmail integration.
  ADD COLUMN IF NOT EXISTS notify_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_emails      JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Embedding. Off by default: allowing a page to be framed is a decision, not
  -- a default. `embed_origins` empty means "any site" — see routes/leadForms.js
  -- for why that is the honest default for a public marketing form and what the
  -- allow-list buys when it is filled in.
  ADD COLUMN IF NOT EXISTS embed_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS embed_origins      JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Per-form upload ceiling in MB. NULL = use the global default from
  -- form_settings. NULL and 0 must never both mean "off": 0 here would silence
  -- every upload on the form while looking like a configured limit, so the API
  -- clears a typed 0 back to NULL.
  ADD COLUMN IF NOT EXISTS max_upload_mb      INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lead_forms_post_submit_action_check'
       AND conrelid = 'coexistence.lead_forms'::regclass
  ) THEN
    ALTER TABLE coexistence.lead_forms
      ADD CONSTRAINT lead_forms_post_submit_action_check
      CHECK (post_submit_action IN ('message','redirect','whatsapp'));
  END IF;
END $$;

-- ── uploaded files ──────────────────────────────────────────────────────────
-- One row per file a respondent uploads. The bytes live in MinIO (the same
-- bucket as the form's logo and banner); this table is the index.
--
-- ⚠ THE ANSWER STORES `upload_token`, NEVER `object_key`. A file is uploaded
-- BEFORE the form is submitted — the respondent picks it, it goes up, they
-- carry on filling — so the answer has to point at something already on the
-- server. Letting the browser name that thing by its bucket key would let
-- anyone hand back any key in the bucket and have it attached to their
-- submission. The token is minted here, server-side, and is the only handle the
-- public ever sees.
--
-- submission_id is NULL until the form is actually submitted ("claimed"). An
-- unclaimed row is someone who picked a file and then closed the tab, and it is
-- reaped on a schedule — without that, an open upload endpoint fills the bucket
-- with files no form ever references.
CREATE TABLE IF NOT EXISTS coexistence.lead_form_files (
  id             BIGSERIAL PRIMARY KEY,
  form_id        BIGINT NOT NULL REFERENCES coexistence.lead_forms(id) ON DELETE CASCADE,
  submission_id  BIGINT REFERENCES coexistence.lead_form_submissions(id) ON DELETE CASCADE,
  field_key      TEXT NOT NULL,
  upload_token   TEXT NOT NULL UNIQUE,
  object_key     TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     BIGINT NOT NULL,
  ip_address     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lead_form_files_form ON coexistence.lead_form_files(form_id);
CREATE INDEX IF NOT EXISTS idx_lead_form_files_submission ON coexistence.lead_form_files(submission_id);
-- Drives the orphan sweeper: find unclaimed uploads older than the grace period.
CREATE INDEX IF NOT EXISTS idx_lead_form_files_unclaimed
  ON coexistence.lead_form_files(created_at) WHERE submission_id IS NULL;

-- ── per-image blocks ────────────────────────────────────────────────────────
-- An `image` field type is a display-only block (like `section`). Its picture is
-- an ordinary MinIO object whose key is stored on the field itself inside
-- `fields` — no table needed, and it travels with the field if it is reordered
-- or deleted.

-- ── global form settings ────────────────────────────────────────────────────
-- Singleton (id = 1), the same shape as every other config table here
-- (capi_config, razorpay_config, mcp_settings). Holds the ceiling an individual
-- form's max_upload_mb cannot exceed, so raising one form's limit can never
-- quietly raise what the server will accept overall.
CREATE TABLE IF NOT EXISTS coexistence.form_settings (
  id                 INT PRIMARY KEY DEFAULT 1,
  max_upload_mb      INT NOT NULL DEFAULT 50,
  -- Default allowed file kinds for a new file field. A per-field list narrows
  -- this; it can never widen it.
  allowed_kinds      JSONB NOT NULL DEFAULT '["pdf","doc","xls","ppt","image"]'::jsonb,
  notify_from_name   TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT form_settings_singleton CHECK (id = 1)
);
INSERT INTO coexistence.form_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN coexistence.lead_forms.pages IS
  'Ordered [{id,title,description}]. Empty = a single implicit page. Fields carry pageId; rules branch between them. Answers stay in ONE flat submissions row regardless.';
COMMENT ON COLUMN coexistence.lead_form_files.upload_token IS
  'The opaque handle stored in the submission answer. Never expose object_key publicly.';
