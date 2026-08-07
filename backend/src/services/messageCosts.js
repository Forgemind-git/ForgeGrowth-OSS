// Message costs — what we owe Meta, per template and per message type.
//
// ── The two sources, and why BOTH are needed ────────────────────────────────
//
// Meta gives the two halves of the answer in different places and neither alone
// is sufficient:
//
//   1. The `pricing` object on every STATUS webhook says WHICH message was
//      billed and under which category — but carries no amount.
//   2. The WABA's `pricing_analytics` field gives the real COST in rupees —
//      but only aggregated by day/country/category/type, never per template.
//
// So the per-template figure is our own attribution (1) multiplied by a unit
// rate DERIVED from Meta's own numbers (cost / volume in 2), and the dashboard
// shows Meta's total alongside it as the reconciliation check.
//
// ⚠ THE RATE IS DERIVED, NEVER HARDCODED. Measured on this account, the same
// UTILITY category bills at Rs 0.1150 for India and Rs 4.0322 for Germany. A
// single stored rate — the obvious design — would misreport by ~97% the moment
// one international message is sent, and would silently go stale every time
// Meta reprices or a volume tier kicks in.

const pool = require('../db');
const { decrypt } = require('../util/crypto');
const { resolveCountry } = require('../util/callingCodes');
// Kept in a db-free module so it can be unit-tested without opening a pool.
const { PRICED_CTE, BILLED_STATUSES } = require('../util/costSql');

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const SYNC_INTERVAL_MS = parseInt(process.env.PRICING_SYNC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);

async function ensureCostTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.message_billing_events (
      message_id TEXT PRIMARY KEY,
      waba_id TEXT, phone_number_id TEXT, wa_number TEXT, recipient_number TEXT,
      category TEXT, pricing_type TEXT, pricing_model TEXT,
      billable BOOLEAN NOT NULL DEFAULT FALSE,
      recipient_cc TEXT, country_code TEXT,
      message_kind TEXT,
      template_id BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
      template_name TEXT, send_origin TEXT,
      status TEXT, delivered_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, day DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_day ON coexistence.message_billing_events(day DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_template ON coexistence.message_billing_events(template_id, day DESC) WHERE template_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_billing_billable ON coexistence.message_billing_events(day DESC, category) WHERE billable;

    CREATE TABLE IF NOT EXISTS coexistence.waba_pricing_daily (
      waba_id TEXT NOT NULL, day DATE NOT NULL,
      country TEXT NOT NULL DEFAULT '', pricing_category TEXT NOT NULL DEFAULT '',
      pricing_type TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT '',
      volume BIGINT NOT NULL DEFAULT 0, cost NUMERIC(16,6) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'INR',
      last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (waba_id, day, country, pricing_category, pricing_type, tier)
    );
    CREATE INDEX IF NOT EXISTS idx_waba_pricing_day ON coexistence.waba_pricing_daily(day DESC);

    CREATE TABLE IF NOT EXISTS coexistence.waba_pricing_sync (
      waba_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','ok','unauthorized','error')),
      last_error TEXT, last_synced_at TIMESTAMPTZ,
      currency TEXT NOT NULL DEFAULT 'INR',
      phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE coexistence.waba_pricing_sync ADD COLUMN IF NOT EXISTS phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;

    CREATE TABLE IF NOT EXISTS coexistence.whatsapp_rate_fallback (
      id SERIAL PRIMARY KEY,
      country TEXT NOT NULL, category TEXT NOT NULL,
      rate NUMERIC(10,4) NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'INR',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      CONSTRAINT uq_rate_fallback UNIQUE (country, category)
    );

    CREATE TABLE IF NOT EXISTS coexistence.message_cost_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      currency TEXT NOT NULL DEFAULT 'INR',
      tax_percent NUMERIC(6,3) NOT NULL DEFAULT 18.0,
      show_tax BOOLEAN NOT NULL DEFAULT TRUE,
      last_pricing_sync_at TIMESTAMPTZ, backfilled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO coexistence.message_cost_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await pool.query(`
    INSERT INTO coexistence.whatsapp_rate_fallback (country, category, rate, currency) VALUES
      ('IN','marketing',0.8631,'INR'), ('IN','utility',0.1150,'INR'),
      ('IN','authentication',0.1150,'INR'), ('IN','service',0,'INR'),
      ('IN','referral_conversion',0,'INR')
    ON CONFLICT (country, category) DO NOTHING`);
  await pool.query(`ALTER TABLE coexistence.chat_history ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL`).catch(() => {});
  await pool.query(`ALTER TABLE coexistence.chat_history ADD COLUMN IF NOT EXISTS send_origin TEXT`).catch(() => {});
}

// ── Ingestion ───────────────────────────────────────────────────────────────

/**
 * Record one status receipt's pricing.
 *
 * Keyed on the wamid, so the three receipts Meta sends per message (sent /
 * delivered / read) collapse into ONE row. Without that the same message would
 * be counted three times — measured on this account, 165 'delivered' receipts
 * covered only 149 distinct messages even before adding sent and read.
 *
 * The row is only ever upgraded: a later receipt fills in delivered_at and the
 * billable flag, and never downgrades an already-billed message back to unbilled.
 */
async function recordPricing({ messageId, wabaId, phoneNumberId, waNumber, recipientNumber, pricing, status, timestamp }) {
  if (!messageId || !pricing) return null;
  const { cc, country } = resolveCountry(recipientNumber);
  const billedNow = BILLED_STATUSES.has(String(status || '').toLowerCase());
  const billable = pricing.billable === true;
  const day = timestamp ? new Date(timestamp) : new Date();

  const { rows } = await pool.query(
    `INSERT INTO coexistence.message_billing_events
       (message_id, waba_id, phone_number_id, wa_number, recipient_number,
        category, pricing_type, pricing_model, billable, recipient_cc, country_code,
        status, delivered_at, sent_at, day)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $13::boolean THEN $14::timestamptz ELSE NULL END,
             $14::timestamptz, $15::date)
     ON CONFLICT (message_id) DO UPDATE SET
       category      = COALESCE(EXCLUDED.category, coexistence.message_billing_events.category),
       pricing_type  = COALESCE(EXCLUDED.pricing_type, coexistence.message_billing_events.pricing_type),
       pricing_model = COALESCE(EXCLUDED.pricing_type, coexistence.message_billing_events.pricing_model),
       -- billable is sticky-true: once Meta says a message is chargeable, a
       -- later receipt that omits the flag must not un-bill it.
       billable      = coexistence.message_billing_events.billable OR EXCLUDED.billable,
       country_code  = COALESCE(coexistence.message_billing_events.country_code, EXCLUDED.country_code),
       recipient_cc  = COALESCE(coexistence.message_billing_events.recipient_cc, EXCLUDED.recipient_cc),
       delivered_at  = COALESCE(coexistence.message_billing_events.delivered_at, EXCLUDED.delivered_at),
       status        = EXCLUDED.status,
       updated_at    = NOW()
     RETURNING message_id`,
    [messageId, wabaId || null, phoneNumberId || null, waNumber || null, recipientNumber || null,
     (pricing.category || '').toLowerCase() || null,
     (pricing.type || '').toLowerCase() || null,
     pricing.pricing_model || null,
     billable, cc, country, status || null,
     billedNow, day.toISOString(), day.toISOString().slice(0, 10)]
  );
  return rows[0] || null;
}

/**
 * Attach template / message-kind / origin from chat_history.
 *
 * Run as a sweep rather than inline because the outbound row and the status
 * receipt can arrive in either order (a fast 'delivered' can beat markSent's
 * swap of the local id for the wamid). Cheap and idempotent.
 */
async function attributeMessages({ limit = 5000 } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.message_billing_events b
        SET message_kind  = ch.message_type,
            template_id   = ch.template_id,
            template_name = COALESCE(t.name, ch.template_meta->>'name'),
            send_origin   = ch.send_origin,
            updated_at    = NOW()
       FROM coexistence.chat_history ch
       LEFT JOIN coexistence.message_templates t ON t.id = ch.template_id
      WHERE ch.message_id = b.message_id
        AND b.message_id IN (
          SELECT message_id FROM coexistence.message_billing_events
           WHERE message_kind IS NULL OR (template_id IS NULL AND template_name IS NULL)
           ORDER BY day DESC LIMIT $1
        )`,
    [limit]
  );

  // ── Historical recovery: broadcast_logs ────────────────────────────────────
  //
  // chat_history.template_id is stamped at SEND, so it is empty for everything
  // sent before this feature existed. The broadcast log keeps its own
  // wamid -> broadcast -> template chain, which recovers the bulk of that
  // history — measured on this instance, 132 of 168 charged messages.
  //
  // ⚠ There is no equivalent fallback via template_meta->>'name': that key is
  // present on ZERO of the 234 template rows here, because the broadcast and
  // automation writers store only header/footer/buttons. A name lookup would
  // have looked like attribution and silently matched nothing.
  const { rowCount: fromBroadcasts } = await pool.query(
    `UPDATE coexistence.message_billing_events b
        SET template_id   = br.template_id,
            template_name = COALESCE(t.name, b.template_name),
            send_origin   = COALESCE(b.send_origin, 'broadcast'),
            updated_at    = NOW()
       FROM coexistence.broadcast_logs bl
       JOIN coexistence.broadcasts br ON br.id = bl.broadcast_id
       LEFT JOIN coexistence.message_templates t ON t.id = br.template_id
      WHERE bl.wa_message_id = b.message_id
        AND br.template_id IS NOT NULL
        AND b.template_id IS NULL`
  );

  return { attributed: rowCount, fromBroadcasts };
}

/**
 * Recover pricing from the webhook audit log.
 *
 * The `pricing` object has been arriving since this instance went live and was
 * parsed but never stored — status records deliberately never become chat rows,
 * so it survived only inside webhook_events.payload. This walks that blob and
 * replays it through the same upsert the live path uses.
 *
 * The lateral join chain is load-bearing: payload holds the WHOLE webhook body,
 * so without descending entry -> changes -> statuses each row would cross-join
 * with every status in its own payload.
 */
async function backfillFromWebhookEvents({ sinceDays = 400 } = {}) {
  const { rows } = await pool.query(
    `SELECT s->>'id'                                   AS message_id,
            e->>'id'                                   AS waba_id,
            c->'value'->'metadata'->>'phone_number_id' AS phone_number_id,
            c->'value'->'metadata'->>'display_phone_number' AS wa_number,
            s->>'recipient_id'                         AS recipient,
            s->'pricing'                               AS pricing,
            s->>'status'                               AS status,
            s->>'timestamp'                            AS ts
       FROM coexistence.webhook_events w,
            LATERAL jsonb_array_elements(w.payload->'entry') e,
            LATERAL jsonb_array_elements(e->'changes') c,
            LATERAL jsonb_array_elements(c->'value'->'statuses') s
      WHERE w.received_at > NOW() - ($1 || ' days')::interval
        AND s ? 'pricing'
      ORDER BY w.received_at ASC`,
    [String(sinceDays)]
  );

  let processed = 0;
  for (const r of rows) {
    if (!r.message_id) continue;
    await recordPricing({
      messageId: r.message_id,
      wabaId: r.waba_id,
      phoneNumberId: r.phone_number_id,
      waNumber: String(r.wa_number || '').replace(/\D/g, ''),
      recipientNumber: r.recipient,
      pricing: r.pricing,
      status: r.status,
      timestamp: r.ts ? new Date(parseInt(r.ts, 10) * 1000) : null,
    }).catch(() => {});
    processed++;
  }

  const attributed = await attributeMessages({ limit: 100000 });
  const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*)::int AS count FROM coexistence.message_billing_events`);
  await pool.query(`UPDATE coexistence.message_cost_config SET backfilled_at = NOW(), updated_at = NOW() WHERE id = 1`).catch(() => {});
  return { scanned: rows.length, processed, stored: count, ...attributed };
}

// ── Meta pricing_analytics ──────────────────────────────────────────────────

async function metaToken() {
  const { rows } = await pool.query(
    `SELECT access_token_encrypted, status FROM coexistence.meta_ads_config WHERE id = 1`
  ).catch(() => ({ rows: [] }));
  const cfg = rows[0];
  if (!cfg?.access_token_encrypted || cfg.status === 'disconnected') return null;
  try { return decrypt(cfg.access_token_encrypted) || null; } catch { return null; }
}

/**
 * Pull one WABA's real cost.
 *
 * ⚠ start/end are UNIX SECONDS. Passing milliseconds lands tens of thousands of
 * years in the future and Meta returns an EMPTY list rather than an error — the
 * same trap the Razorpay ledger sync documented.
 *
 * Meta's lookback is capped at 90 days.
 */
async function fetchPricingAnalytics(wabaId, token, { days = 30 } = {}) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.min(days, 90) * 86400;
  const field = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY)`
    + `.dimensions(["COUNTRY","PRICING_CATEGORY","PRICING_TYPE","TIER"])`
    + `.metric_types(["COST","VOLUME"])`;
  const url = `${BASE}/${wabaId}?fields=${encodeURIComponent(field)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    const err = new Error(e.message || `Meta API ${res.status}`);
    err.metaCode = e.code;
    // A token that simply cannot read this WABA is a permanent, explainable
    // state — recorded as 'unauthorized' so the dashboard can say "unreadable"
    // instead of reporting this account's spend as zero.
    err.kind = (e.code === 200 || e.code === 10 || /permission/i.test(err.message)) ? 'unauthorized' : 'error';
    throw err;
  }
  return body?.pricing_analytics?.data?.[0]?.data_points || [];
}

/**
 * Every phone number Meta has on a WABA.
 *
 * ⚠ THIS IS WHAT MAKES THE TOTALS EXPLAINABLE. pricing_analytics bills per WABA,
 * but this app can only attribute messages whose status receipt it received —
 * i.e. only the numbers connected here. Measured on a real account, a WABA
 * carrying three numbers with only one connected accounted for the ENTIRE gap
 * between Meta's figure and ours. Without listing them, a correct number looks
 * like a bug.
 *
 * Best-effort: a failure returns [] and the coverage note simply says unknown.
 */
async function fetchWabaNumbers(wabaId, token) {
  try {
    const url = `${BASE}/${wabaId}/phone_numbers?fields=display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) return [];
    return (body.data || []).map(p => ({
      number: String(p.display_phone_number || '').replace(/\D/g, ''),
      display: p.display_phone_number || '',
      name: p.verified_name || null,
    })).filter(p => p.number);
  } catch { return []; }
}

async function syncPricingForWaba(wabaId, token, { days = 30 } = {}) {
  try {
    const points = await fetchPricingAnalytics(wabaId, token, { days });
    let upserted = 0;
    for (const p of points) {
      // Bucket boundaries come back as unix seconds; the day is the START.
      const day = new Date((p.start || 0) * 1000).toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO coexistence.waba_pricing_daily
           (waba_id, day, country, pricing_category, pricing_type, tier, volume, cost, last_fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (waba_id, day, country, pricing_category, pricing_type, tier)
         DO UPDATE SET volume = EXCLUDED.volume, cost = EXCLUDED.cost, last_fetched_at = NOW()`,
        [wabaId, day, p.country || '', (p.pricing_category || '').toLowerCase(),
         (p.pricing_type || '').toLowerCase(), p.tier || '',
         Number(p.volume || 0), Number(p.cost || 0)]
      );
      upserted++;
    }
    const numbers = await fetchWabaNumbers(wabaId, token);
    await pool.query(
      `INSERT INTO coexistence.waba_pricing_sync (waba_id, status, last_error, last_synced_at, phone_numbers, updated_at)
       VALUES ($1,'ok',NULL,NOW(),$2::jsonb,NOW())
       ON CONFLICT (waba_id) DO UPDATE SET status='ok', last_error=NULL, last_synced_at=NOW(),
         -- Keep the last known list if this fetch came back empty, rather than
         -- erasing the explanation on a transient blip.
         phone_numbers = CASE WHEN jsonb_array_length(EXCLUDED.phone_numbers) > 0
                              THEN EXCLUDED.phone_numbers
                              ELSE coexistence.waba_pricing_sync.phone_numbers END,
         updated_at = NOW()`,
      [wabaId, JSON.stringify(numbers)]
    );
    return { wabaId, upserted, status: 'ok', numbers: numbers.length };
  } catch (err) {
    await pool.query(
      `INSERT INTO coexistence.waba_pricing_sync (waba_id, status, last_error, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (waba_id) DO UPDATE SET status=EXCLUDED.status, last_error=EXCLUDED.last_error, updated_at=NOW()`,
      [wabaId, err.kind === 'unauthorized' ? 'unauthorized' : 'error', err.message]
    ).catch(() => {});
    return { wabaId, upserted: 0, status: err.kind || 'error', error: err.message };
  }
}

/** Sync every registered WABA. Idles with zero API calls when Meta is not connected. */
async function syncAllPricing({ days = 30 } = {}) {
  const token = await metaToken();
  if (!token) return { skipped: 'meta_not_connected' };
  const { rows } = await pool.query(
    `SELECT DISTINCT waba_id FROM coexistence.whatsapp_accounts WHERE waba_id IS NOT NULL AND is_active`
  );
  const results = [];
  for (const r of rows) results.push(await syncPricingForWaba(r.waba_id, token, { days }));
  await pool.query(`UPDATE coexistence.message_cost_config SET last_pricing_sync_at = NOW(), updated_at = NOW() WHERE id = 1`).catch(() => {});
  await attributeMessages().catch(() => {});
  return { results };
}

let timer = null;
function startPricingSyncTimer() {
  if (timer) return;
  timer = setInterval(() => {
    syncAllPricing().catch(err => console.error('[messageCosts] sync:', err.message));
  }, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  ensureCostTables,
  recordPricing,
  attributeMessages,
  backfillFromWebhookEvents,
  syncPricingForWaba,
  syncAllPricing,
  fetchPricingAnalytics,
  fetchWabaNumbers,
  startPricingSyncTimer,
  PRICED_CTE,
  BILLED_STATUSES,
};
