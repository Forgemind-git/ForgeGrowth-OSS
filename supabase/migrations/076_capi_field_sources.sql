-- ─── Migration 076: choose which lead column feeds each Meta match key ───────
--
--  WHY: the mapping from a Meta match key to a CRM column was hardcoded, which
--  meant a guess was being made on the admin's behalf. That guess is not safe
--  here — coexistence.leads carries TWO postal columns (`zip` and `pincode`) and
--  an empty `city`/`state` pair. `pincode` was chosen because it was the one
--  holding data at the time; if `zip` later starts being populated, hardcoded
--  wiring would silently keep reading the empty column and every conversion
--  would go out missing a key nobody realised was missing.
--
--  customer_field_sources maps Meta key -> leads column name. NULL/absent means
--  "use the built-in default", so an instance that never touches this keeps
--  today's behaviour exactly.
--
--  external_id is deliberately NOT mappable: it is derived from the click id so
--  it stays stable across a deleted sale or a returning customer, which a lead
--  column cannot guarantee.
--
-- Idempotent + re-runnable. Mirrored by ensureCtwaTables() in routes/ctwa.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/076_capi_field_sources.sql

ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS customer_field_sources JSONB NOT NULL DEFAULT
    '{"ph":"whatsapp_number","em":"email","fn":"name","ln":"name","zp":"pincode","ct":"city","st":"state"}'::jsonb;
