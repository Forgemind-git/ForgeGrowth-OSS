// /api/social/telegram — the Telegram bot (admin only: it holds the bot token
// and decides who may contact it).
const express = require('express');
const { adminOnly } = require('./auth');
const bot = require('./services/telegramBot');

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) {
    if (err.notFound) return res.status(404).json({ error: err.message });
    const bad = /required|must|not connected|does not look|rejected|blocked|approve|pick|type a message|token|chat/i.test(err.message);
    if (!bad) console.error('[telegram]', err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
};
const chatId = (req) => {
  const id = String(req.params.chatId || '');
  if (!/^-?\d{1,20}$/.test(id)) throw Object.assign(new Error('Chat not found'), { notFound: true });
  return id;
};

const telegramRouter = express.Router();
telegramRouter.use(adminOnly);
telegramRouter.get('/', wrap(() => bot.status()));
telegramRouter.post('/connect', wrap(req => bot.connect(req.body?.token)));
telegramRouter.post('/disconnect', wrap(() => bot.disconnect()));
telegramRouter.put('/access', wrap(req => bot.saveAccess(req.body || {})));
telegramRouter.get('/chats', wrap(async () => ({ chats: await bot.listChats() })));
telegramRouter.get('/chats/:chatId/messages', wrap(async req => ({ messages: await bot.messages(chatId(req), req.query) })));
telegramRouter.post('/chats/:chatId/messages', wrap(req => bot.sendManual(chatId(req), req.body?.text, req.user.id)));
telegramRouter.put('/chats/:chatId', wrap(async req => ({ chat: await bot.setChatStatus(chatId(req), req.body?.status, req.user.id, req.body?.note) })));
telegramRouter.delete('/chats/:chatId', wrap(req => bot.deleteChat(chatId(req))));

module.exports = { telegramRouter };
