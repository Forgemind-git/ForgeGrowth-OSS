// Payments dashboard helpers — pure functions only (no DB).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildSeries, productLabel, bucketStart, ledgerWhere } = require('../src/services/paymentTrend');

test('quiet days are zero-filled so the line does not skip them', () => {
  const s = buildSeries([
    { period: '2026-09-01', key: 'upi', amount_paise: 100000, refunded_paise: 0, count: 1 },
    { period: '2026-09-03', key: 'card', amount_paise: 50000, refunded_paise: 0, count: 2 },
  ], { bucket: 'day', keys: ['upi', 'card'] });
  assert.deepStrictEqual(s.map(b => b.period), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.strictEqual(s[1].amount, 0);
  assert.deepStrictEqual(s[1].split, { upi: 0, card: 0 });
  assert.strictEqual(s[2].count, 2);
});

test('from/to pad the whole requested range, inclusive', () => {
  const s = buildSeries([{ period: '2026-09-02', key: 'upi', amount_paise: 100, count: 1 }],
    { bucket: 'day', from: '2026-09-01', to: '2026-09-04', keys: ['upi'] });
  assert.strictEqual(s.length, 4);
  assert.strictEqual(s[0].period, '2026-09-01');
  assert.strictEqual(s[3].period, '2026-09-04');
});

test('several rows in one period sum, and split per key', () => {
  const s = buildSeries([
    { period: '2026-09-01', key: 'upi', amount_paise: 100000, count: 1 },
    { period: '2026-09-01', key: 'upi', amount_paise: 50050, count: 1 },
    { period: '2026-09-01', key: 'card', amount_paise: 25000, count: 1 },
  ], { keys: ['upi', 'card'] });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].amount, 1750.5);
  assert.strictEqual(s[0].split.upi, 1500.5);
  assert.strictEqual(s[0].count, 3);
});

test('week and month buckets match Postgres date_trunc (ISO Monday / 1st)', () => {
  assert.strictEqual(bucketStart('2026-09-30', 'week'), '2026-09-28'); // Wed → Mon
  assert.strictEqual(bucketStart('2026-09-28', 'week'), '2026-09-28');
  assert.strictEqual(bucketStart('2026-09-27', 'week'), '2026-09-21'); // Sun → prev Mon
  assert.strictEqual(bucketStart('2026-09-30', 'month'), '2026-09-01');
  const s = buildSeries([{ period: '2026-07-01', key: 'x', amount_paise: 1, count: 1 },
    { period: '2026-09-01', key: 'x', amount_paise: 1, count: 1 }], { bucket: 'month', keys: ['x'] });
  assert.deepStrictEqual(s.map(b => b.period), ['2026-07-01', '2026-08-01', '2026-09-01']);
});

test('product labels decode entities and name link payments', () => {
  assert.strictEqual(productLabel('A &amp; B'), 'A & B');
  assert.strictEqual(productLabel('#TdRPJ5Hj2IOXmB'), 'Payment link');
  assert.strictEqual(productLabel(''), 'No description');
  assert.strictEqual(productLabel(null), 'No description');
});

test('date filters use IST days and ignore junk', () => {
  const w = ledgerWhere({ from: '2026-09-01', to: '2026-09-30', status: 'captured' });
  assert.match(w.where, /Asia\/Kolkata/);
  assert.deepStrictEqual(w.params, ['2026-09-01', '2026-09-30']);
  const junk = ledgerWhere({ from: "2026-09-01'; drop", to: 'x' });
  assert.deepStrictEqual(junk.params, []);
  // Summary skips the status filter entirely.
  assert.doesNotMatch(ledgerWhere({ status: 'failed' }, false).where, /failed/);
});

describe('ledgerWhere — amount range + one per payer', () => {
  const { ledgerWhere, rupeesToPaise } = require('../src/services/paymentTrend');

  test('rupees become paise; junk and negatives are ignored, not guessed', () => {
    assert.equal(rupeesToPaise('2000'), 200000);
    assert.equal(rupeesToPaise(1499.5), 149950);
    assert.equal(rupeesToPaise('abc'), null);
    assert.equal(rupeesToPaise('-5'), null);
    assert.equal(rupeesToPaise(''), null);
  });

  test('min and max are inclusive bounds on amount_paise', () => {
    const { where, params } = ledgerWhere({ minAmount: '1500', maxAmount: '2000' }, false);
    assert.match(where, /p\.amount_paise >= \$1/);
    assert.match(where, /p\.amount_paise <= \$2/);
    assert.deepEqual(params, [150000, 200000]);
  });

  test('a bad amount adds no clause', () => {
    const { where, params } = ledgerWhere({ minAmount: 'x' }, false);
    assert.doesNotMatch(where, /amount_paise/);
    assert.deepEqual(params, []);
  });

  test('unique re-applies every other filter inside the subquery, with the same params', () => {
    const { where, params } = ledgerWhere({ status: 'captured', minAmount: 2000, unique: 'first' });
    assert.match(where, /DISTINCT ON/);
    // The amount filter appears twice: once outside, once inside the subquery.
    assert.equal(where.match(/amount_paise >= \$1/g).length, 2);
    assert.match(where, /paid_at ASC/);
    assert.deepEqual(params, [200000]);
    assert.match(ledgerWhere({ unique: 'last' }).where, /paid_at DESC/);
    assert.doesNotMatch(ledgerWhere({ unique: 'bogus' }).where, /DISTINCT ON/);
  });
});
