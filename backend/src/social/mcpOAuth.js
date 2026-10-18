const socialEnv = require('./env');
// mcpOAuth.js — the OAuth 2.1 shim the MCP endpoint advertises.
//
// WHY THIS EXISTS: claude.ai's custom-connector flow does not treat a key-in-URL
// endpoint as authenticated. It probes the endpoint with no Authorization header,
// expects a 401 carrying WWW-Authenticate: Bearer resource_metadata=..., follows
// that to the protected-resource document, then to the authorization server, and
// only then offers the user a "Connect" button. Answer the probe with 200 and the
// UI sits on "You're not connected yet" forever.
//
// TRUST MODEL: the API key already lives in the connector URL, so possession of
// that URL is the credential — exactly as it was before this shim. Authorization
// therefore auto-approves, but ONLY after validating the key out of the resource
// parameter (it must exist, be enabled, and pass the master switch). This adds a
// handshake; it does not widen access. PKCE S256 is mandatory so an intercepted
// code is useless on its own, and every issued token is bound to the one key it
// was minted for, so it can never be replayed against another connector's URL.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Fail closed: no hardcoded fallback. auth.js tolerates a dev default; tokens
// that grant data access must not.
const JWT_SECRET = socialEnv.FORGESOCIAL_JWT_SECRET || socialEnv.JWT_SECRET;
const SECRET_OK = !!JWT_SECRET && JWT_SECRET !== 'dev-secret-change-me';
// In ForgeGrowth this module's OAuth routes are not mounted (ForgeGrowth's own
// MCP owns /.well-known/*), so there is nothing to warn about at boot.

const MCP_PATH_RE = /^\/api\/mcp\/http\/([A-Za-z0-9_-]+)$/;
const ACCESS_TTL = 3600;             // 1h — claude.ai refreshes with the refresh token
const REFRESH_TTL = 60 * 60 * 24 * 90;
const CODE_TTL_MS = 5 * 60 * 1000;   // short-lived, single-use

// Hosts allowed as an OAuth redirect target. Anything else is refused before a
// code is minted, so a stolen authorize URL cannot bounce a code off-site.
const REDIRECT_HOSTS = new Set([
  'claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com',
  'localhost', '127.0.0.1', '[::1]',
]);

function redirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  return REDIRECT_HOSTS.has(u.hostname);
}

/* ------------------------------ request origin ---------------------------- */
// Everything is derived from the request's own host so the documents are correct
// on whichever hostname served them (Cloudflare-fronted, direct, or localhost).
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function protectedResourceUrl(req) {
  const path = req.originalUrl.split('?')[0];
  return `${originOf(req)}/.well-known/oauth-protected-resource${path}`;
}

/* --------------------------- in-memory code store ------------------------- */
// Auth codes are single-use and expire in 5 minutes, so a Map is the right store;
// losing them on restart just means the user clicks Connect again.
const codes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt < now) codes.delete(c);
}, 60_000).unref?.();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const s256 = (v) => b64url(crypto.createHash('sha256').update(v).digest());

/* -------------------------------- tokens ---------------------------------- */
function issueTokens(key, resource) {
  const base = { key, resource, scope: 'mcp' };
  return {
    access_token: jwt.sign({ ...base, typ: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL }),
    refresh_token: jwt.sign({ ...base, typ: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TTL }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    scope: 'mcp',
  };
}

// Returns { key } for a valid access token, else null. Never throws — the caller
// falls back to treating the bearer as a raw API key.
function verifyAccessToken(token) {
  if (!SECRET_OK) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.typ !== 'access' || p.scope !== 'mcp' || !p.key) return null;
    return { key: p.key, resource: p.resource };
  } catch { return null; }
}

/* ------------------------------- endpoints -------------------------------- */
// Mount with mountOAuth(app, { validateKey }); validateKey(rawKey) must resolve
// for a usable key and throw otherwise (mcpService.validateKey does exactly that).
// Redacted request log for the OAuth surface. Secrets are reduced to a presence
// flag plus a short prefix so a flow can be traced without a credential ever
// reaching the log. Toggle with MCP_OAUTH_DEBUG=0 once the flow is settled.
const DEBUG = socialEnv.MCP_OAUTH_DEBUG !== '0';
const _peek = (v) => (v ? `${String(v).slice(0, 6)}…(${String(v).length})` : null);
function olog(stage, obj) {
  if (!DEBUG) return;
  try { console.log(`[mcp-oauth] ${stage} ${JSON.stringify(obj)}`); } catch { /* never throw from a log */ }
}

// Pull the connector key out of a resource URL. Tolerates a trailing slash and
// a query string — clients normalise URLs differently and a strict compare here
// fails the whole handshake for a cosmetic difference.
function keyFromResource(raw) {
  try {
    const p = new URL(String(raw)).pathname.replace(/\/+$/, '');
    return MCP_PATH_RE.exec(p)?.[1] || null;
  } catch { return null; }
}

function mountOAuth(app, { validateKey }) {
  const json = (res, body) => res.set('Cache-Control', 'no-store').json(body);

  // ── Discovery: protected resource ───────────────────────────────────────
  // Wildcard, not hardcoded — the suffix is whatever MCP path the client probed.
  //
  // When that path carries a connector key we advertise a KEY-SPECIFIC issuer
  // (…/api/mcp/oauth/<key>). That is what makes the flow work for clients that
  // do not send the RFC 8707 `resource` parameter: the key travels in the
  // authorize/token URLs themselves, so it can never go missing.
  const protectedResource = (req, res) => {
    const suffix = req.params[0] ? `/${req.params[0]}` : '';
    const key = MCP_PATH_RE.exec(suffix.replace(/\/+$/, ''))?.[1] || null;
    const o = originOf(req);
    olog('discovery.protected-resource', { suffix, keyed: !!key });
    json(res, {
      resource: `${o}${suffix}`,
      authorization_servers: [key ? `${o}/api/mcp/oauth/${key}` : o],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  };
  app.get('/.well-known/oauth-protected-resource/*', protectedResource);
  app.get('/.well-known/oauth-protected-resource', protectedResource);

  // ── Discovery: authorization server ─────────────────────────────────────
  // RFC 8414 inserts the well-known segment between host and issuer path, so a
  // keyed issuer is probed at /.well-known/oauth-authorization-server/api/mcp/
  // oauth/<key>. Echo the endpoints back with the key still embedded.
  const authServer = (req, res) => {
    const o = originOf(req);
    const probed = req.params[0] ? `/${req.params[0]}` : '';
    const key = /^\/api\/mcp\/oauth\/([A-Za-z0-9_-]+)\/?$/.exec(probed)?.[1] || null;
    const base = key ? `${o}/api/mcp/oauth/${key}` : `${o}/api/mcp/oauth`;
    olog('discovery.auth-server', { probed, keyed: !!key });
    json(res, {
      issuer: key ? `${o}/api/mcp/oauth/${key}` : o,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', authServer);
  app.get('/.well-known/oauth-authorization-server/*', authServer);
  app.get('/.well-known/openid-configuration', authServer);
  app.get('/.well-known/openid-configuration/*', authServer);

  // ── Dynamic client registration (RFC 7591) ──────────────────────────────
  // Public clients only: no secret is issued, PKCE is what proves the exchange.
  const registerHandler = (req, res) => {
    const b = req.body || {};
    const redirect_uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    olog('register', { redirect_uris, client_name: b.client_name, keyed: !!req.params.key });
    if (!redirect_uris.length) return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    const bad = redirect_uris.find(u => !redirectAllowed(u));
    if (bad) {
      olog('register.REJECT', { reason: 'redirect_uri not allowed', bad });
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${bad}` });
    }
    json(res.status(201), {
      client_id: `fsmcp_${b64url(crypto.randomBytes(18))}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: typeof b.client_name === 'string' ? b.client_name.slice(0, 120) : 'MCP client',
    });
  };

  // ── Authorize ───────────────────────────────────────────────────────────
  const authorizeHandler = async (req, res) => {
    const q = req.query || {};
    const pathKey = req.params.key || null;
    olog('authorize', {
      pathKey: pathKey ? pathKey.slice(0, 13) + '…' : null,
      response_type: q.response_type, redirect_uri: q.redirect_uri,
      code_challenge_method: q.code_challenge_method, has_challenge: !!q.code_challenge,
      resource: q.resource || '(none)', scope: q.scope, has_state: !!q.state,
    });
    const redirect_uri = String(q.redirect_uri || '');
    // Errors BEFORE redirect_uri is validated must render, not redirect —
    // bouncing an error to an unvalidated URI is an open redirect.
    const deny = (code, desc, status = 400) => {
      olog('authorize.DENY', { code, desc });
      return res.status(status).type('text/plain').send(`${code}: ${desc}`);
    };

    if (!SECRET_OK) return deny('server_error', 'OAuth is not configured on this server.', 500);
    if (!redirectAllowed(redirect_uri)) return deny('invalid_request', `redirect_uri not allowed: ${redirect_uri || '(missing)'}`);

    const bounce = (params) => {
      if (params.error) olog('authorize.REJECT', params);
      const u = new URL(redirect_uri);
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set('state', String(q.state));
      return res.redirect(302, u.toString());
    };

    if (String(q.response_type) !== 'code') return bounce({ error: 'unsupported_response_type' });
    if (String(q.code_challenge_method || '') !== 'S256') return bounce({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
    const code_challenge = String(q.code_challenge || '');
    if (code_challenge.length < 43) return bounce({ error: 'invalid_request', error_description: 'code_challenge is required' });

    // The key comes from the URL path when the client used the keyed issuer,
    // otherwise from the resource parameter. Either is sufficient.
    const key = pathKey || keyFromResource(q.resource);
    if (!key) return bounce({ error: 'invalid_target', error_description: 'Could not determine which connector this is for — the authorize URL must carry the key, or send resource= the full connector URL.' });

    try {
      await validateKey(key);   // exists, enabled, master switch on
    } catch (err) {
      return bounce({ error: 'access_denied', error_description: err.message || 'This connector key is not valid or has been disabled.' });
    }

    const code = b64url(crypto.randomBytes(32));
    const resource = q.resource ? String(q.resource) : `${originOf(req)}/api/mcp/http/${key}`;
    codes.set(code, {
      key, code_challenge, redirect_uri,
      client_id: q.client_id ? String(q.client_id) : null,
      resource, expiresAt: Date.now() + CODE_TTL_MS,
    });
    olog('authorize.OK', { key: key.slice(0, 13) + '…', code_issued: true, codes_in_store: codes.size });
    return bounce({ code });
  };

  // ── Token ───────────────────────────────────────────────────────────────
  // RFC 6749 §4.1.3: the body is application/x-www-form-urlencoded. The app's
  // global parser is express.json() only, so without this parser mounted HERE
  // req.body is silently {} and every field reads undefined — which surfaces as
  // a confusing invalid_grant rather than a parse error.
  const formBody = require('express').urlencoded({ extended: false });
  const tokenHandler = (req, res) => {
    const b = { ...(req.body || {}) };
    olog('token', {
      pathKey: req.params.key ? req.params.key.slice(0, 13) + '…' : null,
      content_type: req.headers['content-type'], body_keys: Object.keys(b),
      grant_type: b.grant_type, has_code: !!b.code, has_verifier: !!b.code_verifier,
      redirect_uri: b.redirect_uri, resource: b.resource, codes_in_store: codes.size,
    });
    const fail = (code, desc, status = 400) => {
      olog('token.REJECT', { error: code, desc });
      return res.status(status).set('Cache-Control', 'no-store').json({ error: code, error_description: desc });
    };

    if (!SECRET_OK) return fail('server_error', 'OAuth is not configured on this server.', 500);

    const grant = String(b.grant_type || '');

    if (grant === 'refresh_token') {
      try {
        const p = jwt.verify(String(b.refresh_token || ''), JWT_SECRET);
        if (p.typ !== 'refresh' || !p.key) return fail('invalid_grant', 'Not a refresh token');
        olog('token.OK', { via: 'refresh' });
        return json(res, issueTokens(p.key, p.resource));
      } catch { return fail('invalid_grant', 'Refresh token is invalid or expired'); }
    }

    if (grant !== 'authorization_code') return fail('unsupported_grant_type', `grant_type '${grant}' is not supported`);

    const code = String(b.code || '');
    const rec = codes.get(code);
    if (!rec) return fail('invalid_grant', 'Authorization code is unknown, already used, or expired');
    codes.delete(code);                                   // single use, always
    if (rec.expiresAt < Date.now()) return fail('invalid_grant', 'Authorization code has expired');
    if (b.redirect_uri && String(b.redirect_uri) !== rec.redirect_uri) return fail('invalid_grant', 'redirect_uri does not match the authorization request');

    const verifier = String(b.code_verifier || '');
    if (!verifier) return fail('invalid_request', 'code_verifier is required');
    if (s256(verifier) !== rec.code_challenge) return fail('invalid_grant', 'PKCE verification failed');

    olog('token.OK', { key: rec.key.slice(0, 13) + '…' });
    return json(res, issueTokens(rec.key, rec.resource));
  };

  // Both shapes are mounted: keyed (preferred — survives a client that omits
  // `resource`) and bare (kept so any client already using it keeps working).
  app.post('/api/social/mcp/oauth/register', registerHandler);
  app.post('/api/social/mcp/oauth/:key/register', registerHandler);
  app.get('/api/social/mcp/oauth/authorize', authorizeHandler);
  app.get('/api/social/mcp/oauth/:key/authorize', authorizeHandler);
  app.post('/api/social/mcp/oauth/token', formBody, tokenHandler);
  app.post('/api/social/mcp/oauth/:key/token', formBody, tokenHandler);

  // A body the global express.json() parser could not read reaches here as a
  // SyntaxError, which the app's generic handler would turn into a 500. An OAuth
  // client must get a spec-shaped error instead — a 500 during token exchange is
  // exactly the confusing failure this shim exists to avoid.
  app.use('/api/social/mcp/oauth', (err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      olog('body.PARSE_FAIL', { ct: req.headers['content-type'] });
      return res.status(400).set('Cache-Control', 'no-store')
        .json({ error: 'invalid_request', error_description: 'Request body could not be parsed.' });
    }
    return next(err);
  });
}

module.exports = { mountOAuth, verifyAccessToken, protectedResourceUrl, redirectAllowed };
