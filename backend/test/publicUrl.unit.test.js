// Unit tests for the one place that decides this install's public address.
//
// The bug these guard against does not present as a wrong URL. The server
// issues an OAuth token for whatever host the request arrived on, so a plugin
// pointed at a *different* address for the same install holds a token it can
// never spend — and the client reports that as a credentials error. So the
// assertions that matter are the equality ones at the bottom: the plugin
// download, the connector URL shown in Admin Settings and the OAuth metadata
// must be the same string, for the same request.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { publicHost, publicOrigin, mcpUrl } = require('../src/util/publicUrl');

const req = (headers) => ({ headers });

// The env fallbacks are read at call time, so a test that sets them must put
// them back — node:test shares one process across every file.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('publicUrl — host', () => {
  test('takes the left-most entry of a forwarded chain', () => {
    // Two proxy hops append, so the right-most is the INNER address. Joining
    // the whole header produced "https://a.example.com, b.example.com" in the
    // plugin's .mcp.json — a URL no client can resolve.
    assert.equal(
      publicHost(req({ 'x-forwarded-host': 'crm.example.com, backend:3013' })),
      'crm.example.com',
    );
  });

  test('falls back to the Host header, then to configuration', () => {
    assert.equal(publicHost(req({ host: 'crm.example.com' })), 'crm.example.com');
    withEnv({ TLS_DOMAIN: 'crm.example.com', CORS_ORIGIN: undefined, FORGECRM_DOMAIN: undefined }, () => {
      assert.equal(publicHost(req({})), 'crm.example.com');
    });
    withEnv({ TLS_DOMAIN: '', CORS_ORIGIN: 'https://crm.example.com', FORGECRM_DOMAIN: undefined }, () => {
      assert.equal(publicHost(req({})), 'crm.example.com');
    });
  });

  test('the request beats configuration', () => {
    // A stale TLS_DOMAIN from a previous domain must not override the address
    // the admin is demonstrably reaching the page on.
    withEnv({ TLS_DOMAIN: 'old.example.com' }, () => {
      assert.equal(publicHost(req({ host: 'new.example.com' })), 'new.example.com');
    });
  });

  test('empty when nothing says', () => {
    withEnv({ TLS_DOMAIN: '', CORS_ORIGIN: '', FORGECRM_DOMAIN: '' }, () => {
      assert.equal(publicHost(req({})), '');
      assert.equal(publicOrigin(req({})), '');
      assert.equal(mcpUrl(req({})), '');
    });
  });
});

describe('publicUrl — scheme', () => {
  test('a public host is always https', () => {
    // `trust proxy` is off, so a TLS request with no forwarded header reports
    // http. An http issuer is rejected by MCP clients outright, and there is no
    // deployment that reaches a public hostname without TLS somewhere.
    assert.equal(publicOrigin(req({ host: 'crm.example.com' })), 'https://crm.example.com');
    assert.equal(
      publicOrigin(req({ host: 'crm.example.com', 'x-forwarded-proto': 'http' })),
      'https://crm.example.com',
    );
  });

  test('loopback keeps http', () => {
    // The case that shipped an unusable plugin: the host was substituted into a
    // hardcoded https:// prefix, so a localhost install downloaded a connector
    // pointed at a port that speaks plain HTTP.
    withEnv({ CORS_ORIGIN: 'http://localhost:8080' }, () => {
      assert.equal(publicOrigin(req({ host: 'localhost:8080' })), 'http://localhost:8080');
      assert.equal(publicOrigin(req({ host: '127.0.0.1:8080' })), 'http://127.0.0.1:8080');
    });
  });

  test('a TLS-terminating proxy in front of localhost still gets https', () => {
    assert.equal(
      publicOrigin(req({ host: 'localhost:8080', 'x-forwarded-proto': 'https' })),
      'https://localhost:8080',
    );
  });
});

describe('publicUrl — every consumer agrees', () => {
  const cases = [
    { headers: { host: 'crm.example.com' }, expect: 'https://crm.example.com' },
    { headers: { 'x-forwarded-host': 'crm.example.com, backend:3013', 'x-forwarded-proto': 'https,http' }, expect: 'https://crm.example.com' },
    { headers: { host: 'localhost:8080' }, expect: 'http://localhost:8080' },
  ];

  test('mcpUrl is the origin plus /api/mcp', () => {
    withEnv({ CORS_ORIGIN: 'http://localhost:8080' }, () => {
      for (const c of cases) {
        assert.equal(publicOrigin(req(c.headers)), c.expect);
        assert.equal(mcpUrl(req(c.headers)), `${c.expect}/api/mcp`);
      }
    });
  });

  test('the OAuth layer and the HTTP transport resolve through this module', () => {
    // Both used to carry their own copy. If either grows one again, the plugin
    // can point somewhere the token was not issued for and the failure reads as
    // a credentials problem.
    for (const rel of ['../src/routes/mcpOAuth.js', '../src/mcpHttp.js']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      assert.match(src, /require\('\.\.?\/(\.\.\/)?util\/publicUrl'\)/,
        `${rel} must resolve its public address through util/publicUrl`);
      assert.doesNotMatch(src, /x-forwarded-host/,
        `${rel} must not read forwarded headers itself`);
    }
  });

  test('the plugin ships the placeholder the download substitutes', () => {
    // The substitution is on the ORIGIN. A .mcp.json that hardcoded https:// and
    // left only the hostname to be replaced could not express an http install.
    const pluginDir = path.join(__dirname, '..', '..', 'forge-growth-plugin');
    if (!fs.existsSync(pluginDir)) return;   // backend copied alone into the image
    const cfg = fs.readFileSync(path.join(pluginDir, '.mcp.json'), 'utf8');
    assert.match(cfg, /https:\/\/YOUR-FORGE-GROWTH-HOST\/api\/mcp/);

    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'mcp.js'), 'utf8');
    assert.match(routes, /PLUGIN_ORIGIN_PLACEHOLDER = 'https:\/\/YOUR-FORGE-GROWTH-HOST'/);

    // And the result of substituting is exactly what the panel and the OAuth
    // metadata would say for the same request.
    withEnv({ CORS_ORIGIN: 'http://localhost:8080' }, () => {
      for (const c of cases) {
        const substituted = JSON.parse(
          cfg.split('https://YOUR-FORGE-GROWTH-HOST').join(publicOrigin(req(c.headers))),
        );
        assert.equal(substituted.mcpServers['forge-growth'].url, mcpUrl(req(c.headers)));
      }
    });
  });
});
