const NOTIFY_URL = process.env.FORGECOMMAND_WEBHOOK_URL;
const NOTIFY_SECRET = process.env.FORGECOMMAND_WEBHOOK_SECRET;

function forgeCommandNotify(eventType, payload) {
  if (!NOTIFY_URL) return;
  fetch(NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NOTIFY_SECRET}` },
    body: JSON.stringify({ source: 'forgechat', event_type: eventType, payload }),
  }).catch(() => {});
}

module.exports = { forgeCommandNotify };
