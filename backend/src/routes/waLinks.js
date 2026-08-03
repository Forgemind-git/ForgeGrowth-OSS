// WhatsApp click-to-chat link generator — admin CRUD + public redirect
const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');

const router = Router();
const publicRouter = Router();

function normalizePhone(str) {
  return (str || '').replace(/\D/g, '');
}

function generateSlug() {
  return crypto.randomBytes(4).toString('hex');
}

function rowToLink(r) {
  return {
    id: Number(r.id),
    name: r.name,
    message: r.message,
    phoneNumber: r.phone_number,
    slug: r.slug,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/wa-links — list all (auth required via index.js mount)
router.get('/wa-links', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, message, phone_number, slug, created_at, updated_at
         FROM coexistence.wa_links
        ORDER BY created_at DESC`
    );
    res.json({ links: rows.map(rowToLink) });
  } catch (err) {
    console.error('[wa-links] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// POST /api/wa-links — create (auth)
router.post('/wa-links', async (req, res) => {
  try {
    const { name, message, accountId } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!accountId) {
      return res.status(400).json({ error: 'WhatsApp account is required' });
    }

    // Resolve account phone number
    const { rows: accRows } = await pool.query(
      `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE id = $1`,
      [accountId]
    );
    if (!accRows.length) {
      return res.status(400).json({ error: 'WhatsApp account not found' });
    }
    const phoneNumber = normalizePhone(accRows[0].display_phone_number);
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Account has no valid phone number' });
    }

    // Generate unique slug
    let slug = generateSlug();
    let attempts = 0;
    while (attempts < 3) {
      const { rows: dup } = await pool.query(
        `SELECT 1 FROM coexistence.wa_links WHERE slug = $1`,
        [slug]
      );
      if (!dup.length) break;
      slug = generateSlug();
      attempts++;
    }

    const { rows } = await pool.query(
      `INSERT INTO coexistence.wa_links (name, message, phone_number, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [name.trim(), message ? message.trim() : null, phoneNumber, slug]
    );
    res.status(201).json({ link: rowToLink(rows[0]) });
  } catch (err) {
    console.error('[wa-links] create error:', err.message);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// PUT /api/wa-links/:id — edit name/message only (auth)
router.put('/wa-links/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, message } = req.body || {};
    const fields = [];
    const vals = [];
    let i = 1;

    if (name !== undefined) {
      fields.push(`name = $${i++}`);
      vals.push(name ? name.trim() : null);
    }
    if (message !== undefined) {
      fields.push(`message = $${i++}`);
      vals.push(message ? message.trim() : null);
    }
    if (!fields.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    fields.push(`updated_at = NOW()`);
    vals.push(id);

    const { rows } = await pool.query(
      `UPDATE coexistence.wa_links SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Link not found' });
    res.json({ link: rowToLink(rows[0]) });
  } catch (err) {
    console.error('[wa-links] update error:', err.message);
    res.status(500).json({ error: 'Failed to update link' });
  }
});

// DELETE /api/wa-links/:id (auth)
router.delete('/wa-links/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.wa_links WHERE id = $1`,
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Link not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[wa-links] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// GET /l/:slug — PUBLIC redirect to WhatsApp click-to-chat
publicRouter.get('/l/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const { rows } = await pool.query(
      `SELECT phone_number, message FROM coexistence.wa_links WHERE slug = $1`,
      [slug]
    );
    if (!rows.length) return res.status(404).send('Link not found');

    const phone = normalizePhone(rows[0].phone_number);
    const msg = rows[0].message || '';
    const waUrl = `https://wa.me/${phone}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
    return res.redirect(302, waUrl);
  } catch (err) {
    console.error('[wa-links] redirect error:', err.message);
    res.status(500).send('Something went wrong');
  }
});

module.exports = { router, publicRouter };
