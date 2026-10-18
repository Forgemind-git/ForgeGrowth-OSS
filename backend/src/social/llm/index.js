// LLM provider registry. The agent engine calls runWithTools({ provider, ... })
// and this module routes to the right adapter with a uniform
// { runWithTools(...) } contract:
//
//   runWithTools({
//     systemPrompt, messages, tools, onToolCall, onStep,
//     model, apiKey, baseUrl, maxIterations,
//   }) -> { finalText, totalInputTokens, totalOutputTokens, iterations, [capped] }
//
// `tools` follows the Anthropic-style shape (the simpler superset); the OpenAI
// adapter translates internally. Kimi (Moonshot) and Gemini both expose
// OpenAI-compatible chat/tool APIs, so they ride the OpenAI adapter with a
// provider-specific base URL.

const anthropic = require('./anthropic');
const openai = require('./openai');

const DEFAULT_BASE_URL = {
  openrouter: 'https://openrouter.ai/api/v1',
  kimi: 'https://api.moonshot.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
};

// Resolve provider → { adapter, baseUrl }. A stored custom base_url always wins.
function resolve(provider, baseUrl) {
  if (provider === 'openrouter') return { adapter: openai, baseUrl: DEFAULT_BASE_URL.openrouter };
  if (provider === 'anthropic') return { adapter: anthropic, baseUrl: null };
  if (provider === 'openai')    return { adapter: openai, baseUrl: baseUrl || null };
  if (provider === 'kimi')      return { adapter: openai, baseUrl: baseUrl || DEFAULT_BASE_URL.kimi };
  if (provider === 'gemini')    return { adapter: openai, baseUrl: baseUrl || DEFAULT_BASE_URL.gemini };
  const err = new Error(`Unknown LLM provider: ${provider}`);
  err.code = 'UNKNOWN_PROVIDER';
  throw err;
}

function isRunnable(provider) {
  return ['openrouter', 'anthropic', 'openai', 'kimi', 'gemini'].includes(provider);
}

async function runWithTools({ provider, baseUrl, ...rest }) {
  const { adapter, baseUrl: bu } = resolve(provider, baseUrl);
  return adapter.runWithTools({ ...rest, baseUrl: bu });
}

module.exports = { runWithTools, isRunnable };
