// Test numbers: does the router find the right agent, and is that run exempt?
//
//   node --test test/agentTestNumbers.integration.test.js
//
// Needs a reachable database (the whole point is the SQL — the last-10-digit
// match and the draft-vs-live precedence live in one query, so a JS-only test
// would assert nothing). Skips cleanly rather than failing without one.
//
// ⚠ The skip decision is made INSIDE each test body: a describe() body runs at
// module load, before before() can probe the database.
//
// ⚠ agentQueue is replaced in require.cache before agentRouter can reach it.
// Requiring it for real opens a BullMQ Redis connection that holds the event
// loop open, which hangs `npm test` for the whole repo with no output.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const enqueued = [];
function stubModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
stubModule('../src/queue/agentQueue', {
  enqueueAgentRun: async (job) => { enqueued.push(job); },
});
// ⚠ agentHandoff is NOT stubbed here: the pause rules are exactly what these
// tests exercise, and a stub would assert the stub. Only the queue and the
// message sender are replaced.
const { getPauseState, resumeAgent, performHandoff } = require('../src/services/agentHandoff');
stubModule('../src/services/paymentFlow', {
  sendOnThread: async () => ({ sent: true }),
});

const pool = require('../src/db');
const agentService = require('../src/services/agentService');
const { routeIfActive } = require('../src/services/agentRouter');

const SEED = '__testnumbers__';
const WA = '918888800042';          // the business number
const TESTER = '919876543210';      // on the test list
const CUSTOMER = '917000000001';    // not on it

let dbUp = false;
let accountId = null;
let draftId = null;
let liveId = null;

before(async () => {
  try { await pool.query('SELECT 1'); dbUp = true; } catch { return; }
  try { await agentService.ensureAgentTables(); } catch (e) {
    console.error('ensureAgentTables failed:', e.message);
    dbUp = false;
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id, access_token_encrypted)
     VALUES ($1, $2, 'pnid-test-42', 'waba-test-42', 'x') RETURNING id`,
    [SEED, WA],
  );
  accountId = rows[0].id;
});

after(async () => {
  if (dbUp) {
    if (accountId) {
      await pool.query('DELETE FROM coexistence.agents WHERE wa_account_id = $1', [accountId]);
      await pool.query('DELETE FROM coexistence.whatsapp_accounts WHERE id = $1', [accountId]);
    }
    await pool.query('DELETE FROM coexistence.contacts WHERE wa_number = $1', [WA]);
  }
  await pool.end().catch(() => {});
});

// A draft (never live) agent that lists the tester, and optionally a second
// agent that IS live on the same number.
async function seedAgents({ withLiveAgent = false, testNumbers = [{ number: TESTER, label: 'me' }] } = {}) {
  await pool.query('DELETE FROM coexistence.agents WHERE wa_account_id = $1', [accountId]);
  const d = await pool.query(
    `INSERT INTO coexistence.agents
       (name, system_prompt, llm_model, wa_account_id, is_active, status, trigger_mode, test_numbers)
     VALUES ($1,'p','gpt-4o-mini',$2, FALSE, 'draft', 'any', $3::jsonb) RETURNING id`,
    [`${SEED} draft`, accountId, JSON.stringify(testNumbers)],
  );
  draftId = d.rows[0].id;
  liveId = null;
  if (withLiveAgent) {
    const l = await pool.query(
      `INSERT INTO coexistence.agents
         (name, system_prompt, llm_model, wa_account_id, is_active, status, trigger_mode)
       VALUES ($1,'p','gpt-4o-mini',$2, TRUE, 'active', 'any') RETURNING id`,
      [`${SEED} live`, accountId],
    );
    liveId = l.rows[0].id;
  }
}

function inbound(contactNumber, over = {}) {
  return {
    direction: 'incoming',
    message_type: 'text',
    message_body: 'hello',
    wa_number: WA,
    phone_number_id: 'pnid-test-42',
    contact_number: contactNumber,
    message_id: null,
    ...over,
  };
}

beforeEach(() => { enqueued.length = 0; });

describe('a draft agent is reachable ONLY by its own test numbers', () => {
  test('the tester gets through and the run is marked as a test', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents();
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.agentId, draftId);
    assert.equal(res.isTest, true);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].isTest, true, 'the worker must know, or the run row is not stamped');
  });

  test('a customer does not — a draft is still a draft', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents();
    assert.equal(await routeIfActive(inbound(CUSTOMER)), null);
    assert.equal(enqueued.length, 0);
  });

  test('an empty list changes nothing about a draft', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ testNumbers: [] });
    assert.equal(await routeIfActive(inbound(TESTER)), null);
  });
});

describe('matching is on the last 10 digits, in SQL, in one place', () => {
  const variants = ['9876543210', '+91 98765 43210', '91-9876-543210', '00919876543210'];
  for (const v of variants) {
    test(`"${v}" is the same tester as ${TESTER}`, async (t) => {
      if (!dbUp) return t.skip('no database');
      // Stored one way, arriving another — the case that made every other
      // leads<->contacts join in this codebase use the last 10 digits.
      await seedAgents({ testNumbers: [{ number: v.replace(/\D/g, ''), label: null }] });
      const res = await routeIfActive(inbound(TESTER));
      assert.equal(res?.isTest, true);
    });
  }

  test('a different number entirely is not a match', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ testNumbers: [{ number: '919999999999', label: null }] });
    assert.equal(await routeIfActive(inbound(TESTER)), null);
  });
});

describe('precedence when an agent is already live on the same number', () => {
  test('the agent under test wins for its tester', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Without this the thing being tested could never receive the message —
    // the live agent would answer every time and testing would be impossible
    // without taking it down.
    await seedAgents({ withLiveAgent: true });
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.agentId, draftId);
    assert.equal(res.isTest, true);
  });

  test('everybody else still reaches the live agent', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ withLiveAgent: true });
    const res = await routeIfActive(inbound(CUSTOMER));
    assert.equal(res?.agentId, liveId);
    assert.equal(res.isTest, false);
  });
});

describe('a test number is exempt from the limits, end to end', () => {
  test('a used-up allowance still lets the tester through', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ withLiveAgent: true });
    await pool.query(
      `UPDATE coexistence.agents
          SET quota_replies = 1, max_replies_per_conversation = 1, max_runs_per_day = 1
        WHERE wa_account_id = $1`,
      [accountId],
    );
    // Two prior answered runs for this tester — well past every cap above.
    for (const mins of [5, 10]) {
      await pool.query(
        `INSERT INTO coexistence.agent_runs (agent_id, contact_number, status, started_at)
         VALUES ($1,$2,'completed', NOW() - make_interval(mins => $3))`,
        [draftId, TESTER, mins],
      );
    }
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.agentId, draftId);
    assert.equal(res.skipped, undefined, 'a test number must never be refused by a limit');
    assert.equal(enqueued.length, 1);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs
        WHERE agent_id = $1 AND status = 'limited'`, [draftId]);
    assert.equal(rows[0].n, 0, 'and must not record a refusal');
  });

  test('the same allowance still stops a real customer', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ withLiveAgent: true });
    await pool.query(
      `UPDATE coexistence.agents SET quota_replies = 1 WHERE id = $1`, [liveId]);
    await pool.query(
      `INSERT INTO coexistence.agent_runs (agent_id, contact_number, status, started_at)
       VALUES ($1,$2,'completed', NOW() - INTERVAL '5 minutes')`,
      [liveId, CUSTOMER],
    );
    const res = await routeIfActive(inbound(CUSTOMER));
    assert.equal(res?.skipped, 'quota_replies');
    assert.equal(enqueued.length, 0);
  });
});

/* ═══ a limit pause must not outlive the exemption that a test number has ═══ */

describe('a chat paused BY A LIMIT', () => {
  // Reported live: the cap tripped at 18:57, which paused the chat for a human
  // (limit_handoff defaults on). Adding the number as a test number afterwards
  // changed nothing, because the router checks the pause before it looks at
  // anything else — and a pause skip logs no run, so the Activity tab showed
  // silence with no explanation.
  const pauseChat = async (by) => {
    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, agent_paused, agent_paused_at, agent_paused_by)
       VALUES ($1,$2,'Tester', TRUE, NOW(), $3)
       ON CONFLICT (wa_number, contact_number) DO UPDATE
          SET agent_paused = TRUE, agent_paused_at = NOW(), agent_paused_by = EXCLUDED.agent_paused_by`,
      [WA, TESTER, by],
    );
  };
  const pausedNow = async () => (await getPauseState(WA, TESTER)).paused;

  test('is lifted for a test number, and the message is answered', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ withLiveAgent: true });
    await pauseChat('limit');
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.agentId, draftId);
    assert.equal(res.skipped, undefined, 'a limit pause must not silence a test number');
    assert.equal(enqueued.length, 1);
    assert.equal(await pausedNow(), false, 'and the pause is cleared, not merely bypassed');
  });

  test('but a pause a PERSON set still stands', async (t) => {
    if (!dbUp) return t.skip('no database');
    // A colleague handling the conversation must never be talked over — this is
    // the line the exemption stops at.
    await seedAgents({ withLiveAgent: true });
    await pauseChat('manual:7');
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.skipped, 'paused_for_human');
    assert.equal(res.pausedBy, 'manual:7');
    assert.equal(enqueued.length, 0);
    assert.equal(await pausedNow(), true, 'and it is left exactly as the person left it');
  });

  test('and a limit pause still silences an ordinary customer', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedAgents({ withLiveAgent: true });
    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, agent_paused, agent_paused_at, agent_paused_by)
       VALUES ($1,$2,'Customer', TRUE, NOW(), 'limit')
       ON CONFLICT (wa_number, contact_number) DO UPDATE
          SET agent_paused = TRUE, agent_paused_by = 'limit'`,
      [WA, CUSTOMER],
    );
    const res = await routeIfActive(inbound(CUSTOMER));
    assert.equal(res?.skipped, 'paused_for_human');
    assert.equal(enqueued.length, 0);
    assert.equal((await getPauseState(WA, CUSTOMER)).paused, true);
  });

  test('a test conversation cannot be limit-paused in the first place', async (t) => {
    if (!dbUp) return t.skip('no database');
    // The cure above is for chats already stuck. Going forward the cap is
    // skipped for a test number, so onConversationCapped never runs for it.
    await seedAgents({ withLiveAgent: true });
    await pool.query(
      `UPDATE coexistence.contacts SET agent_paused = FALSE, agent_paused_by = NULL
        WHERE wa_number = $1 AND contact_number = $2`, [WA, TESTER]);
    await pool.query(`UPDATE coexistence.agents SET max_replies_per_conversation = 1 WHERE id = $1`, [draftId]);
    await pool.query(
      `INSERT INTO coexistence.agent_runs (agent_id, contact_number, status, started_at)
       VALUES ($1,$2,'completed', NOW() - INTERVAL '2 minutes')`, [draftId, TESTER]);
    const res = await routeIfActive(inbound(TESTER));
    assert.equal(res?.skipped, undefined);
    assert.equal(await pausedNow(), false);
  });
});

describe('getPauseState tells limit from human', () => {
  test('byLimit is true only for the limit engine', async (t) => {
    if (!dbUp) return t.skip('no database');
    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, name, agent_paused, agent_paused_by)
       VALUES ($1,$2,'X', TRUE, 'limit')
       ON CONFLICT (wa_number, contact_number) DO UPDATE SET agent_paused = TRUE, agent_paused_by = 'limit'`,
      [WA, '917000000009'],
    );
    let st = await getPauseState(WA, '917000000009');
    assert.equal(st.paused, true); assert.equal(st.byLimit, true);

    await performHandoff({ agentId: draftId, handoffUserIds: [], waNumber: WA, contactNumber: '917000000009', reason: 'human', by: 'manual:3' });
    st = await getPauseState(WA, '917000000009');
    assert.equal(st.byLimit, false, 'a human takeover is never liftable by a test number');

    await resumeAgent({ waNumber: WA, contactNumber: '917000000009', by: 'test' });
    st = await getPauseState(WA, '917000000009');
    assert.equal(st.paused, false);
  });
});
