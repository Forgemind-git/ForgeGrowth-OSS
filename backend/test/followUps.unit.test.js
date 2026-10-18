// Follow-up calendar: the AI date cleaner and the Google Calendar event shape.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const ca = require('../src/services/chatAnalyser');
const fu = require('../src/services/followUps');

describe('cleanNextFollowUp — what the analyser may put on the calendar', () => {
  const now = new Date('2026-09-23T12:00:00Z');                 // 17:30 IST, 23 Sep
  test('a valid future date and time pass through', () => {
    assert.deepStrictEqual(ca.cleanNextFollowUp({ date: '2026-09-25', time: '10:30', reason: 'they asked for Friday' }, now),
      { date: '2026-09-25', time: '10:30', reason: 'they asked for Friday' });
  });
  test('a past date becomes today, never yesterday', () => {
    assert.strictEqual(ca.cleanNextFollowUp({ date: '2026-09-20' }, now).date, '2026-09-23');
  });
  test('IST today, not UTC: 23:30 IST on the 23rd is still the 23rd', () => {
    assert.strictEqual(ca.istToday(new Date('2026-09-23T18:00:00Z')), '2026-09-23');
    assert.strictEqual(ca.istToday(new Date('2026-09-23T19:00:00Z')), '2026-09-24');
  });
  test('more than 90 days out, garbage dates and bad times are refused', () => {
    assert.strictEqual(ca.cleanNextFollowUp({ date: '2027-06-01' }, now), null);
    assert.strictEqual(ca.cleanNextFollowUp({ date: 'next Monday' }, now), null);
    assert.strictEqual(ca.cleanNextFollowUp(null, now), null);
    assert.strictEqual(ca.cleanNextFollowUp({ date: '2026-09-25', time: '25:00' }, now).time, null);
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
