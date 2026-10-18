// Telegram bot — Social → Settings → Integrations → Telegram.
//
// One bot per instance (singleton row). The token is stored AES-encrypted and
// can be replaced at any time; replacing it restarts the poller on the new bot.
//
// Receiving: LONG POLLING (getUpdates), not a webhook — it needs no public URL
// and no nginx route, and only this backend process reads the bot. Telegram
// allows ONE reader per bot: a webhook set elsewhere, or a second process
// polling the same token, answers 409 and is reported as such. Set
// SOCIAL_TELEGRAM_POLLING=off on a test stack that shares a live token.
//
// Who the bot answers: every chat that writes to it (a person, or a group it is
// added to) is recorded. In 'approved' mode (default) a new chat is 'pending'
// and the bot only tells it to wait; an admin approves it in the chat list. In
// 'everyone' mode a new chat is approved on first contact. A 'blocked' chat is
// stored but never answered. Only approved chats can receive comment alerts.
//
// Every message in and out is stored in telegram_messages (the chat viewer).
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');

const API = 'https://api.telegram.org';
const MODES = ['approved', 'everyone'];
const STATUSES = ['pending', 'approved', 'blocked'];
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const DEFAULT_PENDING_REPLY = "Hi! This bot sends Forge Growth alerts. An admin needs to approve this chat before it can receive anything — I've let them know.";

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_bot (
        id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        token_encrypted text,
        bot_id          bigint,
        bot_username    text,
        bot_name        text,
        status          text NOT NULL DEFAULT 'disconnected',   -- connected | error | disconnected
        last_error      text,
        update_offset   bigint NOT NULL DEFAULT 0,
        access_mode     text NOT NULL DEFAULT 'approved',
        pending_reply   text,
        connected_at    timestamptz,
        last_poll_at    timestamptz,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS telegram_chats (
        chat_id          bigint PRIMARY KEY,
        type             text NOT NULL,                  -- private | group | supergroup | channel
        title            text,
        username         text,
        first_name       text,
        last_name        text,
        status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','blocked')),
        bot_member       boolean NOT NULL DEFAULT true,  -- false = bot was removed / blocked by the user
        note             text,
        first_seen_at    timestamptz NOT NULL DEFAULT now(),
        last_message_at  timestamptz,
        status_changed_at timestamptz,
        status_changed_by int
      );
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id          bigserial PRIMARY KEY,
        chat_id     bigint NOT NULL,
        message_id  bigint,
        direction   text NOT NULL CHECK (direction IN ('in','out')),
        kind        text NOT NULL DEFAULT 'message',      -- message | command | alert | reply | manual | system
        from_id     bigint,
        from_name   text,
        text        text,
        status      text NOT NULL DEFAULT 'ok',           -- ok | failed
        error       text,
        meta        jsonb,
        sent_by     int,
        ts          timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_messages_msg ON telegram_messages (chat_id, message_id, direction) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages (chat_id, ts DESC);
      INSERT INTO telegram_bot (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `).catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function getRow() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM telegram_bot WHERE id = 1');
  return rows[0];
}
async function getToken() {
  const r = await getRow();
  return r?.token_encrypted ? decrypt(r.token_encrypted) : null;
}

// ── Bot API ──
class TelegramError extends Error {
  constructor(message, code, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter; }
}
async function call(token, method, body, { signal, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: ctl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new TelegramError(j.description || `Telegram ${method} failed (${res.status})`, j.error_code || res.status, j.parameters?.retry_after);
    return j.result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ── public shape ──
async function status() {
  const r = await getRow();
  const token = r.token_encrypted ? decrypt(r.token_encrypted) : null;
  const { rows: [c] } = await pool.query(`SELECT count(*) FILTER (WHERE status='approved')::int AS approved,
      count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='blocked')::int AS blocked FROM telegram_chats`);
  return {
    configured: !!token,
    tokenMasked: token ? maskSecret(token) : null,
    status: r.status, lastError: r.last_error,
    bot: r.bot_id ? { id: String(r.bot_id), username: r.bot_username, name: r.bot_name, link: r.bot_username ? `https://t.me/${r.bot_username}` : null } : null,
    accessMode: r.access_mode,
    pendingReply: r.pending_reply || DEFAULT_PENDING_REPLY,
    connectedAt: r.connected_at, lastPollAt: r.last_poll_at,
    polling: pollingEnabled() ? (poller.running ? 'running' : 'stopped') : 'disabled',
    chats: c,
  };
}

// Validate a token against Telegram BEFORE storing it — a bad token is refused, not saved.
async function connect(rawToken) {
  const token = String(rawToken || '').trim();
  if (!TOKEN_RE.test(token)) throw new Error('That does not look like a bot token. It looks like 123456789:AAH… — copy it from @BotFather.');
  let me;
  try { me = await call(token, 'getMe'); }
  catch (e) { throw new Error(e.code === 401 || e.code === 404 ? 'Telegram rejected this token. Copy it again from @BotFather.' : `Could not reach Telegram: ${e.message}`); }
  if (!me?.is_bot) throw new Error('This token does not belong to a bot.');
  // Long polling and a webhook cannot both be active; drop any webhook (keeps queued updates).
  await call(token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  const prev = await getRow();
  const sameBot = prev.bot_id && String(prev.bot_id) === String(me.id);
  await pool.query(`UPDATE telegram_bot SET token_encrypted = $1, bot_id = $2, bot_username = $3, bot_name = $4,
      status = 'connected', last_error = NULL, connected_at = now(), updated_at = now(),
      update_offset = CASE WHEN $5 THEN update_offset ELSE 0 END WHERE id = 1`,
    [encrypt(token), me.id, me.username || null, me.first_name || null, sameBot]);
  restartPolling();
  return status();
}

async function disconnect() {
  await getRow();
  stopPolling();
  await pool.query(`UPDATE telegram_bot SET token_encrypted = NULL, status = 'disconnected', last_error = NULL, updated_at = now() WHERE id = 1`);
  return status();
}

async function saveAccess({ accessMode, pendingReply }) {
  await getRow();
  const sets = [], args = [];
  if (accessMode !== undefined) {
    if (!MODES.includes(accessMode)) throw new Error('accessMode must be approved or everyone');
    args.push(accessMode); sets.push(`access_mode = $${args.length}`);
  }
  if (pendingReply !== undefined) {
    const t = String(pendingReply ?? '').trim().slice(0, 1000);
    args.push(t || null); sets.push(`pending_reply = $${args.length}`);
  }
  if (sets.length) await pool.query(`UPDATE telegram_bot SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, args);
  return status();
}

// ── chats ──
const chatName = (c) => c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : String(c.chat_id));
function chatOut(c) {
  return {
    id: String(c.chat_id), type: c.type, name: chatName(c), username: c.username || null,
    status: c.status, botMember: c.bot_member, note: c.note || null,
    firstSeenAt: c.first_seen_at, lastMessageAt: c.last_message_at,
    lastText: c.last_text ?? undefined, lastDirection: c.last_direction ?? undefined, messageCount: c.message_count ?? undefined,
  };
}
async function listChats() {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT c.*, m.text AS last_text, m.direction AS last_direction,
           (SELECT count(*)::int FROM telegram_messages x WHERE x.chat_id = c.chat_id) AS message_count
      FROM telegram_chats c
      LEFT JOIN LATERAL (SELECT text, direction FROM telegram_messages WHERE chat_id = c.chat_id ORDER BY ts DESC, id DESC LIMIT 1) m ON true
     ORDER BY (c.status = 'pending') DESC, COALESCE(c.last_message_at, c.first_seen_at) DESC`);
  return rows.map(chatOut);
}
async function getChat(chatId) {
  const { rows } = await pool.query('SELECT * FROM telegram_chats WHERE chat_id = $1', [chatId]);
  return rows[0] || null;
}
async function messages(chatId, { before, limit = 100 } = {}) {
  await ensureSchema();
  const lim = Math.min(300, Math.max(1, parseInt(limit, 10) || 100));
  const args = [chatId, lim];
  let cond = '';
  if (before) { args.push(parseInt(before, 10)); cond = `AND id < $${args.length}`; }
  const { rows } = await pool.query(`SELECT * FROM telegram_messages WHERE chat_id = $1 ${cond} ORDER BY ts DESC, id DESC LIMIT $2`, args);
  return rows.reverse().map(m => ({
    id: String(m.id), direction: m.direction, kind: m.kind, fromName: m.from_name, text: m.text,
    status: m.status, error: m.error, ts: m.ts, meta: m.meta || null, sentBy: m.sent_by,
  }));
}
async function setChatStatus(chatId, status, userId, note) {
  if (!STATUSES.includes(status)) throw new Error('status must be pending, approved or blocked');
  const { rows } = await pool.query(`UPDATE telegram_chats SET status = $2, status_changed_at = now(), status_changed_by = $3,
      note = COALESCE($4, note) WHERE chat_id = $1 RETURNING *`, [chatId, status, userId || null, note ?? null]);
  if (!rows[0]) throw Object.assign(new Error('Chat not found'), { notFound: true });
  // Tell a person once they are approved, so they know it worked.
  if (status === 'approved' && rows[0].bot_member) {
    send(chatId, '✅ This chat is approved. You will receive Forge Growth alerts here. Send /help to see what I can do.', { kind: 'system' }).catch(() => {});
  }
  return chatOut(rows[0]);
}
async function deleteChat(chatId) {
  await pool.query('DELETE FROM telegram_messages WHERE chat_id = $1', [chatId]);
  const { rowCount } = await pool.query('DELETE FROM telegram_chats WHERE chat_id = $1', [chatId]);
  if (!rowCount) throw Object.assign(new Error('Chat not found'), { notFound: true });
  return { ok: true };
}

// ── sending ──
// Every send is logged. A 403 ("bot was blocked by the user" / "kicked from the
// group") marks the chat bot_member=false so the UI says why alerts stopped.
async function send(chatId, text, { kind = 'message', html = false, buttons = null, meta = null, sentBy = null, token = null } = {}) {
  const tok = token || await getToken();
  if (!tok) throw new Error('Telegram is not connected');
  const body = { chat_id: chatId, text: String(text).slice(0, 4096), disable_web_page_preview: true };
  if (html) body.parse_mode = 'HTML';
  if (buttons?.length) body.reply_markup = { inline_keyboard: buttons };
  let attempt = 0;
  for (;;) {
    try {
      const m = await call(tok, 'sendMessage', body);
      await pool.query(`INSERT INTO telegram_messages (chat_id, message_id, direction, kind, text, meta, sent_by, ts)
          VALUES ($1,$2,'out',$3,$4,$5,$6, now()) ON CONFLICT DO NOTHING`,
        [chatId, m.message_id, kind, html ? stripHtml(body.text) : body.text, meta ? JSON.stringify(meta) : null, sentBy]);
      await pool.query('UPDATE telegram_chats SET last_message_at = now(), bot_member = true WHERE chat_id = $1', [chatId]);
      return { ok: true, messageId: m.message_id };
    } catch (e) {
      if (e.code === 429 && attempt < 2) { attempt++; await sleep(Math.min(30, e.retryAfter || 3) * 1000); continue; }
      if (e.code === 403) await pool.query('UPDATE telegram_chats SET bot_member = false WHERE chat_id = $1', [chatId]).catch(() => {});
      await pool.query(`INSERT INTO telegram_messages (chat_id, direction, kind, text, status, error, meta, sent_by) VALUES ($1,'out',$2,$3,'failed',$4,$5,$6)`,
        [chatId, kind, html ? stripHtml(body.text) : body.text, e.message, meta ? JSON.stringify(meta) : null, sentBy]).catch(() => {});
      throw e;
    }
  }
}
// An admin typing into the chat viewer.
async function sendManual(chatId, text, userId) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Type a message first');
  const c = await getChat(chatId);
  if (!c) throw Object.assign(new Error('Chat not found'), { notFound: true });
  if (c.status === 'blocked') throw new Error('This chat is blocked. Approve it first.');
  return send(chatId, t, { kind: 'manual', sentBy: userId });
}

// ── receiving ──
const commandHandlers = new Map();   // '/recent' → async (chat) => text|{text,html,buttons}
function registerCommand(name, fn) { commandHandlers.set(name, fn); }

async function upsertChat(chat, { member } = {}) {
  const { rows: [bot] } = await pool.query('SELECT access_mode FROM telegram_bot WHERE id = 1');
  const initial = bot?.access_mode === 'everyone' ? 'approved' : 'pending';
  const { rows } = await pool.query(`
    INSERT INTO telegram_chats (chat_id, type, title, username, first_name, last_name, status, bot_member)
    VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, true))
    ON CONFLICT (chat_id) DO UPDATE SET type = EXCLUDED.type, title = EXCLUDED.title, username = EXCLUDED.username,
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
      bot_member = COALESCE($8, telegram_chats.bot_member)
    RETURNING *, (xmax = 0) AS inserted`,
    [chat.id, chat.type, chat.title || null, chat.username || null, chat.first_name || null, chat.last_name || null, initial, member ?? null]);
  return rows[0];
}

async function handleUpdate(u, token) {
  // Bot added to / removed from a group, or a person blocked / unblocked it.
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member?.status;
    const member = !['left', 'kicked'].includes(st);
    const c = await upsertChat(u.my_chat_member.chat, { member });
    const who = u.my_chat_member.from;
    await logIn(c.chat_id, null, 'system', who, member ? `Bot added (${st})` : `Bot removed (${st})`, u.my_chat_member.date);
    if (member && c.inserted && c.status === 'pending' && c.type !== 'private') {
      await replyPending(c, token);
    }
    return;
  }
  const msg = u.message || u.channel_post || u.edited_message;
  if (!msg?.chat) return;
  const c = await upsertChat(msg.chat, { member: true });
  const text = msg.text ?? msg.caption ?? (msg.new_chat_members ? null : `[${Object.keys(msg).find(k => ['photo', 'video', 'voice', 'document', 'sticker', 'audio', 'location', 'contact', 'animation'].includes(k)) || 'message'}]`);
  if (text == null) return;
  const isCmd = typeof msg.text === 'string' && msg.text.startsWith('/');
  await logIn(c.chat_id, msg.message_id, isCmd ? 'command' : 'message', msg.from || msg.sender_chat, text, msg.date, u.edited_message ? { edited: true } : null);
  await pool.query('UPDATE telegram_chats SET last_message_at = to_timestamp($2) WHERE chat_id = $1', [c.chat_id, msg.date]);
  if (u.edited_message || c.type === 'channel') return;

  if (c.status === 'blocked') return;
  if (c.status === 'pending') {
    // Answer a pending chat only on its first message or an explicit /start — never on every line.
    if (c.inserted || (isCmd && /^\/start\b/.test(msg.text))) await replyPending(c, token);
    return;
  }
  // approved
  if (!isCmd) {
    if (c.type === 'private') await send(c.chat_id, 'Got it. I only send alerts — try /help.', { kind: 'reply', token }).catch(() => {});
    return;
  }
  const name = msg.text.split(/[\s@]/)[0].toLowerCase();
  const reply = await runCommand(name, c).catch(e => `Something went wrong: ${e.message}`);
  if (reply) {
    const r = typeof reply === 'string' ? { text: reply } : reply;
    await send(c.chat_id, r.text, { kind: 'reply', html: !!r.html, buttons: r.buttons, token }).catch(() => {});
  }
}
async function runCommand(name, chat) {
  if (commandHandlers.has(name)) return commandHandlers.get(name)(chat);
  if (name === '/start' || name === '/help') {
    const extra = [...commandHandlers.keys()].map(k => `${k}`).join('  ');
    return `Forge Growth alerts bot.\n\nThis chat is approved. Commands: /help  /id${extra ? '  ' + extra : ''}`;
  }
  if (name === '/id') return `Chat id: ${chat.chat_id}`;
  return 'Unknown command. Send /help.';
}
async function replyPending(c, token) {
  const { rows: [bot] } = await pool.query('SELECT pending_reply FROM telegram_bot WHERE id = 1');
  await send(c.chat_id, (bot?.pending_reply || DEFAULT_PENDING_REPLY) + `\n\nChat id: ${c.chat_id}`, { kind: 'system', token }).catch(() => {});
}
async function logIn(chatId, messageId, kind, from, text, date, meta) {
  const fromName = from ? (from.title || [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null) : null;
  await pool.query(`INSERT INTO telegram_messages (chat_id, message_id, direction, kind, from_id, from_name, text, meta, ts)
      VALUES ($1,$2,'in',$3,$4,$5,$6,$7, to_timestamp($8)) ON CONFLICT DO NOTHING`,
    [chatId, messageId, kind, from?.id || null, fromName, text, meta ? JSON.stringify(meta) : null, date || Date.now() / 1000]);
}

// ── poller ──
const poller = { running: false, gen: 0, ctl: null };
function pollingEnabled() { return !/^(off|false|0|no)$/i.test(process.env.SOCIAL_TELEGRAM_POLLING || ''); }
function stopPolling() { poller.gen++; poller.running = false; try { poller.ctl?.abort(); } catch (_) {} }
function restartPolling() { stopPolling(); if (pollingEnabled()) loop(poller.gen).catch(() => {}); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loop(gen) {
  await ensureSchema();
  poller.running = true;
  let backoff = 2000;
  while (gen === poller.gen) {
    const row = await getRow().catch(() => null);
    const token = row?.token_encrypted ? decrypt(row.token_encrypted) : null;
    if (!token) { poller.running = false; return; }
    poller.ctl = new AbortController();
    try {
      const updates = await call(token, 'getUpdates', {
        offset: Number(row.update_offset) || 0, timeout: 25,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'my_chat_member'],
      }, { signal: poller.ctl.signal, timeoutMs: 35000 });
      if (gen !== poller.gen) return;
      for (const u of updates) {
        try { await handleUpdate(u, token); }
        catch (e) { console.error('[telegram] update', u.update_id, e.message); }
        // Advance past every update, handled or not — one bad update must not jam the queue.
        await pool.query('UPDATE telegram_bot SET update_offset = GREATEST(update_offset, $1) WHERE id = 1', [u.update_id + 1]);
      }
      await pool.query(`UPDATE telegram_bot SET last_poll_at = now(),
          status = CASE WHEN status = 'error' THEN 'connected' ELSE status END,
          last_error = CASE WHEN status = 'error' THEN NULL ELSE last_error END WHERE id = 1`);
      backoff = 2000;
    } catch (e) {
      if (gen !== poller.gen) return;
      const msg = e.code === 401 ? 'Telegram rejected the token (it may have been revoked in @BotFather). Paste a new one.'
        : e.code === 409 ? 'Another program is reading this bot (a webhook, or the same token running elsewhere). Telegram allows only one.'
        : `Telegram unreachable: ${e.message}`;
      await pool.query(`UPDATE telegram_bot SET status = 'error', last_error = $1, last_poll_at = now() WHERE id = 1`, [msg]).catch(() => {});
      if (e.code === 401) { console.error('[telegram]', msg); poller.running = false; return; }
      await sleep(e.code === 409 ? 30000 : backoff);
      backoff = Math.min(60000, backoff * 2);
    }
  }
}

function start() {
  if (!pollingEnabled()) { console.log('[telegram] polling disabled (SOCIAL_TELEGRAM_POLLING=off)'); return; }
  ensureSchema().then(() => restartPolling()).catch(e => console.error('[telegram] start:', e.message));
}

function stripHtml(s) { return String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); }
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = {
  ensureSchema, status, connect, disconnect, saveAccess, listChats, getChat, messages, setChatStatus, deleteChat,
  send, sendManual, registerCommand, start, stopPolling, handleUpdate, escapeHtml, chatName, getToken, TelegramError,
  DEFAULT_PENDING_REPLY,
};
