-- 101_remove_ecommerce.sql
--
-- Removes the E-commerce feature (the WhatsApp catalog as a selling channel),
-- shipped as section A of migration 098. Section B of 098 — MESSAGE COSTS — is
-- a separate feature and is deliberately UNTOUCHED here: message_billing_events,
-- waba_pricing_daily, waba_pricing_sync, whatsapp_rate_fallback,
-- message_cost_config and the chat_history.template_id / send_origin columns all
-- stay exactly as they are.
--
-- ⚠ DESTRUCTIVE. Unlike every other migration in this directory, this one DROPs
-- tables and columns. It is NOT idempotent in the "re-runnable forever" sense —
-- it is idempotent only in that every statement is IF EXISTS, so a second run is
-- a no-op rather than an error.
--
-- ⚠ DEPLOY ORDERING — this migration must ship WITH the backend, never before
-- it. Two hard reasons, both verified against the live instance:
--
--   1. payment_requests.order_id is referenced by the INSERT in
--      services/paymentFlow.js createPaymentForChat(). Drop the column while the
--      pre-removal backend is still running and EVERY Razorpay payment-link
--      creation starts throwing — a live money path.
--
--   2. agents.catalog_enabled / catalog_config are referenced by the INSERT in
--      services/agentService.js createAgent(). Same failure: creating an AI
--      agent starts throwing.
--
--   And it would partly undo itself anyway: the pre-removal backend calls
--   ensureCatalogTables() / ensureOrderTables() at boot, which CREATE TABLE IF
--   NOT EXISTS these very tables — so a restart would put them straight back.
--
--   This is the same lesson recorded for migration 094: additive migrations may
--   go first, but renames and drops travel with the code that stops using them.
--
-- Backup taken before the live run:
--   /root/backup-system/manual/forgegrowth_pre_ecommerce_removal_20260808_022911.sql
--
-- Live row counts at removal time: catalog_accounts 3, catalog_products 13,
-- catalog_collections 1, wa_orders 0, wa_order_items 0. The products were a
-- mirror of Meta's own catalog (still intact at Meta, nothing lost here), and no
-- customer ever placed an order through this app.

-- ── 1. Detach the one reference INTO the e-commerce cluster ─────────────────
-- Dropping the column also drops uq_payment_requests_order (the partial unique
-- index that enforced "one cart, at most one payable link") and the FK to
-- wa_orders. Done FIRST so the table drops below have no inbound dependency.
--
-- The payment_requests rows themselves are NOT touched: a link raised for an
-- order is still a real link that was really paid, and its money history stays
-- in the ledger. Only the pointer to the cart goes. (Live: 0 rows had it set.)
ALTER TABLE coexistence.payment_requests
  DROP COLUMN IF EXISTS order_id;

-- ── 2. Agent catalog tools ──────────────────────────────────────────────────
-- The three catalog tools (search_catalog / show_products / show_catalog) are
-- gone from engine/agentEngine.js, so these columns configure nothing.
-- Live: 0 agents had catalog_enabled = TRUE.
ALTER TABLE coexistence.agents
  DROP COLUMN IF EXISTS catalog_enabled;
ALTER TABLE coexistence.agents
  DROP COLUMN IF EXISTS catalog_config;

-- ── 3. The tables, child-first ──────────────────────────────────────────────
-- Explicit order rather than CASCADE: CASCADE would silently drop anything that
-- happened to reference these, and "silently" is the wrong behaviour for a
-- destructive migration. If a statement below fails on an unexpected dependency,
-- that is information worth stopping for.
DROP TABLE IF EXISTS coexistence.wa_order_items;
DROP TABLE IF EXISTS coexistence.wa_orders;
DROP TABLE IF EXISTS coexistence.catalog_products;
DROP TABLE IF EXISTS coexistence.catalog_collections;
DROP TABLE IF EXISTS coexistence.catalog_accounts;
