// services/analyserContext.js — the business context block handed to the Chat Analyzer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBlock, CONTEXT_CHAR_CAP } = require('../src/services/analyserContext');

test('no business text and no active product → empty block with an EMPTY hash (old analyses are not all stale)', () => {
  const b = buildBlock({ business: '  ', products: [{ name: 'X', details: 'y', active: false }] });
  assert.equal(b.text, '');
  assert.equal(b.hash, '');
});

test('business + active products are included; inactive ones are not; names are listed', () => {
  const b = buildBlock({
    business: 'We teach AI in Tamil.',
    products: [
      { name: 'Claude course', price: '₹5,499', details: 'Batch 12 Oct', active: true },
      { name: 'Old course', price: '', details: 'retired', active: false },
    ],
  });
  assert.match(b.text, /ABOUT THE BUSINESS:\nWe teach AI in Tamil\./);
  assert.match(b.text, /1\. Claude course — price: ₹5,499\nBatch 12 Oct/);
  assert.doesNotMatch(b.text, /Old course/);
  assert.deepEqual(b.productNames, ['Claude course']);
  assert.equal(b.hash.length, 16);
});

test('the hash changes when the context changes and not otherwise', () => {
  const a = buildBlock({ business: 'A', products: [] });
  assert.equal(buildBlock({ business: 'A', products: [] }).hash, a.hash);
  assert.notEqual(buildBlock({ business: 'B', products: [] }).hash, a.hash);
});

test('the block is capped, and one huge paste cannot crowd out the other products', () => {
  const big = 'x'.repeat(50000);
  const b = buildBlock({ business: '', products: [
    { name: 'Huge', details: big, active: true },
    { name: 'Small', details: 'keep me', active: true },
  ] });
  assert.ok(b.text.length <= CONTEXT_CHAR_CAP + 200, `block is ${b.text.length} chars`);
  assert.ok(b.truncated);
  assert.match(b.text, /Small\nkeep me/);
});
