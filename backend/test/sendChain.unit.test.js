const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chainDecision, parseChainState, formatChainState, gapWaitUntil } = require('../src/queue/sendChain');

const NOW = 1_000_000;

test('the first message in a chain always goes', () => {
  assert.equal(chainDecision({ seq: 1, lastAccepted: 0, now: NOW }), 'send');
});

test('a message without a chain is never held', () => {
  assert.equal(chainDecision({ seq: undefined, lastAccepted: 0, now: NOW }), 'send');
});

test('a later message waits until the one before it was accepted', () => {
  assert.equal(chainDecision({ seq: 3, lastAccepted: 1, now: NOW, giveUpAt: NOW + 5000 }), 'wait');
  assert.equal(chainDecision({ seq: 3, lastAccepted: 2, now: NOW, giveUpAt: NOW + 5000 }), 'send');
});

test('it is enough that the predecessor OR anything later was accepted', () => {
  assert.equal(chainDecision({ seq: 2, lastAccepted: 4, now: NOW }), 'send');
});

test('a failed predecessor cannot stall the chain for ever', () => {
  assert.equal(chainDecision({ seq: 2, lastAccepted: 0, now: NOW, giveUpAt: NOW }), 'send_late');
  assert.equal(chainDecision({ seq: 2, lastAccepted: 0, now: NOW + 1, giveUpAt: NOW }), 'send_late');
});

test('with no give-up time it keeps waiting (the engine always sets one)', () => {
  assert.equal(chainDecision({ seq: 2, lastAccepted: 0, now: NOW }), 'wait');
});

test('chain state round-trips, and a pre-pause bare sequence still reads', () => {
  assert.deepEqual(parseChainState(formatChainState(3, NOW)), { seq: 3, at: NOW });
  assert.deepEqual(parseChainState('2'), { seq: 2, at: 0 });
  assert.deepEqual(parseChainState(null), { seq: 0, at: 0 });
});

test('the pause is counted from when the previous message was accepted', () => {
  assert.equal(gapWaitUntil({ gapMs: 4000, lastAcceptedAt: NOW, now: NOW + 1000 }), NOW + 4000);
  assert.equal(gapWaitUntil({ gapMs: 4000, lastAcceptedAt: NOW, now: NOW + 4000 }), 0);
  assert.equal(gapWaitUntil({ gapMs: 4000, lastAcceptedAt: NOW, now: NOW + 9000 }), 0);
});

test('no pause set, or no acceptance time recorded, never holds a message', () => {
  assert.equal(gapWaitUntil({ gapMs: 0, lastAcceptedAt: NOW, now: NOW }), 0);
  assert.equal(gapWaitUntil({ gapMs: 4000, lastAcceptedAt: 0, now: NOW }), 0);
});
