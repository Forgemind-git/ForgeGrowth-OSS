// Frontend mirror of backend/src/services/formAnswers.js — keep the two in step.
//
// A mirror rather than a shared import because the backend is CommonJS in its
// own container and the frontend is a separate bundle. The risk of a mirror is
// that it drifts SILENTLY: if the two emptiness rules disagree, the form lets a
// respondent submit and the server answers 400 on a field they thought they had
// filled in. So this file holds the rules and nothing else, and every frontend
// consumer imports from here rather than re-deriving them inline.

export const RATING_SCALES = [3, 4, 5, 10];
export const DEFAULT_RATING_SCALE = 5;
export const DEFAULT_FEEDBACK_LABEL = 'Anything you would like to add? (optional)';

const DISPLAY_ONLY_TYPES = ['section'];
export const isDisplayOnly = (type) => DISPLAY_ONLY_TYPES.includes(type);

export function ratingScale(field) {
  const n = parseInt(field?.scale, 10);
  return RATING_SCALES.includes(n) ? n : DEFAULT_RATING_SCALE;
}

export function normalizeRating(field, value) {
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
  if (!Number.isFinite(rating) || rating < 1 || rating > max) rating = null;
  return { rating, feedback, max };
}

// The starting value for a field with nothing filled in. Each type needs the
// shape its input expects, or the first keystroke changes the value's type.
export function emptyAnswerFor(field) {
  if (field?.type === 'checkbox') return [];
  if (field?.type === 'rating') return { rating: null, feedback: '' };
  return '';
}

// Shared with the server so "Required" means the same thing on both sides. A
// rating counts as answered only when a STAR is chosen — typed feedback alone
// does not satisfy it, because the star is the question.
export function isEmptyAnswer(field, value) {
  if (isDisplayOnly(field?.type)) return true;
  if (field?.type === 'rating') return normalizeRating(field, value).rating == null;
  if (Array.isArray(value)) return value.length === 0;
  return value == null || value === '';
}

// Every human-facing render of an answer goes through this. Rendering a raw
// answer is not safe: a rating is an object, and React throws "Objects are not
// valid as a React child" on one — which, with no error boundary in this app,
// blanks the entire page rather than breaking one cell.
// One value -> one string. Split out so an array element and a bare value can
// never diverge in how they render.
function scalarToText(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function answerToText(field, value, { separator = ', ' } = {}) {
  if (isDisplayOnly(field?.type)) return '';
  if (field?.type === 'rating') {
    const { rating, feedback, max } = normalizeRating(field, value);
    if (rating == null) return feedback.trim() || '';
    const stars = `${rating}/${max}`;
    return feedback.trim() ? `${stars} - ${feedback.trim()}` : stars;
  }
  if (value == null) return '';
  // Each ELEMENT goes through the same object rule as a bare value. A plain
  // String(v) on an object element yields "[object Object]" — the exact string
  // this module exists to make impossible.
  if (Array.isArray(value)) return value.map(v => scalarToText(v)).join(separator);
  return scalarToText(value);
}
