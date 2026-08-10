// Mount a router in a throwaway Express app and drive it over a real socket.
//
// Testing a route handler through HTTP rather than by calling the function
// keeps middleware, JSON parsing, status codes and error handling in the path —
// which is where most route bugs actually live. It also means these suites
// exercise the same code an MCP client or the browser would hit.
//
// Auth is injected rather than faked at the JWT layer: the routers only ever
// read req.user, so setting it directly tests the authorisation logic
// (adminOnly / requirePermission) without needing a login round-trip.

const express = require('express');
const http = require('http');

// makeApp(router, user) -> { url, close() }
// user defaults to an admin; pass a role to exercise the permission gates.
function makeApp(routers, user = { id: 1, username: 'itest', displayName: 'ITest', role: 'admin' }) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.user = user; next(); });
  for (const r of [].concat(routers)) app.use('/api', r);
  // Mirror the real app's shape: an unhandled throw becomes a JSON 500, not an
  // HTML stack trace, so a suite asserting on { error } sees what production
  // would send.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// req(app, method, path, body) -> { status, json, raw }
function req(app, method, path, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      `${app.url}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    r.on('error', (e) => resolve({ status: 0, json: null, raw: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

module.exports = { makeApp, req };
