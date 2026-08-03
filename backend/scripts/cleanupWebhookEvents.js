#!/usr/bin/env node
// Delete webhook audit rows older than WEBHOOK_RETENTION_DAYS (default 30).
// Run from host cron daily:
//   30 3 * * * docker exec forgecrm-backend node scripts/cleanupWebhookEvents.js >> /var/log/forgecrm-webhook-cleanup.log 2>&1

require('dotenv').config();
const pool = require('../src/db');

(async () => {
  const days = parseInt(process.env.WEBHOOK_RETENTION_DAYS, 10) || 30;
  const { rowCount } = await pool.query(
    `DELETE FROM coexistence.webhook_events WHERE received_at < NOW() - ($1 || ' days')::interval`,
    [days]
  );
  console.log(`[webhook-cleanup] removed ${rowCount} rows older than ${days}d`);
  process.exit(0);
})().catch(err => { console.error('[webhook-cleanup] fatal:', err.message); process.exit(1); });
