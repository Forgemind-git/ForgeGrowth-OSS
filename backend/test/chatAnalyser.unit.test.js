// Chat Analyzer — the rules that fail SILENTLY if they regress.
//
// Every case here is one where a wrong implementation still returns a plausible
// analysis and logs no error. That is why they are asserted rather than trusted.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ca = require('../src/services/chatAnalyser');
const mx = require('../src/services/mediaExtract');

// A conversation: 10 text messages interleaved with 2 voice notes and 1 image.
// ids ascend like chat_history.id does.
const CONVO = [
  { id: 1,  message_type: 'text' },
  { id: 2,  message_type: 'audio' },
  { id: 3,  message_type: 'text' },
  { id: 4,  message_type: 'image' },
  { id: 5,  message_type: 'text' },
  { id: 6,  message_type: 'document' },
  { id: 7,  message_type: 'text' },
  { id: 8,  message_type: 'audio' },
  { id: 9,  message_type: 'text' },
  { id: 10, message_type: 'text' },
];

describe('filterToNewMessages — coverage is per modality', () => {
  test('a full read returns everything', () => {
    const out = ca.filterToNewMessages(CONVO, { modalities: ['text'], active: false });
    assert.strictEqual(out.length, CONVO.length);
  });

  test('text-only coverage advances only text', () => {
    const coverage = { text: { seq: 5 } };
    const out = ca.filterToNewMessages(CONVO, { modalities: ['text'], coverage, active: true });
    assert.deepStrictEqual(out.map(r => r.id), [7, 9, 10]);
  });

  // ⚠ THE ONE THAT MATTERS. Text is covered to message 5. Images have never been
  // analysed. Enabling images must re-reach the image at id 4 — BELOW the text
  // watermark. A single conversation-level watermark returns nothing here, and
  // the user is told the chat is up to date while the image is never read.
  test('enabling a new modality re-reaches media BELOW the text watermark', () => {
    const coverage = { text: { seq: 5 } };
    const out = ca.filterToNewMessages(CONVO, { modalities: ['text', 'image'], coverage, active: true });
    const ids = out.map(r => r.id);
    assert.ok(ids.includes(4), 'the image at id 4 must be picked up despite text being covered to 5');
    assert.deepStrictEqual(ids, [4, 7, 9, 10]);
  });

  test('the single-watermark implementation would lose that image', () => {
    // What a naive `id > watermark` filter returns, for contrast.
    const naive = CONVO.filter(r => r.id > 5);
    assert.ok(!naive.some(r => r.message_type === 'image'),
      'demonstrates the bug this design exists to prevent');
  });

  test('each modality advances independently', () => {
    const coverage = { text: { seq: 9 }, audio: { seq: 2 }, image: { seq: 0 } };
    const out = ca.filterToNewMessages(CONVO, { modalities: ['text', 'audio', 'image'], coverage, active: true });
    // text past 9 → 10; audio past 2 → 8; image past 0 → 4
    assert.deepStrictEqual(out.map(r => r.id).sort((a, b) => a - b), [4, 8, 10]);
  });

  test('a modality that was not requested is excluded even when uncovered', () => {
    const coverage = { text: { seq: 0 } };
    const out = ca.filterToNewMessages(CONVO, { modalities: ['text'], coverage, active: true });
    assert.ok(out.every(r => r.message_type === 'text'));
  });

  test('community compares epochs INCLUSIVELY, so a boundary second is re-read', () => {
    // Evolution ids have no order; the watermark is whole seconds and several
    // group messages routinely share one. Re-reading beats losing.
    const rows = [
      { id: 'a', epoch: 100, message_type: 'text' },
      { id: 'b', epoch: 100, message_type: 'text' },
      { id: 'c', epoch: 101, message_type: 'text' },
    ];
    const out = ca.filterToNewMessages(rows, {
      modalities: ['text'], coverage: { text: { epoch: 100 } }, source: 'community', active: true,
    });
    assert.deepStrictEqual(out.map(r => r.id), ['a', 'b', 'c']);
  });
});

describe('resolveModalities', () => {
  const conf = { analyse_text: true, analyse_images: false, analyse_audio: true, analyse_documents: false };

  test('falls back to the saved defaults', () => {
    assert.deepStrictEqual(ca.resolveModalities(conf, null), ['text', 'audio']);
  });

  test('an explicit request overrides the defaults', () => {
    assert.deepStrictEqual(ca.resolveModalities(conf, ['image']), ['image']);
  });

  test('"all" means every modality', () => {
    assert.deepStrictEqual(ca.resolveModalities(conf, ['all']), ['text', 'image', 'audio', 'document']);
  });

  test('an unknown modality is dropped, not passed through to the query', () => {
    assert.deepStrictEqual(ca.resolveModalities(conf, ['text', 'telepathy']), ['text']);
  });

  test('an empty request is not the same as no request', () => {
    // [] means "the caller sent nothing usable" → defaults; the route turns an
    // empty resolved list into a 400 rather than silently analysing nothing.
    assert.deepStrictEqual(ca.resolveModalities(conf, []), ['text', 'audio']);
  });
});

describe('isScopedRequest — a scoped run must never advance coverage', () => {
  test('any of from/to/keyword makes it scoped', () => {
    assert.ok(ca.isScopedRequest({ from: '2026-01-01' }));
    assert.ok(ca.isScopedRequest({ to: '2026-01-01' }));
    assert.ok(ca.isScopedRequest({ keyword: 'refund' }));
  });
  test('null and an empty object are full runs', () => {
    assert.ok(!ca.isScopedRequest(null));
    assert.ok(!ca.isScopedRequest({}));
    assert.ok(!ca.isScopedRequest({ from: '', to: '', keyword: '' }));
  });
});

describe('modalityOf', () => {
  test('both WhatsApp spellings of a voice note map to audio', () => {
    // Cloud API says 'audio', Evolution says 'voice'. Missing either silently
    // drops every voice note from that source.
    assert.strictEqual(ca.modalityOf('audio'), 'audio');
    assert.strictEqual(ca.modalityOf('voice'), 'audio');
  });
  test('anything unrecognised is treated as text, never dropped', () => {
    assert.strictEqual(ca.modalityOf('interactive'), 'text');
    assert.strictEqual(ca.modalityOf('button'), 'text');
    assert.strictEqual(ca.modalityOf(undefined), 'text');
  });
});

describe('cost — estimates from an editable rate card, never a hardcoded price', () => {
  const rateCard = {
    text: { 'gpt-4o-mini': { in: 0.15, out: 0.60 }, default: { in: 1, out: 2 } },
    audio: { 'whisper-1': { perMinute: 0.006 } },
    vision: { default: { in: 0.15, out: 0.60 } },
  };

  test('token cost is per million', () => {
    // 1M in @0.15 + 1M out @0.60 = $0.75 = 750000 micros
    assert.strictEqual(mx.tokenCostMicros(rateCard, 'text', 'gpt-4o-mini', 1e6, 1e6), 750000);
  });

  test('an unknown model falls back to the default rate, not to zero', () => {
    // Silently charging nothing for an unrecognised model would make the whole
    // dashboard under-report the moment someone switches model.
    assert.strictEqual(mx.tokenCostMicros(rateCard, 'text', 'some-new-model', 1e6, 0), 1000000);
  });

  test('a group with no default and no match costs zero rather than throwing', () => {
    assert.strictEqual(mx.tokenCostMicros(rateCard, 'audio', 'whisper-1', 1000, 0), 0);
  });

  test('whisper is priced per minute but billed per second', () => {
    // 30s at $0.006/min = $0.003 = 3000 micros
    assert.strictEqual(mx.audioCostMicros(rateCard, 'whisper-1', 30), 3000);
    assert.strictEqual(mx.audioCostMicros(rateCard, 'whisper-1', 60), 6000);
  });

  test('zero-length audio costs nothing', () => {
    assert.strictEqual(mx.audioCostMicros(rateCard, 'whisper-1', 0), 0);
  });

  test('micros convert to rupees at the configured rate', () => {
    // 750000 micros = $0.75; at 88 INR/USD = 66
    assert.strictEqual(Math.round(mx.microsToInr(750000, 88) * 100) / 100, 66);
  });
});

describe('artifact cache reuse — which statuses are worth retrying', () => {
  test('a successful extraction is reused', () => {
    assert.ok(mx.reusable({ status: 'ok', text: 'hello' }));
  });

  test("'empty' is reused — a scanned PDF has no text layer, and never will", () => {
    // Retrying costs money and returns empty again, forever.
    assert.ok(mx.reusable({ status: 'empty' }));
  });

  test("'skipped' is reused — it was over a cap, and the cap has not moved", () => {
    assert.ok(mx.reusable({ status: 'skipped' }));
  });

  test("'failed' is NOT reused — a network blip must not become permanent", () => {
    assert.ok(!mx.reusable({ status: 'failed' }));
  });

  test('no cached row at all is not reusable', () => {
    assert.ok(!mx.reusable(null));
    assert.ok(!mx.reusable(undefined));
  });
});

describe('coerceVerdict — the model does not get to invent fields', () => {
  test('an invented funnel stage is dropped', () => {
    // cfg.isValidStage is backed by the live funnel config; with none loaded it
    // rejects everything, which is the safe direction.
    const v = ca.coerceVerdict({ summary: 'x', suggested_stage: 'definitely_buying' }, 'chat');
    assert.strictEqual(v.suggested_stage, null);
  });

  test('an out-of-range confidence is clamped, not stored raw', () => {
    assert.strictEqual(ca.coerceVerdict({ confidence: 5 }, 'chat').confidence, 1);
    assert.strictEqual(ca.coerceVerdict({ confidence: -2 }, 'chat').confidence, 0);
    assert.strictEqual(ca.coerceVerdict({ confidence: 'high' }, 'chat').confidence, null);
  });

  test('an intent outside the enum becomes null rather than failing the CHECK', () => {
    assert.strictEqual(ca.coerceVerdict({ intent: 'very high' }, 'chat').intent, null);
    assert.strictEqual(ca.coerceVerdict({ intent: 'high' }, 'chat').intent, 'high');
  });

  test('a group verdict carries NO stage, intent or buying signals', () => {
    // A group has many speakers and no single lead; a stage verdict there would
    // be nonsense presented as fact.
    const v = ca.coerceVerdict({
      summary: 's', suggested_stage: 'new', intent: 'high',
      buying_signals: ['asked the price'], open_questions: ['refund policy?'],
      participants: ['Asha'],
    }, 'community');
    assert.strictEqual(v.suggested_stage, null);
    assert.strictEqual(v.intent, null);
    assert.deepStrictEqual(v.buying_signals, []);
    assert.deepStrictEqual(v.open_questions, ['refund policy?']);
    assert.deepStrictEqual(v.participants, ['Asha']);
  });

  test('lists survive junk entries and are capped', () => {
    assert.deepStrictEqual(ca.cleanList(['a', '', null, { text: 'b' }, 42]), ['a', 'b']);
    assert.strictEqual(ca.cleanList(Array.from({ length: 50 }, (_, i) => `t${i}`)).length, 12);
    assert.deepStrictEqual(ca.cleanList('not a list'), []);
  });
});

describe('foldTranscript — the opening of a conversation is never dropped', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ line: `[t] speaker: message ${i}`, ts: new Date() }));

  test('a short transcript is untouched', () => {
    const r = ca.foldTranscript(lines.slice(0, 10), { messageCap: 60, charCap: 99999 });
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.text.split('\n').length, 10);
  });

  test('truncation keeps the head, not just the tail', () => {
    // The opening messages carry the source, the qualifying answers and the
    // stated goal — exactly what a stage verdict needs. Keeping only recent
    // small talk is the wrong trade.
    const r = ca.foldTranscript(lines, { messageCap: 20, charCap: 99999 });
    assert.ok(r.truncated);
    assert.ok(r.text.includes('message 0'), 'the first message must survive');
    assert.ok(r.text.includes('message 99'), 'the last message must survive');
    assert.ok(r.text.includes('earlier messages omitted'));
  });
});

describe('buildSystemPrompt', () => {
  test('a text-only run tells the model NOT to guess at media', () => {
    // Without this the model narrates what it imagines an [image] contained.
    const p = ca.buildSystemPrompt({ source: 'chat', stages: ['new'], modalities: ['text'], incremental: false });
    assert.match(p, /do NOT guess/i);
  });

  test('a media run explains the inline markers instead', () => {
    const p = ca.buildSystemPrompt({ source: 'chat', stages: ['new'], modalities: ['text', 'audio'], incremental: false });
    assert.match(p, /\[voice note\]/);
    assert.doesNotMatch(p, /do NOT guess/i);
  });

  test('an incremental run is told it is seeing only the new messages', () => {
    const p = ca.buildSystemPrompt({ source: 'chat', stages: ['new'], modalities: ['text'], incremental: true });
    assert.match(p, /PREVIOUS analysis/i);
    assert.match(p, /UPDATED analysis/i);
  });

  test('a group prompt never asks for a funnel stage', () => {
    const p = ca.buildSystemPrompt({ source: 'community', stages: ['new', 'hot'], modalities: ['text'], incremental: false });
    assert.doesNotMatch(p, /suggested_stage/);
    assert.match(p, /open_questions/);
  });
});

describe('priorSummaryText — what an incremental run carries forward', () => {
  test('nothing to carry forward yields an empty string', () => {
    assert.strictEqual(ca.priorSummaryText(null), '');
    assert.strictEqual(ca.priorSummaryText({ summary: null }), '');
  });

  test('the previous verdict is rendered compactly', () => {
    const t = ca.priorSummaryText({
      summary: 'Wants the weekend batch', intent: 'high', sentiment: 'positive',
      objections: ['too expensive'], topics: ['pricing'], next_action: 'Send the fee structure',
    });
    assert.match(t, /Wants the weekend batch/);
    assert.match(t, /Intent: high/);
    assert.match(t, /too expensive/);
  });
});

// ── the transcript ────────────────────────────────────────────────────────────

const { readScope } = require('../src/routes/chatAnalyser');

describe('readScope — a date range is inclusive, and a bare date is an IST day', () => {
  // ⚠ Every date input in this app sends `YYYY-MM-DD`. `new Date('2026-07-17')`
  // is UTC midnight, so as an upper bound it excludes the whole day the user
  // just asked to include, and as a lower bound it starts 5.5h late in IST.
  // Both read as "the filter found fewer messages", never as an error.

  test('a bare "to" covers to the END of that IST day', () => {
    const s = readScope({ to: '2026-07-17' });
    // 23:59:59.999 IST == 18:29:59.999Z the same day
    assert.strictEqual(s.to, '2026-07-17T18:29:59.999Z');
  });

  test('a bare "from" starts at the BEGINNING of that IST day', () => {
    const s = readScope({ from: '2026-07-17' });
    // 00:00 IST == 18:30Z the PREVIOUS day
    assert.strictEqual(s.from, '2026-07-16T18:30:00.000Z');
  });

  test('from == to is a whole single day, not an empty instant', () => {
    const s = readScope({ from: '2026-07-17', to: '2026-07-17' });
    assert.ok(new Date(s.from) < new Date(s.to));
    const hours = (new Date(s.to) - new Date(s.from)) / 3600000;
    assert.ok(hours > 23.9 && hours < 24, `a single-day range should span ~24h, got ${hours}`);
  });

  test('the naive implementation would produce an empty range', () => {
    // What `new Date('2026-07-17')` for both bounds gives, for contrast.
    assert.strictEqual(new Date('2026-07-17').toISOString(), new Date('2026-07-17').toISOString());
  });

  test('a full timestamp is honoured exactly, not rounded to a day', () => {
    const s = readScope({ from: '2026-07-17T09:37:15.722Z' });
    assert.strictEqual(s.from, '2026-07-17T09:37:15.722Z');
  });

  test('nothing asked for is null, not an empty scope', () => {
    // A `{}` scope would make every run look scoped and stop it advancing coverage.
    assert.strictEqual(readScope({}), null);
    assert.strictEqual(readScope({ from: '', to: '', keyword: '' }), null);
  });

  test('a keyword alone is still a scope', () => {
    assert.deepStrictEqual(readScope({ keyword: ' refund ' }), { from: null, to: null, keyword: 'refund' });
  });

  test('an unreal date is refused rather than silently ignored', () => {
    assert.throws(() => readScope({ from: 'not-a-date' }), /not a real date/);
    assert.throws(() => readScope({ from: '2026-07-20', to: '2026-07-10' }), /after the "to" date/);
  });
});

describe('transcriptToText — a gap must never look like silence', () => {
  const at = '2026-07-17T09:37:15.000Z';
  const render = (entries) => ca.transcriptToText({ entries });

  test('a typed message renders as itself', () => {
    assert.match(render([{ at, speaker: 'customer', type: 'text', text: 'what is the fee?' }]), /customer: what is the fee\?$/);
  });

  test('a transcribed voice note is MARKED as one', () => {
    // Otherwise a reader cannot tell spoken words from typed ones, which
    // matters when quoting a customer back to them.
    assert.match(render([{ at, speaker: 'customer', type: 'audio', text: 'can I pay in two parts', isTranscript: true }]),
      /\[voice note\] can I pay in two parts/);
  });

  test('an UNtranscribed voice note says so, and is not dropped', () => {
    const out = render([{ at, speaker: 'customer', type: 'audio', text: '', pending: true }]);
    assert.match(out, /not transcribed yet/);
  });

  test('an unreadable voice note carries its reason', () => {
    const out = render([{ at, speaker: 'us', type: 'audio', text: '', unreadable: true, note: 'over the 300s limit' }]);
    assert.match(out, /over the 300s limit/);
  });

  test('an image is listed with its caption but never described', () => {
    const out = render([{ at, speaker: 'us', type: 'image', text: '', caption: 'the brochure' }]);
    assert.match(out, /\[image\] the brochure/);
  });

  test('every entry produces exactly one line, so nothing is silently lost', () => {
    const entries = [
      { at, speaker: 'customer', type: 'text', text: 'hi' },
      { at, speaker: 'customer', type: 'audio', text: '', pending: true },
      { at, speaker: 'us', type: 'image', text: '' },
      { at, speaker: 'us', type: 'document', text: '', filename: 'fees.pdf' },
    ];
    assert.strictEqual(render(entries).split('\n').length, entries.length);
  });
});

describe('timing the analyser is given', () => {
  const now = new Date('2026-09-23T12:00:00Z');                 // 17:30 IST
  const row = (direction, iso) => ({ direction, timestamp: new Date(iso) });

  test('midnight is 00:xx, never 24:xx', () => {
    assert.match(ca.istStamp('2026-09-22T18:47:00Z'), /00:17/);
    assert.doesNotMatch(ca.istStamp('2026-09-22T18:47:00Z'), /24:17/);
  });

  test('durations read like a person would say them', () => {
    assert.strictEqual(ca.durationText(5 * 60000), '5 min');
    assert.strictEqual(ca.durationText((6 * 60 + 43) * 60000), '6h 43m');
    assert.strictEqual(ca.durationText(50 * 3600000), '2 days 2h');
  });

  test('customer wrote last → they are waiting on us, from their FIRST unanswered message', () => {
    const t = ca.timingText([
      row('outgoing', '2026-09-23T01:37:00Z'),
      row('incoming', '2026-09-23T04:16:00Z'),
      row('incoming', '2026-09-23T04:30:00Z'),
    ], now);
    assert.match(t, /CUSTOMER wrote last/);
    assert.match(t, /waiting for OUR reply for 7h 44m/);
    assert.match(t, /window: OPEN/);
  });

  test('we wrote last → counts our unanswered messages and reports reply times', () => {
    const t = ca.timingText([
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
    const t = ca.timingText([row('incoming', '2026-09-21T10:00:00Z'), row('outgoing', '2026-09-21T10:05:00Z')], now);
    assert.match(t, /window: CLOSED/);
  });
});

describe('prompt: our own answers and files are facts, not open questions', () => {
  const p = ca.buildSystemPrompt({ source: 'chat', stages: ['new'], modalities: ['text'], incremental: false,
    context: { text: 'PRODUCTS WE SELL:\n1. Course', productNames: ['Course'] } });
  test('an answer WE already gave is settled — no "confirm with the team"', () => {
    assert.match(p, /ALREADY ANSWERED by US/);
    assert.match(p, /do not recommend "confirming with the team"/);
  });
  test('the customer already has everything in a file we sent', () => {
    assert.match(p, /FILES WE HAVE SENT THIS CUSTOMER/);
  });
  test('recommendations must say what, when and because', () => {
    assert.match(p, /start with what to do.*WHEN.*because/s);
  });
});
