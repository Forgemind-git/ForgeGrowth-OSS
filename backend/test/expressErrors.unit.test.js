// util/expressErrors.js — an async route's rejection must reach the error
// handler instead of crashing the process. Before this, GET /api/chatbots/<word>
// threw Postgres 22P02 inside an async handler, nothing caught it, and Node 20
// exited: every user lost the app over one bad link.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');

const { installAsyncErrorForwarding, errorHandler } = require('../src/util/expressErrors');

installAsyncErrorForwarding();

function call(url, method = 'GET', body) {
  return new Promise((resolve) => {
    const r = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      const done = () => { let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); };
      res.on('end', done);
      res.on('close', done);   // cut off mid-response: still settles
    });
    // A destroyed socket (an error after the response started) settles too.
    r.on('error', () => resolve({ status: 0, json: null }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe('expressErrors', () => {
  let server, base;
  const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

  before(async () => {
    const app = express();
    app.use(express.json());
    const r = express.Router();
    r.get('/async-throws', async () => { throw new Error('boom'); });
    r.get('/async-invalid-id', async () => { await Promise.resolve(); throw pgError('22P02'); });
    r.get('/sync-throws', () => { throw new Error('sync boom'); });
    r.get('/ok', async (_req, res) => { res.json({ ok: true }); });
    r.get('/late', async (_req, res) => { res.write('partial'); throw new Error('after headers'); });
    r.post('/echo', (req, res) => res.json(req.body));
    app.use('/api', r);
    // A sub-app mounted the way the Social app is, with the same handler.
    const sub = express();
    sub.get('/api/sub/async', async () => { throw pgError('22P02'); });
    sub.use(errorHandler);
    app.use('/api/sub', (req, res, next) => { req.url = req.originalUrl; sub(req, res, next); });
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((r2) => server.listen(0, '127.0.0.1', r2));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((r) => server.close(r)));

  test('a rejected async handler becomes a JSON 500 and the server keeps serving', async () => {
    const r = await call(`${base}/api/async-throws`);
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(r.json, { error: 'Internal server error' });
    assert.strictEqual((await call(`${base}/api/ok`)).status, 200);
  });

  test('a malformed value in the request (Postgres 22P02) is a 400, in the app and in a sub-app', async () => {
    for (const path of ['/api/async-invalid-id', '/api/sub/async']) {
      const r = await call(base + path);
      assert.strictEqual(r.status, 400, path);
      assert.ok(r.json && typeof r.json.error === 'string', path);
    }
  });

  test('a synchronous throw is still handled', async () => {
    assert.strictEqual((await call(`${base}/api/sync-throws`)).status, 500);
  });

  test('a body that is not JSON is a 400, not a 500', async () => {
    const r = await call(`${base}/api/echo`, 'POST', '{not json');
    assert.strictEqual(r.status, 400);
  });

  test('an error after the response started does not crash the server', async () => {
    await call(`${base}/api/late`);
    assert.strictEqual((await call(`${base}/api/ok`)).status, 200);
  });

  test('installing twice is harmless', () => {
    installAsyncErrorForwarding();
  });
});
