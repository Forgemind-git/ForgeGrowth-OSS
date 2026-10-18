// /api/meta-link — "Receive Instagram DMs" card (services/metaPageLink.js).
// Reads are user-allowed; saving keys and linking Pages is admin-only.
const express = require('express');
const link = require('./services/metaPageLink');
const { adminOnly } = require('./auth');

const router = express.Router();
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) { res.status(400).json({ error: err.message }); }
};

router.get('/', wrap(() => link.status()));
router.post('/token', adminOnly, wrap(req => link.saveToken(req.body?.token)));
router.delete('/token', adminOnly, wrap(() => link.removeToken()));
router.post('/secret', adminOnly, wrap(req => link.saveSecret(req.body?.secret)));
router.post('/pages/:id/link', adminOnly, wrap(req => link.linkPage(req.params.id)));
router.post('/pages/:id/unlink', adminOnly, wrap(req => link.unlinkPage(req.params.id)));

module.exports = router;
