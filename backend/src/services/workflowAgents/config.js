// An agent's full configuration: normalise, validate, resolve from rows, merge a
// test-run override. Everything the runtime and the API accept passes through here,
// so the builder UI, the API and a queued run can never disagree about what a
// setting means.

const { normalizeScope } = require('./scope');
const { normalizeToolConfig } = require('./tools');
const { checkSchema } = require('./jsonSchema');
const { parseCron } = require('./cron');
const { MODELS, DEFAULT_MODEL } = require('./modelClient');

const EVENTS = ['message.inbound', 'lead.stage_changed', 'lead.quiet', 'payment.created'];
const DESTINATION_TYPES = ['results_inbox', 'rep_worklist', 'whatsapp_template', 'email', 'webhook'];
// Retired (Telegram output removed): still found in stored agents, dropped quietly.
const RETIRED_DESTINATION_TYPES = ['telegram'];
const APPROVERS = ['admin', 'team_lead', 'owner_rep'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const INSTRUCTIONS_MAX = 60000;

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const strList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => String(x).trim()).filter(Boolean);

function normalizeTriggers(raw) {
  const errors = [];
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const enabled = t.enabled !== false;
    if (t.type === 'schedule') {
      const cron = String(t.cron || '').trim();
      try { parseCron(cron); } catch (e) { errors.push(`Trigger ${i + 1}: ${e.message}`); return; }
      out.push({ type: 'schedule', cron, timezone: 'Asia/Kolkata', enabled });
    } else if (t.type === 'event') {
      if (!EVENTS.includes(t.event)) { errors.push(`Trigger ${i + 1}: unknown event "${t.event}". Valid: ${EVENTS.join(', ')}.`); return; }
      const f = t.filters && typeof t.filters === 'object' ? t.filters : {};
      const filters = {};
      if (t.event === 'message.inbound') {
        const types = strList(f.message_type).filter(x => ['text', 'voice_note', 'image', 'document', 'video', 'interactive_reply'].includes(x));
        if (types.length) filters.message_type = types;
      }
      if (t.event === 'lead.stage_changed') {
        const to = strList(f.to); if (to.length) filters.to = to;
        const from = strList(f.from); if (from.length) filters.from = from;
      }
      if (t.event === 'lead.quiet') {
        filters.hours_since_last_inbound = clampInt(f.hours_since_last_inbound, 1, 24 * 30, 48);
      }
      if (t.event === 'payment.created') {
        if (f.min_amount_rupees != null && Number(f.min_amount_rupees) >= 0) filters.min_amount_rupees = Number(f.min_amount_rupees);
      }
      const stages = strList(f.stage_in); if (stages.length) filters.stage_in = stages;
      if (f.stage_not_won === true) filters.stage_not_won = true;
      out.push({ type: 'event', event: t.event, filters, debounce_minutes: clampInt(t.debounce_minutes, 0, 24 * 60, t.event === 'lead.quiet' ? 0 : 10), enabled });
    } else if (t.type === 'manual') {
      out.push({ type: 'manual', enabled });
    } else {
      errors.push(`Trigger ${i + 1}: type must be schedule, event or manual.`);
    }
  });
  return { triggers: out, errors };
}

function normalizeDestinations(raw) {
  const errors = [];
  const out = [{ type: 'results_inbox' }];
  (Array.isArray(raw) ? raw : []).forEach((d, i) => {
    if (!d || typeof d !== 'object' || d.type === 'results_inbox' || RETIRED_DESTINATION_TYPES.includes(d.type)) return;
    if (!DESTINATION_TYPES.includes(d.type)) { errors.push(`Destination ${i + 1}: unknown type "${d.type}".`); return; }
    const enabled = d.enabled !== false;
    if (d.type === 'rep_worklist') out.push({ type: 'rep_worklist', split_by: 'owner_rep', enabled });
    if (d.type === 'whatsapp_template') {
      const template = String(d.template || '').trim();
      if (!template) errors.push(`Destination ${i + 1}: choose the WhatsApp template to send.`);
      const sendAt = /^\d{2}:\d{2}$/.test(String(d.send_at || '')) ? d.send_at : null;
      // No approval step: this is an internal digest to reps or managers, never a customer message.
      const to = d.to === 'numbers' ? 'numbers' : 'rep';
      const numbers = strList(d.numbers).map(n => n.replace(/\D/g, '')).filter(n => n.length >= 10);
      if (to === 'numbers' && !numbers.length && enabled) errors.push(`Destination ${i + 1}: add at least one number with its country code.`);
      out.push({ type: 'whatsapp_template', to, numbers, template, send_at: sendAt, enabled });
    }
    if (d.type === 'email') {
      const to = strList(d.to).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (!to.length && enabled) errors.push(`Destination ${i + 1}: add at least one valid email address.`);
      out.push({ type: 'email', to, format: 'text', enabled: enabled && to.length > 0 });
    }
    if (d.type === 'webhook') {
      let url = null;
      try { const u = new URL(String(d.url || '')); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.toString(); } catch { /* invalid */ }
      if (!url && enabled) errors.push(`Destination ${i + 1}: the webhook URL must be a full http(s) URL.`);
      out.push({ type: 'webhook', url, secret: typeof d.secret === 'string' ? d.secret.slice(0, 200) : '', enabled: enabled && !!url });
    }
  });
  return { destinations: out, errors };
}

function normalizeApprovalRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const approvers = strList(r.approvers).filter(a => APPROVERS.includes(a));
  return {
    approvers: approvers.length ? [...new Set(['admin', ...approvers])] : ['admin'],
    expire_hours: clampInt(r.expire_hours, 1, 24 * 14, 24),
    rep_can_send_suggested: r.rep_can_send_suggested === true,
  };
}

function normalizeRuntime(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.batching && typeof r.batching === 'object' ? r.batching : {};
  return { batching: { enabled: b.enabled === true, batch_size: clampInt(b.batch_size, 5, 50, 25), max_candidates: clampInt(b.max_candidates, 10, 400, 150) } };
}

function normalizeAgentSettings(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const model = MODELS[a.model] ? a.model : DEFAULT_MODEL;
  if (a.model && !MODELS[a.model]) errors.push(`Unknown model "${a.model}".`);
  const temperature = Number.isFinite(Number(a.temperature)) ? Math.min(1, Math.max(0, Number(a.temperature))) : 0.2;
  const budget = a.monthly_budget_inr === null || a.monthly_budget_inr === '' || a.monthly_budget_inr === undefined ? null : Number(a.monthly_budget_inr);
  if (budget !== null && !(budget > 0)) errors.push('The monthly budget must be a positive amount, or empty for no limit.');
  return {
    settings: {
      model,
      effort: EFFORTS.includes(a.effort) ? a.effort : 'high',
      temperature,
      max_tool_calls: clampInt(a.max_tool_calls, 1, 500, 40),
      max_tokens_per_run: clampInt(a.max_tokens_per_run, 1000, 5000000, 200000),
      max_output_tokens: clampInt(a.max_output_tokens, 1000, 128000, 16000),
      monthly_budget_inr: budget !== null && budget > 0 ? Math.round(budget * 100) / 100 : null,
      credential_id: a.credential_id == null || a.credential_id === '' ? null : Number(a.credential_id),
      auto_accept_memory: a.auto_accept_memory === true,
    },
    errors,
  };
}

/** Normalise + validate a whole version config. Returns { config, errors }. */
function validateConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const instructions = String(r.instructions == null ? '' : r.instructions);
  if (!instructions.trim()) errors.push('Instructions cannot be empty.');
  if (instructions.length > INSTRUCTIONS_MAX) errors.push(`Instructions are ${instructions.length} characters; the limit is ${INSTRUCTIONS_MAX}.`);
  let outputSchema = r.output_schema;
  if (typeof outputSchema === 'string') {
    try { outputSchema = JSON.parse(outputSchema); } catch { errors.push('The output schema is not valid JSON.'); outputSchema = {}; }
  }
  errors.push(...checkSchema(outputSchema).map(p => `Output schema: ${p}`));
  if (outputSchema && outputSchema.type !== 'object') errors.push('The output schema must describe a JSON object (type: "object").');
  const { scope, errors: scopeErrors } = normalizeScope(r.data_scope);
  const { triggers, errors: trigErrors } = normalizeTriggers(r.triggers);
  const { destinations, errors: destErrors } = normalizeDestinations(r.destinations);
  const toolCfg = normalizeToolConfig(r.tool_config);
  if (!toolCfg.some(t => t.enabled)) errors.push('Enable at least one tool.');
  const { settings, errors: agentErrors } = normalizeAgentSettings(r.agent);
  return {
    config: {
      agent: settings,
      instructions,
      output_schema: outputSchema && typeof outputSchema === 'object' ? outputSchema : {},
      tool_config: toolCfg,
      data_scope: scope,
      triggers,
      destinations,
      approval_rules: normalizeApprovalRules(r.approval_rules),
      runtime: normalizeRuntime(r.runtime),
    },
    errors: [...errors, ...scopeErrors.map(e => `Data access: ${e}`), ...trigErrors, ...destErrors, ...agentErrors],
  };
}

/** Config from DB rows. */
function configFromRows(agent, version) {
  return {
    agent: {
      model: agent.model, effort: agent.effort, temperature: Number(agent.temperature), max_tool_calls: agent.max_tool_calls,
      max_tokens_per_run: agent.max_tokens_per_run, max_output_tokens: agent.max_output_tokens,
      monthly_budget_inr: agent.monthly_budget_inr == null ? null : Number(agent.monthly_budget_inr),
      credential_id: agent.credential_id, auto_accept_memory: agent.auto_accept_memory,
    },
    instructions: version?.instructions || '',
    output_schema: version?.output_schema || {},
    tool_config: version?.tool_config || [],
    data_scope: version?.data_scope || {},
    triggers: version?.triggers || [],
    destinations: version?.destinations || [],
    approval_rules: version?.approval_rules || {},
    runtime: version?.runtime || {},
  };
}

/** A test-run override replaces whole sections; unspecified sections keep the saved config. */
function mergeOverride(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const key of ['instructions', 'output_schema', 'tool_config', 'data_scope', 'triggers', 'destinations', 'approval_rules', 'runtime']) {
    if (override[key] !== undefined) out[key] = override[key];
  }
  if (override.agent && typeof override.agent === 'object') out.agent = { ...base.agent, ...override.agent };
  return out;
}

module.exports = {
  EVENTS, DESTINATION_TYPES, APPROVERS, EFFORTS, normalizeTriggers, normalizeDestinations, normalizeApprovalRules,
  normalizeRuntime, normalizeAgentSettings, validateConfig, configFromRows, mergeOverride,
};
