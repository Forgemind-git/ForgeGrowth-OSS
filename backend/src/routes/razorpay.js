// ─── Razorpay webhook integration ─────────────────────────────────────────────
// Receives Razorpay webhooks (payments + refunds) at a PUBLIC endpoint, verifies
// the HMAC-SHA256 signature against the stored webhook secret, stores each event,
// and links a captured payment to a matching CRM lead + contact (by phone/email),
// stamping the lead as paid + enrolled. Admin routes manage the secret and browse
// the event history.
//
// Two routers are exported:
//   publicRouter  — POST /webhook/razorpay          (mounted in the public block)
//   router        — /razorpay/config | /events | /status  (admin-only)
//
// The receiver needs the RAW request body to verify Razorpay's signature, so
// index.js mounts express.raw() on /api/webhook/razorpay BEFORE express.json().

const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const bus = require('../events');
const { encrypt, decrypt } = require('../util/crypto');
const { adminOnly, requirePermission } = require('../middleware/access');
const { syncRazorpayPayments } = require('../services/razorpayLedger');
const { matchLink, applyCoursePayment } = require('./courses');
const { resolveLinkContext, applyLinkStatus } = require('./paymentRequests');
const rzpClient = require('../integrations/razorpayClient');
const { modeFromKeyId } = rzpClient;

const publicRouter = Router();
const router = Router();

// ── Schema (idempotent; runtime source of truth, mirrors migration 061) ─────────
async function ensureRazorpayTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.razorpay_config (
      id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      webhook_secret_encrypted TEXT,
      key_id                  TEXT,
      status                  TEXT NOT NULL DEFAULT 'disconnected'
                                CHECK (status IN ('connected','disconnected','error')),
      last_event_at           TIMESTAMPTZ,
      last_error              TEXT,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO coexistence.razorpay_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.razorpay_events (
      id                    BIGSERIAL PRIMARY KEY,
      received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      razorpay_event_id     TEXT UNIQUE,
      event_type            TEXT,
      entity_type           TEXT,               -- payment | refund
      payment_id            TEXT,
      order_id              TEXT,
      refund_id             TEXT,
      amount_paise          BIGINT,
      currency              TEXT,
      status                TEXT,               -- captured | failed | refunded | processed …
      payer_email           TEXT,
      payer_contact         TEXT,               -- digits-only
      method                TEXT,               -- upi | card | netbanking …
      notes                 JSONB,
      signature_valid       BOOLEAN NOT NULL DEFAULT FALSE,
      match_method          TEXT,               -- phone | email | payment_id | null
      matched_lead_id       BIGINT,
      matched_lead_name     TEXT,
      matched_contact_number TEXT,
      matched_contact_name  TEXT,
      remote_ip             TEXT,
      payload               JSONB,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_events_received ON coexistence.razorpay_events(received_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rzp_events_payment  ON coexistence.razorpay_events(payment_id);`);
}

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));

function safeEqualHex(a, b) {
  try {
    const ab = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch { return false; }
}

// Find a lead (by phone or email) and a contact (by phone) to attribute a payment.
async function matchPayer({ contact, email }) {
  const phone = digits(contact);
  const last10 = phone.slice(-10);
  let matched = { matchMethod: null, leadId: null, leadName: null, contactNumber: null, contactName: null };

  // Lead: phone first, then email
  if (last10 || email) {
    const { rows } = await pool.query(
      `SELECT id, name, whatsapp_number, email
         FROM coexistence.leads
        WHERE ($1 <> '' AND right(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10) = $1)
           OR ($2 <> '' AND lower(email) = lower($2))
        ORDER BY (CASE WHEN $1 <> '' AND right(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10) = $1 THEN 0 ELSE 1 END)
        LIMIT 1`,
      [last10, email || '']
    );
    if (rows[0]) {
      matched.leadId = rows[0].id;
      matched.leadName = rows[0].name;
      matched.matchMethod = (last10 && digits(rows[0].whatsapp_number).slice(-10) === last10) ? 'phone' : 'email';
    }
  }
  // Contact (by phone only — contacts table has no email column)
  if (last10) {
    const { rows } = await pool.query(
      `SELECT contact_number, COALESCE(name, profile_name) AS name
         FROM coexistence.contacts
        WHERE right(regexp_replace(contact_number, '\\D', '', 'g'), 10) = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [last10]
    );
    if (rows[0]) {
      matched.contactNumber = rows[0].contact_number;
      matched.contactName = rows[0].name;
      if (!matched.matchMethod) matched.matchMethod = 'phone';
    }
  }
  return matched;
}

// Extract the paying-customer profile from a payment's notes + payer fields.
// The Razorpay payment page collects full_name / email / phone (or whatsapp_number)
// / age / profession / pincode as `notes`. full_name is sometimes just the email
// (customer typed their email in the name box) — treat that as no name.
function extractProfile(notes, payerContact, payerEmail) {
  const n = notes && typeof notes === 'object' ? notes : {};
  const rawName = (n.full_name || '').toString().trim();
  const name = rawName && !rawName.includes('@') ? rawName : null;
  const ageNum = parseInt(n.age, 10);
  return {
    name,
    email: payerEmail || n.email || null,
    phone: digits(payerContact || n.phone || n.whatsapp_number),
    age: Number.isFinite(ageNum) ? ageNum : null,
    profession: (n.profession || '').toString().trim() || null,
    pincode: (n.pincode || '').toString().trim() || null,
  };
}

// Find-or-create the lead behind a captured payment that matched no CRM lead, so
// the payer still shows up in the Sales Log. Requires a phone (leads.whatsapp_number
// is NOT NULL). Enrolls it (a captured payment = a won sale).
async function ensureSaleLead(profile) {
  const phone = digits(profile.phone);
  if (phone.length < 7) return null;
  const last10 = phone.slice(-10);
  const { rows: found } = await pool.query(
    `SELECT id FROM coexistence.leads WHERE right(regexp_replace(whatsapp_number,'\\D','','g'),10)=$1 ORDER BY id LIMIT 1`,
    [last10]
  );
  if (found[0]) return found[0].id;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.leads (whatsapp_number, name, email, source, stage, has_whatsapp_thread, payment_date, stage_changed_at, created_at, updated_at)
     VALUES ($1,$2,$3,'Direct','enrolled',FALSE,CURRENT_DATE,NOW(),NOW(),NOW())
     ON CONFLICT (whatsapp_number) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [phone, profile.name, profile.email]
  );
  const leadId = rows[0].id;
  await pool.query(
    `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
     VALUES ($1, 'stage_changed', NULL, 'enrolled', 'razorpay:webhook')`,
    [leadId]
  ).catch(() => {});
  return leadId;
}

// Fill blank profile fields on the lead from the payment (COALESCE(existing, new) —
// gateway data never clobbers a value a human already set).
async function applySaleProfile(leadId, p) {
  await pool.query(
    `UPDATE coexistence.leads
        SET name       = COALESCE(name, $2),
            email      = COALESCE(email, $3),
            age        = COALESCE(age, $4),
            profession = COALESCE(profession, $5),
            pincode    = COALESCE(pincode, $6),
            updated_at = NOW()
      WHERE id = $1`,
    [leadId, p.name, p.email, p.age, p.profession, p.pincode]
  ).catch((err) => console.error('[razorpay] profile enrich:', err.message));
}

// ── PUBLIC: receiver ────────────────────────────────────────────────────────────
// req.body is a Buffer (express.raw mounted on this path in index.js).
publicRouter.post('/webhook/razorpay', async (req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}), 'utf8');
  const sigHeader = req.headers['x-razorpay-signature'] || '';
  const eventIdHeader = req.headers['x-razorpay-event-id'] || null;

  try {
    // Load secret
    const { rows: cfgRows } = await pool.query('SELECT webhook_secret_encrypted FROM coexistence.razorpay_config WHERE id = 1');
    const secret = cfgRows[0]?.webhook_secret_encrypted ? decrypt(cfgRows[0].webhook_secret_encrypted) : '';

    // Verify signature
    let signatureValid = false;
    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
      signatureValid = safeEqualHex(expected, sigHeader);
    }

    // Parse payload (even if signature is bad — we still log the attempt)
    let body = {};
    try { body = JSON.parse(rawBuf.toString('utf8')); } catch { /* keep {} */ }

    if (!secret) {
      await pool.query(
        `UPDATE coexistence.razorpay_config SET status = 'error', last_error = $1, updated_at = NOW() WHERE id = 1`,
        ['Received a webhook but no secret is configured — set the webhook secret to verify events.']
      ).catch(() => {});
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }
    if (!signatureValid) {
      // Log the rejected attempt for visibility, then 400 so Razorpay flags it.
      await pool.query(
        `INSERT INTO coexistence.razorpay_events
           (razorpay_event_id, event_type, signature_valid, remote_ip, payload)
         VALUES ($1, $2, FALSE, $3, $4)
         ON CONFLICT (razorpay_event_id) DO NOTHING`,
        [eventIdHeader, body.event || null, remoteIp, body]
      ).catch(() => {});

      // ⚠ Only a request that actually LOOKS like Razorpay may flag the
      // integration as broken. This endpoint is public and internet-reachable
      // by necessity (Razorpay has no cookie), so any bot probing /api/* can
      // POST here — and a blanket flag let one stray unsigned request pin the
      // Webhooks panel to "error" until the next genuine event, which may be
      // weeks away. A badge that cries wolf is worse than no badge.
      //
      // Genuine Razorpay deliveries ALWAYS carry x-razorpay-signature. Header
      // present but HMAC mismatched = a real secret mismatch, which is exactly
      // the misconfiguration this alarm exists for, so that still flags.
      if (sigHeader) {
        await pool.query(
          `UPDATE coexistence.razorpay_config
              SET status = 'error', last_error = 'Signature verification failed', updated_at = NOW()
            WHERE id = 1`
        ).catch(() => {});
      } else {
        console.warn(`[razorpay] unsigned POST from ${remoteIp} ignored (not Razorpay — no signature header)`);
      }
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ── Extract entity ──
    const eventType = body.event || '';                       // e.g. payment.captured
    const isRefund = eventType.startsWith('refund.');
    const payEntity = body.payload?.payment?.entity || null;
    const refEntity = body.payload?.refund?.entity || null;
    // payment_link.* events carry the link entity. `payment_link.paid` ALSO
    // carries a payment entity (so it behaves exactly like before); expired and
    // cancelled do not, and used to store as an all-NULL row.
    const plinkEntity = body.payload?.payment_link?.entity || null;
    const isLinkOnly = eventType.startsWith('payment_link.') && !payEntity;
    const entity = isRefund ? refEntity : (payEntity || (isLinkOnly ? plinkEntity : null));
    const entityType = isRefund ? 'refund' : (isLinkOnly ? 'payment_link' : 'payment');

    // Refund entities carry payment_id but not contact/email — inherit those from
    // the earlier payment event we already stored.
    let payerContact = digits(payEntity?.contact);
    let payerEmail = payEntity?.email || null;
    const paymentId = payEntity?.id || refEntity?.payment_id || null;
    if (isRefund && paymentId) {
      const { rows: prior } = await pool.query(
        `SELECT payer_contact, payer_email FROM coexistence.razorpay_events
          WHERE payment_id = $1 AND entity_type = 'payment' ORDER BY received_at DESC LIMIT 1`,
        [paymentId]
      );
      if (prior[0]) { payerContact = payerContact || prior[0].payer_contact; payerEmail = payerEmail || prior[0].payer_email; }
    }

    const amountPaise = entity?.amount != null ? Number(entity.amount) : null;
    const currency = entity?.currency || null;
    const status = entity?.status || (isRefund ? 'refunded' : null);
    const method = payEntity?.method || null;
    const orderId = payEntity?.order_id || null;
    const refundId = isRefund ? (refEntity?.id || null) : null;
    const notes = entity?.notes || payEntity?.notes || {};
    const description = payEntity?.description || null;

    // ── Match payer to a lead + contact ──
    const match = await matchPayer({ contact: payerContact, email: payerEmail });
    if (!match.matchMethod && isRefund && paymentId) match.matchMethod = null; // refunds inherit below if needed

    // ── EXACT attribution for a link ForgeGrowth minted ──────────────────────
    // A link payment produces THREE events. Only `payment_link.paid` carries the
    // payment_link entity, and it arrives ~300ms AFTER `payment.captured` — so
    // resolving solely from that entity would let payment.captured run the
    // auto-create fallback first and fork a duplicate lead before the exact
    // answer ever arrived.
    //
    // Razorpay stamps a link-originated payment's DESCRIPTION with the link id
    // minus its `plink_` prefix (observed live: plink_ExampleLinkId01 →
    // "#ExampleLinkId01"). That is what lets every event in the group resolve to
    // the same request. Note: the link's `notes` are NOT copied onto the
    // payment entity (verified on live data — it arrives as an empty array), so
    // the description is the load-bearing key here, not the notes.
    const linkIdFromDescription = (d) => {
      const m = /^#([A-Za-z0-9_-]+)$/.exec(String(d || '').trim());
      return m ? `plink_${m[1]}` : null;
    };
    const safeNotes = (n) => (n && typeof n === 'object' && !Array.isArray(n)) ? n : {};
    const linkForResolve = plinkEntity || (() => {
      const id = linkIdFromDescription(description);
      return id ? { id, notes: safeNotes(payEntity?.notes) } : null;
    })();

    const linkCtx = linkForResolve
      ? await resolveLinkContext(linkForResolve).catch((err) => {
          console.error('[razorpay] link resolve:', err.message); return null;
        })
      : null;

    // An id beats a guess: override the phone/email match outright.
    if (linkCtx?.leadId) {
      const owner = (await pool.query(
        `SELECT id, name FROM coexistence.leads WHERE id = $1`, [linkCtx.leadId]
      )).rows[0];
      if (owner) {
        match.leadId = Number(owner.id);
        match.leadName = owner.name || match.leadName;
        match.matchMethod = 'payment_link';
        // Keep the contact row we found by phone (used for tagging) — but if
        // there wasn't one, look it up from the lead's own number instead of
        // the payer's, since they can differ.
        if (!match.contactNumber) {
          const c = (await pool.query(
            `SELECT contact_number, COALESCE(name, profile_name) AS name FROM coexistence.contacts
              WHERE right(regexp_replace(contact_number, '\\D', '', 'g'), 10) =
                    (SELECT right(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10)
                       FROM coexistence.leads WHERE id = $1)
              ORDER BY updated_at DESC LIMIT 1`, [linkCtx.leadId]
          )).rows[0];
          if (c) { match.contactNumber = c.contact_number; match.contactName = c.name; }
        }
      }
    }

    // ── A captured payment with no matching lead auto-creates the sale, so the
    //    payer appears in the Sales Log with their Razorpay-page details. ──
    const profile = extractProfile(notes, payerContact, payerEmail);
    if (eventType === 'payment.captured' && !match.leadId && profile.phone) {
      const newLeadId = await ensureSaleLead(profile).catch((err) => { console.error('[razorpay] auto-create sale:', err.message); return null; });
      if (newLeadId) {
        match.leadId = newLeadId;
        match.leadName = profile.name || match.leadName;
        match.matchMethod = match.matchMethod || 'auto_created';
      }
    }

    // ── Attribute to a product ──
    // A request we minted NAMES its product, so there is nothing to infer.
    // Amount-matching survives only as the fallback for links created outside
    // ForgeGrowth (and for the historical events already in the log).
    const notesText = notes && typeof notes === 'object' ? Object.values(notes).join(' ') : '';
    const course = (linkCtx?.courseId
      ? { course_id: linkCtx.courseId, course_name: linkCtx.courseName, payment_link_id: null }
      : null)
      ?? await matchLink(amountPaise, `${description || ''} ${notesText}`).catch(() => null);

    // Idempotent insert (Razorpay retries reuse the same x-razorpay-event-id).
    const { rows: ins } = await pool.query(
      `INSERT INTO coexistence.razorpay_events
         (razorpay_event_id, event_type, entity_type, payment_id, order_id, refund_id,
          amount_paise, currency, status, payer_email, payer_contact, method, notes,
          signature_valid, match_method, matched_lead_id, matched_lead_name,
          matched_contact_number, matched_contact_name, remote_ip, payload,
          course_id, payment_link_id, description,
          payment_request_id, razorpay_link_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (razorpay_event_id) DO NOTHING
       RETURNING id`,
      [eventIdHeader, eventType, entityType, paymentId, orderId, refundId,
       amountPaise, currency, status, payerEmail, payerContact, method, notes,
       match.matchMethod, match.leadId, match.leadName,
       match.contactNumber, match.contactName, remoteIp, body,
       course?.course_id || null, course?.payment_link_id || null, description,
       linkCtx?.requestId || null, linkForResolve?.id || null]
    );

    // Already processed (duplicate delivery) — ack without side-effects.
    if (ins.length === 0) {
      await pool.query(`UPDATE coexistence.razorpay_config SET status = 'connected', last_event_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = 1`).catch(() => {});
      return res.json({ ok: true, duplicate: true });
    }

    // ── Keep our payment_requests row in step with the gateway ──────────────
    // Only `payment_link.*` events carry the link entity, and its `amount_paid`
    // is the gateway's own running total — the only figure guaranteed to stay
    // correct across several instalments on a part-payment link. Summing our
    // captured events instead would triple-count (payment.captured, order.paid
    // AND payment_link.paid all land with status='captured').
    if (plinkEntity) {
      await applyLinkStatus(plinkEntity).catch(err => console.error('[razorpay] link status:', err.message));
    }

    // ── On a captured payment, stamp the matched lead as paid + enrolled ──
    if (eventType === 'payment.captured' && match.leadId) {
      await applySaleProfile(match.leadId, profile);
      const { rows: lrows } = await pool.query(
        `UPDATE coexistence.leads
            SET payment_date = COALESCE(payment_date, CURRENT_DATE),
                stage = CASE WHEN stage NOT IN ('enrolled','cold_lost') THEN 'enrolled' ELSE stage END,
                stage_changed_at = CASE WHEN stage NOT IN ('enrolled','cold_lost') THEN NOW() ELSE stage_changed_at END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, stage, (xmax::text) AS _x`,
        [match.leadId]
      );
      // Audit + SSE (only meaningful when the lead exists)
      if (lrows[0]) {
        await pool.query(
          `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
           VALUES ($1, 'stage_changed', NULL, 'enrolled', 'razorpay:webhook')`,
          [match.leadId]
        ).catch(() => {});
        bus.emit('lead-changed', { id: match.leadId, reason: 'razorpay_payment' });
      }
    }

    // ── On a captured course payment, stamp the lead + tag the contact ──
    if (eventType === 'payment.captured' && course?.course_id && (match.leadId || match.contactNumber)) {
      await applyCoursePayment({ leadId: match.leadId, contactNumber: match.contactNumber, courseName: course.course_name, amountPaise }).catch(err => console.error('[razorpay] course side-effect:', err.message));
    }

    await pool.query(`UPDATE coexistence.razorpay_config SET status = 'connected', last_event_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = 1`).catch(() => {});
    bus.emit('razorpay-event', { id: ins[0].id, eventType });
    return res.json({ ok: true, id: ins[0].id, matched: !!match.matchMethod });
  } catch (err) {
    console.error('[razorpay] webhook error:', err.message);
    // Return 200 so Razorpay doesn't hammer retries on our internal bug — the
    // failure is logged server-side. (Signature/secret failures already 400'd.)
    return res.status(200).json({ ok: false });
  }
});

// ── ADMIN: status summary (for the card) ────────────────────────────────────────
router.get('/razorpay/status', adminOnly, async (req, res) => {
  try {
    const [{ rows: cfg }, { rows: [{ total }] }, { rows: matched }] = await Promise.all([
      pool.query(CONFIG_SELECT),
      pool.query('SELECT COUNT(*)::int AS total FROM coexistence.razorpay_events'),
      pool.query("SELECT COUNT(*)::int AS matched FROM coexistence.razorpay_events WHERE matched_lead_id IS NOT NULL OR matched_contact_number IS NOT NULL"),
    ]);
    res.json({
      ...configShape(cfg[0]),
      totalEvents: total || 0,
      matchedEvents: matched[0]?.matched || 0,
    });
  } catch (err) {
    console.error('[razorpay] status error:', err.message);
    res.status(500).json({ error: 'Failed to load Razorpay status' });
  }
});

// ── ADMIN: config (secret is write-only; never returned) ────────────────────────
// The two halves are reported SEPARATELY on purpose. `status` describes the
// inbound webhook; `apiStatus` describes outbound API access. Conflating them
// is what made "connected" misleading for months — the webhook was verified and
// receiving while key_id sat empty and no API call was possible.
const CONFIG_SELECT = `
  SELECT key_id, status, last_event_at, last_error,
         (webhook_secret_encrypted IS NOT NULL) AS has_secret,
         (key_secret_encrypted    IS NOT NULL) AS has_api_keys,
         key_mode, api_status, api_last_error, api_checked_at
    FROM coexistence.razorpay_config WHERE id = 1`;

function configShape(c = {}) {
  return {
    keyId: c.key_id || '',
    status: c.status || 'disconnected',
    hasSecret: !!c.has_secret,
    lastEventAt: c.last_event_at || null,
    lastError: c.last_error || null,
    // Outbound half
    hasApiKeys: !!c.has_api_keys,
    keyMode: c.key_mode || 'test',
    apiStatus: c.api_status || 'not_configured',
    apiLastError: c.api_last_error || null,
    apiCheckedAt: c.api_checked_at || null,
  };
}

router.get('/razorpay/config', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(CONFIG_SELECT);
    res.json(configShape(rows[0]));
  } catch (err) {
    console.error('[razorpay] get config error:', err.message);
    res.status(500).json({ error: 'Failed to load Razorpay config' });
  }
});

router.put('/razorpay/config', adminOnly, async (req, res) => {
  try {
    const { webhookSecret, keyId, keySecret } = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    // Each secret follows the same contract: a non-empty string sets it, ''
    // clears it, undefined leaves it alone. That is what lets the UI show a
    // blank field for an already-stored secret without wiping it on save.
    if (webhookSecret !== undefined) {
      if (webhookSecret && webhookSecret.trim()) {
        sets.push(`webhook_secret_encrypted = $${i++}`); params.push(encrypt(webhookSecret.trim()));
        sets.push(`status = 'connected'`);
        sets.push(`last_error = NULL`);
      } else {
        sets.push(`webhook_secret_encrypted = NULL`);
        sets.push(`status = 'disconnected'`);
      }
    }
    if (keyId !== undefined) {
      const trimmed = keyId?.trim() || null;
      if (trimmed && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'That does not look like a Razorpay Key ID. It should start with rzp_test_ or rzp_live_.' });
      }
      sets.push(`key_id = $${i++}`); params.push(trimmed);
      // Mode is DERIVED from the key id, never typed. A stored toggle can
      // disagree with the key in hand; "I thought I was still in test mode" is
      // the one mistake here that spends real money.
      sets.push(`key_mode = $${i++}`); params.push(modeFromKeyId(trimmed) === 'live' ? 'live' : 'test');
    }
    if (keySecret !== undefined) {
      if (keySecret && keySecret.trim()) {
        sets.push(`key_secret_encrypted = $${i++}`); params.push(encrypt(keySecret.trim()));
      } else {
        sets.push(`key_secret_encrypted = NULL`);
      }
      // Any credential change invalidates the last verification result — a
      // stale green tick next to a freshly-pasted wrong key is worse than none.
      sets.push(`api_status = 'not_configured'`);
      sets.push(`api_last_error = NULL`);
      sets.push(`api_checked_at = NULL`);
    }
    await pool.query(`UPDATE coexistence.razorpay_config SET ${sets.join(', ')} WHERE id = 1`, params);
    const { rows } = await pool.query(CONFIG_SELECT);
    res.json(configShape(rows[0]));
  } catch (err) {
    console.error('[razorpay] save config error:', err.message);
    res.status(500).json({ error: 'Failed to save Razorpay config' });
  }
});

// Prove the OUTBOUND half works. The webhook being connected says nothing about
// API access, so this is the only honest way to report it — and it is a real
// authenticated read, not a credential-shape check.
router.post('/razorpay/test-api', adminOnly, async (req, res) => {
  try {
    const result = await rzpClient.testApiAccess();
    await pool.query(
      `UPDATE coexistence.razorpay_config
          SET api_status = 'connected', api_last_error = NULL, api_checked_at = NOW(),
              key_mode = $1, updated_at = NOW()
        WHERE id = 1`,
      [result.mode === 'live' ? 'live' : 'test']
    );
    res.json({ ok: true, keyId: result.keyId, mode: result.mode });
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.razorpay_config
          SET api_status = 'error', api_last_error = $1, api_checked_at = NOW(), updated_at = NOW()
        WHERE id = 1`,
      [err.message]
    ).catch(() => {});
    console.error('[razorpay] test api error:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ── ADMIN: event history (paged) ────────────────────────────────────────────────
// ── Payment ledger (pulled from Razorpay, read-only) ────────────────────────
// Distinct from /razorpay/events, which is the webhook audit trail. This is
// what Razorpay actually holds, including everything from before the webhook
// existed. Permission is `payments` (not adminOnly) so the Sales team can see
// the ledger without being handed the gateway credentials screen.

router.get('/razorpay/payments', requirePermission('payments'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { status, from, to } = req.query;
    const q = (req.query.q || '').trim();

    const params = [];
    let where = 'WHERE 1=1';
    if (status === 'captured') where += ` AND p.status = 'captured'`;
    else if (status === 'failed') where += ` AND p.status = 'failed'`;
    else if (status === 'refunded') where += ` AND (p.status = 'refunded' OR p.amount_refunded_paise > 0)`;
    else if (status) { params.push(status); where += ` AND p.status = $${params.length}`; }
    if (from) { params.push(from); where += ` AND p.paid_at >= $${params.length}::date`; }
    if (to) { params.push(to); where += ` AND p.paid_at < ($${params.length}::date + INTERVAL '1 day')`; }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (p.payer_email ILIKE $${params.length} OR p.payer_contact ILIKE $${params.length}
                      OR p.description ILIKE $${params.length} OR p.payment_id ILIKE $${params.length}
                      OR p.matched_lead_name ILIKE $${params.length})`;
    }

    const [{ rows }, { rows: [tot] }] = await Promise.all([
      pool.query(
        `SELECT p.* FROM coexistence.razorpay_payments p
         ${where} ORDER BY p.paid_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.razorpay_payments p ${where}`, params),
    ]);

    res.json({
      payments: rows.map(r => ({
        paymentId: r.payment_id, orderId: r.order_id, status: r.status,
        amount: Number(r.amount_paise || 0) / 100,
        refunded: Number(r.amount_refunded_paise || 0) / 100,
        currency: r.currency, method: r.method, captured: r.captured,
        description: r.description, email: r.payer_email, contact: r.payer_contact,
        fee: r.fee_paise == null ? null : Number(r.fee_paise) / 100,
        errorDescription: r.error_description,
        paidAt: r.paid_at,
        leadId: r.matched_lead_id, leadName: r.matched_lead_name, matchMethod: r.match_method,
      })),
      total: tot.total, limit, offset,
    });
  } catch (err) {
    console.error('[razorpay] ledger list error:', err.message);
    res.status(500).json({ error: 'Failed to load payments' });
  }
});

router.get('/razorpay/payments/summary', requirePermission('payments'), async (req, res) => {
  try {
    // One query: separate COUNTs can disagree if a sync lands between them.
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int                                                      AS total,
             COUNT(*) FILTER (WHERE status = 'captured')::int                   AS captured,
             COUNT(*) FILTER (WHERE status = 'failed')::int                     AS failed,
             COUNT(*) FILTER (WHERE amount_refunded_paise > 0)::int             AS refunded,
             COALESCE(SUM(amount_paise) FILTER (WHERE status='captured'),0)     AS collected_paise,
             COALESCE(SUM(amount_refunded_paise),0)                             AS refunded_paise,
             COUNT(*) FILTER (WHERE status='captured' AND matched_lead_id IS NOT NULL)::int AS matched,
             MIN(paid_at) AS first_payment, MAX(paid_at) AS last_payment
        FROM coexistence.razorpay_payments`);
    const { rows: cfg } = await pool.query(
      `SELECT payments_synced_at, payments_sync_error, (key_secret_encrypted IS NOT NULL) AS has_keys
         FROM coexistence.razorpay_config WHERE id = 1`);
    const s = rows[0];
    res.json({
      total: s.total, captured: s.captured, failed: s.failed, refunded: s.refunded,
      matched: s.matched,
      collected: Number(s.collected_paise) / 100,
      refundedAmount: Number(s.refunded_paise) / 100,
      firstPayment: s.first_payment, lastPayment: s.last_payment,
      syncedAt: cfg[0]?.payments_synced_at || null,
      syncError: cfg[0]?.payments_sync_error || null,
      hasApiKeys: !!cfg[0]?.has_keys,
    });
  } catch (err) {
    console.error('[razorpay] ledger summary error:', err.message);
    res.status(500).json({ error: 'Failed to load payment summary' });
  }
});

// Admin-only: a full import walks the entire history and costs real API calls.
router.post('/razorpay/payments/sync', adminOnly, async (req, res) => {
  try {
    const full = req.body?.full === true;
    const out = await syncRazorpayPayments({ full });
    if (out.skipped === 'no_api_keys') {
      return res.status(400).json({ error: 'Add a Razorpay Key ID and Key Secret before syncing payments.' });
    }
    res.json(out);
  } catch (err) {
    console.error('[razorpay] ledger sync error:', err.message);
    res.status(502).json({ error: err.message || 'Could not sync payments from Razorpay' });
  }
});

router.get('/razorpay/events', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const q = (req.query.q || '').trim();
    const where = [];
    const params = [];
    let i = 1;
    if (q) {
      where.push(`(payment_id ILIKE $${i} OR order_id ILIKE $${i} OR payer_email ILIKE $${i} OR payer_contact ILIKE $${i} OR event_type ILIKE $${i} OR matched_lead_name ILIKE $${i} OR matched_contact_name ILIKE $${i})`);
      params.push(`%${q}%`); i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT id, received_at, event_type, entity_type, payment_id, order_id, refund_id,
                amount_paise, currency, status, payer_email, payer_contact, method,
                signature_valid, match_method, matched_lead_id, matched_lead_name,
                matched_contact_number, matched_contact_name
           FROM coexistence.razorpay_events
           ${whereSql}
          ORDER BY received_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.razorpay_events ${whereSql}`, params),
    ]);
    res.json({ events: rows, total, limit, offset });
  } catch (err) {
    console.error('[razorpay] list events error:', err.message);
    res.status(500).json({ error: 'Failed to load Razorpay events' });
  }
});

router.get('/razorpay/events/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coexistence.razorpay_events WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[razorpay] get event error:', err.message);
    res.status(500).json({ error: 'Failed to load Razorpay event' });
  }
});

// ── Payment grouping (shared query fragment) ────────────────────────────────
// The Sales → Payments page and its GET /payments routes were removed; this CTE
// survives because services/mcpService.js `list_payments` is now its only
// consumer. Rows are GROUPED into one "payment journey" per checkout/payer so
// retries of a failed payment fold into a single row with an attempt count —
// the append-only event log underneath is untouched (full audit trail preserved).
//
// Group key (user choice 2026-07-08): Razorpay order_id when present, else the
// payer's phone, else email, else the event id (so orphan events still show).
const GK = `COALESCE(NULLIF(order_id,''), 'ph:'||NULLIF(payer_contact,''), 'em:'||NULLIF(payer_email,''), 'evt:'||id::text)`;

// The grouped CTE — attempts = distinct payment_ids; failed_attempts = distinct
// payment_ids whose status is 'failed' (a failed payment never later captures —
// a retry is a NEW payment_id — so this count is exact). succeeded = any capture.
const GROUP_CTE = `
  WITH ev AS (
    SELECT *, ${GK} AS gk FROM coexistence.razorpay_events
  ),
  grp AS (
    SELECT gk,
      MAX(received_at) AS last_at, MIN(received_at) AS first_at,
      COUNT(DISTINCT payment_id) FILTER (WHERE payment_id IS NOT NULL) AS attempts,
      COUNT(DISTINCT payment_id) FILTER (WHERE status = 'failed')      AS failed_attempts,
      bool_or(status = 'captured' OR event_type = 'order.paid')        AS succeeded,
      bool_or(status = 'refunded' OR event_type LIKE 'refund.%')       AS refunded,
      COALESCE(MAX(amount_paise) FILTER (WHERE status = 'captured'), MAX(amount_paise)) AS amount_paise,
      MAX(currency) AS currency,
      MAX(payer_email) AS payer_email, MAX(payer_contact) AS payer_contact,
      MAX(order_id) AS order_id,
      MAX(matched_lead_id) AS matched_lead_id, MAX(matched_lead_name) AS matched_lead_name,
      MAX(matched_contact_number) AS matched_contact_number, MAX(matched_contact_name) AS matched_contact_name,
      MAX(match_method) AS match_method,
      MAX(course_id) AS course_id,
      bool_and(signature_valid) AS all_verified,
      string_agg(DISTINCT payment_id, ' ') AS pay_ids
    FROM ev GROUP BY gk
  ),
  g2 AS (
    SELECT *, CASE
        WHEN succeeded THEN 'paid'
        WHEN refunded  THEN 'refunded'
        WHEN failed_attempts > 0 THEN 'failed'
        ELSE 'pending' END AS state
    FROM grp
  )`;

// GROUP_CTE is exported for services/mcpService.js `list_payments` — now the
// only consumer, and the single source of truth for what counts as
// paid/failed/refunded/pending.
module.exports = { publicRouter, router, ensureRazorpayTables, GROUP_CTE };
