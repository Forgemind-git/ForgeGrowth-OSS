// Social → Messenger, against a real database.
//
//   node --test test/messenger.integration.test.js
//
// Needs the Social schema (social.*) — skips cleanly without a database.
// Meta is never reached: global fetch is replaced for the whole file and every
// Graph call is recorded. The primary Facebook Page token in app_settings is
// saved before the run and put back afterwards.
//
// ⚠ The skip decision is made INSIDE each test body (describe() runs at load).

process.env.SOCIAL_FACEBOOK_PAGE_ID = '__msgtest_page__';
process.env.SOCIAL_MESSENGER_POLLING = 'off';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const PAGE = '__msgtest_page__';
const P1 = '__msgtest_psid1__';
const P2 = '__msgtest_psid2__';
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

const calls = [];
let convs = [];             // what GET /{page}/conversations returns
let failConversations = null;
let sendFail = null;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'graph.facebook.com') throw new Error('unexpected network call: ' + u);
  const method = String(opts.method || 'GET').toUpperCase();
  calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null });
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.pathname.endsWith('/conversations')) {
    if (failConversations) return json({ error: failConversations });
    return json({ data: convs });
  }
  if (method === 'POST' && u.pathname.endsWith('/messages')) {
    if (sendFail) return json({ error: sendFail });
    return json({ recipient_id: JSON.parse(opts.body).recipient.id, message_id: 'm_sent_' + calls.length });
  }
  if (u.pathname.includes('__msgtest_psid')) return json({ name: 'Profile Name', profile_pic: 'https://example.test/pic.jpg' });
  return json({});
};

const pool = require('../src/social/db');
const messenger = require('../src/social/messenger');

let haveDb = false;
let savedToken = null;
let savedName = null;

async function cleanup() {
  await pool.query(`DELETE FROM messenger_messages WHERE page_id LIKE '__msgtest%'`).catch(() => {});
  await pool.query(`DELETE FROM messenger_peers WHERE page_id LIKE '__msgtest%'`).catch(() => {});
  await pool.query(`DELETE FROM messenger_pages WHERE page_id LIKE '__msgtest%'`).catch(() => {});
}
const setSetting = (k, v) => v == null
  ? pool.query('DELETE FROM app_settings WHERE key = $1', [k])
  : pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);

const conv = (id, peerId, peerName, messages) => ({
  id, updated_time: messages[0]?.created_time || iso(0), link: `/${id}`,
  participants: { data: [{ id: peerId, name: peerName }, { id: PAGE, name: 'Test Page' }] },
  messages: { data: messages },
});
const msg = (id, fromPeer, text, minAgo, extra = {}) => ({
  id, message: text, created_time: iso(minAgo),
  from: fromPeer ? { id: fromPeer, name: 'x' } : { id: PAGE, name: 'Test Page' }, ...extra,
});
const rows = (peer) => pool.query(`SELECT * FROM messenger_messages WHERE page_id = $1 AND peer_id = $2 ORDER BY ts`, [PAGE, peer]).then(r => r.rows);

describe('Messenger inbox', () => {
  before(async () => {
    try { await messenger.ensureSchema(); await pool.query('SELECT 1 FROM app_settings LIMIT 1'); haveDb = true; } catch (_) { haveDb = false; return; }
    const r = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('facebook_page_token','facebook_page_name')`);
    savedToken = r.rows.find(x => x.key === 'facebook_page_token')?.value ?? null;
    savedName = r.rows.find(x => x.key === 'facebook_page_name')?.value ?? null;
    await setSetting('facebook_page_token', null);
    await cleanup();
  });
  after(async () => {
    if (haveDb) {
      await cleanup();
      await setSetting('facebook_page_token', savedToken);
      await setSetting('facebook_page_name', savedName);
    }
    global.fetch = realFetch;
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 50).unref();
  });
  beforeEach(() => { calls.length = 0; failConversations = null; sendFail = null; });

  test('no Page connected: nothing is fetched and the inbox says so', async (t) => {
    if (!haveDb) return t.skip('no database');
    const r = await messenger.syncAll({ force: true });
    assert.strictEqual(r.pages, 0);
    assert.strictEqual(calls.length, 0);
    const ib = await messenger.inbox();
    assert.strictEqual(ib.configured, false);
  });

  test('first sync imports history as already read; directions and names are right', async (t) => {
    if (!haveDb) return t.skip('no database');
    await setSetting('facebook_page_token', 'TEST_PAGE_TOKEN');
    await setSetting('facebook_page_name', 'Test Page');
    convs = [
      conv('t_1', P1, 'Asha Rao', [
        msg('m_1b', null, 'Sure, here are the details', 10),
        msg('m_1a', P1, 'Hi, what is the course fee?', 12, { attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://example.test/a.jpg', preview_url: 'https://example.test/a_s.jpg' } }] } }),
      ]),
      conv('t_2', P2, 'Ravi K', [msg('m_2a', P2, 'Old question', 60 * 30)]),
    ];
    const r = await messenger.syncAll({ force: true });
    assert.strictEqual(r.results[0].ok, true, JSON.stringify(r));
    const getConv = calls.find(c => c.path.endsWith('/conversations'));
    assert.strictEqual(getConv.query.platform, 'messenger');
    assert.strictEqual(getConv.query.access_token, 'TEST_PAGE_TOKEN');

    const a = await rows(P1);
    assert.deepStrictEqual(a.map(x => [x.mid, x.direction]), [['m_1a', 'incoming'], ['m_1b', 'outgoing']]);
    assert.ok(a.every(x => x.read_by_us), 'history must not arrive as unread');
    assert.strictEqual(a[0].attachments[0].type, 'image');
    assert.strictEqual(a[0].attachments[0].url, 'https://example.test/a.jpg');

    const ib = await messenger.inbox();
    assert.strictEqual(ib.configured, true);
    const c1 = ib.conversations.find(c => c.peerId === P1);
    const c2 = ib.conversations.find(c => c.peerId === P2);
    assert.strictEqual(c1.peerName, 'Asha Rao');
    assert.strictEqual(c1.unread, 0);
    assert.strictEqual(c1.windowOpen, true);
    assert.strictEqual(c2.windowOpen, false, '30 hours old → reply window closed');
    assert.strictEqual(ib.conversations[0].peerId, P1, 'newest conversation first');
  });

  test('a later sync adds only the new message, unread; old ones stay read', async (t) => {
    if (!haveDb) return t.skip('no database');
    convs = [conv('t_1', P1, 'Asha Rao', [
      msg('m_1c', P1, 'Can I pay in instalments?', 1),
      msg('m_1b', null, 'Sure, here are the details', 10),
      msg('m_1a', P1, 'Hi, what is the course fee?', 12),
    ])];
    const r = await messenger.syncAll({ force: true });
    assert.strictEqual(r.results[0].inserted, 1);
    const a = await rows(P1);
    assert.strictEqual(a.length, 3, 'no duplicates');
    assert.strictEqual(a.find(x => x.mid === 'm_1c').read_by_us, false);
    assert.strictEqual(a.find(x => x.mid === 'm_1a').read_by_us, true);
    const c1 = (await messenger.inbox()).conversations.find(c => c.peerId === P1);
    assert.strictEqual(c1.unread, 1);
    assert.strictEqual(c1.last.text, 'Can I pay in instalments?');
  });

  test('opening a conversation clears its unread count', async (t) => {
    if (!haveDb) return t.skip('no database');
    const r = await messenger.markRead({ pageId: PAGE, peerId: P1 });
    assert.strictEqual(r.updated, 1);
    const c1 = (await messenger.inbox()).conversations.find(c => c.peerId === P1);
    assert.strictEqual(c1.unread, 0);
  });

  test('webhook: an incoming message is stored once, echo is outgoing, read marks seen', async (t) => {
    if (!haveDb) return t.skip('no database');
    const now = Date.now();
    const payload = { object: 'page', entry: [{ id: PAGE, time: now, messaging: [
      { sender: { id: P1 }, recipient: { id: PAGE }, timestamp: now - 5000, message: { mid: 'm_wh_1', text: 'Live from webhook', attachments: [{ type: 'image', payload: { url: 'https://example.test/w.jpg' } }] } },
      { sender: { id: PAGE }, recipient: { id: P1 }, timestamp: now - 4000, message: { mid: 'm_wh_2', text: 'Echo of our reply', is_echo: true } },
      { sender: { id: P1 }, recipient: { id: PAGE }, timestamp: now - 1000, read: { watermark: now - 1000 } },
    ] }] };
    const r = await messenger.handleWebhook(payload);
    assert.strictEqual(r.messages, 2); assert.strictEqual(r.reads, 1);
    await messenger.handleWebhook(payload);          // Meta redelivers
    const a = await rows(P1);
    assert.strictEqual(a.filter(x => x.mid === 'm_wh_1').length, 1);
    const inc = a.find(x => x.mid === 'm_wh_1');
    assert.strictEqual(inc.direction, 'incoming'); assert.strictEqual(inc.read_by_us, false);
    assert.strictEqual(inc.attachments[0].url, 'https://example.test/w.jpg');
    const echo = a.find(x => x.mid === 'm_wh_2');
    assert.strictEqual(echo.direction, 'outgoing'); assert.strictEqual(echo.seen, true);

    // The poll later returns the same message: still one row, and still unread.
    convs = [conv('t_1', P1, 'Asha Rao', [msg('m_wh_1', P1, 'Live from webhook', 0)])];
    await messenger.syncAll({ force: true });
    const again = (await rows(P1)).filter(x => x.mid === 'm_wh_1');
    assert.strictEqual(again.length, 1);
    assert.strictEqual(again[0].read_by_us, false);
    assert.strictEqual(again[0].conversation_id, 't_1');
  });

  test('reply inside 24h sends a RESPONSE message and stores it', async (t) => {
    if (!haveDb) return t.skip('no database');
    const r = await messenger.reply({ pageId: PAGE, peerId: P1, text: '  Yes, 3 instalments.  ', userId: null });
    assert.ok(r.ok);
    const post = calls.find(c => c.method === 'POST' && c.path.endsWith(`/${PAGE}/messages`));
    assert.deepStrictEqual(post.body, { recipient: { id: P1 }, messaging_type: 'RESPONSE', message: { text: 'Yes, 3 instalments.' } });
    assert.strictEqual(post.query.access_token, 'TEST_PAGE_TOKEN');
    const sent = (await rows(P1)).find(x => x.mid === r.mid);
    assert.strictEqual(sent.direction, 'outgoing'); assert.strictEqual(sent.source, 'reply');
    assert.strictEqual((await messenger.inbox()).conversations.find(c => c.peerId === P1).unread, 0, 'replying reads the conversation');
  });

  test('reply outside 24h is refused before Meta is called', async (t) => {
    if (!haveDb) return t.skip('no database');
    await assert.rejects(messenger.reply({ pageId: PAGE, peerId: P2, text: 'hello' }), /24 hours/);
    assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0);
    await assert.rejects(messenger.reply({ pageId: PAGE, peerId: P1, text: '   ' }), /Type a message/);
  });

  test('Meta refusing the read is recorded on the Page with the fix', async (t) => {
    if (!haveDb) return t.skip('no database');
    failConversations = { message: '(#200) Requires pages_messaging permission to manage the object', code: 200 };
    const r = await messenger.syncAll({ force: true });
    assert.strictEqual(r.results[0].ok, false);
    const page = (await messenger.inbox()).pages.find(p => p.pageId === PAGE);
    assert.match(page.error, /pages_messaging/);
    assert.ok((await messenger.inbox()).conversations.length >= 2, 'stored messages still show');
    failConversations = null;
    await messenger.syncAll({ force: true });
    assert.strictEqual((await messenger.inbox()).pages.find(p => p.pageId === PAGE).error, null, 'a good sync clears it');
  });

  test('a send Meta rejects for the window comes back as a sentence', async (t) => {
    if (!haveDb) return t.skip('no database');
    sendFail = { message: '(#10) This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 };
    await assert.rejects(messenger.reply({ pageId: PAGE, peerId: P1, text: 'hi' }), /24 hours/);
  });
});
