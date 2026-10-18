-- 116: payment status on a sale.
--
-- leads.payment_status is a MANUAL override ('paid' | 'partial' | 'unpaid');
-- NULL means "derive it" — total paid vs the product's default price, computed
-- in services/paymentStatus.js. Stored as a key, never a label, so the label
-- can be renamed in Admin Settings → Fields without touching rows.
--
-- Additive + idempotent. The boot ensure in routes/entityFields.js mirrors the
-- registry seed, and routes/courses.js ensureCourseTables mirrors the column.

ALTER TABLE coexistence.leads
  ADD COLUMN IF NOT EXISTS payment_status TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_payment_status_check'
  ) THEN
    ALTER TABLE coexistence.leads
      ADD CONSTRAINT leads_payment_status_check
      CHECK (payment_status IS NULL OR payment_status IN ('paid', 'partial', 'unpaid'));
  END IF;
END $$;

COMMENT ON COLUMN coexistence.leads.payment_status IS
  'Manual payment-status override for a sale (paid|partial|unpaid). NULL = derived from total paid vs the product default price (services/paymentStatus.js).';

-- Registry row so the Sales Log column can be relabelled / hidden / reordered.
-- Options stay empty: the values are fixed keys rendered by the app, like
-- `source` and `stage`.
INSERT INTO coexistence.entity_fields
  (entity, field_key, label, field_type, options, is_system, system_column, show_in_leads, show_in_sales, sort_order)
VALUES
  ('lead', 'payment_status', 'Payment Status', 'dropdown', '[]', TRUE, 'payment_status', FALSE, TRUE, 13)
ON CONFLICT (entity, field_key) DO NOTHING;
