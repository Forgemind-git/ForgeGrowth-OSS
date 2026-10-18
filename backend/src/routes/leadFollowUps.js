// Leads → My list + follow-up calendar. Thin wrappers over services/followUps.js
// (the same functions the MCP tools call, so the rules cannot drift).
//
//   GET    /my-list                          my pinned chats (+ lead, last message, next follow-up)
//   POST   /my-list        {waNumber, contactNumber, note?}   pin
//   DELETE /my-list?contactNumber=                             unpin
//   GET    /follow-ups?from=&to=&scope=mine|all&status=open|done|cancelled|any
//   POST   /follow-ups     {waNumber, contactNumber, dueDate, dueTime?, note?, source?, aiReason?}
//   PATCH  /follow-ups/:id {dueDate?, dueTime?, note?, status?}
//   DELETE /follow-ups/:id
//   GET    /follow-ups/chat?waNumber=&contactNumber=           pinned? open follow-up? AI suggestion?
//   POST   /follow-ups/suggest {waNumber, contactNumber}       AI-recommended next date
//   GET    /follow-ups/google                                  Google Calendar status
//   POST   /follow-ups/google/sync {scope?, autoSync?}         mirror into Google Calendar

const { Router } = require('express');
const fu = require('../services/followUps');

const router = Router();

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) {
    if (!e.status) console.error('[leadFollowUps]', req.method, req.path, e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong — try again' });
  }
};

router.get('/my-list', wrap(async (req) => ({ items: await fu.myList(req.user) })));
router.post('/my-list', wrap(async (req) => fu.pinChat(req.user, req.body || {})));
router.delete('/my-list', wrap(async (req) => fu.unpinChat(req.user, { contactNumber: req.query.contactNumber || req.body?.contactNumber })));

// Literal paths before /:id.
router.get('/follow-ups/chat', wrap(async (req) => {
  await fu.assertCanReach(req.user, req.query.waNumber, req.query.contactNumber);
  return fu.chatState(req.user, req.query);
}));
router.post('/follow-ups/suggest', wrap(async (req) => {
  const { waNumber, contactNumber } = req.body || {};
  if (!contactNumber) throw Object.assign(new Error('contactNumber is required'), { status: 400 });
  await fu.assertCanReach(req.user, waNumber, contactNumber);
  return fu.suggestFollowUp({ waNumber, contactNumber });
}));
router.get('/follow-ups/google', wrap(async () => fu.googleStatus()));
router.post('/follow-ups/google/sync', wrap(async (req) => fu.syncToGoogle(req.user, req.body || {})));

router.get('/follow-ups', wrap(async (req) => ({ items: await fu.listFollowUps(req.user, req.query) })));
router.post('/follow-ups', wrap(async (req) => {
  const b = req.body || {};
  return fu.setFollowUp(req.user, { ...b, source: b.source === 'ai' ? 'ai' : 'manual' });
}));
router.patch('/follow-ups/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Not found'), { status: 404 });
  return fu.updateFollowUp(req.user, id, req.body || {});
}));
router.delete('/follow-ups/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Not found'), { status: 404 });
  return fu.deleteFollowUp(req.user, id);
}));

module.exports = { router };
