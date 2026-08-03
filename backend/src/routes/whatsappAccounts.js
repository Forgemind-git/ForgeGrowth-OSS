const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');

const router = Router();

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function publicShape(row, { reveal = false } = {}) {
  if (!row) return null;
  const token = decrypt(row.access_token_encrypted);
  return {
    id: row.id,
    displayName: row.display_name,
    displayPhoneNumber: row.display_phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    metaAppId: row.meta_app_id,
    accessTokenMasked: maskSecret(token),
    accessToken: reveal ? token : undefined,
    verifyToken: row.verify_token_encrypted ? decrypt(row.verify_token_encrypted) : '',
    isDefault: row.is_default,
    isActive: row.is_active,
    healthStatus: row.health_status || 'unknown',
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// List all accounts (any authenticated user — needed for template/broadcast pickers)
router.get('/whatsapp-accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE ($1::boolean IS NULL OR is_active = $1)
        ORDER BY is_default DESC, display_name ASC`,
      [req.query.activeOnly === 'true' ? true : null]
    );
    res.json(rows.map(r => publicShape(r)));
  } catch (err) {
    console.error('[whatsapp-accounts] list error:', err.message);
    res.status(500).json({ error: 'Failed to list WhatsApp accounts' });
  }
});

// Account send-health from Meta (must be registered before :id so it doesn't match :id=health).
// Meta accepts a template send (returns a wamid) even when the WABA can't
// actually deliver it — e.g. a billing/payment-method problem blocks all
// business-initiated messages and only shows up as an async "failed" webhook
// (error 131042/141006). This endpoint asks Meta's own health_status per
// account so the UI can warn BEFORE a send instead of after. Cheap enough to
// hit on page load; each account is one Graph call.
const HEALTH_TTL_MS = 60 * 1000;
const _healthCache = new Map(); // accountId -> { at, data }

async function fetchAccountHealth(acc) {
  if (!acc) return { ok: false, canSend: 'UNKNOWN', reason: 'Account not found' };
  if (!acc.wabaId) return { ok: false, canSend: 'UNKNOWN', reason: 'No WABA id configured for this account' };
  if (!acc.accessToken) return { ok: false, canSend: 'UNKNOWN', reason: 'No access token configured for this account' };
  const url = `https://graph.facebook.com/v21.0/${acc.wabaId}`
    + `?fields=id,name,account_review_status,business_verification_status,health_status`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${acc.accessToken}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    return { ok: false, canSend: 'UNKNOWN', reason: json.error?.message || `Meta returned ${res.status}` };
  }
  const hs = json.health_status || {};
  // The blocking reason lives on the WABA-level entity (business/app entities
  // are usually fine). Surface the first WABA-entity error, else any error.
  const entities = Array.isArray(hs.entities) ? hs.entities : [];
  const wabaEntity = entities.find(e => e.entity_type === 'WABA') || entities.find(e => e.errors?.length);
  const firstError = wabaEntity?.errors?.[0] || null;
  return {
    ok: true,
    canSend: hs.can_send_message || 'AVAILABLE', // AVAILABLE | LIMITED | BLOCKED
    reason: firstError?.error_description || null,
    solution: firstError?.possible_solution || null,
    errorCode: firstError?.error_code || null,
    reviewStatus: json.account_review_status || null,
    verificationStatus: json.business_verification_status || null,
  };
}

async function accountHealthCached(acc) {
  const cached = _healthCache.get(acc.id);
  if (cached && (Date.now() - cached.at) < HEALTH_TTL_MS) return cached.data;
  let data;
  try { data = await fetchAccountHealth(acc); }
  catch (err) { data = { ok: false, canSend: 'UNKNOWN', reason: err.message }; }
  _healthCache.set(acc.id, { at: Date.now(), data });
  return data;
}

// GET /whatsapp-accounts/health — send-health for every active account, or one
// account via ?accountId= / ?phone=. Any authenticated user (the pickers that
// consume it aren't admin-only).
router.get('/whatsapp-accounts/health', async (req, res) => {
  try {
    let creds;
    if (req.query.accountId) {
      const one = await getAccountWithToken(req.query.accountId);
      creds = one ? [one] : [];
    } else if (req.query.phone) {
      const one = await getAccountByPhoneNumber(req.query.phone);
      creds = one ? [one] : [];
    } else {
      const { rows } = await pool.query(
        `SELECT * FROM coexistence.whatsapp_accounts WHERE is_active = true ORDER BY is_default DESC, display_name ASC`
      );
      creds = rows.map(rowToCreds).filter(Boolean);
    }
    const accounts = await Promise.all(creds.map(async (acc) => ({
      id: acc.id,
      displayName: acc.displayName,
      displayPhoneNumber: acc.displayPhoneNumber,
      ...(await accountHealthCached(acc)),
    })));
    res.json({ accounts });
  } catch (err) {
    console.error('[whatsapp-accounts] health error:', err.message);
    res.status(500).json({ error: 'Failed to check account health' });
  }
});

// Resolve account by phone (must be registered before :id so it doesn't match :id=by-phone)
router.get('/whatsapp-accounts/by-phone/:phone', async (req, res) => {
  try {
    const acc = await getAccountByPhoneNumber(req.params.phone);
    if (!acc) return res.status(404).json({ error: 'No WhatsApp account registered for this phone' });
    res.json({
      id: acc.id,
      displayName: acc.displayName,
      displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId,
      wabaId: acc.wabaId,
      isActive: acc.isActive,
    });
  } catch (err) {
    console.error('[whatsapp-accounts] by-phone error:', err.message);
    res.status(500).json({ error: 'Failed to resolve account' });
  }
});

// Get one — admins see the decrypted token (?reveal=1)
router.get('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0], { reveal: req.query.reveal === '1' }));
  } catch (err) {
    console.error('[whatsapp-accounts] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch WhatsApp account' });
  }
});

router.post('/whatsapp-accounts', adminOnly, async (req, res) => {
  try {
    const { displayName, displayPhoneNumber, phoneNumberId, wabaId, metaAppId, accessToken, verifyToken, isDefault, isActive } = req.body || {};
    if (!displayName || !displayPhoneNumber || !phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({ error: 'displayName, displayPhoneNumber, phoneNumberId, wabaId, accessToken required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isDefault) {
        await client.query('UPDATE coexistence.whatsapp_accounts SET is_default = FALSE WHERE is_default = TRUE');
      }
      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
          (display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
           access_token_encrypted, verify_token_encrypted, is_default, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          displayName.trim(), displayPhoneNumber.trim().replace(/\D/g, ''), phoneNumberId.trim(), wabaId.trim(),
          metaAppId?.trim() || null,
          encrypt(accessToken.trim()),
          verifyToken && verifyToken.trim() ? encrypt(verifyToken.trim()) : null,
          !!isDefault, isActive !== false,
        ]
      );
      await client.query('COMMIT');
      res.status(201).json(publicShape(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'phoneNumberId already exists' });
    console.error('[whatsapp-accounts] create error:', err.message);
    res.status(500).json({ error: 'Failed to create WhatsApp account' });
  }
});

router.put('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const { displayName, displayPhoneNumber, phoneNumberId, wabaId, metaAppId, accessToken, verifyToken, isDefault, isActive } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isDefault) {
        await client.query('UPDATE coexistence.whatsapp_accounts SET is_default = FALSE WHERE is_default = TRUE AND id <> $1', [req.params.id]);
      }
      const sets = ['updated_at = NOW()'];
      const params = [];
      let i = 1;
      const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
      if (displayName != null) push('display_name', displayName.trim());
      if (displayPhoneNumber != null) push('display_phone_number', displayPhoneNumber.trim().replace(/\D/g, ''));
      if (phoneNumberId != null) push('phone_number_id', phoneNumberId.trim());
      if (wabaId != null) push('waba_id', wabaId.trim());
      if (metaAppId !== undefined) push('meta_app_id', metaAppId?.trim() || null);
      if (accessToken) {
        push('access_token_encrypted', encrypt(accessToken.trim()));
        // Reset health on token update so the UI banner clears
        push('health_status', 'unknown');
        push('last_error_message', null);
      }
      // verifyToken sent as '' clears the per-account token (falls back to env).
      if (verifyToken !== undefined) push('verify_token_encrypted', verifyToken && verifyToken.trim() ? encrypt(verifyToken.trim()) : null);
      if (isDefault != null) push('is_default', !!isDefault);
      if (isActive != null) push('is_active', !!isActive);
      params.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE coexistence.whatsapp_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      await client.query('COMMIT');
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(publicShape(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'phoneNumberId already exists' });
    console.error('[whatsapp-accounts] update error:', err.message);
    res.status(500).json({ error: 'Failed to update WhatsApp account' });
  }
});

router.delete('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.whatsapp_accounts WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[whatsapp-accounts] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete WhatsApp account' });
  }
});

// Normalise phone numbers for matching: strip everything but digits.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function rowToCreds(r) {
  if (!r) return null;
  return {
    id: r.id,
    displayName: r.display_name,
    displayPhoneNumber: r.display_phone_number,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    accessToken: decrypt(r.access_token_encrypted),
    isActive: r.is_active,
  };
}

async function getAccountWithToken(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
    [accountId]
  );
  return rowToCreds(rows[0]);
}

/**
 * Resolve the WhatsApp account that owns the given phone number. Used by
 * broadcasts and automation message nodes to derive credentials from a
 * "from" phone number. Matches by digits-only normalisation so users can
 * register the number as "+919876543210" or "919876543210".
 */
async function getAccountByPhoneNumber(phoneOrId) {
  const norm = normalizePhone(phoneOrId);
  if (!norm) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
       WHERE regexp_replace(display_phone_number, '\\D', '', 'g') = $1
          OR phone_number_id = $2
       LIMIT 1`,
    [norm, String(phoneOrId)]
  );
  return rowToCreds(rows[0]);
}

/**
 * Pre-send guard: ask Meta whether this account can actually deliver a
 * business-initiated message RIGHT NOW. Meta accepts (returns a wamid) even
 * when the WABA is billing-blocked, then fails delivery async — so send
 * endpoints call this BEFORE enqueuing and reject the click with the real
 * reason instead of an optimistic "queued". `acc` may be an account-creds
 * object (from resolveAccount/getAccountWithToken) or an account id.
 * Returns { ok:true } when sendable; { ok:false, reason } when blocked.
 * Fails OPEN (ok:true) if Meta is unreachable — never block a send on our
 * own health-check flakiness.
 */
async function assertCanSend(acc) {
  const account = (acc && typeof acc === 'object') ? acc : await getAccountWithToken(acc);
  if (!account) return { ok: false, reason: 'WhatsApp account not found.' };
  let health;
  try { health = await accountHealthCached(account); }
  catch { return { ok: true }; } // health-check failure must not block a legitimate send
  if (health && health.canSend === 'BLOCKED') {
    const reason = [health.reason, health.solution].filter(Boolean).join(' ')
      || 'This WhatsApp Business account currently cannot send messages. Check its billing/payment method and status in Meta Business settings.';
    return { ok: false, reason };
  }
  return { ok: true };
}

module.exports = { router, getAccountWithToken, getAccountByPhoneNumber, assertCanSend };
