const socialEnv = require('./env');
// Remote (Streamable HTTP) MCP transport, mounted at /api/mcp/http/:key.
//
// Anyone can connect with just a URL (the API key rides in the path) — paste it
// into Claude's "Add custom connector" dialog. Stateless + JSON responses
// (proxy-friendly through Traefik), a fresh McpServer per request. Tools call
// mcpService directly (in-process), gated by the per-request key's capabilities.
//
// Every tool here maps to one capability toggle in Settings → MCP Access:
//   analytics | content | inbox | contacts | publishing  (reads, default ON)
//   engage | publish_create                              (writes, default OFF)
//
// A key may additionally be ACCOUNT-SCOPED (Settings → MCP Access → Account
// scope): locked to one account on one platform. When it is, the `platform` and
// `account` arguments are stripped from the tool schemas entirely — the client
// cannot ask for another account and is never shown one exists — and `scope` is
// passed into every mcpService call so the filtering happens in SQL, not here.

const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const mcpService = require('./mcpService');
const mcpOAuth = require('./mcpOAuth');

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
function fail(msg) { return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }; }

// Wrap a tool: enforce capability, run, format result/error.
function gated(capabilities, cap, fn) {
  return async (args) => {
    if (capabilities[cap] !== true) return fail(`The '${cap}' capability is disabled for MCP access. An admin can enable it in ForgeSocial → Settings → MCP Access.`);
    try { return ok(await fn(args || {})); }
    catch (err) { return fail(err.message || 'Tool failed'); }
  };
}

const PLATFORM_ENUM = z.enum(['instagram', 'youtube', 'facebook', 'threads', 'linkedin']);
const COMMENT_PLATFORM_ENUM = z.enum(['instagram', 'facebook', 'youtube', 'threads']);
const PERIOD_ENUM = z.enum(['7D', '30D', '90D']);

// Build the tool catalog for one request's capabilities + account scope.
// Returns { tools, instructions, serverName } — plain data, dispatched by the
// hand-rolled JSON-RPC handler below (see the transport note at the top).
function buildCatalog(capabilities, scope = null) {
  const locked = !!scope;
  const who = scope ? (scope.username ? '@' + scope.username : scope.label) : null;
  const lockLine = locked
    ? `This connection is locked to the ${scope.platform} account ${who} (id ${scope.accountId}). Every tool returns ONLY that account's data — no other account and no other platform is reachable on this key. Never describe these numbers as workspace-wide or cross-platform totals; they belong to ${who} alone.`
    : '';

  const tools = [];

  // A locked key drops the arguments its scope already decides, so the client
  // never sees a platform/account selector it isn't allowed to use.
  const open = (obj) => (locked ? {} : obj);

  // Same call shape the SDK used, so every tool definition below is unchanged.
  // Restates the lock on every tool — a client may read one tool's description
  // without ever seeing the server-level instructions.
  const server = {
    registerTool: (name, cfg, handler) => {
      tools.push({
        name,
        title: cfg.title,
        description: locked ? `${cfg.description}\n\nSCOPE: ${lockLine}` : cfg.description,
        inputSchema: cfg.inputSchema,
        handler,
      });
    },
  };

  /* ------------------------------ analytics ----------------------------- */
  server.registerTool('get_overview', {
    title: 'Cross-platform overview',
    description: 'KPI roll-up across all connected social platforms (Instagram, YouTube, Facebook, Threads, LinkedIn): total audience, net growth, impressions, average engagement rate, plus a per-platform breakdown with last-sync freshness. Start here for "how are we doing" questions.',
    inputSchema: { period: PERIOD_ENUM.optional().describe('Reporting window (default 30D).') },
  }, gated(capabilities, 'analytics', ({ period }) => mcpService.getOverview(period, scope)));

  server.registerTool('get_platform_stats', {
    title: 'Platform stats',
    description: 'Full analytics payload for ONE platform: followers, growth, impressions/views, engagement rate, daily trend arrays, top posts, platform-specific extras. Optional account id for multi-account platforms (omit = primary account, "all" = combined).',
    inputSchema: {
      ...open({ platform: PLATFORM_ENUM.describe('Which platform.') }),
      period: PERIOD_ENUM.optional().describe('Reporting window (default 30D).'),
      ...open({ account: z.string().optional().describe('Account id, or "all" for a combined view. Omit for the primary account.') }),
    },
  }, gated(capabilities, 'analytics', ({ platform, period, account }) => mcpService.getPlatformStats(platform, period, account, scope)));

  server.registerTool('get_followers_trend', {
    title: 'Followers trend',
    description: 'Follower-count time series for one platform — by hours (up to 168), days (up to 90) or weeks (up to 52). Useful for growth-over-time questions and spotting spikes/drops.',
    inputSchema: {
      ...open({ platform: PLATFORM_ENUM.describe('Which platform.') }),
      unit: z.enum(['hours', 'days', 'weeks']).optional().describe('Granularity (default days).'),
      range: z.number().int().min(1).max(168).optional().describe('How many units back (defaults: 24 hours / 30 days / 8 weeks).'),
      ...open({ account: z.string().optional().describe('Account id, or "all". Omit for the primary account.') }),
    },
  }, gated(capabilities, 'analytics', ({ platform, unit, range, account }) => mcpService.getFollowersTrend(platform, unit, range, account, scope)));

  server.registerTool('get_audience_insights', {
    title: 'Audience demographics',
    description: 'Cached audience insights per platform/account: age/gender/country demographics, online-followers hours (Instagram), traffic sources (YouTube). Data is the daily cached payload — refreshed once a day, never fetched live.',
    inputSchema: { ...open({ platform: PLATFORM_ENUM.optional().describe('Filter to one platform. Omit for all cached entries.') }) },
  }, gated(capabilities, 'analytics', ({ platform }) => mcpService.getAudienceInsights(platform || null, scope)));

  /* ------------------------------- reports ------------------------------ */
  server.registerTool('generate_report', {
    title: 'Generate a performance report (with forecast)',
    description: 'Build a per-platform performance report for a date range AND the raw material for a research-backed forecast. For each platform it returns audience growth, window stats, posting cadence, a trajectory label, and — most importantly — `content.posts`: every post (top AND bottom performers) with its FULL caption, hashtags, posting day/time (IST), and per-post rate signals (save/share/comment/like rate as % of views). USE THIS to reason about WHY specific posts performed. The included `forecast` is a DETERMINISTIC FALLBACK only (do not ship it verbatim — it is generic and contains NO competitor data). See `analysisGuidance` in the result: you are expected to (1) read the captions/rates and explain why each top post won vs the misses, and (2) do LIVE WEB RESEARCH on what top creators/competitors in this niche are doing now, then author your own content-grounded, research-backed forecast and render it via the forgesocial-report skill. ForgeSocial holds first-party data only; competitor analysis must come from your web research. DB-only, no live platform calls. Omit dates for the last 30 days; omit platforms for all four live platforms.',
    inputSchema: {
      ...open({ platforms: z.array(z.enum(['instagram', 'facebook', 'threads', 'youtube', 'linkedin'])).optional().describe('Platforms to include (default: instagram, facebook, threads, youtube).') }),
      from: z.string().optional().describe('Range start YYYY-MM-DD (default: 30 days ago, IST).'),
      to: z.string().optional().describe('Range end YYYY-MM-DD (default: today, IST).'),
    },
  }, gated(capabilities, 'reports', (a) => mcpService.generateReport(a, scope)));

  /* ------------------------------ insights ------------------------------ */
  server.registerTool('get_executive_summary', {
    title: 'Executive scorecard (cross-platform)',
    description: 'The managerial briefing: a normalized, RANKED cross-platform scorecard for "how are we doing and where should we focus". Per platform it returns follower growth %, engagement rate, posting cadence, trajectory (Accelerating/On track/Declining), best format & best theme, and deltas vs the prior equal window. Also returns data-real "where to focus" summary lines and flagged anomalies. Honesty: `comparability` marks which metrics are comparable across platforms (growth %, engagement rate, cadence) vs platform-defined (reach/impressions, themes) — never rank platforms on the platform-defined ones. DB-only, no live calls.',
    inputSchema: { period: PERIOD_ENUM.optional().describe('Window (default 30D); deltas compare against the immediately-preceding equal window.') },
  }, gated(capabilities, 'insights', ({ period }) => mcpService.getExecutiveSummary(period, scope)));

  server.registerTool('get_content_themes', {
    title: 'Content-theme ROI',
    description: 'Which content THEMES actually drive results. Posts are auto-categorized (rule-based caption/hashtag matching) into themes; this returns per-theme post count, share of output, avg views, avg engagement, avg content score, and the engagement trend vs the prior window. `coverage` reports what % of posts were categorized (the rest are "Uncategorized"). Use for "what content works", "what should we make more of". Optionally scope to one platform. DB-only.',
    inputSchema: {
      ...open({ platform: PLATFORM_ENUM.optional().describe('Scope to one platform. Omit for all platforms combined.') }),
      period: PERIOD_ENUM.optional().describe('Window (default 30D).'),
    },
  }, gated(capabilities, 'insights', (a) => mcpService.getContentThemes(a, scope)));

  server.registerTool('get_trends_anomalies', {
    title: 'Trends & anomaly alerts',
    description: 'Period-over-period movement + flagged anomalies from retained history. Per platform: follower / impressions / engagement-rate deltas vs ~one window ago. `anomalies` surfaces the things a manager should act on: impressions drops (>20%), engagement-rate spikes, follower declines, and viral-candidate posts (top-percentile score in the last 14 days). DB-only.',
    inputSchema: { period: PERIOD_ENUM.optional().describe('Comparison window (default 30D).') },
  }, gated(capabilities, 'insights', ({ period }) => mcpService.getTrendsAnomalies(period, scope)));

  /* ------------------------------- content ------------------------------ */
  server.registerTool('list_posts', {
    title: 'List posts (content library)',
    description: 'Published posts across all platforms with per-post metrics: views, engagements, likes, comments, shares, saves, clicks and the 1-99 content score (percentile rank within its platform). Filter by platform, text search, or recency; sort by any metric. Use for "top content", "what did we post", and per-post performance questions.',
    inputSchema: {
      ...open({ platform: PLATFORM_ENUM.optional().describe('Filter to one platform.') }),
      q: z.string().optional().describe('Text search across title, caption and topic.'),
      days: z.number().int().min(1).max(365).optional().describe('Only posts from the last N days.'),
      sortBy: z.enum(['date', 'score', 'views', 'engagements', 'likes', 'comments']).optional().describe('Sort metric (default date, newest first).'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
    },
  }, gated(capabilities, 'content', (a) => mcpService.listPosts(a, scope)));

  // The media library is a shared workspace asset store with no per-account
  // owner column — there is nothing to filter it by, so rather than leak other
  // accounts' uploads, a locked key simply doesn't get this tool.
  if (!locked) {
    server.registerTool('list_media', {
      title: 'List media library',
      description: 'Uploaded media-library assets (the files the composer attaches to posts): id, title, format, file count, size, uploader, upload date. The returned ids are what create_post takes as mediaIds.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 100).') },
    }, gated(capabilities, 'content', (a) => mcpService.listMedia(a)));
  }

  /* -------------------------------- inbox ------------------------------- */
  server.registerTool('list_messages', {
    title: 'List Instagram DMs',
    description: 'Instagram direct messages across connected accounts (newest first) with resolved peer identity (name/username). Filter by account id, peer id, or text search. Other platforms have no DM integration.',
    inputSchema: {
      ...open({ account: z.string().optional().describe('Filter to one connected Instagram account id.') }),
      peer: z.string().optional().describe('Filter to one conversation partner (peer IGSID).'),
      q: z.string().optional().describe('Text search in message bodies.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100).'),
    },
  }, gated(capabilities, 'inbox', (a) => mcpService.listMessages(a, scope)));

  server.registerTool('list_comments', {
    title: 'List comments',
    description: 'Comments on our posts for one platform (instagram, facebook, youtube or threads), newest first, each with the parent post caption/permalink. parentId null = top-level comment, set = a reply. Filter by text/author search; Instagram also by account id. The commentId values are what reply_to_comment takes.',
    inputSchema: {
      ...open({ platform: COMMENT_PLATFORM_ENUM.describe('Which platform.') }),
      ...open({ account: z.string().optional().describe('Instagram only: filter to one connected account id.') }),
      q: z.string().optional().describe('Text search in comment text and author name.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100).'),
    },
  }, gated(capabilities, 'inbox', (a) => mcpService.listComments(a, scope)));

  /* ------------------------------- contacts ----------------------------- */
  server.registerTool('list_contacts', {
    title: 'List contacts (CRM)',
    description: 'CRM contacts auto-built from Instagram DM history: identity, notes, tags, first/last activity, message count, last message preview. Filter by search text, account, or tag id (get tag ids via list_tags).',
    inputSchema: {
      q: z.string().optional().describe('Search name, username, peer id or notes.'),
      ...open({ account: z.string().optional().describe('Filter to one connected Instagram account id.') }),
      tag: z.string().optional().describe('Filter to contacts carrying this tag id.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100).'),
    },
  }, gated(capabilities, 'contacts', (a) => mcpService.listContacts(a, scope)));

  server.registerTool('list_tags', {
    title: 'List tags and categories',
    description: 'The workspace tag taxonomy: tags (id, name, color, category) and their categories. Tag ids are what contacts carry in their tags array and what list_contacts filters by.',
    inputSchema: {},
  }, gated(capabilities, 'contacts', () => mcpService.listTags()));

  /* ------------------------------ publishing ---------------------------- */
  server.registerTool('list_publish_jobs', {
    title: 'List publish jobs',
    description: 'The posting queue + log: every composer posting with status (queued / publishing / published / failed / canceled), schedule, attempts, errors, and whether it was simulated (non-Instagram platforms simulate publishing). Job ids are what cancel_publish_job takes.',
    inputSchema: {
      status: z.enum(['queued', 'publishing', 'published', 'failed', 'canceled']).optional().describe('Filter by status.'),
      ...open({ platform: PLATFORM_ENUM.optional().describe('Filter by platform.') }),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 100).'),
    },
  }, gated(capabilities, 'publishing', (a) => mcpService.listPublishJobs(a, scope)));

  server.registerTool('list_connected_accounts', {
    title: 'List connected accounts',
    description: 'Every connected social account across all platforms with its label/username; Instagram rows include canPublish (OAuth-connected for publishing). The accountId values are what other tools take as account filters.',
    inputSchema: {},
  }, gated(capabilities, 'publishing', () => mcpService.listConnectedAccounts(scope)));

  server.registerTool('get_token_health', {
    title: 'Token health',
    description: 'OAuth token health for every credential: days until expiry, last refresh, and which accounts need attention (expiring / refresh failed / needs reconnect). Pure DB read.',
    inputSchema: {},
  }, gated(capabilities, 'publishing', () => mcpService.getTokenHealth(scope)));

  /* --------------------- writes (capabilities default OFF) -------------- */
  server.registerTool('reply_to_comment', {
    title: 'Reply to a comment',
    description: 'Post a reply under a comment on instagram, facebook, youtube or threads. Get the commentId from list_comments first, and CONFIRM the reply text with the user before sending — this posts publicly on the real platform.',
    inputSchema: {
      ...open({ platform: COMMENT_PLATFORM_ENUM.describe('Which platform the comment is on.') }),
      commentId: z.string().describe('The platform comment id (from list_comments). For YouTube use a TOP-LEVEL comment id — YouTube only nests one level.'),
      message: z.string().min(1).describe('The reply text.'),
      ...open({ accountId: z.string().optional().describe('Instagram only: which connected account replies (from the comment row).') }),
    },
  }, gated(capabilities, 'engage', (a) => mcpService.replyToComment(a, scope)));

  server.registerTool('send_instagram_dm', {
    title: 'Send an Instagram DM',
    description: 'Send a direct message from a connected Instagram account to a conversation partner. Get accountId + peerId from list_messages or list_contacts. Instagram only allows replies within 24h of the user\'s last message. CONFIRM the text with the user before sending.',
    inputSchema: {
      ...open({ accountId: z.string().describe('The connected Instagram account id sending the DM.') }),
      recipientId: z.string().describe('The recipient\'s peer id (IGSID) from list_messages/list_contacts.'),
      text: z.string().min(1).describe('The message text.'),
    },
  }, gated(capabilities, 'engage', (a) => mcpService.sendInstagramDm(a, scope)));

  server.registerTool('create_post', {
    title: 'Create a post (publish job)',
    description: 'Queue a post for immediate or scheduled publishing. Instagram publishes for REAL (account must be OAuth-connected — check canPublish via list_connected_accounts); other platforms simulate. post_type per platform: instagram post/carousel/reel/story, others vary. Use list_media for mediaIds. CONFIRM platform, account, caption, media and timing with the user before creating.',
    inputSchema: {
      ...open({ platform: PLATFORM_ENUM.describe('Target platform.') }),
      ...open({ accountId: z.string().optional().describe('Account id (required for Instagram).') }),
      postType: z.string().describe('Post type, e.g. "post", "carousel", "reel", "story".'),
      caption: z.string().optional().describe('Caption text.'),
      mediaIds: z.array(z.number()).optional().describe('Media library ids (from list_media) in display order.'),
      scheduleType: z.enum(['immediate', 'scheduled']).optional().describe('Default immediate.'),
      scheduledAt: z.string().optional().describe('Future ISO timestamp — required when scheduleType is "scheduled".'),
      details: z.record(z.any()).optional().describe('Optional per-type extras (hashtags array, altText, collaborators, etc.).'),
    },
  }, gated(capabilities, 'publish_create', (a) => mcpService.createPost(a, scope)));

  server.registerTool('cancel_publish_job', {
    title: 'Cancel a queued post',
    description: 'Cancel a publish job that is still queued (already-publishing/published jobs cannot be canceled). Get the id from list_publish_jobs. Confirm with the user first.',
    inputSchema: { id: z.union([z.string(), z.number()]).describe('Publish job id.') },
  }, gated(capabilities, 'publish_create', ({ id }) => mcpService.cancelPublishJob(id, scope)));

  return {
    tools,
    serverName: locked ? `forgesocial (${who})` : 'forgesocial',
    instructions: [
      'ForgeSocial — read-only social analytics for this workspace. All data tools read the SYNCED DATABASE only; they never call the platforms\' APIs, so they cannot burn rate budgets and figures are as fresh as the last sync (every tool reports its own freshness).',
      'CRITICAL RULES: (1) Numbers are first-party only — ForgeSocial holds no competitor data; never present competitor claims as coming from here. (2) Reach/impressions and the 1-99 content score are defined differently per platform — never rank platforms on them; growth %, engagement rate and cadence are comparable. (3) generate_report returns a DETERMINISTIC FALLBACK forecast — do not ship it verbatim; read the post captions and do your own research. (4) A tool erroring with a 403-style message means this key is account-scoped; respect it and do not try other accounts.',
      locked ? lockLine : 'This key is not account-scoped: it reads every connected account on every platform.',
    ].join('\n\n'),
  };
}

/* ------------------------- JSON-RPC 2.0 transport ------------------------ */
// Hand-rolled on purpose. The SDK's StreamableHTTP transport literal-checks for
// BOTH `application/json` and `text/event-stream` in Accept and 406s otherwise —
// but real clients (claude.ai's connector validator included) send `Accept: */*`,
// and a 406 there reads to the user as "couldn't connect". Plain POST + plain
// JSON has no such failure mode.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

// zod shape -> JSON Schema, the wire format tools/list must publish.
function toInputSchema(shape) {
  const keys = Object.keys(shape || {});
  if (!keys.length) return { type: 'object', properties: {} };
  const js = zodToJsonSchema(z.object(shape), { $refStrategy: 'none', target: 'jsonSchema7' });
  delete js.$schema;
  return js;
}

// The resource identifier this endpoint advertises to an OAuth client. Built
// from the request's own host so it is correct on every hostname the app is
// reachable at (Cloudflare-fronted, direct, or localhost) — never hardcoded.
function resourceUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl.split('?')[0]}`;
}

async function dispatch({ method, params, catalog, capabilities, scope, clientProtocol }) {
  switch (method) {
    case 'initialize':
      return {
        // Echo the client's version when we speak it, else our newest.
        protocolVersion: PROTOCOL_VERSIONS.includes(clientProtocol) ? clientProtocol : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: {}, resources: {} },
        serverInfo: { name: catalog.serverName, version: '1.0.0' },
        instructions: catalog.instructions,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return {
        tools: catalog.tools.map(t => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: toInputSchema(t.inputSchema),
        })),
      };

    case 'tools/call': {
      const name = params?.name;
      const tool = catalog.tools.find(t => t.name === name);
      // An unknown name is a protocol error; a failing tool is a tool result
      // with isError — clients treat the two very differently.
      if (!tool) { const e = new Error(`Unknown tool '${name}'`); e.rpcCode = -32602; throw e; }
      return tool.handler(params?.arguments || {});
    }

    // Declared in capabilities but intentionally empty — clients probe both.
    case 'prompts/list':   return { prompts: [] };
    case 'resources/list': return { resources: [] };
    case 'resources/templates/list': return { resourceTemplates: [] };

    default: {
      const e = new Error(`Method not found: ${method}`);
      e.rpcCode = -32601; throw e;
    }
  }
}

async function mcpHttpHandler(req, res) {
  if (req.method !== 'POST') {
    // A GET here would be the SSE stream; this server is stateless and offers
    // none, which the spec allows a server to answer with 405.
    return res.status(405).json(rpcError(null, -32000, 'Method not allowed. This is a stateless MCP server — use POST.'));
  }

  const pathKey = req.params.key;
  const _resource = resourceUrl(req);
  if (socialEnv.MCP_OAUTH_DEBUG !== '0') {
    const a = String(req.headers.authorization || '');
    console.log('[mcp] hit ' + JSON.stringify({
      method: (Array.isArray(req.body) ? req.body[0] : req.body)?.method,
      // shape only — the credential itself never reaches the log
      auth: a ? (/^Bearer\s+eyJ/i.test(a) ? 'Bearer <jwt>' : 'Bearer <opaque>') : 'NONE',
      key: pathKey ? pathKey.slice(0, 13) + '…' : null,
      origin: req.headers.origin || null,
      ua: String(req.headers['user-agent'] || '').slice(0, 50),
    }));
  }
  // Anchors the OAuth flow: an unauthenticated client follows this header to the
  // protected-resource document and from there to the authorization server.
  const challenge = () => res
    .status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${mcpOAuth.protectedResourceUrl(req)}"`)
    .json(rpcError(null, -32001, 'Authorization required'));

  // The bearer may be the raw API key itself or an OAuth access token we issued.
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || null;
  if (!bearer) return challenge();

  let capabilities, scope;
  try {
    // An OAuth token is bound to the key it was issued for, so a token minted
    // for one connector can never be replayed against another's URL.
    const viaToken = mcpOAuth.verifyAccessToken(bearer);
    const effectiveKey = viaToken ? viaToken.key : bearer;
    if (viaToken && viaToken.key !== pathKey) return challenge();
    if (!viaToken && bearer !== pathKey) return challenge();
    ({ capabilities, scope } = await mcpService.validateKey(effectiveKey));
  } catch (err) {
    if (err.status === 401) return challenge();
    return res.status(err.status || 401).json(rpcError(null, -32001, err.message || 'Unauthorized'));
  }

  const body = req.body;
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  if (!messages.length || messages.some(m => !m || m.jsonrpc !== '2.0' || typeof m.method !== 'string')) {
    return res.status(400).json(rpcError(body?.id ?? null, -32600, 'Invalid Request'));
  }

  // A notification has no `id` and must get a bare 202 with no body.
  if (messages.every(m => m.id === undefined || m.id === null)) return res.status(202).end();

  const catalog = buildCatalog(capabilities, scope);
  const out = [];
  for (const m of messages) {
    if (m.id === undefined || m.id === null) continue;   // notification inside a batch
    try {
      const result = await dispatch({
        method: m.method, params: m.params, catalog, capabilities, scope,
        clientProtocol: m.params?.protocolVersion,
      });
      out.push(rpcResult(m.id, result));
    } catch (err) {
      // Never leak an Authorization header or a stack into a client payload.
      console.error(`[mcp] ${m.method} failed:`, err.message);
      out.push(rpcError(m.id, err.rpcCode || -32603, err.message || 'Internal error'));
    }
  }
  res.set('Cache-Control', 'no-store');
  return res.json(batch ? out : out[0]);
}

module.exports = { mcpHttpHandler, buildCatalog };
