// Shared MCP logic used by BOTH transports:
//   - routes/mcp.js   (REST: /api/mcp/v1/*, bearer header — for the stdio server)
//   - mcpHttp.js      (Streamable HTTP: /api/mcp/http/:key — remote connector)
//
// Holds the settings/key-validation + discovery queries so the two transports
// can't drift. Agent create/update/tool ops live in services/agentService.js.

const pool = require('../db');
const bus = require('../events');
const mcpCatalog = require('./mcpCatalog');
const { hashApiKey } = require('../util/crypto');
const googleClient = require('../integrations/googleClient');
const { resolveAccount, insertPendingRow, secondsSinceLastIncoming } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { uploadMedia } = require('../integrations/metaSend');
const { markAccountHealth, classifyMetaError } = require('./accountHealth');

// Meta's free-form customer-service window. Outside it, only approved
// templates can be delivered (free-form text is rejected by Meta).
const SERVICE_WINDOW_SECONDS = 24 * 60 * 60;

// Static LLM catalog — keep in sync with frontend/src/components/agents/modelCatalog.js.
const MODEL_CATALOG = {
  anthropic: [
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (most capable)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
};
const PROVIDER_LABELS = { anthropic: 'Anthropic Claude', openai: 'OpenAI' };
// Per-area "full access" capabilities for the generic proxy + bulk tool.
// Each maps to a set of internal /api path prefixes (PROXY_AREAS below).
// Derived from the catalog's API_AREAS (the list the Settings screen renders), so
// a switch can never exist in the UI without a key here, or the reverse.
const AREA_CAPABILITY_KEYS = mcpCatalog.API_AREAS.map(a => a.key);
const CAPABILITY_KEYS = [
  'discovery', 'create_agent', 'update_agent', 'manage_tools', 'delete',
  'read_messages', 'send_messages', ...AREA_CAPABILITY_KEYS,
];

// path-prefix → area capability. The generic proxy resolves each request's path
// to an area and checks that area's capability before forwarding. Anything that
// matches no area (or /mcp, /auth — blocked separately) is denied: default-deny.
const PROXY_AREAS = [
  { cap: 'area_contacts',   label: 'Contacts & tags',     test: /^\/(contacts|saved-contacts|contact|contact-names|categories|tags|team-members|numbers)(\/|$|\?)/ },
  // Conversation content. ⚠ This area carries SEND (`POST /messages/send`), so
  // the read-only surfaces grouped with it below inherit a heavier grant than
  // they need. Accepted deliberately rather than unnoticed: they are message
  // content and belong nowhere else, and giving each read-only feature its own
  // switch is how the capability list became unreadable the first time.
  //
  //   /agent-conversation — pause an AI agent on one chat, or hand it back. It
  //                        reaches nobody and changes no configuration; it
  //                        decides whether a bot or a person answers next.
  //
  // Both were absent entirely, and PROXY_AREAS is default-deny, so both were
  // unreachable over MCP.
  { cap: 'area_messaging',  label: 'Messages & conversations', test: /^\/(messages|agent-conversation)(\/|$|\?)/ },
  // /broadcast-series = a REPEATING broadcast (migration 105). It shipped with
  // no entry here at all, and PROXY_AREAS is default-deny, so the whole feature
  // was unreachable over MCP — the rule this file states ("a new route file
  // needs a PROXY_AREAS entry or MCP clients cannot reach it") going unapplied
  // to the route that most needed it. It belongs beside /broadcasts: a series
  // creates real broadcasts on a timer, which is the same reach at the same
  // tier, and separating them would let one be granted without the other while
  // reading as the same capability.
  { cap: 'area_broadcasts', label: 'Broadcasts & content', test: /^\/(broadcasts|broadcast-series|templates|media-library|media)(\/|$|\?)/ },
  { cap: 'area_automations', label: 'Automations',        test: /^\/(chatbots|automations|executions)(\/|$|\?)/ },
  { cap: 'area_admin',      label: 'Admin (users, WA accounts, integrations)', test: /^\/(users|whatsapp-accounts|integrations|ai-models|workflow-agents)(\/|$|\?)/ },
  // Message costs are REPORTING — they show what Meta charged, and cannot move
  // money or reach a customer. Its mutations only edit fallback rates and
  // trigger a re-read, so it belongs with the other read surfaces rather than
  // at admin tier.
  { cap: 'area_insights',   label: 'Dashboard & logs',    test: /^\/(dashboard|webhook-history|message-costs)(\/|$|\?)/ },
  // /entity-fields = the field registry behind the Leads table /
  // Transactions (reads for anyone with the cap; mutations are adminOnly on
  // the route itself, and the proxy calls as admin — hence leads-tier, not
  // admin-tier: changing field labels/visibility moves no money and leaks no
  // credentials).
  { cap: 'area_leads',      label: 'Leads & funnel',      test: /^\/(leads|funnel|entity-fields|follow-ups|my-list)(\/|$|\?)/ },
  { cap: 'area_resources',  label: 'Resources & triggers', test: /^\/(resources|trigger-library|trigger-test)(\/|$|\?)/ },
  // `/products` is the canonical path since the Courses -> Products rename;
  // `/courses` stays matched because the backend still answers on it, and a
  // path the proxy does not cover is REFUSED (PROXY_AREAS is default-deny).
  { cap: 'area_courses',    label: 'Products', test: /^\/(products|courses)(\/|$|\?)/ },
  { cap: 'area_payments',   label: 'Sales & students', test: /^\/(students)(\/|$|\?)/ },
  // Social (the ported ForgeSocial sub-app, mounted at /api/social). Its
  // credential, settings, user and MCP-key surfaces are carved out FIRST so the
  // broad /social rule below can never reach them — first-match-wins.
  { cap: 'area_admin',      label: 'Admin (users, WA accounts, integrations)', test: /^\/social\/(credentials|settings|integrations|users|mcp|openrouter|backfill|sync)(\/|$|\?)/ },
  { cap: 'area_social',     label: 'Social (Instagram)', test: /^\/social(\/|$|\?)/ },
];

// Throw a {status,message} error the route handlers map to an HTTP code and the
// MCP transports surface as the tool error text.
function svcErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/* --------------------------- tables + settings --------------------------- */

// Self-healing table creation (mirrors migration 053_mcp.sql).
async function ensureMcpTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.mcp_api_keys (
      id           BIGSERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      key_last4    TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
      last_used_at TIMESTAMPTZ,
      created_by   BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.mcp_settings (
      id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      master_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      capabilities   JSONB NOT NULL DEFAULT '{"discovery":true,"create_agent":true,"update_agent":true,"manage_tools":true,"delete":true}'::jsonb,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`INSERT INTO coexistence.mcp_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

  // Mirrors migration 099_mcp_tool_categories.sql. Named tools are gated by
  // CATEGORY now (see services/mcpCatalog.js); `capabilities` survives because
  // it still scopes which internal API paths the forgechat_request proxy may
  // reach (PROXY_AREAS) — the one job the area caps were designed for.
  await pool.query(`ALTER TABLE coexistence.mcp_settings ADD COLUMN IF NOT EXISTS categories JSONB`);

  // Seed the per-category switches ONCE from the capabilities that were in
  // force before category gating existed, so an already-connected MCP client
  // behaves identically the moment this deploys.
  //
  // Guarded on `categories IS NULL` ("never seeded"), NOT on "is it empty".
  // An empty-object guard would re-seed on every boot and silently switch a
  // category back ON that an admin had deliberately switched OFF. The UPDATE
  // repeats the IS NULL predicate so two backends booting at once cannot both
  // seed it.
  const { rows: cur } = await pool.query(
    'SELECT capabilities, categories FROM coexistence.mcp_settings WHERE id = 1',
  );
  if (cur[0] && cur[0].categories == null) {
    const seeded = mcpCatalog.seedCategories(cur[0].capabilities || {});
    await pool.query(
      'UPDATE coexistence.mcp_settings SET categories = $1 WHERE id = 1 AND categories IS NULL',
      [JSON.stringify(seeded)],
    );
  }
}

async function loadSettings() {
  const { rows } = await pool.query(
    'SELECT master_enabled, capabilities, categories FROM coexistence.mcp_settings WHERE id = 1',
  );
  const r = rows[0] || { master_enabled: false, capabilities: {}, categories: {} };
  return {
    masterEnabled: !!r.master_enabled,
    capabilities: r.capabilities || {},
    // normalizeCategories drops unknown keys and coerces to strict booleans, so
    // a category added by a future deploy reads as OFF until an admin enables
    // it rather than inheriting a stray truthy value.
    categories: mcpCatalog.normalizeCategories(r.categories || {}),
  };
}

// Validate a raw bearer key. Returns { capabilities, categories, keyId } on
// success. Throws { status, message } on any failure so callers map to HTTP
// codes.
async function validateKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) { const e = new Error('Missing API key'); e.status = 401; throw e; }
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.mcp_api_keys WHERE key_hash = $1',
    [hashApiKey(key)],
  );
  const row = rows[0];
  if (!row || !row.is_enabled) { const e = new Error('Invalid or disabled API key'); e.status = 401; throw e; }
  const settings = await loadSettings();
  if (!settings.masterEnabled) { const e = new Error('MCP access is disabled'); e.status = 403; throw e; }
  pool.query('UPDATE coexistence.mcp_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
  return { keyId: row.id, capabilities: settings.capabilities, categories: settings.categories };
}

/* ------------------------------ discovery ------------------------------- */

async function listWaAccounts() {
  const { rows } = await pool.query(
    `SELECT id, display_name, label, display_phone_number, is_active, is_default
       FROM coexistence.whatsapp_accounts
      ORDER BY is_default DESC, COALESCE(NULLIF(btrim(label), ''), display_name)`,
  );
  return rows.map(r => ({
    id: r.id,
    // The label (migration 133) is what people call the number in the app.
    displayName: (r.label && r.label.trim()) || r.display_name,
    label: (r.label && r.label.trim()) || null,
    accountName: r.display_name,
    phoneNumber: r.display_phone_number,
    isActive: r.is_active,
    isDefault: r.is_default,
  }));
}

async function listModels() {
  const { rows } = await pool.query(
    `SELECT id, provider, label FROM coexistence.ai_models ORDER BY created_at DESC`,
  );
  return rows
    .filter(r => MODEL_CATALOG[r.provider])
    .map(r => ({
      aiModelId: r.id,
      provider: r.provider,
      providerLabel: PROVIDER_LABELS[r.provider] || r.provider,
      label: r.label,
      models: MODEL_CATALOG[r.provider],
    }));
}

function searchSpreadsheets({ q = '', pageSize = 50 } = {}) {
  return googleClient.driveListSpreadsheets({ q, pageSize: Math.max(1, Math.min(100, pageSize)) })
    .then(spreadsheets => ({ spreadsheets }));
}

function listSheetTabs(spreadsheetId) {
  return googleClient.sheetsGetSpreadsheet(spreadsheetId);
}

// Read actual cell values from a tab so the assistant can see the real header
// row (and a few sample rows) — needed to map an agent's Sheets logging to the
// right columns. listSheetTabs only returns metadata (tab names/dimensions),
// not contents, so this fills that gap. With no `range`, returns the tab's
// header + up to maxRows data rows; pass an A1 `range` (e.g. "A1:Z1") to narrow.
async function readSheetValues({ spreadsheetId, tab, range, maxRows } = {}) {
  if (!spreadsheetId) { const e = new Error('spreadsheetId is required (from search_spreadsheets).'); e.status = 400; throw e; }
  const cap = Math.max(1, Math.min(500, parseInt(maxRows || 50, 10)));
  if (range) {
    const a1 = range.includes('!') ? range : `${tab ? `${tab}!` : ''}${range}`;
    const out = await googleClient.sheetsReadRange({ spreadsheetId, range: a1 });
    const rows = out.rows || [];
    return { spreadsheetId, tab: tab || null, range: out.range, headers: rows[0] || [], rows: rows.slice(1, cap + 1), rowCount: rows.length };
  }
  if (!tab) { const e = new Error('tab is required (the tab name from list_sheet_tabs) when no range is given.'); e.status = 400; throw e; }
  const out = await googleClient.sheetsGetTabPreview(spreadsheetId, tab, { rows: cap });
  return { spreadsheetId, tab, range: out.range, headers: out.headers || [], rows: out.rows || [], rowCount: (out.rows || []).length + ((out.headers || []).length ? 1 : 0) };
}

async function listMedia(type, name) {
  const { rows } = await pool.query(
    `SELECT id, name, original_name, mime_type, media_type
       FROM coexistence.media_library
      WHERE ($1::text IS NULL OR media_type = $1)
        AND ($2::text IS NULL OR name ILIKE $2 OR original_name ILIKE $2)
      ORDER BY uploaded_at DESC LIMIT 200`,
    [type || null, name ? `%${name}%` : null],
  );
  return rows.map(r => ({ id: r.id, name: r.name || r.original_name, mimeType: r.mime_type, mediaType: r.media_type }));
}

async function listTemplates(waAccountId) {
  const waId = waAccountId != null && waAccountId !== '' ? parseInt(waAccountId, 10) : null;
  const { rows } = await pool.query(
    `SELECT id, name, language, status, category, whatsapp_account_id
       FROM coexistence.message_templates
      WHERE ($1::bigint IS NULL OR whatsapp_account_id = $1)
      ORDER BY name`,
    [waId],
  );
  return rows.map(r => ({
    id: r.id, name: r.name, language: r.language, status: r.status,
    category: r.category, waAccountId: r.whatsapp_account_id,
  }));
}

async function getTemplate(id) {
  const { rows } = await pool.query(
    `SELECT id, name, language, status, category, whatsapp_account_id,
            header_type, header_text, body, footer, buttons, samples
       FROM coexistence.message_templates WHERE id = $1`,
    [parseInt(id, 10)],
  );
  if (!rows[0]) { const e = new Error('Template not found'); e.status = 404; throw e; }
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    language: r.language,
    status: r.status,
    category: r.category,
    waAccountId: r.whatsapp_account_id,
    header: r.header_type
      ? { type: r.header_type, text: r.header_text || null }
      : null,
    body: r.body,
    footer: r.footer || null,
    buttons: r.buttons || [],
    samples: r.samples || {},
  };
}

/* --------------------- conversations: read + reply ---------------------- */

// 24h-window status derived from the customer's LAST INBOUND message.
// `open` → free-form text can be sent; otherwise an approved template is required.
function windowFromLastIncoming(lastIncomingAt) {
  if (!lastIncomingAt) return { open: false, secondsRemaining: 0, expiresAt: null };
  const last = new Date(lastIncomingAt).getTime();
  const expires = last + SERVICE_WINDOW_SECONDS * 1000;
  const remaining = Math.max(0, Math.round((expires - Date.now()) / 1000));
  return { open: remaining > 0, secondsRemaining: remaining, expiresAt: new Date(expires).toISOString() };
}

// List recent conversations across all business numbers (or one via waNumber).
// Each row carries the business `waNumber` it lives on + the 24h window status,
// so the assistant knows which number to reply from and whether free-form text
// is allowed before composing a reply.
async function listConversations({ waNumber, search, limit } = {}) {
  const cap = Math.max(1, Math.min(200, parseInt(limit || 50, 10)));
  const params = [];
  const conds = [`ch.message_type NOT IN ('status','reaction')`];
  if (waNumber) { params.push(String(waNumber).replace(/\D/g, '')); conds.push(`ch.wa_number = $${params.length}`); }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    conds.push(`(ch.contact_number ILIKE $${params.length} OR COALESCE(c.name, c.profile_name) ILIKE $${params.length})`);
  }
  params.push(cap);
  const { rows } = await pool.query(
    `SELECT
        ch.wa_number,
        ch.contact_number,
        COALESCE(c.name, c.profile_name) AS name,
        MAX(ch.timestamp) AS last_message_time,
        MAX(ch.timestamp) FILTER (WHERE ch.direction = 'incoming') AS last_incoming_time,
        COUNT(*) FILTER (
          WHERE ch.direction = 'incoming'
            AND ch.timestamp > COALESCE(cr.last_read_at, 'epoch'::timestamptz)
        ) AS unread_count,
        (SELECT COALESCE(NULLIF(ch2.message_body, ''), '[' || ch2.message_type || ']')
           FROM coexistence.chat_history ch2
          WHERE ch2.wa_number = ch.wa_number AND ch2.contact_number = ch.contact_number
            AND ch2.message_type NOT IN ('status','reaction')
          ORDER BY ch2.timestamp DESC LIMIT 1) AS last_message
      FROM coexistence.chat_history ch
      LEFT JOIN coexistence.contacts c
        ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
      LEFT JOIN coexistence.conversation_reads cr
        ON cr.wa_number = ch.wa_number AND cr.contact_number = ch.contact_number
      WHERE ${conds.join(' AND ')}
      GROUP BY ch.wa_number, ch.contact_number, c.name, c.profile_name, cr.last_read_at
      ORDER BY last_message_time DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(r => ({
    waNumber: r.wa_number,
    contactNumber: r.contact_number,
    name: r.name || null,
    lastMessage: r.last_message || null,
    lastMessageAt: r.last_message_time,
    unreadCount: Number(r.unread_count) || 0,
    window: windowFromLastIncoming(r.last_incoming_time),
  }));
}

// Full message history for one conversation (newest-last), plus the live 24h
// window status so the assistant can decide text vs template before replying.
async function getChatHistory({ waNumber, contactNumber, limit, before } = {}) {
  if (!waNumber) throw svcErr(400, 'waNumber (the business number) is required.');
  if (!contactNumber) throw svcErr(400, 'contactNumber (the customer number) is required.');
  const wa = String(waNumber).replace(/\D/g, '');
  const contact = String(contactNumber).replace(/\D/g, '');
  const cap = Math.max(1, Math.min(200, parseInt(limit || 50, 10)));
  const params = [wa, contact];
  let beforeClause = '';
  if (before) { params.push(before); beforeClause = `AND ch.timestamp < $${params.length}`; }
  params.push(cap);
  const { rows } = await pool.query(
    `SELECT message_id, direction, message_type, message_body, status, timestamp, media_filename,
            -- A voice note's stored transcript (transcribed in Chats or by an
            -- agent). Read from the shared cache only: nothing is transcribed here.
            (SELECT a.text FROM coexistence.chat_message_artifacts a
              WHERE a.source = 'chat' AND a.message_key = ch.message_id
                AND a.kind = 'transcript' AND a.status = 'ok' AND a.text <> ''
              LIMIT 1) AS transcript
       FROM coexistence.chat_history ch
      WHERE ch.wa_number = $1 AND ch.contact_number = $2
        AND ch.message_type NOT IN ('status','reaction') ${beforeClause}
      ORDER BY ch.timestamp DESC
      LIMIT $${params.length}`,
    params,
  );
  const { rows: inc } = await pool.query(
    `SELECT MAX(timestamp) AS last_incoming
       FROM coexistence.chat_history
      WHERE wa_number = $1 AND contact_number = $2 AND direction = 'incoming'`,
    [wa, contact],
  );
  const messages = rows.reverse().map(r => ({
    messageId: r.message_id,
    direction: r.direction,
    type: r.message_type,
    text: r.message_body || (r.media_filename ? `[${r.message_type}: ${r.media_filename}]` : `[${r.message_type}]`),
    transcript: r.transcript || undefined,
    status: r.status,
    at: r.timestamp,
  }));
  return { waNumber: wa, contactNumber: contact, window: windowFromLastIncoming(inc[0]?.last_incoming), messages };
}

// Send a free-form TEXT reply. Reuses the real outbound pipeline (optimistic
// row + BullMQ → Meta). Enforces the 24h window; outside it, throws a clear
// OUTSIDE_WINDOW error directing the caller to send_template.
async function sendTextMessage({ fromNumber, toNumber, text } = {}) {
  if (!fromNumber) throw svcErr(400, 'fromNumber (the business WhatsApp number to send from) is required. Call list_wa_accounts or list_conversations and ask the user which number to use.');
  if (!toNumber) throw svcErr(400, 'toNumber (the customer number) is required.');
  const body = String(text || '').trim();
  if (!body) throw svcErr(400, 'text is required.');

  const { account, error } = await resolveAccount({ fromPhoneNumber: String(fromNumber).replace(/\D/g, '') });
  if (error) throw svcErr(400, error);

  const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: String(toNumber).replace(/\D/g, '') });
  if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
    throw svcErr(409, 'Outside the 24-hour customer-service window — the customer has not messaged in the last 24 hours, so free-form text cannot be delivered. Use send_template with an approved template instead.', 'OUTSIDE_WINDOW');
  }

  const localId = await insertPendingRow({ account, toNumber, messageType: 'text', messageBody: body });
  await enqueueSend({
    kind: 'text',
    accountId: account.id,
    to: String(toNumber).replace(/\D/g, ''),
    localMessageId: localId,
    payload: { body, previewUrl: /https?:\/\/\S+/i.test(body) },
  });
  return { ok: true, messageId: localId, status: 'sending', fromNumber: account.displayPhoneNumber, toNumber };
}

// Build a Meta template `components` array from LITERAL variable values (the
// MCP caller supplies the actual text, not field-key mappings).
function buildLiteralTemplateComponents(template, variables, headerMediaId) {
  const components = [];
  const ht = String(template.header_type || 'NONE').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht) && headerMediaId) {
    const key = ht.toLowerCase();
    components.push({ type: 'header', parameters: [{ type: key, [key]: { id: headerMediaId } }] });
  }
  const vals = Array.isArray(variables)
    ? variables
    : Object.keys(variables || {}).sort((a, b) => (+a) - (+b)).map(k => variables[k]);
  if (vals.length > 0) {
    components.push({ type: 'body', parameters: vals.map(v => ({ type: 'text', text: String(v ?? ' ') || ' ' })) });
  }
  return components;
}

// Send an APPROVED TEMPLATE. Works regardless of the 24h window (proactive
// outreach). The template must belong to the WABA of `fromNumber`.
async function sendTemplateMessage({ fromNumber, toNumber, templateId, variables } = {}) {
  if (!fromNumber) throw svcErr(400, 'fromNumber (the business WhatsApp number to send from) is required. Call list_wa_accounts and ask the user which number to use.');
  if (!toNumber) throw svcErr(400, 'toNumber (the customer number) is required.');
  if (!templateId) throw svcErr(400, 'templateId is required. Call list_templates (then get_template to confirm content) first.');

  const { rows } = await pool.query(
    `SELECT id, name, language, status, whatsapp_account_id, template_type,
            header_type, header_text, header_media_library_id, body, footer, buttons
       FROM coexistence.message_templates WHERE id = $1`,
    [parseInt(templateId, 10)],
  );
  const template = rows[0];
  if (!template) throw svcErr(404, 'Template not found.');
  if (String(template.status).toUpperCase() !== 'APPROVED') {
    throw svcErr(400, `Template "${template.name}" is ${template.status}, not APPROVED — Meta will reject it. Pick an approved template.`);
  }
  if (String(template.template_type || '').toUpperCase() === 'CAROUSEL') {
    throw svcErr(400, 'Carousel templates cannot be sent via MCP yet. Use a standard template or send the carousel from a broadcast.');
  }

  const { account, error } = await resolveAccount({ fromPhoneNumber: String(fromNumber).replace(/\D/g, '') });
  if (error) throw svcErr(400, error);

  // WABA-match guard: a template only exists on its approved account (Meta #132001).
  if (template.whatsapp_account_id != null && Number(template.whatsapp_account_id) !== Number(account.id)) {
    throw svcErr(400, `Template "${template.name}" belongs to a different WhatsApp account and cannot be sent from ${account.displayPhoneNumber}. Choose a template approved on this number (list_templates?waAccountId=${account.id}).`);
  }

  // Resolve a media-header template's image to a per-account Meta media id.
  let headerMediaId = null;
  const ht = String(template.header_type || 'NONE').toUpperCase();
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht)) {
    if (!template.header_media_library_id) {
      throw svcErr(400, `Template "${template.name}" has a ${ht} header but no stored media — it can't be sent programmatically. Re-save the template with a Media Library image.`);
    }
    const { resolveMetaMediaId } = require('../routes/mediaLibrary');
    headerMediaId = await resolveMetaMediaId(template.header_media_library_id, account.id);
    if (!headerMediaId) throw svcErr(400, 'Could not resolve the template header media for this account.');
  }

  const components = buildLiteralTemplateComponents(template, variables, headerMediaId);
  // Show the resolved text in the Chats bubble (not raw {{1}}).
  const vals = Array.isArray(variables) ? variables : Object.keys(variables || {}).sort((a, b) => (+a) - (+b)).map(k => variables[k]);
  const resolvedBody = String(template.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => vals[(+n) - 1] != null ? String(vals[(+n) - 1]) : `{{${n}}}`);

  const localId = await insertPendingRow({
    account,
    toNumber,
    messageType: 'template',
    messageBody: resolvedBody || `Template: ${template.name}`,
    templateId: template.id, sendOrigin: 'mcp',
    templateMeta: {
      header_type: template.header_type || 'NONE',
      header_text: template.header_text || null,
      header_media_library_id: template.header_media_library_id || null,
      footer: template.footer || null,
      buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
    },
  });
  await enqueueSend({
    kind: 'template',
    accountId: account.id,
    to: String(toNumber).replace(/\D/g, ''),
    localMessageId: localId,
    payload: { name: template.name, languageCode: template.language || 'en', components },
  });
  return { ok: true, messageId: localId, status: 'sending', template: template.name, fromNumber: account.displayPhoneNumber, toNumber };
}

// Send a free-form MEDIA message by public URL (document/image/video/audio).
// `link` must be a publicly-fetchable URL (Meta downloads it). Subject to the
// 24h window like any free-form send. Added for outbound bridges so report
// PDFs etc. deliver through this number.
// Extension → mime fallback when an inline fileBase64 arrives without a mimeType.
const EXT_MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp', '3gpp': 'video/3gpp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac', amr: 'audio/amr', m4a: 'audio/mp4',
};

function mediaKindFromMime(mime) {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// WhatsApp accepts up to 5MB images / 16MB audio+video / 100MB documents, but
// inline base64 is parsed wholly into the (256MB) backend, so cap conservatively.
// Larger files should go via the Media Library or a public link.
const MEDIA_BYTE_CAPS = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 25 * 1024 * 1024 };

// Send a document / image / video / audio into an open 24h conversation.
// Accepts ONE of three sources:
//   - fileBase64 (+ filename, optional mimeType) — a file uploaded inline in the
//     MCP client (e.g. a PDF dropped into Claude); uploaded to Meta here.
//   - mediaLibraryId — an item already in the ForgeChat Media Library.
//   - link — a public https URL to the file.
async function sendMediaMessage({ fromNumber, toNumber, type, link, fileBase64, filename, mimeType, mediaLibraryId, caption } = {}) {
  if (!fromNumber) throw svcErr(400, 'fromNumber is required.');
  if (!toNumber) throw svcErr(400, 'toNumber is required.');

  const haveFile = !!fileBase64;
  const haveLib = mediaLibraryId != null && mediaLibraryId !== '';
  const haveLink = !!link;
  const sources = [haveFile, haveLib, haveLink].filter(Boolean).length;
  if (sources === 0) throw svcErr(400, 'Provide one of: fileBase64 (an uploaded file), mediaLibraryId, or link.');
  if (sources > 1) throw svcErr(400, 'Provide only ONE of fileBase64, mediaLibraryId, or link.');

  const { account, error } = await resolveAccount({ fromPhoneNumber: String(fromNumber).replace(/\D/g, '') });
  if (error) throw svcErr(400, error);

  const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: String(toNumber).replace(/\D/g, '') });
  if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
    throw svcErr(409, 'Outside the 24-hour customer-service window — free-form media cannot be delivered. Use send_template for proactive messages.', 'OUTSIDE_WINDOW');
  }

  let mediaId = null;
  let resolvedLink = null;
  let mediaUrlForRow = null;
  let t = type ? String(type).toLowerCase() : null;

  if (haveFile) {
    const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
    const mime = mimeType || EXT_MIME[ext] || 'application/octet-stream';
    if (!t) t = mediaKindFromMime(mime);
    let buffer;
    try { buffer = Buffer.from(String(fileBase64).replace(/^data:[^;]+;base64,/, ''), 'base64'); }
    catch { throw svcErr(400, 'fileBase64 is not valid base64.'); }
    if (!buffer.length) throw svcErr(400, 'fileBase64 decoded to an empty file.');
    const cap = MEDIA_BYTE_CAPS[t] || MEDIA_BYTE_CAPS.document;
    if (buffer.length > cap) {
      throw svcErr(413, `File is ${(buffer.length / 1048576).toFixed(1)}MB — over the ${Math.round(cap / 1048576)}MB inline limit for ${t}. For larger files, add it to the Media Library or host it and pass a link.`);
    }
    try {
      const uploaded = await uploadMedia({ accessToken: account.accessToken, phoneNumberId: account.phoneNumberId, buffer, mimeType: mime, filename: filename || `upload.${ext || 'bin'}` });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no media id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      throw svcErr(err.status === 401 ? 401 : 400, err.message || 'Meta media upload failed');
    }
  } else if (haveLib) {
    const { resolveMetaMediaId } = require('../routes/mediaLibrary');
    mediaId = await resolveMetaMediaId(mediaLibraryId, account.id);
    if (!mediaId) throw svcErr(400, `Media Library item ${mediaLibraryId} could not be resolved for this account.`);
    if (!t) {
      const { rows } = await pool.query('SELECT media_type, mime_type FROM coexistence.media_library WHERE id = $1', [mediaLibraryId]);
      t = rows[0]?.media_type || mediaKindFromMime(rows[0]?.mime_type) || 'document';
    }
  } else {
    resolvedLink = link;
    mediaUrlForRow = link;
    if (!t) t = 'document';
  }

  t = String(t || 'document').toLowerCase();
  if (!['document', 'image', 'video', 'audio'].includes(t)) throw svcErr(400, `Unsupported media type "${t}".`);

  const localId = await insertPendingRow({ account, toNumber, messageType: t, messageBody: caption || filename || null, mediaUrl: mediaUrlForRow, mediaMime: mimeType || null });
  await enqueueSend({
    kind: 'media',
    accountId: account.id,
    to: String(toNumber).replace(/\D/g, ''),
    localMessageId: localId,
    payload: {
      type: t,
      mediaId: mediaId || undefined,
      link: resolvedLink || undefined,
      caption: caption || null,
      filename: t === 'document' ? (filename || null) : null,
    },
  });
  return { ok: true, messageId: localId, status: 'sending', type: t, via: haveFile ? 'upload' : haveLib ? 'media_library' : 'link', fromNumber: account.displayPhoneNumber, toNumber };
}

// Send a free-form INTERACTIVE message — the caller passes a ready Meta
// `interactive` object (reply buttons OR a flow). Used by outbound bridges so
// approve/reject buttons and task-create flows can route through this number.
// Subject to the 24h window. The interactive payload (incl. button ids) is sent
// verbatim, so round-trip ids are preserved.
async function sendInteractiveMessage({ fromNumber, toNumber, interactive } = {}) {
  if (!fromNumber) throw svcErr(400, 'fromNumber is required.');
  if (!toNumber) throw svcErr(400, 'toNumber is required.');
  if (!interactive || typeof interactive !== 'object') throw svcErr(400, 'interactive (a Meta interactive object) is required.');

  const { account, error } = await resolveAccount({ fromPhoneNumber: String(fromNumber).replace(/\D/g, '') });
  if (error) throw svcErr(400, error);

  const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: String(toNumber).replace(/\D/g, '') });
  if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
    throw svcErr(409, 'Outside the 24-hour customer-service window — interactive messages cannot be delivered.', 'OUTSIDE_WINDOW');
  }

  const bodyText = (interactive.body && interactive.body.text) ? String(interactive.body.text) : '[interactive]';
  const localId = await insertPendingRow({ account, toNumber, messageType: 'interactive', messageBody: bodyText });
  await enqueueSend({
    kind: 'interactive',
    accountId: account.id,
    to: String(toNumber).replace(/\D/g, ''),
    localMessageId: localId,
    payload: { interactive },
  });
  return { ok: true, messageId: localId, status: 'sending', fromNumber: account.displayPhoneNumber, toNumber };
}

/* ----------------- generic admin proxy (full access) ------------------- */

const PORT = parseInt(process.env.PORT || '3001', 10);

// A designated admin identity to authorize proxied requests (cached). Real
// existing routes run their own validation + RBAC; we authenticate as admin so
// the proxy can reach everything an admin can in the app.
let _proxyAdmin = null;
async function proxyAdmin() {
  if (_proxyAdmin) return _proxyAdmin;
  const { rows } = await pool.query(
    `SELECT id, username, display_name FROM coexistence.forgecrm_users
      WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1`,
  );
  if (!rows[0]) throw svcErr(500, 'No active admin user is available to authorize the MCP proxy.');
  _proxyAdmin = rows[0];
  return _proxyAdmin;
}

function mintAdminToken(user) {
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../util/session'); // one definition; auth.js verifies with the same
  return jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: 'admin' },
    JWT_SECRET, { expiresIn: '5m' },
  );
}

function resolveArea(path) {
  return PROXY_AREAS.find(a => a.test.test(path)) || null;
}

// Call an internal /api route as admin over localhost — the shared primitive
// behind both the generic proxy AND the dedicated config tools (create_template,
// create_automation, create_template, …). Reuses the real Express routes so
// their validation/RBAC/SSE/queues all still apply; no logic is duplicated.
// NO capability gating here — the caller (proxyRequest, or a capability-gated
// dedicated tool) is responsible for authorization.
async function internalApiCall({ method, path, query, body } = {}) {
  let p = String(path || '').trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/^\/api(?=\/)/, ''); // tolerate a leading /api
  const m = String(method || 'GET').toUpperCase();

  let qs = '';
  if (query && typeof query === 'object') {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null) u.set(k, String(v));
    qs = u.toString();
  }

  const token = mintAdminToken(await proxyAdmin());
  const { COOKIE_NAME } = require('../auth');
  const url = `http://127.0.0.1:${PORT}/api${p}${qs ? `${p.includes('?') ? '&' : '?'}${qs}` : ''}`;
  const init = { method: m, headers: { Cookie: `${COOKIE_NAME}=${token}` } };
  if (m !== 'GET' && body != null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const txt = await res.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: res.status, ok: res.ok, body: data };
}

// Call an internal route and either return its parsed body or throw the route's
// own {error} as a clean svcErr — used by the dedicated config tools so a
// validation failure surfaces as the tool error text, not a raw {status,body}.
async function internalApiOrThrow({ method, path, query, body, failMsg } = {}) {
  const out = await internalApiCall({ method, path, query, body });
  if (!out.ok) {
    const msg = (out.body && (out.body.error || out.body.message)) || failMsg || `Request failed (${out.status})`;
    throw svcErr(out.status || 500, String(msg));
  }
  return out.body;
}

// Forward an arbitrary internal API call as admin, gated by the request path's
// area capability. Reuses the real Express routes (so validation, RBAC, SSE,
// queues all still apply) by calling the backend over localhost with a minted
// admin cookie.
async function proxyRequest({ method, path, query, body } = {}, capabilities = {}) {
  let p = String(path || '').trim();
  if (!p) throw svcErr(400, 'path is required, e.g. "/contacts?waNumber=...".');
  if (!p.startsWith('/')) p = '/' + p;

  // SECURITY: gate on the path the SERVER will actually receive, not the one the
  // caller typed. internalApiCall hands this string to fetch(), and the WHATWG
  // URL parser removes dot-segments — so "/leads/../users" would be gated
  // as area_leads and then delivered to /api/users with an admin cookie,
  // defeating every area capability (and the /mcp + /auth block). %2e%2e
  // normalises identically. Canonicalise FIRST, then gate on the result.
  {
    const u = new URL(`http://127.0.0.1${p}`);
    p = u.pathname + (u.search || '');
    // Belt and braces: `..%2f` survives the parser, so refuse any leftover
    // traversal rather than trusting a single normalisation pass.
    if (/(^|\/)\.\.(\/|$)/.test(u.pathname) || /%2e%2e|%2f/i.test(p)) {
      throw svcErr(400, 'path must not contain path-traversal segments.');
    }
  }
  p = p.replace(/^\/api(?=\/|$)/, ''); // tolerate a leading /api

  // Never expose MCP self-administration or the auth/login surface via the proxy.
  if (/^\/(mcp|auth)(\/|$|\?)/.test(p)) throw svcErr(403, 'This path is not accessible through the MCP proxy.');

  const area = resolveArea(p);
  if (!area) throw svcErr(403, `No MCP area covers "${p}". Call list_endpoints to see what is callable.`);
  if (capabilities[area.cap] !== true) {
    throw svcErr(403, `The "${area.label}" area is disabled for MCP access. Enable it in Admin Settings → MCP Tools.`);
  }

  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw svcErr(400, `Unsupported method "${m}".`);

  return internalApiCall({ method: m, path: p, query, body });
}

// A compact catalog of the main callable endpoints per area, filtered to the
// areas this key has enabled — so the assistant knows what forgechat_request
// can reach. Not exhaustive; the proxy can reach any route in an enabled area.
const ENDPOINT_CATALOG = {
  area_contacts: [
    'GET /contacts?waNumber=&timeRange=30d — saved contacts for a number',
    'GET /saved-contacts?all=true — every saved contact (deduped)',
    'POST /contacts/save {waNumber,contactNumber,name,tags,customFields,assignedUserId}',
    'POST /contacts/import (sheet import is multipart — prefer send_bulk_message for lists)',
    'GET /tags · POST /tags · GET /categories · GET /team-members',
  ],
  area_messaging: [
    'GET /messages?waNumber=&contactNumber= — chat history',
    'POST /messages/send {fromNumber,toNumber,text} — also see send_message tool',
    'GET /agent-conversation?waNumber=&contactNumber= — is an AI agent paused on this chat, and who paused it',
    'POST /agent-conversation/pause · /resume {waNumber,contactNumber} — take a chat off the bot for a person, or hand it back',
  ],
  area_broadcasts: [
    'GET /broadcasts · POST /broadcasts {from_number,recipient_numbers,template_id,message_type,variable_mapping}',
    'POST /broadcasts/:id/send — enqueue to saved-contact audience',
    'GET /templates · GET /media-library — content for broadcasts',
    'For an UPLOADED LIST use the send_bulk_message tool (one call).',
    'POST /broadcasts {..., scheduled_at:"<ISO instant>"} — schedule one send for later; a past time is refused',
    'GET /broadcast-series · POST /broadcast-series — a REPEATING broadcast. Its audience is a RULE re-resolved on every run, not a frozen list, so it does not re-message the same people. It always starts PAUSED, an end condition is required.',
    'PUT /broadcast-series/:id · PUT /broadcast-series/:id/active {active} — start or pause it · POST /broadcast-series/:id/run — fire one run now',
    'POST /broadcast-series/preview — who the rule matches right now, without sending',
  ],
  area_automations: [
    'Prefer the named tools: list_automations, create_automation, validate_automation, update_automation, get_automation_runs.',
    'GET /chatbots · GET /chatbots/:id — the full nodes/edges graph',
    'POST /chatbots/validate {config} — the SAME check the activation gate runs; use it before saving an edited graph',
    'PUT /chatbots/:id {name,description,config,status} — status:"active" runs the activation check and 409s with blocking[] if the flow would be broken',
    'GET /chatbots/:id/executions?status=&limit= · GET /executions/:id — what a flow actually did, step by step',
  ],
  area_admin: [
    'GET /users · POST /users (admin) — SENSITIVE',
    'GET /whatsapp-accounts · GET /ai-models · GET /integrations — SENSITIVE',
    'GET /workflow-agents — workflow agents (scheduled/event-driven Claude agents that read leads, chats and sales and propose actions)',
    'GET /workflow-agents/:id · GET /workflow-agents/:id/runs · GET /workflow-agents/runs/:rid · GET /workflow-agents/runs/:rid/steps — config, run history, full trace',
    'POST /workflow-agents/:id/run {dry_run,pretend_date,config_override} — SENSITIVE: a live run spends Claude credits and files approval requests',
    'GET /workflow-agents/actions?status=pending · POST /workflow-agents/actions/:aid/approve · /reject — SENSITIVE: approving EXECUTES the action (tags, stage moves, WhatsApp sends)',
    'Workflow Agents sit in the admin area: runs spend money and approvals change customer-facing state.',
  ],
  area_insights: [
    'GET /dashboard?range=30d · GET /webhook-history',
    'GET /message-costs/overview?from=&to= — total owed to Meta, charged vs free, reconciled against Meta',
    'GET /message-costs/templates?from= — cost + run count per template',
    'GET /message-costs/breakdown?by=category|type|origin|number|pricingType|country',
    'GET /message-costs/trend?from= · GET /message-costs/config · POST /message-costs/sync',
  ],
  area_leads: [
    'GET /leads?stage=&search=&view= — funnel lead list; view=hot (arrived <24h)|my|unassigned|needs-follow-up (also see list_leads tool)',
    'GET /leads/board — Kanban grouped by stage + conversion %',
    'PUT /leads/:id/move {stage} — change funnel stage (also see move_lead_stage tool)',
    'GET /leads/:id/timeline',
    'GET /funnel/config — configured stages (ordered) + sources · GET /funnel/chart?source=&from=&to= — per-stage counts',
    'POST/PUT/DELETE /funnel/stages · PUT /funnel/stages/reorder · POST/PUT/DELETE /funnel/sources — funnel config (admin)',
    'GET /follow-ups?from=&to=&status=open|done|cancelled|any — the follow-up calendar (also see list_follow_ups) · POST /follow-ups {waNumber,contactNumber,dueDate,dueTime,note} · PATCH/DELETE /follow-ups/:id · POST /follow-ups/google/sync — mirror to Google Calendar',
    'GET /entity-fields — the field registry for the Leads table / Sales Log / Transactions (system + custom fields, labels, options, visibility) + the {{sale.*}} variable tokens',
    'POST /entity-fields {entity:"lead"|"transaction",label,fieldType,options,showInLeads,showInSales} — add a custom field · PUT /entity-fields/:id — relabel/options/visibility · PUT /entity-fields/reorder {entity,ids} · DELETE /entity-fields/:id (soft; values kept) · POST /entity-fields/:id/restore',
    'Leads list/export also accept ?cf_<field_key>=value filters on registry fields.',
  ],
  area_social: [
    'Prefer the named social_* tools. Paths below are under /social (the Social workspace).',
    'GET /social/overview · GET /social/insights/... · GET /social/posts — analytics and the content library',
    'GET /social/ig-automations · GET /social/ig-automations/meta · POST/PUT/DELETE /social/ig-automations/:id — Instagram automation rules',
    'GET /social/ig-automations/flows · GET /social/ig-automations/flows/:id · POST/PUT/DELETE /social/ig-automations/flows/:id — Instagram flows',
    'GET /social/agents · GET /social/agents/:id · POST/PUT/DELETE /social/agents/:id · POST /social/agents/:id/tools — Social AI agents',
    'Credentials, settings, users, integrations and the Social MCP keys are NOT reachable here — they sit in the admin area.',
  ],
  area_resources: ['GET /resources · GET /trigger-library · POST /trigger-test'],
  area_courses: [
    // A product is anything sold: a course, consulting, a template pack, a
    // webinar. /courses still answers as a deprecated alias of every path here.
    'GET /products — catalog, each with its default price + revenue (also see list_products tool)',
    'GET /products/revenue — sales/payments/revenue per product, + the unattributed bucket (also see get_product_revenue tool)',
    'POST /products {name,description,thumbnailUrl,defaultPrice} · PUT /products/:id · DELETE /products/:id — defaultPrice is in RUPEES and optional (null clears it)',
  ],
  area_payments: [
    'GET /students — enrolled students + course, total paid (₹), installment count, last payment',
    'GET /students/:id/installments — that student\'s payments + total',
    'POST /students {studentName,phone,courseId,amount,paymentDate,source,notes} — enrol a student + first installment',
    'POST /students/:id/installments {amount,paymentDate,courseId,notes} — add a payment installment',
  ],
};
function listEndpoints(capabilities = {}) {
  const out = {};
  for (const a of PROXY_AREAS) {
    out[a.cap] = {
      label: a.label,
      enabled: capabilities[a.cap] === true,
      endpoints: capabilities[a.cap] === true ? (ENDPOINT_CATALOG[a.cap] || []) : ['(area disabled — enable in Admin Settings → MCP Tools)'],
    };
  }
  return {
    note: 'Use forgechat_request { method, path, query, body } to call any endpoint in an ENABLED area. For broadcasting to an uploaded contact list, use send_bulk_message.',
    areas: out,
  };
}

/* ------------- bulk broadcast to an uploaded/ad-hoc list ---------------- */

// Upsert one contact (number + optional name) without clobbering an existing
// CRM name (mirrors POST /contacts/save semantics).
async function upsertContact(client, waNumber, number, name) {
  await client.query(
    `INSERT INTO coexistence.contacts (wa_number, contact_number, name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wa_number, contact_number)
     DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name), updated_at = NOW()`,
    [waNumber, number, name || null],
  );
}

// Broadcast a TEMPLATE (or text) to an explicit list of recipients — the flow
// behind "upload a sheet in Claude → message everyone in it". Builds a real
// broadcast + per-recipient logs (so it shows in the Bulk Message UI with
// delivery stats) and enqueues real sends. Supports per-recipient template
// variables straight from the sheet (variables[] in row order).
async function sendBulkMessage({ fromNumber, name, messageType, templateId, text, recipients, saveContacts } = {}) {
  if (!fromNumber) throw svcErr(400, 'fromNumber (the business WhatsApp number to send from) is required. Call list_wa_accounts and ask the user which number.');
  if (!Array.isArray(recipients) || recipients.length === 0) throw svcErr(400, 'recipients[] is required — the list of people from the uploaded sheet.');
  if (recipients.length > 5000) throw svcErr(400, 'Too many recipients (max 5000 per bulk send).');

  const msgType = messageType === 'text' ? 'text' : 'template';
  const { account, error } = await resolveAccount({ fromPhoneNumber: String(fromNumber).replace(/\D/g, '') });
  if (error) throw svcErr(400, error);

  // Normalize recipients → [{ number, name, variables[] }]
  const norm = recipients.map(r => {
    if (typeof r === 'string' || typeof r === 'number') return { number: String(r).replace(/\D/g, ''), name: null, variables: [] };
    return {
      number: String(r.number || r.contact_number || r.phone || '').replace(/\D/g, ''),
      name: r.name || null,
      variables: Array.isArray(r.variables) ? r.variables.map(v => String(v ?? '')) : [],
    };
  }).filter(r => r.number && r.number.length >= 7);
  if (norm.length === 0) throw svcErr(400, 'No valid recipient phone numbers found in the list.');

  // Template path: load + guard.
  let template = null;
  let headerMediaId = null;
  if (msgType === 'template') {
    if (!templateId) throw svcErr(400, 'templateId is required for a template broadcast. Call list_templates + get_template first.');
    const { rows } = await pool.query(
      `SELECT id, name, language, status, whatsapp_account_id, template_type,
              header_type, header_text, header_media_library_id, body, footer, buttons
         FROM coexistence.message_templates WHERE id = $1`,
      [parseInt(templateId, 10)],
    );
    template = rows[0];
    if (!template) throw svcErr(404, 'Template not found.');
    if (String(template.status).toUpperCase() !== 'APPROVED') throw svcErr(400, `Template "${template.name}" is ${template.status}, not APPROVED.`);
    if (String(template.template_type || '').toUpperCase() === 'CAROUSEL') throw svcErr(400, 'Carousel templates cannot be sent via MCP yet.');
    if (template.whatsapp_account_id != null && Number(template.whatsapp_account_id) !== Number(account.id)) {
      throw svcErr(400, `Template "${template.name}" is not approved on ${account.displayPhoneNumber}. Use list_templates?waAccountId=${account.id}.`);
    }
    const ht = String(template.header_type || 'NONE').toUpperCase();
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht)) {
      if (!template.header_media_library_id) throw svcErr(400, `Template "${template.name}" has a ${ht} header but no stored media — re-save it with a Media Library image.`);
      const { resolveMetaMediaId } = require('../routes/mediaLibrary');
      headerMediaId = await resolveMetaMediaId(template.header_media_library_id, account.id);
      if (!headerMediaId) throw svcErr(400, 'Could not resolve the template header media for this account.');
    }
  } else {
    if (!text || !String(text).trim()) throw svcErr(400, 'text is required for a text broadcast. (Note: free-form text only reaches recipients inside the 24-hour window — for a fresh imported list use a template.)');
  }

  // Create the broadcast record (for UI visibility + delivery stats).
  const { rows: bRows } = await pool.query(
    `INSERT INTO coexistence.broadcasts
       (from_number, recipient_numbers, template_id, status, name, variable_mapping, message_type, body, updated_at)
     VALUES ($1, $2, $3, 'SENDING', $4, '{}'::jsonb, $5, $6, NOW())
     RETURNING id`,
    [account.displayPhoneNumber || String(fromNumber), JSON.stringify(norm.map(r => r.number)),
     msgType === 'template' ? template.id : null, name || 'MCP bulk broadcast', msgType, msgType === 'text' ? String(text) : null],
  );
  const broadcastId = bRows[0].id;

  // Optionally save uploaded people as contacts (so they appear in the CRM).
  if (saveContacts !== false) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of norm) await upsertContact(client, account.displayPhoneNumber || String(fromNumber).replace(/\D/g, ''), r.number, r.name);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); /* non-fatal */ }
    finally { client.release(); }
  }

  let enqueued = 0; let failed = 0;
  for (const r of norm) {
    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
       VALUES ($1, 'BROADCAST', $2, 'PENDING') RETURNING id`,
      [broadcastId, r.number],
    );
    const logId = logRows[0].id;
    try {
      if (msgType === 'template') {
        const components = buildLiteralTemplateComponents(template, r.variables, headerMediaId);
        const resolvedBody = String(template.body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => r.variables[(+n) - 1] != null ? r.variables[(+n) - 1] : `{{${n}}}`);
        const localId = await insertPendingRow({
          account, toNumber: r.number, messageType: 'template',
          messageBody: resolvedBody || `Template: ${template.name}`,
          templateId: template.id, sendOrigin: 'broadcast',
          templateMeta: {
            header_type: template.header_type || 'NONE', header_text: template.header_text || null,
            header_media_library_id: template.header_media_library_id || null,
            footer: template.footer || null, buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
          },
        });
        await enqueueSend({
          kind: 'template', accountId: account.id, to: r.number, localMessageId: localId,
          payload: { name: template.name, languageCode: template.language || 'en', components },
          originRef: { kind: 'broadcast_log', id: logId },
        });
      } else {
        const body = String(text).replace(/\{\{\s*name\s*\}\}/gi, r.name || '').replace(/\{\{\s*(contact\.number|number)\s*\}\}/gi, r.number);
        const localId = await insertPendingRow({ account, toNumber: r.number, messageType: 'text', messageBody: body });
        await enqueueSend({
          kind: 'text', accountId: account.id, to: r.number, localMessageId: localId,
          payload: { body }, originRef: { kind: 'broadcast_log', id: logId },
        });
      }
      enqueued++;
    } catch (jobErr) {
      failed++;
      await pool.query(`UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`, [String(jobErr.message).slice(0, 500), logId]);
    }
  }

  await pool.query(`UPDATE coexistence.broadcasts SET status='SENT', updated_at=NOW() WHERE id=$1`, [broadcastId]);
  return {
    ok: true, broadcastId, total: norm.length, enqueued, failed,
    messageType: msgType, fromNumber: account.displayPhoneNumber,
    note: 'Queued. Track delivery in the Bulk Message page or via GET /broadcasts/' + broadcastId + '.',
  };
}

/* --------------------- leads / funnel dedicated tools -------------------- */
// Thin read (+ one write) helpers over the funnel tables, backing the
// list_leads / move_lead_stage MCP tools. Mirror the query shapes in
// routes/leads.js rather than diverging from them.

const funnelCfg = require('./funnelConfig');

function leadSummaryRow(r) {
  return {
    id: Number(r.id), name: r.name, whatsappNumber: r.whatsapp_number, email: r.email,
    stage: r.stage, source: r.source,
    assignedUserName: r.assigned_user_name || null,
    lastActivityAt: r.last_activity_at, createdAt: r.created_at,
  };
}

// Which business WhatsApp number a lead actually talked to.
//
// `coexistence.leads` has NO account column — a lead is not tied to a number in the
// data model at all. The link only exists in chat_history, which carries both
// `wa_number` (ours) and `contact_number` (theirs). So the scope is expressed as
// "this lead has at least one message on that number".
//
// Numbers are compared on their LAST TEN DIGITS, which is this codebase's existing
// convention and is already indexed (idx_chat_history_key10) — country-code prefixes
// are written inconsistently across the table, so an exact string match silently
// misses rows.
async function resolveWaAccountNumber(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT id, display_phone_number,
            COALESCE(NULLIF(btrim(label), ''), display_name) AS display_name,
            display_name AS account_name
       FROM coexistence.whatsapp_accounts`);
  if (!rows.length) throw svcErr(404, 'No WhatsApp accounts are configured.');
  const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  // id, then exact number, then a unique name match — and REFUSE when a name is
  // ambiguous rather than silently scoping the answer to the wrong business.
  let hit = rows.find((r) => String(r.id) === raw);
  if (!hit && digits.length >= 10) hit = rows.find((r) => last10(r.display_phone_number) === digits.slice(-10));
  // EXACT name before substring. "Acme Academy" is the exact name of one
  // account AND a prefix of "Acme Academy - Sales"; without this, the most
  // natural way to name the main number is rejected as ambiguous.
  // The shown name (label) first, then the underlying account name.
  if (!hit) hit = rows.find((r) => String(r.display_name || '').trim().toLowerCase() === raw.toLowerCase());
  if (!hit) hit = rows.find((r) => String(r.account_name || '').trim().toLowerCase() === raw.toLowerCase());
  if (!hit) {
    const named = rows.filter((r) => String(r.display_name || '').toLowerCase().includes(raw.toLowerCase()));
    if (named.length === 1) [hit] = named;
    else if (named.length > 1) {
      throw svcErr(400, `"${raw}" matches ${named.length} numbers: ${named.map((r) => `${r.display_name} (${r.display_phone_number})`).join(', ')}. Name one exactly.`);
    }
  }
  if (!hit) {
    throw svcErr(404, `No WhatsApp number matches "${raw}". Available: ${rows.map((r) => `${r.display_name} (${r.display_phone_number})`).join(', ')}.`);
  }
  return last10(hit.display_phone_number);
}

async function listLeads({ stage, search, limit, view, waAccount } = {}) {
  const cap = Math.max(1, Math.min(500, parseInt(limit || 50, 10)));
  const params = [];
  const where = [];
  if (waAccount !== undefined && waAccount !== null && String(waAccount).trim() !== '') {
    const num = await resolveWaAccountNumber(waAccount);
    params.push(num);
    where.push(`EXISTS (SELECT 1 FROM coexistence.chat_history ch
                         WHERE right(regexp_replace(ch.contact_number, '\\D', '', 'g'), 10)
                             = right(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10)
                           AND right(regexp_replace(ch.wa_number, '\\D', '', 'g'), 10) = $${params.length})`);
  }
  if (stage) {
    if (!funnelCfg.isValidStage(stage)) throw svcErr(400, `Invalid stage. Must be one of: ${funnelCfg.stageKeys().join(', ')}`);
    params.push(stage); where.push(`l.stage = $${params.length}`);
  }
  // Saved-view presets (mirror routes/leads.js). 'hot' = arrived within 24h.
  if (view === 'hot') where.push(`l.created_at >= NOW() - INTERVAL '24 hours'`);
  else if (view === 'unassigned') where.push(`l.assigned_user_id IS NULL AND l.assigned_bda IS NULL`);
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    where.push(`(l.name ILIKE $${params.length} OR l.whatsapp_number ILIKE $${params.length} OR l.email ILIKE $${params.length})`);
  }
  // The page is capped, so the caller MUST be told how many actually match — a bare
  // array of 50 rows out of 405 reads as "we have 50 leads" to anything consuming this,
  // and nothing in the old response hinted otherwise. Counted with the same WHERE, minus
  // the LIMIT.
  const filterParams = params.slice();
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(cap);
  const [{ rows }, countRes, stageRes] = await Promise.all([
    pool.query(
      `SELECT l.*, u.display_name AS assigned_user_name
         FROM coexistence.leads l
         LEFT JOIN coexistence.forgecrm_users u ON u.id = l.assigned_user_id
        ${whereSql}
        ORDER BY l.last_activity_at DESC NULLS LAST, l.id DESC
        LIMIT $${params.length}`,
      params,
    ),
    pool.query(`SELECT count(*)::int AS total FROM coexistence.leads l ${whereSql}`, filterParams),
    // Breakdown under the SAME filters, so "how many are hot?" is answerable without
    // dragging every row across the wire just to count them.
    pool.query(
      `SELECT l.stage, count(*)::int AS n FROM coexistence.leads l ${whereSql}
        GROUP BY l.stage ORDER BY n DESC`,
      filterParams,
    ),
  ]);

  const total = countRes.rows[0]?.total ?? rows.length;
  const byStage = Object.fromEntries(stageRes.rows.map((r) => [r.stage, r.n]));
  return {
    total,                        // how many match the filters, ignoring the page cap
    returned: rows.length,        // how many are in this response
    truncated: total > rows.length,
    byStage,                      // counts per funnel stage under the same filters
    leads: rows.map(leadSummaryRow),
  };
}

// Change a lead's funnel stage — mirrors PUT /leads/:id/move (audit log + SSE).
async function moveLeadStage(leadId, stage) {
  const id = parseInt(leadId, 10);
  if (!Number.isFinite(id)) throw svcErr(400, 'leadId is required.');
  if (!funnelCfg.isValidStage(stage)) throw svcErr(400, `stage must be one of: ${funnelCfg.stageKeys().join(', ')}`);
  const { rows: cur } = await pool.query(`SELECT stage FROM coexistence.leads WHERE id = $1`, [id]);
  if (!cur.length) throw svcErr(404, 'Lead not found.');
  const from = cur[0].stage;
  const { rows } = await pool.query(
    `UPDATE coexistence.leads
        SET stage = $1, stage_changed_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
      WHERE id = $2 RETURNING *`,
    [stage, id],
  );
  await pool.query(
    `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
     VALUES ($1,'stage_changed',$2,$3,'mcp')`,
    [id, from, stage],
  );
  bus.emit('lead-changed', { leadId: id });
  return { lead: leadSummaryRow(rows[0]) };
}

/* ------------------------------ products -------------------------------- */

const paise = n => Number(n || 0);
const rupees = n => Math.round(paise(n) / 100);

// The product catalog with each product's default price, sales and revenue. (Table is still `courses` — see migration 084.)
async function listCourses() {
  const { rows: courses } = await pool.query(
    `SELECT id, name, description, active, default_price_paise FROM coexistence.courses ORDER BY name`,
  );
  const { productTotals } = require('./productSales');
  const totals = {};
  for (const t of await productTotals()) totals[t.id] = t;
  const products = courses.map(c => ({
      id: Number(c.id), name: c.name, description: c.description, active: c.active,
      // null means no default price set — distinct from a price of 0.
      defaultPriceRupees: c.default_price_paise == null ? null : rupees(c.default_price_paise),
      // Sales totals (services/productSales.js).
      salesCount: totals[c.id]?.sales_count ?? 0,
      paymentCount: totals[c.id]?.payment_count ?? 0,
      revenueRupees: rupees(totals[c.id]?.revenue_paise ?? 0),
  }));
  // `courses` is a deprecated alias of the same array, kept so an MCP client
  // that already reads that key does not break on the rename.
  return { currency: 'INR', products, courses: products };
}

// Revenue leaderboard per product. Read via the shared service, so this tool
// reports the same numbers the Products page shows.
async function getCourseRevenue() {
  const { productTotals, unattributedTotals } = require('./productSales');
  const rows = await productTotals();
  const { unattributed } = await unattributedTotals();
  const products = rows.map(r => ({
    id: r.id, name: r.name, active: r.active,
    revenueRupees: rupees(r.revenue_paise),
    salesCount: r.sales_count,          // customers who bought it
    paymentCount: r.payment_count,      // their transactions
  }));
  return {
    currency: 'INR',
    products, courses: products,        // `courses` = deprecated alias
    unattributed: {
      revenueRupees: rupees(unattributed.revenue_paise),
      salesCount: unattributed.sales_count, paymentCount: unattributed.payment_count,
      note: 'Sales with no Product set on the sale.',
    },
    totalRevenueRupees: rupees(
      rows.reduce((s, r) => s + paise(r.revenue_paise), 0) + paise(unattributed.revenue_paise),
    ),
  };
}

/* -------- dedicated config tools (media / templates / automations)
   — the "let Claude configure the app" surface.
   Each reuses the real Express routes via internalApiCall so validation,
   RBAC and side-effects are never duplicated. Capability gating happens at
   the tool layer (mcpHttp.js gated() / routes/mcp.js requireCap). ---------- */

// Max bytes accepted into the Media Library via base64/URL. Meta's own per-type
// caps are smaller and enforced later at send/submit time; this just bounds what
// we parse into memory.
const MEDIA_INGEST_CAP = 30 * 1024 * 1024;

// Add a file to the Media Library from base64 (a file the user attached in the
// MCP client) OR a public URL — the JSON path the multipart upload route lacks.
// Optionally sync it straight to a WhatsApp number's Meta media store so it is
// immediately usable in sends. Returns the created media row (+ sync result).
async function uploadMediaFromSource({ base64, url, filename, mimeType, name, syncToNumber } = {}) {
  const haveB64 = !!base64;
  const haveUrl = !!url;
  if (haveB64 === haveUrl) throw svcErr(400, 'Provide exactly ONE of base64 (an attached file) or url (a public link).');

  let buffer;
  let mime = mimeType || null;
  let fname = filename || null;

  if (haveB64) {
    const dataMatch = String(base64).match(/^data:([^;]+);base64,/);
    if (dataMatch && !mime) mime = dataMatch[1];
    try { buffer = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64'); }
    catch { throw svcErr(400, 'base64 is not valid base64.'); }
  } else {
    let resp;
    try { resp = await fetch(url); } catch (e) { throw svcErr(400, `Could not fetch the url: ${e.message}`); }
    if (!resp.ok) throw svcErr(400, `Could not fetch the url (HTTP ${resp.status}).`);
    buffer = Buffer.from(await resp.arrayBuffer());
    if (!mime) mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || null;
    if (!fname) { try { fname = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || null; } catch { fname = null; } }
  }

  if (!buffer || !buffer.length) throw svcErr(400, 'The file is empty.');
  if (buffer.length > MEDIA_INGEST_CAP) {
    throw svcErr(413, `File is ${(buffer.length / 1048576).toFixed(1)}MB — over the ${Math.round(MEDIA_INGEST_CAP / 1048576)}MB Media Library limit.`);
  }
  if (!mime) { const ext = String(fname || '').split('.').pop()?.toLowerCase(); mime = EXT_MIME[ext] || 'application/octet-stream'; }
  if (!fname) { const ext = (mime.split('/')[1] || 'bin').split('+')[0]; fname = `upload-${Date.now()}.${ext}`; }

  const { ingestMediaFromSource, syncMediaToAccount } = require('../routes/mediaLibrary');
  const media = await ingestMediaFromSource({ buffer, originalName: fname, mimeType: mime, name: name || fname });

  let sync = null;
  if (syncToNumber) {
    const { account, error } = await resolveAccount({ fromPhoneNumber: String(syncToNumber).replace(/\D/g, '') });
    if (error) throw svcErr(400, `Media saved (id ${media.id}) but could not sync to ${syncToNumber}: ${error}`);
    sync = await syncMediaToAccount(media.id, account.id);
  }
  return {
    ok: true, media, sync,
    note: 'Saved to the Media Library. Use its id as headerMediaLibraryId in create_template, or mediaLibraryId in send_media / send_bulk_message.',
  };
}

// Create a WhatsApp message template as a DRAFT. For a media header, pass
// headerMediaLibraryId (from upload_media) + whatsappAccountId — the Meta upload
// handle is resolved here from the library item. Does NOT submit to Meta (call
// submit_template next).
async function createTemplate(args = {}) {
  const a = args || {};
  if (!String(a.name || '').trim()) throw svcErr(400, 'name is required (snake_case, e.g. "welcome_offer").');
  const body = String(a.body || '').trim();
  if (!body) throw svcErr(400, 'body is required.');

  const headerType = String(a.headerType || a.header_type || 'NONE').toUpperCase();
  const isMediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType);
  const whatsappAccountId = a.whatsappAccountId ?? a.waAccountId ?? null;
  const headerMediaLibraryId = a.headerMediaLibraryId ?? a.header_media_library_id ?? null;

  let mediaHandle = null;
  if (isMediaHeader) {
    if (!headerMediaLibraryId) throw svcErr(400, `A ${headerType} header needs headerMediaLibraryId — upload the image with upload_media first.`);
    if (!whatsappAccountId) throw svcErr(400, 'whatsappAccountId is required for a media-header template (the Meta upload handle is per WhatsApp account).');
    const handleRes = await internalApiOrThrow({
      method: 'POST', path: '/templates/upload-media-handle-from-library',
      body: { accountId: whatsappAccountId, mediaLibraryId: headerMediaLibraryId },
      failMsg: 'Failed to prepare the header media for Meta.',
    });
    mediaHandle = handleRes.handle;
  }

  const payload = {
    name: String(a.name).trim(),
    category: a.category || 'MARKETING',
    language: a.language || 'en',
    header_type: headerType,
    header_text: headerType === 'TEXT' ? (a.headerText || a.header_text || null) : null,
    media_handle: mediaHandle,
    header_media_library_id: isMediaHeader ? headerMediaLibraryId : null,
    body,
    footer: a.footer || null,
    buttons: Array.isArray(a.buttons) ? a.buttons : [],
    samples: a.samples || {},
    whatsappAccountId,
    template_type: a.templateType || a.template_type || 'STANDARD',
  };
  const created = await internalApiOrThrow({ method: 'POST', path: '/templates', body: payload, failMsg: 'Failed to create the template.' });
  return {
    ok: true,
    template: { id: created.id, name: created.name, language: created.language, status: created.status, category: created.category, waAccountId: created.whatsapp_account_id },
    note: 'Created as DRAFT. Call submit_template to send it to Meta for approval, then sync_template to poll the result.',
  };
}

// Submit a DRAFT template to Meta for approval.
async function submitTemplate({ templateId } = {}) {
  if (!templateId) throw svcErr(400, 'templateId is required (from create_template or list_templates).');
  const out = await internalApiOrThrow({ method: 'POST', path: `/templates/${parseInt(templateId, 10)}/submit`, failMsg: 'Failed to submit the template to Meta.' });
  return {
    ok: true,
    template: { id: out.id, name: out.name, status: out.status },
    metaStatus: out.metaResponse?.status || null,
    note: 'Submitted to Meta. Approval usually takes minutes but can take up to 24h — call sync_template to refresh the status.',
  };
}

// Poll Meta for a template's current approval status and refresh the local row.
async function syncTemplate({ templateId } = {}) {
  if (!templateId) throw svcErr(400, 'templateId is required.');
  const out = await internalApiOrThrow({ method: 'POST', path: `/templates/${parseInt(templateId, 10)}/sync`, failMsg: 'Failed to sync the template status from Meta.' });
  return { ok: true, template: { id: out.id, name: out.name, status: out.status, rejectionReason: out.rejection_reason || null } };
}

// Create an automation (flow) from a nodes/edges config (or a full config
// object). Lands INACTIVE — the caller reviews it in the builder / sets it
// active via forgechat_request PUT /chatbots/:id.
//
// ⚠ THIS PATH USED TO WRITE THE CONFIG UNCHECKED. `POST /chatbots` runs no
// validation at all (only ACTIVATION is gated, in PUT), and the tool did no
// normalisation — so a hand-written flow with no coordinates stacked every card
// on the origin, and an edge naming a handle that does not exist was saved
// silently. `flowValidator` says so in its own header: this tool was the reason
// a client-only validator would be "a rail an LLM client walks straight past".
//
// Now: normalise -> check -> refuse. Refusing (rather than saving and reporting)
// is the right default HERE specifically, and it is the opposite of the rule for
// a human pressing Save. A person's draft is half-built on purpose and losing
// their work would be worse than a broken draft. An MCP call is a one-shot
// authoring action that CLAIMS to be finished, and the caller can read the
// findings and immediately try again — so the findings are worth more before
// the write than after it. `allowIncomplete` is the escape hatch for genuinely
// parking a work-in-progress.
async function createAutomation({ name, description, triggerType, status, nodes, edges, config, allowIncomplete } = {}) {
  if (!String(name || '').trim()) throw svcErr(400, 'name is required.');
  const { normalizeFlowConfig, danglingHandles } = require('./flowAuthoring');
  const { validateFlow } = require('./flowValidator');

  const raw = (config && typeof config === 'object')
    ? config
    : { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] };
  const cfg = normalizeFlowConfig(raw);

  // An edge on a handle the node does not have is invisible to validateFlow —
  // it looks for handles that are UNwired, and this one matches no handle at
  // all. Reported separately so the exact `row:N`-style mistake names itself.
  const dangling = danglingHandles(cfg);

  // Same template context the activation gate uses, so "create_automation said
  // it was fine" and "Go Live refused it" cannot disagree.
  let templatesById = {};
  try {
    const { rows } = await pool.query('SELECT id, name, status FROM coexistence.message_templates');
    templatesById = Object.fromEntries(rows.map(t => [String(t.id), t]));
  } catch { /* validate without template context rather than failing the call */ }

  const check = validateFlow(cfg, { templatesById });

  if ((check.blocking.length || dangling.length) && !allowIncomplete) {
    const problems = [
      ...dangling.map(d => `• ${d.message} ${d.fix}`),
      ...check.blocking.map(b => `• ${b.message} ${b.fix || ''}`.trim()),
    ];
    throw svcErr(400,
      `This flow was not created — it would be broken at runtime:\n${problems.join('\n')}\n\n` +
      'Fix these and call create_automation again. Pass allowIncomplete:true only if you deliberately want to park an unfinished draft.');
  }

  const created = await internalApiOrThrow({
    method: 'POST', path: '/chatbots',
    body: { name: String(name).trim(), description: description || null, status: 'draft', trigger_type: triggerType || 'keyword', config: cfg },
    failMsg: 'Failed to create the automation.',
  });

  // status:'active' is accepted and then deliberately NOT honoured here. The
  // activation gate lives in PUT /chatbots/:id, so creating straight to active
  // would be the one way into the app that skips it — and going live means
  // replying to real customers. Said out loud rather than ignored silently.
  const wantedActive = status === 'active';

  return {
    ok: true,
    automation: { id: created.id, name: created.name, status: created.status, triggerType: created.trigger_type },
    warnings: check.warnings,
    danglingConnections: dangling,
    note: [
      `Created as a draft (id ${created.id}) and laid out left-to-right.`,
      check.warnings.length
        ? `${check.warnings.length} thing(s) are unfinished but not broken — see warnings[]; each names the step and the fix.`
        : 'No warnings.',
      wantedActive
        ? 'It was NOT activated: going live runs the activation check, which only PUT /chatbots/:id does. Review it in the builder first, then set status:"active" via forgechat_request.'
        : 'To go live: forgechat_request PUT /chatbots/:id { "status": "active" }.',
    ].join(' '),
  };
}

// Load the template context validateFlow needs. Shared by every automation
// entry point here so "the checker said it was fine" cannot depend on which
// door the request came through.
async function flowTemplateContext() {
  try {
    const { rows } = await pool.query('SELECT id, name, status FROM coexistence.message_templates');
    return Object.fromEntries(rows.map(t => [String(t.id), t]));
  } catch { return {}; }
}

// Check a flow WITHOUT saving it — or check one already saved.
//
// The gap this closes: the only previous way to discover a hand-authored graph
// was broken was to create it and open the builder, which turns a wrong guess
// into a real row somebody has to find and delete.
async function validateAutomation({ automationId, nodes, edges, config } = {}) {
  const { normalizeFlowConfig, danglingHandles } = require('./flowAuthoring');
  const { validateFlow } = require('./flowValidator');

  let cfg;
  if (automationId != null && automationId !== '') {
    const row = await internalApiOrThrow({ method: 'GET', path: `/chatbots/${parseInt(automationId, 10)}`, failMsg: 'Automation not found.' });
    cfg = row.config || {};
  } else if (config && typeof config === 'object') {
    cfg = normalizeFlowConfig(config);
  } else {
    cfg = normalizeFlowConfig({ nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] });
  }

  const check = validateFlow(cfg, { templatesById: await flowTemplateContext() });
  const dangling = danglingHandles(cfg);
  const canGoLive = check.ok && dangling.length === 0;
  return {
    ok: canGoLive,
    canGoLive,
    blocking: check.blocking,
    warnings: check.warnings,
    danglingConnections: dangling,
    note: canGoLive
      ? (check.warnings.length
        ? `This flow can go live. ${check.warnings.length} thing(s) are unfinished but not broken.`
        : 'This flow can go live with nothing outstanding.')
      : 'This flow cannot go live yet — each entry in blocking[] / danglingConnections[] names the step and how to fix it.',
  };
}

// Edit or activate a saved automation.
//
// ⚠ Activation deliberately goes through PUT /chatbots/:id rather than writing
// the column, because that route IS the activation gate. Setting the status any
// other way would be the one door into the app that skips the check — and what
// it skips is whether a flow about to reply to real customers actually works.
async function updateAutomation({ id, name, description, active, nodes, edges, config } = {}) {
  const aid = parseInt(id, 10);
  if (!Number.isFinite(aid)) throw svcErr(400, 'id is required (from list_automations).');
  const { normalizeFlowConfig, danglingHandles } = require('./flowAuthoring');

  const body = {};
  if (name !== undefined) body.name = String(name).trim();
  if (description !== undefined) body.description = description;

  let cfg = null;
  if (config && typeof config === 'object') cfg = normalizeFlowConfig(config);
  else if (Array.isArray(nodes) || Array.isArray(edges)) {
    cfg = normalizeFlowConfig({ nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] });
  }
  if (cfg) {
    // Refused here as well as at activation: an edge on a handle that does not
    // exist is invisible to the activation gate (it checks whether handles are
    // wired, not whether they exist), so it would otherwise be saved silently
    // and go live looking correct.
    const dangling = danglingHandles(cfg);
    if (dangling.length) {
      throw svcErr(400, `The flow was not saved:\n${dangling.map(d => `• ${d.message} ${d.fix}`).join('\n')}`);
    }
    body.config = cfg;
  }
  if (active !== undefined) body.status = active ? 'active' : 'inactive';

  if (!Object.keys(body).length) throw svcErr(400, 'Nothing to change — pass at least one of name, description, active, nodes/edges/config.');

  const out = await internalApiCall({ method: 'PUT', path: `/chatbots/${aid}`, body });
  if (!out.ok) {
    // The activation gate answers 409 with the findings attached. Surfaced in
    // full rather than flattened to "could not activate", because the whole
    // value of that gate is that it says WHICH step and WHY.
    if (out.status === 409 && out.body && Array.isArray(out.body.blocking)) {
      throw svcErr(409, `${out.body.error}\n${out.body.blocking.map(b => `• ${b.message} ${b.fix || ''}`.trim()).join('\n')}`);
    }
    throw svcErr(out.status || 500, (out.body && out.body.error) || 'Failed to update the automation.');
  }
  return {
    ok: true,
    automation: { id: out.body.id, name: out.body.name, status: out.body.status },
    note: active === true
      ? 'This automation is now LIVE and will reply to real customers.'
      : active === false ? 'This automation is paused.' : 'Saved. It was not activated.',
  };
}

async function listAutomations({ id } = {}) {
  if (id != null && id !== '') {
    const aid = parseInt(id, 10);
    if (!Number.isFinite(aid)) throw svcErr(400, 'id must be a number.');
    const row = await internalApiOrThrow({ method: 'GET', path: `/chatbots/${aid}`, failMsg: 'Automation not found.' });
    return { automation: row };
  }
  const rows = await internalApiOrThrow({ method: 'GET', path: '/chatbots', failMsg: 'Failed to list automations.' });
  const list = Array.isArray(rows) ? rows : (rows.chatbots || []);
  return {
    automations: list.map(r => ({
      id: r.id, name: r.name, description: r.description, status: r.status,
      triggerType: r.trigger_type,
      steps: Array.isArray(r.config && r.config.nodes) ? r.config.nodes.length : null,
      updatedAt: r.updated_at,
    })),
    note: 'status "active" means it is live and replying. Pass an id to read the full nodes/edges graph.',
  };
}

// What a flow actually did. The execution log names the step and the reason,
// which is almost always the answer to "the automation did not work".
async function getAutomationRuns({ automationId, executionId, status, limit } = {}) {
  if (executionId != null && executionId !== '') {
    const eid = parseInt(executionId, 10);
    if (!Number.isFinite(eid)) throw svcErr(400, 'executionId must be a number.');
    return internalApiOrThrow({ method: 'GET', path: `/executions/${eid}`, failMsg: 'Run not found.' });
  }
  const aid = parseInt(automationId, 10);
  if (!Number.isFinite(aid)) throw svcErr(400, 'automationId is required (from list_automations).');
  return internalApiOrThrow({
    method: 'GET', path: `/chatbots/${aid}/executions`,
    query: { status, limit: limit || 20 },
    failMsg: 'Failed to read the runs.',
  });
}

// ── follow-up calendar (Leads → My list) ────────────────────────────────────
// Same functions the app routes call (services/followUps.js), so a follow-up
// set from Claude lands on exactly the calendar a rep sees.

const MCP_USER = { role: 'admin', viaMcp: true, displayName: 'MCP' };

async function mcpResolveThread(contactNumber, waNumber) {
  const d = String(contactNumber || '').replace(/\D/g, '');
  if (d.length < 8) throw Object.assign(new Error('contactNumber must be the customer\'s phone number'), { status: 400 });
  if (waNumber) return { waNumber: String(waNumber).replace(/\D/g, ''), contactNumber: d };
  // The thread they last WROTE on — that is where a follow-up should go.
  const { rows: [r] } = await pool.query(
    `SELECT wa_number, contact_number FROM coexistence.chat_history
      WHERE right(regexp_replace(contact_number,'\\D','','g'),10) = right($1,10)
      ORDER BY (direction = 'incoming') DESC, timestamp DESC LIMIT 1`, [d]);
  return r ? { waNumber: r.wa_number, contactNumber: r.contact_number } : { waNumber: null, contactNumber: d };
}

async function mcpOwnerId(ownerEmail) {
  if (!ownerEmail) return undefined;
  const { rows: [u] } = await pool.query(
    `SELECT id FROM coexistence.forgecrm_users WHERE lower(email) = lower($1) OR lower(username) = lower($1) LIMIT 1`, [String(ownerEmail).trim()]);
  if (!u) throw Object.assign(new Error(`No user with email/username "${ownerEmail}"`), { status: 400 });
  return Number(u.id);
}

async function listFollowUpsMcp({ from, to, status = 'open', contactNumber, limit } = {}) {
  const fu = require('./followUps');
  const items = await fu.listFollowUps(MCP_USER, { from, to, status, contact: contactNumber, limit });
  return { count: items.length, followUps: items };
}

async function setFollowUpMcp({ contactNumber, waNumber, dueDate, dueTime, note, ownerEmail } = {}) {
  const fu = require('./followUps');
  const thread = await mcpResolveThread(contactNumber, waNumber);
  const ownerUserId = await mcpOwnerId(ownerEmail);
  const f = await fu.setFollowUp(MCP_USER, {
    ...thread, dueDate, dueTime, note, source: 'mcp', pin: false,
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
  });
  return { ok: true, followUp: f, note: 'If this person already had an open follow-up for that owner it was RESCHEDULED, not duplicated.' };
}

async function updateFollowUpMcp({ id, dueDate, dueTime, note, status, remove } = {}) {
  const fu = require('./followUps');
  if (!id) throw Object.assign(new Error('id is required (from list_follow_ups)'), { status: 400 });
  if (remove) return fu.deleteFollowUp(MCP_USER, Number(id));
  const patch = {};
  if (dueDate !== undefined) patch.dueDate = dueDate;
  if (dueTime !== undefined) patch.dueTime = dueTime;
  if (note !== undefined) patch.note = note;
  if (status !== undefined) patch.status = status;
  return { ok: true, followUp: await fu.updateFollowUp(MCP_USER, Number(id), patch) };
}

async function suggestFollowUpMcp({ contactNumber, waNumber } = {}) {
  const fu = require('./followUps');
  const thread = await mcpResolveThread(contactNumber, waNumber);
  return { suggestion: await fu.suggestFollowUp(thread), hint: 'Call set_follow_up with this date to put it on the calendar.' };
}

module.exports = {
  MODEL_CATALOG, PROVIDER_LABELS, CAPABILITY_KEYS, AREA_CAPABILITY_KEYS, PROXY_AREAS,
  ensureMcpTables, loadSettings, validateKey,
  // Category catalog — re-exported so both transports and routes/mcp.js gate on
  // one implementation rather than importing it in three places and drifting.
  catalog: mcpCatalog,
  isToolAllowed: mcpCatalog.isToolAllowed,
  listFollowUpsMcp, setFollowUpMcp, updateFollowUpMcp, suggestFollowUpMcp,
  toolDeniedMessage: mcpCatalog.toolDeniedMessage,
  listWaAccounts, listModels, searchSpreadsheets, listSheetTabs, readSheetValues, listMedia, listTemplates, getTemplate,
  listConversations, getChatHistory, sendTextMessage, sendTemplateMessage,
  sendMediaMessage, sendInteractiveMessage,
  proxyRequest, listEndpoints, sendBulkMessage,
  listLeads, moveLeadStage,
  listCourses, getCourseRevenue,
  uploadMediaFromSource, createTemplate, submitTemplate, syncTemplate,
  createAutomation, validateAutomation, updateAutomation, listAutomations, getAutomationRuns,
  internalApiOrThrow,
  // One literal component builder, shared rather than copied per sender.
  buildLiteralTemplateComponents,
};
