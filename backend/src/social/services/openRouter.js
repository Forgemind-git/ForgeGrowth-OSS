// OpenRouter — one admin-managed key (Settings → OpenRouter) shared by the
// features that call OpenRouter models (Instagram AI agents, the flow AI step).
//   - Key stored AES-GCM encrypted in app_settings (never in env / source).
//   - Every call is logged in ai_usage_log (feature, model, tokens, USD cost
//     reported by OpenRouter) so spend can be shown per feature in rupees.
//   - Account / key spend is read back from OpenRouter (/key, /credits).
//   - USD→INR rate: daily from open.er-api.com (cached), or an admin override.
const pool = require('../db');
const socialEnv = require('../env');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');

const BASE = 'https://openrouter.ai/api';
const K_KEY = 'openrouter_api_key';
const K_RATE = 'openrouter_inr_rate';          // admin override (number as text) or null
const K_FX = 'openrouter_fx_cache';            // {rate, at}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function setSetting(key, value) {
  if (value == null) return pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS ai_usage_log (
        id            bigserial PRIMARY KEY,
        provider      text NOT NULL DEFAULT 'openrouter',
        feature       text NOT NULL,
        model         text,
        input_tokens  int,
        output_tokens int,
        cost_usd      numeric(14,8) NOT NULL DEFAULT 0,
        ok            boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_log_at ON ai_usage_log (created_at DESC);
    `).catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function getKey() { return decrypt(await getSetting(K_KEY)); }

async function orFetch(path, { key, method = 'GET', body } = {}) {
  const k = key || await getKey();
  if (!k) throw new Error('OpenRouter is not connected. Add the API key in Settings → OpenRouter.');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': socialEnv.PUBLIC_BASE_URL || 'https://github.com/Forgemind-git/ForgeGrowth-OSS', 'X-Title': 'Forge Growth' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `OpenRouter returned ${res.status}`;
    const err = new Error(res.status === 401 ? 'OpenRouter rejected the API key' : res.status === 402 ? 'OpenRouter credit limit reached' : msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function logUsage({ feature, model, usage, ok = true }) {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO ai_usage_log (feature, model, input_tokens, output_tokens, cost_usd, ok) VALUES ($1,$2,$3,$4,$5,$6)`,
      [feature, model || null, usage?.input_tokens ?? null, usage?.output_tokens ?? null, Number(usage?.cost) || 0, ok]);
  } catch (e) { console.error('[openrouter] usage log:', e.message); }
}

// TypeSafe System One "decisions" (Jev): one state, several typed questions.
async function decide({ model, state, questions, feature }) {
  const d = await orFetch('/alpha/decisions', { method: 'POST', body: { model, state, questions } });
  await logUsage({ feature, model: d.model || model, usage: d.usage });
  return d;
}

// Chat models OpenRouter offers (text in → text out), cached 6 h. Pricing is USD per token.
let modelCache = null;
async function chatModels() {
  if (modelCache && Date.now() - modelCache.at < 6 * 3600 * 1000) return modelCache.list;
  const d = await (await fetch(BASE + '/v1/models', { signal: AbortSignal.timeout(15000) })).json();
  const list = (d.data || [])
    .filter(m => !/:batch$/.test(m.id))
    .filter(m => (m.architecture?.output_modalities || []).join() === 'text' && (m.architecture?.input_modalities || []).includes('text'))
    .map(m => ({ id: m.id, name: m.name, prompt: Number(m.pricing?.prompt) || 0, completion: Number(m.pricing?.completion) || 0, context: m.context_length }));
  modelCache = { at: Date.now(), list };
  return list;
}
async function costOf(model, inTok, outTok) {
  const m = (await chatModels().catch(() => [])).find(x => x.id === model);
  return m ? (inTok || 0) * m.prompt + (outTok || 0) * m.completion : 0;
}

// ── rupees ──
async function inrRate() {
  const override = Number(await getSetting(K_RATE));
  if (override > 0) return { rate: override, source: 'manual' };
  let cache = null;
  try { cache = JSON.parse(await getSetting(K_FX) || 'null'); } catch (_) {}
  if (cache?.rate && Date.now() - cache.at < 12 * 3600 * 1000) return { rate: cache.rate, source: 'live', at: cache.at };
  try {
    const r = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) })).json();
    const rate = Number(r?.rates?.INR);
    if (rate > 0) { await setSetting(K_FX, JSON.stringify({ rate, at: Date.now() })); return { rate, source: 'live', at: Date.now() }; }
  } catch (_) { /* fall through */ }
  return cache?.rate ? { rate: cache.rate, source: 'live', at: cache.at, stale: true } : { rate: 88, source: 'fallback' };
}

// ── settings + spend (admin) ──
async function status() {
  const enc = await getSetting(K_KEY);
  const key = decrypt(enc);
  const fx = await inrRate();
  const out = { connected: !!key, keyMasked: key ? maskSecret(key) : null, inr: fx, rateOverride: Number(await getSetting(K_RATE)) || null };
  if (!key) return out;
  try {
    const [k, c] = await Promise.all([orFetch('/v1/key', { key }), orFetch('/v1/credits', { key }).catch(() => null)]);
    const d = k.data || {};
    out.key = { label: d.label, limit: d.limit, limitRemaining: d.limit_remaining, limitReset: d.limit_reset, usage: d.usage, daily: d.usage_daily, weekly: d.usage_weekly, monthly: d.usage_monthly, resetsAt: d.effective_budget?.resets_at || null };
    if (c?.data) out.account = { credits: c.data.total_credits, usage: c.data.total_usage, balance: Number(c.data.total_credits) - Number(c.data.total_usage) };
  } catch (e) { out.error = e.message; }
  return out;
}

async function saveKey(key) {
  key = String(key || '').trim();
  if (!/^sk-or-/.test(key)) throw new Error('That does not look like an OpenRouter key (it should start with sk-or-)');
  await orFetch('/v1/key', { key });      // verify before saving
  await setSetting(K_KEY, encrypt(key));
}
async function removeKey() { await setSetting(K_KEY, null); }
async function setRate(rate) {
  const n = Number(rate);
  await setSetting(K_RATE, n > 0 ? String(n) : null);
}

// Local per-feature spend (what ForgeSocial itself spent through this key).
async function spend() {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT feature, model,
           count(*)::int AS calls,
           COALESCE(sum(cost_usd),0)::float AS usd,
           COALESCE(sum(cost_usd) FILTER (WHERE created_at > now() - interval '1 day'),0)::float AS usd_today,
           COALESCE(sum(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'),0)::float AS usd_7d,
           COALESCE(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('month', now())),0)::float AS usd_month,
           count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS calls_today,
           COALESCE(sum(input_tokens),0)::bigint AS input_tokens, COALESCE(sum(output_tokens),0)::bigint AS output_tokens
      FROM ai_usage_log GROUP BY 1, 2 ORDER BY usd DESC`);
  const { rows: days } = await pool.query(`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, count(*)::int AS calls, COALESCE(sum(cost_usd),0)::float AS usd
      FROM ai_usage_log WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`);
  return { byFeature: rows, daily: days };
}

module.exports = { chatModels, costOf, ensureSchema, getKey, decide, logUsage, inrRate, status, saveKey, removeKey, setRate, spend };
