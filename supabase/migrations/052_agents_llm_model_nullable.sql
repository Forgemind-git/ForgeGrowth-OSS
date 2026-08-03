-- Drafts can be saved before a model is chosen (e.g. the operator adds a tool or
-- leaves to connect an AI model first). The code already supports a NULL
-- ai_model_id/llm_model for status='draft' (migration 050 even marks such rows as
-- drafts), but llm_model was still NOT NULL — so any draft-without-model save
-- (the "Save draft & go to Integrations" path, and adding a tool before the first
-- save) hit a not-null violation → "Failed to create agent". Relax the constraint.
ALTER TABLE coexistence.agents ALTER COLUMN llm_model DROP NOT NULL;
