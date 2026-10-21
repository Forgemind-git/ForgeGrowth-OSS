// The MCP tool catalog — the SINGLE source of truth for what tools exist,
// which category each belongs to, and therefore what an admin is switching on
// or off in Admin Settings -> MCP Tools.
//
// WHY THIS FILE EXISTS
// -------------------
// The original capability model stapled together two incompatible concepts:
//
//   * functional caps  — discovery / create_agent / update_agent / manage_tools
//                        / delete / read_messages / send_messages
//   * area caps        — area_* , built for the generic `forgechat_request`
//                        proxy but ALSO used to gate real named tools
//
// The result was unreadable and genuinely dangerous: `discovery` alone gated
// ten unrelated tools (WhatsApp numbers, AI models, Google Drive spreadsheet
// search, sheet values, media, templates and agents), so an admin who wanted
// Claude to build a WhatsApp template had no choice but to also hand over
// Google Drive search. And turning `discovery` off silently broke half the
// template tools with no indication anywhere in the UI.
//
// Now: every tool belongs to exactly ONE category, the category is the gate,
// and the Settings screen renders itself from this file. Categories are named
// after the PROCESS a person is doing ("Template Builder"), not after the
// internal route prefix the tool happens to call.
//
// THE AREA CAPS DID NOT GO AWAY — they now do only the job they were designed
// for: scoping which internal API paths the generic `forgechat_request` proxy
// may reach (see PROXY_AREAS in mcpService.js). They no longer gate named
// tools, so the two concepts are finally separate.
//
// INVARIANTS — do not regress these:
//   1. DEFAULT-DENY. A tool that is not listed here resolves to no category and
//      is REFUSED. Drift becomes a visible failure instead of a silent hole,
//      and the coverage test in test/mcpCatalog.test.js fails the build.
//   2. A tool belongs to exactly one category. Two categories gating one tool
//      makes "is this on?" unanswerable from the UI.
//   3. `legacyCaps` exists ONLY to seed the first migration so a live connector
//      keeps behaving identically. Never gate anything on it at runtime.

/* ------------------------------ tiers ---------------------------------- */

// Tiers drive the badge + colour in Settings. They are advisory signalling for
// the admin reading the screen, NOT a second gate — the category toggle is the
// only gate. Worded for a non-engineer, because the person deciding whether to
// switch a category on is a strategist, not the person who wrote it.
const TIERS = {
  read: {
    label: 'Reads only',
    description: 'Cannot change anything or reach a customer.',
  },
  build: {
    label: 'Builds & configures',
    description: 'Creates or edits setup — templates, agents, flows, funnel stages.',
  },
  spend: {
    label: 'Costs money per use',
    description: 'Messages nobody, but every call bills your AI provider — reading voice notes, images and PDFs is charged per item.',
  },
  send: {
    label: 'Reaches customers',
    description: 'Sends real WhatsApp messages to real people. Meta charges apply.',
  },
  destructive: {
    label: 'Cannot be undone',
    description: 'Permanently removes something. There is no undo.',
  },
  advanced: {
    label: 'Full API access',
    description: 'Unrestricted internal API calls, scoped separately by area.',
  },
};

/* ------------------------------ areas ----------------------------------- */

// The four parts of the app, in the order the Settings screen shows them. Every
// category belongs to exactly one area, so a non-technical admin can find "what
// can Claude do in Social?" without knowing any tool names.
const AREAS = [
  { key: 'social', label: 'Social', description: 'Instagram — numbers, inbox, Instagram automations and Social AI agents.' },
  { key: 'sales', label: 'Sales', description: 'Leads and the funnel, the follow-up calendar, sales, products and the Chat Analyzer.' },
  { key: 'chats', label: 'Chats & Automations', description: 'WhatsApp conversations, sending, broadcasts, templates, media, automation flows and WhatsApp AI agents.' },
  { key: 'admin', label: 'Admin', description: 'Connected numbers and models, Google, deleting things, and the unrestricted API escape hatch.' },
];

/* ------------------------------ kinds ----------------------------------- */

// What ONE tool does, in plain words. Shown next to every tool in Settings so
// the admin sees the risk of each tool, not just of the category switch.
const KINDS = {
  read: { label: 'Reads', description: 'Looks only. Changes nothing, reaches nobody.' },
  change: { label: 'Changes setup', description: 'Creates or edits something in the app.' },
  send: { label: 'Reaches people', description: 'Sends a real message, reply or post.' },
  spend: { label: 'Costs money', description: 'Each use bills your AI provider.' },
  delete: { label: 'Deletes', description: 'Removes something for good. No undo.' },
  advanced: { label: 'Full API', description: 'Calls any internal endpoint in an enabled API area.' },
};

// Default kind of a tool from its category's tier, used when a tool does not
// say otherwise. list_/get_/read_/search_/validate_ tools only ever read.
const TIER_KIND = { read: 'read', build: 'change', spend: 'spend', send: 'send', destructive: 'delete', advanced: 'advanced' };
const READ_PREFIX = /^(list_|get_|read_|search_|validate_)/;

// The API areas that scope the generic forgechat_request proxy (Direct API
// access). Served to the Settings screen so it never keeps its own copy — a
// hand-kept frontend list once carried an `area_bda` switch that no backend
// path ever checked. mcpService derives AREA_CAPABILITY_KEYS from this list.
const API_AREAS = [
  { key: 'area_contacts', label: 'Contacts & tags', description: 'Contacts, saved contacts, tags and categories.' },
  { key: 'area_messaging', label: 'Messages', description: 'Chat messages, reactions, WhatsApp group archive and pausing a bot on one chat.' },
  { key: 'area_broadcasts', label: 'Broadcasts & content', description: 'Broadcasts (incl. repeating), templates and media library.' },
  { key: 'area_automations', label: 'Automations', description: 'Automation flows and their runs.' },
  { key: 'area_admin', label: 'Admin (users, accounts)', description: 'SENSITIVE — users, WhatsApp accounts, AI models, integrations and Social credentials.', sensitive: true },
  { key: 'area_insights', label: 'Dashboard & logs', description: 'Dashboard analytics, webhook history and message costs.' },
  { key: 'area_leads', label: 'Leads & funnel', description: 'Leads, funnel config, the field registry and follow-ups.' },
  { key: 'area_resources', label: 'Resources', description: 'Live links and the trigger library.' },
  { key: 'area_courses', label: 'Products', description: 'Product catalogue.' },
  { key: 'area_payments', label: 'Sales', description: 'Sales (students), their payments and refunds.' },
  { key: 'area_chat_analysis', label: 'Chat Analyzer', description: 'Conversation analyses and what they cost.' },
  { key: 'area_social', label: 'Social', description: 'The Social workspace: analytics, inbox, Instagram automations, flows and Social AI agents. Its credentials and settings stay under Admin.' },
];

/* ---------------------------- categories -------------------------------- */

// Order here is the order shown in Settings: setup first (what you connect),
// then the things you build, then the things that reach customers, then
// analytics, then the advanced escape hatch last.
const CATEGORIES = [
  {
    key: 'setup',
    area: 'admin',
    label: 'Setup & Connections',
    description:
      'See which WhatsApp numbers, AI models and API areas are connected — how Claude discovers what your workspace has before it configures anything — and give a number a short display label.',
    // 'build' since rename_wa_number: a category's tier describes the most
    // powerful thing inside it. The label is display-only; nothing else here writes.
    tier: 'build',
    legacyCaps: ['discovery'],
  },
  {
    key: 'templates',
    area: 'chats',
    label: 'Template Builder',
    description:
      'Read, draft, submit for Meta approval and re-sync WhatsApp message templates. Everything needed to take a template from an idea to APPROVED without opening the app.',
    tier: 'build',
    legacyCaps: ['discovery', 'area_broadcasts'],
  },
  {
    key: 'media',
    area: 'chats',
    label: 'Media Library',
    description:
      'List and upload posters, images, video and documents, and sync them to each WhatsApp account so templates and sends can use them.',
    tier: 'build',
    legacyCaps: ['discovery', 'area_broadcasts'],
  },
  {
    key: 'agents',
    area: 'chats',
    label: 'AI Agents',
    description:
      'Create and configure the AI agents that talk to customers on WhatsApp — persona, model, trigger, and their Google Sheets / HTTP tools.',
    tier: 'build',
    legacyCaps: ['discovery', 'create_agent', 'update_agent', 'manage_tools'],
  },
  {
    key: 'delete',
    area: 'admin',
    label: 'Delete & remove',
    description:
      'Let Claude permanently delete things: WhatsApp AI agents and their tools, WhatsApp automation flows, Instagram automations and flows, and Social AI agents and their tools. Kept apart from building deliberately — building and deleting are different decisions, and this is the only category whose actions cannot be undone.',
    tier: 'destructive',
    legacyCaps: ['delete'],
  },
  {
    key: 'automations',
    area: 'chats',
    label: 'Automations',
    description:
      'Build, check and edit automation flows — the trigger/message/condition/action graphs that run when a customer messages in — and read what a flow actually did on each run. ' +
      'It can also SWITCH A FLOW LIVE, after which that flow replies to real customers on its own; activating runs the same check the app does and refuses a flow that would be broken.',
    // Stays in the "builds" tier rather than "reaches customers": arming a flow
    // is not the same as sending. A live flow only ever answers someone who
    // messaged in first, so it cannot originate contact or blast a list the way
    // Send Messages and Broadcasts can — but the description says plainly that
    // it starts replying, because an admin reading this screen must not have to
    // infer it from the tier badge.
    tier: 'build',
    legacyCaps: ['area_automations'],
  },
  {
    key: 'chat_analysis',
    area: 'sales',
    label: 'Chat Analyzer',
    description:
      'Read what a WhatsApp conversation is about — its summary, intent, objections and suggested funnel stage — and analyse one conversation on demand, optionally including its voice notes, images and PDFs.',
    // 'spend', not 'read': three of these tools only read, but analyse_chat
    // bills the AI provider per call, and a category's tier has to describe the
    // most powerful thing inside it or the Settings badge misleads.
    tier: 'spend',
    // ⚠ There is deliberately NO bulk tool here. A bulk run costs money per
    // conversation with nobody watching; it stays a click in the tab, behind a
    // cost estimate.
    legacyCaps: ['area_chat_analysis'],
  },
  {
    key: 'leads',
    area: 'sales',
    label: 'Leads & Funnel',
    description:
      'Read leads and the funnel, edit a lead\'s details, move a lead between funnel stages, and manage the follow-up calendar.',
    tier: 'build',
    legacyCaps: ['area_leads'],
  },
  {
    key: 'inbox',
    area: 'chats',
    label: 'Conversations',
    description:
      'Read WhatsApp conversations and message history, including whether the 24-hour reply window is still open. Read-only — it cannot send.',
    tier: 'read',
    legacyCaps: ['read_messages'],
  },
  {
    key: 'messaging',
    area: 'chats',
    label: 'Send Messages',
    description:
      'Send a real WhatsApp message to one person — free text inside the 24-hour window, approved templates any time, plus media and interactive messages.',
    tier: 'send',
    legacyCaps: ['send_messages'],
  },
  {
    key: 'broadcasts',
    area: 'chats',
    label: 'Broadcasts',
    description:
      'Message a whole uploaded list in one go. A broadcast reaches everyone on the list at once and Meta charges per message, so this is the highest-volume way to spend money from a chat.',
    tier: 'send',
    legacyCaps: ['area_broadcasts'],
  },
  {
    key: 'sales',
    area: 'sales',
    label: 'Products & Sales',
    description:
      'Read sales (who bought, what they paid, what they still owe), the product catalogue and per-product revenue. Read-only — it cannot charge anyone.',
    tier: 'read',
    legacyCaps: ['area_courses', 'area_payments'],
  },
  {
    key: 'social_insights',
    area: 'social',
    label: 'Social analytics',
    description: 'Read follower trends, reach and engagement per platform, the content library (every post with its numbers), audience demographics, connected accounts and login health. Read-only — from synced data, never live calls.',
    tier: 'read',
    // area_social is new, so no existing instance holds it: these seed OFF.
    legacyCaps: ['area_social'],
  },
  {
    key: 'social_inbox',
    area: 'social',
    label: 'Social inbox & contacts',
    description: 'Read Instagram DMs, comments on your posts and the Social contacts list. Read-only — it cannot reply.',
    tier: 'read',
    // area_social is new, so no existing instance holds it: these seed OFF.
    legacyCaps: ['area_social'],
  },
  {
    key: 'social_publish',
    area: 'social',
    label: 'Social replies',
    description: 'Reply publicly to comments and send Instagram DMs. Every one of these is seen by real people on the real platform.',
    tier: 'send',
    // area_social is new, so no existing instance holds it: these seed OFF.
    legacyCaps: ['area_social'],
  },
  {
    key: 'social_automations',
    area: 'social',
    label: 'Instagram automations & flows',
    description: 'Build, edit and read Instagram automations (comment-to-DM and keyword rules) and multi-step flows, and see how each one performed. Switching one ON makes it answer real people on its own. Deleting is a separate switch.',
    tier: 'build',
    // area_social is new, so no existing instance holds it: these seed OFF.
    legacyCaps: ['area_social'],
  },
  {
    key: 'social_agents',
    area: 'social',
    label: 'Social AI agents',
    description: 'Create and edit the AI agents that answer Instagram DMs and comments, attach tools, and read what they replied. Switching one live makes it answer real people. Deleting is a separate switch.',
    tier: 'build',
    // area_social is new, so no existing instance holds it: these seed OFF.
    legacyCaps: ['area_social'],
  },
  {
    key: 'google',
    area: 'admin',
    label: 'Google Workspace',
    description:
      'Search connected Google Drive spreadsheets and read their tabs and values — used when wiring a Google Sheets tool onto an agent.',
    tier: 'read',
    legacyCaps: ['discovery'],
  },
  {
    key: 'direct_api',
    area: 'admin',
    label: 'Direct API access',
    description:
      'The generic escape hatch: call any internal ForgeGrowth API endpoint as an admin. What it can actually reach is scoped separately by the API area switches below.',
    tier: 'advanced',
    // Seeded on if ANY area was previously on, because that is exactly when the
    // proxy was previously usable.
    legacyCaps: [
      'area_contacts', 'area_messaging', 'area_broadcasts', 'area_automations',
      'area_admin', 'area_insights', 'area_leads',
      'area_resources', 'area_courses', 'area_payments',
    ],
    legacyAny: true,
  },
];

/* ------------------------------- tools ---------------------------------- */

// name -> { category, summary }
// `summary` is what an admin reads in Settings when they expand a category, so
// it says what the tool DOES for them, not what function it calls.
const HAND_TOOLS = {
  /* --- Setup & Connections --- */
  list_wa_accounts:        { category: 'setup', summary: 'List the connected WhatsApp business numbers.' },
  list_models:             { category: 'setup', summary: 'List the connected AI models an agent can use.' },
  list_endpoints:          { category: 'setup', summary: 'List which API areas are currently reachable.' },

  /* --- Template Builder --- */
  list_templates:          { category: 'templates', summary: 'List message templates and their approval status.' },
  get_template:            { category: 'templates', summary: 'Read one template in full — body, header, footer, buttons.' },
  create_template:         { category: 'templates', summary: 'Draft a new WhatsApp template.' },
  submit_template:         { category: 'templates', summary: 'Submit a draft to Meta for approval.' },
  sync_template:           { category: 'templates', summary: 'Re-read a template’s approval status from Meta.' },

  /* --- Media Library --- */
  list_media:              { category: 'media', summary: 'List or search media library items by name or type.' },
  upload_media:            { category: 'media', summary: 'Upload a poster or file from a public URL into the library.' },

  /* --- AI Agents --- */
  list_agents:             { category: 'agents', summary: 'List the AI agents in this workspace.' },
  get_agent:               { category: 'agents', summary: 'Read one agent’s full configuration.' },
  create_agent:            { category: 'agents', summary: 'Create a new AI agent (always as a draft).' },
  update_agent:            { category: 'agents', summary: 'Edit an agent’s name, prompt, model or trigger.' },
  add_tool:                { category: 'agents', summary: 'Attach a tool to an agent.' },
  add_google_sheets_tool:  { category: 'agents', summary: 'Attach a Google Sheets tool to an agent.' },
  add_http_tool:           { category: 'agents', summary: 'Attach an HTTP request tool (external API or device).' },
  update_tool:             { category: 'agents', summary: 'Edit a tool already attached to an agent.' },

  /* --- Delete & remove --- */
  delete_agent:            { category: 'delete', summary: 'Permanently delete an AI agent.' },
  delete_tool:             { category: 'delete', summary: 'Permanently remove a tool from an agent.' },

  /* --- Automations --- */
  create_automation:       { category: 'automations', summary: 'Build an automation flow from a plain-language plan.' },
  list_automations:        { category: 'automations', summary: 'List the automation flows, or read one’s full graph.' },
  validate_automation:     { category: 'automations', summary: 'Check a flow for problems without saving it.' },
  update_automation:       { category: 'automations', summary: 'Edit a flow, or switch it live / pause it.' },
  get_automation_runs:     { category: 'automations', summary: 'Read what a flow actually did, step by step.' },

  list_analysed_chats:     { category: 'chat_analysis', summary: 'List conversations and what the analyser found in them.' },
  get_chat_analysis:       { category: 'chat_analysis', summary: 'Read one conversation\'s analysis, and what has been read of it so far.' },
  analyze_chat:            { category: 'chat_analysis', summary: 'Analyse one conversation now. Costs money; media costs more.' },
  get_chat_analysis_costs: { category: 'chat_analysis', summary: 'Estimated spend on analysis, split by media type.' },
  get_chat_transcript:     { category: 'chat_analysis', summary: 'Read a conversation word for word, with voice notes transcribed.' },
  transcribe_chat:         { category: 'chat_analysis', summary: 'Transcribe a conversation\'s voice notes (once each, then free).' },
  suggest_follow_up_date:  { category: 'chat_analysis', summary: 'Ask the AI for the best next follow-up date for a chat.' },
  get_chat_image:          { category: 'chat_analysis', summary: 'Look at images a customer sent. Free — no vision model involved.' },

  /* --- Leads & Funnel --- */
  list_leads:              { category: 'leads', summary: 'List leads, filtered by stage, source or saved view.' },
  move_lead_stage:         { category: 'leads', summary: 'Move a lead to a different funnel stage.' },
  list_follow_ups:         { category: 'leads', summary: 'Read the follow-up calendar: who to contact on which day.' },
  set_follow_up:           { category: 'leads', summary: 'Put a lead on the follow-up calendar (or reschedule them).' },
  update_follow_up:        { category: 'leads', summary: 'Reschedule, add a note, mark done or delete a follow-up.' },

  /* --- Conversations --- */
  list_conversations:      { category: 'inbox', summary: 'List recent conversations with 24-hour window status.' },
  read_messages:           { category: 'inbox', summary: 'Read one conversation’s message history.' },

  /* --- Send Messages --- */
  send_message:            { category: 'messaging', summary: 'Send a free-text reply (inside the 24-hour window).' },
  send_template:           { category: 'messaging', summary: 'Send an approved template — works any time.' },
  send_media:              { category: 'messaging', summary: 'Send a PDF, image, video or audio file.' },
  send_interactive:        { category: 'messaging', summary: 'Send buttons or a list message.' },

  /* --- Broadcasts --- */
  send_bulk_message:       { category: 'broadcasts', summary: 'Message an uploaded list of recipients in one broadcast.' },

  /* --- Products & Sales --- */
  list_products:           { category: 'sales', summary: 'List the product catalogue and prices.' },
  get_product_revenue:     { category: 'sales', summary: 'Read revenue collected per product.' },

  /* --- Google Workspace --- */
  search_spreadsheets:     { category: 'google', summary: 'Search connected Google Drive spreadsheets.' },
  list_sheet_tabs:         { category: 'google', summary: 'List the tabs inside a spreadsheet.' },
  read_sheet_values:       { category: 'google', summary: 'Read rows from a spreadsheet tab.' },

  /* --- Direct API access --- */
  forgechat_request:       { category: 'direct_api', summary: 'Call any internal API endpoint in an enabled area.' },
};

// Tools declared as data in mcpRouteTools.js are merged in here, so the
// catalog — and therefore the Settings screen and the gate — knows them without
// a second hand-typed entry. A name declared in both places is a bug.
const { ROUTE_TOOLS } = require('./mcpRouteTools');
const TOOLS = { ...HAND_TOOLS };
for (const t of ROUTE_TOOLS) {
  if (TOOLS[t.name]) throw new Error(`MCP tool '${t.name}' is declared twice (mcpCatalog + mcpRouteTools).`);
  TOOLS[t.name] = { category: t.category, summary: t.summary, kind: t.kind };
}

/* ------------------------------ helpers --------------------------------- */

const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));
const TOOL_NAMES = Object.keys(TOOLS);

// Tool name -> category key, or null when the tool is not in the catalog.
// Returning null (rather than throwing or defaulting) is what makes the gate
// default-deny: an unknown tool has no category, so it can never be enabled.
function toolCategory(name) {
  return TOOLS[name]?.category || null;
}

function toolsInCategory(key) {
  return TOOL_NAMES.filter(n => TOOLS[n].category === key).sort();
}

// What one tool does: its own `kind` when declared, a read-only verb prefix,
// else its category's tier.
function toolKind(name) {
  const t = TOOLS[name];
  if (!t) return null;
  if (t.kind) return t.kind;
  if (READ_PREFIX.test(name)) return 'read';
  return TIER_KIND[CATEGORY_BY_KEY[t.category]?.tier] || 'change';
}

// Is this tool allowed to run? The ONLY runtime gate for named tools.
// `categories` is the mcp_settings.categories JSONB. Anything not explicitly
// true is off — a missing key reads as disabled, so a category added by a
// future deploy is off until an admin turns it on.
function isToolAllowed(name, categories = {}) {
  const cat = toolCategory(name);
  if (!cat) return false;
  return categories[cat] === true;
}

// Human-readable refusal. Names the CATEGORY, not the internal capability, so
// the person reading it in Claude knows exactly which switch to flip.
function toolDeniedMessage(name) {
  const cat = toolCategory(name);
  if (!cat) {
    return `Unknown tool '${name}'. It is not in the MCP catalog, so it is refused.`;
  }
  const label = CATEGORY_BY_KEY[cat]?.label || cat;
  return `The '${label}' tool category is switched off for MCP access. Turn it on in ForgeGrowth -> Admin Settings -> MCP Tools.`;
}

// Seed category state from the OLD capabilities blob so an already-connected
// client behaves identically the moment this deploys.
//
// A category needs ALL of its legacy caps (`every`) unless it declares
// legacyAny. `every` is deliberate: it can only ever NARROW access relative to
// before, never widen it. Silently granting an MCP client something it did not
// have before is the one outcome a migration must never produce.
function seedCategories(capabilities = {}) {
  const out = {};
  for (const c of CATEGORIES) {
    const caps = c.legacyCaps || [];
    if (!caps.length) { out[c.key] = false; continue; }
    out[c.key] = c.legacyAny
      ? caps.some(k => capabilities[k] === true)
      : caps.every(k => capabilities[k] === true);
  }
  return out;
}

// Normalise a stored blob: drop unknown keys, coerce to strict booleans, and
// default any category missing from storage to false.
function normalizeCategories(stored = {}) {
  const out = {};
  for (const k of CATEGORY_KEYS) out[k] = stored[k] === true;
  return out;
}

// The shape the Settings screen renders itself from. Sent by GET /mcp/settings
// so the UI never hand-maintains its own copy of the category list — the exact
// drift that let a Settings tab render a button that silently did nothing.
function catalogForUi(categories = {}) {
  const cats = CATEGORIES.map(c => {
    // Reading tools first, then by risk, so the dangerous ones sit together at
    // the bottom of an expanded category instead of being scattered.
    const order = ['read', 'change', 'spend', 'send', 'delete', 'advanced'];
    const tools = toolsInCategory(c.key)
      .map(n => ({ name: n, summary: TOOLS[n].summary, kind: toolKind(n), kindLabel: KINDS[toolKind(n)]?.label }))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
    const kindCounts = {};
    for (const t of tools) kindCounts[t.kind] = (kindCounts[t.kind] || 0) + 1;
    return {
      key: c.key,
      area: c.area,
      label: c.label,
      description: c.description,
      tier: c.tier,
      tierLabel: TIERS[c.tier]?.label || c.tier,
      toolCount: tools.length,
      kindCounts,
      enabled: categories[c.key] === true,
      tools,
    };
  });
  return {
    tiers: TIERS,
    kinds: KINDS,
    apiAreas: API_AREAS,
    totalTools: TOOL_NAMES.length,
    areas: AREAS.map(a => ({ ...a, categories: cats.filter(c => c.area === a.key).map(c => c.key) })),
    categories: cats,
  };
}

module.exports = {
  TIERS,
  AREAS,
  KINDS,
  API_AREAS,
  toolKind,
  CATEGORIES,
  CATEGORY_KEYS,
  TOOLS,
  TOOL_NAMES,
  toolCategory,
  toolsInCategory,
  isToolAllowed,
  toolDeniedMessage,
  seedCategories,
  normalizeCategories,
  catalogForUi,
};
