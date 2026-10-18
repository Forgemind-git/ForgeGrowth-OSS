'use strict';

/**
 * Which Meta AD actually produced paying students — measured in ForgeGrowth,
 * not in Ads Manager.
 *
 * Meta's "results" count form fills and clicks. What matters is who then chats
 * on WhatsApp and pays. ForgeGrowth holds both ends of that, joined by the lead:
 *
 *   landing page ads   landing_lead_links.details.landing.ad_id  (the visitor's
 *                      ?ad_id, stored when their first message was matched)
 *   click-to-WhatsApp  ctwa_referrals.source_id                   (Meta's ad id
 *                      on the first message's referral)
 *        ↓ lead_id
 *   razorpay_payments.matched_lead_id (captured, net of refunds) and the lead's
 *   funnel stage ('enrolled' covers a sale entered by hand without Razorpay).
 *
 * Attribution: each lead belongs to its FIRST ad touch inside the range (one
 * person, one ad — never double-counted across ads). A payment counts when it
 * was made after that touch, with a day's grace for someone who paid on the
 * page before their first message reached us.
 *
 * Read-only. Powers the get_ad_conversions MCP tool.
 */

const pool = require('../db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function istToday(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Validated IST date range; defaults to the last 30 days including today. */
function resolveRange({ from, to } = {}, nowMs = Date.now()) {
  const today = istToday(nowMs);
  const t = DATE_RE.test(String(to || '')) ? String(to) : today;
  const f = DATE_RE.test(String(from || '')) ? String(from) : addDays(t, -29);
  if (f > t) throw new Error('`from` must be on or before `to`');
  const days = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error(`Range too long: ${days} days (max ${MAX_RANGE_DAYS})`);
  return { from: f, to: t, days };
}

/**
 * One row per lead → one row per ad. Pure — the unit tests drive it.
 * `rows`: { lead_id, ad_id, adset_id, campaign_id, channel, touched_at, stage, paid_paise }
 */
function aggregateByAd(rows) {
  const byAd = new Map();
  for (const r of rows || []) {
    const adId = String(r.ad_id || '').trim();
    if (!adId) continue;
    let a = byAd.get(adId);
    if (!a) {
      a = { adId, adsetId: null, campaignId: null, chats: 0, landingChats: 0, ctwaChats: 0,
        buyers: 0, paidBuyers: 0, enrolledNoPayment: 0, revenue: 0, firstChatAt: null, lastChatAt: null };
      byAd.set(adId, a);
    }
    if (!a.adsetId && r.adset_id) a.adsetId = String(r.adset_id);
    if (!a.campaignId && r.campaign_id) a.campaignId = String(r.campaign_id);
    a.chats += 1;
    if (r.channel === 'ctwa') a.ctwaChats += 1; else a.landingChats += 1;
    const paid = Math.max(0, Number(r.paid_paise) || 0);
    const enrolled = r.stage === 'enrolled';
    if (paid > 0) { a.paidBuyers += 1; a.revenue += paid / 100; }
    else if (enrolled) a.enrolledNoPayment += 1;
    if (paid > 0 || enrolled) a.buyers += 1;
    const at = r.touched_at ? new Date(r.touched_at).toISOString() : null;
    if (at && (!a.firstChatAt || at < a.firstChatAt)) a.firstChatAt = at;
    if (at && (!a.lastChatAt || at > a.lastChatAt)) a.lastChatAt = at;
  }
  const ads = [...byAd.values()].map(a => ({
    ...a,
    revenue: Math.round(a.revenue * 100) / 100,
    conversionRate: a.chats ? Math.round((a.buyers / a.chats) * 1000) / 10 : 0,
  })).sort((x, y) => y.buyers - x.buyers || y.revenue - x.revenue || y.chats - x.chats);
  const totals = ads.reduce((t, a) => ({
    chats: t.chats + a.chats, buyers: t.buyers + a.buyers, paidBuyers: t.paidBuyers + a.paidBuyers,
    revenue: Math.round((t.revenue + a.revenue) * 100) / 100,
  }), { chats: 0, buyers: 0, paidBuyers: 0, revenue: 0 });
  return { ads, totals };
}

const SQL = `
  WITH touches AS (
    SELECT k.lead_id,
           NULLIF(btrim(k.details->'landing'->>'ad_id'), '')       AS ad_id,
           NULLIF(btrim(k.details->'landing'->>'adset_id'), '')    AS adset_id,
           NULLIF(btrim(k.details->'landing'->>'campaign_id'), '') AS campaign_id,
           'landing'::text AS channel, k.created_at AS touched_at
      FROM coexistence.landing_lead_links k
     WHERE k.lead_id IS NOT NULL
    UNION ALL
    SELECT r.lead_id, NULLIF(btrim(r.source_id), ''), NULL, NULL, 'ctwa', r.clicked_at
      FROM coexistence.ctwa_referrals r
     WHERE r.lead_id IS NOT NULL
  ),
  first_touch AS (
    SELECT DISTINCT ON (lead_id) *
      FROM touches
     WHERE ad_id IS NOT NULL
       AND touched_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
       AND touched_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
     ORDER BY lead_id, touched_at ASC
  )
  SELECT f.lead_id, f.ad_id, f.adset_id, f.campaign_id, f.channel, f.touched_at, l.stage,
         COALESCE((
           SELECT SUM(p.amount_paise - COALESCE(p.amount_refunded_paise, 0))
             FROM coexistence.razorpay_payments p
            WHERE p.matched_lead_id = f.lead_id
              AND p.status IN ('captured', 'refunded')
              AND p.paid_at >= f.touched_at - INTERVAL '1 day'
         ), 0) AS paid_paise
    FROM first_touch f
    JOIN coexistence.leads l ON l.id = f.lead_id`;

async function getAdConversions({ from, to, adIds } = {}) {
  const range = resolveRange({ from, to });
  const { rows } = await pool.query(SQL, [range.from, range.to]);
  const wanted = Array.isArray(adIds) && adIds.length ? new Set(adIds.map(String)) : null;
  const { ads, totals } = aggregateByAd(wanted ? rows.filter(r => wanted.has(String(r.ad_id))) : rows);
  return {
    range: { ...range, timezone: 'Asia/Kolkata' },
    attribution: 'Each lead is credited to its first ad touch in the range (landing page ad_id or click-to-WhatsApp referral). '
      + 'buyers = leads with a captured Razorpay payment after that touch (net of refunds) or moved to the enrolled stage; '
      + 'revenue = net captured payments in INR.',
    totals,
    ads,
  };
}

module.exports = { getAdConversions, aggregateByAd, resolveRange };
