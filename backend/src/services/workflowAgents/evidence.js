// Evidence verification: every quote an agent puts in its output must come from a
// real message. Checked server-side after the model answers — a quote that is not in
// the message it cites (or cites a message that does not exist, or belongs to a
// different lead) is sent back to the model to fix, and stripped if it still fails.

const { KEY10 } = require('./sql');
const { key10 } = require('./format');

const norm = (s) => String(s == null ? '' : s)
  .replace(/<\/?customer_message>/gi, ' ')
  .replace(/[“”"‘’'`]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Walk any output shape; an object holding message_id + quote is a piece of evidence. */
function collectEvidence(value, { contactId = null, path = '$' } = {}, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectEvidence(v, { contactId, path: `${path}[${i}]` }, out));
  } else if (value && typeof value === 'object') {
    const here = value.contact_id != null ? String(value.contact_id) : contactId;
    if (typeof value.message_id === 'string' && typeof value.quote === 'string') {
      out.push({ path, message_id: value.message_id, quote: value.quote, contact_id: here, holder: value });
    }
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') collectEvidence(v, { contactId: here, path: `${path}.${k}` }, out);
    }
  }
  return out;
}

/** Does `quote` appear in `source`? An ellipsis may join fragments quoted in order. */
function quoteMatches(quote, source) {
  const q = norm(quote);
  const s = norm(source);
  if (!q || !s) return false;
  if (s.includes(q)) return true;
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  let from = 0;
  for (const p of parts) {
    const at = s.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

async function checkEvidence(pool, output) {
  const items = collectEvidence(output);
  if (!items.length) return { total: 0, verified: 0, failures: [] };
  const ids = [...new Set(items.map(i => i.message_id))];
  const { rows } = await pool.query(
    `SELECT ch.message_id, ${KEY10('ch.contact_number')} AS k10, ch.message_body,
            (SELECT a.text FROM coexistence.chat_message_artifacts a
              WHERE a.source = 'chat' AND a.message_key = ch.message_id AND a.kind = 'transcript' AND a.status = 'ok' LIMIT 1) AS transcript,
            (SELECT a.text FROM coexistence.chat_message_artifacts a
              WHERE a.source = 'chat' AND a.message_key = ch.message_id AND a.kind IN ('vision', 'document') AND a.status = 'ok' LIMIT 1) AS description
       FROM coexistence.chat_history ch WHERE ch.message_id = ANY($1::text[])`, [ids]);
  const byId = new Map(rows.map(r => [r.message_id, r]));
  const leadIds = [...new Set(items.map(i => i.contact_id).filter(v => /^\d+$/.test(String(v))))].map(Number);
  const leadKeys = new Map();
  if (leadIds.length) {
    const { rows: ls } = await pool.query(`SELECT id, whatsapp_number FROM coexistence.leads WHERE id = ANY($1::bigint[])`, [leadIds]);
    for (const l of ls) leadKeys.set(String(l.id), key10(l.whatsapp_number));
  }
  const failures = [];
  for (const item of items) {
    const row = byId.get(item.message_id);
    if (!row) { failures.push({ path: item.path, message_id: item.message_id, reason: 'message_not_found' }); continue; }
    if (item.contact_id && leadKeys.has(item.contact_id) && leadKeys.get(item.contact_id) !== row.k10) {
      failures.push({ path: item.path, message_id: item.message_id, reason: 'message_belongs_to_another_lead' });
      continue;
    }
    if (![row.message_body, row.transcript, row.description].some(src => quoteMatches(item.quote, src))) {
      failures.push({ path: item.path, message_id: item.message_id, reason: 'quote_not_in_message' });
    }
  }
  return { total: items.length, verified: items.length - failures.length, failures };
}

/**
 * Remove failing evidence entries in place (only array members can be removed
 * without breaking a required field). Returns how many were removed.
 */
function stripFailedEvidence(output, failures) {
  const bad = new Set(failures.map(f => f.path));
  let removed = 0;
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const p = `${path}[${i}]`;
        if (bad.has(p)) { value.splice(i, 1); removed += 1; } else walk(value[i], p);
      }
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (v && typeof v === 'object') walk(v, `${path}.${k}`);
    }
  };
  walk(output, '$');
  return removed;
}

module.exports = { collectEvidence, checkEvidence, quoteMatches, stripFailedEvidence, norm };
