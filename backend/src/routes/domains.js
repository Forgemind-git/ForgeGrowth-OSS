// Custom domains — Admin Settings → Domain.
//
//   publicRouter  (unauthenticated, mounted before authMiddleware)
//       /public/tls-check   GET  — Caddy's on-demand-TLS `ask` endpoint
//
//   router        (mounted under authMiddleware, every route adminOnly)
//       /domains          GET|POST
//       /domains/:id      PATCH|DELETE
//       /domains/status   GET  — what the browser used vs what is configured
//
// The `ask` endpoint is the security boundary for on-demand certificates.
// Without it, anyone who pointed any hostname at this server could make it
// request a certificate on their behalf, and the resulting failures would burn
// the install's Let's Encrypt rate limit. With it, Caddy issues only for names
// an admin has explicitly added.

const { Router } = require('express');
const { adminOnly } = require('../middleware/access');
const { cookieSecure } = require('../util/session');
const domains = require('../services/domainService');

/* ============================ public router ============================ */

const publicRouter = Router();

// Caddy calls this once per unknown hostname, before it will ask a certificate
// authority for anything: GET /api/public/tls-check?domain=crm.example.com
//
// 200 means "yes, issue for that". Anything else means no. It returns no body
// on purpose — Caddy reads only the status, and a body would be one more thing
// to keep in step. Failing closed is deliberate: a database that cannot be
// reached must not become an open invitation to issue certificates.
publicRouter.get('/public/tls-check', async (req, res) => {
  const host = domains.normalizeHostname(req.query.domain || '');
  if (!host) return res.status(400).end();
  try {
    const ok = await domains.isApproved(host);
    if (ok) domains.stampAsked(host);
    return res.status(ok ? 200 : 403).end();
  } catch (err) {
    console.error('[domains] tls-check failed:', err.message);
    return res.status(503).end();
  }
});

/* ============================= admin router ============================= */

const router = Router();

router.get('/domains', adminOnly, async (req, res) => {
  try {
    res.json({ domains: await domains.listDomains() });
  } catch (err) {
    console.error('[domains] list error:', err.message);
    res.status(500).json({ error: 'Failed to load domains' });
  }
});

// What this install currently believes about its own address, and what the
// browser making THIS request actually used. Reported together because every
// address problem worth reporting is a disagreement between the two, and neither
// value alone tells you anything is wrong.
router.get('/domains/status', adminOnly, async (req, res) => {
  try {
    const requestHost = domains.normalizeHostname(
      req.headers['x-forwarded-host'] || req.headers.host || ''
    );
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket && req.socket.encrypted ? 'https' : 'http');

    const corsOrigin = String(process.env.CORS_ORIGIN || '').trim();
    const tlsDomain = String(process.env.TLS_DOMAIN || '').trim();
    const secureCookies = cookieSecure();
    const approved = requestHost ? await domains.isApproved(requestHost) : false;
    const configured = corsOrigin
      .split(',')
      .map((s) => domains.normalizeHostname(s))
      .filter(Boolean);

    const warnings = [];

    // The one that presents as "it logs me out on every refresh". The cookie is
    // marked Secure, the browser silently discards it over plain HTTP, login
    // returns 200 and the next request is a 401 — with nothing in any log.
    if (secureCookies && proto === 'http') {
      warnings.push({
        level: 'error',
        title: 'Signing in will not work at this address',
        detail: 'You are on http://, but the login cookie is marked Secure, so your '
              + 'browser throws it away. Sign-in appears to succeed and the next click '
              + 'returns Unauthorized. Reach this site over https://, or reinstall '
              + 'without an https address.',
      });
    }

    // CORS is read from .env once at startup, so an address missing from it
    // fails as a generic 500 rather than as anything mentioning CORS.
    if (requestHost && !configured.includes(requestHost) && !approved) {
      warnings.push({
        level: 'error',
        title: 'This address is not on the allow-list',
        detail: `Browser requests from ${requestHost} will be refused by the API. `
              + 'Add it below and it works immediately — no restart needed.',
      });
    }

    // Which of the two kinds of server this is, decided by install.sh: does this
    // install own ports 80/443, or does something else? It changes what adding a
    // domain here actually achieves, so the screen must not describe both the
    // same way. Defaulting to 'proxy' is the cautious direction — an install
    // upgraded from before this existed has no TLS_MODE, and promising automatic
    // certificates it cannot deliver would be the worse error.
    const tlsMode = String(process.env.TLS_MODE || '').trim() === 'caddy' ? 'caddy' : 'proxy';

    if (!tlsDomain && proto !== 'https') {
      warnings.push({
        level: 'warn',
        title: 'No HTTPS',
        detail: 'Meta will not accept a webhook address that is not https://, and public '
              + 'form links are built as https://. '
              + (tlsMode === 'caddy'
                ? 'Add a domain below and point its DNS here — the certificate is obtained '
                + 'on the first visit.'
                : 'Something else on this server owns ports 80 and 443, so add the domain '
                + 'below and then point that reverse proxy at this install.'),
      });
    }

    res.json({
      requestHost,
      protocol: proto,
      secureCookies,
      corsOrigin,
      tlsDomain: tlsDomain || null,
      tlsMode,
      approved,
      warnings,
    });
  } catch (err) {
    console.error('[domains] status error:', err.message);
    res.status(500).json({ error: 'Failed to read the address settings' });
  }
});

// Does this domain actually reach this install? Everything else on this screen
// reports configuration; this one reports the outcome, which is the only thing
// that distinguishes "set up" from "working". POST rather than GET because it
// makes a real outbound request and stamps a row — it is not a cacheable read.
//
// Slow by nature (up to two attempts, eight seconds each), so it is a button an
// admin presses rather than something the page does on load.
router.post('/domains/:id/check', adminOnly, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Unknown domain' });
  }
  try {
    const result = await domains.checkDomainById(req.params.id);
    if (!result) return res.status(404).json({ error: 'Domain not found' });
    res.json(result);
  } catch (err) {
    console.error('[domains] check error:', err.message);
    res.status(500).json({ error: 'Could not check that domain' });
  }
});

router.post('/domains', adminOnly, async (req, res) => {
  try {
    const row = await domains.addDomain(req.body?.hostname, req.user?.id);
    res.status(201).json(row);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[domains] add error:', err.message);
    res.status(500).json({ error: 'Failed to add the domain' });
  }
});

router.patch('/domains/:id', adminOnly, async (req, res) => {
  try {
    const row = await domains.setActive(req.params.id, req.body?.isActive);
    if (!row) return res.status(404).json({ error: 'Domain not found' });
    res.json(row);
  } catch (err) {
    console.error('[domains] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the domain' });
  }
});

router.delete('/domains/:id', adminOnly, async (req, res) => {
  try {
    const ok = await domains.removeDomain(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Domain not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[domains] delete error:', err.message);
    res.status(500).json({ error: 'Failed to remove the domain' });
  }
});

module.exports = { router, publicRouter, ensureDomainTables: domains.ensureDomainTables };
