// Agent auto-reply runtime for the ForgeSocial Inbox.
//
// Two entry points:
//   onInstagramDm()  — called from the IG webhook for each NEW incoming DM
//                      (real-time). The webhook already dedupes by mid.
//   sweepComments()  — called after syncService.syncComments(); finds fresh,
//                      unanswered top-level comments and replies to them.
//
// Human-like by design (anti-spam, NOT detection-evasion): a random delay
// (agent.min_delay_sec..max_delay_sec, default 5–10s) before every send, the
// LLM is prompted to vary phrasing per recipient (new vs returning), and ALL
// sends go through the same rate-gated module functions the Inbox uses, within
// Meta's 24h DM window. Per-conversation in-memory locks prevent double-fires;
// comment replies are deduped in the DB via agent_runs.inbound_ref.

const pool = require('../db');
const engine = require('../engine/agentEngine');
const instagram = require('../instagram');
const mcp = require('../mcpService');
const agentMedia = require('./agentMedia');

const inflight = new Set(); // conversation keys currently being processed
const pending = new Map();   // conversation key → latest {accountId, peerId, text} that arrived mid-run

function rand(min, max) { return Math.floor(min + Math.random() * (Math.max(min, max) - min + 1)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Strip emojis / emoticons / decorative symbols — business replies must read
// professional, never botty. Belt-and-suspenders over the system-prompt rule.
const EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2122}\u{2139}]/gu; // eslint-disable-line no-misleading-character-class -- joiners and selectors are stripped one by one, on purpose
function cleanReply(s) {
  return String(s || '')
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Human-like pause before sending (seconds → ms). 0 when humanize is off.
async function humanDelay(agent) {
  if (agent.humanize === false) return;
  const lo = agent.min_delay_sec != null ? agent.min_delay_sec : 5;
  const hi = agent.max_delay_sec != null ? agent.max_delay_sec : 10;
  await sleep(rand(lo, hi) * 1000);
}

function triggerMatches(agent, text) {
  if ((agent.trigger_mode || 'any') !== 'keyword') return true;
  const kw = (agent.trigger_keyword || '').trim();
  if (!kw) return true;
  let hay = String(text || '');
  let needle = kw;
  if (!agent.trigger_case_sensitive) { hay = hay.toLowerCase(); needle = needle.toLowerCase(); }
  const mt = agent.trigger_match_type || 'contains';
  if (mt === 'exact') return hay.trim() === needle;
  if (mt === 'starts') return hay.trim().startsWith(needle);
  return hay.includes(needle);
}

async function findActiveAgent({ platform, accountId, channel }) {
  // channel: 'dm' (reply_dms) or 'comment' (reply_comments). Account match is
  // strict for IG/Threads (multi-account); platform-only for FB/YT.
  const col = channel === 'dm' ? 'reply_dms' : 'reply_comments';
  const matchAccount = (platform === 'instagram' || platform === 'threads') && accountId;
  const params = [platform];
  let sql = `SELECT * FROM agents WHERE is_active = TRUE AND status = 'active' AND platform = $1 AND ${col} = TRUE`;
  if (matchAccount) { params.push(accountId); sql += ` AND (account_id = $2 OR account_id IS NULL)`; }
  sql += ' ORDER BY (account_id IS NOT NULL) DESC, updated_at DESC LIMIT 1';
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

/* ------------------------------ DMs ---------------------------------- */

async function buildDmHistory({ accountId, peerId, limit }) {
  // Include messages that have either text OR attachments (images / audio / video).
  // Image-only messages have text=null — they must not be silently dropped or the
  // LLM loses all memory of a shared image on the very next turn.
  const { rows } = await pool.query(
    `SELECT direction, text, attachments, ts FROM instagram_messages
      WHERE account_id = $1 AND (sender_id = $2 OR recipient_id = $2)
        AND (text IS NOT NULL AND text <> '' OR attachments IS NOT NULL)
      ORDER BY ts DESC LIMIT $3`,
    [accountId, peerId, Math.max(1, Math.min(100, limit || 20))],
  );
  return rows.reverse().map(r => {
    let content = r.text || '';
    if (!content && r.attachments) {
      // Describe the attachment type so the LLM knows media was shared.
      try {
        const atts = JSON.parse(r.attachments);
        if (!Array.isArray(atts) || !atts.length) return null;
        const type = (atts[0]?.type || '').toLowerCase();
        if (type === 'image') content = '[User sent a photo/image]';
        else if (type === 'audio' || type === 'voice') content = '[User sent a voice note]';
        else if (type === 'video') content = '[User sent a video]';
        else content = '[User sent a media attachment]';
      } catch { content = '[User sent an attachment]'; }
    }
    if (!content) return null;
    return { role: r.direction === 'incoming' ? 'user' : 'assistant', content };
  }).filter(Boolean);
}

async function contactMeta({ accountId, peerId }) {
  const { rows } = await pool.query(
    `SELECT u.name, u.username,
            (SELECT COUNT(*) FROM instagram_messages m WHERE m.account_id = $1 AND (m.sender_id = $2 OR m.recipient_id = $2)) AS msg_count
       FROM instagram_users u WHERE u.igsid = $2`,
    [accountId, peerId],
  );
  const r = rows[0] || {};
  return { name: r.name || (r.username ? '@' + r.username : null), isReturning: Number(r.msg_count || 0) > 1 };
}

// Session continuity: a keyword-triggered agent that has recently replied to
// this peer stays engaged for follow-up messages (which naturally won't repeat
// the keyword) until the conversation goes quiet for trigger_session_minutes.
async function inActiveSession(agent, peerId) {
  const mins = agent.trigger_session_minutes != null ? agent.trigger_session_minutes : 30;
  const { rows } = await pool.query(
    `SELECT 1 FROM agent_runs
      WHERE agent_id = $1 AND peer_id = $2 AND channel = 'dm'
        AND started_at > now() - ($3 || ' minutes')::interval
      LIMIT 1`,
    [agent.id, peerId, String(mins)],
  );
  return rows.length > 0;
}

// Called from the IG webhook for a new INCOMING DM. Fire-and-forget.
async function onInstagramDm({ accountId, peerId, text, attachments = null }) {
  if (!accountId || !peerId) return;
  const key = `dm:${accountId}:${peerId}`;
  let acquired = false;
  try {
    const agent = await findActiveAgent({ platform: 'instagram', accountId, channel: 'dm' });
    if (!agent) return;
    // An IG automation (question flow / quick-reply tap / story rule) owns this conversation.
    if (await require('./commentAutomation').isHandling(accountId, peerId)) return;

    // Voice notes: when transcription is on and the DM is audio-only, transcribe
    // FIRST so the keyword/session gate (and the model) see real text.
    let effText = text || '';
    const audioAtt = agent.transcribe_audio ? agentMedia.pickAttachment(attachments, 'audio') : null;
    if (audioAtt && !effText) {
      const transcript = await agentMedia.transcribeFromUrl(audioAtt.url);
      if (transcript) { effText = transcript; console.log(`[agentDispatch] transcribed voice note (${transcript.length} chars).`); }
    }

    // Gate: respond if the trigger matches OR we're mid-conversation (so the
    // 2nd, 3rd… message of a keyword-started chat continues without the keyword).
    // An image-only DM in an active session also proceeds.
    const imageAtt = agent.accept_images ? agentMedia.pickAttachment(attachments, 'image') : null;
    let proceed = triggerMatches(agent, effText) || (!!imageAtt && (agent.trigger_mode || 'any') !== 'keyword');
    if (!proceed && (agent.trigger_mode || 'any') === 'keyword') proceed = await inActiveSession(agent, peerId);
    if (!proceed) {
      console.log(`[agentDispatch] DM to ${accountId}: agent "${agent.name}" trigger (${agent.trigger_mode}${agent.trigger_keyword ? ' "' + agent.trigger_keyword + '"' : ''}) did not match and no active session — skipping.`);
      return;
    }

    // Coalesce: if a run is already in flight for this conversation, remember the
    // latest message and let the current run finish, then re-process ONCE (it
    // re-reads the whole thread, so it answers everything that arrived meanwhile).
    if (inflight.has(key)) { pending.set(key, { accountId, peerId, text, attachments }); return; }
    inflight.add(key); acquired = true;
    console.log(`[agentDispatch] DM to ${accountId}: running agent #${agent.id} "${agent.name}" for peer ${peerId}`);

    const loaded = await engine.loadRunnableAgent(agent.id).catch(e => { console.error('[agentDispatch] DM load failed:', e.message); return null; });
    if (!loaded) return;

    const meta = await contactMeta({ accountId, peerId });
    const history = await buildDmHistory({ accountId, peerId, limit: agent.context_window_messages });
    // Append the current turn (text-only history skips media-only messages).
    if (effText && !(history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === effText)) {
      history.push({ role: 'user', content: effText });
    }
    // Load the image (vision) and attach it to the final user turn as multimodal.
    let imageData = null;
    if (imageAtt) {
      console.log(`[agentDispatch] loading image attachment for peer ${peerId}: ${imageAtt.url.slice(0, 80)}`);
      imageData = await agentMedia.loadImageBase64(imageAtt.url);
      if (!imageData) console.warn(`[agentDispatch] image load failed — model won't see the image.`);
    }
    if (imageData) {
      const parts = [
        { type: 'image', mime: imageData.mime, data: imageData.data },
        { type: 'text', text: effText || 'The user sent this image.' },
      ];
      const last = history[history.length - 1];
      if (last && last.role === 'user') last.content = parts;
      else history.push({ role: 'user', content: parts });
    }
    if (history.length === 0) history.push({ role: 'user', content: effText || 'Hello' });

    const out = await engine.runLoop({
      loaded, messages: history,
      ctx: { mode: 'dm', live: true, platform: 'instagram', accountId, peerId, inboundRef: (effText || 'media').slice(0, 120), trigger: agent.trigger_mode, contactName: meta.name, isReturning: meta.isReturning, hasImage: !!imageData, hasAudio: !!audioAtt },
      persist: true,
    });

    const reply = cleanReply(out.finalText);
    if (!reply) { console.log(`[agentDispatch] agent #${agent.id} produced no reply (status ${out.status}) — nothing sent.`); return; }
    await humanDelay(agent);
    try {
      await instagram.sendDirectMessage({ accountId, recipientId: peerId, text: reply });
      console.log(`[agentDispatch] agent #${agent.id} replied to peer ${peerId} (${reply.length} chars).`);
    } catch (e) {
      console.error('[agentDispatch] DM send failed:', e.message);
      if (out.runId) await pool.query(`UPDATE agent_runs SET status='failed', error_message=$1 WHERE id=$2`, [`send failed: ${e.message}`.slice(0, 500), out.runId]).catch(() => {});
    }
  } catch (e) {
    console.error('[agentDispatch] onInstagramDm error:', e.message);
  } finally {
    // Only the invocation that acquired the lock releases it + drains any message
    // that arrived mid-run (re-invoke once with the latest).
    if (acquired) {
      inflight.delete(key);
      const next = pending.get(key);
      if (next) { pending.delete(key); setImmediate(() => onInstagramDm(next)); }
    }
  }
}

/* ---------------------------- comments ------------------------------- */

// Per-platform candidate query: fresh top-level comments not authored by us,
// with no reply under them, not already handled by an agent run.
const COMMENT_SOURCES = {
  instagram: {
    table: 'instagram_comments', idCol: 'comment_id', textCol: 'text', tsCol: 'ts',
    accountCol: 'account_id', authorCol: 'from_id',
  },
  facebook: { table: 'facebook_comments', idCol: 'comment_id', textCol: 'message', tsCol: 'ts', accountCol: null, authorCol: 'from_id' },
  youtube: { table: 'youtube_comments', idCol: 'comment_id', textCol: 'text', tsCol: 'ts', accountCol: null, authorCol: 'author_channel_id' },
  threads: { table: 'threads_comments', idCol: 'comment_id', textCol: 'text', tsCol: 'ts', accountCol: 'account_key', authorCol: null },
};

async function candidateComments({ platform, agent, sinceFloor, limit }) {
  const src = COMMENT_SOURCES[platform];
  if (!src) return [];
  const params = [];
  let where = `parent_id IS NULL AND ${src.textCol} IS NOT NULL AND ${src.textCol} <> ''`;
  params.push(sinceFloor); where += ` AND ${src.tsCol} >= $${params.length}`;
  if (src.accountCol && (platform === 'instagram' || platform === 'threads') && agent.account_id) {
    params.push(agent.account_id); where += ` AND ${src.accountCol} = $${params.length}`;
  }
  // Don't reply to our own comments (best-effort).
  if (src.authorCol && agent.account_id) {
    params.push(agent.account_id); where += ` AND (${src.authorCol} IS NULL OR ${src.authorCol} <> $${params.length})`;
  }
  params.push(limit);
  const sql = `
    SELECT c.${src.idCol} AS comment_id, c.${src.textCol} AS text
      FROM ${src.table} c
     WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM ${src.table} ch WHERE ch.parent_id = c.${src.idCol})
       AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.inbound_ref = c.${src.idCol})
     ORDER BY c.${src.tsCol} DESC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Sweep all four platforms for active comment-agents. Capped per call so a
// backlog never produces a burst of replies.
async function sweepComments() {
  try {
    const { rows: agents } = await pool.query(
      `SELECT * FROM agents WHERE is_active = TRUE AND status = 'active' AND reply_comments = TRUE`,
    );
    if (agents.length === 0) return;
    const MAX_PER_SWEEP = 6;
    let sent = 0;
    // Only consider comments from the last 12h, and never older than the agent's
    // last config change (so activating an agent doesn't reply to old backlog).
    for (const agent of agents) {
      if (sent >= MAX_PER_SWEEP) break;
      const platform = agent.platform;
      if (!COMMENT_SOURCES[platform]) continue;
      // Use created_at (not updated_at): editing agent config bumps updated_at to NOW,
      // which would incorrectly exclude any comments that arrived just before the save.
      const floor = new Date(Math.max(Date.now() - 12 * 3600 * 1000, new Date(agent.created_at).getTime()));
      const cands = await candidateComments({ platform, agent, sinceFloor: floor, limit: MAX_PER_SWEEP - sent }).catch(e => { console.error('[agentDispatch] candidate query failed:', e.message); return []; });
      for (const c of cands) {
        if (sent >= MAX_PER_SWEEP) break;
        if (!triggerMatches(agent, c.text)) continue;
        await replyToComment({ agent, platform, comment: c }).catch(e => console.error('[agentDispatch] comment reply failed:', e.message));
        sent += 1;
      }
    }
  } catch (e) {
    console.error('[agentDispatch] sweepComments error:', e.message);
  }
}

async function replyToComment({ agent, platform, comment }) {
  const key = `comment:${comment.comment_id}`;
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    const loaded = await engine.loadRunnableAgent(agent.id).catch(e => { console.error('[agentDispatch] comment load failed:', e.message); return null; });
    if (!loaded) return;
    const messages = [{ role: 'user', content: `A user left this comment on your ${platform} post:\n\n"${comment.text}"\n\nWrite a brief, friendly public reply.` }];
    const out = await engine.runLoop({
      loaded, messages,
      ctx: { mode: 'comment', live: true, platform, accountId: agent.account_id, inboundRef: comment.comment_id, trigger: agent.trigger_mode, isReturning: false },
      persist: true,
    });
    const reply = cleanReply(out.finalText);
    if (!reply) return;
    await humanDelay(agent);
    try {
      await mcp.replyToComment({ platform, commentId: comment.comment_id, message: reply, accountId: agent.account_id });
    } catch (e) {
      console.error('[agentDispatch] comment send failed:', e.message);
      if (out.runId) await pool.query(`UPDATE agent_runs SET status='failed', error_message=$1 WHERE id=$2`, [`send failed: ${e.message}`.slice(0, 500), out.runId]).catch(() => {});
    }
  } finally {
    inflight.delete(key);
  }
}

module.exports = { onInstagramDm, sweepComments };
