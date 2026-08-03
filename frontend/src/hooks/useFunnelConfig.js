// Funnel config loader — the single frontend source of truth for the
// user-configurable funnel stages + sources (migration 064). One fetch is
// cached module-wide and shared with every consumer via a tiny subscription,
// so a rename/recolor in Funnel Settings reflects everywhere without prop-drilling
// or Context. The old hardcoded values remain as a pre-load fallback so nothing
// flashes empty.

import { useState, useEffect } from 'react';
import { api } from '../api';

// Fallback = the historical hardcoded stages (kept so the UI renders instantly
// before /funnel/config resolves, and if the request fails).
const FALLBACK_STAGES = [
  { stageKey: 'new',       label: 'New',         color: '#2563eb', isFunnel: true,  isWon: false },
  { stageKey: 'contacted', label: 'Contacted',   color: '#7c3aed', isFunnel: true,  isWon: false },
  { stageKey: 'engaged',   label: 'Engaged',     color: '#0891b2', isFunnel: true,  isWon: false },
  { stageKey: 'hot',       label: 'Hot',         color: '#E8A317', isFunnel: true,  isWon: false },
  { stageKey: 'enrolled',  label: 'Enrolled',    color: '#0F6E56', isFunnel: true,  isWon: true },
  { stageKey: 'cold_lost', label: 'Cold / Lost', color: '#6B7280', isFunnel: false, isWon: false },
];

let _cfg = null;           // { stages:[...], sources:[{id,label}] }
let _inflight = null;
const _subs = new Set();

// Derive a soft badge background from a stage color (10% alpha).
function bgOf(color) {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return '#F1F1EE';
  return color + '1A';
}

function normalize(cfg) {
  const stages = (cfg?.stages?.length ? cfg.stages : FALLBACK_STAGES).map(s => ({
    id: s.id,
    stageKey: s.stageKey,
    label: s.label,
    color: s.color || '#6B7280',
    bg: bgOf(s.color),
    isFunnel: s.isFunnel !== false,
    isWon: s.isWon === true,
    orderIndex: s.orderIndex,
  }));
  const sources = (cfg?.sources || []).map(s => (typeof s === 'string' ? s : s.label));
  return { stages, sources };
}

function notify() { _subs.forEach(cb => cb(_cfg)); }

export async function loadFunnelConfig(force = false) {
  if (_cfg && !force) return _cfg;
  if (_inflight && !force) return _inflight;
  _inflight = api.funnel.config()
    .then(raw => { _cfg = normalize(raw); notify(); return _cfg; })
    .catch(() => { _cfg = normalize(null); notify(); return _cfg; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

// Call after an admin edits stages/sources so all mounted views refresh.
export function refreshFunnelConfig() { return loadFunnelConfig(true); }

// Synchronous getters (fallback until the first load resolves).
export function funnelStageMeta(key) {
  const src = _cfg?.stages || normalize(null).stages;
  return src.find(s => s.stageKey === key) || { stageKey: key, label: key, color: '#6B7280', bg: '#F1F1EE' };
}
export function funnelStageOrder() { return (_cfg?.stages || normalize(null).stages).map(s => s.stageKey); }
export function funnelSourceOptions() { return _cfg?.sources || []; }

// Reactive hook — re-renders the consumer when the shared config loads/changes.
export function useFunnelConfig() {
  const [cfg, setCfg] = useState(_cfg || normalize(null));
  useEffect(() => {
    const cb = (c) => setCfg(c || normalize(null));
    _subs.add(cb);
    if (_cfg) setCfg(_cfg); else loadFunnelConfig();
    return () => { _subs.delete(cb); };
  }, []);
  return {
    stages: cfg.stages,
    sources: cfg.sources,
    funnelStages: cfg.stages.filter(s => s.isFunnel),
    wonStages: cfg.stages.filter(s => s.isWon),
    stageMeta: (key) => cfg.stages.find(s => s.stageKey === key) || { stageKey: key, label: key, color: '#6B7280', bg: '#F1F1EE' },
    loading: !_cfg,
    refresh: refreshFunnelConfig,
  };
}
