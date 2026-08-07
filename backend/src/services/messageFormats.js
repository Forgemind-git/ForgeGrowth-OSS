// Message-format cache + inbound matching (migration 093).
//
// A message format is a labelled pre-filled WhatsApp opener. The label is the
// tracking unit: put format "IG Reel 12" on one video and "Pricing Page" on the
// site, and every conversation each produces is attributable.
//
// HOW ATTRIBUTION WORKS. There is no query string on a wa.me link — the only
// thing that survives the hop into WhatsApp is the message text itself. So the
// text IS the tracking token: when the customer sends the pre-filled opener, we
// match the inbound body back to the format that authored it.
//
// Matching is deliberately conservative, because a false match mislabels a real
// customer's source and there is nothing downstream to catch it:
//
//   - Candidates are restricted to formats published on the number that
//     RECEIVED the message. A format for number A must never absorb traffic on
//     number B.
//   - exact  — the normalised body equals the format's opener. Unambiguous, and
//              the DB's unique index guarantees only one active format can own
//              a given opener.
//   - prefix — the customer typed extra after the opener.
//   - contains — the opener appears inside a longer message.
//   Both loose modes require the opener to be >= MIN_LOOSE_LEN characters. A
//   two-word format like "hi there" would otherwise claim nearly every inbound
//   message in the inbox.
//   - Longest opener wins, so a specific format beats a generic one.
//
// The cache is read SYNCHRONOUSLY from the webhook path, so it is loaded at
// boot and refreshed on every write — the same shape as services/funnelConfig.

const pool = require('../db');

let _formats = [];   // [{ id, label, messageNorm, targets:[{id,phone}] }]
let _loadedAt = 0;

// Openers shorter than this can only ever match EXACTLY.
const MIN_LOOSE_LEN = 20;

// MUST stay identical to the SQL expression behind wa_links.message_norm
// (a GENERATED column): collapse whitespace runs, trim, lowercase — in that
// order. If these two drift, formats simply stop matching, silently.
function normalizeMessage(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function digits(s) {
  return String(s == null ? '' : s).replace(/[^0-9]/g, '');
}

async function refreshMessageFormats() {
  try {
    const { rows } = await pool.query(
      `SELECT l.id,
              l.name  AS label,
              l.message_norm,
              COALESCE(
                json_agg(json_build_object('id', t.id, 'phone', t.phone_number)
                         ORDER BY t.sort_order, t.id)
                FILTER (WHERE t.id IS NOT NULL),
                '[]'
              ) AS targets
         FROM coexistence.wa_links l
         LEFT JOIN coexistence.wa_link_targets t ON t.format_id = l.id
        WHERE l.active = TRUE AND l.message_norm <> ''
        GROUP BY l.id
        ORDER BY length(l.message_norm) DESC, l.id`
    );
    _formats = rows.map(r => ({
      id: Number(r.id),
      label: r.label,
      messageNorm: r.message_norm,
      targets: (r.targets || []).map(t => ({ id: Number(t.id), phone: digits(t.phone) })),
    }));
    _loadedAt = Date.now();
  } catch (err) {
    // Never throw from a cache refresh — a broken refresh must not take down
    // the write that triggered it, nor message ingestion.
    console.error('[message-formats] refresh failed:', err.message);
  }
  return _formats;
}

// Synchronous. Returns null (no attribution) or
// { formatId, label, targetId, matchKind }.
function matchInbound({ body, waNumber } = {}) {
  const norm = normalizeMessage(body);
  if (!norm || !_formats.length) return null;
  const wa = digits(waNumber);

  const candidates = [];
  for (const f of _formats) {
    const target = f.targets.find(t => t.phone === wa);
    if (target) candidates.push({ f, target });
  }
  if (!candidates.length) return null;

  const hit = (c, matchKind) => ({
    formatId: c.f.id, label: c.f.label, targetId: c.target.id, matchKind,
  });

  for (const c of candidates) if (norm === c.f.messageNorm) return hit(c, 'exact');
  for (const c of candidates) {
    if (c.f.messageNorm.length >= MIN_LOOSE_LEN && norm.startsWith(c.f.messageNorm)) return hit(c, 'prefix');
  }
  for (const c of candidates) {
    if (c.f.messageNorm.length >= MIN_LOOSE_LEN && norm.includes(c.f.messageNorm)) return hit(c, 'contains');
  }
  return null;
}

// Append-only. ON CONFLICT on message_id so a webhook replay (Meta retries, or
// our own replay tool) can never count one conversation twice.
async function recordHit({
  formatId, targetId, waNumber, contactNumber, messageId,
  leadId = null, isNewLead = false, matchKind = null,
} = {}) {
  if (!formatId) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.wa_link_hits
         (format_id, target_id, wa_number, contact_number, message_id,
          lead_id, is_new_lead, match_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING id`,
      [formatId, targetId || null, waNumber || null, contactNumber || null,
       messageId || null, leadId, !!isNewLead, matchKind]
    );
    return rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    console.error('[message-formats] recordHit failed:', err.message);
    return null;
  }
}

// A format's label becomes a lead's funnel Source, so it has to exist in the
// managed funnel_sources list or the Leads/Pipeline source pickers would not
// offer a value the funnel is already full of.
async function ensureFunnelSource(label) {
  const name = String(label || '').trim();
  if (!name) return;
  try {
    await pool.query(
      `INSERT INTO coexistence.funnel_sources (label) VALUES ($1)
       ON CONFLICT (label) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [name]
    );
    await require('./funnelConfig').refreshFunnelConfig();
  } catch (err) {
    console.error('[message-formats] ensureFunnelSource failed:', err.message);
  }
}

// Renaming a format's label re-points the leads THIS format produced, and no
// others. wa_link_hits is what makes that precise: without it we would have to
// rewrite every lead whose source string happens to match, which would also
// catch leads attributed by some other route that shared the name.
async function renameFunnelSource(oldLabel, newLabel, formatId) {
  const from = String(oldLabel || '').trim();
  const to = String(newLabel || '').trim();
  if (!from || !to || from === to) return 0;
  try {
    const { rowCount } = await pool.query(
      `UPDATE coexistence.leads
          SET source = $1, updated_at = NOW()
        WHERE source = $2
          AND id IN (SELECT lead_id FROM coexistence.wa_link_hits
                      WHERE format_id = $3 AND lead_id IS NOT NULL)`,
      [to, from, formatId]
    );
    // Retire the old source only when nothing is left on it — another format or
    // a hand-typed lead may still legitimately be using that label.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.leads WHERE source = $1`, [from]
    );
    if (rows[0].n === 0) {
      await pool.query(
        `UPDATE coexistence.funnel_sources SET active = FALSE, updated_at = NOW() WHERE label = $1`,
        [from]
      );
    }
    await ensureFunnelSource(to);
    return rowCount;
  } catch (err) {
    console.error('[message-formats] renameFunnelSource failed:', err.message);
    return 0;
  }
}

function loadedAt() { return _loadedAt; }
function cached() { return _formats; }

module.exports = {
  normalizeMessage, digits,
  refreshMessageFormats, matchInbound, recordHit,
  ensureFunnelSource, renameFunnelSource,
  loadedAt, cached, MIN_LOOSE_LEN,
};
