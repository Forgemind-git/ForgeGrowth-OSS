-- 084_product_default_price.sql
-- Products (formerly "Courses") gain an optional DEFAULT PRICE.
--
-- ⚠ The table is still named `courses`. The concept is now generic — a product
-- may be a course, a consulting engagement, a template pack or a webinar — and
-- every user-facing surface and the API say "product". The table keeps its
-- original name on purpose: `courses.id` is referenced by payment_links,
-- sales_log and razorpay_events, which is the Razorpay money-attribution path.
-- Renaming it buys nothing anyone can see and puts payment attribution at risk.
-- Read `courses` as "products" everywhere below.
--
-- Why a default price when payment_links already carry amounts: a payment link
-- is one PRICE VARIANT used to match an incoming payment by its exact amount
-- (full price, early bird, a discount). The default price is the product's own
-- headline price — what you would normally charge — and it is what pre-fills a
-- manual sale. The two are different questions, so one cannot stand in for the
-- other: a product can have a price before it has any payment link at all.
--
-- Stored in PAISE, matching sales_log and leads.paid_amount_paise. Rupees are
-- converted at the API boundary, never in the database — an integer of paise
-- cannot drift the way a float of rupees can.

ALTER TABLE coexistence.courses
  ADD COLUMN IF NOT EXISTS default_price_paise BIGINT;

COMMENT ON TABLE coexistence.courses IS
  'Products (course / consulting / template / webinar). Table name is historical — see migration 084.';
COMMENT ON COLUMN coexistence.courses.default_price_paise IS
  'Optional headline price in paise. Pre-fills a manual sale; distinct from payment_links.amount_paise, which matches real payments.';
