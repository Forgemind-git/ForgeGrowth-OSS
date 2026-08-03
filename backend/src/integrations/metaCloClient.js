// Meta Conversions API for CRM — the transport for Conversion Leads
// Optimisation (CLO).
//
// ⚠ Deliberately a SEPARATE client from metaCapiClient.js, which speaks the
// Click-to-WhatsApp dialect. The two are not interchangeable:
//
//                      CTWA (metaCapiClient)        CLO (this file)
//   action_source      business_messaging           system_generated
//   identifier         ctwa_clid (raw)              Meta lead id
//   extra required     messaging_channel            lead_event_source
//   window             7 days                       28 days
//   dataset            per-WABA dataset             a separate CRM dataset
//
// Sending a CLO event with business_messaging, or a CTWA event with
// system_generated, is accepted by Meta and then silently unattributable — so
// keeping the two builders apart is the point, not an accident of layout.

// The normalisation + hashing helpers are IMPORTED rather than reimplemented.
// A wrongly-normalised value hashes to something matching nobody while Meta
// still returns 200 OK, so a second copy of that logic is the exact shape of
// bug that never surfaces. One implementation, used by both integrations.
const { sha256, normalizeMatchValue } = require('./metaCapiClient');

// Meta's cap on events per request.
const MAX_EVENTS_PER_REQUEST = 1000;

// Meta rejects CRM events describing something older than this.
const WINDOW_DAYS = 28;

function graphBase(version) {
  return `https://graph.facebook.com/${version || 'v21.0'}`;
}

/**
 * Build one CLO event.
 *
 * `metaLeadId` is the 15–17 digit Instant Form lead id and is by far the best
 * identifier. When it is absent we fall back to hashed phone/email, which Meta
 * accepts but matches at a much lower rate — the caller logs a warning so the
 * degradation is visible rather than silent.
 */
function buildCloEvent({ eventName, eventTime, metaLeadId, leadEventSource, phone, email }) {
  const event = {
    event_name: eventName,
    event_time: Math.floor(eventTime / 1000),
    // Required for CRM events. Any other value makes the event unattributable.
    action_source: 'system_generated',
    // Meta requires a non-empty string naming the CRM.
    lead_event_source: leadEventSource,
    user_data: {},
  };

  if (metaLeadId) {
    // Sent raw: it is Meta's own identifier, not personal data.
    event.user_data.lead_id = String(metaLeadId);
  } else {
    const ph = normalizeMatchValue('ph', phone);
    const em = normalizeMatchValue('em', email);
    if (ph) event.user_data.ph = sha256(ph);
    if (em) event.user_data.em = sha256(em);
    // fbc (the click cookie) is browser-side and has no source in a CRM record,
    // so it is not attempted here rather than sent empty.
  }

  return event;
}

// Does this event carry anything Meta can match on?
function hasIdentifier(event) {
  const u = event?.user_data || {};
  return !!(u.lead_id || u.ph || u.em);
}

/**
 * POST a batch to the CRM dataset.
 *
 * Never throws on a Meta rejection — a refusal is data the caller must log
 * against each row, not an exception. Returns a classified outcome so the
 * caller knows whether retrying could ever help.
 */
async function sendCloEvents(token, datasetId, events, { testEventCode, graphApiVersion } = {}) {
  const payload = { data: events, partner_agent: 'ForgeGrowth' };
  if (testEventCode) payload.test_event_code = testEventCode;

  let res, body;
  try {
    res = await fetch(`${graphBase(graphApiVersion)}/${datasetId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: token }),
      signal: AbortSignal.timeout(30000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    // A dropped connection says nothing about whether the request was valid —
    // always retryable.
    return {
      ok: false, retryable: true, httpStatus: 0, eventsReceived: 0, fbtraceId: null,
      error: err.name === 'TimeoutError' ? 'Meta request timed out' : err.message,
      request: payload, response: null,
    };
  }

  const err = body?.error || null;
  const ok = res.ok && !err;

  return {
    ok,
    // 5xx and rate limits are transient; a 4xx validation failure is Meta's
    // considered answer and retrying it just burns quota forever.
    retryable: !ok && isRetryable(res.status, err),
    httpStatus: res.status,
    eventsReceived: body?.events_received ?? 0,
    fbtraceId: body?.fbtrace_id || err?.fbtrace_id || null,
    error: ok ? null : (err?.error_user_msg || err?.message || `Meta API ${res.status}`),
    request: payload,
    response: body || null,
  };
}

// Meta signals throttling as code 4 / 17 / 32 / 613, or an HTTP 429.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

function isRetryable(status, err) {
  if (status >= 500) return true;
  if (status === 429) return true;
  if (err && RATE_LIMIT_CODES.has(Number(err.code))) return true;
  return false;
}

// Strip the token before anything is persisted or logged. The request object
// handed back by sendCloEvents never contains it (it is merged in at fetch
// time), but this is the belt-and-braces the tests assert on.
function redact(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { access_token, ...rest } = payload;
  return rest;
}

module.exports = {
  buildCloEvent,
  sendCloEvents,
  hasIdentifier,
  isRetryable,
  redact,
  MAX_EVENTS_PER_REQUEST,
  WINDOW_DAYS,
};
