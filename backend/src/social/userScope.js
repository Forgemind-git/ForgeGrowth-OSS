// /api/me/scope — each user's "My accounts" preset: the platforms + Instagram
// accounts every page opens with (Overview, Inbox, Contacts, Content Library,
// Automations, Comment Analyzer). Tokens: 'instagram|<ig account id>' for
// Instagram (multi-account) and the bare platform key ('facebook', 'youtube',
// 'threads', 'linkedin') for the single-account platforms. Empty = everything.
const express = require('express');
const pool = require('./db');

const PLATFORMS = ['instagram', 'facebook', 'youtube', 'threads', 'linkedin'];
const key = (userId) => `user_scope:${userId}`;
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key(req.user.id)]);
    let tokens = [];
    try { tokens = JSON.parse(rows[0]?.value || '[]'); } catch (_) {}
    res.json({ tokens: Array.isArray(tokens) ? tokens : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/', async (req, res) => {
  try {
    const tokens = [...new Set((Array.isArray(req.body?.tokens) ? req.body.tokens : []).map(String)
      .filter(t => PLATFORMS.includes(t.split('|')[0])))].slice(0, 100);
    if (!tokens.length) await pool.query('DELETE FROM app_settings WHERE key = $1', [key(req.user.id)]);
    else await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key(req.user.id), JSON.stringify(tokens)]);
    res.json({ tokens });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
