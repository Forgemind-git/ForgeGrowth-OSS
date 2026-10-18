const socialEnv = require('./env');
const NOTIFY_URL = socialEnv.FORGECOMMAND_WEBHOOK_URL;
const NOTIFY_SECRET = socialEnv.FORGECOMMAND_WEBHOOK_SECRET;

function forgeCommandNotify(eventType, payload) {
  if (!NOTIFY_URL) return;
  fetch(NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NOTIFY_SECRET}` },
    body: JSON.stringify({ source: 'forgesocial', event_type: eventType, payload }),
  }).catch(() => {});
}

module.exports = { forgeCommandNotify };
