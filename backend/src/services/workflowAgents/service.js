// Workflow agents: agents, versions, memory and runs. Routes stay thin; the rules live here.

const pool = require('../../db');
const { PRESETS, blankConfig } = require('./presets');
const { validateConfig, configFromRows, normalizeAgentSettings, EFFORTS } = require('./config');
const { describeCron, nextRun } = require('./cron');
const { toIst } = require('./format');
const { MODELS } = require('./modelClient');
const { stableStringify } = require('./tools/write');

class ServiceError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const MEMORY_KINDS = ['pinned', 'learned', 'contact', 'glossary'];
const MEMORY_STATUSES = ['active', 'pending_review', 'archived'];
// Rough token estimate for the memory budget warning (≈4 characters per token).
const MEMORY_TOKEN_BUDGET = 6000;

async function audit({ agentId, entity, entityId = null, action, before = null, after = null, userId = null }, client = pool) {
  await client.query(
    `INSERT INTO coexistence.workflow_agent_audit (agent_id, entity, entity_id, action, before, after, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [agentId, entity, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), userId]);
}

function slugify(name) {
  return String(name || 'agent').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'agent';
}

async function uniqueSlug(client, name) {
  const base = slugify(name);
  const { rows } = await client.query(`SELECT slug FROM coexistence.workflow_agents WHERE slug = $1 OR slug LIKE $2`, [base, `${base}-%`]);
  const taken = new Set(rows.map(r => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function triggerSummary(triggers) {
  return (triggers || []).filter(t => t.enabled !== false).map(t => {
    if (t.type === 'schedule') return describeCron(t.cron);
    if (t.type === 'manual') return 'By hand';
    const f = t.filters || {};
    switch (t.event) {
      case 'message.inbound': return `When a lead sends ${f.message_type?.length ? `a ${f.message_type.map(x => x.replace('_', ' ')).join(' or ')}` : 'a message'}`;
      case 'lead.stage_changed': return `When a lead moves${f.to?.length ? ` to ${f.to.join(', ')}` : ' stage'}`;
      case 'lead.quiet': return `When a lead is quiet for ${f.hours_since_last_inbound || 48} h`;
      case 'payment.created': return 'When a payment arrives';
      default: return t.event;
    }
  });
}

function agentRow(a) {
  return {
    id: String(a.id), name: a.name, slug: a.slug, description: a.description, icon: a.icon, preset_key: a.preset_key,
    status: a.status, credential_id: a.credential_id, model: a.model, model_label: MODELS[a.model]?.label || a.model,
    temperature: Number(a.temperature), temperature_supported: !!MODELS[a.model]?.sampling, effort: a.effort,
    max_tool_calls: a.max_tool_calls, max_tokens_per_run: a.max_tokens_per_run, max_output_tokens: a.max_output_tokens,
    monthly_budget_inr: a.monthly_budget_inr == null ? null : Number(a.monthly_budget_inr), auto_accept_memory: a.auto_accept_memory,
    current_version_id: a.current_version_id == null ? null : String(a.current_version_id),
    created_by: a.created_by, created_at: toIst(a.created_at), updated_at: toIst(a.updated_at),
  };
}

function versionRow(v) {
  if (!v) return null;
  return {
    id: String(v.id), version: v.version, instructions: v.instructions, output_schema: v.output_schema, tool_config: v.tool_config,
    data_scope: v.data_scope, triggers: v.triggers, destinations: v.destinations, approval_rules: v.approval_rules, runtime: v.runtime,
    change_note: v.change_note, created_by: v.created_by, created_at: toIst(v.created_at),
  };
}

function runRow(r) {
  return {
    id: String(r.id), agent_id: String(r.agent_id), agent_version_id: r.agent_version_id == null ? null : String(r.agent_version_id),
    trigger_type: r.trigger_type, trigger_key: r.trigger_key, trigger_payload: r.trigger_payload, dry_run: r.dry_run,
    pretend_date: r.pretend_date ? (typeof r.pretend_date === 'string' ? r.pretend_date : toIst(r.pretend_date).slice(0, 10)) : null,
    status: r.status, requested_by: r.requested_by, queued_at: toIst(r.queued_at), started_at: toIst(r.started_at), finished_at: toIst(r.finished_at),
    duration_ms: r.started_at && r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null,
    model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens,
    tool_calls: r.tool_calls, cost_inr: Number(r.cost_inr || 0), output_valid: r.output_valid, error: r.error,
  };
}

// ── agents ────────────────────────────────────────────────────────────────────

async function listAgents() {
  const { rows } = await pool.query(
    `SELECT a.*, v.triggers,
            lr.status AS last_run_status, lr.finished_at AS last_run_at, lr.queued_at AS last_run_queued_at,
            COALESCE(m.runs, 0)::int AS runs_this_month, COALESCE(m.cost, 0)::float AS cost_this_month,
            COALESCE(p.pending, 0)::int AS pending_approvals,
            COALESCE(mem.pending, 0)::int AS pending_memory
       FROM coexistence.workflow_agents a
       LEFT JOIN coexistence.workflow_agent_versions v ON v.id = a.current_version_id
       LEFT JOIN LATERAL (SELECT status, finished_at, queued_at FROM coexistence.workflow_agent_runs r WHERE r.agent_id = a.id AND r.dry_run = FALSE ORDER BY r.queued_at DESC LIMIT 1) lr ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) AS runs, SUM(cost_inr) AS cost FROM coexistence.workflow_agent_runs r
                           WHERE r.agent_id = a.id AND r.queued_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') m ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) AS pending FROM coexistence.workflow_agent_actions x WHERE x.agent_id = a.id AND x.status = 'pending' AND (x.expires_at IS NULL OR x.expires_at > NOW())) p ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) AS pending FROM coexistence.workflow_agent_memory mm WHERE mm.agent_id = a.id AND mm.status = 'pending_review') mem ON TRUE
      ORDER BY a.created_at DESC`);
  return rows.map(r => ({
    ...agentRow(r),
    trigger_summary: triggerSummary(r.triggers),
    next_scheduled_run: (() => {
      const times = (r.triggers || []).filter(t => t.type === 'schedule' && t.enabled !== false).map(t => { try { return nextRun(t.cron); } catch { return null; } }).filter(Boolean);
      return times.length && r.status === 'active' ? toIst(new Date(Math.min(...times.map(d => d.getTime())))) : null;
    })(),
    last_run: r.last_run_status ? { status: r.last_run_status, at: toIst(r.last_run_at || r.last_run_queued_at) } : null,
    runs_this_month: r.runs_this_month, cost_this_month_inr: Math.round(r.cost_this_month * 100) / 100,
    pending_approvals: r.pending_approvals, pending_memory: r.pending_memory,
  }));
}

async function getAgent(id) {
  const { rows: [a] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [Number(id)]);
  if (!a) throw new ServiceError(404, 'Agent not found.');
  const { rows: [v] } = a.current_version_id
    ? await pool.query(`SELECT * FROM coexistence.workflow_agent_versions WHERE id = $1`, [a.current_version_id])
    : { rows: [] };
  return { agent: agentRow(a), version: versionRow(v), trigger_summary: triggerSummary(v?.triggers) };
}

/**
 * The guided "New agent" answers, laid over the preset before it is validated, so
 * version 1 already reflects them. Only these keys can be set this way; anything
 * else stays as the preset (or blank agent) defines it and is edited later in the
 * builder. Every value still goes through validateConfig.
 */
function applySetup(src, setup) {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return;
  if (typeof setup.instructions === 'string' && setup.instructions.trim()) src.instructions = setup.instructions;
  if (Array.isArray(setup.triggers)) src.triggers = setup.triggers;
  if (Array.isArray(setup.destinations)) src.destinations = setup.destinations;
  if (setup.data_scope && typeof setup.data_scope === 'object' && !Array.isArray(setup.data_scope)) {
    src.data_scope = { ...(src.data_scope || {}), ...setup.data_scope };
  }
  if (Array.isArray(setup.enable_tools)) {
    const on = new Set(setup.enable_tools.map(String));
    src.tool_config = (src.tool_config || []).map(t => (on.has(t.tool_key) ? { ...t, enabled: true } : t));
  }
  if (Array.isArray(setup.memory)) {
    // Fill in the preset's own memory items (matched by title); never adds or removes one.
    for (const m of src.memory || []) {
      const answer = setup.memory.find(x => x && String(x.title) === String(m.title));
      if (answer && typeof answer.content === 'string' && answer.content.trim()) m.content = answer.content.trim();
    }
  }
  if (setup.monthly_budget_inr !== undefined) src.agent = { ...(src.agent || {}), monthly_budget_inr: setup.monthly_budget_inr };
}

// The presets that exist are the ones in code. A row for a preset retired from
// code (ad_to_chat_quality) may linger in workflow_agent_presets; it is ignored,
// never offered. Agents already made from it keep working.
const isLivePreset = (key) => PRESETS.some(p => p.preset_key === key);

async function getPreset(key) {
  if (!isLivePreset(key)) throw new ServiceError(404, `Unknown preset "${key}".`);
  const { rows: [row] } = await pool.query(`SELECT preset_key, name, description, icon, config FROM coexistence.workflow_agent_presets WHERE preset_key = $1`, [key]);
  const p = row || PRESETS.find(x => x.preset_key === key);
  if (!p) throw new ServiceError(404, `Unknown preset "${key}".`);
  const c = p.config || {};
  return {
    preset_key: p.preset_key, name: p.name, description: p.description, icon: p.icon,
    triggers: c.triggers || [], destinations: c.destinations || [], data_scope: c.data_scope || {},
    memory: (c.memory || []).map(m => ({ kind: m.kind, title: m.title, content: m.content })),
    monthly_budget_inr: c.agent?.monthly_budget_inr ?? null,
  };
}

async function createAgent({ presetKey = null, name, description, icon, setup = null, userId }) {
  let preset = null;
  if (presetKey) {
    if (!isLivePreset(presetKey)) throw new ServiceError(404, `Unknown preset "${presetKey}".`);
    const { rows } = await pool.query(`SELECT * FROM coexistence.workflow_agent_presets WHERE preset_key = $1`, [presetKey]);
    preset = rows[0] || null;
    if (!preset) {
      const code = PRESETS.find(p => p.preset_key === presetKey);
      if (!code) throw new ServiceError(404, `Unknown preset "${presetKey}".`);
      preset = { preset_key: code.preset_key, name: code.name, description: code.description, icon: code.icon, config: code.config };
    }
  }
  // Deep copy: the agent must never share an object with its preset.
  const src = JSON.parse(JSON.stringify(preset ? preset.config : blankConfig()));
  applySetup(src, setup);
  const { config, errors } = validateConfig(src);
  if (errors.length) throw new ServiceError(400, errors.join(' '));
  const finalName = String(name || preset?.name || 'New agent').trim().slice(0, 120);
  if (!finalName) throw new ServiceError(400, 'Name is required.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slug = await uniqueSlug(client, finalName);
    const s = config.agent;
    const { rows: [a] } = await client.query(
      `INSERT INTO coexistence.workflow_agents
         (name, slug, description, icon, preset_key, status, credential_id, model, temperature, effort, max_tool_calls, max_tokens_per_run, max_output_tokens, monthly_budget_inr, auto_accept_memory, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [finalName, slug, description ?? preset?.description ?? null, icon ?? preset?.icon ?? 'bot', preset?.preset_key || null,
        s.credential_id, s.model, s.temperature, s.effort, s.max_tool_calls, s.max_tokens_per_run, s.max_output_tokens, s.monthly_budget_inr, s.auto_accept_memory, userId || null]);
    const { rows: [v] } = await client.query(
      `INSERT INTO coexistence.workflow_agent_versions (agent_id, version, instructions, output_schema, tool_config, data_scope, triggers, destinations, approval_rules, runtime, change_note, created_by)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [a.id, config.instructions, JSON.stringify(config.output_schema), JSON.stringify(config.tool_config), JSON.stringify(config.data_scope),
        JSON.stringify(config.triggers), JSON.stringify(config.destinations), JSON.stringify(config.approval_rules), JSON.stringify(config.runtime),
        preset ? `Created from preset "${preset.name}"` : 'Created', userId || null]);
    await client.query(`UPDATE coexistence.workflow_agents SET current_version_id = $1 WHERE id = $2`, [v.id, a.id]);
    for (const m of src.memory || []) {
      if (!MEMORY_KINDS.includes(m.kind) || m.kind === 'contact') continue;
      await client.query(
        `INSERT INTO coexistence.workflow_agent_memory (agent_id, kind, title, content, source, status, created_by) VALUES ($1,$2,$3,$4,'admin','active',$5)`,
        [a.id, m.kind, String(m.title).slice(0, 120), String(m.content).slice(0, 4000), userId || null]);
    }
    await audit({ agentId: a.id, entity: 'agent', entityId: a.id, action: 'create', after: { preset: preset?.preset_key || null, name: finalName }, userId }, client);
    await client.query('COMMIT');
    return getAgent(a.id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const SETTINGS_KEYS = ['model', 'effort', 'temperature', 'max_tool_calls', 'max_tokens_per_run', 'max_output_tokens', 'monthly_budget_inr', 'credential_id', 'auto_accept_memory'];

async function updateAgent(id, patch, userId) {
  const { rows: [a] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [Number(id)]);
  if (!a) throw new ServiceError(404, 'Agent not found.');
  const sets = [];
  const params = [a.id];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim().slice(0, 120);
    if (!name) throw new ServiceError(400, 'Name cannot be empty.');
    add('name', name);
  }
  if (patch.description !== undefined) add('description', patch.description == null ? null : String(patch.description).slice(0, 1000));
  if (patch.icon !== undefined) add('icon', patch.icon == null ? null : String(patch.icon).slice(0, 40));
  if (patch.status !== undefined) {
    if (!['draft', 'active', 'paused'].includes(patch.status)) throw new ServiceError(400, 'status must be draft, active or paused.');
    if (patch.status === 'active' && !a.current_version_id) throw new ServiceError(400, 'Save the agent before activating it.');
    add('status', patch.status);
  }
  const current = configFromRows(a, null).agent;
  const touched = SETTINGS_KEYS.filter(k => patch[k] !== undefined);
  if (touched.length) {
    if (patch.effort !== undefined && !EFFORTS.includes(patch.effort)) throw new ServiceError(400, `effort must be one of ${EFFORTS.join(', ')}.`);
    if (patch.credential_id != null && patch.credential_id !== '') {
      const { rows } = await pool.query(`SELECT provider FROM coexistence.ai_models WHERE id = $1`, [Number(patch.credential_id)]);
      if (!rows[0]) throw new ServiceError(400, 'That AI credential does not exist.');
      if (rows[0].provider !== 'anthropic') throw new ServiceError(400, 'Workflow agents run on Claude: pick an Anthropic credential.');
    }
    const merged = { ...current };
    for (const k of touched) merged[k] = patch[k];
    const { settings, errors } = normalizeAgentSettings(merged);
    if (errors.length) throw new ServiceError(400, errors.join(' '));
    for (const k of touched) add(k, settings[k]);
  }
  if (!sets.length) return getAgent(a.id);
  sets.push('updated_at = NOW()');
  await pool.query(`UPDATE coexistence.workflow_agents SET ${sets.join(', ')} WHERE id = $1`, params);
  await audit({ agentId: a.id, entity: 'agent', entityId: a.id, action: 'update', before: Object.fromEntries(Object.keys(patch).map(k => [k, a[k]])), after: patch, userId });
  return getAgent(a.id);
}

async function deleteAgent(id, userId) {
  const { rows } = await pool.query(`DELETE FROM coexistence.workflow_agents WHERE id = $1 RETURNING id, name`, [Number(id)]);
  if (!rows.length) throw new ServiceError(404, 'Agent not found.');
  await audit({ agentId: rows[0].id, entity: 'agent', entityId: rows[0].id, action: 'delete', before: { name: rows[0].name }, userId });
  return { ok: true };
}

// ── versions ──────────────────────────────────────────────────────────────────

async function saveVersion(id, rawConfig, changeNote, userId) {
  const { rows: [a] } = await pool.query(`SELECT * FROM coexistence.workflow_agents WHERE id = $1`, [Number(id)]);
  if (!a) throw new ServiceError(404, 'Agent not found.');
  const { config, errors } = validateConfig({ ...rawConfig, agent: configFromRows(a, null).agent });
  if (errors.length) throw new ServiceError(400, errors.join(' '), { errors });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise saves per agent so two editors cannot both become "version n+1".
    await client.query(`SELECT id FROM coexistence.workflow_agents WHERE id = $1 FOR UPDATE`, [a.id]);
    const { rows: [prev] } = await client.query(`SELECT * FROM coexistence.workflow_agent_versions WHERE id = $1`, [a.current_version_id]);
    const same = prev && ['instructions', 'output_schema', 'tool_config', 'data_scope', 'triggers', 'destinations', 'approval_rules', 'runtime']
      .every(k => stableStringify(prev[k]) === stableStringify(config[k]));
    if (same) { await client.query('ROLLBACK'); return { ...(await getAgent(a.id)), unchanged: true }; }
    const { rows: [{ next }] } = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM coexistence.workflow_agent_versions WHERE agent_id = $1`, [a.id]);
    const { rows: [v] } = await client.query(
      `INSERT INTO coexistence.workflow_agent_versions (agent_id, version, instructions, output_schema, tool_config, data_scope, triggers, destinations, approval_rules, runtime, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.id, next, config.instructions, JSON.stringify(config.output_schema), JSON.stringify(config.tool_config), JSON.stringify(config.data_scope),
        JSON.stringify(config.triggers), JSON.stringify(config.destinations), JSON.stringify(config.approval_rules), JSON.stringify(config.runtime),
        changeNote ? String(changeNote).slice(0, 500) : null, userId || null]);
    await client.query(`UPDATE coexistence.workflow_agents SET current_version_id = $1, updated_at = NOW() WHERE id = $2`, [v.id, a.id]);
    await audit({ agentId: a.id, entity: 'version', entityId: v.id, action: 'save', before: { version: prev?.version || null }, after: { version: next, change_note: changeNote || null }, userId }, client);
    await client.query('COMMIT');
    return getAgent(a.id);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listVersions(id) {
  const { rows } = await pool.query(
    `SELECT v.id, v.version, v.change_note, v.created_by, v.created_at, COALESCE(u.display_name, u.username) AS created_by_name, length(v.instructions) AS instructions_chars
       FROM coexistence.workflow_agent_versions v LEFT JOIN coexistence.forgecrm_users u ON u.id = v.created_by
      WHERE v.agent_id = $1 ORDER BY v.version DESC`, [Number(id)]);
  return rows.map(r => ({ id: String(r.id), version: r.version, change_note: r.change_note, created_by_name: r.created_by_name, created_at: toIst(r.created_at), instructions_chars: r.instructions_chars }));
}

async function getVersion(id, versionId) {
  const { rows: [v] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_versions WHERE agent_id = $1 AND id = $2`, [Number(id), Number(versionId)]);
  if (!v) throw new ServiceError(404, 'Version not found.');
  return versionRow(v);
}

async function restoreVersion(id, versionId, userId) {
  const v = await getVersion(id, versionId);
  return saveVersion(id, v, `Restored version ${v.version}`, userId);
}

// ── memory ────────────────────────────────────────────────────────────────────

function memoryRow(m) {
  return {
    id: String(m.id), kind: m.kind, contact_id: m.lead_id == null ? null : String(m.lead_id), contact_name: m.lead_name || null,
    title: m.title, content: m.content, source: m.source, status: m.status, expires_at: toIst(m.expires_at),
    proposed_by_run_id: m.proposed_by_run_id == null ? null : String(m.proposed_by_run_id),
    created_at: toIst(m.created_at), updated_at: toIst(m.updated_at),
  };
}

async function listMemory(id, { status, kind, q } = {}) {
  const params = [Number(id)];
  const where = ['m.agent_id = $1'];
  if (status && MEMORY_STATUSES.includes(status)) { params.push(status); where.push(`m.status = $${params.length}`); }
  if (kind && MEMORY_KINDS.includes(kind)) { params.push(kind); where.push(`m.kind = $${params.length}`); }
  if (q) { params.push(`%${String(q).replace(/[\\%_]/g, c => `\\${c}`)}%`); where.push(`(m.title ILIKE $${params.length} OR m.content ILIKE $${params.length} OR l.name ILIKE $${params.length} OR l.whatsapp_number ILIKE $${params.length})`); }
  const { rows } = await pool.query(
    `SELECT m.*, l.name AS lead_name FROM coexistence.workflow_agent_memory m LEFT JOIN coexistence.leads l ON l.id = m.lead_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE m.status WHEN 'pending_review' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
               CASE m.kind WHEN 'pinned' THEN 0 WHEN 'glossary' THEN 1 WHEN 'learned' THEN 2 ELSE 3 END, m.updated_at DESC`, params);
  const active = rows.filter(r => r.status === 'active' && r.kind !== 'contact');
  const chars = active.reduce((s, r) => s + r.title.length + r.content.length, 0);
  return {
    items: rows.map(memoryRow),
    budget: { characters: chars, approx_tokens: Math.ceil(chars / 4), token_budget: MEMORY_TOKEN_BUDGET, over_budget: Math.ceil(chars / 4) > MEMORY_TOKEN_BUDGET },
  };
}

function cleanMemoryInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.kind !== undefined) {
    if (!MEMORY_KINDS.includes(body.kind)) throw new ServiceError(400, `kind must be one of ${MEMORY_KINDS.join(', ')}.`);
    out.kind = body.kind;
  }
  if (!partial || body.title !== undefined) {
    const t = String(body.title || '').trim();
    if (!t) throw new ServiceError(400, 'Title is required.');
    out.title = t.slice(0, 120);
  }
  if (!partial || body.content !== undefined) {
    const c = String(body.content || '').trim();
    if (!c) throw new ServiceError(400, 'Content is required.');
    out.content = c.slice(0, 4000);
  }
  if (body.expires_at !== undefined) {
    if (body.expires_at === null || body.expires_at === '') out.expires_at = null;
    else { const d = new Date(body.expires_at); if (Number.isNaN(d.getTime())) throw new ServiceError(400, 'expires_at is not a valid date.'); out.expires_at = d; }
  }
  if (body.contact_id !== undefined) out.lead_id = body.contact_id == null || body.contact_id === '' ? null : Number(body.contact_id);
  if (body.status !== undefined) {
    if (!MEMORY_STATUSES.includes(body.status)) throw new ServiceError(400, `status must be one of ${MEMORY_STATUSES.join(', ')}.`);
    out.status = body.status;
  }
  return out;
}

async function createMemory(id, body, userId) {
  const m = cleanMemoryInput(body);
  if (m.kind === 'contact' && !m.lead_id) throw new ServiceError(400, 'Contact memory needs a lead.');
  if (m.lead_id) {
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.leads WHERE id = $1`, [m.lead_id]);
    if (!rows.length) throw new ServiceError(400, 'That lead does not exist.');
  }
  const { rows: [row] } = await pool.query(
    `INSERT INTO coexistence.workflow_agent_memory (agent_id, kind, lead_id, title, content, source, status, expires_at, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,'admin',$6,$7,$8,$8) RETURNING *`,
    [Number(id), m.kind, m.lead_id || null, m.title, m.content, m.status || 'active', m.expires_at || null, userId || null]);
  await audit({ agentId: Number(id), entity: 'memory', entityId: row.id, action: 'create', after: m, userId });
  return memoryRow(row);
}

async function updateMemory(id, memoryId, body, userId) {
  const { rows: [before] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_memory WHERE id = $1 AND agent_id = $2`, [Number(memoryId), Number(id)]);
  if (!before) throw new ServiceError(404, 'Memory item not found.');
  const m = cleanMemoryInput(body, { partial: true });
  const kind = m.kind || before.kind;
  const leadId = m.lead_id !== undefined ? m.lead_id : before.lead_id;
  if (kind === 'contact' && !leadId) throw new ServiceError(400, 'Contact memory needs a lead.');
  const cols = { kind: m.kind, lead_id: m.lead_id, title: m.title, content: m.content, expires_at: m.expires_at, status: m.status };
  const sets = [];
  const params = [before.id];
  for (const [col, v] of Object.entries(cols)) if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
  if (!sets.length) return memoryRow(before);
  params.push(userId || null); sets.push(`updated_by = $${params.length}`, 'updated_at = NOW()');
  const { rows: [row] } = await pool.query(`UPDATE coexistence.workflow_agent_memory SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  await audit({ agentId: Number(id), entity: 'memory', entityId: row.id, action: 'update', before: memoryRow(before), after: m, userId });
  return memoryRow(row);
}

async function decideMemory(id, memoryId, decision, userId, edits = {}) {
  const { rows: [before] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_memory WHERE id = $1 AND agent_id = $2`, [Number(memoryId), Number(id)]);
  if (!before) throw new ServiceError(404, 'Memory item not found.');
  if (before.status !== 'pending_review') throw new ServiceError(409, 'Only items waiting for review can be approved or rejected.');
  const status = decision === 'approve' ? 'active' : 'archived';
  return updateMemory(id, memoryId, { ...edits, status }, userId);
}

async function deleteMemory(id, memoryId, userId) {
  const { rows } = await pool.query(`DELETE FROM coexistence.workflow_agent_memory WHERE id = $1 AND agent_id = $2 RETURNING *`, [Number(memoryId), Number(id)]);
  if (!rows.length) throw new ServiceError(404, 'Memory item not found.');
  await audit({ agentId: Number(id), entity: 'memory', entityId: rows[0].id, action: 'delete', before: memoryRow(rows[0]), userId });
  return { ok: true };
}

// ── runs ──────────────────────────────────────────────────────────────────────

async function listRuns(id, { status, trigger, from, to, limit = 50, offset = 0 } = {}) {
  const params = [Number(id)];
  const where = ['r.agent_id = $1'];
  if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
  if (trigger) { params.push(trigger); where.push(`r.trigger_type = $${params.length}`); }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); where.push(`r.queued_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { params.push(to); where.push(`r.queued_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const { rows } = await pool.query(
    `SELECT r.*, COUNT(*) OVER() AS total FROM coexistence.workflow_agent_runs r WHERE ${where.join(' AND ')} ORDER BY r.queued_at DESC LIMIT ${lim} OFFSET ${off}`, params);
  return { runs: rows.map(runRow), total: rows[0] ? Number(rows[0].total) : 0 };
}

async function getRun(runId) {
  const { rows: [r] } = await pool.query(
    `SELECT r.*, a.name AS agent_name FROM coexistence.workflow_agent_runs r JOIN coexistence.workflow_agents a ON a.id = r.agent_id WHERE r.id = $1`, [Number(runId)]);
  if (!r) throw new ServiceError(404, 'Run not found.');
  const [actions, deliveries] = await Promise.all([
    pool.query(`SELECT id, action_type, lead_id, status FROM coexistence.workflow_agent_actions WHERE run_id = $1 ORDER BY id`, [r.id]),
    pool.query(`SELECT destination_index, type, status, error, detail, created_at FROM coexistence.workflow_agent_deliveries WHERE run_id = $1 ORDER BY destination_index`, [r.id]),
  ]);
  return {
    ...runRow(r), agent_name: r.agent_name, output: r.output, output_markdown: r.output_markdown, validation_errors: r.validation_errors,
    checks: r.checks, config_snapshot: r.config_snapshot,
    actions: actions.rows.map(a => ({ id: String(a.id), action_type: a.action_type, contact_id: a.lead_id == null ? null : String(a.lead_id), status: a.status })),
    deliveries: deliveries.rows.map(d => ({ ...d, created_at: toIst(d.created_at) })),
  };
}

async function getRunSteps(runId) {
  const { rows } = await pool.query(
    `SELECT id, step, type, tool_key, input, output, duration_ms, created_at FROM coexistence.workflow_agent_run_steps WHERE run_id = $1 ORDER BY step, id`, [Number(runId)]);
  return rows.map(s => ({ ...s, id: String(s.id), created_at: toIst(s.created_at) }));
}

async function cancelRun(runId, userId) {
  const { rows } = await pool.query(
    `UPDATE coexistence.workflow_agent_runs SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), error = COALESCE(error, 'Cancelled by a user.')
      WHERE id = $1 AND status IN ('queued', 'running') RETURNING agent_id`, [Number(runId)]);
  if (!rows.length) throw new ServiceError(409, 'Only a queued or running run can be cancelled.');
  await audit({ agentId: rows[0].agent_id, entity: 'run', entityId: Number(runId), action: 'cancel', userId });
  return { ok: true };
}

async function listPresets() {
  const { rows } = await pool.query(
    `SELECT preset_key, name, description, icon, sort_order, config FROM coexistence.workflow_agent_presets
      WHERE preset_key = ANY($1::text[]) ORDER BY sort_order`, [PRESETS.map(p => p.preset_key)]);
  const list = rows.length ? rows : PRESETS;
  return list.map(p => ({
    preset_key: p.preset_key, name: p.name, description: p.description, icon: p.icon,
    trigger_summary: triggerSummary(p.config.triggers), tools_enabled: (p.config.tool_config || []).filter(t => t.enabled).length,
  }));
}

module.exports = {
  ServiceError, audit, listAgents, getAgent, createAgent, getPreset, applySetup, updateAgent, deleteAgent, saveVersion, listVersions, getVersion, restoreVersion,
  listMemory, createMemory, updateMemory, decideMemory, deleteMemory, listRuns, getRun, getRunSteps, cancelRun, listPresets,
  triggerSummary, runRow, agentRow, MEMORY_KINDS, MEMORY_TOKEN_BUDGET,
};
