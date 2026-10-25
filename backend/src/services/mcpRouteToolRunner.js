// Runs a tool declared in mcpRouteTools.js. Shared by the HTTP transport (in
// process) and the apiRouter route the stdio transport calls, so both execute
// the exact same code.
//
// A `route` tool calls the REAL Express route as an admin (internalApiCall), so
// every validation, permission check, audit row and SSE emit that route performs
// still happens. A `service` tool calls an existing service function — the
// SERVICES map below only ADAPTS argument shapes; it holds no business logic.

const { ROUTE_TOOLS } = require('./mcpRouteTools');

const BY_NAME = new Map(ROUTE_TOOLS.map(t => [t.name, t]));

function svcErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Lazy: the Social sub-app's service pulls in its own pool and settings, which
// a unit test (or the catalog) must never load just by requiring this file.
const social = () => require('../social/mcpService');

const SERVICES = {
  'social.getOverview': (a) => social().getOverview(a.period || undefined, null),
  'social.getPlatformStats': (a) => social().getPlatformStats(a.platform, a.period || undefined, a.account || null, null),
  'social.getFollowersTrend': (a) => social().getFollowersTrend(a.platform, a.unit || undefined, a.range || null, a.account || null, null),
  'social.getAudienceInsights': (a) => social().getAudienceInsights(a.platform || null, null),
  'social.getExecutiveSummary': (a) => social().getExecutiveSummary(a.period || undefined, null),
  'social.getContentThemes': (a) => social().getContentThemes(clean(a), null),
  'social.getTrendsAnomalies': (a) => social().getTrendsAnomalies(a.period || undefined, null),
  'social.listPosts': (a) => social().listPosts(clean(a), null),
  'social.listConnectedAccounts': () => social().listConnectedAccounts(null),
  'social.getTokenHealth': () => social().getTokenHealth(null),
  'social.listMessages': (a) => social().listMessages(clean(a), null),
  'social.listComments': (a) => social().listComments(clean(a), null),
  'social.listContacts': (a) => social().listContacts(clean(a), null),
  'social.replyToComment': (a) => social().replyToComment(clean(a), null),
  'social.sendInstagramDm': (a) => social().sendInstagramDm(clean(a), null),
};

// Request bodies built from a tool's flat params. Shape only — the route still
// validates everything.
const BUILDERS = {
  // The "Auto-DM links from comments" preset (frontend automations/shared.jsx
  // comment_link): reply under the comment, then DM a message with a link button.
  commentDmDraft: (a) => {
    const url = String(a.link_url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw svcErr(400, 'link_url must be a full link starting with https://');
    const text = String(a.dm_text || '').trim();
    if (!text) throw svcErr(400, 'dm_text is required.');
    const keywords = Array.isArray(a.keywords) ? a.keywords.map(k => String(k).trim()).filter(Boolean) : [];
    const replies = Array.isArray(a.reply_texts) ? a.reply_texts.map(r => String(r).trim()).filter(Boolean) : null;
    return {
      name: String(a.name || '').trim() || 'Auto-DM links from comments',
      account_id: a.account_id,
      trigger: 'comment',
      media_id: a.media_id || null,
      keywords,
      reply_texts: replies && replies.length ? replies : ['Thanks! Please see DMs.', 'Sent you a message! Check it out!', 'Nice! Check your DMs!'],
      dm_message: { attachment: { type: 'template', payload: {
        template_type: 'button', text,
        buttons: [{ type: 'web_url', title: String(a.link_title || '').trim() || 'Open link', url }],
      } } },
      once_per_user: a.once_per_user !== false,
    };
  },
};

// Drop null/undefined so a service sees "not given" rather than an explicit null.
function clean(a = {}) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function buildCall(spec, args) {
  const a = args || {};
  const used = new Set();
  const path = spec.route.path.replace(/\{([a-zA-Z_]+)\}/g, (_, k) => {
    used.add(k);
    const v = a[k];
    if (v === undefined || v === null || v === '') throw svcErr(400, `${k} is required.`);
    return encodeURIComponent(String(v));
  });
  let query;
  if (Array.isArray(spec.route.query)) {
    query = {};
    for (const k of spec.route.query) if (a[k] !== undefined && a[k] !== null && a[k] !== '') query[k] = a[k];
  }
  let body;
  const b = spec.route.body;
  if (b === '*') {
    body = {};
    for (const [k, v] of Object.entries(a)) if (!used.has(k) && v !== undefined) body[k] = v;
  } else if (Array.isArray(b)) {
    body = {};
    for (const k of b) if (a[k] !== undefined) body[k] = a[k];
  } else if (b && typeof b === 'object' && b.from) {
    body = a[b.from];
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw svcErr(400, `${b.from} must be an object.`);
  } else if (b && typeof b === 'object' && b.build) {
    const fn = BUILDERS[b.build];
    if (!fn) throw svcErr(500, `Tool '${spec.name}' points at a missing body builder.`);
    body = fn(a);
  }
  // Fields the tool always sets, whatever the caller sent: an MCP-created
  // Instagram rule or flow is a draft until someone switches it on.
  if (body && b && b.force) body = { ...body, ...b.force };
  return { method: spec.route.method, path, query, body };
}

async function runRouteTool(name, args) {
  const spec = BY_NAME.get(name);
  if (!spec) throw svcErr(404, `Unknown tool '${name}'.`);
  if (spec.service) {
    const fn = SERVICES[spec.service];
    if (!fn) throw svcErr(500, `Tool '${name}' points at a missing service.`);
    return fn(args || {});
  }
  // Required at call time: mcpService requires the send queue (BullMQ/Redis).
  const { internalApiOrThrow } = require('./mcpService');
  return internalApiOrThrow({ ...buildCall(spec, args), failMsg: `${spec.title} failed` });
}

module.exports = { runRouteTool, buildCall, SERVICES, isRouteTool: (n) => BY_NAME.has(n) };
