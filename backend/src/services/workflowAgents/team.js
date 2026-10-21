// Module settings and team setup: business name, costs, and the rep model
// the data map found missing (teams, team leads, employee ids, working hours, and
// which rep holds which WhatsApp number, with history).

const pool = require('../../db');
const { toIst } = require('./format');
const { modelCatalog } = require('./modelClient');
const { ServiceError, audit } = require('./service');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanHours(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object') throw new ServiceError(400, 'Working hours must be { days: [1..7], start: "HH:MM", end: "HH:MM" }.');
  const days = [...new Set((Array.isArray(v.days) ? v.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
  if (!days.length) throw new ServiceError(400, 'Pick at least one working day.');
  if (!HHMM.test(String(v.start)) || !HHMM.test(String(v.end))) throw new ServiceError(400, 'Working hours need a start and end time as HH:MM.');
  if (String(v.start) >= String(v.end)) throw new ServiceError(400, 'The working day must end after it starts.');
  return { days, start: String(v.start), end: String(v.end) };
}

async function getSettings() {
  const { rows: [s] } = await pool.query(`SELECT * FROM coexistence.workflow_agent_settings WHERE id = 1`);
  const { rows: creds } = await pool.query(`SELECT id, label, enabled_models FROM coexistence.ai_models WHERE provider = 'anthropic' ORDER BY id`);
  return {
    business_name: s?.business_name || null,
    default_working_hours: s?.default_working_hours || null,
    usd_to_inr: Number(s?.usd_to_inr || 88),
    rate_card: s?.rate_card || {},
    anthropic_credentials: creds.map(c => ({ id: c.id, label: c.label || `Anthropic #${c.id}` })),
    anthropic_env_key: !!process.env.ANTHROPIC_API_KEY,
    models: modelCatalog(),
  };
}

async function updateSettings(patch, userId) {
  const sets = [];
  const params = [];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.business_name !== undefined) add('business_name', patch.business_name ? String(patch.business_name).trim().slice(0, 120) : null);
  if (patch.default_working_hours !== undefined) add('default_working_hours', JSON.stringify(cleanHours(patch.default_working_hours)));
  if (patch.usd_to_inr !== undefined) {
    const n = Number(patch.usd_to_inr);
    if (!(n > 0 && n < 1000)) throw new ServiceError(400, 'The USD→INR rate must be a positive number.');
    add('usd_to_inr', n);
  }
  if (patch.rate_card !== undefined) {
    const card = {};
    for (const [model, r] of Object.entries(patch.rate_card || {})) {
      const input = Number(r?.input); const output = Number(r?.output);
      if (!(input >= 0) || !(output >= 0)) throw new ServiceError(400, `Rates for ${model} must be numbers (USD per million tokens).`);
      card[model] = { input, output };
    }
    add('rate_card', JSON.stringify(card));
  }
  if (sets.length) {
    await pool.query(`UPDATE coexistence.workflow_agent_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, params);
    await audit({ agentId: null, entity: 'settings', action: 'update', after: patch, userId });
  }
  return getSettings();
}

async function getTeamSetup() {
  const [users, teams, accounts, assignments] = await Promise.all([
    pool.query(`SELECT id, username, COALESCE(display_name, username) AS name, role, is_active, team_id, employee_id, working_hours, notify_phone FROM coexistence.forgecrm_users ORDER BY is_active DESC, name`),
    pool.query(`SELECT id, name, lead_user_id FROM coexistence.rep_teams ORDER BY name`),
    pool.query(`SELECT id, display_name, display_phone_number, is_active FROM coexistence.whatsapp_accounts ORDER BY id`),
    pool.query(`SELECT id, whatsapp_account_id, user_id, valid_from, valid_to, note FROM coexistence.rep_number_assignments ORDER BY valid_from DESC LIMIT 500`),
  ]);
  return {
    reps: users.rows.map(u => ({
      id: String(u.id), username: u.username, name: u.name, role: u.role, active: u.is_active,
      team_id: u.team_id == null ? null : String(u.team_id), employee_id: u.employee_id, working_hours: u.working_hours, notify_phone: u.notify_phone,
    })),
    teams: teams.rows.map(t => ({ id: String(t.id), name: t.name, lead_user_id: t.lead_user_id == null ? null : String(t.lead_user_id) })),
    numbers: accounts.rows.map(a => {
      const current = assignments.rows.find(x => String(x.whatsapp_account_id) === String(a.id) && x.valid_to == null);
      return { id: String(a.id), label: a.display_name, number: a.display_phone_number, active: a.is_active, current_rep_user_id: current ? String(current.user_id) : null, since: current ? toIst(current.valid_from) : null };
    }),
    assignment_history: assignments.rows.map(x => ({ id: String(x.id), business_number_id: String(x.whatsapp_account_id), rep_user_id: String(x.user_id), from: toIst(x.valid_from), to: toIst(x.valid_to), note: x.note })),
  };
}

async function upsertTeam({ id = null, name, lead_user_id = null }, userId) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw new ServiceError(400, 'Team name is required.');
  const lead = lead_user_id == null || lead_user_id === '' ? null : Number(lead_user_id);
  try {
    const { rows: [t] } = id
      ? await pool.query(`UPDATE coexistence.rep_teams SET name = $2, lead_user_id = $3, updated_at = NOW() WHERE id = $1 RETURNING id`, [Number(id), n, lead])
      : await pool.query(`INSERT INTO coexistence.rep_teams (name, lead_user_id) VALUES ($1, $2) RETURNING id`, [n, lead]);
    if (!t) throw new ServiceError(404, 'Team not found.');
    await audit({ agentId: null, entity: 'team', entityId: t.id, action: id ? 'update' : 'create', after: { name: n, lead_user_id: lead }, userId });
    return getTeamSetup();
  } catch (e) {
    if (e.code === '23505') throw new ServiceError(409, `A team called "${n}" already exists.`);
    if (e.code === '23503') throw new ServiceError(400, 'That team lead does not exist.');
    throw e;
  }
}

async function deleteTeam(id, userId) {
  const { rows } = await pool.query(`DELETE FROM coexistence.rep_teams WHERE id = $1 RETURNING id, name`, [Number(id)]);
  if (!rows.length) throw new ServiceError(404, 'Team not found.');
  await audit({ agentId: null, entity: 'team', entityId: rows[0].id, action: 'delete', before: { name: rows[0].name }, userId });
  return getTeamSetup();
}

async function updateRep(repId, patch, userId) {
  const sets = [];
  const params = [Number(repId)];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.team_id !== undefined) add('team_id', patch.team_id == null || patch.team_id === '' ? null : Number(patch.team_id));
  if (patch.employee_id !== undefined) add('employee_id', patch.employee_id ? String(patch.employee_id).trim().slice(0, 40) : null);
  if (patch.working_hours !== undefined) add('working_hours', patch.working_hours === null ? null : JSON.stringify(cleanHours(patch.working_hours)));
  if (patch.notify_phone !== undefined) {
    const d = String(patch.notify_phone || '').replace(/\D/g, '');
    if (d && d.length < 10) throw new ServiceError(400, 'The notify phone needs a country code and number.');
    add('notify_phone', d || null);
  }
  if (!sets.length) return getTeamSetup();
  try {
    const { rowCount } = await pool.query(`UPDATE coexistence.forgecrm_users SET ${sets.join(', ')} WHERE id = $1`, params);
    if (!rowCount) throw new ServiceError(404, 'User not found.');
  } catch (e) {
    if (e.code === '23503') throw new ServiceError(400, 'That team does not exist.');
    throw e;
  }
  await audit({ agentId: null, entity: 'rep', entityId: Number(repId), action: 'update', after: patch, userId });
  return getTeamSetup();
}

/** Hand a business number to a rep (or to nobody). The previous holder's period is closed, never deleted. */
async function assignNumber(accountId, repUserId, userId, note = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [acc] } = await client.query(`SELECT id FROM coexistence.whatsapp_accounts WHERE id = $1 FOR UPDATE`, [Number(accountId)]);
    if (!acc) throw new ServiceError(404, 'Business number not found.');
    const { rows: [open] } = await client.query(`SELECT id, user_id FROM coexistence.rep_number_assignments WHERE whatsapp_account_id = $1 AND valid_to IS NULL`, [acc.id]);
    const target = repUserId == null || repUserId === '' ? null : Number(repUserId);
    if (open && target != null && Number(open.user_id) === target) { await client.query('ROLLBACK'); return getTeamSetup(); }
    if (open) await client.query(`UPDATE coexistence.rep_number_assignments SET valid_to = NOW() WHERE id = $1`, [open.id]);
    if (target != null) {
      const { rows: [u] } = await client.query(`SELECT id FROM coexistence.forgecrm_users WHERE id = $1 AND is_active`, [target]);
      if (!u) throw new ServiceError(400, 'That rep is not an active user.');
      await client.query(`INSERT INTO coexistence.rep_number_assignments (whatsapp_account_id, user_id, valid_from, assigned_by, note) VALUES ($1,$2, NOW() + INTERVAL '1 millisecond', $3, $4)`,
        [acc.id, target, userId || null, note ? String(note).slice(0, 200) : null]);
    }
    await audit({ agentId: null, entity: 'number_assignment', entityId: acc.id, action: 'assign', before: { rep_user_id: open ? String(open.user_id) : null }, after: { rep_user_id: target == null ? null : String(target) }, userId }, client);
    await client.query('COMMIT');
    return getTeamSetup();
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { getSettings, updateSettings, getTeamSetup, upsertTeam, deleteTeam, updateRep, assignNumber, cleanHours };
