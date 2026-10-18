// Meta Conversions API client — Click-to-WhatsApp flavour.
//
// The normal (web) CAPI matches a conversion to an ad via browser signals (fbp/
// fbc cookies, hashed email/phone). None of that exists in a WhatsApp chat, so
// CTWA uses a different join key: `ctwa_clid`, the click id Meta mints the
// instant someone taps a Click-to-WhatsApp ad. It rides along in the first
// inbound message's `referral` object and is the ONLY thing that ties a chat
// back to an ad. Hand it back with an event and Meta closes the loop.
//
// Two Meta-specific facts this module encodes:
//   1. The POST target is a DATASET, not the pixel/WABA. A WhatsApp Business
//      Account owns one: GET /{waba_id}/dataset. If it has none, POST the same
//      edge to create it (needs whatsapp_business_manage_events on the token).
//   2. The event MUST carry action_source='business_messaging' +
//      messaging_channel='whatsapp', and user_data must pair ctwa_clid with the
//      whatsapp_business_account_id. Any other action_source is silently
//      unattributable for CTWA.
//
// Read-and-write against Meta, unlike metaAdsClient (read-only) — the route
// layer owns the master switch, test/live mode and the audit log.

const { META_API_VERSION } = require('./metaAdsClient');

const BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Meta's standard event catalog ────────────────────────────────────────────
// Every event Meta defines for the Conversions API, grouped the way a person
// thinks about a funnel rather than the way Meta's docs list them. Each entry
// carries what the signal MEANS, what Meta actually DOES with it, and what it
// corresponds to in a WhatsApp conversation — the UI renders all three, so the
// person choosing a mapping never has to guess.
//
//   group          section header in the picker
//   meaning        what the signal says happened
//   metaBehaviour  how Meta's optimiser treats it
//   messaging      what it looks like in a click-to-WhatsApp funnel
//   strength       'low' | 'medium' | 'high' — how much weight Meta gives it
//   expectsValue   Meta wants a monetary value with this event
//   recommended    sensible for a WhatsApp funnel (the rest are e-commerce)
const EVENT_CATALOG = [
  // ── enquiry / lead capture ────────────────────────────────────────────────
  {
    name: 'Lead', group: 'Enquiry & leads', strength: 'high', recommended: true,
    meaning: 'Someone showed real interest and became a lead.',
    metaBehaviour: 'The core mid-funnel signal. Campaigns optimising for leads bid towards people who resemble everyone who fired this, so it is the event that most directly shapes who your ads reach.',
    messaging: 'Best mapped to the stage where a conversation stops being a hello and becomes a genuine enquiry — not the first inbound message.',
  },
  {
    name: 'Contact', group: 'Enquiry & leads', strength: 'medium', recommended: true,
    meaning: 'The person got in touch — a message, call or enquiry.',
    metaBehaviour: 'Treated as an early intent signal. It fires far more often than Lead, so Meta learns faster but on looser evidence.',
    messaging: 'Fits the first real reply. Use it when almost everyone who writes back counts as progress worth optimising for.',
  },
  {
    name: 'Schedule', group: 'Enquiry & leads', strength: 'high', recommended: true,
    meaning: 'An appointment, demo or call was booked.',
    metaBehaviour: 'A strong intent signal one step short of a purchase. Meta weights it heavily because booked time rarely happens by accident.',
    messaging: 'Map this when a BDA locks in a counselling call or a demo slot.',
  },
  {
    name: 'SubmitApplication', group: 'Enquiry & leads', strength: 'high', recommended: true,
    meaning: 'A formal application was submitted — a course, loan or job.',
    metaBehaviour: 'High-intent and low-volume. Meta optimises well on it once you have enough weekly volume; below roughly 50 a week it will struggle to learn.',
    messaging: 'Right for admissions funnels where the person fills in a form before paying.',
  },

  // ── sign-up & trial ───────────────────────────────────────────────────────
  {
    name: 'CompleteRegistration', group: 'Sign-up & trial', strength: 'high', recommended: true,
    meaning: 'A registration or sign-up was completed.',
    metaBehaviour: 'Meta reads it as a finished account-creation step — a confirmed conversion rather than an intention.',
    messaging: 'Good for webinar or free-class registrations captured over chat.',
  },
  {
    name: 'StartTrial', group: 'Sign-up & trial', strength: 'high', expectsValue: true,
    meaning: 'A free or paid trial began.',
    metaBehaviour: 'Meta expects a value — what the trial is worth to you — and treats it as a leading indicator of subscription revenue.',
    messaging: 'Use it if you give a trial class or trial week before the full course.',
  },
  {
    name: 'Subscribe', group: 'Sign-up & trial', strength: 'high', expectsValue: true,
    meaning: 'A recurring subscription started.',
    metaBehaviour: 'Meta expects the plan price and optimises towards recurring revenue rather than one-off sales.',
    messaging: 'Only relevant for a monthly or instalment plan billed on repeat.',
  },

  // ── purchase & revenue ────────────────────────────────────────────────────
  {
    name: 'Purchase', group: 'Purchase & revenue', strength: 'high', expectsValue: true, recommended: true,
    meaning: 'Money changed hands — the sale completed.',
    metaBehaviour: 'The strongest signal Meta has. With a value and currency attached it powers value-based bidding and the ROAS figures in Ads Manager. Without a value Meta still counts the conversion but cannot optimise for revenue.',
    messaging: 'Map this to your won stage. Send the amount actually paid so Meta learns which ads bring the bigger enrolments, not just more of them.',
  },
  {
    name: 'InitiateCheckout', group: 'Purchase & revenue', strength: 'medium', expectsValue: true,
    meaning: 'Checkout began but has not completed.',
    metaBehaviour: 'A pre-purchase signal. Meta uses it when purchases are too rare to learn on — it gives the optimiser volume while pointing in the same direction.',
    messaging: 'Fires when you send the payment link and the person opens it.',
  },
  {
    name: 'AddPaymentInfo', group: 'Purchase & revenue', strength: 'high', expectsValue: true,
    meaning: 'Payment details were entered.',
    metaBehaviour: 'The last step before Purchase, so Meta treats it as the highest-intent event that is not a sale.',
    messaging: 'Rarely visible in a WhatsApp funnel unless your gateway reports it back.',
  },
  {
    name: 'Donate', group: 'Purchase & revenue', strength: 'high', expectsValue: true,
    meaning: 'A donation was made.',
    metaBehaviour: 'Handled exactly like Purchase, with the same value-based bidding — it exists so non-profits report in their own language.',
    messaging: 'Not applicable unless you are running fundraising campaigns.',
  },

  // ── interest & browsing ───────────────────────────────────────────────────
  {
    name: 'ViewContent', group: 'Interest & browsing', strength: 'low',
    meaning: 'Someone looked at a specific page, product or piece of content.',
    metaBehaviour: 'A broad top-of-funnel signal. It fires so often that Meta will happily optimise towards cheap, low-quality traffic if you use it alone.',
    messaging: 'Map only if you want Meta chasing volume — for example when a brand-new ad set has no conversions to learn from yet.',
  },
  {
    name: 'Search', group: 'Interest & browsing', strength: 'low',
    meaning: 'A search was performed.',
    metaBehaviour: 'Weak on its own. Meta mostly uses it to build retargeting audiences rather than to steer delivery.',
    messaging: 'No natural equivalent in a WhatsApp conversation.',
  },
  {
    name: 'AddToCart', group: 'Interest & browsing', strength: 'medium',
    meaning: 'An item was added to a cart.',
    metaBehaviour: 'A mid-funnel commerce signal that also feeds dynamic product retargeting.',
    messaging: 'Only meaningful with a product catalogue behind the conversation.',
  },
  {
    name: 'AddToWishlist', group: 'Interest & browsing', strength: 'low',
    meaning: 'An item was saved for later.',
    metaBehaviour: 'Weaker than AddToCart. Used almost entirely for audience building.',
    messaging: 'Only meaningful with a product catalogue.',
  },
  {
    name: 'CustomizeProduct', group: 'Interest & browsing', strength: 'low',
    meaning: 'A product was configured or customised.',
    metaBehaviour: 'A niche light-intent signal Meta records but rarely optimises against.',
    messaging: 'Only meaningful with a configurable product.',
  },
  {
    name: 'FindLocation', group: 'Interest & browsing', strength: 'low',
    meaning: 'Someone looked up a store or branch location.',
    metaBehaviour: 'Feeds store-traffic and local-awareness campaigns rather than online conversion optimisation.',
    messaging: 'Map it if people ask for your centre address before enrolling.',
  },
];

// Section order the UI renders in — declared once so backend and frontend agree.
const EVENT_GROUPS = ['Enquiry & leads', 'Sign-up & trial', 'Purchase & revenue', 'Interest & browsing'];

// Flat name list kept for the send path + validation.
const STANDARD_EVENTS = EVENT_CATALOG.map(e => e.name);

// Events where Meta expects a monetary value; the UI warns when one is mapped
// with value_mode='none'.
const VALUE_EVENTS = EVENT_CATALOG.filter(e => e.expectsValue).map(e => e.name);

// A dropped connection to graph.facebook.com surfaces as a bare "fetch failed"
// with no status — retrying once or twice clears it. Meta's own 4xx rejections
// are NOT retried: those are answers, not failures.
function isTransient(err) {
  return !err.status && (err.name === 'TimeoutError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(err.message || ''));
}

async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (!isTransient(err)) throw err;
      if (i === attempts - 1) {
        // "fetch failed" tells an admin nothing — name the actual problem.
        err.message = `Could not reach Meta (${err.message}). Try again in a moment.`;
        throw err;
      }
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

function shapeError(res, body) {
  const e = (body && body.error) || {};
  const err = new Error(e.error_user_msg || e.message || `Meta API ${res.status}`);
  err.metaCode = e.code;
  err.metaSubcode = e.error_subcode;
  err.fbtraceId = e.fbtrace_id || null;
  err.status = res.status;
  return err;
}

async function graphGet(path, params, token) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw shapeError(res, body);
  return body;
}

async function graphPost(path, payload, token) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, access_token: token }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw shapeError(res, body);
  return body;
}

// ── Dataset discovery / creation ─────────────────────────────────────────────

// The dataset attached to a WhatsApp Business Account, or null if Meta has not
// created one yet (common — it only appears once the account is wired for
// conversion tracking).
async function getWabaDataset(token, wabaId) {
  const body = await withRetry(() => graphGet(`${wabaId}/dataset`, {}, token));
  const first = (body.data || [])[0];
  return first && first.id ? String(first.id) : null;
}

// Ask Meta to create the dataset for this WABA. Idempotent on Meta's side: if
// one already exists the same id comes back. Requires the token to hold
// whatsapp_business_manage_events.
async function createWabaDataset(token, wabaId) {
  const body = await withRetry(() => graphPost(`${wabaId}/dataset`, {}, token));
  const id = body.id || body.dataset_id || null;
  if (id) return String(id);
  // Some API versions return {success:true} and expect a follow-up read.
  return await getWabaDataset(token, wabaId);
}

// ── Customer information parameters (Meta "advanced matching") ───────────────
//
// The click id attributes a conversion to an AD. These keys tell Meta WHO
// converted, so it can match the person to a profile — which is what improves
// optimisation and makes a lookalike built from these events worth having.
//
// ⚠ Every value here is SHA-256 hashed after normalisation. Meta requires it,
// and it means the plaintext never leaves this server. ctwa_clid and
// whatsapp_business_account_id are deliberately NOT hashed: they are Meta's own
// tokens, not personal data, and hashing them would break attribution entirely.
//
// `tier` is how much the key moves match rate on its own:
//   high   — can identify a person by itself
//   medium — narrows hard, best paired with a high-tier key
//   low    — cannot identify anyone alone; raises confidence in combination
const MATCH_KEY_CATALOG = [
  {
    key: 'ph', label: 'Phone number', tier: 'high', source: 'WhatsApp number',
    what: 'The number the conversation happens on.',
    why: 'The strongest key you have. Meta matches phone numbers to accounts at a high rate, and for a WhatsApp funnel it is present on literally every lead — no other key comes close on coverage.',
    normalisation: 'Digits only, including country code, no plus sign or spaces. Then hashed.',
  },
  {
    key: 'em', label: 'Email address', tier: 'high', source: 'Sale profile',
    what: 'The email captured on the payment page.',
    why: 'The other key Meta matches at a high rate. Pairing email with phone is the single biggest jump in match quality you can make.',
    normalisation: 'Trimmed, lowercased. Then hashed.',
  },
  {
    key: 'external_id', label: 'Your own customer ID', tier: 'high', source: 'Lead ID',
    what: 'A stable identifier for this person in your CRM.',
    why: 'Lets Meta connect repeat events from the same person even when other details change. Only useful if it stays the same for a given customer over time — which is why it is derived from the click id here, not the lead row (a deleted and re-created lead gets a new id).',
    normalisation: 'Hashed as-is.',
  },
  {
    key: 'fn', label: 'First name', tier: 'medium', source: 'Lead name',
    what: 'First name only, split from the full name.',
    why: 'Cannot identify anyone by itself — plenty of people share a first name — but combined with a phone or email it measurably raises Meta\'s confidence in the match.',
    normalisation: 'Trimmed, lowercased, punctuation and spaces removed. Then hashed.',
  },
  {
    key: 'ln', label: 'Last name', tier: 'medium', source: 'Lead name',
    what: 'Everything after the first name.',
    why: 'Same as first name: a combination booster, not a standalone key. Often missing here, since many WhatsApp profile names are a single word.',
    normalisation: 'Trimmed, lowercased, punctuation and spaces removed. Then hashed.',
  },
  {
    key: 'zp', label: 'PIN code', tier: 'low', source: 'Sale profile',
    what: 'The postal code captured on the payment page.',
    why: 'A PIN code covers thousands of people, so it can never identify anyone on its own — treat it as a confidence booster on top of phone or email, not as a signal in its own right. It is genuinely useful for that, and it costs nothing to include, but sending it will not by itself improve delivery.',
    normalisation: 'Digits only, spaces removed. Then hashed.',
  },
  {
    key: 'ct', label: 'City', tier: 'low', source: 'Not collected yet',
    what: 'The customer\'s city.',
    why: 'Broader than a PIN code and correspondingly weaker. Only worth enabling once you actually capture it.',
    normalisation: 'Lowercased, spaces and punctuation removed. Then hashed.',
  },
  {
    key: 'st', label: 'State', tier: 'low', source: 'Not collected yet',
    what: 'The customer\'s state.',
    why: 'The weakest geographic key — a state holds millions of people. Include it only alongside stronger keys.',
    normalisation: 'Lowercased two-letter code where possible. Then hashed.',
  },
  {
    key: 'country', label: 'Country', tier: 'low', source: 'Derived from phone',
    what: 'Two-letter country code, derived from the phone number\'s dialling code.',
    why: 'Almost free to send and helps Meta scope the match, but on its own it narrows nothing when your whole audience is in one country.',
    normalisation: 'Two-letter ISO code, lowercased. Then hashed.',
  },
];

const MATCH_KEY_TIERS = { high: 'Strong match key', medium: 'Combination booster', low: 'Weak on its own' };

// Fields we hold that Meta has NO matching parameter for. They can still travel
// as custom_data — useful in Events Manager for breakdowns — but they do NOT
// improve matching, and the UI must say so rather than implying a stronger signal.
const NON_MATCHING_PROPERTIES = [
  { key: 'age', label: 'Age', why: 'Meta matches on date of birth (db), which an age alone cannot produce — a birth year is not a birth date. Sent as a custom property only.' },
  { key: 'profession', label: 'Profession', why: 'Meta has no matching parameter for occupation at all. Sent as a custom property only.' },
];

// ── Meta's learning phase ────────────────────────────────────────────────────
// The number every marketer eventually asks about. Meta's optimiser needs a
// steady volume of the SAME event before it can learn who to show the ad to;
// below that it is effectively guessing, and results swing wildly.
const LEARNING_PHASE = {
  weeklyTarget: 50,
  window: 7,
  headline: 'Meta needs about 50 conversions per ad set per week to optimise properly.',
  detail: [
    'Meta calls the period before it has enough data the "learning phase". During it the optimiser experiments, cost per result is unstable, and comparing two ads tells you very little.',
    'The threshold is roughly 50 of the SAME optimisation event per AD SET per week — not per campaign, and not 50 across different events. An ad set sending 20 Purchases and 30 Leads is not at 50; it is at 20 and 30, and both are short.',
    'This is why mapping a rarer, stronger event is a real trade-off. Purchase is the signal you actually care about, but if you only make a handful of sales a week Meta may never leave the learning phase on it. Mapping an earlier stage as well gives the optimiser volume to learn from while Purchase carries the value.',
    'If you cannot reach the threshold on sales, the usual fixes are to consolidate ad sets rather than run many small ones, or to optimise for the earlier event and use Purchase for reporting.',
  ],
  belowTargetHint: 'Below the threshold Meta keeps re-learning, so treat cost-per-result differences between ads as noise rather than evidence.',
};

// ── Tab-wide notes ───────────────────────────────────────────────────────────
// Every control on the Conversion API tab gets a plain-English explanation from
// here, so the guidance is consistent instead of some controls being documented
// and others not. Keyed by a note id the frontend references.
const NOTE_CATALOG = {
  master_switch: {
    title: 'The master switch',
    body: [
      'While this is off, stage changes are still recorded but nothing is sent to Meta. Turning it on does NOT replay history — only stage changes from that moment forward are transmitted, which is deliberate: flipping the switch should never blast months of old conversions into your ad account.',
      'To send the ones already waiting, use "Send eligible now". That is the explicit, reviewable action.',
    ],
  },
  mode: {
    title: 'Test versus live',
    body: [
      'Test mode routes everything through your test event code. Events appear in Events Manager under Test Events so you can confirm the shape is right, and they do NOT reach the optimiser or affect delivery.',
      'Live mode means Meta counts the conversion and uses it to decide who sees your ads. Validate in test first, then switch.',
      'Test and live are tracked separately, so validating in test never blocks the same conversion from being sent for real later.',
    ],
  },
  attribution_window: {
    title: 'Attribution window',
    body: [
      'How old an ad click may be and still get credit for a conversion. Someone who clicked an ad four months ago and enrols today probably did not enrol because of that ad.',
      'This is your own guard and is separate from Meta\'s own attribution settings in Ads Manager.',
      'Note the other, harder limit: Meta refuses any event describing something that happened more than 7 days ago. Those are skipped rather than back-dated, because back-dating an old sale into this week would inflate the return of a spend window that did not earn it.',
    ],
  },
  dataset: {
    title: 'Datasets',
    body: [
      'Conversions are posted to a dataset owned by a WhatsApp Business Account. A click can only be reported to the dataset of the account it actually landed on — sending it elsewhere means Meta cannot connect it to the ad.',
      'If clicks are arriving on an account with no dataset, those conversions are skipped until you create one here.',
    ],
  },
  click_id: {
    title: 'What a click ID is',
    body: [
      'When someone taps a click-to-WhatsApp ad, Meta attaches a click ID (ctwa_clid) to the first message they send you. It is the only thing that ties that conversation back to a specific ad.',
      'No click ID means no attribution: the person may still be a real lead, but Meta cannot be told which ad produced them. That is normal for anyone who messaged you from a bio link, a saved number, or an organic post.',
      'The click ID is not personal data and is the one value sent to Meta unhashed — it is Meta\'s own token.',
    ],
  },
  customer_info: {
    title: 'Sending customer information',
    body: [
      'The click ID tells Meta WHICH AD produced a sale. Customer information tells it WHO bought, so it can match that person to a Meta profile and go looking for more people like them.',
      'Every value is hashed with SHA-256 before it leaves this server, so Meta receives a fingerprint it can compare against its own hashes, never the actual email or phone number.',
      'More matched keys is better, but the keys are not equal. Phone and email do the real work; names help in combination; PIN code, city and state cannot identify anyone on their own and only add confidence on top of a stronger key. Sending everything you have is fine — just do not expect a PIN code alone to change delivery.',
      'Watch Event Match Quality in Events Manager after switching this on. It scores how well Meta could match your events, and it is the honest feedback loop for whether this is working.',
    ],
  },
  performance: {
    title: 'Reading the before and after',
    body: [
      'This compares the period before conversions started flowing with the period since. It is a comparison, not a controlled experiment: budgets, creatives and seasonality all move at the same time, so treat a change as a signal to look closer rather than proof the Conversion API caused it.',
      'Expect nothing immediately. Meta needs enough conversions to leave the learning phase before delivery meaningfully changes, so give it a couple of weeks at a realistic volume before judging.',
    ],
  },
};

const crypto = require('crypto');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
}

// Meta specifies an exact normalisation per key, and a mismatch here is
// invisible: the hash simply never matches anyone and the event still returns
// 200 OK. Getting this wrong looks identical to getting it right.
function normalizeMatchValue(key, raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  if (!v) return null;

  switch (key) {
    case 'em':
      v = v.toLowerCase();
      // A value that isn't an email would hash to a guaranteed non-match, so
      // drop it rather than send noise (the sale profile sometimes carries a
      // name in the email box).
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
    case 'ph': {
      v = v.replace(/\D/g, '');
      // Meta wants the country code included. A bare 10-digit Indian mobile
      // would match nobody, so assume +91 — every number in this CRM is stored
      // with its country code already, this only rescues hand-entered rows.
      if (v.length === 10) v = `91${v}`;
      return v.length >= 8 ? v : null;
    }
    case 'fn':
    case 'ln':
    case 'ct':
      return v.toLowerCase().replace(/[^a-z]/g, '') || null;
    case 'st':
      return v.toLowerCase().replace(/[^a-z]/g, '') || null;
    case 'zp':
      v = v.replace(/\s/g, '').toLowerCase();
      return v || null;
    case 'country':
      v = v.toLowerCase().replace(/[^a-z]/g, '');
      return v.length === 2 ? v : null;
    case 'external_id':
      return v;
    default:
      return v;
  }
}

// Split a display name into first/last. A single-word name is a first name —
// duplicating it into ln would send a hash that matches nobody.
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { fn: null, ln: null };
  if (parts.length === 1) return { fn: parts[0], ln: null };
  return { fn: parts[0], ln: parts.slice(-1)[0] };
}

// Country from the phone's dialling code. Deliberately tiny — only the codes
// this business actually sees. An unknown code returns null rather than a guess,
// because a wrong country hash is worse than an absent one.
const DIAL_COUNTRY = { 91: 'in', 971: 'ae', 974: 'qa', 968: 'om', 965: 'kw', 966: 'sa', 973: 'bh', 1: 'us', 44: 'gb' };
function countryFromPhone(digits) {
  if (!digits) return null;
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (DIAL_COUNTRY[code]) return DIAL_COUNTRY[code];
  }
  return null;
}

// Which Meta keys are fed by a chosen CRM column, and which are derived.
// external_id is deliberately absent: it comes from the click id so it stays
// stable across a deleted sale or a returning customer, which no lead column can
// promise. `country` is derived from the phone unless a column is mapped.
const MAPPABLE_KEYS = ['ph', 'em', 'fn', 'ln', 'zp', 'ct', 'st', 'country'];

const DEFAULT_FIELD_SOURCES = {
  ph: 'whatsapp_number', em: 'email', fn: 'name', ln: 'name',
  zp: 'pincode', ct: 'city', st: 'state',
};

// Pull the raw value for one Meta key out of a lead row, given the admin's
// chosen source column. fn/ln always tokenise their source, so mapping either a
// full-name column or a dedicated first-name column both behave correctly:
// first token for fn, last token for ln (null when the name is a single word,
// because duplicating it would send a hash matching nobody).
function rawValueForKey(key, leadRow, sources) {
  if (!leadRow) return null;
  const col = (sources && sources[key]) || DEFAULT_FIELD_SOURCES[key] || null;
  if (!col) return null;
  const v = leadRow[col];
  if (v == null || v === '') return null;
  if (key === 'fn') return splitName(v).fn;
  if (key === 'ln') return splitName(v).ln;
  return v;
}

/**
 * Build the hashed user_data block for one conversion.
 *
 * `values` is already resolved per Meta key by the caller (which owns the
 * column mapping), so this function stays purely about normalisation + hashing
 * and can be unit-checked without a database.
 *
 * Returns { userData, keysSent } — keysSent is the flat list of match keys that
 * actually carried a value, which is what the history log and the UI report as
 * match quality. A key that is enabled but empty is simply absent: sending an
 * empty or placeholder hash would count as a failed match on Meta's side.
 */
function buildUserData({ ctwaClid, wabaId, values, enabledFields }) {
  const userData = {
    ctwa_clid: ctwaClid,
    whatsapp_business_account_id: String(wabaId),
  };
  const keysSent = [];
  if (!values || !enabledFields) return { userData, keysSent };

  const candidates = { ...values };
  // Country falls back to the phone's dialling code when no column supplies it.
  if (candidates.country == null) {
    candidates.country = countryFromPhone(normalizeMatchValue('ph', candidates.ph));
  }

  for (const { key } of MATCH_KEY_CATALOG) {
    if (enabledFields[key] !== true) continue;
    const norm = normalizeMatchValue(key, candidates[key]);
    if (norm == null) continue;
    userData[key] = sha256(norm);
    keysSent.push(key);
  }

  return { userData, keysSent };
}

// ── Event construction ───────────────────────────────────────────────────────

// One CTWA conversion event. `eventTime` is seconds since epoch — Meta rejects
// events more than 7 days old, which the caller guards against.
function buildCtwaEvent({ eventName, eventTime, ctwaClid, wabaId, pageId, eventId, value, currency, customData, userData }) {
  const event = {
    event_name: eventName,
    event_time: eventTime,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData || {
      ctwa_clid: ctwaClid,
      whatsapp_business_account_id: String(wabaId),
    },
  };
  // Meta documents whatsapp_business_account_id for WhatsApp CTWA and page_id
  // for Messenger/Instagram. Sent ALONGSIDE, never instead — swapping a working
  // attribution key for the other one would break attribution silently, and
  // sending both costs nothing.
  if (pageId) event.user_data.page_id = String(pageId);
  if (eventId) event.event_id = eventId;

  const cd = { ...(customData || {}) };
  if (value != null && Number.isFinite(Number(value))) {
    cd.value = Number(value);
    cd.currency = currency || 'INR';
  }
  if (Object.keys(cd).length) event.custom_data = cd;

  return event;
}

// POST events to the dataset. Returns the raw outcome (never throws on a Meta
// rejection — the caller logs both outcomes to capi_events, and a failed
// transmission is data, not an exception).
// Retrying a POST is safe here: every event carries a deterministic event_id, so
// if the first attempt actually landed before the connection dropped, Meta
// deduplicates the retry instead of double-counting the conversion.
async function sendEvents(token, datasetId, events, { testEventCode } = {}) {
  const payload = { data: events, partner_agent: 'ForgeGrowth' };
  if (testEventCode) payload.test_event_code = testEventCode;

  let res, body;
  try {
    res = await withRetry(() => fetch(`${BASE}/${datasetId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: token }),
      signal: AbortSignal.timeout(30000),
    }));
    body = await res.json().catch(() => ({}));
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      eventsReceived: 0,
      fbtraceId: null,
      error: err.name === 'TimeoutError' ? 'Meta request timed out' : err.message,
      request: payload,
      response: null,
    };
  }

  const metaErr = body && body.error;
  return {
    ok: res.ok && !metaErr,
    httpStatus: res.status,
    eventsReceived: Number(body?.events_received || 0),
    fbtraceId: (metaErr && metaErr.fbtrace_id) || body?.fbtrace_id || null,
    error: metaErr ? (metaErr.error_user_msg || metaErr.message || `Meta API ${res.status}`) : null,
    request: payload,
    response: body || null,
  };
}

module.exports = {
  getWabaDataset,
  createWabaDataset,
  buildCtwaEvent,
  sendEvents,
  STANDARD_EVENTS,
  VALUE_EVENTS,
  EVENT_CATALOG,
  EVENT_GROUPS,
  MATCH_KEY_CATALOG,
  MATCH_KEY_TIERS,
  MAPPABLE_KEYS,
  DEFAULT_FIELD_SOURCES,
  rawValueForKey,
  NON_MATCHING_PROPERTIES,
  NOTE_CATALOG,
  LEARNING_PHASE,
  buildUserData,
  normalizeMatchValue,
  splitName,
  sha256,
  META_API_VERSION,
};
