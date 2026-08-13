// Repeating broadcasts — CRUD + history + a manual "run now".
//
// The sending logic lives entirely in services/broadcastSeries.js, which in
// turn goes through the ONE shared dispatchBroadcast(). Nothing here sends.

const { Router } = require('express');
const pool = require('../db');
const { isAdmin } = require('../permissions');
const svc = require('../services/broadcastSeries');

const router = Router();

const shape = (r, extra = {}) => ({
  id: Number(r.id),
  name: r.name,
  active: r.active,
  fromNumber: r.from_number,
  messageType: r.message_type,
  templateId: r.template_id == null ? null : Number(r.template_id),
  variableMapping: r.variable_mapping || {},
  body: r.body,
  url: r.url,
  mediaLibraryId: r.media_library_id == null ? null : Number(r.media_library_id),
  caption: r.caption,
  audience: r.audience || {},
  recurrence: r.recurrence || {},
  skipAlreadySent: r.skip_already_sent !== false,
  maxPerRun: r.max_per_run,
  endsOn: r.ends_on,
  maxRuns: r.max_runs == null ? null : Number(r.max_runs),
  runsCount: r.runs_count,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  ...extra,
});

/**
 * ⚠ A payment template mints a LIVE Razorpay link per recipient. Putting that
 * in a loop that fires every week, unattended, is the re-runnable-money-action
 * trap this codebase already guards against with a unique index elsewhere.
 * Refused outright rather than gated behind a confirmation, because the person
 * who set the series up is not present when it fires.
 */
async function refusePaymentTemplate(templateId) {
  if (!templateId) return null;
  const { rows } = await pool.query(
    `SELECT id, name, buttons FROM coexistence.message_templates WHERE id = $1`, [templateId],
  );
  if (!rows[0]) return null;
  const { templateHasPaymentButton } = require('../services/paymentFlow');
  if (templateHasPaymentButton(rows[0])) {
    return `"${rows[0].name}" carries a payment button, so every run would create a new live payment link for every recipient. Send that one manually instead.`;
  }
  return null;
}

/** Shared validation for create + update. Throws { status, message }. */
async function validate(b, { partial = false, current = null } = {}) {
  const out = {};

  if (!partial || b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) throw Object.assign(new Error('Give this repeating broadcast a name.'), { status: 400 });
    out.name = name.slice(0, 200);
  }
  if (!partial || b.fromNumber !== undefined) {
    const f = String(b.fromNumber || '').trim();
    if (!f) throw Object.assign(new Error('Pick the number this sends from.'), { status: 400 });
    out.from_number = f;
  }
  if (!partial || b.messageType !== undefined) out.message_type = b.messageType || 'template';
  if (!partial || b.templateId !== undefined) out.template_id = b.templateId ? parseInt(b.templateId, 10) : null;
  if (b.variableMapping !== undefined) out.variable_mapping = JSON.stringify(b.variableMapping || {});
  if (b.body !== undefined) out.body = b.body || null;
  if (b.url !== undefined) out.url = b.url || null;
  if (b.mediaLibraryId !== undefined) out.media_library_id = b.mediaLibraryId ? Number(b.mediaLibraryId) : null;
  if (b.caption !== undefined) out.caption = b.caption || null;
  if (b.skipAlreadySent !== undefined) out.skip_already_sent = b.skipAlreadySent !== false;
  if (b.maxPerRun !== undefined) out.max_per_run = Math.max(1, Math.min(5000, parseInt(b.maxPerRun, 10) || 500));

  const effType = out.message_type ?? current?.message_type ?? 'template';
  const effTpl = out.template_id !== undefined ? out.template_id : current?.template_id;
  if (effType === 'template') {
    if (!effTpl) throw Object.assign(new Error('Pick the template this sends.'), { status: 400 });
    const refusal = await refusePaymentTemplate(effTpl);
    if (refusal) throw Object.assign(new Error(refusal), { status: 400 });
  }

  if (!partial || b.audience !== undefined) out.audience = JSON.stringify(svc.normalizeAudience(b.audience));
  if (!partial || b.recurrence !== undefined) {
    out.recurrence = JSON.stringify(svc.normalizeRecurrence(b.recurrence));
  }

  // ⚠ A series MUST be able to end. An unbounded repeating blast to real
  // customers should not be expressible at all — not merely discouraged.
  if (!partial || b.endsOn !== undefined || b.maxRuns !== undefined) {
    const endsOn = b.endsOn ? String(b.endsOn).slice(0, 10) : null;
    const maxRuns = b.maxRuns != null && b.maxRuns !== '' ? parseInt(b.maxRuns, 10) : null;
    const effEnds = b.endsOn !== undefined ? endsOn : current?.ends_on;
    const effMax = b.maxRuns !== undefined ? maxRuns : (current?.max_runs ?? null);
    if (!effEnds && !effMax) {
      throw Object.assign(new Error('Set an end — either a last date or a number of runs. A repeating broadcast with no end would keep messaging people forever.'), { status: 400 });
    }
    if (endsOn && new Date(`${endsOn}T23:59:59+05:30`).getTime() < Date.now()) {
      throw Object.assign(new Error('That end date has already passed.'), { status: 400 });
    }
    if (maxRuns != null && !(maxRuns > 0)) {
      throw Object.assign(new Error('Number of runs must be at least 1.'), { status: 400 });
    }
    if (b.endsOn !== undefined) out.ends_on = endsOn;
    if (b.maxRuns !== undefined) out.max_runs = maxRuns;
  }
  return out;
}

// GET /broadcast-series
router.get('/broadcast-series', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM coexistence.broadcast_series_sends x WHERE x.series_id = s.id) AS reached
         FROM coexistence.broadcast_series s
        ORDER BY s.active DESC, s.next_run_at NULLS LAST, s.id DESC`
    );
    res.json({ series: rows.map(r => shape(r, { reached: r.reached })) });
  } catch (err) {
    console.error('[series] list error:', err.message);
    res.status(500).json({ error: 'Failed to load repeating broadcasts' });
  }
});

// GET /broadcast-series/:id — with its run history
router.get('/broadcast-series/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const { rows: runs } = await pool.query(
      `SELECT id, broadcast_id, ran_at, recipient_count, status, note
         FROM coexistence.broadcast_series_runs
        WHERE series_id = $1 ORDER BY ran_at DESC LIMIT 50`,
      [req.params.id],
    );
    const { rows: reach } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.broadcast_series_sends WHERE series_id = $1`, [req.params.id],
    );
    res.json(shape(rows[0], {
      reached: reach[0].n,
      runs: runs.map(r => ({
        id: Number(r.id), broadcastId: r.broadcast_id == null ? null : Number(r.broadcast_id),
        ranAt: r.ran_at, recipientCount: r.recipient_count, status: r.status, note: r.note,
      })),
    }));
  } catch (err) {
    console.error('[series] get error:', err.message);
    res.status(500).json({ error: 'Failed to load this repeating broadcast' });
  }
});

// POST /broadcast-series — always created PAUSED.
//
// ⚠ Never auto-activates. Something that will message real customers on a timer
// gets one deliberate press to start, so a mis-set rule cannot fire on its own
// before anyone has read it back.
router.post('/broadcast-series', async (req, res) => {
  try {
    const v = await validate(req.body || {});
    const next = await svc.computeNextRun(JSON.parse(v.recurrence), new Date());
    const { rows } = await pool.query(
      `INSERT INTO coexistence.broadcast_series
         (name, from_number, message_type, template_id, variable_mapping, body, url,
          media_library_id, caption, audience, recurrence, skip_already_sent, max_per_run,
          ends_on, max_runs, next_run_at, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, FALSE, $17)
       RETURNING *`,
      [
        v.name, v.from_number, v.message_type, v.template_id,
        v.variable_mapping ?? '{}', v.body ?? null, v.url ?? null,
        v.media_library_id ?? null, v.caption ?? null,
        v.audience, v.recurrence,
        v.skip_already_sent ?? true, v.max_per_run ?? 500,
        v.ends_on ?? null, v.max_runs ?? null,
        next, req.user?.id || null,
      ],
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[series] create error:', err.message);
    res.status(500).json({ error: 'Failed to create the repeating broadcast' });
  }
});

// PUT /broadcast-series/:id
router.put('/broadcast-series/:id', async (req, res) => {
  try {
    const { rows: cur } = await pool.query(`SELECT * FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Not found' });

    const v = await validate(req.body || {}, { partial: true, current: cur[0] });
    const sets = ['updated_at = NOW()'];
    const params = [];
    for (const [col, val] of Object.entries(v)) { params.push(val); sets.push(`${col} = $${params.length}`); }

    // Changing WHEN must move the next slot — otherwise the series keeps its
    // old time and the edit silently does nothing until after the next fire.
    if (v.recurrence) {
      const next = await svc.computeNextRun(JSON.parse(v.recurrence), new Date());
      params.push(next); sets.push(`next_run_at = $${params.length}`);
    }
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.broadcast_series SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    res.json(shape(rows[0]));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[series] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the repeating broadcast' });
  }
});

// POST /broadcast-series/:id/active  { active }
router.post('/broadcast-series/:id/active', async (req, res) => {
  try {
    const active = req.body?.active === true;
    const { rows: cur } = await pool.query(`SELECT * FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Not found' });

    // Resuming recomputes the next slot from NOW. Without this, a series paused
    // for a fortnight would resume with a next_run_at deep in the past and fire
    // immediately on the next tick — the "I scheduled it for 6pm and it sent
    // right now" surprise, in a loop.
    const next = active ? await svc.computeNextRun(cur[0].recurrence, new Date()) : null;
    const { rows } = await pool.query(
      `UPDATE coexistence.broadcast_series SET active = $2, next_run_at = $3, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.id, active, next],
    );
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('[series] activate error:', err.message);
    res.status(500).json({ error: 'Failed to change the schedule' });
  }
});

// POST /broadcast-series/:id/run — fire one run right now (admin only).
//
// Real sends, so it is gated and it goes through the exact same path a timed
// run takes; there is no "test" variant that would prove something different
// from what the schedule actually does.
router.post('/broadcast-series/:id/run', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin can run a repeating broadcast on demand.' });
    const { rows } = await pool.query(`SELECT * FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const result = await svc.runSeriesOnce(rows[0]);
    res.json(result);
  } catch (err) {
    console.error('[series] manual run error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to run' });
  }
});

// GET /broadcast-series/:id/preview — who WOULD be messaged right now.
//
// The same resolveAudience() the run uses, so the preview cannot promise a
// different audience from the one that actually gets messaged.
router.get('/broadcast-series/:id/preview', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const people = await svc.resolveAudience(rows[0]);
    res.json({ count: people.length, sample: people.slice(0, 20) });
  } catch (err) {
    console.error('[series] preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview the audience' });
  }
});

// POST /broadcast-series/preview — preview a rule BEFORE the series exists.
router.post('/broadcast-series/preview', async (req, res) => {
  try {
    const b = req.body || {};
    const people = await svc.resolveAudience({
      id: 0,
      from_number: b.fromNumber || '',
      audience: svc.normalizeAudience(b.audience),
      // No series id yet, so nothing to exclude — say so rather than pretending
      // the already-reached filter was applied.
      skip_already_sent: false,
      max_per_run: b.maxPerRun || 500,
    });
    res.json({ count: people.length, sample: people.slice(0, 20), skipAlreadySentApplied: false });
  } catch (err) {
    console.error('[series] rule preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview the audience' });
  }
});

// DELETE /broadcast-series/:id — the series and its history. Broadcasts it
// already created are NOT deleted: those are real sends with real delivery
// logs, and they belong to the Bulk Message list, not to this row.
router.delete('/broadcast-series/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.broadcast_series WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[series] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

module.exports = { router };
