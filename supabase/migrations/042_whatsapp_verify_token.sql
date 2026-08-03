-- 042: Per-account Webhook Verify Token on WhatsApp accounts.
--
-- Until now the Meta webhook handshake (GET /api/webhook/whatsapp) only checked
-- a single global env var (META_WEBHOOK_VERIFY_TOKEN). For a multi-WABA setup
-- each account can have its own verify token configured in the Meta App
-- Dashboard, so we store one per account.
--
-- The verify token is a custom string the user creates and enters identically
-- in Meta's webhook settings; the handshake compares the incoming
-- hub.verify_token against it. Stored encrypted (AES-256-GCM, same as the
-- access token). Nullable so the column adds without a value and the env-var
-- fallback keeps working for accounts created before this migration.
ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS verify_token_encrypted TEXT;
