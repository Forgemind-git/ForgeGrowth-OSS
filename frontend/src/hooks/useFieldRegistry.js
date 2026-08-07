// Entity-field registry loader — the frontend source of truth for the
// configurable Leads / Sales Log / Transaction fields (migration 097). Same
// module-cache + subscription pattern as useFunnelConfig: one fetch shared by
// every consumer, primed at login in App.jsx, with a hardcoded fallback that
// mirrors the seeded system rows so the tables render identically to the
// pre-registry app if the request fails.

import { useState, useEffect } from 'react';
import { api } from '../api';

// Mirrors the migration-097 seeds — keep in step if the seeds ever change.
const sys = (fieldKey, label, fieldType, showInLeads, showInSales, options = []) =>
  ({ id: null, fieldKey, label, fieldType, options, required: false, isSystem: true, systemColumn: fieldKey, showInLeads, showInSales, sortOrder: 0 });
const FALLBACK = {
  lead: [
    sys('name', 'Name', 'text', true, true),
    sys('whatsapp_number', 'WhatsApp', 'phone', true, true),
    sys('email', 'Email', 'email', false, true),
    sys('age', 'Age', 'number', false, true),
    sys('profession', 'Profession', 'dropdown', false, true,
      ['Student', 'Engineer', 'Freelancer', 'Business Owner', 'Marketing Professional', 'Other']),
    sys('pincode', 'Pincode', 'text', false, true),
    sys('city', 'City', 'text', false, false),
    sys('source', 'Source', 'dropdown', true, true),
    sys('stage', 'Stage', 'dropdown', true, false),
    sys('follow_up_count', 'Follow-ups', 'number', true, false),
    sys('assigned_to', 'BDA', 'text', true, false),
    sys('paid_course', 'Product', 'text', false, true),
    sys('total_paid', 'Total Paid', 'number', false, true),
    sys('payment_date', 'Payment Date', 'date', false, false),
    sys('created_at', 'Arrived', 'date', true, false),
    sys('last_activity_at', 'Last Activity', 'date', true, false),
  ],
  transaction: [
    sys('payment_date', 'Date', 'date', false, true),
    sys('amount', 'Amount', 'number', false, true),
    sys('method', 'Method', 'dropdown', false, true, ['UPI', 'Card', 'Cash', 'Bank Transfer', 'Other']),
    sys('notes', 'Note', 'textarea', false, true),
    sys('product', 'Product', 'text', false, false),
  ],
  saleTokens: [
    { key: 'total_paid', label: 'Total paid' },
    { key: 'product', label: 'Product' },
    { key: 'last_amount', label: 'Last payment amount' },
    { key: 'last_payment_date', label: 'Last payment date' },
    { key: 'payment_date', label: 'First payment date' },
    { key: 'installments', label: 'Payments count' },
    { key: 'method', label: 'Last payment method' },
  ],
};

let _reg = null;
let _inflight = null;
const _subs = new Set();

function normalize(raw) {
  const lead = raw?.fields?.lead?.length ? raw.fields.lead : FALLBACK.lead;
  const transaction = raw?.fields?.transaction?.length ? raw.fields.transaction : FALLBACK.transaction;
  const saleTokens = raw?.saleTokens?.length ? raw.saleTokens : FALLBACK.saleTokens;
  return { lead, transaction, saleTokens };
}

function notify() { _subs.forEach(cb => cb(_reg)); }

export async function loadFieldRegistry(force = false) {
  if (_reg && !force) return _reg;
  if (_inflight && !force) return _inflight;
  _inflight = api.entityFields.list()
    .then(raw => { _reg = normalize(raw); notify(); return _reg; })
    .catch(() => { _reg = normalize(null); notify(); return _reg; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

// Call after an admin edits fields so all mounted views refresh.
export function refreshFieldRegistry() { return loadFieldRegistry(true); }

// Synchronous getter for non-React code (fallback until the first load).
export function fieldLabel(entity, key, fallback) {
  const list = (_reg || normalize(null))[entity] || [];
  const f = list.find(x => x.fieldKey === key);
  return f ? f.label : (fallback !== undefined ? fallback : key);
}

// Reactive hook — re-renders the consumer when the shared registry loads/changes.
export function useFieldRegistry() {
  const [reg, setReg] = useState(_reg || normalize(null));
  useEffect(() => {
    const cb = (r) => setReg(r || normalize(null));
    _subs.add(cb);
    if (_reg) setReg(_reg); else loadFieldRegistry();
    return () => { _subs.delete(cb); };
  }, []);
  return {
    lead: reg.lead,
    transaction: reg.transaction,
    saleTokens: reg.saleTokens,
    leadCustom: reg.lead.filter(f => !f.isSystem),
    transactionCustom: reg.transaction.filter(f => !f.isSystem),
    byKey: (entity, key) => (reg[entity] || []).find(f => f.fieldKey === key) || null,
    label: (entity, key, fallback) => {
      const f = (reg[entity] || []).find(x => x.fieldKey === key);
      return f ? f.label : (fallback !== undefined ? fallback : key);
    },
    loading: !_reg,
    refresh: refreshFieldRegistry,
  };
}

// Render a JSONB bag value for a table cell / meta row.
export function formatFieldValue(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
