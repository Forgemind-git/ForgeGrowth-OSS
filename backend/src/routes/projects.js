// Projects — one folder for a campaign's whole toolkit (migration 094).
//
// A campaign is a COMBINATION: a broadcast template that goes out, an AI agent
// that answers whoever replies to it, and an automation that follows up. Those
// three lived in three unrelated lists. A project is the thing that holds them
// together so "the Applied AI launch" is one openable object.
//
// This table WAS automation_folders (migration 039, never used). The
// automations-only view of it still answers on /automation-folders in
// routes/chatbots.js, so the existing Automations file-manager UI is unaffected.
const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');

const router = Router();

// What can live in a project. The TABLE NAME IS READ FROM THIS MAP, never from
// the request body — that is what makes the dynamic-table assign endpoint safe.
// `countKey` is the key this kind's tally appears under in a project's
// `counts` object — the shape the Projects page renders from. It is separate
// from `plural` because the wording a person reads ("2 AI agents") is not the
// key an API client reads (`agents`).
const KINDS = {
  template:   { table: 'message_templates', noun: 'template',   plural: 'templates',  countKey: 'templates' },
  automation: { table: 'chatbots',          noun: 'automation', plural: 'automations', countKey: 'automations' },
  agent:      { table: 'agents',            noun: 'AI agent',   plural: 'AI agents',  countKey: 'agents' },
  // Follow-up sequences have no `status` column — `active` boolean instead;
  // statusExpr adapts the generic picker query (code-owned string, never input).
  followup:   { table: 'follow_up_sequences', noun: 'follow-up sequence', plural: 'follow-up sequences',
                countKey: 'followups',
                statusExpr: `(CASE WHEN x.active THEN 'ACTIVE' ELSE 'PAUSED' END)` },
  form:       { table: 'lead_forms',        noun: 'form',       plural: 'forms',      countKey: 'forms' },
};

// Every table above carries its project pointer under the SAME constraint name,
// which is what lets the FK below be a loop rather than one hand-written block
// per kind. Adding kind #6 is then a KINDS entry and nothing else.
const fkName = (table) => `${table}_project_id_fkey`;

// The one validator for "move these items into that project", shared by the
// assign route below and the MCP move_to_project tool. Shared rather than
// copied because a second kind list would have to be updated in lockstep, and
// the half that fell behind would refuse a perfectly valid kind with a message
// listing the wrong set. Throws {status, message}; returns normalised args.
function parseAssignArgs({ kind, ids, projectId } = {}) {
  const err = (status, message) => Object.assign(new Error(message), { status });
  const k = String(kind || '').trim();
  if (!KINDS[k]) throw err(400, `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite))];
  if (!list.length) throw err(400, `Pick at least one ${KINDS[k].noun} to move.`);
  // null / '' / absent all mean "unfile" — the caller's three ways of saying
  // the same thing, normalised to one.
  if (projectId == null || projectId === '') return { kind: k, ids: list, projectId: null };
  const target = parseInt(projectId, 10);
  if (!Number.isFinite(target)) throw err(400, 'projectId must be a project id, or null to unfile.');
  return { kind: k, ids: list, projectId: target };
}

// Boot self-heal, mirroring migration 094 for an instance that has the code but
// not the migration yet.
//
// ⚠ IT MUST DO THE RENAME, not just CREATE IF NOT EXISTS. An earlier version
// only created `projects`, which meant that on an instance still holding
// `automation_folders`, booting the new backend produced an EMPTY projects
// table beside the real folder table — and then migration 094's own guard
// ("skip the rename if projects already exists") would skip forever, leaving
// the app reading an empty table while every automation stayed filed under the
// old one. Caught by running this against a live database during development.
// Doing the rename here also removes the deploy-ordering hazard for this half:
// backend-first is now safe.
async function ensureProjectTables() {
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='coexistence' AND table_name='automation_folders')
         AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='coexistence' AND table_name='projects') THEN
        ALTER TABLE coexistence.automation_folders RENAME TO projects;
      END IF;
    END $$`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.projects (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      color       TEXT,
      archived    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`ALTER TABLE coexistence.projects
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS color TEXT,
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='coexistence' AND table_name='chatbots' AND column_name='folder_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='coexistence' AND table_name='chatbots' AND column_name='project_id') THEN
        ALTER TABLE coexistence.chatbots RENAME COLUMN folder_id TO project_id;
      END IF;
    END $$`);
  for (const k of Object.values(KINDS)) {
    await pool.query(
      `ALTER TABLE coexistence.${k.table} ADD COLUMN IF NOT EXISTS project_id BIGINT`
    );
  }
  // Migration 039's constraint is RENAMED rather than dropped + re-created, so
  // referential integrity is never briefly absent.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chatbots_project_id_fkey')
         AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chatbots_folder_id_fkey') THEN
        ALTER TABLE coexistence.chatbots RENAME CONSTRAINT chatbots_folder_id_fkey TO chatbots_project_id_fkey;
      END IF;
    END $$`);
  // ⚠ DERIVED FROM KINDS, deliberately — this block used to be one hand-written
  // arm per table while the ADD COLUMN above already looped. A fifth kind
  // therefore got its column and silently NO foreign key, so deleting a project
  // would have left dangling pointers instead of being refused. Keep it a loop.
  for (const k of Object.values(KINDS)) {
    await pool.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${fkName(k.table)}') THEN
           ALTER TABLE coexistence.${k.table} ADD CONSTRAINT ${fkName(k.table)}
             FOREIGN KEY (project_id) REFERENCES coexistence.projects(id) ON DELETE RESTRICT;
         END IF;
       END $$`);
  }
}

function rowToProject(r) {
  const counts = {};
  for (const k of Object.values(KINDS)) counts[k.countKey] = Number(r[k.countKey] || 0);
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description || null,
    color: r.color || null,
    archived: r.archived === true,
    counts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// One tally per kind, generated from KINDS so a new kind cannot appear in the
// detail payload while being missing from the count badge on the card.
// Every identifier here is code-owned; nothing comes from the request.
const COUNT_SELECTS = Object.values(KINDS)
  .map(k => `(SELECT COUNT(*) FROM coexistence.${k.table} x WHERE x.project_id = p.id) AS "${k.countKey}"`)
  .join(',\n         ');

const SELECT_PROJECT = `
  SELECT p.id, p.name, p.description, p.color, p.archived, p.created_at, p.updated_at,
         ${COUNT_SELECTS}
    FROM coexistence.projects p`;

// ── LIST ─────────────────────────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_PROJECT} ORDER BY p.archived, LOWER(p.name)`);
    res.json({ projects: rows.map(rowToProject) });
  } catch (err) {
    console.error('[projects] list error:', err.message);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

// ── DETAIL — the project's whole toolkit in one fetch ────────────────────────
router.get('/projects/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Project not found' });
    const { rows } = await pool.query(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });

    const [templates, automations, agents, followups, forms] = await Promise.all([
      pool.query(
        `SELECT id, name, category, language, status, template_type
           FROM coexistence.message_templates WHERE project_id = $1
          ORDER BY LOWER(name)`, [id]),
      pool.query(
        `SELECT id, name, description, status, trigger_type
           FROM coexistence.chatbots WHERE project_id = $1
          ORDER BY LOWER(name)`, [id]),
      pool.query(
        `SELECT id, name, description, status, is_active
           FROM coexistence.agents WHERE project_id = $1
          ORDER BY LOWER(name)`, [id]),
      pool.query(
        `SELECT id, name, description, active, trigger_stage_key,
                (SELECT COUNT(*)::int FROM coexistence.follow_up_steps st
                  WHERE st.sequence_id = f.id) AS step_count
           FROM coexistence.follow_up_sequences f WHERE project_id = $1
          ORDER BY LOWER(name)`, [id]),
      pool.query(
        `SELECT id, name, description, status, slug, form_type,
                (SELECT COUNT(*)::int FROM coexistence.lead_form_submissions s
                  WHERE s.form_id = lf.id) AS submission_count
           FROM coexistence.lead_forms lf WHERE project_id = $1
          ORDER BY LOWER(name)`, [id]),
    ]);

    res.json({
      project: rowToProject(rows[0]),
      templates: templates.rows.map(r => ({
        id: Number(r.id), name: r.name, category: r.category,
        language: r.language, status: r.status, templateType: r.template_type,
      })),
      automations: automations.rows.map(r => ({
        id: Number(r.id), name: r.name, description: r.description,
        status: r.status, triggerType: r.trigger_type,
      })),
      agents: agents.rows.map(r => ({
        id: Number(r.id), name: r.name, description: r.description,
        status: r.status, isActive: r.is_active === true,
      })),
      followups: followups.rows.map(r => ({
        id: Number(r.id), name: r.name, description: r.description,
        status: r.active ? 'ACTIVE' : 'PAUSED',
        triggerStageKey: r.trigger_stage_key, stepCount: Number(r.step_count || 0),
      })),
      forms: forms.rows.map(r => ({
        id: Number(r.id), name: r.name, description: r.description,
        status: r.status, slug: r.slug, formType: r.form_type || 'link',
        submissionCount: Number(r.submission_count || 0),
      })),
    });
  } catch (err) {
    console.error('[projects] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load the project' });
  }
});

// ── CREATE ───────────────────────────────────────────────────────────────────
router.post('/projects', adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Project name is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.projects (name, description, color)
       VALUES ($1,$2,$3) RETURNING id`,
      [name, req.body?.description ? String(req.body.description).trim() : null,
       req.body?.color || null]
    );
    const { rows: full } = await pool.query(`${SELECT_PROJECT} WHERE p.id = $1`, [rows[0].id]);
    res.status(201).json({ project: rowToProject(full[0]) });
  } catch (err) {
    console.error('[projects] create error:', err.message);
    res.status(500).json({ error: 'Failed to create the project' });
  }
});

// ── UPDATE (rename / recolour / archive) ─────────────────────────────────────
router.put('/projects/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.name !== undefined) {
      const v = String(b.name).trim();
      if (!v) return res.status(400).json({ error: 'Project name cannot be empty' });
      vals.push(v); sets.push(`name = $${vals.length}`);
    }
    if (b.description !== undefined) {
      vals.push(b.description ? String(b.description).trim() : null);
      sets.push(`description = $${vals.length}`);
    }
    if (b.color !== undefined) { vals.push(b.color || null); sets.push(`color = $${vals.length}`); }
    if (b.archived !== undefined) { vals.push(b.archived === true); sets.push(`archived = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');
    vals.push(id);
    const { rowCount } = await pool.query(
      `UPDATE coexistence.projects SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    const { rows: full } = await pool.query(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
    res.json({ project: rowToProject(full[0]) });
  } catch (err) {
    console.error('[projects] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the project' });
  }
});

// ── DELETE — refused while the project still holds anything ──────────────────
// Deliberately a refusal, not a cascade-to-null: a project is someone's campaign
// and silently unfiling its toolkit loses the only record of what belonged
// together. The message names what is still inside so it is actionable.
router.delete('/projects/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Derived from KINDS for the same reason as COUNT_SELECTS: a kind missing
    // here would let a project holding it be deleted, and the FK would then
    // refuse with a raw Postgres error instead of the actionable message below.
    const { rows } = await pool.query(
      `SELECT ${Object.values(KINDS)
        .map(k => `(SELECT COUNT(*)::int FROM coexistence.${k.table} WHERE project_id = $1) AS "${k.countKey}"`)
        .join(', ')}`,
      [id]
    );
    const c = rows[0];
    const parts = Object.values(KINDS)
      .filter(k => c[k.countKey] > 0)
      .map(k => `${c[k.countKey]} ${c[k.countKey] === 1 ? k.noun : k.plural}`);
    if (parts.length) {
      return res.status(409).json({
        error: `This project still holds ${parts.join(', ')}. Move them out before deleting it.`,
        counts: c,
      });
    }
    const { rowCount } = await pool.query('DELETE FROM coexistence.projects WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[projects] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the project' });
  }
});

// ── ASSIGN — move templates / automations / agents in or out ─────────────────
// One endpoint for all three kinds. { kind, ids: [], projectId: <id|null> };
// projectId null unfiles them.
router.post('/projects/assign', adminOnly, async (req, res) => {
  try {
    let kind, ids, target;
    try { ({ kind, ids, projectId: target } = parseAssignArgs(req.body || {})); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const spec = KINDS[kind];

    if (target !== null) {
      const { rowCount } = await pool.query('SELECT 1 FROM coexistence.projects WHERE id = $1', [target]);
      if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    }

    const { rowCount } = await pool.query(
      `UPDATE coexistence.${spec.table} SET project_id = $1 WHERE id = ANY($2::bigint[])`,
      [target, ids]
    );
    res.json({ ok: true, moved: rowCount, kind, projectId: target });
  } catch (err) {
    console.error('[projects] assign error:', err.message);
    res.status(500).json({ error: 'Failed to move the items' });
  }
});

// ── PICKER — every item of one kind with its current project ─────────────────
// Powers the "add to project" modal. Lives here rather than widening three
// unrelated list endpoints for a modal only this page opens.
router.get('/projects-items/:kind', async (req, res) => {
  try {
    const spec = KINDS[String(req.params.kind || '')];
    if (!spec) {
      return res.status(400).json({ error: `kind must be one of: ${Object.keys(KINDS).join(', ')}` });
    }
    const { rows } = await pool.query(
      `SELECT x.id, x.name, ${spec.statusExpr || 'x.status'} AS status, x.project_id, p.name AS project_name
         FROM coexistence.${spec.table} x
         LEFT JOIN coexistence.projects p ON p.id = x.project_id
        ORDER BY LOWER(x.name)`
    );
    res.json({
      kind: req.params.kind,
      items: rows.map(r => ({
        id: Number(r.id), name: r.name, status: r.status || null,
        projectId: r.project_id == null ? null : Number(r.project_id),
        projectName: r.project_name || null,
      })),
    });
  } catch (err) {
    console.error('[projects] items error:', err.message);
    res.status(500).json({ error: 'Failed to load items' });
  }
});

module.exports = { router, ensureProjectTables, KINDS, parseAssignArgs };
