const crypto = require('crypto');
const { Router } = require('express');
const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { evaluateTriggers, evaluateOutboundTriggers, resumeAutomation } = require('../engine/automationEngine');
const agentRouter = require('../services/agentRouter');
const { markPending, MEDIA_TYPES } = require('../services/mediaDownloader');
const { enqueueMediaDownload } = require('../queue/mediaQueue');
const bus = require('../events');
const { ensureLeadForContact, deriveLeadSource } = require('./leads');
const messageFormats = require('../services/messageFormats');
const { recordCtwaReferral, linkReferralsToLead } = require('./ctwa');
const { matchByHash } = require('../util/wamid');

const router = Router();

// Delivery-status rank for monotonic updates — a receipt may only move a
// message FORWARD (sending → sent → delivered → read), never backward. Meta
// re-sends and reorders status webhooks, so without this a late 'delivered'
// (or a duplicate 'sent') would clobber an already-'read' message and the blue
// double-tick would regress to grey. 'failed' is allowed to overwrite anything
// up to delivered (a genuine send failure must surface) but not 'read'.
const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3, played: 3, failed: 2 };

/** Constant-time string compare that tolerates length mismatches. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/**
 * Best-effort audit logger. Inserts immediately on receipt so even payloads
 * that crash the parser are visible in the Webhooks tab. Returns the row id
 * so the handler can UPDATE the same row with the processing outcome.
 *
 * Never throws — webhook handling must continue even if the audit table is
 * unreachable (we always return 200 to Meta to avoid retry storms).
 */
function inferPayloadKind(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  if (body?.verify === true) return 'verify';
  if (body.object !== 'whatsapp_business_account') return 'unknown';
  const change = body.entry?.[0]?.changes?.[0];
  if (!change) return 'unknown';
  const field = change.field;
  if (field === 'message_template_status_update') return 'template_status_update';
  if (field === 'account_update') return 'account_update';
  const value = change.value || {};
  // Echoes get their own kind so the Webhooks tab can distinguish "sent from
  // the WA Business app" (SMB echo) from inbound customer messages.
  if (Array.isArray(value.message_echoes) && value.message_echoes.length > 0) {
    return field === 'smb_message_echoes' ? 'smb_message_echoes' : 'message_echoes';
  }
  if (Array.isArray(value.messages) && value.messages.length > 0) return 'messages';
  if (Array.isArray(value.statuses) && value.statuses.length > 0) return 'statuses';
  return field || 'unknown';
}

/**
 * Granular subtype — what kind of message or status this payload carries.
 *  - messages    → text / image / video / audio / voice / document / location /
 *                  sticker / contacts / interactive / reaction / order / system
 *  - statuses    → sent / delivered / read / failed
 *  - template_*  → APPROVED / REJECTED / PAUSED / DISABLED / etc.
 *  - verify      → 'handshake'
 */
function inferPayloadSubtype(body) {
  if (body?.verify === true) return 'handshake';
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;
  if (Array.isArray(value.messages) && value.messages.length > 0) return value.messages[0].type || null;
  if (Array.isArray(value.statuses) && value.statuses.length > 0) return value.statuses[0].status || null;
  if (Array.isArray(value.message_echoes) && value.message_echoes.length > 0) return value.message_echoes[0].type || null;
  if (value.event) return String(value.event);
  return null;
}

function pickPhoneNumberId(body) {
  return body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
}

// WABAs we own but don't register as full accounts (e.g. the Meta test number).
// These bypass the "unregistered WABA" drop so their messages keep flowing.
const EXTRA_ALLOWED_WABAS = (process.env.WEBHOOK_EXTRA_ALLOWED_WABAS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

async function logWebhookReceived({ payload, headers, remoteIp, source }) {
  try {
    const kind = inferPayloadKind(payload);
    const subtype = inferPayloadSubtype(payload);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.webhook_events
         (source, remote_ip, request_headers, payload, payload_kind, payload_subtype, meta_object, phone_number_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        source || 'meta',
        remoteIp || null,
        JSON.stringify(headers || {}),
        JSON.stringify(payload),
        kind,
        subtype,
        payload?.object || null,
        pickPhoneNumberId(payload),
      ]
    );
    return rows[0].id;
  } catch (err) {
    console.error('[webhook-audit] insert failed:', err.message);
    return null;
  }
}

async function logWebhookProcessed(id, { status, recordsExtracted, error, processingMs }) {
  if (!id) return;
  try {
    await pool.query(
      `UPDATE coexistence.webhook_events
          SET processing_status = $1,
              records_extracted = $2,
              processing_error = $3,
              processing_ms = $4
        WHERE id = $5`,
      [status, recordsExtracted || 0, error || null, processingMs || null, id]
    );
  } catch (err) {
    console.error('[webhook-audit] update failed:', err.message);
  }
}

/**
 * Parse a Meta WhatsApp Cloud API webhook payload and extract message records.
 * Handles: text, image, video, audio, document, location, sticker, contacts,
 *          interactive (button_reply / list_reply), reaction, and status updates.
 */
// Normalize WhatsApp phone numbers to digits-only — strips '+', spaces, dashes.
// Meta sometimes includes leading '+' in display_phone_number, sometimes not;
// without this, the same conversation lands under two different wa_numbers and
// shows as duplicate chat threads.
function normalizePhone(s) {
  if (!s) return s;
  return String(s).replace(/\D/g, '');
}

function parseMetaPayload(body) {
  const records = [];

  if (!body || body.object !== 'whatsapp_business_account') {
    return records;
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    // entry.id is the WhatsApp Business Account (WABA) id this payload belongs
    // to. We stamp it on every record so the POST handler can drop messages
    // from WABAs that aren't registered in coexistence.whatsapp_accounts
    // (Meta may deliver other tenants' webhooks here if our app is subscribed
    // to their WABA — see the unregistered-WABA filter below).
    const wabaId = entry.id || null;
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      if (value.messaging_product !== 'whatsapp') continue;

      const metadata = value.metadata || {};
      const phoneNumberId = metadata.phone_number_id || '';
      const displayPhoneNumber = metadata.display_phone_number || '';

      // Contact profile info (name mapping)
      const contactProfiles = {};
      (value.contacts || []).forEach(c => {
        const waId = c.wa_id || '';
        const name = c.profile?.name || '';
        if (waId && name) contactProfiles[waId] = name;
      });

      // Parse a single message (shared logic for incoming and outgoing)
      function parseMessage(msg, direction, waNum, contactNum) {
        const record = {
          message_id: msg.id || '',
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          wa_number: normalizePhone(waNum || displayPhoneNumber),
          contact_number: normalizePhone(contactNum || ''),
          to_number: normalizePhone(msg.to || ''),
          direction,
          message_type: msg.type || 'unknown',
          message_body: null,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          status: direction === 'incoming' ? 'received' : 'sent',
          timestamp: msg.timestamp
            ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[contactNum] || null,
          // Quote-reply: when the customer replies to a specific message, Meta
          // sends the quoted message's wamid here. Stored so we can render the
          // quoted bubble above their reply.
          context_message_id: msg.context?.id || null,
          // CTWA attribution: present on the first message when the customer
          // arrived via a click-to-WhatsApp ad / post CTA. Used to set the lead's
          // Funnel Source (Instagram Ad / Facebook Ad / organic / …).
          referral: msg.referral || null,
        };

        const type = msg.type;
        if (type === 'text' && msg.text) {
          record.message_body = msg.text.body || '';
        } else if (type === 'image' && msg.image) {
          record.message_body = msg.image.caption || '';
          record.media_mime_type = msg.image.mime_type || null;
          record.media_url = msg.image.id || null;
        } else if (type === 'video' && msg.video) {
          record.message_body = msg.video.caption || '';
          record.media_mime_type = msg.video.mime_type || null;
          record.media_url = msg.video.id || null;
        } else if (type === 'audio' && msg.audio) {
          record.message_body = 'Audio message';
          record.media_mime_type = msg.audio.mime_type || null;
          record.media_url = msg.audio.id || null;
        } else if (type === 'voice' && msg.voice) {
          record.message_body = 'Voice message';
          record.media_mime_type = msg.voice.mime_type || null;
          record.media_url = msg.voice.id || null;
        } else if (type === 'document' && msg.document) {
          record.message_body = msg.document.filename || '';
          record.media_mime_type = msg.document.mime_type || null;
          record.media_url = msg.document.id || null;
          record.media_filename = msg.document.filename || null;
        } else if (type === 'location' && msg.location) {
          const lat = msg.location.latitude || '';
          const lng = msg.location.longitude || '';
          record.message_body = `Location: ${lat}, ${lng}`;
        } else if (type === 'sticker' && msg.sticker) {
          record.message_body = 'Sticker';
          record.media_mime_type = msg.sticker.mime_type || null;
          record.media_url = msg.sticker.id || null;
        } else if (type === 'contacts' && msg.contacts) {
          const names = msg.contacts.map(c => c.name?.formatted_name || c.name?.first_name || 'Contact').join(', ');
          record.message_body = `Shared contact(s): ${names}`;
        } else if (type === 'interactive' && msg.interactive) {
          // The two interactive shapes were previously MERGED into one label,
          // after which a button tap was indistinguishable from a list choice.
          // `message_body` stays the display label (right for the chat bubble);
          // `reply_kind`/`reply_id` are the ROUTING key. Two different needs
          // that were being served by one column.
          //
          // Extracted HERE and not from `raw_payload` at resume time: that
          // column holds the WHOLE webhook batch, so any later extraction has
          // to re-find this message by `m.id === record.message_id` — the join
          // already documented as load-bearing for the CTWA backfill.
          const br = msg.interactive.button_reply;
          const lr = msg.interactive.list_reply;
          const reply = br || lr || {};
          record.message_body = reply.title || 'Interactive response';
          record.message_type = 'interactive';
          record.reply_kind = br ? 'button' : lr ? 'list' : null;
          record.reply_id = reply.id || null;
          record.reply_label = reply.title || null;
        } else if (type === 'button' && msg.button) {
          // A TEMPLATE quick-reply tap (distinct from `interactive`, which is a
          // button on a non-template interactive message). Meta sends
          // { button: { text, payload } }. Without this branch the row landed
          // with a NULL body — the bubble rendered empty AND no keyword trigger
          // could ever match the tap, so "tap the button to get the link" style
          // automations silently never fired.
          //
          // ⚠ This is the shape that matters here: EVERY button-bearing node in
          // production is a template, so a router that only understands
          // `interactive.button_reply.id` fixes nothing that is live. Unless we
          // injected a payload at send time, `payload` is Meta's echo of the
          // visible LABEL — hence the label fallback in resolveReplyHandle.
          record.message_body = msg.button.text || msg.button.payload || 'Button tap';
          record.message_type = 'button';
          record.reply_kind = 'template_button';
          record.reply_id = msg.button.payload || null;
          record.reply_label = msg.button.text || null;
        } else if (type === 'reaction' && msg.reaction) {
          record.message_body = `Reaction: ${msg.reaction.emoji || ''}`;
          record.message_type = 'reaction';
          // Capture the target message + emoji so the insert loop can attach it
          // to that message instead of creating a standalone bubble. Empty emoji
          // = the customer removed their reaction.
          record.reaction = {
            targetMessageId: msg.reaction.message_id || null,
            emoji: msg.reaction.emoji || '',
            from: msg.from || null,
          };
        } else if (type === 'order' && msg.order) {
          // Meta still delivers this shape if a catalog is enabled on the number
          // at Meta's end, so the branch stays — the message must land in the
          // chat rather than vanishing. The cart itself is not modelled here;
          // the full payload remains available in raw_payload.
          record.message_body = 'Order received';
        } else if (type === 'system' && msg.system) {
          record.message_body = msg.system.body || 'System message';
        } else if (type === 'unknown' && msg.errors) {
          record.message_body = `Error: ${msg.errors[0]?.message || 'Unknown error'}`;
          record.status = 'error';
        }

        return record;
      }

      // Incoming messages
      const messages = value.messages || [];
      for (const msg of messages) {
        records.push(parseMessage(msg, 'incoming', displayPhoneNumber, msg.from));
      }

      // Outgoing message echoes (messages sent from the WhatsApp Business app)
      const messageEchoes = value.message_echoes || [];
      for (const msg of messageEchoes) {
        // For echoes: from = business number, to = customer
        records.push(parseMessage(msg, 'outgoing', displayPhoneNumber, msg.to));
      }

      // Status updates (delivered, read, sent)
      const statuses = value.statuses || [];
      for (const status of statuses) {
        records.push({
          message_id: status.id || '',
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          wa_number: normalizePhone(displayPhoneNumber),
          contact_number: normalizePhone(status.recipient_id || ''),
          to_number: normalizePhone(status.recipient_id || ''),
          direction: 'outgoing',
          message_type: 'status',
          message_body: `Status: ${status.status || ''}`,
          raw_payload: JSON.stringify(body),
          media_url: null,
          media_mime_type: null,
          status: status.status || 'unknown',
          timestamp: status.timestamp
            ? new Date(parseInt(status.timestamp, 10) * 1000).toISOString()
            : new Date().toISOString(),
          contact_name: contactProfiles[status.recipient_id] || null,
          // Include full status payload for trigger evaluation
          conversation: status.conversation || null,
          pricing: status.pricing || null,
          errors: status.errors || null,
        });
      }
    }
  }

  return records;
}

/**
 * POST /api/webhook/whatsapp
 * Receives raw Meta WhatsApp webhook payloads forwarded by n8n.
 * No auth required — called by internal n8n instance.
 */
router.post('/webhook/whatsapp', async (req, res) => {
  const startTime = Date.now();
  const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  const source = req.headers['x-replay'] === '1' ? 'replay'
    : (req.headers['user-agent'] || '').toLowerCase().includes('n8n') ? 'n8n'
    : 'meta';
  const auditId = await logWebhookReceived({
    payload: req.body,
    headers: req.headers,
    remoteIp,
    source,
  });

  try {
    const payload = req.body;
    if (!payload) {
      await logWebhookProcessed(auditId, { status: 'error', error: 'Empty payload', processingMs: Date.now() - startTime });
      return res.status(400).json({ error: 'Empty payload' });
    }

    // Support both array of payloads (n8n batch) and single payload
    const payloads = Array.isArray(payload) ? payload : [payload];
    const parsedRecords = [];
    for (const p of payloads) {
      const records = parseMetaPayload(p);
      parsedRecords.push(...records);
    }

    // Drop records from WhatsApp Business Accounts we don't own. Meta delivers a
    // WABA's webhooks to EVERY app subscribed to it; if our app is (accidentally)
    // subscribed to another tenant's WABA, their customer conversations would
    // otherwise be stored here and surface as phantom "business numbers". We only
    // keep records whose waba_id matches a registered account. Matching at the
    // WABA (not phone_number_id) level means a NEW number added under one of our
    // existing accounts flows in automatically — no per-number registration.
    // Read live each request so newly-registered accounts take effect instantly.
    const { rows: waRows } = await pool.query(
      'SELECT DISTINCT waba_id FROM coexistence.whatsapp_accounts'
    );
    const allowedWabas = new Set(waRows.map(r => String(r.waba_id)));
    // Plus any extra WABAs we own but never registered as a full account — e.g.
    // the Meta-provided test number's WABA. Comma-separated in env so it isn't
    // mistaken for a foreign tenant and dropped.
    for (const w of EXTRA_ALLOWED_WABAS) allowedWabas.add(w);
    const allRecords = [];
    let rejectedCount = 0;
    for (const r of parsedRecords) {
      if (r.waba_id && allowedWabas.has(String(r.waba_id))) {
        allRecords.push(r);
      } else {
        rejectedCount++;
      }
    }
    if (rejectedCount > 0) {
      console.warn(`[webhook] Dropped ${rejectedCount} record(s) from unregistered WABA(s)`);
    }

    if (allRecords.length === 0) {
      // Acknowledge non-message webhooks (e.g. verification, errors) — or a
      // payload entirely from unregistered WABAs (all records dropped).
      await logWebhookProcessed(auditId, {
        status: 'processed',
        recordsExtracted: 0,
        error: rejectedCount > 0 ? `skipped ${rejectedCount} record(s) from unregistered WABA` : null,
        processingMs: Date.now() - startTime,
      });
      return res.status(200).json({ ok: true, stored: 0, skipped: rejectedCount });
    }

    // Status changes that actually moved a message forward — emitted over SSE
    // after commit so the open chat updates the tick in real time (no 15s wait).
    const statusUpdates = [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const r of allRecords) {
        // Status receipts (sent/delivered/read/failed) update the ORIGINAL
        // message's status — they must never create a chat row. Inserting them
        // produced phantom "Status: delivered" bubbles. If no matching message
        // exists (e.g. an app-sent message we don't track), this is a no-op.
        // Monotonic: only move forward so an out-of-order receipt can't regress
        // a 'read' (blue) back to 'delivered'/'sent' (grey).
        if (r.message_type === 'status') {
          const newRank = STATUS_RANK[r.status] ?? 0;
          // A receipt's wamid may encode a different participant identity than
          // the message row's (Meta phone-number → opaque user-id migration), so
          // an exact id match can miss. Fall back to the stable message hash.
          let targetMessageId = r.message_id;
          const known = await client.query(
            'SELECT 1 FROM coexistence.chat_history WHERE message_id = $1',
            [r.message_id]
          );
          if (known.rowCount === 0) {
            const { rows: candidates } = await client.query(
              `SELECT message_id FROM coexistence.chat_history
                WHERE direction = 'outgoing' AND wa_number = $1 AND contact_number = $2
                  AND timestamp > NOW() - INTERVAL '30 days'`,
              [r.wa_number, r.contact_number]
            );
            targetMessageId = matchByHash(r.message_id, candidates.map(c => c.message_id)) || r.message_id;
          }
          // On a 'failed' receipt, capture Meta's reason (code + human title) so
          // the UI can show WHY instead of a bare red icon. Meta puts it in
          // errors[0]; prefer the most specific text available.
          let failedError = null;
          if (r.status === 'failed' && Array.isArray(r.errors) && r.errors.length > 0) {
            const e = r.errors[0] || {};
            const detail = e.error_data?.details || e.title || e.message || 'Message failed to send';
            failedError = (e.code != null ? `[${e.code}] ` : '') + detail;
          }
          const upd = await client.query(
            `UPDATE coexistence.chat_history
                SET status = $1,
                    error_message = CASE WHEN $1 = 'failed' AND $4::text IS NOT NULL
                                         THEN $4 ELSE error_message END
              WHERE message_id = $2
                AND $3 > (CASE status
                            WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2
                            WHEN 'read' THEN 3 WHEN 'played' THEN 3 WHEN 'failed' THEN 2 ELSE 0 END)
              RETURNING wa_number, contact_number, message_id`,
            [r.status, targetMessageId, newRank, failedError]
          );
          if (upd.rowCount > 0) {
            const row = upd.rows[0];
            statusUpdates.push({ waNumber: row.wa_number, contactNumber: row.contact_number, messageId: row.message_id, status: r.status });
          }
          continue;
        }

        // Reactions are NOT chat bubbles — attach the emoji to the message it
        // reacts to (message_reactions). An empty emoji removes the reaction.
        if (r.message_type === 'reaction') {
          const tgt = r.reaction?.targetMessageId;
          if (tgt) {
            if (r.reaction.emoji) {
              await client.query(
                `INSERT INTO coexistence.message_reactions
                   (wa_number, contact_number, target_message_id, direction, emoji, reactor, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,NOW())
                 ON CONFLICT (target_message_id, direction)
                 DO UPDATE SET emoji = EXCLUDED.emoji, reactor = EXCLUDED.reactor, updated_at = NOW()`,
                [r.wa_number, r.contact_number, tgt, r.direction, r.reaction.emoji, r.reaction.from || null]
              );
            } else {
              await client.query(
                `DELETE FROM coexistence.message_reactions WHERE target_message_id = $1 AND direction = $2`,
                [tgt, r.direction]
              );
            }
          }
          continue;
        }

        // Upsert chat_history (ignore duplicates on message_id)
        await client.query(
          `INSERT INTO coexistence.chat_history
            (message_id, phone_number_id, wa_number, contact_number, to_number,
             direction, message_type, message_body, raw_payload, media_url,
             media_mime_type, media_filename, status, timestamp, context_message_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (message_id) DO UPDATE SET
             status = EXCLUDED.status,
             raw_payload = EXCLUDED.raw_payload`,
          [
            r.message_id, r.phone_number_id, r.wa_number, r.contact_number, r.to_number,
            r.direction, r.message_type, r.message_body, r.raw_payload, r.media_url,
            r.media_mime_type, r.media_filename || null, r.status, r.timestamp,
            r.context_message_id || null,
          ]
        );

        // Upsert the WhatsApp profile/push name into profile_name (NOT name).
        // `name` is reserved for a name we explicitly captured (AI ask-name flow
        // or manual save) so inbound messages don't clobber it — that clobbering
        // is what made the automation "is the contact known?" condition always
        // true. Display falls back to COALESCE(name, profile_name).
        if (r.contact_number && r.wa_number && r.contact_name) {
          await client.query(
            `INSERT INTO coexistence.contacts (wa_number, contact_number, profile_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (wa_number, contact_number) DO UPDATE SET
               profile_name = EXCLUDED.profile_name,
               updated_at = NOW()`,
            [r.wa_number, r.contact_number, r.contact_name]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Push delivery/read tick updates to any open chat (real-time, post-commit).
    for (const u of statusUpdates) bus.emit('message-status', u);

    // Message costs: persist the `pricing` object Meta attaches to every status
    // receipt. It was previously parsed and discarded — status records never
    // become chat rows, so it survived only inside the webhook_events blob and
    // nothing in the app could answer "what did that template cost?".
    //
    // Non-blocking: cost accounting must never delay the Meta ack or be able to
    // fail message ingestion.
    {
      const priced = allRecords.filter(r => r.message_type === 'status' && r.pricing && r.message_id);
      if (priced.length > 0) {
        (async () => {
          const costs = require('../services/messageCosts');
          for (const r of priced) {
            await costs.recordPricing({
              messageId: r.message_id,
              wabaId: r.waba_id,
              phoneNumberId: r.phone_number_id,
              waNumber: r.wa_number,
              recipientNumber: r.contact_number,
              pricing: r.pricing,
              status: r.status,
              timestamp: r.timestamp,
            }).catch(() => {});
          }
          await costs.attributeMessages({ limit: 500 }).catch(() => {});
        })().catch(e => console.error('[webhook] pricing capture error:', e.message));
      }
    }

    // Evaluate automation triggers
    // 1. For incoming messages (keyword, anyMessage, newContact triggers)
    //    First: if this conversation has paused executions awaiting a reply,
    //    resume them and SKIP fresh trigger evaluation for that record
    //    (the customer is mid-conversation — see plan: "Resume only — skip
    //    new trigger").
    const incomingRecords = allRecords.filter(r => r.direction === 'incoming' && r.message_type !== 'status' && r.message_type !== 'reaction');

    // Bridge Chats → Leads: every inbound WhatsApp customer becomes a funnel lead.
    // Source is attributed from Meta's CTWA `referral` (Instagram Ad / Facebook Ad /
    // organic / … ), else 'Direct'. Idempotent upsert — an existing lead keeps its
    // stage/source. Non-blocking so it never delays the Meta ack.
    {
      const seenLeadNums = new Set();
      for (const rec of incomingRecords) {
        if (!rec.contact_number || seenLeadNums.has(rec.contact_number)) continue;
        seenLeadNums.add(rec.contact_number);
        // Click-to-WhatsApp attribution runs in the SAME chain as the lead
        // upsert, not as an independent promise. Ordering matters: the referral
        // INSERT resolves lead_id with an inline subquery at statement time, so
        // if it raced ahead of the lead's commit AND landed after
        // linkReferralsToLead had already run, the row would keep lead_id NULL
        // with nothing left to fix it — and that ad would show clicks but no
        // leads. Referral first, then the lead, then the link.
        // Non-blocking + swallows its own errors: attribution must never be able
        // to delay or break message ingestion.
        const refRecords = incomingRecords.filter(
          r => r.referral && r.contact_number === rec.contact_number
        );
        // Message-format attribution (migration 093). Scans EVERY message this
        // contact sent in the batch, not just the first: the pre-filled opener
        // can arrive behind a sticker or a bare "hi". Reads an in-process cache,
        // so it costs no query and cannot slow ingestion.
        let fmtHit = null, fmtRecord = null;
        for (const r of incomingRecords) {
          if (r.contact_number !== rec.contact_number) continue;
          const m = messageFormats.matchInbound({ body: r.message_body, waNumber: r.wa_number });
          if (m) { fmtHit = m; fmtRecord = r; break; }
        }
        (async () => {
          for (const r of refRecords) await recordCtwaReferral(r);
          // A matched format is a MORE specific answer than Meta's referral
          // ("IG Reel 12" vs just "Instagram") and it is one we deliberately
          // placed, so it wins when both are present. ensureLeadForContact
          // applies `source` on INSERT only — an existing lead never has its
          // source rewritten by a later click.
          const lead = await ensureLeadForContact({
            contactNumber: rec.contact_number, name: rec.contact_name,
            source: fmtHit ? fmtHit.label : deriveLeadSource(rec.referral),
          });
          if (lead?.id) await linkReferralsToLead(rec.contact_number, lead.id);
          if (fmtHit) {
            await messageFormats.recordHit({
              formatId: fmtHit.formatId, targetId: fmtHit.targetId,
              waNumber: fmtRecord.wa_number, contactNumber: fmtRecord.contact_number,
              messageId: fmtRecord.message_id,
              leadId: lead?.id || null, isNewLead: !!lead?.inserted,
              matchKind: fmtHit.matchKind,
            });
          }
        })().catch(e => console.error('[webhook] lead/CTWA attribution error:', e.message));
      }
    }

    if (incomingRecords.length > 0) {
      for (const record of incomingRecords) {
        try {
          // ⚠ awaiting_kind='reply' ONLY — keep this filter even though the
          // Payment node (the only other pause kind) was removed 2026-08-12.
          // It is what stops a pause that is NOT waiting for words from being
          // consumed by a customer typing "ok", which (because the `continue`
          // below skips fresh trigger evaluation) would also leave them with
          // no reply at all. Any future non-reply pause inherits the guard.
          const { rows: pausedRows } = await pool.query(
            `SELECT id FROM coexistence.automation_executions
              WHERE wa_number=$1 AND contact_number=$2
                AND status='paused' AND expires_at>NOW()
                AND awaiting_kind = 'reply'
              ORDER BY paused_at`,
            [record.wa_number, record.contact_number]
          );
          if (pausedRows.length > 0) {
            for (const p of pausedRows) {
              try {
                await resumeAutomation(pool, p.id, record);
              } catch (resumeErr) {
                console.error(`[webhook] Resume error for execution ${p.id}:`, resumeErr.message);
              }
            }
            continue; // do not also fire fresh triggers
          }
          const fired = await evaluateTriggers(record);
          // Agent fall-through: when no keyword automation matched, route the
          // message to the active agent on this WA account (if any). The
          // agentRouter no-ops when no active agent exists, so this is safe
          // to call unconditionally.
          if (!fired || fired.length === 0) {
            try {
              await agentRouter.routeIfActive(record);
            } catch (agentErr) {
              console.error('[webhook] Agent routing error:', agentErr.message);
            }
          }
        } catch (triggerErr) {
          console.error('[webhook] Trigger evaluation error:', triggerErr.message);
        }
      }
    }

    // 1b. For OUTBOUND messages the business sent (Meta "message echoes") — fire
    //     keyword triggers set to Outbound/Both. This is how a message a BD types
    //     in their WhatsApp Business app reaches automations (it never touches
    //     our send queue). evaluateOutboundTriggers dedups by wamid, so a message
    //     we sent through ForgeGrowth (already handled in the send queue) is not
    //     fired again here, and an automation's own send can't loop.
    const outboundEchoRecords = allRecords.filter(r =>
      r.direction === 'outgoing' && r.message_type !== 'status' && r.message_type !== 'reaction');
    for (const record of outboundEchoRecords) {
      try {
        await evaluateOutboundTriggers(record);
      } catch (triggerErr) {
        console.error('[webhook] Outbound echo trigger error:', triggerErr.message);
      }
    }

    // 2. For status updates (messageRead, messageDelivered, messageSent triggers)
    const statusRecords = allRecords.filter(r => r.message_type === 'status');
    if (statusRecords.length > 0) {
      for (const record of statusRecords) {
        try {
          await evaluateTriggers(record);
        } catch (triggerErr) {
          console.error('[webhook] Status trigger evaluation error:', triggerErr.message);
        }
      }
    }

    // Enqueue durable media downloads via BullMQ (concurrency-capped + retried)
    for (const r of allRecords) {
      if (MEDIA_TYPES.has(r.message_type) && r.media_url && r.message_id) {
        await markPending(r.message_id);
        enqueueMediaDownload(r.message_id).catch(() => {});
      }
    }

    console.log(`[webhook] Stored ${allRecords.length} record(s)`);
    await logWebhookProcessed(auditId, {
      status: 'processed',
      recordsExtracted: allRecords.length,
      error: rejectedCount > 0 ? `skipped ${rejectedCount} record(s) from unregistered WABA` : null,
      processingMs: Date.now() - startTime,
    });
    res.status(200).json({ ok: true, stored: allRecords.length, skipped: rejectedCount });
  } catch (err) {
    console.error('[webhook] Error:', err.message);
    await logWebhookProcessed(auditId, { status: 'error', error: err.message, processingMs: Date.now() - startTime });
    // Always return 200 to n8n so it doesn't retry infinitely
    res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/webhook/whatsapp
 * Meta webhook verification endpoint (for direct Meta → ForgeChat webhooks).
 * Not needed for n8n forwarding, but included for completeness.
 */
router.get('/webhook/whatsapp', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  let accepted = false;
  if (mode === 'subscribe' && token) {
    // 1) Match against any account's per-account Webhook Verify Token (set in
    //    the WhatsApp account connection form, stored encrypted).
    try {
      const { rows } = await pool.query(
        `SELECT verify_token_encrypted FROM coexistence.whatsapp_accounts
          WHERE verify_token_encrypted IS NOT NULL`
      );
      for (const r of rows) {
        if (safeEqual(decrypt(r.verify_token_encrypted), token)) { accepted = true; break; }
      }
    } catch (err) {
      console.error('[webhook] verify-token lookup error:', err.message);
    }
    // 2) Backward-compatible global env fallback.
    if (!accepted && process.env.META_WEBHOOK_VERIFY_TOKEN && safeEqual(process.env.META_WEBHOOK_VERIFY_TOKEN, token)) {
      accepted = true;
    }
  }

  await logWebhookReceived({
    payload: { verify: true, mode, challenge, accepted },
    headers: req.headers,
    remoteIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    source: 'verify',
  }).then(id => logWebhookProcessed(id, {
    status: accepted ? 'verified' : 'error',
    error: accepted ? null : `Token mismatch (mode=${mode})`,
    processingMs: 0,
  }));
  if (accepted) {
    console.log('[webhook] Meta verification accepted');
    // Echo the challenge as plain text so the reflected value can't be
    // interpreted as HTML (reflected-XSS guard).
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  res.status(403).json({ error: 'Verification failed' });
});

module.exports = { router };
