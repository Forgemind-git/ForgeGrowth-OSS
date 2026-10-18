const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateHeaderValue } = require('node:http');
const { contentDisposition } = require('../src/util/contentDisposition');

// The real failure: this exact name made the download route 500.
test('a name with an em dash is a valid header value', () => {
  const v = contentDisposition('Live Lab Sesh 02 — agenda card');
  assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', v));
});

test('the exact name survives in filename*', () => {
  const name = 'Live Lab Sesh 02 — agenda card (v2) it\'s *final*';
  const v = contentDisposition(name);
  const encoded = v.match(/filename\*=UTF-8''(.+)$/)[1];
  assert.equal(decodeURIComponent(encoded), name);
  assert.doesNotMatch(encoded, /['()*]/);
});

test('the ASCII fallback carries no character that could break the header', () => {
  const v = contentDisposition('a"b\\c\r\nSet-Cookie: x=1 — ₹');
  const ascii = v.match(/filename="([^"]*)"/)[1];
  assert.match(ascii, /^[\x20-\x7e]*$/);
  assert.doesNotMatch(ascii, /["\\\r\n]/);
  assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', v));
});

test('a plain name is unchanged in both parts', () => {
  assert.equal(contentDisposition('Live Lab Poster'),
    `inline; filename="Live Lab Poster"; filename*=UTF-8''Live%20Lab%20Poster`);
});

test('an empty name still produces a usable header', () => {
  assert.match(contentDisposition(''), /^inline; filename="file"; /);
  assert.match(contentDisposition(null, 'attachment'), /^attachment; filename="file"; /);
});
