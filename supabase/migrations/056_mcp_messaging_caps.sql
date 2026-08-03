-- 056: MCP message read + reply capabilities.
--
-- Adds two NEW per-key capabilities to mcp_settings.capabilities so the MCP can
-- (a) read WhatsApp conversations/history and (b) reply (free-form text within
-- the 24h window + approved templates). Both default to FALSE — they are
-- higher-privilege than agent building, so an admin must opt in explicitly in
-- Admin Settings → MCP Tools. The synthetic MCP user is org-wide admin, so these
-- tools are unscoped; keeping them off by default is the safe posture.
--
-- routes/mcp.js CAPABILITY_KEYS + the gated() / requireCap() checks treat a
-- missing key as disabled (=== true), so existing keys are already safe even
-- before this runs; this just makes the default explicit and surfaces the two
-- toggles for any freshly-created settings row.

-- New default for fresh installs.
ALTER TABLE coexistence.mcp_settings
  ALTER COLUMN capabilities SET DEFAULT
    '{"discovery":true,"create_agent":true,"update_agent":true,"manage_tools":true,"delete":true,"read_messages":false,"send_messages":false}'::jsonb;

-- Backfill the singleton row: add the two keys only if absent (preserve any
-- existing admin choices for the other capabilities).
UPDATE coexistence.mcp_settings
   SET capabilities = capabilities
       || jsonb_build_object('read_messages', COALESCE((capabilities->>'read_messages')::boolean, false))
       || jsonb_build_object('send_messages', COALESCE((capabilities->>'send_messages')::boolean, false))
 WHERE id = 1;
