// Forms — a no-presets, Google-Forms-style capture builder (migrations 066 +
// 083). Lives in the Chats section. Two routers:
//   router        — authenticated CRUD, submissions table/dashboard/export     (mounted under authMiddleware)
//   publicRouter   — unauthenticated: fetch a published form, its branding
//                    images, and accept a submission                          (mounted before auth)
//
// TWO FORM TYPES, and the difference is whether the respondent is known:
//   'link'     — shared as a plain URL. Nobody is identified up front, so the
//                phone is OPTIONAL. A field the builder mapped to phone is the
//                voluntary phone section; skip it and the submission is stored
//                with phone_number NULL and lead_id NULL.
//   'whatsapp' — sent through an approved template whose URL button carries a
//                per-recipient token, so the phone is known before the first
//                answer and the lead link is automatic.
//
// A submission upserts coexistence.leads (matched by phone) *when a phone is
// present*, same pattern as the Razorpay/webhook auto-create-lead paths — a
// Form is just another lead-creation source, not a parallel data store. Fields
// with no `mapsTo` land in leads.custom_fields. The raw per-submission answers
// are always kept in lead_form_submissions, which is this form's own structured
// response table (a form may collect fields no lead column represents, and an
// anonymous response has nowhere else to live: leads.whatsapp_number is NOT
// NULL + UNIQUE, so a phone-less response CANNOT become a lead).
//
// Endpoints:
//   GET    /lead-forms                        list (+ submission counts)
//   POST   /lead-forms                         create { name, description, formType, projectId }
//   GET    /lead-forms/:id                     full form incl. fields[]
//   PUT    /lead-forms/:id                     update (name/description/fields/status/successMessage/
//                                              defaultSource/formType/waAccountId/templateId/projectId)
//   DELETE /lead-forms/:id                     delete (cascades submissions)
//   POST   /lead-forms/:id/logo                upload logo (multipart)        [admin]
//   DELETE /lead-forms/:id/logo
//   POST   /lead-forms/:id/banner              upload banner (multipart)      [admin]
//   DELETE /lead-forms/:id/banner
//   POST   /lead-forms/:id/template            build a UTILITY|MARKETING template carrying this
//                                              form's link, optionally submitting it to Meta  [admin]
//   GET    /lead-forms/:id/templates           templates whose URL button points at this form
//   GET    /lead-forms/:id/submissions         table view (paginated)
//   GET    /lead-forms/:id/submissions/export  CSV
//   GET    /lead-forms/:id/dashboard           completion counts, daily trend, per-field breakdown,
//                                              latest responses
//
//   GET    /public/lead-forms/:slug            published form config (safe subset) + prefillPhone from ?t=<token>
//   GET    /public/lead-forms/:slug/asset/:kind  logo|banner image, streamed from MinIO
//   POST   /public/lead-forms/:slug/submit     { answers, token } → logs the submission, and upserts a
//                                              lead when a phone is present (phone is optional)

const { Router } = require('express');
const multer = require('multer');
const crypto = require('crypto');
const pool = require('../db');
const minio = require('../util/minioClient');
const { adminOnly } = require('../middleware/access');
const cfg = require('../services/funnelConfig');
const {
  RATING_SCALES, DEFAULT_RATING_SCALE, DEFAULT_FEEDBACK_LABEL,
  isDisplayOnly, ratingScale, normalizeRating, isEmptyAnswer, answerToText,
} = require('../services/formAnswers');

const router = Router();
const publicRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const FORM_TYPES = ['link', 'whatsapp'];
// 'rating' collects { rating, feedback } rather than a scalar, and 'section' is
// a display-only heading that collects nothing — see services/formAnswers.js,
// which owns the emptiness and display rules for both.
const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'date', 'dropdown', 'radio', 'checkbox', 'boolean', 'rating', 'section'];
const MAPS_TO = ['name', 'email', 'phone', 'age', 'profession', 'pincode', 'city', 'source'];
const LEAD_COL = { name: 'name', email: 'email', phone: 'whatsapp_number', age: 'age', profession: 'profession', pincode: 'pincode', city: 'city', source: 'source' };

// ── self-healing table bootstrap (mirror of migration 066) ────────────────────
async function ensureLeadFormTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.lead_forms (
      id               BIGSERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      slug             TEXT NOT NULL UNIQUE,
      description      TEXT,
      fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
      logo_key         TEXT,
      banner_key       TEXT,
      status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
      success_message  TEXT,
      default_source   TEXT,
      created_by       BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_forms_status ON coexistence.lead_forms(status);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.lead_form_submissions (
      id             BIGSERIAL PRIMARY KEY,
      form_id        BIGINT NOT NULL REFERENCES coexistence.lead_forms(id) ON DELETE CASCADE,
      lead_id        BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      answers        JSONB NOT NULL DEFAULT '{}'::jsonb,
      phone_number   TEXT,
      send_token     TEXT,
      ip_address     TEXT,
      user_agent     TEXT,
      submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_form ON coexistence.lead_form_submissions(form_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_form_submissions_lead ON coexistence.lead_form_submissions(lead_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.lead_form_send_tokens (
      token          TEXT PRIMARY KEY,
      form_id        BIGINT NOT NULL REFERENCES coexistence.lead_forms(id) ON DELETE CASCADE,
      phone_number   TEXT NOT NULL,
      contact_name   TEXT,
      broadcast_id   BIGINT REFERENCES coexistence.broadcasts(id) ON DELETE SET NULL,
      wa_account_id  BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      used_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_form_send_tokens_form ON coexistence.lead_form_send_tokens(form_id);`);
  // Migration 083 — form type + remembered WhatsApp send setup.
  await pool.query(`
    ALTER TABLE coexistence.lead_forms
      ADD COLUMN IF NOT EXISTS form_type     TEXT NOT NULL DEFAULT 'link',
      ADD COLUMN IF NOT EXISTS wa_account_id BIGINT REFERENCES coexistence.whatsapp_accounts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS template_id   BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'lead_forms_form_type_check'
           AND conrelid = 'coexistence.lead_forms'::regclass
      ) THEN
        ALTER TABLE coexistence.lead_forms
          ADD CONSTRAINT lead_forms_form_type_check CHECK (form_type IN ('link','whatsapp'));
      END IF;
    END $$;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_forms_type ON coexistence.lead_forms(form_type);`);
}

// ── helpers ─────────────────────────────────────────────────────────────────
function slugify(label) {
  return String(label || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'form';
}

async function uniqueSlug(label) {
  const base = slugify(label);
  let slug = base;
  for (let n = 2; ; n++) {
    const { rows } = await pool.query(`SELECT 1 FROM coexistence.lead_forms WHERE slug = $1`, [slug]);
    if (!rows.length) return slug;
    slug = `${base}-${n}`;
  }
}

// Validate + normalize a fields[] payload from the builder. Throws { status, message }.
function sanitizeFields(fields) {
  if (!Array.isArray(fields)) throw { status: 400, message: 'fields must be an array' };
  const seen = new Set();
  return fields.map((f, i) => {
    const key = String(f.key || '').trim() || `field_${i + 1}`;
    if (seen.has(key)) throw { status: 400, message: `Duplicate field key "${key}"` };
    // Keys must fit the {{form.<slug>.<key>}} token grammar (no spaces/dots),
    // or the follow-up variable picker mints a chip whose token neither
    // validates nor resolves — literal braces reach the customer. The builder
    // always mints safe keys (field_<ts>_<n>); this gates API/MCP callers.
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
      throw { status: 400, message: `Field key "${key}" may only use letters, numbers, _ and - (no spaces or dots).` };
    }
    seen.add(key);
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    // mapsTo: a real lead column ('name', 'phone', …) OR 'cf:<field_key>' — a
    // registered custom Leads field (Admin Settings → Fields). The cf: target
    // is validated against the live registry so a deleted field silently stops
    // being a valid mapping target instead of writing orphan keys.
    let mapsTo = MAPS_TO.includes(f.mapsTo) ? f.mapsTo : null;
    if (!mapsTo && typeof f.mapsTo === 'string' && f.mapsTo.startsWith('cf:')) {
      const registry = require('../services/fieldRegistry');
      const cfKey = f.mapsTo.slice(3);
      const target = registry.fieldByKey('lead', cfKey);
      if (target && !target.isSystem) mapsTo = `cf:${cfKey}`;
    }
    // Neither a star rating nor a section heading can fill a lead column: one
    // is a number out of N, the other has no answer at all. Cleared here rather
    // than only hidden in the builder, so an API/MCP caller cannot write a
    // rating object into leads.name or a cf: bag key.
    if (type === 'rating' || isDisplayOnly(type)) mapsTo = null;

    // A section is a heading between questions. Forcing `required` off is what
    // stops it blocking every submission: the required loop would otherwise ask
    // for an answer the form never offers a way to give.
    const required = isDisplayOnly(type) ? false : !!f.required;

    // Per-type extras. Invalid values fall back to the default rather than
    // throwing — an unknown scale is a caller mistake worth correcting, not a
    // reason to reject an otherwise valid form.
    const extras = {};
    if (type === 'rating') {
      const scale = parseInt(f.scale, 10);
      extras.scale = RATING_SCALES.includes(scale) ? scale : DEFAULT_RATING_SCALE;
      extras.feedback = !!f.feedback;
      if (extras.feedback) {
        extras.feedbackLabel = String(f.feedbackLabel || '').trim().slice(0, 200) || DEFAULT_FEEDBACK_LABEL;
      }
    }
    if (isDisplayOnly(type) && f.description) {
      extras.description = String(f.description).slice(0, 1000);
    }

    const needsOptions = ['dropdown', 'radio', 'checkbox'].includes(type);
    // Trimmed, not just non-empty: the dashboard's per-field breakdown groups
    // answers by exact value, so a stray space would split " Red" and "Red"
    // into two rows. Enforced here rather than only in the builder so it also
    // holds for MCP and direct API callers.
    const options = needsOptions ? (Array.isArray(f.options) ? f.options.map(o => String(o).trim()).filter(Boolean) : []) : undefined;
    if (needsOptions && !options.length) throw { status: 400, message: `Field "${f.label || key}" needs at least one option` };
    return {
      key, label: String(f.label || key).trim() || key, type,
      required, mapsTo,
      ...extras,
      ...(options ? { options } : {}),
      ...(f.placeholder ? { placeholder: String(f.placeholder).slice(0, 200) } : {}),
    };
  });
}

function rowToForm(r, submissionCount) {
  return {
    id: Number(r.id), name: r.name, slug: r.slug, description: r.description,
    formType: r.form_type || 'link',
    // Which campaign folder this form is filed under (migration 100). Purely
    // organisational — it has no effect on the form, its link or its
    // submissions. projectName is only present when the caller joined it.
    projectId: r.project_id == null ? null : Number(r.project_id),
    projectName: r.project_name || null,
    waAccountId: r.wa_account_id == null ? null : Number(r.wa_account_id),
    templateId: r.template_id == null ? null : Number(r.template_id),
    fields: r.fields || [], hasLogo: !!r.logo_key, hasBanner: !!r.banner_key,
    status: r.status, successMessage: r.success_message, defaultSource: r.default_source,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(submissionCount != null ? { submissionCount: Number(submissionCount) } : {}),
  };
}

// Resolve a caller-supplied projectId to a real project, so a bad id comes back
// as a sentence rather than a raw foreign-key violation surfaced as a 500.
// `''`/null/undefined all mean "no project" — the PUT below distinguishes
// "omitted" (leave the filing alone) from an explicit null (unfile).
async function resolveProject(value) {
  if (value == null || value === '') return { id: null, name: null };
  const id = parseInt(value, 10);
  if (!Number.isFinite(id)) { const e = new Error('Invalid project'); e.status = 400; throw e; }
  const { rows } = await pool.query(`SELECT name FROM coexistence.projects WHERE id = $1`, [id]);
  if (!rows.length) { const e = new Error('Project not found'); e.status = 404; throw e; }
  return { id, name: rows[0].name };
}

// Public-safe subset — no logo/banner keys, no internal ids beyond what's needed to render.
function rowToPublicForm(r) {
  return {
    id: Number(r.id), name: r.name, slug: r.slug, description: r.description,
    formType: r.form_type || 'link',
    // scale/feedback/feedbackLabel/description are part of what the respondent
    // SEES, not admin metadata — a 4-star field renders five stars without the
    // scale, and a section renders as a bare heading without its description.
    fields: (r.fields || []).map(f => ({
      key: f.key, label: f.label, type: f.type, required: f.required,
      options: f.options, placeholder: f.placeholder, mapsTo: f.mapsTo || null,
      ...(f.scale ? { scale: f.scale } : {}),
      ...(f.feedback ? { feedback: true, feedbackLabel: f.feedbackLabel || DEFAULT_FEEDBACK_LABEL } : {}),
      ...(f.description ? { description: f.description } : {}),
    })),
    hasLogo: !!r.logo_key, hasBanner: !!r.banner_key,
    successMessage: r.success_message,
  };
}

// Upsert coexistence.leads by phone (last-10-digit match, same convention as
// routes/leads.js POST /students). Mapped fields win the lead's real columns
// (blank-only, COALESCE) except `source` which a form submission should set
// outright the first time; unmapped fields merge into custom_fields JSONB.
async function upsertLeadFromSubmission({ phone, mapped, customFields, defaultSource }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);
  const source = mapped.source || defaultSource || null;

  const { rows: found } = await pool.query(
    `SELECT id, stage FROM coexistence.leads WHERE right(regexp_replace(whatsapp_number,'\\D','','g'),10) = $1 ORDER BY id LIMIT 1`,
    [last10]
  );

  if (found.length) {
    const leadId = found[0].id;
    await pool.query(
      `UPDATE coexistence.leads
          SET name = COALESCE(name, $2), email = COALESCE($3, email), age = COALESCE($4, age),
              profession = COALESCE($5, profession), pincode = COALESCE($6, pincode),
              city = COALESCE($7, city), source = COALESCE(source, $8),
              custom_fields = custom_fields || $9::jsonb,
              last_activity_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [leadId, mapped.name || null, mapped.email || null,
        Number.isFinite(mapped.age) ? mapped.age : null, mapped.profession || null,
        mapped.pincode || null, mapped.city || null, source, JSON.stringify(customFields || {})]
    );
    return leadId;
  }

  const stage = cfg.funnelStageKeys()[0] || 'new';
  const { rows: ins } = await pool.query(
    `INSERT INTO coexistence.leads (whatsapp_number, name, email, age, profession, pincode, city, source, stage, has_whatsapp_thread, custom_fields, stage_changed_at, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10::jsonb,NOW(),NOW(),NOW(),NOW()) RETURNING id`,
    [digits, mapped.name || null, mapped.email || null, Number.isFinite(mapped.age) ? mapped.age : null,
      mapped.profession || null, mapped.pincode || null, mapped.city || null, source, stage, JSON.stringify(customFields || {})]
  );
  return ins[0].id;
}

// Mint a single-use token binding a form to one WhatsApp recipient, so the
// link they tap (the template's dynamic URL button, filled with this token)
// silently identifies them — no phone number ever asked on the form itself.
// Consumed by routes/broadcasts.js at send time (per recipient).
async function mintSendToken({ formId, phoneNumber, contactName, broadcastId, waAccountId }) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO coexistence.lead_form_send_tokens (token, form_id, phone_number, contact_name, broadcast_id, wa_account_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [token, formId, digits, contactName || null, broadcastId || null, waAccountId || null]
  );
  return token;
}

// Given a template's dynamic URL-button value (e.g.
// "https://…/#/f/<slug>/{{1}}"), if it points at a PUBLISHED lead form, mint a
// per-recipient token so the recipient is auto-identified when they open it.
// Returns the token, or null if the button isn't a lead-form link. This is
// what makes the silent phone-capture work from ANY send path (Test Send,
// Broadcast, Lead-Forms flow) — not just the dedicated "Send via WhatsApp".
async function mintTokenForButtonUrl(buttonUrl, phoneNumber, opts = {}) {
  const m = String(buttonUrl || '').match(/\/f\/([^/{}?#\s]+)/);
  if (!m) return null;
  const slug = m[1];
  const { rows } = await pool.query(
    `SELECT id FROM coexistence.lead_forms WHERE slug = $1 AND status = 'published'`, [slug]
  );
  if (!rows.length) return null;
  return mintSendToken({ formId: rows[0].id, phoneNumber, ...opts });
}

// ═══════════════════════════════ authenticated ═══════════════════════════════

router.get('/lead-forms', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS project_name,
              (SELECT COUNT(*) FROM coexistence.lead_form_submissions s WHERE s.form_id = f.id)::int AS submission_count
         FROM coexistence.lead_forms f
         LEFT JOIN coexistence.projects p ON p.id = f.project_id
        ORDER BY f.created_at DESC`
    );
    res.json({ forms: rows.map(r => rowToForm(r, r.submission_count)) });
  } catch (err) {
    console.error('[lead-forms] list error:', err.message);
    res.status(500).json({ error: 'Failed to load lead forms' });
  }
});

router.post('/lead-forms', adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const formType = FORM_TYPES.includes(req.body?.formType) ? req.body.formType : 'link';
    const project = await resolveProject(req.body?.projectId);
    const slug = await uniqueSlug(name);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.lead_forms (name, slug, description, form_type, created_by, project_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, slug, req.body?.description || null, formType,
       req.user?.id ? parseInt(req.user.id, 10) : null, project.id]
    );
    res.status(201).json({ form: rowToForm({ ...rows[0], project_name: project.name }, 0) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[lead-forms] create error:', err.message);
    res.status(500).json({ error: 'Failed to create form' });
  }
});

router.get('/lead-forms/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, p.name AS project_name
         FROM coexistence.lead_forms f
         LEFT JOIN coexistence.projects p ON p.id = f.project_id
        WHERE f.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Form not found' });
    res.json({ form: rowToForm(rows[0]) });
  } catch (err) {
    console.error('[lead-forms] get error:', err.message);
    res.status(500).json({ error: 'Failed to load form' });
  }
});

// Authenticated logo/banner preview — used by the builder while a form is
// still in draft (the public asset route below only serves published forms).
router.get('/lead-forms/:id/asset/:kind', async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!['logo', 'banner'].includes(kind)) return res.status(404).end();
    const { rows } = await pool.query(`SELECT ${kind}_key FROM coexistence.lead_forms WHERE id = $1`, [req.params.id]);
    const key = rows[0]?.[`${kind}_key`];
    if (!key) return res.status(404).end();
    const buf = await minio.getObjectBuffer(key);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    res.status(404).end();
  }
});

router.put('/lead-forms/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = [];
    let i = 1;
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      vals.push(String(b.name).trim()); sets.push(`name = $${i++}`);
    }
    if (b.description !== undefined) { vals.push(b.description || null); sets.push(`description = $${i++}`); }
    if (b.fields !== undefined) {
      let fields;
      try { fields = sanitizeFields(b.fields); }
      catch (e) { return res.status(e.status || 400).json({ error: e.message || 'Invalid fields' }); }
      vals.push(JSON.stringify(fields)); sets.push(`fields = $${i++}::jsonb`);
    }
    if (b.status !== undefined) {
      if (!['draft', 'published', 'closed'].includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
      vals.push(b.status); sets.push(`status = $${i++}`);
    }
    if (b.successMessage !== undefined) { vals.push(b.successMessage || null); sets.push(`success_message = $${i++}`); }
    if (b.defaultSource !== undefined) { vals.push(b.defaultSource || null); sets.push(`default_source = $${i++}`); }
    if (b.formType !== undefined) {
      if (!FORM_TYPES.includes(b.formType)) return res.status(400).json({ error: 'Invalid form type' });
      vals.push(b.formType); sets.push(`form_type = $${i++}`);
    }
    if (b.waAccountId !== undefined) { vals.push(b.waAccountId ? parseInt(b.waAccountId, 10) : null); sets.push(`wa_account_id = $${i++}`); }
    if (b.templateId !== undefined) { vals.push(b.templateId ? parseInt(b.templateId, 10) : null); sets.push(`template_id = $${i++}`); }
    // Omitting projectId leaves the filing alone; passing null unfiles it.
    if (b.projectId !== undefined) {
      const project = await resolveProject(b.projectId);
      vals.push(project.id); sets.push(`project_id = $${i++}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await pool.query(`UPDATE coexistence.lead_forms SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Form not found' });
    // Re-read with the project join so the response carries projectName.
    const { rows: full } = await pool.query(
      `SELECT f.*, p.name AS project_name
         FROM coexistence.lead_forms f
         LEFT JOIN coexistence.projects p ON p.id = f.project_id
        WHERE f.id = $1`, [id]);
    res.json({ form: rowToForm(full[0] || rows[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[lead-forms] update error:', err.message);
    res.status(500).json({ error: 'Failed to update form' });
  }
});

router.delete('/lead-forms/:id', adminOnly, async (req, res) => {
  try {
    const { rows: f } = await pool.query(`SELECT logo_key, banner_key FROM coexistence.lead_forms WHERE id = $1`, [req.params.id]);
    if (!f.length) return res.status(404).json({ error: 'Form not found' });
    await pool.query(`DELETE FROM coexistence.lead_forms WHERE id = $1`, [req.params.id]);
    if (f[0].logo_key) minio.removeObject(f[0].logo_key).catch(() => {});
    if (f[0].banner_key) minio.removeObject(f[0].banner_key).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[lead-forms] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete form' });
  }
});

async function uploadAsset(req, res, kind) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Only image files are allowed' });
    const { rows: f } = await pool.query(`SELECT ${kind}_key FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!f.length) return res.status(404).json({ error: 'Form not found' });
    const oldKey = f[0][`${kind}_key`];
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
    const key = `lead-forms/${id}/${kind}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    await minio.putObject(key, req.file.buffer, req.file.mimetype);
    await pool.query(`UPDATE coexistence.lead_forms SET ${kind}_key = $1, updated_at = NOW() WHERE id = $2`, [key, id]);
    if (oldKey) minio.removeObject(oldKey).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error(`[lead-forms] ${kind} upload error:`, err.message);
    res.status(500).json({ error: `Failed to upload ${kind}` });
  }
}
router.post('/lead-forms/:id/logo', adminOnly, upload.single('file'), (req, res) => uploadAsset(req, res, 'logo'));
router.post('/lead-forms/:id/banner', adminOnly, upload.single('file'), (req, res) => uploadAsset(req, res, 'banner'));

async function removeAsset(req, res, kind) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: f } = await pool.query(`SELECT ${kind}_key FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!f.length) return res.status(404).json({ error: 'Form not found' });
    if (f[0][`${kind}_key`]) minio.removeObject(f[0][`${kind}_key`]).catch(() => {});
    await pool.query(`UPDATE coexistence.lead_forms SET ${kind}_key = NULL, updated_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[lead-forms] ${kind} remove error:`, err.message);
    res.status(500).json({ error: `Failed to remove ${kind}` });
  }
}
router.delete('/lead-forms/:id/logo', adminOnly, (req, res) => removeAsset(req, res, 'logo'));
router.delete('/lead-forms/:id/banner', adminOnly, (req, res) => removeAsset(req, res, 'banner'));

// ── WhatsApp template for this form ─────────────────────────────────────────
// Builds a UTILITY or MARKETING template whose URL button already points at
// this form, so the admin never has to hand-assemble the link. The trailing
// {{1}} is not decoration: Meta only allows a per-recipient value in a URL
// button if the button is declared dynamic, and that token is what silently
// identifies the person who taps it (see mintTokenForButtonUrl).

// The form's public origin. The HOST is taken from the request so this keeps
// working across both domains the app is served on, but the SCHEME is pinned
// to https rather than read from the request.
//
// Meta rejects a template whose URL button is not https, and deriving the
// scheme from `x-forwarded-proto` / `req.protocol` makes that rejection
// conditional on proxy headers we do not control — the app has `trust proxy`
// off, so a request that reaches Express without that header reports "http"
// and silently builds a template Meta will refuse. The public form is only
// ever served over TLS, so there is no case where http is the right answer.
function publicFormBase(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || process.env.FORGECRM_DOMAIN || '').split(',')[0].trim();
  if (!host) throw Object.assign(new Error('Could not work out this site\'s address for the form link. Set FORGECRM_DOMAIN and try again.'), { status: 500 });
  return `https://${host}`;
}

router.post('/lead-forms/:id/template', adminOnly, async (req, res) => {
  try {
    // Lazily required: routes/templates.js requires THIS module (for token
    // minting), so a top-level require here would be a cycle.
    const { insertTemplateRow, submitTemplateToMeta } = require('./templates');

    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const { rows } = await pool.query(`SELECT * FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Form not found' });
    const form = rows[0];

    const category = String(b.category || '').toUpperCase();
    if (!['UTILITY', 'MARKETING'].includes(category)) {
      return res.status(400).json({ error: 'Category must be Utility or Marketing' });
    }
    const waAccountId = parseInt(b.waAccountId, 10);
    if (!waAccountId) return res.status(400).json({ error: 'Pick a WhatsApp number to send from' });
    const bodyText = String(b.body || '').trim();
    if (!bodyText) return res.status(400).json({ error: 'Message text is required' });
    // Variables need a matching sample per Meta, and collecting those properly
    // is the Template Builder's job. Say so rather than silently dropping them.
    if (/\{\{\d+\}\}/.test(bodyText)) {
      return res.status(400).json({ error: 'Variables like {{1}} are not supported here — build that template in Template Builder instead.' });
    }
    const buttonText = String(b.buttonText || 'Open form').trim().slice(0, 25);

    const url = `${publicFormBase(req)}/f/${form.slug}/{{1}}`;
    const base = {
      category, language: String(b.language || 'en'),
      header_type: 'NONE', body: bodyText,
      footer: b.footer ? String(b.footer).trim().slice(0, 60) : null,
      buttons: [{ type: 'URL', text: buttonText, value: url, urlSample: url.replace('{{1}}', 'sample1234567890') }],
      samples: {}, whatsappAccountId: waAccountId, template_type: 'STANDARD',
    };

    // Meta requires a unique (name, language) per WABA. The slug is already
    // lowercase-and-hyphens, so it only needs underscoring to satisfy Meta's
    // name rules; on collision, suffix rather than making the admin retype.
    const stem = `${form.slug.replace(/-/g, '_')}_form`.replace(/[^a-z0-9_]/g, '').slice(0, 500) || 'lead_form';
    let created = null, lastErr = null;
    for (let n = 1; n <= 20; n++) {
      try {
        created = await insertTemplateRow({ ...base, name: n === 1 ? stem : `${stem}_${n}` });
        break;
      } catch (e) {
        lastErr = e;
        if (e.status !== 409) break;   // only a name clash is worth retrying
      }
    }
    if (!created) {
      if (lastErr?.status === 400) return res.status(400).json({ error: 'Validation failed', errors: lastErr.errors });
      return res.status(lastErr?.status || 500).json({ error: lastErr?.message || 'Failed to create template' });
    }

    // Remember the send setup on the form, and flip it to a WhatsApp form —
    // it now has the one thing that makes it one.
    await pool.query(
      `UPDATE coexistence.lead_forms
          SET template_id = $1, wa_account_id = $2, form_type = 'whatsapp', updated_at = NOW()
        WHERE id = $3`,
      [created.id, waAccountId, id]
    );

    let template = created, submitError = null;
    if (b.submit) {
      try { template = await submitTemplateToMeta(created.id); }
      catch (e) {
        // The row is already saved as a DRAFT, so a Meta rejection is not a
        // failure of this request — report it and let them retry the submit.
        submitError = e.message || 'Meta rejected the template';
      }
    }

    res.status(201).json({
      template,
      submitError,
      // Meta only serves a link for a form that is actually accepting responses.
      warning: form.status !== 'published'
        ? 'This form is still a draft — publish it before the template is approved, or the link will not open.'
        : null,
    });
  } catch (err) {
    console.error('[lead-forms] template create error:', err.message);
    // Errors we raised ourselves already carry a sentence worth showing.
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Failed to create the template' });
  }
});

// Templates on this form's account whose URL button already points at it —
// what the Send flow offers, and how the builder knows a form is ready to send.
router.get('/lead-forms/:id/templates', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: fr } = await pool.query(`SELECT slug, wa_account_id FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!fr.length) return res.status(404).json({ error: 'Form not found' });
    const accountId = req.query.accountId ? parseInt(req.query.accountId, 10) : fr[0].wa_account_id;
    if (!accountId) return res.json({ templates: [] });
    const { rows } = await pool.query(
      `SELECT id, name, category, language, status, buttons
         FROM coexistence.message_templates
        WHERE whatsapp_account_id = $1
        ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [accountId]
    );
    const needle = `/f/${fr[0].slug}/`;
    res.json({
      templates: rows
        .filter(t => (Array.isArray(t.buttons) ? t.buttons : []).some(x => x.type === 'URL' && String(x.value || '').includes(needle)))
        .map(t => ({ id: Number(t.id), name: t.name, category: t.category, language: t.language, status: t.status })),
    });
  } catch (err) {
    console.error('[lead-forms] template list error:', err.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// ── submissions table view ─────────────────────────────────────────────────
router.get('/lead-forms/:id/submissions', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM coexistence.lead_form_submissions WHERE form_id = $1`, [id]);
    const { rows } = await pool.query(
      `SELECT s.*, l.name AS lead_name, l.stage AS lead_stage
         FROM coexistence.lead_form_submissions s
         LEFT JOIN coexistence.leads l ON l.id = s.lead_id
        WHERE s.form_id = $1
        ORDER BY s.submitted_at DESC
        LIMIT $2 OFFSET $3`,
      [id, pageSize, (page - 1) * pageSize]
    );
    res.json({
      total: cnt[0].n, page, pageSize,
      submissions: rows.map(r => ({
        id: Number(r.id), answers: r.answers || {}, phoneNumber: r.phone_number,
        leadId: r.lead_id == null ? null : Number(r.lead_id), leadName: r.lead_name, leadStage: r.lead_stage,
        submittedAt: r.submitted_at,
      })),
    });
  } catch (err) {
    console.error('[lead-forms] submissions error:', err.message);
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

router.get('/lead-forms/:id/submissions/export', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: fr } = await pool.query(`SELECT name, fields FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!fr.length) return res.status(404).json({ error: 'Form not found' });
    const fields = fr[0].fields || [];
    const { rows } = await pool.query(
      `SELECT answers, phone_number, submitted_at FROM coexistence.lead_form_submissions WHERE form_id = $1 ORDER BY submitted_at DESC LIMIT 10000`,
      [id]
    );
    // Section headings are excluded: they collect no answer, so a column for
    // one would be blank on every row of every export.
    const answerFields = fields.filter(f => !isDisplayOnly(f.type));
    const cols = ['Submitted At', 'Phone', ...answerFields.map(f => f.label)];
    const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.join(',')];
    for (const r of rows) {
      const answers = r.answers || {};
      const line = [new Date(r.submitted_at).toISOString(), r.phone_number || '',
        ...answerFields.map(f => answerToText(f, answers[f.key], { separator: '; ' }))];
      lines.push(line.map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(fr[0].name)}-submissions.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[lead-forms] export error:', err.message);
    res.status(500).json({ error: 'Failed to export submissions' });
  }
});

// ── dashboard ───────────────────────────────────────────────────────────────
router.get('/lead-forms/:id/dashboard', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: fr } = await pool.query(`SELECT fields FROM coexistence.lead_forms WHERE id = $1`, [id]);
    if (!fr.length) return res.status(404).json({ error: 'Form not found' });
    const fields = fr[0].fields || [];

    // One query for every headline count, so they can never disagree with each
    // other the way four separate COUNT(*)s can when a submission lands between
    // them. "People" counts each phone once (the same person may fill a form
    // twice) plus every anonymous row, since those cannot be de-duplicated —
    // there is nothing to match them on.
    const { rows: countRow } = await pool.query(
      `SELECT COUNT(*)::int                                                        AS total,
              COUNT(*) FILTER (WHERE lead_id IS NOT NULL)::int                     AS leads_created,
              COUNT(*) FILTER (WHERE phone_number IS NOT NULL AND phone_number <> '')::int AS identified,
              COUNT(*) FILTER (WHERE phone_number IS NULL OR phone_number = '')::int       AS anonymous,
              (COUNT(DISTINCT phone_number) FILTER (WHERE phone_number IS NOT NULL AND phone_number <> '')
               + COUNT(*) FILTER (WHERE phone_number IS NULL OR phone_number = ''))::int   AS people
         FROM coexistence.lead_form_submissions WHERE form_id = $1`,
      [id]
    );
    const { rows: daily } = await pool.query(
      `SELECT submitted_at::date AS day, COUNT(*)::int AS n
         FROM coexistence.lead_form_submissions
        WHERE form_id = $1 AND submitted_at > NOW() - INTERVAL '30 days'
        GROUP BY submitted_at::date ORDER BY day`,
      [id]
    );

    // Value-count breakdown for choice-type fields (dropdown/radio/checkbox)
    // and rating fields.
    const choiceFields = fields.filter(f => ['dropdown', 'radio', 'checkbox'].includes(f.type));
    const ratingFields = fields.filter(f => f.type === 'rating');
    const breakdown = {};
    const ratings = {};
    if (choiceFields.length || ratingFields.length) {
      const { rows: subs } = await pool.query(`SELECT answers FROM coexistence.lead_form_submissions WHERE form_id = $1`, [id]);
      for (const f of choiceFields) {
        const counts = {};
        for (const s of subs) {
          const v = (s.answers || {})[f.key];
          const vals = Array.isArray(v) ? v : (v != null && v !== '' ? [v] : []);
          for (const val of vals) counts[val] = (counts[val] || 0) + 1;
        }
        breakdown[f.key] = { label: f.label, counts };
      }
      for (const f of ratingFields) {
        const max = ratingScale(f);
        // Every star value is seeded at 0 so the chart shows the full scale —
        // "nobody gave us a 1" is a result, and a breakdown that simply omits
        // the value reads as though it were never offered.
        const counts = {};
        for (let n = 1; n <= max; n++) counts[n] = 0;
        let sum = 0, rated = 0, withFeedback = 0;
        const feedback = [];
        for (const s of subs) {
          const { rating, feedback: text } = normalizeRating(f, (s.answers || {})[f.key]);
          if (rating != null) { counts[rating]++; sum += rating; rated++; }
          if (text && text.trim()) {
            withFeedback++;
            if (feedback.length < 20) feedback.push({ rating, text: text.trim() });
          }
        }
        ratings[f.key] = {
          label: f.label, max, counts, responses: rated, withFeedback,
          // Averaged over RATED responses only. Dividing by every submission
          // would drag the score down every time someone skipped the question.
          average: rated ? Math.round((sum / rated) * 100) / 100 : null,
          feedback,
        };
      }
    }

    // Basic details for each of the most recent completions, so the dashboard
    // answers "who filled this in?" without a trip to the Table tab.
    const { rows: recent } = await pool.query(
      `SELECT s.id, s.answers, s.phone_number, s.submitted_at, s.lead_id, l.name AS lead_name
         FROM coexistence.lead_form_submissions s
         LEFT JOIN coexistence.leads l ON l.id = s.lead_id
        WHERE s.form_id = $1
        ORDER BY s.submitted_at DESC LIMIT 10`,
      [id]
    );
    // The respondent's name comes from whichever field the builder mapped to
    // name — reading a fixed key like answers.name would silently show nothing
    // on any form that labelled the question differently.
    const nameField = fields.find(f => f.mapsTo === 'name');
    const emailField = fields.find(f => f.mapsTo === 'email');

    const c = countRow[0];
    res.json({
      totalSubmissions: c.total,
      leadsCreated: c.leads_created,
      identifiedSubmissions: c.identified,
      anonymousSubmissions: c.anonymous,
      peopleCompleted: c.people,
      dailySubmissions: daily.map(r => ({ day: r.day, count: r.n })),
      fieldBreakdown: breakdown,
      ratingBreakdown: ratings,
      recentSubmissions: recent.map(r => ({
        id: Number(r.id),
        name: r.lead_name || (nameField ? (r.answers || {})[nameField.key] : null) || null,
        email: emailField ? ((r.answers || {})[emailField.key] || null) : null,
        phoneNumber: r.phone_number || null,
        leadId: r.lead_id == null ? null : Number(r.lead_id),
        submittedAt: r.submitted_at,
      })),
    });
  } catch (err) {
    console.error('[lead-forms] dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ═══════════════════════════════════ public ═══════════════════════════════════

publicRouter.get('/public/lead-forms/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.lead_forms WHERE slug = $1`, [req.params.slug]);
    if (!rows.length || rows[0].status !== 'published') return res.status(404).json({ error: 'This form is not available.' });

    let prefillPhone = null;
    const token = req.query.t ? String(req.query.t) : null;
    if (token) {
      // Tokens are reusable until they expire — a recipient can open their link
      // and submit the form as many times as they like (each submit logs a new
      // row). We deliberately do NOT gate on used_at here so the phone keeps
      // prefilling on repeat visits.
      const { rows: tk } = await pool.query(
        `SELECT phone_number FROM coexistence.lead_form_send_tokens
          WHERE token = $1 AND form_id = $2 AND expires_at > NOW()`,
        [token, rows[0].id]
      );
      if (tk.length) prefillPhone = tk[0].phone_number;
    }
    res.json({ form: rowToPublicForm(rows[0]), prefillPhone });
  } catch (err) {
    console.error('[lead-forms] public get error:', err.message);
    res.status(500).json({ error: 'Failed to load form' });
  }
});

publicRouter.get('/public/lead-forms/:slug/asset/:kind', async (req, res) => {
  try {
    const kind = req.params.kind;
    if (!['logo', 'banner'].includes(kind)) return res.status(404).end();
    const { rows } = await pool.query(`SELECT ${kind}_key FROM coexistence.lead_forms WHERE slug = $1 AND status = 'published'`, [req.params.slug]);
    const key = rows[0]?.[`${kind}_key`];
    if (!key) return res.status(404).end();
    const buf = await minio.getObjectBuffer(key);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (err) {
    res.status(404).end();
  }
});

publicRouter.post('/public/lead-forms/:slug/submit', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM coexistence.lead_forms WHERE slug = $1`, [req.params.slug]);
    if (!rows.length || rows[0].status !== 'published') return res.status(404).json({ error: 'This form is not available.' });
    const form = rows[0];
    const fields = form.fields || [];
    const answers = req.body?.answers || {};
    const token = req.body?.token ? String(req.body.token) : null;

    // Validate required fields. The emptiness test is shared with the builder
    // and the public page (services/formAnswers.js) because a rating answer is
    // an OBJECT — under the old `v === ''` test, a rating field with nothing
    // selected was truthy and sailed through a Required check.
    for (const f of fields) {
      if (f.required && isEmptyAnswer(f, answers[f.key])) {
        return res.status(400).json({ error: `"${f.label}" is required` });
      }
    }

    // Resolve the phone: a valid (non-expired) send token always wins (the
    // silent-capture path), otherwise fall back to a field the builder mapped
    // to phone. Tokens are reusable — a recipient may submit the same link
    // multiple times; each submit logs its own row and re-upserts the lead.
    let phone = null, tokenRow = null;
    if (token) {
      const { rows: tk } = await pool.query(
        `SELECT * FROM coexistence.lead_form_send_tokens WHERE token = $1 AND form_id = $2 AND expires_at > NOW()`,
        [token, form.id]
      );
      if (tk.length) { tokenRow = tk[0]; phone = tk[0].phone_number; }
    }
    const mapped = {};
    const customFields = {};
    for (const f of fields) {
      const v = answers[f.key];
      if (isEmptyAnswer(f, v)) continue;
      // A rating is flattened to "4/5 - loved it" for the lead bag only. The
      // full structured answer is still stored verbatim on the submission row,
      // so nothing is lost — but the bag is read back by the Leads table and by
      // {{lead.<key>}} in follow-ups, and an object in either renders as
      // "[object Object]" to a human.
      const stored = f.type === 'rating' ? answerToText(f, v) : v;
      if (f.mapsTo && f.mapsTo.startsWith('cf:')) {
        // Mapped to a registered custom Leads field — store under the REGISTRY
        // key so the value shows on the Leads/Sales Log tables and resolves as
        // {{lead.<key>}} in follow-ups.
        customFields[f.mapsTo.slice(3)] = stored;
      } else if (f.mapsTo) {
        if (f.mapsTo === 'phone') { if (!phone) phone = String(v); }
        else if (f.mapsTo === 'age') mapped.age = Number.isFinite(Number(v)) ? parseInt(v, 10) : null;
        else mapped[f.mapsTo] = String(v).trim();
      } else {
        customFields[f.key] = stored;
      }
    }
    // The phone is OPTIONAL, by design. leads.whatsapp_number is NOT NULL and
    // UNIQUE — it is the join key for the funnel, the WhatsApp thread and the
    // stage-tag mirror — so a response with no phone genuinely CANNOT become a
    // lead. It is stored as an anonymous row in this form's own table with the
    // phone column blank, which is exactly what a link-only form is for.
    //
    // Never reject the fill over a missing phone: the respondent has already
    // done the work, and a 400 here throws their answers away for a field they
    // were told was optional. Requiring one is the builder's decision, made per
    // field via `required` and enforced by the loop above.
    const leadId = phone
      ? await upsertLeadFromSubmission({ phone, mapped, customFields, defaultSource: form.default_source || form.name })
      : null;

    await pool.query(
      `INSERT INTO coexistence.lead_form_submissions (form_id, lead_id, answers, phone_number, send_token, ip_address, user_agent)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [form.id, leadId, JSON.stringify(answers), phone, token, req.ip || null, req.get('user-agent') || null]
    );
    // Stamp last-used for audit (the token stays reusable — see the reusable
    // lookups above; this is no longer a single-use consume).
    if (tokenRow) await pool.query(`UPDATE coexistence.lead_form_send_tokens SET used_at = NOW() WHERE token = $1`, [token]);

    res.status(201).json({ ok: true, successMessage: form.success_message || 'Thanks — your response has been recorded.' });
  } catch (err) {
    console.error('[lead-forms] submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit form' });
  }
});

// FIELD_TYPES is exported so the MCP layer can validate against the SAME list
// this route sanitizes with. It matters more than it looks: sanitizeFields
// DOWNGRADES an unknown type to 'text' rather than erroring, so a second,
// hand-maintained copy that fell behind would let an MCP caller "create" a
// rating field and silently get a text box back, reported as success.
module.exports = { router, publicRouter, ensureLeadFormTables, mintSendToken, mintTokenForButtonUrl, FIELD_TYPES };
