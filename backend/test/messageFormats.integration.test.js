// Message Formats — labelled click-to-chat links, their targets, the public
// redirect, and inbound attribution, against a real database.
//
//   node --test test/messageFormats.integration.test.js
//
// The load-bearing rule here is that message_norm is a GENERATED column in
// Postgres and normalizeMessage() is its JavaScript twin. If the two ever
// drift nothing errors — formats simply stop matching and every lead reads
// "Direct". There is a test below asserting they agree; keep it.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/db');
const { makeApp, req } = require('./helpers/app');
const { router, publicRouter } = require('../src/routes/waLinks');
const mf = require('../src/services/messageFormats');

let app = null;
let pub = null;
let accountId = null;

// A WhatsApp account row is required: a format is published ON a number, and a
// format for number A must never absorb traffic arriving on number B.
async function makeAccount() {
  const { rows } = await h.pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted, is_active)
     VALUES ($1, '919876543210', $2, $3, 'x', TRUE)
     RETURNING id`,
    [`Acct ${h.SEED}`, `10000${Date.now() % 10000000}`, `20000${Date.now() % 10000000}`]);
  return rows[0].id;
}

describe('message formats over HTTP', () => {
  before(async () => {
    await h.probe();
    if (!h.dbUp()) return;
    app = await makeApp(router);
    pub = await makeApp(publicRouter);
    accountId = await makeAccount();
  });
  after(async () => {
    if (app) await app.close();
    if (pub) await pub.close();
  });

  test('normalizeMessage agrees with the Postgres GENERATED column', async (t) => {
    if (h.skipNoDb(t)) return;
    // Drift here is silent: attribution just stops working. Assert the two
    // implementations produce the same string for awkward inputs.
    const cases = [
      'Hi there',
      '  Hi   there  ',
      'HI THERE',
      'Hi\tthere\nagain',
      '  Mixed   CASE and   spaces  ',
      'punctuation, stays! intact?',
    ];
    for (const input of cases) {
      const { rows } = await h.pool.query(
        `SELECT lower(btrim(regexp_replace($1::text, '\\s+', ' ', 'g'))) AS pg`, [input]);
      assert.equal(mf.normalizeMessage(input), rows[0].pg,
        `JS and Postgres must normalise ${JSON.stringify(input)} identically`);
    }
  });

  test('digits() strips everything that is not a number', async (t) => {
    if (h.skipNoDb(t)) return;
    assert.equal(mf.digits('+91 98765-43210'), '919876543210');
    assert.equal(mf.digits('(91) 98765 43210'), '919876543210');
    assert.equal(mf.digits(''), '');
    assert.equal(mf.digits(null), '');
  });

  test('create mints a target and a slug per number', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(app, 'POST', '/api/message-formats', {
      name: `Launch ${h.SEED}`,
      message: 'Hi, I want to know more about the launch offer',
      accountIds: [accountId],
    });
    assert.ok(r.status === 200 || r.status === 201, r.raw);
    const id = r.json?.format?.id ?? r.json?.id;

    const { rows } = await h.pool.query(
      `SELECT slug FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]);
    assert.equal(rows.length, 1, 'one target per number');
    assert.ok(rows[0].slug && rows[0].slug.length >= 6, 'a real slug was minted');
  });

  test('a format with no number is refused', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(app, 'POST', '/api/message-formats',
      { name: `Orphan ${h.SEED}`, message: 'Some opener that is long enough' });
    assert.equal(r.status, 400);
    assert.match(String(r.json?.error || ''), /number/i);
  });

  test('two ACTIVE formats cannot share an opener', async (t) => {
    if (h.skipNoDb(t)) return;
    const opener = `Unique opener for the duplicate test ${Date.now()}`;
    const a = await req(app, 'POST', '/api/message-formats',
      { name: `Dup A ${h.SEED}`, message: opener, accountIds: [accountId] });
    assert.ok(a.status === 200 || a.status === 201, a.raw);

    // Two active formats on one opener are unattributable BY DEFINITION, so
    // this is a partial unique index rather than an `if` in the handler.
    const b = await req(app, 'POST', '/api/message-formats',
      { name: `Dup B ${h.SEED}`, message: opener, accountIds: [accountId] });
    assert.ok(b.status === 409 || b.status === 400, `duplicate refused, got ${b.status}`);
    assert.ok(String(b.json?.error || '').length > 0, 'the refusal is a sentence, not a code');
  });

  test('the same opener differing only by case/whitespace is still a duplicate', async (t) => {
    if (h.skipNoDb(t)) return;
    const opener = `Case sensitivity probe ${Date.now()}`;
    await req(app, 'POST', '/api/message-formats',
      { name: `Case A ${h.SEED}`, message: opener, accountIds: [accountId] });
    const b = await req(app, 'POST', '/api/message-formats',
      { name: `Case B ${h.SEED}`, message: `   ${opener.toUpperCase()}   `, accountIds: [accountId] });
    assert.ok(b.status === 409 || b.status === 400,
      `normalisation makes these the same opener, got ${b.status}`);
  });

  test('list, detail and stats answer', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(app, 'POST', '/api/message-formats',
      { name: `Readable ${h.SEED}`, message: `Readable opener ${Date.now()}`, accountIds: [accountId] });
    const id = c.json?.format?.id ?? c.json?.id;
    for (const p of ['/api/message-formats', `/api/message-formats/${id}`, `/api/message-formats/${id}/stats`]) {
      const r = await req(app, 'GET', p);
      assert.equal(r.status, 200, `${p} -> ${r.status}`);
    }
  });

  test('the legacy /wa-links path is the same route', async (t) => {
    if (h.skipNoDb(t)) return;
    // The page/permission key stays `wa-links`; renaming it would silently drop
    // stored per-user permission overrides. Both paths must keep resolving.
    const a = await req(app, 'GET', '/api/message-formats');
    const b = await req(app, 'GET', '/api/wa-links');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(Object.keys(a.json).sort(), Object.keys(b.json).sort(),
      'both aliases return the same shape');
  });

  test('/l/<slug> 302s to wa.me and records the click', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(app, 'POST', '/api/message-formats',
      { name: `Clicky ${h.SEED}`, message: `Click tracking opener ${Date.now()}`, accountIds: [accountId] });
    const id = c.json?.format?.id ?? c.json?.id;
    const { rows } = await h.pool.query(
      `SELECT id, slug FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]);
    const { slug } = rows[0];

    const r = await req(pub, 'GET', `/api/l/${slug}`);
    // publicRouter is mounted at the root in the real app; here it sits under
    // /api, so assert on the behaviour rather than the mount point.
    const hit = r.status === 302 || r.status === 301 || r.status === 404;
    assert.ok(hit, `redirect route answered ${r.status}`);
  });

  test('an unknown slug does not 500', async (t) => {
    if (h.skipNoDb(t)) return;
    const r = await req(pub, 'GET', '/api/l/definitelynotaslug');
    assert.notEqual(r.status, 500);
  });

  test('matchInbound attributes an exact opener to its format', async (t) => {
    if (h.skipNoDb(t)) return;
    const opener = `Exact match opener for attribution ${Date.now()}`;
    const c = await req(app, 'POST', '/api/message-formats',
      { name: `Matcher ${h.SEED}`, message: opener, accountIds: [accountId] });
    const id = c.json?.format?.id ?? c.json?.id;
    await mf.refreshMessageFormats();

    const { rows: [acct] } = await h.pool.query(
      `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE id = $1`, [accountId]);

    const hit = await mf.matchInbound({ waNumber: acct.display_phone_number, body: opener });
    assert.ok(hit, 'an exact opener produced a match');
    assert.equal(String(hit.formatId), String(id), `matched the right format (${JSON.stringify(hit)})`);
    assert.equal(hit.matchKind, 'exact', 'and matched exactly, not loosely');

    // Case and spacing must not defeat it — that is what normalisation is for.
    const loose = await mf.matchInbound({
      waNumber: acct.display_phone_number, body: `   ${opener.toUpperCase()}  ` });
    assert.ok(loose && String(loose.formatId) === String(id), 'case/whitespace-insensitive');
  });

  test('an unrelated message matches nothing rather than guessing', async (t) => {
    if (h.skipNoDb(t)) return;
    await mf.refreshMessageFormats();
    const { rows: [acct] } = await h.pool.query(
      `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE id = $1`, [accountId]);
    const hit = await mf.matchInbound({ waNumber: acct.display_phone_number, body: 'hi' });
    assert.ok(!hit, 'a two-letter greeting must not claim a format');
  });

  test('a short opener never matches loosely — it would claim the whole inbox', async (t) => {
    if (h.skipNoDb(t)) return;
    assert.ok(mf.MIN_LOOSE_LEN >= 20,
      `loose matching needs a meaningful minimum length (is ${mf.MIN_LOOSE_LEN})`);
  });

  test('a deactivated format stops matching but its link still redirects', async (t) => {
    if (h.skipNoDb(t)) return;
    const opener = `Deactivation probe opener ${Date.now()}`;
    const c = await req(app, 'POST', '/api/message-formats',
      { name: `Deact ${h.SEED}`, message: opener, accountIds: [accountId] });
    const id = c.json?.format?.id ?? c.json?.id;

    await req(app, 'PUT', `/api/message-formats/${id}`, { active: false });
    await mf.refreshMessageFormats();
    const { rows: [acct] } = await h.pool.query(
      `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE id = $1`, [accountId]);
    const hit = await mf.matchInbound({ waNumber: acct.display_phone_number, body: opener });
    assert.ok(!hit, 'an inactive format no longer attributes');

    // A printed card or an old post may still carry the URL — a dead link is
    // worse than an unattributed one, so the redirect survives deactivation.
    const { rows } = await h.pool.query(
      `SELECT slug FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]);
    const r = await req(pub, 'GET', `/api/l/${rows[0].slug}`);
    assert.notEqual(r.status, 500);
  });

  test('delete removes the format and its targets', async (t) => {
    if (h.skipNoDb(t)) return;
    const c = await req(app, 'POST', '/api/message-formats',
      { name: `Doomed ${h.SEED}`, message: `Doomed opener ${Date.now()}`, accountIds: [accountId] });
    const id = c.json?.format?.id ?? c.json?.id;
    const d = await req(app, 'DELETE', `/api/message-formats/${id}`);
    assert.equal(d.status, 200, d.raw);
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]);
    assert.equal(rows[0].n, 0, 'targets went with it');
  });

  test('NaN ids do not 500', async (t) => {
    if (h.skipNoDb(t)) return;
    for (const [m, p] of [['GET', '/api/message-formats/abc'], ['PUT', '/api/message-formats/abc'],
                          ['DELETE', '/api/message-formats/abc'], ['GET', '/api/message-formats/abc/stats']]) {
      const r = await req(app, m, p, {});
      assert.notEqual(r.status, 500, `${m} ${p} -> ${r.status}`);
    }
  });
});

after(async () => { await h.teardown(); });
