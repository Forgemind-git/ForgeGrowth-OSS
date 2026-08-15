const { Router } = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { effectivePages } = require('./permissions');

async function loadUserSession(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, display_name, role, permissions, is_active, last_login_at
       FROM coexistence.forgecrm_users WHERE id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  const { rows: waRows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isActive: u.is_active,
    permissions: u.permissions || null,
    pages: Array.from(effectivePages({ role: u.role, permissions: u.permissions })),
    assignedWaNumbers: waRows.map(r => r.wa_number),
  };
}

const { JWT_SECRET, cookieOptions } = require('./util/session');
const COOKIE_NAME = 'forgecrm_token';
const TOKEN_EXPIRY = '24h';

const router = Router();

// Ensure tables exist on startup
async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.forgecrm_users (
        id         BIGSERIAL PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        email      TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        display_name TEXT,
        role       TEXT NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Bootstrap the first admin when the user table is empty.
    //
    // ⚠ There is deliberately NO hardcoded default password. This project is
    // public, so a known credential like "admin/admin123" is a live vulnerability
    // on every deployment whose owner never got around to changing it — and it
    // is exactly what internet-wide scanners look for. Instead: take the
    // password from the environment, or generate a strong random one and print
    // it ONCE to the server log.
    const { rows } = await client.query('SELECT COUNT(*) FROM coexistence.forgecrm_users');
    if (parseInt(rows[0].count) === 0) {
      const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
      const supplied = process.env.BOOTSTRAP_ADMIN_PASSWORD;
      const password = supplied || require('crypto').randomBytes(15).toString('base64url');
      const hash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
         VALUES ('admin', $1, $2, 'Admin', 'admin')`,
        [email, hash]
      );
      if (supplied) {
        console.log(`[auth] Created the first admin: ${email} (password from BOOTSTRAP_ADMIN_PASSWORD)`);
      } else {
        console.log('\n' + '='.repeat(66));
        console.log('  FIRST-RUN ADMIN ACCOUNT CREATED');
        console.log(`  email:    ${email}`);
        console.log(`  password: ${password}`);
        console.log('  This is shown ONCE. Sign in and change it immediately.');
        console.log('  (Set BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD to choose your own.)');
        console.log('='.repeat(66) + '\n');
      }
    }
  } finally {
    client.release();
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.forgecrm_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }
    const token = signToken(user);
    res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: 24 * 60 * 60 * 1000 });
    // Best-effort: stamp last_login_at; don't fail login if this errors.
    pool.query(`UPDATE coexistence.forgecrm_users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
    const session = await loadUserSession(user.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const session = await loadUserSession(req.user.id);
    if (!session) {
      res.clearCookie(COOKIE_NAME, cookieOptions());
      return res.status(401).json({ error: 'User not found' });
    }
    if (session.isActive === false) {
      res.clearCookie(COOKIE_NAME, cookieOptions());
      return res.status(403).json({ error: 'Account disabled' });
    }
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ ok: true });
});

module.exports = { router, authMiddleware, ensureTables, COOKIE_NAME };
