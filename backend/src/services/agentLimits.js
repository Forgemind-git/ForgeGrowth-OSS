// Usage limits for AI agents.
//
// Three independent ceilings, all NULL = unlimited, all enforced in ONE place
// (enforceLimits, called from agentRouter before the run is enqueued) so a
// blocked message costs zero tokens:
//
//   1. max_replies_per_minute        — flood guard, per contact.
//   2. max_replies_per_conversation  — the talkative-lead cap, per contact,
//                                      refilling after a SILENCE.
//   3. quota_replies / quota_conversations — the same person's allowance over
//                                      a rolling window, refilling on a CLOCK.
//   4. max_runs_per_day              — systemic backstop, per agent, IST day.
//
// They are deliberately separate: a total cap cannot see a burst (15 messages
// in 20 seconds are all inside a budget of 20); a cap that refills on silence
// cannot stop someone taking the same budget again half an hour later; and
// none of them can see a broadcast backfire (300 individually-normal
// conversations at once).
//
// ⚠ NULL means unlimited, never 0 — see migrations 102 and 108.
// ⚠ A run from one of the agent's test numbers is exempt from all of them AND
//   is excluded from every count here, so a morning of testing cannot eat a
//   customer's allowance or the day's budget.

const pool = require('../db');

// There is deliberately NO default closing message here. The editor pre-fills
// a suggested sentence into an editable box, so an empty stored value can only
// mean the operator cleared it — and a fallback on this side would put words
// they deleted back in front of a customer.

// Bounds the session scan. A session cannot outlive this even at the maximum
// trigger_session_minutes (1440), and it keeps the query on the
// (contact_number, started_at DESC) index instead of walking all history.
const SESSION_SCAN_DAYS = 30;

function asLimit(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null; // 0/negative/NaN => unlimited
}

// ── The rolling quota window ────────────────────────────────────────────────
//
// Stored on the agent as a value + a unit; converted to minutes HERE and
// nowhere else. A derived minutes column beside the value+unit would be a
// restated fact that can go stale, and storing only minutes would lose the
// difference between "1 day" and "1440 minutes" in the UI.
//
// Capped at the scan horizon: the counting query only looks back
// SESSION_SCAN_DAYS, so a longer window would quietly count less than it
// claims to.
const WINDOW_UNITS = { minutes: 1, hours: 60, days: 1440 };
const MAX_WINDOW_MINUTES = SESSION_SCAN_DAYS * 1440;

function windowMinutes(value, unit) {
  const per = WINDOW_UNITS[unit] || WINDOW_UNITS.days;
  const n = parseInt(value, 10);
  const v = Number.isFinite(n) && n > 0 ? n : 1;
  return Math.min(v * per, MAX_WINDOW_MINUTES);
}

// Human phrasing for a window, used in the reason recorded against a blocked
// run ("3/3 replies in the last 24 hours"). Derived from the same value+unit
// the enforcement reads, so the sentence cannot describe a different window
// from the one that was applied.
function describeWindow(value, unit) {
  const n = parseInt(value, 10);
  const v = Number.isFinite(n) && n > 0 ? n : 1;
  const u = WINDOW_UNITS[unit] ? unit : 'days';
  return `${v} ${v === 1 ? u.replace(/s$/, '') : u}`;
}

/**
 * Replies the agent has already sent in the CURRENT conversation with this
 * contact, plus how many messages it has already blocked in it.
 *
 * "Current conversation" = everything since the last gap of at least
 * `sessionMinutes` between runs. That is the same session notion the router
 * already uses for keyword/new-contact engagement, so a lead returning
 * tomorrow starts fresh while a lead spamming right now does not.
 *
 * A rolling "last N minutes" window would NOT work here: someone asking a
 * question every 25 minutes for five hours is plainly one conversation, but a
 * 30-minute rolling window would never see more than two runs and the cap
 * would never fire.
 *
 * `failed` runs are excluded throughout — a customer must not lose budget to
 * our own outage.
 */
async function sessionCounts({ agentId, contactNumber, sessionMinutes }) {
  const { rows } = await pool.query(
    `WITH runs AS (
       SELECT status, started_at,
              LAG(started_at) OVER (ORDER BY started_at) AS prev
         FROM coexistence.agent_runs
        WHERE agent_id = $1
          AND contact_number = $2
          AND status <> 'failed'
          AND is_test = FALSE
          AND started_at > NOW() - make_interval(days => $4)
     ),
     bounds AS (
       SELECT CASE
         -- NOW is a boundary too. Without this arm the session only ever ends
         -- when a NEWER run opens the next one, so a conversation that simply
         -- went quiet stays "current" forever and its budget never comes back.
         WHEN NOW() - (SELECT MAX(started_at) FROM runs) >= make_interval(mins => $3)
           THEN NULL
         ELSE (SELECT MAX(started_at) FROM runs
                WHERE prev IS NULL OR started_at - prev >= make_interval(mins => $3))
       END AS session_start
     )
     -- A NULL session_start (no history, or the chat has gone quiet) makes the
     -- comparison NULL, yields no rows, and the aggregates return 0.
     SELECT COUNT(*) FILTER (WHERE r.status <> 'limited')::int AS replies,
            COUNT(*) FILTER (WHERE r.status =  'limited')::int AS blocked
       FROM runs r, bounds b
      WHERE r.started_at >= b.session_start`,
    [agentId, contactNumber, sessionMinutes, SESSION_SCAN_DAYS],
  );
  // No runs at all -> the cross join yields no rows -> aggregates return 0.
  return { replies: rows[0]?.replies || 0, blocked: rows[0]?.blocked || 0 };
}

/**
 * How many images the customer has sent in the CURRENT conversation, counting
 * the one that just arrived.
 *
 * Backs `agents.max_images_per_conversation` — a cost ceiling, since every image
 * shown to a vision model is billed per image. Per CONVERSATION and not per
 * message because WhatsApp delivers each photo as its own message and triggers
 * its own run, so a per-message cap could only ever be 1.
 *
 * ⚠ The session boundary here is drawn over INBOUND MESSAGES, not over
 * agent_runs like sessionCounts() above — the two are genuinely different
 * quantities and the runs boundary is wrong for this one. A conversation that
 * OPENS with a photo has no prior run, so a runs-derived session start would
 * fall after that photo's timestamp and miss it, then miss the first of every
 * subsequent burst the same way. Messages also match what "conversation" means
 * to the person reading the cap.
 *
 * Note there is no "NOW is also a boundary" arm (which sessionCounts needs):
 * the triggering message is already in chat_history when the agent runs, so
 * MAX(timestamp) is always current by construction. A first image after a long
 * silence opens its own session and counts 1.
 */
async function imagesInSession({ waNumber, contactNumber, sessionMinutes }) {
  if (!waNumber || !contactNumber) return 0;
  const { rows } = await pool.query(
    `WITH msgs AS (
       SELECT timestamp, message_type,
              LAG(timestamp) OVER (ORDER BY timestamp) AS prev
         FROM coexistence.chat_history
        WHERE wa_number = $1
          AND contact_number = $2
          AND direction = 'incoming'
          AND timestamp > NOW() - make_interval(days => $4)
     ),
     bounds AS (
       SELECT MAX(timestamp) AS session_start
         FROM msgs
        WHERE prev IS NULL OR timestamp - prev >= make_interval(mins => $3)
     )
     SELECT COUNT(*) FILTER (WHERE m.message_type = 'image')::int AS images
       FROM msgs m, bounds b
      WHERE m.timestamp >= b.session_start`,
    [waNumber, contactNumber, sessionMinutes, SESSION_SCAN_DAYS],
  );
  return rows[0]?.images || 0;
}

/**
 * What ONE person has used of their rolling allowance.
 *
 * This is a different question from sessionCounts() above, and both are needed.
 * The session cap asks "how long may one sitting run?" and refills the moment
 * the chat goes quiet — so someone can take 20 replies now, wait half an hour,
 * and take 20 more, all day. This asks "how much may this person have in the
 * last N hours?" and refills on a clock instead.
 *
 * Returns, all measured inside the window:
 *   replies        — answers they have already had.
 *   conversations  — separate sittings they have started. A run counts as a
 *                    start when the gap to their PREVIOUS run is at least
 *                    sessionMinutes (the same session notion used everywhere
 *                    else here), so it is the same boundary the operator sets
 *                    under Trigger.
 *   blocked        — messages already refused for this quota, which is what
 *                    makes the closing message fire once per window and not
 *                    once per message.
 *   repliesOldest / conversationsOldest — when the oldest counted item falls
 *                    out of the window, i.e. when a slot frees up. Recorded in
 *                    the reason so the operator can see when the person is due
 *                    to be answered again, rather than only that they were not.
 *   lastReplyAt    — used to tell "starting a NEW conversation" from "still in
 *                    one", because the conversation quota must only refuse the
 *                    former (see enforceLimits).
 *
 * ⚠ `prev` is computed over ANSWERED runs only. A 'limited' row sits between
 * two real runs, so including it would shrink the gap and make the next real
 * run look like a continuation of a sitting that never happened.
 *
 * ⚠ The LAG runs over the whole scan horizon, not just the window — a run whose
 * previous run was two hours ago is a new conversation even when that previous
 * run has already fallen out of a one-hour window.
 *
 * Test runs and failed runs are excluded: a test must not consume a customer's
 * allowance, and neither must our own outage.
 */
async function quotaCounts({ agentId, contactNumber, windowMin, sessionMinutes }) {
  const { rows } = await pool.query(
    `WITH answered AS (
       SELECT started_at,
              LAG(started_at) OVER (ORDER BY started_at) AS prev
         FROM coexistence.agent_runs
        WHERE agent_id = $1
          AND contact_number = $2
          AND status NOT IN ('failed','limited')
          AND is_test = FALSE
          AND started_at > NOW() - make_interval(days => $5)
     ),
     win AS (
       SELECT started_at, prev
         FROM answered
        WHERE started_at > NOW() - make_interval(mins => $3)
     ),
     starts AS (
       SELECT started_at FROM win
        WHERE prev IS NULL OR started_at - prev >= make_interval(mins => $4)
     )
     SELECT (SELECT COUNT(*) FROM win)::int                        AS replies,
            (SELECT COUNT(*) FROM starts)::int                     AS conversations,
            (SELECT MIN(started_at) FROM win)                      AS replies_oldest,
            (SELECT MIN(started_at) FROM starts)                   AS conversations_oldest,
            (SELECT MAX(started_at) FROM answered)                 AS last_reply_at,
            (SELECT COUNT(*) FROM coexistence.agent_runs
              WHERE agent_id = $1 AND contact_number = $2
                AND status = 'limited' AND is_test = FALSE
                AND started_at > NOW() - make_interval(mins => $3))::int AS blocked`,
    [agentId, contactNumber, windowMin, sessionMinutes, SESSION_SCAN_DAYS],
  );
  const r = rows[0] || {};
  return {
    replies: r.replies || 0,
    conversations: r.conversations || 0,
    blocked: r.blocked || 0,
    repliesOldest: r.replies_oldest || null,
    conversationsOldest: r.conversations_oldest || null,
    lastReplyAt: r.last_reply_at || null,
  };
}

// When the oldest counted item leaves the window — i.e. the earliest moment the
// person can be answered again. Null when there is nothing to age out.
function freesUpAt(oldest, windowMin) {
  if (!oldest) return null;
  return new Date(new Date(oldest).getTime() + windowMin * 60000);
}

// Runs for this contact in the last 60 seconds. 'limited' rows are NOT counted:
// a burst block records nothing, but a conversation-cap block does, and letting
// those feed back into the burst count would keep a capped contact throttled
// on a signal that has nothing to do with how fast they are typing.
async function recentRunCount({ agentId, contactNumber }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM coexistence.agent_runs
      WHERE agent_id = $1 AND contact_number = $2
        AND status NOT IN ('failed','limited')
        AND is_test = FALSE
        AND started_at > NOW() - INTERVAL '1 minute'`,
    [agentId, contactNumber],
  );
  return rows[0]?.n || 0;
}

/**
 * Runs by this agent so far today, across every conversation.
 *
 * ⚠ The IST boundary must stay a naive timestamp until the single conversion
 * back (anti-pattern #30). `(NOW() AT TIME ZONE 'Asia/Kolkata')::date AT TIME
 * ZONE 'Asia/Kolkata'` promotes a date using the SERVER zone and lands 5.5h in
 * the future, so the count reads a plausible 0 and the cap never fires.
 */
async function runsToday({ agentId }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM coexistence.agent_runs
      WHERE agent_id = $1
        AND status NOT IN ('failed','limited')
        AND is_test = FALSE
        AND started_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [agentId],
  );
  return rows[0]?.n || 0;
}

/**
 * Record a blocked message as a run row so the operator can see WHY the agent
 * went quiet instead of reading a flatline and guessing.
 *
 * Carries the inbound message id, so the same unique index that stops a
 * replayed message being answered twice also stops it being logged twice —
 * hence the 23505 swallow.
 */
async function recordBlocked({ agent, contactNumber, inboundMessageId, reason }) {
  try {
    await pool.query(
      `INSERT INTO coexistence.agent_runs
         (agent_id, wa_account_id, contact_number, inbound_message_id,
          status, error_message, started_at, ended_at)
       VALUES ($1,$2,$3,$4,'limited',$5,NOW(),NOW())`,
      [agent.id, agent.wa_account_id || null, contactNumber, inboundMessageId || null, reason],
    );
  } catch (e) {
    if (e.code === '23505') return; // already logged for this inbound
    console.error('[agentLimits] could not log blocked run:', e.message);
  }
}

/**
 * Gate an inbound message against the agent's limits.
 *
 * Returns null when the message may proceed, or { skipped: <reason> } when it
 * was blocked (side effects already applied). Called AFTER the handoff-keyword
 * check in agentRouter, so a customer asking for a human always gets through
 * no matter how many questions they have asked.
 *
 * Order is burst -> conversation -> quota -> day, which fails toward serving
 * the customer: a flood is throttled before it can eat the conversation
 * budget, and someone mid-conversation still gets their closing message and a
 * human on a day the agent has otherwise stopped.
 *
 * `isTest` short-circuits everything. A test number exists so the agent can be
 * exercised over and over; a cap that applied to it would make the second run
 * of the day impossible, which is the opposite of what it is for. The check
 * lives here rather than only at the call site so a future caller cannot
 * forget it.
 */
async function enforceLimits({ agent, waNumber, contactNumber, inboundMessageId, isTest = false }) {
  if (isTest) return null;

  const perMinute = asLimit(agent.max_replies_per_minute);
  const perConvo = asLimit(agent.max_replies_per_conversation);
  const perDay = asLimit(agent.max_runs_per_day);
  const quotaReplies = asLimit(agent.quota_replies);
  const quotaConvos = asLimit(agent.quota_conversations);
  if (!perMinute && !perConvo && !perDay && !quotaReplies && !quotaConvos) return null; // nothing configured

  // 1. Burst. Records nothing and sends nothing on purpose: a throttle is "not
  //    right now", not a state change. The message stays in chat_history, so
  //    buildMessageHistory still feeds it to the model — the customer's point
  //    is answered in the next reply, it just does not earn its own.
  if (perMinute) {
    const recent = await recentRunCount({ agentId: agent.id, contactNumber });
    if (recent >= perMinute) {
      console.warn(`[agentLimits] agent ${agent.id}: ${contactNumber} throttled (${recent}/${perMinute} per minute)`);
      return { skipped: 'rate_limited' };
    }
  }

  // 2. Conversation cap — the only limit with a customer-visible consequence.
  if (perConvo) {
    const sessionMinutes = Math.max(1, Math.min(1440, agent.trigger_session_minutes || 30));
    const { replies, blocked } = await sessionCounts({
      agentId: agent.id, contactNumber, sessionMinutes,
    });
    if (replies >= perConvo) {
      // Every blocked message is logged (so the run history shows how many
      // went unanswered), but the closing message and the handoff fire only on
      // the FIRST one — `blocked` is what makes this idempotent for the rest of
      // the session.
      await recordBlocked({
        agent, contactNumber, inboundMessageId,
        reason: `Conversation reply limit reached (${replies}/${perConvo})`,
      });

      if (blocked === 0) {
        await onConversationCapped({ agent, waNumber, contactNumber, replies, perConvo });
      }
      return { skipped: 'conversation_limit', replies, limit: perConvo, firstHit: blocked === 0 };
    }
  }

  // 3. Rolling per-person quota — "three replies each day", "one conversation
  //    an hour". Unlike the conversation cap above, this does NOT refill when
  //    the chat goes quiet; it refills on the clock the operator chose, which
  //    is the whole point of it existing alongside that cap.
  if (quotaReplies || quotaConvos) {
    const sessionMinutes = Math.max(1, Math.min(1440, agent.trigger_session_minutes || 30));
    const windowMin = windowMinutes(agent.quota_window_value, agent.quota_window_unit);
    const label = describeWindow(agent.quota_window_value, agent.quota_window_unit);
    const q = await quotaCounts({ agentId: agent.id, contactNumber, windowMin, sessionMinutes });

    // Is this message opening a NEW sitting, or continuing one? The
    // conversation quota may only ever refuse the former: someone who is
    // allowed one conversation a day and is three messages into it must not be
    // cut off mid-sentence by the same rule that let them start.
    const startsNew = !q.lastReplyAt
      || (Date.now() - new Date(q.lastReplyAt).getTime()) >= sessionMinutes * 60000;

    let hit = null;
    if (quotaReplies && q.replies >= quotaReplies) {
      hit = {
        skipped: 'quota_replies', used: q.replies, limit: quotaReplies,
        reason: `Reply quota reached (${q.replies}/${quotaReplies} in the last ${label})`,
        freesUp: freesUpAt(q.repliesOldest, windowMin),
      };
    } else if (quotaConvos && startsNew && q.conversations >= quotaConvos) {
      hit = {
        skipped: 'quota_conversations', used: q.conversations, limit: quotaConvos,
        reason: `Conversation quota reached (${q.conversations}/${quotaConvos} in the last ${label})`,
        freesUp: freesUpAt(q.conversationsOldest, windowMin),
      };
    }

    if (hit) {
      const when = hit.freesUp ? ` — next reply available ${istStamp(hit.freesUp)}` : '';
      await recordBlocked({
        agent, contactNumber, inboundMessageId,
        reason: `${hit.reason}${when}`,
      });
      // Once per WINDOW, not once per message: `blocked` counts refusals
      // already made inside this same window.
      if (q.blocked === 0) {
        await onQuotaCapped({ agent, waNumber, contactNumber, reason: hit.reason });
      }
      return { ...hit, windowMinutes: windowMin, firstHit: q.blocked === 0 };
    }
  }

  // 4. Daily ceiling. Deliberately silent to the customer: this fires across
  //    every conversation at once (its whole reason for existing is the
  //    broadcast backfire), so a closing message here would mean hundreds of
  //    them. Visible to the operator in the run history instead.
  if (perDay) {
    const today = await runsToday({ agentId: agent.id });
    if (today >= perDay) {
      console.warn(`[agentLimits] agent ${agent.id}: daily cap reached (${today}/${perDay}) — not answering ${contactNumber}`);
      await recordBlocked({
        agent, contactNumber, inboundMessageId,
        reason: `Daily run limit reached (${today}/${perDay})`,
      });
      return { skipped: 'daily_limit', runs: today, limit: perDay };
    }
  }

  return null;
}

/**
 * What happens the first time a conversation hits its reply cap: an optional
 * closing line, then (by default) a human.
 *
 * The handoff is what stops the agent replying again — it sets
 * contacts.agent_paused, which routeIfActive already checks on every inbound.
 * With handoff off there is nothing to pause, and the cap simply holds for the
 * rest of the session and lifts when the chat goes quiet.
 */
async function onConversationCapped({ agent, waNumber, contactNumber, replies, perConvo }) {
  await sendClosingMessage({ agent, waNumber, contactNumber });

  if (agent.limit_handoff === false) return;

  try {
    const { performHandoff } = require('./agentHandoff');
    // No assignee list: the agent's own escalate capability was removed, so a
    // capped conversation is PAUSED and left in Chats for whoever picks it up,
    // rather than auto-assigned to a round-robin nobody configures any more.
    // performHandoff already treats an empty pool as "pause without assigning".
    await performHandoff({
      agentId: agent.id,
      handoffUserIds: [],
      waNumber,
      contactNumber,
      reason: `Reply limit reached (${replies}/${perConvo} in one conversation).`,
      by: 'limit',
    });
  } catch (e) {
    // A failed handoff must not resurrect the agent — the block already
    // returned, and the next message re-evaluates the same cap.
    console.error('[agentLimits] handoff after cap failed:', e.message);
  }
}

/**
 * The one place the closing line is sent. Shared by the conversation cap and
 * the rolling quota so the two cannot drift into saying different things — the
 * operator wrote ONE sentence for "the agent has stopped here", and which
 * ceiling stopped it is an operator-facing detail, recorded on the run.
 */
async function sendClosingMessage({ agent, waNumber, contactNumber }) {
  const body = (agent.limit_reached_message || '').trim();
  if (!body) return; // a cleared box is a deliberate "send nothing"
  try {
    // Reuses the one shared text sender rather than another copy of
    // insertPendingRow + enqueueSend. The 24h window is definitionally open
    // here (we are reacting to an inbound), but it is checked anyway so a
    // doomed send is reported rather than silently dropped.
    const { sendOnThread } = require('./paymentFlow');
    const res = await sendOnThread({ waNumber, contactNumber, body });
    if (!res.sent) {
      console.warn(`[agentLimits] agent ${agent.id}: closing message not sent (${res.reason})`);
    }
  } catch (e) {
    console.error('[agentLimits] closing message failed:', e.message);
  }
}

/**
 * What happens the first time inside a window that someone runs out of their
 * rolling allowance: the closing line, and a human ONLY if the operator asked
 * for one.
 *
 * `quota_handoff` defaults to FALSE where `limit_handoff` defaults to TRUE, and
 * that difference is deliberate. Being chatty in one sitting suggests interest
 * worth a person; having used today's allowance is a "come back tomorrow", and
 * escalating every one of those would push the whole rate-limited population
 * into Chats.
 */
async function onQuotaCapped({ agent, waNumber, contactNumber, reason }) {
  await sendClosingMessage({ agent, waNumber, contactNumber });

  if (agent.quota_handoff !== true) return;
  try {
    const { performHandoff } = require('./agentHandoff');
    await performHandoff({
      agentId: agent.id,
      handoffUserIds: [],
      waNumber,
      contactNumber,
      reason,
      by: 'limit',
    });
  } catch (e) {
    console.error('[agentLimits] handoff after quota failed:', e.message);
  }
}

// The reason text on a blocked run is read by a person, in IST like every other
// timestamp in this app.
function istStamp(d) {
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}

module.exports = {
  enforceLimits,
  sessionCounts,
  quotaCounts,
  windowMinutes,
  describeWindow,
  freesUpAt,
  WINDOW_UNITS,
  imagesInSession,
  recentRunCount,
  runsToday,
  asLimit,
};
