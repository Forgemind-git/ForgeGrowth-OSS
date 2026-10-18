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
const { publicOrigin } = require('./util/publicUrl');
const { automationToolDescription } = require('./services/flowAuthoring');
const { ROUTE_TOOLS, buildInputSchema } = require('./services/mcpRouteTools');
const { runRouteTool } = require('./services/mcpRouteToolRunner');

// The public address of this install. Resolved by util/publicUrl so the URL in
// a WWW-Authenticate challenge is the same string the plugin download and the
// OAuth metadata use — a client that is sent to a different host than the one
// that issued its token reports a credentials error, not an address one.
const baseFromReq = publicOrigin;

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

/**
 * Every agent setting an MCP client may send, shared by create_agent and
 * update_agent so the two cannot offer different fields — they used to be two
 * hand-typed copies, and both had fallen 15 fields behind `agentService`.
 *
 * ⚠ WHAT IS DELIBERATELY ABSENT: `triggerStageKeys` / `triggerTagIds`, the
 * funnel gate deciding WHICH leads an agent is allowed to answer.
 * `agentService.canSetFunnelTrigger()` is default-deny and refuses any caller
 * that does not identify an admin actor — MCP does not — so listing them here
 * would offer a control that saves cleanly and then does nothing at all
 * (anti-pattern #20). It is a web-app decision; the tool description says so.
 *
 * ⚠ NULL vs OMITTED is load-bearing on every limit: omitted leaves the stored
 * value alone, null clears it. Collapsing them would make a rename wipe an
 * agent's ceilings. `.nullable().optional()` is what expresses both.
 */
function agentFields() {
  const lim = (max, desc) => z.number().int().min(0).max(max).nullable().optional().describe(`${desc} Omit to leave unchanged, null or 0 for no limit.`);
  return {
    name: z.string().optional(),
    systemPrompt: z.string().optional().describe('The persona and instructions — this IS the agent.'),
    aiModelId: z.union([z.string(), z.number()]).nullable().optional().describe('Credential id from list_models. Required (with llmModel) before it can be active.'),
    llmModel: z.string().nullable().optional().describe('A models[].value from list_models.'),
    waAccountId: z.union([z.string(), z.number()]).nullable().optional().describe('WhatsApp number id from list_wa_accounts.'),
    status: z.enum(['draft', 'active']).optional(),
    isActive: z.boolean().optional(),
    contextWindowMessages: z.number().int().min(1).max(100).optional().describe('How many past messages the agent sees.'),
    maxToolIterations: z.number().int().min(1).max(20).optional().describe('How many tool calls it may chain in one reply.'),

    /* what it can understand */
    transcribeAudio: z.boolean().optional().describe('Understand voice notes (transcribed, billed per minute). Off by default.'),
    acceptImages: z.boolean().optional().describe('See images — needs a vision-capable model. Off by default.'),
    maxVoiceSeconds: lim(3600, 'Longest voice note it will transcribe, in seconds; a longer one is not transcribed and the agent asks for a shorter one instead of guessing.'),
    maxImagesPerConversation: lim(1000, 'Images it will look at per conversation. WhatsApp delivers each photo as its own message, so this is per CONVERSATION, not per message.'),

    /* when it engages */
    triggerMode: z.enum(['any', 'keyword']).optional(),
    triggerKeyword: z.string().optional(),
    triggerMatchType: z.enum(['exact', 'contains', 'starts']).optional(),
    triggerCaseSensitive: z.boolean().optional(),
    triggerSessionMinutes: z.number().int().min(1).max(1440).optional().describe('Silence that ends a conversation, in minutes. Also how "one conversation" is measured for the limits below.'),

    /* usage ceilings — all optional, all unlimited by default */
    maxRepliesPerConversation: lim(500, 'Replies in one sitting before it stops.'),
    maxRepliesPerMinute: lim(500, 'Burst throttle. Nothing is sent and nothing is recorded — the skipped message still reaches the model as context on the next reply.'),
    maxRunsPerDay: lim(10000, 'Replies across ALL conversations in a day (IST). Guards against a broadcast backfire; silent to customers because it fires everywhere at once.'),
    quotaReplies: lim(10000, 'Replies one person may have over a rolling window — a ceiling that refills on a CLOCK, unlike maxRepliesPerConversation which refills the moment they go quiet.'),
    quotaConversations: lim(1000, 'Separate conversations one person may start in the window. Only ever refuses a NEW sitting, never cuts someone off mid-conversation.'),
    quotaWindowValue: z.number().int().min(1).max(999).optional().describe('Length of the rolling window (default 1).'),
    quotaWindowUnit: z.enum(['minutes', 'hours', 'days']).optional().describe('Unit of the rolling window (default days).'),
    limitHandoff: z.boolean().optional().describe('On hitting a per-conversation limit, pause the bot and leave the chat for a person. Default ON — someone who asked that many questions is usually interested.'),
    quotaHandoff: z.boolean().optional().describe('Same, for the rolling allowance. Default OFF — "come back tomorrow" is not a reason to push everyone into the inbox.'),
    limitReachedMessage: z.string().nullable().optional().describe('One closing line sent when a limit stops it. Empty means send nothing — there is no hidden fallback.'),

    /* testing */
    testNumbers: z.array(z.object({
      number: z.string().describe('Any format — stored digits-only and matched on the last 10.'),
      label: z.string().optional(),
    })).optional().describe('Numbers that can exercise this agent while it is still a DRAFT. They are also exempt from every limit above and their runs are excluded from the counts, so a day of testing does not eat the real budget. Triggers and funnel gating still apply.'),

    mediaGroups: z.array(mediaGroupSchema).optional(),
  };
}

const GUIDE = `This is ForgeGrowth — an AI Academy Marketing/Sales lead funnel with a WhatsApp Chats layer underneath it. Before assuming this is purely an agent-builder: if the user wants to inspect or act on leads, campaigns, or webinars, use the funnel tools directly (list_leads, move_lead_stage, get_campaign_performance, list_webinars, or forgechat_request for anything else in an enabled area) — you do NOT need to build an agent for that.

Social (Instagram, Facebook, Threads, YouTube, LinkedIn) has its own social_* tools: analytics and the content library (social_get_overview, social_get_platform_stats, social_list_posts), the inbox (social_list_messages, social_list_comments), Instagram automations and flows (social_list_automations, social_create_automation, social_list_flows, social_get_flow, social_create_flow — always create with active:false and switch on after the user confirms) and Social AI agents (social_list_agents, social_create_agent). Marketing reads: get_marketing_overview, get_click_to_whatsapp, get_campaign_roi. Sales reads: list_sales, get_payments_trend, get_funnel.

You can also CONFIGURE the whole app from a plain-language "game plan": get a poster into the Media Library (upload_media with a public url, or list_media by name for one the user already uploaded in the web app), create + submit a WhatsApp template for Meta approval (create_template → submit_template → sync_template), build an automation flow (ALWAYS validate_automation on the graph first, then create_automation — it lands as a draft and update_automation{active:true} takes it live after a second check; get_automation_runs says what a flow actually did), generate a click-to-chat link (create_wa_link), and send/broadcast (send_message, send_template, send_media, send_bulk_message). ALWAYS summarise what you will do and get the user's explicit confirmation before any create/submit/send step.
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

8b. Ask about USAGE LIMITS before confirming — every one defaults to unlimited, so an agent with none set will answer one person forever. Offer maxRepliesPerConversation (one sitting), quotaReplies + quotaWindowValue/quotaWindowUnit (a per-person allowance that refills on a clock), maxRepliesPerMinute (burst) and maxRunsPerDay (a broadcast backfire). Offer testNumbers too: those can talk to the agent while it is still a draft, are exempt from every limit, and their runs do not count against the budget.

Notes: an ACTIVE agent needs both aiModelId and llmModel (otherwise save status:"draft"). Only one active agent per WhatsApp number. Always confirm destructive actions (delete) first. Which funnel stages or tags an agent may answer is admin-only and can only be set in the web app.`;

function registerRouteTools(server, handlerFor) {
  for (const spec of ROUTE_TOOLS) {
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: buildInputSchema(z, spec.params),
      ...(spec.kind === 'read' ? { annotations: { readOnlyHint: true } } : {}),
      ...(spec.kind === 'delete' ? { annotations: { destructiveHint: true } } : {}),
    }, handlerFor(spec));
  }
}

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

  /* config: media / templates / automations / wa-links */
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
    // GENERATED from services/flowAuthoring.js, which builds it out of the same
    // expectedHandles() the validator gates on. Hand-written prose here is what
    // let the documented handle vocabulary drift from the canvas.
    description: automationToolDescription(),
    inputSchema: {
      name: z.string().describe('Automation name.'),
      description: z.string().optional(),
      triggerType: z.string().optional().describe('Mirrors the trigger node\'s kind, e.g. "keyword".'),
      status: z.enum(['draft', 'active']).optional().describe('Always created as a draft; activating runs a separate check via PUT /chatbots/:id.'),
      nodes: z.array(z.record(z.any())).optional().describe('Flow nodes. Do not send x/y — they are assigned automatically.'),
      edges: z.array(z.record(z.any())).optional().describe('Flow edges: { from, to, fromHandle }.'),
      config: z.record(z.any()).optional().describe('Full { nodes, edges } config (alternative to passing nodes/edges separately).'),
      allowIncomplete: z.boolean().optional().describe('Save a knowingly-unfinished draft even if the check finds blocking problems. Default false.'),
    },
  }, run((a) => mcpService.createAutomation(a)));

  server.registerTool('validate_automation', {
    title: 'Check an automation flow',
    // Exists because the only previous way to learn a flow was broken was to
    // CREATE it and look in the builder — so a wrong graph became a real row
    // somebody had to find and delete. Checking first is free.
    description:
      'Check a flow graph WITHOUT saving it, or check an existing automation by id. Returns blocking[] (would be broken at ' +
      'runtime — the flow cannot go live), warnings[] (unfinished but harmless) and danglingConnections[] (an edge naming an ' +
      'output the step does not have — the commonest hand-authoring mistake, and invisible on the canvas). Run this before ' +
      'create_automation, and after editing a flow through forgechat_request.',
    inputSchema: {
      automationId: z.union([z.string(), z.number()]).optional().describe('Check a saved automation instead of a graph.'),
      nodes: z.array(z.record(z.any())).optional(),
      edges: z.array(z.record(z.any())).optional(),
      config: z.record(z.any()).optional().describe('Full { nodes, edges } config.'),
    },
  }, run((a) => mcpService.validateAutomation(a)));

  server.registerTool('update_automation', {
    title: 'Update or activate an automation',
    description:
      'Edit a saved automation: rename it, replace its flow graph, or ACTIVATE it. ' +
      'Activating runs the same check as the app and refuses a flow that would be broken. ' +
      'An active flow replies to real customers immediately — always confirm with the user before setting active:true.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('Automation id from list_automations / create_automation.'),
      name: z.string().optional(),
      description: z.string().optional(),
      active: z.boolean().optional().describe('true = go live (checked first), false = pause it.'),
      nodes: z.array(z.record(z.any())).optional().describe('Replaces the whole node list.'),
      edges: z.array(z.record(z.any())).optional().describe('Replaces the whole edge list.'),
      config: z.record(z.any()).optional().describe('Full { nodes, edges } config.'),
    },
  }, run((a) => mcpService.updateAutomation(a)));

  server.registerTool('list_automations', {
    title: 'List automations',
    description: 'List the automation flows with their status and trigger. Pass an id to read one back in full, including its nodes/edges graph.',
    inputSchema: { id: z.union([z.string(), z.number()]).optional().describe('Read one automation in full.') },
  }, run((a) => mcpService.listAutomations(a)));

  server.registerTool('get_automation_runs', {
    title: 'Read automation runs',
    description:
      'Read what an automation actually DID — one row per run, each with the steps it visited, their input/output and any error. ' +
      'When a user says a flow "did not work", read this before theorising: it usually names the step and the reason.',
    inputSchema: {
      automationId: z.union([z.string(), z.number()]).describe('Automation id.'),
      executionId: z.union([z.string(), z.number()]).optional().describe('One run in full, with every step.'),
      status: z.enum(['success', 'error', 'running', 'queued', 'paused', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, run((a) => mcpService.getAutomationRuns(a)));

  server.registerTool('create_wa_link', {
    title: 'Create a click-to-chat link',
    description: 'Create a tracked wa.me click-to-chat link that opens a chat with a business number, optionally pre-filled with a message. Returns the short link + slug.',
    inputSchema: {
      name: z.string().describe('Link name (for your reference).'),
      accountId: z.union([z.string(), z.number()]).describe('WhatsApp account id (from list_wa_accounts) — its phone number is used.'),
      message: z.string().optional().describe('Pre-filled message text the user starts the chat with.'),
    },
  }, run((a) => mcpService.createWaLink(a)));

  /* AI Academy funnel: leads / marketing / BDA */
  server.registerTool('list_leads', {
    title: 'List funnel leads',
    description: "List leads from the Marketing/Sales funnel. Filter by stage (a configurable funnel stage key — call GET /funnel/config for the current set; defaults are new/contacted/engaged/hot/enrolled/cold_lost), by a saved view (view='hot' = leads that arrived within the last 24h; 'unassigned'), or by a name/number/email search. COUNTING: the response carries `total` (how many match the filters, IGNORING the page limit), `returned` (rows in this response), `truncated`, and `byStage` (counts per funnel stage under the same filters). Answer \"how many leads\" from `total` and \"how many are hot/enrolled\" from `byStage` — never from the length of the `leads` array, which is capped at `limit` (default 50). There is no need to raise `limit` just to count. `leads` holds id, name, whatsappNumber, stage, source, assignedUserName, createdAt. SCOPE: `waAccount` limits the result to leads that have actually messaged ONE of our business WhatsApp numbers (id, phone number, or exact display name from list_wa_accounts). Several businesses share this funnel, so an unscoped count spans all of them. Leave it out only when the user genuinely wants every number.",
    inputSchema: {
      stage: z.string().optional().describe('Funnel stage key (configurable — see GET /funnel/config).'),
      view: z.enum(['hot', 'unassigned']).optional().describe("Saved view: 'hot' = arrived within the last 24 hours."),
      search: z.string().optional().describe('Partial match on the LEAD\'s name, WhatsApp number, or email — not our business number (see waAccount for that).'),
      waAccount: z.union([z.string(), z.number()]).optional().describe('Limit to leads that have messaged this business WhatsApp number — its id, phone number, or exact display name from list_wa_accounts. Ambiguous names are refused rather than guessed.'),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, run(({ stage, search, limit, view, waAccount }) => mcpService.listLeads({ stage, search, limit, view, waAccount })));

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

  server.registerTool('get_ad_conversions', {
    title: 'Get conversions per Meta ad',
    description: 'Which Meta ad actually produced chats and paying students, measured in ForgeGrowth (not Ads Manager). '
      + 'Per ad id: chats (leads whose FIRST ad touch in the range was this ad — landing page ad_id or click-to-WhatsApp referral), '
      + 'buyers (of those, captured Razorpay payment after the touch, net of refunds, or moved to enrolled), revenue in INR, conversionRate %. '
      + 'Dates are IST YYYY-MM-DD; defaults to the last 30 days. Read-only.',
    inputSchema: {
      from: z.string().optional().describe('Start date, IST, YYYY-MM-DD (inclusive). Default: 29 days before `to`.'),
      to: z.string().optional().describe('End date, IST, YYYY-MM-DD (inclusive). Default: today.'),
      adIds: z.array(z.string()).optional().describe('Limit to these Meta ad ids.'),
    },
    annotations: { readOnlyHint: true },
  }, run(({ from, to, adIds }) => require('./services/adConversions').getAdConversions({ from, to, adIds })));

  server.registerTool('list_webinars', {
    title: 'List webinar batches',
    description: 'List webinar/batch schedule with registrations, attendance %, and hot-lead counts.',
    inputSchema: {},
  }, run(() => mcpService.listWebinars()));

  /* courses + payments */
  // ── Chat Analyzer ──
  // No bulk tool: a bulk run costs money per conversation and nobody is
  // watching when a chat message triggers it. It stays a click in the tab.
  server.registerTool('list_analysed_chats', {
    title: 'List conversations and their analysis',
    description: 'Conversations the Chat Analyzer can read — 1:1 chats and WhatsApp groups — with whatever it has already found. `readSoFar` says which of text/audio/image/document the standing summary actually covers, so "analysed" is never mistaken for "read everything". Filter: all | never | stale | analysed | errors.',
    inputSchema: {
      source: z.enum(['all', 'chat', 'community']).optional().describe('chat = 1:1 conversations, community = WhatsApp groups.'),
      filter: z.enum(['all', 'never', 'stale', 'analysed', 'errors']).optional(),
      search: z.string().optional().describe('Match a name or phone number.'),
      limit: z.number().optional(),
    },
  }, run((a) => mcpService.listAnalysedChats(a)));

  server.registerTool('get_chat_analysis', {
    title: 'Read one conversation\'s analysis',
    description: 'The stored analysis for one conversation, plus `coverage` — how far each modality has been read. Does not analyse anything and costs nothing.',
    inputSchema: {
      source: z.enum(['chat', 'community']).optional(),
      key: z.string().describe('The conversation key from list_analysed_chats.'),
    },
  }, run((a) => mcpService.getChatAnalysis(a)));

  server.registerTool('analyze_chat', {
    title: 'Analyse one conversation',
    description: 'Analyse ONE conversation now and return the verdict. COSTS MONEY: the analysis call is billed by tokens, and each voice note, image or PDF is billed per item the first time it is read (cached and free afterwards). Defaults to text only — add modalities deliberately. A date range or keyword makes the run a one-off that is saved but does NOT replace the conversation\'s standing summary. Use list_analysed_chats first to get the key.',
    inputSchema: {
      source: z.enum(['chat', 'community']).optional(),
      key: z.string().describe('The conversation key from list_analysed_chats.'),
      modalities: z.array(z.enum(['text', 'audio', 'image', 'document'])).optional()
        .describe('What to read. Omit for the workspace default (usually text only). Audio and image cost money per item.'),
      from: z.string().optional().describe('ISO date. Makes this a filtered one-off run.'),
      to: z.string().optional().describe('ISO date.'),
      keyword: z.string().optional().describe('Only messages containing this word. Makes this a filtered one-off run.'),
      incremental: z.boolean().optional().describe('Default true — read only what is new since last time. False re-reads the whole conversation and costs more.'),
    },
  }, run((a) => mcpService.analyzeChat(a)));

  server.registerTool('get_chat_transcript', {
    title: 'Read a conversation word for word',
    description: 'The timestamped transcript of one conversation: text messages as sent, and voice notes as their exact transcript. This is what was SAID — use get_chat_analysis for what it MEANT. Reading costs nothing; voice notes already transcribed are returned free, and any that are not yet appear with notTranscribedYet so you can tell silence from an untranscribed note. Images and documents are listed by timestamp and caption only — their contents are NOT returned.',
    inputSchema: {
      source: z.enum(['chat', 'community']).optional(),
      key: z.string().describe('The conversation key from list_analysed_chats.'),
      from: z.string().optional().describe('ISO date — only messages on or after this.'),
      to: z.string().optional().describe('ISO date — only messages on or before this.'),
      audioOnly: z.boolean().optional().describe('Return only the voice notes, skipping typed messages.'),
    },
  }, run((a) => mcpService.getChatTranscript(a)));

  server.registerTool('list_follow_ups', {
    title: 'Read the follow-up calendar',
    description: 'The follow-ups on the sales calendar (Sales → Follow-up): who we plan to contact on which day, with the note, owner, lead stage and whether it is mirrored to Google Calendar. Defaults to OPEN follow-ups; pass status "done", "cancelled" or "any". Dates are IST calendar days (YYYY-MM-DD).',
    inputSchema: {
      from: z.string().optional().describe('YYYY-MM-DD — only follow-ups due on or after this day.'),
      to: z.string().optional().describe('YYYY-MM-DD — only follow-ups due on or before this day.'),
      status: z.string().optional().describe('open (default) | done | cancelled | any — or a comma list.'),
      contactNumber: z.string().optional().describe('Only this customer (any format; matched on the last 10 digits).'),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  }, run((a) => mcpService.listFollowUpsMcp(a)));

  server.registerTool('set_follow_up', {
    title: 'Put a lead on the follow-up calendar',
    description: 'Schedule a follow-up with a customer on a day (and optionally a time) with a note. A person has at most ONE open follow-up per owner: calling this again RESCHEDULES it rather than adding a duplicate. If Google Calendar sync is on, the event is created there too. Confirm the date with the user first. Use suggest_follow_up_date if they want the AI to pick the day.',
    inputSchema: {
      contactNumber: z.string().describe('The customer\'s WhatsApp number (any format).'),
      dueDate: z.string().describe('YYYY-MM-DD (IST calendar day).'),
      dueTime: z.string().optional().describe('HH:MM 24h IST, only when a time of day matters.'),
      note: z.string().optional().describe('What to say or do on that day.'),
      waNumber: z.string().optional().describe('Our business number the chat is on. Default: the one they last wrote to.'),
      ownerEmail: z.string().optional().describe('Put it on this team member\'s calendar (email or username). Default: whoever the lead is assigned to.'),
    },
  }, run((a) => mcpService.setFollowUpMcp(a)));

  server.registerTool('update_follow_up', {
    title: 'Change or finish a follow-up',
    description: 'Reschedule a follow-up (dueDate/dueTime), change its note, mark it done or cancelled (status), or delete it (remove: true). The id comes from list_follow_ups. Google Calendar events follow the change.',
    inputSchema: {
      id: z.number().int().describe('Follow-up id from list_follow_ups.'),
      dueDate: z.string().optional(),
      dueTime: z.string().nullable().optional().describe('HH:MM, or null to make it an all-day follow-up.'),
      note: z.string().optional(),
      status: z.enum(['open', 'done', 'cancelled']).optional(),
      remove: z.boolean().optional().describe('Delete it entirely.'),
    },
  }, run((a) => mcpService.updateFollowUpMcp(a)));

  server.registerTool('suggest_follow_up_date', {
    title: 'Ask the AI for the next follow-up date',
    description: 'The AI-recommended day (and time, if it matters) for the next follow-up with a customer, with a one-line reason. Reuses the Chat Analyzer\'s suggestion when nothing new has arrived since the last analysis (free); otherwise makes ONE small AI call (costs a little). Does not change the calendar — call set_follow_up to apply it.',
    inputSchema: {
      contactNumber: z.string().describe('The customer\'s WhatsApp number (any format).'),
      waNumber: z.string().optional(),
    },
  }, run((a) => mcpService.suggestFollowUpMcp(a)));

  server.registerTool('transcribe_chat', {
    title: 'Transcribe a conversation\'s voice notes',
    description: 'Transcribe the voice notes in ONE conversation and return every voice note as text. Uses microsoft/mai-transcribe-2 via OpenRouter (multilingual — Tamil, Hindi, English and mixed speech). COSTS MONEY per new note, but each note is transcribed ONCE, ever: notes that already have a transcript are returned free and never re-sent. Call it again if `remaining` is above zero. Use list_analysed_chats first to get the key; use get_chat_transcript afterwards to read the full conversation with these transcripts in place.',
    inputSchema: {
      source: z.enum(['chat', 'community']).optional(),
      key: z.string().describe('The conversation key from list_analysed_chats.'),
      from: z.string().optional().describe('ISO date — only voice notes on or after this.'),
      to: z.string().optional().describe('ISO date — only voice notes on or before this.'),
    },
  }, run((a) => mcpService.transcribeChat(a)));

  // ⚠ NOT wrapped in run(): that formats every result as a JSON text block, which
  // would hand the model a wall of base64 instead of a picture. An image must be
  // returned as a real MCP image block or it is not an image to the model.
  server.registerTool('get_chat_image', {
    title: 'Look at images from a conversation',
    description: 'Returns the actual images a customer sent, so you can see them yourself. FREE — this is a disk read, not a vision model; prefer it over analysing images when you just need to know what one shows. Get the messageId of an image from get_chat_transcript first. Up to 5 per call, images only (video and PDFs are not returned).',
    inputSchema: {
      source: z.enum(['chat', 'community']).optional(),
      key: z.string().describe('The conversation key from list_analysed_chats.'),
      messageIds: z.array(z.string()).describe('messageId values of image entries from get_chat_transcript.'),
    },
  }, async (args) => {
    try {
      const r = await mcpService.getChatImages(args || {});
      const content = [];
      for (const img of r.images) {
        // Context first, then the picture: a bare image with no timestamp or
        // sender cannot be placed in the conversation it came from.
        content.push({ type: 'text', text: `${img.from} · ${new Date(img.at).toISOString()}${img.caption ? ` · caption: ${img.caption}` : ''}` });
        content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
      }
      if (r.skipped.length) {
        content.push({ type: 'text', text: `Not returned:\n${r.skipped.map(x => `- ${x.messageId || '(extra)'}: ${x.reason}`).join('\n')}` });
      }
      if (!content.length) content.push({ type: 'text', text: 'No images were returned.' });
      return { content };
    } catch (err) {
      return fail(err.message || 'Could not read those images');
    }
  });

  server.registerTool('get_chat_analysis_costs', {
    title: 'What analysis has cost',
    description: 'Estimated spend on chat analysis, split by media type, with run counts. Figures are ESTIMATES computed from the workspace rate card — OpenAI reports tokens, never a price.',
    inputSchema: {
      from: z.string().optional().describe('ISO date.'),
      to: z.string().optional().describe('ISO date.'),
    },
  }, run((a) => mcpService.getChatAnalysisCosts(a)));

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
      'Create a new ForgeChat AI agent. Gather + CONFIRM all settings with the user first. For an ACTIVE agent pass aiModelId + llmModel; otherwise status:"draft". ' +
      'Only one active agent per WhatsApp number. After creating, attach tools with add_google_sheets_tool / add_http_tool. ' +
      'Usage limits and the per-person allowance are all OPTIONAL and all default to unlimited — an agent with none set will answer one person forever, so ask whether a ceiling is wanted. ' +
      'Note: which funnel stages or tags an agent is allowed to answer can only be set in the web app — it is an admin-only decision and is ignored here.',
    inputSchema: { ...agentFields(), name: z.string(), systemPrompt: z.string() },
  }, run((a) => agentService.createAgent(a)));

  server.registerTool('update_agent', {
    title: 'Update agent',
    description:
      'Update an agent. ONLY the fields you pass change — omitting a field leaves it alone, so an unrelated edit never wipes a limit. ' +
      'Pass null to clear a limit (0 also clears it; there is no way to express "may send zero replies"). Same validation as create_agent.',
    inputSchema: {
      id: z.union([z.string(), z.number()]),
      ...agentFields(),
      name: z.string().optional(),
      systemPrompt: z.string().optional(),
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

  /* tools declared as data (services/mcpRouteTools.js) — Social, Marketing,
     Sales and the delete/rename tools. The stdio server registers the same
     list from the same file, so the two transports cannot drift. */
  registerRouteTools(server, (spec) => run((args) => runRouteTool(spec.name, args)));

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
