// External MCP access — admin management + REST API for the stdio MCP server.
//
//   adminRouter  (mounted under authMiddleware, every route adminOnly)
//       /mcp/settings  GET|PUT   — master switch + capability toggles
//       /mcp/keys      GET|POST|PUT|DELETE — bearer API keys (plaintext shown once)
//       /mcp/install   GET       — connection details for the UI install panel
//
//   apiRouter   (mounted on /api/mcp/v1, OWN bearer middleware — header auth)
//       discovery + agent CRUD consumed by the local (stdio) MCP server.
//
// The REMOTE (Streamable HTTP) transport lives in ../mcpHttp.js and shares the
// same key-validation + discovery via services/mcpService.js.

const { Router } = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { makeZip } = require('../util/zip');
const { adminOnly } = require('../middleware/access');
const { hashApiKey } = require('../util/crypto');
const agentService = require('../services/agentService');
const mcpService = require('../services/mcpService');

const { CAPABILITY_KEYS, ensureMcpTables, loadSettings, catalog } = mcpService;

/* ============================ admin router ============================ */

const adminRouter = Router();

adminRouter.get('/mcp/settings', adminOnly, async (req, res) => {
  try {
    const s = await loadSettings();
    // Ship the catalog WITH the state. The Settings screen renders its category
    // cards, tool counts and per-tool lists straight from this — it never keeps
    // its own copy of the category list. A hand-maintained frontend mirror is
    // exactly how a tab once rendered a button that silently did nothing.
    res.json({ ...s, catalog: catalog.catalogForUi(s.categories) });
  } catch (err) {
    console.error('[mcp] settings get error:', err.message);
    res.status(500).json({ error: 'Failed to load MCP settings' });
  }
});

adminRouter.put('/mcp/settings', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const cur = await loadSettings();
    const masterEnabled = b.masterEnabled !== undefined ? !!b.masterEnabled : cur.masterEnabled;
    // Both blobs merge key-by-key against a WHITELIST rather than replacing the
    // stored object, so a client that sends one toggle cannot blank every other
    // switch, and an unknown key sent by a stale or hostile client is dropped
    // instead of being persisted as a phantom capability.
    const caps = { ...cur.capabilities };
    if (b.capabilities && typeof b.capabilities === 'object' && !Array.isArray(b.capabilities)) {
      for (const k of CAPABILITY_KEYS) {
        if (b.capabilities[k] !== undefined) caps[k] = !!b.capabilities[k];
      }
    }
    const cats = { ...cur.categories };
    if (b.categories && typeof b.categories === 'object' && !Array.isArray(b.categories)) {
      for (const k of catalog.CATEGORY_KEYS) {
        if (b.categories[k] !== undefined) cats[k] = b.categories[k] === true;
      }
    }
    await pool.query(
      `UPDATE coexistence.mcp_settings
          SET master_enabled = $1, capabilities = $2, categories = $3, updated_at = NOW()
        WHERE id = 1`,
      [masterEnabled, JSON.stringify(caps), JSON.stringify(cats)],
    );
    const next = await loadSettings();
    res.json({ ...next, catalog: catalog.catalogForUi(next.categories) });
  } catch (err) {
    console.error('[mcp] settings put error:', err.message);
    res.status(500).json({ error: 'Failed to update MCP settings' });
  }
});

function keyShape(r) {
  return {
    id: r.id,
    label: r.label,
    keyPrefix: r.key_prefix,
    keyLast4: r.key_last4,
    isEnabled: r.is_enabled,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

adminRouter.get('/mcp/keys', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coexistence.mcp_api_keys ORDER BY created_at DESC');
    res.json(rows.map(keyShape));
  } catch (err) {
    console.error('[mcp] keys list error:', err.message);
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

adminRouter.post('/mcp/keys', adminOnly, async (req, res) => {
  try {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'A label is required' });
    const plain = 'fck_live_' + crypto.randomBytes(24).toString('base64url');
    const keyPrefix = plain.slice(0, 13);
    const keyLast4 = plain.slice(-4);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.mcp_api_keys (label, key_prefix, key_last4, key_hash, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [label, keyPrefix, keyLast4, hashApiKey(plain), req.user?.id || null],
    );
    res.status(201).json({ ...keyShape(rows[0]), key: plain });
  } catch (err) {
    console.error('[mcp] key create error:', err.message);
    res.status(500).json({ error: 'Failed to create key' });
  }
});

adminRouter.put('/mcp/keys/:id', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    if (b.label !== undefined) { sets.push(`label = $${i++}`); params.push(String(b.label).trim()); }
    if (b.isEnabled !== undefined) { sets.push(`is_enabled = $${i++}`); params.push(!!b.isEnabled); }
    if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.mcp_api_keys SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(keyShape(rows[0]));
  } catch (err) {
    console.error('[mcp] key update error:', err.message);
    res.status(500).json({ error: 'Failed to update key' });
  }
});

adminRouter.delete('/mcp/keys/:id', adminOnly, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM coexistence.mcp_api_keys WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mcp] key delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete key' });
  }
});

// Download the Claude plugin as a ready-to-use .zip.
//
// The point of doing this server-side rather than shipping a static file is the
// HOST SUBSTITUTION below: the archive is built per request with this instance's
// own domain already written into .mcp.json. Every customer runs their own Forge
// Growth, so a checked-in plugin would make "edit this file before it works" the
// first step of every install — the worst possible place for a manual step.
const PLUGIN_DIR = process.env.FORGEGROWTH_PLUGIN_DIR || '/app/plugin';
const PLUGIN_HOST_PLACEHOLDER = 'YOUR-FORGE-GROWTH-HOST';

// Walk the plugin directory into [{ name, data }] with forward-slash paths.
// Skips anything that is not a small text file — the plugin is markdown + json,
// and this endpoint has no business shipping binaries or node_modules.
function collectPluginFiles(dir, base = 'forge-growth', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) { collectPluginFiles(full, rel, out); continue; }
    if (!/\.(md|json|ya?ml|txt)$/i.test(entry.name)) continue;
    out.push({ name: rel, data: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

adminRouter.get('/mcp/plugin.zip', adminOnly, (req, res) => {
  try {
    if (!fs.existsSync(PLUGIN_DIR)) {
      return res.status(404).json({
        error: 'The plugin files are not available on this server. Mount the forge-growth-plugin directory at ' + PLUGIN_DIR + ' and try again.',
      });
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.FORGEGROWTH_DOMAIN || '';
    const files = collectPluginFiles(PLUGIN_DIR);
    if (!files.length) return res.status(404).json({ error: 'No plugin files found to package.' });

    // Write this instance's real host in, so the download needs no editing.
    for (const f of files) {
      if (f.data.includes(PLUGIN_HOST_PLACEHOLDER)) {
        f.data = f.data.split(PLUGIN_HOST_PLACEHOLDER).join(host);
      }
    }
    const zip = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="forge-growth-plugin.zip"');
    res.setHeader('Content-Length', zip.length);
    // The archive is built from this instance's own config — never let a shared
    // cache hand one customer's host to another.
    res.setHeader('Cache-Control', 'no-store');
    res.end(zip);
  } catch (err) {
    console.error('[mcp] plugin download error:', err.message);
    res.status(500).json({ error: 'Failed to package the plugin.' });
  }
});

adminRouter.get('/mcp/install', adminOnly, (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || (process.env.FORGECRM_DOMAIN || '');
  const base = `${proto}://${host}`;
  const apiUrl = `${base}/api/mcp/v1`;
  const remoteUrl = `${base}/api/mcp/http/<YOUR_KEY>`;
  const serverPath = process.env.MCP_SERVER_PATH || '/root/ForgeGrowth/mcp-server/src/index.js';
  res.json({
    // Remote (hosted) connector — paste this URL (with a real key) into Claude's
    // "Add custom connector" dialog or any MCP client. No local files needed.
    remoteUrl,
    // Local (stdio) connector — for the node server run from a config file.
    apiUrl,
    serverPath,
    configSnippet: {
      mcpServers: {
        'forgechat-agents': {
          command: 'node',
          args: [serverPath],
          env: { FORGECHAT_API_URL: apiUrl, FORGECHAT_API_KEY: 'fck_live_PASTE_YOUR_KEY' },
        },
      },
    },
  });
});

/* ============================= api router ============================ */

const apiRouter = Router();

// Bearer auth (header) + capability gating for every /api/mcp/v1 request.
async function mcpKeyAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing bearer token' });
    const { capabilities, categories, keyId } = await mcpService.validateKey(m[1]);
    req.mcp = { capabilities, categories };
    req.user = { id: keyId, role: 'admin', viaMcp: true };
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Authentication failed' });
  }
}

// Gate a REST endpoint by the CATEGORY of the tool it backs. The argument is a
// TOOL NAME, not a capability, so this file and the Streamable HTTP transport
// enforce the same switch for the same tool. That matters because the stdio MCP
// server reaches its tools through these endpoints — if the two gates were
// typed independently, one transport would quietly end up more permissive than
// the other and only the looser one would ever be noticed.
function requireTool(tool) {
  return (req, res, next) => {
    if (!catalog.isToolAllowed(tool, req.mcp?.categories || {})) {
      return res.status(403).json({ error: catalog.toolDeniedMessage(tool) });
    }
    next();
  };
}

apiRouter.use(mcpKeyAuth);

function sendErr(res, err, fallback) {
  if (err instanceof agentService.ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[mcp] ${fallback}:`, err.message);
  return res.status(500).json({ error: fallback });
}

// Surface "Google not connected" discovery errors as 400 instead of 500.
async function discovery(res, fn, fallback) {
  try {
    res.json(await fn());
  } catch (err) {
    const msg = err?.message || fallback;
    if (/connect|token|credential|integration|auth/i.test(msg)) {
      return res.status(400).json({ error: msg });
    }
    console.error(`[mcp] ${fallback}:`, msg);
    res.status(500).json({ error: fallback });
  }
}

/* --------- discovery --------- */
apiRouter.get('/wa-accounts', requireTool('list_wa_accounts'), (req, res) =>
  discovery(res, () => mcpService.listWaAccounts(), 'Failed to list WhatsApp accounts'));
apiRouter.get('/models', requireTool('list_models'), (req, res) =>
  discovery(res, () => mcpService.listModels(), 'Failed to list models'));
apiRouter.get('/spreadsheets', requireTool('search_spreadsheets'), (req, res) =>
  discovery(res, () => mcpService.searchSpreadsheets({ q: String(req.query.q || ''), pageSize: parseInt(req.query.pageSize || '50', 10) }), 'Failed to list spreadsheets'));
apiRouter.get('/spreadsheets/:id/tabs', requireTool('list_sheet_tabs'), (req, res) =>
  discovery(res, () => mcpService.listSheetTabs(req.params.id), 'Failed to load spreadsheet tabs'));
apiRouter.get('/spreadsheets/:id/values', requireTool('read_sheet_values'), (req, res) =>
  discovery(res, () => mcpService.readSheetValues({
    spreadsheetId: req.params.id,
    tab: req.query.tab,
    range: req.query.range || undefined,
    maxRows: req.query.maxRows,
  }), 'Failed to read spreadsheet values'));
apiRouter.get('/media', requireTool('list_media'), (req, res) =>
  discovery(res, () => mcpService.listMedia(
    req.query.type ? String(req.query.type) : null,
    req.query.name ? String(req.query.name) : null,
  ), 'Failed to list media'));
apiRouter.get('/templates', requireTool('list_templates'), (req, res) =>
  discovery(res, () => mcpService.listTemplates(req.query.waAccountId), 'Failed to list templates'));
apiRouter.get('/templates/:id', requireTool('get_template'), (req, res) =>
  discovery(res, () => mcpService.getTemplate(req.params.id), 'Failed to fetch template'));
apiRouter.get('/agents', requireTool('list_agents'), async (req, res) => {
  try { res.json(await agentService.listAgents()); } catch (err) { sendErr(res, err, 'Failed to list agents'); }
});
apiRouter.get('/agents/:id', requireTool('get_agent'), async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json(agent);
  } catch (err) { sendErr(res, err, 'Failed to fetch agent'); }
});

/* --------- conversations: read + reply --------- */
apiRouter.get('/conversations', requireTool('list_conversations'), (req, res) =>
  discovery(res, () => mcpService.listConversations({
    waNumber: req.query.waNumber, search: req.query.search || req.query.q, limit: req.query.limit,
  }), 'Failed to list conversations'));
apiRouter.get('/conversations/messages', requireTool('read_messages'), (req, res) =>
  discovery(res, () => mcpService.getChatHistory({
    waNumber: req.query.waNumber, contactNumber: req.query.contactNumber,
    limit: req.query.limit, before: req.query.before,
  }), 'Failed to read messages'));
apiRouter.post('/messages/text', requireTool('send_message'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendTextMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send message' }); }
});
apiRouter.post('/messages/template', requireTool('send_template'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendTemplateMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send template' }); }
});
apiRouter.post('/messages/media', requireTool('send_media'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendMediaMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send media' }); }
});
apiRouter.post('/messages/interactive', requireTool('send_interactive'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendInteractiveMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send interactive' }); }
});

/* --------- funnel: leads / marketing / BDA dedicated tools --------- */
apiRouter.get('/leads', requireTool('list_leads'), (req, res) =>
  discovery(res, () => mcpService.listLeads({ stage: req.query.stage, search: req.query.search, limit: req.query.limit, view: req.query.view }), 'Failed to list leads'));
apiRouter.put('/leads/:id/move', requireTool('move_lead_stage'), async (req, res) => {
  try { res.json(await mcpService.moveLeadStage(req.params.id, req.body?.stage)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to move lead' }); }
});
apiRouter.get('/campaign-performance', requireTool('get_campaign_performance'), (req, res) =>
  discovery(res, () => mcpService.getCampaignPerformance({ campaignId: req.query.campaignId }), 'Failed to load campaign performance'));
apiRouter.get('/webinars-list', requireTool('list_webinars'), (req, res) =>
  discovery(res, () => mcpService.listWebinars(), 'Failed to list webinars'));

/* --------- courses + payments dedicated tools --------- */
// Named *-list / *-summary so they can't collide with the real /courses and
// /payments app routes reachable through the generic proxy.
apiRouter.get('/courses-list', requireTool('list_products'), (req, res) =>
  discovery(res, () => mcpService.listCourses(), 'Failed to list courses'));
apiRouter.get('/courses-revenue', requireTool('get_product_revenue'), (req, res) =>
  discovery(res, () => mcpService.getCourseRevenue(), 'Failed to load course revenue'));
apiRouter.get('/payments-list', requireTool('list_payments'), (req, res) =>
  discovery(res, () => mcpService.listPayments({
    state: req.query.state, courseId: req.query.courseId, search: req.query.search, limit: req.query.limit,
  }), 'Failed to list payments'));

/* --------- full access: generic proxy + catalog + bulk --------- */
// Both of these were previously UNGATED at this layer — they self-gated on the
// area caps inside listEndpoints/proxyRequest, so there was no switch that
// turned them off outright. They now sit behind their category like every other
// tool; the per-area caps still scope what the proxy may actually reach, so
// this is a second lock on the same door, not a replacement for it.
apiRouter.get('/endpoints', requireTool('list_endpoints'),
  (req, res) => res.json(mcpService.listEndpoints(req.mcp?.capabilities || {})));
apiRouter.post('/proxy', requireTool('forgechat_request'), async (req, res) => {
  try {
    const out = await mcpService.proxyRequest(req.body || {}, req.mcp?.capabilities || {});
    res.status(200).json(out);
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Proxy request failed' }); }
});
apiRouter.post('/bulk-message', requireTool('send_bulk_message'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendBulkMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Bulk send failed' }); }
});

/* --------- config: media / templates / automations / wa-links / lead forms ---
   Suffixed (*-create / *-list / *-submit) so they never collide with the real
   app paths the generic proxy forwards. --------- */
apiRouter.post('/media-upload', requireTool('upload_media'), async (req, res) => {
  try { res.status(201).json(await mcpService.uploadMediaFromSource(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to upload media' }); }
});
apiRouter.post('/templates-create', requireTool('create_template'), async (req, res) => {
  try { res.status(201).json(await mcpService.createTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create template' }); }
});
apiRouter.post('/templates-submit', requireTool('submit_template'), async (req, res) => {
  try { res.json(await mcpService.submitTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to submit template' }); }
});
apiRouter.post('/templates-sync', requireTool('sync_template'), async (req, res) => {
  try { res.json(await mcpService.syncTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to sync template' }); }
});
apiRouter.post('/automations-create', requireTool('create_automation'), async (req, res) => {
  try { res.status(201).json(await mcpService.createAutomation(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create automation' }); }
});
apiRouter.post('/wa-links-create', requireTool('create_wa_link'), async (req, res) => {
  try { res.status(201).json(await mcpService.createWaLink(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create link' }); }
});
apiRouter.post('/lead-forms-create', requireTool('create_lead_form'), async (req, res) => {
  try { res.status(201).json(await mcpService.createLeadForm(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create lead form' }); }
});
apiRouter.get('/lead-forms-list', requireTool('list_lead_forms'), (req, res) =>
  discovery(res, () => mcpService.listLeadForms(), 'Failed to list lead forms'));
apiRouter.get('/lead-forms-submissions', requireTool('list_form_submissions'), (req, res) =>
  discovery(res, () => mcpService.listFormSubmissions({ formId: req.query.formId, page: req.query.page, pageSize: req.query.pageSize }), 'Failed to load submissions'));
// Suffixed so they can never collide with the real /projects paths the generic
// proxy forwards — same convention as /courses-list and /lead-forms-list above.
apiRouter.get('/projects-list', requireTool('list_projects'), (req, res) =>
  discovery(res, () => mcpService.listProjects({ projectId: req.query.projectId }), 'Failed to list projects'));
apiRouter.post('/projects-assign', requireTool('move_to_project'), async (req, res) => {
  try { res.json(await mcpService.moveToProject(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to move the items' }); }
});

/* --------- mutations --------- */
apiRouter.post('/agents', requireTool('create_agent'), async (req, res) => {
  try { res.status(201).json(await agentService.createAgent(req.body || {})); } catch (err) { sendErr(res, err, 'Failed to create agent'); }
});
apiRouter.put('/agents/:id', requireTool('update_agent'), async (req, res) => {
  try { res.json(await agentService.updateAgent(req.params.id, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to update agent'); }
});
apiRouter.post('/agents/:id/tools', requireTool('add_tool'), async (req, res) => {
  try { res.status(201).json(await agentService.addTool(req.params.id, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to add tool'); }
});
apiRouter.put('/agents/:id/tools/:toolId', requireTool('update_tool'), async (req, res) => {
  try { res.json(await agentService.updateTool(req.params.id, req.params.toolId, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to update tool'); }
});
apiRouter.delete('/agents/:id/tools/:toolId', requireTool('delete_tool'), async (req, res) => {
  try { res.json(await agentService.deleteTool(req.params.id, req.params.toolId)); } catch (err) { sendErr(res, err, 'Failed to delete tool'); }
});
apiRouter.delete('/agents/:id', requireTool('delete_agent'), async (req, res) => {
  try { res.json(await agentService.deleteAgent(req.params.id)); } catch (err) { sendErr(res, err, 'Failed to delete agent'); }
});

module.exports = { adminRouter, apiRouter, ensureMcpTables };
