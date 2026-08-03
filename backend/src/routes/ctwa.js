// Click-to-WhatsApp attribution.
//
// READ /ctwa/* — Click-to-WhatsApp tab. Every CTWA ad's real performance, built
// from the `referral` object the webhook already receives (no extra Meta call),
// joined to campaign_ads for spend and to leads for what actually happened next.
//
// The join key is Meta's CTWA click id (`ctwa_clid`), captured off the inbound
// message by recordCtwaReferral() and bound to a lead by linkReferralsToLead().
// Because the click id arrives on the message itself, ad → conversation → lead →
// stage → revenue all resolve locally with no further calls to Meta.

const { Router } = require('express');
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const cfg = require('../services/funnelConfig');
const { RZP_CAPTURED } = require('./leads');

const router = Router();

// Page key the sidebar/permissions model already knows about. Enforced
// server-side too — the CTWA views return lead names, numbers and amounts paid,
// and every other lead surface gates on its page key.
const CTWA_PAGE = 'ctwa-ads';

const paise2r = (p) => Math.round(Number(p || 0)) / 100;

// ── self-healing schema (mirrors supabase/migrations/073_ctwa_referrals.sql) ───────
async function ensureCtwaTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.ctwa_referrals (
      id BIGSERIAL PRIMARY KEY,
      ctwa_clid TEXT,
      contact_number TEXT NOT NULL,
      lead_id BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      wa_number TEXT, phone_number_id TEXT, waba_id TEXT, message_id TEXT,
      source_id TEXT, source_type TEXT, source_url TEXT, platform TEXT,
      headline TEXT, body TEXT, media_type TEXT,
      image_url TEXT, video_url TEXT, thumbnail_url TEXT, welcome_message TEXT,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ctwa_referrals_clid ON coexistence.ctwa_referrals (ctwa_clid) WHERE ctwa_clid IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ctwa_referrals_msg ON coexistence.ctwa_referrals (message_id) WHERE message_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_contact ON coexistence.ctwa_referrals (contact_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_lead ON coexistence.ctwa_referrals (lead_id) WHERE lead_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_source ON coexistence.ctwa_referrals (source_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ctwa_referrals_clicked ON coexistence.ctwa_referrals (clicked_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.ad_daily_stats (
      id                   BIGSERIAL PRIMARY KEY,
      ad_external_id       TEXT NOT NULL,
      adset_external_id    TEXT,
      campaign_external_id TEXT,
      stat_date            DATE NOT NULL,
      spend                NUMERIC(14,2) NOT NULL DEFAULT 0,
      impressions          BIGINT NOT NULL DEFAULT 0,
      clicks               BIGINT NOT NULL DEFAULT 0,
      leads                INT    NOT NULL DEFAULT 0,
      account_id           TEXT,
      last_synced_at       TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_daily_stats ON coexistence.ad_daily_stats(ad_external_id, stat_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_date ON coexistence.ad_daily_stats(stat_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_campaign ON coexistence.ad_daily_stats(campaign_external_id)`);
}

// ── referral capture (called by the webhook, additive + non-blocking) ─────────

// Meta tells us the entry point but not the platform name — derive it from the
// url the person clicked from. wa.me/wamo/status/... = a WhatsApp Status ad.
// The Meta webhook is a public endpoint, so msg.timestamp is caller-controlled.
// clicked_at is the only input to the attribution window, so a future-dated
// value would keep a stale click "fresh" forever. Never trust it past now.
function clampClickTime(ts) {
  const t = ts ? new Date(ts).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date().toISOString();
  return new Date(Math.min(t, Date.now())).toISOString();
}

function derivePlatform(sourceUrl) {
  const u = String(sourceUrl || '').toLowerCase();
  if (!u) return null;
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('facebook.com') || u.includes('fb.me') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('wa.me') || u.includes('whatsapp.com')) return 'WhatsApp';
  return 'Other';
}

// Promote one inbound message's `referral` object to a ctwa_referrals row.
// Idempotent: a bare ON CONFLICT DO NOTHING covers BOTH unique indexes (clid and
// message_id) — a targeted conflict clause could only arbitrate one of them.
// Never throws: attribution must not be able to break message ingestion.
async function recordCtwaReferral(record) {
  try {
    const ref = record && record.referral;
    if (!ref || typeof ref !== 'object') return null;
    if (!record.contact_number) return null;

    // Meta re-attaches the SAME referral to follow-up messages, sometimes with
    // the ctwa_clid key OMITTED. Such a row has a NULL clid (clid index doesn't
    // apply) and a fresh wamid (message_id index doesn't apply), so it inserts
    // as a phantom second "click" and inflates every click count on the tab.
    // A clid-less referral for a contact who already has a referral from the
    // same ad is an ECHO, not a new click — verified against production data
    // (identical source_id, body, creative urls, minutes apart).
    if (!ref.ctwa_clid && ref.source_id) {
      const { rows: echo } = await pool.query(
        `SELECT 1 FROM coexistence.ctwa_referrals
          WHERE contact_number = $1 AND source_id = $2 LIMIT 1`,
        [record.contact_number, String(ref.source_id)]
      );
      if (echo.length) return null;
    }

    const { rows } = await pool.query(
      `INSERT INTO coexistence.ctwa_referrals
         (ctwa_clid, contact_number, lead_id, wa_number, phone_number_id, waba_id, message_id,
          source_id, source_type, source_url, platform,
          headline, body, media_type, image_url, video_url, thumbnail_url, welcome_message,
          clicked_at, raw)
       VALUES ($1,$2,
               (SELECT id FROM coexistence.leads WHERE whatsapp_number = $2 ORDER BY id LIMIT 1),
               $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18::timestamptz, $19::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        ref.ctwa_clid || null, record.contact_number,
        record.wa_number || null, record.phone_number_id || null, record.waba_id || null,
        record.message_id || null,
        ref.source_id || null, ref.source_type || null, ref.source_url || null,
        derivePlatform(ref.source_url),
        ref.headline || null, ref.body || null, ref.media_type || null,
        ref.image_url || null, ref.video_url || null, ref.thumbnail_url || null,
        ref.welcome_message?.text || null,
        // clicked_at drives the attribution window, and the webhook is a public
        // endpoint — never let a caller-supplied timestamp sit in the future.
        clampClickTime(record.timestamp), JSON.stringify(ref),
      ]
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.error('[ctwa] recordCtwaReferral error:', err.message);
    return null;
  }
}

// The lead row is created by ensureLeadForContact a moment after the referral
// lands, so late-bind any referral that arrived first.
async function linkReferralsToLead(contactNumber, leadId) {
  if (!contactNumber || !leadId) return;
  try {
    await pool.query(
      `UPDATE coexistence.ctwa_referrals SET lead_id = $2, updated_at = NOW()
        WHERE contact_number = $1 AND lead_id IS NULL`,
      [contactNumber, leadId]
    );
  } catch (err) {
    console.error('[ctwa] linkReferralsToLead error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Click-to-WhatsApp analytics
// ═══════════════════════════════════════════════════════════════════════════

// Window + facet filter shared by every /ctwa endpoint.
function ctwaFilter(q, startIdx = 1) {
  const where = ['1=1'];
  const params = [];
  let i = startIdx;
  const add = (v) => { params.push(v); return `$${i++}`; };

  const days = parseInt(q.days, 10);
  if (Number.isFinite(days) && days > 0) where.push(`r.clicked_at >= NOW() - (${add(String(days))} || ' days')::interval`);
  if (q.platform) where.push(`r.platform = ${add(q.platform)}`);
  if (q.sourceId) where.push(`r.source_id = ${add(q.sourceId)}`);
  if (q.sourceType) where.push(`r.source_type = ${add(q.sourceType)}`);
  if (q.mediaType) where.push(`r.media_type = ${add(q.mediaType)}`);

  return { where: where.join(' AND '), params, nextIdx: i };
}

// Everything the CTWA tab needs in one round-trip.
router.get('/ctwa/overview', requirePermission(CTWA_PAGE), async (req, res) => {
  try {
    const f = ctwaFilter(req.query || {});
    const won = cfg.wonStageKeys();
    const wonIdx = `$${f.nextIdx}`;
    const params = [...f.params, won.length ? won : ['enrolled']];

    // Deduped-by-payment_id gateway payments UNION manual sales, per lead.
    const PAID = `
      lead_paid AS (
        SELECT lead_id, SUM(amount_paise)::bigint AS paise FROM (
          SELECT lead_id, amount_paise FROM ( ${RZP_CAPTURED('matched_lead_id IS NOT NULL')} ) rz
          UNION ALL
          SELECT lead_id, amount_paise FROM coexistence.sales_log WHERE lead_id IS NOT NULL
        ) p GROUP BY lead_id
      )`;

    const REFS = `refs AS (SELECT r.* FROM coexistence.ctwa_referrals r WHERE ${f.where})`;
    // One row per (ad, lead) so a lead who clicked 3× isn't counted 3×.
    const ADLEAD = `ad_lead AS (SELECT DISTINCT source_id, lead_id FROM refs WHERE lead_id IS NOT NULL)`;

    // The placement TOGGLE must be built from a placement-blind query. Deriving it
    // from the filtered rows collapses the list to the one selected placement, and
    // the control that produced the filter disappears — leaving no way back.
    // Date range still applies, so the toggle offers placements that exist in view.
    const fAll = ctwaFilter({ ...(req.query || {}), platform: '' });

    const [kpiQ, adsQ, platQ, allPlatQ, seriesQ, stageQ, creativeQ] = await Promise.all([
      pool.query(`
        WITH ${REFS}, ${PAID},
        leads_in AS (SELECT DISTINCT lead_id FROM refs WHERE lead_id IS NOT NULL)
        SELECT
          (SELECT COUNT(*) FROM refs)::int                                   AS clicks,
          (SELECT COUNT(DISTINCT contact_number) FROM refs)::int             AS people,
          (SELECT COUNT(DISTINCT ctwa_clid) FROM refs WHERE ctwa_clid IS NOT NULL)::int AS tracked_clicks,
          (SELECT COUNT(*) FROM leads_in)::int                               AS leads,
          (SELECT COUNT(*) FROM leads_in li JOIN coexistence.leads l ON l.id = li.lead_id
             WHERE l.stage = ANY(${wonIdx}::text[]))::int                    AS enrolled,
          (SELECT COALESCE(SUM(lp.paise),0) FROM leads_in li
             JOIN lead_paid lp ON lp.lead_id = li.lead_id)::bigint           AS revenue_paise,
          (SELECT COUNT(DISTINCT source_id) FROM refs WHERE source_id IS NOT NULL)::int AS ads
      `, params),

      pool.query(`
        WITH ${REFS}, ${PAID}, ${ADLEAD},
        stats AS (
          -- One ad can run across several placements/creatives, so pick the
          -- DOMINANT value (mode) rather than an alphabetical MAX — which would
          -- label an Instagram-heavy ad "WhatsApp" just because W > I. The full
          -- placement list rides along in the platforms column so nothing is hidden.
          SELECT source_id,
                 COUNT(*)::int                                AS clicks,
                 COUNT(DISTINCT contact_number)::int          AS people,
                 MIN(clicked_at)                              AS first_click,
                 MAX(clicked_at)                              AS last_click,
                 mode() WITHIN GROUP (ORDER BY platform)      AS platform,
                 string_agg(DISTINCT platform, ', ')          AS platforms,
                 mode() WITHIN GROUP (ORDER BY source_type)   AS source_type,
                 mode() WITHIN GROUP (ORDER BY media_type)    AS media_type,
                 -- newest creative wins for the thumbnail / copy shown in the UI
                 (array_agg(source_url ORDER BY clicked_at DESC) FILTER (WHERE source_url IS NOT NULL))[1]   AS source_url,
                 (array_agg(headline ORDER BY clicked_at DESC) FILTER (WHERE headline IS NOT NULL))[1]       AS headline,
                 (array_agg(body ORDER BY clicked_at DESC) FILTER (WHERE body IS NOT NULL))[1]               AS body,
                 (array_agg(COALESCE(thumbnail_url, image_url) ORDER BY clicked_at DESC)
                    FILTER (WHERE COALESCE(thumbnail_url, image_url) IS NOT NULL))[1]                        AS thumbnail_url,
                 (array_agg(video_url ORDER BY clicked_at DESC) FILTER (WHERE video_url IS NOT NULL))[1]     AS video_url,
                 COUNT(DISTINCT COALESCE(body,'') || '|' || COALESCE(media_type,''))::int AS creative_variants
            FROM refs GROUP BY source_id
        ),
        outcome AS (
          SELECT al.source_id,
                 COUNT(*)::int                                                       AS leads,
                 COUNT(*) FILTER (WHERE l.stage = ANY(${wonIdx}::text[]))::int        AS enrolled,
                 COALESCE(SUM(lp.paise),0)::bigint                                   AS revenue_paise
            FROM ad_lead al
            JOIN coexistence.leads l ON l.id = al.lead_id
            LEFT JOIN lead_paid lp ON lp.lead_id = al.lead_id
           GROUP BY al.source_id
        )
        SELECT s.*, COALESCE(o.leads,0) AS leads, COALESCE(o.enrolled,0) AS enrolled,
               COALESCE(o.revenue_paise,0) AS revenue_paise,
               ca.name AS ad_name, ca.status AS ad_status, ca.spend, ca.impressions,
               ca.clicks AS ad_clicks, ca.leads AS meta_leads,
               ca.creative_thumbnail_url, ca.creative_image_url, ca.creative_watch_url, ca.ig_permalink,
               ca.adset_name, ca.adset_external_id,
               c.name AS campaign_name, c.external_id AS campaign_external_id
          FROM stats s
          LEFT JOIN outcome o ON o.source_id = s.source_id
          LEFT JOIN coexistence.campaign_ads ca ON ca.ad_external_id = s.source_id
          LEFT JOIN coexistence.campaigns c ON c.external_id = ca.campaign_external_id
         ORDER BY s.clicks DESC
      `, params),

      pool.query(`
        WITH ${REFS}, ${PAID}, ad_lead AS (SELECT DISTINCT platform, lead_id FROM refs WHERE lead_id IS NOT NULL)
        SELECT COALESCE(r.platform,'Unknown') AS platform,
               COUNT(*)::int AS clicks,
               COUNT(DISTINCT r.contact_number)::int AS people,
               (SELECT COUNT(*) FROM ad_lead al WHERE COALESCE(al.platform,'Unknown') = COALESCE(r.platform,'Unknown'))::int AS leads,
               (SELECT COUNT(*) FROM ad_lead al JOIN coexistence.leads l ON l.id = al.lead_id
                 WHERE COALESCE(al.platform,'Unknown') = COALESCE(r.platform,'Unknown')
                   AND l.stage = ANY(${wonIdx}::text[]))::int AS enrolled
          FROM refs r GROUP BY r.platform ORDER BY clicks DESC
      `, params),

      pool.query(`
        SELECT COALESCE(r.platform,'Unknown') AS platform, COUNT(*)::int AS clicks
          FROM coexistence.ctwa_referrals r
         WHERE ${fAll.where}
         GROUP BY 1 ORDER BY clicks DESC
      `, fAll.params),

      pool.query(`
        WITH ${REFS}
        SELECT (clicked_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
               COUNT(*)::int AS clicks,
               COUNT(DISTINCT contact_number)::int AS people
          FROM refs GROUP BY 1 ORDER BY 1
      `, f.params),

      pool.query(`
        WITH ${REFS}, ad_lead AS (SELECT DISTINCT lead_id FROM refs WHERE lead_id IS NOT NULL)
        SELECT l.stage, COUNT(*)::int AS count
          FROM ad_lead al JOIN coexistence.leads l ON l.id = al.lead_id
         GROUP BY l.stage
      `, f.params),

      // "Which specific video/image did they see?" — one row per creative
      // variant, since a single ad id can serve several bodies/media.
      pool.query(`
        WITH ${REFS}
        SELECT source_id, media_type, COALESCE(body,'') AS body, MAX(headline) AS headline,
               MAX(COALESCE(thumbnail_url, image_url)) AS thumbnail_url,
               MAX(video_url) AS video_url, MAX(source_url) AS source_url,
               COUNT(*)::int AS clicks,
               COUNT(DISTINCT lead_id)::int AS leads
          FROM refs GROUP BY source_id, media_type, COALESCE(body,'')
         ORDER BY clicks DESC
      `, f.params),
    ]);

    const k = kpiQ.rows[0] || {};
    const ads = adsQ.rows.map(r => ({
      sourceId: r.source_id,
      adName: r.ad_name || null,
      adStatus: r.ad_status || null,
      campaignName: r.campaign_name || null,
      campaignExternalId: r.campaign_external_id || null,
      platform: r.platform,
      platforms: r.platforms,          // every placement this ad actually ran on
      sourceType: r.source_type,
      mediaType: r.media_type,
      sourceUrl: r.source_url,
      headline: r.headline,
      body: r.body,
      // Meta's image URLs are signed and expire in days. The Ads sync refreshes
      // creative_thumbnail_url every 6h, while the referral copy is frozen at the
      // moment of the click — so prefer the synced one and keep the referral
      // image only as a fallback for ads the sync doesn't know about.
      // Both synced URLs come before the referral's copy, which is frozen at
      // click time and so is the one that actually 404s/403s once Meta's signed
      // URL expires. The 64x64 leads because it is ideal for a 40px row thumb.
      thumbnailUrl: r.creative_thumbnail_url || r.creative_image_url || r.thumbnail_url || null,
      // Full-resolution still, for the drill-in (the row thumbnail above is
      // Meta's 64x64 and is fine at 40px but unusable at card size).
      imageUrl: r.creative_image_url || null,
      // Meta withholds the MP4, so the drill-in links out instead of embedding.
      watchUrl: r.creative_watch_url || null,
      videoUrl: r.video_url,
      igPermalink: r.ig_permalink,
      adsetName: r.adset_name || null,
      adsetExternalId: r.adset_external_id || null,
      creativeVariants: r.creative_variants,
      clicks: r.clicks,
      people: r.people,
      leads: r.leads,
      enrolled: r.enrolled,
      revenue: paise2r(r.revenue_paise),
      firstClick: r.first_click,
      lastClick: r.last_click,
      // From the Meta Ads sync — LIFETIME numbers for the ad, not windowed.
      spend: r.spend == null ? null : Number(r.spend),
      impressions: r.impressions == null ? null : Number(r.impressions),
      adClicks: r.ad_clicks == null ? null : Number(r.ad_clicks),
      metaLeads: r.meta_leads == null ? null : Number(r.meta_leads),
      matched: r.ad_name != null,
    }));

    const spendTotal = ads.reduce((s, a) => s + (a.spend || 0), 0);
    const revenueTotal = paise2r(k.revenue_paise);

    res.json({
      kpis: {
        clicks: k.clicks || 0,
        trackedClicks: k.tracked_clicks || 0,
        people: k.people || 0,
        leads: k.leads || 0,
        enrolled: k.enrolled || 0,
        ads: k.ads || 0,
        revenue: revenueTotal,
        spend: spendTotal,
        costPerLead: k.leads ? spendTotal / k.leads : null,
        costPerEnrolment: k.enrolled ? spendTotal / k.enrolled : null,
        roas: spendTotal ? revenueTotal / spendTotal : null,
        leadToEnrolPct: k.leads ? (k.enrolled / k.leads) * 100 : null,
      },
      ads,
      creatives: creativeQ.rows.map(r => ({
        sourceId: r.source_id, mediaType: r.media_type, body: r.body, headline: r.headline,
        thumbnailUrl: r.thumbnail_url, videoUrl: r.video_url, sourceUrl: r.source_url,
        clicks: r.clicks, leads: r.leads,
      })),
      platforms: platQ.rows,
      // Every placement in the date range regardless of the placement filter —
      // what the toggle is rendered from, so selecting one never hides the rest.
      allPlatforms: allPlatQ.rows,
      timeseries: seriesQ.rows.map(r => ({ day: r.day, clicks: r.clicks, people: r.people })),
      stages: stageQ.rows,
      // Meta's sync stores lifetime spend per ad; say so rather than implying the
      // spend figure respects the date filter.
      spendIsLifetime: true,
    });
  } catch (err) {
    console.error('[ctwa] overview error:', err.message);
    res.status(500).json({ error: 'Failed to load Click-to-WhatsApp performance' });
  }
});

// Drill-in: every click on one ad + the leads it produced.
router.get('/ctwa/ads/:sourceId', requirePermission(CTWA_PAGE), async (req, res) => {
  try {
    const sourceId = String(req.params.sourceId);
    const won = cfg.wonStageKeys();
    const wonArr = won.length ? won : ['enrolled'];

    const [adQ, refQ, leadQ, stageQ, seriesQ] = await Promise.all([
      pool.query(
        `SELECT ca.*, c.name AS campaign_name FROM coexistence.campaign_ads ca
           LEFT JOIN coexistence.campaigns c ON c.external_id = ca.campaign_external_id
          WHERE ca.ad_external_id = $1`, [sourceId]),
      pool.query(
        `SELECT * FROM coexistence.ctwa_referrals WHERE source_id = $1 ORDER BY clicked_at DESC LIMIT 500`, [sourceId]),

      // Paid totals come from the SAME deduped gateway+manual union the overview
      // uses, not from leads.paid_amount_paise. That stamped column can lag a
      // reconcile, and a per-lead figure that doesn't add up to the ad's Revenue
      // in the row above reads as a broken page.
      //
      // The chat link resolves the REAL (wa_number, contact_number) pair from
      // contacts via LATERAL rather than assuming the lead's digits match a
      // contact_number — the same correction made for the Sales Log.
      pool.query(
        `WITH paid AS (
           SELECT lead_id, SUM(amount_paise)::bigint AS paise FROM (
             SELECT lead_id, amount_paise FROM ( ${RZP_CAPTURED('matched_lead_id IS NOT NULL')} ) rz
             UNION ALL
             SELECT lead_id, amount_paise FROM coexistence.sales_log WHERE lead_id IS NOT NULL
           ) p GROUP BY lead_id
         )
         SELECT DISTINCT ON (l.id) l.id, l.name, l.whatsapp_number, l.stage, l.source,
                l.assigned_bda, l.created_at, r.clicked_at, r.ctwa_clid,
                r.media_type, r.body, r.platform,
                COALESCE(pd.paise, 0) AS paid_paise,
                ct.wa_number AS chat_wa_number, ct.contact_number AS chat_contact_number
           FROM coexistence.ctwa_referrals r
           JOIN coexistence.leads l ON l.id = r.lead_id
           LEFT JOIN paid pd ON pd.lead_id = l.id
           LEFT JOIN LATERAL (
             SELECT c.wa_number, c.contact_number FROM coexistence.contacts c
              WHERE right(regexp_replace(c.contact_number, '\\D', '', 'g'), 10)
                  = right(regexp_replace(l.whatsapp_number, '\\D', '', 'g'), 10)
              ORDER BY c.updated_at DESC LIMIT 1
           ) ct ON TRUE
          WHERE r.source_id = $1
          ORDER BY l.id, r.clicked_at DESC`, [sourceId]),

      // Where this ad's people ended up. One row per LEAD, not per click — a
      // person who clicked the same ad five times is still one lead.
      pool.query(
        `SELECT l.stage, COUNT(*)::int AS count
           FROM (SELECT DISTINCT lead_id FROM coexistence.ctwa_referrals
                  WHERE source_id = $1 AND lead_id IS NOT NULL) al
           JOIN coexistence.leads l ON l.id = al.lead_id
          GROUP BY l.stage ORDER BY count DESC`, [sourceId]),

      // Clicks per day for this ad, so the drill-in shows whether it is still
      // running or burned out weeks ago.
      pool.query(
        `SELECT to_char(clicked_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS clicks
           FROM coexistence.ctwa_referrals
          WHERE source_id = $1 AND clicked_at IS NOT NULL
          GROUP BY 1 ORDER BY 1`, [sourceId]),
    ]);

    const ad = adQ.rows[0] || null;
    res.json({
      sourceId,
      ad: ad ? {
        adExternalId: ad.ad_external_id, name: ad.name, status: ad.status,
        campaignName: ad.campaign_name, adsetName: ad.adset_name || null,
        spend: Number(ad.spend || 0),
        impressions: Number(ad.impressions || 0), clicks: Number(ad.clicks || 0),
        metaLeads: Number(ad.leads || 0), thumbnailUrl: ad.creative_thumbnail_url,
        // Full-res still + a place to actually watch it (Meta withholds the MP4).
        imageUrl: ad.creative_image_url || null,
        watchUrl: ad.creative_watch_url || null,
        title: ad.creative_title, body: ad.creative_body, igPermalink: ad.ig_permalink,
        lastSyncedAt: ad.last_synced_at || null,
      } : null,
      referrals: refQ.rows.map(r => ({
        id: r.id, ctwaClid: r.ctwa_clid, contactNumber: r.contact_number, leadId: r.lead_id,
        platform: r.platform, sourceType: r.source_type, sourceUrl: r.source_url,
        mediaType: r.media_type, headline: r.headline, body: r.body,
        thumbnailUrl: r.thumbnail_url || r.image_url, videoUrl: r.video_url,
        welcomeMessage: r.welcome_message, clickedAt: r.clicked_at,
      })),
      leads: leadQ.rows.map(r => ({
        id: r.id, name: r.name, whatsappNumber: r.whatsapp_number, stage: r.stage,
        source: r.source, assignedBda: r.assigned_bda, platform: r.platform,
        createdAt: r.created_at, clickedAt: r.clicked_at, ctwaClid: r.ctwa_clid,
        mediaType: r.media_type, adBody: r.body,
        paid: paise2r(r.paid_paise), isWon: wonArr.includes(r.stage),
        chatWaNumber: r.chat_wa_number || null,
        chatContactNumber: r.chat_contact_number || null,
      })),
      stages: stageQ.rows.map(r => ({ stage: r.stage, count: r.count })),
      timeseries: seriesQ.rows.map(r => ({ day: r.day, clicks: r.clicks })),
    });
  } catch (err) {
    console.error('[ctwa] ad detail error:', err.message);
    res.status(500).json({ error: 'Failed to load ad detail' });
  }
});

module.exports = {
  router,
  ensureCtwaTables,
  recordCtwaReferral,
  linkReferralsToLead,
  derivePlatform,
};
