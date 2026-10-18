// Shared SQL for the workflow-agent tool layer. Every fragment here maps a concept
// from the brief onto the real schema documented in docs/agents/DATA_MAP.md; change
// a rule HERE and every tool follows, instead of eight tools each carrying a copy.

/** Last-10-digit person key. Byte-identical to the idx_*_key10 expression indexes. */
const KEY10 = (col) => `right(regexp_replace(${col},'\\D','','g'),10)`;

/**
 * Owner (rep user id) of lead alias `l`, first match wins (DATA_MAP §3):
 *   1. leads.assigned_user_id
 *   2. contacts.assigned_user_id on the person's most recently updated thread
 *   3. the rep assigned to the business number that received the lead's LATEST
 *      inbound, valid AT that message's timestamp (rep_number_assignments)
 *   4. NULL → "unassigned"
 * Never a phone number.
 */
const OWNER_SQL = (alias = 'l') => `COALESCE(
    ${alias}.assigned_user_id,
    (SELECT oc.assigned_user_id FROM coexistence.contacts oc
      WHERE ${KEY10('oc.contact_number')} = ${KEY10(`${alias}.whatsapp_number`)}
        AND oc.assigned_user_id IS NOT NULL
      ORDER BY oc.updated_at DESC NULLS LAST LIMIT 1),
    (SELECT (SELECT rna.user_id
               FROM coexistence.whatsapp_accounts owa
               JOIN coexistence.rep_number_assignments rna ON rna.whatsapp_account_id = owa.id
              WHERE owa.display_phone_number = li.wa_number
                AND rna.valid_from <= li.ts AND (rna.valid_to IS NULL OR rna.valid_to > li.ts)
              ORDER BY rna.valid_from DESC LIMIT 1)
       FROM (SELECT och.wa_number, och.timestamp AS ts FROM coexistence.chat_history och
              WHERE ${KEY10('och.contact_number')} = ${KEY10(`${alias}.whatsapp_number`)}
                AND och.direction = 'incoming'
              ORDER BY och.timestamp DESC LIMIT 1) li)
  )`;

/**
 * Owner of a message at the time it was sent: the lead's standing assignment first,
 * then the rep holding that business number at that moment.
 */
const MESSAGE_OWNER_SQL = (ch = 'ch') => `COALESCE(
    (SELECT ml.assigned_user_id FROM coexistence.leads ml
      WHERE ${KEY10('ml.whatsapp_number')} = ${KEY10(`${ch}.contact_number`)} AND ml.assigned_user_id IS NOT NULL LIMIT 1),
    (SELECT mc.assigned_user_id FROM coexistence.contacts mc
      WHERE mc.wa_number = ${ch}.wa_number AND mc.contact_number = ${ch}.contact_number AND mc.assigned_user_id IS NOT NULL LIMIT 1),
    (SELECT rna.user_id FROM coexistence.whatsapp_accounts mwa
       JOIN coexistence.rep_number_assignments rna ON rna.whatsapp_account_id = mwa.id
      WHERE mwa.display_phone_number = ${ch}.wa_number
        AND rna.valid_from <= ${ch}.timestamp AND (rna.valid_to IS NULL OR rna.valid_to > ${ch}.timestamp)
      ORDER BY rna.valid_from DESC LIMIT 1)
  )`;

/**
 * sender_type of a chat_history row (DATA_MAP §4.2). Precedence matters: a recorded
 * send_origin always beats a heuristic.
 */
const SENDER_TYPE_SQL = (ch = 'ch') => `CASE
    WHEN ${ch}.direction = 'incoming' THEN 'customer'
    WHEN ${ch}.send_origin = 'broadcast' THEN 'broadcast'
    WHEN ${ch}.send_origin = 'automation' THEN 'automation'
    WHEN ${ch}.send_origin = 'agent' THEN 'bot'
    WHEN ${ch}.send_origin = 'chat_reply' THEN 'human_agent'
    WHEN ${ch}.send_origin IN ('mcp', 'payment', 'template_test', 'follow_up') THEN 'system'
    WHEN EXISTS (SELECT 1 FROM coexistence.broadcast_logs sbl WHERE sbl.wa_message_id = ${ch}.message_id) THEN 'broadcast'
    WHEN COALESCE(${ch}.raw_payload->>'origin', '') <> 'outbound' THEN 'human_agent'
    WHEN EXISTS (SELECT 1 FROM coexistence.agent_runs sar
                  WHERE sar.final_reply = ${ch}.message_body
                    AND ${KEY10('sar.contact_number')} = ${KEY10(`${ch}.contact_number`)}
                    AND ${ch}.timestamp BETWEEN sar.started_at AND COALESCE(sar.ended_at, sar.started_at) + INTERVAL '2 minutes') THEN 'bot'
    WHEN EXISTS (SELECT 1 FROM coexistence.automation_execution_steps sst
                   JOIN coexistence.automation_executions sex ON sex.id = sst.execution_id
                  WHERE sst.node_type = 'message'
                    AND sst.created_at BETWEEN ${ch}.timestamp - INTERVAL '3 seconds' AND ${ch}.timestamp + INTERVAL '3 seconds'
                    AND ${KEY10('sex.contact_number')} = ${KEY10(`${ch}.contact_number`)}) THEN 'automation'
    ELSE 'unattributed'
  END`;

/** 'recorded' (stored by the app / Meta), 'inferred' (timing or text heuristic), 'unknown'. */
const SENDER_CONFIDENCE_SQL = (senderTypeCol, ch = 'ch', originExpr = `${ch}.raw_payload->>'origin'`) => `CASE
    WHEN ${ch}.direction = 'incoming' OR ${ch}.send_origin IS NOT NULL THEN 'recorded'
    WHEN ${senderTypeCol} = 'broadcast' THEN 'recorded'
    WHEN ${senderTypeCol} = 'human_agent' AND COALESCE(${originExpr}, '') <> 'outbound' THEN 'recorded'
    WHEN ${senderTypeCol} = 'unattributed' THEN 'unknown'
    ELSE 'inferred'
  END`;

/**
 * Classified messages. `filterSql` restricts the base rows (alias `ch`), e.g.
 * "ch.timestamp >= $2". Returns a SELECT whose rows carry everything the chat tools
 * need. Thread position (lead_bot vs lead_rep for an inbound) is computed over the
 * rows the filter admits, so callers widen their window a day to classify its edge.
 */
function classifiedMessagesSql(filterSql) {
  return `
    WITH base AS (
      SELECT ch.id, ch.message_id, ch.wa_number, ch.contact_number, ${KEY10('ch.contact_number')} AS k10,
             ch.direction, ch.message_type, ch.message_body, ch.status, ch.template_id, ch.timestamp,
             ch.media_mime_type, ch.media_filename, ch.media_size_bytes, ch.media_status,
             ch.context_message_id, ch.send_origin,
             ${SENDER_TYPE_SQL('ch')} AS sender_type,
             ch.raw_payload->>'origin' AS raw_origin
        FROM coexistence.chat_history ch
       WHERE ch.message_type NOT IN ('status', 'reaction', 'revoke')
         AND (${filterSql})
    ),
    grouped AS (
      SELECT b.*,
             COUNT(*) FILTER (WHERE b.direction = 'outgoing')
               OVER (PARTITION BY b.wa_number, b.k10 ORDER BY b.timestamp, b.id) AS out_grp,
             MAX(b.timestamp) FILTER (WHERE b.direction = 'incoming')
               OVER (PARTITION BY b.wa_number, b.k10 ORDER BY b.timestamp, b.id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_inbound_at
        FROM base b
    ),
    positioned AS (
      SELECT g.*,
             MAX(CASE WHEN g.direction = 'outgoing' THEN g.sender_type END)
               OVER (PARTITION BY g.wa_number, g.k10, g.out_grp) AS prev_out_sender
        FROM grouped g
    )
    SELECT p.id, p.message_id, p.wa_number, p.contact_number, p.k10, p.direction, p.message_type,
           p.message_body, p.status, p.template_id, mt.name AS template_name, p.timestamp,
           p.media_mime_type, p.media_filename, p.media_size_bytes, p.media_status, p.context_message_id,
           p.sender_type,
           ${SENDER_CONFIDENCE_SQL('p.sender_type', 'p', 'p.raw_origin')} AS sender_confidence,
           CASE
             WHEN p.direction = 'incoming' AND p.message_type = 'audio' THEN 'voice_note'
             WHEN p.direction = 'incoming' AND p.message_type IN ('image', 'document', 'video', 'sticker') THEN 'media'
             WHEN p.direction = 'outgoing' AND (p.sender_type = 'broadcast' OR p.message_type = 'template') THEN 'broadcast'
             WHEN p.direction = 'outgoing' AND p.sender_type = 'human_agent' THEN 'lead_rep'
             WHEN p.direction = 'outgoing' THEN 'lead_bot'
             WHEN p.prev_out_sender = 'human_agent' THEN 'lead_rep'
             ELSE 'lead_bot'
           END AS chat_type,
           (p.direction = 'incoming'
             OR (p.last_inbound_at IS NOT NULL AND p.timestamp - p.last_inbound_at < INTERVAL '24 hours')) AS is_within_24h_window,
           tr.text AS transcript, tr.language AS transcript_language, tr.status AS transcript_status,
           ds.text AS media_description,
           ${MESSAGE_OWNER_SQL('p')} AS rep_user_id
      FROM positioned p
      LEFT JOIN coexistence.message_templates mt ON mt.id = p.template_id
      LEFT JOIN coexistence.chat_message_artifacts tr
             ON tr.source = 'chat' AND tr.message_key = p.message_id AND tr.kind = 'transcript'
      LEFT JOIN LATERAL (
        SELECT a.text FROM coexistence.chat_message_artifacts a
         WHERE a.source = 'chat' AND a.message_key = p.message_id AND a.kind IN ('vision', 'document') AND a.status = 'ok'
         ORDER BY a.id DESC LIMIT 1
      ) ds ON TRUE`;
}

/** A body that is only the webhook's placeholder for media carries no content. */
const PLACEHOLDER_BODIES = new Set(['Audio message', 'Voice message', 'Image', 'Video', 'Document', 'Sticker']);

module.exports = {
  KEY10, OWNER_SQL, MESSAGE_OWNER_SQL, SENDER_TYPE_SQL, SENDER_CONFIDENCE_SQL,
  classifiedMessagesSql, PLACEHOLDER_BODIES,
};
