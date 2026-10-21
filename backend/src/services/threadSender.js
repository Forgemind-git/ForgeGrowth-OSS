// ─── Free-form message on one WhatsApp thread ───────────────────────────────
//
// sendOnThread() is the one window-aware sender for a single plain text /
// buttons / link message to a customer, used by the agent limit-reached notice
// and the workflow-agent send_whatsapp action. It refuses up front when the
// 24-hour window is closed, instead of logging a send Meta will reject.
//
// ensureThreadSenderColumns() owns automation_executions.awaiting_kind, which
// the automation engine reads to know what a paused run is waiting for.

const pool = require('../db');
const { resolveAccount, insertPendingRow, secondsSinceLastIncoming } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));

// Meta's customer-service window. A free-form text outside it is rejected by
// Meta, so we report that honestly instead of logging a phantom success.
const WINDOW_SECONDS = 24 * 60 * 60;

async function ensureThreadSenderColumns() {
  await pool.query(`ALTER TABLE coexistence.automation_executions ADD COLUMN IF NOT EXISTS awaiting_kind TEXT NOT NULL DEFAULT 'reply';`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_executions_awaiting
      ON coexistence.automation_executions(wa_number, contact_number, awaiting_kind)
      WHERE status = 'paused';`);
}

/**
 * Send a plain text message on a chat thread.
 *
 * Returns { sent, reason } — never throws for a business reason like a closed
 * 24h window, because every caller here is a background sweeper whose job is to
 * record what happened, not to crash.
 */
/**
 * @param {{text:string,url:string}} [link] send a tappable BUTTON under the
 *   body instead of leaving the URL in the text. Same 24-hour rule either way —
 *   an interactive message is still free-form to Meta — so the guard below is
 *   deliberately shared rather than duplicated for the button case.
 */
/**
 * @param {{title:string}[]} [buttons] reply buttons under the body. A TAP on one
 *   arrives as an ordinary inbound, which is what lets a paused automation
 *   resume on it — the reason this exists rather than another link button.
 *   Meta allows at most 3, each ≤20 characters.
 */
/**
 * @param {number} [headerMediaLibraryId] a picture above the body, resolved to a
 *   Meta media id for THIS account. Only valid alongside reply buttons.
 */
async function sendOnThread({ waNumber, contactNumber, body, requireWindow = true, link = null, buttons = null, headerMediaLibraryId = null }) {
  const text = (body || '').trim();
  if (!text) return { sent: false, reason: 'empty_message' };

  // Meta caps the button label at 20 characters and refuses a non-https URL.
  // Checked here so a bad button degrades to a normal text message with the
  // link in the body, rather than the whole message failing at the API.
  const replies = Array.isArray(buttons)
    ? buttons.map((b, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: String(b.title || b).trim().slice(0, 20) } }))
        .filter(b => b.reply.title).slice(0, 3)
    : [];

  let cta = null;
  if (link && link.url && /^https:\/\//i.test(link.url)) {
    cta = { display_text: String(link.text || 'Open').trim().slice(0, 20) || 'Open', url: link.url };
  } else if (link) {
    console.warn(`[threadSender] button dropped, not an https link: ${link.url}`);
  }

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

  // Buttons win over a link button: they are the only one of the two that can
  // hand the conversation back to an automation.
  // A picture above the buttons. Resolved per account, and a failure drops the
  // IMAGE only — the buttons are what move the customer on.
  let header = null;
  if (replies.length && headerMediaLibraryId) {
    try {
      const { metaMediaIdForLibrary } = require('../engine/automationEngine');
      const client = await pool.connect();
      try { header = { type: 'image', image: { id: await metaMediaIdForLibrary(client, headerMediaLibraryId, account.id) } }; }
      finally { client.release(); }
    } catch (err) {
      console.warn(`[threadSender] header image skipped (media ${headerMediaLibraryId}): ${err.message}`);
    }
  }

  const interactive = replies.length
    ? { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: replies }, ...(header ? { header } : {}) }
    : cta
      ? { type: 'cta_url', body: { text: text.slice(0, 1024) }, action: { name: 'cta_url', parameters: cta } }
      : null;

  const localId = await insertPendingRow({
    account, toNumber: contactNumber,
    messageType: interactive ? 'interactive' : 'text', messageBody: text,
  });
  await enqueueSend({
    kind: interactive ? 'interactive' : 'text',
    accountId: account.id,
    to: digits(contactNumber),
    localMessageId: localId,
    payload: interactive ? { interactive } : { body: text, previewUrl: true },
  });
  return { sent: true, localMessageId: localId };
}

module.exports = { ensureThreadSenderColumns, sendOnThread };
