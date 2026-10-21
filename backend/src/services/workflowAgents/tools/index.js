// Tool registry: every tool an agent can be given, its schema, its permission kind,
// and the single entry point that runs one (scope, toggle, permission, parameter
// overrides, input validation, error-as-data, result size cap).

const { validate } = require('../jsonSchema');
const { isAll } = require('../scope');
const { loadAccounts, loadUsers, err } = require('./common');
const context = require('./context');
const leads = require('./leads');
const chats = require('./chats');
const sales = require('./sales');
const automations = require('./automations');
const draft = require('./draft');
const write = require('./write');

const TOOLS = [
  ...context.tools, ...leads.tools, ...chats.tools, ...sales.tools, ...automations.tools, ...draft.tools, ...write.tools,
];
const TOOLS_BY_KEY = new Map(TOOLS.map(t => [t.key, t]));
if (TOOLS_BY_KEY.size !== TOOLS.length) throw new Error('workflowAgents: duplicate tool key');

const PERMISSIONS_BY_KIND = { read: ['read'], draft: ['draft'], write: ['write', 'draft'] };
const CATEGORY_ORDER = ['Context', 'Leads & funnel', 'Conversations', 'Sales', 'Automations', 'Agent', 'Drafts', 'Actions'];
const RESULT_CHAR_CAP = 150000;
const DESCRIPTION_MAX = 2000;

/** Registry for the UI / API: schemas are read-only there by design. */
function describeTools() {
  return TOOLS.map(t => ({
    key: t.key, title: t.title, category: t.category, kind: t.kind,
    permissions: PERMISSIONS_BY_KIND[t.kind], default_permission: t.kind,
    description: t.description, input_schema: t.input_schema, overridable: t.overridable || [],
  })).sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.key.localeCompare(b.key));
}

/**
 * Normalise a stored tool_config. Unknown tools are dropped, a permission the tool
 * cannot have falls back to its own kind, and only declared overrides survive.
 */
function normalizeToolConfig(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const tool = TOOLS_BY_KEY.get(entry.tool_key);
    if (!tool || seen.has(tool.key)) continue;
    seen.add(tool.key);
    const allowed = PERMISSIONS_BY_KIND[tool.kind];
    const permission = allowed.includes(entry.permission) ? entry.permission : tool.kind;
    const params = {};
    const src = entry.params_override && typeof entry.params_override === 'object' ? entry.params_override : {};
    for (const o of tool.overridable || []) {
      const v = src[o.key];
      if (v === undefined || v === null || v === '') continue;
      if (o.type === 'number') { const n = Number(v); if (Number.isInteger(n) && n >= 1) params[o.key] = n; }
      else if (o.type === 'boolean') params[o.key] = v === true || v === 'true';
    }
    const description = typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim().slice(0, DESCRIPTION_MAX) : null;
    out.push({ tool_key: tool.key, enabled: entry.enabled !== false, permission, params_override: params, description });
  }
  return out;
}

/** Anthropic tool definitions for the enabled tools, sorted by name (stable prefix for prompt caching). */
function modelToolDefs(toolConfig) {
  return normalizeToolConfig(toolConfig)
    .filter(e => e.enabled)
    .map(e => {
      const t = TOOLS_BY_KEY.get(e.tool_key);
      const note = t.kind === 'write'
        ? (e.permission === 'draft' ? ' (Configured as DRAFT: proposals are recorded in the run, not queued for approval.)' : ' (Creates a pending approval; it never executes directly.)')
        : '';
      return { name: t.key, description: `${e.description || t.description}${note}`, input_schema: t.input_schema };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-run context the tools share. Loads lookups once. */
async function buildToolContext({ pool, agent, scope, runId = null, dryRun = false, now = new Date(), toolConfig = [], approvalRules = {}, recordStep = null, recordDraft = null }) {
  const [accounts, users, settings] = await Promise.all([loadAccounts(pool), loadUsers(pool), context.loadSettings(pool)]);
  return {
    pool, agent, scope, runId, dryRun, now, approvalRules, recordStep, recordDraft,
    toolConfig: normalizeToolConfig(toolConfig),
    accounts, users, settings,
    inScopeNumber: (n) => isAll(scope.business_numbers) || scope.business_numbers.includes(n),
  };
}

/** Run one tool call from the model. Never throws: failures come back as data. */
async function runTool(ctx, key, rawInput) {
  const tool = TOOLS_BY_KEY.get(key);
  if (!tool) return err('unknown_tool', `There is no tool named "${key}".`);
  const entry = ctx.toolConfig.find(e => e.tool_key === key);
  if (!entry || !entry.enabled) return err('tool_disabled', `The tool "${key}" is not enabled for this agent.`);
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? { ...rawInput } : {};
  const problems = validate(tool.input_schema, input);
  if (problems.length) return err('invalid_input', 'The tool input does not match its schema.', { details: problems.slice(0, 10) });

  const caps = {};
  const overrides = {};
  for (const o of tool.overridable || []) {
    const v = entry.params_override[o.key];
    if (v === undefined) continue;
    if (o.mode === 'cap') caps[o.key] = v;
    else overrides[o.key] = v;
  }
  if (caps.n && input.n) input.n = Math.min(Number(input.n), caps.n);

  let result;
  try {
    result = await tool.handler(input, { ...ctx, permission: entry.permission, caps, overrides });
  } catch (e) {
    console.error(`[workflow-agents] tool ${key} failed:`, e.message);
    return err('tool_failed', `The tool failed while reading data: ${e.message.slice(0, 200)}`);
  }
  const text = JSON.stringify(result);
  if (text && text.length > RESULT_CHAR_CAP) {
    return err('result_too_large', `The result was ${text.length} characters. Narrow it with a smaller limit, a shorter window or fewer ids.`);
  }
  return result;
}

module.exports = {
  TOOLS, TOOLS_BY_KEY, PERMISSIONS_BY_KIND, describeTools, normalizeToolConfig, modelToolDefs, buildToolContext, runTool,
};
