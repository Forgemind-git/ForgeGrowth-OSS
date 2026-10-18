const socialEnv = require('./env');
// Shared Redis client for the rate limiter + backfill queue.
// Fail-soft: if Redis is unreachable, callers fall back to allowing the work
// (the rate limiter fails open, the backfill simply doesn't run) so the app
// never hard-breaks on a Redis outage.
const Redis = require('ioredis');

let redis = null;
try {
  redis = new Redis(socialEnv.REDIS_URL || 'redis://redis:6379', {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 300, 5000),
  });
  let loggedErr = false;
  redis.on('error', (e) => { if (!loggedErr) { console.error('Redis error:', e.message); loggedErr = true; } });
  redis.on('ready', () => { loggedErr = false; console.log('Redis connected'); });
} catch (e) {
  console.error('Redis init failed (continuing without it):', e.message);
  redis = null;
}

module.exports = redis;
