// Chat Analyzer — what a conversation is actually saying.
//
// Revived from migration 069 (code removed 2026-07-31 in 0fba39d) and extended:
// it now reads media, analyses only what is new, covers WhatsApp GROUPS as well
// as 1:1 chats, and records what every run cost.
//
// ── The four rules this file exists to enforce ────────────────────────────────
//
// 1. COVERAGE IS PER MODALITY. A single "last analysed message" watermark is the
//    obvious design and it is silently wrong: cover 1-100 as text-only, switch
//    images on, and one watermark reports 1-100 as done while every image in it
//    is skipped for good. See loadCoverage/advanceCoverage.
//
// 2. A SCOPED RUN NEVER ADVANCES COVERAGE. An explicit date range or keyword is
//    a one-off question, not progress through the conversation. Letting it move
//    the watermark would mark everything up to the range's end as analysed when
//    only a filtered slice of it was read. This is also what keeps the watermark
//    monotonic, and therefore trustworthy.
//
// 3. EXPENSIVE TEXT IS CACHED ON THE MESSAGE, NOT THE RUN. Transcripts, vision
//    descriptions and PDF text live in chat_message_artifacts (see
//    services/mediaExtract.js) and are reused by every later run whatever its
//    scope.
//
// 4. GROUPS GET A DIFFERENT VERDICT. A group has many speakers and no single
//    lead, so a funnel-stage suggestion there is meaningless. Groups return
//    topics, open questions and who is active instead.
//
// ⚠ Group messages are NOT in chat_history. They live in the separate `evolution`
// database behind a read-only Postgres role, with an entirely different JSON
// shape. That is why there are two transcript builders rather than one with a
// flag.

const crypto = require('crypto');
const pool = require('../db');
const evoPool = require('../evolutionDb');
const cfg = require('./funnelConfig');
const { isOpenAiCompatible, runChatCompletion, parseLooseJson } = require('../llm/chatCompletion');
const extract = require('./mediaExtract');
const { libraryMatches, libraryLabel, libraryFileText } = require('./libraryMedia');
const analyserContext = require('./analyserContext');

// ── constants ─────────────────────────────────────────────────────────────────

const CLAIM_TIMEOUT = '5 minutes';   // a crashed run releases its claim after this
const RAW_RESPONSE_CAP = 4000;
const HEAD_MESSAGES = 6;             // opening messages always kept when truncating
const BATCH_CONCURRENCY = 2;         // pool max is 20, shared with webhooks/BullMQ/SSE
const BATCH_GAP_MS = 400;
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5;
const FETCH_LIMIT = 600;             // hard ceiling on rows pulled for one run

const MODALITIES = ['text', 'image', 'audio', 'document'];
const INTENTS = new Set(['high', 'medium', 'low', 'none']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);

// Empty message_body is ~30% of real traffic. Without a placeholder the model
// confidently analyses a blank transcript.
const TYPE_PLACEHOLDER = {
  image: '[image]', video: '[video]', audio: '[voice note]', voice: '[voice note]',
  document: '[document]', sticker: '[sticker]', location: '[location]',
  contacts: '[contact card]', template: '[template message sent]',
  interactive: '[interactive message]', button: '[button tap]', order: '[order]',
  unsupported: '[unsupported message]',
};

// The last-10-digit join key, used everywhere a lead meets a chat.
const KEY10 = (col) => `right(regexp_replace(${col},'\\D','','g'),10)`;

/**
 * The ONE spelling of a chat's key: its last 10 digits (the same rule as KEY10).
 *
 * ⚠ The Chats slide-over passed the full number (91XXXXXXXXXX) while the Chat
 * Analyzer tab passed 10 digits, so one conversation got TWO analyses, two
 * coverage watermarks and was paid for twice — and an analysis made from the
 * chat never showed on the tab. Every entry point canonicalises, so no caller
 * can reintroduce it. Group keys (a JID) pass through untouched.
 */
function canonicalKey(source, key) {
  if (source === 'community' || key == null) return key;
  const d = String(key).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : String(key).trim();
}

const _batches = new Map();
let _cfgCache = null;
let _cfgAt = 0;

// ── schema self-heal (mirrors supabase/migrations/110_chat_analyzer_v2.sql) ────

async function ensureChatAnalyserTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.chat_analyser_config (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      credential_id INT, model_id TEXT,
      nightly_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      nightly_hour_ist INT NOT NULL DEFAULT 3,
      nightly_max_conversations INT NOT NULL DEFAULT 200,
      last_nightly_run_at TIMESTAMPTZ, last_nightly_ist_date DATE, last_nightly_batch_id UUID,
      min_messages INT NOT NULL DEFAULT 4,
      transcript_message_cap INT NOT NULL DEFAULT 60,
      transcript_char_cap INT NOT NULL DEFAULT 12000,
      master_context_human TEXT NOT NULL DEFAULT '',
      master_context_machine TEXT NOT NULL DEFAULT '',
      master_context_updated_at TIMESTAMPTZ, master_context_edited_at TIMESTAMPTZ,
      master_context_edited_by TEXT,
      master_stale BOOLEAN NOT NULL DEFAULT FALSE, master_running_since TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`INSERT INTO coexistence.chat_analyser_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    ALTER TABLE coexistence.chat_analyser_config
      ADD COLUMN IF NOT EXISTS analyse_text BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS analyse_images BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS analyse_audio BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS analyse_documents BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS vision_model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      ADD COLUMN IF NOT EXISTS transcribe_model TEXT NOT NULL DEFAULT 'microsoft/mai-transcribe-2',
      ADD COLUMN IF NOT EXISTS max_media_per_run INT NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS max_audio_seconds INT NOT NULL DEFAULT 300,
      ADD COLUMN IF NOT EXISTS max_image_bytes BIGINT NOT NULL DEFAULT 5242880,
      ADD COLUMN IF NOT EXISTS max_document_chars INT NOT NULL DEFAULT 8000,
      ADD COLUMN IF NOT EXISTS bulk_max INT NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS usd_to_inr NUMERIC(10,4) NOT NULL DEFAULT 88.0,
      ADD COLUMN IF NOT EXISTS rate_card JSONB NOT NULL DEFAULT '{
        "text":   {"gpt-4o-mini":{"in":0.15,"out":0.60},"gpt-4o":{"in":2.50,"out":10.00},"default":{"in":0.15,"out":0.60}},
        "audio":  {"microsoft/mai-transcribe-2":{"perMinute":0.00167},"default":{"perMinute":0.00167}},
        "vision": {"gpt-4o-mini":{"in":0.15,"out":0.60},"default":{"in":0.15,"out":0.60}}
      }'::jsonb`);

  // Migration 123 mirror: transcription moved from OpenAI Whisper to OpenRouter
  // (microsoft/mai-transcribe-2). Cached Whisper transcripts stay and are reused.
  await pool.query(`ALTER TABLE coexistence.chat_analyser_config
    ALTER COLUMN transcribe_model SET DEFAULT 'microsoft/mai-transcribe-2'`);
  await pool.query(`UPDATE coexistence.chat_analyser_config
     SET transcribe_model = 'microsoft/mai-transcribe-2', updated_at = NOW()
   WHERE transcribe_model IS DISTINCT FROM 'microsoft/mai-transcribe-2'`);
  await pool.query(`UPDATE coexistence.chat_analyser_config
     SET rate_card = jsonb_set(rate_card, '{audio}',
           '{"microsoft/mai-transcribe-2":{"perMinute":0.00167},"default":{"perMinute":0.00167}}'::jsonb)
   WHERE rate_card->'audio' ? 'whisper-1'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.chat_analysis (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
      wa_number TEXT, contact_number TEXT,
      suggested_score INT, suggested_stage TEXT,
      confidence NUMERIC(3,2), intent TEXT, sentiment TEXT,
      summary TEXT, stage_reason TEXT, score_reason TEXT, next_action TEXT, risk TEXT,
      objections JSONB NOT NULL DEFAULT '[]'::jsonb,
      buying_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      rules_matched JSONB NOT NULL DEFAULT '[]'::jsonb,
      context_machine TEXT NOT NULL DEFAULT '', context_human TEXT NOT NULL DEFAULT '',
      context_edited_at TIMESTAMPTZ, context_edited_by TEXT,
      suggestion_state TEXT NOT NULL DEFAULT 'pending',
      applied_stage TEXT, applied_score INT, applied_at TIMESTAMPTZ, applied_by TEXT,
      dismissed_at TIMESTAMPTZ, dismissed_by TEXT,
      last_message_id BIGINT, last_message_at TIMESTAMPTZ,
      analysed_message_count INT NOT NULL DEFAULT 0,
      transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      last_run_id BIGINT, last_run_at TIMESTAMPTZ,
      last_status TEXT NOT NULL DEFAULT 'ok', last_error TEXT,
      run_count INT NOT NULL DEFAULT 0, model_used TEXT, running_since TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    ALTER TABLE coexistence.chat_analysis
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chat',
      ADD COLUMN IF NOT EXISTS conversation_key TEXT,
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS modalities JSONB NOT NULL DEFAULT '["text"]'::jsonb`);

  // The 069 → 110 shape change. Guarded so a fresh instance and an instance that
  // already ran 069 both land on the same schema (anti-pattern #41: an ensure
  // that mirrors a shape change must PERFORM it, not create-if-missing).
  await pool.query(`
    UPDATE coexistence.chat_analysis
       SET conversation_key = right(regexp_replace(contact_number,'\\D','','g'),10)
     WHERE conversation_key IS NULL AND contact_number IS NOT NULL`);
  await pool.query(`
    UPDATE coexistence.chat_analysis SET conversation_key = 'lead:' || lead_id
     WHERE conversation_key IS NULL AND lead_id IS NOT NULL`);
  await pool.query(`DELETE FROM coexistence.chat_analysis WHERE conversation_key IS NULL`);
  await pool.query(`ALTER TABLE coexistence.chat_analysis ALTER COLUMN lead_id DROP NOT NULL`);
  await pool.query(`ALTER TABLE coexistence.chat_analysis ALTER COLUMN contact_number DROP NOT NULL`);
  await pool.query(`ALTER TABLE coexistence.chat_analysis DROP CONSTRAINT IF EXISTS chat_analysis_lead_id_key`);
  await pool.query(`ALTER TABLE coexistence.chat_analysis ALTER COLUMN conversation_key SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_analysis_conversation
                      ON coexistence.chat_analysis (source, conversation_key)`);

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
  // Migration 127 mirror: our replies judged too.
  await pool.query(`ALTER TABLE coexistence.chat_analysis
      ADD COLUMN IF NOT EXISTS reply_review TEXT,
      ADD COLUMN IF NOT EXISTS missed JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // Migration 128 mirror: the date the AI suggests for the next follow-up.
  await pool.query(`ALTER TABLE coexistence.chat_analysis
      ADD COLUMN IF NOT EXISTS next_follow_up JSONB`);
  // Migration 126 mirror: business context + products + what the verdict used.
  await pool.query(`ALTER TABLE coexistence.chat_analyser_config
      ADD COLUMN IF NOT EXISTS business_context TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS context_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS context_updated_by TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS coexistence.chat_analyser_products (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, price_text TEXT,
      details TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0, course_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`ALTER TABLE coexistence.chat_analysis
      ADD COLUMN IF NOT EXISTS interested_products JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS context_hash TEXT`);
  await pool.query(`UPDATE coexistence.chat_analyser_config
     SET rate_card = jsonb_set(rate_card, '{text}',
           '{"gpt-5":{"in":1.25,"out":10.00},"gpt-5-mini":{"in":0.25,"out":2.00}}'::jsonb || (rate_card->'text'))
   WHERE NOT (rate_card->'text' ? 'gpt-5')`);
  // Migration 125 mirror: the summary → problems → notes → recommendations sections.
  await pool.query(`ALTER TABLE coexistence.chat_analysis
      ADD COLUMN IF NOT EXISTS problems JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS recommendations JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // Migration 124 mirror: 'library' = this message's file is a Media Library item.
  await pool.query(`ALTER TABLE coexistence.chat_message_artifacts DROP CONSTRAINT IF EXISTS chat_message_artifacts_kind_check`);
  await pool.query(`ALTER TABLE coexistence.chat_message_artifacts ADD CONSTRAINT chat_message_artifacts_kind_check
                      CHECK (kind IN ('transcript','vision','document','library'))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.chat_analysis_coverage (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL, conversation_key TEXT NOT NULL, modality TEXT NOT NULL,
      covered_through_seq BIGINT, covered_through_epoch BIGINT,
      covered_through_at TIMESTAMPTZ, covered_from_at TIMESTAMPTZ,
      covered_message_count INT NOT NULL DEFAULT 0,
      last_run_id BIGINT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_analysis_coverage
                      ON coexistence.chat_analysis_coverage (source, conversation_key, modality)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.chat_analysis_runs (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES coexistence.leads(id) ON DELETE CASCADE,
      batch_id UUID, kind TEXT NOT NULL DEFAULT 'conversation',
      trigger TEXT NOT NULL, actor TEXT, status TEXT NOT NULL, error TEXT,
      provider TEXT, model_id TEXT, credential_id INT,
      prompt_tokens INT, completion_tokens INT, total_tokens INT,
      elapsed_ms INT, messages_analysed INT,
      transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      suggested_score INT, suggested_stage TEXT,
      parsed JSONB, raw_response TEXT, context_before TEXT, master_context_before TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
    )`);
  await pool.query(`
    ALTER TABLE coexistence.chat_analysis_runs
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chat',
      ADD COLUMN IF NOT EXISTS conversation_key TEXT,
      ADD COLUMN IF NOT EXISTS scope JSONB,
      ADD COLUMN IF NOT EXISTS is_scoped BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_incremental BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS modalities JSONB NOT NULL DEFAULT '["text"]'::jsonb,
      ADD COLUMN IF NOT EXISTS new_messages INT,
      ADD COLUMN IF NOT EXISTS reused_artifacts INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS new_artifacts INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS llm_cost_micros BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS artifact_cost_micros BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS result JSONB`);
  for (const [name, def] of [
    ['chat_analysis_runs_kind_check', `CHECK (kind IN ('conversation','group','master'))`],
    ['chat_analysis_runs_trigger_check', `CHECK (trigger IN ('manual','bulk','nightly','mcp'))`],
  ]) {
    await pool.query(`ALTER TABLE coexistence.chat_analysis_runs DROP CONSTRAINT IF EXISTS ${name}`);
    await pool.query(`ALTER TABLE coexistence.chat_analysis_runs ADD CONSTRAINT ${name} ${def}`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_car_conv
                      ON coexistence.chat_analysis_runs (source, conversation_key, started_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_car_when
                      ON coexistence.chat_analysis_runs (started_at DESC)`);
}

// ── config ────────────────────────────────────────────────────────────────────

async function loadConfig({ fresh = false } = {}) {
  if (!fresh && _cfgCache && Date.now() - _cfgAt < 15000) return _cfgCache;
  const { rows } = await pool.query(`SELECT * FROM coexistence.chat_analyser_config WHERE id = 1`);
  _cfgCache = rows[0] || null;
  _cfgAt = Date.now();
  return _cfgCache;
}

function invalidateConfigCache() { _cfgCache = null; _cfgAt = 0; }

/** Which modalities a run should use: explicit request, else the saved defaults. */
function resolveModalities(conf, requested) {
  if (Array.isArray(requested) && requested.length) {
    const want = requested.map(m => String(m).toLowerCase());
    if (want.includes('all')) return MODALITIES.slice();
    return MODALITIES.filter(m => want.includes(m));
  }
  return MODALITIES.filter(m => ({
    text: conf.analyse_text, image: conf.analyse_images,
    audio: conf.analyse_audio, document: conf.analyse_documents,
  })[m]);
}

/**
 * The credential + model for the analysis call.
 * ⚠ Only OpenAI-compatible credentials work: runChatCompletion speaks the
 * OpenAI wire format, so an Anthropic or Gemini key 404s on every single run.
 */
async function resolveModel(conf) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.ai_models
      ORDER BY (id = $1) DESC, (provider='openai') DESC, id ASC`,
    [conf?.credential_id || -1]
  );
  const cred = rows.find(r => isOpenAiCompatible(r));
  if (!cred) return { cred: null, modelId: null };
  const preferred = conf?.credential_id === cred.id ? conf.model_id : null;
  const enabled = Array.isArray(cred.enabled_models) ? cred.enabled_models : [];
  const modelId = preferred
    || enabled.find(m => /mini|flash|haiku|turbo/i.test(m))
    || enabled[0]
    || 'gpt-4o-mini';
  return { cred, modelId };
}

// ── coverage ──────────────────────────────────────────────────────────────────

/** Watermarks keyed by modality: { text: {seq, epoch, at, count}, … }. */
async function loadCoverage(source, conversationKey) {
  conversationKey = canonicalKey(source, conversationKey);
  const { rows } = await pool.query(
    `SELECT modality, covered_through_seq, covered_through_epoch, covered_through_at,
            covered_from_at, covered_message_count
       FROM coexistence.chat_analysis_coverage
      WHERE source = $1 AND conversation_key = $2`,
    [source, conversationKey]
  );
  const out = {};
  for (const r of rows) {
    out[r.modality] = {
      seq: r.covered_through_seq == null ? null : Number(r.covered_through_seq),
      epoch: r.covered_through_epoch == null ? null : Number(r.covered_through_epoch),
      at: r.covered_through_at, from: r.covered_from_at,
      count: r.covered_message_count || 0,
    };
  }
  return out;
}

/**
 * Move each analysed modality's watermark forward.
 *
 * ⚠ Only ever called for a FULL run. A scoped run leaves coverage alone — see
 * rule 2 at the top of this file. `GREATEST` makes it monotonic even if two runs
 * finish out of order.
 */
async function advanceCoverage({ source, conversationKey, modalities, seq, epoch, at, from, count, runId }) {
  for (const m of modalities) {
    await pool.query(
      `INSERT INTO coexistence.chat_analysis_coverage
         (source, conversation_key, modality, covered_through_seq, covered_through_epoch,
          covered_through_at, covered_from_at, covered_message_count, last_run_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (source, conversation_key, modality) DO UPDATE SET
         covered_through_seq   = GREATEST(COALESCE(coexistence.chat_analysis_coverage.covered_through_seq,0), COALESCE(EXCLUDED.covered_through_seq,0)),
         covered_through_epoch = GREATEST(COALESCE(coexistence.chat_analysis_coverage.covered_through_epoch,0), COALESCE(EXCLUDED.covered_through_epoch,0)),
         covered_through_at    = GREATEST(coexistence.chat_analysis_coverage.covered_through_at, EXCLUDED.covered_through_at),
         covered_from_at       = LEAST(COALESCE(coexistence.chat_analysis_coverage.covered_from_at, EXCLUDED.covered_from_at), EXCLUDED.covered_from_at),
         covered_message_count = coexistence.chat_analysis_coverage.covered_message_count + EXCLUDED.covered_message_count,
         last_run_id = EXCLUDED.last_run_id, updated_at = NOW()`,
      [source, conversationKey, m, seq || null, epoch || null, at || null, from || null, count || 0, runId || null]
    );
  }
}

// ── transcript: 1:1 chats ─────────────────────────────────────────────────────

function istStamp(ts) {
  try {
    // ⚠ hourCycle, not hour12:false — en-IN with hour12:false renders a message
    // sent at 00:17 as "24:17", which reads as the END of the day, not the start.
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch { return ''; }
}

// Declared above its use on purpose: a `const` referenced by a function that
// runs before this line would sit in the temporal dead zone (anti-pattern #44).
const TYPES_AUDIO = new Set(['audio', 'voice']);

function modalityOf(type) {
  if (TYPES_AUDIO.has(type)) return 'audio';
  if (type === 'image') return 'image';
  if (type === 'document') return 'document';
  return 'text';
}

/**
 * Rows for a 1:1 conversation.
 *
 * Deliberately not agentEngine.buildMessageHistory: that keys off a wa_account_id
 * and drops rows with an empty body, which would silently delete every voice note
 * and image — precisely the messages this feature exists to read.
 */
async function fetchChatMessages({ conversationKey, scope, since }) {
  const params = [conversationKey];
  const where = [`${KEY10('contact_number')} = ${KEY10('$1')}`, `message_type NOT IN ('status','reaction','revoke','edit')`];
  if (since != null) { params.push(since); where.push(`id > $${params.length}`); }
  if (scope?.from) { params.push(scope.from); where.push(`timestamp >= $${params.length}`); }
  if (scope?.to) { params.push(scope.to); where.push(`timestamp <= $${params.length}`); }
  if (scope?.keyword) { params.push(`%${scope.keyword}%`); where.push(`message_body ILIKE $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id, message_id, direction, message_type, message_body, timestamp,
            wa_number, media_mime_type
       FROM coexistence.chat_history
      WHERE ${where.join(' AND ')}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${FETCH_LIMIT}`,
    params
  );
  return rows.reverse();
}

// ── transcript: WhatsApp groups (Evolution, read-only) ────────────────────────

const EVO_TYPE = {
  conversation: 'text', extendedTextMessage: 'text', imageMessage: 'image',
  videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document',
  stickerMessage: 'sticker', locationMessage: 'location', contactMessage: 'contacts',
};
const EVO_NOISE = ['protocolMessage', 'pinInChatMessage', 'messageContextInfo', 'senderKeyDistributionMessage', 'reactionMessage'];

async function fetchGroupMessages({ conversationKey, scope, since }) {
  // ⚠ Returning [] here would surface as "this group has no messages to
  // analyse" — a statement about the GROUP when the truth is that Evolution is
  // not configured or not reachable. Say which.
  if (!evoPool) {
    throw Object.assign(
      new Error('Group messages come from Evolution, which is not connected right now. Set EVOLUTION_RO_PASSWORD, or try again once it is back.'),
      { status: 503 }
    );
  }
  const params = [conversationKey, EVO_NOISE];
  const where = [`m.key->>'remoteJid' = $1`, `m."messageType" <> ALL($2)`];
  // ⚠ `>=`, not `>`. Evolution's Message.id is a text cuid with no ordering, so
  // the only watermark is messageTimestamp in whole SECONDS — and several group
  // messages in one second is entirely normal. Re-reading the boundary second is
  // cheap (its artifacts are cached); losing a message is silent and permanent.
  if (since != null) { params.push(since); where.push(`m."messageTimestamp" >= $${params.length}`); }
  if (scope?.from) { params.push(Math.floor(new Date(scope.from).getTime() / 1000)); where.push(`m."messageTimestamp" >= $${params.length}`); }
  if (scope?.to) { params.push(Math.floor(new Date(scope.to).getTime() / 1000)); where.push(`m."messageTimestamp" <= $${params.length}`); }

  const { rows } = await evoPool.query(
    `SELECT m.id, m."messageType" AS evo_type, m."pushName" AS push_name,
            m.participant, m.key->>'fromMe' AS from_me, m."messageTimestamp" AS ts,
            COALESCE(m.message->>'conversation',
                     m.message->'extendedTextMessage'->>'text',
                     m.message->'imageMessage'->>'caption',
                     m.message->'videoMessage'->>'caption',
                     m.message->'documentMessage'->>'caption') AS body,
            COALESCE(m.message->'documentMessage'->>'fileName',
                     m.message->'audioMessage'->>'fileName') AS filename,
            COALESCE(m.message->'imageMessage'->>'mimetype',
                     m.message->'audioMessage'->>'mimetype',
                     m.message->'documentMessage'->>'mimetype') AS mime,
            (m.message->'audioMessage'->>'seconds')::int AS seconds
       FROM "Message" m
      WHERE ${where.join(' AND ')}
      ORDER BY m."messageTimestamp" DESC
      LIMIT ${FETCH_LIMIT}`,
    params
  );
  let out = rows.reverse().map(r => ({
    id: r.id, message_id: r.id,
    direction: r.from_me === 'true' ? 'outgoing' : 'incoming',
    message_type: EVO_TYPE[r.evo_type] || 'text',
    message_body: r.body || r.filename || '',
    timestamp: new Date(Number(r.ts) * 1000),
    epoch: Number(r.ts),
    speaker: r.push_name || (r.participant || '').split('@')[0] || 'someone',
    media_mime_type: r.mime || null,
    seconds: r.seconds || null,
  }));
  // Keyword filtering happens here rather than in SQL: the body is assembled
  // from five different JSON paths above, so a WHERE on any one of them would
  // miss the others.
  if (scope?.keyword) {
    const k = scope.keyword.toLowerCase();
    out = out.filter(m => (m.message_body || '').toLowerCase().includes(k));
  }
  return out;
}

// ── assembling the text handed to the model ───────────────────────────────────

/**
 * Turn rows into transcript lines, pulling in media text for the chosen
 * modalities. Returns the lines plus what the media cost.
 */
async function renderTranscript({ source, conversationKey, rows, modalities, conf, cred, apiKey }) {
  const want = new Set(modalities);
  let mediaBudget = conf.max_media_per_run;
  let costMicros = 0, reused = 0, fresh = 0;
  const skipped = [];
  const lines = [];
  let prevTs = null;
  // Our own Media Library files (brochure, course video, voice note…). A file
  // with a description is represented BY that description — no paid
  // transcription or parsing of a company file we already describe.
  const library = await libraryMatches(source, rows).catch(() => new Map());

  for (const r of rows) {
    const mod = modalityOf(r.message_type);
    let body = (r.message_body || '').trim();
    const lib = library.get(r.message_id);

    // Already read once (a voice note transcribed in Chats, by an agent or an
    // earlier run; an image or PDF already read): its text is used whatever
    // modalities were picked — it is free, and leaving it out hid most of a
    // voice-note conversation behind "[voice note]" placeholders.
    if (r.__cached && !(lib && lib.description)) {
      const label = mod === 'audio' ? 'voice note' : mod === 'image' ? 'image' : 'document';
      body = body && mod !== 'audio' ? `${body}\n  [${label}] ${r.__cached}` : `[${label}] ${r.__cached}`;
      reused += 1;
    } else if (lib && (lib.description || mod === 'text' || !want.has(mod))) {
      const label = libraryLabel(lib, r.message_type);
      // The stored body of a sent file is its filename or caption; keep a
      // caption, drop a bare filename that only repeats the library name.
      body = body && body !== lib.name && !/\.(pdf|mp4|ogg|mp3|jpe?g|png|webp|docx?)$/i.test(body) ? `${label} ${body}` : label;
    } else if (mod !== 'text' && want.has(mod)) {
      if (mediaBudget <= 0) {
        skipped.push({ messageId: r.message_id, reason: 'per-run media limit reached' });
      } else {
        mediaBudget -= 1;
        const a = await extract.extractArtifact({
          source, messageKey: r.message_id, modality: mod, conversationKey,
          mime: r.media_mime_type, declaredSeconds: r.seconds, conf, cred, apiKey,
        });
        if (a.cached) reused += 1; else if (a.status === 'ok') fresh += 1;
        costMicros += a.costMicros || 0;
        if (a.status === 'ok' && a.text) {
          const label = mod === 'audio' ? 'voice note' : mod === 'image' ? 'image' : 'document';
          const named = lib ? `${label} from our Media Library: "${lib.name}"` : label;
          // The caption is kept alongside the extracted text — a customer's own
          // words about a screenshot are often the more useful half.
          body = body ? `${body}\n  [${named}] ${a.text}` : `[${named}] ${a.text}`;
        } else if (a.error) {
          skipped.push({ messageId: r.message_id, reason: a.error });
          if (!body) body = `${TYPE_PLACEHOLDER[r.message_type] || '[media]'} (unreadable: ${a.error})`;
        }
      }
    }

    if (body.length > 1200) body = `${body.slice(0, 1200)}…`;
    if (!body) body = TYPE_PLACEHOLDER[r.message_type] || '';
    if (!body) continue;

    const who = source === 'community'
      ? (r.direction === 'outgoing' ? 'us' : (r.speaker || 'someone'))
      : (r.direction === 'incoming' ? 'CUSTOMER' : 'US');
    // A long silence is part of the story ("replied 7 hours later") and is
    // invisible in a list of timestamps unless it is spelled out.
    const gap = prevTs ? gapText(new Date(r.timestamp) - new Date(prevTs)) : '';
    prevTs = r.timestamp;
    lines.push({ line: `${gap ? `  … ${gap} later …\n` : ''}[${istStamp(r.timestamp)}] ${who}: ${body}`, ts: r.timestamp });
  }

  return { lines, costMicros, reused, fresh, skipped };
}

/** "7h 12m" for a gap worth mentioning (≥ 1 hour), else ''. */
function gapText(ms) {
  if (!Number.isFinite(ms) || ms < 60 * 60 * 1000) return '';
  return durationText(ms);
}

function durationText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} days ${rh}h` : `${d} days`;
}

/**
 * Facts about the WHOLE conversation that an update reading only the new
 * messages would otherwise never see: who is waiting on whom and for how long,
 * how fast we answer, whether the 24h reply window is open, and what is inside
 * the files we have sent (brochure etc.). Cheap: one query over direction +
 * timestamp, the file text is parsed once per process.
 */
async function conversationFacts({ source, conversationKey, now = new Date() }) {
  if (source !== 'chat') return { timing: '', files: '' };
  const { rows } = await pool.query(
    `SELECT message_id, direction, message_type, timestamp
       FROM coexistence.chat_history
      WHERE ${KEY10('contact_number')} = ${KEY10('$1')}
        AND message_type NOT IN ('status','reaction','revoke','edit')
      ORDER BY timestamp, id`, [conversationKey]);
  if (!rows.length) return { timing: '', files: '' };
  return {
    timing: timingText(rows, now),
    files: await sentFilesText(source, rows),
  };
}

function timingText(rows, now = new Date()) {
  const ago = (ts) => durationText(now - new Date(ts));
  const last = rows[rows.length - 1];
  const lastIn = [...rows].reverse().find(r => r.direction === 'incoming');
  const lines = [`Now: ${istStamp(now)} IST.`];
  if (last.direction === 'incoming') {
    // Their message is the last one: THEY are waiting on US.
    const firstUnanswered = (() => {
      let i = rows.length - 1;
      while (i > 0 && rows[i - 1].direction === 'incoming') i -= 1;
      return rows[i];
    })();
    lines.push(`The CUSTOMER wrote last (${istStamp(last.timestamp)}). They have been waiting for OUR reply for ${ago(firstUnanswered.timestamp)}.`);
  } else {
    let n = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i].direction !== 'incoming'; i -= 1) n += 1;
    lines.push(lastIn
      ? `WE wrote last (${istStamp(last.timestamp)}, ${ago(last.timestamp)} ago). The customer has not replied to our last ${n} message${n === 1 ? '' : 's'}; their last message was ${ago(lastIn.timestamp)} ago (${istStamp(lastIn.timestamp)}).`
      : `Only WE have written so far; the customer has never replied.`);
  }
  // How long each customer message (or burst of them) waited for us.
  const waits = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].direction !== 'incoming' || (i > 0 && rows[i - 1].direction === 'incoming')) continue;
    const reply = rows.slice(i + 1).find(r => r.direction === 'outgoing');
    if (reply) waits.push(new Date(reply.timestamp) - new Date(rows[i].timestamp));
  }
  if (waits.length) {
    lines.push(`Our reply times to the customer's messages (oldest → newest): ${waits.slice(-5).map(durationText).join(', ')}.`);
  }
  if (lastIn) {
    const closes = new Date(new Date(lastIn.timestamp).getTime() + 24 * 3600 * 1000);
    lines.push(closes > now
      ? `WhatsApp 24h reply window: OPEN for another ${durationText(closes - now)} (free-form messages allowed until ${istStamp(closes)}).`
      : `WhatsApp 24h reply window: CLOSED since ${istStamp(closes)} — only an approved template can reach them now.`);
  }
  return lines.join('\n');
}

async function sentFilesText(source, rows) {
  const ours = rows.filter(r => r.direction === 'outgoing' && r.message_type === 'document');
  if (!ours.length) return '';
  const lib = await libraryMatches(source, ours).catch(() => new Map());
  const seen = new Set();
  const parts = [];
  for (const r of ours) {
    const l = lib.get(r.message_id);
    if (!l || seen.has(l.id)) continue;
    seen.add(l.id);
    const text = await libraryFileText(l.id).catch(() => '');
    if (!text && !l.description) continue;
    parts.push(`--- "${l.name}" (sent ${istStamp(r.timestamp)})${l.description ? ` — ${l.description}` : ''} ---\n${text || '(contents not readable — only the description above is known)'}`);
    if (parts.length >= 3) break;
  }
  return parts.join('\n\n');
}

/** Head + tail truncation. */
function foldTranscript(lines, { messageCap, charCap }) {
  let kept = lines, truncated = false;
  if (lines.length > messageCap) {
    // Never a plain "last N": the opening messages carry the source, the
    // qualifying answers and the stated goal — exactly what a verdict needs.
    // Dropping them to keep recent small talk is the wrong trade.
    const tailCount = Math.max(1, messageCap - HEAD_MESSAGES);
    const head = lines.slice(0, HEAD_MESSAGES);
    const tail = lines.slice(-tailCount);
    const omitted = lines.length - head.length - tail.length;
    kept = [...head, { line: `… [${omitted} earlier messages omitted] …` }, ...tail];
    truncated = true;
  }
  let text = kept.map(l => l.line).join('\n');
  if (text.length > charCap) {
    text = text.slice(text.length - charCap);
    const nl = text.indexOf('\n');
    if (nl > -1) text = text.slice(nl + 1);
    truncated = true;
  }
  return { text, truncated };
}

// ── prompt ────────────────────────────────────────────────────────────────────

function buildSystemPrompt({ source, stages, incremental, modalities, context = null }) {
  // What we sell. Without it every recommendation is generic; with it the model
  // can name the product and write follow-ups that mention it.
  const ctxText = context?.text
    ? `\n\n=== OUR BUSINESS (context from the sales team — use it, do not repeat it back) ===\n${context.text}\n=== END OF BUSINESS CONTEXT ===\n`
      + `\nUSE THIS CONTEXT — generic advice is useless to the sales team:`
      + `\n- "recommendations": 2-4 items. Each names a concrete action AND the specific product fact that supports it (e.g. "Resend the payment link and tell them UPI works best, since their payment has not gone through" — not "follow up with the customer").`
      + `\n- "follow_up_messages": every message must use at least one specific fact from the context that fits THIS customer — the price, the next batch date, the schedule, a payment/instalment option, or our answer to a doubt they raised. Never write "let me know if you have any questions" or other filler. Follow the tone the business context asks for.`
      + `\n- Never invent a product, price, date, feature or offer that is not in the context, the files we sent, or the conversation.`
      + `\n- ⚠ If a customer question was ALREADY ANSWERED by US in the conversation (a US text OR a US voice-note transcript), that answer is what we told them: treat it as settled fact, do not recommend "confirming with the team", and do not re-answer it in a follow-up unless they asked again.`
      + `\n- Only when NOBODY on our side has answered a question AND neither the context nor our files answer it: neither confirm nor deny it — in the follow-up say you will check, and add "Check <the question> with the team" to recommendations. Saying "we don't offer X" is inventing just as much as saying "we do".`
      + `\n- If what WE told the customer contradicts the business context or our files (a different price, date or schedule), point it out in "missed" — the customer may be confused.`
    : `\n\nNo business context has been provided, so do not invent products, prices or dates.`;
  const followUpKeys = `
  "interested_products": [${context?.productNames?.length ? `"exact name from: ${context.productNames.join(' | ').replace(/"/g, "'")}"` : '"a product or service they asked about"'}, "..."],
  "follow_up_messages": [{"when": "e.g. Now | If no reply in 24h | Day 3 | After they pay", "message": "a ready-to-send WhatsApp message to them — short, warm, personal, in the same language and style the customer writes in (e.g. Tamil + English if they mix), referring to the product and their situation"}, "... a SEQUENCE of 3-5 messages that takes this customer from where they are now to paying/enrolling, in order"],`;
  const media = modalities.filter(m => m !== 'text');
  // ⚠ Transcripts of voice notes are shown on EVERY run (they are cached and
  // free). The text-only variant of this note used to say "media is a bare
  // placeholder — do not guess", and every model tested (gpt-4o-mini → gpt-5)
  // then discounted our voice-note answers as "not answered in text" and told
  // the salesperson to answer questions we had already answered out loud.
  const mediaNote = `\n"[voice note] …" is the word-for-word TRANSCRIPT of a voice message — it is exactly what that speaker SAID, and it counts fully as their message. A question WE answered in a voice note IS answered; never call it "unanswered", "not answered in text" or "only audio". Transcripts are often Tamil, English or a mix (Tanglish) — read them in full. "[image] …" and "[document] …" followed by text are what that file showed or contained.`
    + (media.length ? '' : `\nA bare placeholder with no text after it, such as [image] or [voice note], was not read — do NOT guess what it contained.`);
  const libraryNote = `\nA line like [document from our Media Library: "Course brochure" — …] means WE sent one of our own prepared files (brochure, course video, voice note); the text after the dash is our description of what that file contains. When the full text of a file we sent is given under "FILES WE HAVE SENT THIS CUSTOMER", the customer already HAS every fact in it (schedule, dates, syllabus, requirements) — use those facts, and never recommend sending information that is already in that file; at most, point them to the page of the brochure that answers them. It is not the customer's words.`;

  if (source === 'community') {
    return `You analyse a WhatsApp GROUP conversation for a business that runs training programmes.
A group has many speakers and no single customer, so do NOT judge one person's buying intent.${mediaNote}${libraryNote}${ctxText}
${incremental ? '\nYou are given your PREVIOUS analysis and only the NEW messages since. Produce an UPDATED analysis of the whole conversation, carrying forward anything still true.\n' : ''}
Respond with ONLY a JSON object:
{
  "summary": "3-4 sentences on what this group is discussing and its mood",
  "problems": ["a problem in this group: an unanswered question, a complaint, confusion, something going wrong", "..."],
  "notes": ["a fact worth remembering: a date, a decision, a request, who said what that matters", "..."],
  "recommendations": ["a concrete action the business should take, most important first", "..."],
  "follow_up_messages": [{"when": "e.g. Now | Tomorrow morning", "message": "a ready-to-post message for this group, in the group's language and tone"}, "... 1-2 in total"],
  "sentiment": "positive|neutral|negative",
  "topics": ["short topic", "..."],
  "open_questions": ["a question someone asked that nobody answered", "..."],
  "participants": ["name of an actively contributing person", "..."],
  "next_action": "the single most useful thing the business should do in this group",
  "risk": "anything that could cost the business members or reputation, or null"
}`;
  }

  return `You analyse a 1:1 WhatsApp conversation between a business and a customer, for a sales team.
Every line is "[weekday, date, time IST] SPEAKER: message". SPEAKER is CUSTOMER (the lead) or US (our team, including our automated messages). "… 7h 12m later …" marks a long silence. The TIMING block says what time it is now and who is waiting on whom — use it: how quickly we answered, how long they have gone quiet, and when the next message should go out.${mediaNote}${libraryNote}${ctxText}
${incremental ? '\nYou are given your PREVIOUS analysis and only the NEW messages since it. Produce an UPDATED analysis of the WHOLE conversation, carrying forward anything still true and revising what the new messages change.\n' : ''}
The funnel stages you may suggest are exactly: ${stages.join(', ')}.
Respond with ONLY a JSON object:
{
  "summary": "3-4 sentences on what this customer wants and where the conversation stands",
  "problems": ["a problem or blocker: what is stopping the sale, what the customer is unsure or unhappy about, anything that went wrong on our side", "..."],
  "notes": ["a fact the salesperson must remember: what the customer said about themselves, their goal, a preference, a date, a promise made, what we already sent them", "..."],
  "recommendations": ["2-4 items, most important first. Each is ONE plain sentence a new salesperson understands without reading the chat: start with what to do (a verb), say WHEN (e.g. 'today before 7 PM', 'tomorrow morning'), and end with 'because …' naming the reason from THIS chat. Never recommend something we already did or said.", "..."],
  "reply_review": "1-2 sentences judging OUR replies (US lines, voice notes included): did we answer what they asked, correctly, and how fast (use the reply times)? Say plainly if our last message was good.",
  "missed": ["something WE missed: a question left unanswered, a promise not kept, wrong information, a buying moment not acted on", "..."],${followUpKeys}
  "next_follow_up": {"date": "YYYY-MM-DD — the best day (IST) for our NEXT message, today or later, judged from the TIMING block and what was promised (e.g. 'I'll confirm tomorrow', a payment date, a batch deadline)", "time": "HH:MM (24h IST) when a time of day matters, else null", "reason": "one short sentence why this day"},
  "intent": "high|medium|low|none",
  "sentiment": "positive|neutral|negative",
  "confidence": 0.0-1.0,
  "suggested_stage": "one of the stages above, or null if unsure",
  "stage_reason": "one sentence citing what in the conversation supports it",
  "next_action": "the single most useful thing the salesperson should do next",
  "risk": "what could lose this customer, or null",
  "objections": ["an objection the customer actually raised", "..."],
  "buying_signals": ["something they said that shows real interest", "..."],
  "topics": ["short topic", "..."]
}
US lines are OUR team's replies (voice notes appear as their transcript) — read them as carefully as the CUSTOMER's. Before writing any recommendation or follow-up, check it against what US already said and what our files already contain: never tell the salesperson to say, send or confirm something that is already there. Follow-ups continue from OUR last message — they do not restart the pitch.
Base every field on what was actually said. Keep each list item to one short sentence; use [] when there is nothing real to put in a list. If the conversation is too thin to judge, say so in the summary and set confidence low.`;
}

function cleanList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => (typeof x === 'string' ? x : x?.text || x?.label || '')).map(s => String(s).trim()).filter(Boolean).slice(0, 12);
}

/** [{when, message}] — ready-to-send follow-ups. A bare string is kept as a message. */
function cleanFollowUps(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => {
    if (typeof x === 'string') return x.trim() === '...' ? null : { when: null, message: x.trim() };
    const message = String(x?.message || x?.text || '').trim();
    return { when: x?.when ? String(x.when).trim().slice(0, 80) : null, message };
  }).filter(f => f && f.message && f.message !== '...').map(f => ({ ...f, message: f.message.slice(0, 1500) })).slice(0, 5);
}

/** Today in IST as YYYY-MM-DD. */
function istToday(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * {date, time, reason} or null. A date in the past is moved to today (the model
 * sometimes answers "yesterday's" plan) and one more than 90 days out is
 * refused — a calendar entry nobody will reach is noise.
 */
function cleanNextFollowUp(v, now = new Date()) {
  if (!v || typeof v !== 'object') return null;
  const date = String(v.date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  const today = istToday(now);
  const max = istToday(new Date(now.getTime() + 90 * 86400000));
  if (date > max) return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time || '').trim()) ? String(v.time).trim() : null;
  return {
    date: date < today ? today : date,
    time,
    reason: typeof v.reason === 'string' ? v.reason.trim().slice(0, 300) : null,
  };
}

function coerceVerdict(parsed, source) {
  const p = parsed || {};
  const out = {
    summary: typeof p.summary === 'string' ? p.summary.trim().slice(0, 2000) : null,
    sentiment: SENTIMENTS.has(p.sentiment) ? p.sentiment : null,
    next_action: typeof p.next_action === 'string' ? p.next_action.trim().slice(0, 600) : null,
    risk: typeof p.risk === 'string' && p.risk.trim() ? p.risk.trim().slice(0, 600) : null,
    topics: cleanList(p.topics),
    problems: cleanList(p.problems),
    notes: cleanList(p.notes),
    recommendations: cleanList(p.recommendations),
    interested_products: cleanList(p.interested_products).slice(0, 6),
    follow_ups: cleanFollowUps(p.follow_up_messages || p.follow_ups),
    reply_review: typeof p.reply_review === 'string' && p.reply_review.trim() ? p.reply_review.trim().slice(0, 800) : null,
    missed: cleanList(p.missed),
    next_follow_up: source === 'community' ? null : cleanNextFollowUp(p.next_follow_up),
  };
  if (source === 'community') {
    out.open_questions = cleanList(p.open_questions);
    out.participants = cleanList(p.participants);
    out.intent = null; out.confidence = null; out.suggested_stage = null;
    out.stage_reason = null; out.objections = []; out.buying_signals = [];
    return out;
  }
  out.intent = INTENTS.has(p.intent) ? p.intent : null;
  const c = Number(p.confidence);
  out.confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
  // A stage the model invented, or one an admin has since deleted, is dropped
  // rather than stored — validated against the live funnel config.
  out.suggested_stage = (typeof p.suggested_stage === 'string' && cfg.isValidStage(p.suggested_stage))
    ? p.suggested_stage : null;
  out.stage_reason = typeof p.stage_reason === 'string' ? p.stage_reason.trim().slice(0, 600) : null;
  out.objections = cleanList(p.objections);
  out.buying_signals = cleanList(p.buying_signals);
  out.open_questions = []; out.participants = [];
  return out;
}

/**
 * Mark media messages whose text is ALREADY stored (transcript / vision /
 * document, status ok) so they are treated like text: always read, free, and
 * counted under the TEXT watermark. That is what lets a voice-note reply from
 * our side register as "a new message" for a text-only Update analysis.
 */
async function annotateCached(source, rows) {
  const media = rows.filter(r => modalityOf(r.message_type) !== 'text' && r.message_id);
  if (!media.length) return rows;
  const { rows: arts } = await pool.query(
    `SELECT message_key, text FROM coexistence.chat_message_artifacts
      WHERE source = $1 AND message_key = ANY($2::text[]) AND status = 'ok'
        AND kind IN ('transcript','vision','document') AND text <> ''`,
    [source, media.map(r => r.message_id)]
  );
  const byKey = new Map(arts.map(a => [a.message_key, a.text]));
  for (const r of rows) {
    const t = byKey.get(r.message_id);
    if (t) { r.__cached = t; r.__mod = 'text'; }
  }
  return rows;
}

/**
 * What has arrived since the last analysis — shown next to Update analysis so it
 * is obvious whether a new reply (ours or theirs) has been read yet.
 * `untranscribed` = new voice notes with no transcript: a text-only update cannot
 * read those, so the UI says so rather than looking up to date.
 */
async function unreadSince(source, conversationKey) {
  conversationKey = canonicalKey(source, conversationKey);
  if (source !== 'chat') return null;
  const cov = await loadCoverage(source, conversationKey);
  const seq = Number(cov?.text?.seq || 0);
  if (!seq) return null;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE h.message_type IN ('audio','voice') AND NOT EXISTS (
              SELECT 1 FROM coexistence.chat_message_artifacts a
               WHERE a.source = 'chat' AND a.message_key = h.message_id AND a.kind = 'transcript' AND a.status = 'ok'))::int AS untranscribed,
            MAX(h.timestamp) AS latest
       FROM coexistence.chat_history h
      WHERE ${KEY10('h.contact_number')} = ${KEY10('$1')} AND h.id > $2
        AND h.message_type NOT IN ('status','reaction','revoke')`,
    [conversationKey, seq]
  );
  return { total: r.total, untranscribed: r.untranscribed, latest: r.latest, readUpTo: cov.text.at };
}

/**
 * The last few messages BEFORE the new ones — already analysed, sent only so
 * the model understands what the new messages are replying to. Cached media is
 * included; nothing is paid for.
 */
async function fetchRecentContext({ source, conversationKey, beforeSeq, limit = 4 }) {
  if (source !== 'chat' || !beforeSeq) return [];
  const { rows } = await pool.query(
    `SELECT id, message_id, direction, message_type, message_body, timestamp, wa_number, media_mime_type
       FROM coexistence.chat_history
      WHERE ${KEY10('contact_number')} = ${KEY10('$1')} AND id <= $2
        AND message_type NOT IN ('status','reaction','revoke')
      ORDER BY timestamp DESC, id DESC LIMIT $3`,
    [conversationKey, beforeSeq, limit]
  );
  return annotateCached(source, rows.reverse());
}

/**
 * Keep only the messages that are NEW for their own modality.
 *
 * ⚠ THE WHOLE POINT OF THIS FUNCTION. Coverage is per modality, so a message is
 * judged against the watermark of ITS OWN kind. Cover a conversation to message
 * 5000 as text-only, then switch images on: every image at or below 5000 is
 * still new, because the image watermark is unset. A single conversation-level
 * watermark reports "5000 done", skips them all, and nothing errors — the
 * analysis is just quietly missing what the user turned images on to see.
 *
 * `active: false` means a full read (no coverage yet, or the run is scoped);
 * everything is returned unfiltered.
 *
 * Community uses `>=` on a whole-second epoch because Evolution's message id has
 * no order — see fetchGroupMessages. Re-reading a boundary message is cheap;
 * losing one is silent and permanent.
 */
function filterToNewMessages(rows, { modalities, coverage = {}, source = 'chat', active = true } = {}) {
  if (!active) return rows;
  const want = new Set(modalities || []);
  return rows.filter((r) => {
    const m = r.__mod || modalityOf(r.message_type);
    if (!want.has(m)) return false;
    const cov = coverage[m];
    if (!cov) return true;                       // never covered → all of it is new
    return source === 'community'
      ? Number(r.epoch || 0) >= Number(cov.epoch || 0)
      : Number(r.id) > Number(cov.seq || 0);
  });
}

// ── the transcript ────────────────────────────────────────────────────────────
//
// What was actually said, message by message, with timestamps — as opposed to
// the analysis, which is what it MEANT.
//
// ⚠ DERIVED ON READ, NEVER STORED AS A SECOND COPY. The expensive half (audio →
// text) IS stored, permanently, in chat_message_artifacts. Assembling those into
// a conversation is cheap, and a saved assembly would go stale the moment the
// next message lands — the restated-fact trap this codebase has paid for before.
//
// ⚠ AND IT IS NOT FOLDED. renderTranscript() trims to fit the model's context
// window, which is right when feeding an LLM and wrong here: a transcript that
// silently drops the middle of a conversation is worse than no transcript,
// because nothing on screen says it happened.

const TRANSCRIPT_MAX = 5000;   // a hard stop, not a silent trim: reported when hit

/**
 * One entry per message, oldest first.
 *
 * Audio carries its exact transcript when one is cached, and is flagged
 * `pending` when it is not — never silently dropped, or the reader believes
 * they are looking at the whole conversation.
 */
async function buildFullTranscript({ source = 'chat', conversationKey, scope = null } = {}) {
  conversationKey = canonicalKey(source, conversationKey);
  const convo = await resolveConversation(source, conversationKey);
  if (!convo) throw Object.assign(new Error('That conversation could not be found'), { status: 404 });

  const rows = source === 'community'
    ? await fetchGroupMessages({ conversationKey, scope, since: null })
    : await fetchChatMessages({ conversationKey, scope, since: null });

  // One query for every cached artifact in this conversation, rather than one
  // per message — a 200-message chat would otherwise make 200 round trips.
  const keys = rows.map(r => r.message_id).filter(Boolean);
  const artifacts = new Map();
  if (keys.length) {
    const { rows: arts } = await pool.query(
      `SELECT message_key, kind, text, status, error, audio_seconds
         FROM coexistence.chat_message_artifacts
        WHERE source = $1 AND message_key = ANY($2::text[])`,
      [source, keys]
    );
    for (const a of arts) artifacts.set(`${a.message_key}:${a.kind}`, a);
  }

  const shown = rows.slice(0, TRANSCRIPT_MAX);
  const library = await libraryMatches(source, shown).catch(() => new Map());

  let pendingAudio = 0, transcribedAudio = 0, images = 0, documents = 0, fromLibrary = 0;
  const entries = shown.map((r) => {
    const mod = modalityOf(r.message_type);
    const body = (r.message_body || '').trim();
    const e = {
      messageId: r.message_id,
      at: r.timestamp,
      direction: r.direction === 'incoming' ? 'in' : 'out',
      speaker: source === 'community'
        ? (r.direction === 'outgoing' ? 'us' : (r.speaker || 'someone'))
        : (r.direction === 'incoming' ? 'customer' : 'us'),
      type: r.message_type,
      text: body,
      isTranscript: false,
    };

    // A file from our own Media Library: named, and described when it has a
    // description. A described library voice note needs no transcription — it
    // is never counted as pending, so nobody is asked to pay to transcribe
    // our own recording once per recipient.
    const lib = library.get(r.message_id);
    if (lib) {
      e.library = { id: lib.id, name: lib.name, description: lib.description };
      fromLibrary += 1;
    }

    if (mod === 'audio' && lib && lib.description && !artifacts.get(`${r.message_id}:transcript`)) {
      e.text = '';
    } else if (mod === 'audio') {
      const a = artifacts.get(`${r.message_id}:transcript`);
      if (a && a.status === 'ok' && a.text) {
        // The exact words. This is the whole point of the feature.
        e.text = a.text;
        e.isTranscript = true;
        e.audioSeconds = a.audio_seconds == null ? null : Number(a.audio_seconds);
        transcribedAudio += 1;
      } else if (a && a.status !== 'ok') {
        e.text = '';
        e.note = a.error || 'This voice note could not be transcribed';
        e.unreadable = true;
      } else {
        e.text = '';
        e.pending = true;               // never dropped — surfaced as "not transcribed yet"
        pendingAudio += 1;
      }
    } else if (mod === 'image') {
      // Marked, not described. Vision is deliberately not run for the
      // transcript — see the route's note about what Claude can and cannot see.
      images += 1;
      e.caption = body || null;
      e.text = '';
    } else if (mod === 'document') {
      documents += 1;
      e.filename = body || null;
      e.text = '';
    }
    return e;
  });

  return {
    conversation: convo,
    entries,
    counts: {
      messages: entries.length,
      total: rows.length,
      audioTranscribed: transcribedAudio,
      audioPending: pendingAudio,
      images, documents,
      fromLibrary,
    },
    // A hard stop that says so, rather than a quiet trim.
    truncated: rows.length > TRANSCRIPT_MAX,
    scope: scope || null,
  };
}

/** Plain text rendering — what a person copies out, or an LLM reads. */
function transcriptToText(t) {
  return t.entries.map((e) => {
    const stamp = istStamp(e.at);
    let what = e.text;
    if (e.library && !e.isTranscript) {
      what = libraryLabel(e.library, e.type);
    } else if (e.library && e.isTranscript) {
      what = `${libraryLabel(e.library, e.type)} ${what}`;
    } else if (!what) {
      if (e.pending) what = '[voice note — not transcribed yet]';
      else if (e.unreadable) what = `[voice note — ${e.note}]`;
      else if (e.type === 'image') what = e.caption ? `[image] ${e.caption}` : '[image]';
      else if (e.type === 'document') what = e.filename ? `[document] ${e.filename}` : '[document]';
      else what = TYPE_PLACEHOLDER[e.type] || '[no text]';
    } else if (e.isTranscript) {
      what = `[voice note] ${what}`;
    }
    return `[${stamp}] ${e.speaker}: ${what}`;
  }).join('\n');
}

/**
 * How many voice notes still need transcribing here, and what that would cost.
 * Counted from the CACHE, so an already-transcribed conversation reports zero
 * and the button that spends money disappears.
 */
async function transcribeEstimate({ source = 'chat', conversationKey, scope = null } = {}) {
  conversationKey = canonicalKey(source, conversationKey);
  const conf = await loadConfig();
  const t = await buildFullTranscript({ source, conversationKey, scope });
  const pending = t.entries.filter(e => e.pending);
  // Real durations where we know them (Evolution declares them); the rest use
  // the same assumption the bulk estimate uses, and the UI says so.
  const ASSUMED = 30;
  const seconds = pending.length * ASSUMED;
  const micros = extract.audioCostMicros(conf.rate_card, conf.transcribe_model, seconds);
  return {
    pending: pending.length,
    alreadyTranscribed: t.counts.audioTranscribed,
    assumedSecondsEach: ASSUMED,
    micros,
    inr: extract.microsToInr(micros, conf.usd_to_inr),
    estimated: true,
  };
}

/**
 * Transcribe this conversation's untranscribed voice notes.
 *
 * ⚠ THIS IS READING, NOT ANALYSING. It deliberately does NOT advance the
 * coverage watermark and does NOT touch the standing summary: a conversation can
 * have a complete transcript while its analysis has still never looked at the
 * audio. Advancing coverage here would claim the analyser had read something it
 * has not, and the summary would silently stop offering to.
 */
async function transcribeConversation({ source = 'chat', conversationKey, scope = null, actor = 'system' } = {}) {
  conversationKey = canonicalKey(source, conversationKey);
  const conf = await loadConfig();
  if (!conf?.enabled) throw Object.assign(new Error('Chat Analyzer is switched off in its settings'), { status: 400 });

  const apiKey = await extract.resolveTranscriptionKey();
  if (!apiKey) {
    throw Object.assign(new Error('No OpenRouter key is connected, so voice notes cannot be transcribed. Add one in Admin Settings → AI Models.'), { status: 400 });
  }

  const before = await buildFullTranscript({ source, conversationKey, scope });
  const pending = before.entries.filter(e => e.pending);
  if (!pending.length) {
    return { ok: true, transcribed: 0, alreadyDone: before.counts.audioTranscribed, costInr: 0, failed: [] };
  }

  const cap = conf.max_media_per_run;
  const todo = pending.slice(0, cap);
  let costMicros = 0, done = 0;
  const failed = [];

  for (const e of todo) {
    const r = await extract.extractArtifact({
      source, messageKey: e.messageId, modality: 'audio',
      conversationKey, conf, cred: null, apiKey,
    });
    costMicros += r.costMicros || 0;
    if (r.status === 'ok') done += 1;
    else failed.push({ messageId: e.messageId, reason: r.error || r.status });
  }

  // Recorded as a run so the cost dashboard and the run log account for it —
  // but as its own kind, so it is never mistaken for an analysis.
  await recordRun({
    source, conversationKey, leadId: before.conversation.leadId,
    kind: source === 'community' ? 'group' : 'conversation',
    trigger: 'manual', actor, status: 'ok',
    modalities: ['audio'], scope, scoped: !!scope, incremental: false,
    newMessages: todo.length, messagesAnalysed: done,
    freshArtifacts: done, artifactCost: costMicros,
    result: { transcribeOnly: true, transcribed: done, failed },
  });

  return {
    ok: true,
    transcribed: done,
    remaining: Math.max(0, pending.length - todo.length),
    cappedAt: pending.length > cap ? cap : null,
    costInr: extract.microsToInr(costMicros, conf.usd_to_inr),
    failed,
  };
}


// ── images, handed over as images ─────────────────────────────────────────────

const IMAGE_MAX_PER_CALL = 5;
const IMAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * The actual bytes of specific images from one conversation, so a model that can
 * see can look at them itself.
 *
 * ⚠ SCOPED TO THE CONVERSATION, ALWAYS. The caller names message ids, and every
 * one is checked to belong to THIS conversation and to be an image before a byte
 * is read. Without that the tool becomes "read any image in the workspace by id",
 * which is a different permission from the per-conversation one the route
 * already enforces.
 *
 * ⚠ Capped by count AND by total bytes. A conversation can hold 18 images; one
 * response carrying all of them helps nobody and is the only way this tool can
 * misbehave.
 */
async function getConversationImages({ source = 'chat', conversationKey, messageIds = [] } = {}) {
  conversationKey = canonicalKey(source, conversationKey);
  const wanted = (Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(x => String(x || '').trim()).filter(Boolean);
  if (!wanted.length) {
    throw Object.assign(new Error('Which images? Pass messageIds from get_chat_transcript.'), { status: 400 });
  }

  // The transcript is the authority on what is in this conversation, so the
  // membership check and the id the caller quoted come from the same place.
  const t = await buildFullTranscript({ source, conversationKey });
  const byId = new Map(t.entries.map(e => [e.messageId, e]));

  const out = [];
  const skipped = [];
  let total = 0;

  for (const id of wanted.slice(0, IMAGE_MAX_PER_CALL)) {
    const e = byId.get(id);
    if (!e) { skipped.push({ messageId: id, reason: 'not a message in this conversation' }); continue; }
    if (modalityOf(e.type) !== 'image') {
      // Video cannot be shown and a PDF is not an image; saying which beats a
      // generic refusal the caller cannot act on.
      skipped.push({ messageId: id, reason: `this is a ${e.type}, not an image` });
      continue;
    }
    const r = await extract.loadMediaBase64({ source, messageKey: id });
    if (r.error) { skipped.push({ messageId: id, reason: r.error }); continue; }
    if (total + r.bytes > IMAGE_MAX_TOTAL_BYTES) {
      skipped.push({ messageId: id, reason: 'would exceed the size limit for one response — ask for it on its own' });
      continue;
    }
    total += r.bytes;
    out.push({
      messageId: id, at: e.at, from: e.speaker, direction: e.direction,
      caption: e.caption || null, mimeType: r.mime, bytes: r.bytes, base64: r.base64,
    });
  }

  if (wanted.length > IMAGE_MAX_PER_CALL) {
    skipped.push({ messageId: null, reason: `only the first ${IMAGE_MAX_PER_CALL} of ${wanted.length} were fetched` });
  }
  return { conversation: t.conversation, images: out, skipped, totalBytes: total };
}

// ── conversations ─────────────────────────────────────────────────────────────

/** Who this conversation is, for either source. Null if it does not exist. */
async function resolveConversation(source, conversationKey) {
  conversationKey = canonicalKey(source, conversationKey);
  if (source === 'community') {
    const { rows } = await pool.query(
      `SELECT group_jid, name, instance_name, active
         FROM coexistence.community_groups WHERE group_jid = $1`,
      [conversationKey]
    );
    if (!rows.length) return null;
    return {
      source, conversationKey, displayName: rows[0].name || conversationKey,
      leadId: null, waNumber: null, instanceName: rows[0].instance_name,
    };
  }
  // A chat is identified by the last 10 digits, so it resolves even when the
  // lead stores '+91 98765 43210' and chat_history stores '919876543210'.
  const { rows } = await pool.query(
    `SELECT c.contact_number, c.wa_number, COALESCE(c.name, c.profile_name) AS name,
            l.id AS lead_id, l.name AS lead_name, l.stage
       FROM coexistence.contacts c
       LEFT JOIN coexistence.leads l ON ${KEY10('l.whatsapp_number')} = ${KEY10('c.contact_number')}
      WHERE ${KEY10('c.contact_number')} = ${KEY10('$1')}
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 1`,
    [conversationKey]
  );
  if (!rows.length) {
    // No contact row — but chat_history may still hold the conversation.
    const { rows: h } = await pool.query(
      `SELECT contact_number, wa_number FROM coexistence.chat_history
        WHERE ${KEY10('contact_number')} = ${KEY10('$1')}
        ORDER BY timestamp DESC LIMIT 1`,
      [conversationKey]
    );
    if (!h.length) return null;
    return { source, conversationKey, displayName: h[0].contact_number, leadId: null, waNumber: h[0].wa_number, contactNumber: h[0].contact_number };
  }
  const r = rows[0];
  return {
    source, conversationKey,
    displayName: r.lead_name || r.name || r.contact_number,
    leadId: r.lead_id || null, waNumber: r.wa_number, contactNumber: r.contact_number,
    stage: r.stage || null,
  };
}

async function loadAnalysis(source, conversationKey) {
  conversationKey = canonicalKey(source, conversationKey);
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.chat_analysis WHERE source = $1 AND conversation_key = $2`,
    [source, conversationKey]
  );
  return rows[0] || null;
}

/** A compact rendering of the previous verdict, for an incremental prompt. */
function priorSummaryText(prev) {
  if (!prev || !prev.summary) return '';
  const bits = [`Summary: ${prev.summary}`];
  if (prev.intent) bits.push(`Intent: ${prev.intent}`);
  if (prev.sentiment) bits.push(`Sentiment: ${prev.sentiment}`);
  if (prev.suggested_stage) bits.push(`Suggested stage: ${prev.suggested_stage}`);
  const arr = (v) => (Array.isArray(v) ? v : []);
  if (arr(prev.objections).length) bits.push(`Objections: ${arr(prev.objections).join('; ')}`);
  if (arr(prev.buying_signals).length) bits.push(`Buying signals: ${arr(prev.buying_signals).join('; ')}`);
  if (arr(prev.topics).length) bits.push(`Topics: ${arr(prev.topics).join('; ')}`);
  if (arr(prev.open_questions).length) bits.push(`Open questions: ${arr(prev.open_questions).join('; ')}`);
  if (prev.next_action) bits.push(`Next action: ${prev.next_action}`);
  if (arr(prev.problems).length) bits.push(`Problems: ${arr(prev.problems).join('; ')}`);
  if (arr(prev.notes).length) bits.push(`Notes: ${arr(prev.notes).join('; ')}`);
  if (arr(prev.recommendations).length) bits.push(`Recommendations (drop any the conversation has since done or answered): ${arr(prev.recommendations).join('; ')}`);
  if (arr(prev.interested_products).length) bits.push(`Interested in: ${arr(prev.interested_products).join('; ')}`);
  if (arr(prev.missed).length) bits.push(`We had missed: ${arr(prev.missed).join('; ')}`);
  // What we told the team to send last time — so the update can say whether our
  // replies since then followed it, and move the sequence on instead of restarting.
  if (arr(prev.follow_ups).length) bits.push(`Follow-ups suggested last time: ${arr(prev.follow_ups).map(f => `${f.when ? `[${f.when}] ` : ''}${f.message}`).join(' || ')}`);
  return bits.join('\n');
}

// ── the run ───────────────────────────────────────────────────────────────────

function isScopedRequest(scope) {
  return !!(scope && (scope.from || scope.to || scope.keyword));
}

/**
 * Analyse one conversation.
 *
 * @param modalities  which of text|image|audio|document to read this run
 * @param scope       {from,to,keyword} — makes the run SCOPED: stored as its own
 *                    result, never overwriting the rolling verdict, never
 *                    advancing coverage
 * @param incremental read only what is new since coverage (ignored when scoped)
 */
async function analyseConversation({
  source = 'chat', conversationKey, modalities: wantModalities = null,
  scope = null, incremental = true, trigger = 'manual', actor = 'system',
  batchId = null, conf = null,
} = {}) {
  conversationKey = canonicalKey(source, conversationKey);
  const started = Date.now();
  conf = conf || await loadConfig();
  if (!conf) throw Object.assign(new Error('Chat Analyzer is not configured'), { status: 500 });
  if (!conf.enabled) throw Object.assign(new Error('Chat Analyzer is switched off in its settings'), { status: 400 });

  const convo = await resolveConversation(source, conversationKey);
  if (!convo) throw Object.assign(new Error('That conversation could not be found'), { status: 404 });

  const modalities = resolveModalities(conf, wantModalities);
  if (!modalities.length) {
    throw Object.assign(new Error('Nothing is selected to analyse — pick at least one of text, images, voice notes or documents'), { status: 400 });
  }
  const scoped = isScopedRequest(scope);
  const { cred, modelId } = await resolveModel(conf);
  if (!cred) {
    throw Object.assign(new Error('No OpenAI-compatible AI model is connected. Add an OpenAI key in Admin Settings → AI Models.'), { status: 400 });
  }

  // A scoped run is a question about a slice, so it is never incremental: the
  // whole point is to read exactly the range asked for.
  const coverage = await loadCoverage(source, conversationKey);
  const prev = await loadAnalysis(source, conversationKey);
  const context = await analyserContext.currentBlock();
  // ⚠ A verdict made with DIFFERENT business context is stale even when no new
  // message has arrived — otherwise editing the products would change nothing
  // until the customer happened to write again ("already up to date"). So a
  // context change forces a full re-read (media is cached, so it costs tokens only).
  const contextChanged = !!prev && (prev.context_hash || '') !== context.hash;
  const useIncremental = incremental && !scoped && !contextChanged;

  // The fetch floor is the LOWEST watermark across the requested modalities —
  // if text is covered to 5000 but audio only to 1200, audio still needs 1201+.
  // Any modality with no coverage at all forces a full read.
  let since = null;
  if (useIncremental && modalities.every(m => coverage[m])) {
    const key = source === 'community' ? 'epoch' : 'seq';
    since = Math.min(...modalities.map(m => coverage[m][key] || 0)) || null;
  }

  const rows = source === 'community'
    ? await fetchGroupMessages({ conversationKey, scope, since })
    : await fetchChatMessages({ conversationKey, scope, since });

  await annotateCached(source, rows);
  const fresh = filterToNewMessages(rows, {
    modalities, coverage, source, active: useIncremental && since != null,
  });

  const newMessages = fresh.length;
  if (!newMessages && prev && useIncremental) {
    // Nothing new is a legitimate, cheap outcome — recorded so the tab can say
    // "up to date" rather than looking like a failed run.
    const runId = await recordRun({
      source, conversationKey, leadId: convo.leadId, batchId, trigger, actor,
      kind: source === 'community' ? 'group' : 'conversation',
      status: 'skipped', error: 'Already up to date — no new messages',
      modalities, scope, scoped, incremental: true, newMessages: 0,
      elapsedMs: Date.now() - started,
    });
    return { ok: true, skipped: true, reason: 'up_to_date', runId, newMessages: 0, conversation: convo };
  }
  if (!newMessages) {
    throw Object.assign(new Error(scoped
      ? 'No messages match that date range or keyword'
      : 'This conversation has no messages to analyse'), { status: 400 });
  }

  const apiKey = modalities.includes('audio') ? await extract.resolveTranscriptionKey() : null;
  const rendered = await renderTranscript({
    source, conversationKey, rows: fresh, modalities, conf, cred, apiKey,
  });
  if (!rendered.lines.length) {
    throw Object.assign(new Error('Nothing readable in those messages'), { status: 400 });
  }
  const { text: transcript, truncated } = foldTranscript(rendered.lines, {
    messageCap: conf.transcript_message_cap, charCap: conf.transcript_char_cap,
  });

  const stages = cfg.funnelStageKeys ? cfg.funnelStageKeys() : [];
  const system = buildSystemPrompt({
    source, stages, modalities, context,
    incremental: useIncremental && since != null && !!prev,
  });
  const priorText = (useIncremental && since != null && prev) ? priorSummaryText(prev) : '';
  // An update is: the previous analysis + a few messages it already covered (so
  // the new ones make sense) + ONLY the new messages. Never the whole chat again.
  let recentText = '';
  if (priorText) {
    const firstNewSeq = source === 'chat' ? Number(fresh[0]?.id) : null;
    const ctxRows = await fetchRecentContext({ source, conversationKey, beforeSeq: firstNewSeq ? firstNewSeq - 1 : null });
    if (ctxRows.length) {
      const ctxRendered = await renderTranscript({ source, conversationKey, rows: ctxRows, modalities: [], conf, cred, apiKey: null });
      // Trimmed: this is only so the new messages make sense, and a few long
      // voice-note transcripts here would cost as much as the update saves.
      recentText = ctxRendered.lines.map(l => (l.line.length > 300 ? `${l.line.slice(0, 300)}…` : l.line)).join('\n');
    }
  }
  // Whole-conversation facts an update reading only the new messages would miss.
  const facts = await conversationFacts({ source, conversationKey }).catch((e) => {
    console.warn('[chatAnalyser] conversation facts unavailable:', e.message);
    return { timing: '', files: '' };
  });
  const userMsg = [
    facts.timing ? `TIMING:\n${facts.timing}\n` : '',
    facts.files ? `FILES WE HAVE SENT THIS CUSTOMER (they already have all of this):\n${facts.files}\n` : '',
    priorText ? `PREVIOUS ANALYSIS (made from the earlier messages):\n${priorText}\n` : '',
    recentText ? `LAST MESSAGES ALREADY COVERED (context only):\n${recentText}\n` : '',
    priorText ? `NEW MESSAGES SINCE THEN:\n${transcript}` : `CONVERSATION:\n${transcript}`,
  ].filter(Boolean).join('\n');

  let llmRes, verdict, llmCost = 0, err = null;
  try {
    llmRes = await runChatCompletion(cred, modelId, [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ], {
      // Reasoning models (gpt-5 family) spend most of their budget THINKING —
      // measured ~2.5k reasoning + ~1.3k answer on a 60-message chat — so the
      // old 2000 cut their answer off. A ceiling, not a target: billed per use.
      maxTokens: 8000, json: true, withUsage: true,
    });
    verdict = coerceVerdict(parseLooseJson(llmRes.content), source);
    const u = llmRes.usage || {};
    llmCost = extract.tokenCostMicros(conf.rate_card, 'text', modelId, u.prompt_tokens, u.completion_tokens);
  } catch (e) {
    err = e.message?.slice(0, 400) || 'The AI call failed';
  }

  const runId = await recordRun({
    source, conversationKey, leadId: convo.leadId, batchId, trigger, actor,
    kind: source === 'community' ? 'group' : 'conversation',
    status: err ? 'error' : 'ok', error: err,
    provider: cred.provider, modelId, credentialId: cred.id,
    promptTokens: llmRes?.usage?.prompt_tokens, completionTokens: llmRes?.usage?.completion_tokens,
    totalTokens: llmRes?.usage?.total_tokens,
    elapsedMs: Date.now() - started, messagesAnalysed: rendered.lines.length,
    truncated, modalities, scope, scoped, incremental: useIncremental && since != null,
    newMessages, reused: rendered.reused, freshArtifacts: rendered.fresh,
    llmCost, artifactCost: rendered.costMicros,
    parsed: verdict || null, raw: llmRes?.content,
    result: verdict ? { ...verdict, skippedMedia: rendered.skipped } : null,
    suggestedStage: verdict?.suggested_stage || null,
  });

  if (err) throw Object.assign(new Error(err), { status: 502, runId });

  const last = fresh[fresh.length - 1];

  // ⚠ A scoped run stops here. It has produced a real, stored answer (the run
  // row above) but must not become the conversation's standing verdict, and must
  // not claim coverage over a range it only read a filtered slice of.
  if (!scoped) {
    await persistVerdict({
      source, conversationKey, convo, verdict, modalities, runId,
      lastMessageId: source === 'chat' ? Number(last.id) : null,
      lastMessageAt: last.timestamp, truncated, modelId,
      // An update reads only the new messages, but the verdict covers them all.
      count: (priorText ? Number(prev.analysed_message_count || 0) : 0) + rendered.lines.length,
      contextHash: context.hash,
    });
    await advanceCoverage({
      source, conversationKey, modalities,
      seq: source === 'chat' ? Number(last.id) : null,
      epoch: source === 'community' ? last.epoch : null,
      at: last.timestamp, from: fresh[0].timestamp,
      count: newMessages, runId,
    });
  }

  return {
    ok: true, runId, scoped, incremental: useIncremental && since != null,
    conversation: convo, verdict, newMessages,
    messagesAnalysed: rendered.lines.length, truncated,
    modalities, skippedMedia: rendered.skipped,
    // Plain answer to "did it see my reply?": what this run read and on top of what.
    read: {
      builtOnPrevious: !!priorText,
      contextChanged,
      newMessages,
      voiceNotes: fresh.filter(r => TYPES_AUDIO.has(r.message_type)).length,
      fromUs: fresh.filter(r => r.direction === 'outgoing').length,
      fromThem: fresh.filter(r => r.direction === 'incoming').length,
      recentContext: recentText ? recentText.split('\n').length : 0,
      lastMessageAt: last?.timestamp || null,
    },
    cost: {
      llmMicros: llmCost, artifactMicros: rendered.costMicros,
      totalMicros: llmCost + rendered.costMicros,
      inr: extract.microsToInr(llmCost + rendered.costMicros, conf.usd_to_inr),
      reusedArtifacts: rendered.reused, newArtifacts: rendered.fresh,
    },
  };
}

async function persistVerdict({ source, conversationKey, convo, verdict, modalities, runId, lastMessageId, lastMessageAt, count, truncated, modelId, contextHash = '' }) {
  await pool.query(
    `INSERT INTO coexistence.chat_analysis
       (source, conversation_key, lead_id, wa_number, contact_number, display_name,
        summary, intent, sentiment, confidence, suggested_stage, stage_reason,
        next_action, risk, objections, buying_signals, topics, open_questions,
        participants, modalities, last_message_id, last_message_at,
        analysed_message_count, transcript_truncated, last_run_id, last_run_at,
        last_status, last_error, run_count, model_used, suggestion_state, running_since, updated_at,
        problems, notes, recommendations, interested_products, follow_ups, context_hash, reply_review, missed,
        next_follow_up)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,NOW(),'ok',NULL,1,$26,'pending',NULL,NOW(),$27,$28,$29,$30,$31,$32,$33,$34,$35)
     ON CONFLICT (source, conversation_key) DO UPDATE SET
       lead_id = COALESCE(EXCLUDED.lead_id, coexistence.chat_analysis.lead_id),
       wa_number = COALESCE(EXCLUDED.wa_number, coexistence.chat_analysis.wa_number),
       contact_number = COALESCE(EXCLUDED.contact_number, coexistence.chat_analysis.contact_number),
       display_name = COALESCE(EXCLUDED.display_name, coexistence.chat_analysis.display_name),
       summary = EXCLUDED.summary, intent = EXCLUDED.intent, sentiment = EXCLUDED.sentiment,
       confidence = EXCLUDED.confidence, suggested_stage = EXCLUDED.suggested_stage,
       stage_reason = EXCLUDED.stage_reason, next_action = EXCLUDED.next_action,
       risk = EXCLUDED.risk, objections = EXCLUDED.objections,
       buying_signals = EXCLUDED.buying_signals, topics = EXCLUDED.topics,
       open_questions = EXCLUDED.open_questions, participants = EXCLUDED.participants,
       problems = EXCLUDED.problems, notes = EXCLUDED.notes, recommendations = EXCLUDED.recommendations,
       interested_products = EXCLUDED.interested_products, follow_ups = EXCLUDED.follow_ups,
       context_hash = EXCLUDED.context_hash,
       reply_review = EXCLUDED.reply_review, missed = EXCLUDED.missed,
       next_follow_up = EXCLUDED.next_follow_up,
       -- The union: a run that added audio must not erase the fact that text is
       -- also covered, or the badge would flip back and forth per run.
       modalities = (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(
                       coexistence.chat_analysis.modalities || EXCLUDED.modalities) v),
       last_message_id = GREATEST(COALESCE(coexistence.chat_analysis.last_message_id,0), COALESCE(EXCLUDED.last_message_id,0)),
       last_message_at = GREATEST(coexistence.chat_analysis.last_message_at, EXCLUDED.last_message_at),
       analysed_message_count = EXCLUDED.analysed_message_count,
       transcript_truncated = EXCLUDED.transcript_truncated,
       last_run_id = EXCLUDED.last_run_id, last_run_at = NOW(),
       last_status = 'ok', last_error = NULL,
       run_count = coexistence.chat_analysis.run_count + 1,
       model_used = EXCLUDED.model_used,
       -- A new verdict is a new suggestion: a stage applied or dismissed last
       -- time says nothing about the one just produced.
       suggestion_state = 'pending', running_since = NULL, updated_at = NOW()`,
    [source, conversationKey, convo.leadId, convo.waNumber, convo.contactNumber || null,
     convo.displayName, verdict.summary, verdict.intent, verdict.sentiment, verdict.confidence,
     verdict.suggested_stage, verdict.stage_reason, verdict.next_action, verdict.risk,
     JSON.stringify(verdict.objections), JSON.stringify(verdict.buying_signals),
     JSON.stringify(verdict.topics), JSON.stringify(verdict.open_questions),
     JSON.stringify(verdict.participants), JSON.stringify(modalities),
     lastMessageId, lastMessageAt, count, truncated, runId, modelId,
     JSON.stringify(verdict.problems || []), JSON.stringify(verdict.notes || []),
     JSON.stringify(verdict.recommendations || []),
     JSON.stringify(verdict.interested_products || []), JSON.stringify(verdict.follow_ups || []),
     contextHash || '', verdict.reply_review || null, JSON.stringify(verdict.missed || []),
     verdict.next_follow_up ? JSON.stringify(verdict.next_follow_up) : null]
  );
}

async function recordRun(r) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chat_analysis_runs
       (source, conversation_key, lead_id, batch_id, kind, trigger, actor, status, error,
        provider, model_id, credential_id, prompt_tokens, completion_tokens, total_tokens,
        elapsed_ms, messages_analysed, transcript_truncated, suggested_stage,
        parsed, raw_response, scope, is_scoped, is_incremental, modalities,
        new_messages, reused_artifacts, new_artifacts, llm_cost_micros,
        artifact_cost_micros, result, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW())
     RETURNING id`,
    [r.source, r.conversationKey, r.leadId || null, r.batchId || null, r.kind,
     r.trigger, r.actor, r.status, r.error || null, r.provider || null, r.modelId || null,
     r.credentialId || null, r.promptTokens || null, r.completionTokens || null,
     r.totalTokens || null, r.elapsedMs || null, r.messagesAnalysed || null,
     !!r.truncated, r.suggestedStage || null,
     r.parsed ? JSON.stringify(r.parsed) : null,
     r.raw ? String(r.raw).slice(0, RAW_RESPONSE_CAP) : null,
     r.scope ? JSON.stringify(r.scope) : null, !!r.scoped, !!r.incremental,
     JSON.stringify(r.modalities || []), r.newMessages ?? null,
     r.reused || 0, r.freshArtifacts || 0, r.llmCost || 0, r.artifactCost || 0,
     r.result ? JSON.stringify(r.result) : null]
  );
  return Number(rows[0].id);
}

// ── listing ───────────────────────────────────────────────────────────────────

/**
 * Conversations for the tab. Both sources in one list, because to a user
 * "conversations I can analyse" is one idea.
 *
 * `staleMessages` is computed from the LIVE message stream against the text
 * watermark, never from a cached flag — a flag would go stale exactly when it
 * matters (the moment a new message lands).
 */
async function listConversations({ source = 'all', filter = 'all', search = '', limit = 200, offset = 0, assignedUserId = null } = {}) {
  const conf = await loadConfig();
  const minMessages = conf?.min_messages || 4;
  const out = [];

  if (source === 'all' || source === 'chat') {
    const params = [minMessages];
    const where = [`conv.msg_count >= $1`];
    if (assignedUserId) { params.push(assignedUserId); where.push(`l.assigned_user_id = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(COALESCE(l.name, ct.name, ct.profile_name) ILIKE $${params.length} OR conv.key10 ILIKE $${params.length})`); }

    const { rows } = await pool.query(
      `WITH conv AS (
         SELECT ${KEY10('contact_number')} AS key10,
                MAX(id) AS max_msg_id, MAX(timestamp) AS last_msg_at,
                COUNT(*)::int AS msg_count,
                MIN(contact_number) AS contact_number,
                COUNT(*) FILTER (WHERE message_type IN ('audio','voice'))::int AS audio_count,
                COUNT(*) FILTER (WHERE message_type = 'image')::int AS image_count,
                COUNT(*) FILTER (WHERE message_type = 'document')::int AS doc_count
           FROM coexistence.chat_history
          WHERE message_type NOT IN ('status','reaction','revoke')
          GROUP BY 1
       )
       SELECT conv.*, a.summary, a.intent, a.sentiment, a.suggested_stage, a.next_action,
              a.risk, a.topics, a.modalities, a.last_run_at, a.last_status, a.run_count,
              a.suggestion_state, a.display_name,
              l.id AS lead_id, l.name AS lead_name, l.stage AS lead_stage,
              ct.name AS contact_name, ct.profile_name, ct.wa_number,
              cov.covered_through_seq AS text_seq
         FROM conv
         LEFT JOIN coexistence.chat_analysis a
                ON a.source = 'chat' AND a.conversation_key = conv.key10
         LEFT JOIN coexistence.chat_analysis_coverage cov
                ON cov.source = 'chat' AND cov.conversation_key = conv.key10 AND cov.modality = 'text'
         LEFT JOIN LATERAL (
                SELECT * FROM coexistence.contacts c
                 WHERE ${KEY10('c.contact_number')} = conv.key10
                 ORDER BY c.updated_at DESC NULLS LAST LIMIT 1) ct ON TRUE
         LEFT JOIN coexistence.leads l ON ${KEY10('l.whatsapp_number')} = conv.key10
        WHERE ${where.join(' AND ')}
        ORDER BY conv.last_msg_at DESC
        LIMIT ${Math.min(limit, 500)} OFFSET ${offset}`,
      params
    );
    for (const r of rows) {
      const analysed = !!r.last_run_at;
      const newSince = Math.max(0, Number(r.max_msg_id || 0) - Number(r.text_seq || 0));
      out.push({
        source: 'chat', conversationKey: r.key10,
        name: r.lead_name || r.display_name || r.contact_name || r.profile_name || r.contact_number,
        contactNumber: r.contact_number, waNumber: r.wa_number,
        leadId: r.lead_id ? Number(r.lead_id) : null, leadStage: r.lead_stage || null,
        messageCount: r.msg_count, lastMessageAt: r.last_msg_at,
        media: { audio: r.audio_count, image: r.image_count, document: r.doc_count },
        analysed, neverAnalysed: !analysed,
        // Only meaningful once something has been covered; on a never-analysed
        // conversation "N new" would just restate the message count.
        newMessages: analysed && r.text_seq ? newSince : 0,
        isStale: analysed && !!r.text_seq && newSince > 0,
        summary: r.summary, intent: r.intent, sentiment: r.sentiment,
        suggestedStage: r.suggested_stage, nextAction: r.next_action, risk: r.risk,
        topics: r.topics || [], modalities: r.modalities || [],
        lastRunAt: r.last_run_at, lastStatus: r.last_status, runCount: r.run_count || 0,
        suggestionState: r.suggestion_state || null,
      });
    }
  }

  // Deliberately NOT gated on evoPool: community_groups is our table, so the
  // groups exist whether or not Evolution answers. A run against one reports
  // the outage itself (see fetchGroupMessages).
  if (source === 'all' || source === 'community') {
    const { rows } = await pool.query(
      `SELECT g.group_jid, g.name, g.instance_name,
              a.summary, a.sentiment, a.topics, a.open_questions, a.participants,
              a.next_action, a.risk, a.modalities, a.last_run_at, a.last_status,
              a.run_count, a.display_name,
              cov.covered_through_epoch AS text_epoch
         FROM coexistence.community_groups g
         LEFT JOIN coexistence.chat_analysis a
                ON a.source = 'community' AND a.conversation_key = g.group_jid
         LEFT JOIN coexistence.chat_analysis_coverage cov
                ON cov.source = 'community' AND cov.conversation_key = g.group_jid AND cov.modality = 'text'
        WHERE g.active
        ORDER BY g.sort_order, g.name`
    );
    for (const r of rows) {
      if (search && !(r.name || '').toLowerCase().includes(search.toLowerCase())) continue;
      out.push({
        source: 'community', conversationKey: r.group_jid,
        analysable: !!evoPool,
        name: r.name || r.display_name || r.group_jid,
        contactNumber: null, waNumber: null, leadId: null, leadStage: null,
        messageCount: null, lastMessageAt: null,
        media: { audio: 0, image: 0, document: 0 },
        analysed: !!r.last_run_at, neverAnalysed: !r.last_run_at,
        newMessages: 0, isStale: false,
        summary: r.summary, intent: null, sentiment: r.sentiment,
        suggestedStage: null, nextAction: r.next_action, risk: r.risk,
        topics: r.topics || [], openQuestions: r.open_questions || [],
        participants: r.participants || [], modalities: r.modalities || [],
        lastRunAt: r.last_run_at, lastStatus: r.last_status, runCount: r.run_count || 0,
        suggestionState: null,
      });
    }
  }

  const filtered = out.filter(c => {
    if (filter === 'analysed') return c.analysed;
    if (filter === 'never') return c.neverAnalysed;
    if (filter === 'stale') return c.isStale;
    if (filter === 'errors') return c.lastStatus === 'error';
    return true;
  });
  return { conversations: filtered, total: filtered.length };
}

// ── cost dashboard ────────────────────────────────────────────────────────────

/**
 * What the analyser has cost.
 *
 * ⚠ EVERY FIGURE HERE IS AN ESTIMATE, and the UI must say so. OpenAI returns
 * token counts and nothing else — there is no endpoint that reports what a call
 * actually cost (unlike Meta's pricing_analytics, which the message-cost feature
 * reads a real rate from). So rupees are tokens × the admin-editable rate card,
 * and they drift the day OpenAI changes its prices.
 */
async function costSummary({ from = null, to = null } = {}) {
  const conf = await loadConfig();
  const usdToInr = Number(conf?.usd_to_inr || 88);
  const params = [];
  const where = [];
  if (from) { params.push(from); where.push(`started_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`started_at <= $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // ONE query for the headline numbers: separate COUNTs can disagree when a run
  // lands between them.
  const { rows: [totals] } = await pool.query(
    `SELECT COUNT(*)::int                                              AS runs,
            COUNT(*) FILTER (WHERE status = 'ok')::int                 AS ok_runs,
            COUNT(*) FILTER (WHERE status = 'error')::int              AS failed_runs,
            COUNT(*) FILTER (WHERE status = 'skipped')::int            AS skipped_runs,
            COUNT(*) FILTER (WHERE is_scoped)::int                     AS scoped_runs,
            COUNT(*) FILTER (WHERE is_incremental)::int                AS incremental_runs,
            COUNT(DISTINCT conversation_key)::int                      AS conversations,
            COALESCE(SUM(total_tokens),0)::bigint                      AS tokens,
            COALESCE(SUM(llm_cost_micros),0)::bigint                   AS llm_micros,
            COALESCE(SUM(artifact_cost_micros),0)::bigint              AS artifact_micros,
            COALESCE(SUM(reused_artifacts),0)::int                     AS reused,
            COALESCE(SUM(new_artifacts),0)::int                        AS fresh
       FROM coexistence.chat_analysis_runs ${clause}`,
    params
  );

  // Media spend comes from the ARTIFACT table, not the runs: an artifact is paid
  // for once and then reused by every later run, so attributing its cost to each
  // run that read it would multiply the same rupee.
  const aParams = [];
  const aWhere = [];
  if (from) { aParams.push(from); aWhere.push(`created_at >= $${aParams.length}`); }
  if (to) { aParams.push(to); aWhere.push(`created_at <= $${aParams.length}`); }
  const { rows: byKind } = await pool.query(
    `SELECT kind,
            COUNT(*)::int                                   AS items,
            COUNT(*) FILTER (WHERE status = 'ok')::int      AS ok_items,
            COUNT(*) FILTER (WHERE status = 'empty')::int   AS empty_items,
            COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed_items,
            COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_items,
            COALESCE(SUM(cost_micros),0)::bigint            AS micros,
            COALESCE(SUM(audio_seconds),0)::numeric         AS seconds
       FROM coexistence.chat_message_artifacts
       ${aWhere.length ? `WHERE ${aWhere.join(' AND ')}` : ''}
      GROUP BY kind`,
    aParams
  );

  const kindMap = { transcript: 'audio', vision: 'image', document: 'document' };
  const media = { audio: null, image: null, document: null };
  for (const r of byKind) {
    const label = kindMap[r.kind];
    if (!label) continue;
    media[label] = {
      items: r.items, ok: r.ok_items, empty: r.empty_items,
      failed: r.failed_items, skipped: r.skipped_items,
      micros: Number(r.micros),
      inr: extract.microsToInr(r.micros, usdToInr),
      audioSeconds: label === 'audio' ? Number(r.seconds || 0) : null,
    };
  }
  for (const k of Object.keys(media)) {
    if (!media[k]) media[k] = { items: 0, ok: 0, empty: 0, failed: 0, skipped: 0, micros: 0, inr: 0, audioSeconds: k === 'audio' ? 0 : null };
  }

  const { rows: daily } = await pool.query(
    `SELECT (started_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
            COUNT(*)::int AS runs,
            COALESCE(SUM(llm_cost_micros + artifact_cost_micros),0)::bigint AS micros
       FROM coexistence.chat_analysis_runs ${clause}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
    params
  );

  const { rows: byModel } = await pool.query(
    `SELECT model_id, COUNT(*)::int AS runs,
            COALESCE(SUM(total_tokens),0)::bigint AS tokens,
            COALESCE(SUM(llm_cost_micros),0)::bigint AS micros
       FROM coexistence.chat_analysis_runs ${clause}
      ${clause ? 'AND' : 'WHERE'} model_id IS NOT NULL
      GROUP BY 1 ORDER BY 4 DESC`,
    params
  );

  const llm = Number(totals.llm_micros);
  const art = Number(media.audio.micros) + Number(media.image.micros) + Number(media.document.micros);
  return {
    estimated: true,               // the UI must label every figure as such
    usdToInr,
    runs: {
      total: totals.runs, ok: totals.ok_runs, failed: totals.failed_runs,
      skipped: totals.skipped_runs, scoped: totals.scoped_runs,
      incremental: totals.incremental_runs, conversations: totals.conversations,
    },
    tokens: Number(totals.tokens),
    artifacts: { reused: totals.reused, fresh: totals.fresh },
    cost: {
      llmMicros: llm, llmInr: extract.microsToInr(llm, usdToInr),
      mediaMicros: art, mediaInr: extract.microsToInr(art, usdToInr),
      totalMicros: llm + art, totalInr: extract.microsToInr(llm + art, usdToInr),
    },
    byMediaType: media,
    byModel: byModel.map(r => ({
      model: r.model_id, runs: r.runs, tokens: Number(r.tokens),
      micros: Number(r.micros), inr: extract.microsToInr(r.micros, usdToInr),
    })),
    daily: daily.map(r => ({ day: r.day, runs: r.runs, micros: Number(r.micros), inr: extract.microsToInr(r.micros, usdToInr) })).reverse(),
  };
}

async function listRuns({ source = null, conversationKey = null, limit = 50, offset = 0 } = {}) {
  if (conversationKey) conversationKey = canonicalKey(source || 'chat', conversationKey);
  const params = [];
  const where = [];
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  if (conversationKey) { params.push(conversationKey); where.push(`conversation_key = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT id, source, conversation_key, kind, trigger, actor, status, error,
            model_id, total_tokens, elapsed_ms, messages_analysed, new_messages,
            is_scoped, is_incremental, modalities, scope, reused_artifacts,
            new_artifacts, llm_cost_micros, artifact_cost_micros, result, started_at
       FROM coexistence.chat_analysis_runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC LIMIT ${Math.min(limit, 200)} OFFSET ${offset}`,
    params
  );
  const conf = await loadConfig();
  return rows.map(r => ({
    id: Number(r.id), source: r.source, conversationKey: r.conversation_key,
    kind: r.kind, trigger: r.trigger, actor: r.actor, status: r.status, error: r.error,
    model: r.model_id, tokens: r.total_tokens, elapsedMs: r.elapsed_ms,
    messagesAnalysed: r.messages_analysed, newMessages: r.new_messages,
    scoped: r.is_scoped, incremental: r.is_incremental,
    modalities: r.modalities || [], scope: r.scope || null,
    reusedArtifacts: r.reused_artifacts, newArtifacts: r.new_artifacts,
    costInr: extract.microsToInr(Number(r.llm_cost_micros) + Number(r.artifact_cost_micros), conf?.usd_to_inr || 88),
    result: r.result || null, startedAt: r.started_at,
  }));
}

// ── bulk ──────────────────────────────────────────────────────────────────────

function batchStatus(batchId) { return _batches.get(batchId) || null; }

/**
 * Analyse many conversations. Deliberately NOT exposed to MCP — a bulk run
 * spends real money per conversation, so it stays a deliberate click behind the
 * cost estimate in the tab.
 */
async function runBulk({ targets, modalities = null, trigger = 'bulk', actor = 'system', incremental = true }) {
  const conf = await loadConfig();
  const cap = conf?.bulk_max || 100;
  const list = (targets || []).slice(0, cap);
  const batchId = crypto.randomUUID();
  const state = {
    batchId, total: list.length, done: 0, ok: 0, failed: 0, skipped: 0,
    costMicros: 0, startedAt: new Date().toISOString(), finishedAt: null, errors: [],
  };
  _batches.set(batchId, state);

  (async () => {
    let consecutiveFailures = 0;
    const queue = list.slice();
    const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length || 1) }, async () => {
      while (queue.length) {
        if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
          // Five failures in a row is a broken key or a dead model, not bad luck.
          // Stopping protects both the bill and the run log.
          state.errors.push('Stopped early after 5 consecutive failures');
          queue.length = 0;
          break;
        }
        const t = queue.shift();
        try {
          const r = await analyseConversation({
            source: t.source || 'chat', conversationKey: t.conversationKey,
            modalities, incremental, trigger, actor, batchId, conf,
          });
          if (r.skipped) state.skipped += 1; else state.ok += 1;
          state.costMicros += r.cost?.totalMicros || 0;
          consecutiveFailures = 0;
        } catch (err) {
          state.failed += 1;
          consecutiveFailures += 1;
          if (state.errors.length < 20) state.errors.push(`${t.conversationKey}: ${err.message}`);
        }
        state.done += 1;
        await new Promise(res => setTimeout(res, BATCH_GAP_MS));
      }
    });
    await Promise.all(workers);
    state.finishedAt = new Date().toISOString();
    // Keep the result readable for a while after it finishes, then let it go.
    setTimeout(() => _batches.delete(batchId), 10 * 60 * 1000).unref?.();
  })().catch(err => { state.errors.push(err.message); state.finishedAt = new Date().toISOString(); });

  return state;
}

/**
 * What a run would cost before anyone commits to it.
 *
 * Media is the expensive half and its price depends on how much is ALREADY
 * cached, so this counts real uncached items rather than guessing per message.
 */
async function estimateCost({ targets, modalities = null }) {
  const conf = await loadConfig();
  const mods = resolveModalities(conf, modalities);
  const usdToInr = Number(conf?.usd_to_inr || 88);
  let audio = 0, image = 0, doc = 0, cachedItems = 0;

  for (const t of (targets || [])) {
    if (t.source === 'community') continue;   // group media counts need Evolution
    const { rows } = await pool.query(
      `SELECT h.message_type, h.media_size_bytes,
              (SELECT 1 FROM coexistence.chat_message_artifacts a
                WHERE a.source='chat' AND a.message_key = h.message_id
                  AND a.status <> 'failed' LIMIT 1) AS cached
         FROM coexistence.chat_history h
        WHERE ${KEY10('h.contact_number')} = ${KEY10('$1')}
          AND h.message_type IN ('audio','voice','image','document')`,
      [t.conversationKey]
    );
    for (const r of rows) {
      if (r.cached) { cachedItems += 1; continue; }
      const m = modalityOf(r.message_type);
      if (!mods.includes(m)) continue;
      if (m === 'audio') audio += 1;
      else if (m === 'image') image += 1;
      else doc += 1;
    }
  }

  // A voice note here averages ~30s; that is an assumption and the UI says so.
  const ASSUMED_AUDIO_SECONDS = 30;
  const audioMicros = extract.audioCostMicros(conf.rate_card, conf.transcribe_model, audio * ASSUMED_AUDIO_SECONDS);
  // Vision: roughly one image ≈ 1.1k input tokens + a short answer.
  const imageMicros = extract.tokenCostMicros(conf.rate_card, 'vision', conf.vision_model, image * 1100, image * 90);
  // The analysis call itself: roughly 3k in / 400 out per conversation.
  const n = (targets || []).length;
  const { modelId } = await resolveModel(conf);
  const llmMicros = extract.tokenCostMicros(conf.rate_card, 'text', modelId, n * 3000, n * 400);
  const total = audioMicros + imageMicros + llmMicros;

  return {
    estimated: true, conversations: n, modalities: mods,
    uncached: { audio, image, document: doc }, cachedItems,
    assumedAudioSeconds: ASSUMED_AUDIO_SECONDS,
    micros: { audio: audioMicros, image: imageMicros, llm: llmMicros, total },
    inr: {
      audio: extract.microsToInr(audioMicros, usdToInr),
      image: extract.microsToInr(imageMicros, usdToInr),
      llm: extract.microsToInr(llmMicros, usdToInr),
      total: extract.microsToInr(total, usdToInr),
    },
  };
}

module.exports = {
  ensureChatAnalyserTables,
  listConversations, costSummary, listRuns, runBulk, batchStatus, estimateCost,
  buildFullTranscript, transcriptToText, transcribeEstimate, transcribeConversation,
  getConversationImages, IMAGE_MAX_PER_CALL,
  filterToNewMessages,
  analyseConversation, resolveConversation, loadAnalysis, recordRun,
  persistVerdict, priorSummaryText, isScopedRequest,
  loadConfig, invalidateConfigCache, resolveModalities, resolveModel, canonicalKey, unreadSince,
  loadCoverage, advanceCoverage,
  fetchChatMessages, fetchGroupMessages,
  renderTranscript, foldTranscript, annotateCached, cleanNextFollowUp, istToday, conversationFacts, timingText, durationText,
  buildSystemPrompt, coerceVerdict, cleanList,
  istStamp, modalityOf,
  KEY10, MODALITIES, TYPE_PLACEHOLDER, CLAIM_TIMEOUT, RAW_RESPONSE_CAP,
  BATCH_CONCURRENCY, BATCH_GAP_MS, ABORT_AFTER_CONSECUTIVE_FAILURES,
  _batches,
};
