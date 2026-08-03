-- 065_sales_profile_fields.sql
-- Sales Log enrichment (2026-07-21).
-- The Students tab becomes the "Sales Log" tab: each sale is a paying customer
-- (an enrolled lead) whose profile mirrors the Razorpay payment-page form —
-- Full Name / Email / Phone / Age / Profession / Pincode. Name/email/phone
-- already existed on leads; add the three missing profile fields. A manual
-- sales_log transaction also gets a `method` so split / multi-method payments
-- can be recorded (Razorpay transactions already carry their real method).
--
-- Idempotent; re-runnable.

ALTER TABLE coexistence.leads     ADD COLUMN IF NOT EXISTS age        INT;
ALTER TABLE coexistence.leads     ADD COLUMN IF NOT EXISTS profession TEXT;
ALTER TABLE coexistence.leads     ADD COLUMN IF NOT EXISTS pincode    TEXT;
ALTER TABLE coexistence.sales_log ADD COLUMN IF NOT EXISTS method     TEXT;
