// /api/openrouter — admin: key, ₹ rate, spend (services/openRouter.js).
const express = require('express');
const { adminOnly } = require('./auth');
const openRouter = require('./services/openRouter');

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) {
    const bad = /required|must|not connected|does not look|rejected|invalid/i.test(err.message);
    if (!bad) console.error('[openrouter]', err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
};

const openRouterRouter = express.Router();
openRouterRouter.use(adminOnly);
openRouterRouter.get('/', wrap(() => openRouter.status()));
openRouterRouter.get('/spend', wrap(async () => ({ ...(await openRouter.spend()), inr: await openRouter.inrRate() })));
openRouterRouter.post('/key', wrap(async req => { await openRouter.saveKey(req.body?.key); return openRouter.status(); }));
openRouterRouter.delete('/key', wrap(async () => { await openRouter.removeKey(); return { ok: true }; }));
openRouterRouter.put('/rate', wrap(async req => { await openRouter.setRate(req.body?.rate); return openRouter.status(); }));

module.exports = { openRouterRouter };
