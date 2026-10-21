// Turning one WhatsApp media message into text, exactly once.
//
// Voice notes are transcribed from the Chats window, by AI agents and by
// Workflow Agents. Speech-to-text (OpenRouter, microsoft/mai-transcribe-2) is
// billed by the second of audio, and the answer can never change, because the
// message is immutable. So every result is cached in
// coexistence.chat_message_artifacts, UNIQUE on (source, message_key, kind).
//
// ⚠ THIS IS THE COST SAVING. A note transcribed anywhere is reused everywhere
// and never paid for twice. Do not add a "force refresh" that bypasses it
// without a very good reason and a visible cost warning.
//
// agentEngine's transcribeInboundIfAudio reads and writes this cache too, so a
// voice note is transcribed once whichever caller meets it first.
//
// The image (vision) and PDF (document) extractors predate the removal of the
// Chat Analyzer (2026-10-21); rows of those kinds already in the cache are
// still read by Workflow Agents.
//
// Nothing here throws. A failed extraction is a recorded status, not an
// exception.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db');
const { downloadOne } = require('./mediaDownloader');
const { probeDurationSeconds } = require('./mediaDuration');
const { transcribeAudio, openRouterKey } = require('./transcription');
const { storedCopy } = require('./communityMediaArchiver');
const minio = require('../util/minioClient');
const { runChatCompletion } = require('../llm/chatCompletion');

// What each modality is called in the cache. A modality is what the USER picks
// ('audio'); a kind is what we store ('transcript').
const KIND_BY_MODALITY = { audio: 'transcript', image: 'vision', document: 'document' };

// Message types that carry each modality, per source. WhatsApp calls a voice
// note 'audio' on the Cloud API and 'voice' via Evolution, so both are listed.
const TYPES_BY_MODALITY = {
  audio: new Set(['audio', 'voice']),
  image: new Set(['image']),
  document: new Set(['document']),
};

// Only these document types have a text layer we can read. A .docx or .xlsx
// would need another library each; they are reported as unsupported rather than
// silently returning nothing, so the UI can say why.
const READABLE_DOC_MIME = new Set(['application/pdf']);

const VISION_PROMPT =
  'This image was sent in a WhatsApp conversation between a business and a customer. ' +
  'In at most 60 words, say what it shows and transcribe any text in it. ' +
  'Payment screenshots, receipts, error messages, ID documents and product photos are all common — ' +
  'if it is one of those, say so and include the key figures or wording. ' +
  'Describe only what is visible. Do not speculate about intent.';

// ── cost ──────────────────────────────────────────────────────────────────────
//
// ⚠ OpenAI reports token COUNTS, never a price, so vision and LLM figures are
// computed from the admin-editable rate card and are ESTIMATES. Transcription is
// the exception: OpenRouter returns the real cost per call and that is stored. Costs are held
// as integer USD micro-dollars: a per-row NUMERIC in rupees would round at each
// row and drift away from the dashboard total.

function rateFor(rateCard, group, model) {
  const g = (rateCard && rateCard[group]) || {};
  return g[model] || g.default || null;
}

/** USD micro-dollars for a token-metered call. Rates are USD per 1M tokens. */
function tokenCostMicros(rateCard, group, model, inTokens = 0, outTokens = 0) {
  const r = rateFor(rateCard, group, model);
  if (!r) return 0;
  const usd = ((inTokens || 0) / 1e6) * (r.in || 0) + ((outTokens || 0) / 1e6) * (r.out || 0);
  return Math.round(usd * 1e6);
}

/** USD micro-dollars for audio, from the rate card — ESTIMATES only (the pending-note
 *  estimate). A real transcription records the cost OpenRouter reports instead. */
function audioCostMicros(rateCard, model, seconds = 0) {
  const r = rateFor(rateCard, 'audio', model);
  if (!r || !seconds) return 0;
  return Math.round(((seconds / 60) * (r.perMinute || 0)) * 1e6);
}

function microsToInr(micros, usdToInr) {
  return (Number(micros || 0) / 1e6) * Number(usdToInr || 0);
}

// ── bytes ─────────────────────────────────────────────────────────────────────
//
// The two sources store media in different places, and neither is negotiable:
// 1:1 chat media is mirrored to local disk by mediaDownloader; group media is
// copied into our own MinIO bucket by communityMediaArchiver, because Evolution
// drops it.

/**
 * Resolve one message's bytes to a real file on disk.
 * Returns { path, mime, bytes, cleanup } or { error }. `cleanup` removes the
 * temp file for MinIO-sourced bytes and is a no-op for local ones.
 */
async function resolveFile(source, messageKey) {
  if (source === 'chat') {
    const { rows } = await pool.query(
      `SELECT media_mime_type, media_size_bytes, media_storage_path, media_status
         FROM coexistence.chat_history WHERE message_id = $1`,
      [messageKey]
    );
    const row = rows[0];
    if (!row) return { error: 'That message no longer exists' };

    // ⚠ THE STORED FILE COMES FIRST, and downloadOne is only the fallback.
    //
    // downloadOne checks `media_url` (Meta's media id) BEFORE it checks whether
    // the file is already on disk — correct for a downloader, since with no id
    // there is nothing to fetch. But OUTBOUND media never has a Meta id: its
    // bytes were persisted directly at send time by persistOutboundBuffer. So
    // routing a READ through downloadOne refuses a file that is sitting right
    // there, with the cryptic "no media_id in media_url column".
    //
    // Measured on this instance: 584 of 1,123 stored media files — 288 of 324
    // documents and 294 of 529 voice notes — are in exactly that state. Reading
    // the path first is what makes the majority of media analysable at all.
    let filePath = null;
    if (row.media_storage_path && fs.existsSync(row.media_storage_path)) {
      filePath = row.media_storage_path;
    } else {
      const r = await downloadOne(messageKey).catch(err => ({ ok: false, error: err.message }));
      if (!r || !r.ok || !r.path) {
        return { error: r?.error === 'no media_id in media_url column'
          ? 'This message has no stored file and no Meta media id to fetch one with'
          : (r?.error || 'Media is no longer available from Meta') };
      }
      if (!fs.existsSync(r.path)) return { error: 'The stored media file is missing from disk' };
      filePath = r.path;
    }

    return {
      path: filePath,
      mime: row.media_mime_type || '',
      bytes: Number(row.media_size_bytes || 0) || fs.statSync(filePath).size,
      cleanup: () => {},
    };
  }

  // Community. Only what the archiver managed to copy exists — Evolution keeps
  // nothing, so an unarchived group message is permanently unreadable and must
  // say so rather than looking like a transient failure.
  const copy = await storedCopy(messageKey);
  if (!copy || !copy.object_key) {
    return { error: 'This group media was never archived, so it is permanently unavailable' };
  }
  let buf;
  try {
    buf = await minio.getObjectBuffer(copy.object_key);
  } catch (err) {
    return { error: `Could not read the archived copy: ${err.message}` };
  }
  const ext = path.extname(copy.object_key) || '';
  const tmp = path.join(os.tmpdir(), `ca-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmp, buf);
  return {
    path: tmp,
    mime: copy.mime_type || '',
    bytes: Number(copy.bytes || buf.length),
    cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* best effort */ } },
  };
}

// ── schema self-heal (mirrors supabase/migrations/110 + 124) ─────────────────
//
// Formerly part of the Chat Analyzer's ensure. The cache outlived that feature:
// voice-note transcripts, Media Library matches ('library') and the Workflow
// Agents' language column (workflowAgents/schema.js) all live here.
async function ensureMessageArtifactTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.chat_message_artifacts (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL, message_key TEXT NOT NULL, kind TEXT NOT NULL,
      conversation_key TEXT, text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok', error TEXT,
      provider TEXT, model TEXT, prompt_tokens INT, completion_tokens INT,
      audio_seconds NUMERIC(10,2), bytes BIGINT,
      cost_micros BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_artifacts
                      ON coexistence.chat_message_artifacts (source, message_key, kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cma_conversation
                      ON coexistence.chat_message_artifacts (source, conversation_key, kind)`);
  // Migration 124 mirror: 'library' = this message's file is a Media Library item.
  await pool.query(`ALTER TABLE coexistence.chat_message_artifacts DROP CONSTRAINT IF EXISTS chat_message_artifacts_kind_check`);
  await pool.query(`ALTER TABLE coexistence.chat_message_artifacts ADD CONSTRAINT chat_message_artifacts_kind_check
                      CHECK (kind IN ('transcript','vision','document','library'))`);
}

// ── cache ─────────────────────────────────────────────────────────────────────

async function readCached(source, messageKey, kind) {
  const { rows } = await pool.query(
    `SELECT text, status, error, cost_micros, audio_seconds, model
       FROM coexistence.chat_message_artifacts
      WHERE source = $1 AND message_key = $2 AND kind = $3`,
    [source, messageKey, kind]
  );
  return rows[0] || null;
}

async function writeCache(row) {
  // ON CONFLICT so two concurrent runs on the same conversation cannot collide.
  // The unique index is the real guard; this is what makes it survivable.
  await pool.query(
    `INSERT INTO coexistence.chat_message_artifacts
       (source, message_key, kind, conversation_key, text, status, error,
        provider, model, prompt_tokens, completion_tokens, audio_seconds, bytes, cost_micros)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (source, message_key, kind) DO UPDATE SET
       text = EXCLUDED.text, status = EXCLUDED.status, error = EXCLUDED.error,
       provider = EXCLUDED.provider, model = EXCLUDED.model,
       prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens,
       audio_seconds = EXCLUDED.audio_seconds, bytes = EXCLUDED.bytes,
       cost_micros = EXCLUDED.cost_micros, updated_at = NOW()`,
    [row.source, row.messageKey, row.kind, row.conversationKey || null, row.text || '',
     row.status, row.error || null, row.provider || null, row.model || null,
     row.promptTokens || null, row.completionTokens || null,
     row.audioSeconds || null, row.bytes || null, row.costMicros || 0]
  );
}

/**
 * A cached row is reusable unless it FAILED. 'empty' and 'skipped' are
 * deliberate outcomes, not retryable ones:
 *   empty   — a scanned PDF has no text layer. Retrying costs money and returns
 *             empty again, forever.
 *   skipped — over a configured cap. Retrying under the same cap does nothing;
 *             raise the cap and it re-runs (the status is rewritten then).
 * 'failed' is transient (network, a Meta blip) and is retried on the next run.
 */
function reusable(cached) {
  return !!cached && cached.status !== 'failed';
}

/** A chat's conversation key: the contact's last 10 digits (the rule every lead lookup uses). */
function chatConversationKey(contactNumber) {
  return String(contactNumber || '').replace(/\D/g, '').slice(-10) || null;
}

/**
 * A usable cached transcript for one message, or null. Only 'ok' rows count —
 * callers (the agent engine) want words, not statuses.
 */
async function cachedTranscript(source, messageKey) {
  const c = await readCached(source, messageKey, 'transcript');
  return c && c.status === 'ok' && c.text ? c.text : null;
}

/**
 * Store a transcription made OUTSIDE extractArtifact (the agent engine applies
 * its own per-agent length cap, so it transcribes itself) in the same cache the
 * Chats window reads — so later views and agent runs reuse it.
 * `result` is what transcription.transcribeAudio returned.
 */
async function storeTranscript({ source = 'chat', messageKey, conversationKey, result, measuredSeconds, bytes, rateCard }) {
  const clean = (result?.text || '').trim();
  const seconds = result?.seconds || measuredSeconds || null;
  await writeCache({
    source, messageKey, kind: 'transcript', conversationKey,
    text: clean, status: clean ? 'ok' : 'empty',
    error: clean ? null : 'The transcription model heard no speech',
    provider: result?.provider, model: result?.model,
    audioSeconds: seconds, bytes,
    costMicros: result?.costUsd ? Math.round(result.costUsd * 1e6)
      : audioCostMicros(rateCard, result?.model, seconds || 0),
  });
}

// ── extractors ────────────────────────────────────────────────────────────────

async function doTranscript({ file, conf, apiKey, declaredSeconds }) {
  // Duration is MEASURED before transcription, never estimated, because the
  // speech-to-text call bills by the second — a cap applied to the transcript
  // protects nothing. Evolution declares the length in its payload; for Cloud
  // API media we probe with ffprobe (already installed for the voice-note
  // transcode).
  let seconds = Number(declaredSeconds) || 0;
  if (!seconds) seconds = Number(await probeDurationSeconds(file.path).catch(() => 0)) || 0;

  const cap = conf.max_audio_seconds;
  if (seconds && seconds > cap) {
    return {
      status: 'skipped', text: '',
      error: `Voice note is ${Math.round(seconds)}s, over the ${cap}s limit`,
      audioSeconds: seconds, costMicros: 0,
    };
  }
  // An UNKNOWN duration is transcribed. Failing open costs a cap; failing closed
  // loses the customer's message, which is worse.
  const r = await transcribeAudio({ filePath: file.path, apiKey, model: conf.transcribe_model, mime: file.mime });
  const clean = (r.text || '').trim();
  const billedSeconds = r.seconds || seconds || null;
  // OpenRouter reports the real price; the rate card is only the fallback for a
  // response that somehow omitted it.
  const costMicros = r.costUsd
    ? Math.round(r.costUsd * 1e6)
    : audioCostMicros(conf.rate_card, r.model, billedSeconds || 0);
  return {
    status: clean ? 'ok' : 'empty',
    text: clean,
    error: clean ? null : 'The transcription model heard no speech',
    audioSeconds: billedSeconds,
    provider: r.provider,
    model: r.model,
    costMicros,
  };
}

async function doVision({ file, conf, cred }) {
  if (file.bytes > conf.max_image_bytes) {
    return {
      status: 'skipped', text: '',
      error: `Image is ${(file.bytes / 1048576).toFixed(1)}MB, over the ${(conf.max_image_bytes / 1048576).toFixed(0)}MB limit`,
      costMicros: 0,
    };
  }
  const b64 = fs.readFileSync(file.path).toString('base64');
  const mime = file.mime || 'image/jpeg';
  // Built in the OpenAI wire shape directly: runChatCompletion passes `messages`
  // through untouched and posts to /chat/completions, so the content parts must
  // already be what OpenAI expects.
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: VISION_PROMPT },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    ],
  }];
  const res = await runChatCompletion(cred, conf.vision_model, messages, { maxTokens: 200, withUsage: true });
  const clean = (res?.content || '').trim();
  const usage = res?.usage || {};
  return {
    status: clean ? 'ok' : 'empty',
    text: clean,
    error: clean ? null : 'The vision model returned nothing',
    provider: cred.provider,
    model: res?.model || conf.vision_model,
    promptTokens: usage.prompt_tokens || null,
    completionTokens: usage.completion_tokens || null,
    costMicros: tokenCostMicros(conf.rate_card, 'vision', conf.vision_model,
      usage.prompt_tokens, usage.completion_tokens),
  };
}

async function doDocument({ file, conf }) {
  if (!READABLE_DOC_MIME.has((file.mime || '').toLowerCase())) {
    return {
      status: 'skipped', text: '',
      error: `${file.mime || 'This file type'} has no text layer we can read (PDF only)`,
      costMicros: 0,
    };
  }
  // Required lazily: pdf-parse pulls in a PDF engine, and a module needed by one
  // optional modality should not be loaded by every backend boot.
  const { PDFParse } = require('pdf-parse');
  let parser;
  try {
    parser = new PDFParse({ data: fs.readFileSync(file.path) });
    const out = await parser.getText();
    let text = (out?.text || '').replace(/\s+\n/g, '\n').trim();
    const pages = out?.total || 0;
    if (!text) {
      // A scanned PDF is an image of a page: real bytes, real pages, no text
      // layer. Cached as 'empty' so it is never re-parsed, and reported plainly
      // rather than as a failure the user might retry.
      return {
        status: 'empty', text: '',
        error: `No extractable text in ${pages || '?'} page(s) — likely a scanned document`,
        costMicros: 0,
      };
    }
    if (text.length > conf.max_document_chars) {
      text = `${text.slice(0, conf.max_document_chars)}\n… [truncated at ${conf.max_document_chars} characters]`;
    }
    // Local parsing — no API call, so no cost. The text still costs tokens when
    // it reaches the analysis prompt; that is counted as LLM cost, not here.
    return { status: 'ok', text, model: 'pdf-parse', costMicros: 0 };
  } finally {
    if (parser) await parser.destroy().catch(() => {});
  }
}

// ── the one entry point ───────────────────────────────────────────────────────

/**
 * Text for one media message, from cache when possible.
 *
 * @returns {{text, status, cached, costMicros, error, kind}} — never throws.
 */
async function extractArtifact({ source, messageKey, modality, conversationKey, mime, declaredSeconds, conf, cred, apiKey }) {
  const kind = KIND_BY_MODALITY[modality];
  if (!kind) return { text: '', status: 'skipped', cached: false, costMicros: 0, error: `Unknown modality ${modality}`, kind: null };

  const cached = await readCached(source, messageKey, kind).catch(() => null);
  if (reusable(cached)) {
    return {
      text: cached.text || '', status: cached.status, cached: true,
      costMicros: 0,                    // already paid for, on a previous run
      error: cached.error || null, kind,
    };
  }

  // Credentials are checked per modality: a PDF needs none, transcription needs
  // the OpenRouter key, vision needs an OpenAI-compatible credential. Reporting the
  // precise missing piece beats one generic "not configured".
  if (modality === 'audio' && !apiKey) {
    return { text: '', status: 'skipped', cached: false, costMicros: 0, kind, error: 'No OpenRouter key is connected (Admin Settings → AI Models), so voice notes cannot be transcribed' };
  }
  if (modality === 'image' && !cred) {
    return { text: '', status: 'skipped', cached: false, costMicros: 0, kind, error: 'No OpenAI-compatible model is connected, so images cannot be read' };
  }

  const file = await resolveFile(source, messageKey);
  if (file.error) {
    const row = { source, messageKey, kind, conversationKey, text: '', status: 'failed', error: file.error, costMicros: 0 };
    await writeCache(row).catch(() => {});
    return { text: '', status: 'failed', cached: false, costMicros: 0, error: file.error, kind };
  }
  if (mime && !file.mime) file.mime = mime;

  let out;
  try {
    if (modality === 'audio') out = await doTranscript({ file, conf, apiKey, declaredSeconds });
    else if (modality === 'image') out = await doVision({ file, conf, cred });
    else out = await doDocument({ file, conf });
  } catch (err) {
    out = { status: 'failed', text: '', error: err.message?.slice(0, 300) || 'Extraction failed', costMicros: 0 };
  } finally {
    file.cleanup();
  }

  await writeCache({ source, messageKey, kind, conversationKey, bytes: file.bytes, ...out }).catch(() => {});
  return {
    text: out.text || '', status: out.status, cached: false,
    costMicros: out.costMicros || 0, error: out.error || null, kind,
  };
}

/**
 * Re-transcribe a note that ALREADY has a transcript from an older model
 * (Whisper), with the current one. This is the only path allowed to replace a
 * stored transcript, and only on an explicit request (the Re-transcribe
 * button / the admin's "re-transcribe older notes").
 *
 * ⚠ THE OLD TEXT IS REPLACED ONLY BY A SUCCESSFUL NEW ONE. If the new call
 * fails, finds no speech or is over the length cap, the stored transcript is
 * left exactly as it was — a worse outcome must never cost the text we had.
 *
 * @returns {{status, text, costMicros, error}} — never throws.
 */
async function retranscribeArtifact({ source, messageKey, conversationKey, mime, conf, apiKey }) {
  const file = await resolveFile(source, messageKey);
  if (file.error) return { status: 'failed', text: '', costMicros: 0, error: file.error };
  if (mime && !file.mime) file.mime = mime;
  let out;
  try {
    out = await doTranscript({ file, conf, apiKey });
  } catch (err) {
    out = { status: 'failed', text: '', error: err.message?.slice(0, 300) || 'Transcription failed', costMicros: 0 };
  } finally {
    file.cleanup();
  }
  if (out.status === 'ok') {
    await writeCache({ source, messageKey, kind: 'transcript', conversationKey, bytes: file.bytes, ...out });
  }
  return { status: out.status, text: out.text || '', costMicros: out.costMicros || 0, error: out.error || null };
}

/** True when a cached transcript was made by an older model and may be redone. */
function isLegacyTranscript(row, conf) {
  return !!row && (row.status === 'ok' || row.status === 'empty')
    && !!row.model && row.model !== conf.transcribe_model;
}

/**
 * One message's bytes as base64, for handing an image straight to a model that
 * can see it.
 *
 * ⚠ COSTS NOTHING. This is a disk read, not an API call — the whole point is
 * that a model which accepts images does the seeing itself, instead of paying a
 * vision model to write a description and then reading that.
 *
 * Uses the same resolveFile as extraction, so it inherits the stored-file-first
 * rule that makes outbound media (most documents and half the voice notes on
 * this instance) reachable at all.
 */
async function loadMediaBase64({ source = 'chat', messageKey, maxBytes = 5 * 1024 * 1024 }) {
  const file = await resolveFile(source, messageKey);
  if (file.error) return { error: file.error };
  try {
    if (file.bytes > maxBytes) {
      return { error: `That file is ${(file.bytes / 1048576).toFixed(1)}MB, over the ${(maxBytes / 1048576).toFixed(0)}MB limit for one response` };
    }
    const buf = fs.readFileSync(file.path);
    return {
      base64: buf.toString('base64'),
      mime: file.mime || 'application/octet-stream',
      bytes: buf.length,
    };
  } catch (err) {
    return { error: `Could not read the stored file: ${err.message}` };
  } finally {
    file.cleanup();
  }
}

/** The OpenRouter key speech-to-text needs (AI Models credential, else env). */
async function resolveTranscriptionKey() {
  return openRouterKey();
}

module.exports = {
  ensureMessageArtifactTables,
  extractArtifact, loadMediaBase64,
  resolveTranscriptionKey,
  cachedTranscript,
  retranscribeArtifact,
  isLegacyTranscript,
  storeTranscript,
  chatConversationKey,
  tokenCostMicros,
  audioCostMicros,
  microsToInr,
  rateFor,
  reusable,
  KIND_BY_MODALITY,
  TYPES_BY_MODALITY,
  READABLE_DOC_MIME,
};
