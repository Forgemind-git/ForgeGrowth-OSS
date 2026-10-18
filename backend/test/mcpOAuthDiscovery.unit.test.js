// Discovery metadata for the MCP OAuth server.
//
// ⚠ WHY THIS FILE EXISTS. The protected-resource route used to answer for ANY
// suffix with the canonical document. A Claude connector configured with the
// deprecated /api/mcp/http/<key> url therefore asked about THAT resource, was
// handed a well-formed document describing /api/mcp, completed the entire
// OAuth dance, and only then rejected the mismatch (RFC 9728 §3.3). It
// presented as "Authorization with Forge Growth failed" a few seconds after
// connecting, with a freshly minted token that was never used — nothing in any
// log said which url was wrong. Diagnosed 2026-08-20 from mcp_oauth_tokens
// rows whose last_used_at was NULL.
//
// The route must therefore describe ONLY the resource it actually protects.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { publicRouter } = require('../src/routes/mcpOAuth');

const HOST = 'growth.example.test';

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use('/', publicRouter);
    const srv = app.listen(0, async () => {
      const port = srv.address().port;
      const get = (path) => new Promise((res) => {
        http.get({ port, path, headers: { host: HOST, 'x-forwarded-proto': 'https' } }, (r) => {
          let b = '';
          r.on('data', (d) => { b += d; });
          r.on('end', () => res({ status: r.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
        });
      });
      try { await fn(get); resolve(); } catch (e) { reject(e); } finally { srv.close(); }
    });
  });
}

const PR = '/.well-known/oauth-protected-resource';
const RESOURCE = `https://${HOST}/api/mcp`;

describe('protected-resource metadata', () => {
  test('answers at the bare path', () => withServer(async (get) => {
    const r = await get(PR);
    assert.equal(r.status, 200);
    assert.equal(r.json.resource, RESOURCE);
  }));

  // Clients differ on whether they append the resource path, so both forms
  // must work — answering only one is a common reason discovery fails.
  test('answers when the resource path is appended', () => withServer(async (get) => {
    for (const p of [`${PR}/api/mcp`, `${PR}/api/mcp/`]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.json.resource, RESOURCE, p);
    }
  }));

  // The regression itself.
  test('404s for the deprecated key-in-url resource, naming the right url', () => withServer(async (get) => {
    const r = await get(`${PR}/api/mcp/http/fck_live_abc123`);
    assert.equal(r.status, 404, 'must not describe a resource it does not protect');
    assert.match(r.json.error_description, /\/api\/mcp\/http\/fck_live_abc123/, 'says which path was asked for');
    assert.match(r.json.error_description, new RegExp(RESOURCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'names the correct url');
  }));

  test('404s for any other suffix', () => withServer(async (get) => {
    for (const p of [`${PR}/nope`, `${PR}/api`, `${PR}/api/mcp/v1`]) {
      assert.equal((await get(p)).status, 404, p);
    }
  }));

  // The authorization-server document describes the whole origin and makes no
  // claim about a resource, so it has no equivalent hazard and stays lenient.
  test('authorization-server metadata stays permissive', () => withServer(async (get) => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/mcp']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.json.issuer, `https://${HOST}`);
      assert.deepEqual(r.json.code_challenge_methods_supported, ['S256']);
    }
  }));
});
