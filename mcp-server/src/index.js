#!/usr/bin/env node
// ForgeChat Agent Builder — MCP server.
//
// A thin, well-described client over the ForgeChat MCP API
// (/api/mcp/v1, bearer-authed). It exposes DISCOVERY tools (so the assistant
// can offer the user their real WhatsApp numbers, models, spreadsheets, tabs,
// media and templates) and MUTATION tools (create/update/delete agents + tools).
//
// The assistant is expected to gather + confirm the full config with the user
// BEFORE calling create_agent — see the `create-forgechat-agent` prompt and the
// tool descriptions.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.FORGECHAT_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.FORGECHAT_API_KEY || '';

if (!API_URL || !API_KEY) {
  console.error('[forgechat-mcp] FORGECHAT_API_URL and FORGECHAT_API_KEY env vars are required.');
  process.exit(1);
}

// One HTTP helper. Surfaces the backend's {error} message verbatim so the
// assistant can relay it and help the user fix the input.
async function call(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// Wrap a handler so thrown errors become a proper MCP tool error result.
function tool(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: 'forgechat-agents', version: '1.0.0' });

/* ============================== discovery ============================== */

server.registerTool('list_wa_accounts', {
  title: 'List WhatsApp accounts',
  description: 'List the WhatsApp business numbers (WABA accounts) an agent can run on. Use this to ask the user which number the agent should use. Returns id, displayName, phoneNumber, isActive, isDefault.',
  inputSchema: {},
}, tool(() => call('GET', '/wa-accounts')));

server.registerTool('list_models', {
  title: 'List AI models',
  description: 'List connected AI model credentials and the selectable model ids for each. Use to ask the user which model the agent should use. Each entry has aiModelId (pass to create_agent), provider, providerLabel, label, and models[] of {value,label} (the value is the llmModel to pass).',
  inputSchema: {},
}, tool(() => call('GET', '/models')));

server.registerTool('search_spreadsheets', {
  title: 'Search Google spreadsheets',
  description: 'Search the connected Google account for spreadsheets (by name). Use when configuring a Google Sheets tool, so the user can pick a real spreadsheet. Returns { spreadsheets: [{ id, name, modifiedTime, ownerEmail }] }. Requires the Google Sheets integration to be connected in ForgeChat.',
  inputSchema: { query: z.string().optional().describe('Optional search term to filter spreadsheets by name.') },
}, tool(({ query }) => call('GET', `/spreadsheets${query ? `?q=${encodeURIComponent(query)}` : ''}`)));

server.registerTool('list_sheet_tabs', {
  title: 'List spreadsheet tabs',
  description: 'List the tabs (sheets) inside a spreadsheet. Call after the user picks a spreadsheet so they can choose which tab the agent should read/write. Returns { id, title, tabs: [{ title, rowCount, columnCount }] }.',
  inputSchema: { spreadsheetId: z.string().describe('The spreadsheet id from search_spreadsheets.') },
}, tool(({ spreadsheetId }) => call('GET', `/spreadsheets/${encodeURIComponent(spreadsheetId)}/tabs`)));

server.registerTool('read_sheet_values', {
  title: 'Read spreadsheet cell values',
  description: 'Read actual cell values from a tab — use this to see the real HEADER ROW and a few sample rows so you can map an agent\'s Sheets logging to the right columns. list_sheet_tabs only returns metadata, NOT contents. Returns { range, headers:[...], rows:[[...]], rowCount }. Pass range "A1:Z1" for just the headers; omit range to read the header + maxRows rows.',
  inputSchema: {
    spreadsheetId: z.string().describe('The spreadsheet id from search_spreadsheets.'),
    tab: z.string().describe('Tab name from list_sheet_tabs.'),
    range: z.string().optional().describe('Optional A1 range (e.g. "A1:Z1" for headers only). Omit to read the header + maxRows rows.'),
    maxRows: z.number().int().min(1).max(500).optional().describe('Soft cap on returned rows (default 50).'),
  },
}, tool(({ spreadsheetId, tab, range, maxRows }) => {
  const qs = new URLSearchParams({ tab: String(tab) });
  if (range) qs.set('range', range);
  if (maxRows != null) qs.set('maxRows', String(maxRows));
  return call('GET', `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values?${qs.toString()}`);
}));

server.registerTool('list_media', {
  title: 'List media library items',
  description: 'List items from the ForgeChat media library, optionally filtered by type and/or name. Returns [{ id, name, mediaType, mimeType }]. When the user mentions a media file by name (e.g. "use the logo image"), call this with that name to resolve it to an id automatically — then use that id in mediaGroups. Never ask the user for an id.',
  inputSchema: {
    type: z.enum(['image', 'video', 'audio', 'document']).optional().describe('Optional media type filter.'),
    name: z.string().optional().describe('Partial name search (case-insensitive). Use when the user mentions a media file by name.'),
  },
}, tool(({ type, name }) => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (name) params.set('name', name);
  const qs = params.toString();
  return call('GET', `/media${qs ? `?${qs}` : ''}`);
}));

server.registerTool('list_templates', {
  title: 'List message templates',
  description: 'List WhatsApp message templates, optionally scoped to a WhatsApp account. Returns [{ id, name, language, status, category, waAccountId }]. When the user mentions a template by name, call this to find it, then call get_template to read its full content before confirming with the user.',
  inputSchema: { waAccountId: z.union([z.string(), z.number()]).optional().describe('Optional WhatsApp account id to scope templates to.') },
}, tool(({ waAccountId }) => call('GET', `/templates${waAccountId != null ? `?waAccountId=${encodeURIComponent(waAccountId)}` : ''}`)));

server.registerTool('get_template', {
  title: 'Get template content',
  description: 'Fetch the full content of a template — body text, header, footer, buttons, and variable samples. Call this after finding a template by name via list_templates. Show the user the template name + body + buttons so they can confirm it is the right one before you use its id in a media group or agent config. Never use a template id without confirming the content first.',
  inputSchema: { id: z.union([z.string(), z.number()]).describe('Template id from list_templates.') },
}, tool(({ id }) => call('GET', `/templates/${encodeURIComponent(id)}`)));

server.registerTool('list_agents', {
  title: 'List agents',
  description: 'List all existing AI agents (with tool counts and last-run time). Use to review or before updating/deleting.',
  inputSchema: {},
}, tool(() => call('GET', '/agents')));

server.registerTool('get_agent', {
  title: 'Get agent',
  description: 'Get one agent in full, including its configured tools[].',
  inputSchema: { id: z.union([z.string(), z.number()]).describe('Agent id.') },
}, tool(({ id }) => call('GET', `/agents/${encodeURIComponent(id)}`)));

/* ====================== conversations: read + reply ==================== */

server.registerTool('list_conversations', {
  title: 'List WhatsApp conversations',
  description:
    'List recent WhatsApp conversations (newest first), optionally for one business number or filtered by name/number. ' +
    'Each row returns the business number it is on (waNumber), the customer number (contactNumber), name, last message + time, unreadCount, ' +
    'and a `window` object { open, secondsRemaining, expiresAt } telling you whether the 24-hour customer-service window is still open. ' +
    'When window.open is false you can only reply with an approved template (send_template), not free-form text (send_message).',
  inputSchema: {
    waNumber: z.string().optional().describe('Only conversations on this business WhatsApp number.'),
    search: z.string().optional().describe('Filter by customer name or number (partial match).'),
    limit: z.number().int().min(1).max(200).optional().describe('Max conversations (default 50).'),
  },
}, tool(({ waNumber, search, limit }) => {
  const p = new URLSearchParams();
  if (waNumber) p.set('waNumber', String(waNumber));
  if (search) p.set('search', String(search));
  if (limit != null) p.set('limit', String(limit));
  const qs = p.toString();
  return call('GET', `/conversations${qs ? `?${qs}` : ''}`);
}));

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
}, tool(({ waNumber, contactNumber, limit, before }) => {
  const p = new URLSearchParams({ waNumber: String(waNumber), contactNumber: String(contactNumber) });
  if (limit != null) p.set('limit', String(limit));
  if (before) p.set('before', String(before));
  return call('GET', `/conversations/messages?${p.toString()}`);
}));

server.registerTool('send_message', {
  title: 'Send a text reply',
  description:
    'Send a free-form TEXT WhatsApp message. You MUST pass fromNumber — the business number to send from. ' +
    'If unsure which number, call list_wa_accounts (or use the conversation waNumber) and ASK THE USER which number to send from. ' +
    'Only works inside the 24-hour customer-service window; otherwise it returns an OUTSIDE_WINDOW error and you must use send_template instead. ' +
    'Check the conversation `window.open` before sending.',
  inputSchema: {
    fromNumber: z.string().describe('The business WhatsApp number to send FROM. Ask the user if unclear.'),
    toNumber: z.string().describe('The customer number to send to.'),
    text: z.string().describe('The message text.'),
  },
}, tool(({ fromNumber, toNumber, text }) => call('POST', '/messages/text', { fromNumber, toNumber, text })));

server.registerTool('send_template', {
  title: 'Send an approved template',
  description:
    'Send an APPROVED WhatsApp template — works any time, including OUTSIDE the 24-hour window (proactive outreach, or when send_message returned OUTSIDE_WINDOW). ' +
    'You MUST pass fromNumber — the business number to send from; ask the user which number if unclear. ' +
    'First call list_templates (filter by waAccountId) + get_template to confirm the template and how many {{n}} variables it needs, then pass the values in order.',
  inputSchema: {
    fromNumber: z.string().describe('The business WhatsApp number to send FROM. The template must be approved on this number.'),
    toNumber: z.string().describe('The customer number to send to.'),
    templateId: z.union([z.string(), z.number()]).describe('Template id from list_templates.'),
    variables: z.array(z.string()).optional().describe('Body variable values in order ({{1}}, {{2}}, …). Omit if the template has none.'),
  },
}, tool(({ fromNumber, toNumber, templateId, variables }) => call('POST', '/messages/template', { fromNumber, toNumber, templateId, variables })));

server.registerTool('send_media', {
  title: 'Send a document / image / video / audio',
  description:
    'Send a file (PDF or other DOCUMENT, image, video, or audio) into a WhatsApp conversation. ' +
    'USE THIS when the user uploads/attaches a file and asks to send it to a number — read the file and pass its bytes as base64 in fileBase64 plus the filename. ' +
    'Pass exactly ONE source: (1) fileBase64 + filename (a file uploaded here); (2) mediaLibraryId from list_media (an existing Media Library item); (3) link (a public https URL). ' +
    'You MUST pass fromNumber — the business number to send from; ask the user if unclear. ' +
    'Only works INSIDE the 24-hour customer-service window; otherwise it returns OUTSIDE_WINDOW and you must use send_template. ' +
    'The media type is auto-detected; only set type to override. For documents pass filename; caption is optional (ignored for audio).',
  inputSchema: {
    fromNumber: z.string().describe('The business WhatsApp number to send FROM. Ask the user if unclear.'),
    toNumber: z.string().describe('The customer number to send to.'),
    fileBase64: z.string().optional().describe('Base64 of the uploaded file (raw base64 or a data: URL). Pair with filename. Use for "send this PDF/file" requests.'),
    filename: z.string().optional().describe('Original file name incl. extension, e.g. "Quotation.pdf". Required with fileBase64.'),
    mimeType: z.string().optional().describe('MIME type of fileBase64 (e.g. application/pdf). Inferred from filename when omitted.'),
    mediaLibraryId: z.union([z.string(), z.number()]).optional().describe('Id from list_media to send an existing Media Library item.'),
    link: z.string().optional().describe('Public https URL to the file.'),
    type: z.enum(['document', 'image', 'video', 'audio']).optional().describe('Override the auto-detected media type.'),
    caption: z.string().optional().describe('Optional caption (image/video/document; ignored for audio).'),
  },
}, tool((args) => call('POST', '/messages/media', args)));

server.registerTool('send_interactive', {
  title: 'Send an interactive message (buttons / list)',
  description:
    'Send a free-form INTERACTIVE WhatsApp message — reply buttons or a list menu — by passing a ready Meta `interactive` object verbatim. ' +
    'You MUST pass fromNumber. Only works INSIDE the 24-hour customer-service window (for proactive interactive prompts use an approved template). ' +
    'Example: { type:"button", body:{ text:"Pick one" }, action:{ buttons:[{ type:"reply", reply:{ id:"yes", title:"Yes" } }] } }.',
  inputSchema: {
    fromNumber: z.string().describe('The business WhatsApp number to send FROM.'),
    toNumber: z.string().describe('The customer number to send to.'),
    interactive: z.record(z.any()).describe('A Meta interactive object (type button or list).'),
  },
}, tool(({ fromNumber, toNumber, interactive }) => call('POST', '/messages/interactive', { fromNumber, toNumber, interactive })));

/* ============ config: media / templates / automations / lead forms ========== */

server.registerTool('upload_media', {
  title: 'Upload media to the Media Library',
  description:
    'Add an image / video / document / audio to the Media Library from an attached file (base64) OR a public URL — the JSON path the multipart upload lacks. ' +
    'USE THIS to get a poster into ForgeChat before a media-header template. Pass exactly ONE of base64 or url. ' +
    'Optionally pass syncToNumber to upload it to that number\'s Meta store immediately. Returns the new media { id, ... } — use its id as headerMediaLibraryId in create_template.',
  inputSchema: {
    base64: z.string().optional().describe('Base64 of an attached file (raw or data: URL). Provide this OR url.'),
    url: z.string().optional().describe('Public URL to fetch the file from. Provide this OR base64.'),
    filename: z.string().optional().describe('File name incl. extension, e.g. "poster.jpg".'),
    mimeType: z.string().optional().describe('MIME type (inferred when omitted).'),
    name: z.string().optional().describe('Display name in the Media Library.'),
    syncToNumber: z.string().optional().describe('Business WhatsApp number to sync the media to Meta for.'),
  },
}, tool((args) => call('POST', '/media-upload', args)));

server.registerTool('create_template', {
  title: 'Create a WhatsApp message template',
  description:
    'Create a template as a DRAFT (does NOT submit — call submit_template next). For a poster header: upload_media first, then pass headerType "IMAGE" + headerMediaLibraryId + whatsappAccountId. ' +
    'Body uses {{1}},{{2}} for variables (provide samples). Confirm the full template with the user before creating.',
  inputSchema: {
    name: z.string().describe('Snake_case name, e.g. "diwali_offer".'),
    body: z.string().describe('Body text. Use {{1}},{{2}} for variables.'),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
    language: z.string().optional().describe('Language code, default "en".'),
    headerType: z.enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional(),
    headerText: z.string().optional().describe('Header text (headerType TEXT only).'),
    headerMediaLibraryId: z.union([z.string(), z.number()]).optional().describe('Media Library id for a media header.'),
    whatsappAccountId: z.union([z.string(), z.number()]).optional().describe('WhatsApp account id (required for a media header + to submit).'),
    footer: z.string().optional(),
    buttons: z.array(z.record(z.any())).optional(),
    samples: z.record(z.any()).optional().describe('Example values for {{n}} variables (required by Meta).'),
  },
}, tool((args) => call('POST', '/templates-create', args)));

server.registerTool('submit_template', {
  title: 'Submit a template to Meta for approval',
  description: 'Submit a DRAFT template to Meta. It must have a WhatsApp account assigned. Poll with sync_template afterwards.',
  inputSchema: { templateId: z.union([z.string(), z.number()]).describe('Template id.') },
}, tool(({ templateId }) => call('POST', '/templates-submit', { templateId })));

server.registerTool('sync_template', {
  title: 'Refresh a template approval status',
  description: 'Poll Meta for a template\'s current status (APPROVED / REJECTED / SUBMITTED). Meta does not push status, so call this to check a submitted template.',
  inputSchema: { templateId: z.union([z.string(), z.number()]).describe('Template id.') },
}, tool(({ templateId }) => call('POST', '/templates-sync', { templateId })));

server.registerTool('create_automation', {
  title: 'Create an automation flow',
  description:
    'Create a WhatsApp automation from a nodes/edges config. Lands INACTIVE. config = { nodes:[...], edges:[...] }: node types trigger|message|condition|action|delay|api|handoff|ai|ai_agent|subflow; edges { from, to, fromHandle? }. ' +
    'Build the flow to match the user\'s described chat flow, confirm it, then create. Activate later via forgechat_request PUT /chatbots/:id.',
  inputSchema: {
    name: z.string(),
    description: z.string().optional(),
    triggerType: z.string().optional(),
    status: z.enum(['draft', 'active']).optional(),
    nodes: z.array(z.record(z.any())).optional(),
    edges: z.array(z.record(z.any())).optional(),
    config: z.record(z.any()).optional().describe('Full { nodes, edges } config (alternative to nodes/edges).'),
    folderId: z.union([z.string(), z.number()]).optional(),
  },
}, tool((args) => call('POST', '/automations-create', args)));

server.registerTool('create_wa_link', {
  title: 'Create a click-to-chat link',
  description: 'Create a tracked wa.me link opening a chat with a business number, optionally pre-filled with a message.',
  inputSchema: {
    name: z.string().describe('Link name.'),
    accountId: z.union([z.string(), z.number()]).describe('WhatsApp account id (from list_wa_accounts).'),
    message: z.string().optional().describe('Pre-filled message text.'),
  },
}, tool((args) => call('POST', '/wa-links-create', args)));

server.registerTool('create_lead_form', {
  title: 'Create a form',
  description:
    'Create a capture form and optionally attach fields + publish in one call. fields[]: { key, label, type (text|textarea|email|phone|number|date|dropdown|radio|checkbox|boolean|rating|section), required?, mapsTo? (name|email|phone|age|profession|pincode|city|source), options?, placeholder? }. ' +
    'type "rating" is a STAR RATING: add scale (3, 4, 5 or 10 — default 5), feedback:true to show an optional comment box under the stars, and feedbackLabel to word its prompt. Its answer is {rating,feedback}; required means a star must be picked (the comment stays optional), and it cannot use mapsTo. Use this instead of a dropdown of "5 Stars"/"4 Stars" — only a real rating gets an average and a star distribution on the dashboard. ' +
    'type "section" is a display-only heading to break a long form into parts: give it a label and an optional description. It collects no answer, so it is never required and never mapped. ' +
    'An unknown type is REJECTED (not silently turned into a text box), so use these names exactly. ' +
    'formType "link" (default) is shared as a plain URL and the phone is OPTIONAL — give a field mapsTo:"phone" to let people volunteer one; without it responses are stored with the phone column blank and do not create a lead. ' +
    'formType "whatsapp" is sent through an approved Utility/Marketing template whose link captures each recipient\'s phone automatically; after publishing, use forgechat_request POST /lead-forms/<id>/template to build that template. ' +
    'A submission upserts a CRM lead by phone whenever a phone is present. publish:true makes it live. Returns the form with its public slug (URL /f/<slug>).',
  inputSchema: {
    name: z.string(),
    description: z.string().optional(),
    formType: z.enum(['link', 'whatsapp']).optional(),
    fields: z.array(z.record(z.any())).optional(),
    successMessage: z.string().optional(),
    defaultSource: z.string().optional(),
    publish: z.boolean().optional(),
  },
}, tool((args) => call('POST', '/lead-forms-create', args)));

server.registerTool('list_lead_forms', {
  title: 'List lead forms',
  description: 'List all lead-capture forms with status, slug and submission counts.',
  inputSchema: {},
}, tool(() => call('GET', '/lead-forms-list')));

server.registerTool('list_form_submissions', {
  title: 'List lead-form submissions',
  description:
    'List collected responses for one lead form (paginated), each with its answers + matched lead. ' +
    'A star-rating answer comes back as {rating, feedback, outOf, text} — ALWAYS quote the scale from outOf or text ("4/4"), never assume a rating is out of 5. ' +
    'ratingFields[] describes each rating question and its scale. For averages and the star distribution use forgechat_request GET /lead-forms/<id>/dashboard rather than adding them up yourself.',
  inputSchema: {
    formId: z.union([z.string(), z.number()]).describe('Form id from list_lead_forms.'),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  },
}, tool(({ formId, page, pageSize }) => {
  const p = new URLSearchParams({ formId: String(formId) });
  if (page != null) p.set('page', String(page));
  if (pageSize != null) p.set('pageSize', String(pageSize));
  return call('GET', `/lead-forms-submissions?${p.toString()}`);
}));

/* ========================= projects (campaign folders) ================= */

server.registerTool('list_projects', {
  title: 'List projects',
  description:
    'List the campaign projects (folders), each with a count of the templates, automations, AI agents and forms filed under it. ' +
    'Pass projectId to open one and list the actual items inside. Use this to turn a project NAME the user said into the id move_to_project needs — never guess an id.',
  inputSchema: {
    projectId: z.union([z.string(), z.number()]).optional().describe('Open one project and list what it holds. Omit to list every project.'),
  },
}, tool(({ projectId }) => {
  const p = new URLSearchParams();
  if (projectId != null && projectId !== '') p.set('projectId', String(projectId));
  const qs = p.toString();
  return call('GET', `/projects-list${qs ? `?${qs}` : ''}`);
}));

server.registerTool('move_to_project', {
  title: 'Move items into a project',
  description:
    'File one or more items into a campaign project, or take them out of one. ' +
    "kind is 'template' | 'automation' | 'agent' | 'form' ('form' = a lead-capture form from list_lead_forms). " +
    'ids[] are that kind\'s ids — resolve them first with list_lead_forms / list_templates / list_agents, never guess. ' +
    'Pass projectId to file them there (from list_projects), or null to unfile them. ' +
    'This ONLY changes which folder the items are listed under: nothing is created, edited, published, activated or sent, and no customer is contacted.',
  inputSchema: {
    kind: z.enum(['template', 'automation', 'agent', 'form']),
    ids: z.array(z.union([z.string(), z.number()])),
    projectId: z.union([z.string(), z.number()]).nullable().optional(),
  },
}, tool((args) => call('POST', '/projects-assign', args)));

/* ================= AI Academy funnel: leads / marketing / BDA ========== */

server.registerTool('list_leads', {
  title: 'List funnel leads',
  description: "List leads from the Marketing/Sales funnel. Filter by stage (a configurable funnel stage key — see GET /funnel/config; defaults new/contacted/engaged/hot/enrolled/cold_lost), a saved view (view='hot' = arrived within 24h; 'unassigned'), or a name/number/email search. Returns id, name, whatsappNumber, stage, source, assignedUserName, createdAt.",
  inputSchema: {
    stage: z.string().optional().describe('Funnel stage key (configurable — see GET /funnel/config).'),
    view: z.enum(['hot', 'unassigned']).optional().describe("Saved view: 'hot' = arrived within the last 24 hours."),
    search: z.string().optional().describe('Partial match on name, WhatsApp number, or email.'),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, tool(({ stage, search, limit, view }) => {
  const p = new URLSearchParams();
  if (stage) p.set('stage', stage);
  if (view) p.set('view', view);
  if (search) p.set('search', search);
  if (limit != null) p.set('limit', String(limit));
  const qs = p.toString();
  return call('GET', `/leads${qs ? `?${qs}` : ''}`);
}));

server.registerTool('move_lead_stage', {
  title: 'Move a lead to a new funnel stage',
  description: 'Change a lead\'s funnel stage (e.g. move it to "hot" or "enrolled"). Logs the change to the lead timeline. Confirm the lead + target stage with the user first.',
  inputSchema: {
    leadId: z.union([z.string(), z.number()]).describe('Lead id (from list_leads).'),
    stage: z.string().describe('Target funnel stage key (configurable — see GET /funnel/config).'),
  },
}, tool(({ leadId, stage }) => call('PUT', `/leads/${encodeURIComponent(leadId)}/move`, { stage })));

server.registerTool('get_campaign_performance', {
  title: 'Get ad campaign performance',
  description: 'Get spend/leads/cost-per-lead for one campaign (by campaignId) or the most recent 100 campaigns if omitted. Covers both manually-entered and Meta-Ads-synced campaigns.',
  inputSchema: { campaignId: z.union([z.string(), z.number()]).optional().describe('Omit to list recent campaigns.') },
}, tool(({ campaignId }) => call('GET', `/campaign-performance${campaignId != null ? `?campaignId=${encodeURIComponent(campaignId)}` : ''}`)));

server.registerTool('list_webinars', {
  title: 'List webinar batches',
  description: 'List webinar/batch schedule with registrations, attendance %, and hot-lead counts.',
  inputSchema: {},
}, tool(() => call('GET', '/webinars-list')));

/* ------------------------- courses + payments --------------------------- */

// The REST paths below stay /courses-* — they are internal plumbing between
// this stdio server and the backend, not something a user or client sees.
server.registerTool('list_products', {
  title: 'List products',
  description: 'List the product catalog — a product is anything sold: a course, a consulting engagement, a template pack, a webinar. Each carries its optional default (headline) price plus its payment links with price, paid count and revenue. Amounts are in rupees; defaultPriceRupees is null when no default price is set.',
  inputSchema: {},
}, tool(() => call('GET', '/courses-list')));

server.registerTool('get_product_revenue', {
  title: 'Get product revenue',
  description: 'Revenue, paid count and failed count per product, plus payments that matched no product, plus the overall total. Amounts are in rupees. Use this for "how much has product X made" / "which product sells best".',
  inputSchema: {},
}, tool(() => call('GET', '/courses-revenue')));

server.registerTool('list_payments', {
  title: 'List payments',
  description:
    'The Razorpay payment ledger, one row per payer (all their attempts grouped), newest first. Each row links back to the matched CRM lead/contact where Razorpay data allowed a match. ' +
    'Use state="failed" to find people who tried to pay and could not — the follow-up list. Amounts are in rupees.',
  inputSchema: {
    state: z.enum(['paid', 'failed', 'refunded', 'pending']).optional().describe('Filter by outcome. "failed" = attempted but never succeeded (follow-up list).'),
    courseId: z.union([z.string(), z.number()]).optional().describe('Product id from list_products, or "none" for payments that matched no product.'),
    search: z.string().optional().describe('Partial match on payer email, phone, order id, or matched lead/contact name.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  },
}, tool(({ state, courseId, search, limit }) => {
  const p = new URLSearchParams();
  if (state) p.set('state', String(state));
  if (courseId != null) p.set('courseId', String(courseId));
  if (search) p.set('search', String(search));
  if (limit != null) p.set('limit', String(limit));
  const qs = p.toString();
  return call('GET', `/payments-list${qs ? `?${qs}` : ''}`);
}));

/* ===================== full access: proxy + bulk ===================== */

server.registerTool('list_endpoints', {
  title: 'List callable ForgeChat endpoints',
  description: 'Show which ForgeChat API areas are enabled for this connector and the main endpoints in each, so you know what forgechat_request can call. Call this when the user asks for something not covered by a dedicated tool.',
  inputSchema: {},
}, tool(() => call('GET', '/endpoints')));

server.registerTool('forgechat_request', {
  title: 'Call any ForgeChat API (admin)',
  description:
    'Generic authenticated call to ANY ForgeChat endpoint in an ENABLED area (full admin access) — use for anything without a dedicated tool: contacts, tags, broadcasts, automations, pipelines, users, accounts, dashboard, etc. ' +
    'Call list_endpoints first to see enabled areas + paths. path is like "/contacts" or "/broadcasts/12/send". Returns { status, ok, body }. ' +
    'Disabled areas and /mcp + /auth paths are refused. For broadcasting to an uploaded contact list, prefer send_bulk_message.',
  inputSchema: {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method.'),
    path: z.string().describe('API path under /api, e.g. "/contacts?waNumber=..." or "/broadcasts".'),
    query: z.record(z.any()).optional().describe('Query params as an object.'),
    body: z.record(z.any()).optional().describe('JSON body for POST/PUT/PATCH/DELETE.'),
  },
}, tool(({ method, path, query, body }) => call('POST', '/proxy', { method, path, query, body })));

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
}, tool((args) => call('POST', '/bulk-message', args)));

/* ============================== mutations ============================= */

// Shared media-group shape (optional, advanced).
const mediaGroupSchema = z.object({
  description: z.string().describe('REQUIRED. Tells the agent exactly WHEN to send this group — specific and action-oriented, e.g. "Send when the user confirms they want to enroll" or "Send after the user asks for pricing". Ask the user for this before finalising the group.'),
  mediaIds: z.array(z.number()).optional().describe('Media library item ids to send.'),
  links: z.array(z.string()).optional().describe('URLs to send as link messages.'),
  templateId: z.number().nullable().optional().describe('Approved template id to fire. Always confirm the template content with the user via get_template before using this.'),
}).passthrough();

server.registerTool('create_agent', {
  title: 'Create agent',
  description:
    'Create a new ForgeChat AI agent. IMPORTANT: gather and CONFIRM all settings with the user first ' +
    '(purpose, name, system prompt, WhatsApp number, model, trigger, tools). For an ACTIVE agent you must ' +
    'pass aiModelId + llmModel; otherwise pass status:"draft". Only one active agent is allowed per WhatsApp number. ' +
    'After creating, use add_google_sheets_tool to attach a Sheets tool if the user wanted one.',
  inputSchema: {
    name: z.string().describe('Agent name.'),
    systemPrompt: z.string().describe('The system prompt that defines the agent behaviour.'),
    aiModelId: z.union([z.string(), z.number()]).optional().describe('Connected credential id (from list_models). Required for an active agent.'),
    llmModel: z.string().optional().describe('Model id (the models[].value from list_models). Required for an active agent.'),
    waAccountId: z.union([z.string(), z.number()]).optional().describe('WhatsApp account id (from list_wa_accounts).'),
    status: z.enum(['draft', 'active']).optional().describe('draft = save incomplete (no live traffic). active = runnable (needs model). Defaults to active.'),
    isActive: z.boolean().optional().describe('Whether the agent takes live traffic (only when status=active; one active per number).'),
    contextWindowMessages: z.number().int().min(1).max(100).optional().describe('How many past messages to include (1-100, default 20).'),
    maxToolIterations: z.number().int().min(1).max(20).optional().describe('Max tool-call loops per turn (1-20, default 6).'),
    transcribeAudio: z.boolean().optional().describe('Transcribe inbound voice notes (OpenAI Whisper).'),
    acceptImages: z.boolean().optional().describe('Let the agent see inbound images (sends them to a vision-capable model).'),
    triggerMode: z.enum(['any', 'keyword']).optional().describe('any = every message; keyword = only on keyword/within session.'),
    triggerKeyword: z.string().optional().describe('Required when triggerMode=keyword on an active agent.'),
    triggerMatchType: z.enum(['exact', 'contains', 'starts']).optional().describe('How the keyword matches (default contains).'),
    triggerCaseSensitive: z.boolean().optional(),
    triggerSessionMinutes: z.number().int().min(1).max(1440).optional().describe('How long a keyword session stays open (1-1440, default 30).'),
    mediaGroups: z.array(mediaGroupSchema).optional().describe('Optional media/link/template bundles the agent can send.'),
  },
}, tool((args) => call('POST', '/agents', args)));

server.registerTool('update_agent', {
  title: 'Update agent',
  description: 'Update an existing agent. Only the fields you pass are changed. Same validation as create_agent.',
  inputSchema: {
    id: z.union([z.string(), z.number()]).describe('Agent id.'),
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
}, tool(({ id, ...patch }) => call('PUT', `/agents/${encodeURIComponent(id)}`, patch)));

server.registerTool('add_google_sheets_tool', {
  title: 'Add Google Sheets tool',
  description:
    'Attach a Google Sheets tool to an agent. First use search_spreadsheets + list_sheet_tabs so the user picks a real ' +
    'spreadsheet and tab, and ask which operations to allow. Uses the workspace-wide Google connection.',
  inputSchema: {
    agentId: z.union([z.string(), z.number()]).describe('Agent id.'),
    spreadsheetId: z.string().describe('Spreadsheet id (from search_spreadsheets).'),
    spreadsheetName: z.string().optional().describe('Display name of the spreadsheet (for reference).'),
    sheetName: z.string().describe('Tab name (from list_sheet_tabs).'),
    ops: z.array(z.enum(['read', 'append', 'update', 'upsert'])).min(1).describe('Allowed operations — at least one of read/append/update/upsert.'),
  },
}, tool(({ agentId, spreadsheetId, spreadsheetName, sheetName, ops }) =>
  call('POST', `/agents/${encodeURIComponent(agentId)}/tools`, {
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
    agentId: z.union([z.string(), z.number()]).describe('Agent id.'),
    label: z.string().describe('Short action name, e.g. "Turn on smart light".'),
    description: z.string().describe('When the AI should call this tool — the model reads this to decide. Be specific.'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method.'),
    url: z.string().describe('Endpoint URL. Use {name} for a path parameter, e.g. https://api.io/devices/{device_id}/state'),
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
}, tool(({ agentId, label, description, method, url, headers, params, timeoutMs }) =>
  call('POST', `/agents/${encodeURIComponent(agentId)}/tools`, {
    toolType: 'http_request',
    config: { label, description, method, url, headers: headers || [], params: params || [], timeout_ms: timeoutMs || 10000 },
  })));

server.registerTool('add_tool', {
  title: 'Add tool (generic)',
  description: 'Attach a tool to an agent by raw toolType + config. Prefer add_google_sheets_tool for Sheets and add_http_tool for HTTP. Supported toolTypes: "google_sheets", "http_request".',
  inputSchema: {
    agentId: z.union([z.string(), z.number()]).describe('Agent id.'),
    toolType: z.string().describe('Tool type, e.g. "google_sheets".'),
    config: z.record(z.any()).describe('Tool config object (shape depends on toolType).'),
    isEnabled: z.boolean().optional(),
  },
}, tool(({ agentId, toolType, config, isEnabled }) =>
  call('POST', `/agents/${encodeURIComponent(agentId)}/tools`, { toolType, config, isEnabled })));

server.registerTool('update_tool', {
  title: 'Update tool',
  description: "Update an agent tool's config or enabled flag.",
  inputSchema: {
    agentId: z.union([z.string(), z.number()]).describe('Agent id.'),
    toolId: z.union([z.string(), z.number()]).describe('Tool id.'),
    config: z.record(z.any()).optional(),
    isEnabled: z.boolean().optional(),
  },
}, tool(({ agentId, toolId, config, isEnabled }) =>
  call('PUT', `/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`, { config, isEnabled })));

server.registerTool('delete_tool', {
  title: 'Delete tool',
  description: 'Remove a tool from an agent. Confirm with the user first.',
  inputSchema: {
    agentId: z.union([z.string(), z.number()]).describe('Agent id.'),
    toolId: z.union([z.string(), z.number()]).describe('Tool id.'),
  },
}, tool(({ agentId, toolId }) =>
  call('DELETE', `/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`)));

server.registerTool('delete_agent', {
  title: 'Delete agent',
  description: 'Delete an agent entirely. This is destructive — confirm with the user first.',
  inputSchema: { id: z.union([z.string(), z.number()]).describe('Agent id.') },
}, tool(({ id }) => call('DELETE', `/agents/${encodeURIComponent(id)}`)));

/* =============================== prompt =============================== */

const GUIDE = `This is ForgeGrowth — an AI Academy Marketing/Sales lead funnel with a WhatsApp Chats layer underneath it. Before assuming this is purely an agent-builder: if the user wants to inspect or act on leads, campaigns, or webinars, use the funnel tools directly (list_leads, move_lead_stage, get_campaign_performance, list_webinars, or forgechat_request for anything else in an enabled area) — you do NOT need to build an agent for that.

You can also CONFIGURE the whole app from a plain-language "game plan": upload a poster (upload_media), create + submit a WhatsApp template for Meta approval (create_template → submit_template → sync_template), build an automation flow (create_automation), make a lead form (create_lead_form) and read its submissions (list_form_submissions), generate a click-to-chat link (create_wa_link), and send/broadcast (send_message, send_template, send_media, send_bulk_message). ALWAYS summarise what you will do and get the user's explicit confirmation before any create/submit/send step.

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

server.registerPrompt('create-forgechat-agent', {
  title: 'Create a ForgeChat agent',
  description: 'Guided flow to create and configure a ForgeChat WhatsApp AI agent (asks the right questions, then creates it).',
  argsSchema: {},
}, () => ({
  messages: [{ role: 'user', content: { type: 'text', text: GUIDE } }],
}));

/* =============================== start =============================== */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[forgechat-mcp] ready');
