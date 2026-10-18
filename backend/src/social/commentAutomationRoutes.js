// /api/ig-automations — CRUD for ManyChat-style Instagram automation rules
// (see services/commentAutomation.js). Mounted after authMiddleware; reads are
// user-allowed, writes are admin-only (a rule sends messages on the account's behalf).
const express = require('express');
const automation = require('./services/commentAutomation');
const flows = require('./services/flowEngine');
const { adminOnly } = require('./auth');

const router = express.Router();

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) {
    const bad = /required|must be|must have|nothing to update|not found|at most/.test(err.message);
    if (!bad) console.error('[ig-automations]', err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
};

router.get('/', wrap(req => automation.listRules(req.query.account_id)));
router.get('/meta', wrap(() => automation.meta()));
router.get('/accounts', wrap(() => automation.listAccounts()));
router.get('/posts', wrap(req => automation.listPosts(req.query.account_id)));
router.get('/log', wrap(req => automation.listLog({ ruleId: req.query.rule_id, accountId: req.query.account_id, limit: req.query.limit })));
router.get('/leads', wrap(req => automation.listLeads({ ruleId: req.query.rule_id, accountId: req.query.account_id, limit: req.query.limit })));
// Flow Builder (node graphs) — services/flowEngine.js
router.get('/flows', wrap(req => flows.listFlows(req.query.account_id)));
router.get('/flows/ai-models', wrap(() => flows.aiModels()));
router.post('/flows/ai-test', wrap(req => flows.aiTest(req.body || {})));
router.get('/flows/:id', wrap(async req => { const f = await flows.getFlow(Number(req.params.id)); if (!f) throw new Error('flow not found'); return f; }));
router.get('/flows/:id/insights', wrap(req => flows.flowInsights(Number(req.params.id))));
router.post('/flows', adminOnly, wrap(req => flows.createFlow(req.body || {})));
router.put('/flows/:id', adminOnly, wrap(async req => { const f = await flows.updateFlow(Number(req.params.id), req.body || {}); if (!f) throw new Error('flow not found'); return f; }));
router.delete('/flows/:id', adminOnly, wrap(async req => ({ ok: await flows.deleteFlow(Number(req.params.id)) })));
router.get('/:id/insights', wrap(req => automation.ruleInsights(Number(req.params.id), req.query.days)));
router.post('/', adminOnly, wrap(req => automation.createRule(req.body || {})));
router.put('/:id', adminOnly, wrap(async req => {
  const r = await automation.updateRule(Number(req.params.id), req.body || {});
  if (!r) throw new Error('rule not found');
  return r;
}));
router.delete('/:id', adminOnly, wrap(async req => ({ ok: await automation.deleteRule(Number(req.params.id)) })));

module.exports = router;
