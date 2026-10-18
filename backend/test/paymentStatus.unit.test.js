// Payment status of a sale — the derivation the Sales Log column, the export
// and {{lead.payment_status}} all read. No DB, no network.
const test = require('node:test');
const assert = require('node:assert');
const { derivePaymentStatus, isPaymentStatus, LABELS } = require('../src/services/paymentStatus');

test('derives paid / partial / unpaid from paid vs price', () => {
  assert.deepStrictEqual(derivePaymentStatus({ totalPaidPaise: 500000, pricePaise: 500000 }),
    { status: 'paid', source: 'auto', outstandingPaise: 0 });
  assert.deepStrictEqual(derivePaymentStatus({ totalPaidPaise: 600000, pricePaise: 500000 }),
    { status: 'paid', source: 'auto', outstandingPaise: 0 });
  assert.deepStrictEqual(derivePaymentStatus({ totalPaidPaise: 200000, pricePaise: 500000 }),
    { status: 'partial', source: 'auto', outstandingPaise: 300000 });
  assert.deepStrictEqual(derivePaymentStatus({ totalPaidPaise: 0, pricePaise: 500000 }),
    { status: 'unpaid', source: 'auto', outstandingPaise: 500000 });
});

test('nothing paid is unpaid even with no price; something paid with no price is NOT a guess', () => {
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: 0, pricePaise: null }).status, 'unpaid');
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: null, pricePaise: undefined }).status, 'unpaid');
  // ₹3,000 paid, product has no price: neither "paid" nor "partial" can be asserted.
  assert.deepStrictEqual(derivePaymentStatus({ totalPaidPaise: 300000, pricePaise: null }),
    { status: null, source: null, outstandingPaise: null });
  // A zero price is "no price", not "free".
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: 300000, pricePaise: 0 }).status, null);
});

test('a manual override wins over the derivation', () => {
  const d = derivePaymentStatus({ override: 'paid', totalPaidPaise: 100000, pricePaise: 500000 });
  assert.deepStrictEqual(d, { status: 'paid', source: 'manual', outstandingPaise: 0 });
  const u = derivePaymentStatus({ override: 'unpaid', totalPaidPaise: 500000, pricePaise: 500000 });
  assert.strictEqual(u.status, 'unpaid');
  assert.strictEqual(u.source, 'manual');
  // A manual "partial" still reports what the price says is outstanding.
  const p = derivePaymentStatus({ override: 'partial', totalPaidPaise: 100000, pricePaise: 500000 });
  assert.deepStrictEqual(p, { status: 'partial', source: 'manual', outstandingPaise: 400000 });
});

test('an unknown override is ignored, never stored as a status', () => {
  assert.strictEqual(isPaymentStatus('paid'), true);
  assert.strictEqual(isPaymentStatus('Fully paid'), false);
  assert.strictEqual(isPaymentStatus(''), false);
  assert.strictEqual(isPaymentStatus(null), false);
  const d = derivePaymentStatus({ override: 'whatever', totalPaidPaise: 500000, pricePaise: 500000 });
  assert.strictEqual(d.source, 'auto');
  assert.strictEqual(d.status, 'paid');
});

test('string inputs from pg (bigint → string) are handled', () => {
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: '500000', pricePaise: '500000' }).status, 'paid');
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: '499999', pricePaise: '500000' }).status, 'partial');
});

test('every status has a label', () => {
  for (const k of ['paid', 'partial', 'unpaid']) assert.ok(LABELS[k]);
});

test('a full refund reads Refunded, even over a manual "paid"', () => {
  const d = derivePaymentStatus({ override: 'paid', totalPaidPaise: 549900, pricePaise: 549900, refundedPaise: 549900 });
  assert.strictEqual(d.status, 'refunded');
  assert.strictEqual(d.source, 'auto');
  assert.strictEqual(LABELS.refunded, 'Refunded');
});

test('a partial refund comes off the paid total before comparing', () => {
  const d = derivePaymentStatus({ totalPaidPaise: 549900, pricePaise: 549900, refundedPaise: 200000 });
  assert.strictEqual(d.status, 'partial');
  assert.strictEqual(d.outstandingPaise, 200000);
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: '549900', pricePaise: '549900', refundedPaise: null }).status, 'paid');
});

test('a refund with nothing paid is not "Refunded"', () => {
  assert.strictEqual(derivePaymentStatus({ totalPaidPaise: 0, pricePaise: 549900, refundedPaise: 1000 }).status, 'unpaid');
});
