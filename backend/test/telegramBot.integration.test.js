// Telegram bot, against a real database.
//
//   node --test test/telegramBot.integration.test.js
//
// Needs the Social schema (social.*) — skips cleanly without a database.
// Telegram is never reached: global fetch is replaced for the whole file and
// every Bot API call is recorded, so the tests can assert what WOULD be sent.
//
// ⚠ The skip decision is made INSIDE each test body: a describe() body runs at
// module load, before before() can probe the database.

process.env.SOCIAL_ENCRYPTION_KEY = process.env.SOCIAL_ENCRYPTION_KEY || 'test-key-telegram-bot';
process.env.SOCIAL_TELEGRAM_POLLING = 'off';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const calls = [];
let nextMsgId = 5000;           // Telegram message ids are unique per chat — never reuse one
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
    return ok({ message_id: nextMsgId++, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id } });
  }
  return ok([]);
};

const pool = require('../src/social/db');
const bot = require('../src/social/services/telegramBot');

const TOKEN = '8510584968:AAtestTOKENabcdefghijklmnopqrstuvwxyz12';
const C_PERSON = '990000001';     // approved person
const C_PENDING = '990000002';    // never approved
const C_GROUP = '-990000003';     // group the bot is added to

let haveDb = false;
const sends = (chatId) => calls.filter(c => c.method === 'sendMessage' && (chatId == null || String(c.body.chat_id) === String(chatId)));
const update = (chat, text, extra = {}) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: Math.floor(Math.random() * 1e9), date: Math.floor(Date.now() / 1000), chat, from: { id: chat.id, first_name: chat.first_name || 'X' }, text, ...extra } });

async function cleanup() {
  await pool.query(`DELETE FROM telegram_messages WHERE chat_id = ANY($1::bigint[])`, [[C_PERSON, C_PENDING, C_GROUP]]).catch(() => {});
  await pool.query(`DELETE FROM telegram_chats WHERE chat_id = ANY($1::bigint[])`, [[C_PERSON, C_PENDING, C_GROUP]]).catch(() => {});
}
describe('Telegram bot', () => {
  before(async () => {
    try { await pool.query('SELECT 1 FROM instagram_comments LIMIT 1'); haveDb = true; } catch (_) { haveDb = false; return; }
    await bot.ensureSchema();
    await cleanup();
  });
  after(async () => {
    if (haveDb) { await cleanup(); await bot.disconnect().catch(() => {}); }
    global.fetch = realFetch;
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 50).unref();
  });
  beforeEach(() => { calls.length = 0; });

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
    await bot.handleUpdate(update({ id: Number(C_PERSON), type: 'private', first_name: 'Sam' }, '/help'), TOKEN);
    assert.match(sends(C_PERSON)[0].body.text, /This chat is approved/);
    await bot.handleUpdate(update({ id: Number(C_PERSON), type: 'private', first_name: 'Sam' }, '/id'), TOKEN);
    assert.match(sends(C_PERSON)[1].body.text, new RegExp(`Chat id: ${C_PERSON}`));
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

  test('a manual message is sent and logged; a blocked chat refuses it', async (t) => {
    if (!haveDb) return t.skip('no database');
    await bot.sendManual(C_PERSON, 'hello from Forge Growth', 1);
    const m = (await bot.messages(C_PERSON)).pop();
    assert.equal(m.kind, 'manual');
    assert.equal(m.text, 'hello from Forge Growth');
    await bot.setChatStatus(C_PENDING, 'blocked', 1);
    await assert.rejects(bot.sendManual(C_PENDING, 'hi', 1), /blocked/);
  });
});
