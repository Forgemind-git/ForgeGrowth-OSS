// Remote (Streamable HTTP) MCP transport, mounted at /api/mcp/http/:key.
//
// This is "Model B": anyone can connect with just a URL (key in the path) —
// no local files. Stateless + JSON responses (proxy-friendly through Traefik),
// a fresh McpServer per request. Tools call services/mcpService + agentService
// DIRECTLY (in-process), gated by the per-request key's capabilities.

const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const agentService = require('./services/agentService');
const mcpService = require('./services/mcpService');

// `trust proxy` is off in this app, so req.protocol reports http even on a TLS
// request. The forwarded header is the only truthful source behind Traefik +
// nginx, and an http URL in a WWW-Authenticate challenge is ignored by clients.
function baseFromReq(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto === 'http' ? 'https' : proto}://${host}`;
}

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function fail(msg) { return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }; }

// Run a tool and format its result/error. It does NOT gate: gating is applied
// once at registration in buildServer(), derived from the tool's own name, so a
// handler can never be wired to the wrong switch by hand.
function run(fn) {
  return async (args) => {
    try { return ok(await fn(args || {})); }
    catch (err) { return fail(err.message || 'Tool failed'); }
  };
}

const mediaGroupSchema = z.object({
  description: z.string().describe('REQUIRED. Tells the agent exactly WHEN to send this group — specific and action-oriented, e.g. "Send when the user confirms they want to enroll" or "Send after the user asks for pricing". Ask the user for this before finalising the group.'),
  mediaIds: z.array(z.number()).optional().describe('Media library item ids to send.'),
  links: z.array(z.string()).optional().describe('URLs to send as link messages.'),
  templateId: z.number().nullable().optional().describe('Approved template id to fire. Always confirm the template content with the user via get_template before using this.'),
}).passthrough();

const GUIDE = `This is ForgeGrowth — an AI Academy Marketing/Sales lead funnel with a WhatsApp Chats layer underneath it. Before assuming this is purely an agent-builder: if the user wants to inspect or act on leads, campaigns, webinars, or BDA performance, use the funnel tools directly (list_leads, move_lead_stage, get_campaign_performance, list_webinars, get_bda_activity, or forgechat_request for anything else in an enabled area) — you do NOT need to build an agent for that.

You can also CONFIGURE the whole app from a plain-language "game plan": get a poster into the Media Library (upload_media with a public url, or list_media by name for one the user already uploaded in the web app), create + submit a WhatsApp template for Meta approval (create_template → submit_template → sync_template), build an automation flow (create_automation), make a lead form (create_lead_form) and read its submissions (list_form_submissions), generate a click-to-chat link (create_wa_link), and send/broadcast (send_message, send_template, send_media, send_bulk_message). ALWAYS summarise what you will do and get the user's explicit confirmation before any create/submit/send step.
IMPORTANT for posters/images: you cannot upload a file the user attached in this chat — you don't have its raw bytes, and trying to inline it as base64 hangs forever. If the user's image is a local file with no public URL, tell them to upload it once in ForgeGrowth → Media Library in the web app, then reference it by name (you resolve it with list_media). Only use upload_media when you have a genuine public https URL.

The rest of this guide covers creating a WhatsApp AI agent. Gather and CONFIRM the full configuration with the user before calling create_agent. Offer real options fetched from their account — never guess ids, spreadsheets, tabs, models, or numbers.

Walk this flow:
1. Ask what the agent should do (its purpose / goal).
2. Propose a clear name and a first draft of the system prompt; refine with the user.
3. Call list_wa_accounts and ask which WhatsApp number it should run on.
4. Call list_models and ask which AI model to use (show provider + model options). Pass the chosen aiModelId + llmModel.
5. Ask how it should trigger: "any" (every message) or "keyword". If keyword, ask for the keyword, match type (exact/contains/starts), case sensitivity, and session window minutes (default 30).
   Also ask whether the agent should understand voice notes (set transcribeAudio:true) and/or images (set acceptImages:true).
6. Ask whether it needs tools.
   - Google Sheets:
     a. Call search_spreadsheets and let the user pick a spreadsheet.
     b. Call list_sheet_tabs for that spreadsheet and let the user pick the tab.
     b2. If the agent will LOG rows to the sheet (or you need the column layout), call read_sheet_values (range "A1:Z1") to read the real header row, then map the logged fields to those exact columns — don't assume column names.
     c. Ask which operations to allow: read, append, update, upsert (one or more). For LOGGING a contact's data to the sheet, prefer 'upsert' — it updates the contact's existing row (matched by a key column like phone) or adds one if new, so there are never duplicate rows.
   - HTTP request (to call an external API / device / hardware / webhook): ask for the endpoint URL, method, any auth headers, and what inputs the AI should fill (each input's name, where it goes — path/query/body/header — type, and meaning). Then use add_http_tool. Use {name} in the URL for path inputs.
7. Ask whether it should send media bundles or templates (media groups) — optional. A media group is a bundle the agent sends at a specific moment. For EACH group:
   a. Ask "when should this be sent?" — the answer becomes the group's description (e.g. "Send when the user confirms interest", "Send after the user asks for pricing"). This description is how the agent decides when to trigger the group, so make it specific and action-oriented.
   b. Media: if the user mentions a file by name, call list_media with that name to resolve it to an id — never ask the user for an id.
   c. Template: if the user mentions a template by name, call list_templates to find it, then call get_template to read its full content (body, header, buttons). Show the user the template name + body + buttons and ask them to confirm it is the right one BEFORE using its id.
   d. Ask if there are more groups to add. Repeat until done.
8. Summarize the complete configuration and ask for explicit confirmation.
9. On confirmation, call create_agent. Then attach any chosen tools: add_google_sheets_tool for Sheets, add_http_tool for HTTP.
10. Report the created agent (id + recap) and offer to activate it or make edits.

Notes: an ACTIVE agent needs both aiModelId and llmModel (otherwise save status:"draft"). Only one active agent per WhatsApp number. Always confirm destructive actions (delete) first.`;

// Build a fresh server scoped to one request's settings.
//   categories   -> gates the 44 named tools (services/mcpCatalog.js)
//   capabilities -> still scopes which API paths forgechat_request may reach
function buildServer({ capabilities, categories }) {
  const server = new McpServer({ name: 'forgechat-agents', version: '1.0.0' });

  // Gate EVERY tool by its own category, derived from the tool NAME here at
  // registration rather than hand-typed at each call site. That is what makes
  // drift impossible: a tool with no entry in mcpCatalog.js resolves to no
  // category and is refused, so it can never be silently wired to the wrong
  // switch — or to none at all, which is how list_endpoints and
  // forgechat_request previously ended up ungated.
  const registerRaw = server.registerTool.bind(server);
  server.registerTool = (name, meta, handler) => registerRaw(name, meta, async (...a) => {
    if (!mcpService.isToolAllowed(name, categories)) return fail(mcpService.toolDeniedMessage(name));
    return handler(...a);
  });

  /* discovery */
  server.registerTool('list_wa_accounts', {
    title: 'List WhatsApp accounts',
    description: 'List the WhatsApp business numbers an agent can run on. Use to ask the user which number to use. Returns id, displayName, phoneNumber, isActive, isDefault.',
    inputSchema: {},
  }, run(() => mcpService.listWaAccounts()));

  server.registerTool('list_models', {
    title: 'List AI models',
    description: 'List connected AI model credentials and selectable model ids. Each entry has aiModelId, provider, providerLabel, label, and models[] of {value,label}. Pass aiModelId + a models[].value (as llmModel) to create_agent.',
    inputSchema: {},
  }, run(() => mcpService.listModels()));

  server.registerTool('search_spreadsheets', {
    title: 'Search Google spreadsheets',
    description: 'Search the connected Google account for spreadsheets by name. Use when configuring a Google Sheets tool so the user picks a real spreadsheet. Returns { spreadsheets: [{ id, name, modifiedTime, ownerEmail }] }.',
    inputSchema: { query: z.string().optional().describe('Optional search term.') },
  }, run(({ query }) => mcpService.searchSpreadsheets({ q: query || '' })));

  server.registerTool('list_sheet_tabs', {
    title: 'List spreadsheet tabs',
    description: 'List the tabs in a spreadsheet so the user can choose one. Returns { id, title, tabs: [{ title, rowCount, columnCount }] }.',
    inputSchema: { spreadsheetId: z.string().describe('Spreadsheet id from search_spreadsheets.') },
  }, run(({ spreadsheetId }) => mcpService.listSheetTabs(spreadsheetId)));

  server.registerTool('read_sheet_values', {
    title: 'Read spreadsheet cell values',
    description: 'Read actual cell values from a tab — use this to see the real HEADER ROW and a few sample rows so you can map an agent\'s Sheets logging to the right columns. list_sheet_tabs only returns metadata (names/dimensions), NOT contents; this returns them. Returns { range, headers:[...], rows:[[...]], rowCount }. With no range, returns the header + up to maxRows data rows. Pass an A1 range like "A1:Z1" to fetch only the header row.',
    inputSchema: {
      spreadsheetId: z.string().describe('Spreadsheet id from search_spreadsheets.'),
      tab: z.string().describe('Tab name from list_sheet_tabs.'),
      range: z.string().optional().describe('Optional A1 range (e.g. "A1:Z1" for just headers, or "A1:Z20"). Omit to read the header + maxRows rows.'),
      maxRows: z.number().int().min(1).max(500).optional().describe('Soft cap on returned rows (default 50).'),
    },
  }, run(({ spreadsheetId, tab, range, maxRows }) => mcpService.readSheetValues({ spreadsheetId, tab, range, maxRows })));

  server.registerTool('list_media', {
    title: 'List media library items',
    description: 'List media library items for media groups. Filter by type and/or name (partial, case-insensitive). Returns [{ id, name, mediaType, mimeType }]. When the user mentions a media name, call this with that name to resolve it to an id — then use that id in mediaGroups.',
    inputSchema: {
      type: z.enum(['image', 'video', 'audio', 'document']).optional(),
      name: z.string().optional().describe('Partial name search (case-insensitive). Use when the user mentions a media file by name.'),
    },
  }, run(({ type, name }) => mcpService.listMedia(type, name)));

  server.registerTool('list_templates', {
    title: 'List message templates',
    description: 'List WhatsApp message templates (optionally by WhatsApp account). Returns [{ id, name, language, status, category, waAccountId }]. When the user mentions a template by name, call this to find it, then call get_template to read its full content before confirming with the user.',
    inputSchema: { waAccountId: z.union([z.string(), z.number()]).optional() },
  }, run(({ waAccountId }) => mcpService.listTemplates(waAccountId)));

  server.registerTool('get_template', {
    title: 'Get template content',
    description: 'Fetch the full content of a template — body text, header, footer, buttons, and variable samples. Call this after finding a template by name via list_templates, then show the content to the user (name + body + buttons) so they can confirm it is the right one before using its id in a media group or agent config.',
    inputSchema: { id: z.union([z.string(), z.number()]).describe('Template id from list_templates.') },
  }, run(({ id }) => mcpService.getTemplate(id)));

  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'List all existing AI agents with tool counts and last-run time.',
    inputSchema: {},
  }, run(() => agentService.listAgents()));

  server.registerTool('get_agent', {
    title: 'Get agent',
    description: 'Get one agent in full, including its tools[].',
    inputSchema: { id: z.union([z.string(), z.number()]) },
  }, run(({ id }) => agentService.getAgent(id)));

  /* conversations: read + reply */
  server.registerTool('list_conversations', {
    title: 'List WhatsApp conversations',
    description:
      'List recent WhatsApp conversations (newest first), optionally for one business number or filtered by name/number. ' +
      'Each row returns the business number it is on (waNumber), the customer number (contactNumber), name, last message + time, unreadCount, ' +
      'and a `window` object { open, secondsRemaining, expiresAt } telling you whether the 24-hour customer-service window is still open. ' +
      'When window.open is false you can only reply with an approved template (send_template), not free-form text (send_message).',
    inputSchema: {
      waNumber: z.string().optional().describe('Only this business WhatsApp number.'),
      search: z.string().optional().describe('Filter by customer name or number (partial).'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, run(({ waNumber, search, limit }) => mcpService.listConversations({ waNumber, search, limit })));

  server.registerTool('read_messages', {
    title: 'Read a conversation',
    description:
      'Read the message history of one conversation (oldest→newest), plus a `window` object showing whether the 24-hour window is open. ' +
      'Pass the waNumber + contactNumber from list_conversations.',
    inputSchema: {
      waNumber: z.string().describe('Business WhatsApp number (from list_conversations).'),
      contactNumber: z.string().describe('Customer number (from list_conversations).'),
      limit: z.number().int().min(1).max(200).optional().describe('Most recent N messages (default 50).'),
      before: z.string().optional().describe('ISO timestamp — only messages before this (for paging back).'),
    },
  }, run(({ waNumber, contactNumber, limit, before }) => mcpService.getChatHistory({ waNumber, contactNumber, limit, before })));

  server.registerTool('send_message', {
    title: 'Send a text reply',
    description:
      'Send a free-form TEXT WhatsApp message. You MUST pass fromNumber — the business number to send from. ' +
      'If unsure which number, call list_wa_accounts (or use the waNumber of the conversation) and ASK THE USER which number to send from. ' +
      'Only works inside the 24-hour customer-service window (the customer messaged within 24h); otherwise it returns an OUTSIDE_WINDOW error and you must use send_template instead. ' +
      'Check the conversation `window.open` (via list_conversations / read_messages) before sending.',
    inputSchema: {
      fromNumber: z.string().describe('The business WhatsApp number to send FROM. Ask the user if unclear.'),
      toNumber: z.string().describe('The customer number to send to.'),
      text: z.string().describe('The message text.'),
    },
  }, run(({ fromNumber, toNumber, text }) => mcpService.sendTextMessage({ fromNumber, toNumber, text })));

  server.registerTool('send_template', {
    title: 'Send an approved template',
    description:
      'Send an APPROVED WhatsApp template message — works any time, including OUTSIDE the 24-hour window (use this for proactive outreach or when send_message returned OUTSIDE_WINDOW). ' +
      'You MUST pass fromNumber — the business number to send from; ask the user which number if unclear. ' +
      'First call list_templates (filter by waAccountId) and get_template to confirm the exact template + how many {{n}} variables it needs, then pass the variable values in order.',
    inputSchema: {
      fromNumber: z.string().describe('The business WhatsApp number to send FROM. The template must be approved on this number.'),
      toNumber: z.string().describe('The customer number to send to.'),
      templateId: z.union([z.string(), z.number()]).describe('Template id from list_templates.'),
      variables: z.array(z.string()).optional().describe('Body variable values in order ({{1}}, {{2}}, …). Omit if the template has no variables.'),
    },
  }, run(({ fromNumber, toNumber, templateId, variables }) => mcpService.sendTemplateMessage({ fromNumber, toNumber, templateId, variables })));

  server.registerTool('send_media', {
    title: 'Send a document / image / video / audio',
    description:
      'Send a file (PDF or other DOCUMENT, image, video, or audio) into a WhatsApp conversation. ' +
      'USE THIS when the user uploads/attaches a file in the chat and asks to send it to a number — read the file and pass its bytes as base64 in `fileBase64` plus the `filename`. ' +
      'Three ways to supply the file (pass exactly ONE): (1) `fileBase64` + `filename` for a file uploaded right here; (2) `mediaLibraryId` from list_media for a file already in the ForgeChat Media Library; (3) `link` for a public https URL. ' +
      'You MUST pass `fromNumber` (the business number to send from) — ask the user / use the conversation\'s waNumber if unclear. ' +
      'Only works INSIDE the 24-hour customer-service window; otherwise it returns OUTSIDE_WINDOW and you must use send_template. ' +
      'The media `type` is auto-detected from the file; only set it to override. For documents pass a `filename` so it shows a proper name; `caption` is optional (ignored for audio).',
    inputSchema: {
      fromNumber: z.string().describe('The business WhatsApp number to send FROM. Ask the user if unclear.'),
      toNumber: z.string().describe('The customer number to send to.'),
      fileBase64: z.string().optional().describe('Base64 of the file the user uploaded here (a raw base64 string or a data: URL). Pair with filename. Use this for "send this PDF/file" requests.'),
      filename: z.string().optional().describe('Original file name incl. extension, e.g. "Quotation.pdf". Required with fileBase64; recommended for documents.'),
      mimeType: z.string().optional().describe('MIME type of fileBase64 (e.g. application/pdf). Inferred from filename when omitted.'),
      mediaLibraryId: z.union([z.string(), z.number()]).optional().describe('Id from list_media to send an existing Media Library item instead of an upload.'),
      link: z.string().optional().describe('Public https URL to the file (alternative to fileBase64 / mediaLibraryId).'),
      type: z.enum(['document', 'image', 'video', 'audio']).optional().describe('Override the auto-detected media type.'),
      caption: z.string().optional().describe('Optional caption (shown with image/video/document; ignored for audio).'),
    },
  }, run((args) => mcpService.sendMediaMessage(args)));

  server.registerTool('send_interactive', {
    title: 'Send an interactive message (buttons / list)',
    description:
      'Send a free-form INTERACTIVE WhatsApp message — reply buttons or a list menu — by passing a ready Meta `interactive` object verbatim. ' +
      'You MUST pass fromNumber (the business number). Only works INSIDE the 24-hour customer-service window (for proactive interactive prompts use an approved template instead). ' +
      'Example interactive: { type:"button", body:{ text:"Pick one" }, action:{ buttons:[{ type:"reply", reply:{ id:"yes", title:"Yes" } }] } }.',
    inputSchema: {
      fromNumber: z.string().describe('The business WhatsApp number to send FROM.'),
      toNumber: z.string().describe('The customer number to send to.'),
      interactive: z.record(z.any()).describe('A Meta interactive object (type button or list).'),
    },
  }, run(({ fromNumber, toNumber, interactive }) => mcpService.sendInteractiveMessage({ fromNumber, toNumber, interactive })));

  /* config: media / templates / automations / wa-links / lead forms */
  server.registerTool('upload_media', {
    title: 'Upload media to the Media Library',
    description:
      'Add an image / video / document / audio file to the ForgeChat Media Library, then use its returned id as headerMediaLibraryId in create_template. Pass exactly ONE of url or base64. ' +
      'PREFER `url` — a public https link to the file. The server fetches it directly. ' +
      'DO NOT try to inline an image the user attached in the chat as `base64`: you cannot reproduce an attached file\'s raw bytes, and attempting it produces a huge argument that never completes (the "upload keeps running forever" bug). ' +
      'For a LOCAL file the user has (on their desktop, with no URL), do NOT call this tool — instead tell the user to upload it once in ForgeGrowth → Media Library in the web app, then say "use the poster named X"; you resolve it with list_media (by name) and pass its id straight to create_template. ' +
      '`base64` is only viable for tiny files (a few KB) that were genuinely delivered to you as data. ' +
      'Optionally pass syncToNumber (a business WhatsApp number) to immediately upload it to that number\'s Meta media store. Returns the new media { id, ... }.',
    inputSchema: {
      url: z.string().optional().describe('Public https URL to fetch the file from. PREFERRED. Provide this OR base64.'),
      base64: z.string().optional().describe('Base64 of a SMALL file actually delivered to you as data. Do NOT use for an image the user attached in chat — you cannot reproduce its bytes and the call will hang. Prefer url.'),
      filename: z.string().optional().describe('File name incl. extension, e.g. "poster.jpg". Recommended.'),
      mimeType: z.string().optional().describe('MIME type (inferred from filename/URL when omitted).'),
      name: z.string().optional().describe('Display name in the Media Library.'),
      syncToNumber: z.string().optional().describe('Business WhatsApp number to immediately sync the media to Meta for.'),
    },
  }, run((a) => mcpService.uploadMediaFromSource(a)));

  server.registerTool('create_template', {
    title: 'Create a WhatsApp message template',
    description:
      'Create a WhatsApp message template as a DRAFT (does NOT submit to Meta — call submit_template next). ' +
      'For a media header (poster): get a Media Library id first — resolve an already-uploaded file with list_media (by name), or fetch a public link with upload_media (url). ' +
      'Never ask the user to paste base64; if their poster is a local file with no URL, have them upload it in ForgeGrowth → Media Library, then reference it by name. ' +
      'Then pass headerType "IMAGE" + headerMediaLibraryId + whatsappAccountId. ' +
      'Body text uses {{1}},{{2}} for variables (provide `samples` for Meta review). Confirm the full template with the user before creating.',
    inputSchema: {
      name: z.string().describe('Template name in snake_case, e.g. "diwali_offer".'),
      body: z.string().describe('Body text. Use {{1}},{{2}} for variables.'),
      category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional().describe('Default MARKETING.'),
      language: z.string().optional().describe('Language code, default "en".'),
      headerType: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional().describe('Default NONE.'),
      headerText: z.string().optional().describe('Header text (headerType TEXT only).'),
      headerMediaLibraryId: z.union([z.string(), z.number()]).optional().describe('Media Library id for a media header (from upload_media / list_media).'),
      whatsappAccountId: z.union([z.string(), z.number()]).optional().describe('WhatsApp account id (from list_wa_accounts). Required for a media header + to submit.'),
      footer: z.string().optional(),
      buttons: z.array(z.record(z.any())).optional().describe('Meta button objects (QUICK_REPLY / URL / PHONE_NUMBER / COPY_CODE).'),
      samples: z.record(z.any()).optional().describe('Example values for {{n}} variables, required by Meta for approval.'),
    },
  }, run((a) => mcpService.createTemplate(a)));

  server.registerTool('submit_template', {
    title: 'Submit a template to Meta for approval',
    description: 'Submit a DRAFT template to Meta for approval. The template must have a WhatsApp account assigned. After submitting, use sync_template to poll the approval result.',
    inputSchema: { templateId: z.union([z.string(), z.number()]).describe('Template id from create_template / list_templates.') },
  }, run((a) => mcpService.submitTemplate(a)));

  server.registerTool('sync_template', {
    title: 'Refresh a template approval status',
    description: 'Poll Meta for a template\'s current status (APPROVED / REJECTED / SUBMITTED) and refresh it locally. Meta does not push status, so call this to check on a submitted template.',
    inputSchema: { templateId: z.union([z.string(), z.number()]).describe('Template id.') },
  }, run((a) => mcpService.syncTemplate(a)));

  server.registerTool('create_automation', {
    title: 'Create an automation flow',
    description:
      'Create a WhatsApp automation (chatbot flow) from a nodes/edges config. Lands INACTIVE. ' +
      'The config is { nodes:[...], edges:[...] }: node types trigger|message|condition|action|delay|api|handoff|ai|ai_agent|subflow; edges are { from, to, fromHandle? } (fromHandle: default|yes|no|btn:N|row:N). ' +
      'Build the flow to match the user\'s described chat flow, confirm it, then create. Set status:"active" later (via forgechat_request PUT /chatbots/:id) after reviewing it in the builder.',
    inputSchema: {
      name: z.string().describe('Automation name.'),
      description: z.string().optional(),
      triggerType: z.string().optional().describe('e.g. "keyword" or "anyMessage" — matches the trigger node.'),
      status: z.enum(['draft', 'active']).optional().describe('Default draft.'),
      nodes: z.array(z.record(z.any())).optional().describe('Flow nodes.'),
      edges: z.array(z.record(z.any())).optional().describe('Flow edges connecting nodes.'),
      config: z.record(z.any()).optional().describe('Full { nodes, edges } config (alternative to passing nodes/edges separately).'),
      folderId: z.union([z.string(), z.number()]).optional(),
    },
  }, run((a) => mcpService.createAutomation(a)));

  server.registerTool('create_wa_link', {
    title: 'Create a click-to-chat link',
    description: 'Create a tracked wa.me click-to-chat link that opens a chat with a business number, optionally pre-filled with a message. Returns the short link + slug.',
    inputSchema: {
      name: z.string().describe('Link name (for your reference).'),
      accountId: z.union([z.string(), z.number()]).describe('WhatsApp account id (from list_wa_accounts) — its phone number is used.'),
      message: z.string().optional().describe('Pre-filled message text the user starts the chat with.'),
    },
  }, run((a) => mcpService.createWaLink(a)));

  server.registerTool('create_lead_form', {
    title: 'Create a form',
    description:
      'Create a Google-Forms-style capture form and (optionally) attach its fields + publish in one call. ' +
      'fields[] items: { key, label, type (text|textarea|email|phone|number|date|dropdown|radio|checkbox|boolean), required?, mapsTo? (name|email|phone|age|profession|pincode|city|source), options? (for dropdown/radio/checkbox), placeholder? }. ' +
      'formType "link" (default) is shared as a plain URL and the phone number is OPTIONAL — give a field mapsTo:"phone" to let people volunteer one; without it responses are stored with the phone column blank and do not create a lead. ' +
      'formType "whatsapp" is sent through an approved Utility/Marketing template whose link captures each recipient\'s phone automatically; after publishing, call forgechat_request POST /lead-forms/<id>/template to build that template. ' +
      'A submission upserts a CRM lead by phone whenever a phone is present. Pass publish:true to make it live immediately. Returns the form with its public slug (URL /f/<slug>).',
    inputSchema: {
      name: z.string().describe('Form name.'),
      description: z.string().optional(),
      formType: z.enum(['link', 'whatsapp']).optional().describe('How it will be shared. Default "link".'),
      fields: z.array(z.record(z.any())).optional().describe('The form fields (see description for shape).'),
      successMessage: z.string().optional().describe('Thank-you message shown after submit.'),
      defaultSource: z.string().optional().describe('Lead source to tag submissions with.'),
      publish: z.boolean().optional().describe('Publish immediately (default false = draft).'),
    },
  }, run((a) => mcpService.createLeadForm(a)));

  server.registerTool('list_lead_forms', {
    title: 'List lead forms',
    description: 'List all lead-capture forms with their status, slug and submission counts.',
    inputSchema: {},
  }, run(() => mcpService.listLeadForms()));

  server.registerTool('list_form_submissions', {
    title: 'List lead-form submissions',
    description: 'List the collected responses for one lead form (paginated), each with its answers + the matched lead.',
    inputSchema: {
      formId: z.union([z.string(), z.number()]).describe('Form id from list_lead_forms.'),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
    },
  }, run((a) => mcpService.listFormSubmissions(a)));

  /* projects — the campaign folder something is filed under */
  server.registerTool('list_projects', {
    title: 'List projects',
    description:
      'List the campaign projects (folders) in this workspace, each with a count of the templates, automations, AI agents, follow-up sequences and forms filed under it. ' +
      'Pass projectId to open one project and get the actual items inside it. Use this to resolve a project NAME the user said into the id move_to_project needs — never guess an id.',
    inputSchema: {
      projectId: z.union([z.string(), z.number()]).optional().describe('Open one project and list what it holds. Omit to list every project.'),
    },
  }, run((a) => mcpService.listProjects(a)));

  server.registerTool('move_to_project', {
    title: 'Move items into a project',
    description:
      'File one or more items into a campaign project, or take them out of one. ' +
      "kind is 'template' | 'automation' | 'agent' | 'followup' | 'form' ('form' = a lead-capture form from list_lead_forms). " +
      'ids[] are that kind\'s ids — resolve them first with list_lead_forms / list_templates / list_agents / forgechat_request, never guess. ' +
      'Pass projectId to file them there (get it from list_projects), or projectId null to unfile them. ' +
      'This ONLY changes which folder the items are listed under: nothing is created, edited, published, activated or sent, and no customer is contacted.',
    inputSchema: {
      kind: z.enum(['template', 'automation', 'agent', 'followup', 'form']).describe('What kind of item is being moved.'),
      ids: z.array(z.union([z.string(), z.number()])).describe('Ids of the items to move.'),
      projectId: z.union([z.string(), z.number()]).nullable().optional().describe('Target project id from list_projects. null (or omitted) removes them from their current project.'),
    },
  }, run((a) => mcpService.moveToProject(a)));

  /* AI Academy funnel: leads / marketing / BDA */
  server.registerTool('list_leads', {
    title: 'List funnel leads',
    description: "List leads from the Marketing/Sales funnel. Filter by stage (a configurable funnel stage key — call GET /funnel/config for the current set; defaults are new/contacted/engaged/hot/enrolled/cold_lost), by a saved view (view='hot' = leads that arrived within the last 24h; 'unassigned'), or by a name/number/email search. Returns id, name, whatsappNumber, stage, source, assignedUserName, createdAt.",
    inputSchema: {
      stage: z.string().optional().describe('Funnel stage key (configurable — see GET /funnel/config).'),
      view: z.enum(['hot', 'unassigned']).optional().describe("Saved view: 'hot' = arrived within the last 24 hours."),
      search: z.string().optional().describe('Partial match on name, WhatsApp number, or email.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, run(({ stage, search, limit, view }) => mcpService.listLeads({ stage, search, limit, view })));

  server.registerTool('move_lead_stage', {
    title: 'Move a lead to a new funnel stage',
    description: 'Change a lead\'s funnel stage (e.g. move it to "hot" or "enrolled"). Logs the change to the lead timeline. Confirm the lead + target stage with the user first.',
    inputSchema: {
      leadId: z.union([z.string(), z.number()]).describe('Lead id (from list_leads).'),
      stage: z.string().describe('Target funnel stage key (configurable — see GET /funnel/config).'),
    },
  }, run(({ leadId, stage }) => mcpService.moveLeadStage(leadId, stage)));

  server.registerTool('get_campaign_performance', {
    title: 'Get ad campaign performance',
    description: 'Get spend/leads/cost-per-lead for one campaign (by campaignId) or the most recent 100 campaigns if omitted. Covers both manually-entered and Meta-Ads-synced campaigns.',
    inputSchema: { campaignId: z.union([z.string(), z.number()]).optional().describe('Omit to list recent campaigns.') },
  }, run(({ campaignId }) => mcpService.getCampaignPerformance({ campaignId })));

  server.registerTool('list_webinars', {
    title: 'List webinar batches',
    description: 'List webinar/batch schedule with registrations, attendance %, and hot-lead counts.',
    inputSchema: {},
  }, run(() => mcpService.listWebinars()));

  server.registerTool('get_bda_activity', {
    title: 'Get BDA leaderboard + activity',
    description: 'Get the BDA conversion leaderboard (leads handled/converted) plus recent raw activity log entries, optionally scoped to one BDA id.',
    inputSchema: {
      bdaId: z.union([z.string(), z.number()]).optional().describe('Team member id (from a leaderboard row) to scope activity to just that BDA.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, run(({ bdaId, limit }) => mcpService.getBdaActivity({ bdaId, limit })));

  /* courses + payments */
  server.registerTool('list_products', {
    title: 'List products',
    description: 'List the product catalog — a product is anything sold: a course, a consulting engagement, a template pack, a webinar. Each carries its optional default (headline) price plus its payment links with price, paid count and revenue. Amounts are in rupees; defaultPriceRupees is null when no default price is set.',
    inputSchema: {},
  }, run(() => mcpService.listCourses()));

  server.registerTool('get_product_revenue', {
    title: 'Get product revenue',
    description: 'Revenue, paid count and failed count per product, plus payments that matched no product, plus the overall total. Amounts are in rupees. Use this for "how much has product X made" / "which product sells best".',
    inputSchema: {},
  }, run(() => mcpService.getCourseRevenue()));

  server.registerTool('list_payments', {
    title: 'List payments',
    description: 'The Razorpay payment ledger, one row per payer (all their attempts grouped), newest first. Each row links back to the matched CRM lead/contact where Razorpay data allowed a match. Use state="failed" to find people who tried to pay and could not — the follow-up list. Amounts are in rupees.',
    inputSchema: {
      state: z.enum(['paid', 'failed', 'refunded', 'pending']).optional().describe('Filter by outcome. "failed" = attempted but never succeeded (follow-up list).'),
      courseId: z.union([z.string(), z.number()]).optional().describe('Product id from list_products, or "none" for payments that matched no product.'),
      search: z.string().optional().describe('Partial match on payer email, phone, order id, or matched lead/contact name.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
    },
  }, run(({ state, courseId, search, limit }) => mcpService.listPayments({ state, courseId, search, limit })));

  /* full access: generic proxy + catalog + bulk broadcast */
  server.registerTool('list_endpoints', {
    title: 'List callable ForgeChat endpoints',
    description: 'Show which ForgeChat API areas are enabled for this connector and the main endpoints in each, so you know what forgechat_request can call. Call this first when the user asks to do something not covered by a dedicated tool.',
    inputSchema: {},
  }, async () => ok(mcpService.listEndpoints(capabilities)));

  server.registerTool('forgechat_request', {
    title: 'Call any ForgeChat API (admin)',
    description:
      'Generic authenticated call to ANY ForgeChat endpoint in an ENABLED area (full admin access) — use for anything without a dedicated tool: contacts, tags, broadcasts, automations, pipelines, users, accounts, dashboard, etc. ' +
      'Call list_endpoints first to see enabled areas + paths. path is like "/contacts" or "/broadcasts/12/send". Returns { status, ok, body }. ' +
      'Disabled areas and /mcp + /auth paths are refused. For broadcasting to an uploaded contact list, prefer send_bulk_message.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method.'),
      path: z.string().describe('API path under /api, e.g. "/contacts?waNumber=..." or "/broadcasts".'),
      query: z.record(z.any()).optional().describe('Query params as an object (alternative to inlining them in path).'),
      body: z.record(z.any()).optional().describe('JSON body for POST/PUT/PATCH/DELETE.'),
    },
  }, async (args) => {
    try { return ok(await mcpService.proxyRequest(args || {}, capabilities)); }
    catch (err) { return fail(err.message || 'Proxy request failed'); }
  });

  server.registerTool('send_bulk_message', {
    title: 'Broadcast to an uploaded contact list',
    description:
      'Send a WhatsApp broadcast to an explicit list of recipients — the flow behind "upload a sheet in chat and message everyone in it". ' +
      'Parse the uploaded sheet yourself into recipients[] ({ number, name?, variables? }). ' +
      'You MUST pass fromNumber (ask the user which business number). For a fresh/cold list use messageType "template" with an APPROVED templateId (free-form text only reaches people who messaged in the last 24h). ' +
      'Per-recipient template variables come from each row\'s variables[] (in {{1}},{{2}} order). Creates a tracked broadcast (visible in the Bulk Message page) and saves the people as contacts by default.',
    inputSchema: {
      fromNumber: z.string().describe('Business WhatsApp number to send FROM. Ask the user.'),
      messageType: z.enum(['template', 'text']).optional().describe('Default "template". Use template for cold/imported lists.'),
      templateId: z.union([z.string(), z.number()]).optional().describe('Approved template id (required for template). Confirm via get_template first.'),
      text: z.string().optional().describe('Text body (text mode only). Supports {{name}} and {{number}}. Only reaches people within the 24h window.'),
      name: z.string().optional().describe('Broadcast name shown in the UI.'),
      saveContacts: z.boolean().optional().describe('Save the uploaded people as CRM contacts (default true).'),
      recipients: z.array(z.union([
        z.string(),
        z.object({
          number: z.string().describe('Phone number (any format).'),
          name: z.string().optional(),
          variables: z.array(z.string()).optional().describe('Template body values for this row in {{1}},{{2}} order.'),
        }).passthrough(),
      ])).min(1).describe('The recipients from the uploaded sheet.'),
    },
  }, run((a) => mcpService.sendBulkMessage(a)));

  /* mutations */
  server.registerTool('create_agent', {
    title: 'Create agent',
    description:
      'Create a new ForgeChat AI agent. Gather + CONFIRM all settings with the user first. For an ACTIVE agent pass aiModelId + llmModel; otherwise status:"draft". Only one active agent per WhatsApp number. After creating, use add_google_sheets_tool to attach a Sheets tool if wanted.',
    inputSchema: {
      name: z.string(),
      systemPrompt: z.string(),
      aiModelId: z.union([z.string(), z.number()]).optional(),
      llmModel: z.string().optional(),
      waAccountId: z.union([z.string(), z.number()]).optional(),
      status: z.enum(['draft', 'active']).optional(),
      isActive: z.boolean().optional(),
      contextWindowMessages: z.number().int().min(1).max(100).optional(),
      maxToolIterations: z.number().int().min(1).max(20).optional(),
      transcribeAudio: z.boolean().optional(),
      acceptImages: z.boolean().optional(),
      triggerMode: z.enum(['any', 'keyword']).optional(),
      triggerKeyword: z.string().optional(),
      triggerMatchType: z.enum(['exact', 'contains', 'starts']).optional(),
      triggerCaseSensitive: z.boolean().optional(),
      triggerSessionMinutes: z.number().int().min(1).max(1440).optional(),
      mediaGroups: z.array(mediaGroupSchema).optional(),
    },
  }, run((a) => agentService.createAgent(a)));

  server.registerTool('update_agent', {
    title: 'Update agent',
    description: 'Update an agent. Only fields you pass change. Same validation as create_agent.',
    inputSchema: {
      id: z.union([z.string(), z.number()]),
      name: z.string().optional(),
      systemPrompt: z.string().optional(),
      aiModelId: z.union([z.string(), z.number()]).nullable().optional(),
      llmModel: z.string().nullable().optional(),
      waAccountId: z.union([z.string(), z.number()]).nullable().optional(),
      status: z.enum(['draft', 'active']).optional(),
      isActive: z.boolean().optional(),
      contextWindowMessages: z.number().int().min(1).max(100).optional(),
      maxToolIterations: z.number().int().min(1).max(20).optional(),
      transcribeAudio: z.boolean().optional(),
      acceptImages: z.boolean().optional(),
      triggerMode: z.enum(['any', 'keyword']).optional(),
      triggerKeyword: z.string().optional(),
      triggerMatchType: z.enum(['exact', 'contains', 'starts']).optional(),
      triggerCaseSensitive: z.boolean().optional(),
      triggerSessionMinutes: z.number().int().min(1).max(1440).optional(),
      mediaGroups: z.array(mediaGroupSchema).optional(),
    },
  }, run(({ id, ...patch }) => agentService.updateAgent(id, patch)));

  server.registerTool('add_google_sheets_tool', {
    title: 'Add Google Sheets tool',
    description: 'Attach a Google Sheets tool to an agent. Use search_spreadsheets + list_sheet_tabs first so the user picks a real spreadsheet + tab, and ask which ops to allow.',
    inputSchema: {
      agentId: z.union([z.string(), z.number()]),
      spreadsheetId: z.string(),
      spreadsheetName: z.string().optional(),
      sheetName: z.string(),
      ops: z.array(z.enum(['read', 'append', 'update', 'upsert'])).min(1),
    },
  }, run(({ agentId, spreadsheetId, spreadsheetName, sheetName, ops }) =>
    agentService.addTool(agentId, {
      toolType: 'google_sheets',
      config: { spreadsheet_id: spreadsheetId, spreadsheet_name: spreadsheetName || null, sheet_name: sheetName, ops },
    })));

  server.registerTool('add_http_tool', {
    title: 'Add HTTP request tool',
    description:
      'Attach an HTTP-request tool so the agent can call an external system (device/hardware API, webhook, internal service) during a chat. ' +
      'You set a fixed method + URL + static headers (for auth); the agent\'s AI fills the declared params at call time. ' +
      'Path params replace {name} in the URL, query params append to the URL, body params build the JSON body, header params become request headers. ' +
      'Confirm the endpoint + params with the user before adding.',
    inputSchema: {
      agentId: z.union([z.string(), z.number()]),
      label: z.string().describe('Short action name, e.g. "Turn on smart light".'),
      description: z.string().describe('When the AI should call this tool — the model reads this to decide. Be specific.'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method.'),
      url: z.string().describe('Endpoint URL. Use {name} to insert a path parameter, e.g. https://api.io/devices/{device_id}/state'),
      headers: z.array(z.object({ k: z.string(), v: z.string() })).optional().describe('Static headers sent on every call (auth tokens etc.).'),
      params: z.array(z.object({
        name: z.string().describe('Identifier (letters/numbers/underscore).'),
        in: z.enum(['path', 'query', 'body', 'header']).describe('Where the value goes.'),
        type: z.enum(['string', 'number', 'boolean']).optional(),
        description: z.string().optional().describe('What the value means — the AI reads this.'),
        required: z.boolean().optional(),
      })).optional().describe('Values the AI fills when calling the tool.'),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
    },
  }, run(({ agentId, label, description, method, url, headers, params, timeoutMs }) =>
    agentService.addTool(agentId, {
      toolType: 'http_request',
      config: { label, description, method, url, headers: headers || [], params: params || [], timeout_ms: timeoutMs || 10000 },
    })));

  server.registerTool('add_tool', {
    title: 'Add tool (generic)',
    description: 'Attach a tool by raw toolType + config. Prefer add_google_sheets_tool for Sheets and add_http_tool for HTTP. Supported toolTypes: "google_sheets", "http_request".',
    inputSchema: {
      agentId: z.union([z.string(), z.number()]),
      toolType: z.string(),
      config: z.record(z.any()),
      isEnabled: z.boolean().optional(),
    },
  }, run(({ agentId, toolType, config, isEnabled }) =>
    agentService.addTool(agentId, { toolType, config, isEnabled })));

  server.registerTool('update_tool', {
    title: 'Update tool',
    description: "Update an agent tool's config or enabled flag.",
    inputSchema: {
      agentId: z.union([z.string(), z.number()]),
      toolId: z.union([z.string(), z.number()]),
      config: z.record(z.any()).optional(),
      isEnabled: z.boolean().optional(),
    },
  }, run(({ agentId, toolId, config, isEnabled }) =>
    agentService.updateTool(agentId, toolId, { config, isEnabled })));

  server.registerTool('delete_tool', {
    title: 'Delete tool',
    description: 'Remove a tool from an agent. Confirm with the user first.',
    inputSchema: { agentId: z.union([z.string(), z.number()]), toolId: z.union([z.string(), z.number()]) },
  }, run(({ agentId, toolId }) => agentService.deleteTool(agentId, toolId)));

  server.registerTool('delete_agent', {
    title: 'Delete agent',
    description: 'Delete an agent entirely. Destructive — confirm with the user first.',
    inputSchema: { id: z.union([z.string(), z.number()]) },
  }, run(({ id }) => agentService.deleteAgent(id)));

  /* prompt */
  server.registerPrompt('create-forgechat-agent', {
    title: 'Create a ForgeChat agent',
    description: 'Guided flow to create and configure a ForgeChat WhatsApp AI agent.',
    argsSchema: {},
  }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: GUIDE } }] }));

  return server;
}

// Express handler. Stateless: new server+transport per POST.
// Two ways in, deliberately kept side by side:
//
//   1. OAuth bearer token  — /api/mcp with `Authorization: Bearer …`. What
//      Claude's connector dialog produces once a Client ID/Secret is set up.
//   2. Key in the URL      — /api/mcp/http/<key>. The original scheme, kept so
//      every already-installed connector keeps working. Deprecated: it puts a
//      long-lived credential in a URL, where it ends up in history and logs.
//
// ⚠ A 401 from the OAuth path MUST carry WWW-Authenticate pointing at the
// protected-resource metadata (RFC 9728). Without that header the client has no
// way to discover the authorization server and simply reports that the
// connector failed, with nothing to act on.
async function mcpHttpHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This is a stateless MCP server — use POST.' },
      id: null,
    });
  }

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  let capabilities, categories;

  if (bearer) {
    const { verifyAccessToken, resourceUrl } = require('./routes/mcpOAuth');
    const unauthorized = (desc) => {
      res.set('WWW-Authenticate',
        `Bearer realm="ForgeGrowth MCP", error="invalid_token", error_description="${desc}", ` +
        `resource_metadata="${baseFromReq(req)}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({
        jsonrpc: '2.0', error: { code: -32001, message: desc }, id: null,
      });
    };
    const v = await verifyAccessToken(bearer, resourceUrl(req)).catch(() => ({ ok: false, reason: 'error' }));
    if (!v.ok) {
      return unauthorized({
        missing: 'No access token supplied.',
        unknown: 'That access token is not recognised.',
        revoked: 'That access token has been revoked.',
        expired: 'That access token has expired.',
        // Distinct message on purpose: a token that is valid but minted for a
        // different resource is a confused-deputy attempt, not an expiry.
        audience: 'That token was issued for a different resource.',
        client_disabled: 'The connector this token belongs to has been disabled.',
      }[v.reason] || 'Token could not be validated.');
    }
    // Capabilities stay GLOBAL (mcp_settings), never per-token: an admin
    // turning a capability off must apply instantly to every already-connected
    // client, including ones holding a token minted before the change.
    const settings = await mcpService.loadSettings();
    if (!settings.masterEnabled) {
      return res.status(403).json({
        jsonrpc: '2.0', error: { code: -32001, message: 'MCP access is turned off.' }, id: null,
      });
    }
    ({ capabilities, categories } = settings);
  } else {
    try {
      ({ capabilities, categories } = await mcpService.validateKey(req.params.key));
    } catch (err) {
      // No key in the path AND no bearer → this is a connector probing for
      // OAuth. Answer with the challenge so it can discover the AS, rather
      // than a bare 401 it cannot act on.
      if (!req.params.key) {
        res.set('WWW-Authenticate',
          `Bearer realm="ForgeGrowth MCP", ` +
          `resource_metadata="${baseFromReq(req)}/.well-known/oauth-protected-resource"`);
      }
      return res.status(err.status || 401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: err.message || 'Unauthorized' },
        id: null,
      });
    }
  }

  const server = buildServer({ capabilities, categories });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcpHttp] error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

module.exports = { mcpHttpHandler };
