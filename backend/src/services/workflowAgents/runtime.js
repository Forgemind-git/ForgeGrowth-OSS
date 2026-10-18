// Workflow agent runtime: create a run, then execute it — assemble context, run the
// Claude tool loop under budgets, validate the answer against the output schema,
// verify evidence, record every step, post-process.
//
// A run's configuration is SNAPSHOTTED onto the run row when it is created, so a
// queued run executes exactly what was saved at the time, and a test run can carry
// unsaved settings from the builder without touching the saved agent.

const pool = require('../../db');
const bus = require('../../events');
const { buildToolContext, runTool, modelToolDefs, TOOLS_BY_KEY } = require('./tools');
const { activeMemory } = require('./tools/context');
const { normalizeScope } = require('./scope');
const { validate } = require('./jsonSchema');
const { checkEvidence, stripFailedEvidence } = require('./evidence');
const { renderMarkdown } = require('./markdown');
const { GUARDRAILS, renderTemplate } = require('./guardrails');
const modelClient = require('./modelClient');
const { toIst, istDate, istHuman } = require('./format');
const { validateConfig, configFromRows, mergeOverride } = require('./config');

const STEP_OUTPUT_CAP = 60000;
const MAX_VALIDATION_RETRIES = 2;
const DAY = 864e5;

class RunError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── create ────────────────────────────────────────────────────────────────────

/**
 * @returns the queued run row, or null when a run with this trigger key already
 * exists (the idempotency guarantee for schedules and debounced events).
 */
async function createRun({ agentId, triggerType, triggerKey = null, triggerPayload = {}, dryRun = false, pretendDate = null, configOverride = null, requestedBy = null, versionId = null }) {
  const { rows: [agent] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [agentId]);
  if (!agent) throw new RunError(404, 'Agent not found.');
  const wantVersion = versionId || agent.current_version_id;
  const { rows: [version] } = wantVersion
    ? await pool.query(`SELECT * FROM coexistence.workflow_agent_versions WHERE id = $1 AND agent_id = $2`, [wantVersion, agent.id])
    : { rows: [] };
  if (versionId && !version) throw new RunError(404, 'That version does not belong to this agent.');
  if (!version && !(dryRun && configOverride)) throw new RunError(400, 'Save this agent at least once before running it.');
  if (!dryRun && triggerType !== 'manual' && agent.status !== 'active') throw new RunError(409, 'Only an active agent runs on schedules and events.');
  if (pretendDate != null) {
    if (!dryRun) throw new RunError(400, '"Pretend today is" is only available in test runs.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pretendDate)) || Number.isNaN(new Date(`${pretendDate}T00:00:00+05:30`).getTime())) throw new RunError(400, 'The pretend date must be YYYY-MM-DD.');
    if (String(pretendDate) > istDate()) throw new RunError(400, 'The pretend date cannot be in the future.');
  }
  const base = configFromRows(agent, version);
  const merged = dryRun ? mergeOverride(base, configOverride) : base;
  const { config, errors } = validateConfig(merged);
  if (errors.length) throw new RunError(400, errors.join(' '));

  const { rows } = await pool.query(
    `INSERT INTO coexistence.workflow_agent_runs
       (agent_id, agent_version_id, trigger_type, trigger_key, trigger_payload, dry_run, pretend_date, config_snapshot, requested_by, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (agent_id, trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [agent.id, version?.id || null, dryRun && triggerType === 'manual' ? 'test' : triggerType,
      triggerKey, JSON.stringify(triggerPayload || {}), !!dryRun, pretendDate, JSON.stringify(config), requestedBy, config.agent.model]);
  return rows[0] || null;
}

// ── execute ───────────────────────────────────────────────────────────────────

function pretendNow(pretendDate) {
  if (!pretendDate) return new Date();
  const d = typeof pretendDate === 'string' ? pretendDate : `${pretendDate.getFullYear()}-${String(pretendDate.getMonth() + 1).padStart(2, '0')}-${String(pretendDate.getDate()).padStart(2, '0')}`;
  const nowIst = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(11, 19);
  return new Date(`${d}T${nowIst}+05:30`);
}

function parseJsonAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return { error: 'Your final message contained no JSON.' };
  const attempts = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) attempts.push(fence[1]);
  const first = t.indexOf('{'); const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(t.slice(first, last + 1));
  for (const a of attempts) {
    try { const v = JSON.parse(a); if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v }; } catch { /* next */ }
  }
  return { error: 'Your final message was not a valid JSON object.' };
}

const cap = (v) => {
  const s = JSON.stringify(v);
  if (s === undefined) return null;
  return s.length > STEP_OUTPUT_CAP ? { truncated: true, chars: s.length, preview: s.slice(0, STEP_OUTPUT_CAP) } : v;
};

async function monthSpentInr(agentId, excludeRunId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(cost_inr), 0)::float AS spent FROM coexistence.workflow_agent_runs
      WHERE agent_id = $1 AND id <> $2
        AND queued_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`, [agentId, excludeRunId]);
  return Number(r.spent || 0);
}

async function notifyAdmins({ agentId, title, body }) {
  await pool.query(
    `INSERT INTO coexistence.workflow_agent_notifications (user_id, agent_id, title, body)
     SELECT u.id, $1, $2, $3 FROM coexistence.forgecrm_users u WHERE u.role = 'admin' AND u.is_active`, [agentId, title, body]);
}

function memoryBlock(items) {
  if (!items.length) return '# Memory\n(No memory items yet.)';
  const group = (kind, heading) => {
    const list = items.filter(i => i.kind === kind);
    return list.length ? `## ${heading}\n${list.map(i => `- **${i.title}** (memory_id ${i.memory_id}): ${i.content}`).join('\n')}` : '';
  };
  return ['# Memory', group('pinned', 'Pinned (always follow)'), group('glossary', 'Glossary'), group('learned', 'Learned'), group('contact', 'About specific leads')].filter(Boolean).join('\n\n');
}

/**
 * The tool loop. Returns { status, output, validationErrors, error, checks } where
 * status is done | budget_stopped | cancelled | failed.
 */
async function modelLoop({ runId, config, ctx, system, tools, userText, schema, callModel, state, spentBefore, label = 'main', allowTools = true }) {
  const limits = config.agent;
  const messages = [{ role: 'user', content: [{ type: 'text', text: userText }] }];
  let finalizing = !allowTools;
  let finalizeReason = null;
  let validationAttempts = 0;
  let lastText = '';

  for (;;) {
    const { rows: [cur] } = await pool.query(`SELECT status FROM coexistence.workflow_agent_runs WHERE id = $1`, [runId]);
    if (cur && cur.status === 'cancelled') return { status: 'cancelled', output: null, error: 'Cancelled by a user.' };
    if (modelClient.totalTokens(state.usage) >= limits.max_tokens_per_run) {
      await state.recordStep('info', { tool_key: null, output: { budget: 'max_tokens_per_run', used: modelClient.totalTokens(state.usage), limit: limits.max_tokens_per_run } });
      return { status: 'budget_stopped', output: parseJsonAnswer(lastText).value || null, error: `Token budget reached (${limits.max_tokens_per_run.toLocaleString('en-IN')} tokens).` };
    }

    const params = modelClient.buildRequest({
      model: limits.model, effort: limits.effort, temperature: limits.temperature, maxOutputTokens: limits.max_output_tokens,
      system, tools: tools.length ? tools : null, messages,
      toolChoice: tools.length && finalizing ? { type: 'none' } : null,
    });
    const t0 = Date.now();
    let resp;
    try {
      resp = await callModel(params);
    } catch (e) {
      const status = e?.status ? ` (HTTP ${e.status})` : '';
      await state.recordStep('model', { output: { error: `${e.message}${status}` }, duration_ms: Date.now() - t0 });
      return { status: 'failed', output: null, error: `The model call failed${status}: ${String(e.message).slice(0, 300)}` };
    }
    const u = modelClient.usageOf(resp);
    for (const k of Object.keys(state.usage)) state.usage[k] += u[k];
    state.costInr += modelClient.costInr(limits.model, u, state.costSettings);
    const textBlocks = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
    if (textBlocks.trim()) lastText = textBlocks;
    await state.recordStep('model', {
      output: {
        phase: label, stop_reason: resp.stop_reason, usage: u, text: textBlocks.slice(0, 4000),
        tool_calls: toolUses.map(t => t.name), fallbacks_disabled: resp.__fallbacks_disabled || undefined,
        served_by: resp.model && resp.model !== limits.model ? resp.model : undefined,
      },
      duration_ms: Date.now() - t0,
    });
    await pool.query(
      `UPDATE coexistence.workflow_agent_runs SET input_tokens = $2, output_tokens = $3, cache_write_tokens = $4, cache_read_tokens = $5, cost_inr = $6, tool_calls = $7 WHERE id = $1`,
      [runId, state.usage.input, state.usage.output, state.usage.cacheWrite, state.usage.cacheRead, state.costInr, state.toolCalls]);

    if (limits.monthly_budget_inr && spentBefore + state.costInr >= limits.monthly_budget_inr) {
      await state.recordStep('info', { output: { budget: 'monthly_budget_inr', spent_inr: Math.round((spentBefore + state.costInr) * 100) / 100 } });
      return { status: 'budget_stopped', output: parseJsonAnswer(lastText).value || null, error: `Monthly budget of ₹${limits.monthly_budget_inr} reached during this run.` };
    }

    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'refusal') {
      const cat = resp.stop_details?.category ? ` (${resp.stop_details.category})` : '';
      return { status: 'failed', output: null, error: `Claude declined this request${cat}.` };
    }
    if (resp.stop_reason === 'pause_turn') continue;

    if (toolUses.length) {
      const over = !finalizing && state.toolCalls + toolUses.length > limits.max_tool_calls;
      if (finalizing || over) {
        if (over) {
          finalizing = true;
          finalizeReason = `Tool-call budget reached (${limits.max_tool_calls}).`;
          await state.recordStep('info', { output: { budget: 'max_tool_calls', limit: limits.max_tool_calls } });
        }
        messages.push({
          role: 'user',
          content: toolUses.map(tu => ({
            type: 'tool_result', tool_use_id: tu.id, is_error: true,
            content: JSON.stringify({ error: 'tool_budget_reached', message: 'No more tool calls are allowed in this run. Return your final JSON now using what you already have, and list what you could not check in data_gaps.' }),
          })),
        });
        continue;
      }
      state.toolCalls += toolUses.length;
      // Step numbers are assigned before the concurrent calls so the trace keeps call order.
      const results = await Promise.all(toolUses.map(async (tu) => {
        await state.recordStep('tool_call', { tool_key: tu.name, input: tu.input });
        const s0 = Date.now();
        const result = await runTool(ctx, tu.name, tu.input);
        await state.recordStep('tool_result', { tool_key: tu.name, output: cap(result), duration_ms: Date.now() - s0 });
        return { tu, result };
      }));
      messages.push({
        role: 'user',
        content: results.map(({ tu, result }) => ({
          type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result), ...(result && result.error ? { is_error: true } : {}),
        })),
      });
      continue;
    }

    if (resp.stop_reason === 'max_tokens') {
      if (validationAttempts >= MAX_VALIDATION_RETRIES) return { status: 'failed', output: null, error: 'The answer kept exceeding the output token limit. Raise max output tokens or narrow the instructions.' };
      validationAttempts += 1;
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Your answer was cut off by the output limit. Return the complete JSON object again, more concisely.' }] });
      continue;
    }

    const parsed = parseJsonAnswer(textBlocks);
    const errors = parsed.error ? [parsed.error] : validate(schema, parsed.value);
    let checks = null;
    if (!errors.length) {
      checks = await checkEvidence(pool, parsed.value);
      if (checks.failures.length) {
        errors.push(...checks.failures.map(f => `${f.path}: evidence ${f.reason.replace(/_/g, ' ')} (message_id ${f.message_id}). Quote exactly from the cited message or remove it.`));
      }
    }
    await state.recordStep('validation', { output: { phase: label, ok: !errors.length, errors: errors.slice(0, 30), evidence: checks && { total: checks.total, verified: checks.verified } } });
    if (!errors.length) {
      return { status: finalizeReason ? 'budget_stopped' : 'done', output: parsed.value, checks, error: finalizeReason };
    }
    if (validationAttempts < MAX_VALIDATION_RETRIES) {
      validationAttempts += 1;
      messages.push({ role: 'user', content: [{ type: 'text', text: `Your JSON did not pass validation:\n- ${errors.slice(0, 30).join('\n- ')}\n\nFix these and return the complete JSON object only.` }] });
      continue;
    }
    // Out of retries. Unverifiable evidence is removed (and reported); a schema failure is a failure.
    if (!parsed.error && checks && checks.failures.length && validate(schema, parsed.value).length === 0) {
      const removed = stripFailedEvidence(parsed.value, checks.failures);
      if (Array.isArray(parsed.value.data_gaps)) parsed.value.data_gaps.push(`${removed} quote(s) could not be matched to their message and were removed.`);
      if (validate(schema, parsed.value).length === 0) {
        return { status: finalizeReason ? 'budget_stopped' : 'done', output: parsed.value, checks: { ...checks, removed }, error: finalizeReason };
      }
    }
    return { status: 'failed', output: parsed.value || null, validationErrors: errors, checks, error: 'The final answer did not match the output schema after 2 retries.' };
  }
}

/** Deterministic shortlist for map-reduce runs: active leads first, then slipping ones. */
async function batchCandidates(ctx, config) {
  const max = config.runtime.batching.max_candidates;
  const direct = async (key, input) => TOOLS_BY_KEY.get(key).handler(input, { ...ctx, caps: {}, overrides: {} });
  const active = await direct('get_active_conversations', { limit: Math.min(200, max) });
  const ids = (active.conversations || []).map(c => c.contact_id);
  if (ids.length < max) {
    const slipping = await direct('list_leads', {
      last_inbound_from: new Date(ctx.now.getTime() - 7 * DAY).toISOString(),
      last_inbound_to: new Date(ctx.now.getTime() - 2 * DAY).toISOString(),
      limit: Math.min(200, max - ids.length),
    });
    for (const l of slipping.leads || []) if (!ids.includes(l.contact_id)) ids.push(l.contact_id);
  }
  return ids.slice(0, max);
}

async function executeRun(runId, deps = {}) {
  const { rows: [run] } = await pool.query(
    `UPDATE coexistence.workflow_agent_runs SET status = 'running', started_at = NOW()
      WHERE id = $1 AND status = 'queued' RETURNING *`, [runId]);
  if (!run) return { skipped: 'not_queued' };
  const { rows: [agent] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [run.agent_id]);
  const config = run.config_snapshot;
  const now = deps.now || pretendNow(run.pretend_date);
  let stepNo = 0;
  const recordStep = async (type, { tool_key = null, input = null, output = null, duration_ms = null } = {}) => {
    stepNo += 1;
    const n = stepNo;
    try {
      await pool.query(
        `INSERT INTO coexistence.workflow_agent_run_steps (run_id, step, type, tool_key, input, output, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, n, type, tool_key, input == null ? null : JSON.stringify(input), output == null ? null : JSON.stringify(output), duration_ms]);
    } catch (e) { console.error('[workflow-agents] step log failed:', e.message); }
  };

  const { rows: [settings] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_settings WHERE id = 1`);
  const state = {
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, costInr: 0, toolCalls: 0, recordStep,
    costSettings: { rateCard: settings?.rate_card || {}, usdToInr: Number(settings?.usd_to_inr || 88) },
  };

  const finish = async (status, fields = {}) => {
    const output = fields.output === undefined ? null : fields.output;
    const markdown = output ? renderMarkdown(output, { agentName: agent.name }) : null;
    const { rows: [done] } = await pool.query(
      `UPDATE coexistence.workflow_agent_runs
          SET status = $2, finished_at = NOW(), output = $3, output_markdown = $4, output_valid = $5,
              validation_errors = $6, checks = $7, error = $8, cursor = $9,
              input_tokens = $10, output_tokens = $11, cache_write_tokens = $12, cache_read_tokens = $13, cost_inr = $14, tool_calls = $15
        WHERE id = $1 AND status = 'running' RETURNING *`,
      [runId, status, output ? JSON.stringify(output) : null, markdown, output ? fields.valid !== false : null,
        fields.validationErrors ? JSON.stringify(fields.validationErrors) : null, fields.checks ? JSON.stringify(fields.checks) : null,
        fields.error || null, fields.cursor ? JSON.stringify(fields.cursor) : null,
        state.usage.input, state.usage.output, state.usage.cacheWrite, state.usage.cacheRead, state.costInr, state.toolCalls]);
    bus.emit('workflow-agent-run', { agentId: agent.id, runId, status: done ? status : 'cancelled' });
    return done;
  };

  try {
    const spentBefore = await monthSpentInr(agent.id, runId);
    const budget = config.agent.monthly_budget_inr;
    if (budget && spentBefore >= budget) {
      return await finish('budget_stopped', { error: `Monthly budget of ₹${budget} is already used (₹${spentBefore.toFixed(2)} this month).` });
    }
    if (budget && spentBefore >= budget * 0.8 && !run.dry_run) {
      const { rows: warned } = await pool.query(
        `SELECT 1 FROM coexistence.workflow_agent_notifications WHERE agent_id = $1 AND title LIKE 'Budget 80%'
           AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' LIMIT 1`, [agent.id]);
      if (!warned.length) await notifyAdmins({ agentId: agent.id, title: `Budget 80% used: ${agent.name}`, body: `₹${spentBefore.toFixed(2)} of ₹${budget} spent this month.` });
    }

    let callModel = deps.callModel;
    if (!callModel) {
      try {
        const { apiKey } = await modelClient.resolveApiKey(pool, config.agent.credential_id);
        callModel = modelClient.createCaller(apiKey);
      } catch (e) {
        return await finish('failed', { error: e.message });
      }
    }

    const { scope } = normalizeScope(config.data_scope);
    if (run.pretend_date) scope.as_of = now;
    const { rows: [lastRun] } = await pool.query(
      `SELECT finished_at, cursor FROM coexistence.workflow_agent_runs
        WHERE agent_id = $1 AND status = 'succeeded' AND dry_run = FALSE AND id <> $2 ORDER BY finished_at DESC LIMIT 1`, [agent.id, runId]);
    const { rows: [maxMsg] } = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM coexistence.chat_history WHERE timestamp <= $1`, [now]);

    const ctx = await buildToolContext({
      pool, agent: { id: agent.id, name: agent.name, auto_accept_memory: config.agent.auto_accept_memory },
      scope, runId, dryRun: run.dry_run, now, toolConfig: config.tool_config, approvalRules: config.approval_rules,
      recordStep: (type, payload) => recordStep(type, { output: payload }),
    });
    ctx.lastRunAt = lastRun?.finished_at ? new Date(lastRun.finished_at) : null;

    const workspace = await TOOLS_BY_KEY.get('get_workspace_context').handler({}, { ...ctx, caps: {}, overrides: {} });
    const focusLead = Number(run.trigger_payload?.lead_id) || null;
    const memory = await activeMemory(pool, agent.id, { kinds: ['pinned', 'glossary', 'learned', 'contact'], leadIds: focusLead ? [focusLead] : [], now });
    const vars = {
      business_name: workspace.business_name, today_ist: istDate(now), now_ist: istHuman(now), agent_name: agent.name,
      rep_name: run.trigger_payload?.rep_name || '', lookback_days: scope.lookback_days,
    };
    const system = [
      { type: 'text', text: `${renderTemplate(GUARDRAILS, vars)}\n\n# Agent instructions\n\n${renderTemplate(config.instructions, vars)}` },
      { type: 'text', text: memoryBlock(memory) },
      { type: 'text', text: `# Workspace context (get_workspace_context)\n${JSON.stringify(workspace)}`, cache_control: { type: 'ephemeral' } },
    ];
    const tools = modelToolDefs(config.tool_config);
    const baseUser = [
      '# This run',
      `- Run id: ${runId}`,
      `- Trigger: ${run.trigger_type}${run.trigger_key ? ` (${run.trigger_key})` : ''}`,
      `- Trigger payload: ${JSON.stringify(run.trigger_payload || {})}`,
      `- Now: ${istHuman(now)} (${toIst(now)})`,
      `- Previous successful run: ${lastRun ? toIst(lastRun.finished_at) : 'none'}. Tools accept since:"last_run" to read only what is new since then.`,
      run.dry_run ? '- TEST RUN: write tools only simulate, nothing is saved or sent.' : '- Live run: write tools file proposals that wait for human approval.',
      '- When you need several independent reads (e.g. several conversations), request them in the same turn.',
      '',
      '# Output schema',
      'When you are done, reply with ONLY a JSON object matching this schema (no prose, no code fence):',
      JSON.stringify(config.output_schema),
    ].join('\n');

    const spent = { spentBefore };
    let result;
    const batching = config.runtime?.batching;
    if (batching?.enabled && run.trigger_type !== 'event') {
      const candidates = await batchCandidates(ctx, config);
      await recordStep('info', { output: { batching: true, candidates: candidates.length, batch_size: batching.batch_size } });
      if (!candidates.length) {
        result = await modelLoop({ runId, config, ctx, system, tools, userText: baseUser, schema: config.output_schema, callModel, state, spentBefore: spent.spentBefore });
      } else {
        const partials = [];
        for (let i = 0; i < candidates.length; i += batching.batch_size) {
          const chunk = candidates.slice(i, i + batching.batch_size);
          const n = Math.floor(i / batching.batch_size) + 1;
          const total = Math.ceil(candidates.length / batching.batch_size);
          const part = await modelLoop({
            runId, config, ctx, system, tools, schema: config.output_schema, callModel, state, spentBefore: spent.spentBefore, label: `batch ${n}/${total}`,
            userText: `${baseUser}\n\n# Batch ${n} of ${total}\nWork ONLY on these contact_ids: ${JSON.stringify(chunk)}. Return a JSON object matching the schema that covers only these leads. A merge step will combine the batches afterwards.`,
          });
          if (part.status === 'cancelled' || part.status === 'failed' && !part.output) { result = part; break; }
          if (part.output) partials.push({ batch: n, output: part.output });
          if (part.status === 'budget_stopped') break;
        }
        if (!result) {
          result = await modelLoop({
            runId, config, ctx, system, tools, allowTools: false, schema: config.output_schema, callModel, state, spentBefore: spent.spentBefore, label: 'merge',
            userText: `${baseUser}\n\n# Merge step\nCombine these partial outputs into ONE final JSON object matching the schema. Re-rank, apply the per-rep limits, recompute every summary count. Do not add leads, quotes or message_ids that are not in the partial outputs.\n\n${JSON.stringify(partials)}`,
          });
        }
      }
    } else {
      result = await modelLoop({ runId, config, ctx, system, tools, userText: baseUser, schema: config.output_schema, callModel, state, spentBefore: spent.spentBefore });
    }

    if (result.status === 'cancelled') return await finish('cancelled', { error: result.error });
    if (result.status === 'failed') {
      const done = await finish('failed', { output: result.output, valid: false, validationErrors: result.validationErrors, checks: result.checks, error: result.error });
      if (!run.dry_run) await notifyAdmins({ agentId: agent.id, title: `Workflow agent failed: ${agent.name}`, body: result.error }).catch(() => {});
      return done;
    }
    const status = result.status === 'done' ? 'succeeded' : 'budget_stopped';
    const cursor = { last_chat_history_id: String(maxMsg.id), until: now.toISOString() };
    const done = await finish(status, { output: result.output, checks: result.checks, error: result.error, cursor });
    if (done && !run.dry_run && result.output) {
      try {
        await require('./destinations').deliverRun(done, agent, config);
      } catch (e) {
        console.error('[workflow-agents] delivery failed:', e.message);
      }
    }
    return done;
  } catch (e) {
    console.error(`[workflow-agents] run ${runId} crashed:`, e);
    return finish('failed', { error: `Internal error: ${String(e.message).slice(0, 300)}` });
  }
}

module.exports = { createRun, executeRun, parseJsonAnswer, pretendNow, RunError, memoryBlock, modelLoop };
