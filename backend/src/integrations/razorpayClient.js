// ─── Razorpay API client (Payment Links) ─────────────────────────────────────
// The OUTBOUND half of the Razorpay integration. routes/razorpay.js receives
// and verifies webhooks; this file is the only place that CALLS Razorpay.
//
// ⚠ This is the first write access ForgeGrowth has to a payment gateway. A call
// through here can mint a link a real customer can really pay. Two guards:
//   1. createPaymentLink is NEVER retried (see withRetry below).
//   2. The key MODE is derived from the key id, never from a user-set toggle.
//
// Auth is HTTP Basic with key_id:key_secret. Razorpay keys are account-wide —
// there is no narrowly-scoped key like Stripe's restricted keys — so the secret
// is stored AES-encrypted (same util/crypto key as the Meta tokens) and is
// never returned by any GET route.

const pool = require('../db');
const { decrypt } = require('../util/crypto');

const API_BASE = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15000;

// Razorpay's own key ids carry their environment: rzp_test_… / rzp_live_….
// The mode is DERIVED from that, not stored from a dropdown, because "I thought
// I was still in test mode" is the one mistake here that costs real money. A
// stored toggle can disagree with the key; a derived one cannot.
function modeFromKeyId(keyId) {
  const k = String(keyId || '');
  if (k.startsWith('rzp_live_')) return 'live';
  if (k.startsWith('rzp_test_')) return 'test';
  return 'unknown';
}

class RazorpayError extends Error {
  constructor(message, { status = 502, code = null, field = null } = {}) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

// Load + decrypt the stored credentials. Throws a user-actionable error rather
// than a null deref when they were never entered.
async function getCredentials() {
  const { rows } = await pool.query(
    `SELECT key_id, key_secret_encrypted FROM coexistence.razorpay_config WHERE id = 1`
  );
  const c = rows[0] || {};
  if (!c.key_id || !c.key_secret_encrypted) {
    throw new RazorpayError(
      'Razorpay API keys are not set. Add the Key ID and Key Secret in Admin Settings → Webhooks → Razorpay.',
      { status: 400, code: 'NO_API_KEYS' }
    );
  }
  let secret;
  try { secret = decrypt(c.key_secret_encrypted); }
  catch {
    throw new RazorpayError(
      'The stored Razorpay Key Secret could not be read. Re-enter it in Admin Settings → Webhooks → Razorpay.',
      { status: 400, code: 'SECRET_UNREADABLE' }
    );
  }
  return { keyId: c.key_id, keySecret: secret, mode: modeFromKeyId(c.key_id) };
}

// Razorpay error bodies look like { error: { code, description, field, reason } }.
// `description` is written for humans, so it is surfaced verbatim — the frontend
// shows backend error strings as-is and they must stand alone.
function toError(status, body) {
  const e = (body && body.error) || {};
  const desc = e.description || e.reason || '';
  if (status === 401) {
    return new RazorpayError(
      'Razorpay rejected these API keys. Check the Key ID and Key Secret in Admin Settings → Webhooks → Razorpay.',
      { status: 400, code: 'BAD_CREDENTIALS' }
    );
  }
  return new RazorpayError(
    desc || `Razorpay refused the request (${status}).`,
    { status: status >= 400 && status < 500 ? 400 : 502, code: e.code || null, field: e.field || null }
  );
}

async function call(method, path, body, creds) {
  const c = creds || (await getCredentials());
  const auth = Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Network-level: no response at all. Distinguished from a Razorpay refusal
    // so withRetry can safely retry this and only this.
    const e = new RazorpayError(
      err.name === 'AbortError'
        ? 'Razorpay did not respond in time. Try again in a moment.'
        : 'Could not reach Razorpay. Check the server\'s network connection.',
      { status: 502, code: 'NETWORK' }
    );
    e.retriable = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON body */ }
  if (!res.ok) throw toError(res.status, parsed);
  return parsed;
}

// Retries ONLY a network-level failure, and only for reads. A 4xx from Razorpay
// is a decision, not a blip — retrying it just repeats the same refusal.
//
// ⚠ createPaymentLink deliberately does NOT use this. A create whose response
// was lost may have SUCCEEDED on Razorpay's side; retrying it would mint a
// second live link for the same customer. (reference_id uniqueness would
// usually catch that, but "usually" is not a guarantee to bet a duplicate
// customer charge on.) A failed create is reported and re-tried by a human.
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (!err.retriable) throw err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

// ── Public surface ───────────────────────────────────────────────────────────

// Cheap authenticated read that proves the keys work. Used by the "Test API
// access" button — the webhook being connected says nothing about API access,
// so this is the only honest way to report the outbound half.
async function testApiAccess() {
  const creds = await getCredentials();
  await withRetry(() => call('GET', '/payment_links?count=1', undefined, creds));
  return { ok: true, keyId: creds.keyId, mode: creds.mode };
}

// Razorpay caps `notes` at 15 keys and 256 chars per value, and rejects
// non-string values. Silently truncating beats a 400 on an otherwise-valid link.
function sanitizeNotes(notes) {
  const out = {};
  Object.entries(notes || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 15)
    .forEach(([k, v]) => { out[k] = String(v).slice(0, 256); });
  return out;
}

/**
 * Create a Razorpay payment link.
 *
 * `notes` carries our identity onto the link — this is the whole point of the
 * feature. The webhook reads payload.payment_link.entity.id back and resolves
 * it to a payment_requests row, so attribution never depends on the amount or
 * on the payer using their WhatsApp number at checkout.
 */
async function createPaymentLink({
  amountPaise, currency = 'INR', description, referenceId,
  customerName, customerEmail, customerPhone,
  acceptPartial = false, firstMinPartialPaise = null,
  notify = { sms: false, email: false }, reminderEnable = false,
  notes = {}, callbackUrl = null, expireBy = null,
}) {
  const payload = {
    amount: Math.round(Number(amountPaise)),
    currency,
    accept_partial: !!acceptPartial,
    description: (description || '').slice(0, 2048) || undefined,
    reference_id: referenceId || undefined,
    notes: sanitizeNotes(notes),
    reminder_enable: !!reminderEnable,
  };

  if (acceptPartial && firstMinPartialPaise != null) {
    payload.first_min_partial_amount = Math.round(Number(firstMinPartialPaise));
  }

  // Razorpay rejects a customer object whose every field is blank, and notify
  // channels only work when the matching field is present — so both are built
  // from what we actually have rather than sent as empty strings.
  const customer = {};
  if (customerName) customer.name = String(customerName).slice(0, 128);
  if (customerEmail) customer.email = String(customerEmail);
  if (customerPhone) customer.contact = String(customerPhone);
  if (Object.keys(customer).length) payload.customer = customer;

  payload.notify = {
    sms: !!(notify.sms && customer.contact),
    email: !!(notify.email && customer.email),
  };

  if (callbackUrl) { payload.callback_url = callbackUrl; payload.callback_method = 'get'; }
  // Razorpay wants seconds, and requires at least ~15 minutes in the future.
  if (expireBy) payload.expire_by = Math.floor(new Date(expireBy).getTime() / 1000);

  return call('POST', '/payment_links', payload);   // NOT retried — see withRetry
}

// Page through Razorpay's payment ledger.
//
// This is the PULL half of the integration. The webhook is push-only, so it can
// only ever know about events sent after it was configured — on this account
// that left 312 captured payments (₹420,968, back to Feb 2025) that the
// dashboard had no idea existed. A pull is also the only way to recover from a
// webhook Razorpay failed to deliver.
//
// `from`/`to` are UNIX SECONDS (Razorpay's own unit), not milliseconds — a
// value in ms lands ~55,000 years in the future and silently returns nothing.
async function listPayments({ from, to, count = 100, skip = 0 } = {}) {
  const qs = new URLSearchParams({ count: String(Math.min(count, 100)), skip: String(skip) });
  if (from) qs.set('from', String(from));
  if (to) qs.set('to', String(to));
  return withRetry(() => call('GET', `/payments?${qs}`));
}

// Every payment in a window, following pagination to the end.
// `maxPages` is a runaway guard, not a business limit — it is logged if hit so
// a truncated sync can never look like a complete one.
async function listAllPayments({ from, to, maxPages = 100 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await listPayments({ from, to, count: 100, skip: page * 100 });
    const items = body.items || [];
    out.push(...items);
    if (items.length < 100) return { payments: out, truncated: false };
  }
  return { payments: out, truncated: true };
}

async function fetchPaymentLink(plinkId) {
  return withRetry(() => call('GET', `/payment_links/${encodeURIComponent(plinkId)}`));
}

// Cancel is not retried on a network blip either: the first attempt may have
// landed, and a second cancel on an already-cancelled link errors confusingly.
async function cancelPaymentLink(plinkId) {
  return call('POST', `/payment_links/${encodeURIComponent(plinkId)}/cancel`, {});
}

module.exports = {
  RazorpayError,
  modeFromKeyId,
  getCredentials,
  testApiAccess,
  createPaymentLink,
  fetchPaymentLink,
  cancelPaymentLink,
  listPayments,
  listAllPayments,
};
