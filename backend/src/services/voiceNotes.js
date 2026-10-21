// One voice note in a chat: read its transcript, estimate what transcribing it
// would cost, and transcribe it — from the Chats window, one bubble at a time.
//
// ⚠ SAME CACHE AS AI AGENTS AND WORKFLOW AGENTS (chat_message_artifacts,
// kind 'transcript'). A note transcribed anywhere shows here, and a note
// transcribed here is reused everywhere. A note that already has a transcript is
// NEVER sent to the model again and its text is never overwritten:
// extractArtifact returns the cached row for any status except 'failed'.

const fs = require('fs');
const pool = require('../db');
const extract = require('./mediaExtract');
const { probeDurationSeconds } = require('./mediaDuration');

const AUDIO_TYPES = new Set(['audio', 'voice']);

// Used only when the file is not on disk yet (it would be fetched from Meta on
// transcription), so its length cannot be measured. Bitrates of what WhatsApp
// actually delivers: opus voice notes ~16 kbps, mp3 audio ~64 kbps.
function secondsFromBytes(bytes, mime) {
  if (!bytes) return null;
  const kbps = /ogg|opus/i.test(mime || '') ? 16 : 64;
  return Math.max(1, Math.round((bytes * 8) / (kbps * 1000)));
}

// ── transcription settings ──────────────────────────────────────────────────
//
// The length cap, rate card and USD→INR rate were saved in
// coexistence.chat_analyser_config, the Chat Analyzer's settings row. That
// feature was removed (2026-10-21) but the row is kept, so an install that
// raised its voice-note cap keeps it. Only these transcription columns are read;
// the defaults below (the migration-110/123 defaults) apply when the row or the
// table is missing.
const TRANSCRIPTION_DEFAULTS = {
  transcribe_model: 'microsoft/mai-transcribe-2',
  max_audio_seconds: 300,
  usd_to_inr: 88,
  rate_card: { audio: { 'microsoft/mai-transcribe-2': { perMinute: 0.00167 }, default: { perMinute: 0.00167 } } },
};

let _cfgCache = null;
let _cfgAt = 0;

async function loadConfig() {
  if (_cfgCache && Date.now() - _cfgAt < 15000) return _cfgCache;
  let row = null;
  try {
    const { rows } = await pool.query(
      `SELECT max_audio_seconds, usd_to_inr, rate_card
         FROM coexistence.chat_analyser_config WHERE id = 1`);
    row = rows[0] || null;
  } catch { /* table absent: defaults */ }
  const conf = { ...TRANSCRIPTION_DEFAULTS };
  if (row) {
    if (Number(row.max_audio_seconds) > 0) conf.max_audio_seconds = Number(row.max_audio_seconds);
    if (Number(row.usd_to_inr) > 0) conf.usd_to_inr = Number(row.usd_to_inr);
    if (row.rate_card && row.rate_card.audio) conf.rate_card = row.rate_card;
  }
  _cfgCache = conf;
  _cfgAt = Date.now();
  return conf;
}

async function loadNote(messageId) {
  const { rows } = await pool.query(
    `SELECT message_id, wa_number, contact_number, message_type, media_mime_type,
            media_size_bytes, media_storage_path
       FROM coexistence.chat_history WHERE message_id = $1`,
    [messageId]
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error('That message no longer exists'), { status: 404 });
  if (!AUDIO_TYPES.has(row.message_type)) {
    throw Object.assign(new Error('Only voice notes and audio messages can be transcribed'), { status: 400 });
  }
  return row;
}

async function readArtifact(messageId) {
  const { rows } = await pool.query(
    `SELECT text, status, error, model, provider, audio_seconds, cost_micros, updated_at
       FROM coexistence.chat_message_artifacts
      WHERE source = 'chat' AND message_key = $1 AND kind = 'transcript'`,
    [messageId]
  );
  return rows[0] || null;
}

function retranscribeEstimate(a, conf) {
  const seconds = a.audio_seconds == null ? 30 : Number(a.audio_seconds);
  const micros = extract.audioCostMicros(conf.rate_card, conf.transcribe_model, seconds);
  return { seconds: Math.round(seconds), inr: extract.microsToInr(micros, conf.usd_to_inr), usd: micros / 1e6 };
}

function shapeArtifact(a, conf) {
  const usdToInr = conf.usd_to_inr;
  const legacy = extract.isLegacyTranscript(a, conf);
  return {
    canRetranscribe: legacy,
    retranscribeEstimate: legacy ? retranscribeEstimate(a, conf) : undefined,
    status: a.status,
    transcript: a.status === 'ok' ? a.text : null,
    error: a.error || null,
    model: a.model || null,
    audioSeconds: a.audio_seconds == null ? null : Number(a.audio_seconds),
    costInr: extract.microsToInr(a.cost_micros, usdToInr),
    transcribedAt: a.updated_at,
  };
}

/** Transcript if there is one, else the estimated cost of making one. */
async function voiceNoteInfo(messageId) {
  const row = await loadNote(messageId);
  const conf = await loadConfig();
  const a = await readArtifact(messageId);
  const base = { messageId, waNumber: row.wa_number, contactNumber: row.contact_number };

  if (a && a.status !== 'failed') return { ...base, ...shapeArtifact(a, conf) };

  let seconds = null;
  let measured = false;
  if (row.media_storage_path && fs.existsSync(row.media_storage_path)) {
    seconds = await probeDurationSeconds(row.media_storage_path).catch(() => null);
    measured = seconds != null;
  }
  if (seconds == null) seconds = secondsFromBytes(Number(row.media_size_bytes || 0), row.media_mime_type) || 30;
  const micros = extract.audioCostMicros(conf.rate_card, conf.transcribe_model, seconds);
  const overCap = seconds > conf.max_audio_seconds;
  return {
    ...base,
    status: a ? 'failed' : 'none',
    transcript: null,
    error: a ? a.error : null,
    model: conf.transcribe_model,
    estimate: {
      seconds: Math.round(seconds),
      measured,
      usd: micros / 1e6,
      inr: extract.microsToInr(micros, conf.usd_to_inr),
      overCap,
      capSeconds: conf.max_audio_seconds,
    },
  };
}

/**
 * Transcribe one voice note. A note that already has a transcript is returned
 * as-is (`charged: false`) — never re-transcribed, never overwritten.
 */
async function transcribeVoiceNote(messageId) {
  const row = await loadNote(messageId);
  const conf = await loadConfig();
  const apiKey = await extract.resolveTranscriptionKey();
  if (!apiKey) {
    throw Object.assign(new Error('No OpenRouter key is connected. Add one in Admin Settings → AI Models.'), { status: 400 });
  }
  const r = await extract.extractArtifact({
    source: 'chat', messageKey: messageId, modality: 'audio',
    conversationKey: extract.chatConversationKey(row.contact_number),
    mime: row.media_mime_type, conf, cred: null, apiKey,
  });
  const a = await readArtifact(messageId);
  return {
    messageId,
    charged: !r.cached && r.costMicros > 0,
    chargedInr: r.cached ? 0 : extract.microsToInr(r.costMicros, conf.usd_to_inr),
    ...(a ? shapeArtifact(a, conf) : { status: r.status, transcript: null, error: r.error }),
  };
}

/**
 * Replace an OLDER model's transcript (Whisper) with the current model's.
 * Refused (409) when the note has no transcript yet (use transcribe) or was
 * already done by the current model — so a double click can never pay twice
 * for the same model's answer.
 */
async function retranscribeVoiceNote(messageId) {
  const row = await loadNote(messageId);
  const conf = await loadConfig();
  const before = await readArtifact(messageId);
  if (!extract.isLegacyTranscript(before, conf)) {
    throw Object.assign(new Error(before && before.status === 'ok'
      ? 'This voice note is already transcribed with the current model'
      : 'This voice note has no older transcript to replace — use Transcribe instead'), { status: 409 });
  }
  const apiKey = await extract.resolveTranscriptionKey();
  if (!apiKey) {
    throw Object.assign(new Error('No OpenRouter key is connected. Add one in Admin Settings → AI Models.'), { status: 400 });
  }
  const r = await extract.retranscribeArtifact({
    source: 'chat', messageKey: messageId,
    conversationKey: extract.chatConversationKey(row.contact_number),
    mime: row.media_mime_type, conf, apiKey,
  });
  const a = await readArtifact(messageId);
  return {
    messageId,
    replaced: r.status === 'ok',
    charged: r.costMicros > 0,
    chargedInr: extract.microsToInr(r.costMicros, conf.usd_to_inr),
    // When it did not work the old transcript is still there — say why.
    retranscribeError: r.status === 'ok' ? null : (r.error || 'The new model returned no speech'),
    ...shapeArtifact(a, conf),
  };
}

/** { messageId: {status, transcript, model, canRetranscribe} } for the voice notes on a page of chat. */
async function transcriptsFor(messageIds) {
  const ids = (messageIds || []).filter(Boolean);
  if (!ids.length) return {};
  const { rows } = await pool.query(
    `SELECT message_key, status, text, error, model
       FROM coexistence.chat_message_artifacts
      WHERE source = 'chat' AND kind = 'transcript' AND message_key = ANY($1)`,
    [ids]
  );
  const conf = rows.length ? await loadConfig() : null;
  const out = {};
  for (const r of rows) {
    out[r.message_key] = {
      status: r.status, transcript: r.status === 'ok' ? r.text : null, error: r.error || null,
      model: r.model || null, canRetranscribe: extract.isLegacyTranscript(r, conf),
    };
  }
  return out;
}

module.exports = {
  loadConfig, TRANSCRIPTION_DEFAULTS,
  voiceNoteInfo, transcribeVoiceNote, retranscribeVoiceNote, transcriptsFor, secondsFromBytes,
};
