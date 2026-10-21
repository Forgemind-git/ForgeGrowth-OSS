// ============================================================
// rateLimiter.js — Redis sliding-window rate limiter for ALL outbound
// social-API calls, so ForgeSocial stays under each platform's limit.
//
// The binding constraint is Instagram's 200 calls/hour PER TOKEN, so buckets are
// keyed per token (a sha1 prefix of the access token), each with its own window.
// `gatedFetch` is a drop-in for the global `fetch`: every platform module aliases
// `fetch` to it, so each request to a known API host transparently acquires a
// slot first. Non-API hosts (image/CDN downloads) pass straight through.
//
// `gate()` BLOCKS until a slot frees (up to maxWaitMs) instead of ever exceeding
// the limit — that's the whole point. Interactive callers time out (~20s) and
// fall back to cache/mock; the backfill worker catches RATE_LIMITED and retries
// on the next tick once the rolling window has freed budget.
// ============================================================
const crypto = require('crypto');
const redis = require('./redis');

// Per-API-host limits. Conservative vs the real ceilings (IG = 200/hr/token) so
// we always stay safely under. graph.facebook.com serves Instagram accounts
// connected through a Facebook Page token; per-token bucketing keeps each token
// independently bounded.
const HOST_LIMITS = {
  'graph.instagram.com': { bucket: 'ig', max: 180, windowMs: 3600000 },
  'graph.facebook.com':  { bucket: 'fb', max: 180, windowMs: 3600000 },
};

// Messaging has its OWN limits per Instagram professional account, separate from
// the hourly Platform budget above (Meta: Instagram Platform overview → "Messaging
// Rate Limits", and Graph API → Rate Limits → Business Use Case → Messaging):
//   Send API          100 calls/s (text, links, reactions, stickers), 10/s audio/video
//   Private replies   750 calls/hour (comments on posts/reels)
//   Conversations API 2 calls/s
// We stay well inside each (about half) so an auto-reply never waits behind
// analytics and never gets anywhere near Meta's ceiling. Keyed per token, and a
// token belongs to one account, so these are per-account buckets.
const MESSAGING_LIMITS = {
  send:          { bucket: 'ig_send',  max: 50,  windowMs: 1000 },
  send_media:    { bucket: 'ig_media', max: 5,   windowMs: 1000 },
  private_reply: { bucket: 'ig_pr',    max: 600, windowMs: 3600000 },
  conversations: { bucket: 'ig_conv',  max: 1,   windowMs: 1000, maxWaitMs: 60000 },
};

// Which messaging bucket (if any) a request belongs to.
function messagingKind(u, opts) {
  let path;
  try { path = new URL(u).pathname; } catch { return null; }
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET' && /\/conversations$/.test(path)) return 'conversations';
  if (method !== 'POST' || !/\/messages$/.test(path)) return null;
  let body = null;
  try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* form body */ }
  if (body?.recipient?.comment_id) return 'private_reply';
  const t = body?.message?.attachment?.type;
  if (t === 'audio' || t === 'video') return 'send_media';
  return 'send';
}

// Atomic sliding-window check-and-add. Returns -1 when a slot was acquired, else
// the ms until the oldest entry ages out (i.e. how long to wait before retrying).
const SLIDING_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - win)
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, win)
  return -1
end
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return (tonumber(first[2]) + win) - now
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenKey = (t) => (t ? crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12) : 'anon');

// Acquire one slot from `bucket:subkey`, waiting until free or maxWaitMs elapses.
// Default wait is 6s (was 20s): when the budget is exhausted, every gated call
// in an interactive request used to hang the page section for up to 20s before
// failing over to cache/DB fallback. 6s still smooths short bursts; background
// jobs catch RATE_LIMITED and retry on their next tick regardless.
async function gate(bucket, subkey, { max, windowMs, maxWaitMs = 6000 } = {}) {
  if (!redis) return true; // fail-open when Redis is down
  const key = `forgesocial:rl:${bucket}:${subkey}`;
  const start = Date.now();
  while (true) {
    let res;
    try {
      res = await redis.eval(SLIDING_LUA, 1, key, Date.now(), windowMs, max, `${Date.now()}-${Math.random()}`);
    } catch (e) {
      console.error('rateLimiter redis error (fail-open):', e.message);
      return true;
    }
    if (Number(res) === -1) return true;
    let wait = Number(res);
    if (!(wait > 0)) wait = 1000;
    if (Date.now() - start + wait > maxWaitMs) {
      const err = new Error(`rate-limited: ${bucket} budget exhausted (retry in ~${Math.ceil(wait / 1000)}s)`);
      err.code = 'RATE_LIMITED';
      err.retryMs = wait;
      throw err;
    }
    await sleep(Math.min(wait + 50, 15000));
  }
}

// Calls still free this window for the token behind `url` (no slot taken).
// Background "nice to have" jobs check it and yield so people-facing calls
// (replies, follow checks, Inbox) keep a reserve. null = unknown (no Redis).
async function headroom(url) {
  if (!redis) return null;
  let host = '';
  try { host = new URL(String(url)).host; } catch { return null; }
  const hostKey = Object.keys(HOST_LIMITS).find((h) => host.includes(h));
  if (!hostKey) return null;
  const { bucket, max, windowMs } = HOST_LIMITS[hostKey];
  const key = `forgesocial:rl:${bucket}:${tokenKey(extractToken(String(url), {}))}`;
  try {
    await redis.zremrangebyscore(key, 0, Date.now() - windowMs);
    return max - Number(await redis.zcard(key));
  } catch { return null; }
}

function extractToken(url, opts) {
  try {
    const t = new URL(url).searchParams.get('access_token');
    if (t) return t;
  } catch { /* not a parseable URL */ }
  const auth = opts && opts.headers && (opts.headers.Authorization || opts.headers.authorization);
  if (auth) return String(auth).replace(/^Bearer\s+/i, '');
  return null;
}

// Drop-in for global fetch. Gates known API hosts (per token), passes everything
// else through untouched. `opts.__rl` lets a caller override { maxWaitMs }.
async function gatedFetch(url, opts = {}) {
  const u = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
  let host = '';
  try { host = new URL(u).host; } catch { /* relative/blob — pass through */ }
  const hostKey = host && Object.keys(HOST_LIMITS).find((h) => host.includes(h));
  if (hostKey) {
    const msg = (hostKey === 'graph.instagram.com' || hostKey === 'graph.facebook.com') && messagingKind(u, opts);
    const lim = msg ? MESSAGING_LIMITS[msg] : HOST_LIMITS[hostKey];
    await gate(lim.bucket, tokenKey(extractToken(u, opts)), { ...lim, ...(opts.__rl || {}) });
  }
  const o = { ...opts };
  delete o.__rl;
  return fetch(u, o); // global fetch
}

module.exports = { gate, gatedFetch, headroom, tokenKey, HOST_LIMITS, MESSAGING_LIMITS, messagingKind };
