// Custom-domain normalisation and validation — the two pure functions behind
// Admin Settings → Domain.
//
//   node --test test/customDomains.unit.test.js
//
// Worth testing without a database because both sit on security boundaries that
// fail quietly. normalizeHostname decides whether a Host header matches what an
// admin typed: if the two spellings ever diverge, the site holds a valid
// certificate and then refuses its own API calls with a generic 500, which reads
// as "the app is broken" rather than as a configuration mismatch.
// validateHostname decides what the bundled Caddy is allowed to request a public
// certificate for — everything it lets through becomes a real request to a
// certificate authority, and enough failures exhaust the install's rate limit.

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeHostname,
  validateHostname,
  interpretReachability,
} = require('../src/services/domainService');

test('normalizeHostname reduces every spelling of one host to the same value', async (t) => {
  const cases = [
    ['crm.example.com', 'crm.example.com'],
    ['https://crm.example.com', 'crm.example.com'],
    ['http://crm.example.com', 'crm.example.com'],
    ['CRM.Example.COM', 'crm.example.com'],
    ['crm.example.com/', 'crm.example.com'],
    ['crm.example.com/some/path', 'crm.example.com'],
    ['crm.example.com:8080', 'crm.example.com'],
    ['https://crm.example.com:8443/admin', 'crm.example.com'],
    // A fully-qualified name ends in a dot. Browsers send it both ways and it is
    // the same host; storing both would produce a domain that works only
    // sometimes, depending on how the visitor typed it.
    ['crm.example.com.', 'crm.example.com'],
    ['  crm.example.com  ', 'crm.example.com'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ];
  for (const [input, expected] of cases) {
    await t.test(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.strictEqual(normalizeHostname(input), expected);
    });
  }
});

test('normalizeHostname keeps a bracketed IPv6 literal intact', () => {
  // The brackets are part of the host in a URL, and the colons inside must not
  // be mistaken for a port separator.
  assert.strictEqual(normalizeHostname('[2001:db8::1]:8443'), '[2001:db8::1]');
});

test('validateHostname accepts real hostnames', () => {
  for (const h of ['crm.example.com', 'a.b.c.example.com', 'my-crm.example.co.uk']) {
    assert.strictEqual(validateHostname(h), null, `${h} should be accepted`);
  }
});

test('validateHostname refuses what can never get a certificate', async (t) => {
  const rejected = [
    ['', 'empty'],
    ['localhost', 'localhost needs no certificate and cannot have one'],
    ['intranet', 'a bare label has no public certificate authority'],
    ['203.0.113.4', 'Let’s Encrypt does not issue for IP addresses'],
    ['*.example.com', 'wildcards need DNS-01, which this path does not do'],
    ['crm..example.com', 'malformed'],
    ['-crm.example.com', 'a label cannot start with a hyphen'],
    ['crm.example.com-', 'a label cannot end with a hyphen'],
    ['crm example.com', 'a space is not valid in a hostname'],
    ['crm.example.com/evil', 'a path is not a hostname'],
  ];
  for (const [input, why] of rejected) {
    await t.test(`${JSON.stringify(input)} — ${why}`, () => {
      const problem = validateHostname(input);
      assert.ok(problem, `${input} should have been refused`);
      assert.strictEqual(typeof problem, 'string');
      // The message is shown directly to an admin, so it has to read as English
      // rather than as a rule name.
      assert.ok(problem.length > 10, 'the reason should be a sentence');
    });
  }
});

/* --------------------------------------------------------- reachability */

// The reachability check exists because "configured" and "working" are different
// states that look identical from inside the server. Its whole value is that each
// outcome names which of DNS / the proxy / this install is at fault, so the tests
// are about the DISTINCTIONS, not about the wording.

test('a 200 over https is the only unambiguous success', () => {
  const r = interpretReachability({ scheme: 'https', status: 200 });
  assert.strictEqual(r.level, 'ok');
});

test('reachable over http only is not reported as success', () => {
  // It resolves, it routes, it answers — and it still cannot receive a Meta
  // webhook or serve a public form link, both of which require https. Calling
  // that "ok" would be the reassuring answer rather than the true one.
  const r = interpretReachability({ scheme: 'http', status: 200 });
  assert.notStrictEqual(r.level, 'ok');
  assert.match(r.detail, /https/i);
});

test('403 on an active domain means a DIFFERENT install answered', () => {
  // The subtle case, and the reason this check earns its place. This install
  // knows the hostname — it is in the list being checked — so a refusal proves
  // the reply came from somewhere else running the same software. Nothing else
  // in the product can tell that apart from an ordinary routing mistake.
  const r = interpretReachability({ scheme: 'https', status: 403, isActive: true });
  assert.strictEqual(r.level, 'error');
  assert.match(r.title, /another install/i);
});

test('403 on an inactive domain is the expected answer, not a fault', () => {
  const r = interpretReachability({ scheme: 'https', status: 403, isActive: false });
  assert.notStrictEqual(r.level, 'error');
});

test('404 is attributed to the proxy, not to this install', () => {
  const r = interpretReachability({ scheme: 'https', status: 404 });
  assert.strictEqual(r.level, 'error');
  assert.match(r.detail, /proxy|route/i);
});

test('401 names a different application, not a mystery status', () => {
  // Verified against real hosts: an older copy of this software and an unrelated
  // app both answer 401 here, because the path sits behind their login. It is the
  // most common non-200 in practice, so it gets a sentence rather than a number.
  const r = interpretReachability({ scheme: 'https', status: 401 });
  assert.strictEqual(r.level, 'error');
  assert.match(r.title, /different application/i);
});

test('a redirect is a failure, never followed into a false success', async (t) => {
  // The probe uses redirect: 'manual' precisely so this branch is reachable. An
  // app that 302s to its own login page would otherwise resolve to 200 and be
  // reported as "working" — a green light for the exact mistake the check exists
  // to catch.
  for (const status of [301, 302, 307, 308]) {
    await t.test(String(status), () => {
      const r = interpretReachability({ scheme: 'https', status });
      assert.strictEqual(r.level, 'error');
      assert.match(r.title, /redirect/i);
    });
  }
});

test('503 says the request arrived and blames the database', () => {
  // Reaching the app and failing inside it is good news about DNS and routing,
  // and the message has to say so or an admin re-checks their DNS for an hour.
  const r = interpretReachability({ scheme: 'https', status: 503 });
  assert.match(r.detail, /database/i);
});

test('each connection failure is attributed to a different thing', async (t) => {
  const cases = [
    ['ENOTFOUND', /resolve/i],
    ['ECONNREFUSED', /refus|listening/i],
    ['CERT_HAS_EXPIRED', /certificate/i],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /certificate/i],
  ];
  for (const [errorCode, expected] of cases) {
    await t.test(errorCode, () => {
      const r = interpretReachability({ scheme: 'https', errorCode });
      assert.strictEqual(r.level, 'error');
      assert.match(`${r.title} ${r.detail}`, expected);
    });
  }
});

test('a timeout is a warning, not a verdict', () => {
  // A server frequently cannot reach its own public address — plenty of networks
  // do not hairpin — so visitors may be perfectly fine. Reporting this as a
  // definite failure would send someone to dismantle working DNS.
  const r = interpretReachability({ scheme: 'https', errorCode: 'ETIMEDOUT' });
  assert.strictEqual(r.level, 'warn');
  assert.match(r.detail, /another device|own public address/i);
});

test('every outcome is renderable: level, title and detail are always present', async (t) => {
  const outcomes = [
    { scheme: 'https', status: 200 },
    { scheme: 'http', status: 200 },
    { scheme: 'https', status: 403 },
    { scheme: 'https', status: 404 },
    { scheme: 'https', status: 503 },
    { scheme: 'https', status: 418 },
    { scheme: 'https', errorCode: 'ENOTFOUND' },
    { scheme: 'https', errorCode: 'EUNKNOWN' },
  ];
  for (const o of outcomes) {
    await t.test(JSON.stringify(o), () => {
      const r = interpretReachability(o);
      assert.ok(['ok', 'warn', 'error'].includes(r.level), 'level must be renderable');
      assert.ok(r.title && r.title.length > 5, 'needs a title');
      // Shown to an admin who is not a systems administrator, so every branch has
      // to end in an instruction rather than a status code.
      assert.ok(r.detail && r.detail.length > 30, 'needs an actionable sentence');
    });
  }
});

test('validation runs on the normalised value, not the raw input', () => {
  // A caller that validated first and normalised second would accept
  // "https://localhost:3000" — it has a dot and no forbidden characters — and
  // then store "localhost". Ordering is the whole guard here.
  assert.strictEqual(normalizeHostname('https://localhost:3000'), 'localhost');
  assert.ok(validateHostname(normalizeHostname('https://localhost:3000')));
});
