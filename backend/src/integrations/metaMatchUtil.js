// Advanced-matching normalisation + hashing for Meta server-side events.
//
// Meta matches a server event to a person by SHA-256 of a *normalised* value.
// Normalisation is not cosmetic: hashing "+91 98765-43210" and hashing
// "919876543210" produce different digests, so a value normalised the wrong way
// matches nobody and fails silently — the event is accepted, it just never
// attributes. Every match key therefore has an explicit rule below.
//
// Used by the Conversion Leads Optimisation (CLO) client.

const crypto = require('crypto');

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
}

function normalizeMatchValue(key, raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  if (!v) return null;

  switch (key) {
    case 'em':
      v = v.toLowerCase();
      // A value that isn't an email would hash to a guaranteed non-match, so
      // drop it rather than send noise (the sale profile sometimes carries a
      // name in the email box).
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
    case 'ph': {
      v = v.replace(/\D/g, '');
      // Meta wants the country code included. A bare 10-digit Indian mobile
      // would match nobody, so assume +91 — every number in this CRM is stored
      // with its country code already, this only rescues hand-entered rows.
      if (v.length === 10) v = `91${v}`;
      return v.length >= 8 ? v : null;
    }
    case 'fn':
    case 'ln':
    case 'ct':
      return v.toLowerCase().replace(/[^a-z]/g, '') || null;
    case 'st':
      return v.toLowerCase().replace(/[^a-z]/g, '') || null;
    case 'zp':
      v = v.replace(/\s/g, '').toLowerCase();
      return v || null;
    case 'country':
      v = v.toLowerCase().replace(/[^a-z]/g, '');
      return v.length === 2 ? v : null;
    case 'external_id':
      return v;
    default:
      return v;
  }
}

module.exports = { sha256, normalizeMatchValue };
