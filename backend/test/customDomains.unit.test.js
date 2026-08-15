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

const { normalizeHostname, validateHostname } = require('../src/services/domainService');

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

test('validation runs on the normalised value, not the raw input', () => {
  // A caller that validated first and normalised second would accept
  // "https://localhost:3000" — it has a dot and no forbidden characters — and
  // then store "localhost". Ordering is the whole guard here.
  assert.strictEqual(normalizeHostname('https://localhost:3000'), 'localhost');
  assert.ok(validateHostname(normalizeHostname('https://localhost:3000')));
});
