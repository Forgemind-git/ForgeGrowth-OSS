// Global, app-wide notification bus. Lets any module — components, api callers,
// or catch blocks — surface a message in a single shared modal, replacing the
// native alert() top-popups used throughout the app. Mount <FeedbackModal/>
// exactly once near the App root; it subscribes here.
//
//   import { showError, showSuccess, notify } from '../lib/feedback';
//   showError('Could not save the contact.');
//   showSuccess('Broadcast sent to 120 contacts.');
//
// notify() accepts a string or { variant, title, message }. When no variant is
// given it's inferred from the text (success-ish wording → success, else error)
// so the bulk alert()→notify() swap keeps the right colour without hand-editing
// every call site.

let listener = null;
let queue = [];

const SUCCESS_RE = /(^\s*[✓✅])|\b(success|succeeded|sent|saved|created|updated|deleted|removed|copied|connected|disconnected|imported|enabled|disabled|added|scheduled|approved|submitted|done)\b/i;
const FAILURE_RE = /\b(fail|failed|error|invalid|wrong|could ?n.?t|cannot|can.?t|unable|denied|not allowed|forbidden|required|missing|expired|too large|too fast)\b/i;

function inferVariant(message) {
  const m = String(message || '');
  if (SUCCESS_RE.test(m) && !FAILURE_RE.test(m)) return 'success';
  return 'error';
}

export function notify(payload) {
  const item = typeof payload === 'string' ? { message: payload } : (payload || {});
  const message = item.message == null ? '' : String(item.message);
  const entry = {
    variant: item.variant || inferVariant(message),
    title: item.title || null,
    message,
    // monotonic key so the host re-renders even for identical consecutive messages
    _k: (notify._k = (notify._k || 0) + 1),
  };
  if (listener) listener(entry);
  else queue.push(entry); // host not mounted yet — replay once it subscribes
}

export const showError   = (message, title) => notify({ variant: 'error',   message, title });
export const showSuccess = (message, title) => notify({ variant: 'success', message, title });
export const showInfo    = (message, title) => notify({ variant: 'info',    message, title });

// Internal: used only by <FeedbackModal/>.
export function _subscribe(fn) {
  listener = fn;
  if (queue.length) {
    const pending = queue;
    queue = [];
    pending.forEach(fn);
  }
  return () => { if (listener === fn) listener = null; };
}
