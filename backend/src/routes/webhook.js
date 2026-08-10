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
const { recordCtwaReferral, linkReferralsToLead } = require('./ctwa');
const { matchByHash } = require('../util/wamid');
const { forgeCommandNotify } = require('../forgeCommandNotify');
const { parseMetaPayload } = require('../services/metaPayload');

// ── External agent bridge (optional) ─────────────────────────────────────────
// Traffic on ONE phone number id can be forwarded to an external agent webhook
// instead of running through the normal inbox pipeline. Inbound is still stored
// for visibility; the agent's reply is sent back out through the CRM's own
// sender, so it is logged as an outgoing message and appears in the chat.
//
// Every other number keeps using the built-in automations/agents untouched.
// Unset by default — configure FORGETASK_* to enable.
const FORGETASK_PNID = process.env.FORGETASK_PHONE_NUMBER_ID || '';
const FORGETASK_FROM_NUMBER = process.env.FORGETASK_FROM_NUMBER || '';

// ⚠ Always test membership through this helper, never `pnid === FORGETASK_PNID`.
// With the bridge unconfigured, FORGETASK_PNID is '' — and a record that
// carries no phone_number_id also reads as '', so a bare equality check matches
// and silently DROPS that record from the inbox. Requiring a configured id
// first makes "no bridge" mean "excludes nothing".
function isBridgedNumber(phoneNumberId) {
  return !!FORGETASK_PNID && String(phoneNumberId || '') === FORGETASK_PNID;
}
const FORGETASK_AGENT_WEBHOOK_URL = process.env.FORGETASK_AGENT_WEBHOOK_URL || null;
const FORGETASK_AGENT_API_KEY = process.env.FORGETASK_AGENT_API_KEY || null;

// Pull the agent-relevant payload out of a raw Meta message: plain text, a tapped
// button id (interactive OR template quick-reply), or a voice-note media id.
function extractForgeTaskInput(msg) {
  if (!msg) return null;
  if (msg.type === 'text') return { message: msg.text?.body || '' };
  if (msg.type === 'interactive') {
    if (msg.interactive?.type === 'button_reply') return { message: msg.interactive.button_reply.id || '' };
    if (msg.interactive?.type === 'list_reply') return { message: msg.interactive.list_reply.id || '' };
    return null; // nfm_reply (Flow submit) etc. — not bridged
  }
  if (msg.type === 'button') return { message: msg.button?.payload || msg.button?.text || '' };
  if (msg.type === 'audio' || msg.type === 'voice') return { audio_media_id: (msg.audio || msg.voice)?.id || null };
  return null; // images/docs/location/etc. — not bridged
}

// Forward ONE inbound ForgeTask-number message to the ForgeTask agent, then send
// the reply via the CRM's own sender (so it's stored as outgoing → full chat
// visibility). Never throws — a bridge failure must not affect webhook handling.
async function forwardToForgeTask(msg, contactName) {
  if (!FORGETASK_AGENT_WEBHOOK_URL || !FORGETASK_AGENT_API_KEY) return;
  const from = msg.from;
  if (!from) return;
  const input = extractForgeTaskInput(msg);
  if (!input || (!String(input.message || '').trim() && !input.audio_media_id)) return;
  try {
    const r = await fetch(FORGETASK_AGENT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': FORGETASK_AGENT_API_KEY },
      body: JSON.stringify({
        conversation_id: `whatsapp_${String(from).replace(/\D/g, '')}`,
        whatsapp_phone: from,
        user_name: contactName || null,
        platform: 'whatsapp',
        message_id: msg.id || null,
        ...input,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) { console.error(`[ft-bridge] agent webhook HTTP ${r.status}`); return; }
    const data = await r.json().catch(() => ({}));
    const reply = data?.reply;
    if (reply && String(reply).trim()) {
      const mcpService = require('../services/mcpService');
      await mcpService.sendTextMessage({ fromNumber: FORGETASK_FROM_NUMBER, toNumber: from, text: String(reply) })
        .catch(e => console.error('[ft-bridge] reply send failed:', e.message));
    }
  } catch (e) {
    console.error('[ft-bridge] forward failed:', e.message);
  }
}

// Walk raw Meta payload(s) and fire-and-forget a bridge for every inbound message
// on the ForgeTask number. Reads from the raw payload (not parsed records) so
// button ids / template payloads survive.
function bridgeForgeTaskMessages(payloads) {
  if (!FORGETASK_AGENT_WEBHOOK_URL) return;
  for (const p of payloads || []) {
    for (const entry of p?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        if (!isBridgedNumber(value.metadata?.phone_number_id)) continue;
        const nameByWaId = {};
        for (const c of value.contacts || []) if (c.wa_id) nameByWaId[c.wa_id] = c.profile?.name || null;
        for (const msg of value.messages || []) {
          forwardToForgeTask(msg, nameByWaId[msg.from] || null); // fire-and-forget
        }
      }
    }
  }
}

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

    // ForgeTask hub: forward inbound on the ForgeTask number to its agent and
    // send the reply back out (fire-and-forget so Meta still gets a fast ack).
    bridgeForgeTaskMessages(payloads);

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
    // stage/source. Non-blocking so it never delays the Meta ack; skips ForgeTask.
    {
      const seenLeadNums = new Set();
      for (const rec of incomingRecords) {
        if (!rec.contact_number || seenLeadNums.has(rec.contact_number)) continue;
        if (isBridgedNumber(rec.phone_number_id)) continue;
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
        (async () => {
          for (const r of refRecords) await recordCtwaReferral(r);
          const lead = await ensureLeadForContact({
            contactNumber: rec.contact_number, name: rec.contact_name,
            source: deriveLeadSource(rec.referral),
          });
          if (lead?.id) await linkReferralsToLead(rec.contact_number, lead.id);
        })().catch(e => console.error('[webhook] lead/CTWA attribution error:', e.message));
      }
    }

    if (incomingRecords.length > 0) {
      for (const record of incomingRecords) {
        try {
          // ForgeTask-number messages are handled by the ForgeTask bridge above —
          // skip CRM automations/agent so the message isn't answered twice.
          if (isBridgedNumber(record.phone_number_id)) continue;
          const { rows: pausedRows } = await pool.query(
            `SELECT id FROM coexistence.automation_executions
              WHERE wa_number=$1 AND contact_number=$2
                AND status='paused' AND expires_at>NOW()
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
        if (isBridgedNumber(record.phone_number_id)) continue;
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
    // Notify ForgeCommand about incoming WhatsApp messages (fire-and-forget).
    for (const r of incomingRecords) {
      if (!r.message_body) continue;
      const isMedia = MEDIA_TYPES.has(r.message_type);
      forgeCommandNotify(isMedia ? 'whatsapp_media' : 'whatsapp_message', {
        from: r.contact_number,
        from_name: r.contact_name || r.contact_number,
        text: r.message_body,
        media_type: isMedia ? r.message_type : undefined,
        wa_number: r.wa_number,
      });
    }
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
