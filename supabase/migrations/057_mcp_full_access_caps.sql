-- 057: MCP full-access (generic proxy + bulk broadcast) per-area capabilities.
--
-- Adds seven per-AREA capability toggles that gate the generic `forgechat_request`
-- proxy (and the send_bulk_message tool). Each area maps to a set of internal
-- /api path prefixes (see PROXY_AREAS in services/mcpService.js). All default to
-- FALSE — turning one on lets an MCP key perform ADMIN actions on that area from
-- an external client, so each is an explicit opt-in.
--
-- As with 056, the gated()/requireCap() `=== true` check treats a missing key as
-- disabled, so this is safe to run at any time; it just makes the defaults
-- explicit and surfaces the toggles in Admin Settings → MCP Tools.

ALTER TABLE coexistence.mcp_settings
  ALTER COLUMN capabilities SET DEFAULT
    '{"discovery":true,"create_agent":true,"update_agent":true,"manage_tools":true,"delete":true,
      "read_messages":false,"send_messages":false,
      "area_contacts":false,"area_messaging":false,"area_broadcasts":false,"area_automations":false,
      "area_pipelines":false,"area_admin":false,"area_insights":false}'::jsonb;

-- Backfill the singleton row: add each area key only if absent (preserve choices).
UPDATE coexistence.mcp_settings
   SET capabilities = capabilities
       || jsonb_build_object('area_contacts',   COALESCE((capabilities->>'area_contacts')::boolean, false))
       || jsonb_build_object('area_messaging',  COALESCE((capabilities->>'area_messaging')::boolean, false))
       || jsonb_build_object('area_broadcasts', COALESCE((capabilities->>'area_broadcasts')::boolean, false))
       || jsonb_build_object('area_automations',COALESCE((capabilities->>'area_automations')::boolean, false))
       || jsonb_build_object('area_pipelines',  COALESCE((capabilities->>'area_pipelines')::boolean, false))
       || jsonb_build_object('area_admin',      COALESCE((capabilities->>'area_admin')::boolean, false))
       || jsonb_build_object('area_insights',   COALESCE((capabilities->>'area_insights')::boolean, false))
 WHERE id = 1;
