// Data scope: the hard limits on what a workflow agent's tools can see.
//
// ⚠ SCOPE IS ENFORCED HERE, IN SQL, NEVER IN THE PROMPT. Every read tool builds its
// WHERE clause through leadScopeSql()/messageScopeSql(), and every tool that takes
// a lead id checks it with assertLeadInScope() first. A model that asks for a lead
// outside scope gets {"error":"out_of_scope"} back as DATA, so it can recover —
// it is never told what the lead contains.
//
// Every user-supplied value leaves this file as a bound parameter via `add()`.

const { normKey } = require('./format');
const { KEY10, OWNER_SQL } = require('./sql');

const CHAT_TYPES = ['lead_bot', 'lead_rep', 'broadcast', 'voice_note', 'media', 'internal_note'];
// Retired with the Marketing section: still found in stored scopes, dropped quietly.
const RETIRED_CHAT_TYPES = ['ad_referral'];

const WON_STAGE_MODES = ['include', 'exclude', 'exclude_unless_outstanding'];

const DEFAULT_SCOPE = Object.freeze({
  business_numbers: ['all'],
  teams: ['all'],
  rep_user_ids: ['all'],
  funnel_stages: ['all'],
  sources: ['all'],
  chat_types: [...CHAT_TYPES],
  lookback_days: 14,
  mask_pii: true,
  exclude_opted_out: true,
  exclude_tags: ['do_not_contact', 'test'],
  won_stages: 'include',
});

const isAll = (list) => !Array.isArray(list) || list.length === 0 || list.some(v => String(v).toLowerCase() === 'all');

function strList(v) {
  if (!Array.isArray(v)) return ['all'];
  const out = [...new Set(v.map(x => String(x == null ? '' : x).trim()).filter(Boolean))];
  return out.length ? out : ['all'];
}

/**
 * Normalise a stored/submitted scope. Unknown keys are dropped; invalid values fall
 * back to the safest default rather than widening access.
 * @returns {{ scope: object, errors: string[] }}
 */
function normalizeScope(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const scope = {
    business_numbers: strList(r.business_numbers).map(v => (v.toLowerCase() === 'all' ? 'all' : v.replace(/\D/g, ''))).filter(Boolean),
    teams: strList(r.teams),
    rep_user_ids: strList(r.rep_user_ids),
    funnel_stages: strList(r.funnel_stages),
    sources: strList(r.sources),
    chat_types: Array.isArray(r.chat_types) ? [...new Set(r.chat_types.map(String))].filter(t => CHAT_TYPES.includes(t)) : [...DEFAULT_SCOPE.chat_types],
    lookback_days: DEFAULT_SCOPE.lookback_days,
    mask_pii: r.mask_pii === undefined ? true : r.mask_pii !== false,
    exclude_opted_out: r.exclude_opted_out === undefined ? true : r.exclude_opted_out !== false,
    exclude_tags: Array.isArray(r.exclude_tags) ? [...new Set(r.exclude_tags.map(normKey).filter(Boolean))] : [...DEFAULT_SCOPE.exclude_tags],
    won_stages: WON_STAGE_MODES.includes(r.won_stages) ? r.won_stages : 'include',
  };
  if (Array.isArray(r.chat_types)) {
    const bad = r.chat_types.map(String).filter(t => !CHAT_TYPES.includes(t) && !RETIRED_CHAT_TYPES.includes(t));
    if (bad.length) errors.push(`Unknown chat type(s): ${bad.join(', ')}. Valid: ${CHAT_TYPES.join(', ')}.`);
  }
  if (r.lookback_days !== undefined) {
    const n = Number(r.lookback_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) errors.push('lookback_days must be a whole number from 1 to 365.');
    else scope.lookback_days = n;
  }
  for (const key of ['teams', 'rep_user_ids']) {
    if (!isAll(scope[key])) {
      const bad = scope[key].filter(v => v !== 'unassigned' && !/^\d+$/.test(v));
      if (bad.length) errors.push(`${key} must be user/team ids (or "all"${key === 'rep_user_ids' ? ' / "unassigned"' : ''}); got ${bad.join(', ')}.`);
      scope[key] = scope[key].filter(v => v === 'unassigned' || /^\d+$/.test(v));
      if (!scope[key].length) scope[key] = ['__none__'];
    }
  }
  if (!isAll(scope.business_numbers) && scope.business_numbers.some(n => n.length < 10)) {
    errors.push('business_numbers must be full WhatsApp numbers with country code, or "all".');
  }
  return { scope, errors };
}

/**
 * WHERE fragment (starting with AND) restricting leads alias `l` to the scope.
 * `ownerCol` must be an expression that resolves the lead's owner user id — pass
 * the column produced by OWNER_SQL when the query joins it, or null to compute it.
 */
function leadScopeSql(scope, add, { alias = 'l', ownerExpr = null } = {}) {
  const k10 = KEY10(`${alias}.whatsapp_number`);
  const parts = [];

  if (scope.exclude_opted_out) parts.push(`COALESCE(${alias}.opted_out, FALSE) = FALSE`);

  // "Pretend today is": a test run must not see leads that did not exist yet.
  if (scope.as_of instanceof Date) parts.push(`${alias}.created_at <= ${add(scope.as_of)}`);

  if (!isAll(scope.funnel_stages)) parts.push(`${alias}.stage = ANY(${add(scope.funnel_stages)}::text[])`);

  if (!isAll(scope.sources)) {
    parts.push(`lower(btrim(COALESCE(${alias}.source, ''))) = ANY(${add(scope.sources.map(s => s.toLowerCase().trim()))}::text[])`);
  }

  if (scope.won_stages === 'exclude' || scope.won_stages === 'exclude_unless_outstanding') {
    const won = `${alias}.stage IN (SELECT fs.stage_key FROM coexistence.funnel_stages fs WHERE fs.is_won AND fs.active)`;
    if (scope.won_stages === 'exclude') parts.push(`NOT (${won})`);
    else {
      // Outstanding = a known product price above everything paid.
      parts.push(`(NOT (${won}) OR EXISTS (
        SELECT 1 FROM coexistence.courses c
         WHERE ${alias}.paid_course IS NOT NULL AND lower(btrim(c.name)) = lower(btrim(${alias}.paid_course))
           AND c.default_price_paise > 0
           AND COALESCE(${alias}.payment_status, '') <> 'paid'
           AND c.default_price_paise > COALESCE((
             SELECT SUM(sl.amount_paise) FROM coexistence.sales_log sl WHERE sl.lead_id = ${alias}.id), 0)))`);
    }
  }

  if (!isAll(scope.business_numbers)) {
    parts.push(`EXISTS (SELECT 1 FROM coexistence.contacts sc
                         WHERE ${KEY10('sc.contact_number')} = ${k10}
                           AND sc.wa_number = ANY(${add(scope.business_numbers)}::text[]))`);
  }

  if (scope.exclude_tags.length) {
    // contacts.tags is per THREAD; a tag on any of the person's threads excludes them.
    parts.push(`NOT EXISTS (
      SELECT 1 FROM coexistence.contacts tc, jsonb_array_elements(COALESCE(tc.tags, '[]'::jsonb)) t
       WHERE ${KEY10('tc.contact_number')} = ${k10}
         AND (trim(both '_' from regexp_replace(lower(COALESCE(t->>'name', '')), '[^a-z0-9]+', '_', 'g')) = ANY(${add(scope.exclude_tags)}::text[])
           OR trim(both '_' from regexp_replace(lower(COALESCE(t->>'id', '')), '[^a-z0-9]+', '_', 'g')) = ANY(${add(scope.exclude_tags)}::text[])))`);
  }

  const owner = ownerExpr || `(${OWNER_SQL(alias)})`;
  if (!isAll(scope.rep_user_ids)) {
    const ids = scope.rep_user_ids.filter(v => /^\d+$/.test(v)).map(Number);
    const unassigned = scope.rep_user_ids.includes('unassigned');
    const conds = [];
    if (ids.length) conds.push(`${owner} = ANY(${add(ids)}::bigint[])`);
    if (unassigned) conds.push(`${owner} IS NULL`);
    parts.push(conds.length ? `(${conds.join(' OR ')})` : 'FALSE');
  }
  if (!isAll(scope.teams)) {
    const ids = scope.teams.filter(v => /^\d+$/.test(v)).map(Number);
    parts.push(ids.length
      ? `${owner} IN (SELECT u.id FROM coexistence.forgecrm_users u WHERE u.team_id = ANY(${add(ids)}::bigint[]))`
      : 'FALSE');
  }

  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/** Chat types a message-returning tool may include, intersected with a requested subset. */
function allowedChatTypes(scope, requested) {
  const allowed = scope.chat_types;
  if (!Array.isArray(requested) || !requested.length) return allowed;
  return requested.map(String).filter(t => allowed.includes(t));
}

/**
 * Throws nothing. Returns true when lead `leadId` exists AND passes the scope.
 * Used by every tool that accepts a lead id, before it reads anything else.
 */
async function leadInScope(pool, scope, leadId) {
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const params = [id];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.leads l WHERE l.id = $1 ${leadScopeSql(scope, add)}`, params);
  return rows.length > 0;
}

/** Lower bound of the lookback window, relative to the run's "now". */
function lookbackStart(scope, now = new Date()) {
  return new Date(now.getTime() - scope.lookback_days * 24 * 60 * 60 * 1000);
}

module.exports = {
  CHAT_TYPES, WON_STAGE_MODES, DEFAULT_SCOPE, isAll, normalizeScope, leadScopeSql,
  allowedChatTypes, leadInScope, lookbackStart,
};
