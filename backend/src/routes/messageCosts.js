// Message costs — the money side of WhatsApp messaging.
//
// Answers, per period: what we owe Meta in total, which template contributed
// what, how many runs each template had, the average cost per message overall
// and per category, and the same split by message type.
//
// EVERY aggregation below builds on messageCosts.PRICED_CTE, so the per-template
// total and the per-category total can never disagree about what one message
// cost. Same single-source discipline as GROUP_CTE in razorpay.js.
//
// Admin-only throughout: this is billing data.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const costs = require('../services/messageCosts');

const router = Router();

// Default window. 30 days matches Meta's own dashboard and keeps the first
// paint fast; the lookback ceiling is Meta's 90-day pricing_analytics cap.
function range(req) {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from
    || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

// Shared WHERE for every priced query. `day` is the message's own delivery day.
const WINDOW = `WHERE day >= $1::date AND day <= $2::date`;

const n = v => Number(v || 0);
const money = v => Math.round(Number(v || 0) * 10000) / 10000;

// ── Overview ────────────────────────────────────────────────────────────────

router.get('/message-costs/overview', adminOnly, async (req, res) => {
  const { from, to } = range(req);
  try {
    // One query for every headline number — four separate COUNTs can disagree
    // when a receipt lands between them.
    const { rows: [t] } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT COUNT(*)::int                                              AS messages,
              COUNT(*) FILTER (WHERE billable)::int                      AS billable,
              COUNT(*) FILTER (WHERE NOT billable)::int                  AS free,
              COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int      AS delivered,
              COUNT(*) FILTER (WHERE template_id IS NOT NULL)::int       AS template_messages,
              COALESCE(SUM(unit_cost),0)                                 AS cost,
              COUNT(DISTINCT template_id) FILTER (WHERE template_id IS NOT NULL)::int AS templates_used
         FROM priced ${WINDOW}`,
      [from, to]
    );

    // Meta's OWN total for the same window — the reconciliation check. Shown
    // beside our attributed figure rather than instead of it: ours breaks down
    // by template, Meta's is the invoice.
    const { rows: [m] } = await pool.query(
      `SELECT COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(volume),0)::bigint AS volume
         FROM coexistence.waba_pricing_daily
        WHERE day >= $1::date AND day <= $2::date`,
      [from, to]
    );

    // How much of our figure is Meta-confirmed vs estimated from the rate card.
    // Stated explicitly so nobody reads an estimate as an invoice.
    const { rows: sources } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT rate_source, COUNT(*)::int AS messages, COALESCE(SUM(unit_cost),0) AS cost
         FROM priced ${WINDOW} GROUP BY rate_source ORDER BY cost DESC`,
      [from, to]
    );

    // WABAs whose spend cannot be read at all. Reporting these as zero would be
    // a lie the dashboard tells every day — on this instance one of the three
    // numbers returns "Application does not have permission".
    const { rows: syncRows } = await pool.query(
      `SELECT s.waba_id, s.status, s.last_error, s.last_synced_at, s.phone_numbers,
              (SELECT string_agg(DISTINCT wa.display_phone_number, ', ')
                 FROM coexistence.whatsapp_accounts wa WHERE wa.waba_id = s.waba_id) AS numbers,
              -- Numbers Meta bills on this WABA that are NOT connected to this
              -- app. Their spend is inside Meta's total and can never be in ours,
              -- because we never receive their delivery receipts.
              (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
                 FROM jsonb_array_elements(s.phone_numbers) p
                WHERE NOT EXISTS (
                  SELECT 1 FROM coexistence.whatsapp_accounts wa
                   WHERE REPLACE(REPLACE(REPLACE(wa.display_phone_number,'+',''),'-',''),' ','') = p->>'number'
                )) AS unconnected
         FROM coexistence.waba_pricing_sync s ORDER BY s.waba_id`
    );
    const unconnected = syncRows.flatMap(s => (s.unconnected || []).map(p => ({
      wabaId: s.waba_id, number: p.display || p.number, name: p.name || null,
    })));

    const { rows: [cfg] } = await pool.query(`SELECT * FROM coexistence.message_cost_config WHERE id = 1`);
    const cost = n(t.cost);
    const taxPercent = n(cfg?.tax_percent);

    res.json({
      from, to,
      messages: n(t.messages),
      billable: n(t.billable),
      free: n(t.free),
      delivered: n(t.delivered),
      templateMessages: n(t.template_messages),
      templatesUsed: n(t.templates_used),
      cost: money(cost),
      // GST is shown as its own line, never folded into the per-message cost —
      // that keeps our figures directly comparable with pricing_analytics, which
      // reports pre-tax.
      tax: cfg?.show_tax ? money(cost * taxPercent / 100) : 0,
      taxPercent,
      totalWithTax: cfg?.show_tax ? money(cost * (1 + taxPercent / 100)) : money(cost),
      // Average across BILLABLE messages only. Dividing by all messages would
      // report a misleadingly tiny per-message cost, since most traffic here is
      // free service-window replies.
      avgPerBillable: n(t.billable) ? money(cost / n(t.billable)) : 0,
      avgPerMessage: n(t.messages) ? money(cost / n(t.messages)) : 0,
      metaReportedCost: money(m.cost),
      metaReportedVolume: n(m.volume),
      rateSources: sources.map(s => ({ source: s.rate_source, messages: n(s.messages), cost: money(s.cost) })),
      wabaSync: syncRows.map(s => ({
        wabaId: s.waba_id, status: s.status, lastError: s.last_error,
        lastSyncedAt: s.last_synced_at, numbers: s.numbers,
        unconnected: (s.unconnected || []).map(p => p.display || p.number),
      })),
      // Why Meta's total can legitimately exceed ours. Two independent reasons,
      // both real on this instance, and both invisible without saying so:
      //   1. a WABA whose spend the token cannot read at all
      //   2. numbers on a billed WABA that are not connected to this app
      // Presenting the two totals side by side without this note makes a correct
      // number look like a bug.
      coverage: {
        unreadableWabas: syncRows.filter(s => s.status === 'unauthorized').map(s => s.waba_id),
        unconnectedNumbers: unconnected,
        gap: money(n(m.cost) - cost),
      },
      currency: cfg?.currency || 'INR',
      lastPricingSyncAt: cfg?.last_pricing_sync_at || null,
      backfilledAt: cfg?.backfilled_at || null,
    });
  } catch (err) {
    console.error('[message-costs] overview error:', err.message);
    res.status(500).json({ error: 'Could not load message costs.' });
  }
});

// ── Per template ────────────────────────────────────────────────────────────
//
// "Which template contributed, how much each cost, how many runs, average cost."
//
// Groups on COALESCE(template name, id) so a template deleted since it was sent
// still reports its historical cost instead of vanishing into an "unknown"
// bucket — the snapshot name on the billing row is what makes that possible.

router.get('/message-costs/templates', adminOnly, async (req, res) => {
  const { from, to } = range(req);
  try {
    const { rows } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT p.template_id,
              COALESCE(t.name, p.template_name, '(not a template)') AS name,
              MAX(t.category)                                        AS template_category,
              MAX(t.status)                                          AS template_status,
              MAX(p.category)                                        AS pricing_category,
              COUNT(*)::int                                          AS runs,
              COUNT(*) FILTER (WHERE p.billable)::int                 AS billable_runs,
              COUNT(*) FILTER (WHERE p.delivered_at IS NOT NULL)::int AS delivered,
              COUNT(DISTINCT p.recipient_number)::int                 AS recipients,
              COALESCE(SUM(p.unit_cost),0)                            AS cost,
              MAX(p.day)                                              AS last_sent
         FROM priced p
         LEFT JOIN coexistence.message_templates t ON t.id = p.template_id
         ${WINDOW.replace(/day/g, 'p.day')}
        GROUP BY p.template_id, COALESCE(t.name, p.template_name, '(not a template)')
        ORDER BY cost DESC, runs DESC`,
      [from, to]
    );
    res.json({
      from, to,
      templates: rows.map(r => ({
        templateId: r.template_id == null ? null : Number(r.template_id),
        name: r.name,
        templateCategory: r.template_category || null,
        templateStatus: r.template_status || null,
        pricingCategory: r.pricing_category || null,
        runs: n(r.runs),
        billableRuns: n(r.billable_runs),
        delivered: n(r.delivered),
        recipients: n(r.recipients),
        cost: money(r.cost),
        // Per-run average across ALL runs of this template — the number that
        // answers "what does sending this one cost me?", free sends included,
        // because a template that often lands inside the service window really
        // is cheaper to use.
        avgCost: n(r.runs) ? money(n(r.cost) / n(r.runs)) : 0,
        avgCostBillable: n(r.billable_runs) ? money(n(r.cost) / n(r.billable_runs)) : 0,
        lastSent: r.last_sent,
      })),
    });
  } catch (err) {
    console.error('[message-costs] templates error:', err.message);
    res.status(500).json({ error: 'Could not load per-template costs.' });
  }
});

// ── Breakdowns ──────────────────────────────────────────────────────────────

const BREAKDOWNS = {
  // Meta's billing category — what actually determines the rate.
  category: { col: 'COALESCE(category, \'unknown\')', label: 'category' },
  // How the message was composed (template / text / image / interactive …).
  type: { col: 'COALESCE(message_kind, \'unknown\')', label: 'messageType' },
  // Which subsystem sent it.
  origin: { col: 'COALESCE(send_origin, \'unattributed\')', label: 'origin' },
  // Which business number it went out on.
  number: { col: 'COALESCE(wa_number, \'unknown\')', label: 'waNumber' },
  // Free vs paid reason (regular / free_customer_service / free_entry_point).
  pricingType: { col: 'COALESCE(pricing_type, \'unknown\')', label: 'pricingType' },
  country: { col: 'COALESCE(country_code, \'unknown\')', label: 'country' },
};

router.get('/message-costs/breakdown', adminOnly, async (req, res) => {
  const { from, to } = range(req);
  // Whitelist lookup — the query string never reaches the SQL.
  const spec = BREAKDOWNS[req.query.by] || BREAKDOWNS.category;
  try {
    const { rows } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT ${spec.col} AS bucket,
              COUNT(*)::int                          AS messages,
              COUNT(*) FILTER (WHERE billable)::int  AS billable,
              COALESCE(SUM(unit_cost),0)             AS cost
         FROM priced ${WINDOW}
        GROUP BY 1 ORDER BY cost DESC, messages DESC`,
      [from, to]
    );
    res.json({
      from, to, by: req.query.by || 'category', label: spec.label,
      rows: rows.map(r => ({
        bucket: r.bucket,
        messages: n(r.messages),
        billable: n(r.billable),
        cost: money(r.cost),
        avgCost: n(r.messages) ? money(n(r.cost) / n(r.messages)) : 0,
      })),
    });
  } catch (err) {
    console.error('[message-costs] breakdown error:', err.message);
    res.status(500).json({ error: 'Could not load that breakdown.' });
  }
});

router.get('/message-costs/trend', adminOnly, async (req, res) => {
  const { from, to } = range(req);
  try {
    const { rows } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT day,
              COUNT(*)::int                         AS messages,
              COUNT(*) FILTER (WHERE billable)::int AS billable,
              COALESCE(SUM(unit_cost),0)            AS cost
         FROM priced ${WINDOW}
        GROUP BY day ORDER BY day ASC`,
      [from, to]
    );
    res.json({
      from, to,
      days: rows.map(r => ({
        day: r.day, messages: n(r.messages), billable: n(r.billable), cost: money(r.cost),
      })),
    });
  } catch (err) {
    console.error('[message-costs] trend error:', err.message);
    res.status(500).json({ error: 'Could not load the cost trend.' });
  }
});

// One template's own detail: its daily cost line and its category mix.
router.get('/message-costs/templates/:id', adminOnly, async (req, res) => {
  const { from, to } = range(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Template not found.' });
  try {
    const { rows: days } = await pool.query(
      `${costs.PRICED_CTE}
       SELECT day, COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE billable)::int AS billable,
              COALESCE(SUM(unit_cost),0) AS cost
         FROM priced ${WINDOW} AND template_id = $3
        GROUP BY day ORDER BY day ASC`,
      [from, to, id]
    );
    const { rows: [tpl] } = await pool.query(
      `SELECT id, name, category, language, status FROM coexistence.message_templates WHERE id = $1`, [id]
    );
    res.json({
      from, to,
      template: tpl ? { id: Number(tpl.id), name: tpl.name, category: tpl.category, language: tpl.language, status: tpl.status } : null,
      days: days.map(r => ({ day: r.day, runs: n(r.runs), billable: n(r.billable), cost: money(r.cost) })),
    });
  } catch (err) {
    console.error('[message-costs] template detail error:', err.message);
    res.status(500).json({ error: 'Could not load that template.' });
  }
});

// ── Config + rate card + sync ───────────────────────────────────────────────

router.get('/message-costs/config', adminOnly, async (req, res) => {
  try {
    const { rows: [cfg] } = await pool.query(`SELECT * FROM coexistence.message_cost_config WHERE id = 1`);
    const { rows: rates } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_rate_fallback ORDER BY country, category`
    );
    const { rows: sync } = await pool.query(
      `SELECT s.*, (SELECT string_agg(DISTINCT wa.display_phone_number, ', ')
                      FROM coexistence.whatsapp_accounts wa WHERE wa.waba_id = s.waba_id) AS numbers
         FROM coexistence.waba_pricing_sync s ORDER BY s.waba_id`
    );
    res.json({
      config: {
        currency: cfg?.currency || 'INR',
        taxPercent: n(cfg?.tax_percent),
        showTax: cfg?.show_tax !== false,
        lastPricingSyncAt: cfg?.last_pricing_sync_at || null,
        backfilledAt: cfg?.backfilled_at || null,
      },
      rates: rates.map(r => ({
        id: Number(r.id), country: r.country, category: r.category,
        rate: Number(r.rate), currency: r.currency, updatedAt: r.updated_at,
      })),
      wabaSync: sync.map(s => ({
        wabaId: s.waba_id, status: s.status, lastError: s.last_error,
        lastSyncedAt: s.last_synced_at, numbers: s.numbers,
      })),
    });
  } catch (err) {
    console.error('[message-costs] config error:', err.message);
    res.status(500).json({ error: 'Could not load the cost settings.' });
  }
});

router.put('/message-costs/config', adminOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const tax = b.taxPercent === undefined ? null : Number(b.taxPercent);
    if (tax !== null && (!Number.isFinite(tax) || tax < 0 || tax > 100)) {
      return res.status(400).json({ error: 'Tax must be a percentage between 0 and 100.' });
    }
    await pool.query(
      `UPDATE coexistence.message_cost_config
          SET tax_percent = COALESCE($1, tax_percent),
              show_tax    = COALESCE($2, show_tax),
              currency    = COALESCE($3, currency),
              updated_at  = NOW()
        WHERE id = 1`,
      [tax, b.showTax === undefined ? null : Boolean(b.showTax), b.currency || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[message-costs] config save error:', err.message);
    res.status(500).json({ error: 'Could not save the cost settings.' });
  }
});

// The fallback rate card. Editable, but only ever used for buckets Meta has not
// reported yet — the UI says so, because someone editing this expecting it to
// change historical figures would be misled.
router.put('/message-costs/rates/:id', adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rate = Number(req.body?.rate);
  if (!Number.isFinite(id)) return res.status(404).json({ error: 'Rate not found.' });
  if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'The rate must be a number of rupees per message.' });
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.whatsapp_rate_fallback
          SET rate = $2, updated_at = NOW(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [id, rate, req.user?.id || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rate not found.' });
    res.json({ ok: true, rate: Number(rows[0].rate) });
  } catch (err) {
    console.error('[message-costs] rate save error:', err.message);
    res.status(500).json({ error: 'Could not save that rate.' });
  }
});

router.post('/message-costs/rates', adminOnly, async (req, res) => {
  const country = String(req.body?.country || '').trim().toUpperCase();
  const category = String(req.body?.category || '').trim().toLowerCase();
  const rate = Number(req.body?.rate);
  if (!country || country.length !== 2) return res.status(400).json({ error: 'Country must be a 2-letter code, e.g. IN.' });
  if (!category) return res.status(400).json({ error: 'A category is required.' });
  if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'The rate must be a number of rupees per message.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.whatsapp_rate_fallback (country, category, rate, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (country, category) DO UPDATE SET rate = EXCLUDED.rate, updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [country, category, rate, req.user?.id || null]
    );
    res.status(201).json({ id: Number(rows[0].id), country, category, rate: Number(rows[0].rate) });
  } catch (err) {
    console.error('[message-costs] rate create error:', err.message);
    res.status(500).json({ error: 'Could not save that rate.' });
  }
});

router.post('/message-costs/sync', adminOnly, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days, 10) || 30, 90);
    const result = await costs.syncAllPricing({ days });
    if (result.skipped) {
      return res.status(400).json({ error: 'Meta is not connected. Connect it in Admin Settings -> Integrations.' });
    }
    res.json(result);
  } catch (err) {
    console.error('[message-costs] sync error:', err.message);
    res.status(500).json({ error: 'Could not sync pricing from Meta.' });
  }
});

// Recover pricing that arrived before this feature existed. Idempotent — the
// billing table is keyed on the wamid, so re-running only fills gaps.
router.post('/message-costs/backfill', adminOnly, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days, 10) || 400, 1000);
    const result = await costs.backfillFromWebhookEvents({ sinceDays: days });
    res.json(result);
  } catch (err) {
    console.error('[message-costs] backfill error:', err.message);
    res.status(500).json({ error: 'Could not backfill message costs.' });
  }
});

module.exports = { router, ensureCostTables: costs.ensureCostTables };
