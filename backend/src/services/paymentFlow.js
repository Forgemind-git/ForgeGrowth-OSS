// ─── Payment flow: collect money inside a WhatsApp conversation ──────────────
//
// The shared core behind minting a Razorpay link and delivering it on a
// WhatsApp thread. One implementation, because a second copy of "mint a live
// payment link" would drift, and the drifted half spends real money.
//
// WHAT THIS FILE OWNS
//   createPaymentForChat()  mint a Razorpay link for a chat contact
//   deliverPaymentLink()    send it on their thread, window-aware (free-form
//                           text inside 24h, an approved template outside it)
//
// ⚠ THE BUTTON URL IS OURS, NEVER RAZORPAY'S
// Meta bakes a URL button's base in at approval, so a template points at
// https://<host>/pay/{{1}} — a base we own — and the token resolves to whatever
// the gateway issues today. See paymentButtonIndex().
//
// HISTORY: this file also carried a payment-WATCH dispatcher (chase an unpaid
// link, confirm a paid one) for the automation Payment node and the agent
// payment tools. Both were removed (migrations 104 and 2026-08-12), so the
// watch machinery and its table went with them. Callers left: Sales → Payments,
// the payment-template broadcast, and the Razorpay webhook.

const crypto = require('crypto');
const pool = require('../db');
const bus = require('../events');
const rzp = require('../integrations/razorpayClient');
const { resolveAccount, insertPendingRow, secondsSinceLastIncoming } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;

// Meta's customer-service window. A free-form text outside it is rejected by
// Meta, so we report that honestly instead of logging a phantom success.
const WINDOW_SECONDS = 24 * 60 * 60;

// ── Schema self-heal (mirrors migration 091) ─────────────────────────────────
async function ensurePaymentFlowTables() {
  await pool.query(`
    ALTER TABLE coexistence.payment_requests
      ADD COLUMN IF NOT EXISTS wa_number      TEXT,
      ADD COLUMN IF NOT EXISTS contact_number TEXT,
      ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS automation_id  BIGINT,
      ADD COLUMN IF NOT EXISTS execution_id   BIGINT,
      ADD COLUMN IF NOT EXISTS node_id        TEXT,
      ADD COLUMN IF NOT EXISTS agent_id       BIGINT;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_exec_node
      ON coexistence.payment_requests(execution_id, node_id)
      WHERE execution_id IS NOT NULL AND node_id IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_thread ON coexistence.payment_requests(wa_number, contact_number);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_requests_agent ON coexistence.payment_requests(agent_id) WHERE agent_id IS NOT NULL;`);

  await pool.query(`ALTER TABLE coexistence.automation_executions ADD COLUMN IF NOT EXISTS awaiting_kind TEXT NOT NULL DEFAULT 'reply';`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_executions_awaiting
      ON coexistence.automation_executions(wa_number, contact_number, awaiting_kind)
      WHERE status = 'paused';`);

  // NOTE: payment_watches is deliberately NOT recreated here. It was dropped
  // with the automation Payment node (migration 106); an ensure that recreated
  // it would silently undo that migration on the next boot.

  await pool.query(`
    ALTER TABLE coexistence.agents
      ADD COLUMN IF NOT EXISTS payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS payment_config   JSONB   NOT NULL DEFAULT '{}'::jsonb;`);

  // ── Payment templates (migration 092) ────────────────────────────────────
  await pool.query(`
    ALTER TABLE coexistence.payment_requests
      ADD COLUMN IF NOT EXISTS public_token     TEXT,
      ADD COLUMN IF NOT EXISTS click_count      INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_clicked_at  TIMESTAMPTZ;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_public_token
      ON coexistence.payment_requests(public_token) WHERE public_token IS NOT NULL;`);
  await pool.query(`
    ALTER TABLE coexistence.broadcasts
      ADD COLUMN IF NOT EXISTS payment_course_id    BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS payment_amount_paise BIGINT,
      ADD COLUMN IF NOT EXISTS payment_purpose      TEXT;`);
  await pool.query(`
    ALTER TABLE coexistence.agents
      ADD COLUMN IF NOT EXISTS payment_template_id BIGINT
        REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;`);
}

// ── Payment templates ────────────────────────────────────────────────────────

// The path a payment template's URL button points at. Matched by PATH only, so
// the same approved template keeps working across every domain this instance is
// reachable on — the host is never part of the match.
const PAY_PATH = '/pay/';

/**
 * Does this template carry a payment-link button?
 *
 * DERIVED from the stored button, never restated on a column — a copy would
 * drift the moment someone edited the button and the two would disagree about
 * whether a send needs a payment link minting.
 *
 * ⚠ Reads `b.value` / `b.urlSample` — the EDITOR's field names, which is what is
 * stored. `url`/`example` only exist in the Meta template-creation payload,
 * a different transform entirely (the same trap is already noted in
 * broadcasts.js).
 */
function paymentButtonIndex(template) {
  const btns = Array.isArray(template?.buttons) ? template.buttons : [];
  for (let i = 0; i < btns.length; i++) {
    const b = btns[i];
    if (b?.type === 'URL' && String(b.value || '').includes(PAY_PATH) && /\{\{\s*\d+\s*\}\}/.test(b.value || '')) {
      return i;
    }
  }
  return -1;
}
const templateHasPaymentButton = (t) => paymentButtonIndex(t) >= 0;

// A short, opaque, URL-safe token. Not the razorpay_link_id: that would put a
// gateway identifier in a customer-visible URL and let anyone enumerate links.
function newPublicToken() {
  return crypto.randomBytes(9).toString('hex');   // 18 chars
}

// Every request gets a token lazily, so links raised before migration 092 (and
// any created by a path that forgets) can still be sent through a template.
async function ensurePublicToken(requestId) {
  const { rows } = await pool.query(
    `SELECT public_token FROM coexistence.payment_requests WHERE id = $1`, [requestId]);
  if (rows[0]?.public_token) return rows[0].public_token;
  const token = newPublicToken();
  const { rows: upd } = await pool.query(
    `UPDATE coexistence.payment_requests SET public_token = $2, updated_at = NOW()
      WHERE id = $1 AND public_token IS NULL RETURNING public_token`, [requestId, token]);
  // A concurrent caller may have won; re-read rather than assume ours landed.
  if (upd[0]?.public_token) return upd[0].public_token;
  const { rows: again } = await pool.query(
    `SELECT public_token FROM coexistence.payment_requests WHERE id = $1`, [requestId]);
  return again[0]?.public_token || null;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

// The tokens a payment message may use. Deliberately a small fixed set rather
// than the automation engine's full resolver: this same function serves the
// agent path, which has no execution context to resolve {{custom_field}} from.
function fillPaymentVars(text, { request, contactName } = {}) {
  if (!text) return '';
  const r = request || {};
  const amount = toRupees(r.amount_paise);
  const due = Math.max(0, toRupees(r.amount_paise) - toRupees(r.amount_paid_paise));
  const map = {
    payment_link: r.short_url || '',
    payment_url: r.short_url || '',
    amount: amount.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
    amount_paid: toRupees(r.amount_paid_paise).toLocaleString('en-IN'),
    amount_due: due.toLocaleString('en-IN'),
    product: r.product_label || '',
    purpose: r.purpose || '',
    name: contactName || r.customer_name || '',
  };
  return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : full;
  });
}

// A payment message without the link in it is useless, and it is very easy to
// configure one (the operator forgets the token). Rather than send a dead
// message we append the URL — visible, obvious, and never silently dropped.
function withLink(text, shortUrl) {
  const body = (text || '').trim();
  if (!shortUrl) return body;
  if (body.includes(shortUrl)) return body;
  return body ? `${body}\n\n${shortUrl}` : shortUrl;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Send a plain text message on a chat thread.
 *
 * Returns { sent, reason } — never throws for a business reason like a closed
 * 24h window, because every caller here is a background sweeper whose job is to
 * record what happened, not to crash.
 */
async function sendOnThread({ waNumber, contactNumber, body, requireWindow = true }) {
  const text = (body || '').trim();
  if (!text) return { sent: false, reason: 'empty_message' };

  const { account, error } = await resolveAccount({ fromPhoneNumber: waNumber });
  if (error || !account) return { sent: false, reason: `no_account: ${error || waNumber}` };

  if (requireWindow) {
    const secs = await secondsSinceLastIncoming({
      accountPhoneNumberId: account.phoneNumberId,
      contactNumber,
    });
    // null = this customer has never messaged this number, so the window was
    // never opened at all. Both cases mean Meta will reject free-form text.
    if (secs == null || secs > WINDOW_SECONDS) {
      return {
        sent: false,
        reason: 'outside_24h_window',
        detail: secs == null
          ? 'This contact has never messaged the business number, so WhatsApp will not accept a free-form message.'
          : `The customer last messaged ${Math.floor(secs / 3600)}h ago, past WhatsApp's 24-hour window for free-form messages.`,
      };
    }
  }

  const localId = await insertPendingRow({
    account, toNumber: contactNumber, messageType: 'text', messageBody: text,
  });
  await enqueueSend({
    kind: 'text',
    accountId: account.id,
    to: digits(contactNumber),
    localMessageId: localId,
    payload: { body: text, previewUrl: true },
  });
  return { sent: true, localMessageId: localId };
}

/**
 * Send an APPROVED template carrying a payment button.
 *
 * This is the ONLY way to put a payment link in front of a customer whose
 * 24-hour window has closed, which is the entire reason payment templates
 * exist. Body variables are filled positionally from `variables`; the payment
 * button's parameter is the request's public token.
 */
async function sendPaymentTemplate({ waNumber, contactNumber, templateId, request, variables = [] }) {
  const { account, error } = await resolveAccount({ fromPhoneNumber: waNumber });
  if (error || !account) return { sent: false, reason: `no_account: ${error || waNumber}` };

  const { rows } = await pool.query(
    `SELECT id, name, language, status, whatsapp_account_id, body, buttons, header_type
       FROM coexistence.message_templates WHERE id = $1`, [parseInt(templateId, 10) || 0]);
  const template = rows[0];
  if (!template) return { sent: false, reason: 'template_missing', detail: 'That payment template no longer exists.' };
  if (String(template.status).toUpperCase() !== 'APPROVED') {
    return { sent: false, reason: 'template_not_approved', detail: `The template "${template.name}" is ${template.status}, so WhatsApp will not send it yet.` };
  }
  // A template exists only on the WABA it was approved under — sending it from
  // another number is Meta error #132001. Guarded here as everywhere else.
  if (template.whatsapp_account_id && String(template.whatsapp_account_id) !== String(account.id)) {
    return { sent: false, reason: 'waba_mismatch', detail: `"${template.name}" is not approved on the number ${waNumber}.` };
  }

  const btnIdx = paymentButtonIndex(template);
  if (btnIdx < 0) {
    return { sent: false, reason: 'no_payment_button', detail: `"${template.name}" has no payment-link button. Add one in Template Builder.` };
  }
  const token = await ensurePublicToken(request.id);
  if (!token) return { sent: false, reason: 'no_token', detail: 'Could not mint the payment link token.' };

  const components = [];
  if (variables.length > 0) {
    components.push({ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v ?? ' ') || ' ' })) });
  }
  // `index` is the button's position among ALL buttons (Meta's semantics), not
  // among URL buttons only.
  components.push({ type: 'button', sub_type: 'url', index: btnIdx, parameters: [{ type: 'text', text: token }] });

  const resolvedBody = String(template.body || '')
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => (variables[(+n) - 1] != null ? String(variables[(+n) - 1]) : `{{${n}}}`));

  const localId = await insertPendingRow({
    account, toNumber: contactNumber, messageType: 'template', messageBody: resolvedBody,
    templateId: template.id, sendOrigin: 'payment',
    templateMeta: { name: template.name, language: template.language, buttons: template.buttons, paymentRequestId: Number(request.id) },
  });
  await enqueueSend({
    kind: 'template',
    accountId: account.id,
    to: digits(contactNumber),
    localMessageId: localId,
    payload: { name: template.name, languageCode: template.language || 'en', components },
  });
  return { sent: true, localMessageId: localId, via: 'template', templateName: template.name };
}

/**
 * Deliver a payment link by whichever route will actually reach the customer.
 *
 * mode:
 *   'text'     free-form only (fails when the window is shut)
 *   'template' always the template (works any time, costs a template send)
 *   'auto'     text inside the window, template outside it  ← the sane default
 *
 * 'auto' exists because the operator cannot know at build time whether the
 * window will be open when the flow runs, and picking wrong is either a failed
 * send or a needlessly paid template.
 */
async function deliverPaymentLink({
  waNumber, contactNumber, request, mode = 'auto',
  text, templateId, templateVariables = [], contactName,
}) {
  const wantsTemplate = mode === 'template';
  let windowOpen = null;

  if (mode === 'auto' || mode === 'text') {
    const { account } = await resolveAccount({ fromPhoneNumber: waNumber });
    if (account) {
      const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber });
      windowOpen = secs != null && secs <= WINDOW_SECONDS;
    }
  }

  if (!wantsTemplate && (mode === 'text' || windowOpen)) {
    const body = fillPaymentVars(withLink(text, request.short_url), { request, contactName });
    const res = await sendOnThread({ waNumber, contactNumber, body });
    if (res.sent) return { ...res, via: 'text' };
    // In 'auto', a closed window is not a failure — it is the template's cue.
    if (mode === 'text' || !templateId) return { ...res, via: 'text' };
  }

  if (!templateId) {
    return {
      sent: false, via: 'template', reason: 'no_template',
      detail: 'The 24-hour window is closed and no payment template is set, so WhatsApp will not accept a message. Pick an approved payment template.',
    };
  }
  return sendPaymentTemplate({ waNumber, contactNumber, templateId, request, variables: templateVariables });
}

// ── Amount authority ─────────────────────────────────────────────────────────

/**
 * Resolve what to charge, from a product or an explicit figure.
 *
 * `allowCustom` is what separates the agent path from the automation path: an
 * automation amount was typed by an admin at build time and is trusted; an
 * agent amount was produced by an LLM mid-conversation and is only accepted
 * inside the range an admin set. Returns { error } rather than throwing so both
 * callers can turn it into their own kind of message.
 */
async function resolveAmount({ courseId, amount, allowCustom = true, minPaise = null, maxPaise = null, allowedProductIds = null }) {
  if (courseId) {
    const { rows } = await pool.query(
      `SELECT id, name, default_price_paise FROM coexistence.courses WHERE id = $1`,
      [parseInt(courseId, 10) || 0]
    );
    const product = rows[0];
    if (!product) return { error: `No product with id ${courseId} exists.` };
    if (Array.isArray(allowedProductIds) && allowedProductIds.length > 0
        && !allowedProductIds.map(Number).includes(Number(product.id))) {
      return { error: `This agent is not allowed to sell "${product.name}".` };
    }
    // An explicit amount alongside a product is only honoured when custom
    // amounts are allowed — otherwise the product's own price is the price,
    // which is the whole point of products-only mode.
    if (amount != null && amount !== '' && allowCustom) {
      const p = toPaise(amount);
      const bad = checkRange(p, minPaise, maxPaise);
      if (bad) return { error: bad };
      return { amountPaise: p, product };
    }
    if (!product.default_price_paise) {
      return { error: `"${product.name}" has no price set. Add one in Sales → Products, or give an amount.` };
    }
    return { amountPaise: Number(product.default_price_paise), product };
  }

  if (amount == null || amount === '') return { error: 'Give a product or an amount.' };
  if (!allowCustom) {
    return { error: 'This agent can only raise payment links for a listed product, not a custom amount.' };
  }
  const p = toPaise(amount);
  const bad = checkRange(p, minPaise, maxPaise);
  if (bad) return { error: bad };
  return { amountPaise: p, product: null };
}

function checkRange(paise, minPaise, maxPaise) {
  if (!Number.isFinite(paise) || paise < 100) return 'The amount must be at least ₹1.';
  if (minPaise != null && paise < Number(minPaise)) {
    return `The amount is below the ₹${toRupees(minPaise).toLocaleString('en-IN')} minimum set for this agent.`;
  }
  if (maxPaise != null && paise > Number(maxPaise)) {
    return `The amount is above the ₹${toRupees(maxPaise).toLocaleString('en-IN')} maximum set for this agent.`;
  }
  return null;
}

// ── Mint ─────────────────────────────────────────────────────────────────────

/**
 * Create a Razorpay payment link for a chat contact.
 *
 * IDEMPOTENCY IS THE POINT OF THE `reuseKey` BRANCH. An automation node can be
 * re-entered (a re-trigger, a resumed walk) and an LLM can call its tool twice
 * in one turn. Either would otherwise mint a SECOND live link the customer
 * could also pay. We look for an existing OPEN request for the same waiter and
 * the same amount and hand that one back instead.
 */
async function createPaymentForChat({
  waNumber, contactNumber, contactName,
  amountPaise, courseId = null, productLabel = null,
  purpose = null, description = null,
  kind = 'fixed', minAmountPaise = null,
  expiryHours = null,
  source = 'automation', automationId = null, executionId = null, nodeId = null, agentId = null,
  createdBy = null,
}) {
  const phone = digits(contactNumber);
  if (!phone) return { error: 'This conversation has no usable phone number.' };
  if (!Number.isFinite(amountPaise) || amountPaise < 100) return { error: 'The amount must be at least ₹1.' };

  // ── Reuse an open link rather than minting a duplicate ────────────────────
  const reuse = await findReusableRequest({ executionId, nodeId, agentId, contactNumber: phone, amountPaise });
  if (reuse) return { request: reuse, reused: true };

  // The agent path has no name to hand us, and a nameless Razorpay customer
  // makes the gateway dashboard unreadable. COALESCE(name, profile_name) is the
  // same precedence the chat UI uses.
  if (!contactName) {
    const { rows } = await pool.query(
      `SELECT COALESCE(name, profile_name) AS n FROM coexistence.contacts
        WHERE wa_number = $1 AND contact_number = $2 LIMIT 1`,
      [waNumber, contactNumber]
    ).catch(() => ({ rows: [] }));
    contactName = rows[0]?.n || null;
  }

  // The lead is what the Razorpay note points at, and what the funnel, the
  // Sales Log and the stage-tag mirror all key off. ensureLeadForContact (not
  // the Sales-page helper) is correct here: this person genuinely does have a
  // WhatsApp thread, which is exactly what that helper records.
  const { ensureLeadForContact } = require('../routes/leads');
  const lead = await ensureLeadForContact({ contactNumber: phone, name: contactName, source: 'Direct' });

  const product = courseId
    ? (await pool.query(`SELECT id, name FROM coexistence.courses WHERE id = $1`, [courseId])).rows[0] || null
    : null;

  const acceptPartial = kind === 'partial' || kind === 'open';
  let minPaise = null;
  if (kind === 'partial') {
    minPaise = Number(minAmountPaise);
    if (!Number.isFinite(minPaise) || minPaise < 100) return { error: 'A part payment needs a minimum first amount of at least ₹1.' };
    if (minPaise > amountPaise) return { error: 'The minimum first payment cannot be more than the total.' };
  } else if (kind === 'open') {
    minPaise = 100;
  }

  const expireBy = expiryHours ? new Date(Date.now() + Number(expiryHours) * 3600 * 1000) : null;

  // 1. Local row first — its id is stamped into the Razorpay notes, so it must
  //    exist before the call. Same mandatory ordering as the Sales page.
  let draft;
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.payment_requests
         (lead_id, customer_name, customer_phone, customer_email, course_id, product_label,
          purpose, kind, amount_paise, min_amount_paise, description, expire_by,
          wa_number, contact_number, source, automation_id, execution_id, node_id, agent_id, created_by,
          public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [lead?.id || null, contactName || null, phone, null, product?.id || null,
       product?.name || productLabel || null, purpose || null, kind, amountPaise, minPaise,
       description || null, expireBy, waNumber, contactNumber, source,
       automationId, executionId, nodeId, agentId, createdBy, newPublicToken()]
    );
    draft = rows[0];
  } catch (err) {
    // The unique index fired — another concurrent run of the same node won the
    // race. Hand back whatever it created rather than erroring.
    if (err.code === '23505') {
      const existing = await findReusableRequest({ executionId, nodeId, agentId, contactNumber: phone, amountPaise, anyAmount: true });
      if (existing) return { request: existing, reused: true };
    }
    throw err;
  }

  // 2. Mint. NOT retried — a create whose response was lost may have succeeded,
  //    and a retry would give the customer two payable links.
  let link;
  try {
    link = await rzp.createPaymentLink({
      amountPaise,
      description: description || [product?.name || productLabel, purpose].filter(Boolean).join(' — ') || 'Payment',
      referenceId: `fg-req-${draft.id}`,
      customerName: contactName || null,
      customerPhone: `+${phone}`,
      acceptPartial,
      firstMinPartialPaise: minPaise,
      notify: { sms: false, email: false },   // we deliver it on WhatsApp ourselves
      reminderEnable: false,
      expireBy,
      notes: {
        forge_request_id: draft.id,
        forge_lead_id: lead?.id || '',
        forge_product_id: product?.id || '',
        forge_purpose: purpose || '',
        forge_source: source,
      },
    });
  } catch (err) {
    if (err.retriable || err.code === 'NETWORK') {
      // NOT definitive — the link may exist. Keeping the row is what lets the
      // webhook late-bind it via notes.forge_request_id instead of orphaning a
      // live link.
      await pool.query(
        `UPDATE coexistence.payment_requests SET sync_error = $2, updated_at = NOW() WHERE id = $1`,
        [draft.id, 'Razorpay did not confirm this link. Check the Razorpay dashboard before raising another.']
      ).catch(() => {});
      return { error: 'Razorpay did not confirm the payment link. It may already exist — check the Razorpay dashboard before trying again.', requestId: Number(draft.id) };
    }
    await pool.query(`DELETE FROM coexistence.payment_requests WHERE id = $1`, [draft.id]).catch(() => {});
    return { error: err.message || 'Razorpay refused to create the payment link.' };
  }

  const { rows: [saved] } = await pool.query(
    `UPDATE coexistence.payment_requests
        SET razorpay_link_id = $2, reference_id = $3, short_url = $4, status = $5,
            sync_error = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [draft.id, link.id, link.reference_id || `fg-req-${draft.id}`, link.short_url,
     ['created', 'partially_paid', 'paid', 'cancelled', 'expired'].includes(link.status) ? link.status : 'created']
  );

  bus.emit('payment-request-changed', { id: Number(draft.id), status: saved.status });
  return { request: saved, reused: false };
}

// An "open" request is one that could still be paid. A cancelled/expired/paid
// one must NOT be reused — the customer needs a fresh link.
async function findReusableRequest({ executionId, nodeId, agentId, contactNumber, amountPaise, anyAmount = false }) {
  const OPEN = `pr.status IN ('created','partially_paid') AND pr.razorpay_link_id IS NOT NULL
                AND (pr.expire_by IS NULL OR pr.expire_by > NOW())`;
  if (executionId && nodeId) {
    const { rows } = await pool.query(
      `SELECT pr.* FROM coexistence.payment_requests pr
        WHERE pr.execution_id = $1 AND pr.node_id = $2 ORDER BY pr.id DESC LIMIT 1`,
      [executionId, nodeId]
    );
    return rows[0] || null;   // per-node: ALWAYS reuse, even if paid — the node ran once
  }
  if (agentId && contactNumber) {
    // Per-conversation: an agent asked twice in the same chat for the same
    // thing gets the same link back. A DIFFERENT amount is a real second
    // request (a part payment, a different product) and mints properly.
    const params = [agentId, digits(contactNumber)];
    let amountClause = '';
    if (!anyAmount) { params.push(amountPaise); amountClause = ` AND pr.amount_paise = $3`; }
    const { rows } = await pool.query(
      `SELECT pr.* FROM coexistence.payment_requests pr
        WHERE pr.agent_id = $1
          AND right(regexp_replace(pr.customer_phone, '\\D', '', 'g'), 10) = right($2, 10)
          AND ${OPEN}${amountClause}
          AND pr.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY pr.id DESC LIMIT 1`,
      params
    );
    return rows[0] || null;
  }
  return null;
}

// NOTE (2026-08-12): the payment WATCH machinery — openWatch,
// sweepPaymentWatches, the chase/timeout handlers and the debounced kick —
// was removed with the automation Payment node. Its only two callers were
// that node and the agent payment tools (removed with migration 104), so it
// had nothing left to watch and the payment_watches table was dropped.
//
// Everything ABOVE this line is still live: Sales → Payments mints links
// through createPaymentForChat/deliverPaymentLink, and the Razorpay webhook
// keeps their status current. That path never used a watch.

module.exports = {
  ensurePaymentFlowTables,
  createPaymentForChat,
  sendPaymentTemplate,
  deliverPaymentLink,
  templateHasPaymentButton,
  paymentButtonIndex,
  ensurePublicToken,
  newPublicToken,
  PAY_PATH,
  resolveAmount,
  sendOnThread,
  fillPaymentVars,
  withLink,
  toPaise,
  toRupees,
};
