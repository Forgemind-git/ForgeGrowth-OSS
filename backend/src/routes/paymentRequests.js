// ─── Payment requests — Razorpay links minted by ForgeGrowth ─────────────────
// Sales → Payments. Create a payment link for a lead (fixed amount, part
// payment with a minimum, or an open "pay what you like" amount), track it, and
// let the paid webhook attribute itself EXACTLY.
//
// THE POINT OF THIS FILE
// Before it, a link created in the Razorpay dashboard arrived with notes:null
// and reference_id:"" and could only be attributed by matching its rupee amount
// against the payment_links price registry (courses.matchLink). That is an
// INFERRED key: it collides the moment two things cost the same, is impossible
// for an open amount, and silently books the money to the wrong product rather
// than erroring. Minting the link here lets us stamp our own ids into Razorpay
// `notes`, so the webhook reads back exactly who and what.
//
// TWO IDS ARE STAMPED, ON PURPOSE:
//   forge_request_id — resolves to this table (product, purpose, expected amount)
//   forge_lead_id    — resolves straight to the lead
// The lead id is the belt to the request id's braces. If a create call times
// out after Razorpay already made the link, we may have no local row for it —
// but the link still carries the lead id, so the payment still attributes to
// the right person instead of falling back to phone-matching (which is exactly
// what failed on the one real link payment in the log: addressed to one number,
// paid from another, email came through as Razorpay's void@razorpay.com).
//
// Exports used by routes/razorpay.js:
//   ensurePaymentRequestTables, resolveLinkContext, applyLinkStatus

const { Router } = require('express');
const pool = require('../db');
const bus = require('../events');
const { requirePermission, adminOnly } = require('../middleware/access');
const rzp = require('../integrations/razorpayClient');

const router = Router();

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;
const isAdmin = (req) => req.user?.role === 'admin';
const meId = (req) => parseInt(req.user?.id, 10);

// ── Schema (idempotent; mirrors migration 085) ───────────────────────────────
async function ensurePaymentRequestTables() {
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS key_secret_encrypted TEXT;`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS key_mode       TEXT NOT NULL DEFAULT 'test';`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_status     TEXT NOT NULL DEFAULT 'not_configured';`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_last_error TEXT;`);
  await pool.query(`ALTER TABLE coexistence.razorpay_config ADD COLUMN IF NOT EXISTS api_checked_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.payment_requests (
      id                 BIGSERIAL PRIMARY KEY,
      lead_id            BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      customer_name      TEXT,
      customer_phone     TEXT,
      customer_email     TEXT,
      course_id          BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
      product_label      TEXT,
      purpose            TEXT,
      kind               TEXT NOT NULL DEFAULT 'fixed',
      amount_paise       BIGINT NOT NULL,
      min_amount_paise   BIGINT,
      currency           TEXT NOT NULL DEFAULT 'INR',
      razorpay_link_id   TEXT UNIQUE,
      reference_id       TEXT,
      short_url          TEXT,
      description        TEXT,
      status             TEXT NOT NULL DEFAULT 'created',
      amount_paid_paise  BIGINT NOT NULL DEFAULT 0,
      expire_by          TIMESTAMPTZ,
      paid_at            TIMESTAMPTZ,
      cancelled_at       TIMESTAMPTZ,
      sync_error         TEXT,
      form_id            BIGINT,
      form_submission_id BIGINT,
      created_by         TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE coexistence.payment_requests ADD COLUMN IF NOT EXISTS sync_error TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_lead    ON coexistence.payment_requests(lead_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status  ON coexistence.payment_requests(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_created ON coexistence.payment_requests(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_course  ON coexistence.payment_requests(course_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_phone   ON coexistence.payment_requests(customer_phone);`);

  await pool.query(`ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS payment_request_id BIGINT;`);
  await pool.query(`ALTER TABLE coexistence.razorpay_events ADD COLUMN IF NOT EXISTS razorpay_link_id   TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_events_request ON coexistence.razorpay_events(payment_request_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_events_plink   ON coexistence.razorpay_events(razorpay_link_id);`);
}

// ── Row shape (paise → rupees at the API boundary, never inside) ─────────────
function requestRow(r) {
  return {
    id: Number(r.id),
    leadId: r.lead_id == null ? null : Number(r.lead_id),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    customerEmail: r.customer_email,
    courseId: r.course_id == null ? null : Number(r.course_id),
    productLabel: r.product_name || r.product_label,
    purpose: r.purpose,
    kind: r.kind,
    amount: toRupees(r.amount_paise),
    minAmount: r.min_amount_paise == null ? null : toRupees(r.min_amount_paise),
    amountPaid: toRupees(r.amount_paid_paise),
    // What is still owed on a part payment. Clamped at 0 so an overpayment
    // (Razorpay allows paying more than the minimum) never shows as negative.
    amountDue: Math.max(0, toRupees(r.amount_paise) - toRupees(r.amount_paid_paise)),
    currency: r.currency,
    razorpayLinkId: r.razorpay_link_id,
    referenceId: r.reference_id,
    shortUrl: r.short_url,
    description: r.description,
    status: r.status,
    // A row with no link id never made it to Razorpay — surfaced explicitly so
    // it reads as "not created", never as an unpaid link someone is waiting on.
    created: !!r.razorpay_link_id,
    syncError: r.sync_error,
    expireBy: r.expire_by,
    paidAt: r.paid_at,
    cancelledAt: r.cancelled_at,
    formId: r.form_id == null ? null : Number(r.form_id),
    formSubmissionId: r.form_submission_id == null ? null : Number(r.form_submission_id),
    createdBy: r.created_by,
    createdAt: r.created_at,
    leadStage: r.lead_stage || null,
  };
}

// Non-admins only see requests for a lead assigned to them, OR ones they
// raised themselves (a BDA may create a request before the lead is assigned).
// Mirrors salesLog.js scoping.
function scopeClause(req, params, alias = 'pr') {
  if (isAdmin(req)) return '';
  params.push(meId(req));
  const p = `$${params.length}`;
  return ` AND (EXISTS (SELECT 1 FROM coexistence.leads l WHERE l.id = ${alias}.lead_id AND l.assigned_user_id = ${p})
                OR ${alias}.created_by = (SELECT username FROM coexistence.forgecrm_users WHERE id = ${p}))`;
}

/**
 * Find the lead behind a phone number, creating one only if none exists.
 *
 * Deliberately NOT leads.ensureLeadForContact: that helper stamps
 * has_whatsapp_thread = TRUE, last_inbound_at = NOW() and an actor of
 * 'auto:whatsapp-inbound', all of which are false for someone who has only ever
 * been sent a payment link. Writing them would make the funnel report a
 * conversation that never happened.
 *
 * Matching is on the last 10 digits, like matchPayer / ensureSaleLead — stored
 * numbers vary on whether they carry the country code.
 */
async function findOrCreateLeadForPayment({ phone, name, email }) {
  const num = digits(phone);
  if (num.length < 7) return null;
  const last10 = num.slice(-10);

  const existing = (await pool.query(
    `SELECT id, name, whatsapp_number, email FROM coexistence.leads
      WHERE right(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10) = $1
      ORDER BY id LIMIT 1`, [last10]
  )).rows[0];
  if (existing) return existing;

  const { stages } = require('../services/funnelConfig');
  const first = (stages() || [])[0];
  const stage = first?.stage_key || 'new';

  const { rows } = await pool.query(
    `INSERT INTO coexistence.leads
       (whatsapp_number, name, email, source, stage, has_whatsapp_thread,
        stage_changed_at, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,'Payment link',$4,FALSE,NOW(),NOW(),NOW(),NOW())
     ON CONFLICT (whatsapp_number) DO UPDATE SET updated_at = NOW()
     RETURNING id, name, whatsapp_number, email`,
    [num, name || null, email || null, stage]
  );
  const lead = rows[0];
  await pool.query(
    `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
     VALUES ($1, 'stage_changed', NULL, $2, 'payment-link:created')`,
    [lead.id, stage]
  ).catch(() => {});
  bus.emit('lead-changed', { id: Number(lead.id), reason: 'payment_link_created' });
  return lead;
}

// ── Webhook helpers (called from routes/razorpay.js) ─────────────────────────

/**
 * Resolve a Razorpay payment-link entity to our attribution context.
 *
 * Order matters and is deliberate:
 *   1. our row, found by razorpay_link_id  — the exact key
 *   2. notes.forge_request_id              — same row by a different route
 *   3. notes.forge_lead_id                 — survives a missing local row
 * Returns null when the link was NOT minted here, so the caller falls back to
 * the pre-existing amount/phone matching and historical behaviour is unchanged.
 */
async function resolveLinkContext(plinkEntity) {
  if (!plinkEntity || typeof plinkEntity !== 'object') return null;
  const linkId = plinkEntity.id || null;
  const notes = plinkEntity.notes && typeof plinkEntity.notes === 'object' ? plinkEntity.notes : {};

  let row = null;
  if (linkId) {
    row = (await pool.query(
      `SELECT pr.*, c.name AS product_name FROM coexistence.payment_requests pr
         LEFT JOIN coexistence.courses c ON c.id = pr.course_id
        WHERE pr.razorpay_link_id = $1 LIMIT 1`, [linkId]
    )).rows[0] || null;
  }
  if (!row && notes.forge_request_id) {
    row = (await pool.query(
      `SELECT pr.*, c.name AS product_name FROM coexistence.payment_requests pr
         LEFT JOIN coexistence.courses c ON c.id = pr.course_id
        WHERE pr.id = $1 LIMIT 1`, [parseInt(notes.forge_request_id, 10) || 0]
    )).rows[0] || null;
    // Late-bind the link id we never got to store (create timed out after
    // Razorpay had already made the link).
    if (row && linkId && !row.razorpay_link_id) {
      await pool.query(
        `UPDATE coexistence.payment_requests
            SET razorpay_link_id = $2, short_url = COALESCE(short_url, $3),
                sync_error = NULL, updated_at = NOW()
          WHERE id = $1 AND razorpay_link_id IS NULL`,
        [row.id, linkId, plinkEntity.short_url || null]
      ).catch(() => {});
    }
  }

  if (row) {
    return {
      requestId: Number(row.id),
      linkId,
      leadId: row.lead_id == null ? null : Number(row.lead_id),
      courseId: row.course_id == null ? null : Number(row.course_id),
      courseName: row.product_name || row.product_label || null,
      purpose: row.purpose || null,
    };
  }

  // No local row, but the link still names its lead — better than guessing.
  const noteLeadId = parseInt(notes.forge_lead_id, 10);
  if (Number.isFinite(noteLeadId) && noteLeadId > 0) {
    const lead = (await pool.query(`SELECT id, name FROM coexistence.leads WHERE id = $1`, [noteLeadId])).rows[0];
    if (lead) {
      return { requestId: null, linkId, leadId: Number(lead.id), leadName: lead.name, courseId: null, courseName: null, purpose: null };
    }
  }
  return null;
}

/**
 * Apply a payment-link lifecycle event to our row.
 *
 * `amount_paid` comes from Razorpay's own link entity and is used as the
 * authoritative running total rather than summing payments ourselves — a
 * partial link can be paid several times and the gateway's total is the only
 * one guaranteed to agree with the gateway.
 */
async function applyLinkStatus(plinkEntity) {
  if (!plinkEntity?.id) return null;
  const status = ['created', 'partially_paid', 'paid', 'cancelled', 'expired'].includes(plinkEntity.status)
    ? plinkEntity.status : 'created';
  const paid = Number(plinkEntity.amount_paid || 0);
  const { rows } = await pool.query(
    `UPDATE coexistence.payment_requests
        SET status            = $2,
            amount_paid_paise = GREATEST(amount_paid_paise, $3),
            paid_at           = CASE WHEN $2 = 'paid'      AND paid_at      IS NULL THEN NOW() ELSE paid_at      END,
            cancelled_at      = CASE WHEN $2 = 'cancelled' AND cancelled_at IS NULL THEN NOW() ELSE cancelled_at END,
            sync_error        = NULL,
            updated_at        = NOW()
      WHERE razorpay_link_id = $1
      RETURNING id, lead_id, status`,
    [plinkEntity.id, status, paid]
  );
  if (rows[0]) bus.emit('payment-request-changed', { id: Number(rows[0].id), status: rows[0].status });
  return rows[0] || null;
}

// ── LIST + summary ───────────────────────────────────────────────────────────
router.get('/payment-requests', requirePermission('payments'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { status, leadId, courseId, from, to } = req.query;
    const q = (req.query.q || '').trim();

    const params = [];
    let where = 'WHERE 1=1';
    if (status) { params.push(status); where += ` AND pr.status = $${params.length}`; }
    if (leadId) { params.push(parseInt(leadId, 10)); where += ` AND pr.lead_id = $${params.length}`; }
    if (courseId) { params.push(parseInt(courseId, 10)); where += ` AND pr.course_id = $${params.length}`; }
    if (from) { params.push(from); where += ` AND pr.created_at >= $${params.length}::date`; }
    if (to) { params.push(to); where += ` AND pr.created_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (pr.customer_name ILIKE $${params.length} OR pr.customer_phone ILIKE $${params.length}
                      OR pr.customer_email ILIKE $${params.length} OR pr.purpose ILIKE $${params.length}
                      OR pr.razorpay_link_id ILIKE $${params.length} OR pr.short_url ILIKE $${params.length})`;
    }
    where += scopeClause(req, params);

    const [{ rows }, { rows: [tot] }] = await Promise.all([
      pool.query(
        `SELECT pr.*, c.name AS product_name, l.stage AS lead_stage
           FROM coexistence.payment_requests pr
           LEFT JOIN coexistence.courses c ON c.id = pr.course_id
           LEFT JOIN coexistence.leads   l ON l.id = pr.lead_id
           ${where}
          ORDER BY pr.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.payment_requests pr ${where}`, params),
    ]);
    res.json({ requests: rows.map(requestRow), total: tot.total, limit, offset });
  } catch (err) {
    console.error('[payment-requests] list error:', err.message);
    res.status(500).json({ error: 'Failed to load payment requests' });
  }
});

// KPIs. Every figure comes from ONE query — separate COUNTs can disagree when a
// webhook lands between them.
router.get('/payment-requests/summary', requirePermission('payments'), async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.from) { params.push(req.query.from); where += ` AND pr.created_at >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND pr.created_at < ($${params.length}::date + INTERVAL '1 day')`; }
    where += scopeClause(req, params);

    const { rows: [s] } = await pool.query(
      `SELECT COUNT(*)::int                                                     AS total,
              COUNT(*) FILTER (WHERE pr.status = 'paid')::int                   AS paid,
              COUNT(*) FILTER (WHERE pr.status = 'partially_paid')::int         AS partial,
              COUNT(*) FILTER (WHERE pr.status = 'created')::int                AS pending,
              COUNT(*) FILTER (WHERE pr.status IN ('cancelled','expired'))::int AS closed,
              COUNT(*) FILTER (WHERE pr.razorpay_link_id IS NULL)::int          AS not_created,
              COALESCE(SUM(pr.amount_paid_paise), 0)::bigint                    AS collected_paise,
              COALESCE(SUM(pr.amount_paise) FILTER (WHERE pr.status IN ('created','partially_paid')), 0)::bigint AS outstanding_gross_paise,
              COALESCE(SUM(pr.amount_paid_paise) FILTER (WHERE pr.status IN ('created','partially_paid')), 0)::bigint AS outstanding_paid_paise
         FROM coexistence.payment_requests pr ${where}`, params);

    res.json({
      total: s.total, paid: s.paid, partial: s.partial, pending: s.pending,
      closed: s.closed, notCreated: s.not_created,
      collected: toRupees(s.collected_paise),
      // Still-open links only: what they were raised for, minus what has
      // already come in against them.
      outstanding: Math.max(0, toRupees(s.outstanding_gross_paise) - toRupees(s.outstanding_paid_paise)),
    });
  } catch (err) {
    console.error('[payment-requests] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load payment summary' });
  }
});

// ── CSV export ───────────────────────────────────────────────────────────────
// A reconciliation artifact for accounting — NOT a re-import path. A link we
// minted attributes itself through the webhook, so there is nothing to feed
// back by hand; a manual round-trip would just reintroduce the drift.
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/payment-requests/export', requirePermission('payments'), async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.status) { params.push(req.query.status); where += ` AND pr.status = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); where += ` AND pr.created_at >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND pr.created_at < ($${params.length}::date + INTERVAL '1 day')`; }
    where += scopeClause(req, params);

    const { rows } = await pool.query(
      `SELECT pr.*, c.name AS product_name
         FROM coexistence.payment_requests pr
         LEFT JOIN coexistence.courses c ON c.id = pr.course_id
         ${where} ORDER BY pr.created_at DESC LIMIT 10000`, params);

    const header = [
      'Created', 'Customer', 'Phone', 'Email', 'Product', 'Purpose', 'Type',
      'Amount', 'Minimum', 'Paid', 'Due', 'Status', 'Paid on',
      'Razorpay link id', 'Reference', 'Link URL', 'Raised by',
    ];
    const lines = [header.join(',')];
    rows.forEach(r => {
      const row = requestRow(r);
      lines.push([
        row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : '',
        row.customerName, row.customerPhone, row.customerEmail,
        row.productLabel, row.purpose, row.kind,
        row.amount, row.minAmount == null ? '' : row.minAmount,
        row.amountPaid, row.amountDue,
        row.created ? row.status : 'not_created',
        row.paidAt ? new Date(row.paidAt).toISOString().slice(0, 10) : '',
        row.razorpayLinkId, row.referenceId, row.shortUrl, row.createdBy,
      ].map(csvCell).join(','));
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payment-requests-${stamp}.csv"`);
    // BOM so Excel opens ₹ and non-ASCII names correctly.
    res.send('﻿' + lines.join('\n'));
  } catch (err) {
    console.error('[payment-requests] export error:', err.message);
    res.status(500).json({ error: 'Failed to export payment requests' });
  }
});

// ── DETAIL (+ the gateway events booked against it) ──────────────────────────
router.get('/payment-requests/:id', requirePermission('payments'), async (req, res) => {
  try {
    const params = [parseInt(req.params.id, 10)];
    const scope = scopeClause(req, params);
    const { rows } = await pool.query(
      `SELECT pr.*, c.name AS product_name, l.stage AS lead_stage
         FROM coexistence.payment_requests pr
         LEFT JOIN coexistence.courses c ON c.id = pr.course_id
         LEFT JOIN coexistence.leads   l ON l.id = pr.lead_id
        WHERE pr.id = $1 ${scope}`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment request not found' });

    // Dedupe by payment_id: Razorpay writes payment.captured, order.paid AND
    // payment_link.paid for ONE payment — three rows with status='captured'.
    // Summing them without this triples the figure.
    const { rows: events } = await pool.query(
      `SELECT DISTINCT ON (payment_id)
              id, received_at, event_type, payment_id, amount_paise, status, method, payer_contact
         FROM coexistence.razorpay_events
        WHERE payment_request_id = $1 AND payment_id IS NOT NULL
        ORDER BY payment_id, (event_type = 'payment.captured') DESC, received_at ASC`,
      [req.params.id]
    );
    res.json({
      request: requestRow(rows[0]),
      payments: events.map(e => ({
        id: Number(e.id), receivedAt: e.received_at, eventType: e.event_type,
        paymentId: e.payment_id, amount: toRupees(e.amount_paise),
        status: e.status, method: e.method, payerContact: e.payer_contact,
      })),
    });
  } catch (err) {
    console.error('[payment-requests] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load payment request' });
  }
});

// ── CREATE ───────────────────────────────────────────────────────────────────
// Sequence: insert a local row (to get an id) → call Razorpay with that id in
// notes → store the link. The id must exist BEFORE the call, which is what
// makes the row-then-call order mandatory rather than stylistic.
router.post('/payment-requests', requirePermission('payments'), async (req, res) => {
  const {
    leadId, customerName, customerPhone, customerEmail,
    courseId, purpose, kind = 'fixed',
    amount, minAmount, description,
    notifySms = false, notifyEmail = false, reminderEnable = false,
    expireBy, formId, formSubmissionId,
  } = req.body || {};

  try {
    if (!['fixed', 'partial', 'open'].includes(kind)) {
      return res.status(400).json({ error: 'Payment type must be Fixed, Part payment or Open amount.' });
    }
    const amountPaise = toPaise(amount);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      return res.status(400).json({ error: 'Enter an amount of at least ₹1.' });
    }

    // 'open' is modelled as a partial link with a low floor: Razorpay requires
    // an amount on every link, so a truly amount-less link does not exist. The
    // figure shown is a suggestion and the payer may pay less.
    let minPaise = null;
    const acceptPartial = kind === 'partial' || kind === 'open';
    if (kind === 'partial') {
      minPaise = toPaise(minAmount);
      if (!Number.isFinite(minPaise) || minPaise < 100) {
        return res.status(400).json({ error: 'A part payment needs a minimum first amount of at least ₹1.' });
      }
      if (minPaise > amountPaise) {
        return res.status(400).json({ error: 'The minimum first payment cannot be more than the total amount.' });
      }
    } else if (kind === 'open') {
      minPaise = 100;   // ₹1 floor — the lowest Razorpay accepts
    }

    const phone = digits(customerPhone);

    // Resolve the lead. An explicit leadId wins; otherwise find-or-create by
    // phone via the same idempotent helper the WhatsApp webhook uses, so a
    // payment request never forks a second record for an existing person.
    let lead = null;
    if (leadId) {
      lead = (await pool.query(
        `SELECT id, name, whatsapp_number, email FROM coexistence.leads WHERE id = $1`, [leadId]
      )).rows[0] || null;
      if (!lead) return res.status(404).json({ error: 'That lead no longer exists.' });
    } else if (phone.length >= 7) {
      lead = await findOrCreateLeadForPayment({ phone, name: customerName, email: customerEmail });
    }
    if (!lead && !phone && !customerEmail) {
      return res.status(400).json({ error: 'Pick a lead, or enter a phone number or email for the customer.' });
    }

    const product = courseId
      ? (await pool.query(`SELECT id, name FROM coexistence.courses WHERE id = $1`, [courseId])).rows[0] || null
      : null;

    const finalPhone = phone || digits(lead?.whatsapp_number);
    const finalName = customerName || lead?.name || null;
    const finalEmail = customerEmail || lead?.email || null;

    // 1. Local row first — its id is what gets stamped into Razorpay notes.
    const { rows: [draft] } = await pool.query(
      `INSERT INTO coexistence.payment_requests
         (lead_id, customer_name, customer_phone, customer_email, course_id, product_label,
          purpose, kind, amount_paise, min_amount_paise, description, expire_by,
          form_id, form_submission_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [lead?.id || null, finalName, finalPhone || null, finalEmail, product?.id || null, product?.name || null,
       purpose?.trim() || null, kind, amountPaise, minPaise, description?.trim() || null,
       expireBy || null, formId || null, formSubmissionId || null, req.user?.username || null]
    );

    // 2. Mint the link.
    let link;
    try {
      link = await rzp.createPaymentLink({
        amountPaise,
        description: description?.trim() || [product?.name, purpose].filter(Boolean).join(' — ') || 'Payment',
        referenceId: `fg-req-${draft.id}`,
        customerName: finalName,
        customerEmail: finalEmail,
        customerPhone: finalPhone ? `+${finalPhone}` : null,
        acceptPartial,
        firstMinPartialPaise: minPaise,
        notify: { sms: !!notifySms, email: !!notifyEmail },
        reminderEnable: !!reminderEnable,
        expireBy: expireBy || null,
        notes: {
          forge_request_id: draft.id,
          forge_lead_id: lead?.id || '',        // the fallback key — see file header
          forge_product_id: product?.id || '',
          forge_purpose: purpose || '',
        },
      });
    } catch (err) {
      // A 4xx is Razorpay definitively refusing — nothing was created, so the
      // draft is noise and gets removed. A network/timeout error is NOT
      // definitive: the link may exist. That row is kept and flagged, because
      // deleting it would orphan a live link that is about to be paid.
      if (err.retriable || err.code === 'NETWORK') {
        await pool.query(
          `UPDATE coexistence.payment_requests SET sync_error = $2, updated_at = NOW() WHERE id = $1`,
          [draft.id, 'Razorpay did not confirm this link. Use Refresh, or check the Razorpay dashboard before creating another.']
        ).catch(() => {});
        return res.status(502).json({
          error: 'Razorpay did not confirm the link was created. Check the Razorpay dashboard before trying again — it may already exist.',
          requestId: Number(draft.id),
        });
      }
      await pool.query(`DELETE FROM coexistence.payment_requests WHERE id = $1`, [draft.id]).catch(() => {});
      return res.status(err.status || 502).json({ error: err.message });
    }

    // 3. Store what Razorpay gave back.
    const { rows: [saved] } = await pool.query(
      `UPDATE coexistence.payment_requests
          SET razorpay_link_id = $2, reference_id = $3, short_url = $4,
              status = $5, sync_error = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [draft.id, link.id, link.reference_id || `fg-req-${draft.id}`, link.short_url,
       ['created', 'partially_paid', 'paid', 'cancelled', 'expired'].includes(link.status) ? link.status : 'created']
    );

    bus.emit('payment-request-changed', { id: Number(draft.id), status: saved.status });
    res.status(201).json(requestRow({ ...saved, product_name: product?.name || null }));
  } catch (err) {
    console.error('[payment-requests] create error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create the payment link' });
  }
});

// ── REFRESH (reconcile one row against Razorpay) ─────────────────────────────
router.post('/payment-requests/:id/refresh', requirePermission('payments'), async (req, res) => {
  try {
    const params = [parseInt(req.params.id, 10)];
    const scope = scopeClause(req, params);
    const { rows } = await pool.query(
      `SELECT pr.* FROM coexistence.payment_requests pr WHERE pr.id = $1 ${scope}`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment request not found' });
    const row = rows[0];
    if (!row.razorpay_link_id) {
      return res.status(400).json({ error: 'This request never reached Razorpay, so there is nothing to refresh. Delete it and create a new one.' });
    }
    const link = await rzp.fetchPaymentLink(row.razorpay_link_id);
    await applyLinkStatus(link);
    const { rows: [fresh] } = await pool.query(
      `SELECT pr.*, c.name AS product_name FROM coexistence.payment_requests pr
         LEFT JOIN coexistence.courses c ON c.id = pr.course_id WHERE pr.id = $1`, [row.id]);
    res.json(requestRow(fresh));
  } catch (err) {
    console.error('[payment-requests] refresh error:', err.message);
    res.status(err.status || 502).json({ error: err.message || 'Could not refresh from Razorpay' });
  }
});

// ── CANCEL ───────────────────────────────────────────────────────────────────
router.post('/payment-requests/:id/cancel', requirePermission('payments'), async (req, res) => {
  try {
    const params = [parseInt(req.params.id, 10)];
    const scope = scopeClause(req, params);
    const { rows } = await pool.query(
      `SELECT pr.* FROM coexistence.payment_requests pr WHERE pr.id = $1 ${scope}`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment request not found' });
    const row = rows[0];
    if (row.status === 'paid') return res.status(400).json({ error: 'This link has already been paid — it cannot be cancelled.' });

    if (row.razorpay_link_id) {
      // Razorpay only cancels a link in 'created'. Anything else (already
      // cancelled/expired/partially paid) comes back as a 4xx we surface as-is.
      await rzp.cancelPaymentLink(row.razorpay_link_id);
    }
    const { rows: [saved] } = await pool.query(
      `UPDATE coexistence.payment_requests
          SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`, [row.id]);
    bus.emit('payment-request-changed', { id: Number(row.id), status: 'cancelled' });
    res.json(requestRow(saved));
  } catch (err) {
    console.error('[payment-requests] cancel error:', err.message);
    res.status(err.status || 502).json({ error: err.message || 'Could not cancel the link' });
  }
});

// ── DELETE (admin) — only for a row that never reached Razorpay ──────────────
// A real link is cancelled, never deleted: its payments are already booked
// against it in the event log.
router.delete('/payment-requests/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT razorpay_link_id FROM coexistence.payment_requests WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment request not found' });
    if (rows[0].razorpay_link_id) {
      return res.status(400).json({ error: 'This link exists in Razorpay. Cancel it instead of deleting, so its payment history stays intact.' });
    }
    await pool.query(`DELETE FROM coexistence.payment_requests WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[payment-requests] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the payment request' });
  }
});

module.exports = { router, ensurePaymentRequestTables, resolveLinkContext, applyLinkStatus };
