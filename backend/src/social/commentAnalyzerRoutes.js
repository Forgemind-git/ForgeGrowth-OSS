// /api/comment-analyzer — results (user) + settings / run / reset (admin).
// /api/openrouter       — admin: key, ₹ rate, spend (services/openRouter.js).
const express = require('express');
const { adminOnly } = require('./auth');
const analyzer = require('./services/commentAnalyzer');
const openRouter = require('./services/openRouter');

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (err) {
    const bad = /required|must|not connected|does not look|rejected|invalid/i.test(err.message);
    if (!bad) console.error('[comment-analyzer]', err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
};

const analyzerRouter = express.Router();
analyzerRouter.get('/summary', wrap(req => analyzer.summary(req.query)));
analyzerRouter.get('/results', wrap(req => analyzer.results(req.query)));
analyzerRouter.get('/view', wrap(async req => ({ view: await analyzer.getView(req.user.id) })));
analyzerRouter.put('/view', wrap(async req => ({ view: await analyzer.saveView(req.user.id, req.body) })));
analyzerRouter.get('/dm-labels', wrap(() => analyzer.dmLabels()));
analyzerRouter.get('/labels', wrap(req => analyzer.labels(req.query.platform)));
analyzerRouter.get('/accounts', wrap(async () => ({ accounts: await analyzer.listAccounts() })));
analyzerRouter.get('/settings', wrap(async () => ({ settings: await analyzer.getSettings(), categories: analyzer.CATEGORIES })));
analyzerRouter.put('/settings', adminOnly, wrap(async req => ({ settings: await analyzer.saveSettings(req.body || {}) })));
analyzerRouter.post('/preview', adminOnly, wrap(req => analyzer.preview(req.body || null)));
analyzerRouter.post('/run', adminOnly, wrap(() => analyzer.run({ manual: true, max: 400 })));
analyzerRouter.post('/reset', adminOnly, wrap(req => analyzer.reset(req.body?.scope)));

const openRouterRouter = express.Router();
openRouterRouter.use(adminOnly);
openRouterRouter.get('/', wrap(() => openRouter.status()));
openRouterRouter.get('/spend', wrap(async () => ({ ...(await openRouter.spend()), inr: await openRouter.inrRate() })));
openRouterRouter.post('/key', wrap(async req => { await openRouter.saveKey(req.body?.key); return openRouter.status(); }));
openRouterRouter.delete('/key', wrap(async () => { await openRouter.removeKey(); return { ok: true }; }));
openRouterRouter.put('/rate', wrap(async req => { await openRouter.setRate(req.body?.rate); return openRouter.status(); }));

module.exports = { analyzerRouter, openRouterRouter };
