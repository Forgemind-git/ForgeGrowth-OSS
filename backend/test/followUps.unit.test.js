// Follow-up calendar: the AI date cleaner, the timing the AI is given, and the
// Google Calendar event shape.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const fu = require('../src/services/followUps');

describe('cleanNextFollowUp — what the AI may put on the calendar', () => {
  const now = new Date('2026-09-23T12:00:00Z');                 // 17:30 IST, 23 Sep
  test('a valid future date and time pass through', () => {
    assert.deepStrictEqual(fu.cleanNextFollowUp({ date: '2026-09-25', time: '10:30', reason: 'they asked for Friday' }, now),
      { date: '2026-09-25', time: '10:30', reason: 'they asked for Friday' });
  });
  test('a past date becomes today, never yesterday', () => {
    assert.strictEqual(fu.cleanNextFollowUp({ date: '2026-09-20' }, now).date, '2026-09-23');
  });
  test('IST today, not UTC: 23:30 IST on the 23rd is still the 23rd', () => {
    assert.strictEqual(fu.istToday(new Date('2026-09-23T18:00:00Z')), '2026-09-23');
    assert.strictEqual(fu.istToday(new Date('2026-09-23T19:00:00Z')), '2026-09-24');
  });
  test('more than 90 days out, garbage dates and bad times are refused', () => {
    assert.strictEqual(fu.cleanNextFollowUp({ date: '2027-06-01' }, now), null);
    assert.strictEqual(fu.cleanNextFollowUp({ date: 'next Monday' }, now), null);
    assert.strictEqual(fu.cleanNextFollowUp(null, now), null);
    assert.strictEqual(fu.cleanNextFollowUp({ date: '2026-09-25', time: '25:00' }, now).time, null);
  });
});

describe('timing the follow-up AI is given', () => {
  const now = new Date('2026-09-23T12:00:00Z');                 // 17:30 IST
  const row = (direction, iso) => ({ direction, timestamp: new Date(iso) });

  test('midnight is 00:xx, never 24:xx', () => {
    assert.match(fu.istStamp('2026-09-22T18:47:00Z'), /00:17/);
    assert.doesNotMatch(fu.istStamp('2026-09-22T18:47:00Z'), /24:17/);
  });

  test('durations read like a person would say them', () => {
    assert.strictEqual(fu.durationText(5 * 60000), '5 min');
    assert.strictEqual(fu.durationText((6 * 60 + 43) * 60000), '6h 43m');
    assert.strictEqual(fu.durationText(50 * 3600000), '2 days 2h');
  });

  test('customer wrote last → they are waiting on us, from their FIRST unanswered message', () => {
    const t = fu.timingText([
      row('outgoing', '2026-09-23T01:37:00Z'),
      row('incoming', '2026-09-23T04:16:00Z'),
      row('incoming', '2026-09-23T04:30:00Z'),
    ], now);
    assert.match(t, /CUSTOMER wrote last/);
    assert.match(t, /waiting for OUR reply for 7h 44m/);
    assert.match(t, /window: OPEN/);
  });

  test('we wrote last → counts our unanswered messages and reports reply times', () => {
    const t = fu.timingText([
      row('incoming', '2026-09-23T04:16:00Z'),
      row('outgoing', '2026-09-23T04:22:00Z'),
      row('incoming', '2026-09-23T04:33:00Z'),
      row('outgoing', '2026-09-23T11:16:00Z'),
      row('outgoing', '2026-09-23T11:17:00Z'),
    ], now);
    assert.match(t, /WE wrote last/);
    assert.match(t, /not replied to our last 2 messages/);
    assert.match(t, /Our reply times .*: 6 min, 6h 43m\./);
  });

  test('window closed 24h after their last message', () => {
    const t = fu.timingText([row('incoming', '2026-09-21T10:00:00Z'), row('outgoing', '2026-09-21T10:05:00Z')], now);
    assert.match(t, /window: CLOSED/);
  });
});

describe('Google Calendar event for a follow-up', () => {
  const row = {
    id: 7, person_name: 'Priya', contact_number: '919876500201', wa_number: '919876500100',
    note: 'Send the payment link', lead_stage: null, owner_name: 'Sam',
    due_date_s: '2026-09-25', due_time_s: null,
  };
  test('no time → an all-day event on that IST day', () => {
    const e = fu.eventFor(row);
    assert.deepStrictEqual(e.start, { date: '2026-09-25' });
    assert.deepStrictEqual(e.end, { date: '2026-09-26' });
    assert.match(e.summary, /Follow up: Priya/);
    assert.match(e.description, /Send the payment link/);
    assert.match(e.description, /#\/follow-ups\/919876500100\/919876500201/);
    assert.strictEqual(e.extendedProperties.private.forgegrowthFollowUpId, '7');
  });
  test('with a time → a 30-minute event in Asia/Kolkata', () => {
    const e = fu.eventFor({ ...row, due_time_s: '23:45' });
    assert.deepStrictEqual(e.start, { dateTime: '2026-09-25T23:45:00', timeZone: 'Asia/Kolkata' });
    assert.deepStrictEqual(e.end, { dateTime: '2026-09-26T00:15:00', timeZone: 'Asia/Kolkata' });
  });
});
