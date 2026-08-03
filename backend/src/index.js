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
const { publicRouter: razorpayPublicRouter, router: razorpayRouter, ensureRazorpayTables } = require('./routes/razorpay');
const { router: coursesRouter, ensureCourseTables } = require('./routes/courses');
const { router: paymentRequestsRouter, ensurePaymentRequestTables } = require('./routes/paymentRequests');
const { ensurePaymentLedgerTables, syncRazorpayPayments } = require('./services/razorpayLedger');
const { router: categoriesRouter } = require('./routes/categories');
const { router: teamMembersRouter } = require('./routes/teamMembers');
const { router: contactFieldsRouter } = require('./routes/contactFields');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: templatesRouter, syncAllAccountTemplates } = require('./routes/templates');
const { reconcileMessageStatuses } = require('./services/statusReconciler');
const { router: broadcastsRouter, runDueBroadcasts } = require('./routes/broadcasts');
const { router: chatbotsRouter, publicRouter: chatbotsPublicRouter } = require('./routes/chatbots');
const { router: mediaRouter } = require('./routes/media');
const { router: mediaLibraryRouter } = require('./routes/mediaLibrary');
const minioClient = require('./util/minioClient');
const { router: whatsappAccountsRouter } = require('./routes/whatsappAccounts');
const { router: aiModelsRouter } = require('./routes/aiModels');
const { router: usersRouter } = require('./routes/users');
const { router: eventsRouter } = require('./routes/events');
const { router: webhookHistoryRouter } = require('./routes/webhookHistory');
const { router: waLinksRouter, publicRouter: waLinksPublicRouter } = require('./routes/waLinks');
const { router: dashboardRouter } = require('./routes/dashboard');
const { router: pipelinesRouter } = require('./routes/pipelines');
const { router: leadsRouter } = require('./routes/leads');
const { router: funnelRouter, ensureFunnelTables } = require('./routes/funnel');
const funnelTags = require('./services/funnelTags');
const { router: salesLogRouter, ensureSalesLogTables } = require('./routes/salesLog');
const { router: marketingRouter, syncMetaAds, ensureAdSetTables } = require('./routes/marketing');
const { router: resourcesRouter } = require('./routes/resources');
const { router: bdaRouter } = require('./routes/bda');
const { router: leadFormsRouter, publicRouter: leadFormsPublicRouter, ensureLeadFormTables } = require('./routes/leadForms');
const { router: ctwaRouter, ensureCtwaTables } = require('./routes/ctwa');
const { router: cloRouter, ensureCloTables } = require('./routes/clo');
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

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

app.use(cookieParser());
// MCP transports accept inline file uploads (base64) for send_media — those
// bodies blow past the default 1mb. Mount a larger parser for the MCP paths
// BEFORE the global parser; express.json no-ops once req._body is set, so the
// 1mb limit below never re-checks these routes. Everything else stays at 1mb.
app.use(['/api/mcp/http', '/api/mcp/v1', '/api/mcp'], express.json({ limit: process.env.MCP_BODY_LIMIT || '30mb' }));
// OAuth's token/registration endpoints are form-encoded per RFC 6749. Mounted
// BEFORE the JSON parser so a form POST is not silently received as an empty
// body — which would look like a malformed client rather than a parser gap.
app.use('/api/mcp/oauth', express.urlencoded({ extended: false }));
// Razorpay signs the RAW request bytes, so we must verify HMAC over the exact
// body Razorpay sent — a JSON re-stringify would change whitespace/key order and
// break the signature. Capture the raw Buffer here BEFORE express.json (which
// then no-ops on this path since req._body is set).
app.use('/api/webhook/razorpay', express.raw({ type: '*/*', limit: '1mb' }));
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

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Public routes (webhook from n8n / wa link redirects — no auth)
app.use('/api', webhookRouter);
app.use('/api', razorpayPublicRouter);
app.use('/api', chatbotsPublicRouter);
app.use('/', waLinksPublicRouter);
// Google OAuth callback is public — Google posts back without our cookie
app.use('/api', integrationsPublicRouter);
// Lead Forms — public fill/submit endpoints (no auth; visitors reach these from a shared link)
app.use('/api', leadFormsPublicRouter);
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
app.use('/api', authMiddleware, teamMembersRouter);
app.use('/api', authMiddleware, contactFieldsRouter);
app.use('/api', authMiddleware, uploadsRouter);
app.use('/api', authMiddleware, templatesRouter);
app.use('/api', authMiddleware, broadcastsRouter);
app.use('/api', authMiddleware, chatbotsRouter);
app.use('/api', authMiddleware, mediaRouter);
app.use('/api', authMiddleware, mediaLibraryRouter);
app.use('/api', authMiddleware, whatsappAccountsRouter);
app.use('/api', authMiddleware, aiModelsRouter);
app.use('/api', authMiddleware, usersRouter);
app.use('/api', authMiddleware, eventsRouter);
app.use('/api', authMiddleware, webhookHistoryRouter);
app.use('/api', authMiddleware, razorpayRouter);
app.use('/api', authMiddleware, paymentRequestsRouter);
app.use('/api', authMiddleware, coursesRouter);
app.use('/api', authMiddleware, waLinksRouter);
app.use('/api', authMiddleware, dashboardRouter);
app.use('/api', authMiddleware, pipelinesRouter);
// AI Academy Dashboard (leads funnel + marketing + BDA)
app.use('/api', authMiddleware, leadsRouter);
app.use('/api', authMiddleware, funnelRouter);
app.use('/api', authMiddleware, salesLogRouter);
app.use('/api', authMiddleware, marketingRouter);
app.use('/api', authMiddleware, ctwaRouter);
app.use('/api', authMiddleware, cloRouter);
app.use('/api', authMiddleware, resourcesRouter);
app.use('/api', authMiddleware, bdaRouter);
app.use('/api', authMiddleware, leadFormsRouter);
app.use('/api', authMiddleware, integrationsRouter);
app.use('/api', authMiddleware, agentsRouter);
app.use('/api', authMiddleware, agentConversationRouter);
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
  await ensureMcpTables().catch(err =>
    console.error('[mcp] table ensure failed (apply migration 053):', err.message)
  );
  await ensureMcpOAuthTables().catch(err =>
    console.error('[mcp-oauth] table ensure failed (apply migration 088):', err.message)
  );
  await ensureRazorpayTables().catch(err =>
    console.error('[razorpay] table ensure failed (apply migration 061):', err.message)
  );
  // Course tables ALTER razorpay_events, so must run AFTER ensureRazorpayTables.
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
  // Payment requests reference BOTH leads(id) and courses(id), and ALTER
  // razorpay_events — so this must run after ensureRazorpayTables +
  // ensureCourseTables, and after the funnel cache (a new lead needs its first
  // stage key).
  await ensurePaymentRequestTables().catch(err =>
    console.error('[payment-requests] table ensure failed (apply migration 085):', err.message)
  );
  // The pulled payment ledger. ALTERs razorpay_config, so it runs after
  // ensureRazorpayTables.
  await ensurePaymentLedgerTables().catch(err =>
    console.error('[razorpay-ledger] table ensure failed (apply migration 087):', err.message)
  );
  // Sales Log references courses(id) — run AFTER ensureCourseTables.
  await ensureSalesLogTables().catch(err =>
    console.error('[salesLog] table ensure failed (apply migration 064):', err.message)
  );
  await ensureLeadFormTables().catch(err =>
    console.error('[leadForms] table ensure failed (apply migration 066):', err.message)
  );
  await ensureAdSetTables().catch(err =>
    console.error('[marketing] ad set table ensure failed (apply migration 074):', err.message)
  );
  // Chat Analyser references leads(id) + ai_models(id) — run AFTER those exist.
  await ensureCtwaTables().catch(err =>
    console.error('[ctwa] table ensure failed (apply migration 073):', err.message)
  );
  // CLO references leads(id) — run after the leads table exists.
  await ensureCloTables().catch(err =>
    console.error('[clo] table ensure failed (apply migration 077):', err.message)
  );
  minioClient.ensureBucket().catch(err =>
    console.error('[minio] bucket ensure failed (will retry on first upload):', err.message)
  );
  startMediaWorker();
  startSendWorker();
  startAgentWorker();

  // Stale-pause sweeper: mark paused automation executions that have outlived
  // their expires_at as error. Resume already inline-checks expires_at, so
  // this is purely hygiene against forever-paused rows accumulating.
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Paused execution expired (no reply within timeout)',
                completed_at=NOW()
          WHERE status='paused' AND expires_at < NOW()`
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

  // Agent close-summary sweeper: when an idle-summary agent's conversation goes
  // quiet (no new message for its idle window) and no human has taken over, ask
  // the agent to write its final summary to the sheet/CRM. Every 2 min.
  const { sweepClosedConversations } = require('./services/agentCloseSummary');
  setInterval(() => {
    sweepClosedConversations()
      .then(n => { if (n > 0) console.log(`[closeSummary] summarised ${n} closed conversation(s)`); })
      .catch(err => console.error('[closeSummary] sweep error:', err.message));
  }, 2 * 60 * 1000).unref();

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

  // Meta Ads sync: refresh real campaign spend/results from the Marketing API on
  // a schedule (only does anything while a token is connected). Override with
  // META_ADS_SYNC_INTERVAL_MS; default 6h.
  const META_ADS_SYNC_MS = parseInt(process.env.META_ADS_SYNC_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;
  const runMetaAdsSync = async () => {
    try {
      const { rows } = await pool.query(`SELECT status FROM coexistence.meta_ads_config WHERE id = 1`);
      if (rows[0]?.status !== 'connected') return; // idle unless connected
      const r = await syncMetaAds();
      console.log(`[meta-ads-sync] synced ${r.campaigns} campaign(s) + ${r.adsets} ad set(s) + ${r.ads} ad(s) across ${r.accounts} account(s)`);
    } catch (err) {
      console.error('[meta-ads-sync] error:', err.message);
    }
  };
  setTimeout(runMetaAdsSync, 90 * 1000).unref();         // initial sync ~1.5 min after startup
  setInterval(runMetaAdsSync, META_ADS_SYNC_MS).unref(); // every 6h (gated by connection status)

  // Razorpay payment ledger: pulls what the gateway actually holds, so the
  // dashboard does not depend on a webhook having been delivered. Runs hourly
  // rather than 6-hourly like the ads sync — a missed payment is worse than a
  // stale spend figure, and each tick only re-reads a 48h window. Idles with
  // zero API calls until API keys are stored.
  const RZP_LEDGER_MS = parseInt(process.env.RAZORPAY_LEDGER_SYNC_INTERVAL_MS || '', 10) || 60 * 60 * 1000;
  const runRazorpayLedgerSync = async () => {
    try {
      const r = await syncRazorpayPayments({ full: false });
      if (r.skipped) return;                 // no keys yet — silent, not an error
      console.log(`[razorpay-ledger] read ${r.fetched} payment(s); ledger now holds ${r.total}`);
    } catch (err) {
      console.error('[razorpay-ledger] error:', err.message);
    }
  };
  setTimeout(runRazorpayLedgerSync, 2 * 60 * 1000).unref();
  setInterval(runRazorpayLedgerSync, RZP_LEDGER_MS).unref();

  // Funnel-stage tags: a cursor over the append-only lead_events log. The bus
  // kick inside funnelTags.js does the real-time work; this is the safety net
  // for a stage change that never emitted. Override with
  // FUNNEL_TAG_SWEEP_INTERVAL_MS.
  const TAG_SWEEP_MS = parseInt(process.env.FUNNEL_TAG_SWEEP_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
  const sweepFunnelTags = () => funnelTags.sweepStageEvents()
    .catch(err => console.error('[funnel-tags] sweep failed:', err.message));
  setTimeout(sweepFunnelTags, 45 * 1000).unref();
  setInterval(sweepFunnelTags, TAG_SWEEP_MS).unref();

  // Conversion Leads Optimisation: sweep new stage changes into clo_events, then
  // ship the pending ones to Meta's CRM dataset. Meta asks for at least one
  // upload per day; 15 minutes gives a wide margin and keeps the optimiser fed
  // with fresh signal. Idle unless clo_settings.enabled. CLO_FLUSH_INTERVAL_MS.
  const CLO_FLUSH_MS = parseInt(process.env.CLO_FLUSH_INTERVAL_MS || '', 10) || 15 * 60 * 1000;
  const runCloCycle = async () => {
    try {
      const d = require('./services/cloDispatcher');
      const swept = await d.sweepStageChanges();
      if (swept.reason === 'disabled') return;
      const flushed = await d.flush();
      if (flushed.sent || flushed.failed) {
        console.log(`[clo] flushed ${flushed.sent} sent, ${flushed.failed} failed`);
      }
    } catch (err) {
      console.error('[clo] cycle error:', err.message);
    }
  };
  setTimeout(runCloCycle, 2 * 60 * 1000).unref();
  setInterval(runCloCycle, CLO_FLUSH_MS).unref();

  const server = app.listen(PORT, () => {
    console.log(`[ForgeChat] Backend running on port ${PORT}`);
  });

  // Graceful shutdown so BullMQ marks in-flight jobs as stalled (not lost)
  const shutdown = async (sig) => {
    console.log(`[ForgeChat] ${sig} received, draining…`);
    server.close(() => {});
    await shutdownMediaQueue();
    await shutdownSendQueue();
    await shutdownAgentQueue();
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
