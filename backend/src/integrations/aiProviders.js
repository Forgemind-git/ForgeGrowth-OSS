// AI provider model discovery. Each function takes a raw API key, calls the
// provider's "list models" endpoint, and returns either an array of
// `{id, name}` model descriptors or throws a friendly error.
//
// Errors thrown here surface to the user as 400 responses on the create/sync
// routes, so messages should be safe to display in the admin UI.

const TIMEOUT_MS = 12000;

async function fetchJson(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!res.ok) {
      const msg = parsed?.error?.message || parsed?.error || text?.slice(0, 240) || `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      throw err;
    }
    // 2xx but the response isn't JSON — typically means the URL pointed at a
    // website (HTML 200) or an API gateway error page. Treat as a hard error
    // so the caller can surface a clear message instead of silently storing
    // an empty model list.
    if (parsed === null) {
      const ctHint = ct ? ` (content-type: ${ct.split(';')[0]})` : '';
      throw new Error(`expected JSON response but got non-JSON body${ctHint}. Is the base URL pointing at the API root (not the website)?`);
    }
    return parsed;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI-compatible /models endpoint reader. Used directly by OpenAI, and
// reused by any provider that exposes an OpenAI-shaped /models response when
// the user supplies a custom base URL (Kimi Code, OpenRouter, SiliconFlow…).
async function listOpenAICompatible(apiKey, baseUrl) {
  const root = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${root}/models`;
  const data = await fetchJson(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
  return rows
    .map(m => ({ id: String(m.id || m.name || ''), name: String(m.name || m.id || '') }))
    .filter(m => m.id);
}

async function listOpenAI(apiKey) {
  return listOpenAICompatible(apiKey, 'https://api.openai.com/v1');
}

async function listAnthropic(apiKey) {
  const data = await fetchJson('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows
    .map(m => ({ id: String(m.id || ''), name: String(m.display_name || m.id || '') }))
    .filter(m => m.id);
}

async function listKimi(apiKey, baseUrl) {
  // If the user supplied a custom base URL (Kimi Code, OpenRouter, etc.),
  // call it directly with the OpenAI-compatible /models path. No region
  // fallback in that case — the user told us where to go.
  if (baseUrl && String(baseUrl).trim()) {
    return listOpenAICompatible(apiKey, baseUrl);
  }

  // Strip common paste mistakes: leading "Bearer ", surrounding quotes, stray
  // whitespace, or hidden characters that often slip in when copying.
  const cleaned = String(apiKey)
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!cleaned) throw new Error('API key is empty after sanitising');
  if (!/^sk-/i.test(cleaned)) {
    throw new Error('Moonshot keys start with "sk-". Got: "' + cleaned.slice(0, 6) + '…" — paste only the key string.');
  }

  // Moonshot runs two separate platforms with different key namespaces:
  //   - api.moonshot.ai  → international (platform.moonshot.ai)
  //   - api.moonshot.cn  → China        (platform.moonshot.cn)
  // A key from one platform is rejected by the other with 401. Try .ai first,
  // then fall back to .cn. If both reject the same key, surface a clear
  // double-failure message.
  const endpoints = [
    { url: 'https://api.moonshot.ai/v1/models',  label: 'platform.moonshot.ai' },
    { url: 'https://api.moonshot.cn/v1/models',  label: 'platform.moonshot.cn' },
  ];
  const errors = [];
  for (const ep of endpoints) {
    try {
      const data = await fetchJson(ep.url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${cleaned}` },
      });
      const rows = Array.isArray(data?.data) ? data.data : [];
      return rows
        .map(m => ({ id: String(m.id || ''), name: String(m.id || '') }))
        .filter(m => m.id);
    } catch (err) {
      errors.push({ label: ep.label, status: err.status, message: err.message });
      // Only fall back on auth-style errors. Network errors / 5xx should not
      // mask a real outage by silently trying another region.
      if (err.status !== 401 && err.status !== 403) break;
    }
  }
  const summary = errors.map(e => `${e.label}: ${e.status ? `HTTP ${e.status}` : ''} ${e.message}`.trim()).join(' | ');
  throw new Error(`Moonshot rejected the key on both platforms — ${summary}. Check the key was copied in full from platform.moonshot.ai or platform.moonshot.cn (no extra characters or "Bearer " prefix).`);
}

async function listGemini(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url, { method: 'GET' });
  const rows = Array.isArray(data?.models) ? data.models : [];
  return rows
    .map(m => {
      const raw = String(m.name || '');
      const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
      return { id, name: String(m.displayName || id) };
    })
    .filter(m => m.id);
}

const PROVIDERS = {
  openai:    { label: 'OpenAI',          listModels: listOpenAI },
  anthropic: { label: 'Anthropic Claude', listModels: listAnthropic },
  kimi:      { label: 'Moonshot / Kimi', listModels: listKimi },
  gemini:    { label: 'Google Gemini',   listModels: listGemini },
};

function isSupported(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

async function listModels(provider, apiKey, baseUrl) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unsupported provider: ${provider}`);
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  return p.listModels(apiKey.trim(), baseUrl);
}

module.exports = {
  listModels,
  isSupported,
  providerLabel,
  SUPPORTED: Object.keys(PROVIDERS),
};
