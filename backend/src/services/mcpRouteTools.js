// MCP tools declared ONCE, as plain data, and loaded by BOTH transports.
//
// WHY THIS FILE EXISTS
// --------------------
// Every tool used to be typed out twice — in backend/src/mcpHttp.js (the hosted
// connector) and again in mcp-server/src/index.js (local stdio) — plus a REST
// route on the apiRouter for the stdio copy to call. That is three hand-kept
// copies of one fact, and they had already drifted (get_ad_conversions existed
// over HTTP only). A tool here is declared once:
//
//   * mcpHttp.js loops over ROUTE_TOOLS and registers each one;
//   * mcp-server/src/index.js requires THIS SAME FILE and registers each one,
//     calling POST /api/mcp/v1/route-tools/<name>;
//   * mcpCatalog.js merges each entry's category / summary / kind, so the
//     Settings screen lists it with no second copy.
//
// Parity between the transports is therefore true by construction.
//
// ⚠ RULES FOR THIS FILE
//   1. PURE DATA. No require() of anything — the stdio server loads it from
//      outside the backend package, where the database and services do not exist.
//   2. NO BUSINESS LOGIC. A tool either calls a REAL route (`route`) — so every
//      validation, permission check, audit row and SSE emit that route performs
//      still applies — or a named function on an existing service (`service`,
//      resolved in services/mcpRouteToolRunner.js). Never a third implementation.
//   3. The CATEGORY is the gate (see mcpCatalog.js). Anything that moves money
//      or ad spend does not belong here at all; it stays behind area_admin.
//
// Param spec: { type, desc, required?, enum?, items?, min?, max? }
//   type: string | number | integer | boolean | object | array | any | id
//   (`id` accepts a string or a number.)
//
// Route spec: { method, path, query?, body? }
//   path:  '{name}' placeholders are filled (URL-encoded) from the args.
//   query: list of arg names sent as the query string.
//   body:  list of arg names sent as the JSON body, '*' = every arg that is not
//          a path placeholder, or { from: '<arg>' } = that one arg IS the body.

const PLATFORMS = ['instagram'];
const COMMENT_PLATFORMS = ['instagram'];
const PERIODS = ['7D', '30D', '90D'];

const ROUTE_TOOLS = [
  /* ===================================================================== */
  /* SOCIAL — analytics (read)                                              */
  /* ===================================================================== */
  {
    name: 'social_get_overview', category: 'social_insights', kind: 'read',
    summary: 'Cross-platform social summary: audience, growth, reach and engagement.',
    title: 'Social overview',
    description: 'KPI roll-up across connected Instagram accounts: total audience, net growth, impressions, average engagement, and a per-platform breakdown with last-sync time. Start here for "how is social doing". Reads synced data only — never calls the platforms.',
    params: { period: { type: 'string', enum: PERIODS, desc: 'Reporting window (default 30D).' } },
    service: 'social.getOverview',
  },
  {
    name: 'social_get_platform_stats', category: 'social_insights', kind: 'read',
    summary: 'Full stats for one platform: followers, reach, engagement, top posts.',
    title: 'Social platform stats',
    description: 'Full analytics for ONE platform: followers, growth, impressions/views, engagement rate, daily trend arrays and top posts. account = a connected account id, "all" for combined, or omit for the primary account (get ids from social_list_accounts).',
    params: {
      platform: { type: 'string', enum: PLATFORMS, required: true, desc: 'Which platform.' },
      period: { type: 'string', enum: PERIODS, desc: 'Default 30D.' },
      account: { type: 'string', desc: 'Account id, or "all".' },
    },
    service: 'social.getPlatformStats',
  },
  {
    name: 'social_get_followers_trend', category: 'social_insights', kind: 'read',
    summary: 'Follower count over time for one platform.',
    title: 'Social followers trend',
    description: 'Follower-count time series for one platform — by hours (up to 168), days (up to 90) or weeks (up to 52). Use for growth-over-time questions and spotting spikes or drops.',
    params: {
      platform: { type: 'string', enum: PLATFORMS, required: true, desc: 'Which platform.' },
      unit: { type: 'string', enum: ['hours', 'days', 'weeks'], desc: 'Default days.' },
      range: { type: 'integer', min: 1, max: 168, desc: 'How many units back (defaults 24 hours / 30 days / 8 weeks).' },
      account: { type: 'string', desc: 'Account id, or "all".' },
    },
    service: 'social.getFollowersTrend',
  },
  {
    name: 'social_get_audience', category: 'social_insights', kind: 'read',
    summary: 'Audience age, gender, country and active hours.',
    title: 'Social audience',
    description: 'Cached audience insights per platform/account: age, gender and country, and Instagram online-follower hours. Refreshed once a day.',
    params: { platform: { type: 'string', enum: PLATFORMS, desc: 'Omit for every platform.' } },
    service: 'social.getAudienceInsights',
  },
  {
    name: 'social_get_executive_summary', category: 'social_insights', kind: 'read',
    summary: 'Ranked scorecard of the platforms, with where to focus.',
    title: 'Social executive summary',
    description: 'A ranked cross-platform scorecard: growth %, engagement rate, posting cadence, trajectory, best format and theme, and deltas vs the previous equal window, plus "where to focus" lines and flagged anomalies. Only growth %, engagement rate and cadence are comparable across platforms — never rank platforms on reach or impressions.',
    params: { period: { type: 'string', enum: PERIODS, desc: 'Default 30D.' } },
    service: 'social.getExecutiveSummary',
  },
  {
    name: 'social_get_content_themes', category: 'social_insights', kind: 'read',
    summary: 'Which content themes perform best.',
    title: 'Social content themes',
    description: 'Per content theme (posts are auto-categorised from caption and hashtags): post count, share of output, average views, engagement and score, and the trend vs the previous window. Use for "what content works".',
    params: {
      platform: { type: 'string', enum: PLATFORMS, desc: 'Omit for all platforms.' },
      period: { type: 'string', enum: PERIODS, desc: 'Default 30D.' },
    },
    service: 'social.getContentThemes',
  },
  {
    name: 'social_list_posts', category: 'social_insights', kind: 'read',
    summary: 'The content library: published posts with their numbers.',
    title: 'Social posts (content library)',
    description: 'Published posts across all platforms with views, engagements, likes, comments, shares, saves and the 1-99 content score. Filter by platform, text or recency; sort by any metric.',
    params: {
      platform: { type: 'string', enum: PLATFORMS },
      q: { type: 'string', desc: 'Search caption, title or topic.' },
      days: { type: 'integer', min: 1, max: 365, desc: 'Only the last N days.' },
      sortBy: { type: 'string', enum: ['date', 'score', 'views', 'engagements', 'likes', 'comments'], desc: 'Default date.' },
      limit: { type: 'integer', min: 1, max: 200, desc: 'Default 50.' },
    },
    service: 'social.listPosts',
  },
  {
    name: 'social_list_accounts', category: 'social_insights', kind: 'read',
    summary: 'Connected Instagram accounts.',
    title: 'Social connected accounts',
    description: 'Every connected social account across platforms with its label/username. The accountId values are what the other social tools — and Instagram automations, flows and agents — take as account_id / accountId.',
    params: {},
    service: 'social.listConnectedAccounts',
  },
  {
    name: 'social_get_token_health', category: 'social_insights', kind: 'read',
    summary: 'Which social logins are about to expire or need reconnecting.',
    title: 'Social token health',
    description: 'Login (token) health for every connected social credential: days until expiry, last refresh, and which accounts need attention.',
    params: {},
    service: 'social.getTokenHealth',
  },

  /* ===================================================================== */
  /* SOCIAL — inbox, comments, contacts (read)                             */
  /* ===================================================================== */
  {
    name: 'social_list_messages', category: 'social_inbox', kind: 'read',
    summary: 'Read Instagram DMs.',
    title: 'Social DMs',
    description: 'Instagram direct messages (newest first) with the sender\'s name/username. Filter by account id, peer id or text.',
    params: {
      account: { type: 'string', desc: 'Connected Instagram account id.' },
      peer: { type: 'string', desc: 'One conversation partner (IGSID).' },
      q: { type: 'string' },
      limit: { type: 'integer', min: 1, max: 500 },
    },
    service: 'social.listMessages',
  },
  {
    name: 'social_list_comments', category: 'social_inbox', kind: 'read',
    summary: 'Read comments on your posts.',
    title: 'Social comments',
    description: 'Comments on our posts for one platform, newest first, with the parent post caption/permalink. The commentId values are what social_reply_to_comment takes.',
    params: {
      platform: { type: 'string', enum: COMMENT_PLATFORMS, required: true },
      account: { type: 'string', desc: 'Instagram only: a connected account id.' },
      q: { type: 'string' },
      limit: { type: 'integer', min: 1, max: 500 },
    },
    service: 'social.listComments',
  },
  {
    name: 'social_list_contacts', category: 'social_inbox', kind: 'read',
    summary: 'Read the Social contacts list (people who messaged you).',
    title: 'Social contacts',
    description: 'Contacts built from Instagram DM history: identity, notes, tags, first/last activity, message count and last message.',
    params: {
      q: { type: 'string' },
      account: { type: 'string' },
      tag: { type: 'string', desc: 'A tag id.' },
      limit: { type: 'integer', min: 1, max: 500 },
    },
    service: 'social.listContacts',
  },
  /* ===================================================================== */
  /* SOCIAL — reaches people (send)                                         */
  /* ===================================================================== */
  {
    name: 'social_reply_to_comment', category: 'social_publish', kind: 'send',
    summary: 'Post a public reply under a comment.',
    title: 'Reply to a social comment',
    description: 'Post a PUBLIC reply under an Instagram comment. Get commentId from social_list_comments and CONFIRM the text with the user first.',
    params: {
      platform: { type: 'string', enum: COMMENT_PLATFORMS, required: true },
      commentId: { type: 'string', required: true },
      message: { type: 'string', required: true },
      accountId: { type: 'string', desc: 'Instagram only: the account that replies.' },
    },
    service: 'social.replyToComment',
  },
  {
    name: 'social_send_dm', category: 'social_publish', kind: 'send',
    summary: 'Send an Instagram DM.',
    title: 'Send an Instagram DM',
    description: 'Send a direct message from a connected Instagram account. Instagram allows this only within 24 hours of the person\'s last message. CONFIRM the text with the user first.',
    params: {
      accountId: { type: 'string', required: true },
      recipientId: { type: 'string', required: true, desc: 'Peer id (IGSID) from social_list_messages.' },
      text: { type: 'string', required: true },
    },
    service: 'social.sendInstagramDm',
  },
  /* ===================================================================== */
  /* SOCIAL — Instagram automations (keyword rules) and flows (build)      */
  /* ===================================================================== */
  {
    name: 'social_get_automation_options', category: 'social_automations', kind: 'read',
    summary: 'What an Instagram automation can be set to (triggers, field types).',
    title: 'Instagram automation options',
    description: 'The allowed values for an Instagram automation rule: triggers (comment, dm, postback, story_reply, story_mention), the field types a rule can collect, the per-hour send cap and whether Google Sheets is set up. Call this before creating a rule.',
    params: {},
    route: { method: 'GET', path: '/social/ig-automations/meta' },
  },
  {
    name: 'social_list_automations', category: 'social_automations', kind: 'read',
    summary: 'List Instagram automations (comment/DM keyword rules) and their results.',
    title: 'List Instagram automations',
    description: 'Instagram automation RULES (comment-to-DM, keyword DMs, story replies) with how often each fired, leads collected, link clicks and CTR. Optionally one account.',
    params: { account_id: { type: 'string', desc: 'Connected Instagram account id.' } },
    route: { method: 'GET', path: '/social/ig-automations', query: ['account_id'] },
  },
  {
    name: 'social_list_instagram_posts', category: 'social_automations', kind: 'read',
    summary: 'Instagram posts an automation can be attached to.',
    title: 'Instagram posts for automations',
    description: 'The posts of one Instagram account, for picking media_id when a rule should fire only on one post.',
    params: { account_id: { type: 'string', required: true } },
    route: { method: 'GET', path: '/social/ig-automations/posts', query: ['account_id'] },
  },
  {
    name: 'social_create_automation', category: 'social_automations', kind: 'change',
    summary: 'Create an Instagram automation rule.',
    title: 'Create an Instagram automation',
    description:
      'Create an Instagram automation RULE. rule fields: name, account_id (REQUIRED — from social_list_accounts), trigger (comment | dm | postback | story_reply | story_mention), ' +
      'media_id (one post, or null for every post), keywords (array), match_type (contains | exact | starts_with), reply_texts (array of public comment replies, one picked at random), ' +
      'dm_message (text, or an object), dm_fallback_text, once_per_user, include_replies, tags (array), follow_gate + gate_text/gate_button/follow_gate_text, ' +
      'collect (array of {key,type,label,prompt} — type name|email|phone|text), collect_done_text, sheet_id + sheet_tab, opening_dm, ' +
      'followup_enabled + followup_delay_min (15-1380) + followup_text + followup_link, active. ' +
      'It starts sending real DMs as soon as active is true, so create it with active:false, show the user, then turn it on with social_update_automation.',
    params: { rule: { type: 'object', required: true, desc: 'The rule fields listed above.' } },
    route: { method: 'POST', path: '/social/ig-automations', body: { from: 'rule' } },
  },
  {
    name: 'social_update_automation', category: 'social_automations', kind: 'change',
    summary: 'Edit an Instagram automation rule, or switch it on/off.',
    title: 'Update an Instagram automation',
    description: 'Change any fields of an Instagram automation rule (same fields as social_create_automation; send only what changes). changes:{active:true} switches it on — it then replies to real people.',
    params: {
      id: { type: 'id', required: true },
      changes: { type: 'object', required: true },
    },
    route: { method: 'PUT', path: '/social/ig-automations/{id}', body: { from: 'changes' } },
  },
  {
    name: 'social_get_automation_results', category: 'social_automations', kind: 'read',
    summary: 'How one Instagram automation performed, day by day.',
    title: 'Instagram automation results',
    description: 'Results for one rule over the last N days: fires, DMs, link clicks, leads.',
    params: { id: { type: 'id', required: true }, days: { type: 'integer', min: 1, max: 365 } },
    route: { method: 'GET', path: '/social/ig-automations/{id}/insights', query: ['days'] },
  },
  {
    name: 'social_list_automation_leads', category: 'social_automations', kind: 'read',
    summary: 'People an Instagram automation collected details from.',
    title: 'Instagram automation leads',
    description: 'Answers collected by automation rules (name, email, phone…), optionally for one rule or account.',
    params: {
      rule_id: { type: 'id' }, account_id: { type: 'string' },
      limit: { type: 'integer', min: 1, max: 1000 },
    },
    route: { method: 'GET', path: '/social/ig-automations/leads', query: ['rule_id', 'account_id', 'limit'] },
  },
  {
    name: 'social_list_flows', category: 'social_automations', kind: 'read',
    summary: 'List Instagram flows (multi-step conversations).',
    title: 'List Instagram flows',
    description: 'Instagram FLOWS — multi-step DM conversations built on the canvas — with runs, link sends, clicks and last run. Each row carries its full graph.',
    params: { account_id: { type: 'string' } },
    route: { method: 'GET', path: '/social/ig-automations/flows', query: ['account_id'] },
  },
  {
    name: 'social_get_flow', category: 'social_automations', kind: 'read',
    summary: 'Read one Instagram flow in full.',
    title: 'Read an Instagram flow',
    description: 'One Instagram flow with its full graph {nodes, edges}. Read an existing flow before building a new one so the step types and data fields match exactly.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'GET', path: '/social/ig-automations/flows/{id}' },
  },
  {
    name: 'social_get_flow_results', category: 'social_automations', kind: 'read',
    summary: 'How one Instagram flow performed, step by step.',
    title: 'Instagram flow results',
    description: 'Runs, completed, in progress, failed, sends per step, link clicks/CTR and the 30 most recent runs for one flow.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'GET', path: '/social/ig-automations/flows/{id}/insights' },
  },
  {
    name: 'social_create_flow', category: 'social_automations', kind: 'change',
    summary: 'Create an Instagram flow.',
    title: 'Create an Instagram flow',
    description:
      'Create an Instagram flow. flow = { name, account_id (from social_list_accounts), active (default false), graph: { nodes:[{id, type, position:{x,y}, data}], edges:[{source, sourceHandle, target}] } }. ' +
      'The graph needs EXACTLY ONE node of type "trigger" (its data.triggers lists comment / dm / story_reply / story_mention triggers with keywords). ' +
      'Copy node types and data shapes from an existing flow (social_get_flow) — do not invent them. Keep active:false until the user has seen it.',
    params: { flow: { type: 'object', required: true } },
    route: { method: 'POST', path: '/social/ig-automations/flows', body: { from: 'flow' } },
  },
  {
    name: 'social_update_flow', category: 'social_automations', kind: 'change',
    summary: 'Edit an Instagram flow, or switch it on/off.',
    title: 'Update an Instagram flow',
    description: 'Change a flow\'s name, account, graph or active state. changes:{active:false} also stops every run still waiting on someone.',
    params: { id: { type: 'id', required: true }, changes: { type: 'object', required: true } },
    route: { method: 'PUT', path: '/social/ig-automations/flows/{id}', body: { from: 'changes' } },
  },

  /* ===================================================================== */
  /* SOCIAL — AI agents (build)                                             */
  /* ===================================================================== */
  {
    name: 'social_list_agents', category: 'social_agents', kind: 'read',
    summary: 'List the Social AI agents (Instagram replies).',
    title: 'List Social AI agents',
    description: 'AI agents that answer Instagram DMs and comments, with their channel, status and tool counts.',
    params: {},
    route: { method: 'GET', path: '/social/agents' },
  },
  {
    name: 'social_get_agent', category: 'social_agents', kind: 'read',
    summary: 'Read one Social AI agent in full.',
    title: 'Read a Social AI agent',
    description: 'One Social AI agent with every setting and its tools.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'GET', path: '/social/agents/{id}' },
  },
  {
    name: 'social_list_agent_models', category: 'social_agents', kind: 'read',
    summary: 'AI models a Social agent or flow can use.',
    title: 'Social AI models',
    description: 'The AI model credentials and model ids available to Social agents and flow AI steps.',
    params: {},
    route: { method: 'GET', path: '/social/ig-automations/flows/ai-models' },
  },
  {
    name: 'social_create_agent', category: 'social_agents', kind: 'change',
    summary: 'Create a Social AI agent (as a draft).',
    title: 'Create a Social AI agent',
    description:
      'Create a Social AI agent. agent = { name, systemPrompt (REQUIRED), description, aiModelId + llmModel (from social_list_agent_models; needed to go active), ' +
      'platform (instagram | facebook), accountId (+ accountLabel) from social_list_accounts, replyDms, replyComments, ' +
      'triggerMode (any | keyword) + triggerKeyword + triggerMatchType + triggerCaseSensitive + triggerSessionMinutes, contextWindowMessages, maxToolIterations, ' +
      'acceptImages, transcribeAudio, humanize, minDelaySec, maxDelaySec, enableHandoff + handoffInstructions, autoTags, status (draft | active) }. ' +
      'Create it as status:"draft", confirm with the user, then social_update_agent {status:"active", isActive:true}.',
    params: { agent: { type: 'object', required: true } },
    route: { method: 'POST', path: '/social/agents', body: { from: 'agent' } },
  },
  {
    name: 'social_update_agent', category: 'social_agents', kind: 'change',
    summary: 'Edit a Social AI agent, or switch it live.',
    title: 'Update a Social AI agent',
    description: 'Change any Social agent setting (same fields as social_create_agent; send only what changes). status:"active" + isActive:true makes it answer real people.',
    params: { id: { type: 'id', required: true }, changes: { type: 'object', required: true } },
    route: { method: 'PUT', path: '/social/agents/{id}', body: { from: 'changes' } },
  },
  {
    name: 'social_add_agent_tool', category: 'social_agents', kind: 'change',
    summary: 'Attach a tool to a Social AI agent.',
    title: 'Add a tool to a Social AI agent',
    description: 'Attach a tool (e.g. a Google Sheets or HTTP tool) to a Social agent. Read an agent that already has one (social_get_agent) to copy the exact shape.',
    params: { id: { type: 'id', required: true }, tool: { type: 'object', required: true } },
    route: { method: 'POST', path: '/social/agents/{id}/tools', body: { from: 'tool' } },
  },
  {
    name: 'social_update_agent_tool', category: 'social_agents', kind: 'change',
    summary: 'Edit a tool on a Social AI agent.',
    title: 'Update a Social agent tool',
    description: 'Change a tool already attached to a Social agent.',
    params: { id: { type: 'id', required: true }, toolId: { type: 'id', required: true }, changes: { type: 'object', required: true } },
    route: { method: 'PUT', path: '/social/agents/{id}/tools/{toolId}', body: { from: 'changes' } },
  },
  {
    name: 'social_get_agent_runs', category: 'social_agents', kind: 'read',
    summary: 'What a Social AI agent said, run by run.',
    title: 'Social AI agent runs',
    description: 'Recent runs of one Social agent: who it answered, what it replied, tools used, errors.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'GET', path: '/social/agents/{id}/runs' },
  },

  /* ===================================================================== */
  /* DELETE — everything that cannot be undone sits in one category        */
  /* ===================================================================== */
  {
    name: 'delete_automation', category: 'delete', kind: 'delete',
    summary: 'Permanently delete a WhatsApp automation flow.',
    title: 'Delete a WhatsApp automation',
    description: 'Permanently delete a WhatsApp automation flow. There is no undo — confirm with the user. Pausing it (update_automation {active:false}) is usually what they want.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'DELETE', path: '/chatbots/{id}' },
  },
  {
    name: 'social_delete_automation', category: 'delete', kind: 'delete',
    summary: 'Permanently delete an Instagram automation rule.',
    title: 'Delete an Instagram automation',
    description: 'Permanently delete an Instagram automation rule. No undo — confirm first.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'DELETE', path: '/social/ig-automations/{id}' },
  },
  {
    name: 'social_delete_flow', category: 'delete', kind: 'delete',
    summary: 'Permanently delete an Instagram flow.',
    title: 'Delete an Instagram flow',
    description: 'Permanently delete an Instagram flow and its run history. No undo — confirm first.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'DELETE', path: '/social/ig-automations/flows/{id}' },
  },
  {
    name: 'social_delete_agent', category: 'delete', kind: 'delete',
    summary: 'Permanently delete a Social AI agent.',
    title: 'Delete a Social AI agent',
    description: 'Permanently delete a Social AI agent. No undo — confirm first.',
    params: { id: { type: 'id', required: true } },
    route: { method: 'DELETE', path: '/social/agents/{id}' },
  },
  {
    name: 'social_delete_agent_tool', category: 'delete', kind: 'delete',
    summary: 'Remove a tool from a Social AI agent.',
    title: 'Remove a Social agent tool',
    description: 'Permanently remove a tool from a Social agent.',
    params: { id: { type: 'id', required: true }, toolId: { type: 'id', required: true } },
    route: { method: 'DELETE', path: '/social/agents/{id}/tools/{toolId}' },
  },

  /* ===================================================================== */
  /* SALES — leads, funnel                                                  */
  /* ===================================================================== */
  {
    name: 'get_lead', category: 'leads', kind: 'read',
    summary: 'Read one lead in full, including payment status.',
    title: 'Read a lead',
    description: 'One lead: profile, stage, source, owner, custom fields, product, amount paid, payment status and what is still owed.',
    params: { id: { type: 'id', required: true, desc: 'Lead id from list_leads.' } },
    route: { method: 'GET', path: '/leads/{id}' },
  },
  {
    name: 'update_lead', category: 'leads', kind: 'change',
    summary: 'Edit a lead\'s details (name, email, city, product, custom fields).',
    title: 'Update a lead',
    description:
      'Edit a lead\'s profile. changes may include name, email, city, age, profession, pincode, paidCourse (product name), paymentStatus (paid | partial | unpaid, or "auto" to derive it), ' +
      'customFieldsMerge (object of custom field values) and customFieldsRemove (array of keys). To change the funnel STAGE use move_lead_stage — it writes the audit row the rest of the app relies on.',
    params: { id: { type: 'id', required: true }, changes: { type: 'object', required: true } },
    route: { method: 'PUT', path: '/leads/{id}', body: { from: 'changes' } },
  },
  {
    name: 'get_funnel', category: 'leads', kind: 'read',
    summary: 'The funnel stages in order, and the lead sources.',
    title: 'Funnel stages and sources',
    description: 'The configured funnel: stages in order (stage_key, label, colour, which one counts as won) and the managed lead sources. Use stage_key values with move_lead_stage.',
    params: {},
    route: { method: 'GET', path: '/funnel/config' },
  },
  {
    name: 'get_funnel_chart', category: 'leads', kind: 'read',
    summary: 'How many leads sit in each funnel stage.',
    title: 'Funnel counts',
    description: 'Lead counts per funnel stage, optionally for one source and a date range.',
    params: {
      source: { type: 'string' },
      from: { type: 'string', desc: 'YYYY-MM-DD' },
      to: { type: 'string', desc: 'YYYY-MM-DD' },
    },
    route: { method: 'GET', path: '/funnel/chart', query: ['source', 'from', 'to'] },
  },

  /* ===================================================================== */
  /* SALES — sales and their payments                                      */
  /* ===================================================================== */
  {
    name: 'list_sales', category: 'sales', kind: 'read',
    summary: 'Every customer who bought, with total paid and payment status.',
    title: 'Sales',
    description: 'Every sale (a lead at the won stage) with product, total paid, payment status (fully paid / partly paid / unpaid) and the WhatsApp chat it belongs to.',
    params: {},
    route: { method: 'GET', path: '/students' },
  },
  {
    name: 'get_sale_transactions', category: 'sales', kind: 'read',
    summary: 'One customer\'s payments and instalments.',
    title: 'Sale transactions',
    description: 'Every payment recorded for one sale, each with amount, method and date.',
    params: { id: { type: 'id', required: true, desc: 'The lead id of the sale (from list_sales).' } },
    route: { method: 'GET', path: '/students/{id}/installments' },
  },
  /* ===================================================================== */
  /* CHATS — automations, agents, numbers                                   */
  /* ===================================================================== */
  {
    name: 'get_agent_runs', category: 'agents', kind: 'read',
    summary: 'What a WhatsApp AI agent replied, run by run.',
    title: 'WhatsApp AI agent runs',
    description: 'Recent runs of one WhatsApp AI agent: who it answered, its reply, tools used, and why a message was not answered (limits, pauses).',
    params: { id: { type: 'id', required: true } },
    route: { method: 'GET', path: '/agents/{id}/runs' },
  },
  {
    name: 'rename_wa_number', category: 'setup', kind: 'change',
    summary: 'Give a WhatsApp number a short display label.',
    title: 'Rename a WhatsApp number',
    description: 'Set the display LABEL of a connected WhatsApp number (e.g. "Acme – Sales desk"), shown wherever the number is listed or picked. It never changes the real number or the name customers see on WhatsApp. label:null goes back to the account name. id from list_wa_accounts.',
    params: { id: { type: 'id', required: true }, label: { type: 'string', desc: 'Up to 60 characters; empty or null clears it.' } },
    route: { method: 'PUT', path: '/whatsapp-accounts/{id}/label', body: ['label'] },
  },
];

// Turn a param spec into a zod input schema. Takes `z` as an argument so this
// file stays dependency-free (the stdio server passes its own zod).
function buildInputSchema(z, params = {}) {
  const shape = {};
  for (const [key, p] of Object.entries(params)) {
    let t;
    switch (p.type) {
      case 'number': t = z.number(); break;
      case 'integer': t = z.number().int(); break;
      case 'boolean': t = z.boolean(); break;
      case 'object': t = z.record(z.any()); break;
      case 'array': t = z.array(p.items === 'number' ? z.number() : p.items === 'string' ? z.string() : z.any()); break;
      case 'id': t = z.union([z.string(), z.number()]); break;
      case 'any': t = z.any(); break;
      default: t = p.enum ? z.enum(p.enum) : z.string();
    }
    if ((p.type === 'number' || p.type === 'integer') && p.min != null) t = t.min(p.min);
    if ((p.type === 'number' || p.type === 'integer') && p.max != null) t = t.max(p.max);
    if (p.desc) t = t.describe(p.desc);
    if (!p.required) t = t.nullable().optional();
    shape[key] = t;
  }
  return shape;
}

const ROUTE_TOOL_NAMES = ROUTE_TOOLS.map(t => t.name);

module.exports = { ROUTE_TOOLS, ROUTE_TOOL_NAMES, PLATFORMS, PERIODS, buildInputSchema };
