-- ─── Migration 080: custom conversions + page_id for CTWA ───────────────────
--
--  WHY CUSTOM EVENTS: the CTWA Conversions API only accepted Meta's 17 standard
--  event names. That guard exists for a good reason — Meta SILENTLY DROPS an
--  event name it does not recognise, so a typo ("Purchse") looks like a working
--  mapping that never optimises anything.
--
--  But "qualified" is a definition that lives inside our own chat flow. There is
--  no standard event for it, and a Custom Conversion created in Events Manager
--  is exactly how Meta intends this to be expressed. So the guard cannot simply
--  be removed — it has to distinguish "a name Meta doesn't know because I typo'd
--  it" from "a name Meta doesn't know because I created it myself".
--
--  is_custom is that distinction, set explicitly by the admin. A non-standard
--  name is still rejected unless the mapping is flagged custom, which keeps the
--  typo protection intact while allowing a deliberate Custom Conversion.
--
--  WHY page_id: Meta documents user_data.whatsapp_business_account_id for
--  WhatsApp CTWA and user_data.page_id for Messenger/Instagram. Sending BOTH is
--  harmless and covers the case where the dataset expects the Page. This adds
--  page_id as optional config — it is never sent when unset, so nothing changes
--  for an install that does not fill it in.
--
-- Idempotent + re-runnable. Mirrored by ensureCtwaTables() in routes/ctwa.js.
--
-- Apply: docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/080_capi_custom_conversions.sql

-- A mapping may name a Custom Conversion rather than a Meta standard event.
ALTER TABLE coexistence.capi_event_map
  ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE;

-- The Facebook Page behind the WhatsApp number. Optional; sent alongside the
-- WABA id when present, never instead of it.
ALTER TABLE coexistence.capi_config
  ADD COLUMN IF NOT EXISTS page_id TEXT;
