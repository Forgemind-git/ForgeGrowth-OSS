// Which chat messages carry a file from our own Media Library — and what that
// file IS, in the words of its Media Library description.
//
// Sales material (the brochure PDF, the course video, the Live Lab voice note)
// is uploaded once to the Media Library and then sent to hundreds of people by
// automations, agents, broadcasts and the API. A chat message keeps no pointer
// back to the library item, but the BYTES are identical: the stored file's
// SHA-256 equals media_library.sha256 (measured: 250 of the last 400 outgoing
// media messages matched). So the match is by content, which also covers every
// historical message and every send path, including ones added later.
//
// ⚠ WHY THIS MATTERS: without it, an AI reading the chat either sees a bare
// "[document]" or pays to parse/transcribe the SAME company file once per recipient (the
// Live Lab voice note went out 74 times). With it, the description says what was
// shared — "course brochure: syllabus, fees, dates" — for free.
//
// The match is cached per message in chat_message_artifacts (kind 'library':
// text = the library id, or '' for "not a library file"), because a message is
// immutable and hashing a 15 MB video on every read is not free. The NAME and
// DESCRIPTION are always read live from media_library, so editing a
// description applies to every message already sent.

const fs = require('fs');
const crypto = require('crypto');
const pool = require('../db');

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function localFile(source, messageKey) {
  if (source === 'chat') {
    const { rows } = await pool.query(
      `SELECT media_storage_path FROM coexistence.chat_history WHERE message_id = $1`, [messageKey]);
    const p = rows[0]?.media_storage_path;
    // Only what is already on disk. Never fetch from Meta just to find out
    // whether a file is ours — a missing file is simply "not matched yet".
    return p && fs.existsSync(p) ? { path: p, cleanup: () => {} } : null;
  }
  // Groups: the archived copy in MinIO (Evolution keeps nothing).
  const { storedCopy } = require('./communityMediaArchiver');
  const copy = await storedCopy(messageKey).catch(() => null);
  if (!copy?.object_key) return null;
  const minio = require('../util/minioClient');
  const os = require('os');
  const path = require('path');
  const buf = await minio.getObjectBuffer(copy.object_key);
  const tmp = path.join(os.tmpdir(), `lib-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, buf);
  return { path: tmp, cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* best effort */ } } };
}

/**
 * Library info for the media messages among `rows`.
 * @param rows  [{ message_id, message_type }]
 * @returns Map message_id → { id, name, description, mediaType }
 */
async function libraryMatches(source, rows) {
  const media = (rows || []).filter(r => r && r.message_id && MEDIA_TYPES.has(r.message_type));
  const out = new Map();
  if (!media.length) return out;
  const keys = media.map(r => r.message_id);

  const { rows: cached } = await pool.query(
    `SELECT message_key, text FROM coexistence.chat_message_artifacts
      WHERE source = $1 AND kind = 'library' AND message_key = ANY($2::text[])`,
    [source, keys]
  );
  const idByKey = new Map(cached.map(c => [c.message_key, c.text]));

  for (const key of keys) {
    if (idByKey.has(key)) continue;
    let file = null;
    try {
      file = await localFile(source, key);
      if (!file) continue;                      // not on disk yet — try again next time
      const sha = await sha256File(file.path);
      const { rows: lib } = await pool.query(
        `SELECT id FROM coexistence.media_library WHERE sha256 = $1
          ORDER BY (deleted_at IS NULL) DESC, id DESC LIMIT 1`, [sha]);
      const libId = lib[0] ? String(lib[0].id) : '';
      await pool.query(
        `INSERT INTO coexistence.chat_message_artifacts
           (source, message_key, kind, text, status, provider, model, cost_micros)
         VALUES ($1, $2, 'library', $3, $4, 'local', 'sha256', 0)
         ON CONFLICT (source, message_key, kind) DO NOTHING`,
        [source, key, libId, libId ? 'ok' : 'empty']
      );
      idByKey.set(key, libId);
    } catch (err) {
      console.warn('[libraryMedia] could not match', key, err.message);
    } finally {
      if (file) file.cleanup();
    }
  }

  const ids = [...new Set([...idByKey.values()].filter(Boolean).map(Number))];
  if (!ids.length) return out;
  const { rows: libRows } = await pool.query(
    `SELECT id, COALESCE(name, original_name, filename) AS name, notes, media_type
       FROM coexistence.media_library WHERE id = ANY($1::bigint[])`, [ids]);
  const libById = new Map(libRows.map(l => [String(l.id), l]));
  for (const [key, id] of idByKey) {
    const l = id && libById.get(id);
    if (l) {
      out.set(key, {
        id: Number(l.id), name: l.name || 'Untitled',
        description: (l.notes || '').trim() || null, mediaType: l.media_type,
      });
    }
  }
  return out;
}

/** One line of context for a library file — what a model or a reader sees. */
function libraryLabel(lib, type) {
  const kind = type === 'voice' || type === 'audio' ? 'voice note'
    : type === 'document' ? 'document' : type === 'video' ? 'video' : type === 'image' ? 'image' : 'file';
  return lib.description
    ? `[${kind} from our Media Library: "${lib.name}" — ${lib.description}]`
    : `[${kind} from our Media Library: "${lib.name}"]`;
}

// ── what is INSIDE a document we send ─────────────────────────────────────────
//
// A one-line description ("has syllabus, fees, dates") tells an AI reader that
// a brochure exists, not what it SAYS — so it could not know the customer had
// already been given the schedule, the class dates or the "Claude Pro is
// mandatory" note, and recommended telling them again. The file is ours and
// immutable per sha256, so its text is parsed once per process (pdf-parse,
// local, free) and reused for every chat it was sent in.

const DOC_TEXT_CAP = 6000;
const _docText = new Map();          // `${id}:${sha}` → text ('' = unreadable)

/** Page markers and tab runs out. Letter-spaced headings ("S T A R T S") are
 *  left alone: the word breaks inside them are lost, and a model reads them fine. */
function tidyPdfText(t) {
  return String(t || '')
    .replace(/^-- \d+ of \d+ --$/gm, '')
    .replace(/\t/g, ' · ')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The readable text of a Media Library document (PDF only), or '' when it has
 * none. Never throws — a file that cannot be read just adds nothing.
 */
async function libraryFileText(libId) {
  const { rows: [l] } = await pool.query(
    `SELECT id, sha256, mime_type, media_type, minio_object_key
       FROM coexistence.media_library WHERE id = $1`, [libId]);
  if (!l || !l.minio_object_key || !/pdf/i.test(l.mime_type || '')) return '';
  const key = `${l.id}:${l.sha256}`;
  if (_docText.has(key)) return _docText.get(key);
  let text = '';
  try {
    const minio = require('../util/minioClient');
    const buf = await minio.getObjectBuffer(l.minio_object_key);
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try { text = tidyPdfText((await parser.getText()).text); } finally { await parser.destroy().catch(() => {}); }
    if (text.length > DOC_TEXT_CAP) text = `${text.slice(0, DOC_TEXT_CAP)}…`;
  } catch (err) {
    console.warn('[libraryMedia] could not read library file', libId, err.message);
    return '';                         // not cached — a MinIO blip should not stick
  }
  _docText.set(key, text);
  return text;
}

module.exports = { libraryMatches, libraryLabel, libraryFileText, tidyPdfText, MEDIA_TYPES };
