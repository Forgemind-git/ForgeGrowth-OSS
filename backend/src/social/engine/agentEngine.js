// Agent engine for ForgeSocial: builds the LLM tool-set for an agent, runs the
// tool-use loop, and persists a full trace to agent_runs + agent_run_steps.
//
// Channel-agnostic: the dispatcher (services/agentDispatch.js) builds the
// message history for a DM/comment and decides when/how to SEND the reply
// (with human-like jitter). This module only runs the model + tools and returns
// the final text. Domain tools are ForgeSocial's MCP surface, gated per-agent
// by capability flags; HTTP + Google Sheets come from agent_tools.

const pool = require('../db');
const { decrypt } = require('../util/crypto');
const llm = require('../llm');
const sheets = require('./../services/sheetsAgentOps');
const mcp = require('../mcpService');
const notify = require('../notificationService');

// Sentinel thrown by request_human_handoff to cleanly exit the tool-use loop.
// Caught specifically in runLoop so it's never treated as an actual error.
class HandoffSignal extends Error {
  constructor(reason, ctx) { super(reason); this.name = 'HandoffSignal'; this.ctx = ctx; }
}

/* -------------------------- agent loading ---------------------------- */

// Load an agent joined with its AI model (provider + decrypted key + base url).
async function loadRunnableAgent(agentId) {
  const { rows } = await pool.query(
    `SELECT a.*, am.provider AS ai_provider, am.base_url AS ai_base_url,
            am.api_key_encrypted AS ai_api_key_encrypted
       FROM agents a LEFT JOIN ai_models am ON am.id = a.ai_model_id
      WHERE a.id = $1`,
    [agentId],
  );
  const agent = rows[0];
  if (!agent) throw new Error(`Agent id=${agentId} not found`);
  // No AI Models row → the agent runs on Social's OpenRouter key (Settings →
  // OpenRouter), the same key the Flow Builder's AI step and the Comment
  // Analyzer use. That is the only AI connection a ForgeGrowth Social has, so a
  // Quick Instagram AI agent stores just the OpenRouter model id in llm_model.
  if (!agent.ai_model_id) {
    if (!agent.llm_model) throw new Error('This agent has no model selected.');
    const apiKey = await require('../services/openRouter').getKey();
    if (!apiKey) throw new Error('OpenRouter is not connected. Connect it under Settings → OpenRouter.');
    return { agent, provider: 'openrouter', apiKey, baseUrl: null };
  }
  if (!agent.ai_provider) throw new Error('This agent has no AI model connected. Connect one under Settings → AI Models.');
  if (!agent.llm_model) throw new Error('This agent has no model selected.');
  if (!llm.isRunnable(agent.ai_provider)) throw new Error(`Provider '${agent.ai_provider}' is not runnable.`);
  const apiKey = pickApiKey(agent);
  if (!apiKey) throw new Error(`No API key for provider '${agent.ai_provider}'. Add it under Settings → AI Models.`);
  return { agent, provider: agent.ai_provider, apiKey, baseUrl: agent.ai_base_url || null };
}

function pickApiKey(agent) {
  const fromRegistry = decrypt(agent.ai_api_key_encrypted);
  if (fromRegistry) return fromRegistry;
  // No env-key fallback: AI credentials come from the database only (OpenRouter since 2026-10-11).
  return '';
}

/* ----------------------------- tools --------------------------------- */

// ForgeSocial domain tools, grouped by the capability flag that unlocks them.
// `write` tools only attach on a LIVE run (not the test panel) to avoid posting
// to real platforms while previewing.
const DOMAIN_TOOLS = [
  { cap: 'analytics', name: 'get_overview', description: 'Cross-platform overview KPIs (followers, growth, impressions, engagement rate) for a period.', input_schema: { type: 'object', properties: { period: { type: 'string', description: '7D | 30D | 90D (default 30D)' } } }, run: (a) => mcp.getOverview(a.period) },
  { cap: 'analytics', name: 'get_platform_stats', description: 'Stats snapshot for one platform.', input_schema: { type: 'object', properties: { platform: { type: 'string' }, period: { type: 'string' }, account: { type: 'string' } }, required: ['platform'] }, run: (a) => mcp.getPlatformStats(a.platform, a.period, a.account) },
  { cap: 'analytics', name: 'get_followers_trend', description: 'Followers time-series for a platform (unit: hours|days|weeks).', input_schema: { type: 'object', properties: { platform: { type: 'string' }, unit: { type: 'string' }, range: { type: 'integer' }, account: { type: 'string' } }, required: ['platform'] }, run: (a) => mcp.getFollowersTrend(a.platform, a.unit, a.range, a.account) },
  { cap: 'analytics', name: 'get_audience_insights', description: 'Audience demographics (age/gender/country/online hours) for a platform.', input_schema: { type: 'object', properties: { platform: { type: 'string' } } }, run: (a) => mcp.getAudienceInsights(a.platform) },
  { cap: 'content', name: 'list_posts', description: 'Search the content library — recent posts with metrics + scores.', input_schema: { type: 'object', properties: { platform: { type: 'string' }, q: { type: 'string' }, days: { type: 'integer' }, sortBy: { type: 'string' }, limit: { type: 'integer' } } }, run: (a) => mcp.listPosts(a) },
  { cap: 'content', name: 'list_media', description: 'List uploaded media-library assets.', input_schema: { type: 'object', properties: { limit: { type: 'integer' } } }, run: (a) => mcp.listMedia(a) },
  { cap: 'inbox', name: 'list_messages', description: 'Search recent Instagram DMs in the current conversation. Conversation history is already in your context — only call this to look up specific earlier messages by keyword (use q). Peer and account are automatically scoped to the current contact; do not pass them.', input_schema: { type: 'object', properties: { q: { type: 'string', description: 'Keyword to search message text' }, limit: { type: 'integer' } } }, run: (a, ctx) => mcp.listMessages({ ...a, ...(ctx && ctx.accountId ? { account: ctx.accountId } : {}), ...(ctx && ctx.peerId ? { peer: ctx.peerId } : {}) }) },
  { cap: 'inbox', name: 'list_comments', description: 'List recent Instagram comments.', input_schema: { type: 'object', properties: { platform: { type: 'string' }, account: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } }, run: (a) => mcp.listComments(a) },
  { cap: 'contacts', name: 'list_contacts', description: 'Search CRM contacts built from DM history.', input_schema: { type: 'object', properties: { q: { type: 'string' }, account: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'integer' } } }, run: (a) => mcp.listContacts(a) },
  { cap: 'contacts', name: 'list_tags', description: 'List the tag + category taxonomy.', input_schema: { type: 'object', properties: {} }, run: () => mcp.listTags() },
  // writes
  { cap: 'engage', write: true, name: 'reply_to_comment', description: 'Reply to an Instagram comment (platform: instagram). Posts on the REAL platform.', input_schema: { type: 'object', properties: { platform: { type: 'string' }, commentId: { type: 'string' }, message: { type: 'string' }, accountId: { type: 'string' } }, required: ['platform', 'commentId', 'message'] }, run: (a) => mcp.replyToComment(a) },
  { cap: 'engage', write: true, name: 'send_instagram_dm', description: 'Send an Instagram DM. accountId is the connected IG account; recipientId is the peer IGSID. Sends on the REAL platform.', input_schema: { type: 'object', properties: { accountId: { type: 'string' }, recipientId: { type: 'string' }, text: { type: 'string' } }, required: ['accountId', 'recipientId', 'text'] }, run: (a) => mcp.sendInstagramDm(a) },
  // contacts write: tag the current DM contact
  { cap: 'contacts', write: true, name: 'tag_contact', description: 'Apply one or more tags to the current contact (the person you are replying to in this DM). Only works during DM conversations.', input_schema: { type: 'object', properties: { tagIds: { type: 'array', items: { type: 'string' }, description: 'Array of tag IDs to apply. These IDs come from the Auto-tagging rules in your system prompt.' } }, required: ['tagIds'] }, run: async (args, ctx) => {
    if (!ctx || ctx.mode !== 'dm' || !ctx.peerId) return { ok: false, error: 'tag_contact only works in DM conversations.' };
    const { rows } = await pool.query(
      `SELECT id, tags FROM contacts WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2 LIMIT 1`,
      [ctx.accountId, ctx.peerId],
    );
    if (!rows[0]) return { ok: false, error: 'Contact not found for this peer.' };
    const existing = Array.isArray(rows[0].tags) ? rows[0].tags : [];
    const merged = [...new Set([...existing, ...(args.tagIds || [])])];
    await pool.query(`UPDATE contacts SET tags = $1 WHERE id = $2`, [JSON.stringify(merged), rows[0].id]);
    return { ok: true, tagIds: merged };
  } },
];

function slugForTool(label) {
  const s = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'call';
}

// Build { tools, executors } for one agent. ctx.live gates write tools.
async function buildToolsForAgent(agent, ctx = {}) {
  const tools = [];
  const executors = {};
  const caps = (agent.capabilities && typeof agent.capabilities === 'object') ? agent.capabilities : {};

  for (const def of DOMAIN_TOOLS) {
    if (!caps[def.cap]) continue;
    if (def.write && !ctx.live) continue; // never fire real writes in the test panel
    tools.push({ name: def.name, description: def.description, input_schema: def.input_schema });
    executors[def.name] = async (args) => {
      try { return await def.run(args || {}, ctx); }
      catch (err) { return { ok: false, error: err.message || 'tool failed' }; }
    };
  }

  // Handoff tool: only attached when the agent has enable_handoff=true. Throws
  // HandoffSignal (caught in runLoop) to exit the loop and fire the notification.
  if (agent.enable_handoff) {
    const handoffName = 'request_human_handoff';
    tools.push({
      name: handoffName,
      description: 'Call this when the conversation needs a human team member to take over. Provide a clear reason. The agent will stop replying and notify the team immediately.',
      input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Brief explanation of why human intervention is needed.' } }, required: ['reason'] },
    });
    executors[handoffName] = async (args) => {
      // Fire the notification — the throw exits the LLM loop cleanly.
      const reason = String(args?.reason || 'Needs human attention').slice(0, 300);
      await notify.emit('handoff', {
        title: `Handoff needed${ctx.platform ? ` · ${ctx.platform}` : ''}`,
        body: reason,
        link: '#/social/inbox',
        severity: 'warn',
        platform: ctx.platform || agent.platform || null,
        accountKey: ctx.accountId || agent.account_id || null,
        dedupeKey: null, // never deduped — each handoff is distinct
        meta: { kind: 'dm', platform: ctx.platform || agent.platform, accountId: ctx.accountId || agent.account_id, peerId: ctx.peerId || null },
      }).catch(e => console.error('[agentEngine] handoff notify failed:', e.message));
      throw new HandoffSignal(reason, ctx);
    };
  }

  // HTTP + Google Sheets tools from agent_tools
  const { rows } = await pool.query('SELECT * FROM agent_tools WHERE agent_id = $1 AND is_enabled = TRUE ORDER BY id', [agent.id]);
  for (const row of rows) {
    if (row.tool_type === 'google_sheets') {
      const cfg = row.config || {};
      const ops = Array.isArray(cfg.ops) ? cfg.ops : [];
      const baseDesc = `Google Sheet "${cfg.spreadsheet_name || cfg.spreadsheet_id}" tab "${cfg.sheet_name}"`;
      if (ops.includes('read')) {
        const name = `google_sheets_read_${row.id}`;
        tools.push({ name, description: `Read rows from ${baseDesc}. Use to look up information.`, input_schema: { type: 'object', properties: { range: { type: 'string', description: "Optional A1 range, e.g. 'A2:E50'. Omit for the whole sheet." }, max_rows: { type: 'integer', description: 'Default 100, max 500.' } } } });
        executors[name] = (args) => sheets.executeOp({ op: 'read', toolConfig: cfg, args });
      }
      if (ops.includes('append')) {
        const name = `google_sheets_append_${row.id}`;
        tools.push({ name, description: `Append a new row to ${baseDesc}. Use to save information the user provided.`, input_schema: { type: 'object', properties: { values: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Cell values left-to-right.' } }, required: ['values'] } });
        executors[name] = (args) => sheets.executeOp({ op: 'append', toolConfig: cfg, args });
      }
      if (ops.includes('update')) {
        const name = `google_sheets_update_${row.id}`;
        tools.push({ name, description: `Update a specific range in ${baseDesc} (read first to find the row).`, input_schema: { type: 'object', properties: { range: { type: 'string' }, values: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } }, required: ['range', 'values'] } });
        executors[name] = (args) => sheets.executeOp({ op: 'update', toolConfig: cfg, args });
      }
      if (ops.includes('upsert')) {
        const name = `google_sheets_upsert_${row.id}`;
        tools.push({ name, description: `Find-or-update one row in ${baseDesc} by a key column. PREFER this for logging a contact's enquiry/lead so they never get duplicate rows. Give the key column header + the contact's value, plus fields keyed by their EXACT column headers.`, input_schema: { type: 'object', properties: { key_column: { type: 'string' }, key_value: { type: ['string', 'number'] }, fields: { type: 'object' } }, required: ['key_column', 'key_value', 'fields'] } });
        executors[name] = (args) => sheets.executeOp({ op: 'upsert', toolConfig: cfg, args });
      }
    }
    if (row.tool_type === 'http_request') {
      const cfg = row.config || {};
      const params = Array.isArray(cfg.params) ? cfg.params : [];
      const name = `http_${slugForTool(cfg.label)}_${row.id}`;
      const properties = {};
      const required = [];
      for (const p of params) {
        properties[p.name] = { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string', description: p.description || `The ${p.name} value.` };
        if (p.required) required.push(p.name);
      }
      tools.push({ name, description: `${cfg.description}\n(Performs an HTTP ${cfg.method} request to an external system.)`, input_schema: { type: 'object', properties, required } });
      executors[name] = (args) => executeHttpTool(cfg, args || {});
    }
  }

  return { tools, executors };
}

// Execute a configured http_request tool (admin owns method/url/headers; the
// LLM supplies declared params). Never throws — errors come back as { ok:false }.
async function executeHttpTool(cfg, args) {
  try {
    const method = String(cfg.method || 'GET').toUpperCase();
    const params = Array.isArray(cfg.params) ? cfg.params : [];
    let url = String(cfg.url || '');
    const query = new URLSearchParams();
    const bodyObj = {};
    const dynHeaders = {};
    let hasBody = false;
    for (const p of params) {
      let val = args[p.name];
      if (val === undefined || val === null || val === '') { if (p.required) return { ok: false, error: `Missing required parameter "${p.name}".` }; continue; }
      if (p.type === 'number') { const n = Number(val); if (!Number.isNaN(n)) val = n; }
      else if (p.type === 'boolean') { val = val === true || val === 'true' || val === 1 || val === '1'; }
      if (p.in === 'path') url = url.replace(new RegExp(`\\{${p.name}\\}`, 'g'), encodeURIComponent(String(val)));
      else if (p.in === 'query') query.append(p.name, String(val));
      else if (p.in === 'header') dynHeaders[p.name] = String(val);
      else { bodyObj[p.name] = val; hasBody = true; }
    }
    const qs = query.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    const headers = {};
    for (const h of (Array.isArray(cfg.headers) ? cfg.headers : [])) if (h && h.k) headers[h.k] = h.v;
    Object.assign(headers, dynHeaders);
    const init = { method, headers };
    if (method !== 'GET' && method !== 'DELETE' && hasBody) {
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(bodyObj);
    }
    const ctrl = new AbortController();
    const timeout = Math.max(1000, Math.min(30000, parseInt(cfg.timeout_ms || 10000, 10) || 10000));
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try { res = await fetch(url, { ...init, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    const raw = await res.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = raw.length > 4000 ? raw.slice(0, 4000) + '…[truncated]' : raw; }
    if (typeof body !== 'string') { const asStr = JSON.stringify(body); if (asStr.length > 4000) body = asStr.slice(0, 4000) + '…[truncated]'; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'Request timed out.' };
    return { ok: false, error: err.message || 'HTTP request failed.' };
  }
}

/* ----------------------- system prompt context ----------------------- */

function withContext(systemPrompt, agent, ctx = {}) {
  const base = systemPrompt || '';
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  let s = `${base}\n\n## Current date & time\n- Today is ${today} at ${time} (Asia/Kolkata, IST).`;

  if (ctx.mode === 'dm' || ctx.mode === 'comment') {
    s += `\n\n## Conversation context\n- Channel: ${ctx.mode === 'dm' ? 'Instagram Direct Message' : (ctx.platform || 'social') + ' comment'}.`;
    if (ctx.contactName) s += `\n- You are talking to ${ctx.contactName}.`;
    s += ctx.isReturning
      ? `\n- This is a RETURNING contact you've spoken with before — greet them naturally, do not repeat a canned introduction.`
      : `\n- This appears to be a NEW contact — be welcoming, but still natural and specific to what they said.`;
  }

  // Professional tone: no emojis (strong standing preference — emojis read as
  // botty/unprofessional in a business chat). Applies to test + live replies;
  // live replies are additionally emoji-stripped in agentDispatch as a backstop.
  s += `\n\n## Tone\n- Write in plain, professional text. Do NOT use emojis, emoticons or decorative symbols anywhere in your reply.`;

  if (agent.humanize !== false) {
    // Anti-spam / human-like guidance. This complements the platform rules
    // (official APIs, rate limits, Meta's 24h window) — never circumvents them.
    s += `\n\n## Sound human (important)\n- Write a fresh, natural reply every time — never send the same wording twice, even for similar questions. Vary your greeting, phrasing and length so replies don't look automated.\n- Keep it concise and conversational, like a real person typing. Match the person's tone and language.\n- Only answer what's relevant. Don't add boilerplate disclaimers or repeat your name each message.`;
  }

  // Human handoff: inject escalation criteria so the LLM knows when to call
  // request_human_handoff. Keep instructions verbatim from agent config.
  if (agent.enable_handoff) {
    const instr = String(agent.handoff_instructions || '').trim();
    s += `\n\n## Human handoff\nIf this conversation needs a human team member, call the \`request_human_handoff\` tool with a brief reason. Once you call it, do NOT send any further reply — the team will take over.`;
    if (instr) s += `\nEscalation criteria: ${instr}`;
  }

  // Auto-tagging: list configured rules so the LLM can call tag_contact at the
  // right moment. tag IDs are the stable slugs written into contacts.tags.
  const autoTags = Array.isArray(agent.auto_tags) ? agent.auto_tags : [];
  if (autoTags.length > 0 && ctx.mode === 'dm') {
    s += `\n\n## Auto-tagging rules\nYou may call \`tag_contact\` to tag this contact. Apply tags at any point when the criteria below are met:\n`;
    for (const t of autoTags) {
      if (t.tagId && t.applyWhen) s += `- "${t.tagName || t.tagId}" (id: "${t.tagId}"): ${t.applyWhen}\n`;
    }
  }

  return s;
}

/* ------------------------------- runs -------------------------------- */

async function recordStep(runId, stepIndex, step) {
  await pool.query(
    `INSERT INTO agent_run_steps (run_id, step_index, step_type, tool_type, input, output, status, latency_ms, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      runId, stepIndex, step.step_type, step.tool_type || null,
      step.input ? JSON.stringify(step.input) : null,
      step.output != null ? JSON.stringify(step.output) : null,
      step.status, step.latency_ms || null,
      step.error_message ? String(step.error_message).slice(0, 1000) : null,
    ],
  );
}

/**
 * Run the LLM tool-use loop for an agent over a prepared message history.
 * Opens an agent_runs row (when persist), records steps, returns
 * { runId, status, finalText, totalInputTokens, totalOutputTokens, iterations }.
 * Sending the reply is the caller's job (the dispatcher adds the human delay).
 */
async function runLoop({ loaded, messages, ctx = {}, persist = true }) {
  const { agent, provider, apiKey, baseUrl } = loaded;
  const { tools, executors } = await buildToolsForAgent(agent, ctx);

  let runId = null;
  if (persist) {
    const { rows } = await pool.query(
      `INSERT INTO agent_runs (agent_id, platform, channel, account_id, peer_id, inbound_ref, trigger_label, status, model_name, provider_name, has_image, has_audio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11) RETURNING id`,
      [agent.id, ctx.platform || agent.platform || null, ctx.mode || 'manual',
       ctx.accountId || agent.account_id || null, ctx.peerId || null, ctx.inboundRef || null, ctx.trigger || null,
       agent.llm_model || null, provider || null,
       ctx.hasImage === true, ctx.hasAudio === true],
    );
    runId = rows[0].id;
  }

  let stepCounter = 0;
  const steps = [];
  const onStep = async (step) => {
    stepCounter += 1;
    if (persist) { try { await recordStep(runId, stepCounter, step); } catch (e) { console.error('[agentEngine] step persist failed:', e.message); } }
    else steps.push({ stepIndex: stepCounter, stepType: step.step_type, toolType: step.tool_type || null, input: step.input, output: step.output, status: step.status, latencyMs: step.latency_ms || null, errorMessage: step.error_message || null });
  };

  try {
    const result = await llm.runWithTools({
      provider, apiKey, baseUrl,
      model: agent.llm_model,
      systemPrompt: withContext(agent.system_prompt, agent, ctx),
      messages,
      tools,
      onToolCall: async ({ name, args }) => {
        const exec = executors[name];
        if (!exec) throw new Error(`Unknown tool '${name}'`);
        return await exec(args);
      },
      onStep,
      maxIterations: Math.max(1, Math.min(20, agent.max_tool_iterations || 6)),
    });
    const status = result.capped ? 'capped' : 'completed';
    // OpenRouter spend shows on Settings → OpenRouter like every other feature
    // that calls it. Best effort: a logging failure must never fail the reply.
    if (provider === 'openrouter') {
      try {
        const openRouter = require('../services/openRouter');
        const cost = await openRouter.costOf(agent.llm_model, result.totalInputTokens, result.totalOutputTokens);
        await openRouter.logUsage({ feature: ctx.mode === 'test' ? 'ig_agent_test' : 'ig_agent', model: agent.llm_model, usage: { input_tokens: result.totalInputTokens, output_tokens: result.totalOutputTokens, cost } });
      } catch (e) { console.error('[agentEngine] usage log failed:', e.message); }
    }
    if (persist) {
      await pool.query(
        `UPDATE agent_runs SET status=$1, total_input_tokens=$2, total_output_tokens=$3, final_reply=$4, ended_at=NOW() WHERE id=$5`,
        [status, result.totalInputTokens, result.totalOutputTokens, result.finalText || null, runId],
      );
    }
    return { runId, status, finalText: result.finalText || '', totalInputTokens: result.totalInputTokens, totalOutputTokens: result.totalOutputTokens, iterations: result.iterations, steps };
  } catch (err) {
    // HandoffSignal is a controlled early-exit: mark the run 'handoff' and return
    // empty finalText so the dispatcher knows NOT to send a reply. This is not an
    // error — the notification was already fired inside the tool executor.
    if (err instanceof HandoffSignal) {
      if (persist && runId) {
        await pool.query(
          `UPDATE agent_runs SET status='handoff', final_reply=$1, ended_at=NOW() WHERE id=$2`,
          [err.message.slice(0, 500), runId],
        ).catch(() => {});
      }
      return { runId, status: 'handoff', finalText: '', totalInputTokens: 0, totalOutputTokens: 0, iterations: 0, steps };
    }
    if (persist && runId) {
      await pool.query(`UPDATE agent_runs SET status='failed', error_message=$1, ended_at=NOW() WHERE id=$2`,
        [String(err.message || err).slice(0, 1000), runId]).catch(() => {});
    }
    throw err;
  }
}

// In-app dry run for the test chat panel. No persistence, no real writes.
async function runAgentTest({ agentId, messages }) {
  const loaded = await loadRunnableAgent(agentId);
  const cleaned = Array.isArray(messages) ? messages.filter(m => m && m.content && (m.role === 'user' || m.role === 'assistant')) : [];
  if (cleaned.length === 0) throw new Error('At least one message is required (role=user|assistant, non-empty content).');
  const out = await runLoop({ loaded, messages: cleaned, ctx: { mode: 'test', live: false }, persist: false });
  return {
    reply: out.finalText, status: out.status,
    totalInputTokens: out.totalInputTokens, totalOutputTokens: out.totalOutputTokens,
    iterations: out.iterations, steps: out.steps,
  };
}

module.exports = { loadRunnableAgent, buildToolsForAgent, runLoop, runAgentTest, withContext };
