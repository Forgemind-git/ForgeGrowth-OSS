// Agent usage limits — the input rules, the counting queries, and the gates.
//
//   node --test test/agentLimits.unit.test.js
//
// Needs a reachable database for the counting half; skips cleanly rather than
// failing when there is none, so `npm test` still works without one.
//
// ⚠ The skip decision is made INSIDE each test body. A describe() body runs at
// module load, before before() can probe the database, so a { skip } option
// would read the flag while it is still false and skip the whole suite on a
// machine that HAS a database.
//
// ⚠ paymentFlow and agentHandoff are replaced in require.cache before anything
// loads them. Both are lazily required inside agentLimits, so this is enough to
// keep the send queue's Redis connection out of the process — which otherwise
// holds the event loop open and hangs `npm test` for the whole repo with no
// output.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stub the two side-effect modules BEFORE agentLimits can reach them ───────
const sends = [];
const handoffs = [];
function stubModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
stubModule('../src/services/paymentFlow', {
  sendOnThread: async ({ waNumber, contactNumber, body }) => {
    sends.push({ waNumber, contactNumber, body });
    return { sent: true, localMessageId: 'stub' };
  },
});
stubModule('../src/services/agentHandoff', {
  performHandoff: async (args) => { handoffs.push(args); return { assignedUserId: null }; },
  isConversationPaused: async () => false,
  matchesAnyHandoffKeyword: () => false,
});

const pool = require('../src/db');
const limits = require('../src/services/agentLimits');
const agentService = require('../src/services/agentService');

const SEED = '__agentlimits_test__';
const CONTACT = '919999900001';
let dbUp = false;
let agentId = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch { return; }

  // Columns may be missing if migration 102 has not been applied here.
  try { await agentService.ensureAgentTables(); } catch (e) {
    console.error('ensureAgentTables failed:', e.message);
    dbUp = false;
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO coexistence.agents (name, system_prompt, llm_model, is_active)
     VALUES ($1, 'test', 'gpt-4o-mini', FALSE) RETURNING id`,
    [SEED],
  );
  agentId = rows[0].id;
});

after(async () => {
  if (dbUp && agentId) {
    // agent_runs cascades from agents.
    await pool.query('DELETE FROM coexistence.agents WHERE id = $1', [agentId]);
  }
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  sends.length = 0;
  handoffs.length = 0;
  if (dbUp && agentId) {
    await pool.query('DELETE FROM coexistence.agent_runs WHERE agent_id = $1', [agentId]);
  }
});

// Insert a run `agoMinutes` in the past.
async function seedRun({ agoMinutes = 0, status = 'completed', contact = CONTACT, messageId = null, isTest = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.agent_runs
       (agent_id, contact_number, inbound_message_id, status, started_at, ended_at, is_test)
     VALUES ($1,$2,$3,$4, NOW() - make_interval(mins => $5), NOW() - make_interval(mins => $5), $6)
     RETURNING id`,
    [agentId, contact, messageId, status, agoMinutes, isTest],
  );
  return rows[0].id;
}

function agentRow(over = {}) {
  return {
    id: agentId,
    wa_account_id: null,
    trigger_session_minutes: 30,
    handoff_user_ids: [],
    max_replies_per_conversation: null,
    max_replies_per_minute: null,
    max_runs_per_day: null,
    limit_reached_message: '',
    limit_handoff: false,
    quota_replies: null,
    quota_conversations: null,
    quota_window_value: 1,
    quota_window_unit: 'days',
    quota_handoff: false,
    ...over,
  };
}

const enforce = (agent, over = {}) => limits.enforceLimits({
  agent, waNumber: '918888800000', contactNumber: CONTACT, inboundMessageId: null, ...over,
});

/* ------------------------------- input rules ------------------------------ */

describe('asLimit — what counts as "no limit"', () => {
  test('blank, zero and nonsense all mean unlimited, never "zero replies"', () => {
    // 0 must not survive into storage: read back as a cap it would silence the
    // agent completely, which is never what someone typing 0 intends.
    for (const v of [null, undefined, '', 0, '0', -5, 'abc', NaN, {}]) {
      assert.strictEqual(limits.asLimit(v), null, `${JSON.stringify(v)} should be unlimited`);
    }
  });

  test('positive numbers survive, as numbers, from either a number or a string', () => {
    assert.strictEqual(limits.asLimit(5), 5);
    assert.strictEqual(limits.asLimit('20'), 20);
    assert.strictEqual(limits.asLimit(1), 1);
  });
});

describe('limitIn / limitMessageIn — the storage rules', () => {
  test('a limit is clamped to its ceiling rather than rejected', () => {
    assert.strictEqual(agentService.limitIn(9999, 500), 500);
    assert.strictEqual(agentService.limitIn(10, 500), 10);
    assert.strictEqual(agentService.limitIn(0, 500), null);
  });

  test('a blank closing message is stored as NULL — a deliberate "send nothing"', () => {
    assert.strictEqual(agentService.limitMessageIn(''), null);
    assert.strictEqual(agentService.limitMessageIn('   '), null);
    assert.strictEqual(agentService.limitMessageIn(null), null);
    assert.strictEqual(agentService.limitMessageIn('  hello  '), 'hello');
  });
});

/* ------------------------------- counting -------------------------------- */

describe('sessionCounts — a conversation is bounded by its silences', () => {
  test('runs with no long gap are one conversation', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Gaps of 10 and 20 minutes — both under the 30-minute session.
    await seedRun({ agoMinutes: 50 });
    await seedRun({ agoMinutes: 40 });
    await seedRun({ agoMinutes: 20 });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 3);
  });

  test('a gap of at least the session length starts a new conversation', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 200 });   // old conversation
    await seedRun({ agoMinutes: 190 });   // old conversation
    await seedRun({ agoMinutes: 10 });    // 180 min later -> new conversation
    await seedRun({ agoMinutes: 2 });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 2, 'only the runs after the gap count');
  });

  test('a rolling window would get this wrong — slow but continuous still counts', async (t) => {
    if (!dbUp) return t.skip('no database');
    // One question every 25 minutes for two hours. Every gap is under the
    // 30-minute session, so this is ONE conversation of 5 replies. A
    // "last 30 minutes" count would see at most 2 and never fire the cap.
    for (const m of [100, 75, 50, 25, 1]) await seedRun({ agoMinutes: m });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 5);
  });

  test('failed runs do not spend the customer\'s budget', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 5 });
    await seedRun({ agoMinutes: 4, status: 'failed' });
    await seedRun({ agoMinutes: 3, status: 'failed' });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 1, 'our outage must not count against them');
  });

  test('blocked messages are counted separately from replies', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 5 });
    await seedRun({ agoMinutes: 4, status: 'limited' });
    const { replies, blocked } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 1);
    assert.strictEqual(blocked, 1);
  });

  test('a conversation that has gone quiet is over, even with no newer run', async (t) => {
    if (!dbUp) return t.skip('no database');
    // The regression this guards: finding the last gap BETWEEN runs never
    // notices that the newest run is itself older than the session, so the
    // conversation stayed "current" forever and the budget never came back.
    await seedRun({ agoMinutes: 95 });
    await seedRun({ agoMinutes: 90 });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 0, 'quiet for 90 minutes means the next message starts fresh');
  });

  test('the boundary is the session length, not "some time ago"', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 29 });
    const live = await limits.sessionCounts({ agentId, contactNumber: CONTACT, sessionMinutes: 30 });
    assert.strictEqual(live.replies, 1, '29 minutes of quiet is still the same conversation');

    const expired = await limits.sessionCounts({ agentId, contactNumber: CONTACT, sessionMinutes: 20 });
    assert.strictEqual(expired.replies, 0, 'under a 20-minute session the same run is a past conversation');
  });

  test('no history at all is zero, not a crash', async (t) => {
    if (!dbUp) return t.skip('no database');
    const c = await limits.sessionCounts({
      agentId, contactNumber: '910000000000', sessionMinutes: 30,
    });
    assert.deepStrictEqual(c, { replies: 0, blocked: 0 });
  });

  test('another contact\'s conversation is not counted', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 3, contact: '911111100000' });
    const { replies } = await limits.sessionCounts({
      agentId, contactNumber: CONTACT, sessionMinutes: 30,
    });
    assert.strictEqual(replies, 0);
  });
});

describe('runsToday — the IST day boundary', () => {
  // Anti-pattern #30: `(NOW() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE
  // 'Asia/Kolkata'` lands 5.5h in the FUTURE, so everything from today falls
  // outside and the count reads a plausible 0. This asserts the boundary
  // directly instead of trusting that it looks right.
  test('counts from IST midnight, not UTC midnight', async (t) => {
    if (!dbUp) return t.skip('no database');
    const boundary = `date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`;
    await pool.query(
      `INSERT INTO coexistence.agent_runs (agent_id, contact_number, status, started_at)
       VALUES ($1,$2,'completed', ${boundary} + INTERVAL '1 minute'),
              ($1,$2,'completed', ${boundary} - INTERVAL '1 minute')`,
      [agentId, CONTACT],
    );
    const n = await limits.runsToday({ agentId });
    assert.strictEqual(n, 1, 'one minute after IST midnight is today; one minute before is not');
  });

  test('spans every conversation, and ignores blocked + failed rows', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 1, contact: '911111100001' });
    await seedRun({ agoMinutes: 1, contact: '911111100002' });
    await seedRun({ agoMinutes: 1, status: 'limited' });
    await seedRun({ agoMinutes: 1, status: 'failed' });
    const n = await limits.runsToday({ agentId });
    assert.strictEqual(n, 2, 'a blocked message costs nothing, so it must not spend the daily budget');
  });
});

describe('recentRunCount — the 60-second flood window', () => {
  test('only the last minute counts', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 0 });
    await seedRun({ agoMinutes: 0 });
    await seedRun({ agoMinutes: 5 });
    const n = await limits.recentRunCount({ agentId, contactNumber: CONTACT });
    assert.strictEqual(n, 2);
  });
});

/* --------------------------------- gates --------------------------------- */

describe('enforceLimits', () => {
  test('an agent with nothing configured is never gated', async (t) => {
    if (!dbUp) return t.skip('no database');
    for (let i = 0; i < 40; i++) await seedRun({ agoMinutes: 0 });
    assert.strictEqual(await enforce(agentRow()), null);
  });

  test('the burst limit throttles without recording or sending anything', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 0 });
    await seedRun({ agoMinutes: 0 });
    const res = await enforce(agentRow({ max_replies_per_minute: 2 }));
    assert.strictEqual(res.skipped, 'rate_limited');
    assert.strictEqual(sends.length, 0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs WHERE agent_id=$1 AND status='limited'`, [agentId]);
    assert.strictEqual(rows[0].n, 0, 'a throttle is "not right now", not a state change');
  });

  test('under the burst limit it passes straight through', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 0 });
    assert.strictEqual(await enforce(agentRow({ max_replies_per_minute: 3 })), null);
  });

  test('the conversation cap blocks, logs a visible row, and reports the first hit', async (t) => {
    if (!dbUp) return t.skip('no database');
    for (let i = 0; i < 3; i++) await seedRun({ agoMinutes: i + 1 });
    const res = await enforce(agentRow({ max_replies_per_conversation: 3 }));
    assert.strictEqual(res.skipped, 'conversation_limit');
    assert.strictEqual(res.firstHit, true);

    const { rows } = await pool.query(
      `SELECT status, error_message FROM coexistence.agent_runs
        WHERE agent_id=$1 AND status='limited'`, [agentId]);
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].error_message, /Conversation reply limit reached \(3\/3\)/);
  });

  test('the closing message and handoff fire ONCE, not on every later message', async (t) => {
    if (!dbUp) return t.skip('no database');
    for (let i = 0; i < 2; i++) await seedRun({ agoMinutes: i + 1 });
    const agent = agentRow({
      max_replies_per_conversation: 2,
      limit_reached_message: 'Someone will take it from here.',
      limit_handoff: true,
      handoff_user_ids: [7],
    });

    const first = await enforce(agent);
    assert.strictEqual(first.firstHit, true);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].body, 'Someone will take it from here.');
    assert.strictEqual(handoffs.length, 1);
    assert.match(handoffs[0].reason, /Reply limit reached/);
    assert.strictEqual(handoffs[0].by, 'limit');

    // Three more messages from the same person.
    for (let i = 0; i < 3; i++) {
      const again = await enforce(agent);
      assert.strictEqual(again.skipped, 'conversation_limit');
      assert.strictEqual(again.firstHit, false);
    }
    assert.strictEqual(sends.length, 1, 'the customer must not be told the same thing four times');
    assert.strictEqual(handoffs.length, 1);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs WHERE agent_id=$1 AND status='limited'`, [agentId]);
    assert.strictEqual(rows[0].n, 4, 'every blocked message is still logged for the operator');
  });

  test('a blank closing message sends nothing at all', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 1 });
    const res = await enforce(agentRow({ max_replies_per_conversation: 1, limit_reached_message: '' }));
    assert.strictEqual(res.skipped, 'conversation_limit');
    assert.strictEqual(sends.length, 0);
  });

  test('the conversation budget comes back once the chat has been quiet', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Two replies, but they were 90 minutes ago — past a 30-minute session.
    await seedRun({ agoMinutes: 95 });
    await seedRun({ agoMinutes: 90 });
    assert.strictEqual(await enforce(agentRow({ max_replies_per_conversation: 2 })), null);
  });

  test('the daily ceiling blocks every conversation and stays silent', async (t) => {
    if (!dbUp) return t.skip('no database');
    for (let i = 0; i < 5; i++) await seedRun({ agoMinutes: 1, contact: `91777770000${i}` });
    const res = await enforce(agentRow({ max_runs_per_day: 5 }));
    assert.strictEqual(res.skipped, 'daily_limit');
    assert.strictEqual(res.runs, 5);
    assert.strictEqual(sends.length, 0, 'a broadcast backfire must not send hundreds of closing messages');
    assert.strictEqual(handoffs.length, 0);
  });

  test('someone mid-conversation still gets their closing message on a capped day', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Both ceilings blown at once. Conversation is checked first on purpose, so
    // the customer gets a sentence and a human rather than silence.
    await seedRun({ agoMinutes: 1 });
    await seedRun({ agoMinutes: 2 });
    const res = await enforce(agentRow({
      max_replies_per_conversation: 2,
      max_runs_per_day: 1,
      limit_reached_message: 'One moment.',
      limit_handoff: true,
    }));
    assert.strictEqual(res.skipped, 'conversation_limit');
    assert.strictEqual(sends.length, 1);
  });
});

/* --------------------------- duplicate-run guard -------------------------- */

describe('uq_agent_runs_inbound', () => {
  test('the same inbound message cannot open two runs', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 0, messageId: 'wamid.DUPLICATE_TEST' });
    await assert.rejects(
      () => seedRun({ agoMinutes: 0, messageId: 'wamid.DUPLICATE_TEST' }),
      (e) => e.code === '23505',
      'a replayed webhook must not be able to send a second reply',
    );
  });

  test('runs with no inbound id are not constrained', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 0, messageId: null });
    await seedRun({ agoMinutes: 0, messageId: null });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs WHERE agent_id=$1`, [agentId]);
    assert.strictEqual(rows[0].n, 2, 'the partial index must not catch the test-chat path');
  });

  test('a blocked message is logged once per inbound, not once per delivery', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 1 });
    const agent = agentRow({ max_replies_per_conversation: 1 });
    await enforce(agent, { inboundMessageId: 'wamid.REPLAY' });
    await enforce(agent, { inboundMessageId: 'wamid.REPLAY' });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs WHERE agent_id=$1 AND status='limited'`, [agentId]);
    assert.strictEqual(rows[0].n, 1);
  });
});

/* ═══════════ migration 108: test numbers + the rolling window ═══════════ */

describe('windowMinutes — value + unit is converted in exactly one place', () => {
  test('each unit', () => {
    assert.equal(limits.windowMinutes(30, 'minutes'), 30);
    assert.equal(limits.windowMinutes(2, 'hours'), 120);
    assert.equal(limits.windowMinutes(1, 'days'), 1440);
  });

  test('an unknown unit falls back to days rather than to 1 minute', () => {
    // Falling back to the SMALLEST unit would silently make every window
    // ~1440x shorter than the operator asked for, which reads as "the limit
    // does nothing" rather than as a bad unit.
    assert.equal(limits.windowMinutes(1, 'fortnights'), 1440);
    assert.equal(limits.windowMinutes(1, undefined), 1440);
  });

  test('a non-positive value is 1 of the unit, never 0', () => {
    // A zero-length window would count nothing and let every message through
    // while the UI still showed a configured limit.
    assert.equal(limits.windowMinutes(0, 'hours'), 60);
    assert.equal(limits.windowMinutes(-5, 'hours'), 60);
    assert.equal(limits.windowMinutes('x', 'hours'), 60);
  });

  test('capped at the 30-day scan horizon the counting query uses', () => {
    // Beyond it the window would claim to measure more than the query looks at.
    assert.equal(limits.windowMinutes(365, 'days'), 30 * 1440);
  });
});

describe('describeWindow — the sentence matches the window applied', () => {
  test('singular and plural', () => {
    assert.equal(limits.describeWindow(1, 'days'), '1 day');
    assert.equal(limits.describeWindow(24, 'hours'), '24 hours');
    assert.equal(limits.describeWindow(1, 'minutes'), '1 minute');
  });
});

describe('freesUpAt — when a slot comes back', () => {
  test('oldest counted item + the window', () => {
    const oldest = new Date('2026-08-12T10:00:00Z');
    assert.equal(limits.freesUpAt(oldest, 60).toISOString(), '2026-08-12T11:00:00.000Z');
  });
  test('nothing to age out yields null, not epoch', () => {
    assert.equal(limits.freesUpAt(null, 60), null);
  });
});

describe('normalizeTestNumbers — a stored number that cannot match is worse than none', () => {
  const norm = agentService.normalizeTestNumbers;

  test('strips everything that is not a digit', () => {
    assert.deepEqual(norm([{ number: '+91 98765-43210' }]), [{ number: '919876543210', label: null }]);
  });

  test('dedupes on the last 10 digits, which is how matching works', () => {
    const out = norm([{ number: '919876543210' }, { number: '9876543210', label: 'same person' }]);
    assert.equal(out.length, 1);
  });

  test('drops a too-short entry instead of 400-ing the whole save', () => {
    assert.deepEqual(norm([{ number: '12345' }, { number: '919876543210' }]).map(n => n.number),
      ['919876543210']);
  });

  test('accepts a bare string as well as an object', () => {
    assert.deepEqual(norm(['919876543210']), [{ number: '919876543210', label: null }]);
  });

  test('non-array input is an empty list, never a crash', () => {
    assert.deepEqual(norm(null), []);
    assert.deepEqual(norm('919876543210'), []);
  });
});

describe('quotaCounts — the rolling allowance', () => {
  test('counts replies inside the window and ignores older ones', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 10 });
    await seedRun({ agoMinutes: 50 });
    await seedRun({ agoMinutes: 200 });
    const q = await limits.quotaCounts({
      agentId, contactNumber: CONTACT, windowMin: 60, sessionMinutes: 30,
    });
    assert.equal(q.replies, 2);
  });

  test('a conversation is a run opening after a silence, counted across the window', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Two sittings inside the last 24h: (200,190) and (20,10) minutes ago.
    await seedRun({ agoMinutes: 200 });
    await seedRun({ agoMinutes: 190 });
    await seedRun({ agoMinutes: 20 });
    await seedRun({ agoMinutes: 10 });
    const q = await limits.quotaCounts({
      agentId, contactNumber: CONTACT, windowMin: 1440, sessionMinutes: 30,
    });
    assert.equal(q.replies, 4);
    assert.equal(q.conversations, 2);
  });

  test('a run whose predecessor fell OUT of the window is still a new conversation', async (t) => {
    if (!dbUp) return t.skip('no database');
    // LAG runs over the whole scan horizon on purpose: measuring gaps only
    // inside the window would make the window's first run always look like a
    // fresh conversation, inflating the count.
    await seedRun({ agoMinutes: 100 }); // outside a 60-minute window
    await seedRun({ agoMinutes: 55 });  // inside, 45 min after the previous
    await seedRun({ agoMinutes: 50 });  // continuation
    const q = await limits.quotaCounts({
      agentId, contactNumber: CONTACT, windowMin: 60, sessionMinutes: 30,
    });
    assert.equal(q.replies, 2);
    assert.equal(q.conversations, 1);
  });

  test('a blocked run between two replies does not shrink the gap', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 100 });
    await seedRun({ agoMinutes: 40, status: 'limited' });
    await seedRun({ agoMinutes: 10 });
    const q = await limits.quotaCounts({
      agentId, contactNumber: CONTACT, windowMin: 1440, sessionMinutes: 30,
    });
    // Two sittings, not one: the 'limited' row is not a reply and must not
    // make the 10-minute-ago run look like a continuation of it.
    assert.equal(q.conversations, 2);
    assert.equal(q.replies, 2);
    assert.equal(q.blocked, 1);
  });

  test('test runs and failed runs are invisible to the allowance', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 5, isTest: true });
    await seedRun({ agoMinutes: 6, status: 'failed' });
    const q = await limits.quotaCounts({
      agentId, contactNumber: CONTACT, windowMin: 1440, sessionMinutes: 30,
    });
    assert.equal(q.replies, 0);
    assert.equal(q.conversations, 0);
  });
});

describe('enforceLimits — the rolling quota', () => {
  test('refuses once the reply allowance is used up', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 60 });
    await seedRun({ agoMinutes: 120 });
    const res = await enforce(agentRow({
      quota_replies: 2, quota_window_value: 24, quota_window_unit: 'hours',
    }));
    assert.equal(res?.skipped, 'quota_replies');
    assert.equal(res.limit, 2);
  });

  test('the same person is allowed again once the window has moved past them', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Both replies are older than a one-hour window, so the allowance is back
    // even though the session cap (which refills on silence) would also allow
    // it — this is the case the two rules answer differently.
    await seedRun({ agoMinutes: 90 });
    await seedRun({ agoMinutes: 120 });
    const res = await enforce(agentRow({
      quota_replies: 2, quota_window_value: 1, quota_window_unit: 'hours',
    }));
    assert.equal(res, null);
  });

  test('a rolling window catches what the session cap cannot', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Three separate sittings today, each well inside a session cap of 5.
    await seedRun({ agoMinutes: 600 });
    await seedRun({ agoMinutes: 400 });
    await seedRun({ agoMinutes: 200 });
    const agent = agentRow({
      max_replies_per_conversation: 5,
      quota_replies: 3, quota_window_value: 1, quota_window_unit: 'days',
    });
    const res = await enforce(agent);
    assert.equal(res?.skipped, 'quota_replies');
  });

  test('the conversation allowance refuses a NEW sitting', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 600 });
    await seedRun({ agoMinutes: 300 });
    const res = await enforce(agentRow({
      quota_conversations: 2, quota_window_value: 1, quota_window_unit: 'days',
    }));
    assert.equal(res?.skipped, 'quota_conversations');
  });

  test('but never cuts someone off mid-conversation', async (t) => {
    if (!dbUp) return t.skip('no database');
    // Their second sitting is happening right now (last reply 2 minutes ago,
    // inside the 30-minute session). Refusing here would end a conversation
    // the same rule allowed them to start.
    await seedRun({ agoMinutes: 600 });
    await seedRun({ agoMinutes: 5 });
    await seedRun({ agoMinutes: 2 });
    const res = await enforce(agentRow({
      quota_conversations: 2, quota_window_value: 1, quota_window_unit: 'days',
    }));
    assert.equal(res, null);
  });

  test('sends the closing line once per window, then stays quiet', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 30 });
    const agent = agentRow({
      quota_replies: 1, quota_window_value: 1, quota_window_unit: 'days',
      limit_reached_message: 'Back tomorrow!',
    });
    const first = await enforce(agent);
    assert.equal(first.firstHit, true);
    assert.equal(sends.length, 1);
    const second = await enforce(agent);
    assert.equal(second.firstHit, false);
    assert.equal(sends.length, 1, 'the second refusal must not message them again');
  });

  test('does not hand over to a human unless asked', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 30 });
    await enforce(agentRow({ quota_replies: 1 }));
    assert.equal(handoffs.length, 0, 'quota_handoff defaults off');

    await pool.query('DELETE FROM coexistence.agent_runs WHERE agent_id = $1', [agentId]);
    await seedRun({ agoMinutes: 30 });
    await enforce(agentRow({ quota_replies: 1, quota_handoff: true }));
    assert.equal(handoffs.length, 1);
  });

  test('records the refusal with its reason and when it frees up', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 30 });
    await enforce(agentRow({ quota_replies: 1, quota_window_value: 2, quota_window_unit: 'hours' }));
    const { rows } = await pool.query(
      `SELECT status, error_message FROM coexistence.agent_runs
        WHERE agent_id = $1 AND status = 'limited'`, [agentId]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].error_message, /Reply quota reached \(1\/1 in the last 2 hours\)/);
    assert.match(rows[0].error_message, /next reply available/);
  });
});

describe('a test number is exempt from every limit', () => {
  test('isTest short-circuits, writing nothing', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 1 });
    await seedRun({ agoMinutes: 2 });
    const agent = agentRow({
      max_replies_per_conversation: 1,
      max_replies_per_minute: 1,
      max_runs_per_day: 1,
      quota_replies: 1,
      limit_reached_message: 'stop',
    });
    const res = await enforce(agent, { isTest: true });
    assert.equal(res, null);
    assert.equal(sends.length, 0);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM coexistence.agent_runs
        WHERE agent_id = $1 AND status = 'limited'`, [agentId]);
    assert.equal(rows[0].n, 0, 'an exempt message must not log a refusal');
  });

  test('test runs do not consume anyone else’s day', async (t) => {
    if (!dbUp) return t.skip('no database');
    await seedRun({ agoMinutes: 5, isTest: true });
    await seedRun({ agoMinutes: 6, isTest: true });
    assert.equal(await limits.runsToday({ agentId }), 0);
    assert.equal(await limits.recentRunCount({ agentId, contactNumber: CONTACT }), 0);
    const s = await limits.sessionCounts({ agentId, contactNumber: CONTACT, sessionMinutes: 30 });
    assert.equal(s.replies, 0);
  });
});
