// Admin-only user management.
//
//   GET    /users                 — list all users
//   POST   /users                 — create user (returns plaintext password if generated)
//   GET    /users/:id             — single user with WA assignments
//   PATCH  /users/:id             — update displayName / email / role / permissions / is_active / wa_numbers
//   DELETE /users/:id             — remove user (and CASCADE wa assignments)
//   POST   /users/:id/reset-password — set or generate new password, returns plaintext once

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { adminOnly, auditLog } = require('../middleware/access');
const { PAGES } = require('../permissions');
const roleConfig = require('../services/roleConfig');

const router = Router();


function shapeUser(row, waAssignments = []) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    permissions: row.permissions || null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    assignedWaNumbers: waAssignments,
  };
}

async function loadAssignments(userIds) {
  if (userIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, wa_number FROM coexistence.user_wa_assignments WHERE user_id = ANY($1::bigint[])`,
    [userIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.wa_number);
  }
  return map;
}

function generatePassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

// ⚠ Reads the TABLE, not the in-process cache. A cache is warm in the running
// app and empty everywhere else, so a cache-backed check silently accepts any
// string wherever it has not been loaded — and a user stored with a role that
// matches no row can log in and reach nothing.
async function validateRole(role) {
  if (!(await roleConfig.isAssignableRole(role))) {
    const names = roleConfig.activeRoles().map(r => r.key).join(', ');
    throw new Error(`Role must be one of: ${names || 'admin'}`);
  }
}

function validatePermissions(perms) {
  if (perms == null) return null;
  if (typeof perms !== 'object' || Array.isArray(perms)) {
    throw new Error('permissions must be an object with optional grant[] and revoke[] arrays');
  }
  const out = {};
  for (const k of ['grant', 'revoke']) {
    if (perms[k] == null) continue;
    if (!Array.isArray(perms[k])) throw new Error(`permissions.${k} must be an array`);
    const cleaned = perms[k].map(p => String(p)).filter(p => PAGES.includes(p));
    if (cleaned.length) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : null;
}

// ─── List ───────────────────────────────────────────────────────────
router.get('/users', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.forgecrm_users ORDER BY created_at`
    );
    const assignmentsMap = await loadAssignments(rows.map(r => r.id));
    res.json(rows.map(r => shapeUser(r, assignmentsMap.get(r.id) || [])));
  } catch (err) {
    console.error('[users] list error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/users/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.forgecrm_users WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const assignmentsMap = await loadAssignments([rows[0].id]);
    res.json(shapeUser(rows[0], assignmentsMap.get(rows[0].id) || []));
  } catch (err) {
    console.error('[users] get error:', err.message);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ─── Create ────────────────────────────────────────────────────────
router.post('/users', adminOnly, async (req, res) => {
  const { username, email, displayName, password, role = 'sales', permissions = null, assignedWaNumbers = [] } = req.body || {};
  try {
    if (!username?.trim() || !email?.trim() || !displayName?.trim()) {
      return res.status(400).json({ error: 'username, email and displayName are required' });
    }
    await validateRole(role);
    const cleanPerms = validatePermissions(permissions);
    const finalPassword = password?.trim() || generatePassword();
    const hash = await bcrypt.hash(finalPassword, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO coexistence.forgecrm_users
           (username, email, password, display_name, role, permissions, created_by)
         VALUES ($1, LOWER($2), $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          username.trim(),
          email.trim(),
          hash,
          displayName.trim(),
          role,
          cleanPerms ? JSON.stringify(cleanPerms) : null,
          req.user.id,
        ]
      );
      const user = rows[0];

      // Set WA assignments (only meaningful for a non-admin role; we don't enforce that —
      // admin override is technically allowed and gets ignored at query time)
      const waList = Array.isArray(assignedWaNumbers) ? assignedWaNumbers : [];
      for (const wa of waList) {
        const clean = String(wa).replace(/\D/g, '');
        if (!clean) continue;
        await client.query(
          `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, wa_number) DO NOTHING`,
          [user.id, clean, req.user.id]
        );
      }

      await client.query('COMMIT');
      await auditLog({
        actor: req.user, action: 'user.create',
        targetType: 'user', targetId: user.id,
        payload: { username: user.username, role: user.role, waNumbers: waList },
      });

      // Return shape includes the one-time plaintext password so the UI can show it
      const assignments = await loadAssignments([user.id]);
      const shape = shapeUser(user, assignments.get(user.id) || []);
      res.status(201).json({ ...shape, generatedPassword: password ? null : finalPassword, password: finalPassword });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] create error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    res.status(400).json({ error: err.message || 'Failed to create user' });
  }
});

// ─── Update ────────────────────────────────────────────────────────
router.patch('/users/:id', adminOnly, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM coexistence.forgecrm_users WHERE id = $1`, [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existing[0];

    // Prevent admins from demoting / deactivating themselves to lock everyone out
    if (String(req.user.id) === String(id)) {
      if (req.body.role && req.body.role !== before.role) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      if (req.body.isActive === false) {
        return res.status(400).json({ error: 'You cannot deactivate yourself' });
      }
    }

    const fields = [];
    const params = [];
    let idx = 1;
    const set = (sqlFragment, val) => {
      // sqlFragment looks like "display_name = $$" — we substitute $$ with $<idx>
      fields.push(sqlFragment.replace('$$', `$${idx++}`));
      params.push(val);
    };

    if (req.body.displayName != null) set('display_name = $$', String(req.body.displayName).trim());
    if (req.body.email != null) set('email = $$', String(req.body.email).trim().toLowerCase());
    if (req.body.role != null) {
      await validateRole(req.body.role);
      set('role = $$', req.body.role);
    }
    if (req.body.permissions !== undefined) {
      const cleanPerms = validatePermissions(req.body.permissions);
      set('permissions = $$::jsonb', cleanPerms ? JSON.stringify(cleanPerms) : null);
    }
    if (req.body.isActive != null) set('is_active = $$', !!req.body.isActive);
    fields.push(`updated_at = NOW()`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updated = before;
      if (params.length > 0) {
        params.push(id);
        const sql = `UPDATE coexistence.forgecrm_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
        const result = await client.query(sql, params);
        updated = result.rows[0];
      }

      // Replace wa assignments if provided
      if (Array.isArray(req.body.assignedWaNumbers)) {
        await client.query(`DELETE FROM coexistence.user_wa_assignments WHERE user_id = $1`, [id]);
        for (const wa of req.body.assignedWaNumbers) {
          const clean = String(wa).replace(/\D/g, '');
          if (!clean) continue;
          await client.query(
            `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, wa_number) DO NOTHING`,
            [id, clean, req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      // Build a diff for the audit log
      const changes = {};
      ['display_name', 'email', 'role', 'is_active', 'permissions'].forEach(k => {
        if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) {
          changes[k] = { from: before[k], to: updated[k] };
        }
      });
      if (Array.isArray(req.body.assignedWaNumbers)) changes.assignedWaNumbers = req.body.assignedWaNumbers;
      await auditLog({
        actor: req.user,
        action: changes.role ? 'user.role_change' : 'user.update',
        targetType: 'user', targetId: id, payload: changes,
      });

      const assignmentsMap = await loadAssignments([id]);
      res.json(shapeUser(updated, assignmentsMap.get(Number(id)) || []));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] update error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    res.status(400).json({ error: err.message || 'Failed to update user' });
  }
});

// ─── Reset password (admin-only, plaintext-once display) ──────────
router.post('/users/:id/reset-password', adminOnly, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, username FROM coexistence.forgecrm_users WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });

    const password = req.body?.password?.trim() || generatePassword();
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE coexistence.forgecrm_users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hash, id]
    );
    await auditLog({
      actor: req.user, action: 'user.password_reset',
      targetType: 'user', targetId: id, payload: { byAdmin: req.user.username },
    });
    res.json({ password, generated: !req.body?.password });
  } catch (err) {
    console.error('[users] reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Delete ───────────────────────────────────────────────────────
router.delete('/users/:id', adminOnly, async (req, res) => {
  const id = req.params.id;
  try {
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const { rows: existing } = await pool.query(
      `SELECT username, role FROM coexistence.forgecrm_users WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE id = $1`, [id]);
    await auditLog({
      actor: req.user, action: 'user.delete',
      targetType: 'user', targetId: id, payload: existing[0],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── Audit log (paginated) ────────────────────────────────────────
router.get('/audit-log', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 50, 10), 200);
    const offset = Math.max(parseInt(req.query.offset || 0, 10), 0);
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.user_audit_log`);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id AS "actorUserId", actor_username AS "actorUsername",
              action, target_type AS "targetType", target_id AS "targetId",
              payload, created_at AS "createdAt"
         FROM coexistence.user_audit_log
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ total: countRows[0].total, limit, offset, items: rows });
  } catch (err) {
    console.error('[users] audit-log error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

/* ── Roles ────────────────────────────────────────────────────────────────
 * Managed in the same screen as the users who hold them, because "what can
 * this role do" and "who has it" are one question.
 *
 * ⚠ THE ADMIN ROW IS PROTECTED IN THREE WAYS, all for the same reason: this
 * screen is itself admin-gated, so anything that could strip admin access
 * could lock every user out of the only place that could undo it.
 *   • cannot be deleted or deactivated
 *   • its page list cannot be edited (isAdmin short-circuits it anyway)
 *   • only its label is writable
 */

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;

router.get('/roles', async (req, res) => {
  try {
    // Non-admins get the labels only — a role picker needs them, the page
    // lists are an admin concern.
    const admin = req.user?.role === 'admin';
    const roles = roleConfig.roles().map(r => admin ? r : { key: r.key, label: r.label, active: r.active });
    res.json({ roles, pages: admin ? PAGES : undefined });
  } catch (err) {
    console.error('[users] list roles error:', err.message);
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

router.post('/roles', adminOnly, async (req, res) => {
  try {
    const key = String(req.body?.key || '').trim().toLowerCase();
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'A role needs a name.' });
    if (!ROLE_KEY_RE.test(key)) {
      return res.status(400).json({
        error: 'The role id must be lowercase letters, numbers and underscores, starting with a letter (e.g. "support_lead").',
      });
    }
    const pages = sanitizeRolePages(req.body?.pages);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.user_roles (role_key, label, description, pages, sort_order)
       VALUES ($1,$2,$3,$4::jsonb, COALESCE((SELECT MAX(sort_order)+1 FROM coexistence.user_roles), 1))
       ON CONFLICT (role_key) DO NOTHING
       RETURNING role_key`,
      [key, label, String(req.body?.description || '').trim() || null, JSON.stringify(pages)],
    );
    if (!rows.length) return res.status(409).json({ error: `A role with the id "${key}" already exists.` });
    await roleConfig.refreshRoles();
    res.status(201).json({ ok: true, key });
  } catch (err) {
    console.error('[users] create role error:', err.message);
    res.status(500).json({ error: 'Failed to create the role' });
  }
});

router.put('/roles/:key', adminOnly, async (req, res) => {
  try {
    const key = String(req.params.key);
    const existing = roleConfig.roleByKey(key);
    if (!existing) return res.status(404).json({ error: 'Role not found' });

    const sets = [];
    const params = [];
    const set = (frag, val) => { params.push(val); sets.push(frag.replace('$$', `$${params.length}`)); };

    if (req.body?.label != null) {
      const label = String(req.body.label).trim();
      if (!label) return res.status(400).json({ error: 'A role needs a name.' });
      set('label = $$', label);
    }
    if (req.body?.description != null) set('description = $$', String(req.body.description).trim() || null);

    if (existing.isSystem) {
      // Relabelling Admin is fine. Anything that could reduce its reach is not.
      if (req.body?.pages != null || req.body?.active != null) {
        return res.status(400).json({
          error: 'The Admin role always has full access and cannot be switched off — otherwise nobody could reach these settings to switch it back on. You can rename it.',
        });
      }
    } else {
      if (req.body?.pages != null) set('pages = $$::jsonb', JSON.stringify(sanitizeRolePages(req.body.pages)));
      if (req.body?.active != null) set('active = $$', req.body.active === true || req.body.active === 'true');
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(key);
    await pool.query(
      `UPDATE coexistence.user_roles SET ${sets.join(', ')}, updated_at = NOW() WHERE role_key = $${params.length}`,
      params,
    );
    await roleConfig.refreshRoles();
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] update role error:', err.message);
    res.status(500).json({ error: 'Failed to update the role' });
  }
});

router.delete('/roles/:key', adminOnly, async (req, res) => {
  try {
    const key = String(req.params.key);
    const existing = roleConfig.roleByKey(key);
    if (!existing) return res.status(404).json({ error: 'Role not found' });
    if (existing.isSystem) {
      return res.status(400).json({ error: 'The Admin role cannot be deleted.' });
    }
    // Refuse rather than orphan. A user left holding a deleted role resolves to
    // no pages at all: they log in successfully and land on an empty app, which
    // reads as a broken account rather than a removed role.
    const { rows: held } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.forgecrm_users WHERE role = $1`, [key]);
    if (held[0].n > 0) {
      return res.status(409).json({
        error: `${held[0].n} user${held[0].n === 1 ? ' still has' : 's still have'} the "${existing.label}" role. Move them to another role first.`,
      });
    }
    await pool.query(`DELETE FROM coexistence.user_roles WHERE role_key = $1`, [key]);
    await roleConfig.refreshRoles();
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] delete role error:', err.message);
    res.status(500).json({ error: 'Failed to delete the role' });
  }
});

// Only real page keys are storable — an unknown string would sit in the list
// looking granted and match no page.
function sanitizeRolePages(pages) {
  if (!Array.isArray(pages)) return [];
  const valid = new Set(PAGES);
  return [...new Set(pages.map(String).filter(p => valid.has(p)))];
}

module.exports = { router };
