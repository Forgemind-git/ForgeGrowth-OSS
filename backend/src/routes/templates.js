const express = require('express');
const router = express.Router();
const pool = require('../db');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const extractVars = (t) => {
  const m = [...(t || '').matchAll(/\{\{(\d+)\}\}/g)];
  return [...new Set(m.map(x => x[1]))].sort((a, b) => +a - +b);
};

const nameOk = (n) => /^[a-z0-9_]+$/.test(n);

function runValidation(data) {
  const e = {};
  const { name, body, header_type, header_text, media_handle, footer, buttons, samples, category, code_expiry_minutes } = data;

  if (!name || !name.trim()) e.name = 'Template name is required';
  else if (!nameOk(name)) e.name = 'Only lowercase letters, numbers, underscores';
  else if (name.length > 512) e.name = 'Max 512 characters';

  if (!body || !body.trim()) e.body = 'Body text is required';

  const hv = header_type === 'TEXT' ? extractVars(header_text) : [];
  if (hv.length > 1) e.headerVars = 'Header allows only 1 variable — {{1}}';
  if (header_text && header_text.length > 60) e.headerTextLen = 'Header text max 60 characters';

  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header_type) && !(media_handle || '').trim()) {
    e.mediaHandle = 'Meta file handle required for media header';
  }

  if (extractVars(footer).length > 0) e.footer = 'Footer cannot contain variables';
  if (footer && footer.length > 60) e.footerLen = 'Footer max 60 characters';

  const bv = extractVars(body);
  const miss = bv.filter(v => !(samples || {})[v]?.trim());
  if (miss.length > 0) e.bodySamples = `Fill samples for: ${miss.map(v => `{{${v}}}`).join(', ')}`;
  if (hv.length > 0 && !(samples || {})[hv[0]]?.trim()) e.headerSamples = `Fill sample for header {{${hv[0]}}}`;

  const btnArr = buttons || [];
  const urlBtns = btnArr.filter(b => b.type === 'URL');
  const phoneBtns = btnArr.filter(b => b.type === 'PHONE_NUMBER');
  if (urlBtns.length > 2) e.btnMaxUrl = 'Max 2 URL buttons';
  if (phoneBtns.length > 1) e.btnMaxPhone = 'Max 1 phone button';

  btnArr.forEach((btn, i) => {
    if (!btn.text?.trim() && btn.type !== 'OTP' && btn.type !== 'COPY_CODE') e[`btn_text_${i}`] = 'Button text required';
    if (btn.type === 'URL') {
      if (btn.value && !btn.value.startsWith('https://')) e[`btn_url_${i}`] = 'URL must start with https://';
      if (extractVars(btn.value || '').length > 0 && !btn.urlSample?.trim()) {
        e[`btn_urlsample_${i}`] = 'Sample URL required for dynamic URL variable';
      }
    }
    if (btn.type === 'PHONE_NUMBER' && btn.value) {
      const clean = (btn.value || '').replace(/[\s\-()]/g, '');
      if (!/^\+\d{7,15}$/.test(clean)) e[`btn_phone_${i}`] = 'Use E.164 format: +919876543210';
    }
    if (btn.type === 'COPY_CODE' && !(btn.value || '').trim()) e[`btn_code_${i}`] = 'Coupon code required';
  });

  if (category === 'AUTHENTICATION' && code_expiry_minutes !== null && code_expiry_minutes !== undefined && code_expiry_minutes !== '') {
    const n = +code_expiry_minutes;
    if (isNaN(n) || n < 1 || n > 90) e.codeExpiry = 'Expiry must be 1–90 minutes';
  }

  return e;
}

function buildPayload(data) {
  const { name, category, language, header_type, header_text, media_handle, body, footer, buttons, samples, security_recommendation, code_expiry_minutes, allow_category_change } = data;
  const components = [];

  if (header_type !== 'NONE' && String(data.template_type || '').toUpperCase() !== 'CAROUSEL') {
    const hc = { type: 'HEADER', format: header_type };
    if (header_type === 'TEXT') {
      hc.text = header_text;
      const hv = extractVars(header_text);
      if (hv.length > 0) hc.example = { header_text: [samples[hv[0]] || 'Sample'] };
    } else {
      if (media_handle) hc.example = { header_handle: [media_handle] };
    }
    components.push(hc);
  }

  const bc = { type: 'BODY', text: body };
  if (security_recommendation && category === 'AUTHENTICATION') bc.add_security_recommendation = true;
  const bv = extractVars(body);
  if (bv.length > 0) bc.example = { body_text: [bv.map(v => samples[v] || `sample_${v}`)] };
  components.push(bc);

  if (category !== 'AUTHENTICATION' && footer && String(data.template_type || '').toUpperCase() !== 'CAROUSEL') components.push({ type: 'FOOTER', text: footer });
  if (category === 'AUTHENTICATION' && code_expiry_minutes) components.push({ type: 'FOOTER', code_expiration_minutes: parseInt(code_expiry_minutes) });

  const btnArr = buttons || [];
  if (btnArr.length > 0 && String(data.template_type || '').toUpperCase() !== 'CAROUSEL') {
    const btns = btnArr.map(b => {
      if (b.type === 'OTP') {
        return {
          type: 'OTP',
          otp_type: b.otpType || 'COPY_CODE',
          text: b.text || 'Copy Code',
          ...(b.otpType === 'ONE_TAP' ? { autofill_text: 'Autofill', package_name: b.packageName || '', signature_hash: b.signatureHash || '' } : {})
        };
      }
      if (b.type === 'URL') {
        const uv = extractVars(b.value || '');
        return { type: 'URL', text: b.text, url: b.value, ...(uv.length > 0 ? { example: [b.urlSample || b.value] } : {}) };
      }
      if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.value };
      if (b.type === 'COPY_CODE') return { type: 'COPY_CODE', example: [b.value || 'PROMO50'] };
      return { type: 'QUICK_REPLY', text: b.text };
    });
    components.push({ type: 'BUTTONS', buttons: btns });
  }

  // CAROUSEL templates append a CAROUSEL component containing card definitions.
  // Each card carries its own HEADER + BODY + (optional) BUTTONS components.
  if (data.template_type === 'CAROUSEL' && Array.isArray(data.carousel_cards) && data.carousel_cards.length > 0) {
    const cards = data.carousel_cards.map(card => {
      const cardComponents = [];
      if (card.header_type && card.header_handle) {
        cardComponents.push({ type: 'HEADER', format: card.header_type, example: { header_handle: [card.header_handle] } });
      }
      cardComponents.push({ type: 'BODY', text: card.body || ' ' });
      if (Array.isArray(card.buttons) && card.buttons.length > 0) {
        const btns = card.buttons.map(b => {
          if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.value };
          if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.value };
          return { type: 'QUICK_REPLY', text: b.text };
        });
        cardComponents.push({ type: 'BUTTONS', buttons: btns });
      }
      return { components: cardComponents };
    });
    components.push({ type: 'CAROUSEL', cards });
  }

  return { name, language, category, allow_category_change: allow_category_change, components };
}

/**
 * Validate a CAROUSEL template before submitting to Meta. Returns an error
 * string, or null when OK. Mirrors the frontend carousel validation so the
 * builder's "Submit" gate and the server agree. Drafts are NOT run through this
 * (only the submit path), so an in-progress carousel can still be saved.
 */
function carouselSubmitError(tpl) {
  if (String(tpl.template_type || '').toUpperCase() !== 'CAROUSEL') return null;
  let cards = tpl.carousel_cards;
  if (typeof cards === 'string') { try { cards = JSON.parse(cards); } catch { cards = []; } }
  cards = Array.isArray(cards) ? cards : [];
  if (cards.length < 2) return 'A carousel needs at least 2 cards before it can be submitted.';
  if (cards.length > 10) return 'A carousel can have at most 10 cards.';
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i] || {};
    if (!c.header_handle) return `Card ${i + 1}: a media file is required.`;
    if (!(c.body || '').trim()) return `Card ${i + 1}: body text is required.`;
    if (extractVars(c.body || '').length > 0) return `Card ${i + 1}: variables in a card body aren't supported yet — use static text.`;
  }
  // Meta requires every card to share the same button layout (same types/order).
  const sig = (c) => (Array.isArray(c.buttons) ? c.buttons : []).map(b => b.type).join(',');
  const sig0 = sig(cards[0]);
  if (cards.some(c => sig(c) !== sig0)) return 'All carousel cards must have the same buttons (same types in the same order).';
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /templates — list all
router.get('/templates', async (req, res) => {
  const { accountId, status, q } = req.query;
  const where = [];
  const params = [];
  if (accountId === 'unassigned') {
    where.push('t.whatsapp_account_id IS NULL');
  } else if (accountId) {
    params.push(accountId);
    where.push(`t.whatsapp_account_id = $${params.length}`);
  }
  if (status && status !== 'all') {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(lower(t.name) LIKE $${params.length} OR lower(t.body) LIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.category, t.language, t.header_type, t.header_text, t.media_handle, t.body, t.footer,
            t.header_media_library_id,
            t.buttons, t.samples, t.security_recommendation, t.code_expiry_minutes,
            t.allow_category_change, t.status, t.meta_template_id, t.submitted_at,
            t.quality_score, t.rejection_reason, t.previous_category, t.last_synced_at,
            t.template_type, t.template_group_key,
            t.created_at, t.updated_at,
            t.whatsapp_account_id AS "whatsappAccountId",
            wa.display_name AS "whatsappAccountName",
            wa.display_phone_number AS "whatsappAccountPhone",
            (SELECT COUNT(*) FROM coexistence.broadcasts WHERE template_id = t.id)::int AS "broadcastCount",
            (SELECT COUNT(*) FROM coexistence.broadcast_logs bl
              JOIN coexistence.broadcasts b ON b.id = bl.broadcast_id
             WHERE b.template_id = t.id AND bl.action = 'BROADCAST')::int AS "sendCount"
     FROM coexistence.message_templates t
     LEFT JOIN coexistence.whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
     ${whereSql}
     ORDER BY t.updated_at DESC`,
    params
  );
  res.json(rows);
});

// Self-imposed cap: max 2 edits in any rolling 24h window for APPROVED templates.
// Meta's hard limits are 10/hr and 10/day; we throttle tighter to keep templates
// stable for broadcasts and to avoid burning quota on iterative tweaks.
const EDIT_LIMIT_PER_24H = 2;

/**
 * Count edits in the last 24h for a template (manual_edit + restore both count).
 * Returns { count, oldestRecentAt, nextAvailableAt }.
 */
async function getRecentEditQuota(templateId) {
  const { rows } = await pool.query(
    `SELECT revised_at FROM coexistence.message_template_revisions
      WHERE template_id = $1
        AND source IN ('manual_edit','restore')
        AND revised_at > NOW() - INTERVAL '24 hours'
      ORDER BY revised_at ASC`,
    [templateId]
  );
  const count = rows.length;
  const oldestRecentAt = rows[0]?.revised_at || null;
  // The window frees up one slot when the oldest revision rolls past 24h
  const nextAvailableAt = (count >= EDIT_LIMIT_PER_24H && oldestRecentAt)
    ? new Date(new Date(oldestRecentAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;
  return { count, limit: EDIT_LIMIT_PER_24H, oldestRecentAt, nextAvailableAt };
}

// GET /templates/:id — single template
router.get('/templates/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.category, t.language, t.header_type, t.header_text, t.media_handle, t.body, t.footer,
            t.header_media_library_id,
            t.buttons, t.samples, t.security_recommendation, t.code_expiry_minutes,
            t.allow_category_change, t.status, t.meta_template_id, t.submitted_at,
            t.quality_score, t.rejection_reason, t.previous_category, t.last_synced_at,
            t.template_type, t.template_group_key, t.carousel_cards,
            t.created_at, t.updated_at,
            t.whatsapp_account_id AS "whatsappAccountId",
            wa.display_name AS "whatsappAccountName",
            wa.display_phone_number AS "whatsappAccountPhone",
            (SELECT COUNT(*) FROM coexistence.broadcasts WHERE template_id = t.id)::int AS "broadcastCount",
            (SELECT COUNT(*) FROM coexistence.broadcast_logs bl
              JOIN coexistence.broadcasts b ON b.id = bl.broadcast_id
             WHERE b.template_id = t.id AND bl.action = 'BROADCAST')::int AS "sendCount"
     FROM coexistence.message_templates t
     LEFT JOIN coexistence.whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
  const editQuota = await getRecentEditQuota(req.params.id);
  res.json({
    ...rows[0],
    editsInLast24h: editQuota.count,
    editLimit: editQuota.limit,
    nextEditAvailableAt: editQuota.nextAvailableAt,
  });
});

/**
 * Validate + insert one DRAFT template row.
 *
 * Extracted from POST /templates so the Forms feature (routes/leadForms.js,
 * which creates a Utility/Marketing template carrying a form's link) runs the
 * SAME validation, the same duplicate check and the same INSERT. Two copies of
 * this would drift, and the half that drifted would fail at Meta rather than
 * here — where the error is still explainable.
 *
 * Throws an Error carrying `.status` (+ `.errors` / `.existingId`) instead of
 * writing to `res`, so both an HTTP route and an internal caller can use it.
 */
async function insertTemplateRow(data) {
  const errors = runValidation(data);
  if (Object.keys(errors).length > 0) {
    throw Object.assign(new Error('Validation failed'), { status: 400, errors });
  }

  // Meta requires unique (name, language) per WABA. Pre-check locally to
  // give a friendly error before submission fails downstream.
  if (data.whatsappAccountId) {
    const { rows: dup } = await pool.query(
      `SELECT id FROM coexistence.message_templates
        WHERE whatsapp_account_id = $1
          AND lower(name) = lower($2)
          AND language = $3
        LIMIT 1`,
      [data.whatsappAccountId, data.name, data.language]
    );
    if (dup.length > 0) {
      throw Object.assign(
        new Error(`A template with name "${data.name}" in language "${data.language}" already exists on this WhatsApp Account. Choose a different name or language.`),
        { status: 409, existingId: dup[0].id }
      );
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO coexistence.message_templates
     (name, category, language, header_type, header_text, media_handle, body, footer,
      buttons, samples, security_recommendation, code_expiry_minutes, allow_category_change, status,
      whatsapp_account_id, template_group_key, template_type, carousel_cards, header_media_library_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      data.name, data.category, data.language, data.header_type || 'NONE',
      data.header_text || null, data.media_handle || null, data.body,
      data.footer || null, JSON.stringify(data.buttons || []), JSON.stringify(data.samples || {}),
      data.security_recommendation || false, data.code_expiry_minutes || null,
      data.allow_category_change !== false, 'DRAFT',
      data.whatsappAccountId || null,
      String(data.name || '').toLowerCase(),
      data.template_type || 'STANDARD',
      JSON.stringify(data.carousel_cards || []),
      data.header_media_library_id || null,
    ]
  );
  return rows[0];
}

// POST /templates — create
router.post('/templates', async (req, res) => {
  try {
    const row = await insertTemplateRow(req.body);
    res.status(201).json(row);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'Validation failed', errors: err.errors });
    if (err.status === 409) return res.status(409).json({ error: err.message, existingId: err.existingId });
    console.error('[templates] create error:', err.message);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

/**
 * Snapshot the current template row into message_template_revisions.
 * Called before every mutation so the History tab can show a full timeline.
 */
async function snapshotRevision(client, templateRow, { revisedBy, source, changeSummary }) {
  await client.query(
    `INSERT INTO coexistence.message_template_revisions
       (template_id, revised_by, source, change_summary, snapshot)
     VALUES ($1, $2, $3, $4, $5)`,
    [templateRow.id, revisedBy || null, source || 'manual_edit', changeSummary || null, JSON.stringify(templateRow)]
  );
}

/**
 * Build a human-readable diff label like "Edited body and buttons" by
 * comparing the relevant fields between old and new versions.
 */
function summarizeChanges(oldRow, newData) {
  const changed = [];
  const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (oldRow.body !== newData.body) changed.push('body');
  if ((oldRow.footer || '') !== (newData.footer || '')) changed.push('footer');
  if ((oldRow.header_text || '') !== (newData.header_text || '') ||
      oldRow.header_type !== (newData.header_type || 'NONE') ||
      (oldRow.media_handle || '') !== (newData.media_handle || '')) changed.push('header');
  if (!sameJson(oldRow.buttons || [], newData.buttons || [])) changed.push('buttons');
  if (oldRow.category !== newData.category) changed.push(`category (${oldRow.category}→${newData.category})`);
  if (!sameJson(oldRow.carousel_cards || [], newData.carousel_cards || [])) changed.push('carousel cards');
  return changed.length ? `Edited ${changed.join(', ')}` : 'No content changes';
}

// PUT /templates/:id — update template. Behavior depends on current status:
//   DRAFT / REJECTED  → local-only edit, status stays DRAFT
//   APPROVED / PAUSED → calls Meta edit API, status flips to SUBMITTED for re-review
//   SUBMITTED         → 409 (already under review; wait for outcome)
//   DISABLED          → 409 (must duplicate + recreate per Meta policy)
router.put('/templates/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      'SELECT * FROM coexistence.message_templates WHERE id = $1', [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = existing[0];

    if (tpl.status === 'SUBMITTED') {
      return res.status(409).json({ error: 'Template is under Meta review — wait for approval/rejection before editing' });
    }
    if (tpl.status === 'DISABLED') {
      return res.status(409).json({ error: 'DISABLED templates cannot be edited — duplicate and resubmit instead' });
    }

    const data = req.body;
    const errors = runValidation(data);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    // Meta does not allow renaming or language changes after creation
    const isApprovedEdit = ['APPROVED', 'PAUSED'].includes(tpl.status);
    if (isApprovedEdit) {
      if (data.name && data.name !== tpl.name) {
        return res.status(400).json({ error: 'Cannot rename an APPROVED template — duplicate it instead' });
      }
      if (data.language && data.language !== tpl.language) {
        return res.status(400).json({ error: 'Cannot change language on an APPROVED template — add a translation instead' });
      }
      // 2-per-24h edit cap
      const quota = await getRecentEditQuota(tpl.id);
      if (quota.count >= quota.limit) {
        return res.status(429).json({
          error: `Edit limit reached: ${quota.limit} edits per 24 hours. Next edit available at ${new Date(quota.nextAvailableAt).toLocaleString()}.`,
          editsInLast24h: quota.count,
          editLimit: quota.limit,
          nextEditAvailableAt: quota.nextAvailableAt,
        });
      }
    }

    await client.query('BEGIN');
    await snapshotRevision(client, tpl, {
      revisedBy: req.user?.username,
      source: 'manual_edit',
      changeSummary: summarizeChanges(tpl, data),
    });

    let newStatus = 'DRAFT';
    let metaResponse = null;

    if (isApprovedEdit) {
      // Real Meta edit — needs the linked WhatsApp Account
      if (!tpl.whatsapp_account_id || !tpl.meta_template_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Template missing account link or Meta ID — cannot edit at Meta' });
      }
      const account = await getAccountWithToken(tpl.whatsapp_account_id);
      if (!account?.accessToken) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Linked WhatsApp Account has no access token' });
      }

      // Build the payload Meta expects for an edit (components + optional category swap)
      const fullPayload = buildPayload({ ...tpl, ...data, buttons: data.buttons || [] });
      const editPayload = { components: fullPayload.components };
      if (data.category && data.category !== tpl.category && data.category !== 'AUTHENTICATION') {
        editPayload.category = data.category;
      }

      try {
        metaResponse = await metaEditTemplate(tpl.meta_template_id, account.accessToken, editPayload);
        await markAccountHealth(account.id, 'healthy');
        newStatus = 'SUBMITTED'; // Meta re-reviews edited templates
      } catch (err) {
        await client.query('ROLLBACK');
        const isAuth = err.status === 401 || err.metaError?.code === 190;
        await markAccountHealth(account.id, isAuth ? 'invalid_token' : 'unknown_error', err.message).catch(() => {});
        return res.status(err.status === 401 ? 401 : 400).json({
          error: err.metaError?.message || err.message || 'Meta edit failed',
          metaCode: err.metaError?.code,
          metaErrorSubcode: err.metaError?.error_subcode,
          metaErrorData: err.metaError?.error_data,
        });
      }
    }

    const { rows } = await client.query(
      `UPDATE coexistence.message_templates SET
        name = $1::text, category = $2, language = $3, header_type = $4, header_text = $5,
        media_handle = $6, body = $7, footer = $8, buttons = $9, samples = $10,
        security_recommendation = $11, code_expiry_minutes = $12, allow_category_change = $13,
        whatsapp_account_id = $14, template_type = $15, carousel_cards = $16,
        header_media_library_id = $17,
        template_group_key = lower($1::text),
        status = $18,
        meta_template_id = CASE WHEN $19::boolean THEN meta_template_id ELSE NULL END,
        submitted_at = CASE WHEN $19::boolean THEN NOW() ELSE NULL END,
        updated_at = NOW()
       WHERE id = $20
       RETURNING *`,
      [
        data.name || tpl.name, data.category, data.language || tpl.language,
        data.header_type || 'NONE', data.header_text || null, data.media_handle || null,
        data.body, data.footer || null,
        JSON.stringify(data.buttons || []), JSON.stringify(data.samples || {}),
        data.security_recommendation || false, data.code_expiry_minutes || null,
        data.allow_category_change !== false,
        data.whatsappAccountId || tpl.whatsapp_account_id,
        data.template_type || tpl.template_type || 'STANDARD',
        JSON.stringify(data.carousel_cards || []),
        data.header_media_library_id != null ? data.header_media_library_id : (tpl.header_media_library_id || null),
        newStatus,
        isApprovedEdit,
        req.params.id,
      ]
    );
    await client.query('COMMIT');
    res.json({ ...rows[0], metaResponse });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[templates] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update template' });
  } finally {
    client.release();
  }
});

// GET /templates/:id/revisions — paginated revision history (newest first)
router.get('/templates/:id/revisions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { rows } = await pool.query(
      `SELECT id, template_id, revised_at, revised_by, source, change_summary, snapshot
         FROM coexistence.message_template_revisions
        WHERE template_id = $1
        ORDER BY revised_at DESC
        LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM coexistence.message_template_revisions WHERE template_id = $1`,
      [req.params.id]
    );
    res.json({ revisions: rows, total, limit, offset });
  } catch (err) {
    console.error('[templates] revisions GET error:', err.message);
    res.status(500).json({ error: 'Failed to load revisions' });
  }
});

// POST /templates/:id/revisions/:revId/restore — apply an old snapshot as a new edit
// Snapshots the current state first (so restore itself is a revision), then writes
// the old snapshot's content fields back. Goes through the same Meta-edit pipeline
// as a manual edit when the template is APPROVED.
router.post('/templates/:id/revisions/:revId/restore', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: tplRows } = await client.query(
      'SELECT * FROM coexistence.message_templates WHERE id = $1', [req.params.id]
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = tplRows[0];

    if (tpl.status === 'SUBMITTED') {
      return res.status(409).json({ error: 'Template is under review — wait before restoring' });
    }
    if (tpl.status === 'DISABLED') {
      return res.status(409).json({ error: 'DISABLED templates cannot be restored — duplicate instead' });
    }
    if (['APPROVED', 'PAUSED'].includes(tpl.status)) {
      const quota = await getRecentEditQuota(tpl.id);
      if (quota.count >= quota.limit) {
        return res.status(429).json({
          error: `Edit limit reached: ${quota.limit} edits per 24 hours. Next edit available at ${new Date(quota.nextAvailableAt).toLocaleString()}.`,
          editsInLast24h: quota.count,
          editLimit: quota.limit,
          nextEditAvailableAt: quota.nextAvailableAt,
        });
      }
    }

    const { rows: revRows } = await client.query(
      `SELECT * FROM coexistence.message_template_revisions WHERE id = $1 AND template_id = $2`,
      [req.params.revId, req.params.id]
    );
    if (revRows.length === 0) return res.status(404).json({ error: 'Revision not found' });
    const snap = revRows[0].snapshot;

    await client.query('BEGIN');
    await snapshotRevision(client, tpl, {
      revisedBy: req.user?.username,
      source: 'restore',
      changeSummary: `Restored revision ${req.params.revId} (${revRows[0].change_summary || 'snapshot'})`,
    });

    const isApprovedEdit = ['APPROVED', 'PAUSED'].includes(tpl.status);
    let newStatus = 'DRAFT';
    let metaResponse = null;

    if (isApprovedEdit) {
      if (!tpl.meta_template_id || !tpl.whatsapp_account_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Template missing account link or Meta ID' });
      }
      const account = await getAccountWithToken(tpl.whatsapp_account_id);
      if (!account?.accessToken) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Linked account has no access token' });
      }
      const merged = { ...tpl, ...snap, name: tpl.name, language: tpl.language }; // never restore name/language for APPROVED
      const fullPayload = buildPayload(merged);
      const editPayload = { components: fullPayload.components };
      if (snap.category && snap.category !== tpl.category && snap.category !== 'AUTHENTICATION') {
        editPayload.category = snap.category;
      }
      try {
        metaResponse = await metaEditTemplate(tpl.meta_template_id, account.accessToken, editPayload);
        await markAccountHealth(account.id, 'healthy');
        newStatus = 'SUBMITTED';
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(err.status === 401 ? 401 : 400).json({
          error: err.metaError?.message || err.message || 'Meta edit failed',
          metaCode: err.metaError?.code,
        });
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE coexistence.message_templates SET
         category = $1, header_type = $2, header_text = $3, media_handle = $4,
         body = $5, footer = $6, buttons = $7, samples = $8,
         security_recommendation = $9, code_expiry_minutes = $10,
         allow_category_change = $11, template_type = $12, carousel_cards = $13,
         status = $14, updated_at = NOW()
       WHERE id = $15
       RETURNING *`,
      [
        snap.category, snap.header_type || 'NONE', snap.header_text || null, snap.media_handle || null,
        snap.body, snap.footer || null,
        JSON.stringify(snap.buttons || []), JSON.stringify(snap.samples || {}),
        snap.security_recommendation || false, snap.code_expiry_minutes || null,
        snap.allow_category_change !== false,
        snap.template_type || 'STANDARD',
        JSON.stringify(snap.carousel_cards || []),
        newStatus,
        req.params.id,
      ]
    );
    await client.query('COMMIT');
    res.json({ ...updated[0], metaResponse });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[templates] restore error:', err.message);
    res.status(500).json({ error: 'Failed to restore revision' });
  } finally {
    client.release();
  }
});

// ─── Analytics ────────────────────────────────────────────────────────────────
const templateAnalytics = require('../services/templateAnalytics');

// GET /templates/:id/analytics?days=30 — cached daily series + totals + button breakdown
router.get('/templates/:id/analytics', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const data = await templateAnalytics.getCached(req.params.id, { days });
    res.json(data);
  } catch (err) {
    console.error('[templates] analytics GET error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// POST /templates/:id/analytics/refresh — pull fresh data from Meta and upsert
router.post('/templates/:id/analytics/refresh', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.body?.days, 10) || 30, 90);
    const { rows } = await pool.query('SELECT * FROM coexistence.message_templates WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = rows[0];
    if (!tpl.meta_template_id) {
      return res.status(400).json({ error: 'Template has not been submitted to Meta yet — no analytics available' });
    }
    const result = await templateAnalytics.refreshOne(tpl, { days });
    const fresh = await templateAnalytics.getCached(req.params.id, { days });
    res.json({ refreshed: result.upserted, points: result.points, ...fresh });
  } catch (err) {
    console.error('[templates] analytics refresh error:', err.message);
    res.status(400).json({
      error: err.message || 'Refresh failed',
      insightsDisabled: err.insightsDisabled || false,
      metaCode: err.metaError?.code,
      metaSubcode: err.metaError?.error_subcode,
    });
  }
});

// DELETE /templates/:id — removes from local DB AND from Meta if it was submitted
router.delete('/templates/:id', async (req, res) => {
  try {
    const { rows: tplRows } = await pool.query(
      'SELECT * FROM coexistence.message_templates WHERE id = $1', [req.params.id]
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = tplRows[0];

    // If template was submitted to Meta, delete there too (best-effort — local
    // delete still proceeds even if Meta fails, since user explicitly chose delete)
    let metaDeleted = false, metaError = null;
    if (tpl.meta_template_id && tpl.whatsapp_account_id) {
      const account = await getAccountWithToken(tpl.whatsapp_account_id);
      if (account?.accessToken) {
        try {
          await metaDeleteTemplate(account.wabaId, account.accessToken, tpl.name);
          metaDeleted = true;
        } catch (err) {
          metaError = err.message;
          console.warn(`[templates] Meta delete failed for ${tpl.name}: ${err.message}`);
        }
      }
    }
    await pool.query('DELETE FROM coexistence.message_templates WHERE id = $1', [req.params.id]);
    res.json({ ok: true, metaDeleted, metaError });
  } catch (err) {
    console.error('[templates] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /templates/:id/submit
/**
 * POST /templates/:id/submit — real Meta submission via
 * POST /v21.0/{waba_id}/message_templates. Uses the WhatsApp Account
 * linked to this template (template.whatsapp_account_id). Meta returns the
 * template's review status (often PENDING; sometimes auto-APPROVED for simple
 * AUTHENTICATION templates).
 */
const { submitTemplate } = require('../integrations/metaTemplates');
const { getAccountWithToken, assertCanSend } = require('./whatsappAccounts');
const { markAccountHealth } = require('../services/accountHealth');

/**
 * Send one template to Meta for approval and record the outcome.
 *
 * Extracted alongside insertTemplateRow so routes/leadForms.js can submit the
 * template it built for a form without re-implementing the Meta call, the
 * account-health classification or the status mapping.
 *
 * Throws an Error carrying `.status` and the Meta error fields; never writes
 * to `res`.
 */
async function submitTemplateToMeta(templateId) {
  const { rows: tplRows } = await pool.query(
    'SELECT * FROM coexistence.message_templates WHERE id = $1',
    [templateId]
  );
  if (tplRows.length === 0) throw Object.assign(new Error('Template not found'), { status: 404 });
  const tpl = tplRows[0];
  if (!tpl.whatsapp_account_id) {
    throw Object.assign(new Error('Template has no WhatsApp Account assigned. Edit the template and pick an account first.'), { status: 400 });
  }
  const carErr = carouselSubmitError(tpl);
  if (carErr) throw Object.assign(new Error(carErr), { status: 400 });

  const account = await getAccountWithToken(tpl.whatsapp_account_id);
  if (!account) throw Object.assign(new Error('Linked WhatsApp Account not found'), { status: 400 });
  if (!account.accessToken) throw Object.assign(new Error('Account has no access token'), { status: 400 });

  const payload = buildPayload(tpl);

  let metaResponse;
  try {
    metaResponse = await submitTemplate(account.wabaId, account.accessToken, payload);
    await markAccountHealth(account.id, 'healthy');
  } catch (err) {
    // 401/190 = expired/invalid token — flag account as unhealthy
    const isAuth = err.status === 401 || err.metaError?.code === 190;
    await markAccountHealth(account.id, isAuth ? 'invalid_token' : 'unknown_error', err.message);
    const human = err.metaError?.message || err.message || 'Meta submission failed';
    throw Object.assign(new Error(human), {
      status: err.status === 401 ? 401 : 400,
      metaCode: err.metaError?.code,
      metaErrorSubcode: err.metaError?.error_subcode,
      metaErrorData: err.metaError?.error_data,
    });
  }

  // Map Meta status → our local status
  const metaStatus = (metaResponse.status || 'PENDING').toUpperCase();
  const localStatus = metaStatus === 'APPROVED' ? 'APPROVED'
    : metaStatus === 'REJECTED' ? 'REJECTED'
    : 'SUBMITTED';

  const { rows } = await pool.query(
    `UPDATE coexistence.message_templates
       SET status = $1, meta_template_id = $2, submitted_at = NOW(), updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [localStatus, metaResponse.id || null, templateId]
  );
  return { ...rows[0], metaResponse };
}

router.post('/templates/:id/submit', async (req, res) => {
  try {
    res.json(await submitTemplateToMeta(req.params.id));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.metaCode !== undefined ? { metaCode: err.metaCode } : {}),
        ...(err.metaErrorSubcode !== undefined ? { metaErrorSubcode: err.metaErrorSubcode } : {}),
        ...(err.metaErrorData !== undefined ? { metaErrorData: err.metaErrorData } : {}),
      });
    }
    console.error('[templates] submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit template' });
  }
});

// Note: /templates/:id/approve and /:id/reject were removed — they used to
// just flip local DB state without calling Meta, which was misleading. Use
// /:id/sync (single template) or /sync (all) to pull real status from Meta.

const { listTemplates: metaListTemplates, listLibraryTemplates, deleteTemplate: metaDeleteTemplate, editTemplate: metaEditTemplate } = require('../integrations/metaTemplates');

/**
 * Internal helper — sync templates for one WABA from Meta and upsert into
 * local DB. Returns { updated, total } counts.
 */
async function syncAccountTemplates(account) {
  const remote = await metaListTemplates(account.wabaId, account.accessToken);
  let updated = 0;
  for (const r of remote) {
    const status = (r.status || 'PENDING').toUpperCase();
    const localStatus = status === 'PENDING' ? 'SUBMITTED' : status; // PAUSED, DISABLED, APPROVED, REJECTED pass through
    const qs = typeof r.quality_score === 'object' ? r.quality_score?.score : r.quality_score;
    const result = await pool.query(
      `UPDATE coexistence.message_templates
          SET status = $1,
              quality_score = $2,
              rejection_reason = $3,
              previous_category = COALESCE($4, previous_category),
              category = COALESCE($5, category),
              meta_template_id = COALESCE(meta_template_id, $6),
              last_synced_at = NOW(),
              updated_at = NOW()
        WHERE whatsapp_account_id = $7
          AND lower(name) = lower($8)
          AND language = $9
        RETURNING id`,
      [
        localStatus,
        qs || null,
        r.rejected_reason || null,
        r.previous_category || null,
        r.category ? String(r.category).toUpperCase() : null,
        r.id || null,
        account.id,
        r.name,
        r.language,
      ]
    );
    if (result.rowCount > 0) updated++;
  }
  return { updated, total: remote.length };
}

/**
 * POST /templates/:id/sync — refresh one template's Meta-side status.
 * Looks up the linked account, lists Meta's templates, finds the match by
 * (name, language), updates local row.
 */
router.post('/templates/:id/sync', async (req, res) => {
  try {
    const { rows: tplRows } = await pool.query(
      'SELECT * FROM coexistence.message_templates WHERE id = $1', [req.params.id]
    );
    if (tplRows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = tplRows[0];
    if (!tpl.whatsapp_account_id) return res.status(400).json({ error: 'Template has no WhatsApp Account assigned' });

    const account = await getAccountWithToken(tpl.whatsapp_account_id);
    if (!account) return res.status(400).json({ error: 'Account not found' });
    try {
      await syncAccountTemplates(account);
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const { classifyMetaError } = require('../services/accountHealth');
      await markAccountHealth(account.id, classifyMetaError(err), err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message });
    }
    const { rows: fresh } = await pool.query(
      `SELECT * FROM coexistence.message_templates WHERE id = $1`, [req.params.id]
    );
    res.json(fresh[0]);
  } catch (err) {
    console.error('[templates] sync error:', err.message);
    res.status(500).json({ error: 'Failed to sync from Meta' });
  }
});

/**
 * Sync every active account's templates from Meta. Shared by the manual
 * "Refresh All" button (POST /templates/sync-all) and the periodic auto-sync
 * cron in index.js (Meta does not push us approval status — we must poll).
 */
async function syncAllAccountTemplates() {
  const { rows: accs } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts WHERE is_active = TRUE`
  );
  let totalUpdated = 0, totalRemote = 0;
  for (const r of accs) {
    const account = await getAccountWithToken(r.id);
    if (!account?.accessToken) continue;
    try {
      const result = await syncAccountTemplates(account);
      totalUpdated += result.updated;
      totalRemote += result.total;
      await markAccountHealth(account.id, 'healthy');
    } catch (err) {
      const { classifyMetaError } = require('../services/accountHealth');
      await markAccountHealth(account.id, classifyMetaError(err), err.message);
    }
  }
  return { accountsScanned: accs.length, totalUpdated, totalRemote };
}

/**
 * POST /templates/sync-all — sync every account's templates. Used by the
 * "Refresh All" button in the list view + the periodic auto-sync cron.
 */
router.post('/templates/sync-all', async (req, res) => {
  try {
    const result = await syncAllAccountTemplates();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[templates] sync-all error:', err.message);
    res.status(500).json({ error: 'Failed to sync templates' });
  }
});

/**
 * POST /templates/:id/duplicate — create a DRAFT clone with " (copy)" name suffix.
 */
router.post('/templates/:id/duplicate', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.message_templates
        (name, category, language, header_type, header_text, media_handle, body, footer,
         buttons, samples, security_recommendation, code_expiry_minutes, allow_category_change,
         status, whatsapp_account_id, template_type, carousel_cards, template_group_key)
       SELECT name || '_copy_' || EXTRACT(EPOCH FROM NOW())::int,
              category, language, header_type, header_text, media_handle, body, footer,
              buttons, samples, security_recommendation, code_expiry_minutes, allow_category_change,
              'DRAFT', whatsapp_account_id, template_type, carousel_cards, NULL
         FROM coexistence.message_templates WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[templates] duplicate error:', err.message);
    res.status(500).json({ error: 'Failed to duplicate template' });
  }
});

/**
 * POST /templates/bulk-submit — submit multiple DRAFT templates in one call.
 * Body: { ids: [1, 2, 3] }. Returns per-id outcome.
 */
router.post('/templates/bulk-submit', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    const results = [];
    for (const id of ids) {
      try {
        const fakeReq = { params: { id }, body: {} };
        const fakeRes = { _status: 200, _body: null,
          status(c) { this._status = c; return this; },
          json(b) { this._body = b; return this; },
        };
        // Re-invoke the existing /:id/submit handler logic inline by calling it
        await new Promise((resolve) => {
          submitOneInline(id).then(out => {
            results.push({ id, ...out });
            resolve();
          }).catch(err => {
            results.push({ id, ok: false, error: err.message });
            resolve();
          });
        });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    res.json({ results, succeeded: results.filter(r => r.ok).length, total: results.length });
  } catch (err) {
    console.error('[templates] bulk-submit error:', err.message);
    res.status(500).json({ error: 'Bulk submit failed' });
  }
});

// Internal: shared submit-one logic used by /submit and /bulk-submit
async function submitOneInline(id) {
  const { rows: tplRows } = await pool.query('SELECT * FROM coexistence.message_templates WHERE id = $1', [id]);
  if (tplRows.length === 0) return { ok: false, error: 'Template not found' };
  const tpl = tplRows[0];
  if (!tpl.whatsapp_account_id) return { ok: false, error: 'No WhatsApp Account assigned' };
  const carErr = carouselSubmitError(tpl);
  if (carErr) return { ok: false, error: carErr };
  const account = await getAccountWithToken(tpl.whatsapp_account_id);
  if (!account?.accessToken) return { ok: false, error: 'Account has no token' };

  const payload = buildPayload(tpl);
  try {
    const metaResponse = await submitTemplate(account.wabaId, account.accessToken, payload);
    await markAccountHealth(account.id, 'healthy');
    const metaStatus = (metaResponse.status || 'PENDING').toUpperCase();
    const localStatus = metaStatus === 'APPROVED' ? 'APPROVED'
      : metaStatus === 'REJECTED' ? 'REJECTED' : 'SUBMITTED';
    await pool.query(
      `UPDATE coexistence.message_templates
         SET status = $1, meta_template_id = $2, submitted_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [localStatus, metaResponse.id || null, id]
    );
    return { ok: true, status: localStatus, metaId: metaResponse.id };
  } catch (err) {
    const { classifyMetaError } = require('../services/accountHealth');
    await markAccountHealth(account.id, classifyMetaError(err), err.message);
    return { ok: false, error: err.metaError?.message || err.message };
  }
}

/**
 * GET /templates/library?accountId= — fetch Meta's curated template library.
 */
router.get('/templates/library', async (req, res) => {
  try {
    const { accountId, topic } = req.query;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const account = await getAccountWithToken(accountId);
    if (!account?.accessToken) return res.status(400).json({ error: 'Account not found or has no token' });
    try {
      const data = await listLibraryTemplates(account.accessToken, { topic });
      res.json({ templates: data });
    } catch (err) {
      // Meta returns 400 if account doesn't have library access — that's expected, not a hard error
      res.status(200).json({ templates: [], error: err.message });
    }
  } catch (err) {
    console.error('[templates] library error:', err.message);
    res.status(500).json({ error: 'Failed to list library templates' });
  }
});

/**
 * POST /templates/library/clone — clone a Meta library template into a local DRAFT.
 * Body: { accountId, libraryTemplate: { name, language, category, components } }
 */
router.post('/templates/library/clone', async (req, res) => {
  try {
    const { accountId, libraryTemplate } = req.body || {};
    if (!accountId || !libraryTemplate?.name) return res.status(400).json({ error: 'accountId and libraryTemplate required' });
    // Convert Meta library shape → our DB shape (best-effort)
    const headerComp = (libraryTemplate.components || []).find(c => c.type === 'HEADER');
    const bodyComp = (libraryTemplate.components || []).find(c => c.type === 'BODY');
    const footerComp = (libraryTemplate.components || []).find(c => c.type === 'FOOTER');
    const buttonsComp = (libraryTemplate.components || []).find(c => c.type === 'BUTTONS');
    const buttons = (buttonsComp?.buttons || []).map(b => ({
      type: b.type, text: b.text, value: b.url || b.phone_number || '',
    }));
    const { rows } = await pool.query(
      `INSERT INTO coexistence.message_templates
        (name, category, language, header_type, header_text, body, footer, buttons,
         samples, security_recommendation, allow_category_change, status, whatsapp_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',false,true,'DRAFT',$9) RETURNING *`,
      [
        libraryTemplate.name + '_lib_' + Math.floor(Date.now() / 1000),
        libraryTemplate.category || 'MARKETING',
        libraryTemplate.language || 'en',
        headerComp?.format || 'NONE',
        headerComp?.text || null,
        bodyComp?.text || '',
        footerComp?.text || null,
        JSON.stringify(buttons),
        accountId,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[templates] library clone error:', err.message);
    res.status(500).json({ error: 'Failed to clone library template' });
  }
});

// (export consolidated at the bottom of this file)

// GET /templates/:id/payload — get Meta API payload
router.get('/templates/:id/payload', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT name, category, language, header_type, header_text, media_handle, body, footer,
            buttons, samples, security_recommendation, code_expiry_minutes, allow_category_change
     FROM coexistence.message_templates WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
  const payload = buildPayload(rows[0]);
  res.json(payload);
});

/**
 * POST /templates/:id/test-send
 * Body: { to: '919xxx', sampleValues?: { '1': 'John', '2': 'ORD-123' } }
 * Sends the template via the WhatsApp account linked to this template.
 */
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');

router.post('/templates/:id/test-send', async (req, res) => {
  try {
    const { to, sampleValues = {} } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to (recipient phone) required' });

    const { rows } = await pool.query(
      `SELECT id, name, language, body, buttons, template_type, carousel_cards, whatsapp_account_id FROM coexistence.message_templates WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = rows[0];
    if (!tpl.whatsapp_account_id) return res.status(400).json({ error: 'Template has no WhatsApp account assigned' });

    const { account, error } = await resolveAccount({ accountId: tpl.whatsapp_account_id });
    if (error) return res.status(400).json({ error });

    // Meta accepts a send even when the account is billing-blocked, then fails
    // it async — reject the click now with the real reason instead.
    const canSend = await assertCanSend(account);
    if (!canSend.ok) return res.status(400).json({ error: canSend.reason });

    // Build components from sampleValues (sorted numerically by var index)
    const keys = Object.keys(sampleValues).sort((a, b) => +a - +b);
    const components = keys.length > 0
      ? [{ type: 'body', parameters: keys.map(k => ({ type: 'text', text: String(sampleValues[k] || ' ') })) }]
      : [];
    // A dynamic URL button (a {{n}} variable in its URL) needs a button
    // component or Meta rejects the whole send (#131008). If the button points
    // at a lead form, mint a REAL single-use token for `to` so even a Test
    // Send auto-identifies the recipient (no phone asked on the form). For a
    // non-lead-form dynamic URL, fall back to the sample's trailing segment.
    const { mintTokenForButtonUrl } = require('./leadForms');
    for (let idx = 0; idx < (Array.isArray(tpl.buttons) ? tpl.buttons.length : 0); idx++) {
      const b = tpl.buttons[idx];
      if (b.type === 'URL' && /\{\{\s*\d+\s*\}\}/.test(b.value || '')) {
        let text = await mintTokenForButtonUrl(b.value, to, { waAccountId: account.id });
        if (!text) {
          const sample = String(b.urlSample || '').trim();
          text = sample.split('/').filter(Boolean).pop() || 'test';
        }
        components.push({ type: 'button', sub_type: 'url', index: idx, parameters: [{ type: 'text', text }] });
      }
    }
    // CAROUSEL templates: append the resolved carousel component so the test
    // actually renders the cards (without it Meta rejects — carousel param missing).
    if (String(tpl.template_type || '').toUpperCase() === 'CAROUSEL') {
      const { buildCarouselComponent } = require('./mediaLibrary');
      const carousel = await buildCarouselComponent(tpl, account.id);
      if (carousel) components.push(carousel);
    }

    const localId = await insertPendingRow({
      account, toNumber: to, messageType: 'template', messageBody: tpl.body || `Template: ${tpl.name}`,
    });
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(to).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { name: tpl.name, languageCode: tpl.language || 'en', components },
    });

    res.status(202).json({ ok: true, messageId: localId, status: 'sending' });
  } catch (err) {
    console.error('[templates] test-send error:', err.message);
    res.status(500).json({ error: 'Failed to enqueue test send' });
  }
});

/**
 * POST /templates/upload-media-handle (multipart)
 * Fields: accountId, file
 * Performs Meta's Resumable Upload (2-step) to obtain a `media_handle` that
 * can be pasted into a template's header.example. Returns { handle }.
 */
const multer = require('multer');
const { uploadTemplateMediaHandle } = require('../integrations/metaResumableUpload');
const tplMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/templates/upload-media-handle', tplMediaUpload.single('file'), async (req, res) => {
  try {
    const { accountId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const { rows } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
      [accountId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'WhatsApp account not found' });
    const acc = rows[0];
    if (!acc.meta_app_id) {
      return res.status(400).json({ error: 'WhatsApp account is missing meta_app_id — add it in Settings → WhatsApp Accounts' });
    }
    const { decrypt } = require('../util/crypto');
    const accessToken = decrypt(acc.access_token_encrypted);
    if (!accessToken) return res.status(400).json({ error: 'Account has no access token' });

    try {
      const handle = await uploadTemplateMediaHandle({
        appId: acc.meta_app_id, accessToken,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
      });
      await markAccountHealth(acc.id, 'healthy');
      res.json({ handle, mimeType: req.file.mimetype, size: req.file.size });
    } catch (err) {
      const { classifyMetaError } = require('../services/accountHealth');
      await markAccountHealth(acc.id, classifyMetaError(err), err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }
  } catch (err) {
    console.error('[templates] upload-media-handle error:', err.message);
    res.status(500).json({ error: 'Failed to upload template media' });
  }
});

/**
 * POST /templates/upload-media-handle-from-library
 * Body: { accountId, mediaLibraryId }
 *
 * Same outcome as /templates/upload-media-handle, but pulls the source bytes
 * from the Media Library (MinIO) instead of an inline multipart upload.
 * The template `header_handle` is single-use at submit time, so we don't
 * persist anything per-WABA for templates — this is purely a convenience
 * that lets users build templates from previously uploaded library assets.
 */
router.post('/templates/upload-media-handle-from-library', async (req, res) => {
  try {
    const { accountId, mediaLibraryId } = req.body || {};
    if (!accountId || !mediaLibraryId) {
      return res.status(400).json({ error: 'accountId and mediaLibraryId required' });
    }

    const { rows: accRows } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
      [accountId]
    );
    if (!accRows.length) return res.status(404).json({ error: 'WhatsApp account not found' });
    const acc = accRows[0];
    if (!acc.meta_app_id) {
      return res.status(400).json({ error: 'WhatsApp account is missing meta_app_id — add it in Settings → WhatsApp Accounts' });
    }

    const { rows: mRows } = await pool.query(
      `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
      [mediaLibraryId]
    );
    if (!mRows.length) return res.status(404).json({ error: 'Media not found in library' });
    const media = mRows[0];

    const { decrypt } = require('../util/crypto');
    const accessToken = decrypt(acc.access_token_encrypted);
    if (!accessToken) return res.status(400).json({ error: 'Account has no access token' });

    const minio = require('../util/minioClient');
    let buffer;
    try {
      buffer = await minio.getObjectBuffer(media.minio_object_key);
    } catch (err) {
      return res.status(502).json({ error: `Failed to read media from storage: ${err.message}` });
    }

    try {
      const handle = await uploadTemplateMediaHandle({
        appId: acc.meta_app_id, accessToken,
        buffer, mimeType: media.mime_type,
      });
      await markAccountHealth(acc.id, 'healthy');
      res.json({
        handle,
        mimeType: media.mime_type,
        size: Number(media.size_bytes),
        name: media.name,
        originalName: media.original_name,
        mediaLibraryId: Number(media.id),
      });
    } catch (err) {
      const { classifyMetaError } = require('../services/accountHealth');
      await markAccountHealth(acc.id, classifyMetaError(err), err.message);
      return res.status(err.status === 401 ? 401 : 400).json({ error: err.message, metaCode: err.metaError?.code });
    }
  } catch (err) {
    console.error('[templates] upload-media-handle-from-library error:', err.message);
    res.status(500).json({ error: 'Failed to upload template media from library' });
  }
});

module.exports = { router, syncAccountTemplates, syncAllAccountTemplates, insertTemplateRow, submitTemplateToMeta };
