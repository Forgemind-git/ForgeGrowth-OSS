'use strict';
// Conversions per Meta ad (services/adConversions.js). Pure logic only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/services/adConversions');

const row = (o) => ({ lead_id: 1, ad_id: 'ad1', channel: 'landing', touched_at: '2026-10-01T05:00:00Z', stage: 'engaged', paid_paise: 0, ...o });

test('counts chats and buyers per ad, best converter first', () => {
  const { ads, totals } = A.aggregateByAd([
    row({ lead_id: 1, ad_id: 'ad1' }),
    row({ lead_id: 2, ad_id: 'ad1', paid_paise: 449900 }),
    row({ lead_id: 3, ad_id: 'ad2', channel: 'ctwa', paid_paise: 200000, adset_id: 's2', campaign_id: 'c2' }),
    row({ lead_id: 4, ad_id: 'ad2', channel: 'ctwa', paid_paise: 249900 }),
  ]);
  assert.equal(ads[0].adId, 'ad2');
  assert.deepEqual(
    { chats: ads[0].chats, ctwa: ads[0].ctwaChats, buyers: ads[0].buyers, revenue: ads[0].revenue, rate: ads[0].conversionRate, adset: ads[0].adsetId, campaign: ads[0].campaignId },
    { chats: 2, ctwa: 2, buyers: 2, revenue: 4499, rate: 100, adset: 's2', campaign: 'c2' });
  assert.deepEqual({ chats: ads[1].chats, buyers: ads[1].buyers, revenue: ads[1].revenue, rate: ads[1].conversionRate },
    { chats: 2, buyers: 1, revenue: 4499, rate: 50 });
  assert.deepEqual(totals, { chats: 4, buyers: 3, paidBuyers: 3, revenue: 8998 });
});

test('an enrolled lead with no Razorpay payment is a buyer with no revenue', () => {
  const { ads } = A.aggregateByAd([row({ stage: 'enrolled' })]);
  assert.deepEqual({ buyers: ads[0].buyers, paid: ads[0].paidBuyers, manual: ads[0].enrolledNoPayment, revenue: ads[0].revenue },
    { buyers: 1, paid: 0, manual: 1, revenue: 0 });
});

test('a fully refunded payment is not a sale', () => {
  const { ads } = A.aggregateByAd([row({ paid_paise: 0, stage: 'hot' }), row({ lead_id: 2, paid_paise: -100 })]);
  assert.equal(ads[0].buyers, 0);
  assert.equal(ads[0].revenue, 0);
});

test('rows without an ad id are ignored', () => {
  assert.deepEqual(A.aggregateByAd([row({ ad_id: null }), row({ ad_id: '  ' })]).ads, []);
});

test('date range defaults to the last 30 IST days and refuses bad input', () => {
  const now = Date.parse('2026-10-04T20:00:00Z');            // already 5 Oct in IST
  assert.deepEqual(A.resolveRange({}, now), { from: '2026-09-06', to: '2026-10-05', days: 30 });
  assert.deepEqual(A.resolveRange({ from: '2026-10-01', to: '2026-10-01' }, now), { from: '2026-10-01', to: '2026-10-01', days: 1 });
  assert.throws(() => A.resolveRange({ from: '2026-10-02', to: '2026-10-01' }, now), /on or before/);
  assert.throws(() => A.resolveRange({ from: '2024-01-01', to: '2026-10-01' }, now), /too long/);
});
