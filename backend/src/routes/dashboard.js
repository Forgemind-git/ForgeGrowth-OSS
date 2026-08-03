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

    // Resolve the "Lead Source" category id (case-insensitive). A "lead" is a
    // contact tagged under this category — drives the New Leads + Open
    // Conversations cards.
    const { rows: lsRows } = await pool.query(
      `SELECT id FROM coexistence.categories WHERE LOWER(name) = LOWER($1) ORDER BY created_at LIMIT 1`,
      ['Lead Source']
    );
    const leadSourceCatId = lsRows[0]?.id || null;

    // ── Contacts (totals + new this/prev period), counted per PERSON ──
    //
    // contacts is keyed on (wa_number, contact_number), so someone who has
    // messaged three of our business numbers is three rows. Collapsing to one
    // row per contact_number first makes `total` a count of people.
    //
    // It also fixes what "new" means. Filtering rows on created_at counts a
    // person again the day they happen to message a SECOND business number —
    // they are not a new person, so the range is tested against their earliest
    // appearance anywhere (first_seen), not against each row's own date.
    const [contactRow] = await q(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE p.first_seen >= NOW() - ($1 * INTERVAL '1 day'))::int AS new_in_range,
         count(*) FILTER (WHERE p.first_seen >= NOW() - ($1 * INTERVAL '1 day') * 2
                            AND p.first_seen <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_new
       FROM (
         SELECT c.contact_number, MIN(c.created_at) AS first_seen
           FROM coexistence.contacts c
          WHERE TRUE /*SCOPE*/
          GROUP BY c.contact_number
       ) p`,
      [days], 'contacts'
    );

    // ── New leads: people tagged under "Lead Source", new this/prev ────
    //
    // Same per-person collapse as the contacts totals above, for the same two
    // reasons: one person is several contact rows, and "new" must mean the
    // first time we saw THEM, not the first time we saw each of their rows.
    let leadRow = { new_in_range: 0, prev_new: 0 };
    if (leadSourceCatId) {
      [leadRow] = await q(
        `SELECT
           count(*) FILTER (WHERE p.first_seen >= NOW() - ($1 * INTERVAL '1 day'))::int AS new_in_range,
           count(*) FILTER (WHERE p.first_seen >= NOW() - ($1 * INTERVAL '1 day') * 2
                              AND p.first_seen <  NOW() - ($1 * INTERVAL '1 day'))::int AS prev_new
         FROM (
           SELECT c.contact_number, MIN(c.created_at) AS first_seen
             FROM coexistence.contacts c,
                  jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
            WHERE (t->>'category_id') = $2 /*SCOPE*/
            GROUP BY c.contact_number
         ) p`,
        [days, leadSourceCatId], 'contacts'
      );
    }

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

    // ── Open conversations: unread incoming newer than last read, AND the
    //    contact is tagged under the "Lead Source" category ──────────────
    let openRow = { open_convos: 0 };
    if (leadSourceCatId) {
      [openRow] = await q(
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
         WHERE (r.last_read_at IS NULL OR li.last_in_ts > r.last_read_at)
           AND EXISTS (
             SELECT 1 FROM coexistence.contacts lc,
                  jsonb_array_elements(COALESCE(lc.tags, '[]'::jsonb)) lt
              WHERE lc.wa_number = li.wa_number
                AND lc.contact_number = li.contact_number
                AND (lt->>'category_id') = $1
           )`,
        [leadSourceCatId], 'chat'
      );
    }

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
      // Funnel config unavailable (cache not loaded). Fall back to the tag
      // mirror rather than showing nothing — deduped by PERSON, not by row.
      const stages = await q(
        `SELECT t->>'name' AS name,
                COALESCE(t->>'color', '#dc2626') AS color,
                count(DISTINCT c.contact_number)::int AS count
         FROM coexistence.contacts c,
              jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
         WHERE (t->>'category_id') = 'cat-funnel-stage' /*SCOPE*/
         GROUP BY 1, 2
         ORDER BY count DESC`,
        [], 'contacts'
      );
      funnel = {
        categoryId: 'cat-funnel-stage', categoryName: 'Funnel Stage',
        stages, total: stages.reduce((s, r) => s + r.count, 0), source: 'tags',
      };
    }
    // All categories for a future selector
    const { rows: allCats } = await pool.query(
      `SELECT id, name FROM coexistence.categories ORDER BY name`
    );
    funnel.categories = allCats;

    // ── Tag distribution (top 8 across visible contacts) ──────────────
    //
    // DISTINCT contact_number, not DISTINCT id: the same person can hold a row
    // per business number they have messaged, and counting rows counted them
    // once per number. The chart answers "how many PEOPLE carry this tag".
    const tagDistribution = await q(
      `SELECT t->>'name' AS name,
              COALESCE(t->>'color', '#dc2626') AS color,
              count(DISTINCT c.contact_number)::int AS count
       FROM coexistence.contacts c,
            jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
       WHERE TRUE /*SCOPE*/
       GROUP BY 1, 2
       ORDER BY count DESC
       LIMIT 8`,
      [], 'contacts'
    );

    // ── Build KPI tiles (5 common + 1 role-specific) ──────────────────
    const responseRate = respRow.inbound_convos > 0
      ? Math.round((respRow.replied_convos / respRow.inbound_convos) * 100)
      : 0;

    const kpis = [
      {
        key: 'contacts', label: 'Total Contacts', value: contactRow.total, unit: '',
        delta: pct(contactRow.new_in_range, contactRow.prev_new),
        sub: `+${contactRow.new_in_range} new`,
        tooltip: admin
          ? 'All contacts captured. Change compares new contacts this period vs the previous one.'
          : 'Contacts assigned to you. Change compares new ones this period vs the previous one.',
      },
      {
        key: 'newLeads', label: 'New Leads', value: leadRow.new_in_range, unit: '',
        delta: pct(leadRow.new_in_range, leadRow.prev_new), sub: `in last ${days}d`,
        tooltip: 'New contacts tagged under the “Lead Source” category in the selected period.',
      },
      {
        key: 'open', label: 'Open Conversations', value: openRow.open_convos, unit: '',
        delta: null, sub: 'awaiting reply',
        tooltip: 'Conversations awaiting a reply where the contact is tagged under the “Lead Source” category.',
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
         WHERE u.is_active = TRUE AND u.role IN ('admin','bda_sales')
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
      tagDistribution,
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
    const leadCat = async () => {
      const { rows } = await pool.query(
        `SELECT id FROM coexistence.categories WHERE LOWER(name) = LOWER('Lead Source') ORDER BY created_at LIMIT 1`
      );
      return rows[0]?.id || null;
    };
    // Reusable display-name expression for a contacts alias.
    const nameExpr = (a) => `COALESCE(NULLIF(${a}.name,''), NULLIF(${a}.profile_name,''), ${a}.contact_number)`;

    let title = '';
    let items = [];

    switch (metric) {
      case 'contacts': {
        // One row per PERSON, matching the KPI it drills into — otherwise the
        // tile says 328 and the list behind it shows the same person three
        // times. DISTINCT ON keeps their earliest row, so the date shown is
        // when we first saw them (the same first_seen the tile counts on).
        title = 'All contacts';
        items = await q(
          `SELECT p.primary, p.secondary, to_char(p.first_seen, 'DD Mon YYYY') AS meta
             FROM (
               SELECT DISTINCT ON (c.contact_number)
                      ${nameExpr('c')} AS primary, c.contact_number AS secondary,
                      c.created_at AS first_seen
                 FROM coexistence.contacts c
                WHERE TRUE /*SCOPE*/
                ORDER BY c.contact_number, c.created_at ASC
             ) p
            ORDER BY p.first_seen DESC LIMIT ${LIMIT}`,
          [], 'contacts'
        );
        break;
      }
      case 'newLeads': {
        // Same per-person collapse as the tile: the range is tested against
        // the person's first appearance, so someone who already existed and
        // merely messaged another business number is not listed as new.
        title = `New leads · last ${days}d`;
        const cat = await leadCat();
        if (cat) items = await q(
          `SELECT p.primary, p.secondary, to_char(p.first_seen, 'DD Mon YYYY') AS meta
             FROM (
               SELECT DISTINCT ON (c.contact_number)
                      ${nameExpr('c')} AS primary, c.contact_number AS secondary,
                      MIN(c.created_at) OVER (PARTITION BY c.contact_number) AS first_seen
                 FROM coexistence.contacts c
                WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.tags,'[]'::jsonb)) t
                               WHERE (t->>'category_id') = $1)
                  /*SCOPE*/
                ORDER BY c.contact_number, c.created_at ASC
             ) p
            WHERE p.first_seen >= NOW() - ($2 * INTERVAL '1 day')
            ORDER BY p.first_seen DESC LIMIT ${LIMIT}`,
          [cat, days], 'contacts'
        );
        break;
      }
      case 'open': {
        title = 'Open conversations · Lead Source';
        const cat = await leadCat();
        if (cat) items = await q(
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
             AND EXISTS (SELECT 1 FROM coexistence.contacts lc, jsonb_array_elements(COALESCE(lc.tags,'[]'::jsonb)) lt
                          WHERE lc.wa_number = li.wa_number AND lc.contact_number = li.contact_number
                            AND (lt->>'category_id') = $1)
           ORDER BY li.last_in_ts DESC LIMIT ${LIMIT}`,
          [cat], 'chat'
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
