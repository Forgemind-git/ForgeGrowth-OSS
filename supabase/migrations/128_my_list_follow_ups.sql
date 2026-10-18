-- 128: Leads → My list + follow-up calendar (+ Google Calendar mirror)
--
-- lead_pins        a user's pinned chats ("my list"), one per person (last-10 digits)
-- lead_follow_ups  "contact this person on <date> [at <time>]", with a note;
--                  at most ONE open follow-up per person per owner
-- follow_up_settings  singleton: Google Calendar auto-sync + calendar id
-- chat_analysis.next_follow_up  the Chat Analyzer's suggested next follow-up
--
-- Additive + idempotent; the backend's ensureFollowUpTables() mirrors it at boot.

CREATE TABLE IF NOT EXISTS coexistence.lead_pins (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES coexistence.forgecrm_users(id) ON DELETE CASCADE,
  contact_key    TEXT NOT NULL,
  wa_number      TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  note           TEXT,
  pinned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, contact_key)
);

CREATE TABLE IF NOT EXISTS coexistence.lead_follow_ups (
  id               BIGSERIAL PRIMARY KEY,
  contact_key      TEXT NOT NULL,
  wa_number        TEXT,
  contact_number   TEXT,
  lead_id          BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
  owner_user_id    BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  due_date         DATE NOT NULL,
  due_time         TIME,
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','mcp')),
  ai_reason        TEXT,
  created_by       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at          TIMESTAMPTZ,
  google_event_id  TEXT,
  google_synced_at TIMESTAMPTZ,
  google_error     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_follow_ups_open
  ON coexistence.lead_follow_ups (contact_key, COALESCE(owner_user_id, 0)) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_due
  ON coexistence.lead_follow_ups (due_date) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS coexistence.follow_up_settings (
  id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_auto_sync    BOOLEAN NOT NULL DEFAULT FALSE,
  google_calendar_id  TEXT NOT NULL DEFAULT 'primary',
  google_last_sync_at TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO coexistence.follow_up_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE coexistence.chat_analysis ADD COLUMN IF NOT EXISTS next_follow_up JSONB;
