// Keeps a permanent, self-owned copy of every Communities media file.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// A group media file can be in one of three states, and two of them lose data:
//   • Archived by Evolution   → lives in EVOLUTION's MinIO bucket. Durable, but
//                               owned by a service we do not control.
//   • Not archived, URL live  → WhatsApp still serves it, but only until the
//                               expiry baked into the URL (~26 days from send).
//                               After that it is gone, permanently.
//   • Not archived, expired   → already lost. Nothing can recover it.
//
// Evolution only began copying media on 2026-05-30, and DOCUMENTS only from
// 2026-07-30 — which is exactly how every document sent before 30 July was
// lost. So this sweeper copies media into the app's OWN bucket while it is
// still reachable, after which Communities depends on neither WhatsApp's
// retention nor Evolution's bucket.
//
// It is read-only towards Evolution: it downloads, never writes.

const pool = require('../db');
const evolutionPool = require('../evolutionDb');
const minio = require('../util/minioClient');

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';

const MEDIA_TYPES = ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage'];

// A single file bigger than this is skipped rather than pulled into memory —
// the on-demand route can still serve it while WhatsApp holds it.
const MAX_FILE_BYTES = parseInt(process.env.COMMUNITY_MEDIA_MAX_BYTES || String(60 * 1024 * 1024), 10);

// Bounds one sweep so a large backlog can never monopolise the disk or the
// event loop in a single pass; the next tick picks up where this left off.
const BATCH = parseInt(process.env.COMMUNITY_MEDIA_BATCH || '25', 10);

// After this many failures a file is considered unrecoverable and stops being
// retried. Without it, the ~34 already-expired files would be re-attempted on
// every sweep forever.
const MAX_ATTEMPTS = 3;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/html': 'html',
};

function extFor(mime, fileName) {
  const fromName = fileName && fileName.includes('.') ? fileName.split('.').pop().slice(0, 8) : null;
  return EXT_BY_MIME[(mime || '').split(';')[0]] || fromName || 'bin';
}

/** Decodes WhatsApp's hex `oe=` expiry. See routes/communities.js. */
function whatsappCopyAlive(oeHex) {
  if (!oeHex) return false;
  const expiry = parseInt(oeHex, 16);
  return Number.isFinite(expiry) && expiry * 1000 > Date.now() + 60_000;
}

async function trackedGroups() {
  const { rows } = await pool.query(
    `SELECT group_jid, instance_name FROM coexistence.community_groups WHERE active = TRUE`
  );
  return rows;
}

/**
 * Candidate media in the tracked groups, newest first.
 *
 * Newest-first matters: the newest un-archived files are the ONLY ones with a
 * live WhatsApp URL, so they are the only ones that can still be rescued. An
 * oldest-first sweep would spend its batch on files that are already lost.
 */
async function candidates(tracked, { includeArchived }) {
  const instances = tracked.map(g => g.instance_name);
  const jids = tracked.map(g => g.group_jid);
  const { rows } = await evolutionPool.query(
    `SELECT m.id,
            i.name                        AS instance_name,
            m.key->>'remoteJid'           AS group_jid,
            m."messageType"               AS type,
            m."messageTimestamp"          AS ts,
            NULLIF(m.message->>'mediaUrl','') AS media_url,
            COALESCE(
              m.message->'documentMessage'->>'mimetype',
              m.message->'imageMessage'->>'mimetype',
              m.message->'videoMessage'->>'mimetype',
              m.message->'audioMessage'->>'mimetype'
            ) AS mime_type,
            COALESCE(
              m.message->'documentMessage'->>'fileName',
              m.message->'documentMessage'->>'title'
            ) AS file_name,
            substring(
              COALESCE(
                m.message->'documentMessage'->>'url',
                m.message->'imageMessage'->>'url',
                m.message->'videoMessage'->>'url',
                m.message->'audioMessage'->>'url'
              ) from 'oe=([0-9A-Fa-f]+)'
            ) AS oe_hex
       FROM "Message" m
       JOIN "Instance" i ON i.id = m."instanceId"
      WHERE (i.name, m.key->>'remoteJid') IN (SELECT * FROM unnest($1::text[], $2::text[]))
        AND m."messageType" = ANY($3::text[])
        -- A deleted message ("delete for everyone") keeps its row but has its
        -- payload NULLed, so there is no file to fetch and never will be.
        -- Excluding it here stops the sweep reporting a permanent "failure"
        -- for something that is working exactly as intended.
        AND jsonb_typeof(m.message) <> 'null'
        ${includeArchived ? '' : `AND NULLIF(m.message->>'mediaUrl','') IS NULL`}
      ORDER BY m."messageTimestamp" DESC
      LIMIT 500`,
    [instances, jids, MEDIA_TYPES]
  );
  return rows;
}

/** Fetches the bytes, preferring the copy that costs least to obtain. */
async function fetchBytes(row) {
  // Evolution's archived copy is already decrypted and sitting on local
  // storage — far cheaper than making it re-download and decrypt from WhatsApp.
  if (row.media_url) {
    const r = await fetch(row.media_url);
    if (!r.ok) throw new Error(`evolution storage returned ${r.status}`);
    return { buffer: Buffer.from(await r.arrayBuffer()), source: 'evolution_s3', mime: r.headers.get('content-type') || row.mime_type };
  }

  if (!row.oe_hex) {
    // Evolution occasionally stores a media row whose `message` payload is
    // JSON null — the message is known but its url/mediaKey never were. Saying
    // "expired" here would send a future reader hunting a retention problem
    // that does not exist, so name the real cause.
    const e = new Error('no media data recorded by Evolution');
    e.permanent = true;
    throw e;
  }
  if (!whatsappCopyAlive(row.oe_hex)) {
    // Not an error worth retrying — the file is genuinely gone.
    const e = new Error('WhatsApp copy expired');
    e.permanent = true;
    throw e;
  }
  if (!EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY not configured');

  const waId = await waMessageId(row.id);
  if (!waId) throw new Error('could not resolve WhatsApp message id');

  const resp = await fetch(
    `${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(row.instance_name)}`,
    {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: waId } } }),
    }
  );
  if (!resp.ok) throw new Error(`evolution media fetch returned ${resp.status}`);
  const payload = await resp.json();
  if (!payload?.base64) throw new Error('no media returned');
  return {
    buffer: Buffer.from(payload.base64, 'base64'),
    source: 'whatsapp',
    mime: payload.mimetype || row.mime_type,
  };
}

async function waMessageId(rowId) {
  const { rows } = await evolutionPool.query(`SELECT m.key->>'id' AS wa_id FROM "Message" m WHERE m.id = $1`, [rowId]);
  return rows[0]?.wa_id || null;
}

/**
 * One sweep. Copies up to BATCH files that we do not already hold.
 *
 * @param {object} opts
 * @param {boolean} opts.includeArchived  Also mirror files Evolution already
 *   archived. Off by default: those already sit in MinIO with no lifecycle
 *   rule, and duplicating ~750 MB of historical audio is a deliberate, costly
 *   choice on a disk that is 97% full — so it is opt-in, not a side effect.
 */
async function sweepCommunityMedia({ includeArchived = false, batch = BATCH } = {}) {
  if (!evolutionPool) return { skipped: 'evolution not configured' };

  const tracked = await trackedGroups();
  if (!tracked.length) return { stored: 0, failed: 0, considered: 0 };

  const rows = await candidates(tracked, { includeArchived });
  if (!rows.length) return { stored: 0, failed: 0, considered: 0 };

  // One round trip to find what we already hold (or have given up on) rather
  // than a query per file.
  const { rows: known } = await pool.query(
    `SELECT message_id, object_key, attempts
       FROM coexistence.community_media
      WHERE message_id = ANY($1::text[])`,
    [rows.map(r => r.id)]
  );
  const knownById = new Map(known.map(k => [k.message_id, k]));

  const todo = rows.filter(r => {
    const k = knownById.get(r.id);
    if (!k) return true;
    return !k.object_key && k.attempts < MAX_ATTEMPTS;
  }).slice(0, batch);

  let stored = 0, failed = 0, bytes = 0;

  for (const row of todo) {
    try {
      const { buffer, source, mime } = await fetchBytes(row);
      if (buffer.length > MAX_FILE_BYTES) {
        throw Object.assign(new Error(`file too large (${buffer.length} bytes)`), { permanent: true });
      }
      const key = `communities/${row.group_jid}/${row.id}.${extFor(mime, row.file_name)}`;
      await minio.putObject(key, buffer, mime || 'application/octet-stream');

      await pool.query(
        `INSERT INTO coexistence.community_media
           (message_id, instance_name, group_jid, object_key, mime_type, bytes, source, sent_at, stored_at, attempts, last_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),NOW(),COALESCE((SELECT attempts FROM coexistence.community_media WHERE message_id=$1),0)+1,NULL)
         ON CONFLICT (message_id) DO UPDATE
           SET object_key = EXCLUDED.object_key, mime_type = EXCLUDED.mime_type,
               bytes = EXCLUDED.bytes, source = EXCLUDED.source,
               stored_at = NOW(), last_error = NULL`,
        [row.id, row.instance_name, row.group_jid, key, mime, buffer.length, source, row.ts]
      );
      stored++; bytes += buffer.length;
    } catch (err) {
      failed++;
      // A permanent failure is recorded at MAX_ATTEMPTS immediately so an
      // expired file is never retried again.
      await pool.query(
        `INSERT INTO coexistence.community_media
           (message_id, instance_name, group_jid, mime_type, sent_at, attempts, last_error)
         VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7)
         ON CONFLICT (message_id) DO UPDATE
           SET attempts = GREATEST(coexistence.community_media.attempts + 1, EXCLUDED.attempts),
               last_error = EXCLUDED.last_error`,
        [row.id, row.instance_name, row.group_jid, row.mime_type, row.ts,
         err.permanent ? MAX_ATTEMPTS : 1, String(err.message || err).slice(0, 300)]
      ).catch(() => {});
    }
  }

  if (stored || failed) {
    console.log(`[communityMedia] stored ${stored} (${(bytes / 1048576).toFixed(1)} MB), failed ${failed}, considered ${todo.length}`);
  }
  return { stored, failed, considered: todo.length, bytes };
}

/** The stored copy for a message, or null. */
async function storedCopy(messageId) {
  const { rows } = await pool.query(
    `SELECT object_key, mime_type, bytes FROM coexistence.community_media
      WHERE message_id = $1 AND object_key IS NOT NULL`,
    [messageId]
  );
  return rows[0] || null;
}

/** Which of these message ids we hold permanently — used to mark availability. */
async function storedIds(messageIds) {
  if (!messageIds.length) return new Set();
  const { rows } = await pool.query(
    `SELECT message_id FROM coexistence.community_media
      WHERE message_id = ANY($1::text[]) AND object_key IS NOT NULL`,
    [messageIds]
  );
  return new Set(rows.map(r => r.message_id));
}

module.exports = { sweepCommunityMedia, storedCopy, storedIds };
