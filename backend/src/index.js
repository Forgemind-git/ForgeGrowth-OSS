require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const { router: authRouter, authMiddleware, ensureTables } = require('./auth');
const { router: messagesRouter } = require('./routes/messages');
const { router: webhookRouter } = require('./routes/webhook');
const { router: coursesRouter, ensureCourseTables } = require('./routes/courses');
const { router: categoriesRouter } = require('./routes/categories');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: templatesRouter, syncAllAccountTemplates } = require('./routes/templates');
const { reconcileMessageStatuses } = require('./services/statusReconciler');
const { router: broadcastsRouter, runDueBroadcasts } = require('./routes/broadcasts');
const { router: broadcastSeriesRouter } = require('./routes/broadcastSeries');
const broadcastSeries = require('./services/broadcastSeries');
const { router: chatbotsRouter } = require('./routes/chatbots');
const { resumeExpiredWaits } = require('./engine/automationEngine');
const { router: mediaRouter } = require('./routes/media');
const { router: mediaLibraryRouter } = require('./routes/mediaLibrary');
const minioClient = require('./util/minioClient');
const { router: whatsappAccountsRouter, ensureWhatsappAccountColumns } = require('./routes/whatsappAccounts');
const { router: aiModelsRouter } = require('./routes/aiModels');
const { router: usersRouter } = require('./routes/users');
const roleConfig = require('./services/roleConfig');
const { router: eventsRouter } = require('./routes/events');
const { router: webhookHistoryRouter } = require('./routes/webhookHistory');
const { router: dashboardRouter } = require('./routes/dashboard');
const { router: pipelinesRouter } = require('./routes/pipelines');
const { router: leadsRouter, ensureSalesLogTables } = require('./routes/leads');
const { router: funnelRouter, ensureFunnelTables } = require('./routes/funnel');
const funnelTags = require('./services/funnelTags');
const productTags = require('./services/productTags');
const { router: entityFieldsRouter, ensureEntityFieldTables } = require('./routes/entityFields');
const { router: resourcesRouter } = require('./routes/resources');
const { router: voiceNotesRouter } = require('./routes/voiceNotes');
const { router: leadFollowUpsRouter } = require('./routes/leadFollowUps');
const { ensureFollowUpTables } = require('./services/followUps');
const { ensureMessageArtifactTables } = require('./services/mediaExtract');
// Per-template message costs — what we owe Meta for every message sent.
const { router: messageCostsRouter, ensureCostTables } = require('./routes/messageCosts');
const { router: integrationsRouter, publicRouter: integrationsPublicRouter } = require('./routes/integrations');
const { router: agentsRouter } = require('./routes/agents');
const { router: agentConversationRouter } = require('./routes/agentConversation');
const { adminRouter: mcpAdminRouter, apiRouter: mcpApiRouter, ensureMcpTables } = require('./routes/mcp');
const {
  publicRouter: mcpOAuthPublicRouter,
  adminRouter: mcpOAuthAdminRouter,
  ensureMcpOAuthTables,
} = require('./routes/mcpOAuth');
const { mcpHttpHandler } = require('./mcpHttp');
const { startWorker: startMediaWorker, shutdown: shutdownMediaQueue } = require('./queue/mediaQueue');
const { startSendWorker, shutdownSendQueue } = require('./queue/sendQueue');
const { startAgentWorker, shutdownAgentQueue } = require('./queue/agentQueue');
const { router: workflowAgentsRouter } = require('./routes/workflowAgents');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// CORS_ORIGIN may be a comma-separated list (multiple public domains → same app)
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [
  ...CORS_ORIGINS,
  'http://localhost:5173',
];

// wss host(s) for the CSP connect-src — one per configured origin
const CORS_WSS = CORS_ORIGINS.map((o) => `wss://${o.replace(/^https?:\/\//, '')}`);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", ...CORS_WSS],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
}));

// The app's own surface: cookie-authenticated, so the origin allow-list is
// strict and a stranger is refused outright.
const strictCors = cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
});

// ⚠ The MCP surface is reached from ANOTHER ORIGIN by design — Claude's
// connector runs on claude.ai, and RFC 8414/9728 discovery plus the OAuth
// authorize/token legs are all cross-origin. Running them through the strict
// list above threw "Not allowed by CORS", which the global handler turns into a
// 500 — that WAS the "Internal server error" on /api/mcp/oauth/authorize.
// Registration still succeeded (a server-to-server POST sends no Origin and hit
// the `!origin` arm), so the connector looked half-alive: clients kept being
// created while no token was ever issued.
//
// ⚠ `credentials` MUST stay false here, and that is the whole reason this is
// safe. These endpoints authenticate with a Bearer token, never the session
// cookie, so no Access-Control-Allow-Credentials is sent and a browser can
// neither attach forgegrowth_token nor read a logged-in user's response.
// Reflecting an arbitrary origin WITH credentials on a cookie-authenticated
// route is the real vulnerability — never merge these two into one policy.
//
// The admin routes that share the /api/mcp prefix (settings, keys,
// oauth/clients) are deliberately NOT listed: they are cookie-authenticated and
// belong to the strict policy.
const MCP_PUBLIC_PATHS = [
  /^\/\.well-known\/oauth-(authorization-server|protected-resource)(\/|$)/,
  /^\/api\/mcp\/oauth\/(authorize|token|register)(\/|$)/,
  /^\/api\/mcp$/,               // Streamable HTTP transport (OAuth bearer)
  /^\/api\/mcp\/http\/[^/]+$/,  // legacy key-in-URL transport
  /^\/api\/mcp\/v1(\/|$)/,      // REST surface the stdio server calls
  /^\/api\/social\/mcp\/http\/[^/]+$/,  // Social section's key-in-URL MCP transport
];
const isMcpPublicPath = (p) => MCP_PUBLIC_PATHS.some((re) => re.test(p));

const mcpCors = cors({
  origin: true,        // reflect whoever asked
  credentials: false,  // ← load-bearing; see above
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  // allowedHeaders is omitted on purpose so the preflight reflects whatever the
  // client asked for — a fixed list silently breaks the day a client adds a
  // header (MCP-Protocol-Version arrived exactly that way).
  // The 401 that STARTS the OAuth dance carries the resource-metadata pointer;
  // a browser client cannot read it unless it is explicitly exposed.
  exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  maxAge: 86400,
});

app.use((req, res, next) => (isMcpPublicPath(req.path) ? mcpCors : strictCors)(req, res, next));

app.use(cookieParser());
// Social section (ported ForgeSocial) — mounted BEFORE the JSON parsers below
// because it parses its own bodies (the Instagram webhook verifies the raw bytes)
// and before the API rate limiter (it has its own per-platform budget).
const social = require('./social');
app.use('/api/social', (req, res, next) => { req.url = req.originalUrl; social.app(req, res, next); });
// Instagram automation link buttons were once built as /api/ig-automations/r/<token>
// (missing /social), which fell through to the login check and showed the person
// tapping it {"error":"Unauthorized"}. DMs already sent still carry that address.
app.get('/api/ig-automations/r/:token', (req, res) => {
  res.redirect(302, `/api/social/ig-automations/r/${encodeURIComponent(req.params.token)}`);
});
// MCP transports accept inline file uploads (base64) for send_media — those
// bodies blow past the default 1mb. Mount a larger parser for the MCP paths
// BEFORE the global parser; express.json no-ops once req._body is set, so the
// 1mb limit below never re-checks these routes. Everything else stays at 1mb.
app.use(['/api/mcp/http', '/api/mcp/v1', '/api/mcp'], express.json({ limit: process.env.MCP_BODY_LIMIT || '30mb' }));
// OAuth's token/registration endpoints are form-encoded per RFC 6749. Mounted
// BEFORE the JSON parser so a form POST is not silently received as an empty
// body — which would look like a malformed client rather than a parser gap.
app.use('/api/mcp/oauth', express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOAD_DIR));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  keyGenerator: (req) => {
    try {
      const token = req.cookies?.forgecrm_token;
      if (token) {
        const decoded = require('jsonwebtoken').decode(token);
        if (decoded?.username) return `user:${decoded.username}`;
      }
    } catch {}
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});
app.use(apiLimiter);

// Diagnostic request log for the MCP + OAuth surface. OFF unless
// MCP_REQUEST_LOG=1, because /api bypasses nginx (Traefik routes PathPrefix
// /api straight to the backend) and Traefik has no access log — so without
// this there is NO record of whether a client's request even arrived.
// Never logs the token itself, only whether one was present.
if (process.env.MCP_REQUEST_LOG === '1') {
  app.use((req, res, next) => {
    if (!/^\/(api\/mcp|\.well-known\/oauth)/.test(req.path)) return next();
    const started = Date.now();
    const auth = req.headers.authorization || '';
    const kind = auth.startsWith('Bearer ') ? `bearer(${auth.length - 7}ch)` : auth ? 'other-auth' : 'none';
    res.on('finish', () => {
      console.log(`[mcp-req] ${req.method} ${req.originalUrl} auth=${kind} ` +
        `ua="${(req.headers['user-agent'] || '').slice(0, 40)}" ip=${req.headers['cf-connecting-ip'] || req.ip} ` +
        `-> ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
}

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Public routes (webhook from n8n — no auth)
app.use('/api', webhookRouter);
// Google OAuth callback is public — Google posts back without our cookie
app.use('/api', integrationsPublicRouter);

// MCP API — authenticates via its OWN bearer middleware (not the JWT cookie)
app.use('/api/mcp/v1', mcpApiRouter);
// MCP OAuth 2.1 — discovery, authorize, token, register. Public by necessity:
// the client has no session, and discovery must answer before any auth exists.
// Mounted at the ROOT because RFC 8414/9728 anchor /.well-known at the origin.
app.use('/', mcpOAuthPublicRouter);
// Remote (Streamable HTTP) MCP connector.
//   /api/mcp            → OAuth bearer token (what Claude's connector uses)
//   /api/mcp/http/<key> → legacy key-in-URL, kept so existing installs survive
// The keyless route is declared FIRST but both land in the same handler, which
// picks the auth path from the Authorization header.
app.all('/api/mcp', mcpHttpHandler);
app.all('/api/mcp/http/:key', mcpHttpHandler);

// Auth routes (public)
app.use('/api', authRouter);

// Protected routes
app.use('/api', authMiddleware, messagesRouter);
app.use('/api', authMiddleware, categoriesRouter);
app.use('/api', authMiddleware, uploadsRouter);
app.use('/api', authMiddleware, templatesRouter);
app.use('/api', authMiddleware, broadcastsRouter);
app.use('/api', authMiddleware, broadcastSeriesRouter);
app.use('/api', authMiddleware, chatbotsRouter);
app.use('/api', authMiddleware, mediaRouter);
app.use('/api', authMiddleware, mediaLibraryRouter);
app.use('/api', authMiddleware, whatsappAccountsRouter);
app.use('/api', authMiddleware, aiModelsRouter);
app.use('/api', authMiddleware, usersRouter);
app.use('/api', authMiddleware, eventsRouter);
app.use('/api', authMiddleware, webhookHistoryRouter);
app.use('/api', authMiddleware, coursesRouter);
app.use('/api', authMiddleware, dashboardRouter);
app.use('/api', authMiddleware, pipelinesRouter);
// AI Academy Dashboard (leads funnel + marketing + BDA)
app.use('/api', authMiddleware, leadsRouter);
app.use('/api', authMiddleware, voiceNotesRouter);
app.use('/api', authMiddleware, leadFollowUpsRouter);
app.use('/api', authMiddleware, funnelRouter);
app.use('/api', authMiddleware, entityFieldsRouter);
app.use('/api', authMiddleware, messageCostsRouter);
app.use('/api', authMiddleware, resourcesRouter);
app.use('/api', authMiddleware, integrationsRouter);
app.use('/api', authMiddleware, agentsRouter);
app.use('/api', authMiddleware, agentConversationRouter);
app.use('/api', authMiddleware, workflowAgentsRouter);
app.use('/api', authMiddleware, mcpAdminRouter);
app.use('/api', authMiddleware, mcpOAuthAdminRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  await ensureTables();
  await ensureWhatsappAccountColumns().catch(err =>
    console.error('[whatsapp-accounts] label ensure failed (apply migration 133):', err.message)
  );
  await ensureMcpTables().catch(err =>
    console.error('[mcp] table ensure failed (apply migration 053):', err.message)
  );
  await ensureMcpOAuthTables().catch(err =>
    console.error('[mcp-oauth] table ensure failed (apply migration 088):', err.message)
  );
  await ensureCourseTables().catch(err =>
    console.error('[courses] table ensure failed (apply migration 062):', err.message)
  );
  // Funnel config (stages/sources) — seeds current stage keys + loads the shared
  // funnelConfig cache leads.js reads. Must run before any /leads or /funnel request.
  await ensureFunnelTables().catch(err =>
    console.error('[funnel] table ensure failed (apply migration 064):', err.message)
  );
  // Funnel-stage tags mirror leads.stage onto contacts.tags so Chats can filter
  // by stage. Must run AFTER ensureFunnelTables — the catalog reads funnel_stages.
  await funnelTags.ensureFunnelTagTables().catch(err =>
    console.error('[funnel-tags] table ensure failed (apply migration 082):', err.message)
  );
  await funnelTags.syncFunnelTagCatalog().catch(err =>
    console.error('[funnel-tags] catalog sync failed:', err.message)
  );
  // automation_executions.awaiting_kind — what a paused automation run waits for.
  await require('./services/threadSender').ensureThreadSenderColumns().catch(err =>
    console.error('[thread-sender] column ensure failed (apply migration 091):', err.message)
  );
  // Repeating broadcasts. References message_templates + media_library +
  // broadcasts, all of which ensureTables owns, so it runs after it.
  await broadcastSeries.ensureSeriesTables().catch(err =>
    console.error('[series] table ensure failed (apply migration 105):', err.message)
  );
  // Roles must exist before anything resolves a user's pages. Also drops the
  // old CHECK on forgecrm_users.role, so adding a role never needs DDL again.
  await roleConfig.ensureRoleTables().catch(err =>
    console.error('[roles] table ensure failed (apply migration 107):', err.message));
  // Product tags mirror courses(name) onto contacts.tags, so this runs AFTER
  // ensureCourseTables. Same shape as the funnel-stage mirror.
  await productTags.ensureProductTagTables().catch(err =>
    console.error('[product-tags] ensure failed (apply migration 107):', err.message));
  // The manual sales store references courses(id) — run AFTER ensureCourseTables.
  await ensureSalesLogTables().catch(err =>
    console.error('[sales] table ensure failed (apply migration 064):', err.message)
  );
  // Entity-field registry (Leads / Transaction fields). ALTERs
  // sales_log (custom_fields) so it runs AFTER ensureSalesLogTables, and it
  // loads the fieldRegistry cache the leads routes + variable resolver read.
  await ensureEntityFieldTables().catch(err =>
    console.error('[entity-fields] table ensure failed (apply migration 097):', err.message)
  );
  // The per-message media text cache (voice-note transcripts, Media Library
  // matches). Workflow Agents ALTER it below, so it runs before them.
  await ensureMessageArtifactTables().catch(err =>
    console.error('[media-cache] table ensure failed (apply migration 110):', err.message)
  );
  // My list + follow-up calendar (migration 128).
  await ensureFollowUpTables().catch(err =>
    console.error('[follow-ups] table ensure failed (apply migration 128):', err.message)
  );
  // Landing-page visitor links (migration 122). References leads(id). The
  // table stays empty unless LANDING_SOURCES connects a landing page.
  await require('./services/landingLeads').ensureLandingTables().catch(err =>
    console.error('[landing] table ensure failed (apply migration 122):', err.message)
  );
  await require('./services/agentService').ensureAgentTables().catch(err =>
    console.error('[agents] limit column ensure failed (apply migration 102):', err.message)
  );
  // Workflow Agents (migration 121). References forgecrm_users, whatsapp_accounts,
  // leads, ai_models and chat_message_artifacts, so it runs after all of their
  // ensures. A failure disables the module, never the rest of the app.
  let workflowAgentsReady = false;
  try {
    await require('./services/workflowAgents/schema').ensureWorkflowAgentTables();
    await require('./services/workflowAgents/presets').syncPresets();
    workflowAgentsReady = true;
  } catch (err) {
    console.error('[workflow-agents] table ensure failed (apply migration 121):', err.message);
  }
  minioClient.ensureBucket().catch(err =>
    console.error('[minio] bucket ensure failed (will retry on first upload):', err.message)
  );
  startMediaWorker();
  startSendWorker();
  startAgentWorker();
  if (workflowAgentsReady && process.env.WORKFLOW_AGENTS_DISABLED !== '1') {
    require('./services/workflowAgents/queue').startWorkflowAgentWorker();
    require('./services/workflowAgents/triggers').startWorkflowAgentScheduler();
  }

  // Message costs. ensureCostTables ALTERs chat_history, which every other
  // ensure has finished with by now.
  await ensureCostTables().catch(err =>
    console.error('[message-costs] table ensure failed (apply migration 098):', err.message)
  );

  // Stale-pause sweeper: mark paused automation executions that have outlived
  // their expires_at as error. Resume already inline-checks expires_at, so
  // this is purely hygiene against forever-paused rows accumulating.
  setInterval(async () => {
    try {
      // FIRST: give every expired wait its `timeout` branch. A customer going
      // quiet is the commonest outcome in messaging, not a fault — treating it
      // as one both filled this log with errors (hiding real faults) and made
      // "chase them if they go quiet" impossible to express. Anything wired is
      // resumed; anything not is closed as success with a step saying so, so
      // the blanket UPDATE below now only ever catches genuinely stuck rows.
      try {
        const { resumed, closed } = await resumeExpiredWaits(pool);
        if (resumed || closed) {
          console.log(`[sweeper] timeouts: resumed ${resumed} down a no-reply branch, closed ${closed} with none wired`);
        }
      } catch (twErr) {
        console.error('[sweeper] timeout-branch resume failed:', twErr.message);
      }

      // Every remaining pause is a reply wait (the Payment node, the only other
      // kind of pause, was removed) — so an expired one is genuinely stale.
      const { rowCount } = await pool.query(
        `UPDATE coexistence.automation_executions e
            SET status='error',
                error_message='Paused execution expired (no reply within timeout)',
                completed_at=NOW()
          WHERE e.status='paused' AND e.expires_at < NOW()`
      );
      if (rowCount > 0) console.log(`[sweeper] expired ${rowCount} paused execution(s)`);

      // Reap orphaned 'running' executions: the engine runs synchronously and
      // finishes in ms, so anything 'running' for >15m means the process died
      // mid-walk (e.g. a restart) and the status was never updated to error.
      const { rowCount: orphans } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Execution interrupted (no completion within 15 minutes)',
                completed_at=NOW()
          WHERE status='running' AND started_at < NOW() - INTERVAL '15 minutes'`
      );
      if (orphans > 0) console.log(`[sweeper] reaped ${orphans} orphaned running execution(s)`);
    } catch (err) {
      console.error('[sweeper] error:', err.message);
    }
  }, 30 * 60 * 1000).unref();


  // (The agent close-summary sweeper used to run here. The capability was
  // removed from the agent, so the timer went with it rather than being left
  // ticking every 2 minutes over a flag nothing can set any more.)

  // Self-healing delivery/read ticks: re-derive outbound status from stored
  // receipts and upgrade any row the live path missed (e.g. a receipt that
  // raced markSent before the wamid was attached). Monotonic; emits SSE for
  // anything it advances. Runs once at boot (wider window to catch a downtime
  // gap) then every 5 minutes on a 2-day window. Override with
  // STATUS_RECONCILE_INTERVAL_MS.
  const STATUS_RECONCILE_MS = parseInt(process.env.STATUS_RECONCILE_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  reconcileMessageStatuses({ windowDays: 7 })
    .then(n => { if (n > 0) console.log(`[status-reconcile] boot: fixed ${n} tick(s)`); })
    .catch(err => console.error('[status-reconcile] boot error:', err.message));
  setInterval(async () => {
    try {
      const n = await reconcileMessageStatuses({ windowDays: 2 });
      if (n > 0) console.log(`[status-reconcile] fixed ${n} tick(s)`);
    } catch (err) {
      console.error('[status-reconcile] error:', err.message);
    }
  }, STATUS_RECONCILE_MS).unref();

  // Template status auto-sync: Meta does NOT push template approval/rejection
  // status — we must poll. The tick fires every 10 min but only calls Meta while
  // at least one template is still awaiting review (status='SUBMITTED'). Once all
  // are resolved (approved/rejected/etc.) it idles with zero Meta calls, and
  // auto-resumes when a new template is submitted. Override interval with
  // TEMPLATE_SYNC_INTERVAL_MS.
  const TEMPLATE_SYNC_MS = parseInt(process.env.TEMPLATE_SYNC_INTERVAL_MS || '', 10) || 10 * 60 * 1000;
  const runTemplateSync = async () => {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS pending FROM coexistence.message_templates WHERE status = 'SUBMITTED'`
      );
      const pending = rows[0]?.pending || 0;
      if (pending === 0) return; // all resolved → skip Meta entirely (idle)
      const r = await syncAllAccountTemplates();
      if (r.totalUpdated > 0) {
        console.log(`[template-sync] ${pending} pending → updated ${r.totalUpdated} template(s)`);
      }
    } catch (err) {
      console.error('[template-sync] error:', err.message);
    }
  };
  setTimeout(runTemplateSync, 60 * 1000).unref();        // initial catch-up ~1 min after startup
  setInterval(runTemplateSync, TEMPLATE_SYNC_MS).unref(); // every 10 min (gated by pending count)

  // Scheduled broadcasts: fire any broadcast whose scheduled_at has arrived.
  // One minute is the resolution of the feature — a send lands within 60s of
  // its scheduled time, which is the right granularity for "1 hour before the
  // class". The claim inside runDueBroadcasts is atomic, so overlapping ticks
  // (or a second instance) can never double-send. Costs one indexed query per
  // minute when nothing is due.
  const BROADCAST_TICK_MS = parseInt(process.env.BROADCAST_SCHEDULER_INTERVAL_MS || '60000', 10);
  const runBroadcastScheduler = async () => {
    try {
      await runDueBroadcasts();
    } catch (err) {
      console.error('[broadcast-scheduler] error:', err.message);
    }
  };
  setTimeout(runBroadcastScheduler, 20 * 1000).unref();          // catch anything due while we were down
  setInterval(runBroadcastScheduler, BROADCAST_TICK_MS).unref(); // every minute

  // Repeating broadcasts, on the SAME cadence and with the same atomic-claim
  // guarantee. Separate from the one-off tick because a series does more per
  // fire (resolve the audience, create a broadcast, ledger who was reached) and
  // a slow series must not delay a one-off that is due to the minute.
  const runSeriesScheduler = async () => {
    try {
      await broadcastSeries.runDueSeries();
    } catch (err) {
      console.error('[series-scheduler] error:', err.message);
    }
  };
  setTimeout(runSeriesScheduler, 35 * 1000).unref();
  setInterval(runSeriesScheduler, BROADCAST_TICK_MS).unref();



  // Message costs: pulls Meta's own pricing_analytics, which is the ONLY source
  // of the actual money cost — the status webhook says what was billed but never
  // how much. 6-hourly is enough because Meta reports this daily; the derived
  // unit rates only sharpen as the day's data lands.
  const PRICING_SYNC_MS = parseInt(process.env.PRICING_SYNC_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;
  const runPricingSync = async () => {
    try {
      const r = await require('./services/messageCosts').syncAllPricing({ days: 30 });
      if (r.skipped) return;                 // no WhatsApp account token — silent
      const ok = (r.results || []).filter(x => x.status === 'ok').length;
      console.log(`[message-costs] pricing synced for ${ok}/${(r.results || []).length} WABA(s)`);
    } catch (err) {
      console.error('[message-costs] pricing sync error:', err.message);
    }
  };
  setTimeout(runPricingSync, 4 * 60 * 1000).unref();
  setInterval(runPricingSync, PRICING_SYNC_MS).unref();

  // Funnel-stage tags: a cursor over lead_events. The
  // bus kick inside funnelTags.js does the real-time work; this is the safety
  // net for a stage change that never emitted. Override with
  // FUNNEL_TAG_SWEEP_INTERVAL_MS.
  const TAG_SWEEP_MS = parseInt(process.env.FUNNEL_TAG_SWEEP_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  const sweepFunnelTags = () => funnelTags.sweepStageEvents()
    .catch(err => console.error('[funnel-tags] sweep failed:', err.message));
  setTimeout(sweepFunnelTags, 45 * 1000).unref();
  setInterval(sweepFunnelTags, TAG_SWEEP_MS).unref();

  const server = app.listen(PORT, () => {
    console.log(`[ForgeChat] Backend running on port ${PORT}`);
  });
  social.start();

  // Graceful shutdown so BullMQ marks in-flight jobs as stalled (not lost)
  const shutdown = async (sig) => {
    console.log(`[ForgeChat] ${sig} received, draining…`);
    server.close(() => {});
    await shutdownMediaQueue();
    await shutdownSendQueue();
    await shutdownAgentQueue();
    await require('./services/workflowAgents/queue').shutdownWorkflowAgentQueue();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => {
  // Print the WHOLE error, not just .message. Several things thrown during
  // startup (pg connection errors, AggregateError from a DNS lookup with both
  // families failing) carry an empty .message, which produced a bare
  // "[Fatal] Failed to start:" — nothing for a self-hoster to act on.
  console.error('[Fatal] Failed to start.');
  console.error(err?.stack || err);
  if (err?.code) console.error('  code:', err.code);
  if (Array.isArray(err?.errors)) err.errors.forEach((e, i) => console.error(`  [${i}]`, e?.stack || e));
  // The three mistakes that account for almost every first-run failure.
  console.error(
    '\nCommon causes:\n' +
    '  · Migrations not applied yet     → ./scripts/migrate.sh\n' +
    '  · A required secret is empty     → ./scripts/generate-secrets.sh >> .env\n' +
    '  · Database not reachable         → docker compose ps  (postgres healthy?)\n'
  );
  process.exit(1);
});
