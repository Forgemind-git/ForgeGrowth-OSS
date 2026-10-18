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
  'social.listPosts': (a) => social().listPosts(clean(a), null),
  'social.listConnectedAccounts': () => social().listConnectedAccounts(null),
  'social.getTokenHealth': () => social().getTokenHealth(null),
  'social.listMessages': (a) => social().listMessages(clean(a), null),
  'social.listComments': (a) => social().listComments(clean(a), null),
  'social.listContacts': (a) => social().listContacts(clean(a), null),
  'social.listPublishJobs': (a) => social().listPublishJobs(clean(a), null),
  'social.replyToComment': (a) => social().replyToComment(clean(a), null),
  'social.sendInstagramDm': (a) => social().sendInstagramDm(clean(a), null),
  'social.createPost': (a) => social().createPost(clean(a), null),
  'social.cancelPublishJob': (a) => social().cancelPublishJob(a.id, null),
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
  }
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
