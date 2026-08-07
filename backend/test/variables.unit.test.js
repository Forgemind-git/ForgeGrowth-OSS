// Unified variable resolver unit tests — namespaced tokens, legacy-alias
// parity, context gating, and save-time validation (the non-DB paths).
//
// Uses node:test (built into Node 20). Nothing here touches the database or
// the network: the field registry is primed via its test-only injector, and
// only the synchronous branches of stepTokenError are exercised (the form.*
// branch queries lead_forms and is covered by the integration flow instead).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const registry = require('../src/services/fieldRegistry');
const {
  extractTokens, resolveTokens, neededContext, stepTokenError, stringifyVal,
} = require('../src/services/variables');

const LEAD = {
  id: 7,
  name: 'Anita Kumar',
  whatsapp_number: '919876543210',
  email: 'anita@example.com',
  source: 'Instagram Ad',
  stage: 'hot',
  stage_label: 'Hot',
  city: 'Chennai',
  age: 28,
  profession: 'Engineer',
  pincode: '600001',
  paid_course: 'AI Mastery',
  payment_date: '2026-07-15',
  assigned_user_name: 'Priya',
  follow_up_count: 2,
  paid_amount_paise: 550000,
  custom_fields: { batch: 'Aug-2026', interests: ['Automation', 'Ads'], verified: true },
};

beforeEach(() => {
  registry._setFieldsForTests({
    lead: [
      { id: 1, entity: 'lead', fieldKey: 'name', label: 'Name', fieldType: 'text', options: [], isSystem: true, systemColumn: 'name', showInLeads: true, showInSales: true },
      { id: 2, entity: 'lead', fieldKey: 'batch', label: 'Batch', fieldType: 'text', options: [], isSystem: false, systemColumn: null, showInLeads: true, showInSales: true },
      { id: 3, entity: 'lead', fieldKey: 'interests', label: 'Interests', fieldType: 'checkbox', options: ['Automation', 'Ads'], isSystem: false, showInLeads: false, showInSales: true },
      { id: 4, entity: 'lead', fieldKey: 'verified', label: 'Verified', fieldType: 'boolean', options: [], isSystem: false, showInLeads: false, showInSales: false },
    ],
    transaction: [
      { id: 10, entity: 'transaction', fieldKey: 'method', label: 'Method', fieldType: 'dropdown', options: ['UPI'], isSystem: true, systemColumn: 'method', showInSales: true },
      { id: 11, entity: 'transaction', fieldKey: 'invoice_no', label: 'Invoice no.', fieldType: 'text', options: [], isSystem: false, showInSales: true },
    ],
  });
});

describe('legacy alias parity (the old fillVars contract)', () => {
  test('the six aliases resolve exactly as before', () => {
    assert.equal(
      resolveTokens('{{name}} | {{first_name}} | {{phone}} | {{email}} | {{source}} | {{stage}}', { lead: LEAD }),
      'Anita Kumar | Anita | 919876543210 | anita@example.com | Instagram Ad | Hot');
  });
  test('empty name falls back to "there"; other empties to blank', () => {
    assert.equal(resolveTokens('Hi {{name}}!', { lead: {} }), 'Hi there!');
    assert.equal(resolveTokens('Hi {{first_name}}!', { lead: { name: '   ' } }), 'Hi there!');
    assert.equal(resolveTokens('[{{email}}][{{source}}]', { lead: {} }), '[][]');
  });
  test('case-insensitive and whitespace-tolerant', () => {
    assert.equal(resolveTokens('{{ Name }} / {{FIRST_NAME}}', { lead: LEAD }), 'Anita Kumar / Anita');
  });
  test('unknown tokens are left as-is (send-time policy)', () => {
    assert.equal(resolveTokens('Use {{coupon}} today', { lead: LEAD }), 'Use {{coupon}} today');
  });
  test('null/empty input returned unchanged', () => {
    assert.equal(resolveTokens(null, { lead: LEAD }), null);
    assert.equal(resolveTokens('', { lead: LEAD }), '');
  });
});

describe('{{lead.*}} namespace', () => {
  test('system columns resolve from the lead row', () => {
    assert.equal(resolveTokens('{{lead.city}}, {{lead.age}}, {{lead.profession}}', { lead: LEAD }),
      'Chennai, 28, Engineer');
  });
  test('lead.name has NO "there" fallback (only the bare alias does)', () => {
    assert.equal(resolveTokens('[{{lead.name}}]', { lead: {} }), '[]');
  });
  test('assigned_to prefers the user display name', () => {
    assert.equal(resolveTokens('{{lead.assigned_to}}', { lead: LEAD }), 'Priya');
    assert.equal(resolveTokens('{{lead.assigned_to}}', { lead: { assigned_bda: 'Ravi' } }), 'Ravi');
  });
  test('total_paid formats the stamped paise as rupees', () => {
    assert.equal(resolveTokens('{{lead.total_paid}}', { lead: LEAD }), '₹5,500');
  });
  test('custom fields resolve from the bag via the registry', () => {
    assert.equal(resolveTokens('{{lead.batch}}', { lead: LEAD }), 'Aug-2026');
    assert.equal(resolveTokens('{{lead.interests}}', { lead: LEAD }), 'Automation, Ads');
    assert.equal(resolveTokens('{{lead.verified}}', { lead: LEAD }), 'Yes');
  });
  test('a registry-known key with no stored value resolves to blank, an unknown key stays raw', () => {
    assert.equal(resolveTokens('[{{lead.batch}}]', { lead: { custom_fields: {} } }), '[]');
    assert.equal(resolveTokens('{{lead.nonexistent}}', { lead: LEAD }), '{{lead.nonexistent}}');
  });
});

describe('{{sale.*}} namespace', () => {
  const SALE = {
    totalPaidPaise: 750000,
    count: 3,
    last: { amountPaise: 250000, date: '2026-08-01', method: 'UPI' },
    latestCustom: { invoice_no: 'INV-042' },
    lastProductLabel: 'AI Mastery',
  };
  test('computed tokens resolve from the loaded sale data', () => {
    const out = resolveTokens('{{sale.total_paid}} over {{sale.installments}} payments, last {{sale.last_amount}} by {{sale.method}}',
      { lead: LEAD, saleData: SALE });
    assert.equal(out, '₹7,500 over 3 payments, last ₹2,500 by UPI');
  });
  test('product prefers the stamped lead.paid_course', () => {
    assert.equal(resolveTokens('{{sale.product}}', { lead: LEAD, saleData: SALE }), 'AI Mastery');
  });
  test('transaction custom fields resolve from the latest installment', () => {
    assert.equal(resolveTokens('{{sale.invoice_no}}', { lead: LEAD, saleData: SALE }), 'INV-042');
  });
  test('the transaction SYSTEM keys amount/notes resolve too (validation accepts them, so they must)', () => {
    const withNotes = { ...SALE, last: { ...SALE.last, notes: '2nd installment' } };
    assert.equal(resolveTokens('{{sale.amount}} — {{sale.notes}}', { lead: LEAD, saleData: withNotes }),
      '₹2,500 — 2nd installment');
  });
  test('lead.total_paid prefers the LIVE union when sale context is loaded (stamped column can lag)', () => {
    assert.equal(resolveTokens('{{lead.total_paid}}', { lead: LEAD }), '₹5,500'); // stamped
    assert.equal(resolveTokens('{{lead.total_paid}}', { lead: LEAD, saleData: SALE }), '₹7,500'); // live
  });
  test('without loaded context the token stays raw — never guessed', () => {
    assert.equal(resolveTokens('{{sale.total_paid}}', { lead: LEAD }), '{{sale.total_paid}}');
  });
  test('a lead with no payments resolves to zeros/blanks, not raw braces', () => {
    const empty = { totalPaidPaise: 0, count: 0, last: null, latestCustom: {}, lastProductLabel: null };
    assert.equal(resolveTokens('{{sale.total_paid}}|{{sale.installments}}|{{sale.last_amount}}', { lead: {}, saleData: empty }),
      '₹0|0|');
  });
});

describe('{{form.<slug>.<key>}} namespace', () => {
  test('resolves from the loaded latest submission; loaded-but-empty gives blank', () => {
    const ctx = { lead: LEAD, formAnswers: { webinar: { field_1: 'Yes', field_2: ['A', 'B'] }, other: {} } };
    assert.equal(resolveTokens('{{form.webinar.field_1}} / {{form.webinar.field_2}}', ctx), 'Yes / A, B');
    assert.equal(resolveTokens('[{{form.other.field_9}}]', ctx), '[]');
  });
  test('an unloaded form slug stays raw', () => {
    assert.equal(resolveTokens('{{form.unknown.f}}', { lead: LEAD, formAnswers: { webinar: {} } }), '{{form.unknown.f}}');
    assert.equal(resolveTokens('{{form.webinar.f}}', { lead: LEAD }), '{{form.webinar.f}}');
  });
});

describe('token grammar boundaries', () => {
  test('{{1}}-style positional template variables are never matched', () => {
    assert.equal(resolveTokens('Body {{1}} and {{2}}', { lead: LEAD }), 'Body {{1}} and {{2}}');
    assert.deepEqual(extractTokens('{{1}} {{name}} {{2}}'), ['name']);
  });
  test('extractTokens dedupes and keeps namespaces', () => {
    assert.deepEqual(
      extractTokens('{{name}} {{name}} {{sale.total_paid}} {{form.x.y}}').sort(),
      ['form.x.y', 'name', 'sale.total_paid']);
  });
  test('neededContext flags only what the texts reference', () => {
    assert.deepEqual(neededContext(['hi {{name}}']), { sale: false, formSlugs: [] });
    assert.deepEqual(neededContext(['{{sale.total_paid}}', '{{form.a.k}} {{form.b.k}}']),
      { sale: true, formSlugs: ['a', 'b'] });
    // lead.total_paid loads sale data so it reads the live union.
    assert.equal(neededContext(['{{lead.total_paid}}']).sale, true);
  });
});

describe('stepTokenError — save-time validation (non-DB branches)', () => {
  test('legacy aliases and known lead/sale tokens pass', async () => {
    assert.equal(await stepTokenError(['Hi {{first_name}}, {{lead.batch}} starts soon — paid {{sale.total_paid}}']), null);
  });
  test('a plain unknown token is rejected with its name', async () => {
    const err = await stepTokenError(['Use {{coupon}}']);
    assert.match(err, /\{\{coupon\}\}/);
  });
  test('an unknown lead field is rejected', async () => {
    const err = await stepTokenError(['{{lead.nope}}']);
    assert.match(err, /lead\.nope/);
  });
  test('an unknown sale token is rejected', async () => {
    const err = await stepTokenError(['{{sale.nope}}']);
    assert.match(err, /sale\.nope/);
  });
  test('an incomplete form token is rejected', async () => {
    const err = await stepTokenError(['{{form.only_slug}}']);
    assert.match(err, /incomplete/);
  });
});

describe('stringifyVal', () => {
  test('arrays join, booleans become Yes/No, null becomes blank', () => {
    assert.equal(stringifyVal(['a', 'b']), 'a, b');
    assert.equal(stringifyVal(true), 'Yes');
    assert.equal(stringifyVal(false), 'No');
    assert.equal(stringifyVal(null), '');
    assert.equal(stringifyVal(42), '42');
  });
});
