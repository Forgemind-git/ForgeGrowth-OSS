// Speech-to-text for WhatsApp voice notes, via OpenRouter's Speech-to-Text API
// running microsoft/mai-transcribe-2.
//
// ONE implementation for every caller: the Chat Analyzer (which caches the
// result per message in chat_message_artifacts), the AI agent engine and the
// agent test chat. OpenAI Whisper was removed on 2026-09-23 — MAI-Transcribe 2
// is multilingual (Tamil/English code-switching, which Whisper garbled) and
// cheaper.
//
// ⚠ FORMATS, MEASURED against the live endpoint rather than assumed: ogg/opus
// (WhatsApp's own voice-note format), mp3 and wav are accepted as-is; webm
// (browser recordings in the agent test chat) and m4a/aac are REFUSED with a
// bare "Provider returned 400". Anything outside the accepted set is therefore
// transcoded to mp3 with ffmpeg first (already in the image for the voice-note
// transcode) — otherwise those files fail forever with no useful reason.
//
// ⚠ OpenRouter returns the REAL cost of each call in `usage.cost` (USD). That is
// what gets recorded, not a rate-card estimate — the rate card is only for
// estimating notes that have not been transcribed yet.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const DEFAULT_TRANSCRIBE_MODEL = 'microsoft/mai-transcribe-2';
const PROVIDER = 'openrouter';

// Container formats the endpoint accepts without conversion.
const DIRECT_FORMATS = new Set(['ogg', 'mp3', 'wav']);

/**
 * The OpenRouter key, in order: the newest OpenRouter credential in Admin
 * Settings → AI Models (so it can be rotated from the UI), else the
 * OPENROUTER_API_KEY env var. '' when neither exists.
 */
async function openRouterKey() {
  try {
    const pool = require('../db');
    const { decrypt } = require('../util/crypto');
    const { rows } = await pool.query(
      `SELECT api_key_encrypted FROM coexistence.ai_models
        WHERE provider = 'openrouter' AND api_key_encrypted IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`);
    const k = rows[0] ? decrypt(rows[0].api_key_encrypted) : '';
    if (k && k.trim()) return k.trim();
  } catch (err) {
    console.warn('[transcription] could not read the OpenRouter credential:', err.message);
  }
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

/** 'ogg' | 'mp3' | 'wav' | null — what to call this file on the wire, if it can go as-is. */
function directFormat(filePath, mime = '') {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  const ext = path.extname(filePath || '').slice(1).toLowerCase();
  if (ext === 'opus' || ext === 'oga') return 'ogg';
  return DIRECT_FORMATS.has(ext) ? ext : null;
}

function transcodeToMp3(src) {
  const out = path.join(os.tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-b:a', '48k', out],
      { timeout: 120000 },
      (err) => (err ? reject(new Error(`Could not convert the audio for transcription: ${err.message}`)) : resolve(out)));
  });
}

/**
 * Transcribe a local audio file.
 *  - filePath: a file on disk (ogg/mp3/wav go as-is; anything else is converted)
 *  - apiKey:   OpenRouter key; defaults to the AI Models credential, then OPENROUTER_API_KEY
 *  - model:    defaults to microsoft/mai-transcribe-2
 *  - mime:     optional stored mime type, used to pick the wire format
 *
 * Returns { text, seconds, costUsd, model, provider }. Throws on an API error so
 * callers can record WHY (the analyser caches it as 'failed' and retries later).
 */
async function transcribeAudio({ filePath, apiKey, model, mime } = {}) {
  const key = (apiKey || await openRouterKey()).trim();
  const useModel = model || DEFAULT_TRANSCRIBE_MODEL;
  if (!key) throw new Error('No OpenRouter key is connected (Admin Settings → AI Models), so voice notes cannot be transcribed');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('The audio file is missing');

  let sendPath = filePath;
  let format = directFormat(filePath, mime);
  let tmp = null;
  try {
    if (!format) {
      tmp = await transcodeToMp3(filePath);
      sendPath = tmp;
      format = 'mp3';
    }
    const data = fs.readFileSync(sendPath).toString('base64');
    const res = await fetch(OPENROUTER_STT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-Title': 'Forge Growth',
      },
      body: JSON.stringify({ model: useModel, input_audio: { data, format } }),
      signal: AbortSignal.timeout(180000),
    });
    const raw = await res.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = body?.error?.message || raw.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(`OpenRouter transcription failed (${res.status}): ${msg}`);
    }
    const usage = body?.usage || {};
    return {
      text: body?.text ? String(body.text).trim() : '',
      seconds: Number(usage.seconds) || null,
      costUsd: Number(usage.cost) || 0,
      model: useModel,
      provider: PROVIDER,
    };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
  }
}

/**
 * Text-only convenience for callers that only need the words. Returns '' on any
 * failure (logged) instead of throwing — the agent engine must never lose a
 * customer's turn because transcription had a bad moment.
 */
async function transcribeAudioFile(opts = {}) {
  try {
    return (await transcribeAudio(opts)).text;
  } catch (err) {
    console.warn('[transcription]', err.message);
    return '';
  }
}

module.exports = {
  transcribeAudio, transcribeAudioFile, openRouterKey, directFormat,
  DEFAULT_TRANSCRIBE_MODEL, PROVIDER,
};
