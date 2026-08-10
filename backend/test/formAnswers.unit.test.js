// Form-answer shape rules, and the backend/frontend mirror.
//
//   node --test test/formAnswers.unit.test.js
//
// `rating` is the first form answer that is not a scalar, and all five of its
// consumers assumed a string or an array. Each one failed DIFFERENTLY and
// SILENTLY on an object, which is why the rules live in one module per side.
//
// The mirror matters more than any single rule here: the browser decides what
// to send using frontend/src/lib/formAnswers.js, and the server decides whether
// to accept it using services/formAnswers.js. If those two disagree the form
// submits and the server 400s on a field the respondent believes they filled
// in — no stack trace, no log line, just a person who cannot submit.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const be = require('../src/services/formAnswers');

// Load the ESM frontend mirror without a bundler: strip the export statements
// and evaluate it, so the real file is under test rather than a copy of it.
// Returns null when the frontend tree is not on disk — it is absent inside the
// backend container image, which ships only src/. Skipping there is right; the
// mirror is checked wherever the whole repo is present (a dev machine and CI).
function loadFrontendMirror() {
  const p = path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'formAnswers.js');
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, 'utf8')
    .replace(/^\s*export\s+default\s+/gm, 'var __default = ')
    .replace(/^\s*export\s+/gm, '');
  const sandbox = { module: {}, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;__api = { isEmptyAnswer, answerToText, normalizeRating, ratingScale, isDisplayOnly, RATING_SCALES };`, sandbox);
  return sandbox.__api;
}

const fe = loadFrontendMirror();

describe('rating normalisation', () => {
  test('an out-of-range star is DISCARDED, never clamped', () => {
    // Clamping a 9 sent to a 5-star field into "5" records a top rating nobody
    // gave — the answer becomes a lie rather than a gap.
    assert.equal(be.normalizeRating({ type: 'rating', scale: 5 }, 9).rating, null);
    assert.equal(be.normalizeRating({ type: 'rating', scale: 4 }, 5).rating, null);
    assert.equal(be.normalizeRating({ type: 'rating', scale: 5 }, 0).rating, null);
    assert.equal(be.normalizeRating({ type: 'rating', scale: 5 }, -3).rating, null);
    // ...and an in-range one survives untouched.
    assert.equal(be.normalizeRating({ type: 'rating', scale: 5 }, 5).rating, 5);
    assert.equal(be.normalizeRating({ type: 'rating', scale: 4 }, 4).rating, 4);
  });

  test('an unknown scale falls back to 5 rather than accepting anything', () => {
    for (const bad of [undefined, null, 0, 7, 'five', -1, 100]) {
      assert.equal(be.ratingScale({ scale: bad }), be.DEFAULT_RATING_SCALE,
        `scale ${JSON.stringify(bad)} falls back`);
    }
    for (const good of be.RATING_SCALES) {
      assert.equal(be.ratingScale({ scale: good }), good);
      assert.equal(be.ratingScale({ scale: String(good) }), good, 'a string scale still resolves');
    }
  });

  test('the wire value may be junk — this parses a PUBLIC request body', () => {
    const f = { type: 'rating', scale: 5 };
    for (const junk of [null, undefined, '', 'abc', {}, [], [1, 2], { rating: 'x' }, { nope: 1 }, true]) {
      const out = be.normalizeRating(f, junk);
      assert.equal(out.rating, null, `${JSON.stringify(junk)} -> no rating`);
      assert.equal(typeof out.feedback, 'string', 'feedback is always a string');
    }
    // A numeric string is a legitimate wire shape.
    assert.equal(be.normalizeRating(f, '4').rating, 4);
    assert.equal(be.normalizeRating(f, { rating: '4' }).rating, 4);
  });

  test('feedback is capped so a public endpoint cannot store unbounded text', () => {
    const out = be.normalizeRating({ type: 'rating', scale: 5 }, { rating: 3, feedback: 'x'.repeat(5000) });
    assert.equal(out.feedback.length, 2000);
  });
});

describe('emptiness — required means the STAR, not the comment', () => {
  const f = { type: 'rating', scale: 5 };

  test('feedback with no star is still empty', () => {
    // An object is truthy, so the old `v === ''` check passed an unrated field.
    assert.equal(be.isEmptyAnswer(f, { rating: null, feedback: 'loved it' }), true);
    assert.equal(be.isEmptyAnswer(f, { feedback: 'loved it' }), true);
  });

  test('a star with no feedback is answered', () => {
    assert.equal(be.isEmptyAnswer(f, { rating: 4 }), false);
    assert.equal(be.isEmptyAnswer(f, 4), false);
  });

  test('a section collects nothing, so it is ALWAYS empty', () => {
    // Which is why it can never be required — a required heading would block
    // every submission on a question nobody can answer.
    assert.equal(be.isEmptyAnswer({ type: 'section' }, 'anything'), true);
    assert.equal(be.isDisplayOnly('section'), true);
    assert.equal(be.isDisplayOnly('text'), false);
  });

  test('scalar and array emptiness are unchanged by the rating work', () => {
    assert.equal(be.isEmptyAnswer({ type: 'text' }, ''), true);
    assert.equal(be.isEmptyAnswer({ type: 'text' }, null), true);
    assert.equal(be.isEmptyAnswer({ type: 'text' }, 'x'), false);
    assert.equal(be.isEmptyAnswer({ type: 'checkbox' }, []), true);
    assert.equal(be.isEmptyAnswer({ type: 'checkbox' }, ['a']), false);
    // 0 and false are ANSWERS, not blanks.
    assert.equal(be.isEmptyAnswer({ type: 'number' }, 0), false);
    assert.equal(be.isEmptyAnswer({ type: 'boolean' }, false), false);
  });
});

describe('rendering — nothing reaching a human may be [object Object]', () => {
  const f = { type: 'rating', scale: 5 };

  test('a rating renders as n/max, with the comment appended', () => {
    assert.equal(be.answerToText(f, { rating: 4 }), '4/5');
    assert.equal(be.answerToText(f, { rating: 4, feedback: 'loved it' }), '4/5 - loved it');
    assert.equal(be.answerToText({ type: 'rating', scale: 10 }, { rating: 9 }), '9/10');
  });

  test('an unrated field with a comment renders the comment, not a fake score', () => {
    assert.equal(be.answerToText(f, { rating: null, feedback: 'just a note' }), 'just a note');
    assert.equal(be.answerToText(f, { rating: null, feedback: '' }), '');
  });

  test('a section never occupies an export column', () => {
    assert.equal(be.answerToText({ type: 'section' }, 'heading'), '');
  });

  test('the separator is a parameter so the CSV format cannot be rewritten', () => {
    // The export has always joined multi-selects with '; '. Routing the UI and
    // the CSV through one function must not silently change every export
    // someone already parses.
    const multi = { type: 'checkbox' };
    assert.equal(be.answerToText(multi, ['a', 'b']), 'a, b', 'UI default');
    assert.equal(be.answerToText(multi, ['a', 'b'], { separator: '; ' }), 'a; b', 'CSV');
  });

  test('no input shape can produce [object Object]', () => {
    const shapes = [{ a: 1 }, [{ a: 1 }], { rating: 3 }, new Date(0), null, undefined, 0, false, ''];
    for (const type of ['text', 'textarea', 'checkbox', 'boolean', 'number', 'rating', 'section']) {
      for (const v of shapes) {
        const out = be.answerToText({ type, scale: 5 }, v);
        assert.equal(typeof out, 'string', `${type}/${JSON.stringify(v)} returns a string`);
        assert.ok(!out.includes('[object Object]'),
          `${type} + ${JSON.stringify(v)} produced ${out}`);
      }
    }
  });
});

// Guard for the mirror tests: skip (not pass) where the frontend tree is absent.
function skipNoMirror(t) {
  if (!fe) { t.skip('frontend tree not present (backend-only container)'); return true; }
  return false;
}

describe('the frontend mirror agrees with the backend, pair by pair', () => {
  // The browser decides what to SEND with the frontend copy; the server decides
  // whether to ACCEPT it with the backend copy. A divergence does not throw —
  // it makes a field unsubmittable.
  const FIELDS = [
    { type: 'text' }, { type: 'textarea' }, { type: 'email' }, { type: 'phone' },
    { type: 'number' }, { type: 'date' }, { type: 'dropdown' }, { type: 'radio' },
    { type: 'checkbox' }, { type: 'boolean' }, { type: 'section' },
    { type: 'rating', scale: 3 }, { type: 'rating', scale: 4 },
    { type: 'rating', scale: 5 }, { type: 'rating', scale: 10 },
    { type: 'rating' }, { type: 'rating', scale: 99 },
  ];
  const VALUES = [
    null, undefined, '', '   ', 'text', 0, 1, 4, 5, 9, 11, '4', true, false,
    [], ['a'], ['a', 'b'],
    { rating: 4 }, { rating: 4, feedback: 'good' }, { rating: null, feedback: 'note' },
    { rating: 99 }, { rating: 'x' }, {},
  ];

  test(`isEmptyAnswer matches across ${FIELDS.length}x${VALUES.length} pairs`, (t) => {
    if (skipNoMirror(t)) return;
    const diffs = [];
    for (const f of FIELDS) {
      for (const v of VALUES) {
        const a = be.isEmptyAnswer(f, v);
        const b = fe.isEmptyAnswer(f, v);
        if (a !== b) diffs.push(`${JSON.stringify(f)} + ${JSON.stringify(v)}: backend=${a} frontend=${b}`);
      }
    }
    assert.deepEqual(diffs, [], 'no divergence');
  });

  test(`answerToText matches across ${FIELDS.length}x${VALUES.length} pairs`, (t) => {
    if (skipNoMirror(t)) return;
    const diffs = [];
    for (const f of FIELDS) {
      for (const v of VALUES) {
        const a = be.answerToText(f, v);
        const b = fe.answerToText(f, v);
        if (a !== b) diffs.push(`${JSON.stringify(f)} + ${JSON.stringify(v)}: backend=${JSON.stringify(a)} frontend=${JSON.stringify(b)}`);
      }
    }
    assert.deepEqual(diffs, [], 'no divergence');
  });

  test('normalizeRating and ratingScale match', (t) => {
    if (skipNoMirror(t)) return;
    const diffs = [];
    for (const f of FIELDS.filter((x) => x.type === 'rating')) {
      if (be.ratingScale(f) !== fe.ratingScale(f)) diffs.push(`scale ${JSON.stringify(f)}`);
      for (const v of VALUES) {
        const a = be.normalizeRating(f, v);
        const b = fe.normalizeRating(f, v);
        if (a.rating !== b.rating || a.feedback !== b.feedback || a.max !== b.max) {
          diffs.push(`${JSON.stringify(f)} + ${JSON.stringify(v)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
      }
    }
    assert.deepEqual(diffs, [], 'no divergence');
  });

  test('both sides agree on the allowed scales and on display-only types', (t) => {
    if (skipNoMirror(t)) return;
    assert.deepEqual([...fe.RATING_SCALES].sort(), [...be.RATING_SCALES].sort());
    for (const t of ['section', 'text', 'rating']) {
      assert.equal(be.isDisplayOnly(t), fe.isDisplayOnly(t), `isDisplayOnly('${t}')`);
    }
  });
});
