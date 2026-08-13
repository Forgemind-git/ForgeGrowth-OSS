// Sales pipelines (Kanban deal board) — pipelines, editable stages, and deals.
// Mounted under /api with authMiddleware in index.js.
//
// Endpoints:
//   GET    /pipelines                       list pipelines
//   POST   /pipelines                       create pipeline (seeds default stages)
//   PUT    /pipelines/:id                   rename pipeline
//   DELETE /pipelines/:id                   delete pipeline (cascades stages + deals)
//   GET    /pipelines/:id/board             full board: pipeline + stages + deals + kpis
//   POST   /pipelines/:id/stages            add a stage
//   PUT    /pipelines/:id/stages/reorder    reorder stages ({ order: [stageId,...] })
//   PUT    /stages/:id                      edit a stage
//   DELETE /stages/:id                      delete a stage (409 if it holds deals)
//   POST   /pipelines/:id/deals             create a deal
//   PUT    /deals/:id                       edit a deal
//   PUT    /deals/:id/move                  move a deal to a stage (stamps won/lost)
//   DELETE /deals/:id                       delete a deal
//   GET    /deal-contacts?q=                search CRM contacts for the deal picker
//   GET    /deal-assignees                  active users for the assignee picker

const { Router } = require('express');
const pool = require('../db');
const bus = require('../events');

const router = Router();

// ── access helpers ────────────────────────────────────────────────────────────
// Pipelines/stages (board structure) are admin-managed. Deals are scoped per user:
// a non-admin sees a deal only if it is assigned to them OR its linked contact
// (matched on wa_number + contact_number) is assigned to them.

function isAdmin(req) { return req.user?.role === 'admin'; }
function meId(req) { return parseInt(req.user?.id, 10); }

// Broadcast a board change to every connected client so open Pipelines pages
// refetch live (each client's refetch is scoped, so no data leaks). Set
// `listChanged` when the pipelines list itself changed (create/rename/delete).
function emitPipelineChanged(pipelineId, opts = {}) {
  bus.emit('pipeline-changed', {
    pipelineId: pipelineId != null ? Number(pipelineId) : null,
    listChanged: !!opts.listChanged,
  });
}
function adminGate(req, res) {
  if (isAdmin(req)) return true;
  res.status(403).json({ error: 'Only admins can manage pipelines and stages' });
  return false;
}

// Returns a deal-scope fragment + the next bind index for non-admins.
// `dAlias` is the deals alias, `cAlias` the joined contacts alias. The caller
// must include the contacts LEFT JOIN. Returns '' for admins (no restriction).
function dealScopeClause(req, idx, dAlias = 'd', cAlias = 'c') {
  if (isAdmin(req)) return '';
  return `AND (${dAlias}.assigned_user_id = $${idx} OR ${cAlias}.assigned_user_id = $${idx})`;
}

// Mirror a deal's assignment onto its linked contact so the assignee sees the
// contact (and its chat) everywhere — identical effect to assigning from the
// Chats page (sets contacts.assigned_user_id + emits the same SSE events).
// No-op unless we have a contact AND an assignee.
async function syncContactAssignment(waNumber, contactNumber, assigneeId) {
  if (!waNumber || !contactNumber || !assigneeId) return;
  const { rowCount } = await pool.query(
    `UPDATE coexistence.contacts
        SET assigned_user_id = $1, updated_at = NOW()
      WHERE wa_number = $2 AND contact_number = $3`,
    [assigneeId, waNumber, contactNumber]
  );
  if (rowCount > 0) {
    bus.emit('contact-saved', { waNumber, contactNumber });
    bus.emit('contact-assignment-changed', {
      waNumber, contactNumber, assignedUserId: Number(assigneeId),
    });
  }
}

// Confirms a non-admin may act on a single deal.
async function canAccessDeal(req, dealId) {
  if (isAdmin(req)) return true;
  const { rows } = await pool.query(
    `SELECT 1
       FROM coexistence.deals d
       LEFT JOIN coexistence.contacts c
         ON c.wa_number = d.contact_wa_number AND c.contact_number = d.contact_number
      WHERE d.id = $1 AND (d.assigned_user_id = $2 OR c.assigned_user_id = $2)`,
    [dealId, meId(req)]
  );
  return rows.length > 0;
}

// Default stages seeded when a pipeline is created. Colors line up with the
// design-system accents; probability drives the Weighted Value KPI.
const DEFAULT_STAGES = [
  { name: 'New Lead',      color: '#3b82f6', probability: 10,  is_won: false, is_lost: false },
  { name: 'Qualified',     color: '#eab308', probability: 30,  is_won: false, is_lost: false },
  { name: 'Proposal Sent', color: '#f97316', probability: 50,  is_won: false, is_lost: false },
  { name: 'Negotiation',   color: '#8b5cf6', probability: 70,  is_won: false, is_lost: false },
  { name: 'Won',           color: '#22c55e', probability: 100, is_won: true,  is_lost: false },
  { name: 'Lost',          color: '#ef4444', probability: 0,   is_won: false, is_lost: true  },
];

function stageRow(r) {
  return {
    id: Number(r.id),
    pipelineId: Number(r.pipeline_id),
    name: r.name,
    color: r.color,
    sortOrder: Number(r.sort_order),
    probability: Number(r.probability),
    isWon: r.is_won,
    isLost: r.is_lost,
  };
}

function dealRow(r) {
  return {
    id: Number(r.id),
    pipelineId: Number(r.pipeline_id),
    stageId: Number(r.stage_id),
    title: r.title,
    value: r.value == null ? 0 : Number(r.value),
    currency: r.currency,
    contactWaNumber: r.contact_wa_number,
    contactNumber: r.contact_number,
    contactName: r.contact_name,
    assignedUserId: r.assigned_user_id == null ? null : Number(r.assigned_user_id),
    assignedUserName: r.assigned_user_name || null,
    status: r.status,
    expectedCloseDate: r.expected_close_date,
    notes: r.notes,
    sortOrder: Number(r.sort_order),
    wonAt: r.won_at,
    lostAt: r.lost_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function pipelineRow(r) {
  return {
    id: Number(r.id),
    name: r.name,
    isDefault: r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Pipelines ───────────────────────────────────────────────────────────────

router.get('/pipelines', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, is_default, created_at, updated_at
         FROM coexistence.pipelines
        ORDER BY is_default DESC, created_at ASC, id ASC`
    );
    res.json({ pipelines: rows.map(pipelineRow) });
  } catch (err) {
    console.error('[pipelines] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pipelines' });
  }
});

router.post('/pipelines', async (req, res) => {
  if (!adminGate(req, res)) return;
  const client = await pool.connect();
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Pipeline name is required' });
    }
    await client.query('BEGIN');

    // First pipeline becomes the default.
    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.pipelines`
    );
    const isDefault = (cnt[0]?.n || 0) === 0;

    const { rows } = await client.query(
      `INSERT INTO coexistence.pipelines (name, is_default, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [name.trim(), isDefault, req.user?.id || null]
    );
    const pipeline = rows[0];

    // Seed default stages.
    for (let i = 0; i < DEFAULT_STAGES.length; i++) {
      const s = DEFAULT_STAGES[i];
      await client.query(
        `INSERT INTO coexistence.pipeline_stages
           (pipeline_id, name, color, sort_order, probability, is_won, is_lost, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [pipeline.id, s.name, s.color, i, s.probability, s.is_won, s.is_lost]
      );
    }

    await client.query('COMMIT');
    emitPipelineChanged(pipeline.id, { listChanged: true });
    res.status(201).json({ pipeline: pipelineRow(pipeline) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipelines] create error:', err.message);
    res.status(500).json({ error: 'Failed to create pipeline' });
  } finally {
    client.release();
  }
});

router.put('/pipelines/:id', async (req, res) => {
  if (!adminGate(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Pipeline name is required' });
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.pipelines SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name.trim(), id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pipeline not found' });
    emitPipelineChanged(id, { listChanged: true });
    res.json({ pipeline: pipelineRow(rows[0]) });
  } catch (err) {
    console.error('[pipelines] update error:', err.message);
    res.status(500).json({ error: 'Failed to update pipeline' });
  }
});

router.delete('/pipelines/:id', async (req, res) => {
  if (!adminGate(req, res)) return;
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM coexistence.pipelines WHERE id = $1 RETURNING is_default`,
      [id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    // If we removed the default, promote the oldest remaining pipeline.
    if (rows[0].is_default) {
      await client.query(
        `UPDATE coexistence.pipelines SET is_default = TRUE, updated_at = NOW()
          WHERE id = (SELECT id FROM coexistence.pipelines ORDER BY created_at ASC, id ASC LIMIT 1)`
      );
    }
    await client.query('COMMIT');
    emitPipelineChanged(id, { listChanged: true });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipelines] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete pipeline' });
  } finally {
    client.release();
  }
});

// ── Board (stages + deals + KPIs in one fetch) ───────────────────────────────

router.get('/pipelines/:id/board', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: pRows } = await pool.query(
      `SELECT id, name, is_default, created_at, updated_at
         FROM coexistence.pipelines WHERE id = $1`,
      [id]
    );
    if (!pRows.length) return res.status(404).json({ error: 'Pipeline not found' });

    const { rows: stageRows } = await pool.query(
      `SELECT * FROM coexistence.pipeline_stages
        WHERE pipeline_id = $1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );

    // Non-admins see only their own deals (assigned to them, or whose linked
    // contact is assigned to them). The same scope feeds the KPI rollup so the
    // tiles never disagree with the visible cards.
    const scope = dealScopeClause(req, 2);              // '' for admins, else AND (...$2...)
    const params = isAdmin(req) ? [id] : [id, meId(req)];

    const { rows: dealRows } = await pool.query(
      `SELECT d.*, u.display_name AS assigned_user_name
         FROM coexistence.deals d
         LEFT JOIN coexistence.forgecrm_users u ON u.id = d.assigned_user_id
         LEFT JOIN coexistence.contacts c
           ON c.wa_number = d.contact_wa_number AND c.contact_number = d.contact_number
        WHERE d.pipeline_id = $1 ${scope}
        ORDER BY d.sort_order ASC, d.id ASC`,
      params
    );

    // KPIs. Open = deals not in a won/lost stage. Weighted uses stage probability.
    const { rows: kpiRows } = await pool.query(
      `WITH scoped_deals AS (
         SELECT d.value, d.status, d.won_at, d.lost_at, s.probability
           FROM coexistence.deals d
           JOIN coexistence.pipeline_stages s ON s.id = d.stage_id
           LEFT JOIN coexistence.contacts c
             ON c.wa_number = d.contact_wa_number AND c.contact_number = d.contact_number
          WHERE d.pipeline_id = $1 ${scope}
       )
       SELECT
         (SELECT COUNT(*)               FROM scoped_deals WHERE status='open')             AS total_deals,
         (SELECT COALESCE(SUM(value),0) FROM scoped_deals WHERE status='open')             AS pipeline_value,
         (SELECT COALESCE(SUM(value * probability / 100.0),0) FROM scoped_deals WHERE status='open') AS weighted_value,
         (SELECT COUNT(*) FROM scoped_deals
            WHERE status='won'  AND won_at  AT TIME ZONE 'Asia/Kolkata'
                  >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata'))               AS won_this_month,
         (SELECT COUNT(*) FROM scoped_deals
            WHERE status='lost' AND lost_at AT TIME ZONE 'Asia/Kolkata'
                  >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata'))               AS lost_this_month`,
      params
    );
    const k = kpiRows[0] || {};
    const totalDeals = Number(k.total_deals || 0);
    const pipelineValue = Number(k.pipeline_value || 0);
    const kpis = {
      totalDeals,
      pipelineValue,
      avgDealSize: totalDeals ? pipelineValue / totalDeals : 0,
      weightedValue: Number(k.weighted_value || 0),
      wonThisMonth: Number(k.won_this_month || 0),
      lostThisMonth: Number(k.lost_this_month || 0),
    };

    res.json({
      pipeline: pipelineRow(pRows[0]),
      stages: stageRows.map(stageRow),
      deals: dealRows.map(dealRow),
      kpis,
    });
  } catch (err) {
    console.error('[pipelines] board error:', err.message);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// ── Stages ───────────────────────────────────────────────────────────────────

router.post('/pipelines/:id/stages', async (req, res) => {
  if (!adminGate(req, res)) return;
  try {
    const pipelineId = parseInt(req.params.id, 10);
    const { name, color, probability, isWon, isLost } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Stage name is required' });
    }
    const { rows: pRows } = await pool.query(
      `SELECT 1 FROM coexistence.pipelines WHERE id = $1`, [pipelineId]
    );
    if (!pRows.length) return res.status(404).json({ error: 'Pipeline not found' });

    const { rows: ord } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM coexistence.pipeline_stages WHERE pipeline_id = $1`,
      [pipelineId]
    );
    const { rows } = await pool.query(
      `INSERT INTO coexistence.pipeline_stages
         (pipeline_id, name, color, sort_order, probability, is_won, is_lost, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [
        pipelineId, name.trim(), color || '#6B7280', ord[0].next,
        clampProb(probability), !!isWon, !!isLost,
      ]
    );
    emitPipelineChanged(pipelineId);
    res.status(201).json({ stage: stageRow(rows[0]) });
  } catch (err) {
    console.error('[pipelines] stage create error:', err.message);
    res.status(500).json({ error: 'Failed to add stage' });
  }
});

router.put('/pipelines/:id/stages/reorder', async (req, res) => {
  if (!adminGate(req, res)) return;
  const client = await pool.connect();
  try {
    const pipelineId = parseInt(req.params.id, 10);
    const { order } = req.body || {};
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: 'order must be an array of stage ids' });
    }
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE coexistence.pipeline_stages SET sort_order = $1, updated_at = NOW()
          WHERE id = $2 AND pipeline_id = $3`,
        [i, parseInt(order[i], 10), pipelineId]
      );
    }
    await client.query('COMMIT');
    emitPipelineChanged(pipelineId);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[pipelines] stage reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder stages' });
  } finally {
    client.release();
  }
});

router.put('/stages/:id', async (req, res) => {
  if (!adminGate(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { name, color, probability, isWon, isLost } = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;
    if (name !== undefined) {
      if (!name || !name.trim()) return res.status(400).json({ error: 'Stage name cannot be empty' });
      fields.push(`name = $${i++}`); vals.push(name.trim());
    }
    if (color !== undefined) { fields.push(`color = $${i++}`); vals.push(color || '#6B7280'); }
    if (probability !== undefined) { fields.push(`probability = $${i++}`); vals.push(clampProb(probability)); }
    if (isWon !== undefined) { fields.push(`is_won = $${i++}`); vals.push(!!isWon); }
    if (isLost !== undefined) { fields.push(`is_lost = $${i++}`); vals.push(!!isLost); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE coexistence.pipeline_stages SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Stage not found' });
    emitPipelineChanged(rows[0].pipeline_id);
    res.json({ stage: stageRow(rows[0]) });
  } catch (err) {
    console.error('[pipelines] stage update error:', err.message);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

router.delete('/stages/:id', async (req, res) => {
  if (!adminGate(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: stg } = await pool.query(
      `SELECT pipeline_id FROM coexistence.pipeline_stages WHERE id = $1`, [id]
    );
    if (!stg.length) return res.status(404).json({ error: 'Stage not found' });

    const { rows: dealCnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.deals WHERE stage_id = $1`, [id]
    );
    if ((dealCnt[0]?.n || 0) > 0) {
      return res.status(409).json({ error: 'Move or delete this stage’s deals first' });
    }
    const { rows: total } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.pipeline_stages WHERE pipeline_id = $1`,
      [stg[0].pipeline_id]
    );
    if ((total[0]?.n || 0) <= 1) {
      return res.status(409).json({ error: 'A pipeline must have at least one stage' });
    }
    await pool.query(`DELETE FROM coexistence.pipeline_stages WHERE id = $1`, [id]);
    emitPipelineChanged(stg[0].pipeline_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[pipelines] stage delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete stage' });
  }
});

// ── Deals ─────────────────────────────────────────────────────────────────────

router.post('/pipelines/:id/deals', async (req, res) => {
  try {
    const pipelineId = parseInt(req.params.id, 10);
    const {
      stageId, title, value, currency, contactWaNumber, contactNumber,
      contactName, assignedUserId, expectedCloseDate, notes,
    } = req.body || {};

    if (!title || !title.trim()) return res.status(400).json({ error: 'Deal title is required' });
    if (!stageId) return res.status(400).json({ error: 'Stage is required' });

    // Validate the stage belongs to the pipeline and get its won/lost flags.
    const { rows: stg } = await pool.query(
      `SELECT id, is_won, is_lost FROM coexistence.pipeline_stages WHERE id = $1 AND pipeline_id = $2`,
      [parseInt(stageId, 10), pipelineId]
    );
    if (!stg.length) return res.status(400).json({ error: 'Invalid stage for this pipeline' });
    const status = stg[0].is_won ? 'won' : stg[0].is_lost ? 'lost' : 'open';

    const { rows: ord } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM coexistence.deals WHERE stage_id = $1`,
      [parseInt(stageId, 10)]
    );

    // Non-admins can only own their deals: force the assignee to the creator so
    // the new card stays visible to them regardless of the picker.
    const assignee = isAdmin(req)
      ? (assignedUserId ? parseInt(assignedUserId, 10) : null)
      : meId(req);

    const { rows } = await pool.query(
      `INSERT INTO coexistence.deals
         (pipeline_id, stage_id, title, value, currency, contact_wa_number, contact_number,
          contact_name, assigned_user_id, status, expected_close_date, notes, sort_order,
          won_at, lost_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $10 = 'won' THEN NOW() END,
               CASE WHEN $10 = 'lost' THEN NOW() END,
               $14, NOW(), NOW())
       RETURNING *`,
      [
        pipelineId, parseInt(stageId, 10), title.trim(),
        normalizeNumber(value), currency || 'INR',
        contactWaNumber || null, contactNumber || null, contactName || null,
        assignee,
        status, expectedCloseDate || null, notes || null, ord[0].next,
        req.user?.id || null,
      ]
    );

    // If this deal links a contact and has an assignee, hand that contact (and
    // its chat) to the assignee — same behaviour as assigning in Chats.
    if (assignee && contactWaNumber && contactNumber) {
      await syncContactAssignment(contactWaNumber, contactNumber, assignee);
    }

    emitPipelineChanged(pipelineId);
    res.status(201).json({ deal: dealRow(rows[0]) });
  } catch (err) {
    console.error('[pipelines] deal create error:', err.message);
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

router.put('/deals/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessDeal(req, id))) return res.status(403).json({ error: 'You can only edit your own deals' });
    const b = req.body || {};
    const map = {
      title: 'title', currency: 'currency', contactWaNumber: 'contact_wa_number',
      contactNumber: 'contact_number', contactName: 'contact_name',
      expectedCloseDate: 'expected_close_date', notes: 'notes',
    };
    const fields = [];
    const vals = [];
    let i = 1;
    for (const [key, col] of Object.entries(map)) {
      if (b[key] !== undefined) {
        fields.push(`${col} = $${i++}`);
        vals.push(b[key] === '' ? null : b[key]);
      }
    }
    if (b.value !== undefined) { fields.push(`value = $${i++}`); vals.push(normalizeNumber(b.value)); }
    // Only admins may change a deal's assignee (a BDA can't hand a deal off and
    // lose visibility, nor reassign someone else's deal).
    if (b.assignedUserId !== undefined && isAdmin(req)) {
      fields.push(`assigned_user_id = $${i++}`);
      vals.push(b.assignedUserId ? parseInt(b.assignedUserId, 10) : null);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE coexistence.deals SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
    // Re-fetch with assignee name for a consistent shape.
    const { rows: full } = await pool.query(
      `SELECT d.*, u.display_name AS assigned_user_name
         FROM coexistence.deals d
         LEFT JOIN coexistence.forgecrm_users u ON u.id = d.assigned_user_id
        WHERE d.id = $1`,
      [id]
    );
    // If an admin (re)assigned the deal, mirror it onto the linked contact so
    // the new owner gets the contact + chat too.
    if (b.assignedUserId !== undefined && isAdmin(req)) {
      const d = full[0];
      if (d.assigned_user_id && d.contact_wa_number && d.contact_number) {
        await syncContactAssignment(d.contact_wa_number, d.contact_number, d.assigned_user_id);
      }
    }
    emitPipelineChanged(full[0].pipeline_id);
    res.json({ deal: dealRow(full[0]) });
  } catch (err) {
    console.error('[pipelines] deal update error:', err.message);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// Move a deal to a (possibly new) stage. Recomputes status + won/lost timestamps.
router.put('/deals/:id/move', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessDeal(req, id))) return res.status(403).json({ error: 'You can only move your own deals' });
    const { stageId, sortOrder } = req.body || {};
    if (!stageId) return res.status(400).json({ error: 'stageId is required' });

    const { rows: dealRows } = await pool.query(
      `SELECT pipeline_id FROM coexistence.deals WHERE id = $1`, [id]
    );
    if (!dealRows.length) return res.status(404).json({ error: 'Deal not found' });

    const { rows: stg } = await pool.query(
      `SELECT is_won, is_lost FROM coexistence.pipeline_stages WHERE id = $1 AND pipeline_id = $2`,
      [parseInt(stageId, 10), dealRows[0].pipeline_id]
    );
    if (!stg.length) return res.status(400).json({ error: 'Invalid stage for this pipeline' });
    const status = stg[0].is_won ? 'won' : stg[0].is_lost ? 'lost' : 'open';

    let order = sortOrder;
    if (order === undefined || order === null) {
      const { rows: ord } = await pool.query(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM coexistence.deals WHERE stage_id = $1`,
        [parseInt(stageId, 10)]
      );
      order = ord[0].next;
    }

    await pool.query(
      `UPDATE coexistence.deals
          SET stage_id = $1,
              status = $2,
              sort_order = $3,
              won_at  = CASE WHEN $2 = 'won'  THEN COALESCE(won_at,  NOW()) ELSE NULL END,
              lost_at = CASE WHEN $2 = 'lost' THEN COALESCE(lost_at, NOW()) ELSE NULL END,
              updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [parseInt(stageId, 10), status, parseInt(order, 10), id]
    );
    const { rows: full } = await pool.query(
      `SELECT d.*, u.display_name AS assigned_user_name
         FROM coexistence.deals d
         LEFT JOIN coexistence.forgecrm_users u ON u.id = d.assigned_user_id
        WHERE d.id = $1`,
      [id]
    );
    emitPipelineChanged(full[0].pipeline_id);
    res.json({ deal: dealRow(full[0]) });
  } catch (err) {
    console.error('[pipelines] deal move error:', err.message);
    res.status(500).json({ error: 'Failed to move deal' });
  }
});

router.delete('/deals/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can delete deals' });
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `DELETE FROM coexistence.deals WHERE id = $1 RETURNING pipeline_id`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Deal not found' });
    emitPipelineChanged(rows[0].pipeline_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[pipelines] deal delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

// ── Pickers ───────────────────────────────────────────────────────────────────

// Search saved CRM contacts for the Add Deal form.
router.get('/deal-contacts', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const tagIds = String(req.query.tags || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    // Build the WHERE dynamically so search + tag filter + per-user scope
    // each contribute their own bind params.
    const params = [];
    const where = [];

    params.push(q);            const pQ = `$${params.length}`;
    params.push(`%${q}%`);     const pLike = `$${params.length}`;
    where.push(`(${pQ} = '' OR COALESCE(name, profile_name) ILIKE ${pLike} OR contact_number ILIKE ${pLike})`);

    // Tag filter: contact has at least one of the selected tags (any-match).
    if (tagIds.length) {
      params.push(tagIds);     const pTags = `$${params.length}`;
      where.push(`EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(tags, '[]'::jsonb)) tg
         WHERE tg->>'id' = ANY(${pTags}::text[]))`);
    }

    // Non-admins can only attach contacts assigned to them.
    if (!isAdmin(req)) {
      params.push(meId(req));  const pMe = `$${params.length}`;
      where.push(`assigned_user_id = ${pMe}`);
    }

    const { rows } = await pool.query(
      `SELECT wa_number, contact_number,
              COALESCE(name, profile_name) AS name,
              COALESCE(tags, '[]'::jsonb) AS tags
         FROM coexistence.contacts
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(name, profile_name) NULLS LAST, contact_number
        LIMIT 20`,
      params
    );
    res.json({
      contacts: rows.map(r => ({
        waNumber: r.wa_number,
        contactNumber: r.contact_number,
        name: r.name || null,
        tags: Array.isArray(r.tags) ? r.tags : [],
      })),
    });
  } catch (err) {
    console.error('[pipelines] deal-contacts error:', err.message);
    res.status(500).json({ error: 'Failed to search contacts' });
  }
});

// Active users for the assignee picker (minimal fields, read-only).
router.get('/deal-assignees', async (req, res) => {
  try {
    // Admins can assign to anyone; a non-admin can only assign to themselves.
    const sql = isAdmin(req)
      ? `SELECT id, display_name, role FROM coexistence.forgecrm_users
          WHERE is_active = TRUE
          ORDER BY display_name NULLS LAST, id`
      : `SELECT id, display_name, role FROM coexistence.forgecrm_users WHERE id = $1`;
    const { rows } = await pool.query(sql, isAdmin(req) ? [] : [meId(req)]);
    res.json({
      users: rows.map(r => ({ id: Number(r.id), name: r.display_name, role: r.role })),
    });
  } catch (err) {
    console.error('[pipelines] deal-assignees error:', err.message);
    res.status(500).json({ error: 'Failed to fetch assignees' });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

function clampProb(p) {
  const n = parseInt(p, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function normalizeNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

module.exports = { router };
