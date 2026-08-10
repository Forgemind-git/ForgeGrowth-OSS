// Shape and formatting rules for lead-form answers.
//
// This exists because a form answer is read by five separate consumers — the
// required-field check, the lead custom-field bag, the CSV export, the
// dashboard breakdown and the {{form.<slug>.<key>}} follow-up resolver — and
// the `rating` type is the first answer that is NOT a scalar. Every one of
// those consumers assumed a string or an array, and each fails DIFFERENTLY on
// an object: the required check passes an unrated field (an object is truthy),
// the export writes "[object Object]", and the follow-up resolver would send
// that literal text to a customer over WhatsApp. None of them error.
//
// So the rule lives here once, and each consumer calls it rather than
// re-deriving it. The frontend mirror is `frontend/src/lib/formAnswers.js` —
// keep the two in step (same reason `normalizeMessage` is mirrored for message
// formats: a silent divergence is the failure mode, not a crash).

// Allowed star scales. A rating out of 4 and a rating out of 5 are different
// questions, so the scale is stored per field rather than assumed.
const RATING_SCALES = [3, 4, 5, 10];
const DEFAULT_RATING_SCALE = 5;
const DEFAULT_FEEDBACK_LABEL = 'Anything you would like to add? (optional)';

// Types that collect nothing from the respondent. A section is a heading the
// admin drops between questions; it has no answer, so it must never be
// required, never mapped to a lead column, and never take up an export column.
const DISPLAY_ONLY_TYPES = ['section'];
const isDisplayOnly = (type) => DISPLAY_ONLY_TYPES.includes(type);

function ratingScale(field) {
  const n = parseInt(field?.scale, 10);
  return RATING_SCALES.includes(n) ? n : DEFAULT_RATING_SCALE;
}

// Normalise whatever arrived on the wire into { rating, feedback }. Written
// defensively because this parses a PUBLIC, unauthenticated request body: the
// submit endpoint is reachable by anyone holding the form link, so the value
// may be a string, a number, null, or an object with junk in it.
function normalizeRating(field, value) {
  const max = ratingScale(field);
  let rating = null;
  let feedback = '';
  if (Array.isArray(value)) {
    // An array is never a rating. Without this it falls to parseInt(String(v)),
    // and parseInt('1,2') is 1 — so a junk array posted to a public endpoint
    // would be recorded as a real one-star score.
    rating = NaN;
  } else if (value && typeof value === 'object') {
    rating = parseInt(value.rating, 10);
    feedback = typeof value.feedback === 'string' ? value.feedback : '';
  } else {
    rating = parseInt(value, 10);
  }
  // Out-of-range is discarded rather than clamped: clamping a 9 sent to a
  // 5-star field into "5" would record a top rating nobody gave.
  if (!Number.isFinite(rating) || rating < 1 || rating > max) rating = null;
  return { rating, feedback: feedback.slice(0, 2000), max };
}

// The single emptiness rule. `required` is enforced against THIS, so a rating
// field with feedback typed but no star selected still counts as unanswered —
// the star is the question.
function isEmptyAnswer(field, value) {
  if (isDisplayOnly(field?.type)) return true;
  if (field?.type === 'rating') return normalizeRating(field, value).rating == null;
  if (Array.isArray(value)) return value.length === 0;
  return value == null || value === '';
}

// The single display rule. Anything that reaches a human — a CSV cell, a table
// cell, a WhatsApp variable — goes through here, so no consumer can produce
// "[object Object]".
// `separator` is a parameter because the CSV export has always joined
// multi-select answers with '; ' while the UI reads better with ', '. Routing
// both through one function must not silently rewrite the column format of
// every export anyone already has a parser for.
// One value -> one string. Split out so an array element and a bare value can
// never diverge in how they render.
function scalarToText(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function answerToText(field, value, { separator = ', ' } = {}) {
  if (isDisplayOnly(field?.type)) return '';
  if (field?.type === 'rating') {
    const { rating, feedback, max } = normalizeRating(field, value);
    if (rating == null) return feedback ? feedback.trim() : '';
    const stars = `${rating}/${max}`;
    return feedback.trim() ? `${stars} - ${feedback.trim()}` : stars;
  }
  if (value == null) return '';
  // Each ELEMENT goes through the same object rule as a bare value. A plain
  // String(v) on an object element yields "[object Object]" — the exact string
  // this module exists to make impossible — in the CSV and in a WhatsApp
  // variable sent to a customer.
  if (Array.isArray(value)) return value.map(v => scalarToText(v)).join(separator);
  return scalarToText(value);
}

module.exports = {
  RATING_SCALES,
  DEFAULT_RATING_SCALE,
  DEFAULT_FEEDBACK_LABEL,
  isDisplayOnly,
  ratingScale,
  normalizeRating,
  isEmptyAnswer,
  answerToText,
};
