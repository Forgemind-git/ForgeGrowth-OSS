// Razorpay payment ledger — the PULL half of the integration.
//
// The webhook is push-only: it can only know about events sent after it was
// configured, and an event Razorpay fails to deliver is gone with no trace.
// This module reads the payment list straight from Razorpay's API so the
// dashboard reflects what the gateway actually holds.
//
// ⚠ LEDGER ONLY. This never enrols anyone, never creates a lead and never
// touches funnel stages. It writes to coexistence.razorpay_payments, which
// nothing else aggregates. The webhook path (routes/razorpay.js) remains the
// only thing allowed to mutate CRM state from a payment — importing 1.5 years
// of history through that path would retroactively enrol hundreds of people and
// mirror won-stage tags onto their WhatsApp contacts.
//
// Matching to a lead IS attempted, but only recorded on this row as a hint for
// the UI. It changes nothing about the lead.

const pool = require('../db');
const rzp = require('../integrations/razorpayClient');

// Overlap re-read on every incremental sync. Razorpay can settle or update a
// payment shortly after it is created, and a boundary drawn exactly at the last
// sync time would miss anything that changed just before it. Cheap to re-read
// because the UPSERT is idempotent.
const OVERLAP_HOURS = 48;

async function ensurePaymentLedgerTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.razorpay_payments (
      payment_id             TEXT PRIMARY KEY,
      order_id               TEXT,
      invoice_id             TEXT,
      status                 TEXT,
      amount_paise           BIGINT NOT NULL DEFAULT 0,
      amount_refunded_paise  BIGINT NOT NULL DEFAULT 0,
      currency               TEXT,
      method                 TEXT,
      captured               BOOLEAN,
      description            TEXT,
      payer_email            TEXT,
      payer_contact          TEXT,
      notes                  JSONB,
      fee_paise              BIGINT,
      tax_paise              BIGINT,
      error_code             TEXT,
      error_description      TEXT,
      paid_at                TIMESTAMPTZ,
      matched_lead_id        BIGINT,
      matched_lead_name      TEXT,
      match_method           TEXT,
      raw                    JSONB,
      synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_payments_paid_at ON coexistence.razorpay_payments(paid_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_payments_status  ON coexistence.razorpay_payments(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_payments_contact ON coexistence.razorpay_payments(payer_contact)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_payments_lead    ON coexistence.razorpay_payments(matched_lead_id)`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_synced_at    TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_sync_error   TEXT`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS payments_synced_count INTEGER NOT NULL DEFAULT 0`);
}

// Last 10 digits is the only reliable join between a Razorpay contact and a
// CRM number: the same person appears as 9876543210, +919876543210 and
// 919876543210 across the two systems.
const MATCH_SQL = `
  WITH c AS (SELECT right(regexp_replace($1::text, '\\D', '', 'g'), 10) AS phone10,
                    lower(nullif(trim($2::text), '')) AS email)
  SELECT l.id, l.name,
         CASE WHEN right(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10) = (SELECT phone10 FROM c)
              THEN 'phone' ELSE 'email' END AS method
    FROM coexistence.leads l, c
   WHERE (c.phone10 <> '' AND right(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10) = c.phone10)
      OR (c.email IS NOT NULL AND lower(l.email) = c.email)
   ORDER BY (right(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10) = (SELECT phone10 FROM c)) DESC, l.id
   LIMIT 1`;

// Razorpay uses void@razorpay.com as a placeholder when the payer gave no
// email. Matching on it would join unrelated customers to one another.
const PLACEHOLDER_EMAILS = new Set(['void@razorpay.com', 'voidforward@razorpay.com']);

async function matchPayment(p) {
  const email = PLACEHOLDER_EMAILS.has(String(p.email || '').toLowerCase()) ? null : p.email;
  if (!p.contact && !email) return { leadId: null, leadName: null, method: null };
  try {
    const { rows } = await pool.query(MATCH_SQL, [p.contact || '', email || '']);
    if (!rows[0]) return { leadId: null, leadName: null, method: null };
    return { leadId: Number(rows[0].id), leadName: rows[0].name || null, method: rows[0].method };
  } catch {
    // A matcher failure must never abort the ledger import — an unmatched row
    // is still a correct record of the payment.
    return { leadId: null, leadName: null, method: null };
  }
}

async function upsertPayment(p) {
  const m = await matchPayment(p);
  await pool.query(
    `INSERT INTO coexistence.razorpay_payments
       (payment_id, order_id, invoice_id, status, amount_paise, amount_refunded_paise, currency,
        method, captured, description, payer_email, payer_contact, notes, fee_paise, tax_paise,
        error_code, error_description, paid_at, matched_lead_id, matched_lead_name, match_method,
        raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             to_timestamp($18),$19,$20,$21,$22,NOW())
     ON CONFLICT (payment_id) DO UPDATE SET
       status=EXCLUDED.status, amount_refunded_paise=EXCLUDED.amount_refunded_paise,
       captured=EXCLUDED.captured, fee_paise=EXCLUDED.fee_paise, tax_paise=EXCLUDED.tax_paise,
       error_code=EXCLUDED.error_code, error_description=EXCLUDED.error_description,
       -- Re-matching on every sync is intentional: a payment that arrived
       -- before its lead existed becomes matchable later, and this is the only
       -- thing that will ever notice.
       matched_lead_id=EXCLUDED.matched_lead_id, matched_lead_name=EXCLUDED.matched_lead_name,
       match_method=EXCLUDED.match_method, raw=EXCLUDED.raw, synced_at=NOW()`,
    [
      p.id, p.order_id || null, p.invoice_id || null, p.status || null,
      Number(p.amount || 0), Number(p.amount_refunded || 0), p.currency || null,
      p.method || null, p.captured === true, p.description || null,
      p.email || null, p.contact || null, p.notes && typeof p.notes === 'object' ? p.notes : {},
      p.fee == null ? null : Number(p.fee), p.tax == null ? null : Number(p.tax),
      p.error_code || null, p.error_description || null,
      Number(p.created_at || 0) || null,
      m.leadId, m.leadName, m.method, p,
    ]
  );
}

/**
 * Pull payments into the ledger.
 *
 * @param {object}  opts
 * @param {boolean} opts.full  Import the entire history. Otherwise only the
 *                             window since the last successful sync.
 */
async function syncRazorpayPayments({ full = false } = {}) {
  await ensurePaymentLedgerTables();

  const { rows: cfg } = await pool.query(
    `SELECT (key_secret_encrypted IS NOT NULL) AS has_keys, payments_synced_at
       FROM coexistence.razorpay_config WHERE id = 1`
  );
  if (!cfg[0]?.has_keys) return { ok: false, skipped: 'no_api_keys', imported: 0 };

  // Razorpay's from/to are UNIX SECONDS. Passing milliseconds lands ~55,000
  // years in the future and silently returns an empty list.
  let from;
  if (!full && cfg[0].payments_synced_at) {
    from = Math.floor(new Date(cfg[0].payments_synced_at).getTime() / 1000) - OVERLAP_HOURS * 3600;
  }

  try {
    const { payments, truncated } = await rzp.listAllPayments({ from });
    for (const p of payments) {
      if (p && p.id) await upsertPayment(p);
    }
    if (truncated) {
      // Never let a capped run look like a complete one.
      console.warn('[razorpay-ledger] hit the page cap — some payments were not read this run');
    }
    const { rows: tot } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.razorpay_payments');
    await pool.query(
      `UPDATE coexistence.razorpay_config
          SET payments_synced_at = NOW(), payments_sync_error = NULL,
              payments_synced_count = $1, updated_at = NOW()
        WHERE id = 1`, [tot[0].n]
    );
    return { ok: true, fetched: payments.length, total: tot[0].n, truncated, full };
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.razorpay_config SET payments_sync_error = $1, updated_at = NOW() WHERE id = 1`,
      [err.message]
    ).catch(() => {});
    throw err;
  }
}

module.exports = { ensurePaymentLedgerTables, syncRazorpayPayments };
