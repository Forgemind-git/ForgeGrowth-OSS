// Meta webhook ingestion contract — the parser that turns a raw Cloud API
// payload into message records.
//
//   node --test test/metaPayload.unit.test.js
//
// This is the front door of the whole product: every lead, automation trigger
// and funnel event downstream is derived from what this function returns. It is
// also the layer where a Meta payload-shape change shows up first, and where a
// wrong result is invisible — a message simply never appears, with no error
// anywhere. Hence a test per message type rather than one happy path.
//
// No database and no Redis: the parser is pure, which is why it lives in
// services/ rather than in routes/webhook.js.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { parseMetaPayload, normalizePhone } = require('../src/services/metaPayload');

// Documentation-safe fixtures only — example.com and the reserved 9198765xxxxx
// range. Never a real number, per CLAUDE.md.
const BUSINESS = '15550001111';
const CUSTOMER = '919876543210';
const WABA_ID = '100000000000001';
const PNID = '200000000000002';

// Build a payload in the exact shape Meta posts. `value` is merged over the
// envelope so each test states only the part it cares about.
function payload(value) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: WABA_ID,
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: BUSINESS, phone_number_id: PNID },
          ...value,
        },
      }],
    }],
  };
}

// An inbound message of `type`, with the type-specific body merged in.
function inbound(type, extra, { contacts = true } = {}) {
  return payload({
    ...(contacts ? { contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Contact' } }] } : {}),
    messages: [{
      from: CUSTOMER,
      id: `wamid.TEST_${type.toUpperCase()}`,
      timestamp: '1750000000',
      type,
      ...extra,
    }],
  });
}

const only = (body) => {
  const records = parseMetaPayload(body);
  assert.equal(records.length, 1, `expected exactly one record, got ${records.length}`);
  return records[0];
};

describe('normalizePhone', () => {
  test('strips every non-digit so one person is one chat thread', () => {
    // The invariant: +91… and 91… must not become two threads.
    assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
    assert.equal(normalizePhone('919876543210'), '919876543210');
    assert.equal(normalizePhone('+1 (555) 000-1111'), '15550001111');
  });

  test('passes falsy values through untouched', () => {
    // Callers rely on this: normalizePhone(undefined) must not become the
    // string 'undefined', which would insert as a real-looking wa_number.
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), undefined);
  });
});

describe('parseMetaPayload — envelope', () => {
  test('ignores anything that is not a whatsapp_business_account payload', () => {
    // Meta delivers page/instagram webhooks to the same URL when the app is
    // subscribed to those objects. Parsing them would manufacture junk rows.
    assert.deepEqual(parseMetaPayload({ object: 'page', entry: [] }), []);
    assert.deepEqual(parseMetaPayload({}), []);
    assert.deepEqual(parseMetaPayload(null), []);
    assert.deepEqual(parseMetaPayload(undefined), []);
  });

  test('ignores a change whose messaging_product is not whatsapp', () => {
    const body = payload({ messages: [{ from: CUSTOMER, id: 'wamid.X', type: 'text', text: { body: 'hi' } }] });
    body.entry[0].changes[0].value.messaging_product = 'sms';
    assert.deepEqual(parseMetaPayload(body), []);
  });

  test('stamps the WABA id on every record so unregistered tenants can be dropped', () => {
    // The POST handler filters on waba_id. If the parser stopped setting it,
    // that filter would reject everything — or accept everything.
    const rec = only(inbound('text', { text: { body: 'hello' } }));
    assert.equal(rec.waba_id, WABA_ID);
    assert.equal(rec.phone_number_id, PNID);
  });

  test('reads every entry and every change, not just the first', () => {
    // Meta batches. Taking entry[0] only is a silent message-loss bug.
    const a = inbound('text', { text: { body: 'first' } });
    const b = inbound('text', { text: { body: 'second' } });
    b.entry[0].changes[0].value.messages[0].id = 'wamid.SECOND';
    const merged = { object: 'whatsapp_business_account', entry: [a.entry[0], b.entry[0]] };
    const records = parseMetaPayload(merged);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.message_body), ['first', 'second']);
  });

  test('converts the unix-seconds timestamp to an ISO instant', () => {
    const rec = only(inbound('text', { text: { body: 'hi' } }));
    assert.equal(rec.timestamp, new Date(1750000000 * 1000).toISOString());
  });

  test('falls back to now when Meta omits the timestamp', () => {
    const body = inbound('text', { text: { body: 'hi' } });
    delete body.entry[0].changes[0].value.messages[0].timestamp;
    const rec = only(body);
    assert.ok(!Number.isNaN(Date.parse(rec.timestamp)), 'timestamp must still parse');
  });
});

describe('parseMetaPayload — inbound message types', () => {
  test('text', () => {
    const rec = only(inbound('text', { text: { body: 'Hello there' } }));
    assert.equal(rec.direction, 'incoming');
    assert.equal(rec.status, 'received');
    assert.equal(rec.message_type, 'text');
    assert.equal(rec.message_body, 'Hello there');
    assert.equal(rec.contact_number, CUSTOMER);
    assert.equal(rec.wa_number, BUSINESS);
    assert.equal(rec.contact_name, 'Test Contact');
    assert.equal(rec.message_id, 'wamid.TEST_TEXT');
  });

  test('contact_name is null when Meta sends no contacts array', () => {
    const rec = only(inbound('text', { text: { body: 'hi' } }, { contacts: false }));
    assert.equal(rec.contact_name, null);
  });

  test('image keeps the caption as the body and the media id as the url', () => {
    // media_url holds Meta's media ID at parse time; the media queue resolves
    // it to a real URL later. Storing a URL here would break that hand-off.
    const rec = only(inbound('image', { image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'a caption' } }));
    assert.equal(rec.message_body, 'a caption');
    assert.equal(rec.media_url, 'MEDIA_1');
    assert.equal(rec.media_mime_type, 'image/jpeg');
  });

  test('document carries its filename as both body and media_filename', () => {
    const rec = only(inbound('document', { document: { id: 'MEDIA_2', mime_type: 'application/pdf', filename: 'invoice.pdf' } }));
    assert.equal(rec.message_body, 'invoice.pdf');
    assert.equal(rec.media_filename, 'invoice.pdf');
    assert.equal(rec.media_url, 'MEDIA_2');
  });

  test('audio and voice get a non-null placeholder body', () => {
    // A NULL body renders as an empty bubble and matches no keyword trigger.
    const audio = only(inbound('audio', { audio: { id: 'MEDIA_3', mime_type: 'audio/ogg' } }));
    const voice = only(inbound('voice', { voice: { id: 'MEDIA_4', mime_type: 'audio/ogg' } }));
    assert.equal(audio.message_body, 'Audio message');
    assert.equal(voice.message_body, 'Voice message');
    assert.equal(voice.media_url, 'MEDIA_4');
  });

  test('location renders its coordinates', () => {
    const rec = only(inbound('location', { location: { latitude: 12.97, longitude: 77.59 } }));
    assert.equal(rec.message_body, 'Location: 12.97, 77.59');
  });

  test('interactive reply uses the tapped option title', () => {
    const rec = only(inbound('interactive', {
      interactive: { type: 'button_reply', button_reply: { id: 'opt_yes', title: 'Yes, book me' } },
    }));
    assert.equal(rec.message_type, 'interactive');
    assert.equal(rec.message_body, 'Yes, book me');
  });

  test('interactive list reply is handled like a button reply', () => {
    const rec = only(inbound('interactive', {
      interactive: { type: 'list_reply', list_reply: { id: 'row_1', title: 'Morning batch' } },
    }));
    assert.equal(rec.message_body, 'Morning batch');
  });

  test('template quick-reply tap (type: button) keeps its text', () => {
    // Regression: this branch once did not exist, so the row landed with a NULL
    // body — the bubble rendered empty AND no keyword automation could match
    // the tap, so "tap the button to get the link" flows silently never fired.
    const rec = only(inbound('button', { button: { text: 'Get the link', payload: 'GET_LINK' } }));
    assert.equal(rec.message_type, 'button');
    assert.equal(rec.message_body, 'Get the link');
  });

  test('template quick-reply falls back to the payload when text is absent', () => {
    const rec = only(inbound('button', { button: { payload: 'GET_LINK' } }));
    assert.equal(rec.message_body, 'GET_LINK');
  });

  test('reaction is attached to its target rather than left standalone', () => {
    const rec = only(inbound('reaction', { reaction: { message_id: 'wamid.TARGET', emoji: '👍' } }));
    assert.equal(rec.message_type, 'reaction');
    assert.deepEqual(rec.reaction, { targetMessageId: 'wamid.TARGET', emoji: '👍', from: CUSTOMER });
  });

  test('an emptied reaction means the customer removed it', () => {
    const rec = only(inbound('reaction', { reaction: { message_id: 'wamid.TARGET', emoji: '' } }));
    assert.equal(rec.reaction.emoji, '');
  });

  test('an unsupported type still produces a record rather than vanishing', () => {
    // Meta ships new message types without warning. Dropping them here means a
    // customer message that exists on their phone and nowhere in the inbox.
    const rec = only(inbound('some_future_type', {}));
    assert.equal(rec.message_type, 'some_future_type');
    assert.equal(rec.direction, 'incoming');
  });

  test('an error-typed message is marked as errored', () => {
    const rec = only(inbound('unknown', { errors: [{ message: 'Unsupported message type' }] }));
    assert.equal(rec.status, 'error');
    assert.match(rec.message_body, /Unsupported message type/);
  });

  test('CTWA referral is preserved for ad attribution', () => {
    // Dropping this loses the ad → lead link entirely; the lead just looks organic.
    const referral = { source_type: 'ad', source_id: '120000000000001', headline: 'Free demo' };
    const rec = only(inbound('text', { text: { body: 'hi' }, referral }));
    assert.deepEqual(rec.referral, referral);
  });

  test('a quote-reply keeps the quoted message id', () => {
    const rec = only(inbound('text', { text: { body: 'yes please' }, context: { id: 'wamid.QUOTED' } }));
    assert.equal(rec.context_message_id, 'wamid.QUOTED');
  });
});

describe('parseMetaPayload — echoes and statuses', () => {
  test('a message echo is outgoing and addressed to the customer', () => {
    const rec = only(payload({
      message_echoes: [{
        to: CUSTOMER, id: 'wamid.ECHO', timestamp: '1750000000',
        type: 'text', text: { body: 'sent from the phone' },
      }],
    }));
    assert.equal(rec.direction, 'outgoing');
    assert.equal(rec.status, 'sent');
    assert.equal(rec.contact_number, CUSTOMER);
    assert.equal(rec.message_body, 'sent from the phone');
  });

  test('a status callback becomes a status record, not a message', () => {
    const rec = only(payload({
      statuses: [{
        id: 'wamid.SENT', recipient_id: CUSTOMER, status: 'delivered',
        timestamp: '1750000000', conversation: { id: 'conv1' }, pricing: { billable: true },
      }],
    }));
    assert.equal(rec.message_type, 'status');
    assert.equal(rec.status, 'delivered');
    assert.equal(rec.direction, 'outgoing');
    assert.equal(rec.contact_number, CUSTOMER);
    assert.deepEqual(rec.conversation, { id: 'conv1' });
  });

  test('messages and statuses in one payload are both returned', () => {
    // Meta batches them together; handling only one array loses the other.
    const records = parseMetaPayload(payload({
      contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Contact' } }],
      messages: [{ from: CUSTOMER, id: 'wamid.M', timestamp: '1750000000', type: 'text', text: { body: 'hi' } }],
      statuses: [{ id: 'wamid.S', recipient_id: CUSTOMER, status: 'read', timestamp: '1750000000' }],
    }));
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.message_type), ['text', 'status']);
  });

  test('phone numbers arriving with a + are normalised on every record', () => {
    const body = inbound('text', { text: { body: 'hi' } });
    body.entry[0].changes[0].value.metadata.display_phone_number = `+${BUSINESS}`;
    body.entry[0].changes[0].value.messages[0].from = `+${CUSTOMER}`;
    const rec = only(body);
    assert.equal(rec.wa_number, BUSINESS);
    assert.equal(rec.contact_number, CUSTOMER);
  });
});
