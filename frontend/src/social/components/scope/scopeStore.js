import { useState, useEffect } from "react";
import { api } from "../../api.js";

// "My accounts" — the per-user preset of platforms + Instagram accounts that every
// page opens with. Tokens: 'instagram|<id>' for Instagram, the bare platform key
// for single-account platforms ('facebook', 'youtube', 'threads', 'linkedin').
// Empty = no preset (everything). One module cache shared by all pages.
let state = { loaded: false, tokens: [], accounts: [] };
const subs = new Set();
const emit = () => subs.forEach(fn => fn(state));
let loading = null;

function load() {
  loading = Promise.all([
    api.getScope().catch(() => ({ tokens: [] })),
    api.getPublishAccounts().catch(() => []),
  ]).then(([s, accts]) => {
    state = { loaded: true, tokens: s.tokens || [], accounts: Array.isArray(accts) ? accts : [] };
    emit();
  });
  return loading;
}

export async function saveScope(tokens) {
  const r = await api.saveScope(tokens);
  state = { ...state, tokens: r.tokens || [] };
  emit();
}

// Helpers derived from the token list.
export function scopeInfo(s = state) {
  const tokens = s.tokens || [];
  const active = tokens.length > 0;
  const platforms = [...new Set(tokens.map(t => t.split("|")[0]))];
  const igIds = tokens.filter(t => t.startsWith("instagram|")).map(t => t.split("|")[1]);
  return {
    active, tokens, platforms, igIds,
    // Platform shown? (no preset → every platform)
    hasPlatform: (p) => !active || platforms.includes(p),
    // Instagram account shown? (no preset, or no IG accounts picked → every IG account)
    hasIg: (id) => !active || !igIds.length || igIds.includes(String(id)),
    firstPlatform: (order) => (active ? order.find(p => platforms.includes(p)) : null) || null,
  };
}

export function useScope() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!state.loaded && !loading) load();
    return () => subs.delete(setS);
  }, []);
  return { ...s, ...scopeInfo(s) };
}
