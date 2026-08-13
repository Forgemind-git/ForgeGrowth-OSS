// Shared AI-Agent business logic — used by BOTH the cookie-authed routes
// (routes/agents.js) and the bearer-authed MCP API (routes/mcp.js).
//
// Every mutation here performs the exact same validation the in-app builder
// relied on (draft/active invariant, supported provider, WABA-uniqueness,
// Google Sheets config). Functions throw an ApiError { status, message } so the
// calling router maps it to the right HTTP code; everything else bubbles as a
// 500.

const pool = require('../db');
const { asLimit, WINDOW_UNITS } = require('./agentLimits');

const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai']);

// Lightweight typed error so routers can map status → HTTP code.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ----------------------------- shapers ------------------------------- */

function agentShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // Organisational only — which project (campaign) this agent belongs to.
    // Has no effect on how the agent runs. projectName is only present on the
    // list query, which joins it.
    projectId: row.project_id == null ? null : Number(row.project_id),
    projectName: row.project_name || null,
    systemPrompt: row.system_prompt,
    aiModelId: row.ai_model_id,
    aiProvider: row.ai_provider || null,
    aiModelLabel: row.ai_label || null,
    llmModel: row.llm_model,
    status: row.status || 'active',
    waAccountId: row.wa_account_id,
    isActive: row.is_active,
    contextWindowMessages: row.context_window_messages,
    maxToolIterations: row.max_tool_iterations,
    transcribeAudio: !!row.transcribe_audio,
    acceptImages: !!row.accept_images,
    triggerMode: row.trigger_mode || 'any',
    triggerKeyword: row.trigger_keyword || '',
    triggerMatchType: row.trigger_match_type || 'contains',
    triggerCaseSensitive: !!row.trigger_case_sensitive,
    triggerSessionMinutes: row.trigger_session_minutes != null ? row.trigger_session_minutes : 30,
    // Funnel gating. Empty arrays = engage regardless of where the lead sits,
    // which is what every agent predating this had.
    triggerStageKeys: Array.isArray(row.trigger_stage_keys) ? row.trigger_stage_keys : [],
    triggerTagIds: Array.isArray(row.trigger_tag_ids) ? row.trigger_tag_ids : [],
    mediaGroups: Array.isArray(row.media_groups) ? row.media_groups : [],
    // Usage limits — null means unlimited all the way to the UI, never 0.
    maxRepliesPerConversation: row.max_replies_per_conversation == null ? null : Number(row.max_replies_per_conversation),
    maxRepliesPerMinute: row.max_replies_per_minute == null ? null : Number(row.max_replies_per_minute),
    maxRunsPerDay: row.max_runs_per_day == null ? null : Number(row.max_runs_per_day),
    limitReachedMessage: row.limit_reached_message || '',
    limitHandoff: row.limit_handoff !== false,
    // Rolling per-person quota. The window is value + unit; minutes are derived
    // in agentLimits.windowMinutes and nowhere else.
    quotaReplies: row.quota_replies == null ? null : Number(row.quota_replies),
    quotaConversations: row.quota_conversations == null ? null : Number(row.quota_conversations),
    quotaWindowValue: row.quota_window_value == null ? 1 : Number(row.quota_window_value),
    quotaWindowUnit: WINDOW_UNITS[row.quota_window_unit] ? row.quota_window_unit : 'days',
    quotaHandoff: row.quota_handoff === true,
    // Numbers that may exercise this agent while it is still a draft, exempt
    // from every usage limit. Always an array — the UI maps over it.
    testNumbers: Array.isArray(row.test_numbers) ? row.test_numbers : [],
    // Media understanding ceilings — same null-is-unlimited rule as above.
    maxVoiceSeconds: row.max_voice_seconds == null ? null : Number(row.max_voice_seconds),
    maxImagesPerConversation: row.max_images_per_conversation == null ? null : Number(row.max_images_per_conversation),
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

// Funnel stage keys the agent is allowed to engage.
//
// ⚠ Stored as the IMMUTABLE `stage_key`, never the label or the row id — the
// same rule the stage-tag mirror and the cold-drop engine
// all follow. An admin renaming "Hot" to "Warm" in Funnel Settings must not
// silently stop an agent from answering anybody.
//
// Unknown keys are DROPPED rather than rejected: a stage deleted after the
// agent was configured should narrow what the agent engages, not 400 every
// subsequent save of an unrelated field.
//
// ⚠ Reads `funnel_stages` DIRECTLY rather than funnelConfig's in-process cache.
// The cache is warmed at boot, so the cached version worked in the running app
// and silently validated NOTHING anywhere the cache was cold — it accepted a
// junk stage key with no error, and a gate on a key that matches no stage
// answers nobody while looking configured. This is a config write path, so one
// query is free; being right without depending on warm state is not.
async function sanitizeStageKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const wanted = [];
  for (const v of raw) {
    const k = String(v || '').trim().slice(0, 100);
    if (k && !wanted.includes(k)) wanted.push(k);
    if (wanted.length >= 50) break;
  }
  if (wanted.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT stage_key FROM coexistence.funnel_stages WHERE stage_key = ANY($1::text[]) AND active = TRUE`,
    [wanted],
  );
  const valid = new Set(rows.map(r => r.stage_key));
  return wanted.filter(k => valid.has(k));
}

// Tag ids (contacts.tags carries string ids like `tag-…`, including the
// managed `tag-funnel-<stage_key>` mirror), deduped and capped.
function sanitizeTagIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const t = String(v || '').trim().slice(0, 100);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

function normalizeMediaGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(g => {
      const tId = parseInt(g?.templateId, 10);
      return {
        description: typeof g?.description === 'string' ? g.description.trim().slice(0, 500) : '',
        mediaIds: Array.isArray(g?.mediaIds)
          ? [...new Set(g.mediaIds.map(n => parseInt(n, 10)).filter(Number.isInteger))]
          : [],
        links: Array.isArray(g?.links)
          ? [...new Set(g.links.map(normalizeUrl).filter(Boolean))].slice(0, 20)
          : [],
        templateId: Number.isInteger(tId) ? tId : null,
        templateName: typeof g?.templateName === 'string' ? g.templateName.slice(0, 200) : null,
        templateLanguage: typeof g?.templateLanguage === 'string' ? g.templateLanguage.slice(0, 20) : null,
      };
    })
    .filter(g => g.description && (g.mediaIds.length > 0 || g.links.length > 0 || g.templateId != null));
}

async function getAiModel(id) {
  if (id == null || id === '') return null;
  const { rows } = await pool.query(
    'SELECT id, provider FROM coexistence.ai_models WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}

async function fetchAgent(id) {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.label AS ai_label
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [id],
  );
  return agentShape(rows[0]);
}

/* ------------------------------ reads -------------------------------- */

async function listAgents() {
  const { rows } = await pool.query(
    `SELECT a.*,
            am.provider AS ai_provider,
            am.label    AS ai_label,
            pr.name     AS project_name,
            (SELECT COUNT(*)::int FROM coexistence.agent_tools t WHERE t.agent_id = a.id) AS tool_count,
            (SELECT MAX(started_at) FROM coexistence.agent_runs r WHERE r.agent_id = a.id) AS last_run_at
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
       LEFT JOIN coexistence.projects  pr ON pr.id = a.project_id
       ORDER BY a.updated_at DESC`,
  );
  return rows.map(r => ({
    ...agentShape(r),
    toolCount: r.tool_count,
    lastRunAt: r.last_run_at,
  }));
}

// Returns { ...agent, tools[] } or null if the agent doesn't exist.
async function getAgent(id) {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.label AS ai_label
       FROM coexistence.agents a
       LEFT JOIN coexistence.ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const { rows: tools } = await pool.query(
    `SELECT * FROM coexistence.agent_tools WHERE agent_id = $1 ORDER BY id`,
    [id],
  );
  return { ...agentShape(rows[0]), tools: tools.map(toolShape) };
}

/* ----------------------------- mutations ----------------------------- */

/**
 * Normalise a usage-limit field for storage. Returns null (= unlimited) for
 * anything that is not a positive number, so an operator clearing the box, or
 * typing 0, both mean "off" rather than "this agent may send zero replies".
 *
 * The caller decides `undefined` (field absent from a PUT -> leave the stored
 * value alone) versus `null` (clear it) — same distinction as a product's
 * default price, and collapsing the two would make every unrelated edit wipe
 * the limits.
 */
function limitIn(v, max) {
  const n = asLimit(v);
  return n === null ? null : Math.min(n, max);
}

/**
 * Test numbers: [{ number, label }].
 *
 * ⚠ `number` is stored DIGITS-ONLY. It is matched on its last 10 digits, so
 * "+91 98765 43210", "9198765 43210" and "9876543210" are the same tester —
 * exactly the rule every other phone join in this codebase uses, and the
 * reason a stored "+" or space would be a silent non-match waiting to happen.
 *
 * A too-short entry is DROPPED rather than rejected: this is a side list on a
 * config form, and 400-ing an otherwise valid save because one row was typed
 * badly would lose the rest of the operator's edit. The UI validates as you
 * type, so a dropped row is visible immediately on reload.
 */
function normalizeTestNumbers(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const src = (item && typeof item === 'object') ? item : { number: item };
    const digits = String(src.number || '').replace(/\D/g, '').slice(0, 20);
    if (digits.length < 7) continue;
    const key = digits.slice(-10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      number: digits,
      label: String(src.label || '').trim().slice(0, 60) || null,
    });
    if (out.length >= 20) break;
  }
  return out;
}

// The rolling-quota window. Unit is validated against the same map the
// conversion uses (agentLimits.WINDOW_UNITS) so the two cannot disagree about
// what a unit is; an unknown one falls back to days rather than 400-ing, since
// the window means nothing until a quota number is set beside it.
function windowUnitIn(v) {
  return WINDOW_UNITS[v] ? v : 'days';
}
function windowValueIn(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 1;
}

// A blank message is a deliberate "send nothing at the cap" and is stored as
// such — there is no hidden fallback that would put words the operator deleted
// back in front of a customer.
function limitMessageIn(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 1000) : null;
}

// Map a Postgres unique-violation (one active agent per WABA) to a 409.
function mapPgError(err) {
  if (err.code === '23505') {
    return new ApiError(409, 'Another agent is already active on this WhatsApp account. Disable it first.');
  }
  return err;
}

// Who may set the funnel trigger. Default DENY: a caller that does not say who
// it is (MCP, a script) does not get to redirect which leads a bot answers.
function canSetFunnelTrigger(opts) {
  return !!(opts && opts.actor && opts.actor.role === 'admin');
}

async function createAgent(b = {}, opts = {}) {
  if (!b.name || !b.systemPrompt) {
    throw new ApiError(400, 'name and systemPrompt are required');
  }
  const status = b.status === 'draft' ? 'draft' : 'active';
  const aiModelId = b.aiModelId || null;
  const llmModel = b.llmModel ? String(b.llmModel).trim() : null;

  if (status === 'active') {
    if (!aiModelId || !llmModel) {
      throw new ApiError(400, 'An active agent needs a connected AI model and a model selection.');
    }
    const model = await getAiModel(aiModelId);
    if (!model) throw new ApiError(400, 'Selected AI model no longer exists.');
    if (!SUPPORTED_PROVIDERS.has(model.provider)) {
      throw new ApiError(400, `Provider '${model.provider}' isn't supported by agents.`);
    }
  } else if (aiModelId) {
    const model = await getAiModel(aiModelId);
    if (!model) throw new ApiError(400, 'Selected AI model no longer exists.');
  }
  const isActive = status === 'active' ? !!b.isActive : false;

  const triggerMode = ['keyword', 'new'].includes(b.triggerMode) ? b.triggerMode : 'any';
  const triggerKeyword = typeof b.triggerKeyword === 'string' ? b.triggerKeyword.trim().slice(0, 200) : '';
  if (status === 'active' && triggerMode === 'keyword' && !triggerKeyword) {
    throw new ApiError(400, 'A keyword-triggered agent needs a keyword.');
  }
  // Deciding WHICH segment of the funnel a bot talks to is an admin decision:
  // it silently changes who gets answered by a machine and who is left for a
  // person. Gated here as well as on the route, so a future non-adminOnly
  // caller (or MCP) cannot set it just because the editor hides the control.
  const triggerStageKeys = canSetFunnelTrigger(opts) ? await sanitizeStageKeys(b.triggerStageKeys) : [];
  const triggerTagIds = canSetFunnelTrigger(opts) ? sanitizeTagIds(b.triggerTagIds) : [];
  const mediaGroups = normalizeMediaGroups(b.mediaGroups);

  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.agents
         (name, description, system_prompt, ai_model_id, llm_model,
          status, wa_account_id, is_active,
          context_window_messages, max_tool_iterations,
          trigger_mode, trigger_keyword, trigger_match_type,
          trigger_case_sensitive, trigger_session_minutes,
          trigger_stage_keys, trigger_tag_ids, media_groups,
          transcribe_audio, accept_images,
          max_replies_per_conversation, max_replies_per_minute, max_runs_per_day,
          limit_reached_message, limit_handoff,
          max_voice_seconds, max_images_per_conversation,
          quota_replies, quota_conversations, quota_window_value, quota_window_unit,
          quota_handoff, test_numbers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
               $28,$29,$30,$31,$32,$33)
       RETURNING id`,
      [
        b.name.trim(), b.description?.trim() || null,
        b.systemPrompt, aiModelId, llmModel,
        status, b.waAccountId || null, isActive,
        Math.max(1, Math.min(100, parseInt(b.contextWindowMessages || 20, 10))),
        Math.max(1, Math.min(20, parseInt(b.maxToolIterations || 6, 10))),
        triggerMode, triggerKeyword || null, cleanMatchType(b.triggerMatchType),
        !!b.triggerCaseSensitive,
        Math.max(1, Math.min(1440, parseInt(b.triggerSessionMinutes || 30, 10))),
        JSON.stringify(triggerStageKeys),
        JSON.stringify(triggerTagIds),
        JSON.stringify(mediaGroups),
        !!b.transcribeAudio,
        !!b.acceptImages,
        limitIn(b.maxRepliesPerConversation, 500),
        limitIn(b.maxRepliesPerMinute, 60),
        limitIn(b.maxRunsPerDay, 100000),
        limitMessageIn(b.limitReachedMessage),
        b.limitHandoff === undefined ? true : !!b.limitHandoff,
        limitIn(b.maxVoiceSeconds, 3600),
        limitIn(b.maxImagesPerConversation, 1000),
        limitIn(b.quotaReplies, 10000),
        limitIn(b.quotaConversations, 10000),
        windowValueIn(b.quotaWindowValue),
        windowUnitIn(b.quotaWindowUnit),
        b.quotaHandoff === true,
        JSON.stringify(normalizeTestNumbers(b.testNumbers)),
      ],
    );
    return await fetchAgent(rows[0].id);
  } catch (err) {
    throw mapPgError(err);
  }
}

async function updateAgent(id, b = {}, opts = {}) {
  const { rows: existing } = await pool.query(
    'SELECT * FROM coexistence.agents WHERE id = $1',
    [id],
  );
  if (existing.length === 0) throw new ApiError(404, 'Not found');

  const cur = existing[0];
  const effStatus    = b.status !== undefined ? (b.status === 'draft' ? 'draft' : 'active') : (cur.status || 'active');
  const effModelId   = b.aiModelId !== undefined ? (b.aiModelId || null) : cur.ai_model_id;
  const effLlmModel  = b.llmModel  !== undefined ? (b.llmModel ? String(b.llmModel).trim() : null) : cur.llm_model;
  let   effIsActive  = b.isActive  !== undefined ? !!b.isActive : cur.is_active;
  if (effStatus === 'draft') effIsActive = false;

  if (effModelId) {
    const model = await getAiModel(effModelId);
    if (!model) throw new ApiError(400, 'Selected AI model no longer exists.');
    if ((effStatus === 'active' || effIsActive) && !SUPPORTED_PROVIDERS.has(model.provider)) {
      throw new ApiError(400, `Provider '${model.provider}' isn't supported by agents.`);
    }
  }
  if ((effStatus === 'active' || effIsActive) && (!effModelId || !effLlmModel)) {
    throw new ApiError(400, 'An active agent needs a connected AI model and a model selection.');
  }

  const effTrigMode = b.triggerMode !== undefined ? (['keyword', 'new'].includes(b.triggerMode) ? b.triggerMode : 'any') : (cur.trigger_mode || 'any');
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
  if (b.waAccountId !== undefined) push('wa_account_id', b.waAccountId || null);
  if (b.isActive !== undefined || b.status !== undefined) push('is_active', effIsActive);
  if (b.contextWindowMessages !== undefined) {
    push('context_window_messages', Math.max(1, Math.min(100, parseInt(b.contextWindowMessages, 10) || 20)));
  }
  if (b.transcribeAudio !== undefined) push('transcribe_audio', !!b.transcribeAudio);
  if (b.acceptImages !== undefined) push('accept_images', !!b.acceptImages);
  if (b.maxToolIterations !== undefined) {
    push('max_tool_iterations', Math.max(1, Math.min(20, parseInt(b.maxToolIterations, 10) || 6)));
  }
  if (b.triggerMode !== undefined) push('trigger_mode', effTrigMode);
  if (b.triggerKeyword !== undefined) push('trigger_keyword', effTrigKeyword || null);
  if (b.triggerMatchType !== undefined) push('trigger_match_type', cleanMatchType(b.triggerMatchType));
  if (b.triggerCaseSensitive !== undefined) push('trigger_case_sensitive', !!b.triggerCaseSensitive);
  if (b.triggerSessionMinutes !== undefined) {
    push('trigger_session_minutes', Math.max(1, Math.min(1440, parseInt(b.triggerSessionMinutes, 10) || 30)));
  }
  // Omitted => left alone. A non-admin save therefore PRESERVES an admin's
  // funnel gating rather than silently clearing it — the editor does not send
  // the field at all for them, and a hostile caller that does send it is
  // refused below rather than obeyed.
  if (b.triggerStageKeys !== undefined || b.triggerTagIds !== undefined) {
    if (!canSetFunnelTrigger(opts)) {
      throw new ApiError(403, 'Only an admin can choose which funnel stages or tags this agent answers.');
    }
    if (b.triggerStageKeys !== undefined) push('trigger_stage_keys', JSON.stringify(await sanitizeStageKeys(b.triggerStageKeys)));
    if (b.triggerTagIds !== undefined) push('trigger_tag_ids', JSON.stringify(sanitizeTagIds(b.triggerTagIds)));
  }
  if (b.mediaGroups !== undefined) push('media_groups', JSON.stringify(normalizeMediaGroups(b.mediaGroups)));
  if (b.maxRepliesPerConversation !== undefined) push('max_replies_per_conversation', limitIn(b.maxRepliesPerConversation, 500));
  if (b.maxRepliesPerMinute !== undefined) push('max_replies_per_minute', limitIn(b.maxRepliesPerMinute, 60));
  if (b.maxRunsPerDay !== undefined) push('max_runs_per_day', limitIn(b.maxRunsPerDay, 100000));
  if (b.limitReachedMessage !== undefined) push('limit_reached_message', limitMessageIn(b.limitReachedMessage));
  if (b.limitHandoff !== undefined) push('limit_handoff', !!b.limitHandoff);
  // Omitted => left alone; explicit null => cleared to unlimited. Collapsing the
  // two would let a rename silently wipe a cap someone set deliberately.
  if (b.maxVoiceSeconds !== undefined) push('max_voice_seconds', limitIn(b.maxVoiceSeconds, 3600));
  if (b.maxImagesPerConversation !== undefined) push('max_images_per_conversation', limitIn(b.maxImagesPerConversation, 1000));
  // Same undefined-vs-null rule for the rolling quota: an unrelated edit that
  // does not send these fields must leave a deliberately-set allowance alone.
  if (b.quotaReplies !== undefined) push('quota_replies', limitIn(b.quotaReplies, 10000));
  if (b.quotaConversations !== undefined) push('quota_conversations', limitIn(b.quotaConversations, 10000));
  if (b.quotaWindowValue !== undefined) push('quota_window_value', windowValueIn(b.quotaWindowValue));
  if (b.quotaWindowUnit !== undefined) push('quota_window_unit', windowUnitIn(b.quotaWindowUnit));
  if (b.quotaHandoff !== undefined) push('quota_handoff', b.quotaHandoff === true);
  if (b.testNumbers !== undefined) push('test_numbers', JSON.stringify(normalizeTestNumbers(b.testNumbers)));

  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      params,
    );
    return await fetchAgent(rows[0].id);
  } catch (err) {
    throw mapPgError(err);
  }
}

async function deleteAgent(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.agents WHERE id = $1',
    [id],
  );
  if (rowCount === 0) throw new ApiError(404, 'Not found');
  return { ok: true };
}

/* --------------------------- export / import ------------------------- */

// Portable agent file: full config + tools, no internal ids (kept only as
// best-effort relink hints). Secrets in tool configs (e.g. HTTP auth headers)
// ARE included so the imported agent works — the file is admin-only.
async function exportAgent(id) {
  const full = await getAgent(id);
  if (!full) throw new ApiError(404, 'Not found');
  return {
    type: 'forgechat.agent',
    version: 1,
    agent: {
      name: full.name,
      description: full.description,
      systemPrompt: full.systemPrompt,
      llmModel: full.llmModel,
      aiProvider: full.aiProvider,       // hint for cross-instance model match
      aiModelLabel: full.aiModelLabel,   // hint
      aiModelId: full.aiModelId,         // same-instance relink
      waAccountId: full.waAccountId,     // same-instance relink
      contextWindowMessages: full.contextWindowMessages,
      maxToolIterations: full.maxToolIterations,
      // Usage limits DO travel with the file — they only ever RESTRAIN the
      // agent, and one arriving with its guard rails intact is strictly safer
      // than one arriving without them.
      maxRepliesPerConversation: full.maxRepliesPerConversation,
      maxRepliesPerMinute: full.maxRepliesPerMinute,
      maxRunsPerDay: full.maxRunsPerDay,
      limitReachedMessage: full.limitReachedMessage,
      limitHandoff: full.limitHandoff,
      quotaReplies: full.quotaReplies,
      quotaConversations: full.quotaConversations,
      quotaWindowValue: full.quotaWindowValue,
      quotaWindowUnit: full.quotaWindowUnit,
      quotaHandoff: full.quotaHandoff,
      // testNumbers are DELIBERATELY not exported. They are real people's phone
      // numbers, and unlike the limits above they GRANT reach rather than
      // restrain it — an imported agent must not arrive already answering
      // somebody on whatever WhatsApp account the receiving instance owns.
      transcribeAudio: full.transcribeAudio,
      acceptImages: full.acceptImages,
      // Same reasoning as the usage limits: these only restrain the agent.
      maxVoiceSeconds: full.maxVoiceSeconds,
      maxImagesPerConversation: full.maxImagesPerConversation,
      triggerMode: full.triggerMode,
      triggerKeyword: full.triggerKeyword,
      triggerMatchType: full.triggerMatchType,
      triggerCaseSensitive: full.triggerCaseSensitive,
      triggerSessionMinutes: full.triggerSessionMinutes,
      mediaGroups: full.mediaGroups,
      // triggerStageKeys / triggerTagIds are DELIBERATELY not exported. A stage
      // key is only meaningful against the funnel that defined it, so importing
      // one either matches a DIFFERENT stage on the receiving instance or
      // matches nothing — and "matches nothing" would silently gate the agent
      // to zero conversations while looking configured. Set it here on purpose.
    },
    tools: (full.tools || []).map(t => ({ toolType: t.toolType, config: t.config, isEnabled: t.isEnabled })),
  };
}

// Resolve an exported model reference to a local ai_models id: exact id first,
// then provider+label, then provider alone. Returns null when nothing matches.
async function resolveModelId({ aiModelId, aiProvider, aiModelLabel }) {
  if (aiModelId) {
    const m = await getAiModel(aiModelId);
    if (m) return aiModelId;
  }
  if (aiProvider) {
    const { rows } = await pool.query(
      `SELECT id FROM coexistence.ai_models
        WHERE provider = $1 AND ($2::text IS NULL OR label = $2)
        ORDER BY id LIMIT 1`,
      [aiProvider, aiModelLabel || null],
    );
    if (rows[0]) return rows[0].id;
    const { rows: any } = await pool.query(
      `SELECT id FROM coexistence.ai_models WHERE provider = $1 ORDER BY id LIMIT 1`,
      [aiProvider],
    );
    if (any[0]) return any[0].id;
  }
  return null;
}

// Create a NEW agent from an export file. Always lands as a draft (never
// auto-activates), relinks model/number when they resolve here, and re-adds
// every tool. Returns { agent, warnings }.
async function importAgent(payload = {}) {
  if (!payload || payload.type !== 'forgechat.agent' || !payload.agent) {
    throw new ApiError(400, 'That file is not a ForgeChat agent export.');
  }
  const a = payload.agent;
  if (!a.name || !a.systemPrompt) {
    throw new ApiError(400, 'The export file is missing required agent fields (name / system prompt).');
  }

  const aiModelId = await resolveModelId(a);
  const llmModel = aiModelId ? (a.llmModel || null) : null;

  let waAccountId = null;
  if (a.waAccountId) {
    const { rows } = await pool.query('SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1', [a.waAccountId]);
    if (rows[0]) waAccountId = a.waAccountId;
  }

  const created = await createAgent({
    name: `${a.name} (imported)`.slice(0, 200),
    description: a.description || null,
    systemPrompt: a.systemPrompt,
    aiModelId,
    llmModel,
    waAccountId,
    status: 'draft',         // always import as a draft; user reviews + activates
    isActive: false,
    contextWindowMessages: a.contextWindowMessages,
    maxToolIterations: a.maxToolIterations,
    maxRepliesPerConversation: a.maxRepliesPerConversation,
    maxRepliesPerMinute: a.maxRepliesPerMinute,
    maxRunsPerDay: a.maxRunsPerDay,
    limitReachedMessage: a.limitReachedMessage,
    limitHandoff: a.limitHandoff,
    transcribeAudio: a.transcribeAudio,
    acceptImages: a.acceptImages,
    maxVoiceSeconds: a.maxVoiceSeconds,
    maxImagesPerConversation: a.maxImagesPerConversation,
    triggerMode: a.triggerMode,
    triggerKeyword: a.triggerKeyword,
    triggerMatchType: a.triggerMatchType,
    triggerCaseSensitive: a.triggerCaseSensitive,
    triggerSessionMinutes: a.triggerSessionMinutes,
    mediaGroups: a.mediaGroups,
  });

  const warnings = [];
  if (a.aiModelId && !aiModelId) warnings.push('The AI model from the file was not found here — pick a model before going live.');
  if (a.waAccountId && !waAccountId) warnings.push('The WhatsApp number from the file was not found here — pick a number before going live.');

  for (const t of (Array.isArray(payload.tools) ? payload.tools : [])) {
    try {
      await addTool(created.id, { toolType: t.toolType, config: t.config, isEnabled: t.isEnabled });
    } catch (e) {
      warnings.push(`Skipped a ${t.toolType || 'tool'}: ${e.message}`);
    }
  }

  const full = await getAgent(created.id);
  return { agent: full, warnings };
}

/* ------------------------------ tools -------------------------------- */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PARAM_LOCATIONS = new Set(['path', 'query', 'body', 'header']);
const PARAM_TYPES = new Set(['string', 'number', 'boolean']);

// Validate + normalise an http_request tool config. Returns the cleaned config.
// The admin owns method/url/static headers; the agent's LLM only fills the
// declared params at call time (see agentEngine http_request executor).
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
    ? cfg.headers
        .map(h => ({ k: String(h?.k || '').trim(), v: String(h?.v ?? '').trim() }))
        .filter(h => h.k)
        .slice(0, 30)
    : [];

  const seen = new Set();
  const params = Array.isArray(cfg.params)
    ? cfg.params.map((p, idx) => {
        const name = String(p?.name || '').trim();
        if (!name) throw new ApiError(400, `Parameter #${idx + 1} needs a name.`);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new ApiError(400, `Parameter "${name}" must be a simple identifier (letters, numbers, underscore; no leading digit).`);
        }
        if (seen.has(name)) throw new ApiError(400, `Duplicate parameter name "${name}".`);
        seen.add(name);
        const loc = PARAM_LOCATIONS.has(p?.in) ? p.in : 'body';
        const type = PARAM_TYPES.has(p?.type) ? p.type : 'string';
        return {
          name,
          in: loc,
          type,
          description: String(p?.description || '').trim().slice(0, 500),
          required: !!p?.required,
        };
      }).slice(0, 30)
    : [];

  // Every {placeholder} in the URL must be backed by a path param.
  const placeholders = [...url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(m => m[1]);
  for (const ph of placeholders) {
    const p = params.find(x => x.name === ph);
    if (!p) throw new ApiError(400, `URL placeholder {${ph}} has no matching parameter — add a "path" parameter named "${ph}".`);
    if (p.in !== 'path') throw new ApiError(400, `Parameter "${ph}" is used in the URL path, so its location must be "path".`);
  }

  const timeoutMs = Math.max(1000, Math.min(30000, parseInt(cfg.timeout_ms || 10000, 10) || 10000));

  return { label: label.slice(0, 120), description: description.slice(0, 1000), method, url, headers, params, timeout_ms: timeoutMs };
}

/**
 * Validate + normalise a `lead_form` tool config.
 *
 * Stores ONLY the form id as the live reference, plus a name/slug SNAPSHOT for
 * the tool row's label. The snapshot is display-only and deliberately never
 * read at run time — buildFormTools re-reads the form on every run, so renaming
 * a form, editing its questions or unpublishing it takes effect immediately
 * instead of leaving the agent asking last month's questions.
 *
 * `published` is NOT required here: attaching the tool while the form is still a
 * draft is a reasonable order of work. The engine refuses to build a tool for an
 * unpublished form (and says why), and the picker flags it.
 */
async function validateLeadFormConfig(config) {
  const formId = parseInt(config?.form_id, 10);
  if (!Number.isFinite(formId)) throw new ApiError(400, 'Pick a form for the agent to fill.');
  const { rows } = await pool.query(
    'SELECT id, name, slug, status, fields FROM coexistence.lead_forms WHERE id = $1',
    [formId],
  );
  const form = rows[0];
  if (!form) throw new ApiError(400, 'That form no longer exists.');
  // A form of nothing but section headings has no questions to ask, so the tool
  // would be built and then never be usable. Refuse it here, where the operator
  // can see the message, rather than logging it at run time.
  const askable = (Array.isArray(form.fields) ? form.fields : []).filter(f => f && f.type !== 'section' && f.mapsTo !== 'phone');
  if (askable.length === 0) {
    throw new ApiError(400, `"${form.name}" has no questions the agent could ask. Add at least one field that is not a section heading, then try again.`);
  }
  return { form_id: form.id, form_name: form.name, form_slug: form.slug };
}

// Validate a tool body by type; returns the cleaned config to persist.
// Async because some types (lead_form) validate against the database.
async function validateToolConfig(toolType, config) {
  if (toolType === 'google_sheets') {
    const cfg = config;
    if (!cfg.spreadsheet_id || !cfg.sheet_name) {
      throw new ApiError(400, 'Pick a spreadsheet and a tab for the Sheets tool.');
    }
    if (!Array.isArray(cfg.ops) || cfg.ops.length === 0) {
      throw new ApiError(400, 'Enable at least one operation (read / append / update).');
    }
    return cfg;
  }
  if (toolType === 'http_request') {
    return validateHttpConfig(config);
  }
  if (toolType === 'lead_form') {
    return await validateLeadFormConfig(config);
  }
  return config;
}

async function addTool(agentId, b = {}) {
  if (!b.toolType || !b.config) {
    throw new ApiError(400, 'toolType and config are required');
  }
  const cleanConfig = await validateToolConfig(b.toolType, b.config);
  const { rows } = await pool.query(
    `INSERT INTO coexistence.agent_tools (agent_id, tool_type, config, is_enabled)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [agentId, b.toolType, JSON.stringify(cleanConfig), b.isEnabled !== false],
  );
  return toolShape(rows[0]);
}

async function updateTool(agentId, toolId, b = {}) {
  const sets = [];
  const params = [];
  let i = 1;
  if (b.config !== undefined) {
    // Re-validate against the existing tool's type so an edit can't store junk.
    const { rows: cur } = await pool.query(
      'SELECT tool_type FROM coexistence.agent_tools WHERE agent_id = $1 AND id = $2',
      [agentId, toolId],
    );
    if (cur.length === 0) throw new ApiError(404, 'Not found');
    const cleanConfig = await validateToolConfig(cur[0].tool_type, b.config);
    sets.push(`config = $${i++}`); params.push(JSON.stringify(cleanConfig));
  }
  if (b.isEnabled !== undefined) { sets.push(`is_enabled = $${i++}`); params.push(!!b.isEnabled); }
  if (sets.length === 0) throw new ApiError(400, 'No updatable fields provided');
  params.push(agentId, toolId);
  const { rows } = await pool.query(
    `UPDATE coexistence.agent_tools SET ${sets.join(', ')}
      WHERE agent_id = $${i++} AND id = $${i} RETURNING *`,
    params,
  );
  if (rows.length === 0) throw new ApiError(404, 'Not found');
  return toolShape(rows[0]);
}

async function deleteTool(agentId, toolId) {
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.agent_tools WHERE agent_id = $1 AND id = $2',
    [agentId, toolId],
  );
  if (rowCount === 0) throw new ApiError(404, 'Not found');
  return { ok: true };
}

/**
 * Boot self-heal for migrations 102, 104 and 108. Purely ADDITIVE — every statement is
 * add-if-missing — so mirroring it with create-if-missing is correct here.
 * (Anti-pattern #41 only bites when an ensure-function mirrors a RENAME: it
 * would build an empty new table beside the populated old one.)
 *
 * The unique index is created without the migration's duplicate check: on an
 * instance that already has duplicate runs this simply throws, is caught by the
 * caller in index.js, and the backend boots without the guard rather than
 * refusing to start. The migration is where an operator gets the actionable
 * error message.
 */
async function ensureAgentTables() {
  await pool.query(`
    ALTER TABLE coexistence.agents
      ADD COLUMN IF NOT EXISTS max_replies_per_conversation INT,
      ADD COLUMN IF NOT EXISTS max_replies_per_minute       INT,
      ADD COLUMN IF NOT EXISTS max_runs_per_day             INT,
      ADD COLUMN IF NOT EXISTS limit_reached_message        TEXT,
      ADD COLUMN IF NOT EXISTS limit_handoff                BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS max_voice_seconds            INT,
      ADD COLUMN IF NOT EXISTS max_images_per_conversation  INT,
      ADD COLUMN IF NOT EXISTS trigger_stage_keys           JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS trigger_tag_ids              JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS test_numbers                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS quota_replies                INT,
      ADD COLUMN IF NOT EXISTS quota_conversations          INT,
      ADD COLUMN IF NOT EXISTS quota_window_value           INT  NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS quota_window_unit            TEXT NOT NULL DEFAULT 'days',
      ADD COLUMN IF NOT EXISTS quota_handoff                BOOLEAN NOT NULL DEFAULT FALSE;`);

  // Migration 108. The unit is validated in app code as well, so this is the
  // backstop against a raw SQL or MCP write, not the only guard.
  await pool.query(`ALTER TABLE coexistence.agents DROP CONSTRAINT IF EXISTS agents_quota_window_unit_check;`);
  await pool.query(`
    ALTER TABLE coexistence.agents ADD CONSTRAINT agents_quota_window_unit_check
      CHECK (quota_window_unit IN ('minutes','hours','days'));`);

  // A test run must be invisible to every usage count and distinguishable in
  // the run history.
  await pool.query(`
    ALTER TABLE coexistence.agent_runs
      ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_contact_started
      ON coexistence.agent_runs (agent_id, contact_number, started_at DESC);`);

  // 'limited' marks a message the agent declined to answer because of a limit.
  await pool.query(`ALTER TABLE coexistence.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;`);
  await pool.query(`
    ALTER TABLE coexistence.agent_runs ADD CONSTRAINT agent_runs_status_check
      CHECK (status IN ('running','completed','failed','capped','limited'));`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_inbound
      ON coexistence.agent_runs (agent_id, inbound_message_id)
      WHERE inbound_message_id IS NOT NULL;`);
}

module.exports = {
  ApiError,
  ensureAgentTables,
  agentShape,
  toolShape,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  addTool,
  updateTool,
  deleteTool,
  exportAgent,
  importAgent,
  // Exported so the amount-authority rules can be asserted directly. They are
  // the guard between an LLM and a live payment gateway; a rule that is only
  // reachable through a route is a rule nobody tests.
  // Same reasoning: these decide whether a typed 0 silences an agent.
  limitIn,
  limitMessageIn,
  // Same reasoning again: a test number that normalises wrongly silently never
  // matches, and a window unit that normalises wrongly silently applies a
  // different window from the one on screen.
  normalizeTestNumbers,
  windowValueIn,
  windowUnitIn,
};
