// The "agent fills a form by asking" tool: the schema it exposes to the model,
// the coercion of what comes back, and the shared answers -> lead mapping.
//
//   node --test test/agentForms.unit.test.js
//
// Pure logic — no database, no network. The two modules under test require
// ../src/db, which builds a pg Pool but opens no socket until a query runs, so
// nothing here keeps the event loop alive.
//
// ⚠ Deliberately does NOT require services/mcpService (or anything that pulls in
// the send queue): its Redis connection holds the loop open and hangs `npm test`
// for the whole repo with no output.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { coerceAnswers, propertyFor, isAskable } = require('../src/services/agentFormTools');
const { mapAnswers, missingRequired } = require('../src/services/formSubmission');
const { formatDuration } = require('../src/services/mediaDuration');

// A form shaped like a real one: every field type, a section heading, a
// phone-mapped field, a mapped lead column, a registry custom field and an
// unmapped question.
const FIELDS = [
  { key: 'heading', type: 'section', label: 'About you' },
  { key: 'full_name', type: 'text', label: 'Your name', required: true, mapsTo: 'name' },
  { key: 'phone', type: 'phone', label: 'WhatsApp number', required: true, mapsTo: 'phone' },
  { key: 'email', type: 'email', label: 'Email', mapsTo: 'email' },
  { key: 'age', type: 'number', label: 'Age', mapsTo: 'age' },
  { key: 'goal', type: 'dropdown', label: 'What is your goal', required: true, options: ['Job', 'Freelance', 'Business'] },
  { key: 'topics', type: 'checkbox', label: 'Interested in', options: ['n8n', 'WhatsApp', 'AI'] },
  { key: 'consent', type: 'boolean', label: 'Happy to be contacted' },
  { key: 'when', type: 'date', label: 'Preferred start' },
  { key: 'stars', type: 'rating', label: 'How did you hear about us', scale: 4 },
  { key: 'city_cf', type: 'text', label: 'City', mapsTo: 'cf:home_city' },
  { key: 'notes', type: 'textarea', label: 'Anything else' },
];

const askable = FIELDS.filter(isAskable);

describe('which questions the agent may ask', () => {
  test('a section heading is never asked — it has no answer', () => {
    assert.equal(isAskable({ key: 'h', type: 'section' }), false);
  });

  test('a phone-mapped question is never asked — the chat already knows it', () => {
    // This is the guard that stops an agent asking for a number we have, and
    // stops it being talked into filing answers against a third party.
    assert.equal(isAskable({ key: 'p', type: 'phone', mapsTo: 'phone' }), false);
    // A phone-TYPE field that is not mapped to the lead's phone is a different
    // question (an alternate contact number) and is still asked.
    assert.equal(isAskable({ key: 'alt', type: 'phone', mapsTo: null }), true);
  });

  test('everything else is asked', () => {
    assert.deepEqual(
      askable.map(f => f.key),
      ['full_name', 'email', 'age', 'goal', 'topics', 'consent', 'when', 'stars', 'city_cf', 'notes'],
    );
  });
});

describe('the schema handed to the model', () => {
  test('a dropdown is an enum, so an invalid choice cannot be expressed', () => {
    const p = propertyFor(FIELDS.find(f => f.key === 'goal'));
    assert.equal(p.type, 'string');
    assert.deepEqual(p.enum, ['Job', 'Freelance', 'Business']);
  });

  test('a checkbox is an array of enum items', () => {
    const p = propertyFor(FIELDS.find(f => f.key === 'topics'));
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items.enum, ['n8n', 'WhatsApp', 'AI']);
  });

  test('a rating declares its own scale and requires the star, not the comment', () => {
    const p = propertyFor(FIELDS.find(f => f.key === 'stars'));
    assert.equal(p.type, 'object');
    assert.deepEqual(p.required, ['rating']);
    assert.match(p.properties.rating.description, /1 to 4/);
  });

  test('an options-less dropdown degrades to a free string rather than an empty enum', () => {
    // An empty `enum: []` matches nothing, so the model could never fill it.
    const p = propertyFor({ key: 'x', type: 'dropdown', label: 'X', options: [] });
    assert.equal(p.type, 'string');
    assert.equal(p.enum, undefined);
  });

  test('number and boolean keep their real types', () => {
    assert.equal(propertyFor(FIELDS.find(f => f.key === 'age')).type, 'number');
    assert.equal(propertyFor(FIELDS.find(f => f.key === 'consent')).type, 'boolean');
  });
});

describe('coercing what the model sends back', () => {
  test('a good full answer set coerces with no errors', () => {
    const { answers, errors } = coerceAnswers(FIELDS, {
      full_name: '  Anand  ', email: 'a@b.com', age: '24', goal: 'Job',
      topics: ['n8n', 'AI'], consent: 'yes', when: '2026-09-01',
      stars: { rating: 3, feedback: 'Instagram' }, city_cf: 'Chennai', notes: 'none',
    });
    assert.deepEqual(errors, []);
    assert.equal(answers.full_name, 'Anand');      // trimmed
    assert.equal(answers.age, 24);                  // number, not "24"
    assert.equal(answers.consent, true);            // "yes" -> true
    assert.deepEqual(answers.topics, ['n8n', 'AI']);
    assert.deepEqual(answers.stars, { rating: 3, feedback: 'Instagram' });
  });

  test('an invalid dropdown choice is an ERROR, never a silent drop', () => {
    // Dropping it would leave a required question looking unanswered and the
    // model would loop asking the customer something they already answered.
    const { answers, errors } = coerceAnswers(FIELDS, { goal: 'Retirement' });
    assert.equal(answers.goal, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not a choice/);
    assert.match(errors[0], /Job, Freelance, Business/);
  });

  test('a choice is matched case-insensitively but stored in the form\'s own casing', () => {
    const { answers, errors } = coerceAnswers(FIELDS, { goal: 'job', topics: ['whatsapp'] });
    assert.deepEqual(errors, []);
    assert.equal(answers.goal, 'Job');
    assert.deepEqual(answers.topics, ['WhatsApp']);
  });

  test('a duplicate multi-select choice is stored once', () => {
    const { answers } = coerceAnswers(FIELDS, { topics: ['AI', 'ai', 'AI'] });
    assert.deepEqual(answers.topics, ['AI']);
  });

  test('a rating outside the scale is refused, not clamped', () => {
    // Clamping a 9 sent to a 4-star field into 4 records a top score nobody gave.
    const { answers, errors } = coerceAnswers(FIELDS, { stars: 9 });
    assert.equal(answers.stars, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /1 to 4/);
  });

  test('a bare number is accepted for a rating', () => {
    const { answers, errors } = coerceAnswers(FIELDS, { stars: 3 });
    assert.deepEqual(errors, []);
    assert.deepEqual(answers.stars, { rating: 3 });
  });

  test('a non-numeric number field is an error', () => {
    const { errors } = coerceAnswers(FIELDS, { age: 'twenty-four' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be a number/);
  });

  test('an unparseable boolean is an error rather than a silent false', () => {
    const { answers, errors } = coerceAnswers(FIELDS, { consent: 'maybe' });
    assert.equal(answers.consent, undefined);
    assert.match(errors[0], /yes or no/);
    // …but the real spellings all work, including false-y ones.
    assert.equal(coerceAnswers(FIELDS, { consent: 'no' }).answers.consent, false);
    assert.equal(coerceAnswers(FIELDS, { consent: false }).answers.consent, false);
    assert.equal(coerceAnswers(FIELDS, { consent: '1' }).answers.consent, true);
  });

  test('a key the form does not have is ignored', () => {
    const { answers, errors } = coerceAnswers(FIELDS, { made_up: 'x', full_name: 'A' });
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.keys(answers), ['full_name']);
  });

  test('a section heading and a phone cannot be written even if the model sends them', () => {
    const { answers } = coerceAnswers(FIELDS, { heading: 'hi', phone: '919999999999' });
    assert.equal(answers.heading, undefined);
    assert.equal(answers.phone, undefined);
  });

  test('a non-object payload does not throw', () => {
    for (const junk of [null, undefined, 'text', 42, []]) {
      const { answers, errors } = coerceAnswers(FIELDS, junk);
      assert.deepEqual(answers, {});
      assert.deepEqual(errors, []);
    }
  });
});

describe('required questions', () => {
  test('missing required questions are listed so the agent can ask for them', () => {
    const { answers } = coerceAnswers(FIELDS, { full_name: 'Anand' });
    const missing = missingRequired({ fields: askable, answers });
    // `phone` is required on the form but is NOT askable, so it must not appear
    // here — the chat supplies it, and asking for it would be the bug.
    assert.deepEqual(missing.map(f => f.key), ['goal']);
  });

  test('a rating with only feedback and no star still counts as unanswered', () => {
    const f = [{ key: 'r', type: 'rating', label: 'R', scale: 5, required: true }];
    assert.equal(missingRequired({ fields: f, answers: { r: { feedback: 'nice' } } }).length, 1);
    assert.equal(missingRequired({ fields: f, answers: { r: { rating: 4 } } }).length, 0);
  });

  test('an empty multi-select counts as unanswered', () => {
    const f = [{ key: 'c', type: 'checkbox', label: 'C', options: ['a'], required: true }];
    assert.equal(missingRequired({ fields: f, answers: { c: [] } }).length, 1);
  });
});

describe('answers -> lead mapping (shared with the public form page)', () => {
  const answers = coerceAnswers(FIELDS, {
    full_name: 'Anand', email: 'a@b.com', age: '24', goal: 'Job',
    stars: { rating: 4, feedback: 'loved it' }, city_cf: 'Chennai', notes: 'call me',
  }).answers;

  test('mapped fields become real lead columns', () => {
    const m = mapAnswers({ fields: FIELDS, answers, phone: '919876543210' });
    assert.equal(m.mapped.name, 'Anand');
    assert.equal(m.mapped.email, 'a@b.com');
    assert.equal(m.mapped.age, 24);
  });

  test('a cf: mapping lands under the REGISTRY key, an unmapped field under its own', () => {
    const m = mapAnswers({ fields: FIELDS, answers, phone: '919876543210' });
    assert.equal(m.customFields.home_city, 'Chennai');   // registry key, not city_cf
    assert.equal(m.customFields.city_cf, undefined);
    assert.equal(m.customFields.notes, 'call me');
  });

  test('a rating is FLATTENED for the lead bag', () => {
    // The bag is read by the Leads table and by {{lead.<key>}} in follow-ups;
    // an object renders as "[object Object]" in both.
    const m = mapAnswers({ fields: FIELDS, answers, phone: '919876543210' });
    assert.equal(m.customFields.stars, '4/4 - loved it');
  });

  test('a known phone WINS over a typed one', () => {
    // In a chat the known phone is the contact; on the public page it is the
    // send token's recipient. Both beat a retyped field.
    const withTyped = { ...answers, phone: '910000000000' };
    const m = mapAnswers({ fields: FIELDS, answers: withTyped, phone: '919876543210' });
    assert.equal(m.phone, '919876543210');
  });

  test('with no known phone, a phone-mapped answer is used', () => {
    const withTyped = { ...answers, phone: '910000000000' };
    const m = mapAnswers({ fields: FIELDS, answers: withTyped, phone: null });
    assert.equal(m.phone, '910000000000');
  });

  test('no phone anywhere is allowed — an anonymous response is a real outcome', () => {
    const m = mapAnswers({ fields: FIELDS, answers, phone: null });
    assert.equal(m.phone, null);
  });

  test('a chat fill and a browser fill of the same answers map IDENTICALLY', () => {
    // Both call this one function, which is the point of the shared module —
    // this asserts the property rather than trusting the arrangement.
    const viaChat = mapAnswers({ fields: FIELDS, answers, phone: '919876543210' });
    const viaBrowser = mapAnswers({ fields: FIELDS, answers: { ...answers, phone: '919876543210' }, phone: null });
    assert.deepEqual(viaChat.mapped, viaBrowser.mapped);
    assert.deepEqual(viaChat.customFields, viaBrowser.customFields);
    assert.equal(viaChat.phone, viaBrowser.phone);
  });
});

describe('voice-note duration formatting', () => {
  test('reads naturally at every scale', () => {
    assert.equal(formatDuration(13.7), '14s');
    assert.equal(formatDuration(60), '1m');
    assert.equal(formatDuration(78.74), '1m 19s');
    assert.equal(formatDuration(600), '10m');
  });

  test('junk does not produce NaN in a message shown to an operator', () => {
    assert.equal(formatDuration(null), '0s');
    assert.equal(formatDuration(undefined), '0s');
  });
});
