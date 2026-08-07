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
    description: 'Creates or edits setup — templates, agents, flows, forms, funnel stages.',
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

/* ---------------------------- categories -------------------------------- */

// Order here is the order shown in Settings: setup first (what you connect),
// then the things you build, then the things that reach customers, then
// analytics, then the advanced escape hatch last.
const CATEGORIES = [
  {
    key: 'setup',
    label: 'Setup & Connections',
    description:
      'See which WhatsApp numbers, AI models and API areas are connected. This is how Claude discovers what your workspace actually has before it configures anything.',
    tier: 'read',
    legacyCaps: ['discovery'],
  },
  {
    key: 'templates',
    label: 'Template Builder',
    description:
      'Read, draft, submit for Meta approval and re-sync WhatsApp message templates. Everything needed to take a template from an idea to APPROVED without opening the app.',
    tier: 'build',
    legacyCaps: ['discovery', 'area_broadcasts'],
  },
  {
    key: 'media',
    label: 'Media Library',
    description:
      'List and upload posters, images, video and documents, and sync them to each WhatsApp account so templates and sends can use them.',
    tier: 'build',
    legacyCaps: ['discovery', 'area_broadcasts'],
  },
  {
    key: 'agents',
    label: 'AI Agents',
    description:
      'Create and configure the AI agents that talk to customers on WhatsApp — persona, model, trigger, and their Google Sheets / HTTP tools.',
    tier: 'build',
    legacyCaps: ['discovery', 'create_agent', 'update_agent', 'manage_tools'],
  },
  {
    key: 'delete',
    label: 'Delete & remove',
    description:
      'Let Claude delete an agent outright, or strip a tool off one. Kept out of AI Agents deliberately — building and deleting are different decisions, and this is the only category whose actions cannot be undone.',
    tier: 'destructive',
    legacyCaps: ['delete'],
  },
  {
    key: 'automations',
    label: 'Automations',
    description:
      'Build automation flows — the trigger/message/condition/action graphs that run when a customer messages in.',
    tier: 'build',
    legacyCaps: ['area_automations'],
  },
  {
    key: 'forms',
    label: 'Lead Forms',
    description:
      'Create shareable lead-capture forms and read who filled them in.',
    tier: 'build',
    legacyCaps: ['area_leadforms'],
  },
  {
    key: 'projects',
    label: 'Projects',
    description:
      'File a template, automation, AI agent, follow-up sequence or form into a campaign project — or take it out again. It only changes which folder something is listed under: nothing is created, edited, activated or sent.',
    // Its own category rather than folded into Templates or Lead Forms: the one
    // tool moves FIVE different kinds, so hiding it under any one of them would
    // make "is this on?" unanswerable from the Settings screen.
    tier: 'build',
    // Matches where /projects resolves in PROXY_AREAS, so the named tools and
    // the generic proxy grant the same reach rather than one being a way past
    // the other.
    legacyCaps: ['area_broadcasts'],
  },
  {
    key: 'leads',
    label: 'Leads & Funnel',
    description:
      'Read the lead list and move a lead between funnel stages. This is the funnel Claude reshapes when you hand it a game plan.',
    tier: 'build',
    legacyCaps: ['area_leads'],
  },
  {
    key: 'inbox',
    label: 'Conversations',
    description:
      'Read WhatsApp conversations and message history, including whether the 24-hour reply window is still open. Read-only — it cannot send.',
    tier: 'read',
    legacyCaps: ['read_messages'],
  },
  {
    key: 'messaging',
    label: 'Send Messages',
    description:
      'Send a real WhatsApp message to one person — free text inside the 24-hour window, approved templates any time, plus media and interactive messages.',
    tier: 'send',
    legacyCaps: ['send_messages'],
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts',
    description:
      'Message a whole uploaded list in one go. A broadcast reaches everyone on the list at once and Meta charges per message, so this is the highest-volume way to spend money from a chat.',
    tier: 'send',
    legacyCaps: ['area_broadcasts'],
  },
  {
    key: 'message_formats',
    label: 'Message Formats',
    description:
      'Generate trackable click-to-chat links with a pre-filled opening message, so you can tell which campaign a lead arrived from.',
    // Kept apart from Broadcasts even though it is one tool: Message Formats is
    // its own feature, and minting a link nobody has clicked yet is nothing
    // like blasting a list. Bundling them only because each was small would put
    // a harmless action behind a switch labelled as spending money.
    tier: 'build',
    legacyCaps: ['area_broadcasts'],
  },
  {
    key: 'marketing',
    label: 'Marketing Analytics',
    description:
      'Read campaign performance (including Meta Ads spend), webinars, and BDA activity. Read-only reporting.',
    tier: 'read',
    legacyCaps: ['area_marketing', 'area_bda'],
  },
  {
    key: 'sales',
    label: 'Products & Payments',
    description:
      'Read the product catalogue, per-product revenue and the payment ledger. Read-only — it cannot mint a payment link or charge anyone.',
    tier: 'read',
    legacyCaps: ['area_courses', 'area_payments'],
  },
  {
    key: 'google',
    label: 'Google Workspace',
    description:
      'Search connected Google Drive spreadsheets and read their tabs and values — used when wiring a Google Sheets tool onto an agent.',
    tier: 'read',
    legacyCaps: ['discovery'],
  },
  {
    key: 'direct_api',
    label: 'Direct API access',
    description:
      'The generic escape hatch: call any internal ForgeGrowth API endpoint as an admin. What it can actually reach is scoped separately by the API area switches below.',
    tier: 'advanced',
    // Seeded on if ANY area was previously on, because that is exactly when the
    // proxy was previously usable.
    legacyCaps: [
      'area_contacts', 'area_messaging', 'area_broadcasts', 'area_automations',
      'area_admin', 'area_insights', 'area_leads', 'area_marketing',
      'area_resources', 'area_bda', 'area_courses', 'area_payments',
      'area_leadforms',
    ],
    legacyAny: true,
  },
];

/* ------------------------------- tools ---------------------------------- */

// name -> { category, summary }
// `summary` is what an admin reads in Settings when they expand a category, so
// it says what the tool DOES for them, not what function it calls.
const TOOLS = {
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

  /* --- Lead Forms --- */
  create_lead_form:        { category: 'forms', summary: 'Create a shareable lead-capture form.' },
  list_lead_forms:         { category: 'forms', summary: 'List the lead forms and their public links.' },
  list_form_submissions:   { category: 'forms', summary: 'Read the responses a form has collected.' },

  /* --- Projects --- */
  list_projects:           { category: 'projects', summary: 'List campaign projects and what each one holds.' },
  move_to_project:         { category: 'projects', summary: 'File a template, automation, agent, follow-up or form into a project.' },

  /* --- Leads & Funnel --- */
  list_leads:              { category: 'leads', summary: 'List leads, filtered by stage, source or saved view.' },
  move_lead_stage:         { category: 'leads', summary: 'Move a lead to a different funnel stage.' },

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

  /* --- Message Formats --- */
  create_wa_link:          { category: 'message_formats', summary: 'Generate a trackable click-to-chat link.' },

  /* --- Marketing Analytics --- */
  get_campaign_performance: { category: 'marketing', summary: 'Read campaign spend, leads and results.' },
  list_webinars:           { category: 'marketing', summary: 'List webinars and their registrations.' },
  get_bda_activity:        { category: 'marketing', summary: 'Read the BDA leaderboard and activity log.' },

  /* --- Products & Payments --- */
  list_products:           { category: 'sales', summary: 'List the product catalogue and prices.' },
  get_product_revenue:     { category: 'sales', summary: 'Read revenue collected per product.' },
  list_payments:           { category: 'sales', summary: 'Read the payment ledger — who paid, failed or refunded.' },

  /* --- Google Workspace --- */
  search_spreadsheets:     { category: 'google', summary: 'Search connected Google Drive spreadsheets.' },
  list_sheet_tabs:         { category: 'google', summary: 'List the tabs inside a spreadsheet.' },
  read_sheet_values:       { category: 'google', summary: 'Read rows from a spreadsheet tab.' },

  /* --- Direct API access --- */
  forgechat_request:       { category: 'direct_api', summary: 'Call any internal API endpoint in an enabled area.' },
};

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
  return {
    tiers: TIERS,
    totalTools: TOOL_NAMES.length,
    categories: CATEGORIES.map(c => {
      const tools = toolsInCategory(c.key);
      return {
        key: c.key,
        label: c.label,
        description: c.description,
        tier: c.tier,
        tierLabel: TIERS[c.tier]?.label || c.tier,
        toolCount: tools.length,
        enabled: categories[c.key] === true,
        tools: tools.map(n => ({ name: n, summary: TOOLS[n].summary })),
      };
    }),
  };
}

module.exports = {
  TIERS,
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
