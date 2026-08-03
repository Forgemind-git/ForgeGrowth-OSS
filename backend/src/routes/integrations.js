// Integrations (Google Sheets / Calendar / Gmail) — admin-only endpoints.
//
// Flow per provider:
//   1. Admin enters Client ID/Secret/Redirect URI once via PUT /credentials.
//   2. Admin clicks Connect → opens a popup at /oauth/start?provider=…
//      (mints a state row, redirects to Google consent).
//   3. Google redirects to /oauth/callback?code=…&state=… (PUBLIC — Google
//      doesn't send our cookie). We verify state, exchange code for tokens,
//      fetch the userinfo, store encrypted, then render a tiny HTML page that
//      posts a message to window.opener and closes itself.
//   4. UI list pulls /integrations and shows Connected as user@gmail.com.

const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { encrypt, decrypt } = require('../util/crypto');
const { adminOnly } = require('../middleware/access');
const {
  PROVIDER_SCOPES,
  PROVIDER_LABELS,
  getGoogleOAuthCredentials,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  revokeToken,
  getValidAccessToken,
  driveListSpreadsheets,
  sheetsGetSpreadsheet,
  sheetsGetTabPreview,
  calendarListCalendars,
  gmailGetProfile,
  gmailListLabels,
} = require('../integrations/googleClient');

const router = Router();
const publicRouter = Router();   // OAuth callback — no auth (Google calls us)

const VALID_PROVIDERS = new Set(['google_sheets', 'google_calendar', 'gmail']);

// ─── Google OAuth credentials (the workspace-wide Client ID/Secret) ─────

router.get('/integrations/credentials', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, redirect_uri, updated_at,
              client_id_encrypted, client_secret_encrypted
         FROM coexistence.google_oauth_credentials
        ORDER BY id DESC LIMIT 1`
    );
    if (rows.length === 0) {
      return res.json({ configured: false });
    }
    const r = rows[0];
    const clientId = decrypt(r.client_id_encrypted) || '';
    return res.json({
      configured: true,
      clientId,                                // visible to admin (not a secret per Google's docs)
      clientSecretMasked: '••••••••',          // never returned in plaintext
      redirectUri: r.redirect_uri,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error('[integrations] credentials GET error:', err.message);
    res.status(500).json({ error: 'Failed to load credentials' });
  }
});

router.put('/integrations/credentials', adminOnly, async (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body || {};
  if (!clientId || !String(clientId).trim()) return res.status(400).json({ error: 'clientId is required' });
  if (!redirectUri || !String(redirectUri).trim()) return res.status(400).json({ error: 'redirectUri is required' });
  // clientSecret is required on create. On update, allow empty to keep existing.
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, client_secret_encrypted FROM coexistence.google_oauth_credentials ORDER BY id DESC LIMIT 1`
    );
    let secretEnc;
    if (clientSecret && String(clientSecret).trim()) {
      secretEnc = encrypt(String(clientSecret).trim());
    } else if (existing.length > 0) {
      secretEnc = existing[0].client_secret_encrypted;  // keep existing
    } else {
      return res.status(400).json({ error: 'clientSecret is required when configuring for the first time' });
    }
    const idEnc = encrypt(String(clientId).trim());

    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO coexistence.google_oauth_credentials
            (client_id_encrypted, client_secret_encrypted, redirect_uri, updated_by)
          VALUES ($1, $2, $3, $4)`,
        [idEnc, secretEnc, String(redirectUri).trim(), req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE coexistence.google_oauth_credentials
            SET client_id_encrypted = $1,
                client_secret_encrypted = $2,
                redirect_uri = $3,
                updated_by = $4,
                updated_at = NOW()
          WHERE id = $5`,
        [idEnc, secretEnc, String(redirectUri).trim(), req.user.id, existing[0].id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[integrations] credentials PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

router.delete('/integrations/credentials', adminOnly, async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.google_oauth_credentials`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[integrations] credentials DELETE error:', err.message);
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

// ─── List + manage connected providers ─────────────────────────────────

router.get('/integrations', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, provider, account_email, account_name, scopes, status,
              last_error, last_used_at, token_expiry_at, connected_by, created_at, updated_at
         FROM coexistence.integrations
        ORDER BY provider ASC`
    );
    res.json(rows.map(r => ({
      id: r.id,
      provider: r.provider,
      providerLabel: PROVIDER_LABELS[r.provider] || r.provider,
      accountEmail: r.account_email,
      accountName: r.account_name,
      scopes: r.scopes || [],
      status: r.status,
      lastError: r.last_error,
      lastUsedAt: r.last_used_at,
      tokenExpiryAt: r.token_expiry_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })));
  } catch (err) {
    console.error('[integrations] list error:', err.message);
    res.status(500).json({ error: 'Failed to list integrations' });
  }
});

router.delete('/integrations/:id', adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT access_token_encrypted FROM coexistence.integrations WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    // Best-effort token revoke at Google so the user sees us drop out of
    // their connected-apps list. Don't fail the delete if revoke fails.
    const accessToken = decrypt(rows[0].access_token_encrypted);
    await revokeToken(accessToken);
    await pool.query(`DELETE FROM coexistence.integrations WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[integrations] delete error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

// Lightweight liveness check: refreshes if needed + pings userinfo.
router.post('/integrations/:id/test', adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rows } = await pool.query(
      `SELECT provider FROM coexistence.integrations WHERE id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const provider = rows[0].provider;
    const token = await getValidAccessToken(provider);
    const info = await fetchUserInfo(token);
    if (!info) throw new Error('userinfo call failed');
    await pool.query(
      `UPDATE coexistence.integrations SET status='connected', last_error=NULL, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    res.json({ ok: true, email: info.email, name: info.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── OAuth dance ────────────────────────────────────────────────────────

// Authenticated start: mints a state row tied to the current user.
router.get('/integrations/oauth/start', adminOnly, async (req, res) => {
  const provider = String(req.query.provider || '');
  if (!VALID_PROVIDERS.has(provider)) return res.status(400).json({ error: 'Invalid provider' });
  try {
    const creds = await getGoogleOAuthCredentials();
    if (!creds || !creds.clientId || !creds.clientSecret || !creds.redirectUri) {
      return res.status(400).json({ error: 'Google OAuth credentials are not configured. Save them first.' });
    }
    const state = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO coexistence.oauth_states (state, provider, user_id) VALUES ($1,$2,$3)`,
      [state, provider, req.user.id]
    );
    // Reap stale states (>15 min) opportunistically
    pool.query(`DELETE FROM coexistence.oauth_states WHERE created_at < NOW() - INTERVAL '15 minutes'`).catch(() => {});
    const url = buildAuthUrl(provider, state, creds);
    // Redirect (so the popup just navigates to Google). The frontend opens
    // this URL in a window — the browser follows the 302.
    res.redirect(302, url);
  } catch (err) {
    console.error('[integrations] oauth start error:', err.message);
    res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
});

// Public callback — Google posts here. No auth (cookies may not be sent
// cross-site through the redirect chain). We rely on the state nonce for CSRF.
publicRouter.get('/integrations/oauth/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const renderHtml = (ok, payload) => {
    const safe = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font-family:system-ui,sans-serif;background:#0F0F10;color:#F5F5F2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1a1c;border:1px solid #2a2a2e;border-radius:14px;padding:32px 40px;max-width:480px;text-align:center}
h1{margin:0 0 8px;font-size:18px}p{margin:6px 0;font-size:14px;color:#A0A0A0}
.ok{color:#16a34a}.err{color:#dc2626}</style></head><body>
<div class="card">
<h1 class="${ok ? 'ok' : 'err'}">${ok ? '✓ Connected' : '✗ Connection failed'}</h1>
<p>${ok ? 'You can close this window.' : (payload.error || 'Unknown error')}</p>
</div>
<script>
try { window.opener && window.opener.postMessage(${safe}, window.location.origin); } catch(e){}
setTimeout(()=>{ try{ window.close(); }catch(e){} }, ${ok ? 800 : 5000});
</script></body></html>`;
  };

  if (oauthError) {
    return res.status(400).type('html').send(renderHtml(false, { type: 'forgechat:integration:error', error: String(oauthError) }));
  }
  if (!code || !state) {
    return res.status(400).type('html').send(renderHtml(false, { type: 'forgechat:integration:error', error: 'Missing code or state' }));
  }
  try {
    // Consume state (single-use)
    const { rows: stateRows } = await pool.query(
      `DELETE FROM coexistence.oauth_states
        WHERE state = $1 AND created_at > NOW() - INTERVAL '15 minutes'
       RETURNING provider, user_id`,
      [state]
    );
    if (stateRows.length === 0) {
      throw new Error('Invalid or expired state — please retry the connection');
    }
    const { provider, user_id: userId } = stateRows[0];
    if (!VALID_PROVIDERS.has(provider)) throw new Error('Invalid provider');

    const creds = await getGoogleOAuthCredentials();
    if (!creds) throw new Error('OAuth credentials not configured');

    const tokens = await exchangeCodeForTokens(code, creds);
    const userinfo = await fetchUserInfo(tokens.access_token);
    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);
    const scopes = (tokens.scope || '').split(/\s+/).filter(Boolean);

    // UPSERT — there's a UNIQUE(provider) constraint so reconnecting replaces
    // the previous row. We always store a refresh_token because access_type=offline
    // + prompt=consent forces Google to mint one on every connect.
    await pool.query(
      `INSERT INTO coexistence.integrations
          (provider, account_email, account_name,
           access_token_encrypted, refresh_token_encrypted,
           token_expiry_at, scopes, status, connected_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'connected',$8,NOW())
        ON CONFLICT (provider) DO UPDATE
          SET account_email = EXCLUDED.account_email,
              account_name = EXCLUDED.account_name,
              access_token_encrypted = EXCLUDED.access_token_encrypted,
              refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, coexistence.integrations.refresh_token_encrypted),
              token_expiry_at = EXCLUDED.token_expiry_at,
              scopes = EXCLUDED.scopes,
              status = 'connected',
              last_error = NULL,
              connected_by = EXCLUDED.connected_by,
              updated_at = NOW()`,
      [
        provider,
        userinfo?.email || null,
        userinfo?.name || null,
        encrypt(tokens.access_token),
        tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        expiry,
        JSON.stringify(scopes),
        userId || null,
      ]
    );

    return res.type('html').send(renderHtml(true, {
      type: 'forgechat:integration:connected',
      provider,
      email: userinfo?.email,
    }));
  } catch (err) {
    console.error('[integrations] callback error:', err.message);
    return res.status(400).type('html').send(renderHtml(false, {
      type: 'forgechat:integration:error',
      error: err.message,
    }));
  }
});

// ─── Discovery (picker UI + future automation-node config) ──────────────

// Helper: wrap discovery routes so a clean error message comes back instead
// of bubbling up to the 500 handler (the most common failure here is "not
// connected" or "token expired" — both are user-actionable in the UI).
function discoveryHandler(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req);
      res.json(out);
    } catch (err) {
      console.error('[integrations] discovery error:', err.message);
      res.status(400).json({ error: err.message });
    }
  };
}

// ── Google Sheets ──
router.get('/integrations/google-sheets/spreadsheets',
  adminOnly,
  discoveryHandler(async (req) => {
    const q = String(req.query.q || '').trim();
    const pageSize = Math.max(1, Math.min(parseInt(req.query.pageSize, 10) || 100, 200));
    return { spreadsheets: await driveListSpreadsheets({ q, pageSize }) };
  })
);

router.get('/integrations/google-sheets/spreadsheets/:id',
  adminOnly,
  discoveryHandler(async (req) => sheetsGetSpreadsheet(req.params.id))
);

router.get('/integrations/google-sheets/spreadsheets/:id/preview',
  adminOnly,
  discoveryHandler(async (req) => {
    const tab = String(req.query.tab || '').trim();
    if (!tab) throw new Error('tab query param is required');
    const rows = Math.max(1, Math.min(parseInt(req.query.rows, 10) || 5, 50));
    return sheetsGetTabPreview(req.params.id, tab, { rows });
  })
);

// ── Google Calendar ──
router.get('/integrations/google-calendar/calendars',
  adminOnly,
  discoveryHandler(async () => ({ calendars: await calendarListCalendars() }))
);

// ── Gmail ──
router.get('/integrations/gmail/profile',
  adminOnly,
  discoveryHandler(async () => gmailGetProfile())
);

router.get('/integrations/gmail/labels',
  adminOnly,
  discoveryHandler(async () => ({ labels: await gmailListLabels() }))
);

module.exports = { router, publicRouter };
