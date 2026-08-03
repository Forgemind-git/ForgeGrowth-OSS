const express = require('express');
const router = express.Router();
const pool = require('../db');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { assertCanSend } = require('./whatsappAccounts');
const { enqueueSend } = require('../queue/sendQueue');
const { mintSendToken, mintTokenForButtonUrl } = require('./leadForms');

/**
 * WABA guard: a WhatsApp template only exists on the account (WABA) it was
 * approved under. Sending it from a different number makes Meta reject every
 * recipient with #132001. Returns a friendly error string on mismatch, or null
 * when the pairing is valid (or there's no template / no account binding).
 */
function templateAccountMismatch(template, account, fromNumber) {
  if (!template || template.whatsapp_account_id == null || !account) return null;
  if (String(template.whatsapp_account_id) === String(account.id)) return null;
  const from = fromNumber || account.displayPhoneNumber || `account ${account.id}`;
  return `The template "${template.name}" is approved on a different WhatsApp number and can't be sent from ${from}. Pick a template approved on this number, or change the sending number.`;
}

/**
 * Resolve one variable_mapping source against a recipient context. The mapping
 * VALUE is a contact-field KEY chosen in the builder dropdown — this MUST mirror
 * the frontend `resolvePreviewText` exactly (UI↔backend contract), otherwise the
 * preview shows the real value but the send delivers the literal key (the bug
 * that made every broadcast send "Hi name," instead of "Hi John,").
 *   'name'                 → recipient.name
 *   'contact_number'       → recipient.contact_number
 *   'custom_fields.<id>'   → recipient.custom_fields[id]
 *   'category_tag.<catId>' → the recipient's tag name in that category
 * Anything else is treated as a legacy {{contact.*}} token / literal.
 */
function resolveTemplateParam(src, ctx) {
  const s = String(src == null ? '' : src).trim();
  if (!s) return '';
  if (s === 'name') return ctx.name || '';
  if (s === 'contact_number') return ctx.contact_number || '';
  if (s.startsWith('custom_fields.')) {
    const id = s.slice('custom_fields.'.length);
    const v = (ctx.custom_fields || {})[id];
    return v != null ? String(v) : '';
  }
  if (s.startsWith('category_tag.')) {
    const catId = s.slice('category_tag.'.length);
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    const t = tags.find(tg => String(tg.category_id) === String(catId));
    return t ? (t.name || '') : '';
  }
  return s
    .replace(/\{\{\s*contact\.name\s*\}\}/g, ctx.name || '')
    .replace(/\{\{\s*contact\.number\s*\}\}/g, ctx.contact_number || '')
    .replace(/\{\{\s*name\s*\}\}/g, ctx.name || '')
    .replace(/\{\{\s*contact_number\s*\}\}/g, ctx.contact_number || '');
}

/**
 * Load per-recipient context (name + custom_fields + tags) so variable mapping
 * can resolve custom-field / tag sources at send time. recipient_numbers only
 * persists {contact_number, name}, so custom fields must come from the contacts
 * table. Prefers the row under the broadcast's own wa_number, else most recent.
 * Returns Map keyed by digits-only contact_number.
 */
async function loadContactContext(numbers, fromNumber) {
  const map = new Map();
  const list = [...new Set((numbers || []).map(n => String(n).replace(/\D/g, '')).filter(Boolean))];
  if (list.length === 0) return map;
  const wa = String(fromNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (regexp_replace(contact_number,'\\D','','g'))
            regexp_replace(contact_number,'\\D','','g') AS num, name, custom_fields, tags
       FROM coexistence.contacts
      WHERE regexp_replace(contact_number,'\\D','','g') = ANY($1::text[])
      ORDER BY regexp_replace(contact_number,'\\D','','g'),
               (regexp_replace(wa_number,'\\D','','g') = $2) DESC,
               updated_at DESC NULLS LAST`,
    [list, wa]
  );
  for (const r of rows) map.set(r.num, r);
  return map;
}

/** Attach custom_fields + tags (+ fill name) onto a recipient from the context map. */
function enrichRecipient(recipient, ctxMap) {
  const r = typeof recipient === 'string' ? { contact_number: recipient, name: '' } : { ...recipient };
  const cc = ctxMap.get(String(r.contact_number).replace(/\D/g, ''));
  if (cc) {
    r.custom_fields = cc.custom_fields || {};
    r.tags = Array.isArray(cc.tags) ? cc.tags : [];
    if (!r.name) r.name = cc.name || '';
  }
  return r;
}

// Best-effort placeholder for a dynamic URL button when there's no real
// per-recipient value to put there (a plain broadcast/test-send using a
// template that happens to have a {{n}} URL variable — e.g. one built for
// Lead Forms but sent outside that flow). Meta only requires the parameter
// be present and non-empty, not that it resolve to anything meaningful, so a
// generic test-send should still go through instead of hard-failing.
function urlButtonFallbackValue(b) {
  const sample = String(b.urlSample || '').trim();
  const seg = sample.split('/').filter(Boolean).pop();
  return seg || 'test';
}

/**
 * Build Meta template `components` array from variable_mapping + recipient ctx.
 * variable_mapping is { "1": "<field-key>" } chosen in the builder dropdown.
 * `leadFormToken` (if given) fills any dynamic URL button with the real
 * per-recipient value; otherwise a placeholder is used (see
 * urlButtonFallbackValue) so the send doesn't hard-fail. Meta rejects the
 * send outright if a URL button has a {{n}} variable and no button component
 * is supplied at all.
 */
function buildTemplateComponents(template, variableMapping, recipient, headerMediaId, leadFormToken) {
  const components = [];

  // Header component. Media headers (IMAGE/VIDEO/DOCUMENT) require the header
  // media as a runtime parameter (resolved to a per-account Meta media id);
  // omitting it causes Meta error 132012. TEXT headers only need a parameter
  // when they contain a {{1}} variable. Static TEXT / NONE need no header param.
  const ht = String(template.header_type || 'NONE').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht) && headerMediaId) {
    const key = ht.toLowerCase(); // image | video | document
    components.push({ type: 'header', parameters: [{ type: key, [key]: { id: headerMediaId } }] });
  }

  const bodyVars = Object.keys(variableMapping || {}).sort((a, b) => +a - +b);
  if (bodyVars.length > 0) {
    const parameters = bodyVars.map(k => ({
      type: 'text',
      text: resolveTemplateParam(variableMapping[k], recipient) || ' ',
    }));
    components.push({ type: 'body', parameters });
  }

  // Dynamic URL button parameter. `index` is the button's position among ALL
  // buttons in the template (Meta's semantics), not just URL ones. Stored
  // button shape uses `value`/`urlSample` (the editor's field names) — NOT
  // `url`/`example` (that's only the shape built for Meta's template-creation
  // payload in routes/templates.js, a completely different transform).
  (Array.isArray(template.buttons) ? template.buttons : []).forEach((b, idx) => {
    if (b.type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(b.value || '')) {
      const text = leadFormToken || urlButtonFallbackValue(b);
      components.push({ type: 'button', sub_type: 'url', index: idx, parameters: [{ type: 'text', text }] });
    }
  });

  return components;
}

async function enqueueBroadcastRecipient({ broadcast, template, account, recipient, broadcastLogId, resolvedMediaId, resolvedCarouselComponent }) {
  const msgType = broadcast.message_type || 'template';

  // ── Template ──────────────────────────────────────────────────────────
  if (msgType === 'template') {
    // Mint one opaque single-use token per recipient so the form link they tap
    // silently identifies them (no phone number ever asked on the form). This
    // happens for a broadcast explicitly linked to a Lead Form AND for ANY
    // template whose dynamic URL button points at a published form — so Test
    // Send / regular Broadcast auto-identify recipients too, not just the
    // dedicated "Send via WhatsApp" flow.
    let leadFormToken = null;
    if (broadcast.lead_form_id) {
      leadFormToken = await mintSendToken({
        formId: broadcast.lead_form_id,
        phoneNumber: recipient.contact_number,
        contactName: recipient.name || null,
        broadcastId: broadcast.id,
        waAccountId: account.id,
      });
    } else {
      const urlBtn = (Array.isArray(template.buttons) ? template.buttons : [])
        .find(b => b.type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(b.value || ''));
      if (urlBtn) {
        leadFormToken = await mintTokenForButtonUrl(urlBtn.value, recipient.contact_number, {
          contactName: recipient.name || null, broadcastId: broadcast.id, waAccountId: account.id,
        });
      }
    }
    // resolvedMediaId doubles as the header image for media-header templates.
    const components = buildTemplateComponents(template, broadcast.variable_mapping, recipient, resolvedMediaId, leadFormToken);
    // CAROUSEL templates: append the prebuilt carousel component (resolved once
    // per broadcast — cards are static, identical for every recipient).
    if (template && String(template.template_type || '').toUpperCase() === 'CAROUSEL' && resolvedCarouselComponent) {
      components.push(resolvedCarouselComponent);
    }
    // Resolve {{n}} in the body with the same mapping used for the send, so the
    // Chats UI shows the real message ("Hi Test, … with Risio") instead of raw
    // {{1}}/{{2}} placeholders.
    const resolvedBody = String(template.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
      const mapped = (broadcast.variable_mapping || {})[n];
      const val = mapped != null ? resolveTemplateParam(mapped, recipient) : '';
      return val || `{{${n}}}`;
    });
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'template',
      messageBody: resolvedBody || `Template: ${template.name}`,
      templateMeta: {
        header_type: template.header_type || 'NONE',
        header_text: template.header_text || null,
        // Stable pointer to the header image so the Chats bubble can render the
        // actual picture (not a grey "Image header" placeholder).
        header_media_library_id: broadcast.media_library_id || null,
        footer: template.footer || null,
        buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
      },
    });
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        name: template.name,
        languageCode: template.language || 'en',
        components,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────
  if (msgType === 'text') {
    const body = (broadcast.body || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Link ──────────────────────────────────────────────────────────────
  if (msgType === 'link') {
    const body = (broadcast.url || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body, previewUrl: true },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Media (image / video / audio / document) ──────────────────────────
  if (['image', 'video', 'audio', 'document'].includes(msgType)) {
    const caption = (broadcast.caption || '')
      .replace(/\{\{contact\.name\}\}/g, recipient.name || '')
      .replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: msgType,
      messageBody: caption || `${msgType} message`,
    });
    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        type: msgType,
        mediaId: resolvedMediaId || null,
        link: resolvedMediaId ? null : (broadcast.url || null),
        caption: caption || undefined,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  throw new Error(`Unsupported broadcast message_type: ${msgType}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getBroadcastWithLogs(id) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.name AS template_name, t.category AS template_category,
            t.language AS template_language, t.header_type, t.header_text,
            t.media_handle, t.body AS template_body, t.footer AS template_footer,
            t.buttons AS template_buttons, t.samples AS template_samples,
            t.security_recommendation, t.code_expiry_minutes
     FROM coexistence.broadcasts b
     LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
     WHERE b.id = $1`,
    [id]
  );
  if (bRows.length === 0) return null;

  // Aggregate BROADCAST logs into a single summary entry;
  // keep TEST logs as individual rows.
  const { rows: broadcastAgg } = await pool.query(
    `SELECT
       COUNT(*)::int AS recipient_count,
       MAX(sent_at) AS sent_at,
       CASE
         WHEN COUNT(*) FILTER (WHERE status = 'PENDING') > 0 THEN 'PENDING'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0
          AND COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) = 0 THEN 'failed'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0 THEN 'sent'
         WHEN COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) > 0 THEN 'sent'
         ELSE MAX(status)
       END AS status,
       ARRAY_AGG(DISTINCT error_message) FILTER (WHERE error_message IS NOT NULL) AS errors
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [id]
  );

  const { rows: testLogs } = await pool.query(
    `SELECT id, action, sent_to, status, sent_at, wa_message_id, error_message
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'TEST'
     ORDER BY sent_at DESC`,
    [id]
  );

  // Cumulative funnel: a message that was read passed through delivered & sent
  // first. Counting only the *current* status (exclusive buckets) makes a fully
  // delivered broadcast look like "0 sent / 0 delivered / 2 read" — which is
  // semantically correct but confusing in a Delivery Summary. Users expect:
  //   sent      = ever-sent (sent OR delivered OR read)
  //   delivered = ever-delivered (delivered OR read)
  //   read      = read (terminal)
  const { rows: rollup } = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE bl.status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE bl.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE ch.status IN ('sent','delivered','read'))::int AS sent,
        COUNT(*) FILTER (WHERE ch.status IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE ch.status = 'read')::int AS read
       FROM coexistence.broadcast_logs bl
       LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id
      WHERE bl.broadcast_id = $1 AND bl.action = 'BROADCAST'`,
    [id]
  );

  // Normalise aggregated BROADCAST row to match the log shape the frontend expects
  const logs = [];
  if (broadcastAgg[0]?.recipient_count > 0) {
    logs.push({
      id: `broadcast-${id}`,
      action: 'BROADCAST',
      sent_to: `${broadcastAgg[0].recipient_count} contact${broadcastAgg[0].recipient_count !== 1 ? 's' : ''}`,
      status: broadcastAgg[0].status,
      sent_at: broadcastAgg[0].sent_at,
      wa_message_id: null,
      error_message: broadcastAgg[0].errors?.length ? broadcastAgg[0].errors.join('; ') : null,
      _recipientCount: broadcastAgg[0].recipient_count,
    });
  }
  logs.push(...testLogs);
  logs.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

  return { ...bRows[0], logs, statusRollup: rollup[0] || {} };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /broadcasts — list all with template name and live status rollup
router.get('/broadcasts', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conditions = [];

    const { rows } = await pool.query(
      `WITH base AS (
         SELECT b.*, t.name AS template_name,
                (SELECT COUNT(*) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS log_count,
                (SELECT MAX(sent_at) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS last_activity,
                (
                  SELECT
                    CASE
                      WHEN b.status = 'DRAFT' THEN 'DRAFT'
                      -- A scheduled broadcast has no BROADCAST logs yet, so the
                      -- counts below would all be 0 and it would fall through to
                      -- ELSE. Stated explicitly so the Scheduled tab can't break
                      -- if this CASE is edited later.
                      WHEN b.status = 'SCHEDULED' THEN 'SCHEDULED'
                      WHEN b.status = 'SENDING' THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'PENDING') > 0 THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0
                       AND COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) = 0 THEN 'FAILED'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0 THEN 'PARTIAL'
                      WHEN COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) > 0 THEN 'SENT'
                      ELSE b.status
                    END
                  FROM coexistence.broadcast_logs bl
                  WHERE bl.broadcast_id = b.id AND bl.action = 'BROADCAST'
                ) AS display_status
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
       )
       SELECT * FROM base
       ${status && status !== 'all' ? 'WHERE display_status = $1' : ''}
       ORDER BY created_at DESC`,
      status && status !== 'all' ? [status] : []
    );
    // Map display_status over status for the frontend
    res.json(rows.map(r => ({ ...r, status: r.display_status || r.status })));
  } catch (err) {
    console.error('[broadcasts] /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

// GET /broadcasts/:id — single broadcast with template and logs
router.get('/broadcasts/:id', async (req, res) => {
  try {
    const data = await getBroadcastWithLogs(req.params.id);
    if (!data) return res.status(404).json({ error: 'Broadcast not found' });
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcast' });
  }
});

// POST /broadcasts — create broadcast + optional log entry
router.post('/broadcasts', async (req, res) => {
  try {
    const {
      from_number, recipient_numbers, template_id, status, test_number,
      name, variable_mapping, message_type, body, url, media_library_id, caption,
      lead_form_id, scheduled_at, recipient_filter,
    } = req.body;

    if (!from_number || !recipient_numbers) {
      return res.status(400).json({ error: 'from_number and recipient_numbers required' });
    }

    const msgType = message_type || 'template';
    if (msgType === 'template' && !template_id) {
      return res.status(400).json({ error: 'template_id required for template broadcasts' });
    }

    // A SCHEDULED broadcast needs a future instant. Reject a past time up front
    // rather than letting the next tick fire it immediately — "I scheduled it
    // for 6pm and it sent right now" is the worst possible surprise on a blast
    // to real customers.
    let schedAt = null;
    if (scheduled_at) {
      schedAt = new Date(scheduled_at);
      if (isNaN(schedAt.getTime())) return res.status(400).json({ error: 'scheduled_at is not a valid date' });
      if (schedAt.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'scheduled_at must be in the future' });
      }
    }
    const finalStatus = schedAt ? 'SCHEDULED' : (status || 'DRAFT');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO coexistence.broadcasts
         (from_number, recipient_numbers, template_id, status, test_number, name,
          variable_mapping, message_type, body, url, media_library_id, caption, lead_form_id,
          scheduled_at, recipient_filter, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         RETURNING *`,
        [
          from_number,
          JSON.stringify(recipient_numbers || []),
          template_id || null,
          finalStatus,
          test_number || null,
          name || null,
          JSON.stringify(variable_mapping || {}),
          msgType,
          body || null,
          url || null,
          media_library_id || null,
          caption || null,
          lead_form_id || null,
          schedAt ? schedAt.toISOString() : null,
          recipient_filter ? JSON.stringify(recipient_filter) : null,
        ]
      );
      const broadcast = rows[0];

      if (test_number) {
        await client.query(
          `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
           VALUES ($1, $2, $3, $4)`,
          [broadcast.id, 'TEST', test_number, 'PENDING']
        );
      }

      await client.query('COMMIT');
      res.status(201).json(broadcast);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

// PUT /broadcasts/:id — update (only if DRAFT)
router.put('/broadcasts/:id', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT status FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    if (existing[0].status !== 'DRAFT') {
      return res.status(403).json({ error: 'Only DRAFT broadcasts can be edited' });
    }

    const {
      from_number, recipient_numbers, template_id, test_number, name,
      variable_mapping, message_type, body, url, media_library_id, caption,
      lead_form_id,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE coexistence.broadcasts SET
        from_number = COALESCE($1, from_number),
        recipient_numbers = COALESCE($2, recipient_numbers),
        template_id = COALESCE($3, template_id),
        test_number = COALESCE($4, test_number),
        name = COALESCE($5, name),
        variable_mapping = COALESCE($6, variable_mapping),
        message_type = COALESCE($7, message_type),
        body = COALESCE($8, body),
        url = COALESCE($9, url),
        media_library_id = COALESCE($10, media_library_id),
        caption = COALESCE($11, caption),
        lead_form_id = COALESCE($12, lead_form_id),
        updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        from_number || null,
        recipient_numbers ? JSON.stringify(recipient_numbers) : null,
        template_id || null,
        test_number || null,
        name || null,
        variable_mapping ? JSON.stringify(variable_mapping) : null,
        message_type || null,
        body || null,
        url || null,
        media_library_id || null,
        caption || null,
        lead_form_id || null,
        req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[broadcasts] PUT /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update broadcast' });
  }
});

// DELETE /broadcasts/:id
router.delete('/broadcasts/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Broadcast not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[broadcasts] DELETE /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// POST /broadcasts/:id/send — real Meta send, one job per recipient via BullMQ
/**
 * Narrow a broadcast's stored recipient pool to those who HAVE (or HAVE NOT)
 * tapped a given template quick-reply since a point in time.
 *
 * Evaluated at DISPATCH time, which is the whole point: "message everyone who
 * hasn't clicked yet" has no answer when the broadcast is created.
 *
 * The stored `recipient_numbers` is the authoritative pool and this only ever
 * filters it — a bug here can shrink the audience but can never add someone who
 * wasn't already on the list.
 */
async function resolveButtonClickSegment(filter, staticRecipients) {
  const numbers = staticRecipients.map(r => (typeof r === 'string' ? r : r.contact_number));
  if (numbers.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT contact_number
       FROM coexistence.chat_history
      WHERE wa_number = $1
        AND direction = 'incoming'
        AND message_type = 'button'
        AND lower(message_body) = lower($2)
        AND timestamp >= $3
        AND contact_number = ANY($4::text[])`,
    [filter.waNumber, filter.buttonText, filter.since, numbers]
  );
  const clicked = new Set(rows.map(r => r.contact_number));
  const want = filter.clicked === true;
  return staticRecipients.filter(r => {
    const n = typeof r === 'string' ? r : r.contact_number;
    return want ? clicked.has(n) : !clicked.has(n);
  });
}

/**
 * Dispatch ONE broadcast: resolve account + template + media, then enqueue a
 * real send per recipient.
 *
 * Extracted out of `POST /broadcasts/:id/send` so the scheduler tick can fire a
 * due broadcast through the EXACT same path — there is no second copy of the
 * send logic that could drift from the manual one.
 *
 * Returns `{ ok: true, enqueued }` or `{ ok: false, status, error }`. Expected
 * failures (bad account, empty recipient list, billing block) come back as
 * values rather than throws, so the scheduler can mark the row FAILED with the
 * real reason instead of taking down the timer.
 *
 * `preClaimed` — the caller already flipped this row to SENDING to claim it
 * (the scheduler does that atomically); skip the redundant UPDATE.
 */
async function dispatchBroadcast(broadcastId, { preClaimed = false } = {}) {
  {
    const { rows: bRows } = await pool.query(
      `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
              t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons,
              t.template_type AS t_template_type, t.carousel_cards AS t_carousel_cards,
              t.whatsapp_account_id AS t_whatsapp_account_id
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
        WHERE b.id = $1`,
      [broadcastId]
    );
    if (bRows.length === 0) return { ok: false, status: 404, error: 'Broadcast not found' };
    const broadcast = bRows[0];
    const template = broadcast.message_type === 'template'
      ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
          header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons,
          template_type: broadcast.t_template_type, carousel_cards: broadcast.t_carousel_cards,
          whatsapp_account_id: broadcast.t_whatsapp_account_id }
      : null;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return { ok: false, status: 400, error };

    const wabaError = templateAccountMismatch(template, account, broadcast.from_number);
    if (wabaError) return { ok: false, status: 400, error: wabaError };

    // Meta accepts a send even when the account is billing-blocked, then fails
    // it async — reject the click now with the real reason instead.
    const canSend = await assertCanSend(account);
    if (!canSend.ok) return { ok: false, status: 400, error: canSend.reason };

    let recipients = Array.isArray(broadcast.recipient_numbers) ? broadcast.recipient_numbers : [];
    if (recipients.length === 0) return { ok: false, status: 400, error: 'No recipients selected' };

    // Dynamic segment (migration 071): recompute WHO gets this, right now.
    const filter = broadcast.recipient_filter;
    if (filter && filter.type === 'button_click') {
      const before = recipients.length;
      recipients = await resolveButtonClickSegment(filter, recipients);
      console.log(`[broadcasts] #${broadcastId} segment clicked=${filter.clicked}: ${before} → ${recipients.length}`);
      // An empty segment is a legitimate outcome ("everyone already clicked"),
      // NOT a failure — mark it done rather than leaving a scary FAILED row.
      if (recipients.length === 0) {
        await pool.query(
          `UPDATE coexistence.broadcasts SET status='SENT', updated_at=NOW() WHERE id=$1`, [broadcastId]
        );
        return { ok: true, enqueued: 0, skipped: 'segment empty' };
      }
    }

    // Resolve media once for media-type broadcasts
    let resolvedMediaId = null;
    // Resolve the media id for media-type broadcasts AND for template broadcasts
    // whose template has a media header (IMAGE/VIDEO/DOCUMENT) — both pull from
    // broadcast.media_library_id.
    const _tplHt = template ? String(template.header_type || '').toUpperCase() : '';
    const _needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(_tplHt);
    if ((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || _needsHeaderMedia) && broadcast.media_library_id) {
      const { syncMediaToAccount } = require('./mediaLibrary');
      const { rows: mRows } = await pool.query(
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
        [broadcast.media_library_id]
      );
      if (mRows.length) {
        const media = mRows[0];
        const { rows: sRows } = await pool.query(
          `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
          [media.id, account.id]
        );
        let sync = sRows[0];
        const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
        if (needsSync) {
          sync = await syncMediaToAccount(media.id, account.id);
          sync = {
            meta_media_id: sync.metaMediaId,
            expires_at: sync.expiresAt,
            status: sync.status,
          };
        }
        resolvedMediaId = sync.meta_media_id;
      }
    }

    // CAROUSEL templates: resolve every card's header media to this account once,
    // up front, and build the carousel send component shared by all recipients.
    let resolvedCarouselComponent = null;
    if (template && String(template.template_type || '').toUpperCase() === 'CAROUSEL') {
      const { buildCarouselComponent } = require('./mediaLibrary');
      resolvedCarouselComponent = await buildCarouselComponent(template, account.id);
    }

    if (!preClaimed) {
      await pool.query(
        `UPDATE coexistence.broadcasts SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
        [broadcastId]
      );
    }

    // Enrich recipients with custom_fields + tags so variable mapping can
    // resolve custom-field / tag sources (name + number come from the recipient).
    const ctxMap = await loadContactContext(
      recipients.map(r => (typeof r === 'string' ? r : r.contact_number)),
      broadcast.from_number
    );

    let enqueued = 0;
    for (const r of recipients) {
      const recipient = enrichRecipient(r, ctxMap);
      const { rows: logRows } = await pool.query(
        `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
         VALUES ($1, 'BROADCAST', $2, 'PENDING') RETURNING id`,
        [broadcastId, recipient.contact_number]
      );
      try {
        await enqueueBroadcastRecipient({
          broadcast, template, account, recipient, broadcastLogId: logRows[0].id, resolvedMediaId, resolvedCarouselComponent,
        });
        enqueued++;
      } catch (jobErr) {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [jobErr.message.slice(0, 500), logRows[0].id]
        );
      }
    }

    await pool.query(
      `UPDATE coexistence.broadcasts SET status = 'SENT', updated_at = NOW() WHERE id = $1`,
      [broadcastId]
    );

    return { ok: true, enqueued };
  }
}

// POST /broadcasts/:id/send — manual "send now".
router.post('/broadcasts/:id/send', async (req, res) => {
  try {
    const result = await dispatchBroadcast(req.params.id);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    const data = await getBroadcastWithLogs(req.params.id);
    res.json({ ...data, enqueued: result.enqueued });
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/send error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

/**
 * Scheduler tick — fire every broadcast whose scheduled_at has arrived.
 * Called on an interval from index.js.
 *
 * The claim is a single atomic `UPDATE … WHERE status='SCHEDULED' AND
 * scheduled_at <= NOW() RETURNING id`. Postgres row-locks each matched row, so
 * even if two ticks overlap (or a second backend instance runs) a broadcast can
 * only ever be claimed once — no duplicate blasts to real customers.
 *
 * A row that fails to dispatch is marked FAILED with the reason rather than
 * being left in SENDING forever, so it's visible in the UI instead of silently
 * stuck.
 */
async function runDueBroadcasts() {
  const { rows } = await pool.query(
    `UPDATE coexistence.broadcasts
        SET status = 'SENDING', updated_at = NOW()
      WHERE status = 'SCHEDULED' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
      RETURNING id, name, scheduled_at`
  );
  if (rows.length === 0) return { fired: 0 };

  let fired = 0;
  for (const row of rows) {
    try {
      const result = await dispatchBroadcast(row.id, { preClaimed: true });
      if (result.ok) {
        fired++;
        console.log(`[broadcasts] scheduled send #${row.id} "${row.name}" → ${result.enqueued} recipient(s)`);
      } else {
        await pool.query(
          `UPDATE coexistence.broadcasts SET status='FAILED', updated_at=NOW() WHERE id=$1`, [row.id]
        );
        console.error(`[broadcasts] scheduled send #${row.id} failed: ${result.error}`);
      }
    } catch (err) {
      await pool.query(
        `UPDATE coexistence.broadcasts SET status='FAILED', updated_at=NOW() WHERE id=$1`, [row.id]
      );
      console.error(`[broadcasts] scheduled send #${row.id} threw: ${err.message}`);
    }
  }
  return { fired };
}

// POST /broadcasts/:id/test — real Meta send to a single test number
router.post('/broadcasts/:id/test', async (req, res) => {
  try {
    const { test_number } = req.body;
    if (!test_number) return res.status(400).json({ error: 'test_number required' });

    const { rows: bRows } = await pool.query(
      `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
              t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons,
              t.template_type AS t_template_type, t.carousel_cards AS t_carousel_cards,
              t.whatsapp_account_id AS t_whatsapp_account_id
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
        WHERE b.id = $1`,
      [req.params.id]
    );
    if (bRows.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    const broadcast = bRows[0];
    const template = broadcast.message_type === 'template'
      ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
          header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons,
          template_type: broadcast.t_template_type, carousel_cards: broadcast.t_carousel_cards,
          whatsapp_account_id: broadcast.t_whatsapp_account_id }
      : null;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const wabaError = templateAccountMismatch(template, account, broadcast.from_number);
    if (wabaError) return res.status(400).json({ error: wabaError });

    // Meta accepts a send even when the account is billing-blocked, then fails
    // it async — reject the click now with the real reason instead.
    const canSend = await assertCanSend(account);
    if (!canSend.ok) return res.status(400).json({ error: canSend.reason });

    // Resolve media once for media-type broadcasts
    let resolvedMediaId = null;
    // Resolve the media id for media-type broadcasts AND for template broadcasts
    // whose template has a media header (IMAGE/VIDEO/DOCUMENT) — both pull from
    // broadcast.media_library_id.
    const _tplHt = template ? String(template.header_type || '').toUpperCase() : '';
    const _needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(_tplHt);
    if ((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || _needsHeaderMedia) && broadcast.media_library_id) {
      const { syncMediaToAccount } = require('./mediaLibrary');
      const { rows: mRows } = await pool.query(
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
        [broadcast.media_library_id]
      );
      if (mRows.length) {
        const media = mRows[0];
        const { rows: sRows } = await pool.query(
          `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
          [media.id, account.id]
        );
        let sync = sRows[0];
        const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
        if (needsSync) {
          sync = await syncMediaToAccount(media.id, account.id);
          sync = {
            meta_media_id: sync.metaMediaId,
            expires_at: sync.expiresAt,
            status: sync.status,
          };
        }
        resolvedMediaId = sync.meta_media_id;
      }
    }

    // CAROUSEL templates: resolve card media + build the carousel send component.
    let resolvedCarouselComponent = null;
    if (template && String(template.template_type || '').toUpperCase() === 'CAROUSEL') {
      const { buildCarouselComponent } = require('./mediaLibrary');
      resolvedCarouselComponent = await buildCarouselComponent(template, account.id);
    }

    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
       VALUES ($1, 'TEST', $2, 'PENDING') RETURNING id`,
      [req.params.id, test_number]
    );

    // If the test number is a saved contact, resolve its real name + custom
    // fields so the test reflects what a real recipient would receive; else
    // fall back to a 'Test' name with empty fields.
    const testCtxMap = await loadContactContext([test_number], broadcast.from_number);
    const testCtx = testCtxMap.get(String(test_number).replace(/\D/g, ''));
    const testRecipient = {
      contact_number: test_number,
      name: testCtx?.name || 'Test',
      custom_fields: testCtx?.custom_fields || {},
      tags: Array.isArray(testCtx?.tags) ? testCtx.tags : [],
    };

    await enqueueBroadcastRecipient({
      broadcast, template, account,
      recipient: testRecipient,
      broadcastLogId: logRows[0].id,
      resolvedMediaId,
      resolvedCarouselComponent,
    });

    await pool.query(
      `UPDATE coexistence.broadcasts SET test_number = $1, updated_at = NOW() WHERE id = $2`,
      [test_number, req.params.id]
    );

    const data = await getBroadcastWithLogs(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/test error:', err.message);
    res.status(500).json({ error: 'Failed to send test' });
  }
});

module.exports = { router, resolveTemplateParam, buildTemplateComponents, runDueBroadcasts, dispatchBroadcast };
