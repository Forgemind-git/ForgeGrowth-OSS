// Media Library route — upload to MinIO, list, sync to Meta per WABA,
// toggle auto-resync, delete.

const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const pool = require('../db');
const minio = require('../util/minioClient');
const { uploadMedia: metaUploadMedia } = require('../integrations/metaSend');
const { getAccountWithToken } = require('./whatsappAccounts');

const router = Router();

// 50 MB upload cap (Meta's documented hard limits are smaller per type —
// 5 MB image, 16 MB video/audio, 100 MB document — we let MinIO accept up
// to 50 MB and rely on Meta's API to reject anything it dislikes).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const TYPE_MAP = [
  { prefix: 'image/', type: 'image' },
  { prefix: 'video/', type: 'video' },
  { prefix: 'audio/', type: 'audio' },
];
function inferMediaType(mime) {
  for (const m of TYPE_MAP) if (mime.startsWith(m.prefix)) return m.type;
  return 'document';
}

function rowToMedia(r) {
  return {
    id: r.id,
    filename: r.filename,
    originalName: r.original_name,
    name: r.name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    mediaType: r.media_type,
    sha256: r.sha256,
    autoResync: r.auto_resync,
    notes: r.notes,
    uploadedAt: r.uploaded_at,
  };
}

function rowToSync(r) {
  return {
    id: r.id,
    mediaId: r.media_id,
    accountId: r.account_id,
    metaMediaId: r.meta_media_id,
    syncedAt: r.synced_at,
    expiresAt: r.expires_at,
    status: r.status,
    lastError: r.last_error,
    attempts: r.attempts,
    updatedAt: r.updated_at,
  };
}

// Refresh stale 'synced' rows to 'expired' if expires_at < NOW().
async function markExpired() {
  await pool.query(`
    UPDATE coexistence.media_meta_sync
       SET status = 'expired', updated_at = NOW()
     WHERE status = 'synced' AND expires_at IS NOT NULL AND expires_at < NOW()
  `);
}

// GET /api/media-library
router.get('/media-library', async (req, res) => {
  try {
    await markExpired();
    const { rows: media } = await pool.query(`
      SELECT * FROM coexistence.media_library
       WHERE deleted_at IS NULL
       ORDER BY uploaded_at DESC
       LIMIT 500
    `);
    const ids = media.map(m => m.id);
    let syncs = [];
    if (ids.length) {
      const { rows: s } = await pool.query(
        `SELECT * FROM coexistence.media_meta_sync WHERE media_id = ANY($1::bigint[])`,
        [ids]
      );
      syncs = s;
    }
    const syncsByMedia = syncs.reduce((acc, r) => {
      (acc[r.media_id] = acc[r.media_id] || []).push(rowToSync(r));
      return acc;
    }, {});
    res.json({
      media: media.map(m => ({ ...rowToMedia(m), syncs: syncsByMedia[m.id] || [] })),
    });
  } catch (err) {
    console.error('[media-library] list error:', err);
    res.status(500).json({ error: 'Failed to list media' });
  }
});

// POST /api/media-library  (multipart, field "file")
router.post('/media-library', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, mimetype, size, buffer } = req.file;
    const name = (req.body?.name || '').toString().slice(0, 255) || null;
    const notes = (req.body?.notes || '').toString().slice(0, 500) || null;

    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext = path.extname(originalname).toLowerCase();
    const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const objectKey = `library/${stored}`;
    const mediaType = inferMediaType(mimetype);

    await minio.ensureBucket();
    await minio.putObject(objectKey, buffer, mimetype);

    const { rows } = await pool.query(`
      INSERT INTO coexistence.media_library
        (filename, original_name, name, mime_type, size_bytes, media_type,
         minio_bucket, minio_object_key, sha256, notes, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      stored, originalname, name, mimetype, size, mediaType,
      minio.bucketName(), objectKey, sha, notes, req.user?.id || null,
    ]);
    res.json({ media: rowToMedia(rows[0]) });
  } catch (err) {
    console.error('[media-library] upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload media' });
  }
});

// Ingest a file into the Media Library from an in-memory Buffer (no multipart).
// Shared by the multipart route above and the MCP `upload_media` path (base64 /
// URL), so a poster can be added to the library programmatically. Returns the
// same shape as rowToMedia. Does NOT sync to Meta — call syncMediaToAccount for
// that (the MCP tool does, optionally).
async function ingestMediaFromSource({ buffer, originalName, mimeType, name, notes, uploadedBy } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty or invalid file buffer');
  const mime = mimeType || 'application/octet-stream';
  const safeOriginal = (originalName || `upload-${Date.now()}`).toString().slice(0, 255);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = path.extname(safeOriginal).toLowerCase();
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const objectKey = `library/${stored}`;
  const mediaType = inferMediaType(mime);

  await minio.ensureBucket();
  await minio.putObject(objectKey, buffer, mime);

  const { rows } = await pool.query(`
    INSERT INTO coexistence.media_library
      (filename, original_name, name, mime_type, size_bytes, media_type,
       minio_bucket, minio_object_key, sha256, notes, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    stored, safeOriginal, (name || '').toString().slice(0, 255) || null, mime, buffer.length, mediaType,
    minio.bucketName(), objectKey, sha, (notes || '').toString().slice(0, 500) || null, uploadedBy || null,
  ]);
  return rowToMedia(rows[0]);
}

// PUT /api/media-library/:id  — auto_resync, name, and notes are editable
router.put('/media-library/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { autoResync, name, notes } = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;
    if (autoResync !== undefined) { fields.push(`auto_resync = $${i++}`); vals.push(!!autoResync); }
    if (name !== undefined)       { fields.push(`name = $${i++}`);        vals.push(name ? name.toString().slice(0, 255) : null); }
    if (notes !== undefined)      { fields.push(`notes = $${i++}`);       vals.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE coexistence.media_library SET ${fields.join(', ')}
        WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ media: rowToMedia(rows[0]) });
  } catch (err) {
    console.error('[media-library] update error:', err);
    res.status(500).json({ error: 'Failed to update media' });
  }
});

// DELETE /api/media-library/:id  (soft-delete + remove MinIO object)
router.delete('/media-library/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `UPDATE coexistence.media_library
          SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING minio_object_key`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await minio.removeObject(rows[0].minio_object_key);
    res.json({ ok: true });
  } catch (err) {
    console.error('[media-library] delete error:', err);
    res.status(500).json({ error: 'Failed to delete media' });
  }
});

// GET /api/media-library/:id/download  (auth-proxied download)
router.get('/media-library/:id/download', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT minio_object_key, mime_type, original_name, name
         FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const buf = await minio.getObjectBuffer(rows[0].minio_object_key);
    res.setHeader('Content-Type', rows[0].mime_type);
    const displayName = rows[0].name || rows[0].original_name;
    res.setHeader('Content-Disposition', `inline; filename="${displayName}"`);
    res.send(buf);
  } catch (err) {
    console.error('[media-library] download error:', err);
    res.status(500).json({ error: 'Failed to download media' });
  }
});

// POST /api/media-library/:id/sync/:accountId — push to Meta for one WABA
async function syncMediaToAccount(mediaId, accountId) {
  const { rows: mRows } = await pool.query(
    `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
    [mediaId]
  );
  if (!mRows.length) throw new Error('Media not found');
  const media = mRows[0];

  const account = await getAccountWithToken(accountId);
  if (!account) throw new Error('WhatsApp account not found');

  // mark syncing
  await pool.query(`
    INSERT INTO coexistence.media_meta_sync
      (media_id, account_id, status, attempts, updated_at)
    VALUES ($1,$2,'syncing',1,NOW())
    ON CONFLICT (media_id, account_id) DO UPDATE
      SET status='syncing', attempts = coexistence.media_meta_sync.attempts + 1, updated_at = NOW()
  `, [mediaId, accountId]);

  try {
    const buf = await minio.getObjectBuffer(media.minio_object_key);
    const { id: metaId } = await metaUploadMedia({
      accessToken: account.accessToken,
      phoneNumberId: account.phoneNumberId,
      buffer: buf,
      mimeType: media.mime_type,
      filename: media.original_name,
    });
    const { rows } = await pool.query(`
      UPDATE coexistence.media_meta_sync
         SET meta_media_id=$1, status='synced', synced_at=NOW(),
             expires_at = NOW() + INTERVAL '28 days',
             last_error=NULL, updated_at=NOW()
       WHERE media_id=$2 AND account_id=$3
       RETURNING *
    `, [metaId, mediaId, accountId]);
    return rowToSync(rows[0]);
  } catch (err) {
    await pool.query(`
      UPDATE coexistence.media_meta_sync
         SET status='failed', last_error=$1, updated_at=NOW()
       WHERE media_id=$2 AND account_id=$3
    `, [String(err.message || err).slice(0, 500), mediaId, accountId]);
    throw err;
  }
}

router.post('/media-library/:id/sync/:accountId', async (req, res) => {
  try {
    const sync = await syncMediaToAccount(
      parseInt(req.params.id, 10),
      parseInt(req.params.accountId, 10),
    );
    res.json({ sync });
  } catch (err) {
    console.error('[media-library] sync error:', err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

/**
 * Resolve a media_library row to a ready-to-send Meta media id for one account.
 * Reuses an existing, non-expired `media_meta_sync` row; otherwise (re)uploads
 * the bytes to that account's phone number via `syncMediaToAccount`.
 * Returns the meta media id string, or null if the media can't be resolved.
 */
async function resolveMetaMediaId(mediaLibraryId, accountId) {
  if (!mediaLibraryId) return null;
  const { rows: mRows } = await pool.query(
    `SELECT id FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
    [mediaLibraryId]
  );
  if (!mRows.length) return null;
  const mediaId = mRows[0].id;
  const { rows: sRows } = await pool.query(
    `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
    [mediaId, accountId]
  );
  const sync = sRows[0];
  const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id
    || (sync.expires_at && new Date(sync.expires_at) <= new Date());
  if (needsSync) {
    const fresh = await syncMediaToAccount(mediaId, accountId);
    return fresh.metaMediaId || null;
  }
  return sync.meta_media_id || null;
}

/**
 * Build the Meta `carousel` SEND component for an approved CAROUSEL template.
 * Each card supplies its header media (resolved to a per-account media id) and
 * a payload parameter for each QUICK_REPLY button. Card bodies are static (the
 * builder disallows variables in card bodies) and static URL/PHONE buttons need
 * no parameters, so neither is emitted. Returns { type:'carousel', cards:[...] }
 * or null when there are no cards.
 *
 * `template.carousel_cards` is normally already a JS array (jsonb), but tolerate
 * a JSON string just in case the caller passed a raw column value.
 */
async function buildCarouselComponent(template, accountId) {
  let cards = template.carousel_cards;
  if (typeof cards === 'string') { try { cards = JSON.parse(cards); } catch { cards = []; } }
  if (!Array.isArray(cards) || cards.length === 0) return null;

  const outCards = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i] || {};
    const fmt = String(card.header_type || 'IMAGE').toLowerCase(); // image | video
    const components = [];

    // Header media is required on every carousel card.
    const mediaId = await resolveMetaMediaId(card.media_library_id, accountId);
    if (mediaId) {
      components.push({ type: 'header', parameters: [{ type: fmt, [fmt]: { id: mediaId } }] });
    }

    // QUICK_REPLY buttons need a payload param at send time so taps echo back.
    const btns = Array.isArray(card.buttons) ? card.buttons : [];
    btns.forEach((b, j) => {
      if (b && b.type === 'QUICK_REPLY') {
        components.push({
          type: 'button', sub_type: 'quick_reply', index: j,
          parameters: [{ type: 'payload', payload: String(b.value || b.text || `card_${i}_btn_${j}`).slice(0, 128) }],
        });
      }
    });

    outCards.push({ card_index: i, components });
  }
  return { type: 'carousel', cards: outCards };
}

module.exports = { router, syncMediaToAccount, resolveMetaMediaId, buildCarouselComponent, ingestMediaFromSource };
