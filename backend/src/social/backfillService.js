// ============================================================
// backfillService.js — complete, rate-bounded, resumable historical backfill.
//
// One job per (platform, account). Jobs live in a Redis list so they survive
// restarts; a worker pops them one at a time and runs the platform's getAllPosts
// (which paginates the ENTIRE history), upserting every post idempotently. All
// API calls inside getAllPosts go through the Redis rate limiter, so the worker
// can only go as fast as the budget allows — when a token's window is exhausted
// the call throws RATE_LIMITED, the job is requeued, and the worker stops until
// the next tick (every 2 min) when the rolling window has freed slots. Thus it
// "keeps running as long as required" without ever exceeding a platform's limit.
// ============================================================
const redis = require('./redis');
const accounts = require('./accounts');
const syncService = require('./syncService');

const MODULES = {
  instagram: require('./instagram'),
  threads:   require('./threads'),
  youtube:   require('./youtube'),
  facebook:  require('./facebook'),
  linkedin:  require('./linkedin'),
};

const QKEY   = 'forgesocial:backfill:queue';
const STATUS = 'forgesocial:backfill:status';      // hash: jobId -> JSON result
const INIT   = 'forgesocial:backfill:initialized'; // set once after first seed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobId = (j) => `${j.platform}:${j.accountId || j.accountKey || 'primary'}`;
let running = false;

// One job per connected account across every platform.
async function enumerateJobs() {
  const jobs = [];
  try {
    for (const a of await accounts.accountsForSync('instagram')) {
      jobs.push({ platform: 'instagram', accountId: a.accountId });
    }
  } catch (e) { console.error('Backfill enumerate IG failed:', e.message); }
  for (const p of ['threads', 'youtube', 'facebook', 'linkedin']) {
    try {
      for (const c of await accounts.accountCreds(p)) {
        jobs.push({ platform: p, accountKey: c.accountKey });
      }
    } catch (e) { console.error(`Backfill enumerate ${p} failed:`, e.message); }
  }
  return jobs;
}

async function enqueueAll() {
  if (!redis) return 0;
  const jobs = await enumerateJobs();
  if (jobs.length) await redis.rpush(QKEY, ...jobs.map((j) => JSON.stringify(j)));
  await redis.del(STATUS);
  console.log(`Backfill: enqueued ${jobs.length} account job(s)`);
  return jobs.length;
}

// Seed the queue once (first boot). Subsequent boots resume the existing queue.
async function ensureSeeded() {
  if (!redis) return;
  try {
    if (await redis.get(INIT)) return;
    await enqueueAll();
    await redis.set(INIT, String(Date.now()));
  } catch (e) { console.error('Backfill seed failed:', e.message); }
}

async function processJob(job) {
  const mod = MODULES[job.platform];
  if (!mod || !mod.getAllPosts) return { ok: false, reason: 'no getAllPosts' };

  let posts = [];
  let accountKey = null;

  if (job.platform === 'instagram') {
    const accs = await accounts.accountsForSync('instagram');
    const a = accs.find((x) => x.accountId === job.accountId) || accs[0];
    if (!a) return { ok: false, reason: 'account not found' };
    posts = await mod.getAllPosts(a.statsArg);   // { accountId, token }
    accountKey = a.accountId;
  } else {
    const creds = await accounts.accountCreds(job.platform);
    const c = creds.find((x) => x.accountKey === job.accountKey) || creds[0];
    if (!c) return { ok: false, reason: 'account not found' };
    posts = await mod.getAllPosts(c.cred);
    accountKey = c.accountKey === 'primary' ? null : c.accountKey;   // null → primary's rows
  }

  const count = await syncService._upsertPosts(job.platform, posts || [], accountKey);
  return { ok: true, count, fetched: (posts || []).length };
}

// Drain the queue until empty or the rate budget is hit. Re-entrant-safe.
async function tick() {
  if (!redis || running) return;
  running = true;
  try {
    while (true) {
      const raw = await redis.rpop(QKEY);
      if (!raw) break;                       // queue drained → done for now
      let job;
      try { job = JSON.parse(raw); } catch { continue; }
      try {
        const r = await processJob(job);
        await redis.hset(STATUS, jobId(job), JSON.stringify({ ...r, at: Date.now() }));
        console.log(`Backfill ${jobId(job)}: ${r.ok ? `+${r.count} of ${r.fetched} posts` : 'FAIL ' + r.reason}`);
      } catch (e) {
        if (e.code === 'RATE_LIMITED') {
          await redis.lpush(QKEY, raw);      // put back; retry on the next tick
          console.log(`Backfill paused on ${jobId(job)} (rate budget). ${await redis.llen(QKEY)} job(s) remain; resumes next tick.`);
          break;
        }
        await redis.hset(STATUS, jobId(job), JSON.stringify({ ok: false, reason: e.message, at: Date.now() }));
        console.error(`Backfill ${jobId(job)} error:`, e.message);
      }
      await sleep(800);                      // gentle pacing between accounts
    }
  } finally { running = false; }
}

async function status() {
  if (!redis) return { enabled: false };
  const [queued, raw, initialized] = await Promise.all([
    redis.llen(QKEY),
    redis.hgetall(STATUS),
    redis.get(INIT),
  ]);
  const results = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => {
    try { return [k, JSON.parse(v)]; } catch { return [k, v]; }
  }));
  return { enabled: true, running, queued, initializedAt: initialized ? Number(initialized) : null, completed: Object.keys(results).length, results };
}

// Manual (admin) trigger: re-enqueue everything and start draining.
async function start() {
  const n = await enqueueAll();
  tick().catch((e) => console.error('Backfill tick error:', e.message));
  return n;
}

module.exports = { ensureSeeded, enqueueAll, tick, status, start };
