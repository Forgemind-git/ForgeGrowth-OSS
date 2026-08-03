// Funnel config cache — the single in-process source of truth for the
// configurable funnel stages + sources (migration 064). Loaded once at startup
// and refreshed on every settings write, so route handlers can read the current
// stage list SYNCHRONOUSLY (the app used to hardcode these as module consts).
//
// Shared by routes/leads.js (validation, board, conversion) and routes/funnel.js
// (CRUD + chart). Kept in services/ to avoid a circular require between the two.

const pool = require('../db');

let _stages = [];   // active stages, ordered: [{ stageKey,label,color,orderIndex,isFunnel,isWon }]
let _sources = [];  // active sources: [{ id, label }]
let _loadedAt = 0;

function mapStage(r) {
  return {
    id: Number(r.id),
    stageKey: r.stage_key,
    label: r.label,
    color: r.color || null,
    orderIndex: Number(r.order_index),
    isFunnel: r.is_funnel,
    isWon: r.is_won,
    isDefault: r.is_default,
  };
}

// Reload the cache from the DB. Call after any funnel_stages / funnel_sources
// mutation and once at startup.
async function refreshFunnelConfig() {
  const { rows: st } = await pool.query(
    `SELECT id, stage_key, label, color, order_index, is_funnel, is_won, is_default
       FROM coexistence.funnel_stages
      WHERE active = TRUE
      ORDER BY order_index, id`
  );
  _stages = st.map(mapStage);
  const { rows: sr } = await pool.query(
    `SELECT id, label FROM coexistence.funnel_sources WHERE active = TRUE ORDER BY label`
  );
  _sources = sr.map(r => ({ id: Number(r.id), label: r.label }));
  _loadedAt = Date.now();
  // Keep the managed "Funnel Stage" tag catalog in step with the config. Hooked
  // HERE rather than at the nine funnel-write call sites that each already call
  // this function — one integration point, and any future funnel write is
  // covered for free. Deliberately not awaited: a stage rename must not block
  // on rewriting every contacts.tags blob, and a tag failure must never fail
  // the funnel write that triggered it.
  require('./funnelTags').syncFunnelTagCatalog()
    .catch(err => console.error('[funnel-tags] catalog sync failed:', err.message));
  return { stages: _stages, sources: _sources };
}

// Getters — synchronous reads of the cached config.
function stages() { return _stages; }                                   // all active stages, ordered
function stageKeys() { return _stages.map(s => s.stageKey); }           // all active keys
function funnelStageKeys() {                                            // funnel-progression keys, in order
  return _stages.filter(s => s.isFunnel).map(s => s.stageKey);
}
function wonStageKeys() { return _stages.filter(s => s.isWon).map(s => s.stageKey); }
function sources() { return _sources; }
function isValidStage(key) { return _stages.some(s => s.stageKey === key); }
function loadedAt() { return _loadedAt; }

module.exports = {
  refreshFunnelConfig,
  stages,
  stageKeys,
  funnelStageKeys,
  wonStageKeys,
  sources,
  isValidStage,
  loadedAt,
};
