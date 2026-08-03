// AI Models admin route — CRUD over connected AI provider API keys.
// Keys are AES-256-GCM encrypted at rest. On create (and on /sync), the
// provider's /models endpoint is called to discover available models, which
// are cached in `available_models`.

const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');
const { listModels, isSupported, providerLabel, SUPPORTED } = require('../integrations/aiProviders');

const router = Router();

// Curated default-enabled subset per provider. When a row is created, only
// the intersection of these ids and the discovered available_models is
// initially marked enabled — keeps the AI Agent picker free of clutter.
// Order matters: first match is treated as the recommended default.
const DEFAULT_ENABLED = {
  openai: ['gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-5'],
};

// Build the dynamic WHERE clause + params array for activity queries.
// Always filters to ai_agent steps attributed to a credential (credentialId
// match, with provider-fallback for historical rows). Adds optional
// status/model/from/to filters when supplied.
function buildActivityWhere(credId, provider, filters = {}) {
  const params = [credId, provider];
  const where = [
    `s.node_type = 'ai_agent'`,
    `(
      (s.input_data->>'credentialId')::int = $1
      OR (s.input_data->>'credentialId' IS NULL AND s.input_data->>'provider' = $2)
    )`,
  ];
  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    where.push(`s.status = $${params.length}`);
  }
  if (filters.model) {
    params.push(filters.model);
    where.push(`COALESCE(s.input_data->>'model', s.input_data->'modelRef'->>'modelId') = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`s.started_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`s.started_at <= $${params.length}::timestamptz`);
  }
  return { whereSql: where.join(' AND '), params };
}

async function loadActivity(credId, provider, limit, offset, filters = {}) {
  const lim = Math.min(Math.max(parseInt(limit || 20, 10), 1), 100);
  const off = Math.max(parseInt(offset || 0, 10), 0);
  const { whereSql, params } = buildActivityWhere(credId, provider, filters);

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM coexistence.automation_execution_steps s
      WHERE ${whereSql}`,
    params
  );

  const dataParams = [...params, lim, off];
  const { rows } = await pool.query(
    `SELECT
       s.id,
       s.execution_id,
       e.automation_id,
       cb.name AS automation_name,
       s.started_at,
       s.completed_at,
       s.status,
       s.error_message,
       COALESCE(s.input_data->>'model', s.input_data->'modelRef'->>'modelId') AS model_id,
       s.input_data->>'userMessage' AS user_message,
       s.output_data->>'raw'        AS ai_raw,
       s.output_data->'parsed'      AS ai_parsed,
       (s.output_data->'usage'->>'total_tokens')::int       AS total_tokens,
       (s.output_data->'usage'->>'prompt_tokens')::int      AS prompt_tokens,
       (s.output_data->'usage'->>'completion_tokens')::int  AS completion_tokens,
       (s.output_data->>'elapsedMs')::int                   AS elapsed_ms
     FROM coexistence.automation_execution_steps s
     LEFT JOIN coexistence.automation_executions e ON e.id = s.execution_id
     LEFT JOIN coexistence.chatbots cb              ON cb.id = e.automation_id
     WHERE ${whereSql}
     ORDER BY s.started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    dataParams
  );

  return {
    total: countRows[0].total,
    limit: lim,
    offset: off,
    items: rows.map(r => ({
      stepId: r.id,
      executionId: r.execution_id,
      automationId: r.automation_id,
      automationName: r.automation_name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: r.status,
      errorMessage: r.error_message,
      modelId: r.model_id,
      userMessage: r.user_message,
      aiResponse: r.ai_parsed ?? r.ai_raw,
      totalTokens: r.total_tokens,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      elapsedMs: r.elapsed_ms,
    })),
  };
}

function pickDefaultEnabled(provider, models) {
  const wishlist = DEFAULT_ENABLED[provider];
  if (!wishlist) return null; // null = all enabled (preserves existing behaviour for kimi/anthropic/gemini)
  const available = new Set(models.map(m => m.id));
  const enabled = wishlist.filter(id => available.has(id));
  // Fall back to all-enabled if none of the curated ids exist on this account
  // (e.g. provider deprecated the curated id).
  return enabled.length > 0 ? enabled : null;
}

function shapeRow(r, { reveal = false } = {}) {
  let plainKey = null;
  if (reveal) plainKey = decrypt(r.api_key_encrypted);
  return {
    id: r.id,
    provider: r.provider,
    providerLabel: providerLabel(r.provider),
    label: r.label,
    apiKey: reveal ? plainKey : null,
    apiKeyMasked: maskSecret(decrypt(r.api_key_encrypted) || ''),
    baseUrl: r.base_url || null,
    availableModels: r.available_models || [],
    enabledModels: r.enabled_models, // null = all enabled; array = explicit subset
    lastSyncedAt: r.last_synced_at,
    lastSyncError: r.last_sync_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get('/ai-models', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.ai_models ORDER BY created_at DESC`
    );
    res.json(rows.map(r => shapeRow(r)));
  } catch (err) {
    console.error('[aiModels] list error:', err.message);
    res.status(500).json({ error: 'Failed to list AI models' });
  }
});

router.get('/ai-models/:id', async (req, res) => {
  try {
    const reveal = req.query.reveal === '1' || req.query.reveal === 'true';
    if (reveal && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can reveal API keys' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(shapeRow(rows[0], { reveal }));
  } catch (err) {
    console.error('[aiModels] get error:', err.message);
    res.status(500).json({ error: 'Failed to load AI model' });
  }
});

router.post('/ai-models', async (req, res) => {
  try {
    const { provider, label, apiKey, baseUrl } = req.body || {};
    if (!provider || !isSupported(provider)) {
      return res.status(400).json({ error: `Provider must be one of: ${SUPPORTED.join(', ')}` });
    }
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(400).json({ error: 'API key is required' });
    }
    const cleanBaseUrl = baseUrl?.trim() || null;
    if (cleanBaseUrl && !/^https?:\/\//i.test(cleanBaseUrl)) {
      return res.status(400).json({ error: 'Custom base URL must start with http:// or https://' });
    }

    // Probe the provider's model list as a real connectivity + key-validity
    // check. If this fails the row is never created.
    let models = [];
    try {
      models = await listModels(provider, apiKey, cleanBaseUrl);
    } catch (err) {
      return res.status(400).json({ error: `Provider rejected the key: ${err.message}` });
    }
    if (!Array.isArray(models) || models.length === 0) {
      return res.status(400).json({ error: 'Provider returned no models. Check that the base URL points at the API root (e.g. /v1) and not a website page.' });
    }

    const defaultEnabled = pickDefaultEnabled(provider, models);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.ai_models (provider, label, api_key_encrypted, base_url, available_models, enabled_models, last_synced_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW()) RETURNING *`,
      [
        provider,
        label?.trim() || null,
        encrypt(String(apiKey).trim()),
        cleanBaseUrl,
        JSON.stringify(models),
        defaultEnabled ? JSON.stringify(defaultEnabled) : null,
      ]
    );
    res.status(201).json(shapeRow(rows[0]));
  } catch (err) {
    console.error('[aiModels] create error:', err.message);
    res.status(500).json({ error: 'Failed to save AI model' });
  }
});

router.put('/ai-models/:id', async (req, res) => {
  try {
    const { label, apiKey, enabledModels } = req.body || {};
    const { rows: existing } = await pool.query(
      `SELECT * FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const row = existing[0];

    let newKey = null;
    let newModels = null;
    if (apiKey && String(apiKey).trim()) {
      try {
        newModels = await listModels(row.provider, apiKey);
      } catch (err) {
        return res.status(400).json({ error: `Provider rejected the new key: ${err.message}` });
      }
      newKey = encrypt(String(apiKey).trim());
    }

    // enabledModels: undefined → don't touch; null → reset to "all enabled";
    // array → store explicit subset (validated against available_models).
    let enabledPatch = undefined; // tri-state: undefined / null / string array
    if (enabledModels === null) {
      enabledPatch = null;
    } else if (Array.isArray(enabledModels)) {
      const available = (newModels || row.available_models || []).map(m => m.id);
      const set = new Set(available);
      enabledPatch = enabledModels
        .map(v => String(v))
        .filter(v => set.has(v));
    }

    const { rows: updated } = await pool.query(
      `UPDATE coexistence.ai_models SET
         label = COALESCE($1, label),
         api_key_encrypted = COALESCE($2, api_key_encrypted),
         available_models = COALESCE($3::jsonb, available_models),
         enabled_models = CASE
           WHEN $5::text = 'set' THEN $4::jsonb
           ELSE enabled_models
         END,
         last_synced_at = CASE WHEN $3::jsonb IS NOT NULL THEN NOW() ELSE last_synced_at END,
         last_sync_error = CASE WHEN $3::jsonb IS NOT NULL THEN NULL ELSE last_sync_error END,
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        label?.trim() ?? null,
        newKey,
        newModels ? JSON.stringify(newModels) : null,
        enabledPatch === undefined ? null : (enabledPatch === null ? null : JSON.stringify(enabledPatch)),
        enabledPatch === undefined ? 'skip' : 'set',
        req.params.id,
      ]
    );
    res.json(shapeRow(updated[0]));
  } catch (err) {
    console.error('[aiModels] update error:', err.message);
    res.status(500).json({ error: 'Failed to update AI model' });
  }
});

// Usage dashboard: aggregates AI Agent step rows attributed to this
// credential. Historical rows (before credentialId logging) are matched by
// provider as a best-effort fallback.
router.get('/ai-models/:id/usage', async (req, res) => {
  try {
    const { rows: credRows } = await pool.query(
      `SELECT * FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (credRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const cred = credRows[0];

    // Aggregated counts + tokens from automation_execution_steps
    const { rows: aggRows } = await pool.query(
      `SELECT
         COUNT(*)::int                                                                 AS total_calls,
         COUNT(*) FILTER (WHERE status = 'success')::int                               AS successful_calls,
         COUNT(*) FILTER (WHERE status = 'error')::int                                 AS failed_calls,
         COALESCE(SUM((output_data->'usage'->>'total_tokens')::int), 0)::bigint        AS total_tokens,
         COALESCE(SUM((output_data->'usage'->>'prompt_tokens')::int), 0)::bigint       AS prompt_tokens,
         COALESCE(SUM((output_data->'usage'->>'completion_tokens')::int), 0)::bigint   AS completion_tokens,
         MAX(started_at)                                                               AS last_used_at,
         MIN(started_at)                                                               AS first_used_at
       FROM coexistence.automation_execution_steps
       WHERE node_type = 'ai_agent'
         AND (
           (input_data->>'credentialId')::int = $1
           OR (input_data->>'credentialId' IS NULL AND input_data->>'provider' = $2)
         )`,
      [cred.id, cred.provider]
    );
    const agg = aggRows[0] || {};

    // First page of recent activity (paginate via /ai-models/:id/activity)
    const firstPage = await loadActivity(cred.id, cred.provider, 20, 0);

    // Per-model breakdown
    const { rows: byModelRows } = await pool.query(
      `SELECT
         input_data->>'model' AS model_id,
         COUNT(*)::int AS calls,
         COALESCE(SUM((output_data->'usage'->>'total_tokens')::int), 0)::bigint AS tokens
       FROM coexistence.automation_execution_steps
       WHERE node_type = 'ai_agent'
         AND (
           (input_data->>'credentialId')::int = $1
           OR (input_data->>'credentialId' IS NULL AND input_data->>'provider' = $2)
         )
       GROUP BY input_data->>'model'
       ORDER BY tokens DESC NULLS LAST, calls DESC`,
      [cred.id, cred.provider]
    );

    // Live connection probe — quick ping to /models to confirm key is valid
    // right now (independent of the cached last_synced_at).
    let connectionStatus = 'unknown';
    let connectionError = null;
    let connectionCheckedAt = new Date().toISOString();
    try {
      const apiKey = decrypt(cred.api_key_encrypted);
      if (!apiKey) throw new Error('Could not decrypt stored API key');
      await listModels(cred.provider, apiKey, cred.base_url);
      connectionStatus = 'healthy';
    } catch (err) {
      connectionStatus = 'error';
      connectionError = err.message;
    }

    res.json({
      credential: {
        id: cred.id,
        provider: cred.provider,
        providerLabel: providerLabel(cred.provider),
        label: cred.label,
        createdAt: cred.created_at,
        lastSyncedAt: cred.last_synced_at,
        lastSyncError: cred.last_sync_error,
        baseUrl: cred.base_url,
      },
      connection: {
        status: connectionStatus,
        error: connectionError,
        checkedAt: connectionCheckedAt,
      },
      usage: {
        totalCalls:       Number(agg.total_calls || 0),
        successfulCalls:  Number(agg.successful_calls || 0),
        failedCalls:      Number(agg.failed_calls || 0),
        totalTokens:      Number(agg.total_tokens || 0),
        promptTokens:     Number(agg.prompt_tokens || 0),
        completionTokens: Number(agg.completion_tokens || 0),
        lastUsedAt:       agg.last_used_at || null,
        firstUsedAt:      agg.first_used_at || null,
        byModel: byModelRows.map(r => ({ modelId: r.model_id, calls: Number(r.calls), tokens: Number(r.tokens) })),
      },
      recentCalls: firstPage.items,
      activity: {
        total: firstPage.total,
        limit: firstPage.limit,
        offset: firstPage.offset,
      },
    });
  } catch (err) {
    console.error('[aiModels] usage error:', err.message);
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

// Paginated activity log for a single AI credential.
// Query: ?limit=20&offset=0 (limit max 100). Returns { total, limit, offset, items }.
router.get('/ai-models/:id/activity', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, provider FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const cred = rows[0];
    const filters = {
      status: req.query.status || undefined,
      model:  req.query.model  || undefined,
      from:   req.query.from   || undefined,
      to:     req.query.to     || undefined,
    };
    const data = await loadActivity(cred.id, cred.provider, req.query.limit, req.query.offset, filters);
    res.json(data);
  } catch (err) {
    console.error('[aiModels] activity error:', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.post('/ai-models/:id/sync', async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const row = existing[0];
    const key = decrypt(row.api_key_encrypted);
    if (!key) return res.status(500).json({ error: 'Failed to decrypt stored key' });
    try {
      const models = await listModels(row.provider, key, row.base_url);
      const { rows: updated } = await pool.query(
        `UPDATE coexistence.ai_models
            SET available_models = $1::jsonb,
                last_synced_at = NOW(),
                last_sync_error = NULL,
                updated_at = NOW()
          WHERE id = $2 RETURNING *`,
        [JSON.stringify(models), req.params.id]
      );
      res.json(shapeRow(updated[0]));
    } catch (err) {
      await pool.query(
        `UPDATE coexistence.ai_models SET last_sync_error = $1, updated_at = NOW() WHERE id = $2`,
        [err.message?.slice(0, 500) || 'unknown error', req.params.id]
      );
      res.status(400).json({ error: `Provider error: ${err.message}` });
    }
  } catch (err) {
    console.error('[aiModels] sync error:', err.message);
    res.status(500).json({ error: 'Failed to sync models' });
  }
});

router.delete('/ai-models/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM coexistence.ai_models WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[aiModels] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete AI model' });
  }
});

module.exports = { router };
