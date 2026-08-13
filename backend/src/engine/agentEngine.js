// Agent engine: end-to-end "inbound message → LLM tool-use loop → outbound reply".
//
// Called from the agentQueue worker (NOT inline from the webhook) so the
// webhook stays under Meta's 20s timeout. Logs everything to agent_runs +
// agent_run_steps so the UI can show a full trace.

const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { getProvider } = require('../llm');
const googleSheets = require('../services/sheetsAgentOps'); // FORGECHAT's Sheets ops (same executeOp API)
const { enqueueSend } = require('../queue/sendQueue');
const { insertPendingRow } = require('../services/messageSender');
const { getAccountWithToken } = require('../routes/whatsappAccounts');
// `asLimit` is imported rather than re-implemented so "NULL/0/negative = no
// limit" means the same thing for the media caps as it does for the usage caps.
const { asLimit, imagesInSession } = require('../services/agentLimits');
const { probeDurationSeconds, formatDuration } = require('../services/mediaDuration');

/**
 * Build the JSON-schema tool definitions surfaced to the LLM for one agent.
 * Returns:
 *   - tools: array of { name, description, input_schema } (Anthropic shape)
 *   - executors: map from tool name → async (args) => result
 *
 * We name tools deterministically as `<tool_type>_<op>` (e.g. `google_sheets_append`)
 * so the LLM can pick the right one and so multiple Sheets tools per agent
 * (different spreadsheets) get unique names via the row id suffix.
 *
 * `agent` is the full agents row (so we can read media_groups). `sendCtx` carries
 * the live send target ({ live:true, waAccountId, contactNumber }); in test mode
 * it's { live:false } and the send_media tool only simulates.
 */
async function buildToolsForAgent(agent, sendCtx = null) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.agent_tools
      WHERE agent_id = $1 AND is_enabled = TRUE
      ORDER BY id`,
    [agent.id],
  );

  const tools = [];
  const executors = {};
  // Collected in the loop, built in one pass afterwards: each one needs a DB read
  // for its form, and building them together keeps that out of this loop body.
  const formToolRows = [];

  for (const row of rows) {
    if (row.tool_type === 'lead_form') {
      formToolRows.push(row);
    }

    if (row.tool_type === 'google_sheets') {
      const cfg = row.config || {};
      const ops = Array.isArray(cfg.ops) ? cfg.ops : [];
      const baseDesc = `Google Sheet "${cfg.spreadsheet_name || cfg.spreadsheet_id}" tab "${cfg.sheet_name}"`;

      if (ops.includes('read')) {
        const name = `google_sheets_read_${row.id}`;
        tools.push({
          name,
          description: `Read rows from ${baseDesc}. Use this to look up information the user might be asking about.`,
          input_schema: {
            type: 'object',
            properties: {
              range: {
                type: 'string',
                description: "Optional A1 range to read (e.g. 'A2:E50'). Omit to read the whole sheet.",
              },
              max_rows: {
                type: 'integer',
                description: 'Cap the number of rows returned. Default 100, max 500.',
              },
            },
          },
        });
        executors[name] = (args) => googleSheets.executeOp({ op: 'read', toolConfig: cfg, args });
      }

      if (ops.includes('append')) {
        const name = `google_sheets_append_${row.id}`;
        tools.push({
          name,
          description: `Append a new row to ${baseDesc}. Use this to save information the user provided (booking, order, lead, etc.).`,
          input_schema: {
            type: 'object',
            properties: {
              values: {
                type: 'array',
                items: { type: ['string', 'number', 'boolean', 'null'] },
                description: 'Cell values in left-to-right column order.',
              },
            },
            required: ['values'],
          },
        });
        executors[name] = (args) => googleSheets.executeOp({ op: 'append', toolConfig: cfg, args });
      }

      if (ops.includes('update')) {
        const name = `google_sheets_update_${row.id}`;
        tools.push({
          name,
          description: `Update a specific range in ${baseDesc}. Use this only after you've used the read tool to identify which row/range to change.`,
          input_schema: {
            type: 'object',
            properties: {
              range: {
                type: 'string',
                description: "A1 range to overwrite (e.g. 'A5:E5' to replace row 5).",
              },
              values: {
                type: 'array',
                items: { type: ['string', 'number', 'boolean', 'null'] },
                description: 'New cell values for the range.',
              },
            },
            required: ['range', 'values'],
          },
        });
        executors[name] = (args) => googleSheets.executeOp({ op: 'update', toolConfig: cfg, args });
      }

      if (ops.includes('upsert')) {
        const name = `google_sheets_upsert_${row.id}`;
        tools.push({
          name,
          description: `Find-or-update one row in ${baseDesc} by a key column. PREFER THIS over append/update for logging a contact's enquiry/order/lead: it finds the existing row by key (e.g. their phone number) and writes only the columns you name, or adds a new row if none exists — so a contact never gets duplicate rows and you never track row numbers or column order. Give the key column's exact header + the contact's value for it, plus the fields to write keyed by their EXACT column headers.`,
          input_schema: {
            type: 'object',
            properties: {
              key_column: { type: 'string', description: 'Exact header of the column that identifies the row, e.g. "Phone Number".' },
              key_value: { type: ['string', 'number'], description: "The contact's value for the key column (e.g. their phone number)." },
              fields: { type: 'object', description: 'Object of { "Exact Column Header": value } — only these columns are written. e.g. { "Conversation summary": "…", "Query on which facility": "Personal Training", "Status": "Trial Scheduled" }.' },
            },
            required: ['key_column', 'key_value', 'fields'],
          },
        });
        executors[name] = (args) => googleSheets.executeOp({ op: 'upsert', toolConfig: cfg, args });
      }
    }

    if (row.tool_type === 'http_request') {
      const cfg = row.config || {};
      const params = Array.isArray(cfg.params) ? cfg.params : [];
      const name = `http_${slugForTool(cfg.label)}_${row.id}`;

      const properties = {};
      const required = [];
      for (const p of params) {
        properties[p.name] = {
          type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
          description: p.description || `The ${p.name} value.`,
        };
        if (p.required) required.push(p.name);
      }

      tools.push({
        name,
        description:
          `${cfg.description}\n(Performs an HTTP ${cfg.method} request to an external system.)`,
        input_schema: { type: 'object', properties, required },
      });
      executors[name] = (args) => executeHttpTool(cfg, args || {});
    }
    // Future: gmail_send, calendar_create_event, etc. — same pattern.
  }

  // Media-send capability. Each configured group (description + media files
  // and/or links) is surfaced to the LLM through a single `send_media` tool; the
  // model passes the index of the group whose description matches the moment in
  // the conversation, and we deliver every file AND link in that group.
  const groupSize = (g) => (Array.isArray(g.mediaIds) ? g.mediaIds.length : 0) + (Array.isArray(g.links) ? g.links.length : 0) + (g.templateId ? 1 : 0);
  const mediaGroups = Array.isArray(agent.media_groups)
    ? agent.media_groups.filter(g => g && groupSize(g) > 0)
    : [];
  if (mediaGroups.length > 0) {
    const list = mediaGroups
      .map((g, i) => {
        const parts = [];
        const nf = Array.isArray(g.mediaIds) ? g.mediaIds.length : 0;
        const nl = Array.isArray(g.links) ? g.links.length : 0;
        if (nf) parts.push(`${nf} file(s)`);
        if (nl) parts.push(`${nl} link(s)`);
        if (g.templateId) parts.push(`1 template${g.templateName ? ` (${g.templateName})` : ''}`);
        return `[${i}] ${g.description} — ${parts.join(', ')}`;
      })
      .join('\n');
    tools.push({
      name: 'send_media',
      description:
        'Send a pre-set group of media files (image/video/audio/document) and/or links to the user on WhatsApp. '
        + 'Call this when the conversation matches one of these groups:\n' + list
        + '\nPass the group_index of the group to send — it delivers every file and link in that group directly. '
        + 'Do not try to describe or paste the files/links in text; calling this is what sends them.',
      input_schema: {
        type: 'object',
        properties: {
          group_index: {
            type: 'integer',
            description: 'Index of the media group to send (see the numbered list above).',
          },
        },
        required: ['group_index'],
      },
    });
    executors['send_media'] = async (args) => {
      const idx = parseInt(args?.group_index, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= mediaGroups.length) {
        return { sent: false, error: `Invalid group_index ${args?.group_index}. Valid range: 0..${mediaGroups.length - 1}.` };
      }
      const group = mediaGroups[idx];
      if (!sendCtx || !sendCtx.live) {
        // Test panel: never send to a real number — just report what would happen.
        //
        // The concrete ids/links/template ride along under `__preview` so the
        // simulator can render what was "sent" as real bubbles. Prefixed and
        // stripped before the model sees the result: an LLM handed a list of
        // media ids starts quoting them at the customer.
        return {
          sent: false, simulated: true,
          group: group.description,
          file_count: (group.mediaIds || []).length,
          link_count: (group.links || []).length,
          template: group.templateName || (group.templateId ? `#${group.templateId}` : null),
          note: 'Test mode — not actually delivered.',
          __preview: {
            mediaIds: Array.isArray(group.mediaIds) ? group.mediaIds : [],
            links: Array.isArray(group.links) ? group.links : [],
            templateId: group.templateId || null,
          },
        };
      }
      return await sendMediaGroup({ group, waAccountId: sendCtx.waAccountId, contactNumber: sendCtx.contactNumber });
    };
  }

  // Fill-a-form tools. Built in test mode too — the operator needs to rehearse
  // the questions in the Live test chat — but each executor refuses to WRITE
  // unless the run is live, so a rehearsal never creates a lead or a submission.
  if (formToolRows.length > 0) {
    const { buildFormTools } = require('../services/agentFormTools');
    const forms = await buildFormTools({
      toolRows: formToolRows,
      contactNumber: sendCtx && sendCtx.contactNumber,
      live: !!(sendCtx && sendCtx.live),
      // Stamped onto every row the agent files, which is what makes "you may
      // correct a row YOU added" enforceable rather than advisory.
      agentId: agent.id,
    });
    tools.push(...forms.tools);
    Object.assign(executors, forms.executors);
  }

  // Removed from this list on purpose: the CRM write-back tools, the payment
  // tools and escalate_to_human. An agent here collects data into a form's
  // table; it does not edit the contact, take money, or reassign a human's
  // conversation. The Chats-side takeover (contacts.agent_paused) is
  // untouched — a person can still silence the bot from the inbox, and the
  // usage-limit pause still uses it.

  return { tools, executors };
}

// Turn an HTTP tool label into a safe tool-name fragment (LLM tool names must
// match ^[a-zA-Z0-9_-]+). Falls back to "call" when nothing usable remains.
function slugForTool(label) {
  const s = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'call';
}

/**
 * Execute a configured http_request tool. The admin owns method/url/static
 * headers; the LLM supplies the declared params (path → URL substitution,
 * query → querystring, body → JSON body, header → request header). Returns a
 * compact { ok, status, body } the model can read; never throws (errors come
 * back as { ok:false, error } so the LLM can react).
 */
async function executeHttpTool(cfg, args) {
  try {
    const method = String(cfg.method || 'GET').toUpperCase();
    const params = Array.isArray(cfg.params) ? cfg.params : [];

    let url = String(cfg.url || '');
    const query = new URLSearchParams();
    const bodyObj = {};
    const dynHeaders = {};
    let hasBody = false;

    for (const p of params) {
      let val = args[p.name];
      if (val === undefined || val === null || val === '') {
        if (p.required) return { ok: false, error: `Missing required parameter "${p.name}".` };
        continue;
      }
      if (p.type === 'number') { const n = Number(val); if (!Number.isNaN(n)) val = n; }
      else if (p.type === 'boolean') { val = val === true || val === 'true' || val === 1 || val === '1'; }

      if (p.in === 'path') {
        url = url.replace(new RegExp(`\\{${p.name}\\}`, 'g'), encodeURIComponent(String(val)));
      } else if (p.in === 'query') {
        query.append(p.name, String(val));
      } else if (p.in === 'header') {
        dynHeaders[p.name] = String(val);
      } else { // body
        bodyObj[p.name] = val;
        hasBody = true;
      }
    }

    const qs = query.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;

    const headers = {};
    for (const h of (Array.isArray(cfg.headers) ? cfg.headers : [])) {
      if (h && h.k) headers[h.k] = h.v;
    }
    Object.assign(headers, dynHeaders);

    const init = { method, headers };
    if (method !== 'GET' && method !== 'DELETE' && hasBody) {
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      init.body = JSON.stringify(bodyObj);
    }

    const ctrl = new AbortController();
    const timeout = Math.max(1000, Math.min(30000, parseInt(cfg.timeout_ms || 10000, 10) || 10000));
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let body;
    try { body = JSON.parse(raw); }
    catch { body = raw.length > 4000 ? raw.slice(0, 4000) + '…[truncated]' : raw; }
    // Cap parsed-JSON size too, so a huge response can't blow the LLM context.
    if (typeof body !== 'string') {
      const asStr = JSON.stringify(body);
      if (asStr.length > 4000) body = asStr.slice(0, 4000) + '…[truncated]';
    }

    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'Request timed out.' };
    return { ok: false, error: err.message || 'HTTP request failed.' };
  }
}

/**
 * Deliver every media item in a group to the contact on WhatsApp. Mirrors the
 * automation engine's direct-media path: resolve each media_library item to a
 * per-account Meta media handle (sync if stale), drop an optimistic outbound
 * chat_history row, mirror the bytes to disk so the bubble previews, then
 * enqueue the send on the shared sendQueue.
 */
async function sendMediaGroup({ group, waAccountId, contactNumber }) {
  const { syncMediaToAccount } = require('../routes/mediaLibrary');
  const account = await getAccountWithToken(waAccountId);
  if (!account || !account.displayPhoneNumber) {
    return { sent: false, error: 'No usable WhatsApp account bound to this agent.' };
  }

  const sent = [];
  for (const rawId of group.mediaIds) {
    const mediaId = parseInt(rawId, 10);
    if (!Number.isInteger(mediaId)) continue;
    try {
      const { rows } = await pool.query(
        `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
        [mediaId],
      );
      const media = rows[0];
      if (!media) continue;

      // Resolve (or refresh) the per-account Meta media handle.
      const { rows: sRows } = await pool.query(
        `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
        [media.id, waAccountId],
      );
      let metaMediaId = sRows[0]?.meta_media_id;
      const stale = !sRows[0] || sRows[0].status !== 'synced' || !metaMediaId
        || (sRows[0].expires_at && new Date(sRows[0].expires_at) <= new Date());
      if (stale) {
        const synced = await syncMediaToAccount(media.id, waAccountId);
        metaMediaId = synced.metaMediaId;
      }
      if (!metaMediaId) continue;

      const type = media.media_type; // image | video | audio | document
      const localMessageId = await insertPendingRow({
        account,
        toNumber: contactNumber,
        messageType: type,
        messageBody: null,
        mediaMime: media.mime_type,
      });

      // Mirror the library file to local disk so the outbound bubble can
      // preview it (best-effort; a failure must not block the Meta send).
      try {
        const { getObjectBuffer } = require('../util/minioClient'); // FORGECHAT object storage
        const { persistOutboundBuffer } = require('../services/mediaDownloader');
        const buf = await getObjectBuffer(media.storage_key);
        const ext = (media.original_name || '').split('.').pop()?.toLowerCase()
          || (media.mime_type || '').split('/')[1] || 'bin';
        const acctDigits = String(account.displayPhoneNumber || '').replace(/\D/g, '');
        const { absPath, size } = persistOutboundBuffer({ accountPhoneDigits: acctDigits, messageId: localMessageId, buffer: buf, ext });
        await pool.query(
          `UPDATE coexistence.chat_history
              SET media_storage_path = $1, media_status = 'stored', media_size_bytes = $2,
                  media_mime_type = COALESCE(media_mime_type, $3), media_filename = $4, media_downloaded_at = NOW()
            WHERE message_id = $5`,
          [absPath, size, media.mime_type, media.original_name, localMessageId],
        );
      } catch (mErr) {
        console.error('[agentEngine] media mirror failed:', mErr.message);
      }

      await enqueueSend({
        kind: 'media',
        accountId: waAccountId,
        to: contactNumber,
        localMessageId,
        payload: {
          type,
          mediaId: metaMediaId,
          filename: type === 'document' ? media.original_name : undefined,
        },
      });
      sent.push(media.name || media.original_name || `media#${media.id}`);
    } catch (e) {
      console.error('[agentEngine] sendMediaGroup item failed:', e.message);
    }
  }

  // Send each link as a text message with a link preview (preview_url=true).
  const sentLinks = [];
  for (const url of (Array.isArray(group.links) ? group.links : [])) {
    try {
      const localMessageId = await insertPendingRow({
        account, toNumber: contactNumber, messageType: 'text', messageBody: url,
      });
      await enqueueSend({
        kind: 'text',
        accountId: waAccountId,
        to: contactNumber,
        localMessageId,
        payload: { body: url, previewUrl: true },
      });
      sentLinks.push(url);
    } catch (e) {
      console.error('[agentEngine] sendMediaGroup link failed:', e.message);
    }
  }

  // Finally, fire the attached approved template (if any) — e.g. a menu or
  // order-confirmation template. Mirrors the automation engine's template path:
  // insert a pending 'template' row (with template_meta so the bubble renders),
  // then enqueue a `kind:'template'` send. Variable bindings aren't supported
  // here, so this is for static (no-{{1}}) templates; the WABA must match the
  // agent's number (guaranteed — the picker is account-scoped).
  let sentTemplate = null;
  if (group.templateId) {
    try {
      const { rows: tRows } = await pool.query(
        `SELECT id, name, language, body, header_type, header_text, footer, buttons,
                whatsapp_account_id, status
           FROM coexistence.message_templates WHERE id = $1`,
        [parseInt(group.templateId, 10)],
      );
      const tpl = tRows[0];
      if (tpl && String(tpl.whatsapp_account_id) === String(waAccountId) && tpl.status === 'APPROVED') {
        const localMessageId = await insertPendingRow({
          account, toNumber: contactNumber, messageType: 'template',
          messageBody: tpl.body || `Template: ${tpl.name}`,
          templateId: tpl.id, sendOrigin: 'agent',
          templateMeta: {
            header_type: tpl.header_type || 'NONE',
            header_text: tpl.header_text || null,
            footer: tpl.footer || null,
            buttons: Array.isArray(tpl.buttons) ? tpl.buttons : (tpl.buttons || []),
          },
        });
        await enqueueSend({
          kind: 'template',
          accountId: waAccountId,
          to: String(contactNumber).replace(/\D/g, ''),
          localMessageId,
          payload: { name: tpl.name, languageCode: tpl.language || 'en', components: [] },
        });
        sentTemplate = tpl.name;
      } else {
        console.error('[agentEngine] sendMediaGroup template skipped: not found / wrong account / not approved', group.templateId);
      }
    } catch (e) {
      console.error('[agentEngine] sendMediaGroup template failed:', e.message);
    }
  }

  return {
    sent: (sent.length + sentLinks.length + (sentTemplate ? 1 : 0)) > 0,
    file_count: sent.length, link_count: sentLinks.length,
    files: sent, links: sentLinks, template: sentTemplate, group: group.description,
  };
}

/**
 * Pull recent chat history for this contact, oldest-first, capped at the
 * agent's context window. Skips status updates and reactions.
 */
async function buildMessageHistory({ waAccountId, contactNumber, limit, currentInboundText }) {
  // Resolve the agent's wa_number from the WhatsApp account
  let waNumber = null;
  if (waAccountId) {
    const acc = await getAccountWithToken(waAccountId);
    waNumber = acc?.displayPhoneNumber || null;
  }

  const { rows } = waNumber
    ? await pool.query(
        `SELECT direction, message_body, timestamp
           FROM coexistence.chat_history
          WHERE wa_number = $1 AND contact_number = $2
            AND message_type NOT IN ('status','reaction')
            AND message_body IS NOT NULL AND message_body <> ''
          ORDER BY timestamp DESC
          LIMIT $3`,
        [waNumber, contactNumber, Math.max(1, Math.min(100, limit || 20))],
      )
    : { rows: [] };

  // DB returned newest-first for the LIMIT; reverse to chronological.
  const history = rows.reverse().map(r => ({
    role: r.direction === 'incoming' ? 'user' : 'assistant',
    content: r.message_body,
  }));

  // The current inbound message may not yet be persisted (timing race vs.
  // webhook commit). Append it as the last user message if it isn't there.
  const last = history[history.length - 1];
  if (currentInboundText && !(last && last.role === 'user' && last.content === currentInboundText)) {
    history.push({ role: 'user', content: currentInboundText });
  }
  return history;
}

// Provider + key now come from the agent's referenced ai_models registry row
// (joined as ai_provider / ai_api_key_encrypted). The registry key wins; if the
// row has none (shouldn't happen — the route requires a key) or the agent has no
// model bound, fall back to the server-wide env key for that provider.
function pickApiKey(agent) {
  const fromRegistry = decrypt(agent.ai_api_key_encrypted);
  if (fromRegistry) return fromRegistry;
  if (agent.ai_provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (agent.ai_provider === 'openai')    return process.env.OPENAI_API_KEY || '';
  return '';
}

// Resolve an OpenAI key for Whisper transcription: the agent's own key if it's
// an OpenAI agent, otherwise any OpenAI credential connected in the AI Models
// registry (falling back to the env key). Lets an Anthropic agent still
// transcribe voice notes using the workspace's OpenAI key.
async function resolveOpenAiKey(agent, agentApiKey) {
  if (agent.ai_provider === 'openai' && agentApiKey) return agentApiKey;
  try {
    const { rows } = await pool.query(
      `SELECT api_key_encrypted FROM coexistence.ai_models
        WHERE provider = 'openai' AND api_key_encrypted IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    );
    if (rows[0]) {
      const k = decrypt(rows[0].api_key_encrypted);
      if (k) return k;
    }
  } catch (e) {
    console.error('[agentEngine] resolveOpenAiKey failed:', e.message);
  }
  return process.env.OPENAI_API_KEY || '';
}

// If the inbound message is a voice note, download + transcribe it (OpenAI
// Whisper). Writes the transcript back into chat_history so it shows in the
// conversation + future context.
//
// Returns { text, tooLong }:
//   text    — the transcript, or the plain body for a non-audio message ('' if
//             there is nothing usable).
//   tooLong — { seconds, cap } when the note was longer than the agent's
//             `max_voice_seconds` and was therefore NOT transcribed.
//
// ⚠ The length check happens AFTER the download but BEFORE Whisper, which is the
// only place it can save anything: Whisper bills per minute of audio, so a cap
// applied to the transcript would have already paid for the ten-minute note it
// was meant to refuse. Meta's webhook carries no duration, so the file itself is
// the only source (services/mediaDuration.js).
//
// Note: audio/voice inbounds are stored with a placeholder body ("Audio
// message" / "Voice message") by the webhook — never a real caption — so for
// audio we ignore the stored body and always transcribe the actual file.
async function transcribeInboundIfAudio({ agent, inboundMessageId, agentApiKey }) {
  try {
    const { rows } = await pool.query(
      `SELECT message_id, message_type, message_body
         FROM coexistence.chat_history WHERE message_id = $1`,
      [inboundMessageId],
    );
    const msg = rows[0];
    if (!msg) return { text: '', tooLong: null };
    const isAudio = msg.message_type === 'audio' || msg.message_type === 'voice';
    // Non-audio: any real text body IS the message; nothing to transcribe.
    if (!isAudio) {
      return { text: (msg.message_body && msg.message_body.trim()) ? msg.message_body.trim() : '', tooLong: null };
    }

    const openaiKey = await resolveOpenAiKey(agent, agentApiKey);
    if (!openaiKey) {
      console.warn('[agentEngine] voice note received but no OpenAI key connected for transcription.');
      return { text: '', tooLong: null };
    }
    const { downloadOne } = require('../services/mediaDownloader');
    const { transcribeAudioFile } = require('../services/transcription');
    const dl = await downloadOne(inboundMessageId);
    if (!dl || !dl.ok || !dl.path) {
      console.warn('[agentEngine] could not fetch audio for transcription:', dl && dl.error);
      return { text: '', tooLong: null };
    }

    // Length cap. An UNKNOWN duration (no ffprobe, unreadable container) is
    // treated as acceptable and transcribed — failing open loses a cost guard,
    // failing closed loses the customer's message.
    const voiceCap = asLimit(agent.max_voice_seconds);
    if (voiceCap) {
      const secs = await probeDurationSeconds(dl.path);
      if (secs != null && secs > voiceCap) {
        console.warn(`[agentEngine] agent ${agent.id}: voice note ${inboundMessageId} is ${formatDuration(secs)}, over the ${formatDuration(voiceCap)} cap — not transcribed.`);
        return { text: '', tooLong: { seconds: Math.round(secs), cap: voiceCap } };
      }
    }

    const text = await transcribeAudioFile({ filePath: dl.path, apiKey: openaiKey });
    if (!text) return { text: '', tooLong: null };
    // Surface the transcript in the chat (and future agent context), replacing
    // the placeholder body the webhook stored for the voice note.
    await pool.query(
      `UPDATE coexistence.chat_history SET message_body = $1
        WHERE message_id = $2
          AND (message_body IS NULL OR message_body = ''
               OR message_body IN ('Audio message', 'Voice message'))`,
      [text, inboundMessageId],
    );
    return { text, tooLong: null };
  } catch (e) {
    console.error('[agentEngine] transcription failed:', e.message);
    return { text: '', tooLong: null };
  }
}

/**
 * Load an inbound image as base64 so it can be shown to a vision model. Reads
 * the already-downloaded file (media_storage_path) when present, else downloads
 * it on demand via the same mediaDownloader the chat UI uses. Returns
 * { mime, data } or null (not an image / too large / fetch failed).
 */
async function loadInboundImageBase64({ inboundMessageId }) {
  try {
    const { rows } = await pool.query(
      `SELECT message_id, message_type, media_mime_type, media_storage_path, media_status
         FROM coexistence.chat_history WHERE message_id = $1`,
      [inboundMessageId],
    );
    const msg = rows[0];
    if (!msg || msg.message_type !== 'image') return null;

    const fs = require('fs');
    let absPath = (msg.media_status === 'stored' && msg.media_storage_path) ? msg.media_storage_path : null;
    let mime = msg.media_mime_type || 'image/jpeg';

    if (!absPath) {
      const { downloadOne } = require('../services/mediaDownloader');
      const dl = await downloadOne(inboundMessageId);
      if (!dl || !dl.ok || !dl.path) {
        console.warn('[agentEngine] could not fetch inbound image:', dl && dl.error);
        return null;
      }
      absPath = dl.path;
      if (dl.mime) mime = dl.mime;
    }

    if (!fs.existsSync(absPath)) return null;
    const buf = fs.readFileSync(absPath);
    if (!buf || !buf.length) return null;
    // Vision APIs cap image bytes (~5MB effective); WhatsApp inbound images are
    // already ≤5MB, but guard anyway so a stray large file can't break the run.
    if (buf.length > 5 * 1024 * 1024) {
      console.warn('[agentEngine] inbound image too large for vision:', buf.length);
      return null;
    }
    return { mime, data: buf.toString('base64') };
  } catch (e) {
    console.error('[agentEngine] loadInboundImage failed:', e.message);
    return null;
  }
}

async function recordStep(runId, stepIndex, step) {
  await pool.query(
    `INSERT INTO coexistence.agent_run_steps
       (run_id, step_index, step_type, tool_type, input, output, status, latency_ms, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      runId,
      stepIndex,
      step.step_type,
      step.tool_type || null,
      step.input ? JSON.stringify(step.input) : null,
      step.output != null ? JSON.stringify(step.output) : null,
      step.status,
      step.latency_ms || null,
      step.error_message ? String(step.error_message).slice(0, 1000) : null,
    ],
  );
}

/**
 * Append a small, machine-stable context block to the agent's system prompt so
 * the LLM knows the customer's WhatsApp number (the chat history never carries
 * it). Without this the agent can't fill a "Mobile Number" column when saving an
 * order to a sheet — it would have to ask the customer, which we don't want.
 */
function withContactContext(systemPrompt, contactNumber) {
  const base = systemPrompt || '';
  // Always tell the model today's date/time (IST). Without it the LLM guesses,
  // and was logging stale dates (e.g. a 2023 date) into the "Date" sheet column.
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const dateCtx = `\n\n## Current date & time\n- Today is ${today} at ${time} (Asia/Kolkata, IST). Use this whenever you need the current date/time — e.g. a "Date" column when logging to a sheet. Format dates as YYYY-MM-DD unless instructed otherwise.`;
  if (!contactNumber) return base + dateCtx;
  return `${base}${dateCtx}\n\n## Conversation context\n- The customer's WhatsApp number is ${contactNumber}. When you need their mobile number (e.g. saving an order to a sheet), use this exact number — never ask the customer for it.`;
}

/**
 * Main entry. Loads the agent, builds tools + context, runs the LLM loop,
 * persists everything, and enqueues the final reply on the existing sendQueue.
 */
async function runAgent({ agentId, contactNumber, inboundMessageId, inboundText, isTest = false }) {
  const { rows: agentRows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.api_key_encrypted AS ai_api_key_encrypted
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [agentId],
  );
  const agent = agentRows[0];
  if (!agent) throw new Error(`Agent id=${agentId} not found`);
  // A DRAFT agent still runs for one of its own test numbers — that is the
  // whole point of a test number, and the router only routes one here after
  // matching the list on the agent itself. Every other inbound still needs the
  // agent to be live.
  if (!agent.is_active && !isTest) throw new Error(`Agent id=${agentId} is inactive`);
  if (!agent.wa_account_id) throw new Error(`Agent id=${agentId} has no WhatsApp account bound`);
  if (!agent.ai_provider) throw new Error(`Agent id=${agentId} has no AI model connected. Connect one under Admin Settings → Integrations → AI Models.`);

  const apiKey = pickApiKey(agent);
  if (!apiKey) {
    throw new Error(`No API key for provider '${agent.ai_provider}'. Add it under Integrations → AI Models, or set ${agent.ai_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} in backend/.env.`);
  }

  // Voice notes: when the agent has transcription on and the inbound is audio
  // (no text body), turn it into text via Whisper before opening the run /
  // running the LLM loop. If we can't get a transcript, skip silently rather
  // than reply to a placeholder.
  let messageText = inboundText;
  if (!messageText && inboundMessageId && agent.transcribe_audio) {
    // May be empty (no transcript) — don't bail yet; it could still be an image.
    const heard = await transcribeInboundIfAudio({ agent, inboundMessageId, agentApiKey: apiKey });
    messageText = heard.text;
    // A note over the length cap is NOT silence. The customer has just spoken
    // for several minutes; going quiet reads exactly like being ignored, and
    // they have no way to know a limit exists. Hand the model the fact so it can
    // ask for a shorter note or for text — and tell it plainly not to pretend it
    // heard the contents, because a model given an empty transcript will
    // otherwise happily invent a reply to it.
    if (!messageText && heard.tooLong) {
      messageText =
        `[System note: the customer sent a voice note ${formatDuration(heard.tooLong.seconds)} long, `
        + `which is over this agent's ${formatDuration(heard.tooLong.cap)} limit, so it was not transcribed `
        + `and you cannot know what they said. Apologise briefly and ask them to send a shorter voice note `
        + `or type their message instead. Do not guess what the note contained.]`;
    }
  }

  // Vision: when the agent accepts images and the inbound is a picture, load its
  // bytes so the (vision-capable) model can actually see it.
  //
  // The per-conversation image cap is checked BEFORE the bytes are loaded, since
  // the point of the cap is to not pay for the image at all. It is compared with
  // `>` because imagesInSession() counts the photo that just arrived: a cap of 3
  // allows the 3rd and refuses the 4th.
  let inboundImage = null;
  let imageOverCap = null;
  if (inboundMessageId && agent.accept_images) {
    const imageCap = asLimit(agent.max_images_per_conversation);
    if (imageCap) {
      const { rows: mt } = await pool.query(
        `SELECT message_type FROM coexistence.chat_history WHERE message_id = $1`,
        [inboundMessageId],
      );
      // Only meaningful for an actual image — a text message must never be
      // refused because earlier photos used the budget up.
      if (mt[0]?.message_type === 'image') {
        // chat_history is keyed on the business number, not the account id.
        const { resolveWaNumber } = require('../services/agentCrmTools');
        const waNumber = await resolveWaNumber(agent.wa_account_id);
        const seen = await imagesInSession({
          waNumber, contactNumber,
          sessionMinutes: agent.trigger_session_minutes || 30,
        });
        if (seen > imageCap) {
          imageOverCap = { seen, cap: imageCap };
          console.warn(`[agentEngine] agent ${agent.id}: image ${inboundMessageId} is number ${seen} this conversation, over the cap of ${imageCap} — not shown to the model.`);
        }
      }
    }
    if (!imageOverCap) inboundImage = await loadInboundImageBase64({ inboundMessageId });
  }

  // Same reasoning as the voice cap: say so rather than going quiet. A caption
  // still stands on its own as the customer's message, so the note is appended
  // to it instead of replacing it.
  if (imageOverCap) {
    const note =
      `[System note: the customer sent an image, but this agent has already looked at `
      + `${imageOverCap.cap} image(s) in this conversation, so this one was not viewed and you cannot `
      + `see it. Tell them you cannot look at more pictures right now and ask them to describe it. `
      + `Do not guess what the image shows.]`;
    messageText = messageText ? `${messageText}\n\n${note}` : note;
  }

  if (!messageText && !inboundImage) {
    console.warn(`[agentEngine] agent ${agent.id}: inbound ${inboundMessageId} had no usable text/transcript/image; skipping run.`);
    return { skipped: true, reason: 'nothing_actionable' };
  }

  // Open the run row immediately so a crash mid-loop is still visible in the UI.
  //
  // ⚠ This INSERT is also the duplicate guard. webhook.js builds its record
  // list from the PARSED payload rather than from rows that were newly
  // inserted, so a Meta re-delivery — or the Webhook History replay button —
  // reaches routeIfActive again for a message the agent already answered.
  // uq_agent_runs_inbound (migration 102) makes the second one a 23505, which
  // is caught here and skipped instead of sending the customer a second reply.
  // The guard is the index and not a SELECT-then-INSERT check because two
  // concurrent deliveries would both pass the check.
  let runId;
  try {
    const { rows: runRows } = await pool.query(
      `INSERT INTO coexistence.agent_runs
         (agent_id, wa_account_id, contact_number, inbound_message_id, status, is_test)
       VALUES ($1,$2,$3,$4,'running',$5)
       RETURNING id`,
      [agent.id, agent.wa_account_id, contactNumber, inboundMessageId || null, !!isTest],
    );
    runId = runRows[0].id;
  } catch (e) {
    if (e.code === '23505') {
      console.warn(`[agentEngine] agent ${agent.id}: inbound ${inboundMessageId} already handled; skipping duplicate run.`);
      return { skipped: true, reason: 'duplicate_inbound' };
    }
    throw e;
  }

  let stepCounter = 0;
  const onStep = async (step) => {
    stepCounter += 1;
    try {
      await recordStep(runId, stepCounter, step);
    } catch (e) {
      console.error('[agentEngine] step persist failed:', e.message);
    }
  };

  try {
    const { tools, executors } = await buildToolsForAgent(agent, {
      live: true,
      waAccountId: agent.wa_account_id,
      contactNumber,
    });
    const history = await buildMessageHistory({
      waAccountId: agent.wa_account_id,
      contactNumber,
      limit: agent.context_window_messages,
      currentInboundText: messageText,
    });

    // If the inbound was an image, make the final user turn multimodal (image +
    // caption) so the model sees the picture. Replaces the caption-only text
    // turn buildMessageHistory just added, or appends a fresh turn when the
    // image had no caption.
    if (inboundImage) {
      const caption = (messageText || '').trim();
      const parts = [
        { type: 'image', mime: inboundImage.mime, data: inboundImage.data },
        { type: 'text', text: caption || 'The customer sent this image.' },
      ];
      const last = history[history.length - 1];
      if (last && last.role === 'user' && last.content === caption && caption) {
        last.content = parts;
      } else {
        history.push({ role: 'user', content: parts });
      }
    }

    const provider = getProvider(agent.ai_provider);
    const result = await provider.runWithTools({
      systemPrompt: withContactContext(agent.system_prompt, contactNumber),
      messages: history,
      tools,
      onToolCall: async ({ name, args }) => {
        const exec = executors[name];
        if (!exec) throw new Error(`Unknown tool '${name}'`);
        return await exec(args);
      },
      onStep,
      model: agent.llm_model,
      apiKey,
      maxIterations: Math.max(1, Math.min(20, agent.max_tool_iterations || 6)),
      // Conversation identity, for providers that keep server-side session
      // state. The bundled anthropic/openai adapters ignore these fields.
      conversationKey: `${agent.id}:${contactNumber}`,
      contactNumber,
      agentId: agent.id,
    });

    const finalStatus = result.capped ? 'capped' : 'completed';
    await pool.query(
      `UPDATE coexistence.agent_runs
          SET status=$1, total_input_tokens=$2, total_output_tokens=$3,
              final_reply=$4, ended_at=NOW()
        WHERE id=$5`,
      [finalStatus, result.totalInputTokens, result.totalOutputTokens,
       result.finalText || null, runId],
    );

    if (result.finalText) {
      // Insert an optimistic chat_history row FIRST so the agent's reply shows
      // up in the Chats UI immediately (status='sending'), then the existing
      // sendQueue worker swaps the local id for Meta's wamid on success
      // (markSent) or marks it failed (markFailed). Without this row, the
      // message is delivered to WhatsApp but never appears in our own UI.
      const account = await getAccountWithToken(agent.wa_account_id);
      let localMessageId = null;
      if (account && account.displayPhoneNumber) {
        try {
          localMessageId = await insertPendingRow({
            account,
            toNumber: contactNumber,
            messageType: 'text',
            messageBody: result.finalText,
          });
        } catch (e) {
          console.error('[agentEngine] optimistic row insert failed:', e.message);
        }
      }
      await enqueueSend({
        kind: 'text',
        accountId: agent.wa_account_id,
        to: contactNumber,
        localMessageId,
        payload: { body: result.finalText },
      });
    }
    return { runId, status: finalStatus, finalText: result.finalText };
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.agent_runs
          SET status='failed', error_message=$1, ended_at=NOW()
        WHERE id=$2`,
      [String(err.message || err).slice(0, 1000), runId],
    );
    throw err;
  }
}

/**
 * Dry-run an agent for the in-app test chat panel. Same loading + tool
 * execution as runAgent, but:
 *   - Does NOT enqueue a real WhatsApp send (no chat_history write).
 *   - Does NOT persist to agent_runs / agent_run_steps (test interactions
 *     would otherwise pollute the run history).
 *   - Accepts an explicit messages[] array so the operator can simulate a
 *     multi-turn conversation without writing to chat_history.
 *   - Returns the full step trace inline so the UI can show what the LLM
 *     called and what tools fired.
 *
 * `messages` shape: [{ role: 'user'|'assistant', content: string }] — same as
 * the runtime hydrates from chat_history in runAgent.
 */
async function runAgentTest({ agentId, messages }) {
  const { rows: agentRows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.api_key_encrypted AS ai_api_key_encrypted
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [agentId],
  );
  const agent = agentRows[0];
  if (!agent) throw new Error(`Agent id=${agentId} not found`);
  if (!agent.ai_provider) throw new Error('This agent has no AI model connected yet. Connect one under Integrations → AI Models, then pick it in the Model section.');
  if (!agent.llm_model) throw new Error('Pick a model in the Model section before testing.');

  const apiKey = pickApiKey(agent);
  if (!apiKey) {
    throw new Error(`No API key for provider '${agent.ai_provider}'. Add it under Integrations → AI Models, or set ${agent.ai_provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} in backend/.env.`);
  }

  const { tools, executors } = await buildToolsForAgent(agent, { live: false });

  const steps = [];
  const onStep = async (step) => {
    steps.push({
      stepIndex: steps.length + 1,
      stepType: step.step_type,
      toolType: step.tool_type || null,
      input: step.input,
      output: step.output,
      status: step.status,
      latencyMs: step.latency_ms || null,
      errorMessage: step.error_message || null,
    });
  };

  const cleaned = Array.isArray(messages)
    ? messages.filter(m => m && m.content && (m.role === 'user' || m.role === 'assistant'))
    : [];
  if (cleaned.length === 0) {
    throw new Error('At least one message is required (role=user|assistant, non-empty content).');
  }

  // What the agent "sent" during this turn, so the simulator can show it as
  // real bubbles instead of the customer-facing text alone. Without this the
  // preview renders nothing for a send_media call — the frontend has always
  // read `res.media` / `res.links`, and nothing ever put them there, so files,
  // links and templates were invisible in the test chat while working fine on
  // WhatsApp.
  const sentMediaIds = [];
  const sentLinks = [];
  const sentTemplateIds = [];

  const provider = getProvider(agent.ai_provider);
  const result = await provider.runWithTools({
    systemPrompt: withContactContext(agent.system_prompt, 'test'),
    messages: cleaned,
    tools,
    onToolCall: async ({ name, args }) => {
      const exec = executors[name];
      if (!exec) throw new Error(`Unknown tool '${name}'`);
      const out = await exec(args);
      // Lift the preview payload off the result and DELETE it, so neither the
      // model nor the step trace sees internal ids it might repeat back.
      if (out && typeof out === 'object' && out.__preview) {
        const p = out.__preview;
        delete out.__preview;
        for (const id of (p.mediaIds || [])) if (!sentMediaIds.includes(id)) sentMediaIds.push(id);
        for (const l of (p.links || [])) if (!sentLinks.includes(l)) sentLinks.push(l);
        if (p.templateId && !sentTemplateIds.includes(p.templateId)) sentTemplateIds.push(p.templateId);
      }
      return out;
    },
    onStep,
    model: agent.llm_model,
    apiKey,
    maxIterations: Math.max(1, Math.min(20, agent.max_tool_iterations || 6)),
    // Test chat: a synthetic, per-agent conversation key (isolated from real
    // contacts).
    conversationKey: `${agent.id}:test`,
    contactNumber: 'test',
    agentId: agent.id,
  });

  return {
    reply: result.finalText || '',
    status: result.capped ? 'capped' : 'completed',
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    iterations: result.iterations,
    steps,
    // Whatever the agent sent alongside its text. `media` carries {id,type,name}
    // because that is the shape the preview's MediaItem renders — a bare id
    // would give it no way to choose between an <img>, a <video> and a file
    // card. `templates` carries the real approved content so the simulator
    // draws the same bubble WhatsApp will, rather than a placeholder.
    media: await loadMediaForPreview(sentMediaIds),
    links: sentLinks,
    templates: await loadTemplatesForPreview(sentTemplateIds),
  };
}

/**
 * Media Library rows for the test simulator, in the order they were sent.
 * A row deleted since the group was configured is skipped — showing a broken
 * thumbnail would suggest the live send is broken too, when what is actually
 * wrong is the group.
 */
async function loadMediaForPreview(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, name, original_name, media_type FROM coexistence.media_library WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const byId = new Map(rows.map(r => [String(r.id), r]));
    return ids
      .map(id => byId.get(String(id)))
      .filter(Boolean)
      .map(r => ({ id: Number(r.id), name: r.name || r.original_name || `File ${r.id}`, type: r.media_type }));
  } catch (e) {
    console.error('[agentEngine] media preview load failed:', e.message);
    return [];
  }
}

/**
 * Approved-template content for the test simulator.
 *
 * Read fresh from `message_templates` rather than from the media group, which
 * only stores the id + a name snapshot — a preview built from the snapshot
 * would keep showing a template's OLD wording after it was edited and
 * re-approved, which is exactly the case someone opens the simulator to check.
 *
 * A template that has since been deleted is skipped rather than faked: the
 * honest outcome is that the operator sees it is missing.
 */
async function loadTemplatesForPreview(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, name, language, category, header_type, header_text, body, footer, buttons,
              header_media_library_id
         FROM coexistence.message_templates
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    // Ordered by the sequence the agent sent them in, not by id.
    const byId = new Map(rows.map(r => [String(r.id), r]));
    return ids
      .map(id => byId.get(String(id)))
      .filter(Boolean)
      .map(r => ({
        id: Number(r.id),
        name: r.name,
        language: r.language,
        headerType: r.header_type || 'NONE',
        headerText: r.header_text || '',
        body: r.body || '',
        footer: r.footer || '',
        buttons: Array.isArray(r.buttons) ? r.buttons : [],
        headerMediaLibraryId: r.header_media_library_id == null ? null : Number(r.header_media_library_id),
      }));
  } catch (e) {
    // A preview is not worth failing the whole test turn over.
    console.error('[agentEngine] template preview load failed:', e.message);
    return [];
  }
}

module.exports = { runAgent, runAgentTest, buildToolsForAgent, buildMessageHistory };
