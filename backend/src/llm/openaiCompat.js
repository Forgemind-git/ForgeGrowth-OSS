/**
 * Parameter compatibility for OpenAI's reasoning models (gpt-5*, o1/o3/o4*).
 *
 * Three things break when one of those models is selected, and each fails with
 * its own 400 — so fixing only the first just moves the error along. All three
 * were measured against the live API, not assumed:
 *
 *   max_tokens: 64                  -> 400 "Unsupported parameter: 'max_tokens'
 *                                          ... Use 'max_completion_tokens'"
 *   max_completion_tokens: 64       -> 400 "Could not finish the message because
 *                                          max_tokens or model output limit was
 *                                          reached"  (reasoning ate the budget)
 *   temperature: 0                  -> 400 "does not support 0 with this model.
 *                                          Only the default (1)"
 *
 * ⚠ This is a NAME test, deliberately not applied to every model. The same
 * OpenAI-shaped transport (`Authorization: Bearer` -> POST /chat/completions)
 * also serves Kimi, OpenRouter and SiliconFlow through custom base URLs, and
 * those only understand `max_tokens`. gpt-4o-mini happens to accept both, but
 * switching everything over would break the third-party endpoints for no gain.
 *
 * ⚠ The budget is RAISED, not merely renamed. A reasoning model spends tokens
 * thinking before it emits anything, and those count against the same limit —
 * so the caller's figure (256 for the automation node, 400 for the chat
 * analyser, 1024 for the agent) can be consumed entirely by reasoning, leaving
 * no output and producing the second error above. REASONING_MIN_TOKENS is the
 * floor; a caller asking for more still gets more.
 */

// gpt-5 / gpt-5-mini / o1 / o1-mini / o3 / o3-mini / o4-mini, and dated variants.
const REASONING_MODEL_RE = /^(gpt-5|o[1345])(-|$)/i;

// Enough headroom for the reasoning pass plus a real answer. Measured: a
// trivial prompt spent 0-192 reasoning tokens, and a 64 budget failed outright.
const REASONING_MIN_TOKENS = 4096;

function isReasoningModel(model) {
  return REASONING_MODEL_RE.test(String(model || '').trim());
}

/**
 * Merge the completion-limit and temperature params into `payload` in the shape
 * the given model accepts. Mutates and returns the payload for convenience.
 *
 * Pass `temperature: undefined` to leave it unset entirely.
 */
function applyCompletionParams(payload, model, { maxTokens, temperature } = {}) {
  if (isReasoningModel(model)) {
    if (maxTokens != null) {
      payload.max_completion_tokens = Math.max(Number(maxTokens) || 0, REASONING_MIN_TOKENS);
    }
    // Only the default (1) is accepted; sending it explicitly is allowed but
    // pointless, so leave it off and let the API apply its own default.
    delete payload.temperature;
    return payload;
  }

  if (maxTokens != null) payload.max_tokens = maxTokens;
  if (temperature != null) payload.temperature = temperature;
  return payload;
}

/**
 * True when an API error is the "wrong completion-limit parameter" 400. Used as
 * a belt-and-braces retry so a FUTURE model that flips over to
 * max_completion_tokens works before anyone edits REASONING_MODEL_RE.
 */
function isMaxTokensParamError(err) {
  const msg = String(err?.message || err?.error?.message || '');
  return /max_tokens.*not supported|use\s+'?max_completion_tokens/i.test(msg);
}

module.exports = {
  isReasoningModel,
  applyCompletionParams,
  isMaxTokensParamError,
  REASONING_MIN_TOKENS,
  REASONING_MODEL_RE,
};
