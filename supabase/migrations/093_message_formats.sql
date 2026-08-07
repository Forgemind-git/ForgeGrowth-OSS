-- 093_message_formats.sql — Message Formats (was "Generate Link")
--
-- A "message format" is a labelled pre-filled WhatsApp opener. You put its link
-- on an Instagram reel or a website page; when the viewer taps it, WhatsApp
-- opens with that exact text and the conversation that follows is attributable
-- to the label.
--
-- Three things changed vs. the old wa_links model:
--
--   1. ONE FORMAT, MANY NUMBERS. wa_links.phone_number could hold exactly one
--      number, so "all sales numbers" was inexpressible. Numbers moved to
--      wa_link_targets — one row per number, each with its OWN slug, because
--      each number is a different wa.me destination and therefore a different
--      URL. A format-level rotate_slug additionally hands out the numbers in
--      turn from a single link (spreads leads across BDAs).
--
--   2. THE REDIRECT IS NOW THE SHARED URL. GET /l/:slug already existed and
--      nginx already proxied it, but the UI only ever copied the raw wa.me URL
--      — so the redirect was never in the path and nothing has ever been
--      counted. wa_link_clicks records every tap.
--
--   3. ATTRIBUTION. wa_link_hits records the inbound message that matched a
--      format, i.e. the conversation that actually started. A brand-new lead
--      takes the format's label as its funnel Source.
--
-- Idempotent; re-runnable.

BEGIN;

-- ── The format itself ────────────────────────────────────────────────────────
ALTER TABLE coexistence.wa_links
  ADD COLUMN IF NOT EXISTS active         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS description    TEXT,
  ADD COLUMN IF NOT EXISTS rotate_slug    TEXT,
  ADD COLUMN IF NOT EXISTS rotate_pointer BIGINT  NOT NULL DEFAULT 0;

-- Normalised copy of the message, used to match an inbound WhatsApp body back
-- to its format. GENERATED so it can never drift from `message` — a hand-
-- maintained copy would silently stop matching after any edit that forgot it.
-- The JS side (services/messageFormats.js normalizeMessage) MUST apply the
-- identical transform in the identical order: collapse whitespace, trim, lower.
ALTER TABLE coexistence.wa_links
  ADD COLUMN IF NOT EXISTS message_norm TEXT
    GENERATED ALWAYS AS (lower(btrim(regexp_replace(coalesce(message, ''), '\s+', ' ', 'g')))) STORED;

-- Two ACTIVE formats sharing the same opener are unattributable — an inbound
-- message matching both could only be assigned by coin flip. The guard lives in
-- the index rather than in the create handler because handlers get refactored
-- and an index survives it (and a second writer, e.g. MCP, can't bypass it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_links_message_norm
  ON coexistence.wa_links (message_norm)
  WHERE active AND message_norm <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_links_rotate_slug
  ON coexistence.wa_links (rotate_slug)
  WHERE rotate_slug IS NOT NULL;

-- ── Targets: one row per WhatsApp number this format is published on ─────────
CREATE TABLE IF NOT EXISTS coexistence.wa_link_targets (
  id            BIGSERIAL PRIMARY KEY,
  format_id     BIGINT NOT NULL REFERENCES coexistence.wa_links(id) ON DELETE CASCADE,
  -- The account may be deleted; the link a customer already holds must keep
  -- working, so the number is SNAPSHOT here rather than only joined.
  wa_account_id BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
  phone_number  TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  sort_order    INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_link_targets_format_phone
  ON coexistence.wa_link_targets (format_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_wa_link_targets_format
  ON coexistence.wa_link_targets (format_id, sort_order, id);

-- ── Clicks on /l/<slug> ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.wa_link_clicks (
  id           BIGSERIAL PRIMARY KEY,
  format_id    BIGINT REFERENCES coexistence.wa_links(id) ON DELETE CASCADE,
  target_id    BIGINT REFERENCES coexistence.wa_link_targets(id) ON DELETE SET NULL,
  slug         TEXT,
  phone_number TEXT,
  via_rotation BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent   TEXT,
  referer      TEXT,
  clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_link_clicks_format
  ON coexistence.wa_link_clicks (format_id, clicked_at DESC);

-- ── Hits: an inbound message matched back to its format ──────────────────────
CREATE TABLE IF NOT EXISTS coexistence.wa_link_hits (
  id             BIGSERIAL PRIMARY KEY,
  format_id      BIGINT NOT NULL REFERENCES coexistence.wa_links(id) ON DELETE CASCADE,
  target_id      BIGINT REFERENCES coexistence.wa_link_targets(id) ON DELETE SET NULL,
  wa_number      TEXT,
  contact_number TEXT,
  -- UNIQUE so a webhook replay (Meta retries, our own replay tool) can never
  -- count the same conversation twice.
  message_id     TEXT UNIQUE,
  lead_id        BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  is_new_lead    BOOLEAN NOT NULL DEFAULT FALSE,
  match_kind     TEXT,
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_link_hits_format
  ON coexistence.wa_link_hits (format_id, matched_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_link_hits_contact
  ON coexistence.wa_link_hits (contact_number);

-- ── Backfill: every existing link becomes a format with one target ───────────
-- The target INHERITS the original slug, so links already shared over WhatsApp
-- keep resolving. Guarded by NOT EXISTS so re-running is a no-op.
INSERT INTO coexistence.wa_link_targets (format_id, wa_account_id, phone_number, slug)
SELECT l.id,
       (SELECT a.id FROM coexistence.whatsapp_accounts a
         WHERE regexp_replace(a.display_phone_number, '[^0-9]', '', 'g')
             = regexp_replace(l.phone_number,          '[^0-9]', '', 'g')
         LIMIT 1),
       l.phone_number,
       l.slug
  FROM coexistence.wa_links l
 WHERE l.slug IS NOT NULL
   AND l.phone_number IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM coexistence.wa_link_targets t WHERE t.format_id = l.id);

-- New formats hold their numbers in wa_link_targets, so these two stop being
-- required. Kept (not dropped) so the OLD backend keeps reading them during the
-- deploy window — a dropped column would 500 the list endpoint until the new
-- image is up. Nothing new ever writes them.
ALTER TABLE coexistence.wa_links ALTER COLUMN phone_number DROP NOT NULL;
ALTER TABLE coexistence.wa_links ALTER COLUMN slug         DROP NOT NULL;

COMMENT ON COLUMN coexistence.wa_links.phone_number IS
  'LEGACY (pre-093). Numbers now live in wa_link_targets. Retained only so the pre-093 backend could still read this row; never written by current code.';
COMMENT ON COLUMN coexistence.wa_links.slug IS
  'LEGACY (pre-093). Slugs now live in wa_link_targets (backfilled from here). Never written by current code.';
COMMENT ON TABLE coexistence.wa_links IS
  'A message format: a labelled pre-filled WhatsApp opener. Surfaced in the UI as Chats -> Message Formats.';

COMMIT;
