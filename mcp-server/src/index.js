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
import { createRequire } from 'node:module';

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
    'A voice note that has already been transcribed carries its `transcript` (nothing is transcribed by this call). ' +
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

/* ================ config: media / templates / automations ================ */

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

/**
 * ⚠ FETCHED, NOT COPIED.
 *
 * This description is generated by the backend from the same `expectedHandles()`
 * the flow validator gates on. It used to be hand-written prose here AND in
 * mcpHttp.js, and the two copies drifted from the canvas: both documented list
 * handles as `row:N` long after they became `row:<section>:<row>`, so a flow
 * built from this schema arrived with every list branch dangling and nothing
 * anywhere reported it.
 *
 * This package cannot import the backend's modules, so it reads them over the
 * wire once at start-up. The fallback is deliberately short and points at
 * `validate_automation`: if it is ever in play, the authoritative shape is one
 * tool call away rather than guessed from stale text.
 */
const AUTOMATION_FALLBACK =
  'Create a WhatsApp automation from a { nodes, edges } graph. The full schema could not be read from the server — ' +
  'call validate_automation with your draft graph FIRST: it returns the exact problems, including any edge whose ' +
  'fromHandle does not exist on its step, and lists the valid handles for that step.';

const automationDescription = await (async () => {
  try {
    const res = await fetch(`${API_URL}/automation-schema`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      // No timeout means an unreachable host hangs the server at boot, before
      // it ever speaks MCP — the client just sees a connector that never starts.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return AUTOMATION_FALLBACK;
    const data = await res.json();
    return data?.description || AUTOMATION_FALLBACK;
  } catch {
    return AUTOMATION_FALLBACK;
  }
})();

server.registerTool('create_automation', {
  title: 'Create an automation flow',
  description: automationDescription,
  inputSchema: {
    name: z.string(),
    description: z.string().optional(),
    triggerType: z.string().optional(),
    status: z.enum(['draft', 'active']).optional().describe('Always created as a draft; activating is a separate checked step.'),
    nodes: z.array(z.record(z.any())).optional().describe('Do not send x/y — positions are assigned automatically.'),
    edges: z.array(z.record(z.any())).optional(),
    config: z.record(z.any()).optional().describe('Full { nodes, edges } config (alternative to nodes/edges).'),
    allowIncomplete: z.boolean().optional().describe('Save a knowingly-unfinished draft despite blocking problems. Default false.'),
  },
}, tool((args) => call('POST', '/automations-create', args)));

server.registerTool('validate_automation', {
  title: 'Check an automation flow',
  description:
    'Check a flow graph WITHOUT saving it, or check a saved automation by id. Returns blocking[] (would be broken at runtime), ' +
    'warnings[] (unfinished but harmless) and danglingConnections[] (an edge naming an output the step does not have — the ' +
    'commonest hand-authoring mistake, and invisible on the canvas). Run this before create_automation.',
  inputSchema: {
    automationId: z.union([z.string(), z.number()]).optional(),
    nodes: z.array(z.record(z.any())).optional(),
    edges: z.array(z.record(z.any())).optional(),
    config: z.record(z.any()).optional(),
  },
}, tool((args) => call('POST', '/automations-validate', args)));

server.registerTool('update_automation', {
  title: 'Update or activate an automation',
  description:
    'Edit a saved automation: rename it, replace its flow graph, or ACTIVATE it. Activating runs the ' +
    'same check as the app and refuses a broken flow. An active flow replies to real customers immediately — always confirm first.',
  inputSchema: {
    id: z.union([z.string(), z.number()]),
    name: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional().describe('true = go live (checked first), false = pause.'),
    nodes: z.array(z.record(z.any())).optional(),
    edges: z.array(z.record(z.any())).optional(),
    config: z.record(z.any()).optional(),
  },
}, tool((args) => call('POST', '/automations-update', args)));

server.registerTool('list_automations', {
  title: 'List automations',
  description: 'List the automation flows with status and trigger. Pass an id to read one back in full, including its nodes/edges graph.',
  inputSchema: { id: z.union([z.string(), z.number()]).optional() },
}, tool(({ id }) => call('GET', `/automations-list${id ? `?id=${encodeURIComponent(id)}` : ''}`)));

server.registerTool('get_automation_runs', {
  title: 'Read automation runs',
  description:
    'Read what an automation actually DID — one row per run, each with the steps it visited, their input/output and any error. ' +
    'When a user says a flow "did not work", read this before theorising: it usually names the step and the reason.',
  inputSchema: {
    automationId: z.union([z.string(), z.number()]),
    executionId: z.union([z.string(), z.number()]).optional(),
    status: z.enum(['success', 'error', 'running', 'queued', 'paused', 'cancelled']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, tool((a) => call('GET', `/automations-runs?${new URLSearchParams(
  Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
)}`)));

/* ======================= AI Academy funnel: leads ===================== */

server.registerTool('list_leads', {
  title: 'List funnel leads',
  description: "List leads from the Sales funnel. Filter by stage (a configurable funnel stage key — see GET /funnel/config; defaults new/contacted/engaged/hot/enrolled/cold_lost), a saved view (view='hot' = arrived within 24h; 'unassigned'), or a name/number/email search. Returns id, name, whatsappNumber, stage, source, assignedUserName, createdAt.",
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

/* ------------------------------ products -------------------------------- */

// The REST paths below stay /courses-* — they are internal plumbing between
// this stdio server and the backend, not something a user or client sees.
// ── Follow-up calendar ──
// Mirrors backend/src/mcpHttp.js. Names and schemas must match or
// test/mcpCatalog.unit.test.js fails on transport drift.
server.registerTool('list_follow_ups', {
  title: 'Read the follow-up calendar',
  description: 'The follow-ups on the sales calendar (Sales → Follow-up): who we plan to contact on which day, with the note, owner, lead stage and Google Calendar state. Defaults to OPEN; status "done" | "cancelled" | "any". Dates are IST days (YYYY-MM-DD).',
  inputSchema: {
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.string().optional(),
    contactNumber: z.string().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  },
}, tool((args) => call('GET', `/follow-ups-list?${new URLSearchParams(
  Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
)}`)));

server.registerTool('set_follow_up', {
  title: 'Put a lead on the follow-up calendar',
  description: 'Schedule a follow-up with a customer on a day (optionally a time) with a note. At most ONE open follow-up per person per owner — calling again RESCHEDULES it. Confirm the date with the user first; use suggest_follow_up_date to let the AI pick.',
  inputSchema: {
    contactNumber: z.string(),
    dueDate: z.string(),
    dueTime: z.string().optional(),
    note: z.string().optional(),
    waNumber: z.string().optional(),
    ownerEmail: z.string().optional(),
  },
}, tool((args) => call('POST', '/follow-ups-set', args)));

server.registerTool('update_follow_up', {
  title: 'Change or finish a follow-up',
  description: 'Reschedule (dueDate/dueTime), change the note, mark done/cancelled (status), or delete (remove: true). id from list_follow_ups.',
  inputSchema: {
    id: z.number().int(),
    dueDate: z.string().optional(),
    dueTime: z.string().nullable().optional(),
    note: z.string().optional(),
    status: z.enum(['open', 'done', 'cancelled']).optional(),
    remove: z.boolean().optional(),
  },
}, tool((args) => call('POST', '/follow-ups-update', args)));

server.registerTool('suggest_follow_up_date', {
  title: 'Ask the AI for the next follow-up date',
  description: 'The AI-recommended next follow-up day (and time if it matters) for a customer, with a reason. One small AI call over the chat\'s timing and recent messages. Does not change the calendar — call set_follow_up to apply it.',
  inputSchema: {
    contactNumber: z.string(),
    waNumber: z.string().optional(),
  },
}, tool((args) => call('POST', '/follow-ups-suggest', args)));

server.registerTool('list_products', {
  title: 'List products',
  description: 'List the product catalog — a product is anything sold: a course, a consulting engagement, a template pack, a webinar. Each carries its optional default (headline) price plus its sales count and revenue. Amounts are in rupees; defaultPriceRupees is null when no default price is set.',
  inputSchema: {},
}, tool(() => call('GET', '/courses-list')));

server.registerTool('get_product_revenue', {
  title: 'Get product revenue',
  description: 'Revenue, sales and payment counts per product, plus sales with no product set, plus the overall total. Amounts are in rupees. Use this for "how much has product X made" / "which product sells best".',
  inputSchema: {},
}, tool(() => call('GET', '/courses-revenue')));

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

/**
 * Every agent setting an MCP client may send, shared by create_agent and
 * update_agent — they used to be two hand-typed copies here and two more in the
 * backend transport, and all four had fallen 15 fields behind agentService.
 *
 * ⚠ ABSENT ON PURPOSE: triggerStageKeys / triggerTagIds, the funnel gate
 * deciding WHICH leads an agent answers. agentService.canSetFunnelTrigger() is
 * default-deny and refuses any caller that does not identify an admin actor —
 * MCP does not — so offering them here would be a control that saves cleanly
 * and then does nothing. It is a web-app decision.
 *
 * ⚠ null vs OMITTED is load-bearing on every limit: omitted leaves the stored
 * value alone, null clears it. Collapsing them would make a rename wipe an
 * agent's ceilings.
 */
const agentLimit = (max, desc) =>
  z.number().int().min(0).max(max).nullable().optional()
    .describe(`${desc} Omit to leave unchanged, null or 0 for no limit.`);

const agentFields = () => ({
  name: z.string().optional().describe('Agent name.'),
  systemPrompt: z.string().optional().describe('The persona and instructions — this IS the agent.'),
  aiModelId: z.union([z.string(), z.number()]).nullable().optional().describe('Credential id from list_models. Required (with llmModel) before it can be active.'),
  llmModel: z.string().nullable().optional().describe('A models[].value from list_models.'),
  waAccountId: z.union([z.string(), z.number()]).nullable().optional().describe('WhatsApp number id from list_wa_accounts.'),
  status: z.enum(['draft', 'active']).optional().describe('draft = saved but takes no live traffic. active needs a model.'),
  isActive: z.boolean().optional().describe('Takes live traffic (only when status=active; one active agent per number).'),
  contextWindowMessages: z.number().int().min(1).max(100).optional().describe('How many past messages the agent sees (default 20).'),
  maxToolIterations: z.number().int().min(1).max(20).optional().describe('How many tool calls it may chain in one reply (default 6).'),

  transcribeAudio: z.boolean().optional().describe('Understand voice notes (transcribed, billed per minute). Off by default.'),
  acceptImages: z.boolean().optional().describe('See images — needs a vision-capable model. Off by default.'),
  maxVoiceSeconds: agentLimit(3600, 'Longest voice note it will transcribe, in seconds; a longer one is not transcribed and the agent asks for a shorter one instead of guessing at it.'),
  maxImagesPerConversation: agentLimit(1000, 'Images it will look at per conversation. WhatsApp delivers each photo as its own message, so this is per CONVERSATION, not per message.'),

  triggerMode: z.enum(['any', 'keyword']).optional().describe('any = every message; keyword = only on the keyword / within the session.'),
  triggerKeyword: z.string().optional().describe('Required when triggerMode=keyword on an active agent.'),
  triggerMatchType: z.enum(['exact', 'contains', 'starts']).optional(),
  triggerCaseSensitive: z.boolean().optional(),
  triggerSessionMinutes: z.number().int().min(1).max(1440).optional().describe('Silence that ends a conversation, in minutes. Also how "one conversation" is measured for the limits below.'),

  maxRepliesPerConversation: agentLimit(500, 'Replies in one sitting before it stops.'),
  maxRepliesPerMinute: agentLimit(500, 'Burst throttle. Nothing is sent and nothing is recorded — the skipped message still reaches the model as context on the next reply.'),
  maxRunsPerDay: agentLimit(10000, 'Replies across ALL conversations in a day (IST). Guards against a broadcast backfire; silent to customers because it fires everywhere at once.'),
  quotaReplies: agentLimit(10000, 'Replies one person may have over a rolling window — a ceiling that refills on a CLOCK, unlike maxRepliesPerConversation which refills the moment they go quiet.'),
  quotaConversations: agentLimit(1000, 'Separate conversations one person may start in the window. Only ever refuses a NEW sitting, never cuts someone off mid-conversation.'),
  quotaWindowValue: z.number().int().min(1).max(999).optional().describe('Length of the rolling window (default 1).'),
  quotaWindowUnit: z.enum(['minutes', 'hours', 'days']).optional().describe('Unit of the rolling window (default days).'),
  limitHandoff: z.boolean().optional().describe('On hitting a per-conversation limit, pause the bot and leave the chat for a person. Default ON — someone who asked that many questions is usually interested.'),
  quotaHandoff: z.boolean().optional().describe('Same, for the rolling allowance. Default OFF — "come back tomorrow" is not a reason to push everyone into the inbox.'),
  limitReachedMessage: z.string().nullable().optional().describe('One closing line sent when a limit stops it. Empty means send nothing — there is no hidden fallback.'),

  testNumbers: z.array(z.object({
    number: z.string().describe('Any format — stored digits-only and matched on the last 10.'),
    label: z.string().optional(),
  })).optional().describe('Numbers that can exercise this agent while it is still a DRAFT. They are also exempt from every limit above and their runs are excluded from the counts, so a day of testing does not eat the real budget. Triggers and funnel gating still apply.'),

  mediaGroups: z.array(mediaGroupSchema).optional().describe('Optional media/link/template bundles the agent can send.'),
});

server.registerTool('create_agent', {
  title: 'Create agent',
  description:
    'Create a new ForgeChat AI agent. IMPORTANT: gather and CONFIRM all settings with the user first ' +
    '(purpose, name, system prompt, WhatsApp number, model, trigger, tools). For an ACTIVE agent you must ' +
    'pass aiModelId + llmModel; otherwise pass status:"draft". Only one active agent is allowed per WhatsApp number. ' +
    'Usage limits and the per-person allowance are all OPTIONAL and all default to unlimited — an agent with none set ' +
    'will answer one person forever, so ask whether a ceiling is wanted. ' +
    'After creating, attach tools with add_google_sheets_tool / add_http_tool. ' +
    'Note: which funnel stages or tags an agent may answer can only be set in the web app — it is an admin-only decision and is ignored here.',
  inputSchema: { ...agentFields(), name: z.string().describe('Agent name.'), systemPrompt: z.string().describe('The persona and instructions — this IS the agent.') },
}, tool((args) => call('POST', '/agents', args)));

server.registerTool('update_agent', {
  title: 'Update agent',
  description:
    'Update an existing agent. ONLY the fields you pass change — omitting a field leaves it alone, so an unrelated edit ' +
    'never wipes a limit. Pass null to clear a limit (0 also clears it; there is no way to express "may send zero replies"). ' +
    'Same validation as create_agent.',
  inputSchema: {
    id: z.union([z.string(), z.number()]).describe('Agent id.'),
    ...agentFields(),
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

const GUIDE = `This is ForgeGrowth — an AI Academy Sales lead funnel with a WhatsApp Chats layer underneath it. Before assuming this is purely an agent-builder: if the user wants to inspect or act on leads, use the funnel tools directly (list_leads, move_lead_stage, or forgechat_request for anything else in an enabled area) — you do NOT need to build an agent for that.

Social (Instagram) has its own social_* tools: analytics and the content library (social_get_overview, social_get_platform_stats, social_list_posts), the inbox (social_list_messages, social_list_comments), Instagram automations and flows (social_list_automations, social_create_comment_dm_draft for the common "comment a keyword, get a link in DM" rule, social_create_automation, social_list_flows, social_get_flow, social_create_flow — these always save a draft; switch it on with social_update_automation / social_update_flow after the user confirms) and Social AI agents (social_list_agents, social_create_agent). Sales reads: list_sales, get_sale_transactions, get_funnel.

You can also CONFIGURE the whole app from a plain-language "game plan": upload a poster (upload_media), create + submit a WhatsApp template for Meta approval (create_template → submit_template → sync_template), build an automation flow (ALWAYS validate_automation on the graph first, then create_automation — it lands as a draft and update_automation{active:true} takes it live after a second check; get_automation_runs says what a flow actually did), and send/broadcast (send_message, send_template, send_media, send_bulk_message). ALWAYS summarise what you will do and get the user's explicit confirmation before any create/submit/send step.

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

/* ================= tools declared as data (shared file) ================= */
// The SAME list the hosted connector registers (backend/src/services/mcpRouteTools.js),
// loaded from this repo checkout — this server only runs from one — so the two
// transports cannot drift. Each call goes to POST /route-tools/<name>, which is
// gated by the same per-tool category switch as everything else.
{
  let shared = null;
  try {
    shared = createRequire(import.meta.url)('../../backend/src/services/mcpRouteTools.js');
  } catch (err) {
    console.error('[forgechat-mcp] could not load the shared tool list (backend/src/services/mcpRouteTools.js):', err.message);
  }
  for (const spec of shared?.ROUTE_TOOLS || []) {
    server.registerTool(spec.name, {
      title: spec.title,
      description: spec.description,
      inputSchema: shared.buildInputSchema(z, spec.params),
      ...(spec.kind === 'read' ? { annotations: { readOnlyHint: true } } : {}),
      ...(spec.kind === 'delete' ? { annotations: { destructiveHint: true } } : {}),
    }, tool((args) => call('POST', `/route-tools/${spec.name}`, args)));
  }
}

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
