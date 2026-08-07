// Follow-up engine unit tests — stop rules, variable filling, template gating.
//
// node:test (built into Node 20). Nothing here touches the database or the
// network: these are the pure decision helpers the sweeper keys every send on.
//
//   npm test
//   node --test test/followup.unit.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  computeStopReason, fillVars, templateBlockReason,
  templateVarMax, normalizeTemplateVariables,
} = require('../src/services/followUpEngine');

describe('computeStopReason — the two stop rules', () => {
  const base = {
    stopOnReply: true,
    stopOnStageChange: true,
    enrolledAt: '2026-08-01T10:00:00Z',
    lastInboundAt: null,
    stageNow: 'new',
    stageAtEnrollment: 'new',
  };

  test('no reply, same stage → keep going', () => {
    assert.strictEqual(computeStopReason(base), null);
  });

  test('a reply AFTER enrollment stops the run', () => {
    assert.strictEqual(
      computeStopReason({ ...base, lastInboundAt: '2026-08-01T11:00:00Z' }),
      'replied');
  });

  test('a reply BEFORE enrollment does NOT stop it — that message is why they were enrolled', () => {
    assert.strictEqual(
      computeStopReason({ ...base, lastInboundAt: '2026-08-01T09:00:00Z' }),
      null);
  });

  test('stage change stops the run', () => {
    assert.strictEqual(
      computeStopReason({ ...base, stageNow: 'hot' }),
      'stage_changed');
  });

  test('reply wins over stage change when both apply (reported reason is the human one)', () => {
    assert.strictEqual(
      computeStopReason({ ...base, lastInboundAt: '2026-08-02T00:00:00Z', stageNow: 'hot' }),
      'replied');
  });

  test('stopOnReply=false ignores replies', () => {
    assert.strictEqual(
      computeStopReason({ ...base, stopOnReply: false, lastInboundAt: '2026-08-02T00:00:00Z' }),
      null);
  });

  test('stopOnStageChange=false ignores stage moves', () => {
    assert.strictEqual(
      computeStopReason({ ...base, stopOnStageChange: false, stageNow: 'cold_lost' }),
      null);
  });

  test('manual enrollment with no recorded stage never stage-stops', () => {
    assert.strictEqual(
      computeStopReason({ ...base, stageAtEnrollment: null, stageNow: 'hot' }),
      null);
  });

  test('null lastInboundAt (lead never wrote) never reply-stops', () => {
    assert.strictEqual(computeStopReason({ ...base, lastInboundAt: null }), null);
  });
});

describe('fillVars — per-lead token substitution', () => {
  const lead = { name: 'Priya Sharma', whatsapp_number: '919876543210' };

  test('fills name, first_name and phone', () => {
    assert.strictEqual(
      fillVars('Hi {{first_name}} ({{name}}), we have {{phone}} on file.', lead),
      'Hi Priya (Priya Sharma), we have 919876543210 on file.');
  });

  test('a nameless lead gets "there", never an empty greeting', () => {
    assert.strictEqual(fillVars('Hi {{first_name}}!', { name: null }), 'Hi there!');
    assert.strictEqual(fillVars('Hi {{name}}!', { name: '   ' }), 'Hi there!');
  });

  test('unknown tokens are left as-is (same policy as fillPaymentVars)', () => {
    assert.strictEqual(fillVars('Use {{coupon}} today', lead), 'Use {{coupon}} today');
  });

  test('token match is case-insensitive and space-tolerant', () => {
    assert.strictEqual(fillVars('{{ Name }} / {{FIRST_NAME}}', lead), 'Priya Sharma / Priya');
  });

  test('null/empty text passes through', () => {
    assert.strictEqual(fillVars(null, lead), null);
    assert.strictEqual(fillVars('', lead), '');
  });

  test('email, source and stage label fill from the lead row', () => {
    const rich = { ...lead, email: 'priya@x.example', source: 'Instagram Ad', stage: 'hot', stage_label: 'Hot' };
    assert.strictEqual(
      fillVars('{{email}} / {{source}} / {{stage}}', rich),
      'priya@x.example / Instagram Ad / Hot');
  });

  test('missing email/source fill empty; stage falls back to the key when no label resolved', () => {
    assert.strictEqual(fillVars('[{{email}}][{{source}}]', { name: 'A' }), '[][]');
    assert.strictEqual(fillVars('{{stage}}', { stage: 'cold_lost' }), 'cold_lost');
  });
});

describe('templateBlockReason — what the engine refuses to send', () => {
  const ok = { status: 'APPROVED', header_type: 'NONE', template_type: 'STANDARD' };

  test('approved text-only template passes', () => {
    assert.strictEqual(templateBlockReason(ok), null);
  });

  test('TEXT header also passes (only media headers are blocked)', () => {
    assert.strictEqual(templateBlockReason({ ...ok, header_type: 'TEXT' }), null);
  });

  test('missing template', () => {
    assert.strictEqual(templateBlockReason(null), 'template_missing');
  });

  test('unapproved template — DRAFT, SUBMITTED, REJECTED all block', () => {
    for (const status of ['DRAFT', 'SUBMITTED', 'REJECTED', '']) {
      assert.strictEqual(templateBlockReason({ ...ok, status }), 'template_not_approved');
    }
  });

  test('status compare is case-insensitive (rows store uppercase, but do not rely on it)', () => {
    assert.strictEqual(templateBlockReason({ ...ok, status: 'approved' }), null);
  });

  test('carousel blocks — its cards need per-account media resolution', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, template_type: 'CAROUSEL' }),
      'carousel_not_supported');
  });

  test('media headers block — IMAGE, VIDEO, DOCUMENT', () => {
    for (const h of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
      assert.strictEqual(
        templateBlockReason({ ...ok, header_type: h }),
        'media_header_not_supported');
    }
  });
});

describe('templateBlockReason — variables outside the body are refused', () => {
  const ok = { status: 'APPROVED', header_type: 'NONE', template_type: 'STANDARD' };

  test('a {{1}} in a TEXT header blocks — the engine sends no header component', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, header_type: 'TEXT', header_text: 'Hello {{1}}' }),
      'header_variable_not_supported');
  });

  test('a static TEXT header passes', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, header_type: 'TEXT', header_text: 'Welcome!' }),
      null);
  });

  test('a dynamic URL button blocks — the payment/form template shape', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, buttons: [{ type: 'URL', value: 'https://x.example/pay/{{1}}' }] }),
      'button_variables_not_supported');
  });

  test('a COPY_CODE button blocks', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, buttons: [{ type: 'COPY_CODE', value: 'PROMO50' }] }),
      'button_variables_not_supported');
  });

  test('static URL / QUICK_REPLY / PHONE buttons pass', () => {
    assert.strictEqual(
      templateBlockReason({ ...ok, buttons: [
        { type: 'URL', value: 'https://x.example/pricing' },
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'PHONE_NUMBER', value: '+919999999999' },
      ] }),
      null);
  });

  test('buttons missing / not an array passes', () => {
    assert.strictEqual(templateBlockReason({ ...ok, buttons: null }), null);
  });
});

describe('normalizeTemplateVariables — Meta needs an EXACT body-parameter count', () => {
  test('pads a short list with spaces', () => {
    assert.deepStrictEqual(
      normalizeTemplateVariables(['a'], 'Hi {{1}}, your code is {{2}}'),
      ['a', ' ']);
  });

  test('truncates a long list', () => {
    assert.deepStrictEqual(
      normalizeTemplateVariables(['a', 'b', 'c'], 'Hi {{1}}'),
      ['a']);
  });

  test('a variable-free body sends no body parameters at all', () => {
    assert.deepStrictEqual(normalizeTemplateVariables(['x'], 'No vars here'), []);
  });

  test('empty strings become a space — Meta rejects empty parameters', () => {
    assert.deepStrictEqual(normalizeTemplateVariables(['', null], '{{1}} {{2}}'), [' ', ' ']);
  });

  test('non-array input is treated as none', () => {
    assert.deepStrictEqual(normalizeTemplateVariables(undefined, '{{1}}'), [' ']);
  });

  test('templateVarMax reads the MAX index, not the count', () => {
    assert.strictEqual(templateVarMax('{{2}} only'), 2);
    assert.strictEqual(templateVarMax(''), 0);
    assert.strictEqual(templateVarMax(null), 0);
  });
});
