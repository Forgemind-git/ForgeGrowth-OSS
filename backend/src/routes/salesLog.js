// Sales Log (migration 064). A manual log of paid / converted leads. Product =
// the existing courses registry. Mounted under /api with authMiddleware.
//
// Amounts are stored in PAISE (consistent with razorpay/payment_links) and
// converted ₹↔paise at THIS boundary — callers send/receive rupees.
//
// Endpoints:
//   GET    /sales-log            list + filter (courseId, source, from, to) + sort
//   GET    /sales-log/summary    KPIs: total sales, total revenue, units-by-product
//   POST   /sales-log            create (amount in ₹)
//   PUT    /sales-log/:id        update
//   DELETE /sales-log/:id        delete
//
// RBAC: non-admins see only rows whose linked lead is assigned to them.

const { Router } = require('express');
const pool = require('../db');

const router = Router();

// Self-healing table bootstrap (mirror of migration 064). courses must exist
// first (ensureCourseTables) for the FK.
async function ensureSalesLogTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.sales_log (
      id            BIGSERIAL PRIMARY KEY,
      lead_id       BIGINT REFERENCES coexistence.leads(id)   ON DELETE SET NULL,
      student_name  TEXT NOT NULL,
      course_id     BIGINT REFERENCES coexistence.courses(id) ON DELETE SET NULL,
      product_label TEXT,
      amount_paise  BIGINT NOT NULL DEFAULT 0,
      payment_date  DATE NOT NULL,
      funnel_source TEXT,
      notes         TEXT,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Payment method on a manual transaction (migration 065) — Razorpay rows carry
  // their real method; manual rows record how the customer paid (Cash / UPI / …).
  await pool.query(`ALTER TABLE coexistence.sales_log ADD COLUMN IF NOT EXISTS method TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_log_date   ON coexistence.sales_log(payment_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_log_course ON coexistence.sales_log(course_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_log_lead   ON coexistence.sales_log(lead_id);`);
}

const isAdmin = (req) => req.user?.role === 'admin';
const meId = (req) => parseInt(req.user?.id, 10);
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;
const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);

function salesRow(r) {
  return {
    id: Number(r.id),
    leadId: r.lead_id == null ? null : Number(r.lead_id),
    studentName: r.student_name,
    courseId: r.course_id == null ? null : Number(r.course_id),
    productLabel: r.product_label || r.course_name || null,
    amount: toRupees(r.amount_paise),
    paymentDate: r.payment_date,
    funnelSource: r.funnel_source,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// Non-admins: only sales tied to a lead assigned to them.
function scopeClause(req, params) {
  if (isAdmin(req)) return '';
  params.push(meId(req));
  return `AND s.lead_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM coexistence.leads l WHERE l.id = s.lead_id AND l.assigned_user_id = $${params.length})`;
}

// ── list ──────────────────────────────────────────────────────────────────────
router.get('/sales-log', async (req, res) => {
  try {
    const { courseId, source, from, to } = req.query;
    const sort = ['payment_date', 'amount_paise', 'student_name', 'created_at'].includes(req.query.sort)
      ? req.query.sort : 'payment_date';
    const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const params = [];
    const where = ['1=1'];
    if (courseId) { params.push(parseInt(courseId, 10)); where.push(`s.course_id = $${params.length}`); }
    if (source) { params.push(source); where.push(`s.funnel_source = $${params.length}`); }
    if (from) { params.push(from); where.push(`s.payment_date >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`s.payment_date <= $${params.length}::date`); }
    const scope = scopeClause(req, params);
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS course_name
         FROM coexistence.sales_log s
         LEFT JOIN coexistence.courses c ON c.id = s.course_id
        WHERE ${where.join(' AND ')} ${scope}
        ORDER BY s.${sort} ${dir}, s.id DESC`,
      params
    );
    res.json({ sales: rows.map(salesRow) });
  } catch (err) {
    console.error('[salesLog] list error:', err.message);
    res.status(500).json({ error: 'Failed to load sales log' });
  }
});

// ── summary KPIs ──────────────────────────────────────────────────────────────
router.get('/sales-log/summary', async (req, res) => {
  try {
    const { from, to, source } = req.query;
    const params = [];
    const where = ['1=1'];
    if (from) { params.push(from); where.push(`s.payment_date >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`s.payment_date <= $${params.length}::date`); }
    if (source) { params.push(source); where.push(`s.funnel_source = $${params.length}`); }
    const scope = scopeClause(req, params);
    const base = `FROM coexistence.sales_log s WHERE ${where.join(' AND ')} ${scope}`;

    const { rows: tot } = await pool.query(
      `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(s.amount_paise),0)::bigint AS revenue_paise ${base}`, params);
    const { rows: byProduct } = await pool.query(
      `SELECT COALESCE(c.name, s.product_label, 'Unassigned') AS product,
              COUNT(*)::int AS units, COALESCE(SUM(s.amount_paise),0)::bigint AS revenue_paise
         FROM coexistence.sales_log s
         LEFT JOIN coexistence.courses c ON c.id = s.course_id
        WHERE ${where.join(' AND ')} ${scope}
        GROUP BY COALESCE(c.name, s.product_label, 'Unassigned')
        ORDER BY revenue_paise DESC`, params);

    res.json({
      totalSales: tot[0].total_sales,
      totalRevenue: toRupees(tot[0].revenue_paise),
      byProduct: byProduct.map(r => ({ product: r.product, units: r.units, revenue: toRupees(r.revenue_paise) })),
    });
  } catch (err) {
    console.error('[salesLog] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load sales summary' });
  }
});

// ── create ────────────────────────────────────────────────────────────────────
router.post('/sales-log', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.studentName || !String(b.studentName).trim()) return res.status(400).json({ error: 'Student/client name is required' });
    if (!b.paymentDate) return res.status(400).json({ error: 'Date of payment is required' });

    // Snapshot the product label + source at write time.
    let productLabel = b.productLabel || null;
    if (b.courseId) {
      const { rows } = await pool.query(`SELECT name FROM coexistence.courses WHERE id = $1`, [parseInt(b.courseId, 10)]);
      if (rows.length) productLabel = rows[0].name;
    }
    let funnelSource = b.funnelSource || null;
    if (!funnelSource && b.leadId) {
      const { rows } = await pool.query(`SELECT source FROM coexistence.leads WHERE id = $1`, [parseInt(b.leadId, 10)]);
      if (rows.length) funnelSource = rows[0].source;
    }

    const { rows } = await pool.query(
      `INSERT INTO coexistence.sales_log
         (lead_id, student_name, course_id, product_label, amount_paise, payment_date, funnel_source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        b.leadId ? parseInt(b.leadId, 10) : null,
        String(b.studentName).trim(),
        b.courseId ? parseInt(b.courseId, 10) : null,
        productLabel,
        toPaise(b.amount),
        b.paymentDate,
        funnelSource,
        b.notes || null,
        req.user?.displayName || req.user?.username || null,
      ]
    );
    const { rows: full } = await pool.query(
      `SELECT s.*, c.name AS course_name FROM coexistence.sales_log s
       LEFT JOIN coexistence.courses c ON c.id = s.course_id WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json({ sale: salesRow(full[0]) });
  } catch (err) {
    console.error('[salesLog] create error:', err.message);
    res.status(500).json({ error: 'Failed to create sale' });
  }
});

// ── update ────────────────────────────────────────────────────────────────────
router.put('/sales-log/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.studentName !== undefined) {
      if (!String(b.studentName).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      vals.push(String(b.studentName).trim()); sets.push(`student_name = $${vals.length}`);
    }
    if (b.courseId !== undefined) {
      const cid = b.courseId ? parseInt(b.courseId, 10) : null;
      vals.push(cid); sets.push(`course_id = $${vals.length}`);
      let label = b.productLabel || null;
      if (cid) { const { rows } = await pool.query(`SELECT name FROM coexistence.courses WHERE id = $1`, [cid]); if (rows.length) label = rows[0].name; }
      vals.push(label); sets.push(`product_label = $${vals.length}`);
    }
    if (b.amount !== undefined) { vals.push(toPaise(b.amount)); sets.push(`amount_paise = $${vals.length}`); }
    if (b.paymentDate !== undefined) { vals.push(b.paymentDate); sets.push(`payment_date = $${vals.length}`); }
    if (b.funnelSource !== undefined) { vals.push(b.funnelSource || null); sets.push(`funnel_source = $${vals.length}`); }
    if (b.notes !== undefined) { vals.push(b.notes || null); sets.push(`notes = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    const { rowCount } = await pool.query(
      `UPDATE coexistence.sales_log SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Sale not found' });
    const { rows: full } = await pool.query(
      `SELECT s.*, c.name AS course_name FROM coexistence.sales_log s
       LEFT JOIN coexistence.courses c ON c.id = s.course_id WHERE s.id = $1`, [id]);
    res.json({ sale: salesRow(full[0]) });
  } catch (err) {
    console.error('[salesLog] update error:', err.message);
    res.status(500).json({ error: 'Failed to update sale' });
  }
});

// ── delete ────────────────────────────────────────────────────────────────────
router.delete('/sales-log/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(`DELETE FROM coexistence.sales_log WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Sale not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[salesLog] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete sale' });
  }
});

module.exports = { router, ensureSalesLogTables };
