const socialEnv = require('../env');
// Media handling for agent DMs: vision (images) + voice-note transcription.
//
// Images: read and base64-encoded so a vision-capable model can see them.
// Audio: transcribed with OpenAI Whisper (whisper-1) — the agent's chat provider
// can be anything (Anthropic/Gemini/…); transcription always uses an OpenAI
// credential from the ai_models registry (or OPENAI_API_KEY), independent of it.
//
// Attachment URLs come in two shapes: the original Instagram CDN URL (fresh at
// webhook time) OR a localized `/api/social/uploads/<file>` path after the inbox's
// localizeAttachments() has downloaded it. Both are handled — CDN via fetch,
// localized via a disk read from UPLOADS_DIR.

const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { decrypt } = require('../util/crypto');
const OpenAI = require('openai');

const UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // vision APIs cap ~5MB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;  // Whisper cap 25MB
const FETCH_TIMEOUT = 20000;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.aac': 'audio/aac',
};

// Pick the first image / audio attachment. Shape: [{ type, payload:{ url } }].
// Accepts CDN http(s) URLs AND localized /api/uploads/ paths.
function pickAttachment(attachments, kind) {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    const type = (a?.type || a?.payload?.type || '').toLowerCase();
    const url = a?.payload?.url || a?.url;
    if (!url || typeof url !== 'string') continue;
    const local = url.includes('/api/social/uploads/');
    if (!local && !/^https?:\/\//i.test(url)) continue;
    // Instagram CDN URLs don't have file extensions (e.g. lookaside.fbsbx.com/ig_messaging_cdn/…)
    // — match by attachment type field OR by extension OR by known CDN hostname.
    const isIgCdn = /fbsbx\.com|instagram\.com|cdninstagram\.com/i.test(url);
    if (kind === 'image' && (type === 'image' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) || (isIgCdn && type !== 'audio' && type !== 'voice' && type !== 'video'))) return { url };
    if (kind === 'audio' && (type === 'audio' || type === 'voice' || /\.(mp3|m4a|ogg|oga|wav|webm|aac)(\?|$)/i.test(url))) return { url };
  }
  return null;
}

async function fetchBuffer(url, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`file too large (${buf.length} bytes)`);
    const mime = (res.headers.get('content-type') || '').split(';')[0] || null;
    return { buf, mime };
  } finally {
    clearTimeout(timer);
  }
}

// Read a localized /api/uploads/<file> path from disk (basename-only → no
// path traversal).
async function readLocal(url, maxBytes) {
  const idx = url.indexOf('/api/social/uploads/');
  const name = path.basename(idx >= 0 ? url.slice(idx + '/api/social/uploads/'.length) : url);
  const fpath = path.join(UPLOADS_DIR, name);
  const buf = await fs.promises.readFile(fpath);
  if (buf.length > maxBytes) throw new Error(`file too large (${buf.length} bytes)`);
  return { buf, mime: MIME_BY_EXT[path.extname(name).toLowerCase()] || null };
}

// Read bytes from either a CDN URL or a localized uploads path.
async function readMedia(url, maxBytes) {
  if (/^https?:\/\//i.test(url)) return fetchBuffer(url, maxBytes);
  return readLocal(url, maxBytes);
}

async function resolveOpenAiKey() {
  try {
    const { rows } = await pool.query(
      `SELECT api_key_encrypted FROM ai_models
        WHERE provider = 'openai' AND api_key_encrypted IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`);
    if (rows[0]) { const k = decrypt(rows[0].api_key_encrypted); if (k) return k; }
  } catch (e) { console.error('[agentMedia] resolveOpenAiKey failed:', e.message); }
  return '';   // no env-key fallback (OpenAI credentials removed 2026-10-11)
}

// Read an image → { mime, data(base64) } or null.
async function loadImageBase64(url) {
  try {
    const { buf, mime } = await readMedia(url, MAX_IMAGE_BYTES);
    if (!buf.length) return null;
    return { mime: mime && mime.startsWith('image/') ? mime : 'image/jpeg', data: buf.toString('base64') };
  } catch (e) {
    console.error('[agentMedia] loadImageBase64 failed:', e.message, '— url:', url);
    return null;
  }
}

// Read a voice note → Whisper transcript text ('' on any failure / no key).
async function transcribeFromUrl(url) {
  try {
    const apiKey = await resolveOpenAiKey();
    if (!apiKey) { console.warn('[agentMedia] transcribe skipped — no OpenAI key connected.'); return ''; }
    const { buf } = await readMedia(url, MAX_AUDIO_BYTES);
    if (!buf.length) return '';
    const ext = /\.(\w+)(\?|$)/i.exec(url)?.[1]?.toLowerCase() || 'm4a';
    const file = await OpenAI.toFile(buf, `voice.${ext}`);
    const client = new OpenAI({ apiKey });
    const tr = await client.audio.transcriptions.create({ file, model: 'whisper-1' });
    return (tr?.text || '').trim();
  } catch (e) {
    console.error('[agentMedia] transcribeFromUrl failed:', e.message, '— url:', url);
    return '';
  }
}

module.exports = { pickAttachment, loadImageBase64, transcribeFromUrl, resolveOpenAiKey };
