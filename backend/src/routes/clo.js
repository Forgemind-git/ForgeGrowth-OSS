// Conversion Leads Optimisation (CLO) — settings + funnel-stage configuration.
//
// CLO is a Meta Ads performance goal fed by down-funnel CRM stage data sent over
// the Conversions API, so delivery optimises toward leads that become customers
// rather than leads that merely fill a form.
//
// ⚠ SEPARATE from the read-only CTWA attribution in routes/ctwa.js. Different
// action_source ('system_generated'), different identifier (Meta lead id),
// different window (28 days), and a different dataset. Nothing in ctwa.js reads
// clo_* tables.
//
// ⚠ CLO only works with Facebook/Instagram Lead Ads (Instant Forms). It does not
// work with Click-to-WhatsApp.
//
// Mounted under /api with authMiddleware in index.js. Every route is adminOnly —
// the same guard as other Marketing-tab admin settings.
//
//   GET/PUT             /marketing/clo/settings
//   GET/POST            /marketing/clo/stages
//   PUT/DELETE          /marketing/clo/stages/:id
//   PUT                 /marketing/clo/stages/reorder
//
// Later steps add: /test-event, /flush, /events, /readiness, /stage-stats.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const { encrypt } = require('../util/crypto');
const cfg = require('../services/funnelConfig');

const router = Router();

// Meta's attribution window for CRM events. Anything older is dropped by Meta,
// so the dispatcher skips rather than back-dates.
const CLO_WINDOW_DAYS = 28;

// Mirrors migration 077 so a fresh deploy self-heals without a manual psql run.
async function ensureCloTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.clo_funnel_stages (
      id                     BIGSERIAL PRIMARY KEY,
      stage_key              TEXT NOT NULL,
      event_name             TEXT NOT NULL,
      display_name           TEXT NOT NULL,
      sort_order             INT  NOT NULL DEFAULT 0,
      crm_status_values      JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_optimisation_target BOOLEAN NOT NULL DEFAULT FALSE,
      active                 BOOLEAN NOT NULL DEFAULT TRUE,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_stage_key ON coexistence.clo_funnel_stages(stage_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clo_stage_order ON coexistence.clo_funnel_stages(sort_order)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_single_target
    ON coexistence.clo_funnel_stages((is_optimisation_target)) WHERE is_optimisation_target`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.clo_settings (
      id                     INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled                BOOLEAN NOT NULL DEFAULT FALSE,
      dataset_id             TEXT,
      access_token_encrypted TEXT,
      lead_event_source      TEXT NOT NULL DEFAULT 'Forge Growth',
      graph_api_version      TEXT NOT NULL DEFAULT 'v21.0',
      test_event_code        TEXT,
      dry_run                BOOLEAN NOT NULL DEFAULT TRUE,
      last_event_id          BIGINT NOT NULL DEFAULT 0,
      last_flush_at          TIMESTAMPTZ,
      last_flush_error       TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Migration 078 — the readiness check needs to know whether Meta actually
  // accepted a test event, not merely that a dataset id was typed in.
  await pool.query(`ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_event_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_ok       BOOLEAN`);
  await pool.query(`ALTER TABLE coexistence.clo_settings ADD COLUMN IF NOT EXISTS last_test_error    TEXT`);
  await pool.query(`INSERT INTO coexistence.clo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.clo_events (
      id            BIGSERIAL PRIMARY KEY,
      lead_id       BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      meta_lead_id  TEXT,
      stage_id      BIGINT REFERENCES coexistence.clo_funnel_stages(id) ON DELETE CASCADE,
      event_name    TEXT NOT NULL,
      event_time    TIMESTAMPTZ NOT NULL,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','failed','skipped_duplicate',
                                        'skipped_out_of_window','skipped_no_identifier','dry_run')),
      attempts      INT NOT NULL DEFAULT 0,
      last_error    TEXT,
      meta_response JSONB,
      fbtrace_id    TEXT,
      sent_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_events_sent
    ON coexistence.clo_events(lead_id, stage_id) WHERE status = 'sent'`);
  // Migration 079 — also bars a SECOND pending row for the same pair. Two of
  // them in one flush batch would both try to become 'sent', the unique index
  // would reject the statement, and the whole batch would fail.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_clo_events_active
    ON coexistence.clo_events(lead_id, stage_id) WHERE status IN ('sent', 'pending')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clo_events_status  ON coexistence.clo_events(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clo_events_created ON coexistence.clo_events(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clo_events_lead    ON coexistence.clo_events(lead_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clo_events_pending
    ON coexistence.clo_events(created_at) WHERE status = 'pending'`);

  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_lead_id         TEXT`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_lead_created_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_ad_id           TEXT`);
  await pool.query(`ALTER TABLE coexistence.leads ADD COLUMN IF NOT EXISTS meta_campaign_id     TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_meta_lead_id
    ON coexistence.leads(meta_lead_id) WHERE meta_lead_id IS NOT NULL`);
}

async function loadCloSettings() {
  const { rows } = await pool.query(`SELECT * FROM coexistence.clo_settings WHERE id = 1`);
  return rows[0] || null;
}

// The token is never included. `tokenConfigured` is the only thing the UI needs
// to render a connected/not-configured indicator.
function settingsShape(s, optimisationStageId) {
  if (!s) return null;
  return {
    enabled: s.enabled,
    datasetId: s.dataset_id || '',
    tokenConfigured: !!s.access_token_encrypted,
    leadEventSource: s.lead_event_source,
    graphApiVersion: s.graph_api_version,
    testEventCode: s.test_event_code || '',
    dryRun: s.dry_run,
    lastEventId: Number(s.last_event_id || 0),
    lastFlushAt: s.last_flush_at,
    lastFlushError: s.last_flush_error,
    // Derived from clo_funnel_stages.is_optimisation_target rather than stored a
    // second time — one fact, one home.
    optimisationStageId: optimisationStageId == null ? null : Number(optimisationStageId),
    windowDays: CLO_WINDOW_DAYS,
  };
}

function stageRow(r) {
  return {
    id: Number(r.id),
    stageKey: r.stage_key,
    eventName: r.event_name,
    displayName: r.display_name,
    sortOrder: r.sort_order,
    crmStatusValues: Array.isArray(r.crm_status_values) ? r.crm_status_values : [],
    isOptimisationTarget: r.is_optimisation_target,
    active: r.active,
    sentCount: r.sent_count == null ? 0 : Number(r.sent_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function currentTargetId() {
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.clo_funnel_stages WHERE is_optimisation_target LIMIT 1`);
  return rows[0]?.id ?? null;
}

// ── settings ────────────────────────────────────────────────────────────────
router.get('/marketing/clo/settings', adminOnly, async (req, res) => {
  try {
    const s = await loadCloSettings();
    res.json({
      settings: settingsShape(s, await currentTargetId()),
      // The statuses a stage can map to are this app's own funnel stage keys —
      // read live so a rename in Funnel Settings shows up here immediately.
      crmStatusOptions: cfg.stages().map(x => ({ value: x.stageKey, label: x.label })),
    });
  } catch (err) {
    console.error('[clo] settings error:', err.message);
    res.status(500).json({ error: 'Failed to load Conversion Leads Optimisation settings' });
  }
});

router.put('/marketing/clo/settings', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;

    if (typeof b.enabled === 'boolean') { fields.push(`enabled = $${i++}`); vals.push(b.enabled); }
    if (typeof b.dryRun === 'boolean') { fields.push(`dry_run = $${i++}`); vals.push(b.dryRun); }
    if (b.datasetId !== undefined) {
      const v = String(b.datasetId || '').trim();
      // A dataset id is numeric; catching a pasted pixel NAME here is far kinder
      // than every event failing later with an opaque Meta error.
      if (v && !/^\d{5,}$/.test(v)) {
        return res.status(400).json({ error: 'A dataset ID is the numeric ID from Events Manager, not a name.' });
      }
      fields.push(`dataset_id = $${i++}`); vals.push(v || null);
    }
    if (b.leadEventSource !== undefined) {
      const v = String(b.leadEventSource || '').trim();
      // Meta requires a non-empty lead_event_source on every CRM event.
      if (!v) return res.status(400).json({ error: 'Lead event source cannot be empty — Meta requires it on every CRM event.' });
      fields.push(`lead_event_source = $${i++}`); vals.push(v);
    }
    if (b.graphApiVersion !== undefined) {
      const v = String(b.graphApiVersion || '').trim();
      if (v && !/^v\d+\.\d+$/.test(v)) return res.status(400).json({ error: 'Graph API version looks like v21.0.' });
      fields.push(`graph_api_version = $${i++}`); vals.push(v || 'v21.0');
    }
    if (b.testEventCode !== undefined) {
      fields.push(`test_event_code = $${i++}`); vals.push(String(b.testEventCode || '').trim() || null);
    }
    // Write-only: accepted here, never read back out.
    if (b.accessToken !== undefined) {
      const t = String(b.accessToken || '').trim();
      fields.push(`access_token_encrypted = $${i++}`); vals.push(t ? encrypt(t) : null);
    }

    if (!fields.length) {
      const s = await loadCloSettings();
      return res.json({ settings: settingsShape(s, await currentTargetId()) });
    }

    const { rows } = await pool.query(
      `UPDATE coexistence.clo_settings SET ${fields.join(', ')}, updated_at = NOW() WHERE id = 1 RETURNING *`, vals);
    res.json({ settings: settingsShape(rows[0], await currentTargetId()) });
  } catch (err) {
    console.error('[clo] update settings error:', err.message);
    res.status(500).json({ error: 'Failed to save Conversion Leads Optimisation settings' });
  }
});

// ── stages ──────────────────────────────────────────────────────────────────
router.get('/marketing/clo/stages', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, (SELECT COUNT(*) FROM coexistence.clo_events e
                    WHERE e.stage_id = s.id AND e.status = 'sent')::int AS sent_count
        FROM coexistence.clo_funnel_stages s
       ORDER BY s.sort_order, s.id`);
    res.json({ stages: rows.map(stageRow) });
  } catch (err) {
    console.error('[clo] stages list error:', err.message);
    res.status(500).json({ error: 'Failed to load CLO funnel stages' });
  }
});

// Shared validation. `existing` is the row being updated, if any — used to allow
// a stage to keep its own key without tripping the uniqueness check.
async function validateStage(b, existing) {
  const displayName = String(b.displayName || '').trim();
  if (!displayName) return { error: 'A display name is required' };

  const eventName = String(b.eventName || '').trim();
  // event_name is matched by exact string against the funnel configured in Meta.
  // A space or a stray character means Meta silently ignores the event, which
  // looks identical to it never being sent.
  if (!eventName) return { error: 'An event name is required — it must match the stage name in your Meta funnel exactly.' };
  if (!/^[A-Za-z0-9_]+$/.test(eventName)) {
    return { error: 'Event name may only contain letters, numbers and underscores, and must match your Meta funnel exactly.' };
  }

  const stageKey = String(b.stageKey || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!stageKey) return { error: 'A stage key is required' };

  const dup = await pool.query(
    `SELECT id FROM coexistence.clo_funnel_stages WHERE stage_key = $1 AND id <> $2`,
    [stageKey, existing?.id || 0]);
  if (dup.rows.length) return { error: `Stage key “${stageKey}” is already used by another stage.` };

  // Statuses must be real Forge Growth funnel keys, or the mapping can never fire.
  const raw = Array.isArray(b.crmStatusValues) ? b.crmStatusValues : [];
  const valid = new Set(cfg.stageKeys());
  const bad = raw.filter(v => !valid.has(v));
  if (bad.length) return { error: `Not a Forge Growth lead status: ${bad.join(', ')}` };

  return {
    stageKey,
    eventName,
    displayName,
    crmStatusValues: [...new Set(raw)],
    active: b.active !== false,
    sortOrder: Number.isFinite(parseInt(b.sortOrder, 10)) ? parseInt(b.sortOrder, 10) : null,
  };
}

router.post('/marketing/clo/stages', adminOnly, async (req, res) => {
  try {
    const v = await validateStage(req.body || {}, null);
    if (v.error) return res.status(400).json({ error: v.error });

    const { rows: maxRow } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM coexistence.clo_funnel_stages`);
    const order = v.sortOrder != null ? v.sortOrder : maxRow[0].next;

    const { rows } = await pool.query(
      `INSERT INTO coexistence.clo_funnel_stages
         (stage_key, event_name, display_name, sort_order, crm_status_values, active)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [v.stageKey, v.eventName, v.displayName, order, JSON.stringify(v.crmStatusValues), v.active]);
    res.status(201).json({ stage: stageRow(rows[0]) });
  } catch (err) {
    console.error('[clo] stage create error:', err.message);
    res.status(500).json({ error: 'Failed to create the stage' });
  }
});

router.put('/marketing/clo/stages/:id', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: cur } = await client.query(`SELECT * FROM coexistence.clo_funnel_stages WHERE id = $1`, [id]);
    if (!cur.length) return res.status(404).json({ error: 'Stage not found' });
    const existing = cur[0];

    const b = req.body || {};
    const v = await validateStage({ ...existing, ...toCamel(existing), ...b }, existing);
    if (v.error) return res.status(400).json({ error: v.error });

    // Changing a stage_key that already has sent events orphans them: Meta keeps
    // matching on the OLD event_name, so history and future events land in
    // different buckets. Refuse unless the caller acknowledges it.
    const { rows: sentRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.clo_events WHERE stage_id = $1 AND status = 'sent'`, [id]);
    const sent = sentRows[0].n;
    const keyChanged = v.stageKey !== existing.stage_key || v.eventName !== existing.event_name;
    if (sent > 0 && keyChanged && b.confirmKeyChange !== true) {
      return res.status(409).json({
        error: `This stage has already sent ${sent} event${sent === 1 ? '' : 's'} to Meta as “${existing.event_name}”. `
             + 'Changing its name splits the history — Meta will treat the new name as a different stage. '
             + 'Re-send with confirmKeyChange to proceed.',
        needsConfirm: true, sentCount: sent,
      });
    }

    await client.query('BEGIN');
    // At most one target, enforced by a partial unique index — clear the old one
    // inside the same transaction or the index rejects the write.
    if (b.isOptimisationTarget === true) {
      await client.query(`UPDATE coexistence.clo_funnel_stages SET is_optimisation_target = FALSE WHERE is_optimisation_target AND id <> $1`, [id]);
    }
    const { rows } = await client.query(
      `UPDATE coexistence.clo_funnel_stages
          SET stage_key = $1, event_name = $2, display_name = $3, crm_status_values = $4::jsonb,
              active = $5,
              is_optimisation_target = COALESCE($6, is_optimisation_target),
              sort_order = COALESCE($7, sort_order),
              updated_at = NOW()
        WHERE id = $8 RETURNING *`,
      [v.stageKey, v.eventName, v.displayName, JSON.stringify(v.crmStatusValues), v.active,
       typeof b.isOptimisationTarget === 'boolean' ? b.isOptimisationTarget : null,
       v.sortOrder, id]);
    await client.query('COMMIT');
    res.json({ stage: stageRow(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[clo] stage update error:', err.message);
    res.status(500).json({ error: 'Failed to update the stage' });
  } finally {
    client.release();
  }
});

router.delete('/marketing/clo/stages/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.clo_events WHERE stage_id = $1 AND status = 'sent'`, [id]);
    // Deleting cascades its events, which would erase the record of what was
    // already reported to Meta. Deactivating keeps the audit trail intact.
    if (rows[0].n > 0) {
      return res.status(409).json({
        error: `This stage has ${rows[0].n} event${rows[0].n === 1 ? '' : 's'} already sent to Meta. `
             + 'Switch it off instead of deleting, so the record of what was reported survives.',
      });
    }
    const del = await pool.query(`DELETE FROM coexistence.clo_funnel_stages WHERE id = $1`, [id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Stage not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[clo] stage delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the stage' });
  }
});

router.put('/marketing/clo/stages/reorder', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!ids.length) return res.status(400).json({ error: 'An ordered list of stage IDs is required' });
    await client.query('BEGIN');
    for (let idx = 0; idx < ids.length; idx++) {
      await client.query(`UPDATE coexistence.clo_funnel_stages SET sort_order = $1, updated_at = NOW() WHERE id = $2`, [idx, ids[idx]]);
    }
    await client.query('COMMIT');
    const { rows } = await client.query(`SELECT * FROM coexistence.clo_funnel_stages ORDER BY sort_order, id`);
    res.json({ stages: rows.map(stageRow) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[clo] stage reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder stages' });
  } finally {
    client.release();
  }
});

// ── per-stage statistics ────────────────────────────────────────────────────
//
// The three numbers Meta's eligibility criteria are actually about:
//   conversionRate   what fraction of leads ever reach this rung
//   medianDaysTo     how long it typically takes (vs the 28-day window)
//   volume30d        whether there is enough of it for Meta to learn from
//
// The cohort is leads CREATED in the last 90 days, not all leads ever. A rate
// computed over all history flatters a stage that used to be common and starves
// a new one, and leads created yesterday have not had time to convert — 90 days
// gives every lead in the cohort a full 28-day window to reach the stage plus
// room to spare.
const STATS_COHORT_DAYS = 90;

// A lead has "reached" a stage if it ever transitioned into one of the mapped
// statuses, OR it currently sits in one. The second half matters: a lead created
// directly at a stage never emits a stage_changed row, and counting only
// transitions would silently under-report every such lead.
const REACHED_SQL = `
  reached AS (
    SELECT l.id AS lead_id, l.created_at,
           MIN(COALESCE(ev.ts, l.stage_changed_at, l.created_at)) AS reached_at
      FROM cohort l
      LEFT JOIN coexistence.lead_events ev
        ON ev.lead_id = l.id
       AND ev.event_type = 'stage_changed'
       AND ev.to_value = ANY($1::text[])
     WHERE ev.id IS NOT NULL OR l.stage = ANY($1::text[])
     GROUP BY l.id, l.created_at
  )`;

router.get('/marketing/clo/stage-stats', adminOnly, async (req, res) => {
  try {
    const { rows: stages } = await pool.query(
      `SELECT * FROM coexistence.clo_funnel_stages ORDER BY sort_order, id`);

    const { rows: cohortRow } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.leads
        WHERE created_at >= NOW() - ($1 || ' days')::interval`, [String(STATS_COHORT_DAYS)]);
    const cohort = cohortRow[0].n;

    const stats = [];
    for (const s of stages) {
      const statuses = Array.isArray(s.crm_status_values) ? s.crm_status_values : [];
      if (!statuses.length) {
        stats.push({ stageId: Number(s.id), cohort, reached: 0, conversionRate: null, medianDaysToReach: null, volume30d: 0, unmapped: true });
        continue;
      }
      const { rows } = await pool.query(`
        WITH cohort AS (
          SELECT * FROM coexistence.leads WHERE created_at >= NOW() - '${STATS_COHORT_DAYS} days'::interval
        ), ${REACHED_SQL}
        SELECT COUNT(*)::int AS reached,
               COUNT(*) FILTER (WHERE reached_at >= NOW() - INTERVAL '30 days')::int AS volume_30d,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (reached_at - created_at)) / 86400
               ) AS median_days
          FROM reached`, [statuses]);
      const r = rows[0] || {};
      stats.push({
        stageId: Number(s.id),
        cohort,
        reached: r.reached || 0,
        conversionRate: cohort ? (r.reached / cohort) * 100 : null,
        medianDaysToReach: r.median_days == null ? null : Number(r.median_days),
        volume30d: r.volume_30d || 0,
        unmapped: false,
      });
    }

    // Leads per month, for Meta's >= 200/month bar. Measured over the cohort so
    // a quiet last-7-days does not read as a collapse.
    const perMonth = cohort ? Math.round((cohort / STATS_COHORT_DAYS) * 30) : 0;

    res.json({
      stats,
      cohortDays: STATS_COHORT_DAYS,
      cohortLeads: cohort,
      leadsPerMonth: perMonth,
      windowDays: CLO_WINDOW_DAYS,
      // The bands the UI colours against — served so the thresholds live in one
      // place rather than being restated in the frontend.
      bands: { minRate: 1, maxRate: 40, sweetLow: 33, sweetHigh: 50, minLeadsPerMonth: 200 },
    });
  } catch (err) {
    console.error('[clo] stage stats error:', err.message);
    res.status(500).json({ error: 'Failed to compute stage statistics' });
  }
});

// ── manual dispatch + sandbox verification ──────────────────────────────────
//
// Required lazily: cloDispatcher imports loadCloSettings from this module, so a
// top-level require would be circular and leave one half undefined at boot.
function dispatcher() { return require('../services/cloDispatcher'); }

router.post('/marketing/clo/flush', adminOnly, async (req, res) => {
  try {
    const d = dispatcher();
    // Sweep first so anything that changed stage since the last tick is picked
    // up — otherwise "Send now" would report zero on a queue that is about to
    // fill a second later, which reads as broken.
    const swept = await d.sweepStageChanges();
    const result = await d.flush();
    res.json({ ok: !result.error, swept, ...result });
  } catch (err) {
    console.error('[clo] flush error:', err.message);
    res.status(500).json({ error: 'Failed to dispatch events' });
  }
});

// Replays recent stage transitions through the same gates as the live path.
router.post('/marketing/clo/backfill', adminOnly, async (req, res) => {
  try {
    const r = await dispatcher().backfill({
      days: req.body?.days,
      dryRunOnly: req.body?.dryRunOnly === true,
    });
    if (r.error) return res.status(400).json({ error: r.message || 'Backfill is not available yet.' });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[clo] backfill error:', err.message);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// Sends ONE event with the test event code so it lands in Events Manager →
// Test Events and never reaches the optimiser.
router.post('/marketing/clo/test-event', adminOnly, async (req, res) => {
  try {
    const s = await loadCloSettings();
    if (!s?.dataset_id) return res.status(400).json({ error: 'Add a dataset ID first.' });
    if (!s.access_token_encrypted) return res.status(400).json({ error: 'Add a system-user access token first.' });
    if (!s.test_event_code) {
      // Without the code this would be a REAL event wearing a "test" label.
      return res.status(400).json({ error: 'Add a test event code first, or this would send a live conversion.' });
    }

    const clo = require('../integrations/metaCloClient');
    const { decrypt } = require('../util/crypto');
    const eventName = String(req.body?.eventName || '').trim() || 'QualifiedLead';

    const event = clo.buildCloEvent({
      eventName,
      eventTime: Date.now(),
      // A synthetic id in Meta's 15–17 digit shape: enough to validate transport
      // and payload without claiming a real person converted.
      metaLeadId: String(req.body?.metaLeadId || '').trim() || '000000000000000',
      leadEventSource: s.lead_event_source,
    });

    const result = await clo.sendCloEvents(decrypt(s.access_token_encrypted), s.dataset_id, [event], {
      testEventCode: s.test_event_code,
      graphApiVersion: s.graph_api_version,
    });

    // Remembered so the readiness check can distinguish "a dataset id is typed
    // in" from "Meta has actually accepted an event from us".
    await pool.query(
      `UPDATE coexistence.clo_settings
          SET last_test_event_at = NOW(), last_test_ok = $1, last_test_error = $2, updated_at = NOW()
        WHERE id = 1`, [result.ok, result.ok ? null : result.error]);

    res.json({
      ok: result.ok,
      eventsReceived: result.eventsReceived,
      fbtraceId: result.fbtraceId,
      error: result.error,
      // Token-free by construction; shown so the exact shape can be checked.
      sent: clo.redact(result.request),
    });
  } catch (err) {
    console.error('[clo] test event error:', err.message);
    res.status(500).json({ error: 'Failed to send the test event' });
  }
});


// ── readiness ───────────────────────────────────────────────────────────────
//
// Meta publishes eligibility criteria for CLO; this measures each one against
// live data and says what to do about a failure. Every check reports the actual
// number, because "conversion rate too low" is not actionable and "0.4%, needs
// to be at least 1%" is.
//
// A check is `fail` when Meta's criterion is not met, `warn` when it is met but
// fragile, `pass` otherwise. Nothing here blocks the feature — an operator may
// legitimately switch it on early and watch it improve.
router.get('/marketing/clo/readiness', adminOnly, async (req, res) => {
  try {
    const s = await loadCloSettings();
    const checks = [];

    // 1. Lead volume.
    const { rows: vol } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.leads
        WHERE created_at >= NOW() - ($1 || ' days')::interval`, [String(STATS_COHORT_DAYS)]);
    const perMonth = Math.round((vol[0].n / STATS_COHORT_DAYS) * 30);
    checks.push({
      key: 'lead_volume',
      label: 'At least 200 leads a month',
      status: perMonth >= 200 ? 'pass' : 'fail',
      value: `${perMonth} leads/month`,
      remedy: perMonth >= 200 ? null
        : `Currently ${perMonth} a month. Below 200 Meta gathers too little signal to optimise on — increase Lead Ads volume before relying on this.`,
    });

    // 2. An optimisation target must exist at all.
    const { rows: target } = await pool.query(
      `SELECT * FROM coexistence.clo_funnel_stages WHERE is_optimisation_target LIMIT 1`);
    const t = target[0] || null;
    checks.push({
      key: 'optimisation_stage',
      label: 'An optimisation stage is chosen',
      status: t ? 'pass' : 'fail',
      value: t ? t.display_name : 'none chosen',
      remedy: t ? null : 'Pick the stage Meta should optimise toward on the Funnel Stages tab.',
    });

    // 3 + 4. That stage's rate and timing — the two criteria that decide whether
    // the signal is learnable at all.
    let rate = null, medianDays = null;
    if (t) {
      const statuses = Array.isArray(t.crm_status_values) ? t.crm_status_values : [];
      if (statuses.length) {
        const { rows } = await pool.query(`
          WITH cohort AS (
            SELECT * FROM coexistence.leads WHERE created_at >= NOW() - '${STATS_COHORT_DAYS} days'::interval
          ), ${REACHED_SQL}
          SELECT COUNT(*)::int AS reached,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (reached_at - created_at)) / 86400) AS median_days
            FROM reached`, [statuses]);
        const r = rows[0] || {};
        rate = vol[0].n ? (r.reached / vol[0].n) * 100 : null;
        medianDays = r.median_days == null ? null : Number(r.median_days);
      }
    }

    checks.push({
      key: 'stage_rate',
      label: 'Optimisation stage converts between 1% and 40%',
      status: rate == null ? 'fail' : (rate >= 1 && rate <= 40) ? 'pass' : 'fail',
      value: rate == null ? 'not measurable' : `${rate.toFixed(1)}%`,
      remedy: rate == null
        ? 'Map at least one lead status to the optimisation stage so its rate can be measured.'
        : rate < 1 ? `Only ${rate.toFixed(1)}% of leads reach it — too rare for Meta to learn from. Choose an earlier stage.`
        : rate > 40 ? `${rate.toFixed(1)}% of leads reach it — too common to say much about quality. Choose a deeper stage.`
        : null,
    });

    checks.push({
      key: 'stage_timing',
      label: `Optimisation stage reached within ${CLO_WINDOW_DAYS} days`,
      status: medianDays == null ? 'warn' : medianDays <= CLO_WINDOW_DAYS ? 'pass' : 'fail',
      value: medianDays == null ? 'no data yet' : `${medianDays.toFixed(1)} days median`,
      remedy: medianDays == null ? 'No leads have reached this stage yet, so timing cannot be measured.'
        : medianDays > CLO_WINDOW_DAYS
          ? `Typically ${medianDays.toFixed(0)} days, past Meta's ${CLO_WINDOW_DAYS}-day window — most events would be dropped. Choose an earlier stage.`
          : null,
    });

    // 5. Identifier coverage. This is the check that decides match rate, and on
    // an instance with no Lead Ads it is the one that explains everything else.
    const { rows: idRows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(meta_lead_id)::int AS with_id
         FROM coexistence.leads
        WHERE created_at >= NOW() - ($1 || ' days')::interval`, [String(STATS_COHORT_DAYS)]);
    const pct = idRows[0].total ? (idRows[0].with_id / idRows[0].total) * 100 : 0;
    checks.push({
      key: 'lead_id_coverage',
      label: 'Leads carry a Meta Lead ID',
      status: pct >= 90 ? 'pass' : pct > 0 ? 'warn' : 'fail',
      value: `${pct.toFixed(0)}% (${idRows[0].with_id} of ${idRows[0].total})`,
      remedy: pct >= 90 ? null
        : pct === 0
          ? 'No lead carries a Meta Lead ID. CLO reads it from Instant Form submissions — until Lead Ads campaigns run and their leads are ingested, every event falls back to hashed phone/email and matches at a much lower rate.'
          : `Only ${pct.toFixed(0)}% have one. Events for the rest fall back to hashed phone/email, which Meta matches far less reliably.`,
    });

    // 6. Meta asks for at least one upload a day.
    const lastFlush = s?.last_flush_at ? new Date(s.last_flush_at) : null;
    const hoursSince = lastFlush ? (Date.now() - lastFlush.getTime()) / 3600000 : null;
    checks.push({
      key: 'dispatch_recent',
      label: 'Events dispatched in the last 24 hours',
      status: !s?.enabled ? 'warn' : hoursSince == null ? 'fail' : hoursSince <= 24 ? 'pass' : 'fail',
      value: !s?.enabled ? 'feature is off'
        : hoursSince == null ? 'never' : `${hoursSince < 1 ? 'under an hour' : Math.round(hoursSince) + ' hours'} ago`,
      remedy: !s?.enabled ? 'Switch the feature on to start dispatching.'
        : hoursSince == null ? 'Nothing has been dispatched yet. Use Send now, or wait for the 15-minute cycle.'
        : hoursSince > 24 ? 'Meta expects at least one upload a day. Check the dispatch log for errors.' : null,
    });

    // 7. Dataset configured AND proven, not merely typed in.
    const configured = !!(s?.dataset_id && s?.access_token_encrypted);
    const proven = s?.last_test_ok === true;
    checks.push({
      key: 'dataset_verified',
      label: 'Dataset configured and a test event accepted',
      status: configured && proven ? 'pass' : configured ? 'warn' : 'fail',
      value: !configured ? (s?.dataset_id ? 'no access token' : 'not configured')
        : proven ? `verified ${s.last_test_event_at ? new Date(s.last_test_event_at).toLocaleDateString('en-IN') : ''}`.trim()
        : s?.last_test_error ? `last test failed: ${s.last_test_error}` : 'never tested',
      remedy: !configured ? 'Add the CRM dataset ID and a system-user token on the Setup tab.'
        : proven ? null : 'Send a test event on the Setup tab to confirm Meta accepts it.',
    });

    const failed = checks.filter(c => c.status === 'fail').length;
    const warned = checks.filter(c => c.status === 'warn').length;

    res.json({
      checks,
      passed: checks.length - failed - warned,
      warned,
      failed,
      total: checks.length,
      ready: failed === 0,
      cohortDays: STATS_COHORT_DAYS,
    });
  } catch (err) {
    console.error('[clo] readiness error:', err.message);
    res.status(500).json({ error: 'Failed to compute the readiness check' });
  }
});

// ── event log ───────────────────────────────────────────────────────────────
function eventRow(r) {
  return {
    id: Number(r.id),
    leadId: r.lead_id == null ? null : Number(r.lead_id),
    leadName: r.lead_name || null,
    contactNumber: r.whatsapp_number || null,
    metaLeadId: r.meta_lead_id,
    stageId: r.stage_id == null ? null : Number(r.stage_id),
    stageName: r.stage_name || null,
    eventName: r.event_name,
    eventTime: r.event_time,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    fbtraceId: r.fbtrace_id,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    payload: r.payload,
  };
}

function eventFilters(q, startIdx = 1) {
  const where = ['1=1'];
  const params = [];
  let i = startIdx;
  const add = (v) => { params.push(v); return `$${i++}`; };
  if (q.status) where.push(`e.status = ${add(q.status)}`);
  if (q.stageId) where.push(`e.stage_id = ${add(parseInt(q.stageId, 10))}`);
  const days = parseInt(q.days, 10);
  if (Number.isFinite(days) && days > 0) where.push(`e.created_at >= NOW() - (${add(String(days))} || ' days')::interval`);
  if (q.search) {
    const s = `%${String(q.search).trim()}%`;
    where.push(`(l.name ILIKE ${add(s)} OR l.whatsapp_number ILIKE ${add(s)} OR e.meta_lead_id ILIKE ${add(s)})`);
  }
  return { where: where.join(' AND '), params, nextIdx: i };
}

router.get('/marketing/clo/events', adminOnly, async (req, res) => {
  try {
    const q = req.query || {};
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const f = eventFilters(q);

    const [rowsQ, countQ, summaryQ] = await Promise.all([
      pool.query(`
        SELECT e.*, l.name AS lead_name, l.whatsapp_number, s.display_name AS stage_name
          FROM coexistence.clo_events e
          LEFT JOIN coexistence.leads l ON l.id = e.lead_id
          LEFT JOIN coexistence.clo_funnel_stages s ON s.id = e.stage_id
         WHERE ${f.where}
         ORDER BY e.created_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`, f.params),
      pool.query(`
        SELECT COUNT(*)::int AS n FROM coexistence.clo_events e
          LEFT JOIN coexistence.leads l ON l.id = e.lead_id
         WHERE ${f.where}`, f.params),
      // The summary deliberately ignores the status filter — it is the strip
      // that explains WHY the filtered view is smaller than expected, so it has
      // to describe the whole period, not the slice being looked at.
      pool.query(`
        SELECT status, COUNT(*)::int AS n
          FROM coexistence.clo_events
         WHERE created_at >= NOW() - ($1 || ' days')::interval
         GROUP BY status`, [String(parseInt(q.days, 10) || 30)]),
    ]);

    const summary = {};
    for (const r of summaryQ.rows) summary[r.status] = r.n;

    res.json({
      events: rowsQ.rows.map(eventRow),
      total: countQ.rows[0].n,
      page,
      limit,
      summary,
      summaryDays: parseInt(q.days, 10) || 30,
    });
  } catch (err) {
    console.error('[clo] events error:', err.message);
    res.status(500).json({ error: 'Failed to load the event log' });
  }
});

// Retry applies to FAILED rows only. A skipped row was declined for a reason
// that re-running would hit again (no identifier, outside the window, already
// sent) — those become eligible through the backfill, not a retry button that
// silently does nothing.
router.post('/marketing/clo/events/:id/retry', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE coexistence.clo_events
          SET status = 'pending', attempts = 0, last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'failed'`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(409).json({ error: 'Only failed events can be retried.' });
    res.json({ ok: true, requeued: 1 });
  } catch (err) {
    console.error('[clo] retry error:', err.message);
    res.status(500).json({ error: 'Failed to requeue the event' });
  }
});

router.post('/marketing/clo/events/retry-bulk', adminOnly, async (req, res) => {
  try {
    const f = eventFilters(req.body || {});
    // Selected via a subquery with a LEFT JOIN rather than UPDATE ... FROM:
    // the latter is an inner join, so any event whose lead has since been
    // deleted (lead_id NULL) would be silently excluded from a bulk retry.
    const { rowCount } = await pool.query(
      `UPDATE coexistence.clo_events
          SET status = 'pending', attempts = 0, last_error = NULL, updated_at = NOW()
        WHERE id IN (
          SELECT e.id FROM coexistence.clo_events e
            LEFT JOIN coexistence.leads l ON l.id = e.lead_id
           WHERE e.status = 'failed' AND ${f.where}
        )`, f.params);
    res.json({ ok: true, requeued: rowCount });
  } catch (err) {
    console.error('[clo] bulk retry error:', err.message);
    res.status(500).json({ error: 'Failed to requeue events' });
  }
});

// A stage row read from the DB uses snake_case; validateStage speaks camelCase.
// Only the fields it reads need translating.
function toCamel(r) {
  return {
    stageKey: r.stage_key,
    eventName: r.event_name,
    displayName: r.display_name,
    crmStatusValues: Array.isArray(r.crm_status_values) ? r.crm_status_values : [],
    active: r.active,
    sortOrder: r.sort_order,
  };
}

module.exports = { router, ensureCloTables, loadCloSettings, CLO_WINDOW_DAYS };
