-- 133: a short display LABEL per connected WhatsApp number.
--
-- Several numbers carry near-identical account names (often Meta's verified
-- name), so the Chats "WhatsApp Numbers" list and every "send from" picker were
-- hard to tell apart. `label` is a display label ONLY:
--   * it never changes the real number, the phone_number_id, or Meta's verified name;
--   * NULL / blank = fall back to display_name (the account name), so nothing
--     changes for an account until someone types a label.
-- Mirrored at boot by ensureWhatsappAccountColumns() in routes/whatsappAccounts.js.
-- Additive and idempotent.
ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS label TEXT;

COMMENT ON COLUMN coexistence.whatsapp_accounts.label IS
  'Display label shown wherever the number is listed or picked. Display only; NULL = use display_name.';
