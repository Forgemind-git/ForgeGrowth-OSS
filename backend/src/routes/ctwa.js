// Click-to-WhatsApp attribution + Meta Conversions API.
//
// Two tabs live here, joined by one key — Meta's CTWA click id (`ctwa_clid`):
//
//   READ  /ctwa/*  — Click-to-WhatsApp tab. Every CTWA ad's real performance,
//                    built from the `referral` object the webhook already
//                    receives (no extra Meta call), joined to campaign_ads for
//                    spend and to leads for what actually happened next.
//
//   WRITE /capi/*  — Conversion API tab. Funnel stage → Meta standard event
//                    mapping, the transmission history, and the master switch.
//
// HOW CONVERSIONS FIRE — the deliberate design choice:
// Five different code paths change a lead's stage (the move route, Add Sale,
// the Razorpay webhook ×2, the MCP, the cold-drop engine). Rather than patch a
// hook into all five (and miss the sixth someone adds next month), this module
// reads the ONE thing all of them already write: a `lead_events` row with
// event_type='stage_changed'. A cursor-driven sweeper walks that append-only
// log, so the live write paths stay untouched and any future stage-change path
// is covered for free.
//
// Events that happen while the master switch is OFF are NOT queued: enabling
// jumps the cursor to "now" so flipping the switch can never blast a backlog of
// historical conversions into the ad account. Use "Send eligible now" for that,
// deliberately and visibly.

const crypto = require('crypto');
const { Router } = require('express');
const pool = require('../db');
const bus = require('../events');
const { adminOnly, requirePermission } = require('../middleware/access');
const { decrypt } = require('../util/crypto');
const capi = require('../integrations/metaCapiClient');
const cfg = require('../services/funnelConfig');
const { RZP_CAPTURED } = require('./leads');

const router = Router();

// Meta rejects any event whose event_time is more than 7 days old. We stay a
// day inside that so a slow sweep or a retry can't tip over the edge.
const MAX_EVENT_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
// How many times the sweeper retries one stage event before giving up and moving
// the cursor past it (otherwise a permanently-rejected event blocks the queue).
const MAX_SEND_ATTEMPTS = 3;

// Page key the sidebar/permissions model already knows about. Enforced
// server-side too — the CTWA views return lead names, numbers and amounts paid,
// and every other lead surface gates on its page key.
const CTWA_PAGE = 'ctwa-ads';

const paise2r = (p) => Math.round(Number(p || 0)) / 100;

// Meta deduplicates retries by event_id, so it must be deterministic AND stable
// across lead deletion/recreation — hence keyed on the click id, not leads.id.
function eventIdFor(ctwaClid, eventName) {
  const h = crypto.createHash('sha256').update(String(ctwaClid || '')).digest('hex').slice(0, 24);
  return `fg-${eventName}-${h}`;
}

// ── self-healing schema (mirrors supabase/migrations/073_ctwa_capi.sql) ───────
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
    CREATE TABLE IF NOT EXISTS coexistence.capi_config (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
      test_event_code TEXT,
      default_currency TEXT NOT NULL DEFAULT 'INR',
      max_click_age_days INT NOT NULL DEFAULT 90 CHECK (max_click_age_days BETWEEN 1 AND 365),
      last_sent_at TIMESTAMPTZ, last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Sweeper cursor into lead_events (added after the first cut of migration 073).
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS last_event_id BIGINT NOT NULL DEFAULT 0`);
  // Migration 075 — customer information + the before/after boundary.
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS send_customer_info BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS send_custom_properties BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS enabled_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS customer_fields JSONB NOT NULL DEFAULT '{"ph":true,"em":true,"fn":true,"ln":true,"zp":true,"country":true,"external_id":true,"ct":false,"st":false}'::jsonb`);
  // Migration 076 — which lead column feeds each Meta key.
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS customer_field_sources JSONB NOT NULL DEFAULT '{"ph":"whatsapp_number","em":"email","fn":"name","ln":"name","zp":"pincode","ct":"city","st":"state"}'::jsonb`);
  // Migration 080 — custom conversions + the optional Page id.
  await pool.query(`ALTER TABLE coexistence.capi_event_map ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS page_id TEXT`);
  await pool.query(`ALTER TABLE coexistence.capi_events ADD COLUMN IF NOT EXISTS match_keys JSONB NOT NULL DEFAULT '[]'::jsonb`);
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
  await pool.query(`INSERT INTO coexistence.capi_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.capi_datasets (
      waba_id TEXT PRIMARY KEY, label TEXT, dataset_id TEXT,
      status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','linked','error')),
      discovered_at TIMESTAMPTZ, last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.capi_event_map (
      id BIGSERIAL PRIMARY KEY,
      stage_key TEXT NOT NULL UNIQUE,
      event_name TEXT NOT NULL,
      value_mode TEXT NOT NULL DEFAULT 'none' CHECK (value_mode IN ('none','sale_total','fixed')),
      fixed_value NUMERIC(14,2),
      currency TEXT NOT NULL DEFAULT 'INR',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Same seed as the migration, so a fresh deploy that never ran 073 still lands
  // with the two sensible defaults — but guarded by a MARKER, not by "is the
  // table empty". This runs on every boot, and an admin who deliberately deletes
  // every mapping (to stop sending a conversion) must not have them silently
  // re-created, active, by the next restart.
  await pool.query(`ALTER TABLE coexistence.capi_config ADD COLUMN IF NOT EXISTS mappings_seeded BOOLEAN NOT NULL DEFAULT FALSE`);
  const { rows: seedRow } = await pool.query(`SELECT mappings_seeded FROM coexistence.capi_config WHERE id = 1`);
  if (seedRow[0] && !seedRow[0].mappings_seeded) {
    await pool.query(`
      INSERT INTO coexistence.capi_event_map (stage_key, event_name, value_mode, active)
      SELECT s.stage_key,
             CASE WHEN s.is_won THEN 'Purchase' ELSE 'Lead' END,
             CASE WHEN s.is_won THEN 'sale_total' ELSE 'none' END,
             TRUE
        FROM coexistence.funnel_stages s
       WHERE (s.is_won OR s.stage_key = 'hot')
      ON CONFLICT (stage_key) DO NOTHING`).catch(() => {});
    await pool.query(`UPDATE coexistence.capi_config SET mappings_seeded = TRUE WHERE id = 1`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.capi_events (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      referral_id BIGINT REFERENCES coexistence.ctwa_referrals(id) ON DELETE SET NULL,
      contact_number TEXT, lead_name TEXT, ctwa_clid TEXT,
      stage_key TEXT, event_name TEXT NOT NULL, event_id TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dataset_id TEXT, waba_id TEXT,
      value NUMERIC(14,2), currency TEXT,
      mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
      triggered_by TEXT NOT NULL DEFAULT 'stage_change' CHECK (triggered_by IN ('stage_change','manual','resend','test')),
      status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN ('sent','failed','skipped')),
      skip_reason TEXT, http_status INT, events_received INT, fbtrace_id TEXT,
      request_payload JSONB, response JSONB, error TEXT,
      attempt INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capi_events_created ON coexistence.capi_events (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capi_events_lead ON coexistence.capi_events (lead_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capi_events_status ON coexistence.capi_events (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_capi_events_dedupe ON coexistence.capi_events (lead_id, event_name) WHERE status='sent'`);
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

// ── config helpers ───────────────────────────────────────────────────────────

async function loadCapiConfig() {
  const { rows } = await pool.query(`SELECT * FROM coexistence.capi_config WHERE id = 1`);
  return rows[0] || null;
}

function capiConfigShape(c) {
  if (!c) return null;
  return {
    enabled: c.enabled,
    mode: c.mode,
    testEventCode: c.test_event_code || '',
    defaultCurrency: c.default_currency,
    maxClickAgeDays: c.max_click_age_days,
    pageId: c.page_id || '',
    lastSentAt: c.last_sent_at,
    lastError: c.last_error,
    lastEventId: Number(c.last_event_id || 0),
    sendCustomerInfo: c.send_customer_info === true,
    sendCustomProperties: c.send_custom_properties === true,
    customerFields: c.customer_fields || {},
    customerFieldSources: { ...capi.DEFAULT_FIELD_SOURCES, ...(c.customer_field_sources || {}) },
    enabledAt: c.enabled_at || null,
  };
}

// Columns on coexistence.leads that can sensibly feed a Meta match key, read
// from the database itself rather than hardcoded — so a column added by a future
// migration shows up in the picker automatically and can never drift from the
// real table. Identifiers, timestamps, flags and internal bookkeeping are
// excluded because mapping them would only ever produce a non-matching hash.
const LEAD_FIELD_BLOCKLIST = new Set([
  'id', 'assigned_user_id', 'score', 'follow_up_count', 'stage', 'custom_fields',
  'has_whatsapp_thread', 'tool_access', 'batch_group_added', 'prebatch_reminder_sent',
  'paid_amount_paise', 'score_override_note', 'form_status',
]);

async function leadFieldCatalog() {
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'coexistence' AND table_name = 'leads'
       AND data_type IN ('text', 'character varying', 'integer')
     ORDER BY ordinal_position`);

  const usable = cols
    .map(c => c.column_name)
    .filter(c => !LEAD_FIELD_BLOCKLIST.has(c));
  if (!usable.length) return [];

  // Coverage is what tells an admin whether a column is worth mapping — a
  // perfectly-named column holding nothing is the trap this exists to expose.
  // Column names come from information_schema, never from the request, so the
  // interpolation below cannot carry user input.
  const counts = usable.map(c => `COUNT(NULLIF(${c}::text, ''))::int AS "${c}"`).join(', ');
  const { rows: covRows } = await pool.query(
    `SELECT COUNT(*)::int AS __total, ${counts} FROM coexistence.leads`);
  const cov = covRows[0] || {};
  const total = cov.__total || 0;

  return usable.map(c => ({
    column: c,
    label: c.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
    filled: cov[c] || 0,
    total,
    pct: total ? Math.round(((cov[c] || 0) / total) * 100) : 0,
  }));
}

// The Meta token is the SAME one the Campaigns page connected — one Meta
// connection for the whole app. Returns null when Ads isn't connected, which
// every caller treats as "cannot transmit" rather than an error.
async function metaToken() {
  const { rows } = await pool.query(
    `SELECT access_token_encrypted, status FROM coexistence.meta_ads_config WHERE id = 1`
  );
  const row = rows[0];
  if (!row || !row.access_token_encrypted || row.status === 'disconnected') return null;
  return decrypt(row.access_token_encrypted);
}

function mappingRow(r) {
  return {
    id: r.id,
    stageKey: r.stage_key,
    eventName: r.event_name,
    valueMode: r.value_mode,
    fixedValue: r.fixed_value == null ? null : Number(r.fixed_value),
    currency: r.currency,
    active: r.active,
    isCustom: r.is_custom === true,
  };
}

function eventRow(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    leadName: r.lead_name,
    contactNumber: r.contact_number,
    ctwaClid: r.ctwa_clid,
    stageKey: r.stage_key,
    eventName: r.event_name,
    eventId: r.event_id,
    eventTime: r.event_time,
    datasetId: r.dataset_id,
    wabaId: r.waba_id,
    value: r.value == null ? null : Number(r.value),
    currency: r.currency,
    mode: r.mode,
    triggeredBy: r.triggered_by,
    status: r.status,
    skipReason: r.skip_reason,
    matchKeys: r.match_keys || [],
    httpStatus: r.http_status,
    eventsReceived: r.events_received,
    fbtraceId: r.fbtrace_id,
    error: r.error,
    attempt: r.attempt,
    createdAt: r.created_at,
    requestPayload: r.request_payload,
    response: r.response,
  };
}

// ── the transmission itself ──────────────────────────────────────────────────

async function logCapiEvent(fields) {
  const { rows } = await pool.query(
    `INSERT INTO coexistence.capi_events
       (lead_id, referral_id, contact_number, lead_name, ctwa_clid, stage_key, event_name, event_id,
        event_time, dataset_id, waba_id, value, currency, mode, triggered_by, status, skip_reason,
        http_status, events_received, fbtrace_id, request_payload, response, error, attempt, match_keys)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,NOW()),$10,$11,$12,$13,$14,$15,$16,$17,
             $18,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25::jsonb)
     RETURNING *`,
    [
      fields.leadId || null, fields.referralId || null, fields.contactNumber || null,
      fields.leadName || null, fields.ctwaClid || null, fields.stageKey || null,
      fields.eventName, fields.eventId || '', fields.eventTime || null,
      fields.datasetId || null, fields.wabaId || null,
      fields.value == null ? null : fields.value, fields.currency || null,
      fields.mode || 'test', fields.triggeredBy || 'stage_change',
      fields.status, fields.skipReason || null,
      fields.httpStatus == null ? null : fields.httpStatus,
      fields.eventsReceived == null ? null : fields.eventsReceived,
      fields.fbtraceId || null,
      fields.request ? JSON.stringify(fields.request) : null,
      fields.response ? JSON.stringify(fields.response) : null,
      fields.error || null, fields.attempt || 1,
      JSON.stringify(fields.matchKeys || []),
    ]
  );
  return rows[0];
}

// The lead's REAL paid total in rupees: gateway payments (deduped by payment_id —
// Razorpay writes several 'captured' rows per payment) UNION manual sales_log.
async function leadPaidRupees(leadId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS paise FROM (
       SELECT amount_paise FROM ( ${RZP_CAPTURED('matched_lead_id = $1')} ) rz
       UNION ALL
       SELECT amount_paise FROM coexistence.sales_log WHERE lead_id = $1
     ) s`,
    [leadId]
  );
  return paise2r(rows[0]?.paise);
}

// Leads that would ACTUALLY transmit right now, in mode $1. ONE definition so
// the "Waiting to send" KPI and the backfill can never disagree — and so the
// count only promises what the send path will really do:
//   · stage is mapped + active
//   · the lead has a tracked ad click
//   · nothing already sent for that event IN THIS MODE (a test send must not
//     block the live one, and vice versa)
//   · the stage change is inside Meta's 7-day event window
//   · a sale_total mapping actually has money behind it (a ₹0 Purchase is worse
//     than none — see sendConversionForLead)
const ELIGIBLE_LEADS_SQL = `
  SELECT l.id, l.stage, l.stage_changed_at
    FROM coexistence.leads l
    JOIN coexistence.capi_event_map m ON m.stage_key = l.stage AND m.active
   WHERE EXISTS (SELECT 1 FROM coexistence.ctwa_referrals r
                  WHERE r.ctwa_clid IS NOT NULL
                    AND (r.lead_id = l.id OR r.contact_number = l.whatsapp_number))
     AND l.stage_changed_at IS NOT NULL
     AND l.stage_changed_at >= NOW() - INTERVAL '6 days'
     AND NOT EXISTS (
           SELECT 1 FROM coexistence.capi_events e
            WHERE e.status = 'sent' AND e.mode = $1 AND e.event_name = m.event_name
              AND (e.lead_id = l.id
                   OR (e.ctwa_clid IS NOT NULL AND EXISTS (
                         SELECT 1 FROM coexistence.ctwa_referrals r2
                          WHERE r2.ctwa_clid = e.ctwa_clid
                            AND r2.contact_number = l.whatsapp_number))))
     AND (m.value_mode <> 'sale_total'
          OR EXISTS (SELECT 1 FROM coexistence.sales_log s
                      WHERE s.lead_id = l.id AND s.amount_paise > 0)
          OR EXISTS (SELECT 1 FROM coexistence.razorpay_events z
                      WHERE z.matched_lead_id = l.id AND z.status = 'captured' AND z.amount_paise > 0))`;

// Resolve which dataset to POST to. It MUST be the dataset owned by the WABA the
// click actually landed on — a ctwa_clid is only meaningful to the account that
// minted it, so posting it into another account's dataset is at best rejected
// and at worst mis-attributed.
//
// The only fallback is the genuinely unambiguous case: the click carries no WABA
// id AND exactly one dataset is linked. (An earlier version fell back to "the
// only linked dataset" even when the WABA was known — that quietly routed
// Academy clicks into the Techhub dataset.)
async function resolveDataset(wabaId) {
  const { rows } = await pool.query(
    `SELECT waba_id, dataset_id FROM coexistence.capi_datasets
      WHERE dataset_id IS NOT NULL AND status = 'linked'`
  );
  if (!rows.length) return null;
  if (wabaId) return rows.find(r => String(r.waba_id) === String(wabaId)) || null;
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Send ONE conversion for one lead. Returns { status, reason?, row? }.
 *
 * Never throws — every outcome (sent / failed / skipped) is data the history
 * table wants. Silent skips (a lead that simply never clicked an ad) do NOT
 * write a row, or the log would drown in noise from organic leads.
 */
async function sendConversionForLead({ leadId, stageKey, triggeredBy = 'stage_change', force = false, eventNameOverride = null, valueOverride = null, stageChangedAt = null }) {
  const config = await loadCapiConfig();
  if (!config) return { status: 'skipped', reason: 'no_config' };

  const isManual = triggeredBy !== 'stage_change';
  if (!config.enabled && !isManual) return { status: 'skipped', reason: 'disabled' };

  // 1. mapping
  let mapping = null;
  if (eventNameOverride) {
    // Resend/test path: the caller pins the event (and, for a resend, the exact
    // value that was originally transmitted) so the retry reproduces the
    // original rather than re-deriving a possibly-different one.
    mapping = {
      event_name: eventNameOverride,
      value_mode: valueOverride != null ? 'fixed' : 'none',
      fixed_value: valueOverride,
      currency: config.default_currency,
      active: true,
    };
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.capi_event_map WHERE stage_key = $1`, [stageKey]
    );
    mapping = rows[0] || null;
    if (!mapping) return { status: 'skipped', reason: 'stage_not_mapped' };
    if (!mapping.active && !force) return { status: 'skipped', reason: 'mapping_inactive' };
  }

  // 2. lead — the profile columns come along so the conversion can carry hashed
  //    customer information when that is switched on.
  const { rows: leadRows } = await pool.query(
    `SELECT id, name, whatsapp_number, stage, stage_changed_at,
            email, pincode, age, profession
       FROM coexistence.leads WHERE id = $1`, [leadId]
  );
  const lead = leadRows[0];
  if (!lead) return { status: 'skipped', reason: 'lead_missing' };

  // 3. the click. Most recent click wins — if someone clicked two ads, the last
  //    one is the one that actually brought them back.
  const { rows: refRows } = await pool.query(
    `SELECT * FROM coexistence.ctwa_referrals
      WHERE ctwa_clid IS NOT NULL AND (lead_id = $1 OR contact_number = $2)
      ORDER BY clicked_at DESC LIMIT 1`,
    [lead.id, lead.whatsapp_number]
  );
  const referral = refRows[0];
  // Not from an ad at all → nothing to tell Meta. Silent unless asked directly.
  if (!referral) {
    if (!isManual) return { status: 'skipped', reason: 'no_ctwa_click' };
    const row = await logCapiEvent({
      leadId: lead.id, leadName: lead.name, contactNumber: lead.whatsapp_number,
      stageKey, eventName: mapping.event_name, eventId: eventIdFor(`lead:${lead.id}`, mapping.event_name),
      mode: config.mode, triggeredBy, status: 'skipped', skipReason: 'no_ctwa_click',
    });
    return { status: 'skipped', reason: 'no_ctwa_click', row };
  }

  const base = {
    leadId: lead.id, referralId: referral.id, leadName: lead.name,
    contactNumber: lead.whatsapp_number, ctwaClid: referral.ctwa_clid,
    stageKey, eventName: mapping.event_name,
    // Keyed on the CLICK, not the lead. leads.id is not stable — deleting a sale
    // deletes the lead (capi_events.lead_id → NULL) and the same person coming
    // back gets a fresh id, so a lead-keyed event_id would let Meta count the
    // same click's Purchase twice. The clid is the one identifier that survives.
    eventId: eventIdFor(referral.ctwa_clid, mapping.event_name),
    wabaId: referral.waba_id, mode: config.mode, triggeredBy,
  };

  // 4. dedupe — one 'sent' per (click, event) PER MODE, unless explicitly forced.
  //    Scoped by mode because a test-mode send never reaches the optimiser: if a
  //    test 'sent' row blocked the live send, the documented onboarding (validate
  //    in test, then flip to live) would silently forfeit every conversion that
  //    was validated. Matched on ctwa_clid as well as lead_id so a deleted-and-
  //    recreated lead can't slip a second Purchase past the guard.
  if (!force) {
    const { rows: dup } = await pool.query(
      `SELECT id FROM coexistence.capi_events
        WHERE event_name = $1 AND status = 'sent' AND mode = $2
          AND (lead_id = $3 OR (ctwa_clid IS NOT NULL AND ctwa_clid = $4))
        LIMIT 1`,
      [mapping.event_name, config.mode, lead.id, referral.ctwa_clid]
    );
    if (dup.length) return { status: 'skipped', reason: 'already_sent' };
  }

  // 5. value — computed BEFORE the remaining guards so a skipped row still shows
  //    what would have been sent, which is what makes the history log diagnostic.
  let value = null;
  const currency = mapping.currency || config.default_currency;
  if (mapping.value_mode === 'sale_total') value = await leadPaidRupees(lead.id);
  else if (mapping.value_mode === 'fixed') value = Number(mapping.fixed_value || 0);
  base.value = value;
  base.currency = currency;

  // A ₹0 Purchase is worse than no Purchase: Meta records the conversion at zero
  // value and the dedupe would freeze it there, so when the payment actually
  // lands the real amount can never be reported. Happens whenever a BDA marks
  // someone enrolled before their payment is recorded.
  if (mapping.value_mode === 'sale_total' && !(value > 0)) {
    const row = await logCapiEvent({ ...base, status: 'skipped', skipReason: 'no_payment_recorded_yet' });
    return { status: 'skipped', reason: 'no_payment_recorded_yet', row };
  }

  // 6. click age — don't credit an ad clicked half a year ago.
  const clickAgeDays = (Date.now() - new Date(referral.clicked_at).getTime()) / 86400000;
  if (clickAgeDays > config.max_click_age_days) {
    const row = await logCapiEvent({ ...base, status: 'skipped', skipReason: `click_older_than_${config.max_click_age_days}d` });
    return { status: 'skipped', reason: 'click_too_old', row };
  }

  // 7. dataset + token
  const ds = await resolveDataset(referral.waba_id);
  if (!ds) {
    const row = await logCapiEvent({ ...base, status: 'skipped', skipReason: 'no_dataset' });
    return { status: 'skipped', reason: 'no_dataset', row };
  }
  const token = await metaToken();
  if (!token) {
    const row = await logCapiEvent({ ...base, datasetId: ds.dataset_id, status: 'skipped', skipReason: 'meta_not_connected' });
    return { status: 'skipped', reason: 'meta_not_connected', row };
  }

  // Test mode with no code would send LIVE events while the UI says "test".
  if (config.mode === 'test' && !config.test_event_code) {
    const row = await logCapiEvent({ ...base, datasetId: ds.dataset_id, status: 'skipped', skipReason: 'test_mode_needs_code' });
    return { status: 'skipped', reason: 'test_mode_needs_code', row };
  }

  // 8. event_time — when the conversion actually happened. Meta rejects events
  //    older than 7 days, and back-dating them to "now minus 6 days" would report
  //    a months-old sale as if it happened this week, inflating the ROAS of a
  //    spend window that did not produce it. So SKIP instead of clamping — which
  //    is also what the backfill dialog promises the admin.
  const changedAt = stageChangedAt || lead.stage_changed_at || new Date();
  const changedMs = new Date(changedAt).getTime();
  if (Date.now() - changedMs > MAX_EVENT_AGE_MS) {
    const row = await logCapiEvent({ ...base, datasetId: ds.dataset_id, status: 'skipped', skipReason: 'conversion_older_than_7d' });
    return { status: 'skipped', reason: 'conversion_older_than_7d', row };
  }
  const eventTime = Math.floor(Math.min(changedMs, Date.now()) / 1000);

  // 9. customer information — hashed match keys so Meta can identify WHO
  //    converted, not just which ad produced it. external_id is keyed on the
  //    CLICK for the same reason event_id is: leads.id is not stable across a
  //    deleted sale or a returning customer, so a lead-keyed id would look like
  //    two different people to Meta.
  let userData = null;
  let matchKeys = [];
  if (config.send_customer_info) {
    // The FULL lead row, because which column feeds which Meta key is the
    // admin's choice now — not a hardcoded guess. Re-read rather than widening
    // the earlier SELECT so the mapping can reference any column on the table.
    const { rows: fullRows } = await pool.query(`SELECT * FROM coexistence.leads WHERE id = $1`, [lead.id]);
    const row = fullRows[0] || lead;
    const sources = config.customer_field_sources || {};
    const values = {};
    for (const key of capi.MAPPABLE_KEYS) values[key] = capi.rawValueForKey(key, row, sources);
    // Not mappable: derived from the click so it survives a deleted sale.
    values.external_id = `fg-${referral.ctwa_clid}`;

    const built = capi.buildUserData({
      ctwaClid: referral.ctwa_clid,
      wabaId: referral.waba_id || ds.waba_id,
      values,
      enabledFields: config.customer_fields || {},
    });
    userData = built.userData;
    matchKeys = built.keysSent;
  }

  // Age and profession have no Meta matching parameter, so they can only travel
  // as custom properties — visible in Events Manager for breakdowns, ignored for
  // matching. Kept behind its own toggle so nobody reads them as a stronger signal.
  let customData = null;
  if (config.send_custom_properties) {
    const props = {};
    if (lead.age != null) props.customer_age = String(lead.age);
    if (lead.profession) props.customer_profession = String(lead.profession);
    if (Object.keys(props).length) customData = props;
  }

  const event = capi.buildCtwaEvent({
    eventName: mapping.event_name,
    eventTime,
    ctwaClid: referral.ctwa_clid,
    wabaId: referral.waba_id || ds.waba_id,
    pageId: config.page_id || null,
    eventId: base.eventId,
    value,
    currency,
    userData,
    customData,
  });

  const result = await capi.sendEvents(token, ds.dataset_id, [event], {
    testEventCode: config.mode === 'test' ? config.test_event_code : null,
  });

  const row = await logCapiEvent({
    ...base,
    datasetId: ds.dataset_id,
    eventTime: new Date(eventTime * 1000).toISOString(),
    value, currency,
    status: result.ok ? 'sent' : 'failed',
    httpStatus: result.httpStatus,
    eventsReceived: result.eventsReceived,
    fbtraceId: result.fbtraceId,
    request: result.request,
    response: result.response,
    error: result.error,
    matchKeys,
  });

  await pool.query(
    `UPDATE coexistence.capi_config
        SET last_sent_at = CASE WHEN $1 THEN NOW() ELSE last_sent_at END,
            last_error = $2, updated_at = NOW()
      WHERE id = 1`,
    [result.ok, result.ok ? null : result.error]
  );

  return { status: result.ok ? 'sent' : 'failed', row, error: result.error };
}

// ── the sweeper: lead_events → conversions ───────────────────────────────────

let sweeping = false;

async function sweepStageEvents() {
  if (sweeping) return { skipped: 'busy' };
  sweeping = true;
  try {
    const config = await loadCapiConfig();
    if (!config || !config.enabled) return { skipped: 'disabled' };

    const { rows: events } = await pool.query(
      `SELECT id, lead_id, to_value, ts FROM coexistence.lead_events
        WHERE id > $1 AND event_type = 'stage_changed'
        ORDER BY id LIMIT ${SWEEP_BATCH}`,
      [Number(config.last_event_id || 0)]
    );
    if (!events.length) return { processed: 0 };

    let sent = 0, failed = 0, skipped = 0;
    // The cursor only advances past events we are DONE with. A transmission that
    // failed at Meta (a 5xx, a brief outage) must be retried, not silently left
    // behind — the lead will never change stage again, so the conversion would be
    // lost forever. So: stop the batch at the first failure and leave the cursor
    // just before it. MAX_SEND_ATTEMPTS stops a permanently-failing event from
    // blocking the queue for good; after that it is logged as skipped and passed.
    let cursor = Number(config.last_event_id || 0);
    for (const ev of events) {
      if (!ev.lead_id || !ev.to_value) { skipped++; cursor = ev.id; continue; }

      const out = await sendConversionForLead({
        leadId: ev.lead_id,
        stageKey: ev.to_value,
        triggeredBy: 'stage_change',
        stageChangedAt: ev.ts,
      });

      if (out.status === 'failed') {
        const { rows: tries } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM coexistence.capi_events
            WHERE lead_id = $1 AND status = 'failed' AND stage_key = $2`,
          [ev.lead_id, ev.to_value]
        );
        if (tries[0].n < MAX_SEND_ATTEMPTS) {
          failed++;
          break;                       // retry this same event on the next sweep
        }
        await logCapiEvent({
          leadId: ev.lead_id, stageKey: ev.to_value, eventName: out.row?.event_name || 'unknown',
          eventId: out.row?.event_id || '', mode: config.mode, triggeredBy: 'stage_change',
          status: 'skipped', skipReason: `gave_up_after_${MAX_SEND_ATTEMPTS}_attempts`,
        });
        skipped++; cursor = ev.id; continue;
      }

      if (out.status === 'sent') sent++; else skipped++;
      cursor = ev.id;
    }

    if (cursor !== Number(config.last_event_id || 0)) {
      await pool.query(`UPDATE coexistence.capi_config SET last_event_id = $1, updated_at = NOW() WHERE id = 1`, [cursor]);
    }
    if (sent || failed) console.log(`[capi] swept ${events.length} stage events → ${sent} sent, ${failed} failed, ${skipped} skipped`);
    return { processed: events.length, sent, failed, skipped, lastId: cursor };
  } catch (err) {
    console.error('[capi] sweep error:', err.message);
    return { error: err.message };
  } finally {
    sweeping = false;
  }
}

// A stage change emits 'lead-changed' on the bus, so react to it instead of
// waiting for the next tick — debounced so a bulk move fires one sweep.
let sweepTimer = null;
function kickSweep(delayMs = 4000) {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => { sweepTimer = null; sweepStageEvents(); }, delayMs);
  if (sweepTimer.unref) sweepTimer.unref();
}
bus.on('lead-changed', () => kickSweep());

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

// ═══════════════════════════════════════════════════════════════════════════
// Conversions API — config, mappings, history
// ═══════════════════════════════════════════════════════════════════════════

router.get('/capi/config', adminOnly, async (req, res) => {
  try {
    // Loaded first: the eligible-lead count is mode-specific.
    const config = await loadCapiConfig();
    const [dsQ, mapQ, waQ, statQ, trafficQ, eligQ, covQ] = await Promise.all([
      pool.query(`SELECT * FROM coexistence.capi_datasets ORDER BY label NULLS LAST, waba_id`),
      pool.query(`SELECT * FROM coexistence.capi_event_map ORDER BY id`),
      // DISTINCT ON (waba_id), not DISTINCT (waba_id, display_name): a WABA with
      // two registered numbers would otherwise appear twice and its unreachable
      // clicks would be counted twice.
      pool.query(`SELECT DISTINCT ON (waba_id) waba_id, display_name FROM coexistence.whatsapp_accounts WHERE waba_id IS NOT NULL ORDER BY waba_id, display_name`),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='sent')::int    AS sent,
               COUNT(*) FILTER (WHERE status='failed')::int  AS failed,
               COUNT(*) FILTER (WHERE status='skipped')::int AS skipped,
               COUNT(*) FILTER (WHERE status='sent' AND created_at >= NOW() - INTERVAL '7 days')::int AS sent_7d,
               MAX(created_at) FILTER (WHERE status='sent')  AS last_sent
          FROM coexistence.capi_events`),
      // Where the CTWA traffic actually lands. Without this the UI can say
      // "ready" because SOME account has a dataset, while every real click is
      // arriving on an account that has none — and every conversion would
      // silently skip with no_dataset.
      pool.query(`
        SELECT r.waba_id, COUNT(*)::int AS clicks
          FROM coexistence.ctwa_referrals r
         WHERE r.ctwa_clid IS NOT NULL AND r.waba_id IS NOT NULL
         GROUP BY r.waba_id`),
      // Leads that would really transmit right now (shared definition).
      pool.query(`SELECT COUNT(*)::int AS n FROM ( ${ELIGIBLE_LEADS_SQL} ) x`, [config.mode]),
      // How much of each match key this CRM actually holds. Counted over leads
      // that HAVE an ad click, because those are the only ones that can ever be
      // transmitted — coverage across all 330 leads would overstate what a
      // conversion will really carry.
      pool.query(`
        WITH attributable AS (
          SELECT DISTINCT l.*
            FROM coexistence.leads l
            JOIN coexistence.ctwa_referrals r
              ON (r.lead_id = l.id OR r.contact_number = l.whatsapp_number)
           WHERE r.ctwa_clid IS NOT NULL
        )
        SELECT COUNT(*)::int                                                    AS total,
               COUNT(*) FILTER (WHERE whatsapp_number <> '')::int               AS ph,
               COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int   AS em,
               COUNT(*) FILTER (WHERE name IS NOT NULL AND name <> '')::int     AS fn,
               COUNT(*) FILTER (WHERE name LIKE '% %')::int                     AS ln,
               COUNT(*) FILTER (WHERE pincode IS NOT NULL AND pincode <> '')::int AS zp,
               0::int                                                           AS ct,
               0::int                                                           AS st,
               COUNT(*)::int                                                    AS country,
               COUNT(*)::int                                                    AS external_id,
               COUNT(*) FILTER (WHERE age IS NOT NULL)::int                     AS age,
               COUNT(*) FILTER (WHERE profession IS NOT NULL AND profession <> '')::int AS profession
          FROM attributable`),
    ]);

    const coverage = covQ.rows[0] || { total: 0 };
    const metaConnected = !!(await metaToken());
    const clicksByWaba = {};
    for (const r of trafficQ.rows) clicksByWaba[String(r.waba_id)] = r.clicks;

    const datasets = dsQ.rows.map(r => ({
      wabaId: r.waba_id, label: r.label, datasetId: r.dataset_id,
      status: r.status, discoveredAt: r.discovered_at, lastError: r.last_error,
      clicks: clicksByWaba[String(r.waba_id)] || 0,
    }));
    // WhatsApp accounts that have no capi_datasets row yet.
    const unlinkedAccounts = waQ.rows
      .filter(a => !dsQ.rows.some(d => String(d.waba_id) === String(a.waba_id)))
      .map(a => ({ wabaId: a.waba_id, label: a.display_name, clicks: clicksByWaba[String(a.waba_id)] || 0 }));

    // Clicks that can never be transmitted because the account they landed on
    // has no dataset. This is the difference between "some account is wired up"
    // and "your actual traffic is wired up".
    const unreachableClicks = [...datasets, ...unlinkedAccounts]
      .filter(d => !d.datasetId && d.clicks > 0)
      .reduce((n, d) => n + d.clicks, 0);

    res.json({
      config: capiConfigShape(config),
      metaConnected,
      datasets,
      unlinkedAccounts,
      unreachableClicks,
      mappings: mapQ.rows.map(mappingRow),
      stages: cfg.stages(),
      standardEvents: capi.STANDARD_EVENTS,
      valueEvents: capi.VALUE_EVENTS,
      // The full catalog — name, group, meaning, what Meta does with it — so the
      // picker and the reference panel explain every signal from one source.
      eventCatalog: capi.EVENT_CATALOG,
      eventGroups: capi.EVENT_GROUPS,
      // Customer-information guidance + how much of each key this CRM actually
      // holds, so "should I send PIN code" is answerable with real numbers.
      matchKeyCatalog: capi.MATCH_KEY_CATALOG,
      matchKeyTiers: capi.MATCH_KEY_TIERS,
      nonMatchingProperties: capi.NON_MATCHING_PROPERTIES,
      customerFieldCoverage: coverage,
      // Real columns on coexistence.leads, so the source picker can never offer
      // a field that does not exist.
      leadFields: await leadFieldCatalog(),
      mappableKeys: capi.MAPPABLE_KEYS,
      notes: capi.NOTE_CATALOG,
      learningPhase: capi.LEARNING_PHASE,
      stats: { ...statQ.rows[0], eligible: eligQ.rows[0]?.n || 0 },
    });
  } catch (err) {
    console.error('[capi] config error:', err.message);
    res.status(500).json({ error: 'Failed to load Conversion API settings' });
  }
});

router.put('/capi/config', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const current = await loadCapiConfig();
    const fields = [];
    const vals = [];
    let i = 1;

    if (typeof b.enabled === 'boolean') { fields.push(`enabled = $${i++}`); vals.push(b.enabled); }
    if (b.mode === 'test' || b.mode === 'live') { fields.push(`mode = $${i++}`); vals.push(b.mode); }
    if (b.testEventCode !== undefined) { fields.push(`test_event_code = $${i++}`); vals.push(String(b.testEventCode || '').trim() || null); }
    if (b.pageId !== undefined) {
      const v = String(b.pageId || '').trim();
      if (v && !/^\d{5,}$/.test(v)) return res.status(400).json({ error: 'A Page ID is numeric — copy it from your Facebook Page settings.' });
      fields.push(`page_id = $${i++}`); vals.push(v || null);
    }
    if (b.defaultCurrency) { fields.push(`default_currency = $${i++}`); vals.push(String(b.defaultCurrency).toUpperCase().slice(0, 3)); }
    if (Number.isFinite(parseInt(b.maxClickAgeDays, 10))) {
      const n = Math.max(1, Math.min(365, parseInt(b.maxClickAgeDays, 10)));
      fields.push(`max_click_age_days = $${i++}`); vals.push(n);
    }

    if (typeof b.sendCustomerInfo === 'boolean') { fields.push(`send_customer_info = $${i++}`); vals.push(b.sendCustomerInfo); }
    if (typeof b.sendCustomProperties === 'boolean') { fields.push(`send_custom_properties = $${i++}`); vals.push(b.sendCustomProperties); }
    if (b.customerFields && typeof b.customerFields === 'object') {
      // Only keys Meta actually defines may be stored — an unknown key would be
      // a toggle that silently does nothing.
      const allowed = new Set(capi.MATCH_KEY_CATALOG.map(k => k.key));
      const merged = { ...(current?.customer_fields || {}) };
      for (const [k, v] of Object.entries(b.customerFields)) {
        if (allowed.has(k)) merged[k] = v === true;
      }
      fields.push(`customer_fields = $${i++}::jsonb`); vals.push(JSON.stringify(merged));
    }
    if (b.customerFieldSources && typeof b.customerFieldSources === 'object') {
      // A source must be a real column on leads, or the send path would read
      // undefined and the key would silently vanish from every conversion.
      const catalog = await leadFieldCatalog();
      const realCols = new Set(catalog.map(c => c.column));
      const mappable = new Set(capi.MAPPABLE_KEYS);
      const merged = { ...(current?.customer_field_sources || {}) };
      for (const [k, v] of Object.entries(b.customerFieldSources)) {
        if (!mappable.has(k)) continue;
        if (v === null || v === '') { merged[k] = null; continue; }
        if (!realCols.has(v)) {
          return res.status(400).json({ error: `“${v}” is not a column on the leads table.` });
        }
        merged[k] = v;
      }
      fields.push(`customer_field_sources = $${i++}::jsonb`); vals.push(JSON.stringify(merged));
    }

    // Turning the switch ON jumps the cursor to now, so months of historical
    // stage changes can never fire as a surprise burst of conversions.
    if (b.enabled === true && current && !current.enabled) {
      const { rows } = await pool.query(`SELECT COALESCE(MAX(id),0)::bigint AS max FROM coexistence.lead_events`);
      fields.push(`last_event_id = $${i++}`); vals.push(rows[0].max);
      // Stamp the before/after boundary the FIRST time sending is switched on and
      // never again: if a later off→on toggle moved it, the performance
      // comparison would quietly re-baseline to the most recent flip, and someone
      // toggling the switch while investigating would destroy the measurement
      // they were investigating.
      if (!current.enabled_at) { fields.push(`enabled_at = NOW()`); }
    }

    if (!fields.length) return res.json({ config: capiConfigShape(current) });
    const { rows } = await pool.query(
      `UPDATE coexistence.capi_config SET ${fields.join(', ')}, updated_at = NOW() WHERE id = 1 RETURNING *`, vals
    );
    res.json({ config: capiConfigShape(rows[0]) });
  } catch (err) {
    console.error('[capi] update config error:', err.message);
    res.status(500).json({ error: 'Failed to save Conversion API settings' });
  }
});

// Ask Meta which dataset each WhatsApp account owns.
router.post('/capi/datasets/discover', adminOnly, async (req, res) => {
  try {
    const token = await metaToken();
    if (!token) return res.status(400).json({ error: 'Connect Meta Ads first (Marketing → Campaigns → Connect Meta Ads).' });

    const { rows: accounts } = await pool.query(
      `SELECT DISTINCT waba_id, display_name FROM coexistence.whatsapp_accounts WHERE waba_id IS NOT NULL`
    );
    const out = [];
    for (const a of accounts) {
      let datasetId = null, status = 'missing', lastError = null;
      try {
        datasetId = await capi.getWabaDataset(token, a.waba_id);
        status = datasetId ? 'linked' : 'missing';
      } catch (e) {
        status = 'error';
        lastError = e.message;
      }
      await pool.query(
        `INSERT INTO coexistence.capi_datasets (waba_id, label, dataset_id, status, discovered_at, last_error)
         VALUES ($1,$2,$3,$4,NOW(),$5)
         ON CONFLICT (waba_id) DO UPDATE SET
           label = EXCLUDED.label,
           dataset_id = COALESCE(EXCLUDED.dataset_id, coexistence.capi_datasets.dataset_id),
           status = CASE WHEN EXCLUDED.dataset_id IS NOT NULL THEN 'linked'
                         WHEN coexistence.capi_datasets.dataset_id IS NOT NULL THEN coexistence.capi_datasets.status
                         ELSE EXCLUDED.status END,
           discovered_at = NOW(), last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [a.waba_id, a.display_name, datasetId, status, lastError]
      );
      out.push({ wabaId: a.waba_id, label: a.display_name, datasetId, status, lastError });
    }
    res.json({ ok: true, datasets: out });
  } catch (err) {
    console.error('[capi] discover error:', err.message);
    res.status(500).json({ error: 'Failed to look up datasets' });
  }
});

// Create the dataset Meta hasn't made yet for this WABA.
router.post('/capi/datasets/:wabaId/create', adminOnly, async (req, res) => {
  try {
    const wabaId = String(req.params.wabaId);
    const token = await metaToken();
    if (!token) return res.status(400).json({ error: 'Connect Meta Ads first.' });

    let datasetId;
    try {
      datasetId = await capi.createWabaDataset(token, wabaId);
    } catch (e) {
      await pool.query(
        `UPDATE coexistence.capi_datasets SET status='error', last_error=$2, updated_at=NOW() WHERE waba_id=$1`,
        [wabaId, e.message]
      );
      return res.status(400).json({ error: `Meta refused: ${e.message}` });
    }
    if (!datasetId) return res.status(400).json({ error: 'Meta did not return a dataset id.' });

    await pool.query(
      `INSERT INTO coexistence.capi_datasets (waba_id, dataset_id, status, discovered_at, last_error)
       VALUES ($1,$2,'linked',NOW(),NULL)
       ON CONFLICT (waba_id) DO UPDATE SET dataset_id=EXCLUDED.dataset_id, status='linked',
         discovered_at=NOW(), last_error=NULL, updated_at=NOW()`,
      [wabaId, datasetId]
    );
    res.json({ ok: true, wabaId, datasetId });
  } catch (err) {
    console.error('[capi] create dataset error:', err.message);
    res.status(500).json({ error: 'Failed to create dataset' });
  }
});

// Paste a dataset id by hand (or clear it).
router.put('/capi/datasets/:wabaId', adminOnly, async (req, res) => {
  try {
    const wabaId = String(req.params.wabaId);
    const datasetId = String(req.body?.datasetId || '').trim() || null;
    const { rows: wa } = await pool.query(
      `SELECT display_name FROM coexistence.whatsapp_accounts WHERE waba_id = $1 LIMIT 1`, [wabaId]
    );
    await pool.query(
      `INSERT INTO coexistence.capi_datasets (waba_id, label, dataset_id, status, discovered_at, last_error)
       VALUES ($1,$2,$3,$4,NOW(),NULL)
       ON CONFLICT (waba_id) DO UPDATE SET dataset_id=EXCLUDED.dataset_id, status=EXCLUDED.status,
         label=COALESCE(EXCLUDED.label, coexistence.capi_datasets.label), last_error=NULL, updated_at=NOW()`,
      [wabaId, wa[0]?.display_name || null, datasetId, datasetId ? 'linked' : 'missing']
    );
    res.json({ ok: true, wabaId, datasetId });
  } catch (err) {
    console.error('[capi] link dataset error:', err.message);
    res.status(500).json({ error: 'Failed to save dataset id' });
  }
});

// ── stage → event mappings ───────────────────────────────────────────────────

function validMapping(b) {
  const stageKey = String(b.stageKey || '').trim();
  const eventName = String(b.eventName || '').trim();
  const isCustom = b.isCustom === true;
  if (!stageKey) return { error: 'Stage is required' };
  if (!cfg.isValidStage(stageKey)) return { error: 'Unknown funnel stage' };
  if (!eventName) return { error: 'Event name is required' };

  // Meta SILENTLY DROPS an event name it doesn't recognise, so a typo looks like
  // a working mapping that never optimises anything. A non-standard name is
  // therefore only accepted when the admin has explicitly marked the mapping as
  // a Custom Conversion — which distinguishes "I typo'd Purchase" from "I made
  // this event in Events Manager myself".
  if (!isCustom && !capi.STANDARD_EVENTS.includes(eventName)) {
    return {
      error: `“${eventName}” is not one of Meta's standard events. Pick one from the list, `
           + 'or mark this as a Custom Conversion if you created it in Events Manager.',
    };
  }
  if (isCustom) {
    // Meta rejects names outside this shape, and a name that fails here would be
    // dropped without an error the same way a typo is.
    if (!/^[A-Za-z][A-Za-z0-9_]{1,44}$/.test(eventName)) {
      return { error: 'A custom conversion name must start with a letter and use only letters, numbers and underscores.' };
    }
    if (capi.STANDARD_EVENTS.includes(eventName)) {
      // Naming a custom conversion after a standard event makes Events Manager
      // ambiguous about which definition applies.
      return { error: `“${eventName}” is a Meta standard event — untick Custom Conversion to use it.` };
    }
  }
  const valueMode = ['none', 'sale_total', 'fixed'].includes(b.valueMode) ? b.valueMode : 'none';
  if (valueMode === 'fixed' && !(Number(b.fixedValue) > 0)) return { error: 'Fixed value must be greater than 0' };
  return {
    stageKey, eventName, valueMode, isCustom,
    fixedValue: valueMode === 'fixed' ? Number(b.fixedValue) : null,
    currency: String(b.currency || 'INR').toUpperCase().slice(0, 3),
    active: b.active !== false,
  };
}

router.post('/capi/mappings', adminOnly, async (req, res) => {
  try {
    const v = validMapping(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.capi_event_map (stage_key, event_name, value_mode, fixed_value, currency, active, is_custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (stage_key) DO UPDATE SET event_name=EXCLUDED.event_name, value_mode=EXCLUDED.value_mode,
         fixed_value=EXCLUDED.fixed_value, currency=EXCLUDED.currency, active=EXCLUDED.active,
         is_custom=EXCLUDED.is_custom, updated_at=NOW()
       RETURNING *`,
      [v.stageKey, v.eventName, v.valueMode, v.fixedValue, v.currency, v.active, v.isCustom]
    );
    res.status(201).json({ mapping: mappingRow(rows[0]) });
  } catch (err) {
    console.error('[capi] create mapping error:', err.message);
    res.status(500).json({ error: 'Failed to save mapping' });
  }
});

router.put('/capi/mappings/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    // A toggle-only PATCH shouldn't have to resend the whole mapping.
    if (Object.keys(b).length === 1 && typeof b.active === 'boolean') {
      const { rows } = await pool.query(
        `UPDATE coexistence.capi_event_map SET active=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [b.active, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Mapping not found' });
      return res.json({ mapping: mappingRow(rows[0]) });
    }
    const v = validMapping(b);
    if (v.error) return res.status(400).json({ error: v.error });
    const { rows } = await pool.query(
      `UPDATE coexistence.capi_event_map
          SET stage_key=$1, event_name=$2, value_mode=$3, fixed_value=$4, currency=$5, active=$6,
              is_custom=$8, updated_at=NOW()
        WHERE id=$7 RETURNING *`,
      [v.stageKey, v.eventName, v.valueMode, v.fixedValue, v.currency, v.active, id, v.isCustom]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json({ mapping: mappingRow(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That stage already has a mapping' });
    console.error('[capi] update mapping error:', err.message);
    res.status(500).json({ error: 'Failed to update mapping' });
  }
});

router.delete('/capi/mappings/:id', adminOnly, async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.capi_event_map WHERE id=$1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[capi] delete mapping error:', err.message);
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

// ── transmission history ─────────────────────────────────────────────────────

router.get('/capi/events', adminOnly, async (req, res) => {
  try {
    const q = req.query || {};
    const where = ['1=1'];
    const params = [];
    let i = 1;
    const add = (v) => { params.push(v); return `$${i++}`; };

    if (q.status) where.push(`e.status = ${add(q.status)}`);
    if (q.eventName) where.push(`e.event_name = ${add(q.eventName)}`);
    if (q.mode) where.push(`e.mode = ${add(q.mode)}`);
    if (q.leadId) where.push(`e.lead_id = ${add(parseInt(q.leadId, 10))}`);
    const days = parseInt(q.days, 10);
    if (Number.isFinite(days) && days > 0) where.push(`e.created_at >= NOW() - (${add(String(days))} || ' days')::interval`);
    if (q.search) {
      const s = add(`%${q.search}%`);
      where.push(`(e.lead_name ILIKE ${s} OR e.contact_number ILIKE ${s} OR e.ctwa_clid ILIKE ${s})`);
    }

    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const offset = (page - 1) * limit;

    const [listQ, countQ] = await Promise.all([
      pool.query(
        `SELECT e.* FROM coexistence.capi_events e
          WHERE ${where.join(' AND ')}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT ${limit} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.capi_events e WHERE ${where.join(' AND ')}`, params),
    ]);

    res.json({ events: listQ.rows.map(eventRow), total: countQ.rows[0].n, page, limit });
  } catch (err) {
    console.error('[capi] events error:', err.message);
    res.status(500).json({ error: 'Failed to load conversion history' });
  }
});

// Retry one transmission. Reuses the SAME event_id so Meta deduplicates rather
// than double-counting if the original actually landed.
router.post('/capi/events/:id/resend', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.capi_events WHERE id=$1`, [parseInt(req.params.id, 10)]);
    const prev = rows[0];
    if (!prev) return res.status(404).json({ error: 'Event not found' });
    if (!prev.lead_id) return res.status(400).json({ error: 'That lead no longer exists' });

    // A resend must REPRODUCE the original transmission, not re-resolve it.
    // Re-reading the mapping would emit a different event (and a different
    // event_id, so Meta counts an extra conversion instead of deduplicating),
    // and re-reading the mode would let "Send again" on a clearly-TEST row emit
    // a real live conversion. Pin both to what was originally logged.
    const config = await loadCapiConfig();
    if (prev.mode !== config.mode) {
      return res.status(409).json({
        error: `That row was sent in ${prev.mode.toUpperCase()} mode but the Conversion API is now in ${config.mode.toUpperCase()} mode. Switch back to ${prev.mode.toUpperCase()} to resend it.`,
      });
    }
    const out = await sendConversionForLead({
      leadId: prev.lead_id,
      stageKey: prev.stage_key,
      triggeredBy: 'resend',
      force: true,
      eventNameOverride: prev.event_name,
      valueOverride: prev.value == null ? null : Number(prev.value),
    });
    res.json({ ok: out.status === 'sent', result: out.status, reason: out.reason || null, error: out.error || null, event: out.row ? eventRow(out.row) : null });
  } catch (err) {
    console.error('[capi] resend error:', err.message);
    res.status(500).json({ error: 'Failed to resend' });
  }
});

// Fire one conversion on demand for a specific lead.
router.post('/capi/send', adminOnly, async (req, res) => {
  try {
    const leadId = parseInt(req.body?.leadId, 10);
    if (!Number.isFinite(leadId)) return res.status(400).json({ error: 'leadId is required' });
    const { rows } = await pool.query(`SELECT stage FROM coexistence.leads WHERE id=$1`, [leadId]);
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    const out = await sendConversionForLead({
      leadId, stageKey: rows[0].stage, triggeredBy: 'manual',
      force: req.body?.force === true,
      eventNameOverride: req.body?.eventName || null,
    });
    res.json({ ok: out.status === 'sent', result: out.status, reason: out.reason || null, error: out.error || null, event: out.row ? eventRow(out.row) : null });
  } catch (err) {
    console.error('[capi] manual send error:', err.message);
    res.status(500).json({ error: 'Failed to send conversion' });
  }
});

// Send every lead currently sitting in a mapped stage that has a click and has
// never been transmitted. Deliberate, visible, admin-triggered — this is the
// "catch up on what happened before I switched it on" button.
router.post('/capi/backfill', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.body?.limit, 10) || 100));
    const config = await loadCapiConfig();
    const { rows } = await pool.query(
      `SELECT * FROM ( ${ELIGIBLE_LEADS_SQL} ) x ORDER BY x.stage_changed_at DESC NULLS LAST LIMIT ${limit}`,
      [config.mode]
    );

    let sent = 0, failed = 0, skipped = 0;
    const reasons = {};
    for (const l of rows) {
      const out = await sendConversionForLead({
        leadId: l.id, stageKey: l.stage, triggeredBy: 'manual', stageChangedAt: l.stage_changed_at,
      });
      if (out.status === 'sent') sent++;
      else if (out.status === 'failed') failed++;
      else { skipped++; reasons[out.reason || 'unknown'] = (reasons[out.reason || 'unknown'] || 0) + 1; }
    }
    res.json({ ok: true, considered: rows.length, sent, failed, skipped, reasons });
  } catch (err) {
    console.error('[capi] backfill error:', err.message);
    res.status(500).json({ error: 'Failed to send eligible conversions' });
  }
});

// Prove the pipe works end-to-end using a REAL recent click, without touching
// the funnel. Always goes out with the test event code.
router.post('/capi/test', adminOnly, async (req, res) => {
  try {
    const config = await loadCapiConfig();
    const token = await metaToken();
    if (!token) return res.status(400).json({ error: 'Connect Meta Ads first.' });
    if (!config.test_event_code) return res.status(400).json({ error: 'Add a Test event code first (Events Manager → Test Events).' });

    const { rows } = await pool.query(
      `SELECT * FROM coexistence.ctwa_referrals WHERE ctwa_clid IS NOT NULL ORDER BY clicked_at DESC LIMIT 1`
    );
    const referral = rows[0];
    if (!referral) return res.status(400).json({ error: 'No Click-to-WhatsApp click recorded yet — nothing to test with.' });

    const ds = await resolveDataset(referral.waba_id);
    if (!ds) return res.status(400).json({ error: 'No dataset linked for that WhatsApp account yet.' });

    const eventName = String(req.body?.eventName || 'Lead');
    const eventId = `fg-test-${referral.id}-${eventName}`;
    const event = capi.buildCtwaEvent({
      eventName,
      eventTime: Math.floor(Date.now() / 1000),
      ctwaClid: referral.ctwa_clid,
      wabaId: referral.waba_id || ds.waba_id,
      pageId: config.page_id || null,
      eventId,
    });
    const result = await capi.sendEvents(token, ds.dataset_id, [event], { testEventCode: config.test_event_code });

    const row = await logCapiEvent({
      leadId: referral.lead_id, referralId: referral.id, contactNumber: referral.contact_number,
      ctwaClid: referral.ctwa_clid, eventName, eventId, datasetId: ds.dataset_id, wabaId: referral.waba_id,
      mode: 'test', triggeredBy: 'test', status: result.ok ? 'sent' : 'failed',
      httpStatus: result.httpStatus, eventsReceived: result.eventsReceived, fbtraceId: result.fbtraceId,
      request: result.request, response: result.response, error: result.error,
    });
    res.json({ ok: result.ok, error: result.error, eventsReceived: result.eventsReceived, event: eventRow(row) });
  } catch (err) {
    console.error('[capi] test error:', err.message);
    res.status(500).json({ error: 'Failed to send test event' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// Field preview — what a real conversion would actually carry
// ═══════════════════════════════════════════════════════════════════════════
//
// The whole customer-information feature is invisible otherwise: a wrong column
// or a bad normalisation still returns 200 OK from Meta, so "it sent" proves
// nothing. This shows one real lead end to end — the stored value, what it
// normalises to, and the hash that leaves the building — so the mapping can be
// checked by eye before anything is transmitted.
router.get('/capi/field-preview', adminOnly, async (req, res) => {
  try {
    const config = await loadCapiConfig();
    const sources = { ...capi.DEFAULT_FIELD_SOURCES, ...(config?.customer_field_sources || {}) };
    const enabled = config?.customer_fields || {};

    // Prefer a lead that came from an ad AND has the most detail filled in —
    // previewing an empty row would teach nothing.
    const { rows } = await pool.query(`
      SELECT l.*,
             (CASE WHEN l.email IS NOT NULL AND l.email <> '' THEN 1 ELSE 0 END
            + CASE WHEN l.pincode IS NOT NULL AND l.pincode <> '' THEN 1 ELSE 0 END
            + CASE WHEN l.name LIKE '% %' THEN 1 ELSE 0 END) AS richness
        FROM coexistence.leads l
        JOIN coexistence.ctwa_referrals r
          ON (r.lead_id = l.id OR r.contact_number = l.whatsapp_number)
       WHERE r.ctwa_clid IS NOT NULL
       ORDER BY richness DESC, l.updated_at DESC
       LIMIT 1`);

    const lead = rows[0] || null;
    if (!lead) {
      return res.json({ hasSample: false, sources, table: 'coexistence.leads' });
    }

    const fields = capi.MATCH_KEY_CATALOG.map(k => {
      const mappable = capi.MAPPABLE_KEYS.includes(k.key);
      const column = mappable ? (sources[k.key] || null) : null;
      let raw = null;
      if (k.key === 'external_id') raw = 'fg-<click id>';
      else if (mappable) raw = capi.rawValueForKey(k.key, lead, sources);

      // country falls back to the phone's dialling code when unmapped
      if (k.key === 'country' && raw == null) {
        raw = null; // shown as derived below
      }
      const normalised = k.key === 'external_id' ? null : capi.normalizeMatchValue(k.key, raw);
      return {
        key: k.key,
        label: k.label,
        tier: k.tier,
        enabled: enabled[k.key] === true,
        mappable,
        column,
        raw: raw == null ? null : String(raw),
        normalised,
        // A prefix only — the full hash is not a secret, but showing a fragment
        // makes the point (something unreadable leaves) without inviting anyone
        // to treat this screen as a place to read customer data.
        hashPrefix: normalised ? capi.sha256(normalised).slice(0, 12) : null,
        willSend: enabled[k.key] === true && !!normalised,
      };
    });

    res.json({
      hasSample: true,
      table: 'coexistence.leads',
      sources,
      lead: { id: Number(lead.id), name: lead.name, whatsappNumber: lead.whatsapp_number },
      fields,
      willSendCount: fields.filter(f => f.willSend).length,
    });
  } catch (err) {
    console.error('[capi] field preview error:', err.message);
    res.status(500).json({ error: 'Failed to build the field preview' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Timing — how long from ad click to each funnel stage
// ═══════════════════════════════════════════════════════════════════════════
//
// This answers the question that decides whether CTWA optimisation can work at
// all: does a lead reach the qualifying stage inside Meta's 7-day window?
//
// Meta returns SUCCESS for an event describing something older than 7 days and
// then discards it. Without measuring this you would see healthy send counts,
// no optimisation effect, and nothing anywhere explaining why — which is close
// to impossible to diagnose after the fact.
const CTWA_WINDOW_DAYS = 7;

router.get('/capi/timing', adminOnly, async (req, res) => {
  try {
    // Earliest click per lead. A person who clicked twice is measured from their
    // FIRST click, because that is the one Meta attributes.
    const { rows } = await pool.query(`
      WITH first_click AS (
        SELECT COALESCE(r.lead_id, l.id) AS lead_id, MIN(r.clicked_at) AS clicked_at
          FROM coexistence.ctwa_referrals r
          LEFT JOIN coexistence.leads l ON l.whatsapp_number = r.contact_number
         WHERE r.ctwa_clid IS NOT NULL
         GROUP BY 1
      ),
      reached AS (
        SELECT ev.to_value AS stage_key, f.lead_id,
               MIN(EXTRACT(EPOCH FROM (ev.ts - f.clicked_at)) / 86400) AS days
          FROM first_click f
          JOIN coexistence.lead_events ev
            ON ev.lead_id = f.lead_id AND ev.event_type = 'stage_changed'
         WHERE f.lead_id IS NOT NULL AND ev.ts >= f.clicked_at
         GROUP BY 1, 2
      )
      SELECT stage_key,
             COUNT(*)::int AS leads,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) AS median_days,
             COUNT(*) FILTER (WHERE days <= ${CTWA_WINDOW_DAYS})::int AS within_window
        FROM reached
       GROUP BY stage_key`);

    const byStage = {};
    for (const r of rows) byStage[r.stage_key] = r;

    // Reported in the configured funnel order so the ladder reads top to bottom.
    const stages = cfg.stages().map(s => {
      const r = byStage[s.stageKey];
      const leads = r ? r.leads : 0;
      const median = r?.median_days == null ? null : Number(r.median_days);
      const within = r ? r.within_window : 0;
      return {
        stageKey: s.stageKey,
        label: s.label,
        leads,
        medianDays: median,
        withinWindow: within,
        withinWindowPct: leads ? (within / leads) * 100 : null,
        // The verdict a person actually needs, rather than three numbers to
        // interpret themselves.
        verdict: leads === 0 ? 'no_data'
          : median != null && median <= CTWA_WINDOW_DAYS ? 'inside'
          : 'outside',
      };
    });

    const totalTransitions = rows.reduce((n, r) => n + r.leads, 0);
    // A funnel where nothing ever moves past the entry stage cannot produce a
    // qualification signal, however well the transport is configured. Saying so
    // is more useful than reporting medians of zero.
    const movedBeyondEntry = stages.slice(1).some(s => s.leads > 0);

    res.json({
      stages,
      windowDays: CTWA_WINDOW_DAYS,
      totalTransitions,
      movedBeyondEntry,
      diagnosis: !totalTransitions
        ? 'No stage changes have been recorded for any lead that came from an ad, so there is nothing to send yet.'
        : !movedBeyondEntry
          ? 'Every recorded stage change is the initial one. Leads are being created but never moved through the funnel, '
            + 'so no qualification signal exists to optimise on — that is a process gap, not a configuration problem.'
          : null,
    });
  } catch (err) {
    console.error('[capi] timing error:', err.message);
    res.status(500).json({ error: 'Failed to compute click-to-stage timing' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Click-ID inspector — is this click id real, and what happened to it?
// ═══════════════════════════════════════════════════════════════════════════
//
// A click id is the only thing tying a conversation back to an ad, so "is it
// genuine" is a fair question. There is no offline way to validate one: Meta
// does not publish a format and does not expose a lookup. What CAN be checked:
//
//   shape      — present, and long enough to be a real token rather than noise
//   uniqueness — the same id appearing on two different people is a red flag
//   freshness  — age against the attribution window and Meta's 7-day event limit
//   acceptance — whether Meta itself accepted a conversion carrying it
//
// The last one is the only real proof, and it is worth saying so in the UI:
// Meta accepting the event IS the authenticity test.
router.get('/capi/click-ids', adminOnly, async (req, res) => {
  try {
    const q = req.query || {};
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const config = await loadCapiConfig();

    const where = ['1=1'];
    const params = [];
    let i = 1;
    const add = (v) => { params.push(v); return `$${i++}`; };

    if (q.search) {
      const s = `%${String(q.search).trim()}%`;
      where.push(`(r.ctwa_clid ILIKE ${add(s)} OR r.contact_number ILIKE ${add(s)} OR l.name ILIKE ${add(s)})`);
    }
    if (q.status === 'missing') where.push(`r.ctwa_clid IS NULL`);
    if (q.status === 'present') where.push(`r.ctwa_clid IS NOT NULL`);
    if (q.status === 'sent') where.push(`EXISTS (SELECT 1 FROM coexistence.capi_events e WHERE e.ctwa_clid = r.ctwa_clid AND e.status='sent')`);
    if (q.status === 'duplicate') {
      where.push(`r.ctwa_clid IS NOT NULL AND (
        SELECT COUNT(DISTINCT d.contact_number) FROM coexistence.ctwa_referrals d WHERE d.ctwa_clid = r.ctwa_clid
      ) > 1`);
    }
    const days = parseInt(q.days, 10);
    if (Number.isFinite(days) && days > 0) where.push(`r.clicked_at >= NOW() - (${add(String(days))} || ' days')::interval`);

    const whereSql = where.join(' AND ');

    // One row per CLICK. A person who clicked twice genuinely has two click ids
    // and both are legitimate — collapsing them would hide exactly the detail
    // this view exists to show.
    const [rowsQ, countQ] = await Promise.all([
      pool.query(`
        SELECT r.id, r.ctwa_clid, r.contact_number, r.clicked_at, r.source_id, r.source_type,
               r.platform, r.waba_id, r.lead_id,
               l.name AS lead_name, l.stage AS lead_stage,
               ca.name AS ad_name,
               (SELECT COUNT(DISTINCT d.contact_number) FROM coexistence.ctwa_referrals d
                 WHERE d.ctwa_clid IS NOT NULL AND d.ctwa_clid = r.ctwa_clid)::int AS people_sharing,
               (SELECT COUNT(*) FROM coexistence.ctwa_referrals d
                 WHERE d.ctwa_clid IS NOT NULL AND d.ctwa_clid = r.ctwa_clid)::int AS times_seen,
               ev.status AS last_status, ev.event_name AS last_event, ev.created_at AS last_sent_at,
               ev.match_keys AS last_match_keys, ev.skip_reason AS last_skip_reason, ev.error AS last_error
          FROM coexistence.ctwa_referrals r
          LEFT JOIN coexistence.leads l ON l.id = r.lead_id
          LEFT JOIN coexistence.campaign_ads ca ON ca.ad_external_id = r.source_id
          LEFT JOIN LATERAL (
            SELECT e.status, e.event_name, e.created_at, e.match_keys, e.skip_reason, e.error
              FROM coexistence.capi_events e
             WHERE e.ctwa_clid IS NOT NULL AND e.ctwa_clid = r.ctwa_clid
             ORDER BY e.created_at DESC LIMIT 1
          ) ev ON TRUE
         WHERE ${whereSql}
         ORDER BY r.clicked_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
      pool.query(`
        SELECT COUNT(*)::int AS n
          FROM coexistence.ctwa_referrals r
          LEFT JOIN coexistence.leads l ON l.id = r.lead_id
         WHERE ${whereSql}`, params),
    ]);

    const maxAge = config?.max_click_age_days || 90;
    const rows = rowsQ.rows.map(r => {
      const clid = r.ctwa_clid || null;
      const ageDays = r.clicked_at ? (Date.now() - new Date(r.clicked_at).getTime()) / 86400000 : null;
      const checks = [];

      if (!clid) {
        checks.push({ key: 'present', ok: false, label: 'No click ID',
          detail: 'This conversation did not arrive with a click ID, so Meta cannot be told which ad produced it. Normal for bio links, saved numbers and organic post CTAs.' });
      } else {
        checks.push({ key: 'present', ok: true, label: 'Click ID present' });
        // Meta's ctwa_clid is a long opaque token. A very short value is not a
        // Meta id — it did not come from a real ad tap.
        const shapeOk = clid.length >= 20 && /^[A-Za-z0-9_\-=+/.]+$/.test(clid);
        checks.push({ key: 'shape', ok: shapeOk,
          label: shapeOk ? 'Looks like a Meta token' : 'Unexpected format',
          detail: shapeOk ? undefined : 'Meta click IDs are long opaque strings. This one is not, so it probably did not come from a real ad tap.' });
        const unique = (r.people_sharing || 1) <= 1;
        checks.push({ key: 'unique', ok: unique,
          label: unique ? 'Unique to this person' : `Shared by ${r.people_sharing} people`,
          detail: unique ? undefined : 'The same click ID appearing for different people should not happen from a genuine ad tap.' });
        const inWindow = ageDays != null && ageDays <= maxAge;
        checks.push({ key: 'window', ok: inWindow,
          label: inWindow ? `Within your ${maxAge}-day window` : `Older than your ${maxAge}-day window`,
          detail: inWindow ? undefined : 'Past your attribution window, so a conversion for this click would be skipped rather than credited.' });
      }

      // Meta's own acceptance — the only real proof of authenticity.
      const accepted = r.last_status === 'sent';
      if (r.last_status) {
        checks.push({ key: 'accepted', ok: accepted,
          label: accepted ? 'Meta accepted a conversion for it' : `Last attempt ${r.last_status}`,
          detail: accepted
            ? 'Meta matched this click ID to a real ad click. This is the strongest confirmation available that the ID is genuine.'
            : (r.last_skip_reason || r.last_error || undefined) });
      }

      return {
        id: Number(r.id),
        ctwaClid: clid,
        contactNumber: r.contact_number,
        leadId: r.lead_id ? Number(r.lead_id) : null,
        leadName: r.lead_name,
        leadStage: r.lead_stage,
        clickedAt: r.clicked_at,
        ageDays: ageDays == null ? null : Math.floor(ageDays),
        sourceId: r.source_id,
        sourceType: r.source_type,
        adName: r.ad_name,
        platform: r.platform,
        wabaId: r.waba_id,
        peopleSharing: r.people_sharing || 0,
        timesSeen: r.times_seen || 0,
        lastStatus: r.last_status || null,
        lastEvent: r.last_event || null,
        lastSentAt: r.last_sent_at || null,
        lastMatchKeys: r.last_match_keys || [],
        checks,
        verdict: !clid ? 'no_click_id' : accepted ? 'confirmed' : checks.some(c => !c.ok) ? 'check' : 'unverified',
      };
    });

    res.json({
      rows,
      total: countQ.rows[0]?.n || 0,
      page,
      limit,
      maxClickAgeDays: maxAge,
      note: capi.NOTE_CATALOG.click_id,
    });
  } catch (err) {
    console.error('[capi] click-ids error:', err.message);
    res.status(500).json({ error: 'Failed to load click IDs' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Learning phase — is any ad set actually getting enough conversions?
// ═══════════════════════════════════════════════════════════════════════════
router.get('/capi/learning', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH sent AS (
        SELECT e.event_name, r.source_id, e.created_at
          FROM coexistence.capi_events e
          JOIN coexistence.ctwa_referrals r ON r.ctwa_clid = e.ctwa_clid
         WHERE e.status = 'sent'
           AND e.created_at >= NOW() - INTERVAL '7 days'
      )
      SELECT s.adset_external_id, s.name AS adset_name, s.status, s.optimization_goal,
             c.name AS campaign_name,
             COALESCE(x.event_name, '-')        AS event_name,
             COUNT(x.*)::int                    AS conversions_7d
        FROM coexistence.campaign_adsets s
        LEFT JOIN coexistence.campaigns c ON c.external_id = s.campaign_external_id
        LEFT JOIN coexistence.campaign_ads a ON a.adset_external_id = s.adset_external_id
        LEFT JOIN sent x ON x.source_id = a.ad_external_id
       GROUP BY s.adset_external_id, s.name, s.status, s.optimization_goal, c.name, x.event_name
       ORDER BY conversions_7d DESC, s.name`);

    // Group per ad set: the threshold is per ad set PER EVENT, so an ad set
    // splitting 20 Purchases and 30 Leads is at 20 and 30, not at 50.
    const bySet = new Map();
    for (const r of rows) {
      const key = r.adset_external_id;
      if (!bySet.has(key)) {
        bySet.set(key, {
          adsetExternalId: key, name: r.adset_name, status: r.status,
          optimizationGoal: r.optimization_goal, campaignName: r.campaign_name,
          events: [], total7d: 0,
        });
      }
      const g = bySet.get(key);
      if (r.event_name && r.event_name !== '-' && r.conversions_7d > 0) {
        g.events.push({ eventName: r.event_name, conversions7d: r.conversions_7d });
        g.total7d += r.conversions_7d;
      }
    }

    const target = capi.LEARNING_PHASE.weeklyTarget;
    const adsets = [...bySet.values()].map(g => {
      const best = g.events.reduce((m, e) => (e.conversions7d > (m?.conversions7d || 0) ? e : m), null);
      return {
        ...g,
        strongestEvent: best?.eventName || null,
        strongestCount: best?.conversions7d || 0,
        // Progress is measured on the BEST single event, not the sum — that is
        // what Meta's threshold actually applies to.
        pctOfTarget: Math.min(100, Math.round(((best?.conversions7d || 0) / target) * 100)),
        meetsTarget: (best?.conversions7d || 0) >= target,
      };
    }).sort((a, b) => b.strongestCount - a.strongestCount);

    res.json({
      adsets,
      target,
      windowDays: capi.LEARNING_PHASE.window,
      anyMeeting: adsets.some(a => a.meetsTarget),
      guidance: capi.LEARNING_PHASE,
    });
  } catch (err) {
    console.error('[capi] learning error:', err.message);
    res.status(500).json({ error: 'Failed to load learning-phase data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Before / after — did anything change since conversions started flowing?
// ═══════════════════════════════════════════════════════════════════════════
//
// Deliberately conservative. This is an observational comparison, not a lift
// test: budgets, creatives and seasonality all move at the same time. The
// response therefore ships the caveat with the numbers rather than leaving the
// UI to imply causality, and returns `ready:false` with a reason whenever the
// comparison would be meaningless instead of rendering a confident 0%.
router.get('/capi/performance', adminOnly, async (req, res) => {
  try {
    const config = await loadCapiConfig();
    const boundary = config?.enabled_at || null;

    if (!boundary) {
      return res.json({
        ready: false,
        reason: 'not_enabled_yet',
        message: 'Conversion sending has never been switched on, so there is no "after" period to compare against yet.',
        note: capi.NOTE_CATALOG.performance,
      });
    }

    const afterMs = Date.now() - new Date(boundary).getTime();
    const afterDays = Math.floor(afterMs / 86400000);
    // Compare equal-length windows, capped at 30 days a side. A 3-day "after"
    // against a 30-day "before" is not a comparison.
    const span = Math.max(1, Math.min(30, afterDays || 1));

    const [beforeQ, afterQ, spendCoverQ] = await Promise.all([
      periodStats(new Date(new Date(boundary).getTime() - span * 86400000), new Date(boundary)),
      periodStats(new Date(boundary), new Date()),
      pool.query(`SELECT COUNT(*)::int AS n, MIN(stat_date) AS first_day FROM coexistence.ad_daily_stats`),
    ]);

    const hasDailySpend = (spendCoverQ.rows[0]?.n || 0) > 0;

    res.json({
      ready: afterDays >= 1,
      reason: afterDays < 1 ? 'too_early' : null,
      message: afterDays < 1
        ? 'Conversion sending was switched on less than a day ago. Give it time before comparing — Meta needs enough conversions to leave the learning phase before delivery changes.'
        : null,
      enabledAt: boundary,
      afterDays,
      spanDays: span,
      before: beforeQ,
      after: afterQ,
      // Spend/CPL/ROAS are only honest once daily stats exist; lifetime spend
      // cannot be split across the boundary.
      hasDailySpend,
      spendNote: hasDailySpend
        ? null
        : 'Cost and return are hidden because per-day ad spend has not been synced yet. Lead and enrolment counts below are unaffected.',
      note: capi.NOTE_CATALOG.performance,
      caveat: 'This compares two time periods, it does not prove cause. Budgets, creatives and seasonality change alongside the Conversion API, so treat a difference as a prompt to look closer rather than as proof.',
    });
  } catch (err) {
    console.error('[capi] performance error:', err.message);
    res.status(500).json({ error: 'Failed to load performance comparison' });
  }
});

// Funnel + cost metrics for one window. Clicks/leads/enrolments come from our own
// records; spend comes from ad_daily_stats, which is the only windowed spend we
// have (campaign_ads.spend is a lifetime total and cannot be split by date).
async function periodStats(from, to) {
  const won = cfg.wonStageKeys();
  const wonArr = won.length ? won : ['enrolled'];
  const [q, spendQ] = await Promise.all([
    pool.query(`
      WITH refs AS (
        SELECT * FROM coexistence.ctwa_referrals
         WHERE clicked_at >= $1 AND clicked_at < $2
      ),
      lead_ids AS (SELECT DISTINCT lead_id FROM refs WHERE lead_id IS NOT NULL),
      paid AS (
        SELECT lead_id, SUM(amount_paise)::bigint AS paise FROM (
          SELECT lead_id, amount_paise FROM ( ${RZP_CAPTURED('matched_lead_id IS NOT NULL')} ) rz
          UNION ALL
          SELECT lead_id, amount_paise FROM coexistence.sales_log WHERE lead_id IS NOT NULL
        ) p GROUP BY lead_id
      )
      SELECT (SELECT COUNT(*) FROM refs)::int                                  AS clicks,
             (SELECT COUNT(*) FROM lead_ids)::int                              AS leads,
             (SELECT COUNT(*) FROM lead_ids li JOIN coexistence.leads l ON l.id = li.lead_id
               WHERE l.stage = ANY($3::text[]))::int                           AS enrolled,
             (SELECT COALESCE(SUM(p.paise),0) FROM lead_ids li
                JOIN paid p ON p.lead_id = li.lead_id)::bigint                 AS revenue_paise`,
      [from.toISOString(), to.toISOString(), wonArr]),
    pool.query(`
      SELECT COALESCE(SUM(spend),0)::numeric AS spend,
             COALESCE(SUM(leads),0)::int     AS meta_leads,
             COALESCE(SUM(impressions),0)::bigint AS impressions
        FROM coexistence.ad_daily_stats
       WHERE stat_date >= $1::date AND stat_date < $2::date`,
      [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]),
  ]);

  const r = q.rows[0] || {};
  const s = spendQ.rows[0] || {};
  const spend = Number(s.spend || 0);
  const revenue = paise2r(r.revenue_paise);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    clicks: r.clicks || 0,
    leads: r.leads || 0,
    enrolled: r.enrolled || 0,
    revenue,
    spend: spend || null,
    metaLeads: Number(s.meta_leads || 0),
    impressions: Number(s.impressions || 0),
    costPerLead: spend && r.leads ? spend / r.leads : null,
    costPerEnrolment: spend && r.enrolled ? spend / r.enrolled : null,
    roas: spend ? revenue / spend : null,
    leadToEnrolPct: r.leads ? ((r.enrolled || 0) / r.leads) * 100 : null,
  };
}

module.exports = {
  router,
  ensureCtwaTables,
  recordCtwaReferral,
  linkReferralsToLead,
  sweepStageEvents,
  sendConversionForLead,
  derivePlatform,
};
