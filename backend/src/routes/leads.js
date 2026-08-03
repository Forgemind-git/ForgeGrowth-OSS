// Leads — the AI Academy funnel source of truth. Marketing (acquisition) and
// Sales (conversion) are both views over this table; Chats reads lead context.
// Mounted under /api with authMiddleware in index.js.
//
// Endpoints:
//   GET    /leads                     list (filters + saved-view presets)
//   GET    /leads/board               grouped by stage + stage→stage conversion %
//   GET    /leads/onboarding          enrolled leads + after-sale checklist fields
//   GET    /lead-sources              ranked channel quality table
//   GET    /leads/export              CSV of the current filter
//   GET    /students/export           CSV/XLSX of the Sales Log (enrolled leads)
//   GET    /leads/:id                 single lead
//   GET    /leads/:id/timeline        lead_events + activity timeline
//   POST   /leads                     create
//   PUT    /leads/:id                 edit (dynamic SET)
//   PUT    /leads/:id/move            change stage (audits + emits)
//   POST   /leads/bulk-assign         assign many leads to a BDA/user
//
// Also exports helpers reused by the send-path logger:
//   recordOutbound(leadId, { bda }) — advances the consecutive follow-up streak,
//     logs a message_sent activity row, and cold-drops the lead once it crosses
//     agent_config.stage_thresholds.cold_after_follow_ups.
//   recordInbound(leadId)          — resets the follow-up streak on a reply.

const { Router } = require('express');
const XLSX = require('xlsx');
const pool = require('../db');
const bus = require('../events');
const cfg = require('../services/funnelConfig');
const funnelTags = require('../services/funnelTags');

const router = Router();

// Stage lists are now user-configurable (funnel_stages, migration 064). They are
// read from the cached funnel config instead of hardcoded arrays, but each stage
// keeps a stable stage_key so this logic is unchanged for the seeded defaults.
const allStageKeys = () => cfg.stageKeys();               // every active stage, in order
const funnelStageKeys = () => cfg.funnelStageKeys();      // funnel-progression stages only, in order
const defaultStageKey = () => cfg.stageKeys()[0] || 'new';

// ── access helpers ────────────────────────────────────────────────────────────
function isAdmin(req) { return req.user?.role === 'admin'; }
function meId(req) { return parseInt(req.user?.id, 10); }

// Non-admins see only leads assigned to them (mirrors pipelines dealScopeClause).
function leadScopeClause(req, idx, alias = 'l') {
  if (isAdmin(req)) return '';
  return `AND ${alias}.assigned_user_id = $${idx}`;
}

function emitLeadChanged(payload = {}) {
  bus.emit('lead-changed', payload);
}

function leadRow(r) {
  return {
    id: Number(r.id),
    name: r.name,
    whatsappNumber: r.whatsapp_number,
    email: r.email,
    age: r.age == null ? null : Number(r.age),
    profession: r.profession,
    pincode: r.pincode,
    city: r.city,
    role: r.role,
    source: r.source,
    goal: r.goal,
    webinarSlot: r.webinar_slot,
    referredBy: r.referred_by,
    stage: r.stage,
    assignedBda: r.assigned_bda,
    assignedUserId: r.assigned_user_id == null ? null : Number(r.assigned_user_id),
    assignedUserName: r.assigned_user_name || null,
    followUpCount: Number(r.follow_up_count || 0),
    lastInboundAt: r.last_inbound_at,
    lastOutboundAt: r.last_outbound_at,
    lastActivityAt: r.last_activity_at,
    stageChangedAt: r.stage_changed_at,
    hasWhatsappThread: r.has_whatsapp_thread,
    customFields: r.custom_fields || {},
    paymentDate: r.payment_date,
    paidCourse: r.paid_course,
    paidAmount: r.paid_amount_paise == null ? null : Math.round(Number(r.paid_amount_paise)) / 100,
    formStatus: r.form_status,
    zip: r.zip,
    state: r.state,
    batchAssigned: r.batch_assigned,
    toolAccess: r.tool_access,
    batchGroupAdded: r.batch_group_added,
    prebatchReminderSent: r.prebatch_reminder_sent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── shared filter builder ─────────────────────────────────────────────────────
// Builds a WHERE fragment + params from query filters and saved-view presets.
function buildLeadFilter(req) {
  const q = req.query || {};
  const params = [];
  const where = [];

  const add = (val) => { params.push(val); return `$${params.length}`; };

  if (q.stage && cfg.isValidStage(q.stage)) where.push(`l.stage = ${add(q.stage)}`);
  if (q.source) where.push(`l.source = ${add(q.source)}`);
  if (q.bda) where.push(`l.assigned_bda = ${add(q.bda)}`);
  if (q.assignedUserId) where.push(`l.assigned_user_id = ${add(parseInt(q.assignedUserId, 10))}`);
  if (q.search) {
    const p = add(`%${String(q.search).trim()}%`);
    where.push(`(l.name ILIKE ${p} OR l.whatsapp_number ILIKE ${p} OR l.email ILIKE ${p})`);
  }
  if (q.days) {
    const n = parseInt(q.days, 10);
    if (Number.isFinite(n) && n > 0) where.push(`l.created_at >= NOW() - INTERVAL '${n} days'`);
  }

  // Saved-view presets.
  switch (q.view) {
    case 'my':
      where.push(`l.assigned_user_id = ${add(meId(req))}`);
      break;
    case 'hot':
      // "Hot leads" = arrived within the last 24 hours (recency, independent of
      // the funnel 'hot' stage).
      where.push(`l.created_at >= NOW() - INTERVAL '24 hours'`);
      break;
    case 'unassigned':
      where.push(`l.assigned_user_id IS NULL AND l.assigned_bda IS NULL`);
      break;
    case 'needs-follow-up':
      // Nobody has chased them at all: no outbound since last inbound AND stale.
      where.push(`l.follow_up_count = 0 AND (l.last_outbound_at IS NULL OR l.last_outbound_at < NOW() - INTERVAL '2 days') AND l.stage NOT IN ('enrolled','cold_lost')`);
      break;
    default:
      break;
  }

  // RBAC scope for non-admins.
  if (!isAdmin(req)) where.push(`l.assigned_user_id = ${add(meId(req))}`);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { clause, params };
}

const SELECT_LEAD = `
  SELECT l.*, u.display_name AS assigned_user_name
    FROM coexistence.leads l
    LEFT JOIN coexistence.forgecrm_users u ON u.id = l.assigned_user_id`;

// ── list ──────────────────────────────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  try {
    const { clause, params } = buildLeadFilter(req);
    const { rows } = await pool.query(
      `${SELECT_LEAD} ${clause} ORDER BY l.last_activity_at DESC NULLS LAST, l.id DESC LIMIT 1000`,
      params
    );
    res.json({ leads: rows.map(leadRow) });
  } catch (err) {
    console.error('[leads] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// ── board (kanban grouped by stage + conversion %) ────────────────────────────
router.get('/leads/board', async (req, res) => {
  try {
    const scope = leadScopeClause(req, 1);
    const params = isAdmin(req) ? [] : [meId(req)];
    const { rows } = await pool.query(
      `${SELECT_LEAD} WHERE 1=1 ${scope}
        ORDER BY l.last_activity_at DESC NULLS LAST, l.id DESC`,
      params
    );
    const leads = rows.map(leadRow);

    // Group by stage.
    const stageKeys = allStageKeys();
    const funnelKeys = funnelStageKeys();
    const columns = {};
    for (const s of stageKeys) columns[s] = [];
    for (const lead of leads) (columns[lead.stage] || (columns[lead.stage] = [])).push(lead);

    // Stage-to-stage conversion: leads currently at-or-past stage N+1 vs at-or-past N.
    const atOrPast = (stageIdx) =>
      leads.filter(l => {
        const li = funnelKeys.indexOf(l.stage);
        return li >= stageIdx; // branch-off stages (indexOf -1) excluded from funnel progression
      }).length;
    const conversions = [];
    for (let i = 0; i < funnelKeys.length - 1; i++) {
      const from = atOrPast(i);
      const to = atOrPast(i + 1);
      conversions.push({
        from: funnelKeys[i],
        to: funnelKeys[i + 1],
        pct: from ? Math.round((to / from) * 100) : 0,
      });
    }

    const agentCfg = await loadAgentConfig();
    res.json({
      stages: stageKeys,
      columns,
      conversions,
      coldAfterFollowUps: agentCfg.stage_thresholds?.cold_after_follow_ups ?? 3,
    });
  } catch (err) {
    console.error('[leads] board error:', err.message);
    res.status(500).json({ error: 'Failed to load board' });
  }
});

// ── onboarding (after-sale checklist) ─────────────────────────────────────────
router.get('/leads/onboarding', async (req, res) => {
  try {
    const scope = leadScopeClause(req, 1);
    const params = isAdmin(req) ? [] : [meId(req)];
    const { rows } = await pool.query(
      `${SELECT_LEAD} WHERE l.stage = 'enrolled' ${scope}
        ORDER BY l.payment_date DESC NULLS LAST, l.id DESC`,
      params
    );
    const leads = rows.map(leadRow);
    const pendingForms = leads.filter(l => l.formStatus !== 'complete');
    res.json({ leads, pendingForms });
  } catch (err) {
    console.error('[leads] onboarding error:', err.message);
    res.status(500).json({ error: 'Failed to load onboarding' });
  }
});

// ── Students (paid / enrolled leads) + installments ───────────────────────────
// A "student" is a lead at the won stage ('enrolled'). Installments are that
// student's payments toward their course: Razorpay captured payments matched to
// the lead (razorpay_events.matched_lead_id) + any manually-added sales_log rows.
// Amounts convert paise↔₹ at this boundary.
const paise2r = (p) => Math.round(Number(p || 0)) / 100;

// Razorpay writes multiple 'captured' event rows per payment (payment.captured +
// order.paid), so we DEDUPE by payment_id (preferring the payment.captured row)
// before summing — otherwise totals/installments double-count.
const RZP_CAPTURED = (leadPred) => `
  SELECT DISTINCT ON (COALESCE(payment_id, 'evt'||id::text))
         id, matched_lead_id AS lead_id, amount_paise, created_at, method, payment_id
    FROM coexistence.razorpay_events
   WHERE status='captured' AND ${leadPred}
   ORDER BY COALESCE(payment_id, 'evt'||id::text), (event_type='payment.captured') DESC, id`;

// UNION of a student's payments (gateway + manual), keyed by lead_id.
const PAYMENTS_CTE = `
  payments AS (
    SELECT lead_id, amount_paise, created_at::date AS pay_date FROM ( ${RZP_CAPTURED('matched_lead_id IS NOT NULL')} ) rz
    UNION ALL
    SELECT lead_id, amount_paise, payment_date AS pay_date
      FROM coexistence.sales_log WHERE lead_id IS NOT NULL
  )`;

async function refreshPaidTotal(leadId) {
  await pool.query(
    `UPDATE coexistence.leads l SET paid_amount_paise = (
       SELECT COALESCE(SUM(amount_paise),0) FROM (
         SELECT amount_paise FROM ( ${RZP_CAPTURED('matched_lead_id = l.id')} ) rz
         UNION ALL SELECT amount_paise FROM coexistence.sales_log WHERE lead_id=l.id) s),
       updated_at=NOW() WHERE l.id=$1`, [leadId]);
}

router.get('/students', async (req, res) => {
  try {
    const scope = leadScopeClause(req, 1);
    const params = isAdmin(req) ? [] : [meId(req)];
    const { rows } = await pool.query(
      `WITH ${PAYMENTS_CTE}
       SELECT l.*, u.display_name AS assigned_user_name,
              (SELECT COUNT(*) FROM payments p WHERE p.lead_id=l.id)::int AS installment_count,
              (SELECT COALESCE(SUM(amount_paise),0) FROM payments p WHERE p.lead_id=l.id)::bigint AS total_paid_paise,
              (SELECT MAX(pay_date) FROM payments p WHERE p.lead_id=l.id) AS last_payment_at,
              ch.wa_number AS chat_wa_number, ch.contact_number AS chat_contact_number
         FROM coexistence.leads l
         LEFT JOIN LATERAL (
           SELECT c.wa_number, c.contact_number FROM coexistence.contacts c
            WHERE regexp_replace(c.contact_number, '[^0-9]', '', 'g')
                = regexp_replace(l.whatsapp_number, '[^0-9]', '', 'g')
            ORDER BY c.updated_at DESC NULLS LAST LIMIT 1
         ) ch ON TRUE
         LEFT JOIN coexistence.forgecrm_users u ON u.id = l.assigned_user_id
        WHERE l.stage='enrolled' ${scope}
        ORDER BY last_payment_at DESC NULLS LAST, l.id DESC`,
      params
    );
    const students = rows.map(r => ({
      ...leadRow(r),
      paidCourse: r.paid_course,
      installmentCount: Number(r.installment_count || 0),
      totalPaid: paise2r(r.total_paid_paise),
      lastPaymentAt: r.last_payment_at,
      chatWaNumber: r.chat_wa_number || null,
      chatContactNumber: r.chat_contact_number || null,
    }));
    res.json({ students });
  } catch (err) {
    console.error('[leads] students error:', err.message);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// ── Sales Log export (CSV or XLSX, ?format=xlsx) ───────────────────────────────
router.get('/students/export', async (req, res) => {
  try {
    const scope = leadScopeClause(req, 1);
    const params = isAdmin(req) ? [] : [meId(req)];
    const { rows } = await pool.query(
      `WITH ${PAYMENTS_CTE}
       SELECT l.*,
              (SELECT COALESCE(SUM(amount_paise),0) FROM payments p WHERE p.lead_id=l.id)::bigint AS total_paid_paise
         FROM coexistence.leads l
        WHERE l.stage='enrolled' ${scope}
        ORDER BY l.id DESC LIMIT 5000`,
      params
    );
    const cols = ['Customer', 'WhatsApp', 'Email', 'Age', 'Profession', 'Pincode', 'Course', 'Total Paid (INR)', 'Source', 'Payment Date', 'Created At'];
    const data = rows.map(r => ({
      Customer: r.name || '', WhatsApp: r.whatsapp_number || '', Email: r.email || '',
      Age: r.age ?? '', Profession: r.profession || '', Pincode: r.pincode || '',
      Course: r.paid_course || '', 'Total Paid (INR)': paise2r(r.total_paid_paise),
      Source: r.source || '', 'Payment Date': r.payment_date ? new Date(r.payment_date).toISOString().slice(0, 10) : '',
      'Created At': r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
    }));

    if (req.query.format === 'xlsx') {
      const ws = XLSX.utils.json_to_sheet(data, { header: cols });
      ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 24 }, { wch: 6 }, { wch: 20 }, { wch: 10 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sales Log');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="sales-log.xlsx"');
      return res.send(buf);
    }

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const row of data) lines.push(cols.map(c => esc(row[c])).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-log.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[leads] students export error:', err.message);
    res.status(500).json({ error: 'Failed to export sales log' });
  }
});

router.get('/students/:id/installments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessLead(req, id))) return res.status(403).json({ error: 'You can only view your own students' });
    const { rows: lrows } = await pool.query(`${SELECT_LEAD} WHERE l.id = $1`, [id]);
    if (!lrows.length) return res.status(404).json({ error: 'Student not found' });
    const { rows } = await pool.query(
      `SELECT kind, id, amount_paise, pay_date, method, ref, notes FROM (
         SELECT 'razorpay' AS kind, id, amount_paise, created_at::date AS pay_date,
                COALESCE(NULLIF(method,''),'Razorpay') AS method, payment_id AS ref, NULL::text AS notes
           FROM ( ${RZP_CAPTURED('matched_lead_id = $1')} ) rz
         UNION ALL
         SELECT 'manual' AS kind, id, amount_paise, payment_date AS pay_date,
                COALESCE(NULLIF(method,''),'Manual') AS method, NULL AS ref, notes
           FROM coexistence.sales_log WHERE lead_id=$1
       ) t ORDER BY pay_date ASC NULLS LAST, id ASC`,
      [id]
    );
    const installments = rows.map(r => ({
      kind: r.kind, id: Number(r.id), amount: paise2r(r.amount_paise),
      date: r.pay_date, method: r.method, ref: r.ref, notes: r.notes,
    }));
    res.json({
      student: { ...leadRow(lrows[0]), ...(await chatLinkFor(lrows[0].whatsapp_number)) },
      installments,
      totalPaid: installments.reduce((a, x) => a + x.amount, 0),
    });
  } catch (err) {
    console.error('[leads] installments error:', err.message);
    res.status(500).json({ error: 'Failed to load installments' });
  }
});

// Add a manual installment (a payment row in sales_log) to a student.
router.post('/students/:id/installments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessLead(req, id))) return res.status(403).json({ error: 'You can only update your own students' });
    const b = req.body || {};
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'A payment amount is required' });
    if (!b.paymentDate) return res.status(400).json({ error: 'Payment date is required' });
    const { rows: lr } = await pool.query(`SELECT name, source, paid_course FROM coexistence.leads WHERE id=$1`, [id]);
    if (!lr.length) return res.status(404).json({ error: 'Student not found' });
    let courseId = b.courseId ? parseInt(b.courseId, 10) : null;
    let productLabel = lr[0].paid_course || null;
    if (courseId) {
      const c = await pool.query(`SELECT name FROM coexistence.courses WHERE id=$1`, [courseId]);
      if (c.rows[0]) productLabel = c.rows[0].name;
    }
    await pool.query(
      `INSERT INTO coexistence.sales_log (lead_id, student_name, course_id, product_label, amount_paise, payment_date, funnel_source, notes, method, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, lr[0].name || 'Student', courseId, productLabel, Math.round(amount * 100), b.paymentDate, lr[0].source || null, b.notes || null, b.method || null, actorOf(req)]
    );
    await refreshPaidTotal(id);
    emitLeadChanged({ leadId: id });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[leads] add installment error:', err.message);
    res.status(500).json({ error: 'Failed to add installment' });
  }
});

// Add a sale = enrol a student (match/create their lead) + record the first
// installment. The Students-page "Add Sale" modal posts here.
router.post('/students', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.studentName || !String(b.studentName).trim()) return res.status(400).json({ error: 'Student name is required' });
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'A valid WhatsApp number is required' });
    const name = String(b.studentName).trim();
    const last10 = phone.slice(-10);
    // Razorpay-page profile fields (also collected in the Add Sale form). Manually
    // entered values win over any existing blank (COALESCE(new, existing)).
    const email = b.email ? String(b.email).trim() : null;
    const ageVal = Number.isFinite(Number(b.age)) && String(b.age).trim() !== '' ? parseInt(b.age, 10) : null;
    const profession = b.profession ? String(b.profession).trim() : null;
    const pincode = b.pincode ? String(b.pincode).trim() : null;

    const { rows: found } = await pool.query(
      `SELECT id, stage FROM coexistence.leads WHERE right(regexp_replace(whatsapp_number,'\\D','','g'),10)=$1 ORDER BY id LIMIT 1`, [last10]);
    let leadId;
    if (found.length) {
      leadId = found[0].id;
      const wasEnrolled = found[0].stage === 'enrolled';
      await pool.query(
        `UPDATE coexistence.leads
            SET stage = CASE WHEN stage NOT IN ('enrolled','cold_lost') THEN 'enrolled' ELSE stage END,
                stage_changed_at = CASE WHEN stage NOT IN ('enrolled','cold_lost') THEN NOW() ELSE stage_changed_at END,
                payment_date = COALESCE(payment_date, $2), name = COALESCE(name, $3),
                email = COALESCE($4, email), age = COALESCE($5, age),
                profession = COALESCE($6, profession), pincode = COALESCE($7, pincode),
                source = COALESCE($8, source), updated_at = NOW()
          WHERE id = $1`,
        [leadId, b.paymentDate || null, name, email, ageVal, profession, pincode, b.source || null]);
      if (!wasEnrolled) await logEvent(leadId, 'stage_changed', found[0].stage, 'enrolled', actorOf(req));
    } else {
      const ins = await pool.query(
        `INSERT INTO coexistence.leads (whatsapp_number, name, email, age, profession, pincode, source, stage, has_whatsapp_thread, payment_date, stage_changed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'enrolled',FALSE,$8,NOW(),NOW(),NOW()) RETURNING id`,
        [phone, name, email, ageVal, profession, pincode, b.source || 'Direct', b.paymentDate || null]);
      leadId = ins.rows[0].id;
      await logEvent(leadId, 'stage_changed', null, 'enrolled', actorOf(req));
    }

    const amount = Number(b.amount);
    if (Number.isFinite(amount) && amount > 0 && b.paymentDate) {
      let courseId = b.courseId ? parseInt(b.courseId, 10) : null;
      let productLabel = null;
      if (courseId) { const c = await pool.query(`SELECT name FROM coexistence.courses WHERE id=$1`, [courseId]); productLabel = c.rows[0]?.name || null; }
      if (courseId && productLabel) await pool.query(`UPDATE coexistence.leads SET paid_course = COALESCE(paid_course,$2) WHERE id=$1`, [leadId, productLabel]);
      await pool.query(
        `INSERT INTO coexistence.sales_log (lead_id, student_name, course_id, product_label, amount_paise, payment_date, funnel_source, notes, method, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [leadId, name, courseId, productLabel, Math.round(amount * 100), b.paymentDate, b.source || null, b.notes || null, b.method || null, actorOf(req)]);
    }
    await refreshPaidTotal(leadId);
    // Mirror the (now enrolled) stage onto their WhatsApp contact right away so
    // the tag is visible in Chats the moment the sale is logged. The lead_events
    // sweeper also covers this, but only when the stage actually CHANGED — a
    // second sale for an already-enrolled customer logs no event. Best-effort:
    // a tagging failure must never fail the sale.
    await funnelTags.syncLeadStageTag(leadId)
      .catch(err => console.error('[funnel-tags] add-sale sync failed:', err.message));
    emitLeadChanged({ leadId });
    res.status(201).json({ ok: true, leadId });
  } catch (err) {
    console.error('[leads] add sale error:', err.message);
    res.status(500).json({ error: 'Failed to add sale' });
  }
});

// Delete a sale = delete the underlying lead + its manual transactions, and
// DETACH (not delete) the gateway payments so the razorpay audit trail survives.
// Admin-only — this removes the customer from the funnel everywhere, not just here.
router.delete('/students/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can delete a sale' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid sale id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lr } = await client.query(`SELECT id FROM coexistence.leads WHERE id = $1 FOR UPDATE`, [id]);
    if (!lr.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sale not found' }); }
    // Manual transactions (sales_log FK is ON DELETE SET NULL — remove them outright).
    await client.query(`DELETE FROM coexistence.sales_log WHERE lead_id = $1`, [id]);
    // Gateway payments have no FK on matched_lead_id — detach so they don't dangle.
    await client.query(
      `UPDATE coexistence.razorpay_events SET matched_lead_id = NULL, matched_lead_name = NULL WHERE matched_lead_id = $1`, [id]);
    // Deleting the lead cascades lead_events / webinar_registrations; other refs SET NULL.
    await client.query(`DELETE FROM coexistence.leads WHERE id = $1`, [id]);
    await client.query('COMMIT');
    emitLeadChanged({ leadId: id, reason: 'sale_deleted' });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[leads] delete sale error:', err.message);
    res.status(500).json({ error: 'Failed to delete sale' });
  } finally {
    client.release();
  }
});

// ── lead sources (ranked channel quality) ─────────────────────────────────────
router.get('/lead-sources', async (req, res) => {
  try {
    const scope = leadScopeClause(req, 1);
    const params = isAdmin(req) ? [] : [meId(req)];
    const { rows } = await pool.query(
      `SELECT
          COALESCE(l.source, 'Unknown') AS source,
          COUNT(*)::int AS leads,
          COUNT(*) FILTER (WHERE l.stage IN ('hot','enrolled'))::int AS hot_count,
          COUNT(*) FILTER (WHERE l.stage = 'enrolled')::int AS enrolled_count
         FROM coexistence.leads l
        WHERE 1=1 ${scope}
        GROUP BY COALESCE(l.source, 'Unknown')
        ORDER BY leads DESC`,
      params
    );
    // Cost/lead joins campaigns spend by platform≈source (best-effort; manual now).
    const { rows: campRows } = await pool.query(
      `SELECT COALESCE(platform,'') AS platform, SUM(spend)::numeric AS spend, SUM(leads_generated)::int AS gen
         FROM coexistence.campaigns GROUP BY COALESCE(platform,'')`
    );
    const costByPlatform = {};
    for (const c of campRows) {
      if (c.gen > 0) costByPlatform[c.platform.toLowerCase()] = Number(c.spend) / c.gen;
    }
    const sources = rows.map(r => ({
      source: r.source,
      leads: r.leads,
      hotPct: r.leads ? Math.round((r.hot_count / r.leads) * 100) : 0,
      enrolledPct: r.leads ? Math.round((r.enrolled_count / r.leads) * 100) : 0,
      costPerLead: costByPlatform[String(r.source).toLowerCase()] || null,
      entryStage: 'new',
    }));
    res.json({ sources });
  } catch (err) {
    console.error('[leads] lead-sources error:', err.message);
    res.status(500).json({ error: 'Failed to load lead sources' });
  }
});

// ── CSV export ────────────────────────────────────────────────────────────────
router.get('/leads/export', async (req, res) => {
  try {
    const { clause, params } = buildLeadFilter(req);
    const { rows } = await pool.query(
      `${SELECT_LEAD} ${clause} ORDER BY l.id DESC LIMIT 5000`, params
    );
    const cols = ['name', 'whatsappNumber', 'email', 'city', 'role', 'source', 'goal', 'stage', 'followUpCount', 'assignedUserName', 'createdAt'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows.map(leadRow)) lines.push(cols.map(c => esc(r[c])).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[leads] export error:', err.message);
    res.status(500).json({ error: 'Failed to export leads' });
  }
});

// ── single lead ───────────────────────────────────────────────────────────────
router.get('/leads/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(`${SELECT_LEAD} WHERE l.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    if (!isAdmin(req) && Number(rows[0].assigned_user_id) !== meId(req)) {
      return res.status(403).json({ error: 'You can only view your own leads' });
    }
    res.json({ lead: leadRow(rows[0]) });
  } catch (err) {
    console.error('[leads] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// ── timeline ──────────────────────────────────────────────────────────────────
router.get('/leads/:id/timeline', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: ev } = await pool.query(
      `SELECT ts, event_type, from_value, to_value, actor
         FROM coexistence.lead_events WHERE lead_id = $1 ORDER BY ts DESC LIMIT 200`,
      [id]
    );
    const { rows: act } = await pool.query(
      `SELECT ts, bda, action, trigger_phrase, response_time_seconds, note
         FROM coexistence.bda_activity_log WHERE lead_id = $1 ORDER BY ts DESC LIMIT 200`,
      [id]
    );
    res.json({
      events: ev.map(e => ({
        ts: e.ts, eventType: e.event_type, fromValue: e.from_value, toValue: e.to_value, actor: e.actor,
      })),
      activity: act.map(a => ({
        ts: a.ts, bda: a.bda, action: a.action, triggerPhrase: a.trigger_phrase,
        responseTimeSeconds: a.response_time_seconds, note: a.note,
      })),
    });
  } catch (err) {
    console.error('[leads] timeline error:', err.message);
    res.status(500).json({ error: 'Failed to load timeline' });
  }
});

// ── create ────────────────────────────────────────────────────────────────────
router.post('/leads', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.whatsappNumber || !String(b.whatsappNumber).trim()) {
      return res.status(400).json({ error: 'WhatsApp number is required' });
    }
    const stage = cfg.isValidStage(b.stage) ? b.stage : defaultStageKey();
    const assignedUserId = isAdmin(req)
      ? (b.assignedUserId ? parseInt(b.assignedUserId, 10) : null)
      : meId(req);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.leads
         (name, whatsapp_number, email, city, role, source, goal, webinar_slot, referred_by,
          stage, assigned_bda, assigned_user_id, has_whatsapp_thread, custom_fields,
          stage_changed_at, last_activity_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW(),NOW(),NOW())
       RETURNING *`,
      [
        b.name || null, String(b.whatsappNumber).replace(/[^0-9]/g, ''), b.email || null,
        b.city || null, b.role || null, b.source || null, b.goal || null,
        b.webinarSlot || null, b.referredBy || null, stage,
        b.assignedBda || null, assignedUserId,
        !!b.hasWhatsappThread, b.customFields || {},
      ]
    );
    await logEvent(rows[0].id, 'stage_changed', null, stage, actorOf(req));
    emitLeadChanged({ leadId: Number(rows[0].id) });
    res.status(201).json({ lead: leadRow(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A lead with this WhatsApp number already exists' });
    console.error('[leads] create error:', err.message);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// ── update (dynamic SET) ──────────────────────────────────────────────────────
router.put('/leads/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessLead(req, id))) return res.status(403).json({ error: 'You can only edit your own leads' });
    const b = req.body || {};
    const map = {
      name: 'name', whatsappNumber: 'whatsapp_number', email: 'email', city: 'city', role: 'role', source: 'source',
      goal: 'goal', webinarSlot: 'webinar_slot', referredBy: 'referred_by',
      assignedBda: 'assigned_bda', paymentDate: 'payment_date', formStatus: 'form_status',
      zip: 'zip', state: 'state', batchAssigned: 'batch_assigned',
      profession: 'profession', pincode: 'pincode', paidCourse: 'paid_course',
    };
    const boolMap = { toolAccess: 'tool_access', batchGroupAdded: 'batch_group_added', prebatchReminderSent: 'prebatch_reminder_sent', hasWhatsappThread: 'has_whatsapp_thread' };
    const fields = [];
    const vals = [];
    let i = 1;
    if (b.whatsappNumber !== undefined && String(b.whatsappNumber).replace(/\D/g, '').length < 7) {
      return res.status(400).json({ error: 'A valid WhatsApp number is required' });
    }
    for (const [k, col] of Object.entries(map)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(b[k] === '' ? null : b[k]); }
    }
    for (const [k, col] of Object.entries(boolMap)) {
      if (b[k] !== undefined) { fields.push(`${col} = $${i++}`); vals.push(!!b[k]); }
    }
    if (b.age !== undefined) {
      const ageVal = b.age === '' || b.age === null ? null : parseInt(b.age, 10);
      fields.push(`age = $${i++}`); vals.push(Number.isFinite(ageVal) ? ageVal : null);
    }
    if (b.customFields !== undefined) { fields.push(`custom_fields = $${i++}`); vals.push(b.customFields || {}); }
    if (b.assignedUserId !== undefined && isAdmin(req)) {
      fields.push(`assigned_user_id = $${i++}`);
      vals.push(b.assignedUserId ? parseInt(b.assignedUserId, 10) : null);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push(`updated_at = NOW()`);
    vals.push(id);
    await pool.query(`UPDATE coexistence.leads SET ${fields.join(', ')} WHERE id = $${i}`, vals);
    const { rows } = await pool.query(`${SELECT_LEAD} WHERE l.id = $1`, [id]);
    emitLeadChanged({ leadId: id });
    res.json({ lead: leadRow(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another lead already uses this WhatsApp number' });
    console.error('[leads] update error:', err.message);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// ── move (change stage) ───────────────────────────────────────────────────────
router.put('/leads/:id/move', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canAccessLead(req, id))) return res.status(403).json({ error: 'You can only move your own leads' });
    const { stage } = req.body || {};
    if (!cfg.isValidStage(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const { rows: cur } = await pool.query(`SELECT stage FROM coexistence.leads WHERE id = $1`, [id]);
    if (!cur.length) return res.status(404).json({ error: 'Lead not found' });
    const from = cur[0].stage;
    const { rows } = await pool.query(
      `UPDATE coexistence.leads
          SET stage = $1, stage_changed_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [stage, id]
    );
    await logEvent(id, 'stage_changed', from, stage, actorOf(req));
    emitLeadChanged({ leadId: id });
    res.json({ lead: leadRow(rows[0]) });
  } catch (err) {
    console.error('[leads] move error:', err.message);
    res.status(500).json({ error: 'Failed to move lead' });
  }
});

// ── bulk assign ───────────────────────────────────────────────────────────────
router.post('/leads/bulk-assign', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can bulk-assign leads' });
  try {
    const { leadIds, assignedUserId, assignedBda } = req.body || {};
    if (!Array.isArray(leadIds) || !leadIds.length) return res.status(400).json({ error: 'leadIds is required' });
    const ids = leadIds.map(x => parseInt(x, 10)).filter(Number.isFinite);
    await pool.query(
      `UPDATE coexistence.leads
          SET assigned_user_id = $1, assigned_bda = COALESCE($2, assigned_bda), updated_at = NOW()
        WHERE id = ANY($3::bigint[])`,
      [assignedUserId ? parseInt(assignedUserId, 10) : null, assignedBda || null, ids]
    );
    emitLeadChanged({ bulk: true });
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    console.error('[leads] bulk-assign error:', err.message);
    res.status(500).json({ error: 'Failed to assign leads' });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function actorOf(req) { return req.user?.displayName || req.user?.username || 'system'; }

async function canAccessLead(req, id) {
  if (isAdmin(req)) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.leads WHERE id = $1 AND assigned_user_id = $2`, [id, meId(req)]
  );
  return rows.length > 0;
}

async function logEvent(leadId, type, from, to, actor) {
  try {
    await pool.query(
      `INSERT INTO coexistence.lead_events (lead_id, event_type, from_value, to_value, actor)
       VALUES ($1,$2,$3,$4,$5)`,
      [leadId, type, from == null ? null : String(from), to == null ? null : String(to), actor || null]
    );
  } catch (err) {
    console.error('[leads] logEvent error:', err.message);
  }
}

let _cfgCache = null;
let _cfgAt = 0;
async function loadAgentConfig() {
  if (_cfgCache && Date.now() - _cfgAt < 30000) return _cfgCache;
  const { rows } = await pool.query(`SELECT * FROM coexistence.agent_config WHERE id = 1`);
  _cfgCache = rows[0] || { stage_thresholds: { cold_after_follow_ups: 3 } };
  _cfgAt = Date.now();
  return _cfgCache;
}

// Advance the consecutive follow-up streak on an outbound with no reply since the
// last one; log a message_sent activity row; cold-drop once the streak crosses
// the configured threshold. Best-effort — callers wrap in try/catch so a logging
// failure never blocks message delivery.
async function recordOutbound(leadId, opts = {}) {
  if (!leadId) return;
  const agentCfg = await loadAgentConfig();
  const coldAfter = agentCfg.stage_thresholds?.cold_after_follow_ups ?? 3;
  // Only increment when there's been no inbound since the last outbound (a streak).
  const { rows } = await pool.query(
    `UPDATE coexistence.leads
        SET follow_up_count = CASE
              WHEN last_inbound_at IS NULL OR (last_outbound_at IS NOT NULL AND last_outbound_at > last_inbound_at)
              THEN follow_up_count + 1 ELSE 1 END,
            last_outbound_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING follow_up_count, stage`,
    [leadId]
  );
  if (!rows.length) return;
  await pool.query(
    `INSERT INTO coexistence.bda_activity_log (bda, lead_id, action, note)
     VALUES ($1,$2,'message_sent',$3)`,
    [opts.bda || null, leadId, opts.note || null]
  );
  await logEvent(leadId, 'message_sent', null, null, opts.bda || 'system');

  // Cold-drop: crossing the threshold moves the lead to cold_lost.
  if (rows[0].follow_up_count >= coldAfter && rows[0].stage !== 'cold_lost' && rows[0].stage !== 'enrolled') {
    const { rows: dropped } = await pool.query(
      `UPDATE coexistence.leads
          SET stage = 'cold_lost',
              stage_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND stage <> 'cold_lost' RETURNING id`,
      [leadId]
    );
    if (dropped.length) {
      await logEvent(leadId, 'stage_changed', rows[0].stage, 'cold_lost', 'auto:cold-drop');
      emitLeadChanged({ leadId });
    }
  }
}

// Reset the streak on any inbound reply.
async function recordInbound(leadId) {
  if (!leadId) return;
  await pool.query(
    `UPDATE coexistence.leads
        SET follow_up_count = 0, last_inbound_at = NOW(), last_activity_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [leadId]
  );
}

// Map Meta's CTWA `referral` object → a Funnel Source label (the real entry point
// that brought the customer to WhatsApp). No referral = a plain/direct message
// Meta didn't tag → 'Direct'. Labels are "<Platform> Ad" for paid click-to-WhatsApp
// ads and "<Platform>" for organic post CTAs; they become managed funnel_sources
// the admin can rename/merge in Funnel Settings.
function deriveLeadSource(referral) {
  if (!referral || typeof referral !== 'object') return 'Direct';
  const host = (String(referral.source_url || '').match(/:\/\/([^/]+)/) || [])[1] || '';
  let platform;
  if (/instagram\.com/i.test(host)) platform = 'Instagram';
  else if (/(fb\.me|facebook\.com|fb\.com)/i.test(host)) platform = 'Facebook';
  else if (/wa\.me|whatsapp/i.test(host)) platform = 'WhatsApp Link';
  else if (host) platform = 'Website';
  else platform = 'Meta';
  return referral.source_type === 'ad' ? `${platform} Ad` : platform;
}

// Bridge Chats → Leads: ensure a funnel lead exists for a WhatsApp customer.
// Called from the inbound webhook so every real conversation lands in the funnel.
// Idempotent (unique whatsapp_number): a NEW contact seeds a lead at the first
// configured stage; an EXISTING lead only gets its thread/activity timestamps
// refreshed — its stage / source / name are never clobbered. Best-effort; a
// failure here never blocks message delivery.
async function ensureLeadForContact({ contactNumber, name, source = 'Direct' } = {}) {
  const num = contactNumber == null ? '' : String(contactNumber).trim();
  if (!num) return null;
  try {
    const stage = defaultStageKey();
    const { rows } = await pool.query(
      `INSERT INTO coexistence.leads
         (whatsapp_number, name, source, stage, has_whatsapp_thread,
          stage_changed_at, last_inbound_at, last_activity_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,TRUE,NOW(),NOW(),NOW(),NOW(),NOW())
       ON CONFLICT (whatsapp_number) DO UPDATE
         SET has_whatsapp_thread = TRUE, last_inbound_at = NOW(),
             last_activity_at = NOW(), updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [num, name || null, source, stage]
    );
    const row = rows[0];
    if (row?.inserted) {
      await logEvent(row.id, 'stage_changed', null, stage, 'auto:whatsapp-inbound');
      emitLeadChanged({ leadId: row.id });
    }
    return row;
  } catch (err) {
    console.error('[leads] ensureLeadForContact error:', err.message);
    return null;
  }
}

// Which business number should a "open their chat" link land on? A customer can
// exist under several wa_numbers (the contacts PK is wa_number + contact_number);
// they are one human, so pick the most recently touched thread. Returns null when
// no chat exists, which is what makes the Sales Log render plain text instead of
// a dead link.
async function chatLinkFor(number) {
  const digits = String(number || '').replace(/[^0-9]/g, '');
  if (!digits) return { chatWaNumber: null, chatContactNumber: null };
  const { rows } = await pool.query(
    `SELECT wa_number, contact_number FROM coexistence.contacts
      WHERE regexp_replace(contact_number, '[^0-9]', '', 'g') = $1
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [digits]);
  return {
    chatWaNumber: rows[0]?.wa_number || null,
    chatContactNumber: rows[0]?.contact_number || null,
  };
}

// RZP_CAPTURED is exported so any other module aggregating razorpay_events uses
// the SAME payment_id dedupe (Razorpay writes several 'captured' rows per
// payment — summing them raw double-counts). See routes/ctwa.js.
module.exports = { router, recordOutbound, recordInbound, ensureLeadForContact, deriveLeadSource, RZP_CAPTURED };
