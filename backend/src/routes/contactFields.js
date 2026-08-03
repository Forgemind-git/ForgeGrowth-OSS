const { Router } = require('express');
const pool = require('../db');

const router = Router();

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// GET /api/contact-fields
router.get('/contact-fields', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, field_type, sort_order, created_at, updated_at
       FROM coexistence.contact_field_definitions
       ORDER BY sort_order ASC, name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[contactFields] GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact fields' });
  }
});

// POST /api/contact-fields
router.post('/contact-fields', async (req, res) => {
  try {
    const { name, description, field_type, sort_order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!field_type) {
      return res.status(400).json({ error: 'Field type is required' });
    }
    const validTypes = ['text', 'number', 'phone', 'email', 'date', 'url', 'textarea'];
    if (!validTypes.includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field type' });
    }
    const id = genId('fld');
    const { rows } = await pool.query(
      `INSERT INTO coexistence.contact_field_definitions (id, name, description, field_type, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, field_type, sort_order, created_at, updated_at`,
      [id, name.trim(), (description || '').trim(), field_type, parseInt(sort_order, 10) || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[contactFields] POST error:', err.message);
    res.status(500).json({ error: 'Failed to create contact field' });
  }
});

// PUT /api/contact-fields/:id
router.put('/contact-fields/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, field_type, sort_order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!field_type) {
      return res.status(400).json({ error: 'Field type is required' });
    }
    const validTypes = ['text', 'number', 'phone', 'email', 'date', 'url', 'textarea'];
    if (!validTypes.includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field type' });
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.contact_field_definitions
       SET name = $1, description = $2, field_type = $3, sort_order = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, description, field_type, sort_order, created_at, updated_at`,
      [name.trim(), (description || '').trim(), field_type, parseInt(sort_order, 10) || 0, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Field not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[contactFields] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to update contact field' });
  }
});

// DELETE /api/contact-fields/:id
router.delete('/contact-fields/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.contact_field_definitions WHERE id = $1',
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Field not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[contactFields] DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete contact field' });
  }
});

module.exports = { router };
