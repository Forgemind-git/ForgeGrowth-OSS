-- 046: Claude Code session map for the "Claude over WhatsApp" provider.
--
-- The claude_code LLM provider (backend/src/llm/claudeCode.js) shells out to
-- the sandboxed claude-runner service, which drives the real Claude Code CLI in
-- headless mode. Claude Code keeps its own conversation state keyed by a
-- session_id; we persist that id per WhatsApp conversation so each follow-up
-- message resumes the same session (claude -p --resume <session_id>).
--
-- conversation_key = '<wa_account_id>:<contact_number>' (built in agentEngine).
-- One row per conversation. '/new' | '/reset' | '/clear' deletes the row so the
-- next message starts a fresh Claude session.

CREATE TABLE IF NOT EXISTS coexistence.claude_sessions (
  conversation_key  TEXT PRIMARY KEY,
  session_id        TEXT,
  model             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claude_sessions_updated
  ON coexistence.claude_sessions (updated_at DESC);
