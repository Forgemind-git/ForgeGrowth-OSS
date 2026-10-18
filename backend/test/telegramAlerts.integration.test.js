// Telegram bot + negative-comment alerts, against a real database.
//
//   node --test test/telegramAlerts.integration.test.js
//
// Needs the Social schema (social.*) — skips cleanly without a database.
// Telegram is never reached: global fetch is replaced for the whole file and
// every Bot API call is recorded, so the tests can assert what WOULD be sent.
//
// ⚠ The skip decision is made INSIDE each test body: a describe() body runs at
// module load, before before() can probe the database.

process.env.SOCIAL_ENCRYPTION_KEY = process.env.SOCIAL_ENCRYPTION_KEY || 'test-key-telegram-alerts';
process.env.SOCIAL_TELEGRAM_POLLING = 'off';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const calls = [];
let nextMsgId = 5000;           // Telegram message ids are unique per chat — never reuse one
let failChat = null;           // chat id whose sends answer 403
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://api.telegram.org/')) throw new Error('unexpected network call: ' + u);
  const method = u.split('/').pop();
  const body = opts?.body ? JSON.parse(opts.body) : {};
  calls.push({ method, body });
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  if (method === 'getMe') return ok({ id: 8510584968, is_bot: true, first_name: 'Test Bot', username: 'test_alert_bot' });
  if (method === 'deleteWebhook') return ok(true);
  if (method === 'sendMessage') {
    if (failChat && String(body.chat_id) === String(failChat)) {
      return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
    }
    return ok({ message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id } });
  }
  return ok([]);
};

const pool = require('../src/social/db');
const bot = require('../src/social/services/telegramBot');
const alerts = require('../src/social/services/commentAlerts');

const TOKEN = '8510584968:AAtestTOKENabcdefghijklmnopqrstuvwxyz12';
const ACCT = '__tgtest_acct__';
const C_PERSON = '990000001';     // approved person
const C_PENDING = '990000002';    // never approved
const C_GROUP = '-990000003';     // group the bot is added to
const C_GONE = '990000004';       // approved but blocked the bot (403)

let haveDb = false;
const sends = (chatId) => calls.filter(c => c.method === 'sendMessage' && (chatId == null || String(c.body.chat_id) === String(chatId)));
const update = (chat, text, extra = {}) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: Math.floor(Math.random() * 1e9), date: Math.floor(Date.now() / 1000), chat, from: { id: chat.id, first_name: chat.first_name || 'X' }, text, ...extra } });

async function cleanup() {
  await pool.query(`DELETE FROM comment_alerts WHERE comment_id LIKE '__tgtest%'`).catch(() => {});
  await pool.query(`DELETE FROM comment_analysis WHERE comment_id LIKE '__tgtest%'`).catch(() => {});
  await pool.query(`DELETE FROM instagram_comments WHERE comment_id LIKE '__tgtest%'`).catch(() => {});
  await pool.query(`DELETE FROM telegram_messages WHERE chat_id = ANY($1::bigint[])`, [[C_PERSON, C_PENDING, C_GROUP, C_GONE]]).catch(() => {});
  await pool.query(`DELETE FROM telegram_chats WHERE chat_id = ANY($1::bigint[])`, [[C_PERSON, C_PENDING, C_GROUP, C_GONE]]).catch(() => {});
}
async function addComment(id, { text, sentiment = 'negative', conf = 0.9, toxic = 0.1, category = 'complaint', hoursOld = 0, analyzedAt = 'now()' }) {
  await pool.query(`INSERT INTO instagram_comments (comment_id, account_id, media_id, from_username, text, ts) VALUES ($1,$2,'__tgtest_media__','angry_customer',$3, now() - ($4 || ' hours')::interval)`, [id, ACCT, text, String(hoursOld)]);
  await pool.query(`INSERT INTO comment_analysis (platform, comment_id, status, sentiment, sentiment_conf, category, toxic, analyzed_at) VALUES ('instagram',$1,'done',$2,$3,$4,$5, ${analyzedAt})`, [id, sentiment, conf, category, toxic]);
}

describe('Telegram bot + negative-comment alerts', () => {
  before(async () => {
    try { await pool.query('SELECT 1 FROM instagram_comments LIMIT 1'); haveDb = true; } catch (_) { haveDb = false; return; }
    await bot.ensureSchema(); await alerts.ensureSchema();
    await cleanup();
    await pool.query(`DELETE FROM app_settings WHERE key = 'comment_alert_settings'`);
    alerts.start();     // registers /recent and /status (its timers are unref'd)
  });
  after(async () => {
    if (haveDb) { await cleanup(); await pool.query(`DELETE FROM app_settings WHERE key = 'comment_alert_settings'`); await bot.disconnect().catch(() => {}); }
    global.fetch = realFetch;
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 50).unref();
  });
  beforeEach(() => { calls.length = 0; failChat = null; });

  test('a malformed token is refused before Telegram is asked and nothing is stored', async (t) => {
    if (!haveDb) return t.skip('no database');
    await assert.rejects(bot.connect('not-a-token'), /does not look like a bot token/);
    assert.equal(calls.length, 0);
    const st = await bot.status();
    assert.equal(st.configured, false);
  });

  test('connect stores the token encrypted and reports the bot, masked', async (t) => {
    if (!haveDb) return t.skip('no database');
    const st = await bot.connect(TOKEN);
    assert.equal(st.configured, true);
    assert.equal(st.status, 'connected');
    assert.equal(st.bot.username, 'test_alert_bot');
    assert.ok(!st.tokenMasked.includes('abcdefghijklmnop'), 'token is masked');
    const { rows: [r] } = await pool.query('SELECT token_encrypted FROM telegram_bot WHERE id = 1');
    assert.ok(r.token_encrypted && !r.token_encrypted.includes(TOKEN), 'stored encrypted, not plain');
    assert.equal(await bot.getToken(), TOKEN);
    assert.ok(calls.some(c => c.method === 'deleteWebhook'), 'webhook cleared so polling can work');
  });

  test('a new person is recorded as pending and told to wait — once, not on every message', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.handleUpdate(update({ id: Number(C_PENDING), type: 'private', first_name: 'Pending', username: 'pend' }, '/start'), TOKEN);
    await bot.handleUpdate(update({ id: Number(C_PENDING), type: 'private', first_name: 'Pending' }, 'hello?'), TOKEN);
    await bot.handleUpdate(update({ id: Number(C_PENDING), type: 'private', first_name: 'Pending' }, 'anyone'), TOKEN);
    const c = await bot.getChat(C_PENDING);
    assert.equal(c.status, 'pending');
    assert.equal(sends(C_PENDING).length, 1, 'one "waiting for approval" reply');
    assert.match(sends(C_PENDING)[0].body.text, /approve/i);
    const msgs = await bot.messages(C_PENDING);
    assert.equal(msgs.filter(m => m.direction === 'in').length, 3, 'every incoming message is stored for the viewer');
  });

  test('approving a chat tells them, and then the bot answers its commands', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.handleUpdate(update({ id: Number(C_PERSON), type: 'private', first_name: 'Sam' }, '/start'), TOKEN);
    calls.length = 0;
    await bot.setChatStatus(C_PERSON, 'approved', 1);
    await new Promise(r => setTimeout(r, 50));
    assert.match(sends(C_PERSON)[0].body.text, /approved/i);
    calls.length = 0;
    await bot.handleUpdate(update({ id: Number(C_PERSON), type: 'private', first_name: 'Sam' }, '/status'), TOKEN);
    assert.match(sends(C_PERSON)[0].body.text, /Comment alerts are OFF/);
    await bot.handleUpdate(update({ id: Number(C_PERSON), type: 'private', first_name: 'Sam' }, '/recent'), TOKEN);
    // /recent answers in HTML only when there are flagged comments to list; on an
    // empty database (this suite seeds them in a LATER test) it is plain text.
    const recent = sends(C_PERSON)[1].body;
    if (/No negative comments/.test(recent.text)) assert.equal(recent.parse_mode, undefined);
    else assert.equal(recent.parse_mode, 'HTML');
  });

  test('a blocked chat is stored but never answered', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.setChatStatus(C_PENDING, 'blocked', 1);
    calls.length = 0;
    await bot.handleUpdate(update({ id: Number(C_PENDING), type: 'private', first_name: 'Pending' }, '/start'), TOKEN);
    assert.equal(sends(C_PENDING).length, 0);
    await bot.setChatStatus(C_PENDING, 'pending', 1);
  });

  test('the bot being added to a group records the group as pending', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.handleUpdate({ update_id: 1, my_chat_member: { chat: { id: Number(C_GROUP), type: 'supergroup', title: 'Social Team' }, from: { id: 1, first_name: 'Admin' }, date: Math.floor(Date.now() / 1000), new_chat_member: { status: 'member' } } }, TOKEN);
    const g = await bot.getChat(C_GROUP);
    assert.equal(g.status, 'pending');
    assert.equal(g.title, 'Social Team');
    assert.equal(sends(C_GROUP).length, 1);
    await bot.setChatStatus(C_GROUP, 'approved', 1);
  });

  test('alerts cannot be switched on with no kind of comment selected', async (t) => {
    if (!haveDb) return t.skip('no database');
    await assert.rejects(alerts.saveSettings({ enabled: true, chatIds: [C_PERSON], negative: false, toxic: false, complaint: false }), /at least one/);
  });

  test('only NEW negative comments reach APPROVED chats — once each, HTML-escaped', async (t) => {
    if (!haveDb) return t.skip('no database');
    // Analysed BEFORE alerts were switched on: must never be sent (no backlog blast).
    await addComment('__tgtest_old_analysis', { text: 'analysed earlier', analyzedAt: "now() - interval '1 hour'" });
    await new Promise(r => setTimeout(r, 20));
    const s = await alerts.saveSettings({ enabled: true, chatIds: [C_PERSON, C_GROUP, C_PENDING], negative: true, toxic: true, complaint: false, maxAgeHours: 48 });
    assert.ok(s.enabledAt);
    await new Promise(r => setTimeout(r, 30));
    calls.length = 0;
    await addComment('__tgtest_neg', { text: 'Worst course <b>ever</b> & a scam', conf: 0.92 });
    await addComment('__tgtest_weak', { text: 'meh not sure', conf: 0.4 });                     // below the 60% bar
    await addComment('__tgtest_pos', { text: 'loved it', sentiment: 'positive', category: 'praise' });
    await addComment('__tgtest_toxic', { text: 'you are idiots', sentiment: 'neutral', category: 'other', toxic: 0.95 });
    await addComment('__tgtest_stale', { text: 'posted days ago, analysed now', hoursOld: 96 });   // outside 48h
    const r = await alerts.dispatch();
    assert.equal(r.sent, 4, '2 comments × 2 approved chats');
    assert.equal(sends(C_PENDING).length, 0, 'a pending chat never gets alerts even when ticked');
    const person = sends(C_PERSON).map(c => c.body.text);
    assert.equal(person.length, 2);
    const neg = person.find(t => t.includes('Worst course'));
    assert.ok(neg.includes('&lt;b&gt;ever&lt;/b&gt; &amp; a scam'), 'comment text is HTML-escaped');
    assert.match(neg, /Negative comment/);
    assert.match(person.find(t => t.includes('idiots')), /Abusive comment/);
    assert.ok(!person.some(t => /analysed earlier|meh not sure|loved it|posted days ago/.test(t)));
    calls.length = 0;
    const again = await alerts.dispatch();
    assert.equal(again.sent, 0, 'a comment is alerted once per chat, however often dispatch runs');
    assert.equal(sends().length, 0);
  });

  test('a chat that blocked the bot: failed → retried → gives up after 3, marked unreachable', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.handleUpdate(update({ id: Number(C_GONE), type: 'private', first_name: 'Gone' }, '/start'), TOKEN);
    await bot.setChatStatus(C_GONE, 'approved', 1);
    await alerts.saveSettings({ enabled: true, chatIds: [C_PERSON, C_GONE] });
    failChat = C_GONE;
    await addComment('__tgtest_blocked', { text: 'refund my money now' });
    for (let i = 0; i < 4; i++) await alerts.dispatch();
    const { rows } = await pool.query(`SELECT chat_id::text, status, attempts FROM comment_alerts WHERE comment_id = '__tgtest_blocked' ORDER BY chat_id`);
    const gone = rows.find(r => r.chat_id === C_GONE);
    const ok = rows.find(r => r.chat_id === C_PERSON);
    assert.equal(ok.status, 'sent');
    assert.equal(gone.status, 'gave_up');
    assert.equal(gone.attempts, 3, 'exactly 3 attempts, then stops');
    assert.equal(sends(C_PERSON).filter(c => c.body.text.includes('refund my money')).length, 1);
    assert.equal((await bot.getChat(C_GONE)).bot_member, false);
    const log = await alerts.log({ limit: 20 });
    assert.ok(log.some(a => a.commentId === '__tgtest_blocked' && a.status === 'gave_up' && /blocked/.test(a.error)));
  });

  test('switching alerts off then on again does not replay what arrived in between', async (t) => {
    if (!haveDb) return t.skip('no database');
    await alerts.saveSettings({ enabled: false });
    await addComment('__tgtest_while_off', { text: 'this was posted while alerts were off' });
    await new Promise(r => setTimeout(r, 30));
    await alerts.saveSettings({ enabled: true, chatIds: [C_PERSON] });
    calls.length = 0;
    await alerts.dispatch();
    assert.ok(!sends().some(c => c.body.text.includes('while alerts were off')));
  });

  test('a manual message is sent and logged; a blocked chat refuses it', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.sendManual(C_PERSON, 'hello from Forge Growth', 1);
    const m = (await bot.messages(C_PERSON)).pop();
    assert.equal(m.kind, 'manual');
    assert.equal(m.text, 'hello from Forge Growth');
    await bot.setChatStatus(C_PENDING, 'blocked', 1);
    await assert.rejects(bot.sendManual(C_PENDING, 'hi', 1), /blocked/);
  });

  test('a test alert goes only to approved chats', async (t) => {
    if (!haveDb) return t.skip('no database');
    const r = await alerts.sendTest([C_PERSON, C_PENDING]);
    assert.deepEqual(r.results.map(x => x.chatId), [C_PERSON]);
    assert.match(sends(C_PERSON)[0].body.text, /Test alert/);
  });
});
