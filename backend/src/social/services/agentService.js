// AI-Agent business logic for ForgeSocial — CRUD + tools + validation.
//
// Adapted from the ForgeChat agent builder, wired to ForgeSocial's domain: an
// agent binds to a social CHANNEL (platform + account) instead of a WhatsApp
// number, auto-replies to the Inbox (Instagram DMs and/or comments), and uses
// ForgeSocial domain tools (analytics/posts/comments/contacts/engage)
// plus generic HTTP + Google Sheets tools.
//
// Functions throw ApiError { status, message } so callers map to HTTP codes.

const pool = require('../db');

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai', 'kimi', 'gemini']);
const PLATFORMS = new Set(['instagram']);
const CAPABILITY_KEYS = ['analytics', 'content', 'inbox', 'contacts', 'engage'];
const DEFAULT_CAPABILITIES = { analytics: true, content: true, inbox: true, contacts: false, engage: false };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ----------------------------- shapers ------------------------------- */

function normCaps(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = src[k] != null ? !!src[k] : DEFAULT_CAPABILITIES[k];
  return out;
}

function agentShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    aiModelId: row.ai_model_id,
    aiProvider: row.ai_provider || null,
    aiModelLabel: row.ai_label || null,
    llmModel: row.llm_model,
    status: row.status || 'draft',
    isActive: row.is_active,
    platform: row.platform || null,
    accountId: row.account_id || null,
    accountLabel: row.account_label || null,
    replyDms: !!row.reply_dms,
    replyComments: row.reply_comments != null ? !!row.reply_comments : true,
    triggerMode: row.trigger_mode || 'any',
    triggerKeyword: row.trigger_keyword || '',
    triggerMatchType: row.trigger_match_type || 'contains',
    triggerCaseSensitive: !!row.trigger_case_sensitive,
    triggerSessionMinutes: row.trigger_session_minutes != null ? row.trigger_session_minutes : 30,
    contextWindowMessages: row.context_window_messages != null ? row.context_window_messages : 20,
    maxToolIterations: row.max_tool_iterations != null ? row.max_tool_iterations : 6,
    acceptImages: !!row.accept_images,
    transcribeAudio: !!row.transcribe_audio,
    humanize: row.humanize != null ? !!row.humanize : true,
    minDelaySec: row.min_delay_sec != null ? row.min_delay_sec : 5,
    maxDelaySec: row.max_delay_sec != null ? row.max_delay_sec : 10,
    capabilities: normCaps(row.capabilities),
    enableHandoff: !!row.enable_handoff,
    handoffInstructions: row.handoff_instructions || '',
    autoTags: Array.isArray(row.auto_tags) ? row.auto_tags : (typeof row.auto_tags === 'string' ? (JSON.parse(row.auto_tags) || []) : []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toolShape(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    toolType: row.tool_type,
    config: row.config || {},
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
  };
}

/* --------------------------- normalizers ----------------------------- */

function cleanMatchType(v) {
  return ['exact', 'contains', 'starts'].includes(v) ? v : 'contains';
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(u)) return null;
  return u.slice(0, 2048);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

async function getAiModel(id) {
  if (id == null || id === '') return null;
  const { rows } = await pool.query('SELECT id, provider FROM ai_models WHERE id = $1', [id]);
  return rows[0] || null;
}

async function fetchAgent(id) {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.label AS ai_label
       FROM agents a LEFT JOIN ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [id],
  );
  return agentShape(rows[0]);
}

/* ------------------------------ reads -------------------------------- */

async function listAgents() {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.label AS ai_label,
            (SELECT COUNT(*)::int FROM agent_tools t WHERE t.agent_id = a.id) AS tool_count,
            (SELECT MAX(started_at) FROM agent_runs r WHERE r.agent_id = a.id) AS last_run_at
       FROM agents a LEFT JOIN ai_models am ON am.id = a.ai_model_id
       ORDER BY a.updated_at DESC`,
  );
  return rows.map(r => ({ ...agentShape(r), toolCount: r.tool_count, lastRunAt: r.last_run_at }));
}

async function getAgent(id) {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.label AS ai_label
       FROM agents a LEFT JOIN ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const { rows: tools } = await pool.query('SELECT * FROM agent_tools WHERE agent_id = $1 ORDER BY id', [id]);
  return { ...agentShape(rows[0]), tools: tools.map(toolShape) };
}

/* ----------------------------- mutations ----------------------------- */

function mapPgError(err) {
  if (err.code === '23505') {
    return new ApiError(409, 'Another agent is already active on this channel (platform + account). Deactivate it first.');
  }
  return err;
}

function validateChannel(b, status, isActive) {
  const platform = b.platform || null;
  if (platform && !PLATFORMS.has(platform)) throw new ApiError(400, `platform must be one of: ${[...PLATFORMS].join(', ')}`);
  // DMs are Instagram-only.
  const replyDms = platform === 'instagram' ? !!b.replyDms : false;
  const replyComments = b.replyComments != null ? !!b.replyComments : true;
  if ((status === 'active' || isActive)) {
    if (!platform) throw new ApiError(400, 'An active agent needs a platform + account to serve.');
    if (!b.accountId) throw new ApiError(400, 'An active agent needs a connected account.');
    if (!replyDms && !replyComments) throw new ApiError(400, 'Enable at least one of: reply to DMs / reply to comments.');
  }
  return { platform, replyDms, replyComments };
}

async function validateModel(aiModelId, status, isActive) {
  if (!aiModelId) {
    // No AI Models row = run on Social's OpenRouter key (see agentEngine.loadRunnableAgent).
    if (status === 'active' || isActive) {
      const key = await require('./openRouter').getKey().catch(() => null);
      if (!key) throw new ApiError(400, 'Connect OpenRouter (Settings → OpenRouter) before switching an agent on.');
    }
    return;
  }
  const model = await getAiModel(aiModelId);
  if (!model) throw new ApiError(400, 'Selected AI model no longer exists.');
  if ((status === 'active' || isActive) && !SUPPORTED_PROVIDERS.has(model.provider)) {
    throw new ApiError(400, `Provider '${model.provider}' isn't supported by agents.`);
  }
}

async function createAgent(b = {}) {
  if (!b.name || !b.systemPrompt) throw new ApiError(400, 'name and systemPrompt are required');
  const status = b.status === 'active' ? 'active' : 'draft';
  const isActive = status === 'active' ? !!b.isActive : false;
  const aiModelId = b.aiModelId || null;
  const llmModel = b.llmModel ? String(b.llmModel).trim() : null;

  await validateModel(aiModelId, status, isActive);
  if ((status === 'active' || isActive) && !llmModel) throw new ApiError(400, 'Pick a model for the agent.');
  const { platform, replyDms, replyComments } = validateChannel(b, status, isActive);

  const triggerMode = ['keyword'].includes(b.triggerMode) ? b.triggerMode : 'any';
  const triggerKeyword = typeof b.triggerKeyword === 'string' ? b.triggerKeyword.trim().slice(0, 200) : '';
  if ((status === 'active' || isActive) && triggerMode === 'keyword' && !triggerKeyword) {
    throw new ApiError(400, 'A keyword-triggered agent needs a keyword.');
  }
  const minDelay = clampInt(b.minDelaySec, 0, 600, 5);
  const maxDelay = Math.max(minDelay, clampInt(b.maxDelaySec, 0, 600, 10));

  try {
    const { rows } = await pool.query(
      `INSERT INTO agents
         (name, description, system_prompt, ai_model_id, llm_model, status, is_active,
          platform, account_id, account_label, reply_dms, reply_comments,
          trigger_mode, trigger_keyword, trigger_match_type, trigger_case_sensitive, trigger_session_minutes,
          context_window_messages, max_tool_iterations, accept_images, transcribe_audio,
          humanize, min_delay_sec, max_delay_sec, capabilities,
          enable_handoff, handoff_instructions, auto_tags, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING id`,
      [
        b.name.trim(), b.description?.trim() || null, b.systemPrompt,
        aiModelId, llmModel, status, isActive,
        platform, b.accountId || null, b.accountLabel?.slice(0, 200) || null, replyDms, replyComments,
        triggerMode, triggerKeyword || null, cleanMatchType(b.triggerMatchType), !!b.triggerCaseSensitive, clampInt(b.triggerSessionMinutes, 1, 1440, 30),
        clampInt(b.contextWindowMessages, 1, 100, 20), clampInt(b.maxToolIterations, 1, 20, 6), !!b.acceptImages, !!b.transcribeAudio,
        b.humanize !== false, minDelay, maxDelay, JSON.stringify(normCaps(b.capabilities)),
        !!b.enableHandoff, b.handoffInstructions?.trim() || null, JSON.stringify(Array.isArray(b.autoTags) ? b.autoTags : []),
        b.createdBy || null,
      ],
    );
    return await fetchAgent(rows[0].id);
  } catch (err) {
    throw mapPgError(err);
  }
}

async function updateAgent(id, b = {}) {
  const { rows: existing } = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  if (existing.length === 0) throw new ApiError(404, 'Not found');
  const cur = existing[0];

  const effStatus   = b.status !== undefined ? (b.status === 'active' ? 'active' : 'draft') : (cur.status || 'draft');
  const effModelId  = b.aiModelId !== undefined ? (b.aiModelId || null) : cur.ai_model_id;
  const effLlmModel = b.llmModel !== undefined ? (b.llmModel ? String(b.llmModel).trim() : null) : cur.llm_model;
  let   effIsActive = b.isActive !== undefined ? !!b.isActive : cur.is_active;
  if (effStatus === 'draft') effIsActive = false;

  await validateModel(effModelId, effStatus, effIsActive);
  if ((effStatus === 'active' || effIsActive) && !effLlmModel) throw new ApiError(400, 'Pick a model for the agent.');

  // Merge channel fields against current row for validation when partially patched.
  const chBody = {
    platform: b.platform !== undefined ? b.platform : cur.platform,
    accountId: b.accountId !== undefined ? b.accountId : cur.account_id,
    replyDms: b.replyDms !== undefined ? b.replyDms : cur.reply_dms,
    replyComments: b.replyComments !== undefined ? b.replyComments : cur.reply_comments,
  };
  const { platform, replyDms, replyComments } = validateChannel(chBody, effStatus, effIsActive);

  const effTrigMode = b.triggerMode !== undefined ? (['keyword'].includes(b.triggerMode) ? b.triggerMode : 'any') : (cur.trigger_mode || 'any');
  const effTrigKeyword = b.triggerKeyword !== undefined ? String(b.triggerKeyword || '').trim() : (cur.trigger_keyword || '');
  if ((effStatus === 'active' || effIsActive) && effTrigMode === 'keyword' && !effTrigKeyword) {
    throw new ApiError(400, 'A keyword-triggered agent needs a keyword.');
  }

  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

  if (b.name !== undefined) push('name', b.name.trim());
  if (b.description !== undefined) push('description', b.description?.trim() || null);
  if (b.systemPrompt !== undefined) push('system_prompt', b.systemPrompt);
  if (b.aiModelId !== undefined) push('ai_model_id', effModelId);
  if (b.llmModel !== undefined) push('llm_model', effLlmModel);
  if (b.status !== undefined) push('status', effStatus);
  if (b.isActive !== undefined || b.status !== undefined) push('is_active', effIsActive);
  if (b.platform !== undefined) push('platform', platform);
  if (b.accountId !== undefined) push('account_id', b.accountId || null);
  if (b.accountLabel !== undefined) push('account_label', b.accountLabel?.slice(0, 200) || null);
  if (b.replyDms !== undefined || b.platform !== undefined) push('reply_dms', replyDms);
  if (b.replyComments !== undefined) push('reply_comments', replyComments);
  if (b.triggerMode !== undefined) push('trigger_mode', effTrigMode);
  if (b.triggerKeyword !== undefined) push('trigger_keyword', effTrigKeyword || null);
  if (b.triggerMatchType !== undefined) push('trigger_match_type', cleanMatchType(b.triggerMatchType));
  if (b.triggerCaseSensitive !== undefined) push('trigger_case_sensitive', !!b.triggerCaseSensitive);
  if (b.triggerSessionMinutes !== undefined) push('trigger_session_minutes', clampInt(b.triggerSessionMinutes, 1, 1440, 30));
  if (b.contextWindowMessages !== undefined) push('context_window_messages', clampInt(b.contextWindowMessages, 1, 100, 20));
  if (b.maxToolIterations !== undefined) push('max_tool_iterations', clampInt(b.maxToolIterations, 1, 20, 6));
  if (b.acceptImages !== undefined) push('accept_images', !!b.acceptImages);
  if (b.transcribeAudio !== undefined) push('transcribe_audio', !!b.transcribeAudio);
  if (b.humanize !== undefined) push('humanize', !!b.humanize);
  if (b.minDelaySec !== undefined) push('min_delay_sec', clampInt(b.minDelaySec, 0, 600, 5));
  if (b.maxDelaySec !== undefined) push('max_delay_sec', clampInt(b.maxDelaySec, 0, 600, 10));
  if (b.capabilities !== undefined) push('capabilities', JSON.stringify(normCaps(b.capabilities)));
  if (b.enableHandoff !== undefined) push('enable_handoff', !!b.enableHandoff);
  if (b.handoffInstructions !== undefined) push('handoff_instructions', b.handoffInstructions?.trim() || null);
  if (b.autoTags !== undefined) push('auto_tags', JSON.stringify(Array.isArray(b.autoTags) ? b.autoTags : []));

  params.push(id);
  try {
    const { rows } = await pool.query(`UPDATE agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`, params);
    return await fetchAgent(rows[0].id);
  } catch (err) {
    throw mapPgError(err);
  }
}

async function deleteAgent(id) {
  const { rowCount } = await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  if (rowCount === 0) throw new ApiError(404, 'Not found');
  return { ok: true };
}

/* ------------------------------ tools -------------------------------- */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PARAM_LOCATIONS = new Set(['path', 'query', 'body', 'header']);
const PARAM_TYPES = new Set(['string', 'number', 'boolean']);

function validateHttpConfig(cfg = {}) {
  const label = String(cfg.label || '').trim();
  if (!label) throw new ApiError(400, 'Give the HTTP tool a name (label).');
  const description = String(cfg.description || '').trim();
  if (!description) throw new ApiError(400, 'Describe when the agent should use this HTTP tool — the AI needs it to decide.');

  const method = String(cfg.method || 'GET').trim().toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new ApiError(400, `Method must be one of ${[...HTTP_METHODS].join(', ')}.`);

  const url = normalizeUrl(cfg.url);
  if (!url) throw new ApiError(400, 'Enter a valid http(s) URL for the HTTP tool.');

  const headers = Array.isArray(cfg.headers)
    ? cfg.headers.map(h => ({ k: String(h?.k || '').trim(), v: String(h?.v ?? '').trim() })).filter(h => h.k).slice(0, 30)
    : [];

  const seen = new Set();
  const params = Array.isArray(cfg.params)
    ? cfg.params.map((p, idx) => {
        const name = String(p?.name || '').trim();
        if (!name) throw new ApiError(400, `Parameter #${idx + 1} needs a name.`);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new ApiError(400, `Parameter "${name}" must be a simple identifier.`);
        if (seen.has(name)) throw new ApiError(400, `Duplicate parameter name "${name}".`);
        seen.add(name);
        return {
          name,
          in: PARAM_LOCATIONS.has(p?.in) ? p.in : 'body',
          type: PARAM_TYPES.has(p?.type) ? p.type : 'string',
          description: String(p?.description || '').trim().slice(0, 500),
          required: !!p?.required,
        };
      }).slice(0, 30)
    : [];

  const placeholders = [...url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(m => m[1]);
  for (const ph of placeholders) {
    const p = params.find(x => x.name === ph);
    if (!p) throw new ApiError(400, `URL placeholder {${ph}} has no matching "path" parameter named "${ph}".`);
    if (p.in !== 'path') throw new ApiError(400, `Parameter "${ph}" is in the URL path, so its location must be "path".`);
  }

  const timeoutMs = clampInt(cfg.timeout_ms, 1000, 30000, 10000);
  return { label: label.slice(0, 120), description: description.slice(0, 1000), method, url, headers, params, timeout_ms: timeoutMs };
}

function validateToolConfig(toolType, config) {
  if (toolType === 'google_sheets') {
    const cfg = config || {};
    // Accept a pasted spreadsheet URL too.
    let id = String(cfg.spreadsheet_id || '').trim();
    const m = id.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (m) id = m[1];
    if (!id) throw new ApiError(400, 'Paste the Google Sheet ID or URL.');
    if (!cfg.sheet_name) throw new ApiError(400, 'Enter the tab (sheet) name.');
    if (!Array.isArray(cfg.ops) || cfg.ops.length === 0) throw new ApiError(400, 'Enable at least one operation (read / append / update / upsert).');
    const ops = cfg.ops.filter(o => ['read', 'append', 'update', 'upsert'].includes(o));
    if (ops.length === 0) throw new ApiError(400, 'Enable at least one valid operation.');
    return { spreadsheet_id: id, spreadsheet_name: cfg.spreadsheet_name?.slice(0, 200) || null, sheet_name: String(cfg.sheet_name).slice(0, 200), ops };
  }
  if (toolType === 'http_request') return validateHttpConfig(config);
  throw new ApiError(400, `Unsupported tool type '${toolType}'.`);
}

async function addTool(agentId, b = {}) {
  if (!b.toolType || !b.config) throw new ApiError(400, 'toolType and config are required');
  const cleanConfig = validateToolConfig(b.toolType, b.config);
  const { rows } = await pool.query(
    `INSERT INTO agent_tools (agent_id, tool_type, config, is_enabled) VALUES ($1,$2,$3,$4) RETURNING *`,
    [agentId, b.toolType, JSON.stringify(cleanConfig), b.isEnabled !== false],
  );
  return toolShape(rows[0]);
}

async function updateTool(agentId, toolId, b = {}) {
  const sets = [];
  const params = [];
  let i = 1;
  if (b.config !== undefined) {
    const { rows: cur } = await pool.query('SELECT tool_type FROM agent_tools WHERE agent_id = $1 AND id = $2', [agentId, toolId]);
    if (cur.length === 0) throw new ApiError(404, 'Not found');
    const cleanConfig = validateToolConfig(cur[0].tool_type, b.config);
    sets.push(`config = $${i++}`); params.push(JSON.stringify(cleanConfig));
  }
  if (b.isEnabled !== undefined) { sets.push(`is_enabled = $${i++}`); params.push(!!b.isEnabled); }
  if (sets.length === 0) throw new ApiError(400, 'No updatable fields provided');
  params.push(agentId, toolId);
  const { rows } = await pool.query(
    `UPDATE agent_tools SET ${sets.join(', ')} WHERE agent_id = $${i++} AND id = $${i} RETURNING *`,
    params,
  );
  if (rows.length === 0) throw new ApiError(404, 'Not found');
  return toolShape(rows[0]);
}

async function deleteTool(agentId, toolId) {
  const { rowCount } = await pool.query('DELETE FROM agent_tools WHERE agent_id = $1 AND id = $2', [agentId, toolId]);
  if (rowCount === 0) throw new ApiError(404, 'Not found');
  return { ok: true };
}

module.exports = {
  ApiError, CAPABILITY_KEYS, DEFAULT_CAPABILITIES, SUPPORTED_PROVIDERS,
  agentShape, toolShape,
  listAgents, getAgent, createAgent, updateAgent, deleteAgent,
  addTool, updateTool, deleteTool,
};
