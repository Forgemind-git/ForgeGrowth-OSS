// /api/me/scope — each user's "My accounts" preset: the platforms + Instagram
// accounts every page opens with (Overview, Inbox, Contacts, Content Library,
// Automations, Comment Analyzer). Tokens: 'instagram|<ig account id>' per
// account, or the bare 'instagram' for every account. Empty = everything.
const express = require('express');
const pool = require('./db');

const PLATFORMS = ['instagram'];
const known = (t) => PLATFORMS.includes(String(t).split('|')[0]);
const key = (userId) => `user_scope:${userId}`;
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key(req.user.id)]);
    let tokens = [];
    try { tokens = JSON.parse(rows[0]?.value || '[]'); } catch (_) {}
    // A token for a removed platform no longer matches anything — drop it.
    res.json({ tokens: Array.isArray(tokens) ? tokens.filter(known) : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/', async (req, res) => {
  try {
    const tokens = [...new Set((Array.isArray(req.body?.tokens) ? req.body.tokens : []).map(String)
      .filter(known))].slice(0, 100);
    if (!tokens.length) await pool.query('DELETE FROM app_settings WHERE key = $1', [key(req.user.id)]);
    else await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key(req.user.id), JSON.stringify(tokens)]);
    res.json({ tokens });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
