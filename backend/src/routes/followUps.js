// Follow-up Sequences — Chats → Follow-ups.
//
// CRUD for sequences + steps, enrollment listing, manual enrollment, and the
// outcome log. The sending itself lives in services/followUpEngine.js (the
// cursor sweeper); these routes only shape configuration and state.
//
// Reads require the `follow-up-sequence` page permission (admin-only by role
// default); every mutation is additionally adminOnly — sequences send real
// WhatsApp messages on live accounts.
const { Router } = require('express');
const pool = require('../db');
const { adminOnly, requirePermission } = require('../middleware/access');
const cfg = require('../services/funnelConfig');
const { templateBlockReason, templateVarMax } = require('../services/followUpEngine');
const { stepTokenError } = require('../services/variables');

const router = Router();
const canView = requirePermission('follow-up-sequence');

// A non-numeric :id must 404 cleanly — parseInt('abc') is NaN, and NaN
// reaching Postgres as a bind value 500s the whole route.
const intId = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// The three switches control live message sending — only a real boolean may
// flip them ("false" the string is truthy and would otherwise ACTIVATE).
const strictBool = (v) => (typeof v === 'boolean' ? v : null);

// Step delete/reorder shifts what every mid-run lead receives next
// (enrollments store a position, not a step id) — refuse while runs are live,
// mirroring the sequence-delete guard.
async function activeRunsGuard(sequenceId, res) {
  const { rows: [live] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.follow_up_enrollments
      WHERE sequence_id = $1 AND status = 'active'`, [sequenceId]);
  if (live && live.n > 0) {
    res.status(409).json({ error: `${live.n} lead(s) are mid-sequence. Stop them first — reshaping the steps under them would change what they receive next.` });
    return true;
  }
  return false;
}

const seqRow = (r) => ({
  id: Number(r.id),
  name: r.name,
  description: r.description,
  active: r.active,
  triggerStageKey: r.trigger_stage_key,
  stopOnReply: r.stop_on_reply,
  stopOnStageChange: r.stop_on_stage_change,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  projectId: r.project_id != null ? Number(r.project_id) : null,
  projectName: r.project_name || null,
  stepCount: r.step_count != null ? Number(r.step_count) : undefined,
  activeCount: r.active_count != null ? Number(r.active_count) : undefined,
  finishedCount: r.finished_count != null ? Number(r.finished_count) : undefined,
  sentCount: r.sent_count != null ? Number(r.sent_count) : undefined,
});

const stepRow = (r) => ({
  id: Number(r.id),
  sequenceId: Number(r.sequence_id),
  stepOrder: r.step_order,
  delayMinutes: r.delay_minutes,
  messageKind: r.message_kind,
  templateId: r.template_id != null ? Number(r.template_id) : null,
  templateVariables: Array.isArray(r.template_variables) ? r.template_variables : [],
  body: r.body,
});

const enrollmentRow = (r) => ({
  id: Number(r.id),
  sequenceId: Number(r.sequence_id),
  leadId: Number(r.lead_id),
  leadName: r.lead_name,
  leadNumber: r.lead_number,
  leadStage: r.lead_stage,
  status: r.status,
  stageKeyAtEnrollment: r.stage_key_at_enrollment,
  nextStepOrder: r.next_step_order,
  nextSendAt: r.next_send_at,
  enrolledBy: r.enrolled_by,
  enrolledAt: r.enrolled_at,
  lastSentAt: r.last_sent_at,
  finishedAt: r.finished_at,
  stopReason: r.stop_reason,
});

const STATS_SQL = `
  (SELECT COUNT(*)::int FROM coexistence.follow_up_steps st WHERE st.sequence_id = s.id) AS step_count,
  (SELECT COUNT(*)::int FROM coexistence.follow_up_enrollments e
    WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count,
  (SELECT COUNT(*)::int FROM coexistence.follow_up_enrollments e
    WHERE e.sequence_id = s.id AND e.status <> 'active') AS finished_count,
  (SELECT COUNT(*)::int FROM coexistence.follow_up_log fl
    WHERE fl.sequence_id = s.id AND fl.status = 'sent') AS sent_count`;

// Reject a step whose message can never be sent by the engine. Approval status
// is deliberately NOT checked here — a DRAFT template may be approved later;
// only structurally-unsendable shapes are refused (they can never become
// sendable through this engine, however long you wait).
const STEP_BLOCK_MESSAGES = {
  carousel_not_supported: 'Carousel templates cannot be used in a follow-up step — use a broadcast.',
  media_header_not_supported: 'Templates with an image/video/document header are not supported in follow-up steps yet. Pick a text-only template.',
  header_variable_not_supported: 'This template has a variable in its HEADER. Follow-up steps only fill body variables — pick a template whose variables are all in the body.',
  button_variables_not_supported: 'This template has a dynamic URL or coupon button (like payment and form templates). Follow-up steps cannot fill button values — pick a template with static buttons or none.',
};

async function stepValidationError({ messageKind, templateId, templateVariables, body, delayMinutes }) {
  const mins = parseInt(delayMinutes, 10);
  if (!Number.isFinite(mins) || mins < 1) return 'The wait must be at least 1 minute.';
  if (mins > 60 * 24 * 60) return 'The wait cannot exceed 60 days.';
  if (messageKind === 'text') {
    if (!body || !String(body).trim()) return 'A text step needs a message body.';
    // Reject unknown {{tokens}} NOW — the engine leaves them as-is at send
    // time, so without this a typo reaches the customer as literal braces.
    const tokenErr = await stepTokenError([body]);
    if (tokenErr) return tokenErr;
    return null;
  }
  if (messageKind === 'template') {
    const tid = intId(templateId);
    if (tid == null) return 'A template step needs a template.';
    const { rows: [t] } = await pool.query(
      `SELECT id, status, header_type, header_text, template_type, body, buttons
         FROM coexistence.message_templates WHERE id = $1`, [tid]);
    if (!t) return 'That template no longer exists.';
    const blocked = templateBlockReason({ ...t, status: 'APPROVED' }); // status checked at send time
    if (blocked) return STEP_BLOCK_MESSAGES[blocked] || 'That template cannot be used in a follow-up step.';
    // Meta rejects a body-parameter count mismatch — the UI enforces this, but
    // a step created via the API/MCP must not be able to ship short.
    const need = templateVarMax(t.body);
    const vars = Array.isArray(templateVariables) ? templateVariables : [];
    if (vars.length < need) {
      return `This template needs ${need} variable value${need === 1 ? '' : 's'} ({{1}}…{{${need}}}).`;
    }
    const tokenErr = await stepTokenError(vars.map(v => String(v ?? '')));
    if (tokenErr) return tokenErr;
    return null;
  }
  return 'messageKind must be template or text.';
}

// ── Sequences ────────────────────────────────────────────────────────────────

router.get('/follow-up-sequences', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS project_name, ${STATS_SQL}
         FROM coexistence.follow_up_sequences s
         LEFT JOIN coexistence.projects p ON p.id = s.project_id
        ORDER BY s.created_at DESC`);
    res.json({ sequences: rows.map(seqRow) });
  } catch (err) {
    console.error('[follow-ups] list error:', err.message);
    res.status(500).json({ error: 'Failed to load follow-up sequences' });
  }
});

router.post('/follow-up-sequences', canView, adminOnly, async (req, res) => {
  try {
    const { name, description, triggerStageKey, stopOnReply, stopOnStageChange } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A sequence needs a name.' });
    if (triggerStageKey && !cfg.isValidStage(triggerStageKey)) {
      return res.status(400).json({ error: 'That funnel stage does not exist.' });
    }
    if ((stopOnReply !== undefined && typeof stopOnReply !== 'boolean') ||
        (stopOnStageChange !== undefined && typeof stopOnStageChange !== 'boolean')) {
      return res.status(400).json({ error: 'Stop rules must be true or false.' });
    }
    let projectId = null;
    let projectName = null;
    if (req.body?.projectId != null && req.body.projectId !== '') {
      projectId = intId(req.body.projectId);
      if (projectId == null) return res.status(400).json({ error: 'Invalid project' });
      const { rows: [p] } = await pool.query(
        `SELECT name FROM coexistence.projects WHERE id = $1`, [projectId]);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      projectName = p.name;
    }
    // Always created INACTIVE — activation is a separate, deliberate step.
    const { rows: [r] } = await pool.query(
      `INSERT INTO coexistence.follow_up_sequences
         (name, description, active, trigger_stage_key, stop_on_reply, stop_on_stage_change, created_by, project_id)
       VALUES ($1, $2, FALSE, $3, COALESCE($4, TRUE), COALESCE($5, TRUE), $6, $7)
       RETURNING *`,
      [String(name).trim(), description || null, triggerStageKey || null,
       strictBool(stopOnReply), strictBool(stopOnStageChange),
       req.user?.username || null, projectId]);
    res.status(201).json(seqRow({ ...r, project_name: projectName }));
  } catch (err) {
    console.error('[follow-ups] create error:', err.message);
    res.status(500).json({ error: 'Failed to create the sequence' });
  }
});

router.get('/follow-up-sequences/:id', canView, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Sequence not found' });
    const { rows: [r] } = await pool.query(
      `SELECT s.*, p.name AS project_name, ${STATS_SQL}
         FROM coexistence.follow_up_sequences s
         LEFT JOIN coexistence.projects p ON p.id = s.project_id
        WHERE s.id = $1`, [id]);
    if (!r) return res.status(404).json({ error: 'Sequence not found' });
    const { rows: steps } = await pool.query(
      `SELECT * FROM coexistence.follow_up_steps WHERE sequence_id = $1 ORDER BY step_order, id`, [id]);
    res.json({ ...seqRow(r), steps: steps.map(stepRow) });
  } catch (err) {
    console.error('[follow-ups] get error:', err.message);
    res.status(500).json({ error: 'Failed to load the sequence' });
  }
});

router.put('/follow-up-sequences/:id', canView, adminOnly, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Sequence not found' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (b.name !== undefined) {
      if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'A sequence needs a name.' });
      set('name', String(b.name).trim());
    }
    if (b.description !== undefined) set('description', b.description || null);
    if (b.triggerStageKey !== undefined) {
      if (b.triggerStageKey && !cfg.isValidStage(b.triggerStageKey)) {
        return res.status(400).json({ error: 'That funnel stage does not exist.' });
      }
      set('trigger_stage_key', b.triggerStageKey || null);
    }
    if (b.stopOnReply !== undefined) {
      if (typeof b.stopOnReply !== 'boolean') return res.status(400).json({ error: 'stopOnReply must be true or false.' });
      set('stop_on_reply', b.stopOnReply);
    }
    if (b.stopOnStageChange !== undefined) {
      if (typeof b.stopOnStageChange !== 'boolean') return res.status(400).json({ error: 'stopOnStageChange must be true or false.' });
      set('stop_on_stage_change', b.stopOnStageChange);
    }
    if (b.active !== undefined) {
      // Strictly boolean — the string "false" is truthy and would ACTIVATE a
      // live message sender.
      if (typeof b.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
      if (b.active) {
        const { rows: [c] } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM coexistence.follow_up_steps WHERE sequence_id = $1`, [id]);
        if (!c || c.n === 0) return res.status(400).json({ error: 'Add at least one step before activating the sequence.' });
      }
      set('active', !!b.active);
    }
    if (b.projectId !== undefined) {
      if (b.projectId == null || b.projectId === '') {
        set('project_id', null);
      } else {
        const pid = intId(b.projectId);
        if (pid == null) return res.status(400).json({ error: 'Invalid project' });
        const { rowCount } = await pool.query(`SELECT 1 FROM coexistence.projects WHERE id = $1`, [pid]);
        if (!rowCount) return res.status(404).json({ error: 'Project not found' });
        set('project_id', pid);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    set('updated_at', new Date());

    params.push(id);
    const { rows: [r] } = await pool.query(
      `UPDATE coexistence.follow_up_sequences SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params);
    if (!r) return res.status(404).json({ error: 'Sequence not found' });
    // Re-read with the project join so the response carries projectName.
    const { rows: [full] } = await pool.query(
      `SELECT s.*, p.name AS project_name
         FROM coexistence.follow_up_sequences s
         LEFT JOIN coexistence.projects p ON p.id = s.project_id
        WHERE s.id = $1`, [id]);
    res.json(seqRow(full || r));
  } catch (err) {
    console.error('[follow-ups] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the sequence' });
  }
});

router.delete('/follow-up-sequences/:id', canView, adminOnly, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Sequence not found' });
    // Refuse while runs are live — stop them first, deliberately. Deleting
    // cascades steps, enrollments AND the history log.
    const { rows: [live] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.follow_up_enrollments
        WHERE sequence_id = $1 AND status = 'active'`, [id]);
    if (live && live.n > 0) {
      return res.status(409).json({ error: `${live.n} lead(s) are still in this sequence. Stop them first.` });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.follow_up_sequences WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[follow-ups] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the sequence' });
  }
});

// ── Steps ────────────────────────────────────────────────────────────────────

router.post('/follow-up-sequences/:id/steps', canView, adminOnly, async (req, res) => {
  try {
    const seqId = intId(req.params.id);
    if (seqId == null) return res.status(404).json({ error: 'Sequence not found' });
    const { delayMinutes, messageKind, templateId, templateVariables, body } = req.body || {};
    const kind = messageKind === 'text' ? 'text' : 'template';
    const errMsg = await stepValidationError({ messageKind: kind, templateId, templateVariables, body, delayMinutes });
    if (errMsg) return res.status(400).json({ error: errMsg });

    const { rows: [r] } = await pool.query(
      `INSERT INTO coexistence.follow_up_steps
         (sequence_id, step_order, delay_minutes, message_kind, template_id, template_variables, body)
       SELECT $1, COALESCE(MAX(step_order) + 1, 0), $2, $3, $4, $5, $6
         FROM coexistence.follow_up_steps WHERE sequence_id = $1
       RETURNING *`,
      [seqId, parseInt(delayMinutes, 10), kind,
       kind === 'template' ? intId(templateId) : null,
       JSON.stringify(Array.isArray(templateVariables) ? templateVariables : []),
       kind === 'text' ? String(body).trim() : null]);
    res.status(201).json(stepRow(r));
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Sequence not found' });
    console.error('[follow-ups] add step error:', err.message);
    res.status(500).json({ error: 'Failed to add the step' });
  }
});

router.put('/follow-up-steps/:id', canView, adminOnly, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Step not found' });
    const { rows: [existing] } = await pool.query(
      `SELECT * FROM coexistence.follow_up_steps WHERE id = $1`, [id]);
    if (!existing) return res.status(404).json({ error: 'Step not found' });

    const b = req.body || {};
    const vars = b.templateVariables !== undefined
      ? (Array.isArray(b.templateVariables) ? b.templateVariables : [])
      : existing.template_variables;
    const merged = {
      messageKind: b.messageKind !== undefined ? (b.messageKind === 'text' ? 'text' : 'template') : existing.message_kind,
      templateId: b.templateId !== undefined ? b.templateId : existing.template_id,
      templateVariables: vars,
      body: b.body !== undefined ? b.body : existing.body,
      delayMinutes: b.delayMinutes !== undefined ? b.delayMinutes : existing.delay_minutes,
    };
    const errMsg = await stepValidationError(merged);
    if (errMsg) return res.status(400).json({ error: errMsg });

    const { rows: [r] } = await pool.query(
      `UPDATE coexistence.follow_up_steps
          SET delay_minutes = $2, message_kind = $3, template_id = $4,
              template_variables = $5, body = $6, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, parseInt(merged.delayMinutes, 10), merged.messageKind,
       merged.messageKind === 'template' ? intId(merged.templateId) : null,
       JSON.stringify(vars),
       merged.messageKind === 'text' ? String(merged.body).trim() : null]);
    res.json(stepRow(r));
  } catch (err) {
    console.error('[follow-ups] update step error:', err.message);
    res.status(500).json({ error: 'Failed to update the step' });
  }
});

router.delete('/follow-up-steps/:id', canView, adminOnly, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'Step not found' });
    const { rows: [step] } = await pool.query(
      `SELECT sequence_id FROM coexistence.follow_up_steps WHERE id = $1`, [id]);
    if (!step) return res.status(404).json({ error: 'Step not found' });
    if (await activeRunsGuard(step.sequence_id, res)) return;
    await pool.query(`DELETE FROM coexistence.follow_up_steps WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[follow-ups] delete step error:', err.message);
    res.status(500).json({ error: 'Failed to delete the step' });
  }
});

router.put('/follow-up-sequences/:id/steps/reorder', canView, adminOnly, async (req, res) => {
  try {
    const seqId = intId(req.params.id);
    if (seqId == null) return res.status(404).json({ error: 'Sequence not found' });
    if (await activeRunsGuard(seqId, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => intId(n)) : [];
    if (!ids.length || ids.some(n => n == null)) return res.status(400).json({ error: 'ids required' });
    // The new order must be a permutation of the sequence's actual steps — a
    // partial or foreign list would leave duplicate/global step_order values.
    const { rows: current } = await pool.query(
      `SELECT id FROM coexistence.follow_up_steps WHERE sequence_id = $1`, [seqId]);
    const have = new Set(current.map(r => Number(r.id)));
    if (ids.length !== have.size || ids.some(n => !have.has(n))) {
      return res.status(400).json({ error: 'The order list must contain exactly this sequence’s steps.' });
    }
    // One statement — atomic, no half-applied ordering on failure.
    await pool.query(
      `UPDATE coexistence.follow_up_steps s
          SET step_order = x.ord - 1, updated_at = NOW()
         FROM (SELECT * FROM unnest($2::bigint[]) WITH ORDINALITY) AS x(id, ord)
        WHERE s.id = x.id AND s.sequence_id = $1`,
      [seqId, ids]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[follow-ups] reorder error:', err.message);
    res.status(500).json({ error: 'Failed to reorder steps' });
  }
});

// ── Enrollments ──────────────────────────────────────────────────────────────

router.get('/follow-up-sequences/:id/enrollments', canView, async (req, res) => {
  try {
    const seqId = intId(req.params.id);
    if (seqId == null) return res.status(404).json({ error: 'Sequence not found' });
    const status = req.query.status || '';
    const params = [seqId];
    let where = 'WHERE e.sequence_id = $1';
    if (status === 'active') where += ` AND e.status = 'active'`;
    else if (status === 'finished') where += ` AND e.status <> 'active'`;
    const { rows } = await pool.query(
      `SELECT e.*, l.name AS lead_name, l.whatsapp_number AS lead_number, l.stage AS lead_stage
         FROM coexistence.follow_up_enrollments e
         JOIN coexistence.leads l ON l.id = e.lead_id
         ${where}
        ORDER BY CASE WHEN e.status = 'active' THEN 0 ELSE 1 END, e.next_send_at NULLS LAST, e.enrolled_at DESC
        LIMIT 500`, params);
    res.json({ enrollments: rows.map(enrollmentRow) });
  } catch (err) {
    console.error('[follow-ups] enrollments error:', err.message);
    res.status(500).json({ error: 'Failed to load enrollments' });
  }
});

router.post('/follow-up-sequences/:id/enroll', canView, adminOnly, async (req, res) => {
  try {
    const seqId = intId(req.params.id);
    if (seqId == null) return res.status(404).json({ error: 'Sequence not found' });
    const leadIds = Array.isArray(req.body?.leadIds)
      ? req.body.leadIds.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (!leadIds.length) return res.status(400).json({ error: 'Pick at least one lead.' });
    if (leadIds.length > 200) return res.status(400).json({ error: 'At most 200 leads per manual enrollment.' });

    const { rows: [seq] } = await pool.query(
      `SELECT s.id, s.stage_key, st.delay_minutes AS first_delay FROM (
         SELECT id, trigger_stage_key AS stage_key FROM coexistence.follow_up_sequences WHERE id = $1
       ) s
       LEFT JOIN LATERAL (
         SELECT delay_minutes FROM coexistence.follow_up_steps
          WHERE sequence_id = s.id ORDER BY step_order, id LIMIT 1
       ) st ON TRUE`, [seqId]);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });
    if (seq.first_delay == null) return res.status(400).json({ error: 'Add at least one step before enrolling leads.' });

    let enrolledCount = 0, skipped = 0;
    for (const leadId of leadIds) {
      // Manual enrollment MAY re-run a lead whose earlier run finished — that
      // is the human override — but never duplicates a live run (the partial
      // unique index backs this up).
      const { rowCount } = await pool.query(
        `INSERT INTO coexistence.follow_up_enrollments
           (sequence_id, lead_id, status, stage_key_at_enrollment, next_step_order, next_send_at, enrolled_by)
         SELECT $1, l.id, 'active', l.stage, 0, NOW() + make_interval(mins => $2), $3
           FROM coexistence.leads l
          WHERE l.id = $4
            AND NOT EXISTS (SELECT 1 FROM coexistence.follow_up_enrollments
                             WHERE sequence_id = $1 AND lead_id = $4 AND status = 'active')
         ON CONFLICT DO NOTHING`,
        [seqId, seq.first_delay, `user:${req.user?.username || 'admin'}`, leadId]);
      if (rowCount) enrolledCount++; else skipped++;
    }
    res.json({ enrolled: enrolledCount, skipped });
  } catch (err) {
    console.error('[follow-ups] enroll error:', err.message);
    res.status(500).json({ error: 'Failed to enroll leads' });
  }
});

router.post('/follow-up-enrollments/:id/stop', canView, adminOnly, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (id == null) return res.status(404).json({ error: 'No live enrollment with that id' });
    const { rows: [r] } = await pool.query(
      `UPDATE coexistence.follow_up_enrollments
          SET status = 'stopped', stop_reason = 'manual', finished_at = NOW(), next_send_at = NULL
        WHERE id = $1 AND status = 'active'
        RETURNING id, sequence_id, lead_id`, [id]);
    if (!r) return res.status(404).json({ error: 'No live enrollment with that id' });
    await pool.query(
      `INSERT INTO coexistence.follow_up_log (enrollment_id, sequence_id, lead_id, status, reason)
       VALUES ($1, $2, $3, 'stopped', 'manual')`, [r.id, r.sequence_id, r.lead_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[follow-ups] stop error:', err.message);
    res.status(500).json({ error: 'Failed to stop the enrollment' });
  }
});

// ── Outcome log ──────────────────────────────────────────────────────────────

router.get('/follow-up-sequences/:id/log', canView, async (req, res) => {
  try {
    const seqId = intId(req.params.id);
    if (seqId == null) return res.status(404).json({ error: 'Sequence not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT fl.*, l.name AS lead_name, l.whatsapp_number AS lead_number
         FROM coexistence.follow_up_log fl
         LEFT JOIN coexistence.leads l ON l.id = fl.lead_id
        WHERE fl.sequence_id = $1
        ORDER BY fl.ts DESC LIMIT ${limit}`, [seqId]);
    res.json({
      log: rows.map(r => ({
        id: Number(r.id),
        enrollmentId: Number(r.enrollment_id),
        leadId: Number(r.lead_id),
        leadName: r.lead_name,
        leadNumber: r.lead_number,
        stepOrder: r.step_order,
        status: r.status,
        reason: r.reason,
        localMessageId: r.local_message_id,
        ts: r.ts,
      })),
    });
  } catch (err) {
    console.error('[follow-ups] log error:', err.message);
    res.status(500).json({ error: 'Failed to load the log' });
  }
});

module.exports = { router };
