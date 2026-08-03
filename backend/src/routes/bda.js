// BDA Performance + Activity Log + Webinar Conversion — conversion leaderboards
// aggregated from bda_activity_log + leads + webinar_registrations.
// Mounted under /api with authMiddleware in index.js.
//
//   GET  /bda-performance?period=week|month|all   conversion leaderboard
//   GET  /bda-activity                            raw filterable activity log
//   GET  /webinar-conversion                      per-batch cohort funnel + BDA close board

const { Router } = require('express');
const pool = require('../db');

const router = Router();

function periodInterval(period) {
  if (period === 'week') return `NOW() - INTERVAL '7 days'`;
  if (period === 'month') return `NOW() - INTERVAL '30 days'`;
  return `'-infinity'::timestamptz`;
}

// ── BDA performance leaderboard ───────────────────────────────────────────────
router.get('/bda-performance', async (req, res) => {
  try {
    const since = periodInterval(req.query.period);
    // Activity aggregates keyed by bda label.
    const { rows: act } = await pool.query(
      `SELECT bda,
              COUNT(*) FILTER (WHERE action='message_sent')::int  AS messages_sent,
              COUNT(*) FILTER (WHERE action='trigger_fired')::int AS triggers_fired,
              ROUND(AVG(response_time_seconds) FILTER (WHERE response_time_seconds IS NOT NULL))::int AS avg_response
         FROM coexistence.bda_activity_log
        WHERE bda IS NOT NULL AND ts >= ${since}
        GROUP BY bda`
    );
    // Lead handling + conversion keyed by assigned_bda.
    const { rows: leadAgg } = await pool.query(
      `SELECT assigned_bda AS bda,
              COUNT(*)::int AS leads_handled,
              COUNT(*) FILTER (WHERE stage='enrolled')::int AS converted
         FROM coexistence.leads
        WHERE assigned_bda IS NOT NULL
        GROUP BY assigned_bda`
    );
    // Roster for display names.
    const { rows: roster } = await pool.query(
      `SELECT id, name FROM coexistence.team_members`
    );
    const nameById = {};
    for (const t of roster) nameById[t.id] = t.name;

    const byBda = {};
    const ensure = (bda) => (byBda[bda] || (byBda[bda] = {
      bda, name: nameById[bda] || bda, firstResponseTime: null, messagesSent: 0,
      triggersFired: 0, leadsHandled: 0, converted: 0,
    }));
    for (const a of act) {
      const e = ensure(a.bda);
      e.messagesSent = a.messages_sent; e.triggersFired = a.triggers_fired;
      e.firstResponseTime = a.avg_response;
    }
    for (const l of leadAgg) {
      const e = ensure(l.bda);
      e.leadsHandled = l.leads_handled; e.converted = l.converted;
    }
    const leaderboard = Object.values(byBda)
      .map(e => ({ ...e, conversionPct: e.leadsHandled ? Math.round((e.converted / e.leadsHandled) * 100) : 0 }))
      .sort((a, b) => b.converted - a.converted || b.conversionPct - a.conversionPct);

    res.json({ leaderboard });
  } catch (err) {
    console.error('[bda] performance error:', err.message);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

// ── raw activity log ──────────────────────────────────────────────────────────
router.get('/bda-activity', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.bda) { params.push(req.query.bda); where.push(`a.bda = $${params.length}`); }
    if (req.query.action) { params.push(req.query.action); where.push(`a.action = $${params.length}`); }
    if (req.query.days) {
      const n = parseInt(req.query.days, 10);
      if (Number.isFinite(n)) where.push(`a.ts >= NOW() - INTERVAL '${n} days'`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT a.*, l.name AS lead_name, l.whatsapp_number, tm.name AS bda_name
         FROM coexistence.bda_activity_log a
         LEFT JOIN coexistence.leads l ON l.id = a.lead_id
         LEFT JOIN coexistence.team_members tm ON tm.id = a.bda
         ${clause} ORDER BY a.ts DESC LIMIT 500`,
      params
    );
    // "Active now": any BDA with activity in the last 5 minutes (resolved to name).
    const { rows: active } = await pool.query(
      `SELECT DISTINCT COALESCE(tm.name, a.bda) AS bda
         FROM coexistence.bda_activity_log a
         LEFT JOIN coexistence.team_members tm ON tm.id = a.bda
        WHERE a.bda IS NOT NULL AND a.ts >= NOW() - INTERVAL '5 minutes'`
    );
    res.json({
      activity: rows.map(r => ({
        id: Number(r.id), ts: r.ts, bda: r.bda_name || r.bda, leadId: r.lead_id == null ? null : Number(r.lead_id),
        leadName: r.lead_name, whatsappNumber: r.whatsapp_number, action: r.action,
        triggerPhrase: r.trigger_phrase, responseTimeSeconds: r.response_time_seconds, note: r.note,
      })),
      activeNow: active.map(a => a.bda),
    });
  } catch (err) {
    console.error('[bda] activity error:', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// ── webinar conversion ────────────────────────────────────────────────────────
router.get('/webinar-conversion', async (req, res) => {
  try {
    // Per-batch cohort funnel.
    const { rows: cohorts } = await pool.query(
      `SELECT w.id, w.batch_name, w.date,
              COUNT(wr.*)::int AS booked,
              COUNT(*) FILTER (WHERE wr.attended)::int AS attended,
              COUNT(*) FILTER (WHERE l.stage IN ('hot','enrolled'))::int AS hot,
              COUNT(*) FILTER (WHERE l.stage = 'enrolled')::int AS enrolled
         FROM coexistence.webinars w
         LEFT JOIN coexistence.webinar_registrations wr ON wr.webinar_id = w.id
         LEFT JOIN coexistence.leads l ON l.id = wr.lead_id
        GROUP BY w.id, w.batch_name, w.date
        ORDER BY w.date DESC NULLS LAST, w.id DESC`
    );
    // No-show follow-up queue (registered, not attended).
    const { rows: noShows } = await pool.query(
      `SELECT wr.id, wr.webinar_id, w.batch_name, l.id AS lead_id, l.name AS lead_name,
              l.whatsapp_number, l.assigned_bda
         FROM coexistence.webinar_registrations wr
         JOIN coexistence.webinars w ON w.id = wr.webinar_id
         JOIN coexistence.leads l ON l.id = wr.lead_id
        WHERE wr.attended = FALSE
        ORDER BY w.date DESC NULLS LAST LIMIT 100`
    );
    // Per-BDA close leaderboard: converted leads attributed to a BDA who attended.
    const { rows: closes } = await pool.query(
      `SELECT l.assigned_bda AS bda,
              COUNT(DISTINCT wr.webinar_id)::int AS hosted,
              COUNT(*) FILTER (WHERE l.stage = 'enrolled')::int AS closed,
              COUNT(*)::int AS handled
         FROM coexistence.webinar_registrations wr
         JOIN coexistence.leads l ON l.id = wr.lead_id
        WHERE l.assigned_bda IS NOT NULL
        GROUP BY l.assigned_bda`
    );
    const { rows: roster } = await pool.query(`SELECT id, name FROM coexistence.team_members`);
    const nameById = {}; for (const t of roster) nameById[t.id] = t.name;

    res.json({
      cohorts: cohorts.map(c => ({
        id: Number(c.id), batchName: c.batch_name, date: c.date,
        funnel: [
          { step: 'Booked', count: Number(c.booked || 0) },
          { step: 'Attended', count: Number(c.attended || 0) },
          { step: 'Hot', count: Number(c.hot || 0) },
          { step: 'Enrolled', count: Number(c.enrolled || 0) },
        ],
      })),
      noShows: noShows.map(n => ({
        id: Number(n.id), webinarId: Number(n.webinar_id), batchName: n.batch_name,
        leadId: Number(n.lead_id), leadName: n.lead_name, whatsappNumber: n.whatsapp_number,
        assignedBda: n.assigned_bda, assignedBdaName: nameById[n.assigned_bda] || n.assigned_bda,
      })),
      closeLeaderboard: closes.map(c => ({
        bda: c.bda, name: nameById[c.bda] || c.bda, hosted: Number(c.hosted || 0),
        closed: Number(c.closed || 0),
        closeRate: c.handled ? Math.round((c.closed / c.handled) * 100) : 0,
      })).sort((a, b) => b.closed - a.closed),
    });
  } catch (err) {
    console.error('[bda] webinar-conversion error:', err.message);
    res.status(500).json({ error: 'Failed to load webinar conversion' });
  }
});

module.exports = { router };
