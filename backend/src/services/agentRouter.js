// Agent router. Called from the webhook after evaluateTriggers() returns.
// Decides whether to hand an inbound message to the active agent for that
// WhatsApp account.
//
// Precedence (handled by the caller):
//   1. Paused automation execution awaiting a reply → resume that, skip agent.
//   2. Keyword automation fires on this message → run it, skip agent.
//   3. Otherwise → this router enqueues the agent run (if any agent is active
//      for the inbound WA number).
//
// Test numbers are the one exception to "active": an agent lists numbers that
// may exercise it while it is still a draft, and those runs are exempt from
// every usage limit and stamped is_test so they never read as, or count
// against, customer traffic. Triggers and funnel gating still apply to them —
// those are what you are testing.

const pool = require('../db');
const { enqueueAgentRun } = require('../queue/agentQueue');

// Keyword matcher — mirrors automationEngine's matchesKeyword so the agent's
// keyword trigger behaves identically to a keyword automation's.
function normalizeText(t) { return (t || '').toLowerCase().trim(); }
function matchesKeyword(messageBody, keyword, matchType, caseSensitive) {
  if (!messageBody || !keyword) return false;
  const msg = caseSensitive ? String(messageBody).trim() : normalizeText(messageBody);
  const kw = caseSensitive ? String(keyword).trim() : normalizeText(keyword);
  if (!kw) return false;
  switch (matchType) {
    case 'contains': return msg.includes(kw);
    case 'starts': return msg.startsWith(kw);
    case 'exact':
    default: return msg === kw;
  }
}

/**
 * Does this contact sit where the agent is allowed to engage?
 *
 * Two independent filters, OR'd with each other (either one qualifying is
 * enough) but AND'ed with the message trigger. Both empty = no gate at all,
 * which is what every agent predating this has, so nothing changes for them.
 *
 * ⚠ Stage is matched on `leads.stage`, the immutable stage_key — never a label.
 * ⚠ A contact with NO lead row fails a stage gate. That is deliberate: a stage
 *   gate is a statement about where someone is in the funnel, and "not in the
 *   funnel at all" is not one of the chosen stages. The webhook creates a lead
 *   for every inbound customer before this runs, so in practice the only rows
 *   without one are the ForgeTask hub number and pre-funnel history.
 *
 * Never throws: a database hiccup here must not silence a working agent, so a
 * failure logs and falls through to "allowed" — the same fail-open reasoning
 * used for an unmeasurable voice note.
 */
async function passesFunnelGate(agent, record) {
  const stageKeys = Array.isArray(agent.trigger_stage_keys) ? agent.trigger_stage_keys.filter(Boolean) : [];
  const tagIds = Array.isArray(agent.trigger_tag_ids) ? agent.trigger_tag_ids.filter(Boolean) : [];
  if (stageKeys.length === 0 && tagIds.length === 0) return true;

  try {
    if (stageKeys.length > 0) {
      // Last-10-digit match: the same person is stored as 9876543210 here and
      // 919876543210 there, exactly as every other leads↔contacts join in this
      // codebase has had to handle.
      const { rows } = await pool.query(
        `SELECT 1 FROM coexistence.leads
          WHERE RIGHT(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10)
              = RIGHT(regexp_replace($1::text, '\\D', '', 'g'), 10)
            AND stage = ANY($2::text[])
          LIMIT 1`,
        [record.contact_number, stageKeys],
      );
      if (rows.length > 0) return true;
    }

    if (tagIds.length > 0) {
      // contacts.tags is a denormalised JSONB array of {id,name,color,…}.
      const { rows } = await pool.query(
        `SELECT 1
           FROM coexistence.contacts c,
                LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(c.tags) = 'array' THEN c.tags ELSE '[]'::jsonb END
                ) AS t
          WHERE c.wa_number = $1 AND c.contact_number = $2
            AND t->>'id' = ANY($3::text[])
          LIMIT 1`,
        [record.wa_number || '', record.contact_number, tagIds],
      );
      if (rows.length > 0) return true;
    }
    return false;
  } catch (err) {
    console.error('[agentRouter] funnel gate failed, allowing through:', err.message);
    return true;
  }
}

/**
 * Look up the active agent (if any) for the WhatsApp account that received
 * `record`, and enqueue a run. Returns the run job's metadata or null.
 *
 * - Matches the WA account by its display_phone_number (digits-only) against
 *   the inbound record's wa_number; falls back to phone_number_id.
 * - The DB enforces at most one active agent per WA account (partial unique
 *   index on agents(wa_account_id) WHERE is_active=TRUE), so this query is
 *   guaranteed to return ≤1 row.
 */
async function routeIfActive(record) {
  if (!record || record.direction !== 'incoming') return null;
  if (record.message_type === 'status' || record.message_type === 'reaction') return null;
  if (!record.contact_number) return null;

  const isAudio = (record.message_type === 'audio' || record.message_type === 'voice') && !!record.media_url;
  const isImage = record.message_type === 'image' && !!record.media_url;
  // Audio/voice inbounds carry a placeholder body ("Audio message" / "Voice
  // message") set by the webhook — never a real caption (WhatsApp audio has no
  // caption field). Treat them as text-less so the transcribe_audio gate below
  // is actually honoured and the worker transcribes the audio instead of
  // running the agent on the literal placeholder string. Images CAN carry a
  // real caption (message_body), so an image's caption still counts as text.
  const hasText = !isAudio && !!(record.message_body && record.message_body.trim());
  if (!hasText && !isAudio && !isImage) return null; // text, voice note, or image

  // One query answers both "is there an agent for this number?" and "is this
  // contact one of its test numbers?" — deliberately, so the last-10-digit
  // match exists in exactly ONE place. A second copy in JS would be free to
  // drift, and a drifted phone match fails silently: the agent simply does not
  // answer, which is indistinguishable from it not being configured.
  //
  // A DRAFT agent is reachable ONLY by a test number. That is what makes a test
  // number worth having: you can exercise the whole path on real WhatsApp
  // before the agent answers a single customer. The ORDER BY puts the
  // test-number match first so an agent under test wins over one that is
  // already live on the same WhatsApp account — otherwise the thing you are
  // testing could never get the message.
  const { rows } = await pool.query(
    `SELECT a.id, a.wa_account_id, a.trigger_mode, a.trigger_keyword,
            a.trigger_match_type, a.trigger_case_sensitive, a.trigger_session_minutes,
            a.transcribe_audio, a.accept_images,
            a.trigger_stage_keys, a.trigger_tag_ids,
            a.max_replies_per_conversation, a.max_replies_per_minute,
            a.max_runs_per_day, a.limit_reached_message, a.limit_handoff,
            a.quota_replies, a.quota_conversations,
            a.quota_window_value, a.quota_window_unit, a.quota_handoff,
            (t.is_test IS TRUE) AS is_test_contact
       FROM coexistence.agents a
       JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
       LEFT JOIN LATERAL (
         SELECT TRUE AS is_test
           FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(a.test_numbers) = 'array'
                       THEN a.test_numbers ELSE '[]'::jsonb END
                ) AS tn
          WHERE length(regexp_replace(COALESCE(tn->>'number', tn#>>'{}', ''), '\\D', '', 'g')) >= 7
            AND RIGHT(regexp_replace(COALESCE(tn->>'number', tn#>>'{}', ''), '\\D', '', 'g'), 10)
              = RIGHT(regexp_replace($3::text, '\\D', '', 'g'), 10)
          LIMIT 1
       ) t ON TRUE
      WHERE (regexp_replace(w.display_phone_number, '\\D', '', 'g') = $1
             OR w.phone_number_id = $2)
        AND (a.is_active = TRUE OR t.is_test)
      ORDER BY (t.is_test IS TRUE) DESC, a.is_active DESC, a.id DESC
      LIMIT 1`,
    [record.wa_number || '', record.phone_number_id || '', record.contact_number],
  );
  if (rows.length === 0) return null;

  const agent = rows[0];
  const isTest = agent.is_test_contact === true;

  // Human handoff: if this conversation has been handed to a human, the bot
  // stays silent until someone clicks "Return to bot".
  //
  // ⚠ ONE exception, and it is narrow: a TEST number whose chat was paused by
  // the LIMIT engine itself. A test number is exempt from every usage cap, so a
  // pause those caps caused must not outlive that exemption — otherwise the
  // first cap you trip while testing kills the agent for that number
  // permanently, and the only cure is buried in Chats. Going forward this
  // cannot happen at all (limits are skipped for a test number), so this is the
  // cure for a chat already stuck in that state.
  //
  // A pause a PERSON performed ('manual:<id>') still stands, test number or
  // not: the bot must never talk over a colleague handling the conversation.
  const { getPauseState, resumeAgent } = require('./agentHandoff');
  const pause = await getPauseState(record.wa_number, record.contact_number);
  if (pause.paused) {
    if (!(isTest && pause.byLimit)) {
      return { agentId: agent.id, skipped: 'paused_for_human', pausedBy: pause.by };
    }
    await resumeAgent({
      waNumber: record.wa_number,
      contactNumber: record.contact_number,
      by: `test-number:${agent.id}`,
    });
    console.log(`[agentRouter] agent ${agent.id}: cleared a limit pause for test number ${record.contact_number}`);
  }

  // A voice note only runs when the agent has transcription enabled (the worker
  // turns it into text via Whisper). Otherwise the agent stays text-only.
  if (isAudio && !hasText && !agent.transcribe_audio) return null;

  // A caption-less image only runs when the agent accepts images (the worker
  // sends the picture to the vision model). An image WITH a caption can still
  // run text-only even when accept_images is off.
  if (isImage && !hasText && !agent.accept_images) return null;

  // Trigger gating.
  //  'any'     = run on every inbound.
  //  'keyword' = engage on a keyword match, then keep replying for the session.
  //  'new'     = engage only a BRAND-NEW conversation (the contact's first
  //              inbound — a new lead), then keep replying for the session. The
  //              agent never butts into conversations that already existed.
  // For keyword/new, an inbound that isn't a fresh engagement only runs if
  // there's already an active session (so multi-turn chats continue). A voice
  // note can't be keyword-matched before transcription, so it's handled only
  // within an active session.
  const triggerMode = agent.trigger_mode || 'any';
  if (triggerMode === 'keyword' || triggerMode === 'new') {
    let engages;
    if (triggerMode === 'keyword') {
      engages = hasText && matchesKeyword(
        record.message_body, agent.trigger_keyword,
        agent.trigger_match_type, agent.trigger_case_sensitive,
      );
    } else {
      // 'new': this is a fresh conversation only if the contact has no earlier
      // inbound message (besides the current one) to this number.
      const { rows: prior } = await pool.query(
        `SELECT 1 FROM coexistence.chat_history
          WHERE wa_number = $1 AND contact_number = $2 AND direction = 'incoming'
            AND ($3::text IS NULL OR message_id IS DISTINCT FROM $3)
          LIMIT 1`,
        [record.wa_number || '', record.contact_number, record.message_id || null],
      );
      engages = prior.length === 0;
    }
    if (!engages) {
      const windowMin = agent.trigger_session_minutes || 30;
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM coexistence.agent_runs
          WHERE agent_id = $1 AND contact_number = $2
            AND started_at > NOW() - make_interval(mins => $3)
          LIMIT 1`,
        [agent.id, record.contact_number, windowMin],
      );
      if (recent.length === 0) return null; // not a fresh engagement and no live session
    }
  }

  // Funnel gating. Combined with the trigger above as an AND, not an OR: the
  // keyword (or "new conversation", or "any message") decides WHEN a message is
  // interesting, and this decides WHOSE messages are. So "price" from a lead at
  // the Hot stage runs the agent while the same word from an enrolled customer
  // falls through to a human — which is the whole point of gating on the funnel.
  //
  // Evaluated AFTER the session check on purpose: a conversation the agent has
  // already engaged keeps flowing even if the lead's stage changes mid-chat,
  // rather than the bot going silent halfway through its own exchange.
  const gated = await passesFunnelGate(agent, record);
  if (!gated) return { agentId: agent.id, skipped: 'funnel_gate' };

  // Usage limits. Enforced HERE — before the run is enqueued — so a blocked
  // message costs zero tokens. A test number is exempt: the point of one is to
  // run the agent again and again, which a cap would make impossible after the
  // first few tries.
  const { enforceLimits } = require('./agentLimits');
  const limited = await enforceLimits({
    agent,
    waNumber: record.wa_number,
    contactNumber: record.contact_number,
    inboundMessageId: record.message_id || null,
    isTest,
  });
  if (limited) return { agentId: agent.id, ...limited };

  await enqueueAgentRun({
    agentId: agent.id,
    contactNumber: record.contact_number,
    inboundMessageId: record.message_id || null,
    inboundText: hasText ? record.message_body : null,
    isTest,
  });
  return { agentId: agent.id, isTest };
}

module.exports = { routeIfActive };
