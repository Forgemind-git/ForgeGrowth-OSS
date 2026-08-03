-- 063: MCP capabilities for Courses + Payments, and removal of the dead
--      area_pipelines key.
--
-- Two app areas shipped after the last MCP rework (courses = migration 062,
-- razorpay payments = migration 061) and were never registered in PROXY_AREAS,
-- so the generic proxy default-denied them ("No MCP area covers /payments").
-- This adds their capability toggles:
--
--   area_courses  → /courses, /payment-links   (+ list_courses, get_course_revenue tools)
--   area_payments → /payments, /razorpay       (+ list_payments tool)
--
-- NOTE the deliberate carve-out in PROXY_AREAS: /razorpay/config (the PUT that
-- writes the payment-gateway webhook secret) resolves to the SENSITIVE
-- area_admin, NOT area_payments — so enabling the payment ledger never hands
-- over the gateway credentials.
--
-- Both default to FALSE. As with 056/057, the gated()/requireCap() `=== true`
-- check treats a missing key as disabled, so this is safe to run at any time;
-- it makes the defaults explicit and surfaces the toggles in Admin Settings.
--
-- Also drops `area_pipelines`: the migration-040 deal Kanban was replaced by the
-- leads-stage board and unlinked from the nav, and its PROXY_AREAS entry is gone
-- from the code — the key was inert but still showed up in the stored JSONB.

ALTER TABLE coexistence.mcp_settings
  ALTER COLUMN capabilities SET DEFAULT
    '{"discovery":true,"create_agent":true,"update_agent":true,"manage_tools":true,"delete":true,
      "read_messages":false,"send_messages":false,
      "area_contacts":false,"area_messaging":false,"area_broadcasts":false,"area_automations":false,
      "area_admin":false,"area_insights":false,
      "area_leads":false,"area_marketing":false,"area_resources":false,"area_scoring":false,"area_bda":false,
      "area_courses":false,"area_payments":false}'::jsonb;

-- Backfill the singleton row: add each new key only if absent (preserve choices),
-- and drop the dead one.
UPDATE coexistence.mcp_settings
   SET capabilities = (capabilities - 'area_pipelines')
       || jsonb_build_object('area_courses',  COALESCE((capabilities->>'area_courses')::boolean, false))
       || jsonb_build_object('area_payments', COALESCE((capabilities->>'area_payments')::boolean, false))
 WHERE id = 1;
