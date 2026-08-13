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

/**
 * A stage colour is chosen by an admin for RECOGNITION, not for legibility, and
 * the badge was using that raw colour as its text on a 10% tint of itself.
 * Measured on live data, the green stage rendered #22C55E on a near-white tint:
 * 2.09:1, i.e. a label you have to lean in to read.
 *
 * So the hue is kept and only the LIGHTNESS is retargeted — dark enough to read
 * on a pale tint, light enough to read on a dark one. Every colour an admin can
 * pick lands somewhere readable, rather than only the ones that happened to be
 * dark already.
 */
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s, l };
}

export function stageTextColor(color, isDark) {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return isDark ? '#D4D4D4' : '#4B5563';
  const { h, s, l } = hexToHsl(color);
  // Saturation is also lifted a little on very grey inputs so the hue survives
  // the lightness change instead of collapsing to a neutral.
  const sat = Math.max(0.25, Math.min(s, 0.85));
  const L = isDark ? Math.max(l, 0.72) : Math.min(l, 0.34);
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(L * 100)}%)`;
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
  return src.find(s => s.stageKey === key) || { stageKey: key, label: key, color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' };
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
    stageMeta: (key) => cfg.stages.find(s => s.stageKey === key) || { stageKey: key, label: key, color: 'var(--c-textSecondary, #6B7280)', bg: 'var(--c-surfaceMuted, #F1F1EE)' },
    loading: !_cfg,
    refresh: refreshFunnelConfig,
  };
}
