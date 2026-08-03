/**
 * Shared OpenAI-compatible chat-completion helper.
 *
 * Lifted verbatim out of engine/automationEngine.js (runChatCompletion,
 * pickDefaultModel, PROVIDER_DEFAULT_BASE, and the tolerant JSON extractor that
 * was inlined in executeAgentNode) so a route/service can make one HTTPS call
 * without requiring the whole automation engine — which drags in BullMQ, the
 * agent router and webhook trigger evaluation, and risks a require cycle.
 *
 * These are pure utilities with no engine state; the only dependency is crypto.
 *
 * ⚠️ The transport is OpenAI-shaped: `Authorization: Bearer` → POST
 * `${base_url}/chat/completions`. Anthropic (x-api-key + /v1/messages) and
 * Gemini do NOT serve that shape, so a credential is only usable here when
 * isOpenAiCompatible() says so.
 */

const { decrypt } = require('../util/crypto');

const PROVIDER_DEFAULT_BASE = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  kimi: 'https://api.moonshot.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * True when this credential can be driven through the OpenAI-shaped transport
 * above: a native OpenAI key, or any provider pointed at an explicit
 * OpenAI-compatible base URL (Kimi, OpenRouter, SiliconFlow, vLLM, …).
 */
function isOpenAiCompatible(cred) {
  if (!cred) return false;
  return cred.provider === 'openai' || !!cred.base_url;
}

/**
 * One chat-completion call against a stored provider credential. Returns the
 * raw assistant text (or `{ content, usage, model }` with `withUsage`).
 * Throws on HTTP / parse errors so callers can run a fallback.
 */
async function runChatCompletion(cred, modelId, messages, { maxTokens = 400, json = false, withUsage = false } = {}) {
  const apiKey = decrypt(cred.api_key_encrypted);
  if (!apiKey) throw new Error('Failed to decrypt stored API key');
  const baseUrl = (cred.base_url || PROVIDER_DEFAULT_BASE[cred.provider] || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`No base URL for provider ${cred.provider}`);
  const extraHeaders = {};
  if (cred.provider === 'kimi' && cred.base_url && /kimi\.com/i.test(cred.base_url)) {
    extraHeaders['User-Agent'] = 'claude-code/1.0';
  }
  const payload = { model: modelId, messages, temperature: 0, max_tokens: maxTokens };
  if (json && cred.provider === 'openai') payload.response_format = { type: 'json_object' };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 200)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('AI returned a non-JSON response'); }
  const content = parsed?.choices?.[0]?.message?.content || '';
  if (!withUsage) return content;
  return { content, usage: parsed?.usage || null, model: parsed?.model || modelId };
}

/**
 * Auto-pick a credential + model when the caller has no explicit selection.
 * Prefers OpenAI, then a cheap/fast model within whatever's enabled.
 */
async function pickDefaultModel(client) {
  const { rows } = await client.query(
    `SELECT * FROM coexistence.ai_models ORDER BY (provider='openai') DESC, id ASC`
  );
  for (const cred of rows) {
    const enabled = Array.isArray(cred.enabled_models) ? cred.enabled_models
      : (Array.isArray(cred.available_models) ? cred.available_models : []);
    if (!enabled.length) continue;
    const modelId = enabled.find(m => /mini|haiku|flash|3\.5|turbo|kimi/i.test(m)) || enabled[0];
    return { cred, modelId };
  }
  return null;
}

/**
 * Tolerant JSON extraction. Models are inconsistent — some wrap in ```json
 * fences, some prepend "Sure, here's the JSON:", some add a trailing comment.
 * Strategy: strip fences anywhere → parse raw → extract the first balanced
 * {...} block by brace depth. Returns null when nothing parses.
 */
function parseLooseJson(text) {
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let parsed = null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) parsed = tryParse(fenced[1].trim());
  if (!parsed) parsed = tryParse(text.trim());
  if (!parsed) {
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) { parsed = tryParse(text.slice(start, i + 1)); break; }
        }
      }
    }
  }
  return parsed;
}

module.exports = { PROVIDER_DEFAULT_BASE, isOpenAiCompatible, runChatCompletion, pickDefaultModel, parseLooseJson };
