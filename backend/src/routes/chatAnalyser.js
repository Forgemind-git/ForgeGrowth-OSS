// Chat Analyzer HTTP surface. Mounted under /api with authMiddleware.
// Page key: 'chat-analyzer'.
//
// Deliberately thin: validation, RBAC and response shaping only. Everything that
// thinks lives in services/chatAnalyser.js.
//
// ⚠ APPLYING A SUGGESTED STAGE DOES NOT HAPPEN HERE. The frontend calls the
// existing PUT /leads/:id/move, which already owns stage validation, lead-level
// RBAC, the lead_events audit row that five dispatchers read, and the
// lead-changed SSE emit. A second write path is how audit trails drift — this
// router only records that a suggestion was acted on.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly, requirePermission, assertContactAccess } = require('../middleware/access');
const voiceNotes = require('../services/voiceNotes');
const analyserContext = require('../services/analyserContext');
const { isOpenAiCompatible } = require('../llm/chatCompletion');
const svc = require('../services/chatAnalyser');

const router = Router();
const PAGE = 'chat-analyzer';

function isAdmin(req) { return req.user?.role === 'admin'; }
function meId(req) { return parseInt(req.user?.id, 10); }
function actorOf(req) { return req.user?.displayName || req.user?.username || 'system'; }

function sendErr(res, err, fallback = 'The Chat Analyzer request failed') {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error('[chat-analyzer]', err.message);
  res.status(status).json({ error: err?.message || fallback });
}

/**
 * Can this user reach this conversation?
 *
 * Admins: everything. Everyone else: only conversations whose lead is assigned
 * to them. A GROUP has no lead and therefore no per-user owner, so groups are
 * admin-only rather than silently visible to all — a group carries other
 * customers' messages.
 */
async function canAccess(req, source, conversationKey) {
  if (isAdmin(req)) return true;
  if (source === 'community') return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.leads
      WHERE right(regexp_replace(whatsapp_number,'\\D','','g'),10) = right(regexp_replace($1,'\\D','','g'),10)
        AND assigned_user_id = $2`,
    [conversationKey, meId(req)]
  );
  return rows.length > 0;
}

// A bare calendar date, as every date input in this app sends.
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// IST, because that is the day the person picking the date is living in.
const IST_OFFSET = '+05:30';

/**
 * {from,to,keyword} from a request, or null when nothing was asked for.
 *
 * ⚠ A DATE RANGE IS INCLUSIVE OF BOTH ENDS, AND A BARE DATE IS AN IST DAY.
 * `new Date('2026-07-17')` is UTC midnight, so using it as an upper bound
 * excludes the whole of the day the user just asked to include, and as a lower
 * bound it starts 5.5 hours late for an IST user. Both read as "the filter
 * found fewer messages", never as an error. So a bare date is expanded here:
 * `from` to 00:00:00 IST and `to` to 23:59:59.999 IST of that day. A full
 * timestamp is honoured exactly as given.
 */
function readScope(src = {}) {
  const parse = (v, endOfDay) => {
    if (!v) return null;
    const s = String(v).trim();
    const d = BARE_DATE.test(s)
      ? new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${IST_OFFSET}`)
      : new Date(s);
    return d;
  };
  const from = parse(src.from, false);
  const to = parse(src.to, true);
  if (from && Number.isNaN(from.getTime())) throw Object.assign(new Error('That "from" date is not a real date'), { status: 400 });
  if (to && Number.isNaN(to.getTime())) throw Object.assign(new Error('That "to" date is not a real date'), { status: 400 });
  if (from && to && from > to) throw Object.assign(new Error('The "from" date is after the "to" date'), { status: 400 });
  const keyword = typeof src.keyword === 'string' ? src.keyword.trim() : '';
  if (!from && !to && !keyword) return null;
  return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null, keyword: keyword || null };
}

function readModalities(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const clean = arr.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  return clean.length ? clean : null;
}

// ── list ──────────────────────────────────────────────────────────────────────

router.get('/chat-analysis', requirePermission(PAGE), async (req, res) => {
  try {
    const { source = 'all', filter = 'all', search = '' } = req.query;
    const data = await svc.listConversations({
      source, filter, search,
      limit: Math.min(parseInt(req.query.limit, 10) || 200, 500),
      offset: parseInt(req.query.offset, 10) || 0,
      // Non-admins are scoped to their own leads, and never see groups.
      assignedUserId: isAdmin(req) ? null : meId(req),
    });
    if (!isAdmin(req)) data.conversations = data.conversations.filter(c => c.source !== 'community');
    res.json(data);
  } catch (err) { sendErr(res, err); }
});

// ── one conversation ──────────────────────────────────────────────────────────

router.get('/chat-analysis/conversation', requirePermission(PAGE), async (req, res) => {
  try {
    const source = req.query.source === 'community' ? 'community' : 'chat';
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Which conversation? A key is required.' });
    if (!(await canAccess(req, source, key))) {
      return res.status(403).json({ error: 'You can only open conversations assigned to you' });
    }
    const convo = await svc.resolveConversation(source, key);
    if (!convo) return res.status(404).json({ error: 'That conversation could not be found' });

    const [analysis, coverage, runs] = await Promise.all([
      svc.loadAnalysis(source, key),
      svc.loadCoverage(source, key),
      svc.listRuns({ source, conversationKey: key, limit: 25 }),
    ]);
    const ctx = await analyserContext.currentBlock();
    const unread = await svc.unreadSince(source, key).catch(() => null);

    res.json({
      conversation: convo,
      analysis: analysis ? {
        ...shapeAnalysis(analysis),
        // Made with different business context than today's → re-run to use it.
        contextStale: (analysis.context_hash || '') !== ctx.hash,
      } : null,
      hasBusinessContext: !!ctx.text,
      unread,
      // Per modality, so the UI can say "text is up to date, voice notes have
      // never been read" instead of one misleading "analysed" badge.
      coverage,
      runs,
    });
  } catch (err) { sendErr(res, err); }
});

function shapeAnalysis(a) {
  return {
    source: a.source, conversationKey: a.conversation_key,
    leadId: a.lead_id ? Number(a.lead_id) : null,
    displayName: a.display_name, summary: a.summary,
    intent: a.intent, sentiment: a.sentiment,
    confidence: a.confidence == null ? null : Number(a.confidence),
    suggestedStage: a.suggested_stage, stageReason: a.stage_reason,
    nextAction: a.next_action, risk: a.risk,
    objections: a.objections || [], buyingSignals: a.buying_signals || [],
    problems: a.problems || [], notes: a.notes || [], recommendations: a.recommendations || [],
    interestedProducts: a.interested_products || [], followUps: a.follow_ups || [],
    replyReview: a.reply_review || null, missed: a.missed || [],
    nextFollowUp: a.next_follow_up || null,
    topics: a.topics || [], openQuestions: a.open_questions || [],
    participants: a.participants || [], modalities: a.modalities || [],
    analysedMessageCount: a.analysed_message_count || 0,
    transcriptTruncated: !!a.transcript_truncated,
    lastRunAt: a.last_run_at, lastStatus: a.last_status, lastError: a.last_error,
    runCount: a.run_count || 0, modelUsed: a.model_used,
    suggestionState: a.suggestion_state, appliedAt: a.applied_at, dismissedAt: a.dismissed_at,
  };
}

// ── transcript ────────────────────────────────────────────────────────────────
//
// What was said, as opposed to what it meant. Derived on read from the messages
// plus the permanent audio-transcript cache, and never folded — an analysis
// transcript is trimmed to fit a model's context, which would silently drop the
// middle of a conversation here.

router.get('/chat-analysis/transcript', requirePermission(PAGE), async (req, res) => {
  try {
    const source = req.query.source === 'community' ? 'community' : 'chat';
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Which conversation? A key is required.' });
    if (!(await canAccess(req, source, key))) {
      return res.status(403).json({ error: 'You can only open conversations assigned to you' });
    }
    const t = await svc.buildFullTranscript({ source, conversationKey: key, scope: readScope(req.query) });
    res.json({
      ...t,
      // The plain-text rendering, so a caller that just wants to read or paste
      // it does not have to reimplement the formatting.
      text: svc.transcriptToText(t),
      estimate: await svc.transcribeEstimate({ source, conversationKey: key, scope: readScope(req.query) }),
    });
  } catch (err) { sendErr(res, err, 'Could not build that transcript'); }
});

// Transcribing is READING, not analysing: it fills the permanent cache but
// deliberately leaves the coverage watermark and the standing summary alone.
router.post('/chat-analysis/transcribe', requirePermission(PAGE), async (req, res) => {
  try {
    const b = req.body || {};
    const source = b.source === 'community' ? 'community' : 'chat';
    const key = String(b.conversationKey || b.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Which conversation? A key is required.' });
    if (!(await canAccess(req, source, key))) {
      return res.status(403).json({ error: 'You can only transcribe conversations assigned to you' });
    }
    res.json(await svc.transcribeConversation({
      source, conversationKey: key, scope: readScope(b), actor: actorOf(req),
    }));
  } catch (err) { sendErr(res, err, 'Could not transcribe those voice notes'); }
});

// ── run one ───────────────────────────────────────────────────────────────────

// ── Business context: what we sell, so recommendations are specific ─────────
//
// Read: anyone with the page (a rep should see what the analyser is told).
// Write: admins only — it changes every future analysis for everyone.

router.get('/chat-analysis/context', requirePermission(PAGE), async (req, res) => {
  try {
    const ctx = await analyserContext.loadContext();
    const block = analyserContext.buildBlock(ctx);
    const { rows: catalog } = await pool.query(
      `SELECT id, name, default_price_paise, active FROM coexistence.courses ORDER BY id`);
    res.json({
      ...ctx,
      preview: { chars: block.text.length, cap: analyserContext.CONTEXT_CHAR_CAP, truncated: block.truncated, estTokens: Math.ceil(block.text.length / 4) },
      catalog: catalog.map(c => ({ id: Number(c.id), name: c.name, active: c.active,
        imported: ctx.products.some(p => p.courseId === Number(c.id)) })),
    });
  } catch (err) { sendErr(res, err, 'Could not load the business context'); }
});

router.put('/chat-analysis/context', requirePermission(PAGE), adminOnly, async (req, res) => {
  try {
    await analyserContext.setBusiness((req.body || {}).business, actorOf(req));
    res.json({ ok: true });
  } catch (err) { sendErr(res, err, 'Could not save the business context'); }
});

router.post('/chat-analysis/context/products', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { res.status(201).json({ id: await analyserContext.addProduct(req.body || {}, actorOf(req)) }); }
  catch (err) { sendErr(res, err, 'Could not add the product'); }
});

router.post('/chat-analysis/context/import-products', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { res.json({ imported: await analyserContext.importFromProducts(actorOf(req)) }); }
  catch (err) { sendErr(res, err, 'Could not import products'); }
});

router.put('/chat-analysis/context/products/:id', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { await analyserContext.updateProduct(parseInt(req.params.id, 10), req.body || {}, actorOf(req)); res.json({ ok: true }); }
  catch (err) { sendErr(res, err, 'Could not save the product'); }
});

router.delete('/chat-analysis/context/products/:id', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { await analyserContext.deleteProduct(parseInt(req.params.id, 10), actorOf(req)); res.json({ ok: true }); }
  catch (err) { sendErr(res, err, 'Could not delete the product'); }
});

// ── One voice note, from the Chats window ────────────────────────────────────
//
// ⚠ Gated by CONVERSATION access, not the chat-analyzer page: anyone who can
// open the chat can read or transcribe its voice notes (a BDA sees only their
// assigned contacts, exactly as in Chats). The page permission guards the
// analyser's bulk tools, not a single bubble.
async function noteAccess(req, res) {
  const { rows } = await pool.query(
    `SELECT wa_number, contact_number FROM coexistence.chat_history WHERE message_id = $1`,
    [req.params.messageId]
  );
  if (!rows[0]) { res.status(404).json({ error: 'That message no longer exists' }); return false; }
  return assertContactAccess(req, res, rows[0].wa_number, rows[0].contact_number);
}

router.get('/chat-analysis/voice-notes/:messageId', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.voiceNoteInfo(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not read that voice note'); }
});

router.post('/chat-analysis/voice-notes/:messageId/transcribe', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.transcribeVoiceNote(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not transcribe that voice note'); }
});

// Replace an older model's (Whisper) transcript with the current model's.
router.post('/chat-analysis/voice-notes/:messageId/retranscribe', async (req, res) => {
  try {
    if (!(await noteAccess(req, res))) return;
    res.json(await voiceNotes.retranscribeVoiceNote(req.params.messageId));
  } catch (err) { sendErr(res, err, 'Could not re-transcribe that voice note'); }
});

// Admin: every older transcript at once — summary, then batches.
router.get('/chat-analysis/retranscribe-legacy', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { res.json(await voiceNotes.legacySummary()); }
  catch (err) { sendErr(res, err, 'Could not count older transcripts'); }
});
router.post('/chat-analysis/retranscribe-legacy', requirePermission(PAGE), adminOnly, async (req, res) => {
  try { res.json(await voiceNotes.retranscribeLegacyBatch()); }
  catch (err) { sendErr(res, err, 'Could not re-transcribe the older notes'); }
});

router.post('/chat-analysis/run', requirePermission(PAGE), async (req, res) => {
  try {
    const b = req.body || {};
    const source = b.source === 'community' ? 'community' : 'chat';
    const key = String(b.conversationKey || b.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Which conversation? A key is required.' });
    if (!(await canAccess(req, source, key))) {
      return res.status(403).json({ error: 'You can only analyse conversations assigned to you' });
    }
    const out = await svc.analyseConversation({
      source, conversationKey: key,
      modalities: readModalities(b.modalities),
      scope: readScope(b),
      // Default true, but an explicit false means "read the whole thing again".
      incremental: b.incremental !== false,
      trigger: 'manual', actor: actorOf(req),
    });
    res.json(out);
  } catch (err) { sendErr(res, err, 'Could not analyse that conversation'); }
});

// ── cost estimate, before spending anything ───────────────────────────────────

router.post('/chat-analysis/estimate', requirePermission(PAGE), async (req, res) => {
  try {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    if (!targets.length) return res.status(400).json({ error: 'Nothing selected to estimate' });
    res.json(await svc.estimateCost({ targets, modalities: readModalities(req.body?.modalities) }));
  } catch (err) { sendErr(res, err); }
});

// ── bulk ──────────────────────────────────────────────────────────────────────
//
// ⚠ NOT reachable over MCP, deliberately. A bulk run spends real money per
// conversation and nobody is watching when a chat message triggers it.

router.post('/chat-analysis/run-bulk', requirePermission(PAGE), async (req, res) => {
  try {
    const b = req.body || {};
    let targets = Array.isArray(b.targets) ? b.targets : [];
    if (!targets.length) return res.status(400).json({ error: 'Nothing selected to analyse' });

    // Re-check every target rather than trusting the list the browser sent.
    if (!isAdmin(req)) {
      const allowed = [];
      for (const t of targets) {
        if (await canAccess(req, t.source || 'chat', t.conversationKey)) allowed.push(t);
      }
      if (!allowed.length) return res.status(403).json({ error: 'None of those conversations are assigned to you' });
      targets = allowed;
    }
    const conf = await svc.loadConfig();
    if (targets.length > (conf?.bulk_max || 100)) {
      return res.status(400).json({ error: `That is more than the ${conf.bulk_max} conversations allowed in one run. Raise the limit in settings, or select fewer.` });
    }
    const state = await svc.runBulk({
      targets, modalities: readModalities(b.modalities),
      incremental: b.incremental !== false, trigger: 'bulk', actor: actorOf(req),
    });
    res.json(state);
  } catch (err) { sendErr(res, err); }
});

router.get('/chat-analysis/batches/:batchId', requirePermission(PAGE), (req, res) => {
  const s = svc.batchStatus(req.params.batchId);
  if (!s) return res.status(404).json({ error: 'That batch has finished and its progress is no longer held' });
  res.json(s);
});

// ── runs + cost dashboard ─────────────────────────────────────────────────────

router.get('/chat-analysis/runs', requirePermission(PAGE), async (req, res) => {
  try {
    res.json({
      runs: await svc.listRuns({
        source: req.query.source || null,
        conversationKey: req.query.key || null,
        limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
        offset: parseInt(req.query.offset, 10) || 0,
      }),
    });
  } catch (err) { sendErr(res, err); }
});

router.get('/chat-analysis/summary', requirePermission(PAGE), async (req, res) => {
  try {
    res.json(await svc.costSummary({ from: req.query.from || null, to: req.query.to || null }));
  } catch (err) { sendErr(res, err); }
});

// ── suggestion bookkeeping ────────────────────────────────────────────────────
//
// The stage move itself already happened via PUT /leads/:id/move. This only
// records that the suggestion was acted on, so it stops being offered.

router.post('/chat-analysis/applied', requirePermission(PAGE), async (req, res) => {
  try {
    const { source = 'chat', stage } = req.body || {};
    const conversationKey = svc.canonicalKey(source, (req.body || {}).conversationKey);
    if (!conversationKey) return res.status(400).json({ error: 'Which conversation?' });
    if (!(await canAccess(req, source, conversationKey))) return res.status(403).json({ error: 'Not your conversation' });
    await pool.query(
      `UPDATE coexistence.chat_analysis
          SET suggestion_state = 'applied', applied_stage = $3, applied_at = NOW(),
              applied_by = $4, updated_at = NOW()
        WHERE source = $1 AND conversation_key = $2`,
      [source, conversationKey, stage || null, actorOf(req)]
    );
    res.json({ ok: true });
  } catch (err) { sendErr(res, err); }
});

router.post('/chat-analysis/dismiss', requirePermission(PAGE), async (req, res) => {
  try {
    const { source = 'chat' } = req.body || {};
    const conversationKey = svc.canonicalKey(source, (req.body || {}).conversationKey);
    if (!conversationKey) return res.status(400).json({ error: 'Which conversation?' });
    if (!(await canAccess(req, source, conversationKey))) return res.status(403).json({ error: 'Not your conversation' });
    await pool.query(
      `UPDATE coexistence.chat_analysis
          SET suggestion_state = 'dismissed', dismissed_at = NOW(), dismissed_by = $3, updated_at = NOW()
        WHERE source = $1 AND conversation_key = $2`,
      [source, conversationKey, actorOf(req)]
    );
    res.json({ ok: true });
  } catch (err) { sendErr(res, err); }
});

// ── settings (in the tab, not Admin Settings) ─────────────────────────────────

const NUMERIC_SETTINGS = {
  min_messages: [1, 100], transcript_message_cap: [10, 400], transcript_char_cap: [2000, 60000],
  max_media_per_run: [0, 500], max_audio_seconds: [5, 3600], max_document_chars: [200, 100000],
  bulk_max: [1, 500], nightly_hour_ist: [0, 23], nightly_max_conversations: [1, 2000],
};
const BOOL_SETTINGS = ['enabled', 'analyse_text', 'analyse_images', 'analyse_audio', 'analyse_documents', 'nightly_enabled'];

router.get('/chat-analysis/config', requirePermission(PAGE), adminOnly, async (req, res) => {
  try {
    const conf = await svc.loadConfig({ fresh: true });
    const { rows } = await pool.query(
      `SELECT id, provider, label, base_url, enabled_models FROM coexistence.ai_models ORDER BY id`
    );
    res.json({
      config: conf,
      models: rows.map(r => ({
        credentialId: r.id, provider: r.provider, label: r.label,
        models: r.enabled_models || [],
        // An Anthropic or Gemini key would 404 on every run: runChatCompletion
        // speaks the OpenAI wire format. Named as incompatible rather than
        // silently omitted, so its absence is not a mystery.
        compatible: isOpenAiCompatible(r),
      })),
    });
  } catch (err) { sendErr(res, err); }
});

router.put('/chat-analysis/config', requirePermission(PAGE), adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [];

    for (const k of BOOL_SETTINGS) {
      if (b[k] === undefined) continue;
      // Strict boolean: the string "false" is truthy, and this switch can start
      // a paid nightly batch.
      if (typeof b[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false` });
      params.push(b[k]); sets.push(`${k} = $${params.length}`);
    }
    for (const [k, [lo, hi]] of Object.entries(NUMERIC_SETTINGS)) {
      if (b[k] === undefined) continue;
      const n = parseInt(b[k], 10);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        return res.status(400).json({ error: `${k.replace(/_/g, ' ')} must be a number between ${lo} and ${hi}` });
      }
      params.push(n); sets.push(`${k} = $${params.length}`);
    }
    // transcribe_model is NOT settable: transcription runs on OpenRouter's
    // microsoft/mai-transcribe-2 only (services/transcription.js), and an
    // OpenAI model id typed here would fail on every voice note.
    for (const k of ['vision_model', 'model_id']) {
      if (b[k] === undefined) continue;
      params.push(b[k] ? String(b[k]).slice(0, 120) : null); sets.push(`${k} = $${params.length}`);
    }
    if (b.credential_id !== undefined) {
      params.push(b.credential_id == null ? null : parseInt(b.credential_id, 10));
      sets.push(`credential_id = $${params.length}`);
    }
    if (b.usd_to_inr !== undefined) {
      const n = Number(b.usd_to_inr);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) return res.status(400).json({ error: 'The USD to INR rate must be a positive number' });
      params.push(n); sets.push(`usd_to_inr = $${params.length}`);
    }
    if (b.rate_card !== undefined) {
      // An ARRAY passes a typeof check and Postgres coerces the whole column to
      // a jsonb array with no error, after which every rate read is null.
      if (!b.rate_card || typeof b.rate_card !== 'object' || Array.isArray(b.rate_card)) {
        return res.status(400).json({ error: 'The rate card must be an object' });
      }
      params.push(JSON.stringify(b.rate_card)); sets.push(`rate_card = $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to save' });

    await pool.query(
      `UPDATE coexistence.chat_analyser_config SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`,
      params
    );
    svc.invalidateConfigCache();
    res.json({ config: await svc.loadConfig({ fresh: true }) });
  } catch (err) { sendErr(res, err); }
});

// readScope is exported for its own tests: the inclusive-date rule is the kind
// that fails silently (a filter simply finds fewer rows), so it is asserted.
module.exports = { router, readScope };
