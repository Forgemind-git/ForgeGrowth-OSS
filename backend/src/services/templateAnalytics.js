// Template analytics: pulls per-day SENT/DELIVERED/READ/CLICKED counts from
// Meta's WABA template_analytics endpoint and upserts into
// coexistence.message_template_analytics_daily.
//
// Refresh policy: daily cron pulls 30 days for every APPROVED template, and
// the builder UI calls /:id/analytics/refresh on demand. Meta caps the window
// at 90 days; chunk longer windows yourself if you ever need history.

const pool = require('../db');
const { fetchAnalytics } = require('../integrations/metaTemplates');
const { getAccountWithToken } = require('../routes/whatsappAccounts');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh analytics for one template over the last `days` days.
 * @returns {object} { upserted, totals: {sent, delivered, read, clicked} }
 */
async function refreshOne(template, { days = 30 } = {}) {
  if (!template.meta_template_id || !template.whatsapp_account_id) {
    throw new Error('Template missing Meta ID or account — cannot fetch analytics');
  }
  const account = await getAccountWithToken(template.whatsapp_account_id);
  if (!account?.accessToken) throw new Error('Linked account has no access token');

  const end = new Date();
  const start = new Date(end.getTime() - days * DAY_MS);

  const result = await fetchAnalytics(account.wabaId, account.accessToken, {
    templateIds: [template.meta_template_id],
    start, end,
    granularity: 'DAILY',
  });

  // Meta returns one entry per call (when single template_id requested) with data_points
  const points = result?.[0]?.data_points || [];
  let upserted = 0;
  const totals = { sent: 0, delivered: 0, read: 0, clicked: 0 };

  for (const pt of points) {
    // Each point's `start` is unix seconds at the bucket boundary
    const dayDate = new Date(pt.start * 1000).toISOString().slice(0, 10);
    const sent = pt.sent || 0;
    const delivered = pt.delivered || 0;
    const read = pt.read || 0;
    const clickedArr = Array.isArray(pt.clicked) ? pt.clicked : [];
    const clickedTotal = clickedArr.reduce((s, c) => s + (c.count || 0), 0);

    totals.sent += sent;
    totals.delivered += delivered;
    totals.read += read;
    totals.clicked += clickedTotal;

    await pool.query(
      `INSERT INTO coexistence.message_template_analytics_daily
         (template_id, day, sent, delivered, read_count, clicked_total, clicked_by_button, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (template_id, day) DO UPDATE
         SET sent = EXCLUDED.sent,
             delivered = EXCLUDED.delivered,
             read_count = EXCLUDED.read_count,
             clicked_total = EXCLUDED.clicked_total,
             clicked_by_button = EXCLUDED.clicked_by_button,
             last_fetched_at = NOW()`,
      [template.id, dayDate, sent, delivered, read, clickedTotal, JSON.stringify(clickedArr)]
    );
    upserted++;
  }

  return { upserted, totals, points: points.length };
}

/**
 * Read cached analytics for one template — returns daily series + totals.
 */
async function getCached(templateId, { days = 30 } = {}) {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT day, sent, delivered, read_count, clicked_total, clicked_by_button, last_fetched_at
       FROM coexistence.message_template_analytics_daily
      WHERE template_id = $1 AND day >= $2
      ORDER BY day ASC`,
    [templateId, cutoff]
  );
  const totals = rows.reduce((acc, r) => ({
    sent: acc.sent + r.sent,
    delivered: acc.delivered + r.delivered,
    read: acc.read + r.read_count,
    clicked: acc.clicked + r.clicked_total,
  }), { sent: 0, delivered: 0, read: 0, clicked: 0 });

  // Aggregate per-button clicks across the whole window
  const buttonMap = new Map();
  for (const r of rows) {
    for (const b of (r.clicked_by_button || [])) {
      const key = `${b.type || 'UNKNOWN'}::${b.button_content || ''}`;
      buttonMap.set(key, (buttonMap.get(key) || 0) + (b.count || 0));
    }
  }
  const buttonBreakdown = Array.from(buttonMap.entries()).map(([k, count]) => {
    const [type, button_content] = k.split('::');
    return { type, button_content, count };
  }).sort((a, b) => b.count - a.count);

  return {
    days,
    series: rows.map(r => ({
      day: r.day,
      sent: r.sent,
      delivered: r.delivered,
      read: r.read_count,
      clicked: r.clicked_total,
    })),
    totals,
    buttonBreakdown,
    lastFetchedAt: rows[rows.length - 1]?.last_fetched_at || null,
  };
}

module.exports = { refreshOne, getCached };
