-- 126 — Business context for the Chat Analyzer.
-- The analyser only saw the conversation, so its recommendations were generic.
-- Now an admin describes the business and the products we sell (pasted details:
-- syllabus, fees, batches, FAQs, objection answers) and every analysis reads it,
-- names the product the customer is interested in, and drafts follow-up messages.
-- Additive + idempotent; the boot ensure in services/chatAnalyser.js mirrors it.

ALTER TABLE coexistence.chat_analyser_config
  ADD COLUMN IF NOT EXISTS business_context TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS context_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS context_updated_by TEXT;

CREATE TABLE IF NOT EXISTS coexistence.chat_analyser_products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_text TEXT,
  details TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  course_id BIGINT,                 -- set when imported from Sales → Products (no FK: a deleted product keeps its context)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE coexistence.chat_analysis
  ADD COLUMN IF NOT EXISTS interested_products JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which business context the verdict was made with ('' = none). A different
  -- current hash means the verdict predates a context edit.
  ADD COLUMN IF NOT EXISTS context_hash TEXT;

-- Rate-card entries for the gpt-5 family, so choosing it in Settings reports its
-- real cost instead of silently being priced at the mini "default" (measured:
-- one gpt-5 analysis = 1.5k in + 2.6k out tokens ≈ $0.028, ~40x a mini run).
-- USD per 1M tokens. Added only when missing, so an admin's own figures stay.
UPDATE coexistence.chat_analyser_config
   SET rate_card = jsonb_set(rate_card, '{text}',
         '{"gpt-5":{"in":1.25,"out":10.00},"gpt-5-mini":{"in":0.25,"out":2.00}}'::jsonb || (rate_card->'text'))
 WHERE NOT (rate_card->'text' ? 'gpt-5');
