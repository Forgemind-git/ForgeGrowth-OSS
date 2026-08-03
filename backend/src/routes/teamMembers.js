const { Router } = require('express');
const pool = require('../db');

const router = Router();

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// GET /api/team-members
// Returns both manually created team members AND WhatsApp numbers active in chat
router.get('/team-members', async (req, res) => {
  try {
    // Get manually created team members
    const { rows: manualMembers } = await pool.query(
      `SELECT id, name, phone_number, bda_id, address, email, profile_picture_url,
              role, whatsapp_agent_id, active, created_at, updated_at, FALSE as is_chat_bda
       FROM coexistence.team_members
       ORDER BY name ASC`
    );

    // Get WhatsApp business numbers active in chat (last 30 days)
    const { rows: chatNumbers } = await pool.query(
      `SELECT DISTINCT wa_number
       FROM coexistence.chat_history
       WHERE timestamp >= NOW() - INTERVAL '30 days'
       ORDER BY wa_number ASC`
    );

    // Enrich chat numbers with display name from contacts if available
    const chatBDAs = await Promise.all(chatNumbers.map(async (row) => {
      // Check if this wa_number already exists as a manual team member (by phone_number)
      const existing = manualMembers.find(m =>
        m.phone_number === row.wa_number ||
        m.phone_number === `+${row.wa_number}` ||
        m.phone_number?.replace(/\D/g, '') === row.wa_number.replace(/\D/g, '')
      );
      if (existing) return null; // Skip, already shown

      // Try to get display name from contacts table
      const nameRes = await pool.query(
        'SELECT name FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $1 LIMIT 1',
        [row.wa_number]
      );
      const displayName = nameRes.rows[0]?.name || `+${row.wa_number}`;

      return {
        id: `wa-${row.wa_number}`,
        name: displayName,
        phone_number: `+${row.wa_number}`,
        bda_id: null,
        address: null,
        email: null,
        profile_picture_url: null,
        role: null,
        whatsapp_agent_id: null,
        active: true,
        created_at: null,
        updated_at: null,
        is_chat_bda: true,
      };
    }));

    const merged = [
      ...manualMembers,
      ...chatBDAs.filter(Boolean),
    ];

    res.json(merged);
  } catch (err) {
    console.error('[teamMembers] GET /team-members error:', err.message);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// POST /api/team-members
router.post('/team-members', async (req, res) => {
  try {
    const { name, phone_number, bda_id, address, email, profile_picture_url, role, whatsapp_agent_id, active } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const id = genId('bda');
    const { rows } = await pool.query(
      `INSERT INTO coexistence.team_members (id, name, phone_number, bda_id, address, email, profile_picture_url, role, whatsapp_agent_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, name, phone_number, bda_id, address, email, profile_picture_url, role, whatsapp_agent_id, active, created_at, updated_at`,
      [id, name.trim(), phone_number || null, bda_id || null, address || null, email || null, profile_picture_url || null,
       role || null, whatsapp_agent_id || null, active === undefined ? true : !!active]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[teamMembers] POST /team-members error:', err.message);
    if (err.message.includes('unique constraint') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Team Member ID already exists' });
    }
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

// PUT /api/team-members/:id
router.put('/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone_number, bda_id, address, email, profile_picture_url, role, whatsapp_agent_id, active } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.team_members
       SET name = $1, phone_number = $2, bda_id = $3, address = $4, email = $5, profile_picture_url = $6,
           role = $7, whatsapp_agent_id = $8, active = COALESCE($9, active), updated_at = NOW()
       WHERE id = $10
       RETURNING id, name, phone_number, bda_id, address, email, profile_picture_url, role, whatsapp_agent_id, active, created_at, updated_at`,
      [name.trim(), phone_number || null, bda_id || null, address || null, email || null, profile_picture_url || null,
       role || null, whatsapp_agent_id || null, active === undefined ? null : !!active, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Team member not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[teamMembers] PUT /team-members/:id error:', err.message);
    if (err.message.includes('unique constraint') || err.message.includes('duplicate')) {
      return res.status(409).json({ error: 'Team Member ID already exists' });
    }
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// DELETE /api/team-members/:id
router.delete('/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Don't allow deleting chat-derived team members (they're virtual)
    if (id.startsWith('wa-')) {
      return res.status(400).json({ error: 'Cannot delete a chat-derived team member. Add them as a manual team member first.' });
    }
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.team_members WHERE id = $1',
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Team member not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[teamMembers] DELETE /team-members/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

module.exports = { router };
