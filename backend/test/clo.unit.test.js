// CLO unit tests — payload construction, hashing, retry classification.
//
// Uses node:test, built into Node 20, so the repo gains a test suite without
// gaining a test framework dependency.
//
//   npm test                        (runs everything in test/)
//   node --test test/clo.unit.test.js
//
// Nothing here touches the database or the network.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const clo = require('../src/integrations/metaCloClient');
const match = require('../src/integrations/metaMatchUtil');

const SHA256_HEX = /^[a-f0-9]{64}$/;

describe('CLO payload construction', () => {
  test('carries the three things Meta requires of a CRM event', () => {
    const e = clo.buildCloEvent({
      eventName: 'QualifiedLead',
      eventTime: Date.UTC(2026, 0, 1, 12, 0, 0),
      metaLeadId: '1234567890123456',
      leadEventSource: 'Forge Growth',
    });
    // Any other action_source is accepted by Meta and then unattributable.
    assert.strictEqual(e.action_source, 'system_generated');
    assert.ok(e.lead_event_source && e.lead_event_source.length > 0);
    assert.strictEqual(e.event_name, 'QualifiedLead');
    // Seconds, not milliseconds — Meta reads the wrong century otherwise.
    assert.strictEqual(e.event_time, Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000));
  });

  test('sends the Meta lead id raw, because it is Meta\'s own identifier', () => {
    const e = clo.buildCloEvent({
      eventName: 'QualifiedLead', eventTime: Date.now(),
      metaLeadId: '1234567890123456', leadEventSource: 'Forge Growth',
    });
    assert.strictEqual(e.user_data.lead_id, '1234567890123456');
    assert.strictEqual(e.user_data.ph, undefined, 'must not also send a fallback identifier');
  });

  test('does not leak the CTWA dialect into a CRM event', () => {
    const e = clo.buildCloEvent({
      eventName: 'QualifiedLead', eventTime: Date.now(),
      metaLeadId: '1234567890123456', leadEventSource: 'Forge Growth',
    });
    assert.strictEqual(e.messaging_channel, undefined);
    assert.strictEqual(e.user_data.ctwa_clid, undefined);
  });

  test('falls back to hashed phone and email, never plaintext', () => {
    const e = clo.buildCloEvent({
      eventName: 'QualifiedLead', eventTime: Date.now(),
      metaLeadId: null, leadEventSource: 'Forge Growth',
      phone: '+91 98765-43210', email: '  Foo.Bar@Example.COM ',
    });
    assert.match(e.user_data.ph, SHA256_HEX);
    assert.match(e.user_data.em, SHA256_HEX);
    const serialised = JSON.stringify(e);
    assert.ok(!serialised.includes('9876543210'), 'raw phone must not appear');
    assert.ok(!serialised.toLowerCase().includes('foo.bar@example.com'), 'raw email must not appear');
  });

  test('two spellings of the same phone hash identically', () => {
    // This is the assertion that catches a normalisation regression. A wrong
    // normalisation still returns 200 OK from Meta and matches nobody, so
    // "it sent" proves nothing — only equal hashes do.
    const a = clo.buildCloEvent({ eventName: 'X', eventTime: Date.now(), leadEventSource: 'S', phone: '+91 98765-43210' });
    const b = clo.buildCloEvent({ eventName: 'X', eventTime: Date.now(), leadEventSource: 'S', phone: '9876543210' });
    assert.strictEqual(a.user_data.ph, b.user_data.ph);
  });

  test('a value that is not an email is dropped rather than hashed as noise', () => {
    const e = clo.buildCloEvent({
      eventName: 'X', eventTime: Date.now(), leadEventSource: 'S',
      phone: '919876543210', email: 'Not An Email',
    });
    assert.strictEqual(e.user_data.em, undefined);
    assert.match(e.user_data.ph, SHA256_HEX);
  });

  test('hasIdentifier tells the caller whether Meta can match anything', () => {
    assert.strictEqual(clo.hasIdentifier({ user_data: { lead_id: '123' } }), true);
    assert.strictEqual(clo.hasIdentifier({ user_data: { ph: 'abc' } }), true);
    assert.strictEqual(clo.hasIdentifier({ user_data: {} }), false);
  });
});

describe('CLO retry classification', () => {
  test('server errors and throttling are retryable', () => {
    assert.strictEqual(clo.isRetryable(500, null), true);
    assert.strictEqual(clo.isRetryable(502, null), true);
    assert.strictEqual(clo.isRetryable(503, null), true);
    assert.strictEqual(clo.isRetryable(429, null), true);
  });

  test('Meta throttling codes are retryable whatever the HTTP status', () => {
    for (const code of [4, 17, 32, 613]) {
      assert.strictEqual(clo.isRetryable(200, { code }), true, `code ${code} should retry`);
    }
  });

  test('validation failures are terminal — retrying burns quota forever', () => {
    assert.strictEqual(clo.isRetryable(400, { code: 100 }), false);
    assert.strictEqual(clo.isRetryable(403, { code: 200 }), false);
    assert.strictEqual(clo.isRetryable(404, null), false);
  });
});

describe('CLO token handling', () => {
  test('redact strips the access token', () => {
    const out = clo.redact({ data: [], access_token: 'EAAsecret', test_event_code: 'TEST1' });
    assert.strictEqual(out.access_token, undefined);
    assert.strictEqual(out.test_event_code, 'TEST1', 'non-secret fields survive');
    assert.ok(!JSON.stringify(out).includes('EAAsecret'));
  });

  test('a built event never contains a token in the first place', () => {
    const e = clo.buildCloEvent({
      eventName: 'X', eventTime: Date.now(), metaLeadId: '1', leadEventSource: 'S',
    });
    assert.ok(!JSON.stringify(e).toLowerCase().includes('access_token'));
  });
});

describe('shared normalisation (imported, not duplicated)', () => {
  test('CLO hashes a phone number the way Meta expects', () => {
    // The event must carry sha256 of the NORMALISED value. Hashing the raw
    // string instead is accepted by Meta and then matches nobody — a silent
    // attribution failure, which is why this is asserted rather than trusted.
    const expected = match.sha256(match.normalizeMatchValue('ph', '+91 98765-43210'));
    const viaClo = clo.buildCloEvent({
      eventName: 'X', eventTime: Date.now(), leadEventSource: 'S', phone: '+91 98765-43210',
    }).user_data.ph;
    assert.strictEqual(viaClo, expected);
  });

  test('normalisation strips punctuation and adds the country code', () => {
    assert.strictEqual(match.normalizeMatchValue('ph', '+91 98765-43210'), '919876543210');
    assert.strictEqual(match.normalizeMatchValue('ph', '9876543210'), '919876543210');
    // A value that isn't an email is dropped rather than hashed into noise.
    assert.strictEqual(match.normalizeMatchValue('em', 'Not An Email'), null);
    assert.strictEqual(match.normalizeMatchValue('em', 'A.User@Example.COM'), 'a.user@example.com');
  });
});
