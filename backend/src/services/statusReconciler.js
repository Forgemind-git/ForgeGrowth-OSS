// Self-healing delivery/read tick reconciliation.
//
// The live path (webhook.js) updates a message's status the instant a receipt
// arrives. But a receipt can still be "lost" in one narrow race: Meta's
// sent/delivered/read webhook can land in the split-second *before* markSent()
// swaps the local placeholder id for Meta's real wamid — so the UPDATE keyed on
// the wamid matches no row. The receipt is still safely stored in webhook_events.
//
// This re-derives each outbound message's true status from the stored receipts
// and upgrades any chat_history row that's behind (MONOTONIC — never downgrades),
// then emits `message-status` so any open chat advances the tick live. Bounded
// to a recent window so the periodic run stays cheap.
//
// A receipt's wamid does not always equal the stored message_id (see util/wamid),
// so receipts are correlated to rows by their stable message hash, not by id.
const pool = require('../db');
const bus = require('../events');
const { wamidHash } = require('../util/wamid');

async function reconcileMessageStatuses({ windowDays = 2 } = {}) {
  const { rows: receipts } = await pool.query(`
    SELECT s->>'id' AS message_id,
           CASE WHEN bool_or(s->>'status' IN ('read','played')) THEN 'read'
                WHEN bool_or(s->>'status' = 'delivered')        THEN 'delivered'
                WHEN bool_or(s->>'status' = 'failed')           THEN 'failed'
                WHEN bool_or(s->>'status' = 'sent')             THEN 'sent' END AS best_status
    FROM coexistence.webhook_events we,
         jsonb_array_elements(we.payload->'entry') e,
         jsonb_array_elements(e->'changes') ch,
         jsonb_array_elements(ch->'value'->'statuses') s
    WHERE we.payload_kind = 'statuses'
      AND we.received_at > NOW() - ($1 || ' days')::interval
    GROUP BY s->>'id'
  `, [String(windowDays)]);

  const { rows: outbound } = await pool.query(`
    SELECT message_id FROM coexistence.chat_history
     WHERE direction = 'outgoing'
       AND timestamp > NOW() - ($1 || ' days')::interval
  `, [String(windowDays)]);

  // hash → the message_id actually stored on the row
  const byHash = new Map();
  for (const o of outbound) {
    const h = wamidHash(o.message_id);
    if (h) byHash.set(h, o.message_id);
  }

  const targets = [];
  const statuses = [];
  for (const r of receipts) {
    if (!r.best_status) continue;
    const stored = byHash.get(wamidHash(r.message_id)) || r.message_id;
    targets.push(stored);
    statuses.push(r.best_status);
  }
  if (targets.length === 0) return 0;

  const { rows } = await pool.query(`
    UPDATE coexistence.chat_history ch
       SET status = b.best_status
      FROM (SELECT unnest($1::text[]) AS message_id, unnest($2::text[]) AS best_status) b
     WHERE ch.message_id = b.message_id
       AND ch.direction = 'outgoing'
       AND (CASE b.best_status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
         > (CASE ch.status      WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'played' THEN 3 WHEN 'failed' THEN 2 ELSE 0 END)
    RETURNING ch.wa_number, ch.contact_number, ch.message_id, ch.status
  `, [targets, statuses]);

  for (const r of rows) {
    bus.emit('message-status', {
      waNumber: r.wa_number,
      contactNumber: r.contact_number,
      messageId: r.message_id,
      status: r.status,
    });
  }
  return rows.length;
}

module.exports = { reconcileMessageStatuses };
