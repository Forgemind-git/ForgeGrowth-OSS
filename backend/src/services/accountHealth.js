// Centralised health-state writer for whatsapp_accounts. Called from the send
// queue worker (on Meta API failures) and from templates.submit. Lets the UI
// show a "Token expired, update now" banner instead of letting failures pile
// up silently.

const pool = require('../db');

// Meta error codes that are MESSAGE-level — a single send failed because of its
// own content, the recipient, or the 24-hour messaging window. These are NOT
// account-health problems: the token is valid and other sends still succeed, so
// they must never flip the whole account's banner to "Error". Each failure is
// already recorded per-message (broadcast_logs / chat_history.status='failed').
const MESSAGE_LEVEL_CODES = new Set([
  131026, // Message undeliverable (recipient can't receive / not on WhatsApp)
  131047, // Re-engagement required — outside the 24h window, needs a template
  131051, // Unsupported message type
  131053, // Media upload error for this specific message
  131056, // Per-recipient pair rate limit (too many to this one number)
  470,    // Re-engagement (legacy 24h-window code)
  132000, // Template parameter count mismatch
  132001, // Template name/language does not exist (not approved on this WABA)
  132005, // Template hydrated text too long
  132007, // Template content policy violation
  132012, // Template parameter format mismatch
  132015, // Template is paused
  132016, // Template is disabled
  131008, // Required parameter missing
  131009, // Parameter value invalid
]);

/**
 * Classify an error from Meta and persist it on the account row.
 * @param {number|string} accountId
 * @param {'healthy'|'invalid_token'|'rate_limited'|'unknown_error'|'message_error'} status
 * @param {string} [message]
 */
async function markAccountHealth(accountId, status, message = null) {
  if (!accountId) return;
  // Message-level failures are not account health — leave the banner untouched.
  if (status === 'message_error') return;
  try {
    if (status === 'healthy') {
      await pool.query(
        `UPDATE coexistence.whatsapp_accounts
            SET health_status = 'healthy',
                last_success_at = NOW(),
                last_error_message = NULL
          WHERE id = $1`,
        [accountId]
      );
    } else {
      await pool.query(
        `UPDATE coexistence.whatsapp_accounts
            SET health_status = $1,
                last_error_at = NOW(),
                last_error_message = $2
          WHERE id = $3`,
        [status, (message || '').slice(0, 500), accountId]
      );
    }
  } catch (err) {
    console.error('[accountHealth] update failed:', err.message);
  }
}

/**
 * Classify a thrown error from metaSend/metaTemplates into a health status.
 */
function classifyMetaError(err) {
  if (!err) return 'unknown_error';
  const code = err.metaError?.code;
  if (err.status === 401 || code === 190 || code === 0) return 'invalid_token';
  if (err.status === 429 || code === 4 || code === 80007 || code === 130429) return 'rate_limited';
  if (MESSAGE_LEVEL_CODES.has(code)) return 'message_error';
  return 'unknown_error';
}

module.exports = { markAccountHealth, classifyMetaError };
