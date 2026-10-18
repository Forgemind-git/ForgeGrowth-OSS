// Claude access for workflow agents: credential lookup, the per-model request shape,
// and cost in INR.
//
// Deliberately NOT llm/anthropic.js: that adapter hardcodes max_tokens 1024, has no
// caching and no cost, and the live customer-facing AI Agents depend on it staying
// exactly as it is.

const Anthropic = require('@anthropic-ai/sdk');
const { decrypt } = require('../../util/crypto');

// Per-model request rules (claude-api skill, cached 2026-06-24). Prices are USD per
// million tokens and only DEFAULTS: the admin-editable rate card overrides them.
const MODELS = {
  'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25, sampling: false, thinking: 'default_adaptive', effort: ['low', 'medium', 'high', 'xhigh', 'max'], fallbacks: true },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10, sampling: false, thinking: 'adaptive', effort: ['low', 'medium', 'high', 'xhigh', 'max'], fallbacks: false },
  'claude-fable-5-1': { label: 'Claude Fable 5.1', input: 10, output: 50, cacheReadMultiplier: 0.025, sampling: false, thinking: 'always', effort: ['low', 'medium', 'high', 'xhigh', 'max'], fallbacks: true },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', input: 5, output: 25, sampling: false, thinking: 'adaptive', effort: ['low', 'medium', 'high', 'xhigh', 'max'], fallbacks: false },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', input: 3, output: 15, sampling: true, thinking: 'adaptive', effort: ['low', 'medium', 'high', 'max'], fallbacks: false },
  'claude-haiku-4-5': { label: 'Claude Haiku 4.5', input: 1, output: 5, sampling: true, thinking: 'none', effort: [], fallbacks: false },
};
const DEFAULT_MODEL = 'claude-opus-5';
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL
const CACHE_READ_MULTIPLIER = 0.1;

class ModelConfigError extends Error {}

/** Anthropic API key: the agent's chosen credential, else the first Anthropic credential, else env. */
async function resolveApiKey(pool, credentialId) {
  if (credentialId) {
    const { rows } = await pool.query(`SELECT id, provider, api_key_encrypted FROM coexistence.ai_models WHERE id = $1`, [credentialId]);
    if (!rows[0]) throw new ModelConfigError('The AI credential chosen for this agent no longer exists. Pick another in the agent Overview.');
    if (rows[0].provider !== 'anthropic') throw new ModelConfigError('Workflow agents run on Claude: choose an Anthropic credential in the agent Overview.');
    const key = decrypt(rows[0].api_key_encrypted);
    if (!key) throw new ModelConfigError('The Anthropic API key could not be decrypted. Re-enter it in Admin Settings → AI Models.');
    return { apiKey: key, source: `ai_models:${rows[0].id}` };
  }
  const { rows } = await pool.query(`SELECT id, api_key_encrypted FROM coexistence.ai_models WHERE provider = 'anthropic' ORDER BY id LIMIT 1`);
  if (rows[0]) {
    const key = decrypt(rows[0].api_key_encrypted);
    if (key) return { apiKey: key, source: `ai_models:${rows[0].id}` };
  }
  if (process.env.ANTHROPIC_API_KEY) return { apiKey: process.env.ANTHROPIC_API_KEY, source: 'env' };
  throw new ModelConfigError('No Anthropic API key is configured. Add one in Admin Settings → AI Models (provider: Anthropic) before running a workflow agent.');
}

/** The request body for one turn. `system` / `tools` / `messages` are prepared by the runtime. */
function buildRequest({ model, effort, temperature, maxOutputTokens, system, tools, messages, toolChoice = null }) {
  const m = MODELS[model] || MODELS[DEFAULT_MODEL];
  const params = {
    model,
    max_tokens: maxOutputTokens,
    system,
    messages,
    // Automatic caching for the growing conversation tail; the static prefix carries
    // its own explicit breakpoint on the last system block.
    cache_control: { type: 'ephemeral' },
  };
  if (tools && tools.length) params.tools = tools;
  if (toolChoice) params.tool_choice = toolChoice;
  if (m.thinking === 'adaptive') params.thinking = { type: 'adaptive' };
  // default_adaptive / always: omitting `thinking` runs adaptive; sending anything else can 400.
  if (m.effort.includes(effort)) params.output_config = { effort };
  if (m.sampling && typeof temperature === 'number') params.temperature = temperature;
  if (m.fallbacks) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  return params;
}

/** A caller bound to an API key. Streams (large max_tokens) and returns the final message. */
function createCaller(apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return async function callModel(params) {
    try {
      return await client.beta.messages.stream(params).finalMessage();
    } catch (e) {
      // If the account cannot use server-side fallbacks, run without them rather than failing the run.
      if (params.fallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(String(e.message))) {
        const { fallbacks: _fallbacks, betas: _betas, ...rest } = params;
        const msg = await client.beta.messages.stream(rest).finalMessage();
        msg.__fallbacks_disabled = true;
        return msg;
      }
      throw e;
    }
  };
}

/** Normalise a response's usage into the four token buckets. */
function usageOf(message) {
  const u = message?.usage || {};
  return {
    input: Number(u.input_tokens || 0),
    output: Number(u.output_tokens || 0),
    cacheWrite: Number(u.cache_creation_input_tokens || 0),
    cacheRead: Number(u.cache_read_input_tokens || 0),
  };
}

/** USD → INR for one response. rateCard: { "<model>": { input, output } } in USD/MTok. */
function costInr(model, usage, { rateCard = {}, usdToInr = 88 } = {}) {
  const base = MODELS[model] || MODELS[DEFAULT_MODEL];
  const rate = { ...base, ...(rateCard[model] || {}) };
  const readMult = rate.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
  const usd = (usage.input * rate.input
    + usage.cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER
    + usage.cacheRead * rate.input * readMult
    + usage.output * rate.output) / 1e6;
  return usd * Number(usdToInr || 88);
}

const totalTokens = (u) => u.input + u.output + u.cacheWrite + u.cacheRead;

function modelCatalog() {
  return Object.entries(MODELS).map(([id, m]) => ({
    id, label: m.label, input_usd_per_mtok: m.input, output_usd_per_mtok: m.output,
    supports_temperature: m.sampling, effort_levels: m.effort,
  }));
}

module.exports = {
  MODELS, DEFAULT_MODEL, ModelConfigError, resolveApiKey, buildRequest, createCaller, usageOf, costInr, totalTokens, modelCatalog, Anthropic,
};
