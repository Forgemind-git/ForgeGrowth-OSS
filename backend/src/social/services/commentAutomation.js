const socialEnv = require('../env');
// ManyChat-style Instagram automations (deterministic, no LLM).
//
// Triggers, all fed from instagram.handleWebhook:
//   comment       — keyword on a post's comments → public reply under the comment
//                   and a private-reply DM to the commenter.
//   dm            — keyword in an incoming DM → DM reply.
//   postback      — a template button / quick-reply payload → DM reply.
//   story_reply   — someone replies to our story (optional keywords) → DM reply.
//   story_mention — someone mentions us in their story → DM reply.
//
// On top of the reply itself a rule can:
//   - follow_gate: only hand over the content once the user follows the account.
//     The first DM is a "Send it" button; tapping it checks is_user_follow_business
//     and either delivers the content or asks them to follow and tap again.
//   - collect:     ask a few questions (name / phone / email / custom) in the DM,
//                  validate answers, save them to ig_automation_leads and optionally
//                  append a row to a Google Sheet (service account, see sheetsAgentOps).
//   - tags:        add tags to the person's Contact (same tags as the Contacts tab).
//   - follow_gate on DM / story / button triggers: we check right away (they just
//     messaged us, so the profile lookup is allowed); non-followers get the
//     "please follow" message with an "I've followed" button (same gate tap).
//   - follow-up:   one more message N minutes after the content (≤ 23 h, inside
//     Meta's 24 h window), only if they haven't tapped the link or replied.
//     Only scheduled when the content went out in an open conversation (DM /
//     story / button triggers, comment gate taps) — never after a bare private
//     reply, which doesn't open the window.
//
// Meta rules this module respects (developers.facebook.com/docs/instagram-platform/private-replies):
//   - a private reply is allowed ONCE per comment and only within 7 days of it
//     (we also DM a given user at most once per post — once_per_user);
//   - follow-ups only after the user responds, within 24 h — gate taps, capture
//     answers and dm/postback/story triggers only ever answer a fresh inbound
//     event, never cold-message; capture sessions expire after 23 h;
//   - rate: every call goes through rateLimiter.gatedFetch. DMs and private
//     replies use the MESSAGING buckets (Meta: Send API 100/s, private replies
//     750/h per account — we cap at about half), so they never queue behind
//     analytics. Public comment replies, follow checks and profile lookups are
//     Platform calls and share the 180/h/token budget. Rule firings are also
//     capped per account per hour (IG_AUTOMATION_MAX_PER_HOUR, default 60) as an
//     anti-spam ceiling; over-cap events are logged as skipped;
//   - anti-spam: a short random delay before acting (2–5 s for comments,
//     1–2.5 s in a conversation), and public replies are
//     picked at random from reply_texts (give a rule several variants);
//   - STOP / CANCEL ends a capture conversation;
//   - never reacts to the account's own comments/echoes;
//   - Meta data-deletion requests purge this module's rows (deleteUserData).
//
// Tables are created lazily on first use — no startup wiring needed.

const crypto = require('crypto');
const pool = require('../db');
const fetch = require('../rateLimiter').gatedFetch;   // every outbound Graph call goes through the limiter

const TRIGGERS = ['comment', 'dm', 'postback', 'story_reply', 'story_mention'];
const FIELD_TYPES = ['name', 'email', 'phone', 'text'];
const GATE_PREFIX = 'FS_GATE:';

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ig_automation_rules (
        id               serial PRIMARY KEY,
        name             text NOT NULL,
        account_id       text NOT NULL,
        trigger          text NOT NULL DEFAULT 'comment',
        media_id         text,                              -- comment: limit to one post (null = all posts)
        keywords         text[] NOT NULL DEFAULT '{}',      -- empty = any text; postback: payload values
        match_type       text NOT NULL DEFAULT 'contains',  -- contains | exact | starts_with
        reply_texts      text[] NOT NULL DEFAULT '{}',      -- comment: public replies (one picked at random)
        dm_message       jsonb,                             -- Graph "message" object ({text} | {attachment} | {text, quick_replies})
        dm_fallback_text text,                              -- sent if the template is rejected
        once_per_user    boolean NOT NULL DEFAULT true,     -- comment: one DM per user per post
        include_replies  boolean NOT NULL DEFAULT false,    -- comment: also trigger on replies to comments
        active           boolean NOT NULL DEFAULT true,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS follow_gate boolean NOT NULL DEFAULT false;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS gate_text text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS gate_button text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS follow_gate_text text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS collect jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS collect_done_text text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS sheet_id text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS sheet_tab text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS opening_dm boolean NOT NULL DEFAULT false;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS followup_delay_min int NOT NULL DEFAULT 240;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS followup_text text;
      ALTER TABLE ig_automation_rules ADD COLUMN IF NOT EXISTS followup_link boolean NOT NULL DEFAULT true;

      -- One scheduled follow-up per person per rule (a new trigger re-arms it).
      CREATE TABLE IF NOT EXISTS ig_automation_followups (
        id          bigserial PRIMARY KEY,
        rule_id     int REFERENCES ig_automation_rules(id) ON DELETE CASCADE,
        account_id  text NOT NULL,
        peer_id     text NOT NULL,
        due_at      timestamptz NOT NULL,
        status      text NOT NULL DEFAULT 'pending',   -- pending | sending | sent | skipped
        reason      text,
        message_id  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        done_at     timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ig_automation_followups_open ON ig_automation_followups (rule_id, peer_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS ig_automation_followups_due ON ig_automation_followups (due_at) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS ig_automation_log (
        id          bigserial PRIMARY KEY,
        rule_id     int REFERENCES ig_automation_rules(id) ON DELETE CASCADE,
        account_id  text,
        trigger     text,
        event_id    text,          -- comment_id / message mid
        media_id    text,
        user_id     text,
        username    text,
        input_text  text,
        public_reply_id text,
        dm_message_id   text,
        status      text,          -- pending | sent | partial | failed | skipped
        error       text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (rule_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS ig_automation_log_user ON ig_automation_log (rule_id, media_id, user_id);
      CREATE INDEX IF NOT EXISTS ig_automation_log_recent ON ig_automation_log (account_id, created_at DESC);

      -- One open question-and-answer conversation per person per account.
      CREATE TABLE IF NOT EXISTS ig_automation_sessions (
        account_id  text NOT NULL,
        peer_id     text NOT NULL,
        rule_id     int REFERENCES ig_automation_rules(id) ON DELETE CASCADE,
        step        int NOT NULL DEFAULT 0,
        data        jsonb NOT NULL DEFAULT '{}',
        media_id    text,
        expires_at  timestamptz NOT NULL,
        PRIMARY KEY (account_id, peer_id)
      );

      CREATE TABLE IF NOT EXISTS ig_automation_leads (
        id          bigserial PRIMARY KEY,
        account_id  text NOT NULL,
        peer_id     text NOT NULL,
        username    text,
        rule_id     int REFERENCES ig_automation_rules(id) ON DELETE SET NULL,
        media_id    text,
        data        jsonb NOT NULL DEFAULT '{}',
        sheet_status text,         -- appended | error message | null (no sheet)
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (account_id, peer_id, rule_id)
      );

      -- Tracked link buttons: each web_url button in a sent DM points at
      -- /api/ig-automations/r/<token>, which records the click and redirects.
      -- send_id groups the buttons of one delivered message (CTR = sends clicked / sends).
      CREATE TABLE IF NOT EXISTS ig_automation_links (
        token       text PRIMARY KEY,
        send_id     text NOT NULL,
        rule_id     int REFERENCES ig_automation_rules(id) ON DELETE CASCADE,
        account_id  text,
        peer_id     text,
        url         text NOT NULL,
        clicks      int NOT NULL DEFAULT 0,
        clicked_at  timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ig_automation_links_rule ON ig_automation_links (rule_id, created_at);
    `).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ── helpers ─────────────────────────────────────────────────
function matches(rule, text) {
  const kws = (rule.keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return true;
  const hay = String(text || '').trim().toLowerCase();
  if (!hay) return false;
  return kws.some(k =>
    rule.match_type === 'exact' ? hay === k
      : rule.match_type === 'starts_with' ? hay.startsWith(k)
      : hay.includes(k));
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A short, varied pause before acting. Meta sets no minimum; it is there so
// public comment replies don't land instantly and identically (spam signal).
// Replies to someone who just messaged us only need a beat.
const humanDelay = (kind = 'chat') => sleep(kind === 'comment'
  ? 2000 + Math.floor(Math.random() * 3000)    // 2–5 s before a public reply + private reply
  : 1000 + Math.floor(Math.random() * 1500));  // 1–2.5 s in a conversation
const MAX_PER_HOUR = Math.max(1, parseInt(socialEnv.IG_AUTOMATION_MAX_PER_HOUR || '60', 10));
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const SESSION_TTL = "interval '23 hours'";   // inside Meta's 24 h reply window
const clip = (s, n) => String(s || '').slice(0, n);

async function overHourlyCap(accountId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ig_automation_log
      WHERE account_id = $1 AND status IN ('sent','partial','pending')
        AND created_at > now() - interval '1 hour'`, [accountId]);
  return rows[0].n >= MAX_PER_HOUR;
}

async function accountUsername(accountId) {
  const { rows } = await pool.query('SELECT username FROM instagram_accounts WHERE account_id = $1', [accountId]);
  return rows[0]?.username || null;
}

// POST a message through the account's own auth (Instagram Login → /me/messages,
// Facebook Login → /{page-id}/messages). Returns { mid, recipientId }.
async function sendMessage(accountId, recipient, message) {
  const instagram = require('../instagram');   // lazy: instagram.js requires us
  const auth = await instagram.getAccountAuth(accountId);
  let path = `${auth.base}/me/messages`;
  if (!auth.ig) {
    const { rows } = await pool.query('SELECT page_id FROM instagram_accounts WHERE account_id = $1', [accountId]);
    path = `${auth.base}/${rows[0]?.page_id}/messages`;
  }
  const url = new URL(path);
  url.searchParams.set('access_token', auth.token);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient, message }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Send failed');
  return { mid: data.message_id || null, recipientId: data.recipient_id || recipient.id || null };
}

// Send a message; if it is rejected and a fallback is given, retry once with it.
// (A rejected private reply does not use up the comment's one allowed DM.)
async function sendWithFallback(accountId, recipient, message, fallback, label) {
  try {
    return await sendMessage(accountId, recipient, message);
  } catch (err) {
    if (!fallback || JSON.stringify(fallback) === JSON.stringify(message)) throw err;
    console.warn(`[automation] ${label}: message rejected (${err.message}) — sending fallback`);
    return await sendMessage(accountId, recipient, fallback);
  }
}

async function sendRuleDm(rule, recipient, peerId = null) {
  const message = await trackLinks(rule, rule.dm_message, peerId);
  return sendWithFallback(rule.account_id, recipient, message,
    rule.dm_fallback_text ? { text: rule.dm_fallback_text } : null, `rule ${rule.id}`);
}

// ── link click tracking ─────────────────────────────────────
// Rewrites every web_url button (and a card's default_action) to a tracked
// redirect. Best-effort: any failure sends the original links untouched.
const PUBLIC_BASE = (socialEnv.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const TRACK_LINKS = socialEnv.IG_AUTOMATION_TRACK_LINKS !== 'false';

async function trackLinks(rule, message, peerId) {
  const p = message?.attachment?.payload;
  if (!TRACK_LINKS || !p) return message;
  try {
    const out = JSON.parse(JSON.stringify(message));
    const q = out.attachment.payload;
    const sendId = crypto.randomBytes(8).toString('hex');
    const targets = [];
    const collect = (o) => { if (o && o.type === 'web_url' && /^https?:\/\//i.test(o.url || '')) targets.push(o); };
    (q.buttons || []).forEach(collect);
    for (const el of q.elements || []) { collect(el.default_action); (el.buttons || []).forEach(collect); }
    if (!targets.length) return message;
    for (const t of targets) {
      const token = crypto.randomBytes(9).toString('base64url');
      await pool.query(
        `INSERT INTO ig_automation_links (token, send_id, rule_id, account_id, peer_id, url) VALUES ($1,$2,$3,$4,$5,$6)`,
        [token, sendId, rule.id, rule.account_id, peerId || null, t.url]);
      t.url = `${PUBLIC_BASE}/api/ig-automations/r/${token}`;
    }
    return out;
  } catch (e) {
    console.warn(`[automation] rule ${rule.id}: link tracking skipped (${e.message})`);
    return message;
  }
}

// Public redirect target (index.js, before authMiddleware). Returns the
// destination URL or null for an unknown token.
async function resolveLink(token) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE ig_automation_links SET clicks = clicks + 1, clicked_at = COALESCE(clicked_at, now())
      WHERE token = $1 RETURNING url`, [String(token || '').slice(0, 64)]);
  return rows[0]?.url || null;
}

// A "tap to continue" message whose button carries the gate payload. Button
// template first; quick replies as fallback (both come back to onInstagramMessaging).
function gateMessage(text, button, payload) {
  return {
    message: { attachment: { type: 'template', payload: { template_type: 'button', text: clip(text, 640),
      buttons: [{ type: 'postback', title: clip(button, 20), payload }] } } },
    fallback: { text: clip(text, 1000), quick_replies: [{ content_type: 'text', title: clip(button, 20), payload }] },
  };
}

// Comment rules: anything after the one private reply needs them to tap first.
function needsGate(rule) {
  return !!rule.follow_gate || !!rule.opening_dm || !!rule.followup_enabled || (Array.isArray(rule.collect) && rule.collect.length > 0);
}

// Graph user-profile lookup. Consent-gated: works once the user has messaged or
// tapped a button. If it can't tell, we fail OPEN (deliver) rather than lock the
// user out, and log it.
async function followsAccount(accountId, igsid) {
  const instagram = require('../instagram');
  const auth = await instagram.getAccountAuth(accountId);
  const url = new URL(`${auth.base}/${igsid}`);
  url.searchParams.set('fields', 'is_user_follow_business');
  url.searchParams.set('access_token', auth.token);
  // Someone is waiting on this reply: don't queue long for budget, fail open instead.
  const data = await (await fetch(url, { __rl: { maxWaitMs: 2500 } })).json();
  if (data.error) throw new Error(data.error.message || 'profile lookup failed');
  return data.is_user_follow_business === true;
}

// ── contacts / tags ─────────────────────────────────────────
async function applyTags(accountId, peerId, tags, username) {
  if (!peerId || !Array.isArray(tags) || !tags.length) return;
  await pool.query(
    `INSERT INTO contacts (platform, account_id, peer_id, username, first_seen_at, last_seen_at, message_count, tags)
     VALUES ('instagram', $1, $2, $3, now(), now(), 0, '[]'::jsonb)
     ON CONFLICT (platform, account_id, peer_id) DO NOTHING`, [accountId, peerId, username || null]);
  await pool.query(
    `UPDATE contacts SET tags = (
        SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb)
          FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb) || $3::jsonb) t)
      WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`,
    [accountId, peerId, JSON.stringify(tags)]);
}

// ── rules / log ─────────────────────────────────────────────
async function activeRules(accountId, trigger) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT * FROM ig_automation_rules
      WHERE active AND account_id = $1 AND trigger = $2
      ORDER BY id`, [accountId, trigger]);
  return rows;
}

async function getRule(id) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ig_automation_rules WHERE id = $1', [id]);
  return rows[0] || null;
}

// Claim the (rule, event) pair so a webhook retry or duplicate can't double-send.
async function claim(rule, fields, trigger = rule.trigger) {
  const { rowCount } = await pool.query(
    `INSERT INTO ig_automation_log (rule_id, account_id, trigger, event_id, media_id, user_id, username, input_text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     ON CONFLICT (rule_id, event_id) DO NOTHING`,
    [rule.id, rule.account_id, trigger, fields.eventId, fields.mediaId || null,
     fields.userId || null, fields.username || null, clip(fields.text, 500) || null]);
  return rowCount > 0;
}

function finish(rule, eventId, { status, publicReplyId = null, dmMessageId = null, error = null }) {
  return pool.query(
    `UPDATE ig_automation_log SET status = $3, public_reply_id = $4, dm_message_id = $5, error = $6
      WHERE rule_id = $1 AND event_id = $2`,
    [rule.id, eventId, status, publicReplyId, dmMessageId, error]).catch(() => {});
}

// ── delivering a rule's content (DM window already open) ────
// Sends the rule's DM, tags the contact and, when the rule collects details,
// asks the first question. Returns the DM's message id.
async function deliverContent(rule, peerId, { mediaId = null, username = null } = {}) {
  let mid = null;
  if (rule.dm_message) mid = (await sendRuleDm(rule, { id: peerId }, peerId)).mid;
  await applyTags(rule.account_id, peerId, rule.tags, username).catch(e => console.warn('[automation] tagging failed:', e.message));
  const collect = Array.isArray(rule.collect) ? rule.collect : [];
  if (collect.length) {
    await pool.query(
      `INSERT INTO ig_automation_sessions (account_id, peer_id, rule_id, step, data, media_id, expires_at)
       VALUES ($1, $2, $3, 0, $4, $5, now() + ${SESSION_TTL})
       ON CONFLICT (account_id, peer_id) DO UPDATE
         SET rule_id = EXCLUDED.rule_id, step = 0, data = EXCLUDED.data,
             media_id = EXCLUDED.media_id, expires_at = EXCLUDED.expires_at`,
      [rule.account_id, peerId, rule.id, JSON.stringify(username ? { _username: username } : {}), mediaId]);
    if (mid) await sleep(1200);   // keep the question after the content in the chat
    await sendMessage(rule.account_id, { id: peerId }, { text: collect[0].prompt });
  }
  await scheduleFollowup(rule, peerId).catch(e => console.warn(`[automation] rule ${rule.id}: follow-up not scheduled (${e.message})`));
  return mid;
}

// ── follow-up (one message later, inside the 24 h window) ───
const FOLLOWUP_MAX_MIN = 23 * 60;           // Meta: automated messages only within 24 h of their last message
const WINDOW_SAFE = "interval '23 hours 45 minutes'";

async function scheduleFollowup(rule, peerId) {
  if (!rule.followup_enabled || !String(rule.followup_text || '').trim() || !peerId) return;
  const delay = Math.min(FOLLOWUP_MAX_MIN, Math.max(15, Number(rule.followup_delay_min) || 240));
  await pool.query(
    `INSERT INTO ig_automation_followups (rule_id, account_id, peer_id, due_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))
     ON CONFLICT (rule_id, peer_id) WHERE status = 'pending'
       DO UPDATE SET due_at = EXCLUDED.due_at, created_at = now()`,
    [rule.id, rule.account_id, peerId, delay]);
}

// The follow-up message: the text, with the rule's link buttons again when asked.
function followupMessage(rule) {
  const text = clip(String(rule.followup_text).trim(), 640);
  const dm = typeof rule.dm_message === 'string' ? JSON.parse(rule.dm_message) : rule.dm_message;
  const p = dm?.attachment?.payload;
  const links = [
    ...(p?.buttons || []),
    ...((p?.elements || []).flatMap(e => e.buttons || [])),
  ].filter(b => b.type === 'web_url').slice(0, 3);
  if (rule.followup_link !== false && links.length) {
    return { attachment: { type: 'template', payload: { template_type: 'button', text, buttons: links.map(b => ({ type: 'web_url', title: b.title, url: b.url })) } } };
  }
  return { text: clip(text, 1000) };
}

async function finishFollowup(id, status, reason = null, messageId = null) {
  await pool.query(`UPDATE ig_automation_followups SET status = $2, reason = $3, message_id = $4, done_at = now() WHERE id = $1`,
    [id, status, reason, messageId]);
}

// Worker: send due follow-ups. Skips anyone who tapped the link or wrote back
// since, and anyone whose 24 h window has closed. Shares the hourly anti-spam cap.
let followupsRunning = false;
async function runFollowups() {
  if (followupsRunning) return;
  followupsRunning = true;
  try {
    await ensureSchema();
    const { rows: due } = await pool.query(
      `SELECT id FROM ig_automation_followups WHERE status = 'pending' AND due_at <= now() ORDER BY due_at LIMIT 25`);
    for (const { id } of due) {
      const { rows: [f] } = await pool.query(
        `UPDATE ig_automation_followups SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING *`, [id]);
      if (!f) continue;
      try {
        const rule = await getRule(f.rule_id);
        if (!rule || !rule.active || !rule.followup_enabled) { await finishFollowup(f.id, 'skipped', 'automation off'); continue; }
        const { rows: [st] } = await pool.query(
          `SELECT EXISTS (SELECT 1 FROM ig_automation_links WHERE rule_id = $1 AND peer_id = $3 AND clicked_at >= $4) AS clicked,
                  EXISTS (SELECT 1 FROM instagram_messages WHERE account_id = $2 AND sender_id = $3 AND direction = 'incoming' AND ts > $4) AS replied,
                  GREATEST($4::timestamptz - interval '1 minute',
                    (SELECT MAX(ts) FROM instagram_messages WHERE account_id = $2 AND sender_id = $3 AND direction = 'incoming')) + ${WINDOW_SAFE} > now() AS in_window`,
          [rule.id, f.account_id, f.peer_id, f.created_at]);
        if (st.clicked) { await finishFollowup(f.id, 'skipped', 'tapped the link'); continue; }
        if (st.replied) { await finishFollowup(f.id, 'skipped', 'they replied'); continue; }
        if (!st.in_window) { await finishFollowup(f.id, 'skipped', "outside Meta's 24 h window"); continue; }
        if (await overHourlyCap(f.account_id)) {   // try again next tick (window permitting)
          await pool.query(`UPDATE ig_automation_followups SET status = 'pending', due_at = now() + interval '5 minutes' WHERE id = $1`, [f.id]);
          continue;
        }
        const eventId = `followup:${f.id}`;
        await claim(rule, { eventId, userId: f.peer_id, text: 'Follow-up' }, 'followup');
        const message = await trackLinks(rule, followupMessage(rule), f.peer_id);
        const sent = await sendWithFallback(f.account_id, { id: f.peer_id }, message, { text: clip(rule.followup_text, 1000) }, `rule ${rule.id} follow-up`);
        await finish(rule, eventId, { status: 'sent', dmMessageId: sent.mid });
        await finishFollowup(f.id, 'sent', null, sent.mid);
        console.log(`[automation] rule ${rule.id} follow-up → sent`);
      } catch (e) {
        await finishFollowup(f.id, 'skipped', clip(e.message, 300)).catch(() => {});
        await pool.query(`UPDATE ig_automation_log SET status = 'failed', error = $2 WHERE event_id = $1`, [`followup:${f.id}`, clip(e.message, 300)]).catch(() => {});
        console.warn(`[automation] follow-up ${f.id} failed: ${e.message}`);
      }
      await sleep(400);
    }
  } catch (e) { console.warn('[automation] follow-ups:', e.message); }
  finally { followupsRunning = false; }
}
function start() {
  setTimeout(runFollowups, 45 * 1000);
  setInterval(runFollowups, 60 * 1000);
}

// ── comment trigger ─────────────────────────────────────────
async function onInstagramComment({ accountId, comment }) {
  const v = comment || {};
  if (!accountId || !v.id) return;
  // Flow Builder automations run alongside rules (each dedupes on its own).
  require('./flowEngine').onComment({ accountId, comment }).catch(e => console.warn('[flow] comment:', e.message));
  const rules = await activeRules(accountId, 'comment');
  if (!rules.length) return;

  // Never react to the account's own comments (incl. our public replies, which
  // come back through the same webhook).
  if (v.from?.id === accountId) return;
  const ownUsername = await accountUsername(accountId);
  if (ownUsername && v.from?.username === ownUsername) return;

  const mediaId = v.media?.id || null;
  for (const rule of rules) {
    if (rule.media_id && rule.media_id !== mediaId) continue;
    if (v.parent_id && !rule.include_replies) continue;
    if (!matches(rule, v.text)) continue;

    const fields = { eventId: v.id, mediaId, userId: v.from?.id, username: v.from?.username, text: v.text };
    if (rule.once_per_user && v.from?.id) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ig_automation_log
          WHERE rule_id = $1 AND media_id IS NOT DISTINCT FROM $2 AND user_id = $3
            AND status IN ('sent','partial','pending') LIMIT 1`, [rule.id, mediaId, v.from.id]);
      if (rows.length) {
        if (await claim(rule, fields)) await finish(rule, v.id, { status: 'skipped', error: 'already handled this user on this post' });
        continue;
      }
    }
    const capped = await overHourlyCap(accountId);
    if (!await claim(rule, fields)) continue;
    if (capped) {
      await finish(rule, v.id, { status: 'skipped', error: `hourly cap (${MAX_PER_HOUR}) reached` });
      console.warn(`[automation] account ${accountId} hit the hourly cap — skipped comment ${v.id}`);
      continue;
    }
    const createdMs = v.created_time ? Number(v.created_time) * 1000 : Date.now();
    if (Date.now() - createdMs > PRIVATE_REPLY_WINDOW_MS) {
      await finish(rule, v.id, { status: 'skipped', error: 'comment older than 7 days (Meta private-reply window)' });
      continue;
    }
    await humanDelay('comment');

    let publicReplyId = null, dmMessageId = null;
    const errors = [];
    if (rule.reply_texts?.length) {
      try {
        const instagram = require('../instagram');
        publicReplyId = (await instagram.replyToComment({ commentId: v.id, accountId, message: pick(rule.reply_texts) })).id;
      } catch (e) { errors.push('public reply: ' + e.message); }
    }
    const wantsDm = !!rule.dm_message || needsGate(rule);
    if (wantsDm) {
      try {
        let sent;
        if (needsGate(rule)) {
          // The one allowed private reply is a "tap to get it" button; the content,
          // follow check and questions come after the tap (24 h window is then open).
          const g = gateMessage(
            rule.gate_text || 'Thanks for your comment! Tap below and I will send it right over.',
            rule.gate_button || 'Send it',
            `${GATE_PREFIX}${rule.id}:${mediaId || ''}`);
          sent = await sendWithFallback(accountId, { comment_id: v.id }, g.message, g.fallback, `rule ${rule.id} gate`);
          await applyTags(accountId, sent.recipientId, rule.tags, v.from?.username).catch(() => {});
        } else {
          sent = await sendRuleDm(rule, { comment_id: v.id }, v.from?.id);
          await applyTags(accountId, sent.recipientId, rule.tags, v.from?.username).catch(() => {});
        }
        dmMessageId = sent.mid;
      } catch (e) { errors.push('dm: ' + e.message); }
    }
    const wanted = (rule.reply_texts?.length ? 1 : 0) + (wantsDm ? 1 : 0);
    const status = !errors.length ? 'sent' : errors.length < wanted ? 'partial' : 'failed';
    await finish(rule, v.id, { status, publicReplyId, dmMessageId, error: errors.join(' | ') || null });
    console.log(`[automation] rule ${rule.id} "${rule.name}" on comment ${v.id} by @${v.from?.username}: ${status}${errors.length ? ' — ' + errors.join(' | ') : ''}`);
  }
}

// ── gate tap: follow check → content (+ questions) ──────────
async function handleGateTap({ accountId, peerId, payload, eventId }) {
  const [ruleIdStr, mediaId] = payload.slice(GATE_PREFIX.length).split(':');
  const rule = await getRule(Number(ruleIdStr));
  if (!rule || !rule.active || rule.account_id !== accountId) return;
  if (!await claim(rule, { eventId, mediaId, userId: peerId, text: payload }, 'gate')) return;
  await humanDelay();
  try {
    if (rule.follow_gate) {
      let follows = true, note = null;
      try { follows = await followsAccount(accountId, peerId); }
      catch (e) { note = `follow check unavailable (${e.message}) — delivered anyway`; }
      if (!follows) {
        const username = await accountUsername(accountId);
        const g = gateMessage(
          (rule.follow_gate_text || 'Almost there! Please follow @{account} first, then tap the button below.')
            .replace(/\{account\}/g, username || 'us'),
          "I've followed", payload);
        const sent = await sendWithFallback(accountId, { id: peerId }, g.message, g.fallback, `rule ${rule.id} follow-gate`);
        await finish(rule, eventId, { status: 'skipped', dmMessageId: sent.mid, error: 'not following yet — asked to follow' });
        return;
      }
      if (note) console.warn(`[automation] rule ${rule.id}: ${note}`);
    }
    const mid = await deliverContent(rule, peerId, { mediaId: mediaId || null });
    await finish(rule, eventId, { status: 'sent', dmMessageId: mid });
    console.log(`[automation] rule ${rule.id} "${rule.name}" gate tap → delivered`);
  } catch (e) {
    await finish(rule, eventId, { status: 'failed', error: e.message });
    console.warn(`[automation] rule ${rule.id} gate tap failed: ${e.message}`);
  }
}

// ── capture: validate answer → next question / finish ───────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateAnswer(type, raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false };
  if (type === 'email') return EMAIL_RE.test(s) ? { ok: true, value: s.toLowerCase() } : { ok: false };
  if (type === 'phone') {
    const digits = s.replace(/[^\d]/g, '');
    return digits.length >= 7 && digits.length <= 15 ? { ok: true, value: (s.trim().startsWith('+') ? '+' : '') + digits } : { ok: false };
  }
  return { ok: true, value: s.slice(0, 500) };
}

async function handleCaptureAnswer({ accountId, peerId, text, session }) {
  const rule = await getRule(session.rule_id);
  const collect = Array.isArray(rule?.collect) ? rule.collect : [];
  if (!rule || !collect[session.step]) {
    await pool.query('DELETE FROM ig_automation_sessions WHERE account_id = $1 AND peer_id = $2', [accountId, peerId]);
    return;
  }
  if (/^\s*(stop|cancel)\s*$/i.test(text || '')) {
    await pool.query('DELETE FROM ig_automation_sessions WHERE account_id = $1 AND peer_id = $2', [accountId, peerId]);
    await sendMessage(accountId, { id: peerId }, { text: 'No problem, I have stopped. Message us any time if you need anything.' });
    return;
  }
  const field = collect[session.step];
  const data = { ...(session.data || {}) };
  const check = validateAnswer(field.type, text);
  if (!check.ok) {
    const tries = (data._retries || 0) + 1;
    if (tries < 3) {
      data._retries = tries;
      await pool.query(`UPDATE ig_automation_sessions SET data = $3, expires_at = now() + ${SESSION_TTL} WHERE account_id = $1 AND peer_id = $2`,
        [accountId, peerId, JSON.stringify(data)]);
      await sendMessage(accountId, { id: peerId }, {
        text: `That doesn't look like a valid ${(field.label || field.type).toLowerCase()}. Please try again (or type STOP to cancel).` });
      return;
    }
    data[field.key] = String(text || '').trim().slice(0, 500);   // 3 strikes: keep what they typed, move on
  } else {
    data[field.key] = check.value;
  }
  delete data._retries;
  // Mirror the answer into the contact's custom fields (Contacts → profile, {variables}, conditions).
  pool.query(
    `INSERT INTO ig_contact_fields (account_id, peer_id, key, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id, peer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [accountId, peerId, field.key, String(data[field.key] ?? '').slice(0, 2000)])
    .then(() => pool.query(`INSERT INTO contact_field_defs (key, name, type) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [field.key, field.label || field.key, ['email', 'phone'].includes(field.type) ? field.type : 'text']))
    .catch(() => {});
  const next = session.step + 1;

  if (next < collect.length) {
    await pool.query(`UPDATE ig_automation_sessions SET step = $3, data = $4, expires_at = now() + ${SESSION_TTL} WHERE account_id = $1 AND peer_id = $2`,
      [accountId, peerId, next, JSON.stringify(data)]);
    await sendMessage(accountId, { id: peerId }, { text: collect[next].prompt });
    return;
  }

  // Done — save the lead, optionally push to Sheets, thank them.
  await pool.query('DELETE FROM ig_automation_sessions WHERE account_id = $1 AND peer_id = $2', [accountId, peerId]);
  const { _username, ...answers } = data;
  let username = _username || null;
  if (!username) {
    const { rows } = await pool.query(
      `SELECT COALESCE(c.username, u.username) AS username FROM (SELECT 1) _
         LEFT JOIN contacts c ON c.platform = 'instagram' AND c.account_id = $1 AND c.peer_id = $2
         LEFT JOIN instagram_users u ON u.igsid = $2`, [accountId, peerId]);
    username = rows[0]?.username || null;
  }
  const { rows: leadRows } = await pool.query(
    `INSERT INTO ig_automation_leads (account_id, peer_id, username, rule_id, media_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, peer_id, rule_id) DO UPDATE
       SET data = ig_automation_leads.data || EXCLUDED.data, username = COALESCE(EXCLUDED.username, ig_automation_leads.username),
           media_id = COALESCE(EXCLUDED.media_id, ig_automation_leads.media_id), updated_at = now()
     RETURNING id`,
    [accountId, peerId, username, rule.id, session.media_id || null, JSON.stringify(answers)]);
  if (answers.name) {
    await pool.query(`UPDATE contacts SET name = COALESCE(name, $3) WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`,
      [accountId, peerId, answers.name]).catch(() => {});
  }
  if (rule.sheet_id && rule.sheet_tab) {
    let sheetStatus = 'appended';
    try {
      const sheets = require('./sheetsAgentOps');
      await sheets.executeOp({ op: 'append', toolConfig: { spreadsheet_id: rule.sheet_id, sheet_name: rule.sheet_tab },
        args: { values: [new Date().toISOString(), username ? '@' + username : peerId, ...collect.map(f => answers[f.key] ?? ''), rule.name, session.media_id || ''] } });
    } catch (e) { sheetStatus = clip(e.message, 300); console.warn(`[automation] rule ${rule.id} sheet append failed: ${e.message}`); }
    await pool.query('UPDATE ig_automation_leads SET sheet_status = $2 WHERE id = $1', [leadRows[0].id, sheetStatus]).catch(() => {});
  }
  await sendMessage(accountId, { id: peerId }, {
    text: rule.collect_done_text || 'Thank you! We have your details and will get back to you shortly.' });
  console.log(`[automation] rule ${rule.id} captured lead from ${username ? '@' + username : peerId}`);
}

// ── dm / postback / story triggers ──────────────────────────
// `ev` is the raw Messenger-platform event from entry.messaging[].
async function onInstagramMessaging({ accountId, ev }) {
  if (!accountId || !ev || ev.message?.is_echo) return;
  const peerId = ev.sender?.id;
  if (!peerId || peerId === accountId) return;
  await ensureSchema();

  // A quick-reply tap arrives as a message with quick_reply.payload — treat it
  // like a button postback so one rule handles both.
  const payload = ev.postback?.payload || ev.message?.quick_reply?.payload || null;
  const eventId = ev.message?.mid || ev.postback?.mid || `${peerId}:${ev.timestamp}`;

  if (payload && payload.startsWith(GATE_PREFIX)) return handleGateTap({ accountId, peerId, payload, eventId });
  // Flow Builder: a flow button/quick-reply tap, or a flow waiting for this person's answer.
  const flows = require('./flowEngine');
  if (await flows.onMessaging({ accountId, ev }).catch(e => { console.warn('[flow] messaging:', e.message); return false; })) return;

  // An open question-and-answer conversation takes every plain text reply.
  if (!payload && ev.message) {
    const { rows } = await pool.query(
      'SELECT * FROM ig_automation_sessions WHERE account_id = $1 AND peer_id = $2 AND expires_at > now()', [accountId, peerId]);
    if (rows[0]) return handleCaptureAnswer({ accountId, peerId, text: ev.message.text || '', session: rows[0] });
  }

  const atts = Array.isArray(ev.message?.attachments) ? ev.message.attachments : [];
  const trigger = payload ? 'postback'
    : atts.some(a => a?.type === 'story_mention') ? 'story_mention'
    : ev.message?.reply_to?.story ? 'story_reply'
    : ev.message ? 'dm' : null;
  if (!trigger) return;
  const text = payload || ev.message?.text || '';

  const rules = await activeRules(accountId, trigger);
  let ruleFired = false;
  for (const rule of rules) {
    if (!rule.dm_message && !(Array.isArray(rule.collect) && rule.collect.length)) continue;
    if (trigger === 'postback' ? !(rule.keywords || []).some(k => String(k).toLowerCase() === text.toLowerCase())
      : trigger === 'story_mention' ? false
      : !matches(rule, text)) continue;
    const capped = await overHourlyCap(accountId);
    if (!await claim(rule, { eventId, userId: peerId, text: text || `(${trigger.replace('_', ' ')})` })) continue;
    ruleFired = true;
    if (capped) {
      await finish(rule, eventId, { status: 'skipped', error: `hourly cap (${MAX_PER_HOUR}) reached` });
      break;
    }
    await humanDelay();
    try {
      // "Only for followers": check now — they just messaged us, so Meta allows the lookup.
      if (rule.follow_gate) {
        let follows = true;
        try { follows = await followsAccount(accountId, peerId); }
        catch (e) { console.warn(`[automation] rule ${rule.id}: follow check unavailable (${e.message}) — delivering anyway`); }
        if (!follows) {
          const username = await accountUsername(accountId);
          const g = gateMessage(
            (rule.follow_gate_text || 'Almost there! Please follow @{account} first, then tap the button below.')
              .replace(/\{account\}/g, username || 'us'),
            "I've followed", `${GATE_PREFIX}${rule.id}:`);
          const sent = await sendWithFallback(accountId, { id: peerId }, g.message, g.fallback, `rule ${rule.id} follow-gate`);
          await finish(rule, eventId, { status: 'skipped', dmMessageId: sent.mid, error: 'not following yet — asked to follow' });
          break;
        }
      }
      const mid = await deliverContent(rule, peerId, {});
      await finish(rule, eventId, { status: 'sent', dmMessageId: mid });
      console.log(`[automation] rule ${rule.id} "${rule.name}" (${trigger}${text ? ' "' + clip(text, 40) + '"' : ''}) → sent`);
    } catch (e) {
      await finish(rule, eventId, { status: 'failed', error: e.message });
      console.warn(`[automation] rule ${rule.id} "${rule.name}" (${trigger}) failed: ${e.message}`);
    }
    break;   // first matching rule wins for DMs, so one message gets one reply
  }
  // No rule answered → a Flow Builder DM / story trigger may.
  if (!ruleFired && trigger !== 'postback') await flows.onMessagingTrigger({ accountId, ev }).catch(e => console.warn('[flow] trigger:', e.message));
}

// Called by agentDispatch before an AI agent answers a DM: true when this module
// owns the conversation right now (an open question flow, or the latest message
// is a quick-reply tap / story event that an automation rule handles).
async function isHandling(accountId, peerId) {
  try {
    await ensureSchema();
    if (await require('./flowEngine').isHandling(accountId, peerId)) return true;
    const { rows: s } = await pool.query(
      'SELECT 1 FROM ig_automation_sessions WHERE account_id = $1 AND peer_id = $2 AND expires_at > now()', [accountId, peerId]);
    if (s.length) return true;
    const { rows } = await pool.query(
      `SELECT raw FROM instagram_messages
        WHERE account_id = $1 AND sender_id = $2 AND direction = 'incoming'
        ORDER BY ts DESC LIMIT 1`, [accountId, peerId]);
    const m = rows[0]?.raw?.message;
    if (!m) return false;
    if (m.quick_reply?.payload) return true;
    const trig = (m.attachments || []).some(a => a?.type === 'story_mention') ? 'story_mention' : m.reply_to?.story ? 'story_reply' : null;
    if (trig) return (await activeRules(accountId, trig)).length > 0;
    return false;
  } catch (_) { return false; }
}

// Meta data-deletion callback: drop everything we stored about this user.
async function deleteUserData(userId) {
  if (!userId) return;
  await ensureSchema();
  await pool.query('DELETE FROM ig_automation_log WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM ig_automation_sessions WHERE peer_id = $1', [userId]);
  await pool.query('DELETE FROM ig_automation_leads WHERE peer_id = $1', [userId]);
  await pool.query('DELETE FROM ig_automation_followups WHERE peer_id = $1', [userId]);
  await pool.query('UPDATE ig_automation_links SET peer_id = NULL WHERE peer_id = $1', [userId]);
  await require('./flowEngine').deleteUserData(userId).catch(() => {});
}

// ── CRUD + reads (used by commentAutomationRoutes.js) ───────
const FIELDS = ['name', 'account_id', 'trigger', 'media_id', 'keywords', 'match_type', 'reply_texts',
  'dm_message', 'dm_fallback_text', 'once_per_user', 'include_replies', 'active',
  'tags', 'follow_gate', 'gate_text', 'gate_button', 'follow_gate_text',
  'collect', 'collect_done_text', 'sheet_id', 'sheet_tab', 'opening_dm',
  'followup_enabled', 'followup_delay_min', 'followup_text', 'followup_link'];

function clean(body, { partial = false } = {}) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (!partial && (!out.name || !out.account_id)) throw new Error('name and account_id are required');
  if (out.trigger && !TRIGGERS.includes(out.trigger)) throw new Error(`trigger must be one of ${TRIGGERS.join(', ')}`);
  if (out.match_type && !['contains', 'exact', 'starts_with'].includes(out.match_type)) throw new Error('match_type must be contains, exact or starts_with');
  for (const f of ['keywords', 'reply_texts', 'tags'])
    if (out[f] !== undefined && !Array.isArray(out[f])) throw new Error(`${f} must be an array`);
  if (out.media_id === '') out.media_id = null;
  if (out.followup_delay_min !== undefined) out.followup_delay_min = Math.min(23 * 60, Math.max(15, parseInt(out.followup_delay_min, 10) || 240));
  if (out.followup_text !== undefined) out.followup_text = String(out.followup_text || '').trim().slice(0, 640) || null;
  if (out.followup_enabled && out.followup_text === null) throw new Error('the follow-up needs a message');
  if (typeof out.dm_message === 'string') out.dm_message = out.dm_message.trim() ? { text: out.dm_message } : null;
  if (out.dm_message !== undefined && out.dm_message !== null) out.dm_message = JSON.stringify(out.dm_message);
  if (out.collect !== undefined) {
    if (!Array.isArray(out.collect)) throw new Error('collect must be an array');
    const seen = new Set();
    out.collect = JSON.stringify(out.collect.map((f, i) => {
      const type = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
      let key = String(f?.key || type).toLowerCase().replace(/[^a-z0-9_]/g, '_') || `field_${i + 1}`;
      while (seen.has(key)) key += '_' + (i + 1);
      seen.add(key);
      if (!String(f?.prompt || '').trim()) throw new Error(`collect field ${i + 1} must have a question (prompt)`);
      return { key, type, label: String(f?.label || type).slice(0, 60), prompt: String(f.prompt).trim().slice(0, 1000) };
    }));
  }
  return out;
}

async function listRules(accountId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT COUNT(*)::int FROM ig_automation_log l WHERE l.rule_id = r.id AND l.status IN ('sent','partial') AND l.trigger <> 'followup') AS fired,
            (SELECT MAX(created_at) FROM ig_automation_log l WHERE l.rule_id = r.id AND l.status IN ('sent','partial') AND l.trigger <> 'followup') AS last_fired_at,
            (SELECT COUNT(*)::int FROM ig_automation_leads d WHERE d.rule_id = r.id) AS leads,
            (SELECT COUNT(DISTINCT send_id)::int FROM ig_automation_links k WHERE k.rule_id = r.id AND k.clicked_at IS NOT NULL) AS clicks,
            (SELECT COUNT(DISTINCT send_id)::int FROM ig_automation_links k WHERE k.rule_id = r.id) AS link_sends,
            (SELECT COUNT(*)::int FROM ig_automation_log l WHERE l.rule_id = r.id AND l.status IN ('sent','partial') AND l.dm_message_id IS NOT NULL AND l.trigger <> 'followup') AS dms,
            p.thumbnail_url AS media_thumbnail, COALESCE(p.caption, p.title) AS media_caption, p.permalink AS media_permalink,
            p.likes AS media_likes, p.comments AS media_comments,
            a.username AS account_username
       FROM ig_automation_rules r
       LEFT JOIN LATERAL (SELECT thumbnail_url, caption, title, permalink, likes, comments FROM posts WHERE external_id = r.media_id LIMIT 1) p ON true
       LEFT JOIN instagram_accounts a ON a.account_id = r.account_id
      WHERE ($1::text IS NULL OR r.account_id = $1)
      ORDER BY r.id`, [accountId || null]);
  for (const r of rows) r.ctr = ruleCtr(r, r);
  return rows;
}

async function createRule(body) {
  await ensureSchema();
  const r = clean(body);
  const cols = Object.keys(r);
  const { rows } = await pool.query(
    `INSERT INTO ig_automation_rules (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
    cols.map(c => r[c]));
  return rows[0];
}

async function updateRule(id, body) {
  await ensureSchema();
  const r = clean(body, { partial: true });
  const cols = Object.keys(r);
  if (!cols.length) throw new Error('nothing to update');
  const { rows } = await pool.query(
    `UPDATE ig_automation_rules SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`, [id, ...cols.map(c => r[c])]);
  return rows[0] || null;
}

async function deleteRule(id) {
  await ensureSchema();
  const { rowCount } = await pool.query('DELETE FROM ig_automation_rules WHERE id = $1', [id]);
  return rowCount > 0;
}

async function listLog({ ruleId, accountId, limit = 100 } = {}) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT l.*, COALESCE(NULLIF(l.username, ''), u.username, c.username) AS username,
            COALESCE(u.name, c.name) AS name, COALESCE(c.profile_pic, u.profile_pic) AS profile_pic,
            c.id AS contact_id, r.name AS rule_name
       FROM ig_automation_log l LEFT JOIN ig_automation_rules r ON r.id = l.rule_id
       -- DM / button / story webhooks carry only the sender's id: name them from
       -- the resolved profile cache or the contact (zero Graph calls).
       LEFT JOIN instagram_users u ON u.igsid = l.user_id
       LEFT JOIN contacts c ON c.platform = 'instagram' AND c.account_id = l.account_id AND c.peer_id = l.user_id
      WHERE ($1::int IS NULL OR l.rule_id = $1) AND ($2::text IS NULL OR l.account_id = $2)
      ORDER BY l.created_at DESC LIMIT $3`,
    [ruleId || null, accountId || null, Math.min(Number(limit) || 100, 500)]);
  return rows;
}

async function listLeads({ accountId, ruleId, limit = 500 } = {}) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT d.*, COALESCE(NULLIF(d.username, ''), u.username, c.username) AS username,
            r.name AS rule_name, r.collect AS rule_fields
       FROM ig_automation_leads d LEFT JOIN ig_automation_rules r ON r.id = d.rule_id
       LEFT JOIN instagram_users u ON u.igsid = d.peer_id
       LEFT JOIN contacts c ON c.platform = 'instagram' AND c.account_id = d.account_id AND c.peer_id = d.peer_id
      WHERE ($1::text IS NULL OR d.account_id = $1) AND ($2::int IS NULL OR d.rule_id = $2)
      ORDER BY d.updated_at DESC LIMIT $3`,
    [accountId || null, ruleId || null, Math.min(Number(limit) || 500, 2000)]);
  return rows;
}

// Accounts that can run automations (visible IG accounts with a username).
async function listAccounts() {
  const { rows } = await pool.query(
    `SELECT account_id, username, name FROM instagram_accounts
      WHERE NOT COALESCE(hidden, false) AND username IS NOT NULL
        AND (token IS NOT NULL OR page_id IS NOT NULL)
      ORDER BY username`);
  return rows;
}

// Posts/reels of one account for the post picker (DB only, zero Graph calls).
async function listPosts(accountId) {
  if (!accountId) return [];
  const { rows } = await pool.query(
    `SELECT p.external_id AS id, COALESCE(p.caption, p.title) AS caption, p.thumbnail_url AS thumbnail,
            p.permalink, p.date, p.media_type, p.comments, p.likes
       FROM posts p JOIN platforms pl ON pl.id = p.platform_id
      WHERE pl.key = 'instagram' AND p.account_key = $1 AND p.external_id IS NOT NULL
      ORDER BY p.date DESC NULLS LAST LIMIT 60`, [accountId]);
  return rows;
}

// CTR = people who tapped a link ÷ DMs that carried one. DMs sent before link
// tracking existed have no ig_automation_links row, so when the rule's DM has a
// link every delivered DM counts (not just the tracked ones — that overstated it).
function ruleCtr(rule, { clicks = 0, link_sends = 0, dms = 0 }) {
  const hasLink = JSON.stringify(rule?.dm_message || {}).includes('web_url');
  const base = Math.max(link_sends || 0, hasLink ? dms || 0 : 0);
  return base ? Math.round((clicks / base) * 100) : null;
}

// Insights for one rule: DMs delivered, link clicks, CTR, leads + a daily series.
async function ruleInsights(id, days = 30) {
  await ensureSchema();
  const n = Math.min(Math.max(parseInt(days, 10) || 30, 7), 90);
  const { rows: [rule] } = await pool.query('SELECT dm_message FROM ig_automation_rules WHERE id = $1', [id]);
  const [{ rows: [t] }, { rows: [k] }, { rows: daily }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('sent','partial') AND dm_message_id IS NOT NULL AND trigger <> 'followup')::int AS dms,
              COUNT(*) FILTER (WHERE trigger = 'followup' AND status = 'sent')::int AS followups,
              COUNT(*) FILTER (WHERE status IN ('sent','partial') AND public_reply_id IS NOT NULL)::int AS public_replies,
              COUNT(*) FILTER (WHERE status IN ('sent','partial') AND trigger NOT IN ('gate','followup'))::int AS triggered,
              COUNT(*) FILTER (WHERE trigger = 'gate' AND status = 'sent')::int AS gate_taps,
              COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              (SELECT COUNT(*)::int FROM ig_automation_leads d WHERE d.rule_id = $1) AS leads
         FROM ig_automation_log WHERE rule_id = $1`, [id]),
    pool.query(
      `SELECT COUNT(DISTINCT send_id)::int AS link_sends,
              COUNT(DISTINCT send_id) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicks,
              COALESCE(SUM(clicks), 0)::int AS total_clicks
         FROM ig_automation_links WHERE rule_id = $1`, [id]),
    pool.query(
      `WITH d AS (SELECT generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - ($2::int - 1), (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day)
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT COUNT(*)::int FROM ig_automation_log l WHERE l.rule_id = $1 AND l.status IN ('sent','partial') AND l.dm_message_id IS NOT NULL AND l.trigger <> 'followup'
                  AND (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS sends,
              (SELECT COUNT(DISTINCT send_id)::int FROM ig_automation_links k WHERE k.rule_id = $1
                  AND (k.clicked_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS clicks
         FROM d ORDER BY d.day`, [id, n]),
  ]);
  return {
    sends: t.dms, followups: t.followups, triggered: t.triggered, publicReplies: t.public_replies, gateTaps: t.gate_taps,
    skipped: t.skipped, failed: t.failed, leads: t.leads,
    linkSends: k.link_sends, clicks: k.clicks, totalClicks: k.total_clicks,
    ctr: ruleCtr(rule, { clicks: k.clicks, link_sends: k.link_sends, dms: t.dms }),
    trackingEnabled: TRACK_LINKS, daily,
  };
}

function meta() {
  let sheetsEmail = null;
  try { sheetsEmail = require('./sheetsAgentOps').serviceAccountEmail(); } catch (_) {}
  return { triggers: TRIGGERS, fieldTypes: FIELD_TYPES, maxPerHour: MAX_PER_HOUR, trackLinks: TRACK_LINKS, sheetsConfigured: !!sheetsEmail, sheetsEmail };
}

module.exports = {
  ensureSchema,
  // shared with services/flowEngine.js
  _shared: { sendMessage, followsAccount, applyTags, accountUsername, matches, MAX_PER_HOUR, PUBLIC_BASE, TRACK_LINKS },
  onInstagramComment, onInstagramMessaging, isHandling, deleteUserData, start, runFollowups,
  listRules, createRule, updateRule, deleteRule, listLog, listLeads, listAccounts, listPosts, meta,
  ruleInsights, resolveLink,
};
