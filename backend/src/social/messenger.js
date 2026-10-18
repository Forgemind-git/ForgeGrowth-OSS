// ============================================================
// messenger.js — Facebook Messenger inbox (Social → Messenger)
// ============================================================
// Messages people send to our Facebook Pages. Two ways in, one table:
//
//   1. POLL  — GET /{page}/conversations?platform=messenger every 2 minutes
//              (and on demand from the page). Works with nothing but a Page
//              token that carries `pages_messaging`, and it is what fills in
//              history, so the inbox is never empty just because a webhook
//              was not configured.
//   2. PUSH  — Meta "page" webhook events (entry[].messaging[]). Arrives on
//              /api/social/messenger/webhook, or on the Instagram webhook URL
//              when the Page subscription points there (object === 'page').
//
// Both write messenger_messages keyed on Meta's message id (mid), so a message
// seen by the webhook first and the poll second is ONE row.
//
// Tokens: every Page token we hold — the primary Facebook connection, extra
// Pages from "Add account", and Pages reachable through the "Receive Instagram
// DMs" key. Without `pages_messaging` Meta refuses the read; that is recorded
// per Page and shown on screen rather than rendering an empty inbox.

const socialEnv = require('./env');
const pool = require('./db');
const fetch = require('./rateLimiter').gatedFetch;

const GRAPH = 'https://graph.facebook.com/v20.0';
const SYNC_COOLDOWN_MS = 20 * 1000;
const POLL_MS = Math.max(60 * 1000, parseInt(socialEnv.MESSENGER_POLL_MS || '', 10) || 2 * 60 * 1000);
const WINDOW_MS = 24 * 60 * 60 * 1000;

let _schemaReady = null;
async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_pages (
      page_id      TEXT PRIMARY KEY,
      name         TEXT,
      picture      TEXT,
      last_sync_at TIMESTAMPTZ,
      last_ok_at   TIMESTAMPTZ,
      last_error   TEXT,
      updated_at   TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messenger_messages (
      id              BIGSERIAL PRIMARY KEY,
      mid             TEXT UNIQUE NOT NULL,
      page_id         TEXT NOT NULL,
      peer_id         TEXT NOT NULL,
      conversation_id TEXT,
      direction       TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
      text            TEXT,
      attachments     JSONB,
      ts              TIMESTAMPTZ,
      seen            BOOLEAN NOT NULL DEFAULT false,
      read_by_us      BOOLEAN NOT NULL DEFAULT false,
      source          TEXT NOT NULL DEFAULT 'poll',
      sent_by         BIGINT,
      raw             JSONB,
      created_at      TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messenger_conv ON messenger_messages (page_id, peer_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_messenger_ts   ON messenger_messages (ts DESC);
    CREATE TABLE IF NOT EXISTS messenger_peers (
      page_id         TEXT NOT NULL,
      peer_id         TEXT NOT NULL,
      name            TEXT,
      picture         TEXT,
      conversation_id TEXT,
      link            TEXT,
      pic_checked_at  TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (page_id, peer_id)
    );
  `).catch(err => { _schemaReady = null; throw err; });
  return _schemaReady;
}

// ── Tokens ───────────────────────────────────────────────────
// Deduped by Page id; an earlier source wins (the direct Facebook connection
// over a token minted from the Instagram-DMs key).
async function pageCreds() {
  const out = [];
  const add = list => { for (const c of list || []) if (c?.token && c.pageId && !out.some(o => o.pageId === c.pageId)) out.push(c); };
  try { add(await require('./facebook').listPageCreds()); } catch (_) {}
  try { add(await require('./services/metaPageLink').pageTokens()); } catch (_) {}
  return out;
}

async function graph(path, token, { method = 'GET', params = {}, body } = {}) {
  // A paging.next URL already carries its own query (token included).
  const url = new URL(path.startsWith('http') ? path : `${GRAPH}/${path}`);
  if (!path.startsWith('http')) {
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    // In the URL even for POSTs: the rate limiter buckets by the token it finds there.
    url.searchParams.set('access_token', token);
  }
  const res = await fetch(url.toString(), body
    ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method });
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    const e = new Error(json.error.message || 'Meta request failed');
    e.code = json.error.code; e.subcode = json.error.error_subcode;
    throw e;
  }
  return json;
}

// Meta's wording for a missing permission varies; turn it into the fix.
function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (/pages_messaging|permission|\(#?(200|230|10)\)|not authorized|requires/i.test(m) || [10, 200, 230].includes(err?.code)) {
    return 'Facebook did not allow reading this Page\'s messages. Reconnect Facebook in Settings → Integrations and allow "Manage and access Page conversations in Messenger" (pages_messaging).';
  }
  if (err?.code === 190 || /access token|session has expired|validating access token/i.test(m)) {
    return 'The Facebook Page token has expired. Reconnect Facebook in Settings → Integrations.';
  }
  return m || 'Meta request failed';
}

// ── Attachments ──────────────────────────────────────────────
// Conversations API and webhooks describe attachments differently; both end
// up as [{ type, url, name }].
function normAttachments({ graphAtts, webhookAtts, sticker } = {}) {
  const out = [];
  for (const a of (graphAtts?.data || graphAtts || [])) {
    const mime = String(a.mime_type || '');
    const url = a.image_data?.url || a.video_data?.url || a.file_url || null;
    const type = a.image_data ? (a.image_data.animated_gif_url ? 'gif' : 'image')
      : a.video_data ? 'video'
      : mime.startsWith('audio') ? 'audio'
      : mime.startsWith('image') ? 'image'
      : mime.startsWith('video') ? 'video' : 'file';
    out.push({ type, url, name: a.name || null, preview: a.image_data?.preview_url || a.video_data?.preview_url || null });
  }
  for (const a of (webhookAtts || [])) {
    out.push({ type: a.type === 'fallback' ? 'link' : (a.type || 'file'), url: a.payload?.url || null, name: a.title || a.payload?.title || null });
  }
  if (sticker) out.push({ type: 'sticker', url: typeof sticker === 'string' ? sticker : sticker.url || null, name: null });
  return out.length ? out : null;
}

async function upsertPage(pageId, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await pool.query(
    `INSERT INTO messenger_pages (page_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (page_id) DO UPDATE SET ${sets}, updated_at = now()`,
    [pageId, ...cols.map(c => fields[c])]);
}

async function upsertPeer(pageId, peerId, { name, conversationId, link } = {}) {
  await pool.query(
    `INSERT INTO messenger_peers (page_id, peer_id, name, conversation_id, link)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (page_id, peer_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, messenger_peers.name),
           conversation_id = COALESCE(EXCLUDED.conversation_id, messenger_peers.conversation_id),
           link = COALESCE(EXCLUDED.link, messenger_peers.link),
           updated_at = now()`,
    [pageId, peerId, name || null, conversationId || null, link || null]);
}

// One stored message. ON CONFLICT never touches read_by_us / seen — a later
// poll must not mark a message the team already read as unread again.
async function storeMessage(m) {
  const r = await pool.query(
    `INSERT INTO messenger_messages
       (mid, page_id, peer_id, conversation_id, direction, text, attachments, ts, read_by_us, source, sent_by, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (mid) DO UPDATE
       SET text = COALESCE(EXCLUDED.text, messenger_messages.text),
           attachments = COALESCE(EXCLUDED.attachments, messenger_messages.attachments),
           conversation_id = COALESCE(messenger_messages.conversation_id, EXCLUDED.conversation_id)
     RETURNING (xmax = 0) AS inserted`,
    [m.mid, m.pageId, m.peerId, m.conversationId || null, m.direction, m.text || null,
     m.attachments ? JSON.stringify(m.attachments) : null, m.ts || null,
     m.readByUs === true, m.source || 'poll', m.sentBy || null, m.raw ? JSON.stringify(m.raw) : null]);
  return r.rows[0]?.inserted === true;
}

// ── Poll ─────────────────────────────────────────────────────
let _lastSync = 0;
let _syncing = null;

// First sync of a Page imports its history as already read — otherwise
// connecting a Page turns months of old messages into a wall of unread.
async function syncPage(cred) {
  const { pageId, token } = cred;
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM messenger_messages WHERE page_id = $1', [pageId]);
  const firstImport = n === 0;
  const { rows: [pg] } = await pool.query('SELECT last_ok_at FROM messenger_pages WHERE page_id = $1', [pageId]);
  // Re-read conversations updated since the last good sync, with an hour of overlap.
  const since = pg?.last_ok_at ? new Date(pg.last_ok_at).getTime() - 60 * 60 * 1000 : 0;
  const maxPages = firstImport ? 4 : 2;

  let url = null, pageNo = 0, convs = 0, inserted = 0;
  const fields = 'id,updated_time,link,participants,messages.limit(25){id,message,from,to,created_time,sticker,attachments{mime_type,name,file_url,image_data,video_data}}';
  let data = await graph(`${pageId}/conversations`, token, { params: { platform: 'messenger', fields, limit: 25 } });
  for (;;) {
    pageNo++;
    let older = false;
    for (const c of (data.data || [])) {
      if (since && c.updated_time && new Date(c.updated_time).getTime() < since) { older = true; continue; }
      convs++;
      const peer = (c.participants?.data || []).find(p => String(p.id) !== String(pageId));
      if (!peer) continue;
      const peerId = String(peer.id);
      await upsertPeer(pageId, peerId, { name: peer.name, conversationId: c.id, link: c.link ? `https://www.facebook.com${c.link}` : null });
      for (const msg of (c.messages?.data || [])) {
        const outgoing = String(msg.from?.id) === String(pageId);
        const isNew = await storeMessage({
          mid: msg.id, pageId, peerId, conversationId: c.id,
          direction: outgoing ? 'outgoing' : 'incoming',
          text: msg.message || null,
          attachments: normAttachments({ graphAtts: msg.attachments, sticker: msg.sticker }),
          ts: msg.created_time ? new Date(msg.created_time) : null,
          readByUs: outgoing || firstImport,
          source: 'poll',
        });
        if (isNew) inserted++;
      }
    }
    url = data.paging?.next;
    if (!url || older || pageNo >= maxPages) break;
    data = await graph(url, token);
  }
  return { convs, inserted };
}

// Profile pictures need a per-person call; done a few at a time, never twice a day.
async function fillPictures(cred) {
  const { rows } = await pool.query(
    `SELECT peer_id FROM messenger_peers
      WHERE page_id = $1 AND picture IS NULL
        AND (pic_checked_at IS NULL OR pic_checked_at < now() - interval '1 day')
      LIMIT 8`, [cred.pageId]);
  for (const r of rows) {
    let pic = null, name = null;
    try {
      const p = await graph(r.peer_id, cred.token, { params: { fields: 'name,profile_pic' } });
      pic = p.profile_pic || null; name = p.name || null;
    } catch (_) {}
    await pool.query(
      `UPDATE messenger_peers SET picture = COALESCE($3, picture), name = COALESCE(name, $4), pic_checked_at = now()
        WHERE page_id = $1 AND peer_id = $2`, [cred.pageId, r.peer_id, pic, name]).catch(() => {});
  }
}

async function syncAll({ force = false } = {}) {
  if (_syncing) return _syncing;
  if (!force && Date.now() - _lastSync < SYNC_COOLDOWN_MS) return { skipped: 'cooldown' };
  _lastSync = Date.now();
  _syncing = (async () => {
    await ensureSchema();
    const creds = await pageCreds();
    const results = [];
    for (const cred of creds) {
      try {
        if (cred.name) await upsertPage(cred.pageId, { name: cred.name });
        const r = await syncPage(cred);
        await upsertPage(cred.pageId, { last_sync_at: new Date(), last_ok_at: new Date(), last_error: null });
        fillPictures(cred).catch(() => {});
        results.push({ pageId: cred.pageId, ok: true, ...r });
      } catch (err) {
        const msg = friendlyError(err);
        await upsertPage(cred.pageId, { last_sync_at: new Date(), last_error: msg }).catch(() => {});
        results.push({ pageId: cred.pageId, ok: false, error: msg });
      }
    }
    return { pages: creds.length, results };
  })();
  try { return await _syncing; } finally { _syncing = null; }
}

// ── Webhook (object === 'page') ──────────────────────────────
async function handleWebhook(payload) {
  await ensureSchema();
  const result = { messages: 0, reads: 0 };
  for (const entry of (payload?.entry || [])) {
    const pageId = String(entry.id || '');
    if (!pageId) continue;
    for (const ev of (entry.messaging || [])) {
      if (ev.read) {
        const peerId = String(ev.sender?.id || '');
        const watermark = new Date(Number(ev.read.watermark || ev.timestamp || Date.now()));
        await pool.query(
          `UPDATE messenger_messages SET seen = true
            WHERE page_id = $1 AND peer_id = $2 AND direction = 'outgoing' AND NOT seen AND ts <= $3`,
          [pageId, peerId, watermark]).catch(() => {});
        result.reads++;
        continue;
      }
      if (!ev.message?.mid) continue;
      const echo = !!ev.message.is_echo;
      const peerId = String((echo ? ev.recipient?.id : ev.sender?.id) || '');
      if (!peerId) continue;
      await upsertPeer(pageId, peerId, {});
      await storeMessage({
        mid: ev.message.mid, pageId, peerId,
        direction: echo ? 'outgoing' : 'incoming',
        text: ev.message.text || null,
        attachments: normAttachments({ webhookAtts: ev.message.attachments }),
        ts: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
        readByUs: echo,
        source: 'webhook',
        raw: ev,
      });
      result.messages++;
    }
  }
  if (result.messages) {
    // Name + picture for a first-time sender arrive on the next poll; fetch now.
    pageCreds().then(cs => Promise.all(cs.map(c => fillPictures(c).catch(() => {})))).catch(() => {});
    _lastSync = 0; // let the next page load poll straight away
  }
  return result;
}

// ── Read side ────────────────────────────────────────────────
async function inbox({ pageId = null } = {}) {
  await ensureSchema();
  const creds = await pageCreds();
  const { rows: pageRows } = await pool.query('SELECT * FROM messenger_pages ORDER BY name NULLS LAST');
  const known = new Map(pageRows.map(p => [p.page_id, p]));
  const pages = creds.map(c => {
    const p = known.get(c.pageId) || {};
    return { pageId: c.pageId, name: c.name || p.name || null, lastSyncAt: p.last_sync_at || null, lastOkAt: p.last_ok_at || null, error: p.last_error || null };
  });
  // Pages whose token went away still show their stored messages, marked as such.
  for (const p of pageRows) if (!pages.some(x => x.pageId === p.page_id)) {
    pages.push({ pageId: p.page_id, name: p.name, lastSyncAt: p.last_sync_at, lastOkAt: p.last_ok_at, error: 'This Page is no longer connected, so new messages are not being read.', disconnected: true });
  }

  const params = [];
  let where = '';
  if (pageId) { params.push(String(pageId)); where = 'WHERE m.page_id = $1'; }
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.page_id, m.peer_id ORDER BY m.ts DESC NULLS LAST, m.id DESC) AS rn
         FROM messenger_messages m ${where}
     ), agg AS (
       SELECT page_id, peer_id,
              COUNT(*) FILTER (WHERE direction = 'incoming' AND NOT read_by_us)::int AS unread,
              MAX(ts) FILTER (WHERE direction = 'incoming') AS last_incoming_at,
              COUNT(*)::int AS total
         FROM messenger_messages m ${where}
        GROUP BY page_id, peer_id
     )
     SELECT r.page_id, r.peer_id, r.text, r.attachments, r.direction, r.ts, r.seen,
            a.unread, a.last_incoming_at, a.total, p.name AS peer_name, p.picture AS peer_pic, p.link
       FROM ranked r
       JOIN agg a USING (page_id, peer_id)
       LEFT JOIN messenger_peers p ON p.page_id = r.page_id AND p.peer_id = r.peer_id
      WHERE r.rn = 1
      ORDER BY r.ts DESC NULLS LAST
      LIMIT 500`, params);
  const now = Date.now();
  const conversations = rows.map(r => ({
    key: `${r.page_id}:${r.peer_id}`,
    pageId: r.page_id, peerId: r.peer_id,
    peerName: r.peer_name || null, peerPic: r.peer_pic || null, link: r.link || null,
    unread: r.unread, total: r.total,
    lastIncomingAt: r.last_incoming_at,
    windowOpen: !!r.last_incoming_at && now - new Date(r.last_incoming_at).getTime() < WINDOW_MS,
    last: { text: r.text, attachments: r.attachments, direction: r.direction, ts: r.ts, seen: r.seen },
  }));
  return { configured: creds.length > 0, pages, conversations };
}

async function thread({ pageId, peerId, limit = 200 }) {
  await ensureSchema();
  if (!pageId || !peerId) throw new Error('Pick a conversation.');
  const { rows } = await pool.query(
    `SELECT id, mid, direction, text, attachments, ts, seen, source, sent_by,
            (SELECT u.display_name FROM users u WHERE u.id = m.sent_by) AS sent_by_name
       FROM (SELECT * FROM messenger_messages WHERE page_id = $1 AND peer_id = $2
              ORDER BY ts DESC NULLS LAST, id DESC LIMIT $3) m
      ORDER BY ts ASC NULLS FIRST, id ASC`,
    [String(pageId), String(peerId), Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500)]);
  return rows;
}

async function markRead({ pageId, peerId }) {
  await ensureSchema();
  if (!pageId || !peerId) throw new Error('Pick a conversation.');
  const r = await pool.query(
    `UPDATE messenger_messages SET read_by_us = true
      WHERE page_id = $1 AND peer_id = $2 AND direction = 'incoming' AND NOT read_by_us`,
    [String(pageId), String(peerId)]);
  return { ok: true, updated: r.rowCount };
}

// ── Reply ────────────────────────────────────────────────────
// Messenger only lets a Page send ordinary messages within 24 hours of the
// person's last message. We refuse outside it rather than letting Meta reject.
async function reply({ pageId, peerId, text, userId }) {
  await ensureSchema();
  const body = String(text || '').trim();
  if (!pageId || !peerId) throw new Error('Pick a conversation.');
  if (!body) throw new Error('Type a message first.');
  if (body.length > 2000) throw new Error('Messenger messages can be at most 2,000 characters.');
  const cred = (await pageCreds()).find(c => c.pageId === String(pageId));
  if (!cred) throw new Error('This Page is not connected, so we cannot reply from it.');
  const { rows: [last] } = await pool.query(
    `SELECT MAX(ts) AS at FROM messenger_messages WHERE page_id = $1 AND peer_id = $2 AND direction = 'incoming'`,
    [String(pageId), String(peerId)]);
  if (!last?.at || Date.now() - new Date(last.at).getTime() >= WINDOW_MS) {
    throw new Error('Facebook only allows a reply within 24 hours of the person\'s last message. Reply from the Facebook Page inbox instead, or wait for them to write again.');
  }
  let sent;
  try {
    sent = await graph(`${pageId}/messages`, cred.token, {
      method: 'POST',
      body: { recipient: { id: String(peerId) }, messaging_type: 'RESPONSE', message: { text: body } },
    });
  } catch (err) {
    if (err.subcode === 2018278 || /outside of allowed window/i.test(err.message)) {
      throw new Error('Facebook only allows a reply within 24 hours of the person\'s last message.');
    }
    throw new Error(friendlyError(err));
  }
  const mid = sent.message_id || `local-${Date.now()}`;
  await storeMessage({ mid, pageId: String(pageId), peerId: String(peerId), direction: 'outgoing', text: body, ts: new Date(), readByUs: true, source: 'reply', sentBy: userId || null });
  await markRead({ pageId, peerId });
  return { ok: true, mid };
}

// ── Background poll ──────────────────────────────────────────
let _timer = null;
function start() {
  ensureSchema().catch(err => console.error('[messenger] schema:', err.message));
  if (_timer || socialEnv.MESSENGER_POLLING === 'off') return;
  const tick = () => syncAll().then(r => {
    if (r?.results?.length) {
      const n = r.results.reduce((s, x) => s + (x.inserted || 0), 0);
      if (n) console.log(`[messenger] poll stored ${n} new message(s)`);
    }
  }).catch(err => console.error('[messenger] poll error:', err.message));
  setTimeout(tick, 45 * 1000).unref?.();
  _timer = setInterval(tick, POLL_MS);
  _timer.unref?.();
}

module.exports = { ensureSchema, start, syncAll, handleWebhook, inbox, thread, markRead, reply, normAttachments, friendlyError };
