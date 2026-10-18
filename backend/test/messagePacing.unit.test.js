'use strict';
// Per-message pause ("Pause before this message", node.gapSeconds) on top of the
// flow-wide pause (trigger.messageGapSeconds). Pure — no Redis, no database.
//
// Each rule fails SILENTLY if wrong: a brochure that arrives on the heels of the
// voice note, an opening message that ignores its pause, or — worst — every
// existing flow's timing drifting because the give-up maths changed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextChainFields, messageGapOverrideMs, messageSendDelayMs } = require('../src/engine/automationEngine');
const { gapWaitUntil, CHAIN_GRACE_MS } = require('../src/queue/sendChain');

test('messageGapOverrideMs: blank means "use the flow\'s pause", numbers are seconds, capped', () => {
  for (const v of [undefined, null, '']) assert.equal(messageGapOverrideMs({ gapSeconds: v }), null);
  assert.equal(messageGapOverrideMs({}), null);
  assert.equal(messageGapOverrideMs({ gapSeconds: 20 }), 20000);
  assert.equal(messageGapOverrideMs({ gapSeconds: '4' }), 4000);
  assert.equal(messageGapOverrideMs({ gapSeconds: 0 }), 0, '0 is a real choice: send straight after');
  assert.equal(messageGapOverrideMs({ gapSeconds: 500 }), 120000);
  assert.equal(messageGapOverrideMs({ gapSeconds: -3 }), null);
  assert.equal(messageGapOverrideMs({ gapSeconds: 'soon' }), null);
});

test('the first message of a run applies its own pause as a delay; later ones do not', () => {
  const ctx = {};
  assert.equal(messageSendDelayMs({ gapSeconds: 4 }, ctx), 4000, 'nothing before it to count from');
  ctx.__pendingSendDelayMs = 1000;
  assert.equal(messageSendDelayMs({ gapSeconds: 4 }, ctx), 5000, 'adds to an upstream Delay step');
  ctx.__sendChainSeq = 1;   // one message already queued in this run
  assert.equal(messageSendDelayMs({ gapSeconds: 20 }, ctx), 1000, 'the chain pause handles it from here');
  assert.equal(messageSendDelayMs({}, { __pendingSendDelayMs: 0 }), 0);
});

test('a message\'s own pause overrides the flow\'s, for that message only', () => {
  const ctx = { __messageGapMs: 4000 };
  const gaps = [
    nextChainFields(ctx, 1, 0, messageGapOverrideMs({ gapSeconds: 4 })),  // details
    nextChainFields(ctx, 1, 0, messageGapOverrideMs({})),                 // video (flow's 4 s)
    nextChainFields(ctx, 1, 0, messageGapOverrideMs({})),                 // voice note
    nextChainFields(ctx, 1, 0, messageGapOverrideMs({ gapSeconds: 20 })), // brochure
  ];
  assert.deepEqual(gaps.map(g => g.chainGapMs), [4000, 4000, 4000, 20000]);
  assert.deepEqual(gaps.map(g => g.chainSeq), [1, 2, 3, 4]);
  const k = gaps[0].chainKey;
  assert.ok(gaps.every(g => g.chainKey === k), 'one chain for the whole run');
});

test('a flow with no per-message pauses keeps EXACTLY the old give-up moments', () => {
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const ctx = { __messageGapMs: 4000 };
    for (let seq = 1; seq <= 5; seq++) {
      const f = nextChainFields(ctx, 7, 0, null);
      // the pre-change formula: due + gap * seq + grace
      assert.equal(f.chainGiveUpAt, 1_000_000 + 4000 * seq + CHAIN_GRACE_MS, `seq ${seq}`);
    }
  } finally { Date.now = realNow; }
});

test('a long pause pushes later give-up moments out, so they wait for it', () => {
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const ctx = { __messageGapMs: 4000 };
    const a = nextChainFields(ctx, 1, 0, null);   // 4 s
    const b = nextChainFields(ctx, 1, 0, 20000);  // 20 s
    const c = nextChainFields(ctx, 1, 0, null);   // 4 s
    assert.equal(a.chainGiveUpAt, 4000 + CHAIN_GRACE_MS);
    assert.equal(b.chainGiveUpAt, 24000 + CHAIN_GRACE_MS);
    assert.equal(c.chainGiveUpAt, 28000 + CHAIN_GRACE_MS);
  } finally { Date.now = realNow; }
});

test('timeline: the brochure goes 20 s after the voice note reached WhatsApp', () => {
  const voiceAcceptedAt = 50_000;
  const brochure = nextChainFields({ __messageGapMs: 4000, __sendChainSeq: 3 }, 1, 0, 20000);
  assert.equal(gapWaitUntil({ gapMs: brochure.chainGapMs, lastAcceptedAt: voiceAcceptedAt, now: voiceAcceptedAt + 1000 }), 70_000);
  assert.equal(gapWaitUntil({ gapMs: brochure.chainGapMs, lastAcceptedAt: voiceAcceptedAt, now: 70_001 }), 0, 'then it sends');
});
