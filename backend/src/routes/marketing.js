// Marketing — acquisition-side views over the leads model + campaigns/webinars.
// Mounted under /api with authMiddleware in index.js.
//
//   GET    /marketing/overview            top-of-funnel KPIs + charts
//   GET/POST/PUT/DELETE /campaigns        ad campaigns (Meta-synced + manual)
//   GET    /campaigns/:id
//   GET    /campaigns/:id/ads             Campaign → Ad Set → Ad drill-in
//   GET/POST/PUT/DELETE /webinars         batch schedule (data model only — the
//                                         Webinars tab was removed from the UI)
//   GET/POST/PUT/DELETE /webinar-registrations

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const { encrypt, decrypt } = require('../util/crypto');
const metaAds = require('../integrations/metaAdsClient');

const router = Router();

function num(v) { return v == null ? 0 : Number(v); }

// How far back the routine 6h sync refreshes per-day spend. Recent days are the
// ones that still move (Meta restates spend for a couple of days), and anything
// older is already stored — so a rolling window keeps the call small.
const DAILY_STATS_WINDOW_DAYS = parseInt(process.env.META_DAILY_STATS_WINDOW_DAYS || '', 10) || 45;

async function upsertDailyStat(d) {
  await pool.query(
    `INSERT INTO coexistence.ad_daily_stats
       (ad_external_id, adset_external_id, campaign_external_id, stat_date, spend, impressions, clicks, leads, account_id, last_synced_at)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (ad_external_id, stat_date) DO UPDATE SET
       adset_external_id=EXCLUDED.adset_external_id, campaign_external_id=EXCLUDED.campaign_external_id,
       spend=EXCLUDED.spend, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
       leads=EXCLUDED.leads, account_id=EXCLUDED.account_id, last_synced_at=NOW(), updated_at=NOW()`,
    [d.adExternalId, d.adsetExternalId, d.campaignExternalId, d.statDate,
     d.spend, d.impressions, d.clicks, d.leads, d.accountId]
  );
}

// Mirrors migration 074 so a fresh deploy self-heals without a manual psql run.
async function ensureAdSetTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.campaign_adsets (
      id                   BIGSERIAL PRIMARY KEY,
      adset_external_id    TEXT NOT NULL,
      campaign_external_id TEXT NOT NULL,
      name                 TEXT,
      status               TEXT,
      effective_status     TEXT,
      optimization_goal    TEXT,
      billing_event        TEXT,
      daily_budget         NUMERIC(14,2),
      lifetime_budget      NUMERIC(14,2),
      spend                NUMERIC(14,2) NOT NULL DEFAULT 0,
      leads                INT    NOT NULL DEFAULT 0,
      impressions          BIGINT NOT NULL DEFAULT 0,
      clicks               BIGINT NOT NULL DEFAULT 0,
      reach                BIGINT NOT NULL DEFAULT 0,
      start_date           DATE,
      end_date             DATE,
      account_id           TEXT,
      last_synced_at       TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_adsets_adset ON coexistence.campaign_adsets(adset_external_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_adsets_campaign ON coexistence.campaign_adsets(campaign_external_id)`);
  await pool.query(`ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS adset_external_id TEXT`);
  await pool.query(`ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS adset_name TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_ads_adset ON coexistence.campaign_ads(adset_external_id) WHERE adset_external_id IS NOT NULL`);
  // Migration 086 — full-resolution creatives. creative_thumbnail_url is Meta's
  // 64x64 and has no larger form, so a usable image needs its own columns.
  await pool.query(`ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_image_url TEXT`);
  await pool.query(`ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_watch_url TEXT`);
  await pool.query(`ALTER TABLE coexistence.campaign_ads ADD COLUMN IF NOT EXISTS creative_video_id TEXT`);
}

// ── overview ──────────────────────────────────────────────────────────────────
router.get('/marketing/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const src = req.query.source || null;
    const srcClause = src ? `AND source = $2` : '';
    const p = src ? [days, src] : [days];

    const { rows: kpi } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' days')::interval)::int AS new_leads,
         COUNT(*) FILTER (WHERE stage = 'enrolled' AND stage_changed_at >= NOW() - ($1 || ' days')::interval)::int AS enrollments
       FROM coexistence.leads WHERE 1=1 ${srcClause}`,
      p
    );
    const { rows: campKpi } = await pool.query(
      `SELECT COALESCE(SUM(spend),0)::numeric AS active_spend,
              COALESCE(SUM(leads_generated),0)::int AS gen
         FROM coexistence.campaigns WHERE status = 'active'`
    );
    const newLeads = num(kpi[0]?.new_leads);
    const activeSpend = num(campKpi[0]?.active_spend);
    const totalGen = num(campKpi[0]?.gen);

    // Leads by source (donut).
    const { rows: bySource } = await pool.query(
      `SELECT COALESCE(source,'Unknown') AS source, COUNT(*)::int AS count
         FROM coexistence.leads GROUP BY COALESCE(source,'Unknown') ORDER BY count DESC`
    );

    // Funnel snapshot.
    const { rows: byStage } = await pool.query(
      `SELECT stage, COUNT(*)::int AS count FROM coexistence.leads GROUP BY stage`
    );
    const stageCounts = {};
    for (const r of byStage) stageCounts[r.stage] = r.count;
    const funnel = ['new', 'contacted', 'engaged', 'hot', 'enrolled'].map(s => ({
      stage: s, count: stageCounts[s] || 0,
    }));

    // Leads trend (daily buckets).
    const { rows: trend } = await pool.query(
      `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, COUNT(*)::int AS count
         FROM coexistence.leads
        WHERE created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY day ORDER BY day ASC`,
      [days]
    );

    res.json({
      kpis: {
        newLeads,
        costPerLead: totalGen ? activeSpend / totalGen : 0,
        activeSpend,
        enrollments: num(kpi[0]?.enrollments),
      },
      bySource: bySource.map(r => ({ source: r.source, count: r.count })),
      funnel,
      trend: trend.map(r => ({ day: r.day, count: r.count })),
    });
  } catch (err) {
    console.error('[marketing] overview error:', err.message);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// ── campaigns ─────────────────────────────────────────────────────────────────
function campaignRow(r) {
  const spend = num(r.spend);
  const gen = num(r.leads_generated);
  const enr = num(r.enrollments);
  return {
    id: Number(r.id), name: r.name, platform: r.platform, status: r.status,
    spend, leadsGenerated: gen, enrollments: enr,
    costPerLead: gen ? spend / gen : null,
    costPerEnrollment: enr ? spend / enr : null,
    startDate: r.start_date, endDate: r.end_date,
    externalId: r.external_id, source: r.source,
    objective: r.objective, accountId: r.account_id, accountName: r.account_name,
    impressions: r.impressions != null ? Number(r.impressions) : 0,
    clicks: r.clicks != null ? Number(r.clicks) : 0,
    lastSyncedAt: r.last_synced_at || null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/campaigns', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.campaigns ORDER BY start_date DESC NULLS LAST, id DESC`);
    res.json({ campaigns: rows.map(campaignRow) });
  } catch (err) {
    console.error('[marketing] campaigns list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.campaigns WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: campaignRow(rows[0]) });
  } catch (err) {
    console.error('[marketing] campaign get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Campaign name is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.campaigns (name, platform, status, spend, leads_generated, enrollments, start_date, end_date, external_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name.trim(), b.platform || null, b.status || 'active', num(b.spend), num(b.leadsGenerated),
       num(b.enrollments), b.startDate || null, b.endDate || null, b.externalId || null, b.source || 'manual']
    );
    res.status(201).json({ campaign: campaignRow(rows[0]) });
  } catch (err) {
    console.error('[marketing] campaign create error:', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const map = { name: 'name', platform: 'platform', status: 'status', spend: 'spend',
      leadsGenerated: 'leads_generated', enrollments: 'enrollments', startDate: 'start_date',
      endDate: 'end_date', externalId: 'external_id', source: 'source' };
    const fields = []; const vals = []; let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(b[k] === '' ? null : b[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`); vals.push(id);
    const { rows } = await pool.query(`UPDATE coexistence.campaigns SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: campaignRow(rows[0]) });
  } catch (err) {
    console.error('[marketing] campaign update error:', err.message);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.campaigns WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] campaign delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

// ── webinars ──────────────────────────────────────────────────────────────────
function webinarRow(r) {
  const reg = num(r.registrations);
  const att = num(r.attended);
  return {
    id: Number(r.id), batchName: r.batch_name, date: r.date, landingPageUrl: r.landing_page_url,
    registrations: reg, attended: att, noShows: num(r.no_shows),
    attendancePct: reg ? Math.round((att / reg) * 100) : 0,
    hotLeads: num(r.hot_leads),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/webinars', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*,
              (SELECT COUNT(*) FROM coexistence.webinar_registrations wr
                 JOIN coexistence.leads l ON l.id = wr.lead_id
                WHERE wr.webinar_id = w.id AND l.stage IN ('hot','enrolled'))::int AS hot_leads
         FROM coexistence.webinars w ORDER BY w.date DESC NULLS LAST, w.id DESC`
    );
    res.json({ webinars: rows.map(webinarRow) });
  } catch (err) {
    console.error('[marketing] webinars list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch webinars' });
  }
});

router.get('/webinars/:id/funnel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: w } = await pool.query(`SELECT * FROM coexistence.webinars WHERE id = $1`, [id]);
    if (!w.length) return res.status(404).json({ error: 'Webinar not found' });
    const { rows: agg } = await pool.query(
      `SELECT
         COUNT(*)::int AS booked,
         COUNT(*) FILTER (WHERE wr.reminded)::int AS reminded,
         COUNT(*) FILTER (WHERE wr.attended)::int AS attended,
         COUNT(*) FILTER (WHERE l.stage IN ('hot','enrolled'))::int AS hot,
         COUNT(*) FILTER (WHERE l.stage = 'enrolled')::int AS enrolled
       FROM coexistence.webinar_registrations wr
       JOIN coexistence.leads l ON l.id = wr.lead_id
      WHERE wr.webinar_id = $1`,
      [id]
    );
    const a = agg[0] || {};
    res.json({
      webinar: webinarRow({ ...w[0], hot_leads: a.hot }),
      funnel: [
        { step: 'Booked', count: num(a.booked) },
        { step: 'Reminded', count: num(a.reminded) },
        { step: 'Attended', count: num(a.attended) },
        { step: 'Hot', count: num(a.hot) },
        { step: 'Enrolled', count: num(a.enrolled) },
      ],
    });
  } catch (err) {
    console.error('[marketing] webinar funnel error:', err.message);
    res.status(500).json({ error: 'Failed to load funnel' });
  }
});

router.post('/webinars', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.batchName || !b.batchName.trim()) return res.status(400).json({ error: 'Batch name is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.webinars (batch_name, date, landing_page_url, registrations, attended, no_shows)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.batchName.trim(), b.date || null, b.landingPageUrl || null, num(b.registrations), num(b.attended), num(b.noShows)]
    );
    res.status(201).json({ webinar: webinarRow(rows[0]) });
  } catch (err) {
    console.error('[marketing] webinar create error:', err.message);
    res.status(500).json({ error: 'Failed to create webinar' });
  }
});

router.put('/webinars/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const map = { batchName: 'batch_name', date: 'date', landingPageUrl: 'landing_page_url',
      registrations: 'registrations', attended: 'attended', noShows: 'no_shows' };
    const fields = []; const vals = []; let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(b[k] === '' ? null : b[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`); vals.push(id);
    const { rows } = await pool.query(`UPDATE coexistence.webinars SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Webinar not found' });
    res.json({ webinar: webinarRow(rows[0]) });
  } catch (err) {
    console.error('[marketing] webinar update error:', err.message);
    res.status(500).json({ error: 'Failed to update webinar' });
  }
});

router.delete('/webinars/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.webinars WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Webinar not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] webinar delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete webinar' });
  }
});

// ── webinar registrations ─────────────────────────────────────────────────────
router.get('/webinar-registrations', async (req, res) => {
  try {
    const wid = req.query.webinarId ? parseInt(req.query.webinarId, 10) : null;
    const clause = wid ? `WHERE wr.webinar_id = $1` : '';
    const { rows } = await pool.query(
      `SELECT wr.*, l.name AS lead_name, l.whatsapp_number, l.stage
         FROM coexistence.webinar_registrations wr
         JOIN coexistence.leads l ON l.id = wr.lead_id
         ${clause} ORDER BY wr.created_at DESC`,
      wid ? [wid] : []
    );
    res.json({
      registrations: rows.map(r => ({
        id: Number(r.id), leadId: Number(r.lead_id), webinarId: Number(r.webinar_id),
        leadName: r.lead_name, whatsappNumber: r.whatsapp_number, stage: r.stage,
        attended: r.attended, attendanceFormSubmitted: r.attendance_form_submitted, reminded: r.reminded,
      })),
    });
  } catch (err) {
    console.error('[marketing] registrations list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

router.post('/webinar-registrations', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.leadId || !b.webinarId) return res.status(400).json({ error: 'leadId and webinarId are required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.webinar_registrations (lead_id, webinar_id, attended, attendance_form_submitted, reminded)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lead_id, webinar_id) DO UPDATE SET
         attended = EXCLUDED.attended, attendance_form_submitted = EXCLUDED.attendance_form_submitted,
         reminded = EXCLUDED.reminded, updated_at = NOW()
       RETURNING *`,
      [parseInt(b.leadId, 10), parseInt(b.webinarId, 10), !!b.attended, !!b.attendanceFormSubmitted, !!b.reminded]
    );
    res.status(201).json({ registration: { id: Number(rows[0].id) } });
  } catch (err) {
    console.error('[marketing] registration create error:', err.message);
    res.status(500).json({ error: 'Failed to save registration' });
  }
});

router.put('/webinar-registrations/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const map = { attended: 'attended', attendanceFormSubmitted: 'attendance_form_submitted', reminded: 'reminded' };
    const fields = []; const vals = []; let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(!!b[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`); vals.push(id);
    const { rowCount } = await pool.query(`UPDATE coexistence.webinar_registrations SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Registration not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] registration update error:', err.message);
    res.status(500).json({ error: 'Failed to update registration' });
  }
});

router.delete('/webinar-registrations/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.webinar_registrations WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Registration not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] registration delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// ── Meta Ads (Marketing API) connection ────────────────────────────────────────
// Singleton config in coexistence.meta_ads_config. Token stored AES-encrypted.
// Sync pulls real campaigns/spend into coexistence.campaigns (source='meta').

async function loadMetaConfig() {
  const { rows } = await pool.query(`SELECT * FROM coexistence.meta_ads_config WHERE id = 1`);
  return rows[0] || null;
}

// Public-safe view of the connection (never leaks the token).
function metaConfigShape(cfg) {
  if (!cfg) return { status: 'disconnected' };
  return {
    status: cfg.status,
    appId: cfg.app_id,
    tokenType: cfg.token_type,
    tokenMeta: cfg.token_meta || {},
    adAccountIds: cfg.ad_account_ids || [],
    lastError: cfg.last_error,
    lastSyncedAt: cfg.last_synced_at,
    connected: cfg.status === 'connected',
  };
}

// Pull every chosen ad account and UPSERT its campaigns. Returns a summary.
// Shared by the "Sync now" route and the periodic background sync.
async function syncMetaAds() {
  const cfg = await loadMetaConfig();
  if (!cfg || cfg.status === 'disconnected' || !cfg.access_token_encrypted) {
    throw Object.assign(new Error('Meta Ads is not connected'), { status: 400 });
  }
  const token = decrypt(cfg.access_token_encrypted);
  if (!token) throw Object.assign(new Error('Stored Meta token could not be read'), { status: 400 });
  const accountIds = cfg.ad_account_ids || [];
  if (!accountIds.length) throw Object.assign(new Error('No ad accounts selected'), { status: 400 });

  // Resolve account names once for display.
  let accountNames = {};
  try {
    const accts = await metaAds.listAdAccounts(token);
    accountNames = Object.fromEntries(accts.map(a => [a.id, a.name]));
  } catch { /* names are cosmetic */ }

  let upserted = 0, adsUpserted = 0, adsetsUpserted = 0, dailyUpserted = 0;
  for (const acctId of accountIds) {
    const rows = await metaAds.fetchAccountCampaigns(token, acctId, accountNames[acctId]);
    for (const c of rows) {
      await pool.query(
        `INSERT INTO coexistence.campaigns
           (name, platform, status, spend, leads_generated, start_date, end_date,
            external_id, source, objective, account_id, account_name, impressions, clicks, last_synced_at)
         VALUES ($1,'Meta Ads',$2,$3,$4,$5,$6,$7,'meta',$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           name=EXCLUDED.name, platform='Meta Ads', status=EXCLUDED.status, spend=EXCLUDED.spend,
           leads_generated=EXCLUDED.leads_generated, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
           objective=EXCLUDED.objective, account_id=EXCLUDED.account_id, account_name=EXCLUDED.account_name,
           impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, last_synced_at=NOW(), updated_at=NOW()`,
        [c.name, c.status, c.spend, c.leadsGenerated, c.startDate, c.endDate,
         c.externalId, c.objective, c.accountId, c.accountName, c.impressions, c.clicks]
      );
      upserted++;
    }
    // Ad sets — the middle tier. Fetched before the ads so the drill-in has a
    // bucket for every ad. A failure here must not lose the ads: they carry
    // their own adset_id/name, so the tree still builds from the ad rows alone.
    try {
      const adsets = await metaAds.fetchAccountAdSets(token, acctId);
      for (const s of adsets) {
        await pool.query(
          `INSERT INTO coexistence.campaign_adsets
             (adset_external_id, campaign_external_id, name, status, effective_status, optimization_goal,
              billing_event, daily_budget, lifetime_budget, spend, leads, impressions, clicks, reach,
              start_date, end_date, account_id, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (adset_external_id) DO UPDATE SET
             campaign_external_id=EXCLUDED.campaign_external_id, name=EXCLUDED.name, status=EXCLUDED.status,
             effective_status=EXCLUDED.effective_status, optimization_goal=EXCLUDED.optimization_goal,
             billing_event=EXCLUDED.billing_event, daily_budget=EXCLUDED.daily_budget,
             lifetime_budget=EXCLUDED.lifetime_budget, spend=EXCLUDED.spend, leads=EXCLUDED.leads,
             impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, reach=EXCLUDED.reach,
             start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, account_id=EXCLUDED.account_id,
             last_synced_at=NOW(), updated_at=NOW()`,
          [s.adsetExternalId, s.campaignExternalId, s.name, s.status, s.effectiveStatus, s.optimizationGoal,
           s.billingEvent, s.dailyBudget, s.lifetimeBudget, s.spend, s.leads, s.impressions, s.clicks, s.reach,
           s.startDate, s.endDate, s.accountId]
        );
        adsetsUpserted++;
      }
    } catch (e) {
      console.warn(`[meta-ads] ad sets ${acctId}: ${e.message}`);
    }

    // Per-day spend. Kept on a rolling window rather than refetched in full:
    // the daily grain only matters for recent comparisons, and re-pulling years
    // of history every 6h would be a large, pointless Meta bill. A one-off
    // backfill (POST /marketing/meta-ads/backfill-daily) covers older ground.
    try {
      const since = new Date(Date.now() - DAILY_STATS_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
      const daily = await metaAds.fetchAccountAdDailyStats(token, acctId, since);
      for (const d of daily) {
        if (!d.statDate) continue;
        await upsertDailyStat(d);
        dailyUpserted++;
      }
    } catch (e) {
      console.warn(`[meta-ads] daily stats ${acctId}: ${e.message}`);
    }

    // Ads + creatives for the drill-in.
    const ads = await metaAds.fetchAccountAds(token, acctId);
    for (const a of ads) {
      await pool.query(
        `INSERT INTO coexistence.campaign_ads
           (ad_external_id, campaign_external_id, adset_external_id, adset_name, name, status, spend, leads, impressions, clicks,
            creative_thumbnail_url, creative_title, creative_body, object_type, ig_media_id, ig_permalink, story_id, account_id,
            creative_image_url, creative_watch_url, creative_video_id, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
         ON CONFLICT (ad_external_id) DO UPDATE SET
           campaign_external_id=EXCLUDED.campaign_external_id, adset_external_id=EXCLUDED.adset_external_id,
           adset_name=EXCLUDED.adset_name, name=EXCLUDED.name, status=EXCLUDED.status,
           spend=EXCLUDED.spend, leads=EXCLUDED.leads, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
           creative_thumbnail_url=EXCLUDED.creative_thumbnail_url, creative_title=EXCLUDED.creative_title,
           creative_body=EXCLUDED.creative_body, object_type=EXCLUDED.object_type, ig_media_id=EXCLUDED.ig_media_id,
           ig_permalink=EXCLUDED.ig_permalink, story_id=EXCLUDED.story_id, account_id=EXCLUDED.account_id,
           -- COALESCE, not overwrite: a video-thumbnail lookup that failed this
           -- tick returns null, and replacing a good stored image with null
           -- would make the drill-in lose its creative on a transient Meta blip.
           creative_image_url=COALESCE(EXCLUDED.creative_image_url, coexistence.campaign_ads.creative_image_url),
           creative_watch_url=COALESCE(EXCLUDED.creative_watch_url, coexistence.campaign_ads.creative_watch_url),
           creative_video_id=COALESCE(EXCLUDED.creative_video_id, coexistence.campaign_ads.creative_video_id),
           last_synced_at=NOW(), updated_at=NOW()`,
        [a.adExternalId, a.campaignExternalId, a.adsetExternalId, a.adsetName, a.name, a.status, a.spend, a.leads, a.impressions, a.clicks,
         a.thumbnailUrl, a.title, a.body, a.objectType, a.igMediaId, a.igPermalink, a.storyId, a.accountId,
         a.imageUrl, a.watchUrl, a.videoId]
      );
      adsUpserted++;
    }
  }
  await pool.query(
    `UPDATE coexistence.meta_ads_config SET status='connected', last_error=NULL, last_synced_at=NOW(), updated_at=NOW() WHERE id=1`
  );
  return { accounts: accountIds.length, campaigns: upserted, adsets: adsetsUpserted, ads: adsUpserted, dailyRows: dailyUpserted };
}

// GET one campaign's ads, arranged the way Meta actually structures them:
// Campaign → Ad Set → Ad. Ad sets come from their own synced rows (Meta's own
// ad-set-level spend), and every ad hangs off its parent. Ads whose ad set has
// not been synced yet land in an explicit "Ungrouped" bucket rather than
// vanishing — a missing parent must never hide a real ad.
router.get('/campaigns/:id/ads', async (req, res) => {
  try {
    const { rows: crow } = await pool.query(`SELECT external_id FROM coexistence.campaigns WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!crow.length) return res.status(404).json({ error: 'Campaign not found' });
    const externalId = crow[0].external_id;
    if (!externalId) return res.json({ ads: [], adsets: [] }); // manual campaign — no Meta ads

    const [adQ, setQ] = await Promise.all([
      pool.query(
        `SELECT * FROM coexistence.campaign_ads
          WHERE campaign_external_id = $1
          ORDER BY spend DESC NULLS LAST`, [externalId]),
      pool.query(
        `SELECT * FROM coexistence.campaign_adsets
          WHERE campaign_external_id = $1
          ORDER BY spend DESC NULLS LAST`, [externalId]),
    ]);

    const ads = adQ.rows.map(adRow);
    const byId = new Map();
    for (const s of setQ.rows) byId.set(s.adset_external_id, { ...adsetRow(s), ads: [] });

    const ungrouped = [];
    for (const a of ads) {
      const bucket = a.adsetExternalId && byId.get(a.adsetExternalId);
      if (bucket) bucket.ads.push(a);
      else if (a.adsetExternalId) {
        // Known ad set id, but its row hasn't synced — build a stub from the name
        // the ad itself carries so the grouping is still correct.
        const stub = {
          adsetExternalId: a.adsetExternalId, name: a.adsetName || 'Ad set', status: null,
          optimizationGoal: null, dailyBudget: null, lifetimeBudget: null,
          spend: null, leads: null, impressions: null, clicks: null, reach: null,
          startDate: null, endDate: null, synced: false, ads: [a],
        };
        byId.set(a.adsetExternalId, stub);
      } else ungrouped.push(a);
    }

    const adsets = [...byId.values()]
      .filter(s => s.ads.length > 0)
      .sort((a, b) => (b.spend ?? sumBy(b.ads, 'spend')) - (a.spend ?? sumBy(a.ads, 'spend')));

    if (ungrouped.length) {
      adsets.push({
        adsetExternalId: null, name: 'Ungrouped', status: null, optimizationGoal: null,
        dailyBudget: null, lifetimeBudget: null, spend: null, leads: null, impressions: null,
        clicks: null, reach: null, startDate: null, endDate: null, synced: false, ads: ungrouped,
      });
    }

    // `ads` stays flat alongside the tree so any caller that just wants the list
    // (and the MCP) keeps working unchanged.
    res.json({ ads, adsets });
  } catch (err) {
    console.error('[marketing] campaign ads error:', err.message);
    res.status(500).json({ error: 'Failed to load campaign ads' });
  }
});

function sumBy(rows, key) { return rows.reduce((n, r) => n + num(r[key]), 0); }

function adsetRow(r) {
  return {
    id: Number(r.id), adsetExternalId: r.adset_external_id, name: r.name, status: r.status,
    effectiveStatus: r.effective_status, optimizationGoal: r.optimization_goal, billingEvent: r.billing_event,
    dailyBudget: r.daily_budget != null ? Number(r.daily_budget) : null,
    lifetimeBudget: r.lifetime_budget != null ? Number(r.lifetime_budget) : null,
    spend: num(r.spend), leads: num(r.leads), impressions: num(r.impressions),
    clicks: num(r.clicks), reach: num(r.reach),
    costPerLead: num(r.leads) ? num(r.spend) / num(r.leads) : null,
    startDate: r.start_date, endDate: r.end_date, lastSyncedAt: r.last_synced_at, synced: true,
  };
}

function adRow(r) {
  return {
    id: Number(r.id), adExternalId: r.ad_external_id, name: r.name, status: r.status,
    adsetExternalId: r.adset_external_id || null, adsetName: r.adset_name || null,
    spend: num(r.spend), leads: num(r.leads), impressions: num(r.impressions), clicks: num(r.clicks),
    costPerLead: num(r.leads) ? num(r.spend) / num(r.leads) : null,
    thumbnailUrl: r.creative_thumbnail_url, title: r.creative_title, body: r.creative_body,
    objectType: r.object_type, igMediaId: r.ig_media_id, igPermalink: r.ig_permalink,
  };
}

// GET connection status (+ live list of reachable accounts when connected).
router.get('/marketing/meta-ads/status', adminOnly, async (req, res) => {
  try {
    const cfg = await loadMetaConfig();
    const shape = metaConfigShape(cfg);
    if (cfg && cfg.access_token_encrypted && cfg.status !== 'disconnected') {
      const token = decrypt(cfg.access_token_encrypted);
      if (token) {
        try { shape.availableAccounts = await metaAds.listAdAccounts(token); }
        catch (e) { shape.availableAccounts = []; shape.lastError = e.message; }
      }
    }
    res.json(shape);
  } catch (err) {
    console.error('[meta-ads] status error:', err.message);
    res.status(500).json({ error: 'Failed to load Meta Ads status' });
  }
});

// POST connect — validate a token, store it encrypted, record chosen accounts.
router.post('/marketing/meta-ads/connect', adminOnly, async (req, res) => {
  try {
    const { token, adAccountIds } = req.body || {};
    if (!token || !String(token).trim()) return res.status(400).json({ error: 'Access token is required' });
    let info;
    try { info = await metaAds.inspectToken(String(token).trim()); }
    catch (e) { return res.status(400).json({ error: `Token check failed: ${e.message}` }); }
    if (!info.hasAds) {
      return res.status(400).json({ error: 'This token is missing ads_read / ads_management permission. Regenerate it with the ads scope.' });
    }
    const accounts = await metaAds.listAdAccounts(String(token).trim());
    // Default to every reachable account if the caller didn't pick specific ones.
    const chosen = Array.isArray(adAccountIds) && adAccountIds.length
      ? adAccountIds.filter(id => accounts.some(a => a.id === id))
      : accounts.map(a => a.id);
    await pool.query(
      `UPDATE coexistence.meta_ads_config SET
         access_token_encrypted=$1, app_id=$2, token_type=$3, token_meta=$4::jsonb,
         ad_account_ids=$5::jsonb, status='connected', last_error=NULL, connected_by=$6, updated_at=NOW()
       WHERE id=1`,
      [encrypt(String(token).trim()), info.appId, info.type,
       JSON.stringify({ scopes: info.scopes, appName: info.appName, expiresAt: info.expiresAt, dataAccessExpiresAt: info.dataAccessExpiresAt }),
       JSON.stringify(chosen), req.user?.id || null]
    );
    res.json({ ok: true, appId: info.appId, tokenType: info.type, availableAccounts: accounts, adAccountIds: chosen });
  } catch (err) {
    console.error('[meta-ads] connect error:', err.message);
    res.status(500).json({ error: 'Failed to connect Meta Ads' });
  }
});

// PUT which ad accounts to sync (without re-entering the token).
router.put('/marketing/meta-ads/accounts', adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.adAccountIds) ? req.body.adAccountIds : [];
    await pool.query(`UPDATE coexistence.meta_ads_config SET ad_account_ids=$1::jsonb, updated_at=NOW() WHERE id=1`, [JSON.stringify(ids)]);
    res.json({ ok: true, adAccountIds: ids });
  } catch (err) {
    console.error('[meta-ads] accounts error:', err.message);
    res.status(500).json({ error: 'Failed to update ad accounts' });
  }
});

// POST run a sync now.
router.post('/marketing/meta-ads/sync', adminOnly, async (req, res) => {
  try {
    const summary = await syncMetaAds();
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err.status === 400) {
      await pool.query(`UPDATE coexistence.meta_ads_config SET status='error', last_error=$1, updated_at=NOW() WHERE id=1`, [err.message]).catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    console.error('[meta-ads] sync error:', err.message);
    await pool.query(`UPDATE coexistence.meta_ads_config SET status='error', last_error=$1, updated_at=NOW() WHERE id=1`, [err.message]).catch(() => {});
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// POST backfill per-day spend further back than the rolling sync window. Needed
// once, so a before/after comparison has a "before" with real cost in it. Walked
// in 90-day chunks because Meta rejects an over-long time_range at daily grain.
router.post('/marketing/meta-ads/backfill-daily', adminOnly, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(730, parseInt(req.body?.days, 10) || 180));
    const cfg = await loadMetaConfig();
    if (!cfg || cfg.status === 'disconnected' || !cfg.access_token_encrypted) {
      return res.status(400).json({ error: 'Meta Ads is not connected' });
    }
    const token = decrypt(cfg.access_token_encrypted);
    if (!token) return res.status(400).json({ error: 'Stored Meta token could not be read' });
    const accountIds = Array.isArray(cfg.ad_account_ids) ? cfg.ad_account_ids : [];
    if (!accountIds.length) return res.status(400).json({ error: 'No ad accounts selected' });

    let rows = 0;
    const CHUNK = 90;
    for (const acctId of accountIds) {
      for (let offset = 0; offset < days; offset += CHUNK) {
        const until = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
        const since = new Date(Date.now() - Math.min(days, offset + CHUNK) * 86400000).toISOString().slice(0, 10);
        try {
          const daily = await metaAds.fetchAccountAdDailyStats(token, acctId, since, until);
          for (const d of daily) {
            if (!d.statDate) continue;
            await upsertDailyStat(d);
            rows++;
          }
        } catch (e) {
          console.warn(`[meta-ads] backfill ${acctId} ${since}..${until}: ${e.message}`);
        }
      }
    }
    const { rows: cover } = await pool.query(
      `SELECT COUNT(*)::int AS n, MIN(stat_date) AS first_day, MAX(stat_date) AS last_day
         FROM coexistence.ad_daily_stats`);
    res.json({ ok: true, rows, coverage: cover[0] });
  } catch (err) {
    console.error('[meta-ads] backfill-daily error:', err.message);
    res.status(500).json({ error: `Backfill failed: ${err.message}` });
  }
});

// POST disconnect — clears the token + Meta-sourced campaigns (keeps manual rows).
router.post('/marketing/meta-ads/disconnect', adminOnly, async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.campaigns WHERE source = 'meta'`);
    await pool.query(
      `UPDATE coexistence.meta_ads_config SET access_token_encrypted=NULL, app_id=NULL, token_type=NULL,
         token_meta='{}'::jsonb, ad_account_ids='[]'::jsonb, status='disconnected', last_error=NULL,
         last_synced_at=NULL, updated_at=NOW() WHERE id=1`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[meta-ads] disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect Meta Ads' });
  }
});

// Single export, at the very bottom — keep it that way. A second module.exports
// mid-file once silently won and dropped an export the boot timer depended on,
// which threw on every tick until it was noticed.
module.exports = { router, syncMetaAds, ensureAdSetTables };
