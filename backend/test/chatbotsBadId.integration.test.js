// The request that used to crash the backend: GET /api/chatbots/<not a number>
// made Postgres raise 22P02 inside an async handler that nothing caught.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { probe, skipNoDb, teardown } = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { errorHandler } = require('../src/util/expressErrors');

describe('GET /api/chatbots/:id with a non-numeric id', () => {
  let app;
  before(async () => {
    await probe();
    const express = require('express');
    const { router } = require('../src/routes/chatbots');
    // The real error handler, mounted the way src/index.js mounts it.
    const wrapper = express.Router();
    wrapper.use(router);
    wrapper.use(errorHandler);
    app = await makeApp(wrapper);
  });
  after(async () => { if (app) await app.close(); await teardown(); });

  test('is a 400 and the server keeps serving', async (t) => {
    if (skipNoDb(t)) return;
    const bad = await req(app, 'GET', '/api/chatbots/templates');
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.json && typeof bad.json.error === 'string');
    const list = await req(app, 'GET', '/api/chatbots');
    assert.strictEqual(list.status, 200);
  });
});
