const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const publicRouter = express.Router();
const pool = require('../db');
const { fireWebhookTrigger } = require('../engine/automationEngine');

// ─── Automation folders ────────────────────────────────────────────────────
// Folders only organize automations (chatbots.folder_id). They carry no flow
// config. Responses keep snake_case to match the rest of this module.

// GET /automation-folders — list folders with a live automation count
router.get('/automation-folders', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.created_at, f.updated_at,
            COUNT(c.id)::int AS automation_count
       FROM coexistence.automation_folders f
       LEFT JOIN coexistence.chatbots c ON c.folder_id = f.id
      GROUP BY f.id
      ORDER BY LOWER(f.name) ASC`
  );
  res.json(rows);
});

// POST /automation-folders — create
router.post('/automation-folders', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const { rows } = await pool.query(
    `INSERT INTO coexistence.automation_folders (name) VALUES ($1) RETURNING *`,
    [name]
  );
  res.status(201).json({ ...rows[0], automation_count: 0 });
});

// PUT /automation-folders/:id — rename
router.put('/automation-folders/:id', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const { rows } = await pool.query(
    `UPDATE coexistence.automation_folders
        SET name = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [name, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
  res.json(rows[0]);
});

// DELETE /automation-folders/:id — blocked while the folder still holds automations
router.delete('/automation-folders/:id', async (req, res) => {
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.chatbots WHERE folder_id = $1`,
    [req.params.id]
  );
  const n = cnt[0].n;
  if (n > 0) {
    return res.status(409).json({
      error: `This folder still has ${n} automation${n === 1 ? '' : 's'}. Move or delete ${n === 1 ? 'it' : 'them'} before deleting the folder.`,
    });
  }
  const { rowCount } = await pool.query(
    'DELETE FROM coexistence.automation_folders WHERE id = $1', [req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Folder not found' });
  res.json({ ok: true });
});

// GET /chatbots — list all
router.get('/chatbots', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, trigger_type, config, folder_id, created_at, updated_at
     FROM coexistence.chatbots
     ORDER BY updated_at DESC`
  );
  res.json(rows);
});

// GET /chatbots/:id — single chatbot
router.get('/chatbots/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, trigger_type, config, folder_id, created_at, updated_at
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
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, folder_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [name.trim(), description || null, status || 'draft', trigger_type || 'keyword', JSON.stringify(config || {}), folder_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'That folder no longer exists' });
    throw err;
  }
});

// PUT /chatbots/:id — update. Only the fields present in the body are touched, so
// a folder move (`{ folder_id: <id|null> }`) won't clobber name/description/config.
router.put('/chatbots/:id', async (req, res) => {
  const body = req.body || {};
  if (body.name !== undefined && !String(body.name).trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const sets = [];
  const params = [];
  let i = 1;
  if (body.name !== undefined)         { sets.push(`name = $${i++}`);         params.push(String(body.name).trim()); }
  if (body.description !== undefined)  { sets.push(`description = $${i++}`);  params.push(body.description || null); }
  if (body.status !== undefined)       { sets.push(`status = $${i++}`);       params.push(body.status); }
  if (body.trigger_type !== undefined) { sets.push(`trigger_type = $${i++}`); params.push(body.trigger_type); }
  if (body.config !== undefined)       { sets.push(`config = $${i++}`);       params.push(JSON.stringify(body.config)); }
  if (body.folder_id !== undefined)    { sets.push(`folder_id = $${i++}`);    params.push(body.folder_id === null ? null : body.folder_id); }

  if (sets.length === 0) {
    const { rows } = await pool.query('SELECT * FROM coexistence.chatbots WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    return res.json(rows[0]);
  }

  sets.push('updated_at = NOW()');
  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.chatbots SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'That folder no longer exists' });
    throw err;
  }
});

// POST /chatbots/:id/duplicate — clone an automation. The copy is always
// created DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/:id/duplicate', async (req, res) => {
  const { rows: src } = await pool.query(
    'SELECT name, description, trigger_type, config, folder_id FROM coexistence.chatbots WHERE id = $1',
    [req.params.id]
  );
  if (src.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
  const c = src[0];
  // The copy lands in the same folder as the original.
  const { rows } = await pool.query(
    `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, folder_id)
     VALUES ($1,$2,'inactive',$3,$4,$5)
     RETURNING id, name, description, status, trigger_type, config, folder_id, created_at, updated_at`,
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
    `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, folder_id)
     VALUES ($1,$2,'inactive',$3,$4,NULL)
     RETURNING id, name, description, status, trigger_type, config, folder_id, created_at, updated_at`,
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

// ─── Webhook trigger: per-automation URL + secret ──────────────────────────

// GET /chatbots/:id/webhook — return the public webhook URL + secret for a
// Webhook / API-Event trigger. Lazily mints a secret on first read.
router.get('/chatbots/:id/webhook', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, webhook_secret FROM coexistence.chatbots WHERE id=$1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Automation not found' });
    let secret = rows[0].webhook_secret;
    if (!secret) {
      secret = 'whsec_' + crypto.randomBytes(18).toString('hex');
      await pool.query(`UPDATE coexistence.chatbots SET webhook_secret=$1 WHERE id=$2`, [secret, req.params.id]);
    }
    res.json({ path: `/api/automations/${req.params.id}/webhook`, secret });
  } catch (err) {
    console.error('[chatbots] webhook info error:', err.message);
    res.status(500).json({ error: 'Failed to load webhook info' });
  }
});

// POST /chatbots/:id/webhook/rotate — issue a fresh signing secret
router.post('/chatbots/:id/webhook/rotate', async (req, res) => {
  try {
    const secret = 'whsec_' + crypto.randomBytes(18).toString('hex');
    const { rowCount } = await pool.query(`UPDATE coexistence.chatbots SET webhook_secret=$1 WHERE id=$2`, [secret, req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Automation not found' });
    res.json({ path: `/api/automations/${req.params.id}/webhook`, secret });
  } catch (err) {
    console.error('[chatbots] rotate secret error:', err.message);
    res.status(500).json({ error: 'Failed to rotate secret' });
  }
});

// POST /automations/:id/webhook — PUBLIC. External services POST a JSON body
// here to fire a Webhook / API-Event-triggered automation. If the automation
// has a secret, callers must present it via the X-Whatsflow-Signature header
// (or ?secret=). Returns 202 on accept.
publicRouter.post('/automations/:id/webhook', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT webhook_secret, status FROM coexistence.chatbots WHERE id=$1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Automation not found' });
    if (rows[0].status !== 'active') return res.status(409).json({ error: 'Automation is not active' });
    const secret = rows[0].webhook_secret;
    if (secret) {
      const presented = req.get('X-Whatsflow-Signature') || req.query.secret || '';
      const a = Buffer.from(String(presented));
      const b = Buffer.from(String(secret));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Invalid or missing signature' });
      }
    }
    const result = await fireWebhookTrigger(req.params.id, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.status(202).json(result);
  } catch (err) {
    console.error('[chatbots] public webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = { router, publicRouter };
