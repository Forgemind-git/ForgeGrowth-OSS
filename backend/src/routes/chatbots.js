const express = require('express');
const router = express.Router();
const pool = require('../db');
const { validateFlow } = require('../services/flowValidator');
const { writableLeadFields } = require('../services/leadFields');

// ─── Automation folders = PROJECTS ─────────────────────────────────────────
// Migration 094 generalised automation_folders into `projects`, which now also
// hold message templates and AI agents. These routes are the automations-only
// view of that table and are kept at their old paths + old response keys
// (`folder_id`, `automation_count`) so the existing Automations file-manager UI
// keeps working unchanged. The full cross-entity API lives in routes/projects.js.
//
// The SQL below therefore reads `projects` / `project_id` while the JSON still
// says `folder_id` — the alias is deliberate, not a leftover.

// GET /automation-folders — list projects with a live automation count
router.get('/automation-folders', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.created_at, f.updated_at,
            COUNT(c.id)::int AS automation_count
       FROM coexistence.projects f
       LEFT JOIN coexistence.chatbots c ON c.project_id = f.id
      GROUP BY f.id
      ORDER BY LOWER(f.name) ASC`
  );
  res.json(rows);
});

// POST /automation-folders — create
router.post('/automation-folders', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const { rows } = await pool.query(
    `INSERT INTO coexistence.projects (name) VALUES ($1) RETURNING *`,
    [name]
  );
  res.status(201).json({ ...rows[0], automation_count: 0 });
});

// PUT /automation-folders/:id — rename
router.put('/automation-folders/:id', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const { rows } = await pool.query(
    `UPDATE coexistence.projects
        SET name = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [name, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Project not found' });
  res.json(rows[0]);
});

// DELETE /automation-folders/:id — blocked while the project still holds
// anything. Counts templates and agents too, not just automations: this route
// deletes the whole project row, so checking only automations would let a
// delete through and then fail on the templates FK with a raw 500.
router.delete('/automation-folders/:id', async (req, res) => {
  const { rows: cnt } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM coexistence.chatbots          WHERE project_id = $1) AS automations,
            (SELECT COUNT(*)::int FROM coexistence.message_templates WHERE project_id = $1) AS templates,
            (SELECT COUNT(*)::int FROM coexistence.agents            WHERE project_id = $1) AS agents`,
    [req.params.id]
  );
  const c = cnt[0];
  const parts = [];
  if (c.automations) parts.push(`${c.automations} automation${c.automations === 1 ? '' : 's'}`);
  if (c.templates) parts.push(`${c.templates} template${c.templates === 1 ? '' : 's'}`);
  if (c.agents) parts.push(`${c.agents} AI agent${c.agents === 1 ? '' : 's'}`);
  if (parts.length) {
    return res.status(409).json({
      error: `This project still holds ${parts.join(', ')}. Move or delete them before deleting the project.`,
    });
  }
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.projects WHERE id = $1', [req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// GET /automation-lead-fields — the lead fields a "Set Lead Field" action may
// write, with their live labels, types and dropdown options.
//
// Served from `leadFields.writableLeadFields()` — the SAME function the engine
// validates against — so the builder cannot offer a field the write would then
// refuse. A list rebuilt in the frontend would be a mirror, and the drifted
// half would only ever be visible as an action that silently stores nothing.
router.get('/automation-lead-fields', async (req, res) => {
  try {
    res.json({ fields: writableLeadFields() });
  } catch (err) {
    console.error('[chatbots] lead-fields error:', err.message);
    res.status(500).json({ error: 'Could not load the lead fields.' });
  }
});

// GET /chatbots — list all
router.get('/chatbots', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, trigger_type, config, project_id AS folder_id, created_at, updated_at
     FROM coexistence.chatbots
     ORDER BY updated_at DESC`
  );
  res.json(rows);
});

// GET /chatbots/:id — single chatbot
router.get('/chatbots/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, trigger_type, config, project_id AS folder_id, created_at, updated_at
     FROM coexistence.chatbots WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
  res.json(rows[0]);
});

// POST /chatbots — create. Optional folder_id places it inside a folder.
router.post('/chatbots', async (req, res) => {
  const { name, description, status, trigger_type, config, folder_id } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, project_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *, project_id AS folder_id`,
      [name.trim(), description || null, status || 'draft', trigger_type || 'keyword', JSON.stringify(config || {}), folder_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'That project no longer exists' });
    throw err;
  }
});

/**
 * Check a flow without saving it. The builder debounces this so the canvas can
 * show findings live, and it is the SAME function the activation gate runs, so
 * "the builder said it was fine" and "Go Live refused it" can never disagree.
 */
router.post('/chatbots/validate', async (req, res) => {
  try {
    const config = (req.body && req.body.config) || {};
    const { rows } = await pool.query(
      `SELECT id, name, status FROM coexistence.message_templates`
    ).catch(() => ({ rows: [] }));
    const templatesById = Object.fromEntries(rows.map(t => [String(t.id), t]));
    res.json(validateFlow(config, { templatesById }));
  } catch (err) {
    console.error('[chatbots] validate error:', err.message);
    res.status(500).json({ error: 'Could not check this flow.' });
  }
});

// PUT /chatbots/:id — update. Only the fields present in the body are touched, so
// a folder move (`{ folder_id: <id|null> }`) won't clobber name/description/config.
router.put('/chatbots/:id', async (req, res) => {
  const body = req.body || {};
  if (body.name !== undefined && !String(body.name).trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // ── Activation gate ────────────────────────────────────────────────────
  // Only activation is gated. Saving must never lose work, so a draft is
  // allowed to be broken; going live is where a broken flow starts costing
  // real customers a reply they never receive.
  if (String(body.status) === 'active') {
    try {
      const { rows: cur } = await pool.query(
        `SELECT config FROM coexistence.chatbots WHERE id = $1`, [req.params.id]
      );
      if (cur.length === 0) return res.status(404).json({ error: 'Automation not found' });
      // Validate the config being SAVED in this same request when there is one
      // — otherwise a save-and-activate would check the previous version.
      const config = body.config !== undefined ? body.config : (cur[0].config || {});
      const { rows: tRows } = await pool.query(
        `SELECT id, name, status FROM coexistence.message_templates`
      ).catch(() => ({ rows: [] }));
      const result = validateFlow(config, {
        templatesById: Object.fromEntries(tRows.map(t => [String(t.id), t])),
      });
      if (!result.ok) {
        return res.status(409).json({
          error: result.blocking.length === 1
            ? 'This flow cannot go live yet — one thing needs fixing first.'
            : `This flow cannot go live yet — ${result.blocking.length} things need fixing first.`,
          blocking: result.blocking,
          warnings: result.warnings,
        });
      }
    } catch (err) {
      console.error('[chatbots] activation validation error:', err.message);
      return res.status(500).json({ error: 'Could not check this flow before activating it.' });
    }
  }

  const sets = [];
  const params = [];
  let i = 1;
  if (body.name !== undefined)         { sets.push(`name = $${i++}`);         params.push(String(body.name).trim()); }
  if (body.description !== undefined)  { sets.push(`description = $${i++}`);  params.push(body.description || null); }
  if (body.status !== undefined)       { sets.push(`status = $${i++}`);       params.push(body.status); }
  if (body.trigger_type !== undefined) { sets.push(`trigger_type = $${i++}`); params.push(body.trigger_type); }
  if (body.config !== undefined)       { sets.push(`config = $${i++}`);       params.push(JSON.stringify(body.config)); }
  if (body.folder_id !== undefined)    { sets.push(`project_id = $${i++}`);    params.push(body.folder_id === null ? null : body.folder_id); }

  if (sets.length === 0) {
    const { rows } = await pool.query('SELECT *, project_id AS folder_id FROM coexistence.chatbots WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    return res.json(rows[0]);
  }

  sets.push('updated_at = NOW()');
  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.chatbots SET ${sets.join(', ')} WHERE id = $${i} RETURNING *, project_id AS folder_id`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'That project no longer exists' });
    throw err;
  }
});

// POST /chatbots/:id/duplicate — clone an automation. The copy is always
// created DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/:id/duplicate', async (req, res) => {
  const { rows: src } = await pool.query(
    'SELECT name, description, trigger_type, config, project_id AS folder_id FROM coexistence.chatbots WHERE id = $1',
    [req.params.id]
  );
  if (src.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
  const c = src[0];
  // The copy lands in the same folder as the original.
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, project_id)
     VALUES ($1,$2,'inactive',$3,$4,$5)
     RETURNING id, name, description, status, trigger_type, config, project_id AS folder_id, created_at, updated_at`,
    [`${c.name} (copy)`, c.description, c.trigger_type, JSON.stringify(c.config || {}), c.folder_id]
  );
  res.status(201).json(rows[0]);
});

// GET /chatbots/:id/export — portable automation file (id/folder/timestamps stripped).
router.get('/chatbots/:id/export', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT name, description, trigger_type, config FROM coexistence.chatbots WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
  const c = rows[0];
  res.json({
    type: 'forgechat.automation',
    version: 1,
    automation: {
      name: c.name,
      description: c.description,
      trigger_type: c.trigger_type,
      config: c.config || {},
    },
  });
});

// POST /chatbots/import — create a new automation from an export file. Always
// lands DISABLED ('inactive') at the root (no folder) so it can't fire until
// reviewed/enabled. References inside the flow (templates, models, numbers) are
// kept as-is; the user fixes any that don't resolve in the builder.
router.post('/chatbots/import', async (req, res) => {
  const payload = req.body || {};
  if (payload.type !== 'forgechat.automation' || !payload.automation || !payload.automation.name) {
    return res.status(400).json({ error: 'That file is not a ForgeChat automation export.' });
  }
  const a = payload.automation;
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, project_id)
     VALUES ($1,$2,'inactive',$3,$4,NULL)
     RETURNING id, name, description, status, trigger_type, config, project_id AS folder_id, created_at, updated_at`,
    [`${String(a.name).trim()} (imported)`.slice(0, 200), a.description || null, a.trigger_type || 'keyword', JSON.stringify(a.config || {})]
  );
  res.status(201).json(rows[0]);
});

// DELETE /chatbots/:id
router.delete('/chatbots/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.chatbots WHERE id = $1', [req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Chatbot not found' });
  res.json({ ok: true });
});

// GET /chatbots/:id/executions — paginated list of executions for an automation
router.get('/chatbots/:id/executions', async (req, res) => {
  try {
    const automationId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Filters
    const statusFilter = req.query.status;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const messageStatus = req.query.messageStatus;

    let whereClause = 'WHERE e.automation_id = $1';
    const params = [automationId];
    let paramIdx = 2;

    if (statusFilter && statusFilter !== 'all') {
      whereClause += ` AND e.status = $${paramIdx}`;
      params.push(statusFilter);
      paramIdx++;
    }

    if (startDate) {
      whereClause += ` AND e.started_at >= $${paramIdx}`;
      params.push(new Date(startDate).toISOString());
      paramIdx++;
    }

    if (endDate) {
      whereClause += ` AND e.started_at <= $${paramIdx}`;
      params.push(new Date(endDate).toISOString());
      paramIdx++;
    }

    // Message status filter — find executions where any step has the given wa_message_status
    let joinClause = '';
    if (messageStatus && messageStatus !== 'all') {
      joinClause = `JOIN coexistence.automation_execution_steps s ON s.execution_id = e.id AND s.wa_message_status = $${paramIdx}`;
      params.push(messageStatus);
      paramIdx++;
    }

    const countQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT COUNT(DISTINCT e.id) FROM coexistence.automation_executions e ${joinClause} ${whereClause}`
      : `SELECT COUNT(*) FROM coexistence.automation_executions e ${whereClause}`;

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT DISTINCT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${joinClause}
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`
      : `SELECT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

    const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

    res.json({
      executions: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[chatbots] GET /chatbots/:id/executions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// GET /executions/:id — single execution with all steps
router.get('/executions/:id', async (req, res) => {
  try {
    const { rows: execRows } = await pool.query(
      `SELECT id, automation_id, status, trigger_type, trigger_data, contact_number,
              started_at, completed_at, error_message, created_at
       FROM coexistence.automation_executions
       WHERE id = $1`,
      [req.params.id]
    );
    if (execRows.length === 0) return res.status(404).json({ error: 'Execution not found' });

    const { rows: stepRows } = await pool.query(
      `SELECT id, execution_id, node_id, node_type, node_name, input_data, output_data,
              status, started_at, completed_at, error_message, wa_message_id, wa_message_status, created_at
       FROM coexistence.automation_execution_steps
       WHERE execution_id = $1
       ORDER BY started_at ASC`,
      [req.params.id]
    );

    res.json({ ...execRows[0], steps: stepRows });
  } catch (err) {
    console.error('[chatbots] GET /executions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch execution' });
  }
});

// POST /executions/:id/cancel — stop a non-terminal execution. A cancelled
// 'paused' execution will no longer resume when the customer replies (the
// webhook resume only claims rows WHERE status='paused').
router.post('/executions/:id/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.automation_executions
          SET status = 'cancelled',
              completed_at = NOW(),
              error_message = COALESCE(error_message, 'Cancelled by user')
        WHERE id = $1 AND status IN ('running', 'paused', 'queued')
        RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'Execution is already finished — nothing to stop.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] cancel execution error:', err.message);
    res.status(500).json({ error: 'Failed to cancel execution' });
  }
});

// NOTE (2026-08-12): the per-automation webhook URL + secret, and the public
// POST /automations/:id/webhook that fired it, were removed with the Webhook
// Received / API Event triggers. Nothing could fire them any more — a flow has
// no trigger kind that listens on that URL. The chatbots.webhook_secret column
// is left in place (unused) rather than dropped, so an automation exported from
// an instance that still has the feature imports without error.

module.exports = { router };
