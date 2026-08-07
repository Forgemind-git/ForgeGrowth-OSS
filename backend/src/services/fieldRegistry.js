// Entity-field registry cache — the single in-process source of truth for the
// configurable Leads / Sales Log / Transaction fields (migration 097). Same
// shape as services/funnelConfig.js: loaded once at startup, refreshed on
// every registry write, read SYNCHRONOUSLY by route handlers, the variable
// resolver and the CSV exports.
//
// Kept in services/ so routes/leads.js, routes/entityFields.js and
// services/variables.js can all require it without a cycle.

const pool = require('../db');

let _fields = { lead: [], transaction: [] }; // active fields, ordered
let _loadedAt = 0;

function mapField(r) {
  return {
    id: Number(r.id),
    entity: r.entity,
    fieldKey: r.field_key,
    label: r.label,
    fieldType: r.field_type,
    options: Array.isArray(r.options) ? r.options : [],
    required: r.required === true,
    isSystem: r.is_system === true,
    systemColumn: r.system_column || null,
    showInLeads: r.show_in_leads === true,
    showInSales: r.show_in_sales === true,
    sortOrder: Number(r.sort_order || 0),
  };
}

// Reload the cache from the DB. Call after any entity_fields mutation and once
// at startup (ensureEntityFieldTables ends by calling this).
async function refreshFieldRegistry() {
  const { rows } = await pool.query(
    `SELECT id, entity, field_key, label, field_type, options, required,
            is_system, system_column, show_in_leads, show_in_sales, sort_order
       FROM coexistence.entity_fields
      WHERE deleted_at IS NULL
      ORDER BY sort_order, id`
  );
  const next = { lead: [], transaction: [] };
  for (const r of rows) {
    const f = mapField(r);
    if (next[f.entity]) next[f.entity].push(f);
  }
  _fields = next;
  _loadedAt = Date.now();
  return _fields;
}

// Getters — synchronous reads of the cached config.
function fields(entity) { return _fields[entity] || []; }
function customFields(entity) { return fields(entity).filter(f => !f.isSystem); }
function fieldByKey(entity, key) { return fields(entity).find(f => f.fieldKey === key) || null; }
function isKnownField(entity, key) { return fields(entity).some(f => f.fieldKey === key); }
function labelFor(entity, key, fallback) {
  const f = fieldByKey(entity, key);
  return f ? f.label : (fallback !== undefined ? fallback : key);
}
function loadedAt() { return _loadedAt; }

// TEST-ONLY: inject a registry snapshot without a database. Never call from
// application code — the cache must only ever reflect entity_fields rows.
function _setFieldsForTests(next) {
  _fields = { lead: [], transaction: [], ...next };
}

module.exports = {
  refreshFieldRegistry,
  fields,
  customFields,
  fieldByKey,
  isKnownField,
  labelFor,
  loadedAt,
  _setFieldsForTests,
};
