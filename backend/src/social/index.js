const socialEnv = require('./env');
// ============================================================
// index.js — ForgeSocial Express Server
// ============================================================
// (env is loaded by ForgeGrowth's index.js)
const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');

const pool = require('./db');
const { router: authRouter, authMiddleware, adminOnly, ensureTables } = require('./auth');
const mockService = require('./mockService');
const instagram = require('./instagram');
const messenger = require('./messenger');
const youtube   = require('./youtube');
const facebook  = require('./facebook');
const threads   = require('./threads');
const linkedin  = require('./linkedin');
const syncService = require('./syncService');
const publishService = require('./publishService');
const backfillService = require('./backfillService');
const accounts = require('./accounts');
const tokenService = require('./tokenService');
const mcpService = require('./mcpService');
const reportData = require('./reportData');
const categorize = require('./categorize');
const insightsService = require('./insightsService');
const notificationService = require('./notificationService');
const { mcpHttpHandler } = require('./mcpHttp');
const agentService = require('./services/agentService');
const agentEngine = require('./engine/agentEngine');
const agentDispatch = require('./services/agentDispatch');
const cron = require('node-cron');

// ── Period scaling helper (fallback snapshots are 30D; scale for other periods)
function scaleForPeriod(data, period) {
  const info = mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D'];
  const mult = info.mult;
  if (mult === 1 || !data) return data;

  const scaled = { ...data };

  // Scale period-absolute metrics
  const scaleNum = (n) => (n == null ? n : Math.round(n * mult));
  if (scaled.impressions != null) scaled.impressions = scaleNum(scaled.impressions);
  if (scaled.reach != null) scaled.reach = scaleNum(scaled.reach);
  if (scaled.clicks != null) scaled.clicks = scaleNum(scaled.clicks);
  if (scaled.posts != null) scaled.posts = Math.max(1, scaleNum(scaled.posts));
  if (scaled.growth != null) scaled.growth = scaleNum(scaled.growth);
  if (scaled.scaledGrowth != null) scaled.scaledGrowth = scaleNum(scaled.scaledGrowth);

  // Scale extras values (unless marked raw, e.g. "4:32", "12.4%")
  if (Array.isArray(scaled.extras)) {
    scaled.extras = scaled.extras.map(e => ({
      ...e,
      value: e.raw || typeof e.value !== 'number' ? e.value : scaleNum(e.value),
    }));
  }

  // Filter topPosts by date for shorter periods (lifetime metrics stay as-is)
  if (Array.isArray(scaled.topPosts) && info.days < 30) {
    const cutoff = Date.now() - info.days * 86400000;
    scaled.topPosts = scaled.topPosts.filter(p => {
      const ts = p.timestamp ? new Date(p.timestamp).getTime() : 0;
      return ts >= cutoff;
    });
  }

  // Slice trend arrays to requested period width
  if (Array.isArray(scaled.trend)) {
    scaled.trend = scaled.trend.slice(-info.trendSlice);
  }
  if (Array.isArray(scaled.trendDays)) {
    scaled.trendDays = scaled.trendDays.slice(-info.trendSlice);
  }

  return scaled;
}

const app  = express();

// Mounted inside ForgeGrowth (mounted by ForgeGrowth's src/index.js): helmet, CORS,
// cookie parsing and trust-proxy are the parent app's. This sub-app parses its
// OWN bodies because the parent is mounted before ForgeGrowth's 1mb JSON parser:
// the Instagram webhook needs the raw bytes to verify X-Hub-Signature-256.
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Static uploads ───────────────────────────────────────────
// Served under /api/uploads so Traefik (which only routes /api to the backend)
// reaches it. Mounted before authMiddleware → public, no token required.
const UPLOADS_DIR = socialEnv.UPLOADS_DIR || '/app/uploads';
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/api/social/uploads', express.static(UPLOADS_DIR));

// ── Media upload (multer disk storage, 20MB/file, images + videos) ──
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    /^(image|video)\//.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only image and video files are allowed')),
});
// Wrap so multer errors return friendly JSON instead of hitting the 500 handler
function uploadMedia(req, res, next) {
  mediaUpload.array('files', 10)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 20MB' : err.message;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// ── Public routes ────────────────────────────────────────────
app.get('/api/social/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/social/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Failed to load settings' }); }
});

app.use('/api/social/auth', authRouter);

// ── MCP remote transport (public — the API key in the path IS the auth) ─
// Streamable HTTP endpoint external MCP clients (Claude web/desktop/mobile)
// connect to. Key is validated + capability-gated per request in mcpHttp.js;
// the master switch in Settings → MCP Access rejects everything when off.
app.all('/api/social/mcp/http/:key', mcpHttpHandler);

// The OAuth shim for this MCP endpoint is NOT mounted here: its discovery
// documents live at the protocol-fixed /.well-known/* paths, which ForgeGrowth's
// own MCP already owns. The key-in-URL transport above needs no OAuth.

// ── Public shared report (the token in the path IS the auth) ─────────
// A read-only report snapshot anyone with the link can open. DB-only assembly
// (same as the in-app report), zero platform calls.
app.get('/api/social/public/report/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT platforms, from_date AS "from", to_date AS "to" FROM report_shares WHERE token = $1`, [req.params.token]);
    if (!rows[0]) return res.status(404).json({ error: 'This report link is invalid or has been revoked.' });
    const data = await reportData.assembleReportData({ platforms: rows[0].platforms, from: rows[0].from, to: rows[0].to });
    const summaries = data.platforms.map(p => reportData.summarizePlatform(p, data.rangeDays));
    res.json({ range: { from: data.from, to: data.to, days: data.rangeDays }, generatedAt: data.generatedAt, platforms: summaries, shared: true });
  } catch (err) {
    console.error('Public report error:', err);
    res.status(500).json({ error: 'Failed to load the shared report' });
  }
});

// ── Facebook OAuth callback (public — Facebook redirects here) ─
app.get('/api/social/facebook/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/#/social/integrations/facebook?fb_error=${encodeURIComponent(error)}`);
  if (!code)  return res.status(400).send('Missing OAuth code');
  try {
    if (state === 'fb_add') {
      const r = await accounts.addAccountFromCode('facebook', code);
      _triggerBackgroundSync('facebook');
      // A grant that only carried the primary Page is a reconnect, not an add — say so.
      const added = r.count - (r.reconnectedPrimary ? 1 : 0);
      if (!added) return res.redirect('/#/social/integrations/facebook?fb_connected=1');
      return res.redirect(`/#/social/integrations/facebook?fb_added=${encodeURIComponent(r.label || '1')}`);
    }
    await facebook.exchangeCode(code);
    _triggerBackgroundSync('facebook');
    res.redirect('/#/social/integrations/facebook?fb_connected=1');
  } catch (err) {
    console.error('Facebook OAuth callback error:', err.message);
    res.redirect(`/#/social/integrations/facebook?fb_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Threads OAuth callback + webhook verification (public) ───
app.get('/api/social/threads/callback', async (req, res) => {
  // Meta webhook verification challenge
  if (req.query['hub.mode'] === 'subscribe') {
    // No built-in fallback: with no token configured the handshake is refused.
    const verifyToken = socialEnv.THREADS_WEBHOOK_VERIFY_TOKEN || socialEnv.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
    if (verifyToken && req.query['hub.verify_token'] === verifyToken) {
      return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    return res.status(403).send('Forbidden');
  }
  // OAuth code exchange
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/#/social/integrations/threads?th_error=${encodeURIComponent(error)}`);
  if (!code)  return res.status(200).send('OK'); // webhook POST events land here too
  try {
    if (state === 'th_add') {
      const r = await accounts.addAccountFromCode('threads', code);
      return res.redirect(`/#/social/integrations/threads?th_added=${encodeURIComponent(r.label || '1')}`);
    }
    await threads.exchangeCode(code);
    res.redirect('/#/social/integrations/threads?th_connected=1');
  } catch (err) {
    console.error('Threads OAuth callback error:', err.message);
    res.redirect(`/#/social/integrations/threads?th_error=${encodeURIComponent(err.message)}`);
  }
});

// Meta webhook POST events (data deletion, user creation) — just acknowledge
app.post('/api/social/threads/callback', (req, res) => res.sendStatus(200));

// ── LinkedIn OAuth callback (public — LinkedIn redirects here) ─
app.get('/api/social/linkedin/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect(`/#/social/integrations/linkedin?li_error=${encodeURIComponent(error)}`);
  if (!code)  return res.status(400).send('Missing OAuth code');
  try {
    if (state === 'li_add') {
      const r = await accounts.addAccountFromCode('linkedin', code);
      return res.redirect(`/#/social/integrations/linkedin?li_added=${encodeURIComponent(r.label || '1')}`);
    }
    await linkedin.exchangeCode(code);
    res.redirect('/#/social/integrations/linkedin?li_connected=1');
  } catch (err) {
    console.error('LinkedIn OAuth callback error:', err.message);
    res.redirect(`/#/social/integrations/linkedin?li_error=${encodeURIComponent(err.message)}`);
  }
});

// ── YouTube OAuth callback (public — Google redirects here) ──
app.get('/api/social/youtube/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) {
    return res.redirect(`/#/social/integrations/youtube?yt_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.status(400).send('Missing OAuth code');
  }
  try {
    if (state === 'yt_add') {
      // "Add account" → append a new channel rather than overwrite the primary.
      const r = await accounts.addAccountFromCode('youtube', code);
      return res.redirect(`/#/social/integrations/youtube?yt_added=${encodeURIComponent(r.label || '1')}`);
    }
    await youtube.exchangeCode(code);
    res.redirect('/#/social/integrations/youtube?yt_connected=1');
  } catch (err) {
    console.error('YouTube OAuth callback error:', err.message);
    res.redirect(`/#/social/integrations/youtube?yt_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Instagram webhook (public — Meta calls this) ─────────────
// GET  = one-time verification handshake (App Dashboard → Webhooks)
// POST = live message + comment events (signature-verified, then stored)
app.get('/api/social/instagram/webhook', (req, res) => {
  // No built-in fallback: with no token configured the handshake is refused.
  const verifyToken = socialEnv.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
  if (verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    console.log('[ig-webhook] verification handshake OK (token matched)');
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  if (req.query['hub.mode']) {
    console.warn(verifyToken
      ? '[ig-webhook] verification FAILED — token mismatch'
      : '[ig-webhook] verification refused — no webhook verify token is set');
  }
  return res.status(403).send('Forbidden');
});

app.post('/api/social/instagram/webhook', async (req, res) => {
  const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  const sig = instagram.verifyWebhookSignature(req.rawBody, req.headers['x-hub-signature-256']);
  if (!sig.ok) {
    console.warn('[ig-webhook] rejected:', sig.reason);
    instagram.logWebhookEvent(req.body, { remoteIp, signatureOk: false }).catch(() => {});
    return res.sendStatus(403);
  }
  try {
    // A Facebook Page subscription pointed at this URL delivers Messenger
    // events (object === 'page'); those belong to Social → Messenger, not the
    // Instagram DM tables.
    if (req.body?.object === 'page') {
      instagram.logWebhookEvent(req.body, { remoteIp, signatureOk: true }).catch(() => {});
      const r = await messenger.handleWebhook(req.body);
      console.log(`[ig-webhook] page object → messenger: ${r.messages} message(s)`);
    } else {
      const r = await instagram.handleWebhook(req.body, { remoteIp });
      console.log(`[ig-webhook] stored ${r.messages} message(s), ${r.comments} comment(s)`);
    }
  } catch (err) {
    console.error('[ig-webhook] error:', err.message);
  }
  // Always 200 on a verified delivery so Meta doesn't disable the subscription.
  return res.sendStatus(200);
});

// ── Facebook Messenger webhook (public — Meta calls this) ────
// Point the Meta app's "Page" webhook here, fields messages + message_echoes +
// message_reads. Same verify token and signature check as the Instagram one.
app.get('/api/social/messenger/webhook', (req, res) => {
  const verifyToken = socialEnv.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
  if (verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  return res.status(403).send('Forbidden');
});
app.post('/api/social/messenger/webhook', async (req, res) => {
  const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;
  const sig = instagram.verifyWebhookSignature(req.rawBody, req.headers['x-hub-signature-256']);
  if (!sig.ok) {
    console.warn('[messenger-webhook] rejected:', sig.reason);
    instagram.logWebhookEvent(req.body, { remoteIp, signatureOk: false }).catch(() => {});
    return res.sendStatus(403);
  }
  instagram.logWebhookEvent(req.body, { remoteIp, signatureOk: true }).catch(() => {});
  try {
    if (req.body?.object === 'page') await messenger.handleWebhook(req.body);
  } catch (err) {
    console.error('[messenger-webhook] error:', err.message);
  }
  return res.sendStatus(200);
});

// ── Meta data-deletion & deauthorize callbacks (public, signed_request) ──
// Friendly GET responses so a browser / Meta reachability check sees the URL as live
// (the real callbacks are POST with a signed_request).
app.get('/api/social/instagram/deletion', (req, res) =>
  res.set('Content-Type', 'text/html').send(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px">' +
    '<h2>ForgeSocial — Instagram Data Deletion</h2><p>This endpoint is live. It accepts <b>POST</b> data-deletion callbacks ' +
    'from Meta (with a signed_request). To request deletion of your data, remove ForgeSocial from your Instagram/Facebook ' +
    'app settings, or contact the workspace admin.</p></body>'));
app.get('/api/social/instagram/deauthorize', (req, res) =>
  res.send('ForgeSocial deauthorize endpoint is live (accepts POST callbacks from Meta).'));

app.post('/api/social/instagram/deauthorize', (req, res) => {
  const data = instagram.parseSignedRequest(req.body?.signed_request);
  console.log('[ig-deauth] user:', data?.user_id || '(unverified)');
  res.sendStatus(200);
});

app.post('/api/social/instagram/deletion', async (req, res) => {
  try {
    const data = instagram.parseSignedRequest(req.body?.signed_request);
    if (!data) return res.status(400).json({ error: 'Invalid signed_request' });
    const code = await instagram.handleDataDeletion(data.user_id);
    console.log('[ig-deletion] user:', data.user_id, 'code:', code);
    res.json({
      url: `${socialEnv.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/social/instagram/deletion-status?code=${code}`,
      confirmation_code: code,
    });
  } catch (err) {
    console.error('[ig-deletion] error:', err.message);
    res.status(500).json({ error: 'Deletion request failed' });
  }
});

app.get('/api/social/instagram/deletion-status', async (req, res) => {
  const { code } = req.query;
  const { rows } = await pool.query(
    'SELECT status, requested_at FROM instagram_deletion_requests WHERE code = $1', [code]);
  if (!rows[0]) return res.status(404).send('Unknown deletion request');
  res.set('Content-Type', 'text/html').send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Data Deletion Status</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#111">` +
    `<h2>ForgeSocial — Data Deletion Request</h2>` +
    `<p>Confirmation code: <b>${rows[0] ? code : ''}</b></p>` +
    `<p>Status: <b>${rows[0].status}</b></p>` +
    `<p>The Instagram message and comment data associated with your account that was held by ForgeSocial has been deleted.</p>` +
    `</body></html>`
  );
});

// ── Instagram Login OAuth callback (public — Instagram redirects here) ──
app.get('/api/social/instagram/oauth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.redirect(`/#/social/integrations/instagram?ig_error=${encodeURIComponent(error_description || error)}`);
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const r = await instagram.exchangeOAuthCode(code);
    console.log('[ig-oauth] connected:', r.username || r.accountId);
    res.redirect(`/#/social/integrations/instagram?ig_connected=${encodeURIComponent(r.username || '1')}`);
  } catch (err) {
    console.error('[ig-oauth] callback error:', err.message);
    res.redirect(`/#/social/integrations/instagram?ig_error=${encodeURIComponent(err.message)}`);
  }
});

// Tracked link buttons in automation DMs (public: the person tapping isn't logged in).
app.get('/api/social/ig-automations/r/:token', async (req, res) => {
  try {
    const url = await require('./services/commentAutomation').resolveLink(req.params.token);
    if (!url) return res.status(404).send('This link has expired.');
    res.redirect(302, url);
  } catch (err) {
    console.error('[ig-automations] redirect:', err.message);
    res.status(500).send('Something went wrong.');
  }
});

// ── Protected routes ─────────────────────────────────────────
app.use('/api/social', authMiddleware);

// ManyChat-style IG automations (comment → reply + DM, keyword DMs, button taps)
app.use('/api/social/ig-automations', require('./commentAutomationRoutes'));
// ManyChat-style contacts: custom/system fields, segments, bulk actions, profile (contactsCrm.js)
app.use('/api/social/crm', require('./contactsCrm'));
// Per-user "My accounts" preset used as every page's default platform/account filter (userScope.js)
app.use('/api/social/me/scope', require('./userScope'));
// Comment Analyzer (TypeSafe Jev via OpenRouter) + OpenRouter key / spend (commentAnalyzerRoutes.js)
// Negative-comment alerts → Telegram (must sit above the analyzer router, which owns the prefix)
app.use('/api/social/comment-analyzer/alerts', require('./telegramRoutes').alertsRouter);
app.use('/api/social/comment-analyzer', require('./commentAnalyzerRoutes').analyzerRouter);
// Telegram bot: token, who may contact it, chat viewer (telegramRoutes.js)
app.use('/api/social/telegram', require('./telegramRoutes').telegramRouter);
app.use('/api/social/openrouter', require('./commentAnalyzerRoutes').openRouterRouter);
// "Receive Instagram DMs" settings card (link Pages to the ForgeSocial Meta app)
app.use('/api/social/meta-link', require('./metaPageLinkRoutes'));
// App credentials (Meta / Instagram / Threads / Google / LinkedIn keys) entered
// in Settings → Integrations instead of the server's env file. Admin only;
// secrets never come back — only whether they are set and their last 4.
function credentialUrls() {
  const base = String(socialEnv.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return {
    instagramRedirect: base + '/api/social/instagram/oauth/callback',
    facebookRedirect: base + '/api/social/facebook/callback',
    threadsRedirect: base + '/api/social/threads/callback',
    youtubeRedirect: base + '/api/social/youtube/callback',
    linkedinRedirect: base + '/api/social/linkedin/callback',
    instagramWebhook: base + '/api/social/instagram/webhook',
    privacyPolicy: base + '/#/social-privacy',
  };
}
app.get('/api/social/credentials', adminOnly, async (req, res) => {
  try {
    const credentials = require('./credentials');
    await credentials.load();
    res.json({ credentials: credentials.status(), urls: credentialUrls(),
      canSaveSecrets: !!socialEnv.FORGESOCIAL_ENCRYPTION_KEY });
  } catch (err) {
    console.error('[social] credentials read:', err.message);
    res.status(500).json({ error: 'Could not read the app credentials' });
  }
});
app.put('/api/social/credentials', adminOnly, async (req, res) => {
  try {
    const credentials = require('./credentials');
    const status = await credentials.save(req.body?.values);
    logActivity(req, 'credentials.update', 'settings', null, { keys: Object.keys(req.body?.values || {}) });
    res.json({ credentials: status, urls: credentialUrls(),
      canSaveSecrets: !!socialEnv.FORGESOCIAL_ENCRYPTION_KEY });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save the app credentials' });
  }
});

// ── MCP access management (admin) ────────────────────────────
// Settings (master switch + capability toggles), bearer API keys (plaintext
// shown once — only the SHA-256 hash is stored), and connector install info.
app.get('/api/social/mcp/settings', adminOnly, async (req, res) => {
  try { res.json(await mcpService.loadSettings()); }
  catch (err) {
    console.error('[mcp] settings get error:', err.message);
    res.status(500).json({ error: 'Failed to load MCP settings' });
  }
});

app.put('/api/social/mcp/settings', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await mcpService.loadSettings();
    const masterEnabled = b.masterEnabled !== undefined ? !!b.masterEnabled : cur.masterEnabled;
    const caps = { ...cur.capabilities };
    if (b.capabilities && typeof b.capabilities === 'object') {
      for (const k of mcpService.CAPABILITY_KEYS) {
        if (b.capabilities[k] !== undefined) caps[k] = !!b.capabilities[k];
      }
    }
    await pool.query(
      `UPDATE mcp_settings SET master_enabled = $1, capabilities = $2, updated_at = NOW() WHERE id = 1`,
      [masterEnabled, JSON.stringify(caps)]);
    res.json(await mcpService.loadSettings());
  } catch (err) {
    console.error('[mcp] settings put error:', err.message);
    res.status(500).json({ error: 'Failed to update MCP settings' });
  }
});

function mcpKeyShape(r) {
  return {
    id: r.id, label: r.label, keyPrefix: r.key_prefix, keyLast4: r.key_last4,
    isEnabled: r.is_enabled, lastUsedAt: r.last_used_at, createdAt: r.created_at,
    // null/null = the key sees every account; both set = locked to that one.
    scopePlatform: r.scope_platform || null,
    scopeAccountId: r.scope_account_id || null,
  };
}

// Accounts an MCP key can be locked to (the scope picker's options).
app.get('/api/social/mcp/accounts', adminOnly, async (req, res) => {
  try {
    res.json(await mcpService.listConnectedAccounts());
  } catch (err) {
    console.error('[mcp] scope accounts error:', err.message);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// Validate a requested scope. Returns [platform, accountId] — [null, null] for
// "all accounts". Throws a 400-shaped error when the account isn't connected, so
// a key can never be locked to an account that doesn't exist.
async function resolveKeyScope(body) {
  const platform = body?.scopePlatform ? String(body.scopePlatform).trim().toLowerCase() : null;
  const accountId = body?.scopeAccountId ? String(body.scopeAccountId).trim() : null;
  if (!platform || !accountId) return [null, null];
  const { accounts: list } = await mcpService.listConnectedAccounts();
  const hit = list.find(a => a.platform === platform && String(a.accountId) === accountId);
  if (!hit) { const e = new Error('That account is not connected — pick one from the list.'); e.status = 400; throw e; }
  return [platform, accountId];
}

app.get('/api/social/mcp/keys', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mcp_api_keys ORDER BY created_at DESC');
    res.json(rows.map(mcpKeyShape));
  } catch (err) {
    console.error('[mcp] keys list error:', err.message);
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

app.post('/api/social/mcp/keys', adminOnly, async (req, res) => {
  try {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'A label is required' });
    const [scopePlatform, scopeAccountId] = await resolveKeyScope(req.body);
    const plain = 'fsk_live_' + require('crypto').randomBytes(24).toString('base64url');
    const { rows } = await pool.query(
      `INSERT INTO mcp_api_keys (label, key_prefix, key_last4, key_hash, created_by, scope_platform, scope_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [label, plain.slice(0, 13), plain.slice(-4), mcpService.hashApiKey(plain), req.user?.id || null,
       scopePlatform, scopeAccountId]);
    res.status(201).json({ ...mcpKeyShape(rows[0]), key: plain });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[mcp] key create error:', err.message);
    res.status(500).json({ error: 'Failed to create key' });
  }
});

app.put('/api/social/mcp/keys/:id', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], params = [];
    if (b.label !== undefined) { params.push(String(b.label).trim()); sets.push(`label = $${params.length}`); }
    if (b.isEnabled !== undefined) { params.push(!!b.isEnabled); sets.push(`is_enabled = $${params.length}`); }
    // Scope is re-pointed as a pair — sending scopePlatform:null clears it back
    // to "all accounts". Takes effect on the connector's very next request.
    if (b.scopePlatform !== undefined || b.scopeAccountId !== undefined) {
      const [sp, sa] = await resolveKeyScope(b);
      params.push(sp); sets.push(`scope_platform = $${params.length}`);
      params.push(sa); sets.push(`scope_account_id = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE mcp_api_keys SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(mcpKeyShape(rows[0]));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[mcp] key update error:', err.message);
    res.status(500).json({ error: 'Failed to update key' });
  }
});

app.delete('/api/social/mcp/keys/:id', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM mcp_api_keys WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mcp] key delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete key' });
  }
});

app.get('/api/social/mcp/install', adminOnly, (req, res) => {
  // Rule 9: hand out the DIRECT (non-Cloudflare) host only. The request may
  // well have arrived on the Cloudflare-fronted domain — echoing that back
  // would have the admin paste a connector URL whose post-OAuth call gets
  // dropped, which surfaces as "couldn't connect to the server".
  const reqHost = req.headers['x-forwarded-host'] || req.headers.host || '';
  const host = socialEnv.MCP_DIRECT_HOST || reqHost;
  res.json({
    remoteUrl: `https://${host}/api/mcp/http/<YOUR_KEY>`,
    directHost: host,
    proxiedHost: socialEnv.MCP_DIRECT_HOST && reqHost !== host ? reqHost : null,
    note: socialEnv.MCP_DIRECT_HOST
      ? `Use ${host} for connectors — it bypasses the CDN in front of the dashboard domain, which drops the request Claude makes after authorizing.`
      : null,
  });
});

// Start the Instagram Login OAuth flow (any signed-in user, so the reviewer can connect)
app.get('/api/social/instagram/oauth/init', (req, res) => {
  try { res.json({ url: instagram.getOAuthUrl() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Overview — computed from stored sync_snapshots
app.get('/api/social/overview', async (req, res) => {
  try {
    const { period = '30D' } = req.query;
    const info = mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D'];
    // Near-realtime: kick a throttled background refresh of this period (fire-and-forget)
    syncService.revalidate(period).catch(() => {});
    // Per-platform roll-up uses each platform's PRIMARY account snapshot (consistent
    // with the Overview's per-account view), falling back to its legacy snapshot.
    let snapshots = [];
    for (const key of accounts.PLATFORMS) {
      const snaps = await syncService.getAccountSnapshots(key, period);
      if (!snaps.length) continue;
      const accountSnaps = snaps.filter(s => s.account_key);
      let chosen;
      if (accountSnaps.length) {
        const primaryId = await accounts.resolvePrimaryId(key, accountSnaps.map(s => s.data?.accountId || s.account_key));
        chosen = accountSnaps.find(s => (s.data?.accountId || s.account_key) === primaryId) || accountSnaps[0];
      } else {
        chosen = snaps[0];   // legacy/null-account snapshot
      }
      snapshots.push({ platform: key, data: chosen.data, fetched_at: chosen.fetched_at });
    }
    let isFallback = false;

    // Fallback to latest snapshots of any period if none for requested period
    if (!snapshots.length) {
      const { rows: fallback } = await pool.query(`
        SELECT DISTINCT ON (platform) platform, data, fetched_at, period as snap_period
        FROM sync_snapshots
        ORDER BY platform, fetched_at DESC
      `);
      snapshots = fallback;
      isFallback = true;
    }

    if (!snapshots.length) {
      return res.json({ period, synced: false, periodInfo: info, kpis: [], platforms: [], trendDays: [] });
    }
    let totalAudience = 0, totalGrowth = 0, totalImpressions = 0, totalEngRate = 0, count = 0;
    const platforms = [];
    const platformBreakdown = [];

    for (const snap of snapshots) {
      const d = isFallback ? scaleForPeriod(snap.data, period) : snap.data;
      totalAudience += d.followers || 0;
      totalGrowth += d.growth || 0;
      totalImpressions += d.impressions || 0;
      totalEngRate += d.engagementRate || 0;
      count++;
      platforms.push({
        key: snap.platform,
        ...mockService.PLATFORMS[snap.platform],
        trend: d.trend || [],
      });
      // Transparency: exactly which platforms (and how fresh) make up each KPI sum.
      platformBreakdown.push({
        key: snap.platform,
        name: mockService.PLATFORMS[snap.platform]?.name || snap.platform,
        followers: d.followers || 0,
        growth: d.growth || 0,
        impressions: d.impressions || 0,
        engagementRate: d.engagementRate || 0,
        lastSyncAt: snap.fetched_at,
        estimated: isFallback,
      });
    }

    const avgEngRate = count > 0 ? parseFloat((totalEngRate / count).toFixed(1)) : 0;
    const trendDays = platforms[0]?.trend?.map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (platforms[0].trend.length - 1 - i));
      return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
    }) || [];

    const lastSyncAt = snapshots.reduce(
      (m, s) => (!m || new Date(s.fetched_at) > new Date(m)) ? s.fetched_at : m, null);

    res.json({
      period,
      synced: true,
      lastSyncAt,
      periodInfo: info,
      // True when no snapshot existed for this period and numbers were scaled
      // from another period's snapshot — estimates, not platform-reported values.
      estimated: isFallback,
      platformBreakdown,
      kpis: [
        { label: 'Total Audience', value: totalAudience, delta: count > 0 ? parseFloat((totalGrowth / Math.max(totalAudience - totalGrowth, 1) * 100).toFixed(1)) : 0, deltaLabel: `+${totalGrowth} in ${info.days}d`, positive: true, info: 'Combined followers and subscribers across all connected social platforms.' },
        { label: 'Net Growth', value: totalGrowth, delta: 0, deltaLabel: `vs prev. ${info.days}d`, positive: true, info: 'Net increase in total audience across all platforms during the selected period.' },
        { label: 'Total Impressions', value: totalImpressions, delta: 0, deltaLabel: `vs prev. ${info.days}d`, positive: true, info: 'Total number of times your content was displayed to users across all platforms.' },
        { label: 'Avg. Eng. Rate', value: avgEngRate, delta: 0, deltaLabel: `vs prev. ${info.days}d`, positive: true, suffix: '%', info: 'Average percentage of viewers who engaged with your content (likes, comments, shares, clicks).' },
      ],
      platforms,
      trendDays,
    });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// Platform stats — read from DB snapshot only
// Overlay the permanent, localized thumbnail (from the posts table) onto a
// snapshot's topPosts. Snapshots froze the platform's signed CDN URL at sync
// time (IG/Threads/FB ones expire); the posts table holds the downloaded copy
// under /api/uploads. Join on (platform key, external_id); leaves mock posts —
// whose ids never match a posts row — untouched so they fall back to the glyph.
// Snapshot topPosts are the platform's BEST posts — and some platforms (notably
// YouTube) return them ranked by score/views REGARDLESS of date, so a top video
// from months/a year ago can appear under a "7-day window" label, shown with a
// year-less date ("9 Jun") that makes it look recent. Scope topPosts to the
// selected period by each post's real `timestamp`, and re-stamp the display
// `date` WITH the year so it can never be mistaken for a recent post. Posts with
// no parseable timestamp (mock/legacy) are kept as-is.
function scopeTopPostsToWindow(data, period) {
  if (!data || !Array.isArray(data.topPosts)) return data;
  const days = (mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D']).days;
  const cutoff = Date.now() - days * 86400000;
  const withYear = (ts) => {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  };
  data.topPosts = data.topPosts
    .filter(p => {
      const t = p && p.timestamp ? new Date(p.timestamp).getTime() : NaN;
      return isNaN(t) ? true : t >= cutoff;
    })
    .map(p => {
      if (!p || !p.timestamp) return p;
      const d = withYear(p.timestamp);
      return d ? { ...p, date: d } : p;
    });
  return data;
}

// The DEFINITIVE source of a platform's top posts: the `posts` table (the same
// single source the Content Library, Performance page and reports use), filtered
// to the period window by the real DATE column (which always carries the year).
// This eliminates the "year-old post shown under a 7-day window" class of bug for
// EVERY platform — the frozen snapshot topPosts could rank all-time bests
// regardless of date. Account-scoped leniently because YT/Threads rows often have
// a NULL account_key. Returns [] if nothing in window (caller keeps its fallback).
async function topPostsFromTable(platformKey, accountKey, period, limit = 6) {
  const days = (mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D']).days;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const params = [platformKey, cutoff];
  let acctClause = '';
  if (accountKey && accountKey !== 'all') {
    params.push(accountKey);
    acctClause = `AND (p.account_key = $3 OR p.account_key IS NULL)`;
  }
  params.push(limit);
  const limIdx = params.length;
  const { rows } = await pool.query(
    `SELECT p.external_id, p.title, p.date, p.views, p.engagements, p.likes, p.comments,
            p.shares, p.clicks, p.score, p.permalink, p.thumbnail_url, p.raw_data
       FROM posts p JOIN platforms pl ON pl.id = p.platform_id
      WHERE pl.key = $1 AND p.date >= $2 ${acctClause}
      ORDER BY p.score DESC NULLS LAST, p.views DESC NULLS LAST, p.engagements DESC NULLS LAST
      LIMIT $${limIdx}`, params);
  return rows.map(p => {
    const rd = p.raw_data || {};
    return {
      id: p.external_id,
      title: p.title || 'Post',
      date: p.date ? new Date(p.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '',
      views: Number(p.views) || 0,
      eng: Number(p.engagements) || 0,
      clicks: p.clicks,
      score: p.score,
      likes: Number(p.likes) || 0,
      comments: Number(p.comments) || 0,
      shares: Number(p.shares) || 0,
      watchTime: rd.watchTime ?? null,
      avd: rd.avd ?? null,
      ctr: rd.ctr ?? null,
      permalink: p.permalink || null,
      thumbnail: p.thumbnail_url || null,
      timestamp: rd.timestamp || (p.date ? `${p.date}T00:00:00+05:30` : null),
    };
  });
}

async function enrichTopPostThumbnails(platformKey, topPosts) {
  if (!Array.isArray(topPosts) || topPosts.length === 0) return topPosts;
  const ids = topPosts.map(p => p && p.id != null ? String(p.id) : null).filter(Boolean);
  if (!ids.length) return topPosts;
  try {
    const { rows } = await pool.query(
      `SELECT p.external_id, p.thumbnail_url
         FROM posts p JOIN platforms pl ON pl.id = p.platform_id
        WHERE pl.key = $1 AND p.external_id = ANY($2) AND p.thumbnail_url IS NOT NULL`,
      [platformKey, ids]
    );
    if (!rows.length) return topPosts;
    const map = new Map(rows.map(r => [String(r.external_id), r.thumbnail_url]));
    return topPosts.map(p => {
      const localized = p && p.id != null ? map.get(String(p.id)) : null;
      return localized ? { ...p, thumbnail: localized } : p;
    });
  } catch (err) {
    console.error(`Thumbnail enrich failed for ${platformKey}:`, err.message);
    return topPosts; // never break stats over a thumbnail join
  }
}

app.get('/api/social/platforms/:key/stats', async (req, res) => {
  const { period = '30D', account } = req.query;
  const { key } = req.params;

  try {
    // Per-account snapshots: ?account=<id> → that account; ?account=all → combined
    // sum; omitted → the user-chosen PRIMARY account (default). `accounts` lists
    // the chips for the UI, ordered primary-first; `primaryAccount` is its id.
    const snaps = await syncService.getAccountSnapshots(key, period);
    if (snaps.length) {
      let accountsList = snaps
        .filter(s => s.account_key)
        .map(s => ({ accountId: s.data?.accountId || s.account_key, accountLabel: s.data?.accountLabel || s.account_key }));
      const primaryAccount = await accounts.resolvePrimaryId(key, accountsList.map(a => a.accountId));
      accountsList.sort((a, b) => (a.accountId === primaryAccount ? 0 : 1) - (b.accountId === primaryAccount ? 0 : 1));

      let data, resolvedAccountId;
      if (account && account !== 'all') {
        const s = snaps.find(x => (x.data?.accountId || x.account_key) === account);
        if (!s) return res.json({ key, synced: false, accounts: accountsList, primaryAccount, message: 'No data for this account yet.' });
        data = s.data;
        resolvedAccountId = account;
      } else if (account === 'all') {
        data = snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(s => s.data));
        resolvedAccountId = 'all';
      } else {
        // Default → the primary account's snapshot (fall back to first / combined).
        const s = snaps.find(x => (x.data?.accountId || x.account_key) === primaryAccount);
        data = s ? s.data : (snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(x => x.data)));
        resolvedAccountId = primaryAccount;
      }
      // Use the freshest sampled follower count so the KPI matches the trend chart.
      if (data) await syncService.overlayFreshFollowers(key, resolvedAccountId, data);
      if (data) {
        // Prefer the posts table (authoritative dates); fall back to filtering the
        // snapshot's own topPosts if the table has nothing in the window.
        const tp = await topPostsFromTable(key, resolvedAccountId, period).catch(() => []);
        if (tp.length) data.topPosts = tp; else scopeTopPostsToWindow(data, period);
      }
      if (data && Array.isArray(data.topPosts)) data.topPosts = await enrichTopPostThumbnails(key, data.topPosts);
      return res.json({ ...data, accounts: accountsList, primaryAccount, synced: true, fetchedAt: snaps[0].fetched_at });
    }

    // Legacy fallback: no snapshot for this period → scale from the latest of any period.
    const snapshot = await syncService.getLatestSnapshot(key, period);
    if (snapshot) {
      const isFallback = snapshot.period !== period;
      const data = isFallback ? scaleForPeriod(snapshot.data, period) : snapshot.data;
      if (data) {
        const tp = await topPostsFromTable(key, account || null, period).catch(() => []);
        if (tp.length) data.topPosts = tp; else scopeTopPostsToWindow(data, period);
      }
      if (data && Array.isArray(data.topPosts)) data.topPosts = await enrichTopPostThumbnails(key, data.topPosts);
      return res.json({ ...data, synced: true, estimated: isFallback, fetchedAt: snapshot.fetched_at });
    }
    res.json({ key, synced: false, message: 'No synced data yet. Click Re-sync on Integrations page.' });
  } catch (err) {
    console.error(`Platform stats error for ${key}:`, err);
    res.status(500).json({ error: 'Failed to load platform stats' });
  }
});

// Audience insights — demographics / online-followers / traffic sources.
// Live per-module fetch behind a 24h in-module cache (3-4 rate-gated Graph
// calls per platform per day). Platforms without an implementation return
// available:false so the UI simply hides the section.
const AUDIENCE_PROVIDERS = {
  instagram: (account) => instagram.getAudience(account || null),
  youtube:   () => youtube.getAudience(),
  threads:   () => threads.getAudience(),
};
app.get('/api/social/platforms/:key/audience', async (req, res) => {
  const { key } = req.params;
  const provider = AUDIENCE_PROVIDERS[key];
  if (!provider) return res.json({ available: false, reason: 'Audience insights are not available for this platform yet.' });
  try {
    res.json(await provider(req.query.account));
  } catch (err) {
    console.error(`Audience error for ${key}:`, err.message);
    res.json({ available: false, reason: 'Could not load audience insights right now.' });
  }
});

// Followers trend — time-wise follower counts, filterable by days or weeks.
// Reads ONLY from stored snapshots (no Graph API calls). Independent of the
// Overview KPI period; always uses the 30D snapshot for max daily resolution.
app.get('/api/social/platforms/:key/followers-trend', async (req, res) => {
  const { key } = req.params;
  const { account } = req.query;
  const unit = ['weeks', 'hours'].includes(req.query.unit) ? req.query.unit : 'days';
  const DEFAULTS = { hours: 24, days: 30, weeks: 8 };
  const MAXES = { hours: 168, days: 90, weeks: 52 };
  const range = Math.max(1, Math.min(parseInt(req.query.range, 10) || DEFAULTS[unit], MAXES[unit]));

  try {
    const snaps = await syncService.getAccountSnapshots(key, '30D');
    // No snapshot is not the same as no history — the follower sampler writes to
    // follower_samples independently, so still try to build a series from it.
    if (!snaps.length) {
      const points = await syncService.buildFollowersTrend(key, account || null, null, null, unit, range);
      return res.json({ key, synced: points.length > 0, unit, range, points });
    }

    const accountsList = snaps
      .filter(s => s.account_key)
      .map(s => ({ accountId: s.data?.accountId || s.account_key, accountLabel: s.data?.accountLabel || s.account_key }));
    const primaryAccount = await accounts.resolvePrimaryId(key, accountsList.map(a => a.accountId));

    // Resolve which account's series to build (mirror the /stats handler).
    let chosen, accountKey;
    if (account && account !== 'all') {
      chosen = snaps.find(x => (x.data?.accountId || x.account_key) === account);
      accountKey = account;
    } else if (account === 'all') {
      chosen = { data: snaps.length === 1 ? snaps[0].data : syncService.combineSnapshots(snaps.map(s => s.data)), fetched_at: snaps[0].fetched_at };
      accountKey = 'all';
    } else {
      chosen = snaps.find(x => (x.data?.accountId || x.account_key) === primaryAccount) || snaps[0];
      accountKey = chosen.data?.accountId || chosen.account_key;
    }
    if (!chosen?.data) return res.json({ key, synced: false, unit, range, points: [], accounts: accountsList, primaryAccount });

    const refFollowers = Number(chosen.data?.followers) || undefined;
    const points = await syncService.buildFollowersTrend(key, accountKey, chosen.data, chosen.fetched_at, unit, range, { refFollowers });
    // `estimated` points pre-date our own follower sampling and are reconstructed
    // from platform gain metrics — surfaced so the UI can label them honestly.
    const estimatedCount = points.filter(p => p.estimated).length;
    res.json({
      key, synced: true, unit, range, account: accountKey, primaryAccount, accounts: accountsList, points,
      estimatedCount,
      measuredFrom: points.find(p => !p.estimated)?.date || null,
      lastMeasuredAt: await syncService.getLastFollowerSampleAt(key, accountKey),
    });
  } catch (err) {
    console.error(`Followers trend error for ${key}:`, err);
    res.status(500).json({ error: 'Failed to load followers trend' });
  }
});

// Per-post daily performance history — the metric log written once per IST day
// from the posts table. Returns lifetime counters per day PLUS the per-day gain,
// so the UI can plot "views this reel actually picked up each day". DB-only.
app.get('/api/social/posts/:id/metrics-trend', async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 60, 365));
  try {
    const out = await syncService.getPostMetricsTrend(req.params.id, { days, platform: req.query.platform || null });
    if (!out) return res.status(404).json({ error: 'Post not found' });
    res.json(out);
  } catch (err) {
    console.error('Post metrics trend error:', err.message);
    res.status(500).json({ error: 'Failed to load post metrics history' });
  }
});

// Account-wide daily gains — how many views/likes/comments ALL of a platform's
// posts picked up on each day, summed from the same per-post metric log. DB-only.
app.get('/api/social/platforms/:key/daily-metrics', async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
  try {
    const points = await syncService.getDailyMetricsTrend(req.params.key, { days, account: req.query.account || null });
    res.json({ key: req.params.key, days, account: req.query.account || null, points });
  } catch (err) {
    console.error('Daily metrics error:', err.message);
    res.status(500).json({ error: 'Failed to load daily metrics' });
  }
});

// Content library — read from DB posts table with pagination & SQL filtering
app.get('/api/social/content-library', async (req, res) => {
  try {
    const { platform, topic, format: formatFilter, dateFilter, account, sortBy = 'score', search, page = '1', limit = '10' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (platform) {
      conditions.push(`pl.name = $${paramIdx++}`);
      params.push(platform);
    }
    // Multi-select account filter. A token is either a specific account
    // ("instagram|<id>") or a whole platform ("youtube", for single-account
    // platforms whose posts mix real + null account_key). Match accordingly.
    if (account) {
      const tokens = String(account).split(',').map(s => s.trim()).filter(Boolean);
      const composite = tokens.filter(t => t.includes('|'));
      const platformOnly = tokens.filter(t => !t.includes('|'));
      const ors = [];
      if (composite.length) {
        ors.push(`(pl.key || '|' || COALESCE(p.account_key,'')) = ANY($${paramIdx++}::text[])`);
        params.push(composite);
      }
      if (platformOnly.length) {
        ors.push(`pl.key = ANY($${paramIdx++}::text[])`);
        params.push(platformOnly);
      }
      if (ors.length) conditions.push(`(${ors.join(' OR ')})`);
    }
    if (topic) {
      conditions.push(`p.topic = $${paramIdx++}`);
      params.push(topic);
    }
    // Formats are normalised ("VIDEO" / "Video" / "TEXT_POST" → "Video" / "Text post") so the
    // filter matches every spelling the platforms use.
    if (formatFilter) {
      conditions.push(`lower(replace(p.type, '_', ' ')) = lower($${paramIdx++})`);
      params.push(formatFilter);
    }
    if (search) {
      conditions.push(`(p.title ILIKE $${paramIdx} OR p.caption ILIKE $${paramIdx})`);
      paramIdx++;
      params.push(`%${search}%`);
    }
    if (dateFilter) {
      const days = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90, 'Year-to-date': 365 }[dateFilter];
      if (days) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        conditions.push(`p.date >= $${paramIdx++}`);
        params.push(cutoff.toISOString().split('T')[0]);
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortMap = {
      date: 'p.date DESC NULLS LAST, p.id DESC',
      score: 'p.score DESC',
      views: 'p.views DESC',
      eng: 'p.engagements DESC',
      clicks: 'p.clicks DESC',
      saves: 'p.saves DESC',
    };
    const orderBy = sortMap[sortBy] || sortMap.score;

    // Count total filtered rows
    const countQuery = `
      SELECT COUNT(*) as total
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      ${whereClause}
    `;
    const { rows: countRows } = await pool.query(countQuery, params);
    const total = parseInt(countRows[0].total, 10);
    // Totals for the filtered set (summary strip above the library).
    const { rows: [agg] } = await pool.query(`
      SELECT COALESCE(SUM(p.views),0)::bigint AS views, COALESCE(SUM(p.engagements),0)::bigint AS eng,
             ROUND(AVG(p.score))::int AS "avgScore",
             ROUND(AVG(CASE WHEN p.views > 0 THEN p.engagements::numeric * 100 / p.views END), 1)::float AS "avgEngRate"
        FROM posts p JOIN platforms pl ON pl.id = p.platform_id ${whereClause}`, params);

    // Fetch paginated posts (owning-account identity joined for the post viewer:
    // IG accounts live in instagram_accounts, the other platforms in social_accounts)
    const postsQuery = `
      SELECT p.*, pl.key AS "platformKey", pl.name AS "platformName", pl.short, pl.color, pl.bg, pl.text_on_bg AS "textOnBg",
             COALESCE(ia.username, ia.name, sa.username, sa.label) AS "accountUsername"
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      LEFT JOIN instagram_accounts ia ON pl.key = 'instagram' AND ia.account_id = p.account_key
      LEFT JOIN social_accounts sa ON sa.platform = pl.key AND sa.account_key = p.account_key
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    const queryParams = [...params, limitNum, offset];
    const { rows: posts } = await pool.query(postsQuery, queryParams);

    // Get unique topics and formats from all posts for filter dropdowns
    const { rows: allMeta } = await pool.query(`SELECT DISTINCT topic, type FROM posts WHERE topic IS NOT NULL`);
    const topics = [...new Set(allMeta.map(r => r.topic).filter(Boolean))];
    const fmtLabel = (t) => { const x = String(t).replace(/_/g, ' ').toLowerCase(); return x.charAt(0).toUpperCase() + x.slice(1); };
    const formats = [...new Set(allMeta.map(r => r.type).filter(Boolean).map(fmtLabel))].sort();

    // Distinct accounts present in the library (for the multi-select account filter),
    // resolved to friendly labels; null-account rows fall back to the platform name.
    const { rows: acctRows } = await pool.query(`
      SELECT DISTINCT pl.key AS platform, pl.name AS "platformName", p.account_key AS "accountKey",
             COALESCE(ia.username, ia.name, sa.username, sa.label) AS label
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      LEFT JOIN instagram_accounts ia ON pl.key = 'instagram' AND ia.account_id = p.account_key
      LEFT JOIN social_accounts sa ON sa.platform = pl.key AND sa.account_key = p.account_key
      ORDER BY pl.key, label NULLS FIRST`);
    // Collapse to one clean option per account. Platforms with a single real
    // account (FB/YT/Threads — whose posts mix real + null account_key) become a
    // single platform-wide option; multi-account platforms (IG) list each handle.
    const byPlat = {};
    for (const r of acctRows) {
      const g = byPlat[r.platform] || (byPlat[r.platform] = { platformName: r.platformName, labels: {}, real: new Set() });
      if (r.accountKey) { g.real.add(r.accountKey); g.labels[r.accountKey] = r.label; }
    }
    const handle = (lbl, fallback) => lbl ? (lbl.startsWith('@') ? lbl : '@' + lbl) : fallback;
    const accountsList = [];
    for (const [platform, g] of Object.entries(byPlat)) {
      const realKeys = [...g.real];
      if (realKeys.length <= 1) {
        accountsList.push({ value: platform, label: realKeys.length ? handle(g.labels[realKeys[0]], g.platformName) : g.platformName, platform, platformName: g.platformName });
      } else {
        for (const k of realKeys) accountsList.push({ value: `${platform}|${k}`, label: handle(g.labels[k], g.platformName), platform, platformName: g.platformName });
      }
    }

    const totalPages = Math.ceil(total / limitNum) || 1;

    res.json({
      posts: posts.map(p => ({
        id: p.id,
        externalId: p.external_id,   // platform-side id — needed by the in-app post viewer (YT embed)
        platform: p.platformKey,
        accountUsername: p.accountUsername || null,   // owning connected account (shown in the post viewer)
        title: p.title,
        caption: p.caption || null,
        type: p.type ? String(p.type).replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()) : p.type,
        topic: p.topic || 'Uncategorized',
        thumbnail: p.thumbnail_url || null,
        permalink: p.permalink || null,
        date: p.date ? new Date(p.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '',
        views: p.views,
        eng: p.engagements,
        likes: p.likes,
        comments: p.comments,
        shares: p.shares,
        saves: p.saves,
        clicks: p.clicks,
        score: p.score,
      })),
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      topics,
      formats,
      accounts: accountsList,
      stats: { views: Number(agg.views), eng: Number(agg.eng), avgScore: agg.avgScore, avgEngRate: agg.avgEngRate },
      dateFilterOptions: ['Last 7 days', 'Last 30 days', 'Last 90 days', 'Year-to-date'],
    });
  } catch (err) {
    console.error('Content library error:', err);
    res.status(500).json({ error: 'Failed to load content library' });
  }
});

// Performance — computed from DB posts with real engagement trend & heatmap
app.get('/api/social/performance', async (req, res) => {
  try {
    const { period = '30D', platform } = req.query;
    const info = mockService.PERIOD_INFO[period] || mockService.PERIOD_INFO['30D'];
    // Near-realtime: kick a throttled background refresh of this period (fire-and-forget)
    syncService.revalidate(period).catch(() => {});
    const lastSyncAt = await syncService.getLastSyncAt(period).catch(() => null);

    const { rows: posts } = await pool.query(`
      SELECT p.*, pl.key AS "platformKey", pl.name AS "platformName",
             COALESCE(ia.username, ia.name, sa.username, sa.label) AS "accountUsername"
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      LEFT JOIN instagram_accounts ia ON pl.key = 'instagram' AND ia.account_id = p.account_key
      LEFT JOIN social_accounts sa ON sa.platform = pl.key AND sa.account_key = p.account_key
      ORDER BY p.score DESC
    `);

    // --- helpers ---
    function autoTopic(title) {
      const t = (title || '').toLowerCase();
      if (t.includes('whatsapp')) return 'WhatsApp';
      if (t.includes('email')) return 'Email';
      if (t.includes('claude')) return 'Claude';
      if (t.includes('tamil') || t.includes('தமிழ்')) return 'Tamil Tech';
      if (t.includes('n8n')) return 'n8n';
      if (t.includes('ai agent') || t.includes('ai agents')) return 'AI Agents';
      if (t.includes('automation')) return 'Automation';
      if (t.includes('masterclass') || t.includes('tutorial')) return 'Tutorials';
      if (t.includes('vps') || t.includes('cloud')) return 'Cloud';
      return 'General';
    }

    // Heatmap buckets are IST slots, so the hour AND weekday must be read in
    // IST — getHours() returns the server's TZ (UTC in Docker), which shifted
    // every cell by ~5.5h. Day comes from the same timestamp so a post at
    // 01:30 IST lands on the right weekday too.
    const istParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false, weekday: 'short',
    });
    function extractIst(raw) {
      try {
        const ts = raw?.timestamp || raw?.created_time || raw?.publishedAt;
        if (!ts) return { hour: null, day: null };
        const d = new Date(ts);
        if (isNaN(d)) return { hour: null, day: null };
        const parts = istParts.formatToParts(d);
        const hour = parseInt(parts.find(p => p.type === 'hour')?.value, 10);
        const day  = parts.find(p => p.type === 'weekday')?.value || null;
        return { hour: isNaN(hour) ? null : hour % 24, day };
      } catch { return { hour: null, day: null }; }
    }

    function slotForHour(h) {
      if (h < 8) return 0;      // 6 AM
      if (h < 11) return 1;     // 9 AM
      if (h < 14) return 2;     // 12 PM
      if (h < 17) return 3;     // 3 PM
      if (h < 20) return 4;     // 6 PM
      return 5;                 // 9 PM
    }

    function dayName(dateStr) {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'short' });
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - info.days);

    let enriched = posts.map(p => {
      const ist = extractIst(p.raw_data);
      return {
        ...p,
        topic: p.topic || autoTopic(p.title),
        hour: ist.hour,
        istDay: ist.day,
        engRate: p.views > 0 ? (p.engagements / p.views) * 100 : 0,
      };
    });

    if (platform) {
      const pk = Object.keys(mockService.PLATFORMS).find(k => mockService.PLATFORMS[k].name === platform);
      enriched = enriched.filter(p => p.platformKey === pk);
    }

    // Period filter (topic/format/best/worst respect the selected window)
    let filtered = enriched.filter(p => new Date(p.date + 'T00:00:00') >= cutoff);

    // --- perf by topic ---
    const perfByTopic = (() => {
      const groups = {};
      filtered.forEach(c => {
        const t = c.topic || 'General';
        if (!groups[t]) groups[t] = { topic: t, posts: 0, totalViews: 0, totalEng: 0, totalScore: 0 };
        groups[t].posts += 1;
        groups[t].totalViews += c.views || 0;
        groups[t].totalEng += c.engagements || 0;
        groups[t].totalScore += c.score || 0;
      });
      return Object.values(groups)
        .map(g => ({ topic: g.topic, posts: g.posts, avgViews: Math.round(g.totalViews / g.posts), avgEng: Math.round(g.totalEng / g.posts), avgScore: Math.round(g.totalScore / g.posts) }))
        .sort((a, b) => b.avgViews - a.avgViews);
    })();

    // --- perf by format ---
    const perfByFormat = (() => {
      const groups = {};
      filtered.forEach(c => {
        // Platforms disagree on casing ("Video" vs "VIDEO") — normalise so they
        // group as one format.
        const rawFmt = c.type || 'Post';
        const fmt = rawFmt.charAt(0).toUpperCase() + rawFmt.slice(1).toLowerCase();
        if (!groups[fmt]) groups[fmt] = { format: fmt, posts: 0, totalViews: 0, totalEng: 0, totalScore: 0 };
        groups[fmt].posts += 1;
        groups[fmt].totalViews += c.views || 0;
        groups[fmt].totalEng += c.engagements || 0;
        groups[fmt].totalScore += c.score || 0;
      });
      return Object.values(groups)
        .map(g => ({ format: g.format, posts: g.posts, avgViews: Math.round(g.totalViews / g.posts), avgEng: Math.round(g.totalEng / g.posts), avgScore: Math.round(g.totalScore / g.posts) }))
        .sort((a, b) => b.avgViews - a.avgViews);
    })();

    // --- best / worst posts ---
    const sortedLib = [...filtered].sort((a, b) => (b.score || 0) - (a.score || 0));
    // permalink/externalId/thumbnail ride along for the in-app post viewer modal
    const mapPostRow = (p) => ({
      id: p.id,
      externalId: p.external_id,
      platform: p.platformKey,
      accountUsername: p.accountUsername || null,
      title: p.title,
      type: p.type,
      topic: p.topic || 'General',
      date: p.date ? new Date(p.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '',
      views: p.views,
      eng: p.engagements,
      likes: p.likes,
      comments: p.comments,
      clicks: p.clicks,
      score: p.score,
      permalink: p.permalink || null,
      thumbnail: p.thumbnail_url || null,
      caption: p.caption || null,
    });
    const best  = sortedLib.slice(0, 3).map(mapPostRow);
    const worst = sortedLib.slice(-3).reverse().map(mapPostRow);

    // --- real engagement trend (daily avg engagement rate) ---
    // A short window with 1-2 posting days draws a useless single-dot chart, so
    // the trend auto-widens (30d, then 90d) until it has >=3 points to show.
    const buildTrend = (set, sliceN) => {
      const trendMap = {};
      set.forEach(p => {
        if (!trendMap[p.date]) trendMap[p.date] = { total: 0, count: 0 };
        trendMap[p.date].total += p.engRate;
        trendMap[p.date].count += 1;
      });
      return Object.entries(trendMap)
        .map(([date, { total, count }]) => ({ date, rate: total / count }))
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(-sliceN);
    };
    let trendEntries = buildTrend(filtered, info.trendSlice);
    let trendWindowDays = info.days;
    for (const widerDays of [30, 90]) {
      if (trendEntries.length >= 3 || info.days >= widerDays) break;
      const widerCutoff = new Date();
      widerCutoff.setDate(widerCutoff.getDate() - widerDays);
      const widerSet = enriched.filter(p => new Date(p.date + 'T00:00:00') >= widerCutoff);
      const wider = buildTrend(widerSet, widerDays);
      if (wider.length > trendEntries.length) { trendEntries = wider; trendWindowDays = widerDays; }
    }
    const engTrend = trendEntries.map(e => parseFloat(e.rate.toFixed(1)));
    const engTrendDays = trendEntries.map(e =>
      new Date(e.date + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
    );

    // --- heatmap (day-of-week × time slot) — 90-day history, score-based ---
    // Two fixes that made this grid "dead": (1) a 7D window rarely has posts in
    // more than one or two cells, so it's ALWAYS built from the last 90 days;
    // (2) the heat value is the average CONTENT SCORE (1-99, platform-relative
    // percentile) instead of eng-rate — score exists for every post on every
    // platform, including ones without per-post views (e.g. Facebook).
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const slots = ["6 AM", "9 AM", "12 PM", "3 PM", "6 PM", "9 PM"];
    const HEAT_WINDOW_DAYS = 90;
    const heatCutoff = new Date();
    heatCutoff.setDate(heatCutoff.getDate() - HEAT_WINDOW_DAYS);
    const heatSet = enriched.filter(p => new Date(p.date + 'T00:00:00') >= heatCutoff);

    const heatmapAcc = {};
    days.forEach(d => {
      heatmapAcc[d] = Array(6).fill(null).map(() => ({ total: 0, count: 0 }));
    });
    heatSet.forEach(p => {
      if (p.hour == null) return;
      const d = p.istDay || dayName(p.date);
      const s = slotForHour(p.hour);
      if (heatmapAcc[d]) {
        heatmapAcc[d][s].total += (p.score || 0);
        heatmapAcc[d][s].count += 1;
      }
    });

    const heatmap = days.map(d => ({
      day: d,
      slots: heatmapAcc[d].map(cell => cell.count > 0 ? Math.round(cell.total / cell.count) : 0),
    }));
    const heatmapCounts = days.map(d => ({
      day: d,
      slots: heatmapAcc[d].map(cell => cell.count),
    }));

    // --- best posting time (needs at least 2 posts in the cell to be a claim) ---
    let maxVal = 0, bestDay = '', bestSlot = '';
    heatmap.forEach((row, ri) => {
      row.slots.forEach((v, i) => {
        const n = heatmapCounts[ri].slots[i];
        if (n >= 2 && v > maxVal) { maxVal = v; bestDay = row.day; bestSlot = slots[i]; }
      });
    });
    if (!maxVal) {
      // fall back to single-post cells rather than claiming "no data"
      heatmap.forEach((row, ri) => {
        row.slots.forEach((v, i) => {
          if (heatmapCounts[ri].slots[i] > 0 && v > maxVal) { maxVal = v; bestDay = row.day; bestSlot = slots[i]; }
        });
      });
    }
    const bestPostingTime = maxVal > 0 ? `${bestDay} · ${bestSlot} peak` : 'No data yet';

    res.json({
      period,
      periodInfo: info,
      lastSyncAt,
      scopeLabel: `${platform ? platform + ' · ' : ''}${info.sub}`,
      perfByTopic,
      perfByFormat,
      heatmap,
      heatmapCounts,
      heatmapMetric: 'score',
      heatmapWindowDays: HEAT_WINDOW_DAYS,
      bestPostingTime,
      heatmapSlots: slots,
      engTrend,
      engTrendDays,
      trendWindowDays,
      best,
      worst,
      platformFilter: platform || null,
    });
  } catch (err) {
    console.error('Performance error:', err);
    res.status(500).json({ error: 'Failed to load performance data' });
  }
});

// Insights — REAL derived managerial decision layer (DB-only, zero Graph calls).
// The executive bundle: cross-platform scorecard + flagged anomalies.
app.get('/api/social/insights', async (req, res) => {
  try {
    const period = req.query.period || '30D';
    const [scorecard, trends] = await Promise.all([
      insightsService.getExecutiveScorecard(period),
      insightsService.getTrendsAndAnomalies(period),
    ]);
    res.json({ scorecard, anomalies: trends.anomalies, trends: trends.platforms, generatedAt: scorecard.generatedAt });
  } catch (err) {
    console.error('Insights error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load insights' });
  }
});

// Content-theme ROI (per-theme performance over the window).
app.get('/api/social/insights/themes', async (req, res) => {
  try {
    const data = await insightsService.getContentThemes({ platform: req.query.platform || null, period: req.query.period || '30D' });
    res.json(data);
  } catch (err) {
    console.error('Insights themes error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load content themes' });
  }
});

// Trends & anomalies (WoW/MoM deltas + flagged alerts).
app.get('/api/social/insights/anomalies', async (req, res) => {
  try {
    res.json(await insightsService.getTrendsAndAnomalies(req.query.period || '30D'));
  } catch (err) {
    console.error('Insights anomalies error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load anomalies' });
  }
});

// Follower trajectory (linear projection) for one platform.
app.get('/api/social/insights/trajectory', async (req, res) => {
  try {
    if (!req.query.platform) return res.status(400).json({ error: 'platform is required' });
    res.json(await insightsService.getTrajectory(req.query.platform, { days: Number(req.query.days) || 30 }));
  } catch (err) {
    console.error('Insights trajectory error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to load trajectory' });
  }
});

// Admin: re-run rule-based categorization (after editing the theme map). force=1
// re-tags every post; default only fills posts with no topic yet.
app.post('/api/social/insights/recategorize', adminOnly, async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === '1';
    if (force) categorize.clearCache();
    const result = await categorize.recategorizeAll({ onlyNull: !force, force });
    res.json(result);
  } catch (err) {
    console.error('Recategorize error:', err);
    res.status(500).json({ error: err.message || 'Failed to recategorize' });
  }
});

// SSE — real-time push for agent handoff events. Long-lived stream, one per
// logged-in browser tab. notificationService pushes 'handoff' type immediately
// after the DB INSERT so the popup appears without waiting for the 60s poll.
app.get('/api/social/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable Nginx/Traefik buffering
  });
  res.write(':ok\n\n');
  const client = notificationService.registerSseClient(res, req.user.id);
  req.on('close', () => notificationService.deregisterSseClient(client));
});

// Notifications — in-app alert feed (DB-only reads).
app.get('/api/social/notifications', async (req, res) => {
  try {
    res.json(await notificationService.getFeed(req.user.id, { limit: req.query.limit }));
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

app.post('/api/social/notifications/read', async (req, res) => {
  try {
    const { ids, all } = req.body || {};
    await notificationService.markRead(req.user.id, { ids: Array.isArray(ids) ? ids : null, all: all === true });
    res.json(await notificationService.getFeed(req.user.id, { limit: 30 }));
  } catch (err) {
    console.error('Mark-read error:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

app.get('/api/social/notification-prefs', async (req, res) => {
  try { res.json(await notificationService.getPrefs()); }
  catch (err) { res.status(500).json({ error: 'Failed to load preferences' }); }
});

app.put('/api/social/notification-prefs', adminOnly, async (req, res) => {
  try { res.json(await notificationService.setPrefs(req.body || {})); }
  catch (err) { res.status(500).json({ error: 'Failed to save preferences' }); }
});

// ── Team / users ─────────────────────────────────────────────────────
// People are managed in ForgeGrowth (Admin Settings → Users). The list here is
// every active ForgeGrowth user who can open Social, mirrored into this schema's
// users table so assignment and the activity log can reference them.
app.get('/api/social/users', async (req, res) => {
  try {
    const fgPool = require('../db');
    const { hasPermission } = require('../permissions');
    const { rows: fg } = await fgPool.query(
      `SELECT id, username, email, display_name, role, permissions, created_at
         FROM coexistence.forgecrm_users WHERE is_active IS NOT FALSE ORDER BY created_at ASC`);
    const out = [];
    for (const u of fg) {
      if (!hasPermission({ role: u.role, permissions: u.permissions }, 'social')) continue;
      const email = (u.email && String(u.email).trim()) || `user-${u.id}@forgegrowth.local`;
      const role = u.role === 'admin' ? 'admin' : 'member';
      const displayName = u.display_name || u.username || email;
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, '!forgegrowth-session', $4)
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role`,
        [u.id, email, displayName, role]);
      out.push({ id: Number(u.id), email, displayName, role, avatarUrl: null, createdAt: u.created_at });
    }
    res.json(out);
  } catch (err) {
    console.error('[social] users:', err.message);
    res.status(500).json({ error: 'Failed to load team' });
  }
});
const manageInForgeGrowth = (req, res) =>
  res.status(410).json({ error: 'Users are managed in ForgeGrowth: Admin Settings → Users.' });
app.post('/api/social/users', manageInForgeGrowth);
app.put('/api/social/users/:id', manageInForgeGrowth);
app.delete('/api/social/users/:id', manageInForgeGrowth);

// ── Saved replies / canned responses (inbox) ─────────────────────────
app.get('/api/social/canned-replies', async (req, res) => {
  try { const { rows } = await pool.query(`SELECT id, title, body, created_at AS "createdAt" FROM canned_replies ORDER BY created_at DESC`); res.json(rows); }
  catch { res.status(500).json({ error: 'Failed to load saved replies' }); }
});
app.post('/api/social/canned-replies', async (req, res) => {
  try {
    const { title, body } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    const { rows } = await pool.query(`INSERT INTO canned_replies (title, body) VALUES ($1,$2) RETURNING id, title, body, created_at AS "createdAt"`, [String(title).trim(), String(body || '')]);
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to save reply' }); }
});
app.put('/api/social/canned-replies/:id', async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const { rows } = await pool.query(`UPDATE canned_replies SET title=COALESCE($2,title), body=COALESCE($3,body) WHERE id=$1 RETURNING id, title, body, created_at AS "createdAt"`,
      [req.params.id, title != null ? String(title).trim() : null, body != null ? String(body) : null]);
    if (!rows[0]) return res.status(404).json({ error: 'Saved reply not found' });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update saved reply' }); }
});
app.delete('/api/social/canned-replies/:id', async (req, res) => {
  try { await pool.query('DELETE FROM canned_replies WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to delete saved reply' }); }
});

// ── Inbox item metadata: assignment / status / internal note ─────────
app.get('/api/social/inbox/meta', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.item_type AS "itemType", m.item_id AS "itemId", m.platform,
              m.assigned_to AS "assignedTo", u.display_name AS "assignedName",
              m.status, m.internal_note AS "internalNote", m.updated_at AS "updatedAt"
         FROM inbox_meta m LEFT JOIN users u ON u.id = m.assigned_to`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load inbox metadata' }); }
});
app.post('/api/social/inbox/meta', async (req, res) => {
  try {
    const { itemType, itemId, platform, assignedTo, status, internalNote } = req.body || {};
    if (!itemType || !itemId) return res.status(400).json({ error: 'itemType and itemId are required' });
    if (status && !['open', 'snoozed', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const by = req.user?.displayName || req.user?.email || 'Unknown';
    // Partial upsert: only overwrite the fields that were provided.
    const { rows } = await pool.query(
      `INSERT INTO inbox_meta (item_type, item_id, platform, assigned_to, status, internal_note, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,COALESCE($5,'open'),$6,$7, now())
       ON CONFLICT (item_type, item_id) DO UPDATE SET
         platform      = COALESCE(EXCLUDED.platform, inbox_meta.platform),
         assigned_to   = CASE WHEN $8  THEN EXCLUDED.assigned_to  ELSE inbox_meta.assigned_to END,
         status        = CASE WHEN $10 THEN EXCLUDED.status       ELSE inbox_meta.status END,
         internal_note = CASE WHEN $9  THEN EXCLUDED.internal_note ELSE inbox_meta.internal_note END,
         updated_by    = EXCLUDED.updated_by, updated_at = now()
       RETURNING id`,
      [itemType, String(itemId), platform || null,
       assignedTo === undefined ? null : (assignedTo === null ? null : Number(assignedTo)),
       status || null, internalNote === undefined ? null : internalNote, by,
       assignedTo !== undefined, internalNote !== undefined, status !== undefined]);
    logActivity(req, 'inbox.update', 'inbox_item', `${itemType}:${itemId}`,
      { status, assignedTo: assignedTo !== undefined ? assignedTo : undefined, platform });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error('inbox meta error:', e.message); res.status(500).json({ error: 'Failed to update item' }); }
});

// ── Activity log (audit trail) ───────────────────────────────────────
// Fire-and-forget write at mutation sites; never blocks the request.
async function logActivity(req, action, entityType, entityId, meta = null) {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user?.id || null, req.user?.displayName || req.user?.email || 'Unknown',
       action, entityType || null, entityId != null ? String(entityId) : null, meta ? JSON.stringify(meta) : null]);
  } catch (e) { console.error('[activity] log failed:', e.message); }
}
app.get('/api/social/activity', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const { rows } = await pool.query(
      `SELECT id, user_name AS "userName", action, entity_type AS "entityType", entity_id AS "entityId",
              meta, created_at AS "createdAt"
         FROM activity_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load activity' }); }
});

// ── Goals / KPI targets ──────────────────────────────────────────────
// Current value per goal is computed DB-only: followers + engagement rate reuse
// the insights scorecard; posts is a 30-day count. (metric: followers|engagement_rate|posts)
async function _goalCurrent(metric, platform) {
  try {
    if (metric === 'posts') {
      const params = []; let clause = `p.date >= now() - interval '30 days'`;
      if (platform) { params.push(platform); clause += ` AND pl.key = $1`; }
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM posts p JOIN platforms pl ON pl.id = p.platform_id WHERE ${clause}`, params);
      return rows[0]?.n || 0;
    }
    const sc = await insightsService.getExecutiveScorecard('30D');
    const rows = sc.platforms || [];
    const scoped = platform ? rows.filter(r => r.platform === platform) : rows;
    if (metric === 'followers') return scoped.reduce((a, r) => a + (Number(r.followers) || 0), 0);
    if (metric === 'engagement_rate') {
      const vals = scoped.map(r => r.engagementRate).filter(v => v != null);
      return vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10 : null;
    }
    return null;
  } catch { return null; }
}
app.get('/api/social/goals', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, platform, metric, target, label, created_at AS "createdAt" FROM goals ORDER BY created_at ASC`);
    const out = [];
    for (const g of rows) {
      const current = await _goalCurrent(g.metric, g.platform);
      const pct = (current != null && Number(g.target) > 0) ? Math.round((current / Number(g.target)) * 100) : null;
      out.push({ ...g, target: Number(g.target), current, pct });
    }
    res.json(out);
  } catch { res.status(500).json({ error: 'Failed to load goals' }); }
});
app.post('/api/social/goals', adminOnly, async (req, res) => {
  try {
    const { platform, metric, target, label } = req.body || {};
    if (!['followers', 'engagement_rate', 'posts'].includes(metric)) return res.status(400).json({ error: 'Invalid metric' });
    if (!(Number(target) > 0)) return res.status(400).json({ error: 'Target must be a positive number' });
    const { rows } = await pool.query(
      `INSERT INTO goals (platform, metric, target, label) VALUES ($1,$2,$3,$4) RETURNING id`,
      [platform || null, metric, Number(target), label || null]);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch { res.status(500).json({ error: 'Failed to create goal' }); }
});
app.delete('/api/social/goals/:id', adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM goals WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to delete goal' }); }
});

// ── Create a shareable report link ───────────────────────────────────
app.post('/api/social/reports/share', async (req, res) => {
  try {
    const { platforms, from, to } = req.body || {};
    const keys = Array.isArray(platforms) ? platforms.join(',') : String(platforms || '');
    if (!keys) return res.status(400).json({ error: 'Pick at least one platform' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const token = require('crypto').randomBytes(12).toString('hex');
    await pool.query(
      `INSERT INTO report_shares (token, platforms, from_date, to_date, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [token, keys, from, to, req.user?.displayName || req.user?.email || 'Unknown']);
    res.status(201).json({ ok: true, token, path: `/#/social-share/${token}` });
  } catch (err) { console.error('Share error:', err); res.status(500).json({ error: 'Failed to create share link' }); }
});

// Platforms — always DB-backed
app.get('/api/social/platforms', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM platforms ORDER BY id');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load platforms' }); }
});

// Integrations — DB-backed with live status check
const PLATFORM_TESTERS = {
  instagram: () => instagram.testConnection(),
  youtube:   () => youtube.testConnection(),
  facebook:  () => facebook.testConnection(),
  threads:   () => threads.testConnection(),
  linkedin:  () => linkedin.testConnection(),
};

// ── Unified multi-account integration API ───────────────────
// Account list + sync per platform for the Integrations drill-down pages.
app.get('/api/social/integrations/accounts', async (req, res) => {
  try {
    res.json(await accounts.summary());
  } catch (err) {
    console.error('integrations summary error:', err.message);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

app.get('/api/social/integrations/:platform/accounts', async (req, res) => {
  try {
    if (!accounts.PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Unknown platform' });
    res.json({ accounts: await accounts.listAccounts(req.params.platform), canAdd: accounts.supportsAdd(req.params.platform) });
  } catch (err) {
    console.error('integrations accounts error:', err.message);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// Disconnect the managed (app_settings) account — route lives in managedDisconnect.js.
require('./managedDisconnect').mount(app, adminOnly);

// Remove an additional account (the managed account is edited via its Credentials modal).
app.delete('/api/social/integrations/:platform/accounts/:id', adminOnly, async (req, res) => {
  try {
    if (!accounts.PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Unknown platform' });
    res.json(await accounts.removeAccount(req.params.platform, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set the user-chosen primary account for a platform (controls the Overview default).
app.post('/api/social/integrations/:platform/accounts/:id/primary', adminOnly, async (req, res) => {
  try {
    if (!accounts.PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Unknown platform' });
    res.json(await accounts.setPrimary(req.params.platform, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Sync ALL accounts of one platform (admin) — currently runs the platform sync;
// per-account sync lands with the Phase-2 module refactor.
app.post('/api/social/integrations/:platform/sync', adminOnly, async (req, res) => {
  try {
    const platform = req.params.platform;
    if (!accounts.PLATFORMS.includes(platform)) return res.status(404).json({ error: 'Unknown platform' });
    const result = await syncService.syncPlatform(platform, { fullSync: false });
    if (platform === 'instagram') instagram.resolveAllConversations().catch(() => {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Backfill (rate-bounded, resumable) ───────────────────────
// Status is readable by any user; starting/re-running is admin-only.
app.get('/api/social/backfill/status', async (req, res) => {
  try { res.json(await backfillService.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social/backfill/start', adminOnly, async (req, res) => {
  try {
    const queued = await backfillService.start();
    res.json({ ok: true, queued });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/social/integrations', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM integrations ORDER BY id');

    // Dynamically check actual connection status for social platforms
    const enriched = await Promise.all(rows.map(async (row) => {
      if (!row.platform || !PLATFORM_TESTERS[row.platform]) return row;

      try {
        const status = await PLATFORM_TESTERS[row.platform]();
        return {
          ...row,
          status: status.connected ? 'connected' : 'disconnected',
          token: status.tokenDaysLeft !== undefined && status.tokenDaysLeft <= 7
            ? 'expiring'
            : status.connected ? 'healthy' : null,
          account: status.profile
            ? (status.profile.username || status.profile.name || status.profile.channelId || 'Connected')
            : row.account,
          tokenExpiryDays: status.tokenDaysLeft ?? null,
        };
      } catch (e) {
        return { ...row, status: 'disconnected', token: null };
      }
    }));

    res.json(enriched);
  } catch (err) { res.status(500).json({ error: 'Failed to load integrations' }); }
});

// Token health for the in-app banner — pure DB read, zero Graph calls.
app.get('/api/social/token-health', async (req, res) => {
  try {
    const accounts = await tokenService.getTokenHealth();
    res.json({ accounts, attention: accounts.filter(a => a.status !== 'ok') });
  } catch (err) {
    console.error('Token health error:', err);
    res.status(500).json({ error: 'Failed to load token health' });
  }
});

// Run a refresh pass on demand (admin) — same job the daily cron runs.
app.post('/api/social/token-health/refresh', adminOnly, async (req, res) => {
  try {
    const results = await tokenService.refreshAll();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Posts — always DB-backed
app.get('/api/social/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, pl.key AS "platformKey", pl.name AS "platformName", pl.short, pl.color, pl.bg, pl.text_on_bg AS "textOnBg"
      FROM posts p
      JOIN platforms pl ON pl.id = p.platform_id
      ORDER BY p.score DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load posts' }); }
});

// The Graph "Unsupported delete request … does not support this operation" reply
// means the post wasn't created by our app / the platform forbids API deletion.
// NOTE: this same boilerplate ALSO contains "does not exist", so it must be
// checked BEFORE the already-gone test below or a real undeletable post would be
// mis-read as already-gone and wrongly removed locally (then resynced).
const _UNSUPPORTED_DELETE = /unsupported delete|does not support this operation/i;
// A failure reason that means "it's genuinely gone on the platform" — treat as
// success (removing our row is correct). Excludes the unsupported-delete case.
const _ALREADY_GONE_RE = /not found|does not exist|cannot be found|no longer|already deleted/i;
function _isAlreadyGone(reason) {
  return _ALREADY_GONE_RE.test(reason || '') && !_UNSUPPORTED_DELETE.test(reason || '');
}
function _friendlyDeleteReason(platform, reason) {
  const name = platform.charAt(0).toUpperCase() + platform.slice(1);
  if (_UNSUPPORTED_DELETE.test(reason || ''))
    return `${name} won't delete this post via API — it wasn't published through ForgeSocial, so delete it in the ${name} app instead.`;
  return reason || `Could not delete this ${name} post via API.`;
}

// Delete a Content Library post. Deletes the LIVE post on the platform FIRST
// (FB/YT/Threads/LinkedIn via the module's deletePost); only removes the local
// row if the platform delete actually succeeded (or the post is already gone) —
// otherwise the next sync would just re-add it, making the delete look broken.
// Instagram is excluded entirely (no media-delete API).
app.delete('/api/social/posts/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.external_id, p.account_key, p.permalink, pl.key AS platform
         FROM posts p JOIN platforms pl ON pl.id = p.platform_id
        WHERE p.id = $1`, [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.platform === 'instagram')
      return res.status(400).json({ error: "Instagram doesn't allow deleting posts via API — remove it in the Instagram app and ForgeSocial will sync it out automatically." });
    if (!post.external_id)
      return res.status(400).json({ error: 'This post has no platform id stored, so it cannot be deleted on the platform.' });

    // Reuse the publish-log deleter (it dispatches per platform).
    const r = await publishService.deletePublishedPost({
      platform: post.platform, external_post_id: post.external_id,
      account_id: post.account_key, simulated: false,
    }).catch(e => ({ platformDeleted: false, reason: e.message }));

    const alreadyGone = !r.platformDeleted && _isAlreadyGone(r.reason);
    if (!r.platformDeleted && !alreadyGone) {
      // Keep the row — don't pretend it's deleted when it's still live (it'd resync).
      return res.status(400).json({ error: _friendlyDeleteReason(post.platform, r.reason) });
    }

    await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
    res.json({ ok: true, platformDeleted: r.platformDeleted === true, alreadyGone, permalink: post.permalink || null });
  } catch (err) {
    console.error('Post delete error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ── Media library ────────────────────────────────────────────
app.get('/api/social/media', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, caption, cover_url AS "coverUrl", cover_type AS "coverType",
             files, file_count AS "fileCount", total_size AS "totalSize",
             format, uploaded_by AS "uploadedBy", created_at AS "createdAt",
             m.accounts,
             -- accounts of the posts that used this asset (publish_jobs keeps a media snapshot with mediaId)
             COALESCE((SELECT jsonb_agg(DISTINCT CASE WHEN j.platform = 'instagram' THEN 'instagram|' || j.account_id ELSE j.platform END)
                         FROM publish_jobs j
                        WHERE j.status <> 'canceled' AND j.media @> jsonb_build_array(jsonb_build_object('mediaId', m.id))), '[]') AS "usedBy"
        FROM media m
       ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Media list error:', err);
    res.status(500).json({ error: 'Failed to load media' });
  }
});

app.post('/api/social/media', uploadMedia, async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'At least one file is required' });
    const mapped = files.map(f => ({
      url:  `/api/social/uploads/${f.filename}`,
      name: f.originalname,
      size: f.size,
      mime: f.mimetype,
    }));
    const cover     = mapped[0];
    const coverType = cover.mime.startsWith('video') ? 'video' : 'image';
    const totalSize = mapped.reduce((s, f) => s + (f.size || 0), 0);
    const cats      = [...new Set(mapped.map(f => f.mime.split('/')[0]))];
    const format    = cats.length > 1 ? 'Mixed' : (cats[0] === 'video' ? 'Video' : 'Image');
    const title     = (req.body.title || '').trim() || cover.name;
    const caption   = (req.body.caption || '').trim() || null;
    const uploadedBy = req.user?.displayName || req.user?.email || 'Unknown';
    let accounts = [];
    try { accounts = JSON.parse(req.body.accounts || '[]'); } catch (_) {}
    accounts = cleanMediaAccounts(accounts);

    const { rows } = await pool.query(
      `INSERT INTO media (title, caption, cover_url, cover_type, files, file_count, total_size, format, uploaded_by, accounts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [title, caption, cover.url, coverType, JSON.stringify(mapped), mapped.length, totalSize, format, uploadedBy, JSON.stringify(accounts)]
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Media upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// Which accounts an asset belongs to (shown / filtered by the "My accounts" preset). [] = shared.
function cleanMediaAccounts(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String)
    .filter(t => ['instagram', 'facebook', 'youtube', 'threads', 'linkedin'].includes(t.split('|')[0])))].slice(0, 50);
}
app.put('/api/social/media/:id/accounts', async (req, res) => {
  try {
    const accounts = cleanMediaAccounts(req.body?.accounts);
    const { rowCount } = await pool.query('UPDATE media SET accounts = $2 WHERE id = $1', [req.params.id, JSON.stringify(accounts)]);
    if (!rowCount) return res.status(404).json({ error: 'Media not found' });
    res.json({ ok: true, accounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/social/media/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT files FROM media WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Media not found' });
    for (const f of (rows[0].files || [])) {
      if (f?.url) fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(f.url))).catch(() => {});
    }
    await pool.query('DELETE FROM media WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Media delete error:', err);
    res.status(500).json({ error: 'Failed to delete media' });
  }
});

// ── Publish — composer jobs + scheduler + log ────────────────
// The send-to-platform call is LIVE for all platforms (see publishService.js).
// These routes add ZERO live Graph API reads: the account picker uses DB +
// cached status; the actual publish happens later in the scheduler worker.

// Account picker for the composer (rate-safe: IG from DB, others cached testConnection)
app.get('/api/social/publish/accounts', async (req, res) => {
  try {
    const out = [];
    // Instagram: multi-account, straight from DB (no API call at all)
    try {
      for (const a of await instagram.listAccounts()) {
        // Skip webhook-noise rows (e.g. entry.id "0") with no usable identity.
        if (!a.accountId || a.accountId === '0' || (!a.username && !a.name)) continue;
        out.push({
          platform: 'instagram',
          accountId: a.accountId,
          label: a.name || (a.username ? '@' + a.username : a.accountId),
          username: a.username || null,
          canPublish: a.canPublish === true, // false = registered from webhook, never OAuth-connected
        });
      }
    } catch (e) { console.error('publish/accounts instagram:', e.message); }
    // Single-account platforms: cached testConnection() (force=false → cache)
    const singles = { youtube, facebook, threads, linkedin };
    for (const [key, mod] of Object.entries(singles)) {
      try {
        const s = await mod.testConnection();
        if (s && s.connected) {
          out.push({
            platform: key,
            accountId: null,
            label: s.profile?.name || s.profile?.orgName ||
                   (s.profile?.username ? '@' + s.profile.username : key),
            username: s.profile?.username || null,
            canPublish: true, // single-account platforms only appear here when connected
          });
        }
      } catch (e) { console.error(`publish/accounts ${key}:`, e.message); }
    }
    res.json(out);
  } catch (err) {
    console.error('Publish accounts error:', err);
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

// List jobs / log
app.get('/api/social/publish/jobs', async (req, res) => {
  try {
    const { status, platform } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    const where = [], params = [];
    if (status)   { params.push(status);   where.push(`status = $${params.length}`); }
    if (platform) { params.push(platform); where.push(`platform = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, platform, account_id AS "accountId", account_label AS "accountLabel",
              post_type AS "postType", caption, media, details,
              schedule_type AS "scheduleType", scheduled_at AS "scheduledAt",
              status, attempts, last_error AS "error",
              external_post_id AS "externalPostId", result, simulated,
              created_by AS "createdBy", created_at AS "createdAt",
              published_at AS "publishedAt"
         FROM publish_jobs
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Publish jobs list error:', err);
    res.status(500).json({ error: 'Failed to load publish jobs' });
  }
});

// Create a job (immediate or scheduled)
// Resolve mediaIds → snapshot from the media library (order-preserving).
async function _resolvePublishMedia(mediaIds) {
  const ids = Array.isArray(mediaIds) ? mediaIds.filter(n => Number.isFinite(Number(n))) : [];
  if (!ids.length) return [];
  const { rows } = await pool.query(
    'SELECT id, title, cover_url, cover_type, files FROM media WHERE id = ANY($1::bigint[])', [ids]);
  const byId = new Map(rows.map(r => [String(r.id), r]));
  return ids.map(id => byId.get(String(id))).filter(Boolean).map(r => {
    const first = Array.isArray(r.files) && r.files[0] ? r.files[0] : null;
    return {
      mediaId: r.id, url: first?.url || r.cover_url, name: first?.name || r.title,
      mime: first?.mime || (r.cover_type === 'video' ? 'video/*' : 'image/*'),
    };
  });
}

// Resolve a secondary cover/thumbnail selection (reel cover) → public URL. Mutates details.
async function _resolvePublishThumb(details) {
  if (details && details.thumbnailMediaId != null) {
    const tid = Number(details.thumbnailMediaId);
    if (Number.isFinite(tid)) {
      const { rows: tr } = await pool.query('SELECT cover_url, files FROM media WHERE id=$1', [tid]);
      if (tr[0]) {
        const tf = Array.isArray(tr[0].files) && tr[0].files[0] ? tr[0].files[0] : null;
        details.thumbnailUrl = tf?.url || tr[0].cover_url || null;
      }
    }
  }
}

// Create publish job(s). Supports THREE modes via one endpoint:
//  - single post   (b.platform/accountId/postType)        → 1 job
//  - cross-post     (b.targets[] = [{platform,accountId,postType,details}]) → N jobs, shared caption+media
//  - draft          (b.scheduleType === 'draft')           → saved, not queued
// Authed (not adminOnly): members CAN compose, but their posts land as
// 'pending_review' for an admin to approve — that's the approval workflow.
app.post('/api/social/publish/jobs', async (req, res) => {
  try {
    const b = req.body || {};
    const media = await _resolvePublishMedia(b.mediaIds);
    const isMember = req.user?.role !== 'admin';

    // Normalize to a list of targets. A single-post body is one target.
    const targets = (Array.isArray(b.targets) && b.targets.length)
      ? b.targets
      : [{ platform: b.platform, accountId: b.accountId, accountLabel: b.accountLabel, postType: b.postType, details: b.details }];

    const isDraft = b.scheduleType === 'draft';
    const scheduleType = isDraft ? 'draft' : (b.scheduleType === 'scheduled' ? 'scheduled' : 'immediate');
    const scheduledAt = scheduleType === 'scheduled' ? new Date(b.scheduledAt).toISOString()
                      : scheduleType === 'immediate' ? new Date().toISOString() : null;
    const createdBy = req.user?.displayName || req.user?.email || 'Unknown';

    const created = [], errors = [];
    for (const t of targets) {
      const details = { ...(b.details || {}), ...(t.details || {}) };
      await _resolvePublishThumb(details);
      // The shape validatePublishJob + the IG check expect.
      const job = {
        platform: t.platform, accountId: t.accountId, accountLabel: t.accountLabel,
        postType: t.postType, caption: b.caption, details,
        scheduleType, scheduledAt: b.scheduledAt,
      };

      const vErr = publishService.validatePublishJob(job, media);
      if (vErr) { errors.push({ platform: t.platform, accountLabel: t.accountLabel, error: vErr }); continue; }

      // Instagram: the target account must be OAuth-connected (have a token).
      if (t.platform === 'instagram') {
        const { rows: acct } = await pool.query(
          'SELECT (token IS NOT NULL) AS connected FROM instagram_accounts WHERE account_id = $1', [t.accountId]);
        if (!acct[0] || !acct[0].connected) {
          errors.push({ platform: t.platform, accountLabel: t.accountLabel,
            error: `${t.accountLabel || 'This Instagram account'} isn't connected for publishing — reconnect it in Integrations.` });
          continue;
        }
      }

      // schedule_type only allows immediate|scheduled — a draft hasn't decided yet,
      // so it stores 'immediate' as a placeholder (the promote route sets the real one).
      const schedTypeCol = isDraft ? 'immediate' : scheduleType;
      // Members can't publish directly — their posts await admin approval.
      const jobStatus = isMember ? 'pending_review' : (isDraft ? 'draft' : 'queued');
      const { rows } = await pool.query(
        `INSERT INTO publish_jobs
           (platform, account_id, account_label, post_type, caption, media, details,
            schedule_type, scheduled_at, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [t.platform, t.accountId || null, t.accountLabel || null, t.postType,
         (b.caption || details.caption || details.text || null),
         JSON.stringify(media), JSON.stringify(details),
         schedTypeCol, scheduledAt, jobStatus, createdBy]);
      const id = rows[0].id;
      if (jobStatus === 'queued' && scheduleType === 'immediate') publishService.fireSoon(id);
      created.push({ id, platform: t.platform, accountLabel: t.accountLabel });
    }

    if (!created.length) {
      return res.status(400).json({ error: errors[0]?.error || 'No posts could be created', errors });
    }
    const finalStatus = isMember ? 'pending_review' : (isDraft ? 'draft' : scheduleType);
    logActivity(req, 'publish.create', 'publish_job', created[0].id, { count: created.length, status: finalStatus, platform: targets[0]?.platform });
    res.status(201).json({ ok: true, id: created[0].id, created, errors, count: created.length, scheduleType, status: finalStatus, pendingReview: isMember });
  } catch (err) {
    console.error('Publish create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create publish job' });
  }
});

// Promote a draft into the queue — publish now (no body) or schedule (scheduledAt).
app.post('/api/social/publish/jobs/:id/promote', adminOnly, async (req, res) => {
  try {
    const { scheduledAt } = req.body || {};
    const when = scheduledAt ? new Date(scheduledAt) : null;
    if (when && (isNaN(when) || when.getTime() < Date.now() - 60000))
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    const { rows } = await pool.query(
      `UPDATE publish_jobs SET status='queued', schedule_type=$2, scheduled_at=$3, last_error=NULL
        WHERE id=$1 AND status='draft' RETURNING id`,
      [req.params.id, when ? 'scheduled' : 'immediate', (when || new Date()).toISOString()]);
    if (!rows[0]) return res.status(409).json({ error: 'Only drafts can be promoted' });
    if (!when) publishService.fireSoon(rows[0].id);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Promote error:', err);
    res.status(500).json({ error: 'Failed to promote draft' });
  }
});

// Approve a member's pending post → queue it (publish now or honour its schedule).
app.post('/api/social/publish/jobs/:id/approve', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE publish_jobs SET status='queued', last_error=NULL
        WHERE id=$1 AND status='pending_review' RETURNING id, schedule_type, scheduled_at`,
      [req.params.id]);
    if (!rows[0]) return res.status(409).json({ error: 'Only posts awaiting review can be approved' });
    // Fire now unless it carries a future scheduled time.
    const future = rows[0].schedule_type === 'scheduled' && rows[0].scheduled_at && new Date(rows[0].scheduled_at).getTime() > Date.now();
    if (!future) publishService.fireSoon(rows[0].id);
    logActivity(req, 'publish.approve', 'publish_job', rows[0].id);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error('Approve error:', err); res.status(500).json({ error: 'Failed to approve' }); }
});

// Reject a member's pending post (kept in the log as 'rejected' with the reason).
app.post('/api/social/publish/jobs/:id/reject', adminOnly, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : 'Rejected by reviewer';
    const { rows } = await pool.query(
      `UPDATE publish_jobs SET status='rejected', last_error=$2
        WHERE id=$1 AND status='pending_review' RETURNING id`,
      [req.params.id, reason]);
    if (!rows[0]) return res.status(409).json({ error: 'Only posts awaiting review can be rejected' });
    logActivity(req, 'publish.reject', 'publish_job', rows[0].id, { reason });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { console.error('Reject error:', err); res.status(500).json({ error: 'Failed to reject' }); }
});

// Edit a draft or queued job — reschedule (calendar drag) and/or tweak the caption.
app.put('/api/social/publish/jobs/:id', adminOnly, async (req, res) => {
  try {
    const { scheduledAt, caption } = req.body || {};
    const sets = [], vals = [req.params.id]; let i = 2;
    if (scheduledAt !== undefined) {
      const when = new Date(scheduledAt);
      if (isNaN(when) || when.getTime() < Date.now() - 60000)
        return res.status(400).json({ error: 'Scheduled time must be in the future' });
      sets.push(`scheduled_at=$${i++}`, `schedule_type='scheduled'`); vals.push(when.toISOString());
    }
    if (caption !== undefined) { sets.push(`caption=$${i++}`); vals.push(caption); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    const { rows } = await pool.query(
      `UPDATE publish_jobs SET ${sets.join(', ')} WHERE id=$1 AND status IN ('draft','queued') RETURNING id`, vals);
    if (!rows[0]) return res.status(409).json({ error: 'Only draft or queued jobs can be edited' });
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Publish edit error:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// ── Caption templates + hashtag groups (composer helpers) ────────────
app.get('/api/social/content-templates', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, body, created_at AS "createdAt" FROM content_templates ORDER BY created_at DESC`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load templates' }); }
});
app.post('/api/social/content-templates', adminOnly, async (req, res) => {
  try {
    const { name, body } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO content_templates (name, body) VALUES ($1,$2) RETURNING id, name, body, created_at AS "createdAt"`,
      [String(name).trim(), String(body || '')]);
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to create template' }); }
});
app.put('/api/social/content-templates/:id', adminOnly, async (req, res) => {
  try {
    const { name, body } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE content_templates SET name=COALESCE($2,name), body=COALESCE($3,body) WHERE id=$1
       RETURNING id, name, body, created_at AS "createdAt"`,
      [req.params.id, name != null ? String(name).trim() : null, body != null ? String(body) : null]);
    if (!rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update template' }); }
});
app.delete('/api/social/content-templates/:id', adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM content_templates WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to delete template' }); }
});

app.get('/api/social/hashtag-groups', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, tags, created_at AS "createdAt" FROM hashtag_groups ORDER BY created_at DESC`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to load hashtag groups' }); }
});
app.post('/api/social/hashtag-groups', adminOnly, async (req, res) => {
  try {
    const { name, tags } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const clean = Array.isArray(tags) ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean) : [];
    const { rows } = await pool.query(
      `INSERT INTO hashtag_groups (name, tags) VALUES ($1,$2) RETURNING id, name, tags, created_at AS "createdAt"`,
      [String(name).trim(), JSON.stringify(clean)]);
    res.status(201).json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to create hashtag group' }); }
});
app.put('/api/social/hashtag-groups/:id', adminOnly, async (req, res) => {
  try {
    const { name, tags } = req.body || {};
    const clean = Array.isArray(tags) ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean) : null;
    const { rows } = await pool.query(
      `UPDATE hashtag_groups SET name=COALESCE($2,name), tags=COALESCE($3,tags) WHERE id=$1
       RETURNING id, name, tags, created_at AS "createdAt"`,
      [req.params.id, name != null ? String(name).trim() : null, clean ? JSON.stringify(clean) : null]);
    if (!rows[0]) return res.status(404).json({ error: 'Hashtag group not found' });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to update hashtag group' }); }
});
app.delete('/api/social/hashtag-groups/:id', adminOnly, async (req, res) => {
  try { await pool.query('DELETE FROM hashtag_groups WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to delete hashtag group' }); }
});

// Cancel a queued job
app.post('/api/social/publish/jobs/:id/cancel', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE publish_jobs SET status='canceled'
        WHERE id=$1 AND status='queued' RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Only queued jobs can be canceled' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Publish cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// Delete a publish-log row. For a LIVE published post this also removes the
// matching Content Library entry and attempts a platform-side delete (Instagram
// has no media-delete API, so that part is reported honestly, not silently failed).
app.delete('/api/social/publish/jobs/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM publish_jobs WHERE id=$1', [req.params.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });

    let postRemoved = false, platformDeleted = false, reason = null, permalink = null, alreadyGone = false;
    const isLivePost = job.status === 'published' && job.external_post_id && job.simulated !== true;

    if (isLivePost && job.platform !== 'instagram') {
      // Delete on the platform FIRST; only remove our rows if it actually worked
      // (or the post is already gone) — otherwise the Content Library row would
      // resync and the delete would look broken.
      const r = await publishService.deletePublishedPost(job).catch(e => ({ platformDeleted: false, reason: e.message }));
      platformDeleted = r.platformDeleted === true;
      reason = r.reason || null;
      alreadyGone = !platformDeleted && _isAlreadyGone(reason);
      if (!platformDeleted && !alreadyGone)
        return res.status(400).json({ error: _friendlyDeleteReason(job.platform, reason) });
    } else if (isLivePost) {
      // Instagram: no media-delete API — remove our records only, honestly.
      const r = await publishService.deletePublishedPost(job).catch(e => ({ platformDeleted: false, reason: e.message }));
      reason = r.reason || null;
    }

    if (isLivePost) {
      const { rows: pr } = await pool.query('SELECT id FROM platforms WHERE key=$1', [job.platform]);
      const platformId = pr[0]?.id;
      if (platformId) {
        const { rows: prows } = await pool.query(
          'SELECT permalink FROM posts WHERE platform_id=$1 AND external_id=$2', [platformId, job.external_post_id]);
        permalink = prows[0]?.permalink || null;
        const del = await pool.query('DELETE FROM posts WHERE platform_id=$1 AND external_id=$2', [platformId, job.external_post_id]);
        postRemoved = del.rowCount > 0;
      }
    }

    await pool.query('DELETE FROM publish_jobs WHERE id=$1', [req.params.id]);
    res.json({ ok: true, postRemoved, platformDeleted, alreadyGone, reason, permalink });
  } catch (err) {
    console.error('Publish delete error:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// Reports — generated from sync_snapshots history
app.get('/api/social/reports', async (req, res) => {
  try {
    const { rows: weeklyRows } = await pool.query(`
      SELECT platform, data, fetched_at
      FROM sync_snapshots
      WHERE period = '30D'
      ORDER BY fetched_at DESC
      LIMIT 20
    `);

    // Simple weekly grouping by taking the most recent snapshot per week
    const weekly = [];
    const seenWeeks = new Set();
    for (const row of weeklyRows) {
      const weekStart = new Date(row.fetched_at);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      if (seenWeeks.has(weekKey)) continue;
      seenWeeks.add(weekKey);
      const d = row.data;
      const totalAudience = d.followers || 0;
      const growth = d.growth || 0;
      const impressions = d.impressions || 0;
      const eng = d.engagementRate || 0;
      const weekLabel = `Week ${Math.ceil(weekStart.getDate() / 7)} · ${weekStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}`;
      weekly.push({
        id: `w${weekKey.replace(/-/g, '')}`,
        week: weekLabel,
        audience: totalAudience,
        growth,
        impressions,
        eng,
        status: 'ready',
      });
      if (weekly.length >= 5) break;
    }

    const { rows: monthlyRows } = await pool.query(`
      SELECT platform, data, fetched_at
      FROM sync_snapshots
      WHERE period = '30D'
      ORDER BY fetched_at DESC
      LIMIT 50
    `);

    const monthly = [];
    const seenMonths = new Set();
    for (const row of monthlyRows) {
      const monthKey = row.fetched_at.toISOString().slice(0, 7); // YYYY-MM
      if (seenMonths.has(monthKey)) continue;
      seenMonths.add(monthKey);
      const d = row.data;
      monthly.push({
        id: `m${monthKey.replace('-', '')}`,
        month: new Date(monthKey + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
        audience: d.followers || 0,
        growth: d.growth || 0,
        impressions: d.impressions || 0,
        eng: d.engagementRate || 0,
        status: 'ready',
      });
      if (monthly.length >= 5) break;
    }

    res.json({ weekly, monthly });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// Report-generation data — exact-range payload for the printable per-platform
// reports. DB-only (snapshots + posts + follower_samples): makes ZERO outbound
// platform calls, so it never touches the rate budget. Window-level stats
// (reach/impressions/extras) come from the snapshot whose period best matches
// the range; per-post and follower numbers are filtered to the exact range.
app.get('/api/social/reports/data', async (req, res) => {
  try {
    const data = await reportData.assembleReportData({
      platforms: req.query.platforms, from: req.query.from, to: req.query.to,
    });
    res.json(data);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Report data error:', err);
    res.status(500).json({ error: 'Failed to assemble report data' });
  }
});

// Settings
app.get('/api/social/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Failed to load settings' }); }
});

// ── Instagram credential management ─────────────────────────
app.get('/api/social/instagram/status', async (req, res) => {
  try {
    const status = await instagram.testConnection();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook inbox — stored DMs + comments for the Inbox page (read-only)
app.get('/api/social/instagram/inbox', async (req, res) => {
  try {
    // Resolve DM peer names via the Conversations API (throttled, fire-and-forget)
    instagram.resolveAllConversations().catch(() => {});
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const account = req.query.account || null;
    // Hide messages/comments from hidden or identity-less (noise) accounts so they
    // don't leak into the "All accounts" view after their chip is removed.
    const hiddenSub = `SELECT account_id FROM instagram_accounts WHERE COALESCE(hidden,false) OR (name IS NULL AND username IS NULL)`;
    const whereM = account
      ? `WHERE m.account_id = $2 AND m.account_id NOT IN (${hiddenSub})`
      : `WHERE m.account_id NOT IN (${hiddenSub})`;
    // Comments query doesn't take LIMIT anymore (per-post window cap below) so it
    // needs its own param numbering — $1 = account when present.
    const whereC = account
      ? `WHERE c.account_id = $1 AND c.account_id NOT IN (${hiddenSub})`
      : `WHERE c.account_id NOT IN (${hiddenSub})`;
    const params = account ? [limit, account] : [limit];
    const commentParams = account ? [account] : [];
    const [messages, comments, accounts] = await Promise.all([
      pool.query(
        // Per-ACCOUNT window cap (same technique as the per-post cap on comments
        // below). A flat LIMIT ordered by ts put every slot on the busiest account
        // (one account), so the Inbox — which fetches all accounts in one call and
        // filters client-side — showed "No conversations" for every other account.
        `SELECT id, mid, "accountId", "senderId", "recipientId", direction, text, attachments, ts,
                seen, "seenAt", "readByUs", "createdAt", "peerId", "peerUsername", "peerName", "peerPic"
           FROM (
             SELECT m.id, m.mid, m.account_id AS "accountId", m.sender_id AS "senderId",
                    m.recipient_id AS "recipientId", m.direction, m.text, m.attachments, m.ts,
                    m.seen, m.seen_at AS "seenAt", m.read_by_us AS "readByUs",
                    m.created_at AS "createdAt",
                    (CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END) AS "peerId",
                    u.username AS "peerUsername", u.name AS "peerName", u.profile_pic AS "peerPic",
                    ROW_NUMBER() OVER (PARTITION BY m.account_id
                                       ORDER BY m.ts DESC NULLS LAST, m.id DESC) AS rn
               FROM instagram_messages m
               LEFT JOIN instagram_users u
                 ON u.igsid = (CASE WHEN m.direction = 'incoming' THEN m.sender_id ELSE m.recipient_id END)
               ${whereM}
           ) t
          WHERE rn <= $1
          ORDER BY ts DESC NULLS LAST, id DESC`, params),
      pool.query(
        // Per-post window-function cap (50/post) — guarantees coverage of EVERY post
        // that has at least one comment. A flat LIMIT used to cluster all 500 returned
        // rows on the most-active 8 posts; with backfill bringing in 60+ posts, that
        // hid most of them. 50/post is plenty for Inbox triage; long threads can scroll.
        `SELECT id, "commentId", "accountId", "mediaId", "parentId", "fromId", "fromUsername",
                text, ts, "createdAt", "likeCount", "mediaCaption", "mediaThumbnail", "mediaPermalink", "mediaDate"
           FROM (
             SELECT c.id, c.comment_id AS "commentId", c.account_id AS "accountId",
                    c.media_id AS "mediaId", c.parent_id AS "parentId", c.from_id AS "fromId",
                    -- Instagram withholds some commenters' usernames; our reply to them
                    -- starts with "@theirhandle", so use that when we have it.
                    COALESCE(c.from_username, (
                      SELECT substring(r.text from '^@([A-Za-z0-9._]{1,30})') FROM instagram_comments r
                       WHERE r.parent_id = c.comment_id AND r.text ~ '^@[A-Za-z0-9._]'
                         AND lower(COALESCE(r.from_username, '')) IN (SELECT lower(username) FROM instagram_accounts WHERE username IS NOT NULL)
                       ORDER BY r.ts LIMIT 1)) AS "fromUsername", c.text, c.ts, c.created_at AS "createdAt",
                    c.like_count AS "likeCount",
                    COALESCE(p.caption, p.title) AS "mediaCaption",
                    p.thumbnail_url AS "mediaThumbnail", p.permalink AS "mediaPermalink",
                    p.date AS "mediaDate",
                    ROW_NUMBER() OVER (PARTITION BY c.media_id ORDER BY c.ts DESC NULLS LAST, c.id DESC) AS rn
               FROM instagram_comments c
               LEFT JOIN posts p ON p.external_id = c.media_id
                 AND p.platform_id = (SELECT id FROM platforms WHERE key = 'instagram' LIMIT 1)
               ${whereC}
           ) ranked
          WHERE rn <= 50
          ORDER BY ts DESC NULLS LAST, id DESC`, commentParams),
      instagram.listAccounts(),
    ]);
    // Self-heal: lazily resolve any DM senders missing a cached profile
    // (fire-and-forget, bounded — they fill in on the next refresh)
    const unresolved = new Map();
    for (const m of messages.rows) {
      // resolve peers with no name/username OR no profile picture yet (per-user
      // lookup fills the pic for consent-having users; throttled by its own cache)
      if (m.peerId && (!m.peerName && !m.peerUsername || !m.peerPic) && !unresolved.has(m.peerId)) {
        unresolved.set(m.peerId, m.accountId);
      }
    }
    let n = 0;
    for (const [igsid, accId] of unresolved) {
      if (n++ >= 10) break;
      instagram.resolveUserProfile(igsid, accId).catch(() => {});
    }

    res.json({ messages: messages.rows, comments: comments.rows, accounts });
  } catch (err) {
    console.error('inbox error:', err.message);
    res.status(500).json({ error: 'Failed to load Instagram inbox' });
  }
});

// Mark a conversation's incoming messages as read (clears its unread badge)
app.post('/api/social/instagram/conversations/read', async (req, res) => {
  try {
    const { accountId, peerId } = req.body || {};
    const r = await instagram.markConversationRead({ accountId, peerId });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reply to a DM (any authenticated team member can respond from the Inbox)
app.post('/api/social/instagram/reply', async (req, res) => {
  try {
    const { accountId, recipientId, text } = req.body || {};
    const r = await instagram.sendDirectMessage({ accountId, recipientId, text });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Facebook Messenger inbox (Social → Messenger) ───────────
// Polls the Page conversations at most every 20s (page opens, the Refresh
// button) on top of the 2-minute background poll and the webhook.
app.get('/api/social/messenger/inbox', async (req, res) => {
  try {
    if (req.query.sync !== '0') await messenger.syncAll().catch(() => {});
    res.json(await messenger.inbox({ pageId: req.query.page || null }));
  } catch (err) {
    console.error('messenger inbox error:', err.message);
    res.status(500).json({ error: 'Could not load Messenger conversations.' });
  }
});
app.get('/api/social/messenger/thread', async (req, res) => {
  try { res.json({ messages: await messenger.thread({ pageId: req.query.pageId, peerId: req.query.peerId, limit: req.query.limit }) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/social/messenger/sync', async (req, res) => {
  try { res.json(await messenger.syncAll({ force: true })); }
  catch (err) { res.status(500).json({ error: messenger.friendlyError(err) }); }
});
app.post('/api/social/messenger/read', async (req, res) => {
  try { res.json(await messenger.markRead(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/social/messenger/reply', async (req, res) => {
  try {
    const { pageId, peerId, text } = req.body || {};
    res.json(await messenger.reply({ pageId, peerId, text, userId: req.user?.id }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Reply to an Instagram comment from the Inbox Comments tab
app.post('/api/social/instagram/comments/:id/reply', async (req, res) => {
  try {
    const r = await instagram.replyToComment({ commentId: req.params.id, accountId: req.body?.accountId, message: req.body?.message });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete an Instagram comment (admin-only — irreversible)
app.delete('/api/social/instagram/comments/:id', adminOnly, async (req, res) => {
  try {
    res.json(await instagram.deleteComment(req.params.id, req.body?.accountId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Disconnect an Instagram account (unsubscribe webhook + drop token)
app.post('/api/social/instagram/disconnect', async (req, res) => {
  try {
    const r = await instagram.disconnectAccount(req.body?.accountId);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rename a connected account (friendly label for the Inbox filter)
app.post('/api/social/instagram/accounts/:id', adminOnly, async (req, res) => {
  try {
    await instagram.upsertAccount({ accountId: req.params.id, name: req.body?.name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update account' });
  }
});

app.post('/api/social/instagram/credentials', adminOnly, async (req, res) => {
  try {
    const { accountId, accessToken, appId } = req.body;
    if (!accountId || !accessToken) {
      return res.status(400).json({ error: 'accountId and accessToken are required' });
    }
    await instagram.saveCredentials({ accountId, accessToken, appId });
    const status = await instagram.testConnection();
    _triggerBackgroundSync('instagram');
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/instagram/refresh-token', adminOnly, async (req, res) => {
  try {
    const result = await instagram.refreshToken();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Facebook credential management ──────────────────────────
app.get('/api/social/facebook/oauth/init', (req, res) => {
  try {
    const url = facebook.getConsentUrl(req.query.mode === 'add' ? 'fb_add' : undefined);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save a Business Manager system-user token (or an already page-scoped token) directly.
// The escape hatch for when the OAuth dialog can't attach a Page asset. Admin-only; the
// token is a credential, so it is never echoed back and never logged.
app.post('/api/social/facebook/credentials', adminOnly, async (req, res) => {
  try {
    const r = await facebook.saveManualToken(req.body?.token);
    _triggerBackgroundSync('facebook');
    res.json({ ok: true, pageName: r.pageName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/social/facebook/status', async (req, res) => {
  try {
    const status = await facebook.testConnection(req.query.force === '1');
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Threads credential management ───────────────────────────
app.get('/api/social/threads/oauth/init', (req, res) => {
  try {
    const url = threads.getConsentUrl(req.query.mode === 'add' ? 'th_add' : undefined);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/social/threads/status', async (req, res) => {
  try {
    const status = await threads.testConnection(req.query.force === '1');
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/threads/credentials', adminOnly, async (req, res) => {
  try {
    const { userId, accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
    const result = await threads.saveCredentials({ userId, accessToken });
    const status = await threads.testConnection(true);
    _triggerBackgroundSync('threads');
    res.json({ ok: true, ...result, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/threads/refresh-token', adminOnly, async (req, res) => {
  try {
    const result = await threads.refreshToken();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LinkedIn credential management ──────────────────────────
app.get('/api/social/linkedin/oauth/init', (req, res) => {
  try {
    const url = linkedin.getConsentUrl(req.query.mode === 'add' ? 'li_add' : undefined);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/social/linkedin/status', async (req, res) => {
  try {
    const status = await linkedin.testConnection(req.query.force === '1');
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/linkedin/credentials', adminOnly, async (req, res) => {
  try {
    const { accessToken, orgId } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
    const result = await linkedin.saveCredentials({ accessToken, orgId });
    const status = await linkedin.testConnection(true);
    _triggerBackgroundSync('linkedin');
    res.json({ ok: true, ...result, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/linkedin/refresh-token', adminOnly, async (req, res) => {
  try {
    const result = await linkedin.refreshToken();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── YouTube credential management ───────────────────────────
app.get('/api/social/youtube/oauth/init', (req, res) => {
  try {
    // ?mode=add → carry a state so the callback APPENDS a new channel.
    const url = youtube.getConsentUrl(req.query.mode === 'add' ? 'yt_add' : undefined);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/social/youtube/status', async (req, res) => {
  try {
    const status = await youtube.testConnection(req.query.force === '1');
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/youtube/credentials', adminOnly, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    await youtube.saveCredentials({ refreshToken });
    const status = await youtube.testConnection(true);
    _triggerBackgroundSync('youtube');
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Facebook + YouTube comments (Inbox) ─────────────────────
// Read endpoints are pure DB reads (the cron / sync triggers populate them).
// Reply endpoints make the real Graph/Data-API write, then kick a background
// re-poll so our own reply lands in the store.
app.get('/api/social/facebook/comments', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    // LEFT JOIN posts so each row carries the parent post's thumbnail/caption/date
    // (frontend groups by postId and shows a card per post). Zero Graph calls —
    // posts is already populated by the regular sync.
    const { rows } = await pool.query(
      `SELECT c.id, c.comment_id AS "commentId", c.post_id AS "postId", c.parent_id AS "parentId",
              c.from_id AS "fromId", c.from_name AS "fromName", c.from_pic AS "fromPic",
              c.message, c.like_count AS "likeCount", c.liked_by_us AS "likedByUs",
              c.permalink, c.ts, c.created_at AS "createdAt",
              p.thumbnail_url AS "postThumbnail",
              COALESCE(NULLIF(p.caption, ''), p.title) AS "postCaption",
              p.permalink AS "postPermalink",
              p.date AS "postDate"
         FROM facebook_comments c
         LEFT JOIN posts p
           ON p.external_id = c.post_id
          AND p.platform_id = (SELECT id FROM platforms WHERE key = 'facebook' LIMIT 1)
        ORDER BY c.ts DESC NULLS LAST, c.id DESC
        LIMIT $1`, [limit]);
    let connected = false, me = null;
    try {
      const s = await facebook.testConnection();
      connected = s.connected === true;
      if (s.profile) me = { id: s.profile.id, name: s.profile.name, pic: s.profile.pictureUrl };
    } catch (_) {}
    res.json({ comments: rows, connected, me });
  } catch (err) {
    console.error('fb comments error:', err.message);
    res.status(500).json({ error: 'Failed to load Facebook comments' });
  }
});

app.post('/api/social/facebook/comments/sync', async (req, res) => {
  try {
    const count = await facebook.syncComments({ force: true });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/facebook/comments/:id/reply', async (req, res) => {
  try {
    const r = await facebook.replyToComment({ commentId: req.params.id, message: req.body?.message });
    facebook.syncComments({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/social/facebook/comments/:id', adminOnly, async (req, res) => {
  try {
    res.json(await facebook.deleteComment(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/facebook/comments/:id/like', async (req, res) => {
  try {
    res.json(await facebook.likeComment(req.params.id, req.body?.like !== false));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/social/youtube/comments', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { rows } = await pool.query(
      `SELECT c.id, c.comment_id AS "commentId", c.video_id AS "videoId", c.parent_id AS "parentId",
              c.author_name AS "authorName", c.author_channel_id AS "authorChannelId",
              c.author_pic AS "authorPic", c.text, c.like_count AS "likeCount",
              c.ts, c.created_at AS "createdAt",
              p.thumbnail_url AS "postThumbnail",
              COALESCE(NULLIF(p.title, ''), p.caption) AS "postCaption",
              p.permalink AS "postPermalink",
              p.date AS "postDate"
         FROM youtube_comments c
         LEFT JOIN posts p
           ON p.external_id = c.video_id
          AND p.platform_id = (SELECT id FROM platforms WHERE key = 'youtube' LIMIT 1)
        ORDER BY c.ts DESC NULLS LAST, c.id DESC
        LIMIT $1`, [limit]);
    let connected = false, me = null;
    try {
      const s = await youtube.testConnection();
      connected = s.connected === true;
      if (s.profile) me = { id: s.profile.channelId, name: s.profile.name, pic: s.profile.thumbnailUrl };
    } catch (_) {}
    res.json({ comments: rows, connected, me });
  } catch (err) {
    console.error('yt comments error:', err.message);
    res.status(500).json({ error: 'Failed to load YouTube comments' });
  }
});

app.post('/api/social/youtube/comments/sync', async (req, res) => {
  try {
    const count = await youtube.syncComments({ force: true });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/youtube/comments/:id/reply', async (req, res) => {
  try {
    // :id is the top-level comment id to reply under.
    const r = await youtube.replyToComment({ parentId: req.params.id, text: req.body?.text });
    youtube.syncComments({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/social/youtube/comments/:id', adminOnly, async (req, res) => {
  try {
    res.json(await youtube.deleteComment(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Threads comments (Inbox) ────────────────────────────────
// Same pattern as Facebook/YouTube: DB read for the list, sync to force a poll,
// real Graph write for reply, DELETE for own / hide for others'.
app.get('/api/social/threads/comments', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { rows } = await pool.query(
      `SELECT c.id, c.comment_id AS "commentId", c.thread_id AS "threadId", c.parent_id AS "parentId",
              c.account_key AS "accountKey", c.author_username AS "authorUsername",
              c.text, c.permalink, c.ts, c.created_at AS "createdAt",
              p.thumbnail_url AS "postThumbnail",
              COALESCE(NULLIF(p.caption, ''), p.title) AS "postCaption",
              p.permalink AS "postPermalink",
              p.date AS "postDate"
         FROM threads_comments c
         LEFT JOIN posts p
           ON p.external_id = c.thread_id
          AND p.platform_id = (SELECT id FROM platforms WHERE key = 'threads' LIMIT 1)
        ORDER BY c.ts DESC NULLS LAST, c.id DESC
        LIMIT $1`, [limit]);
    let connected = false, me = null;
    try {
      me = await threads.getMe();
      connected = !!me;
    } catch (_) {}
    res.json({ comments: rows, connected, me });
  } catch (err) {
    console.error('th comments error:', err.message);
    res.status(500).json({ error: 'Failed to load Threads comments' });
  }
});

app.post('/api/social/threads/comments/sync', async (req, res) => {
  try {
    const count = await threads.syncComments({ force: true });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/threads/comments/:id/reply', async (req, res) => {
  try {
    const r = await threads.replyToComment({ commentId: req.params.id, text: req.body?.text });
    threads.syncComments({ force: true }).catch(() => {});
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/social/threads/comments/:id', adminOnly, async (req, res) => {
  try {
    res.json(await threads.deleteComment(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Contacts (CRM-style list auto-built from IG DMs) ────────
// Listing supports: ?q= (name/username/peerId/notes search), ?account= (filter
// to a single connected IG account), ?peer= (filter to a single peer IGSID — used
// by the IG chat header tag picker to find the right contact), ?limit= (max 1000).
// Always sorted by last_seen_at desc.
app.get('/api/social/contacts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    const account = req.query.account || null;
    const peer    = req.query.peer    || null;
    const q = (req.query.q || '').trim();
    const conds = [`c.platform = 'instagram'`];
    // Same visibility rule as the Inbox: contacts from hidden or identity-less
    // accounts (auto-registered noise) must not appear — otherwise a contact is
    // clickable here but its conversation is invisible in the Inbox ("Go to
    // chat" lands on an empty thread and the account filter zeroes the counts).
    conds.push(`c.account_id NOT IN (SELECT account_id FROM instagram_accounts WHERE COALESCE(hidden,false) OR (name IS NULL AND username IS NULL))`);
    const params = [];
    if (account) { params.push(account); conds.push(`c.account_id = $${params.length}`); }
    if (peer)    { params.push(peer);    conds.push(`c.peer_id    = $${params.length}`); }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      conds.push(`(LOWER(c.name) LIKE $${params.length} OR LOWER(c.username) LIKE $${params.length} OR c.peer_id LIKE $${params.length} OR LOWER(COALESCE(c.notes,'')) LIKE $${params.length})`);
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT c.id, c.platform, c.account_id AS "accountId", c.peer_id AS "peerId",
              c.name, c.username, c.profile_pic AS "profilePic", c.notes, c.tags,
              c.first_seen_at AS "firstSeenAt", c.last_seen_at AS "lastSeenAt",
              c.last_msg_preview AS "lastMsgPreview", c.last_msg_dir AS "lastMsgDir",
              c.message_count AS "messageCount",
              a.name AS "accountName", a.username AS "accountUsername"
         FROM contacts c
         LEFT JOIN instagram_accounts a ON a.account_id = c.account_id
        WHERE ${conds.join(' AND ')}
        ORDER BY c.last_seen_at DESC NULLS LAST, c.id DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ contacts: rows, total: rows.length });
  } catch (err) {
    console.error('contacts list error:', err.message);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

app.get('/api/social/contacts/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.platform, c.account_id AS "accountId", c.peer_id AS "peerId",
              c.name, c.username, c.profile_pic AS "profilePic", c.notes, c.tags,
              c.first_seen_at AS "firstSeenAt", c.last_seen_at AS "lastSeenAt",
              c.last_msg_preview AS "lastMsgPreview", c.last_msg_dir AS "lastMsgDir",
              c.message_count AS "messageCount",
              a.name AS "accountName", a.username AS "accountUsername"
         FROM contacts c
         LEFT JOIN instagram_accounts a ON a.account_id = c.account_id
        WHERE c.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit name / notes (admin). Identity (username, profile_pic, account_id, peer_id)
// is API-resolved and intentionally not editable here.
app.post('/api/social/contacts/:id', adminOnly, async (req, res) => {
  try {
    const { name, notes } = req.body || {};
    const sets = [], params = [];
    if (name !== undefined)  { params.push(name);  sets.push(`name = $${params.length}`); }
    if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, notes`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a contact (admin). Doesn't delete the underlying messages — a new DM
// from the same peer will recreate the contact on the next ingest.
app.delete('/api/social/contacts/:id', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set tag ids on a contact (replaces the whole array). Tag-attachment is an
// operational/CRM action so it's user-allowed (vs. name/notes which are admin-only).
// Body: { tags: ["tag-id-1", "tag-id-2", ...] }.
app.post('/api/social/contacts/:id/tags', async (req, res) => {
  try {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    if (tags.length > 50) return res.status(400).json({ error: 'Too many tags (max 50)' });
    if (!tags.every(t => typeof t === 'string')) return res.status(400).json({ error: 'tags must be strings' });
    const { rows } = await pool.query(
      `UPDATE contacts SET tags = $1 WHERE id = $2 RETURNING id, tags`,
      [JSON.stringify(tags), req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Categories (admin-managed; read is user-allowed for the tag picker) ─────
app.get('/api/social/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.description, c.created_at AS "createdAt",
              (SELECT COUNT(*)::int FROM tags t WHERE t.category_id = c.id) AS "tagCount"
         FROM categories c ORDER BY LOWER(c.name)`);
    res.json({ categories: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const _slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('id-' + Date.now().toString(36));

app.post('/api/social/categories', adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const description = (req.body?.description || '').trim() || null;
    if (!name) return res.status(400).json({ error: 'name is required' });
    let id = _slugify(name);
    // ensure unique slug
    const { rows: existing } = await pool.query('SELECT id FROM categories WHERE id LIKE $1', [id + '%']);
    if (existing.some(r => r.id === id)) id = id + '-' + Date.now().toString(36).slice(-4);
    const { rows } = await pool.query(
      `INSERT INTO categories (id, name, description) VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at AS "createdAt"`,
      [id, name, description]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/social/categories/:id', adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const description = (req.body?.description ?? '').trim() || null;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `UPDATE categories SET name = $1, description = $2, updated_at = now()
        WHERE id = $3
       RETURNING id, name, description, created_at AS "createdAt"`,
      [name, description, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/social/categories/:id', adminOnly, async (req, res) => {
  try {
    // FK ON DELETE CASCADE drops the tags; contact_tags JSONB will keep stale ids,
    // but the frontend filters tags-that-no-longer-exist anyway (defensive).
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Tags (admin-managed; read is user-allowed for the tag picker) ───────────
app.get('/api/social/tags', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.color, t.category_id AS "categoryId",
              c.name AS "categoryName", t.created_at AS "createdAt"
         FROM tags t LEFT JOIN categories c ON c.id = t.category_id
        ORDER BY LOWER(t.name)`);
    res.json({ tags: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/tags', adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '#dc2626').trim();
    const categoryId = (req.body?.categoryId || '').trim() || null;
    if (!name)       return res.status(400).json({ error: 'name is required' });
    if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'color must be a #rrggbb hex' });
    // Validate category exists
    const { rows: cats } = await pool.query('SELECT id FROM categories WHERE id = $1', [categoryId]);
    if (!cats[0]) return res.status(400).json({ error: 'Unknown categoryId' });
    let id = _slugify(name);
    const { rows: existing } = await pool.query('SELECT id FROM tags WHERE id LIKE $1', [id + '%']);
    if (existing.some(r => r.id === id)) id = id + '-' + Date.now().toString(36).slice(-4);
    const { rows } = await pool.query(
      `INSERT INTO tags (id, name, color, category_id) VALUES ($1, $2, $3, $4)
       RETURNING id, name, color, category_id AS "categoryId", created_at AS "createdAt"`,
      [id, name, color, categoryId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/social/tags/:id', adminOnly, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '').trim();
    const categoryId = (req.body?.categoryId || '').trim() || null;
    if (!name)       return res.status(400).json({ error: 'name is required' });
    if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'color must be a #rrggbb hex' });
    const { rows: cats } = await pool.query('SELECT id FROM categories WHERE id = $1', [categoryId]);
    if (!cats[0]) return res.status(400).json({ error: 'Unknown categoryId' });
    const { rows } = await pool.query(
      `UPDATE tags SET name = $1, color = $2, category_id = $3, updated_at = now()
        WHERE id = $4
       RETURNING id, name, color, category_id AS "categoryId", created_at AS "createdAt"`,
      [name, color || '#dc2626', categoryId, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/social/tags/:id', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM tags WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    // Pre-existing contact rows keep the stale tag id in their JSONB array — the
    // frontend filters unknown ids out at display time, so no migration needed.
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Sync routes ─────────────────────────────────────────────
app.post('/api/social/sync', adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, message: 'Sync started in background' });
    // Run sync in background so client isn't blocked
    syncService.syncAll().then(results => {
      console.log('Auto sync completed:', results.map(r => `${r.platform}:${r.success ? 'ok' : 'fail'}`).join(', '));
    }).catch(err => {
      console.error('Auto sync error:', err);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/sync/:platform', adminOnly, async (req, res) => {
  try {
    const { platform } = req.params;
    const { fullSync = false } = req.body || {};
    const result = await syncService.syncPlatform(platform, { fullSync });
    if (result.success) {
      res.json({ ok: true, ...result });
    } else {
      res.status(502).json({ ok: false, ...result });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/social/sync/status', async (req, res) => {
  try {
    const status = await syncService.getSyncStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-sync on credential save helpers ─────────────────────
function _triggerBackgroundSync(platform) {
  setTimeout(() => {
    syncService.syncPlatform(platform).then(result => {
      console.log(`Auto-sync after credential save for ${platform}:`, result.success ? 'ok' : result.error);
    }).catch(err => {
      console.error(`Auto-sync error for ${platform}:`, err.message);
    });
  }, 1000);
}

// AI Models (provider credentials) and the agent-run AI Usage dashboard were removed on 2026-10-11:
// every AI feature now runs through OpenRouter (Settings → OpenRouter, services/openRouter.js).


// ════════════════════════════════════════════════════════════════════
// AI Agents — CRUD + tools + runs + test. Reads user-allowed; writes admin.
// ════════════════════════════════════════════════════════════════════
function sendAgentErr(res, err, fallback) {
  if (err instanceof agentService.ApiError) return res.status(err.status).json({ error: err.message });
  console.error(`[agents] ${fallback}:`, err.message);
  return res.status(500).json({ error: fallback });
}

// Channel account picker for the builder (connected social accounts).
app.get('/api/social/agents/meta/accounts', async (req, res) => {
  try {
    const { accounts: list } = await mcpService.listConnectedAccounts();
    res.json({ accounts: list });
  } catch (err) { console.error('[agents] accounts:', err.message); res.status(500).json({ error: 'Failed to load accounts' }); }
});

app.get('/api/social/agents', async (req, res) => {
  try { res.json(await agentService.listAgents()); }
  catch (err) { sendAgentErr(res, err, 'Failed to list agents'); }
});

app.get('/api/social/agents/:id', async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json(agent);
  } catch (err) { sendAgentErr(res, err, 'Failed to fetch agent'); }
});

app.post('/api/social/agents', adminOnly, async (req, res) => {
  try { res.status(201).json(await agentService.createAgent({ ...(req.body || {}), createdBy: req.user?.id })); }
  catch (err) { sendAgentErr(res, err, 'Failed to create agent'); }
});

app.put('/api/social/agents/:id', adminOnly, async (req, res) => {
  try { res.json(await agentService.updateAgent(req.params.id, req.body || {})); }
  catch (err) { sendAgentErr(res, err, 'Failed to update agent'); }
});

app.delete('/api/social/agents/:id', adminOnly, async (req, res) => {
  try { res.json(await agentService.deleteAgent(req.params.id)); }
  catch (err) { sendAgentErr(res, err, 'Failed to delete agent'); }
});

app.post('/api/social/agents/:id/tools', adminOnly, async (req, res) => {
  try { res.status(201).json(await agentService.addTool(req.params.id, req.body || {})); }
  catch (err) { sendAgentErr(res, err, 'Failed to add tool'); }
});

app.put('/api/social/agents/:id/tools/:toolId', adminOnly, async (req, res) => {
  try { res.json(await agentService.updateTool(req.params.id, req.params.toolId, req.body || {})); }
  catch (err) { sendAgentErr(res, err, 'Failed to update tool'); }
});

app.delete('/api/social/agents/:id/tools/:toolId', adminOnly, async (req, res) => {
  try { res.json(await agentService.deleteTool(req.params.id, req.params.toolId)); }
  catch (err) { sendAgentErr(res, err, 'Failed to delete tool'); }
});

app.get('/api/social/agents/:id/runs', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '50', 10)));
    const { rows } = await pool.query(
      `SELECT id, agent_id AS "agentId", platform, channel, account_id AS "accountId", peer_id AS "peerId",
              inbound_ref AS "inboundRef", trigger_label AS "triggerLabel", status,
              total_input_tokens AS "totalInputTokens", total_output_tokens AS "totalOutputTokens",
              final_reply AS "finalReply", error_message AS "errorMessage", started_at AS "startedAt", ended_at AS "endedAt"
         FROM agent_runs WHERE agent_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [req.params.id, limit]);
    res.json(rows);
  } catch (err) { console.error('[agents] runs:', err.message); res.status(500).json({ error: 'Failed to fetch runs' }); }
});

app.get('/api/social/agents/:id/runs/:runId', async (req, res) => {
  try {
    const { rows: runs } = await pool.query('SELECT * FROM agent_runs WHERE id = $1 AND agent_id = $2', [req.params.runId, req.params.id]);
    if (runs.length === 0) return res.status(404).json({ error: 'Not found' });
    const { rows: steps } = await pool.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY step_index', [req.params.runId]);
    const r = runs[0];
    res.json({
      id: r.id, agentId: r.agent_id, platform: r.platform, channel: r.channel, accountId: r.account_id,
      peerId: r.peer_id, inboundRef: r.inbound_ref, status: r.status,
      totalInputTokens: r.total_input_tokens, totalOutputTokens: r.total_output_tokens,
      finalReply: r.final_reply, errorMessage: r.error_message, startedAt: r.started_at, endedAt: r.ended_at,
      steps: steps.map(s => ({ id: s.id, stepIndex: s.step_index, stepType: s.step_type, toolType: s.tool_type, input: s.input, output: s.output, status: s.status, latencyMs: s.latency_ms, errorMessage: s.error_message, createdAt: s.created_at })),
    });
  } catch (err) { console.error('[agents] run detail:', err.message); res.status(500).json({ error: 'Failed to fetch run' }); }
});

app.post('/api/social/agents/:id/test', adminOnly, async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages must be a non-empty array of {role,content}' });
    res.json(await agentEngine.runAgentTest({ agentId: req.params.id, messages }));
  } catch (err) { console.error('[agents] test:', err.message); res.status(500).json({ error: err.message || 'Agent test failed' }); }
});

// ── 404 handler (must be after ALL routes) ───────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ──────────────────────────────────────────────────
// Boot one-shots that spend platform API calls run only if they haven't run in
// the last `minMinutes` (across restarts — stamped in Redis). Several deploys in
// an hour used to repeat every backfill and drain the 180/h Instagram budget
// that replies and automations need; the regular crons still cover them.
async function bootOnce(name, minMinutes, fn) {
  const redis = require('./redis');
  const key = `forgesocial:boot:${name}`;
  try {
    if (redis && !(await redis.set(key, String(Date.now()), 'EX', minMinutes * 60, 'NX'))) {
      console.log(`Boot ${name}: skipped (ran in the last ${minMinutes} min)`);
      return;
    }
  } catch (_) { /* Redis down: just run it */ }
  return fn();
}

// Follower sampler — ONE stored reading per connected account every 6 hours
// (00:00 / 06:00 / 12:00 / 18:00 IST = 4 points a day). The followers chart
// plots only these stored readings. Runs whether or not background jobs are on:
// it is one read-only followers_count call per account that already has a token.
// The boot one-shot is skipped if a reading was taken in the last 6 hours, so a
// restart never adds an off-schedule point.
function startFollowerSampler() {
  const sample = () => syncService.recordFollowerSamples()
    .then(n => console.log(`[social] follower sampler recorded ${n} reading(s)`))
    .catch(err => console.error('[social] follower sampler error:', err.message));
  cron.schedule('30 0,6,12,18 * * *', sample);   // UTC = 06:00/12:00/18:00/00:00 IST
  setTimeout(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM follower_samples WHERE sampled_at > now() - interval '6 hours' LIMIT 1`);
      if (!rows.length) await sample();
    } catch (err) { console.error('[social] follower boot sample:', err.message); }
  }, 30000);
  console.log('[social] follower sampler scheduled every 6 hours (00/06/12/18 IST)');
}

// Called once by ForgeGrowth's index.js after the app is listening.
// Schema setup always runs (it only ever creates/extends the social schema).
// Background jobs (platform syncs, publishing, automations, token refresh) run
// only when SOCIAL_JOBS_ENABLED=1, so deploying this code is inert until the
// new Meta/Google/LinkedIn apps are configured.
async function start() {
  try {
    await ensureTables();
    console.log('[social] database ready (schema ' + pool.schema + ')');
    await require('./credentials').load().catch(err => console.error('[social] credentials load:', err.message));
    // Feature tables that ForgeSocial created lazily (or only when its workers
    // started). Created up front so the import and the pages find them even
    // while background jobs are off.
    await require('./services/commentAutomation').ensureSchema().catch(err => console.error('[social] automations schema:', err.message));
    await require('./services/commentAnalyzer').ensureSchema().catch(err => console.error('[social] analyzer schema:', err.message));
    await require('./contactsCrm').ensureSchema().catch(err => console.error('[social] crm schema:', err.message));
    // Telegram bot poller + negative-comment alerts. Started even with background
    // jobs OFF: the bot has nothing to do with the Meta apps, and an admin must be
    // able to connect it and approve chats first (both idle until configured).
    // Comment Analyzer: classify new comments every 10 min — only when its own
    // 'Analyse automatically' switch is on (services/commentAnalyzer.js). It used to
    // sit behind SOCIAL_JOBS_ENABLED, which made that switch do nothing.
    require('./services/commentAnalyzer').start();
    require('./services/commentAlerts').start();
    require('./services/telegramBot').start();
    // Messenger inbox poll — read-only, idle until a Page token exists. Not
    // behind SOCIAL_JOBS_ENABLED for the same reason as the Telegram bot.
    messenger.start();
    if (socialEnv.JOBS_ENABLED !== '1') {
      console.log('[social] background jobs OFF (set SOCIAL_JOBS_ENABLED=1 to enable)');
      // Follower counts still need refreshing even with jobs off.
      startFollowerSampler();
      return;
    }

    // Auto-sync every 30 minutes (lightweight — period snapshots only)
    const intervalMin = parseInt(socialEnv.SYNC_INTERVAL_MINUTES || '30', 10);
    const cronExpr = intervalMin < 60
      ? `*/${intervalMin} * * * *`
      : `0 */${Math.floor(intervalMin / 60)} * * *`;
    cron.schedule(cronExpr, async () => {
      console.log(`[${new Date().toISOString()}] Running scheduled sync...`);
      try {
        const results = await syncService.syncAll({ fullSync: false });
        console.log('Scheduled sync completed:', results.map(r => `${r.platform}:${r.success ? 'ok' : 'fail'}`).join(', '));
        // Poll Facebook + YouTube comments into the Inbox (IG uses webhooks)
        const cmts = await syncService.syncComments();
        console.log('Comment poll completed:', cmts.map(r => `${r.platform}:${r.success ? r.count : 'fail'}`).join(', '));
        // AI agent auto-reply: sweep freshly-synced comments for active agents.
        agentDispatch.sweepComments().catch(() => {});
      } catch (err) {
        console.error('Scheduled sync error:', err);
      }
    });
    console.log(`Auto-sync scheduled every ${intervalMin} minutes (${cronExpr})`);
    startFollowerSampler();

    // Per-post daily metric log — one row per post per IST day, straight from the
    // `posts` table (no API calls). Runs at 03:40 AM (right after the 3 AM full
    // historical sync refreshes every post's counters) so each day's row holds
    // that day's freshest lifetime numbers, and once on boot so a restarted
    // container still logs the day. Re-runs update the same row.
    cron.schedule('40 3 * * *', () => {
      syncService.recordPostMetricSamples()
        .then(n => console.log(`[daily] post metrics logged for ${n} post(s)`))
        .catch(err => console.error('[daily] post metrics error:', err.message));
    });
    setTimeout(() => { syncService.recordPostMetricSamples().catch(() => {}); }, 240000);
    console.log('Daily per-post metric logging scheduled for 03:40 (+ boot one-shot)');

    // One-shot content categorization backfill — fills posts.topic for every
    // existing post (rule-based, DB-only, zero API cost). Future syncs keep it
    // current via recalculateScores. Delayed so schema seed (content_themes) settles.
    setTimeout(() => {
      categorize.recategorizeAll({ onlyNull: true })
        .then(r => console.log(`Boot categorization: tagged ${r.updated}/${r.scanned} posts`, r.byTopic))
        .catch(err => console.error('Boot categorization error:', err.message));
    }, 60000);

    // One-shot comments backfill at boot (IG/FB/YT/Threads). Webhook ingest covers
    // future deltas; this catches up anything that pre-dates the webhook or was
    // missed during downtime. Delayed so the DB schema check + first auto-sync
    // settle first; runs in the background so it never blocks the listen.
    setTimeout(() => bootOnce('comments-backfill', 25, () => syncService.syncComments()
        .then(rs => console.log('Boot comments backfill:', rs.map(r => `${r.platform}:${r.success ? r.count : 'fail(' + (r.error || '') + ')'}`).join(', ')))
        .catch(err => console.error('Boot comments backfill error:', err.message))), 90000);

    // Flow Builder: resume delayed flow runs every 30 s (services/flowEngine.js).
    require('./services/flowEngine').start();
    // Quick Automations: send due follow-ups every minute (services/commentAutomation.js).
    require('./services/commentAutomation').start();
    require('./contactsCrm').ensureSchema().catch(err => console.error('[crm] schema:', err.message));
    // Follow status: check a few contacts per account every 5 min (contactsCrm.js).
    require('./contactsCrm').startFollowSweep();

    // Heal backfilled DMs stored in the raw Conversations-API attachment shape
    // (pure DB, zero Graph calls) so shared reels/posts render in the Inbox.
    setTimeout(() => {
      instagram.normalizeStoredAttachments().catch(err => console.error('IG attachment normalise error:', err.message));
    }, 15000);

    // Boot one-shot IG MESSAGE backfill (chats from /me/conversations). Webhook
    // captures live deltas; this fills history that pre-dates the webhook. Also
    // runs every 6 hours so anything missed during downtime catches up. ~10 min
    // self-throttle inside instagram.syncMessages so manual triggers won't spam.
    setTimeout(() => bootOnce('ig-message-backfill', 180, () => instagram.syncMessages({ force: true })
        .then(n => console.log(`Boot IG message backfill: ${n} messages touched`))
        .catch(err => console.error('Boot IG message backfill error:', err.message))), 120000);
    cron.schedule('0 */6 * * *', () => {
      instagram.syncMessages({ force: true })
        .then(n => console.log(`[6h] IG message backfill: ${n} messages touched`))
        .catch(err => console.error('IG message backfill error:', err.message));
    });

    // Complete historical backfill — seed the queue once, then drain it on a
    // 15-min worker tick. Rate-limited + resumable, so it runs as long as needed
    // without ever exceeding a platform's API limit. Kick a first tick on boot.
    await backfillService.ensureSeeded().catch((e) => console.error('Backfill seed error:', e.message));
    cron.schedule('*/15 * * * *', () => {
      backfillService.tick().catch((err) => console.error('Backfill worker error:', err.message));
    });
    setTimeout(() => { backfillService.tick().catch(() => {}); }, 150000);
    console.log('Backfill worker scheduled every 15 minutes');

    // Daily full historical sync at 3:00 AM
    cron.schedule('0 3 * * *', async () => {
      console.log(`[${new Date().toISOString()}] Running daily full historical sync...`);
      try {
        const results = await syncService.syncAll({ fullSync: true });
        console.log('Daily full sync completed:', results.map(r => `${r.platform}:${r.success ? 'ok' : 'fail'}`).join(', '));
      } catch (err) {
        console.error('Daily full sync error:', err);
      }
    });
    console.log('Daily full historical sync scheduled for 3:00 AM');

    // Publish scheduler — fire due posting jobs every 60s (stub mode: no real API calls).
    await publishService.reapStalePublishing().catch(() => {});
    cron.schedule('* * * * *', () => {
      publishService.runDueJobs().catch(err =>
        console.error('Publish worker error:', err.message));
    });
    console.log('Publish scheduler running every 60s');

    // Fast lane — comment + new-post freshness every few minutes. Cheap by
    // design: FB = ONE Graph call (comments stream + post upsert, ~12/hr vs
    // 180/hr budget), YT = 1-page commentThreads (1 quota unit, ~288/day vs
    // 10k), Threads = 1 call/account. Instagram is skipped — its webhooks are
    // already realtime. This is what keeps comment response times short; the
    // 30-min cron remains the deep pass (5-page YT depth + deletion pruning).
    const fastMin = parseInt(socialEnv.FAST_SYNC_INTERVAL_MINUTES || '15', 10);
    if (fastMin > 0) {
      cron.schedule(`*/${fastMin} * * * *`, async () => {
        try {
          const rs = await syncService.syncComments({ fast: true });
          const failed = rs.filter(r => !r.success);
          if (failed.length) console.warn('Fast comment poll failures:', failed.map(r => `${r.platform}: ${r.error}`).join(' | '));
          agentDispatch.sweepComments().catch(() => {});
        } catch (err) {
          console.error('Fast comment poll error:', err.message);
        }
      });
      console.log(`Fast comment/post poll scheduled every ${fastMin} minutes (FB/YT/Threads; IG via webhooks)`);
    }

    // Proactive token refresh — daily at 02:30 + a boot one-shot (catches up a
    // container that was stopped past a refresh window). Refreshes every token
    // generation (legacy app_settings + per-account OAuth rows) before the
    // 60-day expiry so connected accounts never silently "log out".
    cron.schedule('30 2 * * *', () => {
      tokenService.refreshAll().catch(err =>
        console.error('[tokenService] daily refresh error:', err.message));
    });
    setTimeout(() => bootOnce('token-refresh', 360, () => tokenService.refreshAll().catch(err =>
        console.error('[tokenService] boot refresh error:', err.message))), 180000);
    console.log('Token auto-refresh scheduled daily at 02:30 (+ boot one-shot)');

    // Notification checks — token-health + insight anomalies → in-app alerts.
    // Event notifications (DMs, comments, publish results) emit inline; these are
    // the standing-condition ones, deduped per day. Every 30 min + boot one-shot.
    cron.schedule('*/30 * * * *', () => {
      notificationService.runChecks().catch(err =>
        console.error('[notify] runChecks error:', err.message));
    });
    setTimeout(() => {
      notificationService.runChecks().catch(err =>
        console.error('[notify] boot runChecks error:', err.message));
    }, 210000);
    console.log('Notification checks scheduled every 30 minutes (+ boot one-shot)');

  } catch (err) {
    // Never take ForgeGrowth down with it: Social simply stays unavailable.
    console.error('[social] startup failed:', err);
  }
}

module.exports = { app, start };
