// Shared helpers for the AI agent.
//
// This file used to also build the CRM write-back tools (save the contact's
// name / tags / custom fields). That capability was removed from the agent —
// an agent here collects data into a form's table rather than editing the
// contact record — so only the two helpers the engine still calls remain.

const pool = require('../db');

// Normalize a field name to a stable key. MUST match fieldVarKey() in
// engine/automationEngine.js + the frontend so name→field resolution agrees.
function fieldVarKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function resolveWaNumber(waAccountId) {
  if (!waAccountId) return null;
  const { rows } = await pool.query(
    'SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE id = $1',
    [waAccountId],
  );
  return rows[0]?.display_phone_number || null;
}

module.exports = { resolveWaNumber, fieldVarKey };
