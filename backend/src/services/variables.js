// Unified variable resolver — one grammar for per-lead tokens across message
// senders, replacing the follow-up engine's private fillVars chain.
//
// Namespaces:
//   {{name}} {{first_name}} {{phone}} {{email}} {{source}} {{stage}}
//       — legacy aliases, byte-compatible with the old fillVars (the 'there'
//         fallbacks and empty-string behaviour are pinned by unit tests).
//   {{lead.<field_key>}}   — any Leads-table field: system fields resolve from
//         the leads row, custom fields from leads.custom_fields.
//   {{sale.<token>}}       — the lead's sales data: computed tokens (SALE_TOKENS)
//         plus transaction custom fields, read from the latest installment.
//   {{form.<slug>.<key>}}  — the lead's LATEST submission to that form.
//
// Policies (kept from fillVars):
//   * Unknown tokens are left as-is at SEND time — but routes/followUps.js now
//     REJECTS unknown tokens at save time via stepTokenError(), which is what
//     stops a typo from ever reaching a customer as literal braces.
//   * {{1}}-style positional template variables are NOT matched here (the token
//     grammar requires a leading letter/underscore) — they are Meta's grammar,
//     filled by the component builders.
//   * sale.* / form.* need context the caller loads via loadTokenContext();
//     when that context is absent the token is left as-is rather than guessed.

const pool = require('../db');
const cfg = require('./funnelConfig');
const registry = require('./fieldRegistry');

// Leading letter/underscore so {{1}} positionals never match.
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g;

const LEGACY_KEYS = new Set(['name', 'first_name', 'phone', 'email', 'source', 'stage']);

// Computed sale tokens — served to the frontend picker by GET /entity-fields
// so the two lists can never drift.
const SALE_TOKENS = [
  { key: 'total_paid', label: 'Total paid' },
  { key: 'product', label: 'Product' },
  { key: 'last_amount', label: 'Last payment amount' },
  { key: 'last_payment_date', label: 'Last payment date' },
  { key: 'payment_date', label: 'First payment date' },
  { key: 'installments', label: 'Payments count' },
  { key: 'method', label: 'Last payment method' },
];
const SALE_TOKEN_KEYS = new Set(SALE_TOKENS.map(t => t.key));

// Lead keys the resolver derives without needing a registry row.
const LEAD_DERIVED_KEYS = new Set([
  'name', 'first_name', 'phone', 'whatsapp_number', 'email', 'source', 'stage',
  'city', 'age', 'profession', 'pincode', 'paid_course', 'payment_date',
  'assigned_to', 'created_at', 'last_activity_at', 'follow_up_count', 'total_paid',
]);

// ── formatting helpers ───────────────────────────────────────────────────────
const rupees = (paise) => '₹' + (Math.round(Number(paise || 0)) / 100).toLocaleString('en-IN');

function fmtDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// JSONB bag values can be arrays (checkbox), booleans, numbers or strings.
function stringifyVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => String(x)).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// Case-tolerant bag lookup: keys are minted lowercase, but form answers store
// whatever key the form carries.
function bagGet(bag, key) {
  if (!bag || typeof bag !== 'object') return undefined;
  if (key in bag) return bag[key];
  const lower = String(key).toLowerCase();
  const hit = Object.keys(bag).find(k => k.toLowerCase() === lower);
  return hit === undefined ? undefined : bag[hit];
}

function stageLabel(lead) {
  if (lead?.stage_label) return lead.stage_label;
  const s = cfg.stages().find(x => x.stageKey === lead?.stage);
  return s?.label || lead?.stage || '';
}

// ── extraction ───────────────────────────────────────────────────────────────
function extractTokens(text) {
  const out = new Set();
  if (!text) return [];
  let m;
  const re = new RegExp(TOKEN_RE.source, 'g');
  while ((m = re.exec(String(text)))) out.add(m[1]);
  return [...out];
}

// ── resolution ───────────────────────────────────────────────────────────────
function resolveLeadKey(key, lead) {
  const nm = (lead?.name || '').trim();
  switch (key) {
    case 'name': return nm;
    case 'first_name': return nm.split(/\s+/)[0] || '';
    case 'phone':
    case 'whatsapp_number': return lead?.whatsapp_number || '';
    case 'email': return lead?.email || '';
    case 'source': return lead?.source || '';
    case 'stage': return stageLabel(lead);
    case 'city': return lead?.city || '';
    case 'age': return lead?.age == null ? '' : String(lead.age);
    case 'profession': return lead?.profession || '';
    case 'pincode': return lead?.pincode || '';
    case 'paid_course': return lead?.paid_course || '';
    case 'payment_date': return fmtDate(lead?.payment_date);
    case 'assigned_to': return lead?.assigned_user_name || lead?.assigned_bda || '';
    case 'created_at': return fmtDate(lead?.created_at);
    case 'last_activity_at': return fmtDate(lead?.last_activity_at);
    case 'follow_up_count': return String(lead?.follow_up_count ?? 0);
    case 'total_paid': return rupees(lead?.paid_amount_paise);
    default: return undefined;
  }
}

function resolveSaleKey(key, lead, saleData) {
  switch (key) {
    case 'total_paid': return rupees(saleData.totalPaidPaise);
    case 'product': return lead?.paid_course || saleData.lastProductLabel || '';
    case 'payment_date': return fmtDate(lead?.payment_date);
    case 'last_amount': return saleData.last ? rupees(saleData.last.amountPaise) : '';
    case 'last_payment_date': return saleData.last ? fmtDate(saleData.last.date) : '';
    case 'installments': return String(saleData.count || 0);
    case 'method': return saleData.last?.method || '';
    // The transaction entity's SYSTEM rows must all resolve — validation
    // accepts any registry-known key, and an accepted token is a promise.
    // amount/notes read the LATEST installment (their per-row meaning).
    case 'amount': return saleData.last ? rupees(saleData.last.amountPaise) : '';
    case 'notes': return saleData.last?.notes || '';
    default: {
      if (registry.isKnownField('transaction', key)) return stringifyVal(bagGet(saleData.latestCustom, key));
      return undefined;
    }
  }
}

// resolveTokens(text, { lead, saleData?, formAnswers? }) → filled string.
function resolveTokens(text, ctx = {}) {
  if (!text) return text;
  const lead = ctx.lead || {};
  return String(text).replace(TOKEN_RE, (raw, rawName) => {
    const lower = rawName.toLowerCase();

    // Legacy aliases — byte-compatible with the old fillVars.
    if (LEGACY_KEYS.has(lower)) {
      const nm = (lead.name || '').trim();
      switch (lower) {
        case 'name': return nm || 'there';
        case 'first_name': return (nm.split(/\s+/)[0] || '') || 'there';
        case 'phone': return lead.whatsapp_number || '';
        case 'email': return lead.email || '';
        case 'source': return lead.source || '';
        case 'stage': return stageLabel(lead);
      }
    }

    if (lower.startsWith('lead.')) {
      const key = rawName.slice(5);
      // total_paid prefers the LIVE deduped union when the caller loaded it —
      // the stamped leads.paid_amount_paise can lag a reconcile (the CTWA
      // drill-in learned this the hard way). neededContext() flags this token
      // so the engine loads saleData for it.
      if (key.toLowerCase() === 'total_paid' && ctx.saleData !== undefined) {
        return rupees((ctx.saleData || {}).totalPaidPaise);
      }
      const derived = resolveLeadKey(key.toLowerCase(), lead);
      if (derived !== undefined) return derived;
      if (registry.isKnownField('lead', key.toLowerCase())) {
        return stringifyVal(bagGet(lead.custom_fields, key));
      }
      return raw; // unknown key — leave as-is (save-time validation refuses it)
    }

    if (lower.startsWith('sale.')) {
      if (ctx.saleData === undefined) return raw; // context not loaded
      const v = resolveSaleKey(rawName.slice(5).toLowerCase(), lead, ctx.saleData || {});
      return v === undefined ? raw : v;
    }

    if (lower.startsWith('form.')) {
      if (ctx.formAnswers === undefined) return raw; // context not loaded
      const parts = rawName.split('.');
      if (parts.length < 3) return raw;
      const slug = parts[1];
      const key = parts.slice(2).join('.');
      const answers = ctx.formAnswers[slug];
      if (answers === undefined) return raw;
      return stringifyVal(bagGet(answers, key));
    }

    return raw; // unknown token — left as-is (fillVars policy)
  });
}

// ── context loading (called by the send engine only when tokens need it) ─────
function neededContext(texts) {
  const tokens = new Set();
  for (const t of texts) extractTokens(t).forEach(n => tokens.add(n));
  const names = [...tokens];
  return {
    // lead.total_paid also loads sale data so it reads the live union rather
    // than the stamped column.
    sale: names.some(n => n.toLowerCase().startsWith('sale.') || n.toLowerCase() === 'lead.total_paid'),
    formSlugs: [...new Set(
      names.filter(n => n.toLowerCase().startsWith('form.'))
        .map(n => n.split('.')[1]).filter(Boolean)
    )],
  };
}

async function loadSaleData(leadId) {
  // Same payment_id dedupe as everything else that reads razorpay_events.
  // Lazy require — routes/leads.js also requires services at its top level.
  const { RZP_CAPTURED } = require('../routes/leads');
  const { rows } = await pool.query(
    `SELECT amount_paise, pay_date, method, kind, custom_fields, product_label, notes FROM (
       SELECT amount_paise, created_at::date AS pay_date,
              COALESCE(NULLIF(method,''),'Razorpay') AS method, 'razorpay' AS kind,
              NULL::jsonb AS custom_fields, NULL::text AS product_label, NULL::text AS notes, created_at AS ord
         FROM ( ${RZP_CAPTURED('matched_lead_id = $1')} ) rz
       UNION ALL
       SELECT amount_paise, payment_date, COALESCE(NULLIF(method,''),'Manual'), 'manual',
              custom_fields, product_label, notes, created_at
         FROM coexistence.sales_log WHERE lead_id = $1
     ) t ORDER BY pay_date DESC NULLS LAST, ord DESC`,
    [leadId]);
  const last = rows[0] || null;
  const latestCustomRow = rows.find(r => r.custom_fields && Object.keys(r.custom_fields).length);
  const lastProduct = rows.find(r => r.product_label);
  return {
    totalPaidPaise: rows.reduce((a, r) => a + Number(r.amount_paise || 0), 0),
    count: rows.length,
    last: last ? { amountPaise: Number(last.amount_paise || 0), date: last.pay_date, method: last.method, notes: last.notes } : null,
    latestCustom: latestCustomRow ? latestCustomRow.custom_fields : {},
    lastProductLabel: lastProduct ? lastProduct.product_label : null,
  };
}

async function loadFormAnswers(leadId, slugs) {
  const out = {};
  for (const slug of slugs) out[slug] = {}; // loaded-but-no-submission → empty
  if (!slugs.length) return out;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (f.slug) f.slug, s.answers
       FROM coexistence.lead_form_submissions s
       JOIN coexistence.lead_forms f ON f.id = s.form_id
      WHERE s.lead_id = $1 AND f.slug = ANY($2)
      ORDER BY f.slug, s.submitted_at DESC`,
    [leadId, slugs]);
  for (const r of rows) out[r.slug] = r.answers || {};
  return out;
}

// One call for the engine: which extra context do these texts need, loaded.
async function loadTokenContext(texts, leadId) {
  const need = neededContext(texts);
  const ctx = {};
  if (need.sale) ctx.saleData = await loadSaleData(leadId);
  if (need.formSlugs.length) ctx.formAnswers = await loadFormAnswers(leadId, need.formSlugs);
  return ctx;
}

// ── save-time validation (routes/followUps.js) ───────────────────────────────
// Returns a human error string for the first invalid token, else null. Async
// because form.* tokens are checked against the live lead_forms rows.
async function stepTokenError(texts) {
  const tokens = new Set();
  for (const t of texts) extractTokens(t).forEach(n => tokens.add(n));

  const formChecks = new Map(); // slug → Set(keys)
  for (const rawName of tokens) {
    const lower = rawName.toLowerCase();
    if (LEGACY_KEYS.has(lower)) continue;
    if (lower.startsWith('lead.')) {
      const key = lower.slice(5);
      if (LEAD_DERIVED_KEYS.has(key) || registry.isKnownField('lead', key)) continue;
      return `Unknown variable {{lead.${key}}} — pick variables from the Insert variable menu (or add the field in Admin Settings → Fields).`;
    }
    if (lower.startsWith('sale.')) {
      const key = lower.slice(5);
      if (SALE_TOKEN_KEYS.has(key) || registry.isKnownField('transaction', key)) continue;
      return `Unknown variable {{sale.${key}}} — pick variables from the Insert variable menu.`;
    }
    if (lower.startsWith('form.')) {
      const parts = rawName.split('.');
      if (parts.length < 3) return `{{${rawName}}} is incomplete — form variables look like {{form.<form>.<field>}}.`;
      const slug = parts[1];
      const key = parts.slice(2).join('.');
      if (!formChecks.has(slug)) formChecks.set(slug, new Set());
      formChecks.get(slug).add(key);
      continue;
    }
    return `Unknown variable {{${rawName}}} — pick variables from the Insert variable menu.`;
  }

  for (const [slug, keys] of formChecks) {
    const { rows: [form] } = await pool.query(
      `SELECT fields FROM coexistence.lead_forms WHERE slug = $1`, [slug]);
    if (!form) return `The form behind {{form.${slug}.…}} no longer exists.`;
    const known = new Set((Array.isArray(form.fields) ? form.fields : []).map(f => String(f.key)));
    for (const key of keys) {
      if (![...known].some(k => k === key || k.toLowerCase() === key.toLowerCase())) {
        return `The form "${slug}" has no field "${key}" — re-pick the variable from the Insert variable menu.`;
      }
    }
  }
  return null;
}

module.exports = {
  TOKEN_RE,
  SALE_TOKENS,
  LEGACY_KEYS,
  LEAD_DERIVED_KEYS,
  extractTokens,
  resolveTokens,
  neededContext,
  loadSaleData,
  loadFormAnswers,
  loadTokenContext,
  stepTokenError,
  // exported for tests
  fmtDate,
  rupees,
  stringifyVal,
};
