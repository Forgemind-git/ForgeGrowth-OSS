import { useState, useEffect } from "react";
import { api } from "../../api.js";
import { showToast } from "../../Toast.jsx";

// Shared tags + custom-field definitions for Contacts, the profile and automation
// steps. One module-level cache so a tag/field created in one place shows up
// everywhere without a reload.
let state = { tags: [], categories: [], fields: [], types: [], loaded: false };
const subs = new Set();
const emit = () => subs.forEach(fn => fn(state));
let loading = null;

export function reloadCrm() {
  loading = Promise.all([
    api.getTags().catch(() => ({ tags: [] })),
    api.getCategories().catch(() => ({ categories: [] })),
    api.crm.fields().catch(() => ({ fields: [], types: [] })),
  ]).then(([t, c, f]) => {
    state = { tags: t.tags || [], categories: c.categories || [], fields: f.fields || [], types: f.types || [], loaded: true };
    emit();
  });
  return loading;
}

export function useCrm() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!state.loaded && !loading) reloadCrm();
    return () => subs.delete(setS);
  }, []);
  return s;
}

const PALETTE = ["#dc2626", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#db2777", "#0891b2", "#4b5563"];

// Create a tag by name (returns its id) — used by every tag picker's "Create" row.
export async function createTag(name) {
  try {
    const t = await api.crm.createTag(name, PALETTE[state.tags.length % PALETTE.length]);
    if (!state.tags.some(x => x.id === t.id)) { state = { ...state, tags: [...state.tags, t] }; emit(); }
    return t.id;
  } catch (e) { showToast(e.message, "error"); return null; }
}

// Create a custom field by name (returns its key).
export async function createField(name, type = "text") {
  try {
    const f = await api.crm.createField({ name, type });
    state = { ...state, fields: [...state.fields, { ...f, used: 0 }] }; emit();
    return f.key;
  } catch (e) { showToast(e.message, "error"); return null; }
}

// Rename / recolour a tag in place.
export async function updateTag(id, body) {
  try {
    const t = await api.crm.updateTag(id, body);
    state = { ...state, tags: state.tags.map(x => x.id === id ? { ...x, ...t } : x) }; emit();
    return true;
  } catch (e) { showToast(e.message, "error"); return false; }
}

// Delete a tag (the server also takes it off every contact). Returns how many contacts had it.
export async function deleteTag(id) {
  try {
    const r = await api.crm.deleteTag(id);
    state = { ...state, tags: state.tags.filter(x => x.id !== id) }; emit();
    return r.removedFrom ?? 0;
  } catch (e) { showToast(e.message, "error"); return null; }
}

export const TAG_COLORS = PALETTE;

export const tagOptions = (tags) => tags.map(t => ({ value: t.id, label: t.name }));
export const fieldOptions = (fields) => fields.filter(f => !f.archived).map(f => ({ value: f.key, label: f.name, sublabel: f.type }));
