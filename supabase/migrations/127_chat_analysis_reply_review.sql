-- 127 — Chat Analyzer judges OUR side of the conversation too.
-- reply_review: how our latest replies landed (did we answer what they asked).
-- missed: what we failed to answer / promised and did not do / opportunities lost.
-- Additive + idempotent; the boot ensure in services/chatAnalyser.js mirrors it.
ALTER TABLE coexistence.chat_analysis
  ADD COLUMN IF NOT EXISTS reply_review TEXT,
  ADD COLUMN IF NOT EXISTS missed JSONB NOT NULL DEFAULT '[]'::jsonb;
