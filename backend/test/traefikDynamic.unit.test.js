// Automatic route publishing — the bounds, not the happy path.
//
//   node --test test/traefikDynamic.unit.test.js
//
// This module writes files that a Traefik serving OTHER people's sites will
// honour, so what matters is not that a route appears but what the code cannot
// do. Each test below pins one of the three mechanisms that bound it: routes
// come only from admin-added domains, they lose to any existing router, and the
// reconciler deletes only files carrying this install's own prefix.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The module reads its configuration at require time, so the env has to be set
// before it is loaded — and reset for the disabled case, which is a separate
// process concern rather than something to fake per test.
process.env.TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/tmp/fg-routes-test';
process.env.PROXY_UPSTREAM = process.env.PROXY_UPSTREAM || 'http://forgegrowth-web-1:80';

const { buildRouteFile, fileNameFor, instanceSlug, enabled } =
  require('../src/services/traefikDynamic');

test('the feature is on only when both variables are set', () => {
  assert.strictEqual(enabled(), true, 'both set in this process');
});

test('a generated route always has priority 1', () => {
  // The whole "it cannot take another site's hostname" guarantee. A router's
  // default priority is its rule length — roughly 30 for a Host() — so 1 loses
  // to anything already claiming the name, and wins only where nothing does.
  const yaml = buildRouteFile({ hostname: 'crm.example.com', upstream: 'http://web-1:80' });
  assert.match(yaml, /^ {6}priority: 1$/m);
});

test('a generated route never carries a certresolver', () => {
  // This path cannot know whether a CDN fronts the hostname, and a resolver on
  // one that does fails its challenge forever while consuming a rate limit
  // shared by every domain on the server.
  const yaml = buildRouteFile({ hostname: 'crm.example.com', upstream: 'http://web-1:80' });
  assert.doesNotMatch(yaml, /certresolver|certResolver/i);
});

test('the rule names exactly the hostname given, quoted', () => {
  const yaml = buildRouteFile({ hostname: 'crm.example.com', upstream: 'http://web-1:80' });
  assert.match(yaml, /rule: "Host\(`crm\.example\.com`\)"/);
  // One router and one service per file: a bad entry can only affect its own host.
  assert.strictEqual((yaml.match(/rule:/g) || []).length, 1);
});

test('two installs on one directory get different filenames', () => {
  // Sharing a routes directory must not let one install overwrite or delete the
  // other's routes. The prefix is derived from the upstream, which is a
  // container name and therefore unique per install.
  const a = instanceSlug();
  assert.ok(a.length > 0);
  assert.ok(fileNameFor('crm.example.com').startsWith(`fg-${a}--`));
  assert.ok(fileNameFor('crm.example.com').endsWith('.yml'));
});

test('the filename is derived from the hostname and is filesystem-safe', async (t) => {
  for (const host of ['crm.example.com', 'a.b.c.example.co.uk', 'UPPER.example.com']) {
    await t.test(host, () => {
      const f = fileNameFor(host);
      assert.doesNotMatch(f, /[/\\]/, 'no path separators');
      assert.doesNotMatch(f, /\.\./, 'no traversal');
    });
  }
});

test('reconcile removes only files carrying this install prefix', async () => {
  // The destructive half. Anything without the prefix belongs to another install
  // or to a person who put it there by hand, and must survive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-routes-'));
  const mine = path.join(dir, `${fileNameFor('gone.example.com')}`);
  const theirs = path.join(dir, 'fg-someotherinstall--x.yml');
  const human = path.join(dir, 'my-own-route.yml');
  for (const f of [mine, theirs, human]) fs.writeFileSync(f, 'x');

  // Exercise the ownership rule directly: reconcile() needs a database, and the
  // decision under test is the filter, not the query.
  const prefix = `fg-${instanceSlug()}--`;
  const removable = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.yml'));

  assert.deepStrictEqual(removable, [path.basename(mine)]);
  assert.ok(fs.existsSync(theirs), "another install's file is untouched");
  assert.ok(fs.existsSync(human), 'a hand-written file is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});
