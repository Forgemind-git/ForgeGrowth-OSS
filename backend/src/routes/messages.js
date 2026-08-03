const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pool = require('../db');
const { resolveAccount, insertPendingRow, secondsSinceLastIncoming } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { uploadMedia } = require('../integrations/metaSend');
const { markAccountHealth, classifyMetaError } = require('../services/accountHealth');
const minio = require('../util/minioClient');
const { syncMediaToAccount } = require('./mediaLibrary');
const { userWaNumbers, assertWaAccess, assertContactAccess } = require('../middleware/access');
const { isAdmin } = require('../permissions');
const bus = require('../events');
const XLSX = require('xlsx');

const pexecFile = promisify(execFile);
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';

/**
 * A quote-reply's context message id is only valid to Meta if it's a real
 * Meta wamid. Optimistic rows still carry a local-/tmp- id (the message hasn't
 * been accepted by Meta yet) — quoting those would make Meta reject the send,
 * so we drop them and send without the quote rather than fail.
 */
function sanitizeContextId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('local-') || id.startsWith('tmp-')) return null;
  return id;
}
const META_AUDIO_TYPES = new Set(['audio/aac', 'audio/mp4', 'audio/amr', 'audio/mpeg', 'audio/ogg']);

/**
 * Transcode browser audio (typically webm/opus) to Meta-accepted ogg/opus.
 * Returns { buffer, mime, ext }.
 */
async function transcodeAudioForMeta(srcBuffer, srcMime) {
  if (META_AUDIO_TYPES.has(srcMime)) {
    return { buffer: srcBuffer, mime: srcMime, ext: srcMime.split('/')[1] };
  }
  // Write source to a temp file, transcode to ogg/opus
  const tmpIn = `/tmp/audio-in-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const tmpOut = `${tmpIn}.ogg`;
  fs.writeFileSync(tmpIn, srcBuffer);
  try {
    await pexecFile('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', tmpIn,
      '-vn', '-c:a', 'libopus', '-b:a', '64k',
      tmpOut,
    ], { timeout: 30_000 });
    const buf = fs.readFileSync(tmpOut);
    return { buffer: buf, mime: 'audio/ogg', ext: 'ogg' };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

/**
 * Mirror an outbound media file to /app/media so the chat bubble can render
 * the thumbnail/playback via the existing /api/media/:messageId proxy.
 * Path layout matches inbound: <wa>/<yyyymm>/<msgid>.<ext>
 */
function persistOutboundMedia({ accountPhoneDigits, messageId, buffer, ext }) {
  const ym = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(MEDIA_DIR, accountPhoneDigits || 'unknown', ym);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${String(messageId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)}.${ext || 'bin'}`;
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buffer);
  return { absPath, size: buffer.length };
}

const router = Router();
const SERVICE_WINDOW_SECONDS = 24 * 3600;

// Multipart parser for chat media (up to 16MB — WhatsApp's per-message cap)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// Contact-import sheet upload (.csv / .xlsx). Kept in memory — SheetJS parses
// the buffer directly. 5MB is plenty for a few thousand contact rows.
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Column-header matching for contact imports: normalize a header to lowercase
// alphanumerics, then match against a set of accepted aliases. Lets users keep
// their own header wording ("Full Name", "Mobile No.", "WhatsApp Number"…).
const IMPORT_NAME_ALIASES = new Set(['name', 'fullname', 'contactname', 'customername']);
const IMPORT_PHONE_ALIASES = new Set([
  'phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno',
  'whatsapp', 'whatsappnumber', 'contactnumber', 'number', 'msisdn',
]);
function pickImportColumn(row, aliases) {
  for (const key of Object.keys(row)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (aliases.has(norm)) return row[key];
  }
  return undefined;
}

// Last-resort mime lookup when a stored media row has no media_mime_type
// (legacy rows). Meta's /media upload REQUIRES a type, so we can't send null.
const EXT_MIME_FALLBACK = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', amr: 'audio/amr', aac: 'audio/aac', m4a: 'audio/mp4',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};

function classifyChatMediaKind(mime) {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

// Effectively unlimited: messages/conversations must NEVER disappear from the
// inbox. This is the fallback window for /messages, /numbers and /contacts when
// no explicit timeRange is requested. Callers can still pass a narrower
// timeRange (1h/6h/24h/7d/14d/30d) to scope a query; absence = show everything.
const DEFAULT_DATA_WINDOW = "INTERVAL '100 years'";
const ALERTABLE_TYPES = "('text', 'audio', 'video', 'image', 'document', 'sticker', 'location', 'contacts')";

function timeRangeToInterval(range) {
  const map = {
    '1h': "INTERVAL '1 hour'",
    '6h': "INTERVAL '6 hours'",
    '24h': "INTERVAL '24 hours'",
    '7d': "INTERVAL '7 days'",
    '14d': "INTERVAL '14 days'",
    '30d': "INTERVAL '30 days'",
  };
  return map[range] || null;
}

// GET /api/numbers
router.get('/numbers', async (req, res) => {
  try {
    // BDA visibility: a wa_number is visible only if the user has at least
    // one contact assigned to them on that number. Admin sees everything.
    let extraFilter = '';
    const params = [];
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      extraFilter = `AND wa_number IN (
        SELECT DISTINCT wa_number FROM coexistence.contacts WHERE assigned_user_id = $${params.length}
      )`;
    }
    // A freshly-registered WhatsApp account has no chat_history yet, so deriving
    // this list from messages alone hides it everywhere it is used as a SENDER
    // (Bulk Message "From", composer, template pickers) until somebody happens to
    // message it first. Union in the registered accounts so every active number
    // the business owns is selectable from day one. Admin-only — BDA visibility
    // stays contact-scoped exactly as before.
    const registeredCte = isAdmin(req.user)
      ? `SELECT display_phone_number AS wa_number
           FROM coexistence.whatsapp_accounts
          WHERE is_active = TRUE AND display_phone_number IS NOT NULL`
      : `SELECT NULL::text AS wa_number WHERE FALSE`;

    const { rows } = await pool.query(`
      WITH hist AS (
        SELECT
          wa_number,
          MAX(timestamp) AS last_message_time,
          COUNT(*) AS message_count
        FROM coexistence.chat_history
        WHERE timestamp >= NOW() - ${DEFAULT_DATA_WINDOW} ${extraFilter}
        GROUP BY wa_number
      ),
      regd AS (${registeredCte})
      SELECT
        COALESCE(h.wa_number, r.wa_number) AS wa_number,
        h.last_message_time,
        COALESCE(h.message_count, 0) AS message_count
      FROM hist h
      FULL OUTER JOIN regd r ON r.wa_number = h.wa_number
      ORDER BY h.last_message_time DESC NULLS LAST
    `, params);

    // Unread chats per wa_number = conversations with >=1 incoming message newer
    // than last_read_at. Respects the same BDA visibility scoping as above.
    const unreadParams = [];
    let unreadJoin = '';
    let unreadAssign = '';
    if (!isAdmin(req.user)) {
      unreadParams.push(req.user.id);
      unreadJoin = `JOIN coexistence.contacts c
        ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number`;
      unreadAssign = `AND c.assigned_user_id = $${unreadParams.length}`;
    }
    const unreadRes = await pool.query(`
      SELECT ch.wa_number, COUNT(DISTINCT ch.contact_number) AS unread_chats
      FROM coexistence.chat_history ch
      LEFT JOIN coexistence.conversation_reads cr
        ON cr.wa_number = ch.wa_number AND cr.contact_number = ch.contact_number
      ${unreadJoin}
      WHERE ch.direction = 'incoming'
        AND ch.timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}
        AND ch.timestamp > COALESCE(cr.last_read_at, 'epoch'::timestamptz)
        ${unreadAssign}
      GROUP BY ch.wa_number
    `, unreadParams);
    const unreadMap = {};
    for (const r of unreadRes.rows) unreadMap[r.wa_number] = Number(r.unread_chats) || 0;

    // Enrich with team member data and display name
    const enriched = await Promise.all(rows.map(async (row) => {
      const [nameRes, teamRes, acctRes] = await Promise.all([
        pool.query(
          'SELECT COALESCE(name, profile_name) AS name FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $1 LIMIT 1',
          [row.wa_number]
        ),
        pool.query(
          `SELECT name, profile_picture_url
           FROM coexistence.team_members
           WHERE phone_number = $1
              OR phone_number = $2
              OR REPLACE(REPLACE(REPLACE(phone_number, '+', ''), '-', ''), ' ', '') = $3
           LIMIT 1`,
          [row.wa_number, `+${row.wa_number}`, row.wa_number.replace(/\D/g, '')]
        ),
        // Last-resort label: the registered account's own name. Kept LAST so an
        // existing number's displayed label never changes — this only fills in
        // numbers that previously rendered as a bare masked phone number.
        pool.query(
          `SELECT display_name FROM coexistence.whatsapp_accounts
            WHERE display_phone_number = $1 AND is_active = TRUE LIMIT 1`,
          [row.wa_number]
        ),
      ]);
      const teamMember = teamRes.rows[0];
      return {
        ...row,
        display_name: teamMember?.name || nameRes.rows[0]?.name || acctRes.rows[0]?.display_name || null,
        profile_picture_url: teamMember?.profile_picture_url || null,
        unread_chats: unreadMap[row.wa_number] || 0,
      };
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[messages] /numbers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch numbers' });
  }
});

// GET /api/contacts?waNumber=xxx&timeRange=24h
router.get('/contacts', async (req, res) => {
  try {
    const { waNumber, timeRange = '24h' } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;

    const interval = timeRangeToInterval(timeRange);
    let timeFilter = `AND timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}`;
    if (interval) timeFilter = `AND timestamp >= NOW() - ${interval}`;

    // BDA visibility: only contacts whose assigned_user_id matches the user.
    // Admin sees everyone. Switch from LEFT to INNER JOIN for non-admins.
    const params = [waNumber];
    let joinKind = 'LEFT JOIN';
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      joinKind = 'INNER JOIN';
      params.push(req.user.id);
      assignFilter = `AND c.assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT
        ch.contact_number,
        MAX(ch.timestamp) AS last_message_time,
        COUNT(*) AS message_count,
        COUNT(*) FILTER (
          WHERE ch.direction = 'incoming'
            AND ch.timestamp > COALESCE(cr.last_read_at, 'epoch'::timestamptz)
        ) AS unread_count,
        (SELECT CASE
                  WHEN NULLIF(ch2.message_body, '') IS NOT NULL THEN ch2.message_body
                  WHEN ch2.message_type IN ('audio','voice') THEN '🎵 Audio'
                  WHEN ch2.message_type = 'image'   THEN '📷 Photo'
                  WHEN ch2.message_type = 'video'   THEN '🎥 Video'
                  WHEN ch2.message_type = 'document' THEN '📄 Document'
                  WHEN ch2.message_type = 'location' THEN '📍 Location'
                  WHEN ch2.message_type = 'contacts' THEN '👤 Contact'
                  WHEN ch2.message_type = 'sticker'  THEN 'Sticker'
                  WHEN ch2.message_type = 'template' THEN 'Template message'
                  WHEN ch2.message_type = 'interactive' THEN 'Interactive message'
                  WHEN ch2.message_type IN ('unsupported','unknown') THEN 'Unsupported message'
                  ELSE NULL
                END
         FROM coexistence.chat_history ch2
         WHERE ch2.wa_number = $1 AND ch2.contact_number = ch.contact_number
           AND ch2.message_type NOT IN ('reaction','status')
         ORDER BY ch2.timestamp DESC LIMIT 1) AS last_message,
        COALESCE(c.name, c.profile_name) AS name,
        c.tags,
        c.assigned_user_id,
        u.display_name AS assigned_user_name,
        u.role        AS assigned_user_role
      FROM coexistence.chat_history ch
      ${joinKind} coexistence.contacts c
        ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
      LEFT JOIN coexistence.forgecrm_users u ON u.id = c.assigned_user_id
      LEFT JOIN coexistence.conversation_reads cr
        ON cr.wa_number = ch.wa_number AND cr.contact_number = ch.contact_number
      WHERE ch.wa_number = $1 ${timeFilter} ${assignFilter}
      GROUP BY ch.contact_number, c.name, c.profile_name, c.tags, c.assigned_user_id, u.display_name, u.role, cr.last_read_at
      ORDER BY last_message_time DESC
    `, params);

    res.json(rows.map(r => ({ ...r, tags: r.tags || [], unread_count: Number(r.unread_count) || 0 })));
  } catch (err) {
    console.error('[messages] /contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// POST /api/contacts/save
router.post('/contacts/save', async (req, res) => {
  try {
    const { waNumber, contactNumber, name, tags, customFields, assignedUserId } = req.body;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }

    // `name` is OPTIONAL. The full edit modal always sends one; the header
    // quick-actions (tag / assign) send '' so the existing CRM name is kept.
    // We never write a (possibly profile-derived) name when none is given —
    // COALESCE(EXCLUDED.name, …) preserves the stored name on partial saves,
    // protecting the name-vs-profile_name distinction the engine relies on.
    const cleanName = (typeof name === 'string' && name.trim()) ? name.trim() : null;
    const tagsJson = JSON.stringify(tags || []);
    const cfJson = JSON.stringify(customFields || {});

    // BDA: can only edit a contact already assigned to them. Cannot reassign.
    // Admin: can edit any contact and may optionally set/clear assigned_user_id.
    if (!isAdmin(req.user)) {
      if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
      // Silently ignore assignedUserId for non-admins
      await pool.query(`
        INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, assigned_user_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (wa_number, contact_number)
        DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name), tags = EXCLUDED.tags, custom_fields = EXCLUDED.custom_fields, updated_at = NOW()
      `, [waNumber, contactNumber, cleanName, tagsJson, cfJson, req.user.id]);
    } else {
      // Admin: assignedUserId may be present (set/clear) or omitted (preserve)
      const cleanAssigned = assignedUserId === null ? null : (assignedUserId ? parseInt(assignedUserId, 10) : undefined);
      if (cleanAssigned !== undefined) {
        await pool.query(`
          INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, assigned_user_id, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (wa_number, contact_number)
          DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name), tags = EXCLUDED.tags, custom_fields = EXCLUDED.custom_fields, assigned_user_id = EXCLUDED.assigned_user_id, updated_at = NOW()
        `, [waNumber, contactNumber, cleanName, tagsJson, cfJson, cleanAssigned]);
      } else {
        await pool.query(`
          INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (wa_number, contact_number)
          DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name), tags = EXCLUDED.tags, custom_fields = EXCLUDED.custom_fields, updated_at = NOW()
        `, [waNumber, contactNumber, cleanName, tagsJson, cfJson]);
      }
    }

    // Notify SSE subscribers. We do this AFTER the DB write succeeds, so a
    // client refetch will see the new state. Two events to differentiate
    // "just an edit" from "assignment changed" — the latter is what BDA
    // portals need to react to immediately.
    bus.emit('contact-saved', { waNumber, contactNumber, name: cleanName });
    if (isAdmin(req.user) && assignedUserId !== undefined) {
      bus.emit('contact-assignment-changed', {
        waNumber,
        contactNumber,
        assignedUserId: assignedUserId === null ? null : Number(assignedUserId),
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] /contacts/save error:', err.message);
    res.status(500).json({ error: 'Failed to save contact' });
  }
});

// POST /api/contacts/change-number — change a contact's phone number, migrating
// the whole conversation + history to the new number atomically. contact_number
// is part of the composite PK and is joined by many tables, so every coexistence
// table keyed on (wa_number, contact_number) is updated in one transaction.
// (agent_runs is intentionally skipped — it has no wa_number to scope by and is
// an internal AI-run log not surfaced in the contact UI.)
router.post('/contacts/change-number', async (req, res) => {
  const { waNumber, oldNumber } = req.body || {};
  let { newNumber } = req.body || {};
  if (!waNumber || !oldNumber || !newNumber) {
    return res.status(400).json({ error: 'waNumber, oldNumber and newNumber required' });
  }
  // Store numbers as digits-only, matching how the webhook/import paths persist them.
  newNumber = String(newNumber).replace(/\D/g, '');
  if (newNumber.length < 7) {
    return res.status(400).json({ error: 'Enter a valid phone number (digits only, at least 7 digits)' });
  }
  // BDAs may only edit a contact assigned to them; admins may edit any.
  if (!(await assertContactAccess(req, res, waNumber, oldNumber))) return;

  if (newNumber === String(oldNumber)) {
    return res.json({ ok: true, contactNumber: newNumber, unchanged: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const src = await client.query(
      'SELECT 1 FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2',
      [waNumber, oldNumber]
    );
    if (src.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contact not found' });
    }
    const clash = await client.query(
      'SELECT 1 FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2',
      [waNumber, newNumber]
    );
    if (clash.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A contact with that number already exists for this WhatsApp number' });
    }
    // Migrate every table keyed on (wa_number, contact_number).
    await client.query('UPDATE coexistence.contacts SET contact_number = $3, updated_at = NOW() WHERE wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('UPDATE coexistence.chat_history SET contact_number = $3 WHERE wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('UPDATE coexistence.conversation_reads SET contact_number = $3 WHERE wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('UPDATE coexistence.message_reactions SET contact_number = $3 WHERE wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('UPDATE coexistence.automation_executions SET contact_number = $3 WHERE wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('UPDATE coexistence.deals SET contact_number = $3 WHERE contact_wa_number = $1 AND contact_number = $2', [waNumber, oldNumber, newNumber]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[messages] /contacts/change-number error:', err.message);
    return res.status(500).json({ error: 'Failed to change contact number' });
  } finally {
    client.release();
  }

  // Refresh any open Chats/Contacts views (old key disappears, new one appears).
  bus.emit('contact-saved', { waNumber, contactNumber: oldNumber });
  bus.emit('contact-saved', { waNumber, contactNumber: newNumber });
  res.json({ ok: true, contactNumber: newNumber });
});

// DELETE /api/contact?waNumber=xxx&contactNumber=xxx — remove the saved contact
// record (name/profile_name/tags/custom_fields/assignment). Chat history lives in
// a separate table and is left intact; a future inbound message will recreate a
// bare row from the WhatsApp profile name.
router.delete('/contact', async (req, res) => {
  try {
    const waNumber = req.query.waNumber || req.body?.waNumber;
    const contactNumber = req.query.contactNumber || req.body?.contactNumber;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    // BDAs can only delete a contact they have access to; admins can delete any.
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
      [waNumber, contactNumber]
    );
    // Refresh any open Chats/Contacts views.
    bus.emit('contact-saved', { waNumber, contactNumber });
    res.json({ ok: true, deleted: rowCount });
  } catch (err) {
    console.error('[messages] DELETE /contact error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// GET /api/contacts/import/template — download a sample .xlsx with the standard
// fields (Name, Phone Number) and one example row. The same column headers are
// what POST /contacts/import expects (alias-matched, so wording is flexible).
router.get('/contacts/import/template', (req, res) => {
  try {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Phone Number'],
      ['John Doe', '919876543210'],
    ]);
    ws['!cols'] = [{ wch: 24 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-import-template.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error('[messages] /contacts/import/template error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

// POST /api/contacts/import — bulk-create saved contacts from an uploaded sheet.
// Accepts .csv or .xlsx (SheetJS reads both). Each row needs a Name + Phone.
// Phones are normalized to digits-only and upserted on (wa_number, contact_number)
// so re-importing is idempotent (existing tags/fields/assignment are preserved).
// Non-admins: imported contacts auto-assign to them (so they appear in their
// scoped view), and they must already have access to the target wa_number.
router.post('/contacts/import', sheetUpload.single('file'), async (req, res) => {
  try {
    const waNumber = String(req.body.waNumber || '').replace(/\D/g, '');
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const admin = isAdmin(req.user);
    if (!admin && !(await assertWaAccess(req, res, waNumber))) return;

    let rows;
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('empty workbook');
      // raw:false → values come back as their displayed text, so phone numbers
      // don't arrive as floats/scientific notation.
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    } catch {
      return res.status(400).json({ error: 'Could not read the file. Upload a valid .csv or .xlsx sheet.' });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'The sheet has no data rows.' });
    }
    const MAX_ROWS = 5000;
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (${rows.length}). The limit is ${MAX_ROWS} per import.` });
    }

    let imported = 0, updated = 0;
    const skipped = [];
    const seen = new Set();

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // +1 for header row, +1 for 1-based display
      const rawName = pickImportColumn(rows[i], IMPORT_NAME_ALIASES);
      const rawPhone = pickImportColumn(rows[i], IMPORT_PHONE_ALIASES);
      const name = (rawName === undefined || rawName === null) ? '' : String(rawName).trim();
      const phone = String(rawPhone ?? '').replace(/\D/g, '');

      if (!phone) { skipped.push({ row: rowNum, reason: 'Missing phone number' }); continue; }
      if (phone.length < 7) { skipped.push({ row: rowNum, reason: `Invalid phone "${String(rawPhone).trim()}"` }); continue; }
      if (!name) { skipped.push({ row: rowNum, reason: 'Missing name' }); continue; }
      if (seen.has(phone)) { skipped.push({ row: rowNum, reason: 'Duplicate phone in sheet' }); continue; }
      seen.add(phone);

      let result;
      if (admin) {
        result = await pool.query(`
          INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, updated_at)
          VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, NOW())
          ON CONFLICT (wa_number, contact_number)
          DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name), updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [waNumber, phone, name]);
      } else {
        // New rows assign to the importing BDA; existing rows keep their current
        // owner (COALESCE) so an import can't silently steal another user's contact.
        result = await pool.query(`
          INSERT INTO coexistence.contacts (wa_number, contact_number, name, tags, custom_fields, assigned_user_id, updated_at)
          VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, $4, NOW())
          ON CONFLICT (wa_number, contact_number)
          DO UPDATE SET name = COALESCE(EXCLUDED.name, coexistence.contacts.name),
                        assigned_user_id = COALESCE(coexistence.contacts.assigned_user_id, EXCLUDED.assigned_user_id),
                        updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [waNumber, phone, name, req.user.id]);
      }
      if (result.rows[0]?.inserted) imported++; else updated++;
    }

    bus.emit('contact-saved', { waNumber });
    res.json({ ok: true, imported, updated, skipped, total: rows.length });
  } catch (err) {
    console.error('[messages] /contacts/import error:', err.message);
    res.status(500).json({ error: 'Failed to import contacts' });
  }
});

// GET /api/saved-contacts?waNumber=xxx  (single business number)
// GET /api/saved-contacts?all=true       (every contact across all numbers, for
//   bulk messaging — deduped by contact_number; admins see all, BDAs see only
//   contacts assigned to them, regardless of which number they live under).
router.get('/saved-contacts', async (req, res) => {
  try {
    if (req.query.all === 'true') {
      const params = [];
      let assignFilter = '';
      if (!isAdmin(req.user)) {
        params.push(req.user.id);
        assignFilter = `AND c.assigned_user_id = $${params.length}`;
      }
      // One row per unique contact_number (most recently updated wins) so the
      // same person reachable via two business lines isn't listed twice.
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (c.contact_number)
               c.contact_number, COALESCE(c.name, c.profile_name) AS name, c.tags, c.custom_fields,
               c.created_at, c.updated_at, c.wa_number,
               c.assigned_user_id, u.display_name AS assigned_user_name, u.role AS assigned_user_role
          FROM coexistence.contacts c
          LEFT JOIN coexistence.forgecrm_users u ON u.id = c.assigned_user_id
         WHERE COALESCE(c.name, c.profile_name) IS NOT NULL AND COALESCE(c.name, c.profile_name) <> '' ${assignFilter}
         ORDER BY c.contact_number, c.updated_at DESC NULLS LAST
      `, params);
      const sorted = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      return res.json(sorted.map(r => ({ ...r, tags: r.tags || [] })));
    }

    const { waNumber } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;

    const params = [waNumber];
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      assignFilter = `AND assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(`
      SELECT c.contact_number, COALESCE(c.name, c.profile_name) AS name, c.tags, c.custom_fields, c.created_at, c.updated_at,
             c.assigned_user_id, u.display_name AS assigned_user_name, u.role AS assigned_user_role
      FROM coexistence.contacts c
      LEFT JOIN coexistence.forgecrm_users u ON u.id = c.assigned_user_id
      WHERE c.wa_number = $1 AND COALESCE(c.name, c.profile_name) IS NOT NULL AND COALESCE(c.name, c.profile_name) <> '' ${assignFilter.replace(/assigned_user_id/g, 'c.assigned_user_id')}
      ORDER BY COALESCE(c.name, c.profile_name) ASC
    `, params);

    res.json(rows.map(r => ({ ...r, tags: r.tags || [] })));
  } catch (err) {
    console.error('[messages] /saved-contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch saved contacts' });
  }
});

// GET /api/contact?waNumber=xxx&contactNumber=xxx
router.get('/contact', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.query;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;

    const { rows } = await pool.query(`
      SELECT c.contact_number, COALESCE(c.name, c.profile_name) AS name, c.tags, c.custom_fields, c.created_at, c.updated_at,
             c.assigned_user_id,
             u.display_name AS assigned_user_name,
             u.role AS assigned_user_role
      FROM coexistence.contacts c
      LEFT JOIN coexistence.forgecrm_users u ON u.id = c.assigned_user_id
      WHERE c.wa_number = $1 AND c.contact_number = $2
      LIMIT 1
    `, [waNumber, contactNumber]);

    if (rows.length === 0) {
      return res.json({ contact_number: contactNumber, name: null, tags: [] });
    }

    res.json({ ...rows[0], tags: rows[0].tags || [] });
  } catch (err) {
    console.error('[messages] /contact error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// POST /api/messages/mark-read — stamp a conversation as read (agent opened it).
// Clears the unread badge for this (wa_number, contact_number).
router.post('/messages/mark-read', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.body;
    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;

    await pool.query(`
      INSERT INTO coexistence.conversation_reads (wa_number, contact_number, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (wa_number, contact_number)
      DO UPDATE SET last_read_at = NOW()
    `, [waNumber, contactNumber]);

    bus.emit('conversation-read', { waNumber, contactNumber });
    res.json({ ok: true });
  } catch (err) {
    console.error('[messages] /messages/mark-read error:', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// GET /api/messages?waNumber=xxx&contactNumber=xxx&page=1&limit=50
router.get('/messages', async (req, res) => {
  try {
    const {
      waNumber, contactNumber,
      page = '1', limit = '50',
      search = '', direction = 'all',
    } = req.query;

    if (!waNumber || !contactNumber) {
      return res.status(400).json({ error: 'waNumber and contactNumber required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const params = [waNumber, contactNumber];
    let paramIdx = 3;
    const conditions = [
      'wa_number = $1',
      'contact_number = $2',
      `timestamp >= NOW() - ${DEFAULT_DATA_WINDOW}`,
      // Defensive: never render status-receipt rows as chat bubbles (legacy
      // phantom "Status: delivered" rows; the webhook no longer creates these).
      `message_type <> 'status'`,
    ];

    const trimmedSearch = (typeof search === 'string' ? search : '').trim().slice(0, 200);
    if (trimmedSearch) {
      conditions.push(`COALESCE(message_body, '') ILIKE $${paramIdx}`);
      params.push(`%${trimmedSearch}%`);
      paramIdx++;
    }

    if (direction === 'incoming') {
      conditions.push(`direction = $${paramIdx}`);
      params.push('incoming');
      paramIdx++;
    } else if (direction === 'outgoing') {
      conditions.push(`direction = $${paramIdx}`);
      params.push('outgoing');
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM coexistence.chat_history WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.chat_history
       WHERE ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limitNum, offset]
    );

    // Attach reactions (emoji badges) to each message by its wamid.
    const ids = rows.map(r => r.message_id).filter(Boolean);
    const reactionsByMsg = {};
    if (ids.length > 0) {
      const { rows: rx } = await pool.query(
        `SELECT target_message_id, direction, emoji
           FROM coexistence.message_reactions
          WHERE target_message_id = ANY($1)`,
        [ids]
      );
      for (const r of rx) {
        (reactionsByMsg[r.target_message_id] ||= []).push({ emoji: r.emoji, direction: r.direction });
      }
    }

    res.json({
      messages: rows
        .map(m => ({ ...m, reactions: reactionsByMsg[m.message_id] || [] }))
        .reverse(), // oldest first for chat display
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error('[messages] /messages error:', err.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/contact-names?waNumber=xxx
router.get('/contact-names', async (req, res) => {
  try {
    const { waNumber } = req.query;
    if (!waNumber) return res.status(400).json({ error: 'waNumber required' });
    if (!(await assertWaAccess(req, res, waNumber))) return;

    const params = [waNumber];
    let assignFilter = '';
    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      assignFilter = `AND assigned_user_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT contact_number, COALESCE(name, profile_name) AS name FROM coexistence.contacts WHERE wa_number = $1 ${assignFilter}`,
      params
    );

    const nameMap = {};
    rows.forEach(r => { nameMap[r.contact_number] = r.name; });
    res.json(nameMap);
  } catch (err) {
    console.error('[messages] /contact-names error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact names' });
  }
});

/**
 * GET /messages/window-status?waNumber=&contactNumber=
 * Returns { canSendFreeForm: boolean, lastIncomingSecondsAgo: number|null, windowSeconds: 86400 }
 * The frontend uses this to grey out the chat input when outside the 24h
 * customer service window.
 */
router.get('/messages/window-status', async (req, res) => {
  try {
    const { waNumber, contactNumber } = req.query;
    if (!waNumber || !contactNumber) return res.status(400).json({ error: 'waNumber and contactNumber required' });
    const { account, error } = await resolveAccount({ fromPhoneNumber: waNumber });
    if (error) return res.json({ canSendFreeForm: false, reason: error, windowSeconds: SERVICE_WINDOW_SECONDS });
    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber });
    res.json({
      canSendFreeForm: secs != null && secs <= SERVICE_WINDOW_SECONDS,
      lastIncomingSecondsAgo: secs,
      windowSeconds: SERVICE_WINDOW_SECONDS,
      accountId: account.id,
      accountName: account.displayName,
    });
  } catch (err) {
    console.error('[messages] window-status error:', err.message);
    res.status(500).json({ error: 'Failed to compute window status' });
  }
});

/**
 * POST /messages/react
 * Body: { fromNumber, toNumber, messageId, emoji }
 * Sends a real WhatsApp reaction to `messageId` (empty emoji removes it) and
 * records it as our outgoing reaction. Subject to the 24h customer service
 * window, same as any free-form message.
 */
router.post('/messages/react', async (req, res) => {
  try {
    const { fromNumber, toNumber, messageId, emoji } = req.body || {};
    if (!fromNumber || !toNumber || !messageId) {
      return res.status(400).json({ error: 'fromNumber, toNumber and messageId required' });
    }
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(409).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    const cleanEmoji = typeof emoji === 'string' ? emoji : '';
    const wa = String(fromNumber).replace(/\D/g, '');
    const contact = String(toNumber).replace(/\D/g, '');

    // Record our reaction (outgoing). Empty emoji removes it.
    if (cleanEmoji) {
      await pool.query(
        `INSERT INTO coexistence.message_reactions
           (wa_number, contact_number, target_message_id, direction, emoji, updated_at)
         VALUES ($1,$2,$3,'outgoing',$4,NOW())
         ON CONFLICT (target_message_id, direction)
         DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()`,
        [wa, contact, messageId, cleanEmoji]
      );
    } else {
      await pool.query(
        `DELETE FROM coexistence.message_reactions WHERE target_message_id = $1 AND direction = 'outgoing'`,
        [messageId]
      );
    }

    await enqueueSend({
      kind: 'reaction',
      accountId: account.id,
      to: contact,
      payload: { messageId, emoji: cleanEmoji },
    });

    res.json({ ok: true, messageId, emoji: cleanEmoji, direction: 'outgoing' });
  } catch (err) {
    console.error('[messages] /react error:', err.message);
    res.status(500).json({ error: 'Failed to send reaction' });
  }
});

/**
 * POST /messages/star
 * Body: { waNumber, contactNumber, messageId, starred }
 * Toggles the local "starred" flag on a message (CRM-only bookmark).
 */
router.post('/messages/star', async (req, res) => {
  try {
    const { waNumber, contactNumber, messageId, starred } = req.body || {};
    if (!waNumber || !contactNumber || !messageId) {
      return res.status(400).json({ error: 'waNumber, contactNumber and messageId required' });
    }
    if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
    const { rowCount } = await pool.query(
      `UPDATE coexistence.chat_history SET starred = $1 WHERE message_id = $2`,
      [!!starred, messageId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true, messageId, starred: !!starred });
  } catch (err) {
    console.error('[messages] /star error:', err.message);
    res.status(500).json({ error: 'Failed to update star' });
  }
});

/**
 * POST /messages/send
 * Body: { fromNumber, toNumber, text }
 * Inserts an optimistic chat_history row (status='sending') and enqueues a
 * BullMQ job. Returns the row immediately so the UI can render the bubble.
 */
router.post('/messages/send', async (req, res) => {
  try {
    const { fromNumber, toNumber, text, contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber || !text || !String(text).trim()) {
      return res.status(400).json({ error: 'fromNumber, toNumber, text required' });
    }

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(400).json({ error });

    // Enforce Meta's 24h customer service window for free-form text
    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({
        error: 'Outside 24-hour customer service window. Send an approved template instead.',
        code: 'OUTSIDE_WINDOW',
      });
    }

    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'text', messageBody: String(text).trim(),
      contextMessageId: ctxId,
    });

    const trimmedText = String(text).trim();
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      // Tag as a human chat reply so it's eligible to fire OUTBOUND keyword triggers.
      originRef: { kind: 'chat_reply' },
      // Enable WhatsApp link preview when the message contains a URL
      payload: { body: trimmedText, previewUrl: /https?:\/\/\S+/i.test(trimmedText), contextMessageId: ctxId },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending' });
  } catch (err) {
    console.error('[messages] send error:', err.message);
    res.status(500).json({ error: 'Failed to enqueue send' });
  }
});

/**
 * POST /messages/send-media (multipart)
 * Fields: fromNumber, toNumber, caption?, file (binary)
 * Uploads the binary to Meta to get a media_id, then enqueues a send job.
 * Subject to the 24h customer service window same as text.
 */
router.post('/messages/send-media', mediaUpload.single('file'), async (req, res) => {
  try {
    const { fromNumber, toNumber, caption = '', contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    const kind = classifyChatMediaKind(req.file.mimetype);
    if (!kind) return res.status(400).json({ error: 'Unsupported file type' });

    // Step 1: upload binary to Meta to get media_id
    let mediaId;
    try {
      const uploaded = await uploadMedia({
        accessToken: account.accessToken,
        phoneNumberId: account.phoneNumberId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }

    // Step 2: insert optimistic row + mirror file locally so the bubble
    // renders the actual thumbnail / playback via /api/media/:messageId
    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: kind,
      messageBody: caption || req.file.originalname,
      mediaMime: req.file.mimetype,
      contextMessageId: ctxId,
    });
    const ext = req.file.originalname.split('.').pop()?.toLowerCase() || req.file.mimetype.split('/')[1] || 'bin';
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId,
      buffer: req.file.buffer, ext,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_filename = $3,
              media_downloaded_at = NOW()
        WHERE message_id = $4`,
      [absPath, size, req.file.originalname, localId]
    );

    // Step 3: enqueue send to Meta
    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      originRef: { kind: 'chat_reply' },  // human chat reply → eligible for outbound triggers
      payload: {
        type: kind, mediaId, caption: caption || undefined,
        filename: kind === 'document' ? req.file.originalname : undefined,
        contextMessageId: ctxId,
      },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', mediaId });
  } catch (err) {
    console.error('[messages] send-media error:', err.message);
    res.status(500).json({ error: 'Failed to send media' });
  }
});

/**
 * POST /messages/send-audio (multipart)
 * Fields: fromNumber, toNumber, file (browser-recorded audio blob)
 * Transcodes the browser's webm/opus output to ogg/opus (Meta-accepted),
 * uploads to Meta, mirrors locally, and enqueues send.
 */
router.post('/messages/send-audio', mediaUpload.single('file'), async (req, res) => {
  try {
    const { fromNumber, toNumber, contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber) return res.status(400).json({ error: 'fromNumber and toNumber required' });
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({ accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    // Transcode to Meta-accepted format if needed
    let audioBuffer, audioMime, audioExt;
    try {
      const transcoded = await transcodeAudioForMeta(req.file.buffer, req.file.mimetype);
      audioBuffer = transcoded.buffer;
      audioMime = transcoded.mime;
      audioExt = transcoded.ext;
    } catch (err) {
      return res.status(400).json({ error: `Audio transcode failed: ${err.message}` });
    }

    // Upload to Meta
    let mediaId;
    try {
      const uploaded = await uploadMedia({
        accessToken: account.accessToken, phoneNumberId: account.phoneNumberId,
        buffer: audioBuffer, mimeType: audioMime, filename: `voice.${audioExt}`,
      });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }

    // Insert optimistic row + mirror locally
    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: 'audio',
      messageBody: 'Voice message', mediaMime: audioMime,
      contextMessageId: ctxId,
    });
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId,
      buffer: audioBuffer, ext: audioExt,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_downloaded_at = NOW()
        WHERE message_id = $3`,
      [absPath, size, localId]
    );

    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      originRef: { kind: 'chat_reply' },  // human chat reply → eligible for outbound triggers
      payload: { type: 'audio', mediaId, contextMessageId: ctxId },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', mediaId });
  } catch (err) {
    console.error('[messages] send-audio error:', err.message);
    res.status(500).json({ error: 'Failed to send audio' });
  }
});

/**
 * POST /messages/send-library-media
 * Body: { fromNumber, toNumber, mediaLibraryId, caption? }
 *
 * Sends an existing Media Library item to a contact. Resolves the WABA from
 * `fromNumber`, finds (or refreshes) the per-WABA Meta media_id for that
 * library item, mirrors the file from MinIO into /app/media so the chat
 * bubble renders, and enqueues the send.
 *
 * Auto-resyncs if no sync row exists for this WABA, or if the existing
 * meta_media_id is expired/failed — the caller never has to worry about
 * Meta's 28-day TTL.
 */
router.post('/messages/send-library-media', async (req, res) => {
  try {
    const { fromNumber, toNumber, mediaLibraryId, caption = '', contextMessageId } = req.body || {};
    if (!fromNumber || !toNumber || !mediaLibraryId) {
      return res.status(400).json({ error: 'fromNumber, toNumber, mediaLibraryId required' });
    }

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({
      accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber,
    });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({ error: 'Outside 24-hour customer service window.', code: 'OUTSIDE_WINDOW' });
    }

    const { rows: mRows } = await pool.query(
      `SELECT * FROM coexistence.media_library
        WHERE id = $1 AND deleted_at IS NULL`,
      [mediaLibraryId]
    );
    if (!mRows.length) return res.status(404).json({ error: 'Media not found in library' });
    const media = mRows[0];

    // Resolve per-WABA meta_media_id; auto-(re)sync if missing/expired/failed
    const { rows: sRows } = await pool.query(
      `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
      [media.id, account.id]
    );
    let sync = sRows[0];
    const needsSync = !sync
      || sync.status !== 'synced'
      || !sync.meta_media_id
      || (sync.expires_at && new Date(sync.expires_at) <= new Date());
    if (needsSync) {
      try {
        sync = await syncMediaToAccount(media.id, account.id);
        // syncMediaToAccount returns a `rowToSync`-shaped object — adapt keys
        sync = {
          meta_media_id: sync.metaMediaId,
          expires_at: sync.expiresAt,
          status: sync.status,
        };
      } catch (err) {
        return res.status(502).json({ error: `Auto-sync to Meta failed: ${err.message}` });
      }
    }

    const kind = classifyChatMediaKind(media.mime_type);
    if (!kind) return res.status(400).json({ error: 'Unsupported library media type for chat send' });

    // Fetch bytes from MinIO so we can mirror locally for bubble rendering
    let buf;
    try {
      buf = await minio.getObjectBuffer(media.minio_object_key);
    } catch (err) {
      return res.status(502).json({ error: `Failed to read media from storage: ${err.message}` });
    }

    const ctxId = sanitizeContextId(contextMessageId);
    const localId = await insertPendingRow({
      account, toNumber, messageType: kind,
      messageBody: caption || media.original_name,
      mediaMime: media.mime_type,
      contextMessageId: ctxId,
    });
    const ext = media.original_name.split('.').pop()?.toLowerCase() || media.mime_type.split('/')[1] || 'bin';
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId, buffer: buf, ext,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_filename = $3,
              media_downloaded_at = NOW()
        WHERE message_id = $4`,
      [absPath, size, media.original_name, localId]
    );

    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      originRef: { kind: 'chat_reply' },  // human chat reply → eligible for outbound triggers
      payload: {
        type: kind,
        mediaId: sync.meta_media_id,
        caption: caption || undefined,
        filename: kind === 'document' ? media.original_name : undefined,
        contextMessageId: ctxId,
      },
    });

    res.status(202).json({
      ok: true, messageId: localId, status: 'sending',
      mediaId: sync.meta_media_id, mediaLibraryId: Number(media.id),
    });
  } catch (err) {
    console.error('[messages] send-library-media error:', err.message);
    res.status(500).json({ error: 'Failed to send library media' });
  }
});

/**
 * POST /messages/forward
 * Body: { fromNumber, toNumber, messageId }
 *
 * Forwards an existing chat message (in either direction) to another contact.
 * Text-ish rows re-send their body; media rows re-upload the LOCALLY STORED
 * file to Meta to mint a fresh media_id for this send.
 *
 * Why re-upload instead of reusing the inbound `media_url` (Meta's media id):
 * a media id is scoped to the number that uploaded it and inbound ids are only
 * guaranteed for *download*. Re-uploading the bytes we already mirrored on disk
 * is the one path that works for inbound AND outbound sources, and it reuses
 * the exact pipeline /messages/send-media uses (so ticks, the bubble thumbnail
 * and outbound triggers all behave identically).
 */
const FORWARD_MEDIA_KINDS = {
  image: 'image', video: 'video', document: 'document',
  audio: 'audio', voice: 'audio',   // voice notes go out as an audio message
  sticker: 'sticker',
};

// The stored path comes from our own DB, but keep media reads pinned inside
// MEDIA_DIR regardless — a bad/legacy row must never read arbitrary files.
function resolveStoredMedia(absPath) {
  if (!absPath) return null;
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

router.post('/messages/forward', async (req, res) => {
  try {
    const { fromNumber, toNumber, messageId } = req.body || {};
    if (!fromNumber || !toNumber || !messageId) {
      return res.status(400).json({ error: 'fromNumber, toNumber and messageId required' });
    }

    const { rows: srcRows } = await pool.query(
      `SELECT * FROM coexistence.chat_history WHERE message_id = $1`,
      [messageId]
    );
    const src = srcRows[0];
    if (!src) return res.status(404).json({ error: 'Original message not found' });

    // Must own both ends: the conversation being copied FROM and the one being
    // sent TO (admins bypass both).
    if (!(await assertContactAccess(req, res, src.wa_number, src.contact_number))) return;
    if (!(await assertContactAccess(req, res, fromNumber, toNumber))) return;

    const { account, error } = await resolveAccount({ fromPhoneNumber: fromNumber });
    if (error) return res.status(400).json({ error });

    const secs = await secondsSinceLastIncoming({
      accountPhoneNumberId: account.phoneNumberId, contactNumber: toNumber,
    });
    if (secs == null || secs > SERVICE_WINDOW_SECONDS) {
      return res.status(409).json({
        error: 'Outside 24-hour customer service window. Send an approved template instead.',
        code: 'OUTSIDE_WINDOW',
      });
    }

    const type = String(src.message_type || '').toLowerCase();
    const mediaKind = FORWARD_MEDIA_KINDS[type];
    const body = (src.message_body || '').trim();

    // ---- Non-media: re-send the body as text (unchanged from the original
    // text-only forward behaviour, which also covered template/interactive
    // rows whose content is their body). ----
    if (!mediaKind) {
      if (!body) {
        return res.status(400).json({ error: `A ${type || 'message'} message has no content that can be forwarded.` });
      }
      const localId = await insertPendingRow({
        account, toNumber, messageType: 'text', messageBody: body,
      });
      await enqueueSend({
        kind: 'text',
        accountId: account.id,
        to: String(toNumber).replace(/\D/g, ''),
        localMessageId: localId,
        originRef: { kind: 'chat_reply' },
        payload: { body, previewUrl: /https?:\/\/\S+/i.test(body) },
      });
      return res.status(202).json({ ok: true, messageId: localId, status: 'sending', forwardedAs: 'text' });
    }

    // ---- Media: make sure the bytes are on disk, then re-upload them ----
    let abs = src.media_status === 'stored' ? resolveStoredMedia(src.media_storage_path) : null;
    let mime = src.media_mime_type || null;
    let filename = src.media_filename || null;
    if (!abs) {
      // Never downloaded (or the file went missing) — try once, now.
      const { downloadOne } = require('../services/mediaDownloader');
      const dl = await downloadOne(messageId);
      if (!dl.ok) {
        return res.status(400).json({
          error: 'That file is no longer available to forward. WhatsApp only keeps media for a limited time.',
        });
      }
      const { rows: freshRows } = await pool.query(
        `SELECT media_storage_path, media_mime_type, media_filename
           FROM coexistence.chat_history WHERE message_id = $1`,
        [messageId]
      );
      abs = resolveStoredMedia(freshRows[0]?.media_storage_path);
      mime = freshRows[0]?.media_mime_type || mime;
      filename = freshRows[0]?.media_filename || filename;
      if (!abs) return res.status(400).json({ error: 'That file could not be read for forwarding.' });
    }

    const ext = (abs.split('.').pop() || '').toLowerCase() || 'bin';
    if (!mime) mime = EXT_MIME_FALLBACK[ext] || 'application/octet-stream';
    if (!filename) filename = `${mediaKind === 'document' ? 'document' : mediaKind}.${ext}`;

    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch (err) {
      return res.status(400).json({ error: 'That file could not be read for forwarding.' });
    }

    // Upload to Meta for a media_id this account can send.
    let mediaId;
    try {
      const uploaded = await uploadMedia({
        accessToken: account.accessToken,
        phoneNumberId: account.phoneNumberId,
        buffer, mimeType: mime, filename,
      });
      mediaId = uploaded?.id;
      if (!mediaId) throw new Error('Meta upload returned no id');
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const cls = classifyMetaError(err);
      await markAccountHealth(account.id, cls, err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }

    // Optimistic row + local mirror so the forwarded bubble renders instantly.
    // Keep the SOURCE type (e.g. 'voice') on our row so the bubble looks the
    // same as the original; only Meta gets the mapped kind.
    const caption = (mediaKind === 'image' || mediaKind === 'video' || mediaKind === 'document') ? body : '';
    const localId = await insertPendingRow({
      account, toNumber, messageType: type,
      messageBody: caption || (mediaKind === 'document' ? filename : null),
      mediaMime: mime,
    });
    const accountDigits = (account.displayPhoneNumber || '').replace(/\D/g, '');
    const { absPath, size } = persistOutboundMedia({
      accountPhoneDigits: accountDigits, messageId: localId, buffer, ext,
    });
    await pool.query(
      `UPDATE coexistence.chat_history
          SET media_storage_path = $1, media_status = 'stored',
              media_size_bytes = $2, media_filename = $3,
              media_downloaded_at = NOW()
        WHERE message_id = $4`,
      [absPath, size, filename, localId]
    );

    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(toNumber).replace(/\D/g, ''),
      localMessageId: localId,
      originRef: { kind: 'chat_reply' },
      payload: {
        type: mediaKind,
        mediaId,
        caption: caption || undefined,
        filename: mediaKind === 'document' ? filename : undefined,
      },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending', forwardedAs: mediaKind, mediaId });
  } catch (err) {
    console.error('[messages] forward error:', err.message);
    res.status(500).json({ error: 'Failed to forward message' });
  }
});

module.exports = { router };
