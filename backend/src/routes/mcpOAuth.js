// OAuth 2.1 authorization server for the MCP connector.
//
// Claude's custom-connector dialog expects an OAuth Client ID / Client Secret,
// and the MCP spec (2025-06-18) requires OAuth 2.1 for HTTP transports. The old
// scheme put a long-lived key in the connector URL, which works but leaks the
// credential into browser history, logs and referrers.
//
// ⚠ WHAT CLAUDE ACTUALLY REQUIRES — each of these fails silently or with an
// opaque error if wrong, so none of it is guesswork:
//   * grant_types authorization_code + refresh_token. `client_credentials` is
//     NOT supported by Claude: it insists on an interactive browser flow.
//   * PKCE S256, advertised in the metadata. A server that does not advertise
//     it is rejected before any redirect happens.
//   * redirect_uri https://claude.ai/api/mcp/auth_callback for web / desktop /
//     mobile. Claude Code uses a LOOPBACK redirect on an ephemeral port, so
//     localhost must be matched port-agnostically (see redirectAllowed).
//   * RFC 9728 protected-resource metadata, and a WWW-Authenticate header on
//     the 401 so the client can find it.
//   * RFC 8707 `resource` — recorded on the token and validated as the audience
//     when it is later presented.
//
// ⚠ frontend/nginx.conf used to return a hard 404 for every /.well-known/oauth*
// path on purpose (the SPA catch-all was answering them with index.html, which
// made connectors attempt Dynamic Client Registration and fail with
// "Couldn't register with forge growth's sign-in service"). That block is now a
// proxy to this router — if discovery ever 404s again, check nginx first.

const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const { hashApiKey } = require('../util/crypto');

const publicRouter = Router();
const adminRouter = Router();

// Short access token + long refresh, per OAuth 2.1's "issue short-lived access
// tokens" guidance. Claude refreshes silently, so a short life costs nothing.
const ACCESS_TTL_S = 60 * 60;              // 1h
const REFRESH_TTL_S = 60 * 60 * 24 * 60;   // 60d
const CODE_TTL_S = 300;                    // 5 min (spec: "short lived")

// Claude's own callback, offered as a default when creating a client so nobody
// has to know it. Loopback is handled separately (ephemeral port).
const CLAUDE_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function baseUrl(req) {
  // Behind Traefik + nginx. `trust proxy` is off in this app, so req.protocol
  // reports http even on a TLS request — read the forwarded header, and pin to
  // https otherwise. An http issuer would be rejected by the client outright.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto === 'http' ? 'https' : proto}://${host}`;
}

// The canonical resource identifier for this MCP server (RFC 8707). Must match
// what the client sends as `resource`, and what the token is later validated
// against.
const resourceUrl = (req) => `${baseUrl(req)}/api/mcp`;

async function ensureMcpOAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_clients (
      id                     BIGSERIAL PRIMARY KEY,
      client_id              TEXT NOT NULL UNIQUE,
      client_secret_hash     TEXT,
      name                   TEXT NOT NULL,
      redirect_uris          JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      dynamically_registered BOOLEAN NOT NULL DEFAULT FALSE,
      created_by             TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at           TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_codes (
      code_hash             TEXT PRIMARY KEY,
      client_id             TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      redirect_uri          TEXT NOT NULL,
      code_challenge        TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      resource              TEXT,
      scope                 TEXT,
      expires_at            TIMESTAMPTZ NOT NULL,
      used_at               TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON coexistence.mcp_oauth_codes(expires_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.mcp_oauth_tokens (
      id                  BIGSERIAL PRIMARY KEY,
      access_token_hash   TEXT NOT NULL UNIQUE,
      refresh_token_hash  TEXT UNIQUE,
      client_id           TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      resource            TEXT,
      scope               TEXT,
      access_expires_at   TIMESTAMPTZ NOT NULL,
      refresh_expires_at  TIMESTAMPTZ,
      revoked_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at        TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client ON coexistence.mcp_oauth_tokens(client_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expiry ON coexistence.mcp_oauth_tokens(access_expires_at)`);
}

// ── Redirect URI matching ────────────────────────────────────────────────────
// Exact match, with ONE deliberate exception: Claude Code listens on a loopback
// port chosen at runtime, so the port cannot be registered in advance. RFC 8252
// says to compare loopback redirects ignoring the port. Everything else is
// compared byte-for-byte — a prefix match here is an open-redirect hole.
function redirectAllowed(registered, candidate) {
  if (!candidate) return false;
  if (registered.includes(candidate)) return true;
  let u;
  try { u = new URL(candidate); } catch { return false; }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (!isLoopback) return false;
  // http is permitted ONLY on loopback (the spec's other exception to HTTPS).
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return registered.some(r => {
    let ru;
    try { ru = new URL(r); } catch { return false; }
    const rLoop = ru.hostname === 'localhost' || ru.hostname === '127.0.0.1' || ru.hostname === '[::1]';
    return rLoop && ru.pathname === u.pathname;
  });
}

async function getClient(clientId) {
  if (!clientId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.mcp_oauth_clients WHERE client_id = $1 AND is_enabled`, [clientId]);
  return rows[0] || null;
}

// ── Discovery ────────────────────────────────────────────────────────────────
// Both documents are served at the bare path AND with any suffix, because
// RFC 9728/8414 anchor the well-known at the ROOT and append the resource path
// (…/.well-known/oauth-protected-resource/api/mcp). Clients differ on which
// they request; answering only one is the most common reason discovery fails.

function protectedResourceDoc(req) {
  return {
    resource: resourceUrl(req),
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${baseUrl(req)}/#/admin-settings`,
  };
}

function authServerDoc(req) {
  const base = baseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    // No client_credentials: Claude requires an interactive flow, and a
    // machine-to-machine grant here would hand out admin-equivalent access with
    // no human in the loop.
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    // S256 only. Advertising "plain" would let a client downgrade to the very
    // interception attack PKCE prevents.
    code_challenge_methods_supported: ['S256'],
    resource_indicators_supported: true,
    service_documentation: `${base}/#/admin-settings`,
  };
}

for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*']) {
  publicRouter.get(p, (req, res) => res.json(protectedResourceDoc(req)));
}
for (const p of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/*',
  // Some clients probe the OpenID path even for a plain OAuth server.
  '/.well-known/openid-configuration',
  '/.well-known/openid-configuration/*',
]) {
  publicRouter.get(p, (req, res) => res.json(authServerDoc(req)));
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
// Supported so a client that CAN self-register does not need anyone to paste
// anything. Gated on the MCP master switch, so registration is impossible while
// MCP is turned off.
publicRouter.post('/api/mcp/oauth/register', async (req, res) => {
  try {
    const { rows: s } = await pool.query('SELECT master_enabled FROM coexistence.mcp_settings WHERE id = 1');
    if (!s[0]?.master_enabled) {
      return res.status(403).json({ error: 'access_denied', error_description: 'MCP access is turned off.' });
    }
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(u => typeof u === 'string') : [];
    if (!uris.length) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required.' });
    }
    for (const u of uris) {
      let parsed;
      try { parsed = new URL(u); } catch { return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Not a URL: ${u}` }); }
      const loop = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
      if (parsed.protocol !== 'https:' && !loop) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Redirect URIs must use https (or loopback).' });
      }
    }
    const clientId = `fgc_${token(16)}`;
    const secret = `fgs_${token(32)}`;
    await pool.query(
      `INSERT INTO coexistence.mcp_oauth_clients
         (client_id, client_secret_hash, name, redirect_uris, dynamically_registered, created_by)
       VALUES ($1,$2,$3,$4,TRUE,'dynamic-registration')`,
      [clientId, hashApiKey(secret), String(b.client_name || 'MCP client').slice(0, 120), JSON.stringify(uris)]
    );
    res.status(201).json({
      client_id: clientId,
      client_secret: secret,
      client_name: b.client_name || 'MCP client',
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,   // never
    });
  } catch (err) {
    console.error('[mcp-oauth] register error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── Authorize ────────────────────────────────────────────────────────────────
// Renders a consent page. The user must already be signed in to Forge Growth —
// this reuses the normal session cookie rather than asking for the password
// again, so the connector can never become a second credential surface.
publicRouter.get('/api/mcp/oauth/authorize', async (req, res) => {
  const q = req.query || {};
  const fail = (code, desc, status = 400) => res.status(status).type('html').send(errorPage(desc));

  try {
    const { rows: s } = await pool.query('SELECT master_enabled FROM coexistence.mcp_settings WHERE id = 1');
    if (!s[0]?.master_enabled) return fail('access_denied', 'MCP access is currently turned off in Forge Growth.', 403);

    const client = await getClient(q.client_id);
    if (!client) return fail('invalid_client', 'That Client ID is not registered here, or has been disabled.');

    const registered = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    // ⚠ Validated BEFORE anything is redirected anywhere. An unvalidated
    // redirect_uri is an open redirect, so this error is rendered on our own
    // page rather than bounced to the supplied URL.
    if (!redirectAllowed(registered, q.redirect_uri)) {
      return fail('invalid_redirect_uri',
        `This client is not registered for that redirect URL.\n\nReceived: ${q.redirect_uri || '(none)'}`);
    }
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only the authorization code flow is supported.');
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') {
      // Refused rather than downgraded — accepting a missing/plain challenge
      // reopens exactly the interception attack PKCE closes.
      return fail('invalid_request', 'This server requires PKCE with S256.');
    }

    // Signed in? authMiddleware does not run on this public route, so the
    // cookie is verified here directly.
    const user = readSession(req);
    if (!user) {
      const back = encodeURIComponent(req.originalUrl);
      return res.type('html').send(loginRequiredPage(`${baseUrl(req)}/#/?next=${back}`));
    }

    res.type('html').send(consentPage({
      clientName: client.name,
      user,
      params: q,
      resource: q.resource || resourceUrl(req),
      action: `${baseUrl(req)}/api/mcp/oauth/authorize`,
    }));
  } catch (err) {
    console.error('[mcp-oauth] authorize error:', err.message);
    fail('server_error', 'Something went wrong starting the connection.', 500);
  }
});

publicRouter.post('/api/mcp/oauth/authorize', async (req, res) => {
  try {
    const b = req.body || {};
    const user = readSession(req);
    if (!user) return res.status(401).type('html').send(errorPage('Your session expired. Sign in to Forge Growth and try connecting again.'));

    const client = await getClient(b.client_id);
    if (!client) return res.status(400).type('html').send(errorPage('That Client ID is not registered here.'));
    const registered = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (!redirectAllowed(registered, b.redirect_uri)) {
      return res.status(400).type('html').send(errorPage('This client is not registered for that redirect URL.'));
    }

    const redirect = new URL(b.redirect_uri);
    if (b.decision !== 'allow') {
      redirect.searchParams.set('error', 'access_denied');
      if (b.state) redirect.searchParams.set('state', b.state);
      return res.redirect(302, redirect.toString());
    }

    // Reap opportunistically rather than on a timer — codes live 5 minutes and
    // are only ever written here, so this is the one place growth happens.
    // Kept 1h past expiry so a replay still finds its row and can revoke the
    // tokens it produced (deleting immediately would turn a replay attempt into
    // an indistinguishable "unknown code").
    pool.query(`DELETE FROM coexistence.mcp_oauth_codes WHERE expires_at < NOW() - INTERVAL '1 hour'`)
      .catch(() => {});

    const code = token(32);
    await pool.query(
      `INSERT INTO coexistence.mcp_oauth_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method,
          resource, scope, expires_at)
       VALUES ($1,$2,$3,$4,$5,'S256',$6,$7, NOW() + ($8 || ' seconds')::interval)`,
      [sha256(code), client.client_id, String(user.id), b.redirect_uri,
       b.code_challenge, b.resource || null, b.scope || 'mcp', String(CODE_TTL_S)]
    );

    redirect.searchParams.set('code', code);
    if (b.state) redirect.searchParams.set('state', b.state);
    res.redirect(302, redirect.toString());
  } catch (err) {
    console.error('[mcp-oauth] approve error:', err.message);
    res.status(500).type('html').send(errorPage('Something went wrong completing the connection.'));
  }
});

// ── Token ────────────────────────────────────────────────────────────────────
publicRouter.post('/api/mcp/oauth/token', async (req, res) => {
  // OAuth requires form encoding here; express.urlencoded is mounted for this
  // path in index.js. Some clients still send JSON, so both are accepted.
  const b = req.body || {};
  const bad = (error, description, status = 400) => res.status(status).json({ error, error_description: description });

  try {
    // Client authentication: secret in the body, or HTTP Basic. A public client
    // (no stored secret) authenticates by PKCE alone, which is the OAuth 2.1
    // rule for clients that cannot keep a secret.
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const basic = req.headers.authorization || '';
    if (basic.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = clientId || decodeURIComponent(id || '');
      clientSecret = clientSecret || decodeURIComponent(secret || '');
    }

    const client = await getClient(clientId);
    if (!client) return bad('invalid_client', 'Unknown or disabled client.', 401);
    if (client.client_secret_hash) {
      if (!clientSecret || hashApiKey(clientSecret) !== client.client_secret_hash) {
        return bad('invalid_client', 'Client authentication failed.', 401);
      }
    }

    if (b.grant_type === 'authorization_code') {
      const codeHash = sha256(b.code || '');
      const { rows } = await pool.query(
        `SELECT * FROM coexistence.mcp_oauth_codes WHERE code_hash = $1`, [codeHash]);
      const row = rows[0];
      if (!row) return bad('invalid_grant', 'That authorization code is not valid.');

      // ⚠ A REPLAYED code is an attack signal, not a no-op. OAuth 2.1 requires
      // revoking everything already issued from it, because a replay means the
      // code leaked and someone else may hold the first set of tokens.
      if (row.used_at) {
        await pool.query(
          `UPDATE coexistence.mcp_oauth_tokens SET revoked_at = NOW()
            WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL
              AND created_at >= $3`,
          [row.client_id, row.user_id, row.used_at]
        ).catch(() => {});
        console.warn(`[mcp-oauth] authorization code replayed for client ${row.client_id} — issued tokens revoked`);
        return bad('invalid_grant', 'That authorization code has already been used.');
      }
      if (new Date(row.expires_at) < new Date()) return bad('invalid_grant', 'That authorization code has expired.');
      if (row.client_id !== client.client_id) return bad('invalid_grant', 'This code was issued to a different client.');
      if (row.redirect_uri !== b.redirect_uri) return bad('invalid_grant', 'redirect_uri does not match the authorization request.');

      // PKCE verification.
      const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (!b.code_verifier || challenge !== row.code_challenge) {
        return bad('invalid_grant', 'PKCE verification failed.');
      }

      // RFC 8707: if the token request names a resource, it must be the one the
      // code was issued for — otherwise a code for resource A could mint a
      // token for resource B.
      if (b.resource && row.resource && b.resource !== row.resource) {
        return bad('invalid_target', 'resource does not match the authorization request.');
      }

      await pool.query(`UPDATE coexistence.mcp_oauth_codes SET used_at = NOW() WHERE code_hash = $1`, [codeHash]);
      const out = await issueTokens({
        clientId: client.client_id, userId: row.user_id,
        resource: b.resource || row.resource || resourceUrl(req), scope: row.scope || 'mcp',
      });
      await pool.query(`UPDATE coexistence.mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = $1`, [client.client_id]);
      return res.json(out);
    }

    if (b.grant_type === 'refresh_token') {
      const rHash = sha256(b.refresh_token || '');
      const { rows } = await pool.query(
        `SELECT * FROM coexistence.mcp_oauth_tokens
          WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [rHash]);
      const row = rows[0];
      if (!row) return bad('invalid_grant', 'That refresh token is not valid.');
      if (row.client_id !== client.client_id) return bad('invalid_grant', 'This refresh token was issued to a different client.');
      if (row.refresh_expires_at && new Date(row.refresh_expires_at) < new Date()) {
        return bad('invalid_grant', 'That refresh token has expired. Reconnect the connector.');
      }
      // Rotation: the old pair is revoked as the new one is issued, so a stolen
      // refresh token stops working the moment the real client next refreshes.
      await pool.query(`UPDATE coexistence.mcp_oauth_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);
      const out = await issueTokens({
        clientId: client.client_id, userId: row.user_id,
        resource: row.resource || resourceUrl(req), scope: row.scope || 'mcp',
      });
      return res.json(out);
    }

    return bad('unsupported_grant_type',
      'Only authorization_code and refresh_token are supported. client_credentials is deliberately not offered.');
  } catch (err) {
    console.error('[mcp-oauth] token error:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

publicRouter.post('/api/mcp/oauth/revoke', async (req, res) => {
  try {
    const t = (req.body || {}).token;
    if (t) {
      const h = sha256(t);
      await pool.query(
        `UPDATE coexistence.mcp_oauth_tokens SET revoked_at = NOW()
          WHERE (access_token_hash = $1 OR refresh_token_hash = $1) AND revoked_at IS NULL`, [h]);
    }
    // RFC 7009: always 200, even for an unknown token — telling a caller which
    // tokens exist is itself a leak.
    res.status(200).json({});
  } catch {
    res.status(200).json({});
  }
});

async function issueTokens({ clientId, userId, resource, scope }) {
  const access = token(32);
  const refresh = token(32);
  await pool.query(
    `INSERT INTO coexistence.mcp_oauth_tokens
       (access_token_hash, refresh_token_hash, client_id, user_id, resource, scope,
        access_expires_at, refresh_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' seconds')::interval, NOW() + ($8 || ' seconds')::interval)`,
    [sha256(access), sha256(refresh), clientId, userId, resource, scope,
     String(ACCESS_TTL_S), String(REFRESH_TTL_S)]
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scope || 'mcp',
  };
}

/**
 * Validate a bearer token presented to the MCP endpoint.
 * Returns { ok, userId, clientId } or { ok:false, reason }.
 *
 * ⚠ Audience is checked here. A token minted for a different resource must be
 * rejected outright and never passed through — that is the confused-deputy hole
 * the MCP spec calls out explicitly.
 */
async function verifyAccessToken(rawToken, expectedResource) {
  if (!rawToken) return { ok: false, reason: 'missing' };
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.mcp_oauth_tokens WHERE access_token_hash = $1`, [sha256(rawToken)]);
  const t = rows[0];
  if (!t) return { ok: false, reason: 'unknown' };
  if (t.revoked_at) return { ok: false, reason: 'revoked' };
  if (new Date(t.access_expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (expectedResource && t.resource && !sameResource(t.resource, expectedResource)) {
    return { ok: false, reason: 'audience' };
  }
  const { rows: c } = await pool.query(
    `SELECT is_enabled FROM coexistence.mcp_oauth_clients WHERE client_id = $1`, [t.client_id]);
  if (!c[0]?.is_enabled) return { ok: false, reason: 'client_disabled' };
  pool.query(`UPDATE coexistence.mcp_oauth_tokens SET last_used_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
  return { ok: true, userId: t.user_id, clientId: t.client_id, scope: t.scope };
}

// Compare audiences forgivingly on the parts that carry no meaning (trailing
// slash, case of scheme/host) and strictly on everything else.
function sameResource(a, b) {
  const norm = (v) => {
    try {
      const u = new URL(v);
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}`;
    } catch { return String(v || '').replace(/\/$/, ''); }
  };
  return norm(a) === norm(b);
}

// Reads the normal Forge Growth session cookie. Kept local rather than reusing
// authMiddleware because these routes are public by necessity — the OAuth
// endpoints must be reachable without a session in order to say "sign in first".
function readSession(req) {
  try {
    const jwt = require('jsonwebtoken');
    const raw = req.cookies?.[process.env.FORGECRM_COOKIE_NAME || 'forgecrm_token'];
    if (!raw) return null;
    const p = jwt.verify(raw, require('../util/session').JWT_SECRET);
    return { id: p.id, name: p.displayName || p.username, role: p.role };
  } catch { return null; }
}

/* ============================ admin router ============================ */

const clientShape = (r) => ({
  id: r.id, clientId: r.client_id, name: r.name,
  redirectUris: r.redirect_uris || [],
  isEnabled: r.is_enabled, dynamic: r.dynamically_registered,
  createdAt: r.created_at, lastUsedAt: r.last_used_at,
  hasSecret: !!r.client_secret_hash,
});

adminRouter.get('/mcp/oauth/clients', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM coexistence.mcp_oauth_tokens t
                     WHERE t.client_id = c.client_id AND t.revoked_at IS NULL
                       AND t.access_expires_at > NOW()) AS active_tokens
         FROM coexistence.mcp_oauth_clients c ORDER BY c.created_at DESC`);
    res.json({ clients: rows.map(r => ({ ...clientShape(r), activeTokens: r.active_tokens })) });
  } catch (err) {
    console.error('[mcp-oauth] list clients error:', err.message);
    res.status(500).json({ error: 'Failed to load OAuth clients' });
  }
});

adminRouter.post('/mcp/oauth/clients', adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the connector a name.' });
    const extra = Array.isArray(req.body?.redirectUris) ? req.body.redirectUris.filter(Boolean) : [];
    // Claude's callbacks are included by default so nobody has to know them,
    // plus a loopback entry for Claude Code (port matched separately).
    const uris = [...new Set([...CLAUDE_REDIRECTS, 'http://localhost/callback', ...extra])];

    const clientId = `fgc_${token(16)}`;
    const secret = `fgs_${token(32)}`;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.mcp_oauth_clients (client_id, client_secret_hash, name, redirect_uris, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [clientId, hashApiKey(secret), name.slice(0, 120), JSON.stringify(uris), req.user?.username || null]
    );
    // The secret is returned ONCE and only its hash is stored.
    res.status(201).json({ ...clientShape(rows[0]), clientSecret: secret });
  } catch (err) {
    console.error('[mcp-oauth] create client error:', err.message);
    res.status(500).json({ error: 'Failed to create the OAuth client' });
  }
});

adminRouter.put('/mcp/oauth/clients/:id', adminOnly, async (req, res) => {
  try {
    const sets = ['id = id']; const params = [];
    if (req.body?.isEnabled !== undefined) { params.push(!!req.body.isEnabled); sets.push(`is_enabled = $${params.length}`); }
    if (req.body?.name) { params.push(String(req.body.name).slice(0, 120)); sets.push(`name = $${params.length}`); }
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.mcp_oauth_clients SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(clientShape(rows[0]));
  } catch (err) {
    console.error('[mcp-oauth] update client error:', err.message);
    res.status(500).json({ error: 'Failed to update the OAuth client' });
  }
});

adminRouter.delete('/mcp/oauth/clients/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM coexistence.mcp_oauth_clients WHERE id = $1 RETURNING client_id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    // Tokens outlive the client row otherwise, and would keep working.
    await pool.query(
      `UPDATE coexistence.mcp_oauth_tokens SET revoked_at = NOW()
        WHERE client_id = $1 AND revoked_at IS NULL`, [rows[0].client_id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[mcp-oauth] delete client error:', err.message);
    res.status(500).json({ error: 'Failed to remove the OAuth client' });
  }
});

/* ============================== pages ================================= */
// Self-contained HTML: these render inside Claude's OAuth popup, where none of
// the SPA's assets are loaded.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SHELL = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--bg:#F7F7F3;--card:#fff;--border:#E5E5E0;--text:#111;--muted:#6B7280;--primary:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);
       font-family:'DM Sans',system-ui,-apple-system,sans-serif;color:var(--text);padding:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:440px;width:100%;
        padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.08)}
  h1{font-size:19px;margin:0 0 6px;letter-spacing:-.02em}
  p{font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 14px}
  .brand{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:13px;letter-spacing:.02em;margin-bottom:18px}
  .pill{background:var(--primary);color:#fff;border-radius:6px;padding:2px 7px;font-size:12px}
  .row{display:flex;gap:10px;margin-top:20px}
  button{flex:1;padding:11px 16px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;
         font-family:inherit;border:1.5px solid var(--border);background:#fff;color:var(--text)}
  button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
  .box{background:#FAF9F5;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin:14px 0}
  .box ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.7}
  code{font-family:'DM Mono',ui-monospace,monospace;font-size:12px;word-break:break-all}
  .warn{background:#FFF8E6;border:1px solid #F0DCA8;color:#6B5312;border-radius:9px;padding:11px 13px;font-size:13px;line-height:1.55}
</style></head><body><div class="card">
<div class="brand">FORGE <span class="pill">GROWTH</span></div>
${body}
</div></body></html>`;

function consentPage({ clientName, user, params, resource, action }) {
  const hidden = (k, v) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`;
  return SHELL('Connect to Forge Growth', `
    <h1>Connect ${esc(clientName)}?</h1>
    <p>Signed in as <strong>${esc(user.name)}</strong>. Approving lets this connector act on Forge Growth using your account.</p>
    <div class="box">
      <strong style="font-size:13px">It will be able to:</strong>
      <ul>
        <li>Use whatever is enabled under <em>Admin Settings → MCP Tools → Capabilities</em></li>
        <li>Nothing beyond that — turning a capability off applies immediately, even to an already-connected client</li>
      </ul>
    </div>
    <p style="font-size:12.5px">Connecting to <code>${esc(resource)}</code></p>
    <form method="post" action="${esc(action)}">
      ${hidden('client_id', params.client_id)}
      ${hidden('redirect_uri', params.redirect_uri)}
      ${hidden('state', params.state || '')}
      ${hidden('code_challenge', params.code_challenge)}
      ${hidden('scope', params.scope || 'mcp')}
      ${hidden('resource', params.resource || resource)}
      <div class="row">
        <button type="submit" name="decision" value="deny">Cancel</button>
        <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
      </div>
    </form>`);
}

function loginRequiredPage(loginUrl) {
  return SHELL('Sign in first', `
    <h1>Sign in to Forge Growth</h1>
    <p>You need to be signed in before you can connect a tool to your account.</p>
    <div class="warn">Sign in in this window, then start the connection again from Claude.</div>
    <div class="row"><a href="${esc(loginUrl)}" style="flex:1;text-decoration:none">
      <button class="primary" style="width:100%">Open Forge Growth</button></a></div>`);
}

function errorPage(message) {
  return SHELL('Could not connect', `
    <h1>Could not connect</h1>
    <p style="white-space:pre-wrap">${esc(message)}</p>
    <div class="warn">If you are setting this up, check the Client ID, Client Secret and redirect URL in
      <strong>Admin Settings → MCP Tools</strong>.</div>`);
}

module.exports = {
  publicRouter,
  adminRouter,
  ensureMcpOAuthTables,
  verifyAccessToken,
  resourceUrl,
  CLAUDE_REDIRECTS,
};
