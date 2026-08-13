// Home dashboard aggregations.
//
// One endpoint, role-scoped: admins get org-wide numbers + team leaderboard +
// automation/broadcast/alert sections; BDA Sales users get the same shape but
// scoped to ONLY the contacts assigned to them (assigned_user_id), and without
// the admin-only sections (they can't reach those features anyway).
//
// Scoping trick: every contact/chat query carries a `/*SCOPE*/` marker.
// applyScope() strips it for admins, or replaces every occurrence with the
// matching `assigned_user_id` filter for non-admins (reusing a single bind
// param — Postgres allows the same $N placeholder to appear multiple times).
//
// All queries are read-only, parameterised, and hit existing indexes.

const { Router } = require('express');
const pool = require('../db');
const { isAdmin } = require('../permissions');
const cfg = require('../services/funnelConfig');

const router = Router();

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// Replace /*SCOPE*/ markers with the per-user visibility clause.
//   kind 'contacts' → filters on the contacts alias `c`
//   kind 'leads'    → filters on the leads alias `l` (mirrors the Sales funnel scope)
//   kind 'chat'     → EXISTS against contacts for the chat_history alias `ch`
function applyScope(sql, params, { admin, uid, kind }) {
  if (admin) return { sql: sql.split('/*SCOPE*/').join(''), params };
  const p = `$${params.length + 1}`;
  let clause;
  if (kind === 'contacts') clause = ` AND c.assigned_user_id = ${p}`;
  else if (kind === 'leads') clause = ` AND l.assigned_user_id = ${p}`;
  else {
    clause = ` AND EXISTS (SELECT 1 FROM coexistence.contacts sc
                     WHERE sc.wa_number = ch.wa_number
                       AND sc.contact_number = ch.contact_number
                       AND sc.assigned_user_id = ${p})`;
  }
  return { sql: sql.split('/*SCOPE*/').join(clause), params: [...params, uid] };
}

// pct change vs previous period; null when there's no baseline to compare to.
function pct(cur, prev) {
  if (!prev || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

router.get('/dashboard', async (req, res) => {
  try {
    const admin = isAdmin(req.user);
    const uid = req.user.id;
    const range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
    const days = RANGE_DAYS[range];

    // Helper: run a scoped query.
    const q = async (sql, params, kind) => {
      const built = applyScope(sql, params, { admin, uid, kind });
      const { rows } = await pool.query(built.sql, built.params);
      return rows;
    };

    // ── Leads (totals + new this/prev period) ─────────────────────────
    //
    // Counted from coexistence.leads, the same table Sales → Leads reads, so
    // the two pages cannot disagree about how many leads exist.
    //
    // This used to count CONTACTS, which answered a different question and
    // answered it wrong: contacts is keyed on (wa_number, contact_number), so
    // one person who has messaged three business numbers is three rows. Leads
    // are one row per person by construction (whatsapp_number is UNIQUE), so no
    // per-person collapse is needed here at all.
    const [leadRow] = await q(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE l.created_at >= NOW() - ($1 * INTERVAL '1 day'))::int AS new_in_range,
         count(*) FILTER (WHERE l.created_at >= NOW() - ($1 * INTERVAL '1 day') * 2
                            AND l.created_at <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_new
       FROM coexistence.leads l
       WHERE TRUE /*SCOPE*/`,
      [days], 'leads'
    );

    // ── Messages + active conversations (this/prev period) ────────────
    const [msgRow] = await q(
      `SELECT
         count(DISTINCT (ch.wa_number, ch.contact_number))
           FILTER (WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS active_convos,
         count(*) FILTER (WHERE ch.direction='outgoing'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS sent,
         count(*) FILTER (WHERE ch.direction='incoming'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day'))::int AS received,
         count(*) FILTER (WHERE ch.direction='outgoing'
                            AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') * 2
                            AND ch.timestamp <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_sent
       FROM coexistence.chat_history ch
       WHERE TRUE /*SCOPE*/`,
      [days], 'chat'
    );

    // ── Response rate: inbound conversations that got a reply ──────────
    const [respRow] = await q(
      `WITH conv AS (
         SELECT ch.wa_number, ch.contact_number,
                bool_or(ch.direction='incoming') AS has_in,
                bool_or(ch.direction='outgoing') AS has_out
         FROM coexistence.chat_history ch
         WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
         GROUP BY ch.wa_number, ch.contact_number
       )
       SELECT count(*) FILTER (WHERE has_in)::int AS inbound_convos,
              count(*) FILTER (WHERE has_in AND has_out)::int AS replied_convos
       FROM conv`,
      [days], 'chat'
    );

    // ── Open conversations: an unread inbound newer than the last read ─
    //
    // No longer gated on a "Lead Source" tag category. That gate meant the tile
    // silently read 0 on any workspace that had never created a category with
    // that exact name — a number that looks like "nothing is waiting" rather
    // than "this is not configured". Every unanswered customer counts now.
    const [openRow] = await q(
      `WITH last_in AS (
         SELECT ch.wa_number, ch.contact_number, max(ch.timestamp) AS last_in_ts
         FROM coexistence.chat_history ch
         WHERE ch.direction='incoming' /*SCOPE*/
         GROUP BY ch.wa_number, ch.contact_number
       )
       SELECT count(*)::int AS open_convos
       FROM last_in li
       LEFT JOIN coexistence.conversation_reads r
         ON r.wa_number = li.wa_number AND r.contact_number = li.contact_number
       WHERE (r.last_read_at IS NULL OR li.last_in_ts > r.last_read_at)`,
      [], 'chat'
    );

    // ── Daily inbound/outbound trend ──────────────────────────────────
    const trend = await q(
      `SELECT to_char(g.d, 'YYYY-MM-DD') AS date,
              COALESCE(i.cnt, 0)::int AS inbound,
              COALESCE(o.cnt, 0)::int AS outbound
       FROM generate_series((NOW() - ($1 * INTERVAL '1 day'))::date, NOW()::date, INTERVAL '1 day') g(d)
       LEFT JOIN (
         SELECT date_trunc('day', ch.timestamp)::date dt, count(*) cnt
         FROM coexistence.chat_history ch
         WHERE ch.direction='incoming'
           AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
         GROUP BY 1
       ) i ON i.dt = g.d::date
       LEFT JOIN (
         SELECT date_trunc('day', ch.timestamp)::date dt, count(*) cnt
         FROM coexistence.chat_history ch
         WHERE ch.direction='outgoing'
           AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
         GROUP BY 1
       ) o ON o.dt = g.d::date
       ORDER BY g.d`,
      [days], 'chat'
    );

    // ── Lead funnel ───────────────────────────────────────────────────
    //
    // Counted from coexistence.leads — the SAME table Sales → Funnel reads, so
    // the two pages cannot report different numbers for the same question.
    //
    // It used to count contact rows carrying a funnel-stage TAG, which is only
    // a denormalised mirror of leads.stage kept for filtering in Chats. That
    // over-counts, because contacts is keyed on (wa_number, contact_number):
    // one person who has messaged three business numbers is three rows, and the
    // tag sync correctly tags all of them. Live, that read 13 enrolled leads as
    // 24. Counting DISTINCT people instead would have said 12 — still wrong,
    // because an enrolled lead who paid without ever messaging has no contact
    // row at all. Only leads.stage answers "how many leads are at this stage".
    const stageRows = await q(
      `SELECT l.stage, COUNT(*)::int AS count
         FROM coexistence.leads l
        WHERE TRUE /*SCOPE*/
        GROUP BY l.stage`,
      [], 'leads'
    );
    const byStage = {};
    for (const r of stageRows) byStage[r.stage] = r.count;

    const configured = cfg.stages();
    let funnel;
    if (configured.length) {
      // Every configured stage, in the admin's order — including the empty
      // ones. Hiding a stage with no leads in it misrepresents the funnel: an
      // empty middle stage is exactly what you need to see.
      const stages = configured.map(s => ({
        name: s.label, color: s.color, count: byStage[s.stageKey] || 0,
        stageKey: s.stageKey, isFunnel: s.isFunnel,
      }));
      funnel = {
        categoryId: null,
        categoryName: null,   // the panel title reads "Lead stages" on its own
        stages,
        total: stages.reduce((sum, r) => sum + r.count, 0),
        source: 'leads',
      };
    } else {
      // ⚠ The cache is cold. Read `funnel_stages` DIRECTLY rather than falling
      // back to the contact TAG mirror, which answers a different question and
      // answers it wrong: contacts is keyed on (wa_number, contact_number), so
      // the mirror tags every row a person has and over-counts them. Live, that
      // read 13 enrolled leads as 24.
      //
      // The counts above already came from `leads`; only the stage LIST was
      // missing, and that is one query away. Same lesson as the agent's stage
      // validator — never let a cold cache silently change what a number means.
      const { rows: dbStages } = await pool.query(
        `SELECT stage_key, label, color, is_funnel
           FROM coexistence.funnel_stages
          WHERE active = TRUE
          ORDER BY order_index, id`
      );
      const stages = dbStages.map(r => ({
        name: r.label, color: r.color, count: byStage[r.stage_key] || 0,
        stageKey: r.stage_key, isFunnel: r.is_funnel,
      }));
      funnel = {
        categoryId: null, categoryName: null,
        stages, total: stages.reduce((s, r) => s + r.count, 0), source: 'leads',
      };
    }
    // All categories for a future selector
    const { rows: allCats } = await pool.query(
      `SELECT id, name FROM coexistence.categories ORDER BY name`
    );
    funnel.categories = allCats;

    // ── Where leads came from (top 8) ─────────────────────────────────
    //
    // Was a distribution of TAGS across contact rows. Leads carry their own
    // `source` — set from the CTWA referral, a Message Format label, a form or
    // an import — so this now answers "where did these people come from",
    // which is the question the donut was always trying to answer.
    const leadSources = await q(
      `SELECT COALESCE(NULLIF(btrim(l.source), ''), 'Unknown') AS name,
              COUNT(*)::int AS count
         FROM coexistence.leads l
        WHERE TRUE /*SCOPE*/
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 8`,
      [], 'leads'
    );
    // The donut colours its own slices; sources have no stored colour.
    const tagDistribution = leadSources.map(r => ({ name: r.name, count: r.count, color: null }));

    // ── Sales log ─────────────────────────────────────────────────────
    //
    // Read through services/productSales so Home, Products and the Sales Log
    // cannot report three different revenue figures for the same money.
    let sales = { totalSales: 0, newSales: 0, prevSales: 0, totalPaise: 0, rangePaise: 0, prevPaise: 0, rangePayments: 0 };
    let recentSalesRows = [];
    try {
      const ps = require('../services/productSales');
      const scopeUid = admin ? null : uid;
      [sales, recentSalesRows] = await Promise.all([
        ps.salesSummary({ days, uid: scopeUid }),
        ps.recentSales({ limit: 6, uid: scopeUid }),
      ]);
    } catch (e) {
      // A sales-log hiccup must not blank the whole dashboard — the funnel and
      // messaging numbers above are still worth showing.
      console.error('[dashboard] sales summary failed:', e.message);
    }

    // ── Build KPI tiles (5 common + 1 role-specific) ──────────────────
    const responseRate = respRow.inbound_convos > 0
      ? Math.round((respRow.replied_convos / respRow.inbound_convos) * 100)
      : 0;

    const kpis = [
      {
        key: 'leads', label: 'Total Leads', value: leadRow.total, unit: '',
        delta: pct(leadRow.new_in_range, leadRow.prev_new),
        sub: `+${leadRow.new_in_range} new`,
        tooltip: admin
          ? 'Everyone in the funnel. One row per person — change compares new leads this period vs the previous one.'
          : 'Leads assigned to you. Change compares new ones this period vs the previous one.',
      },
      {
        key: 'sales', label: 'Sales', value: sales.totalSales, unit: '',
        delta: pct(sales.newSales, sales.prevSales),
        sub: `+${sales.newSales} this period`,
        tooltip: 'Leads that reached a won stage — the same count the Sales Log shows.',
      },
      {
        key: 'revenue', label: 'Revenue', value: Math.round(sales.rangePaise / 100), unit: '₹',
        delta: pct(sales.rangePaise, sales.prevPaise),
        sub: `${sales.rangePayments} payment(s) · ₹${Math.round(sales.totalPaise / 100).toLocaleString('en-IN')} all time`,
        tooltip: 'Collected in this period — gateway payments matched to a sale plus manually logged ones, deduplicated. The same figure the Sales Log and Products report.',
      },
      {
        key: 'open', label: 'Open Conversations', value: openRow.open_convos, unit: '',
        delta: null, sub: 'awaiting reply',
        tooltip: 'Conversations whose latest inbound message is newer than the last time anyone read the thread.',
      },
      {
        key: 'sent', label: 'Messages Sent', value: msgRow.sent, unit: '',
        delta: pct(msgRow.sent, msgRow.prev_sent), sub: `${msgRow.received} received`,
        tooltip: 'Outbound WhatsApp messages in the period. Change compares vs the previous period.',
      },
      {
        key: 'response', label: 'Response Rate', value: responseRate, unit: '%',
        delta: null, sub: `${respRow.replied_convos}/${respRow.inbound_convos} replied`,
        tooltip: 'Share of inbound conversations that received at least one reply in the period.',
      },
    ];

    // Admin/BDA sections + 6th KPI
    let automations = null, broadcasts = null, leaderboard = null;
    const alerts = [];

    if (admin) {
      const [autoCounts] = (await pool.query(
        `SELECT count(*) FILTER (WHERE status='active')::int AS active,
                count(*)::int AS total
         FROM coexistence.chatbots`
      )).rows;
      const [runRow] = (await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='success')::int AS success,
                count(*) FILTER (WHERE status='error')::int AS error,
                count(*) FILTER (WHERE status='paused')::int AS paused
         FROM coexistence.automation_executions
         WHERE started_at >= NOW() - ($1 * INTERVAL '1 day')`,
        [days]
      )).rows;
      automations = {
        active: autoCounts.active, total: autoCounts.total,
        runs: runRow,
        successRate: runRow.total > 0 ? Math.round((runRow.success / runRow.total) * 100) : null,
      };
      kpis.push({
        key: 'automations', label: 'Active Automations', value: autoCounts.active, unit: '',
        delta: null, sub: `of ${autoCounts.total} total`,
        tooltip: 'Automation flows currently enabled (status = active).',
      });

      // Broadcasts summary + recent
      const [bcSummary] = (await pool.query(
        `SELECT count(*)::int AS campaigns
         FROM coexistence.broadcasts
         WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
        [days]
      )).rows;
      const recent = (await pool.query(
        `SELECT b.id, b.name, b.message_type AS "messageType", b.status,
                b.created_at AS "createdAt",
                count(*) FILTER (WHERE l.action='BROADCAST')::int AS recipients,
                count(*) FILTER (WHERE l.action='BROADCAST' AND l.status='SENT')::int AS sent,
                count(*) FILTER (WHERE l.action='BROADCAST' AND l.status='FAILED')::int AS failed
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.broadcast_logs l ON l.broadcast_id = b.id
         GROUP BY b.id
         ORDER BY b.created_at DESC
         LIMIT 5`
      )).rows;
      broadcasts = { campaigns: bcSummary.campaigns, recent };

      // Team leaderboard (active admins + BDAs)
      leaderboard = (await pool.query(
        `SELECT u.id, u.display_name AS "name", u.role,
                -- People, not rows: one person assigned to a BDA on two
                -- business numbers is one person they own, not two.
                count(DISTINCT c.contact_number)::int AS contacts,
                COALESCE(m.sent, 0)::int AS "messagesSent"
         FROM coexistence.forgecrm_users u
         LEFT JOIN coexistence.contacts c ON c.assigned_user_id = u.id
         LEFT JOIN (
           SELECT sc.assigned_user_id AS uid, count(*) AS sent
           FROM coexistence.chat_history ch
           JOIN coexistence.contacts sc
             ON sc.wa_number = ch.wa_number AND sc.contact_number = ch.contact_number
           WHERE ch.direction='outgoing'
             AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day')
           GROUP BY sc.assigned_user_id
         ) m ON m.uid = u.id
         WHERE u.is_active = TRUE
         GROUP BY u.id, u.display_name, u.role, m.sent
         ORDER BY "messagesSent" DESC, contacts DESC
         LIMIT 10`,
        [days]
      )).rows;

      // Alerts (admin operational health)
      const [tpl] = (await pool.query(
        `SELECT count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
                count(*) FILTER (WHERE status='PAUSED')::int AS paused,
                count(*) FILTER (WHERE status='SUBMITTED')::int AS pending,
                count(*) FILTER (WHERE quality_score='RED')::int AS low_quality
         FROM coexistence.message_templates`
      )).rows;
      if (tpl.rejected > 0) alerts.push({ level: 'warn', label: 'Templates rejected', count: tpl.rejected, page: 'template-builder' });
      if (tpl.paused > 0) alerts.push({ level: 'warn', label: 'Templates paused', count: tpl.paused, page: 'template-builder' });
      if (tpl.low_quality > 0) alerts.push({ level: 'warn', label: 'Low-quality templates', count: tpl.low_quality, page: 'template-builder' });
      if (tpl.pending > 0) alerts.push({ level: 'info', label: 'Templates pending review', count: tpl.pending, page: 'template-builder' });
      if (runRow.error > 0) alerts.push({ level: 'warn', label: 'Failed automation runs', count: runRow.error, page: 'chatbot-builder' });
      const [waba] = (await pool.query(
        `SELECT count(*) FILTER (WHERE NOT is_active)::int AS inactive FROM coexistence.whatsapp_accounts`
      )).rows;
      if (waba.inactive > 0) alerts.push({ level: 'warn', label: 'Inactive WhatsApp accounts', count: waba.inactive, page: 'admin-settings' });
    } else {
      // BDA 6th KPI: their active conversations
      kpis.push({
        key: 'convos', label: 'Active Conversations', value: msgRow.active_convos, unit: '',
        delta: null, sub: `${msgRow.received} received`,
        tooltip: 'Your customer threads with at least one message in the period.',
      });
      if (openRow.open_convos > 0) {
        alerts.push({ level: 'warn', label: 'Conversations awaiting your reply', count: openRow.open_convos, page: 'chats' });
      }
    }

    res.json({
      range,
      scope: admin ? 'admin' : 'bda',
      generatedAt: new Date().toISOString(),
      kpis,
      trend,
      funnel,
      // Where the leads came from — the donut's data. Kept under the old key so
      // the existing chart component binds unchanged; its title now says Sources.
      tagDistribution,
      // Sales-log totals + the latest sales, from services/productSales.
      sales: { ...sales, recent: recentSalesRows },
      automations,
      broadcasts,
      leaderboard,
      alerts,
    });
  } catch (err) {
    console.error('[dashboard] error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── KPI drill-down: the list of items behind a KPI number ──────────────
// GET /api/dashboard/details?metric=<kpi key>&range=7d|30d|90d
// Returns { metric, title, count, items:[{primary, secondary, meta}] },
// role-scoped exactly like the main dashboard. `items` is a uniform shape so
// the frontend modal can render any metric with one list component.
router.get('/dashboard/details', async (req, res) => {
  try {
    const admin = isAdmin(req.user);
    const uid = req.user.id;
    const range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
    const days = RANGE_DAYS[range];
    const metric = String(req.query.metric || '');
    const LIMIT = 300;

    const q = async (sql, params, kind) => {
      const built = applyScope(sql, params, { admin, uid, kind });
      const { rows } = await pool.query(built.sql, built.params);
      return rows;
    };
    // Reusable display-name expression for a contacts alias.
    const nameExpr = (a) => `COALESCE(NULLIF(${a}.name,''), NULLIF(${a}.profile_name,''), ${a}.contact_number)`;

    let title = '';
    let items = [];

    switch (metric) {
      case 'leads': {
        title = 'All leads';
        items = await q(
          `SELECT COALESCE(NULLIF(l.name,''), l.whatsapp_number) AS primary,
                  l.whatsapp_number AS secondary,
                  to_char(l.created_at, 'DD Mon YYYY') AS meta
             FROM coexistence.leads l
            WHERE TRUE /*SCOPE*/
            ORDER BY l.created_at DESC LIMIT ${LIMIT}`,
          [], 'leads'
        );
        break;
      }
      case 'newLeads': {
        title = `New leads · last ${days}d`;
        items = await q(
          `SELECT COALESCE(NULLIF(l.name,''), l.whatsapp_number) AS primary,
                  l.whatsapp_number AS secondary,
                  to_char(l.created_at, 'DD Mon YYYY') AS meta
             FROM coexistence.leads l
            WHERE l.created_at >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
            ORDER BY l.created_at DESC LIMIT ${LIMIT}`,
          [days], 'leads'
        );
        break;
      }
      case 'sales':
      case 'revenue': {
        // Both tiles drill into the same list — the sales themselves — because
        // "which sales made this revenue" is the question either one raises.
        title = metric === 'revenue' ? `Revenue · last ${days}d` : 'Sales';
        try {
          const ps = require('../services/productSales');
          const rows = await ps.recentSales({ limit: LIMIT, uid: admin ? null : uid });
          items = rows.map(r => ({
            primary: r.name || r.whatsappNumber,
            secondary: r.product || r.whatsappNumber,
            meta: `₹${Math.round(r.amountPaise / 100).toLocaleString('en-IN')}`,
          }));
        } catch (e) {
          console.error('[dashboard] sales drill-down failed:', e.message);
        }
        break;
      }
      case 'open': {
        title = 'Open conversations';
        items = await q(
          `WITH last_in AS (
             SELECT ch.wa_number, ch.contact_number, max(ch.timestamp) AS last_in_ts
             FROM coexistence.chat_history ch
             WHERE ch.direction='incoming' /*SCOPE*/
             GROUP BY 1, 2
           )
           SELECT ${nameExpr('c')} AS primary, li.contact_number AS secondary,
                  to_char(li.last_in_ts, 'DD Mon, HH24:MI') AS meta
           FROM last_in li
           LEFT JOIN coexistence.conversation_reads r
             ON r.wa_number = li.wa_number AND r.contact_number = li.contact_number
           LEFT JOIN coexistence.contacts c
             ON c.wa_number = li.wa_number AND c.contact_number = li.contact_number
           WHERE (r.last_read_at IS NULL OR li.last_in_ts > r.last_read_at)
           ORDER BY li.last_in_ts DESC LIMIT ${LIMIT}`,
          [], 'chat'
        );
        break;
      }
      case 'sent': {
        title = `Messages sent · last ${days}d`;
        items = await q(
          `SELECT ${nameExpr('c')} AS primary,
                  LEFT(COALESCE(NULLIF(ch.message_body,''), '[' || ch.message_type || ']'), 64) AS secondary,
                  to_char(ch.timestamp, 'DD Mon, HH24:MI') AS meta
             FROM coexistence.chat_history ch
             LEFT JOIN coexistence.contacts c
               ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
            WHERE ch.direction='outgoing'
              AND ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
            ORDER BY ch.timestamp DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'response': {
        title = `Inbound conversations · last ${days}d`;
        items = await q(
          `WITH conv AS (
             SELECT ch.wa_number, ch.contact_number,
                    bool_or(ch.direction='incoming') AS has_in,
                    bool_or(ch.direction='outgoing') AS has_out,
                    max(ch.timestamp) AS last_ts
             FROM coexistence.chat_history ch
             WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
             GROUP BY 1, 2
           )
           SELECT ${nameExpr('c')} AS primary, conv.contact_number AS secondary,
                  CASE WHEN conv.has_out THEN 'Replied' ELSE 'No reply' END AS meta
           FROM conv
           LEFT JOIN coexistence.contacts c
             ON c.wa_number = conv.wa_number AND c.contact_number = conv.contact_number
           WHERE conv.has_in
           ORDER BY conv.has_out ASC, conv.last_ts DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'convos': {
        title = `Active conversations · last ${days}d`;
        items = await q(
          `SELECT ${nameExpr('c')} AS primary, ch.contact_number AS secondary,
                  to_char(max(ch.timestamp), 'DD Mon, HH24:MI') AS meta
             FROM coexistence.chat_history ch
             LEFT JOIN coexistence.contacts c
               ON c.wa_number = ch.wa_number AND c.contact_number = ch.contact_number
            WHERE ch.timestamp >= NOW() - ($1 * INTERVAL '1 day') /*SCOPE*/
            GROUP BY ch.wa_number, ch.contact_number, c.name, c.profile_name
            ORDER BY max(ch.timestamp) DESC LIMIT ${LIMIT}`,
          [days], 'chat'
        );
        break;
      }
      case 'automations': {
        title = 'Active automations';
        if (admin) {
          items = (await pool.query(
            `SELECT name AS primary, ('trigger: ' || trigger_type) AS secondary, status AS meta
               FROM coexistence.chatbots
              WHERE status='active'
              ORDER BY updated_at DESC LIMIT ${LIMIT}`
          )).rows;
        }
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown metric' });
    }

    res.json({ metric, title, count: items.length, items });
  } catch (err) {
    console.error('[dashboard/details] error:', err.message);
    res.status(500).json({ error: 'Failed to load details' });
  }
});

module.exports = { router };
