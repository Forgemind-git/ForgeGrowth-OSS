// Resources — the "share" materials. is_dynamic=false → Content Library (static
// catalog); is_dynamic=true → Live Links (the 3-4 fields that change every batch,
// edited in Chats → AI Agents). Also surfaces the trigger-word library view.
// Mounted under /api with authMiddleware in index.js.
//
//   GET    /resources?dynamic=false|true   list (Content Library / Live Links)
//   POST   /resources                       create
//   PUT    /resources/:id                   edit
//   DELETE /resources/:id                   delete
//   POST   /resources/:id/retire            archive (is_retired = true)
//   GET    /trigger-library                 phrase → resource bundle mapping table
//   PUT    /resources/:id/triggers          edit trigger phrases + applicable stage
//   POST   /trigger-test                    dry-run: which resources match a phrase

const { Router } = require('express');
const pool = require('../db');

const router = Router();

function resourceRow(r) {
  const sends = Number(r.sends || 0);
  return {
    id: Number(r.id), title: r.title, type: r.type,
    stageTags: r.stage_tags || [], fileUrl: r.file_url,
    isDynamic: r.is_dynamic, triggerPhrases: r.trigger_phrases || [],
    applicableStage: r.applicable_stage,
    opens: Number(r.opens || 0), clicks: Number(r.clicks || 0), sends,
    repliesAfterSend: Number(r.replies_after_send || 0),
    replyRate: sends ? Math.round((Number(r.replies_after_send || 0) / sends) * 100) : 0,
    openRate: sends ? Math.round((Number(r.opens || 0) / sends) * 100) : 0,
    isRetired: r.is_retired,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/resources', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.dynamic !== undefined) {
      params.push(String(req.query.dynamic) === 'true');
      where.push(`is_dynamic = $${params.length}`);
    }
    if (req.query.includeRetired !== 'true') where.push(`is_retired = FALSE`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.resources ${clause} ORDER BY updated_at DESC, id DESC`, params
    );
    res.json({ resources: rows.map(resourceRow) });
  } catch (err) {
    console.error('[resources] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

router.post('/resources', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'Title is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.resources
         (title, type, stage_tags, file_url, is_dynamic, trigger_phrases, applicable_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        b.title.trim(), b.type || 'Link',
        JSON.stringify(Array.isArray(b.stageTags) ? b.stageTags : []),
        b.fileUrl || null, !!b.isDynamic,
        JSON.stringify(Array.isArray(b.triggerPhrases) ? b.triggerPhrases : []),
        b.applicableStage || null,
      ]
    );
    res.status(201).json({ resource: resourceRow(rows[0]) });
  } catch (err) {
    console.error('[resources] create error:', err.message);
    res.status(500).json({ error: 'Failed to create resource' });
  }
});

router.put('/resources/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const fields = []; const vals = []; let i = 1;
    const scalar = { title: 'title', type: 'type', fileUrl: 'file_url', applicableStage: 'applicable_stage' };
    for (const [k, col] of Object.entries(scalar)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(b[k] === '' ? null : b[k]); }
    }
    if (b.isDynamic !== undefined) { fields.push(`is_dynamic = $${i++}`); vals.push(!!b.isDynamic); }
    if (b.isRetired !== undefined) { fields.push(`is_retired = $${i++}`); vals.push(!!b.isRetired); }
    if (b.stageTags !== undefined) { fields.push(`stage_tags = $${i++}`); vals.push(JSON.stringify(b.stageTags || [])); }
    if (b.triggerPhrases !== undefined) { fields.push(`trigger_phrases = $${i++}`); vals.push(JSON.stringify(b.triggerPhrases || [])); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`); vals.push(id);
    const { rows } = await pool.query(`UPDATE coexistence.resources SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json({ resource: resourceRow(rows[0]) });
  } catch (err) {
    console.error('[resources] update error:', err.message);
    res.status(500).json({ error: 'Failed to update resource' });
  }
});

router.delete('/resources/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM coexistence.resources WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!rowCount) return res.status(404).json({ error: 'Resource not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[resources] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete resource' });
  }
});

router.post('/resources/:id/retire', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.resources SET is_retired = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [parseInt(req.params.id, 10)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json({ resource: resourceRow(rows[0]) });
  } catch (err) {
    console.error('[resources] retire error:', err.message);
    res.status(500).json({ error: 'Failed to retire resource' });
  }
});

// ── trigger-word library ──────────────────────────────────────────────────────
router.get('/trigger-library', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.resources
        WHERE is_retired = FALSE AND jsonb_array_length(trigger_phrases) > 0
        ORDER BY title ASC`
    );
    res.json({ triggers: rows.map(resourceRow) });
  } catch (err) {
    console.error('[resources] trigger-library error:', err.message);
    res.status(500).json({ error: 'Failed to load trigger library' });
  }
});

router.put('/resources/:id/triggers', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE coexistence.resources
          SET trigger_phrases = $1, applicable_stage = COALESCE($2, applicable_stage), updated_at = NOW()
        WHERE id = $3 RETURNING *`,
      [JSON.stringify(Array.isArray(b.triggerPhrases) ? b.triggerPhrases : []), b.applicableStage || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json({ resource: resourceRow(rows[0]) });
  } catch (err) {
    console.error('[resources] triggers error:', err.message);
    res.status(500).json({ error: 'Failed to update triggers' });
  }
});

router.post('/trigger-test', async (req, res) => {
  try {
    const phrase = String(req.body?.phrase || '').toLowerCase().trim();
    if (!phrase) return res.status(400).json({ error: 'phrase is required' });
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.resources WHERE is_retired = FALSE AND jsonb_array_length(trigger_phrases) > 0`
    );
    const matches = rows.map(resourceRow).filter(r =>
      (r.triggerPhrases || []).some(tp => phrase.includes(String(tp).toLowerCase()))
    );
    res.json({ matches });
  } catch (err) {
    console.error('[resources] trigger-test error:', err.message);
    res.status(500).json({ error: 'Failed to test trigger' });
  }
});

module.exports = { router };
