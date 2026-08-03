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
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const { hashApiKey } = require('../util/crypto');
const agentService = require('../services/agentService');
const mcpService = require('../services/mcpService');

const { CAPABILITY_KEYS, ensureMcpTables, loadSettings } = mcpService;

/* ============================ admin router ============================ */

const adminRouter = Router();

adminRouter.get('/mcp/settings', adminOnly, async (req, res) => {
  try {
    res.json(await loadSettings());
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
    const caps = { ...cur.capabilities };
    if (b.capabilities && typeof b.capabilities === 'object') {
      for (const k of CAPABILITY_KEYS) {
        if (b.capabilities[k] !== undefined) caps[k] = !!b.capabilities[k];
      }
    }
    await pool.query(
      `UPDATE coexistence.mcp_settings
          SET master_enabled = $1, capabilities = $2, updated_at = NOW()
        WHERE id = 1`,
      [masterEnabled, JSON.stringify(caps)],
    );
    res.json(await loadSettings());
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
    const { capabilities, keyId } = await mcpService.validateKey(m[1]);
    req.mcp = { capabilities };
    req.user = { id: keyId, role: 'admin', viaMcp: true };
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Authentication failed' });
  }
}

function requireCap(name) {
  return (req, res, next) => {
    if (req.mcp?.capabilities?.[name] !== true) {
      return res.status(403).json({ error: `The '${name}' capability is disabled for MCP access.` });
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
apiRouter.get('/wa-accounts', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.listWaAccounts(), 'Failed to list WhatsApp accounts'));
apiRouter.get('/models', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.listModels(), 'Failed to list models'));
apiRouter.get('/spreadsheets', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.searchSpreadsheets({ q: String(req.query.q || ''), pageSize: parseInt(req.query.pageSize || '50', 10) }), 'Failed to list spreadsheets'));
apiRouter.get('/spreadsheets/:id/tabs', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.listSheetTabs(req.params.id), 'Failed to load spreadsheet tabs'));
apiRouter.get('/spreadsheets/:id/values', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.readSheetValues({
    spreadsheetId: req.params.id,
    tab: req.query.tab,
    range: req.query.range || undefined,
    maxRows: req.query.maxRows,
  }), 'Failed to read spreadsheet values'));
apiRouter.get('/media', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.listMedia(
    req.query.type ? String(req.query.type) : null,
    req.query.name ? String(req.query.name) : null,
  ), 'Failed to list media'));
apiRouter.get('/templates', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.listTemplates(req.query.waAccountId), 'Failed to list templates'));
apiRouter.get('/templates/:id', requireCap('discovery'), (req, res) =>
  discovery(res, () => mcpService.getTemplate(req.params.id), 'Failed to fetch template'));
apiRouter.get('/agents', requireCap('discovery'), async (req, res) => {
  try { res.json(await agentService.listAgents()); } catch (err) { sendErr(res, err, 'Failed to list agents'); }
});
apiRouter.get('/agents/:id', requireCap('discovery'), async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json(agent);
  } catch (err) { sendErr(res, err, 'Failed to fetch agent'); }
});

/* --------- conversations: read + reply --------- */
apiRouter.get('/conversations', requireCap('read_messages'), (req, res) =>
  discovery(res, () => mcpService.listConversations({
    waNumber: req.query.waNumber, search: req.query.search || req.query.q, limit: req.query.limit,
  }), 'Failed to list conversations'));
apiRouter.get('/conversations/messages', requireCap('read_messages'), (req, res) =>
  discovery(res, () => mcpService.getChatHistory({
    waNumber: req.query.waNumber, contactNumber: req.query.contactNumber,
    limit: req.query.limit, before: req.query.before,
  }), 'Failed to read messages'));
apiRouter.post('/messages/text', requireCap('send_messages'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendTextMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send message' }); }
});
apiRouter.post('/messages/template', requireCap('send_messages'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendTemplateMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send template' }); }
});
apiRouter.post('/messages/media', requireCap('send_messages'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendMediaMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send media' }); }
});
apiRouter.post('/messages/interactive', requireCap('send_messages'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendInteractiveMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to send interactive' }); }
});

/* --------- funnel: leads / marketing / BDA dedicated tools --------- */
apiRouter.get('/leads', requireCap('area_leads'), (req, res) =>
  discovery(res, () => mcpService.listLeads({ stage: req.query.stage, search: req.query.search, limit: req.query.limit, view: req.query.view }), 'Failed to list leads'));
apiRouter.put('/leads/:id/move', requireCap('area_leads'), async (req, res) => {
  try { res.json(await mcpService.moveLeadStage(req.params.id, req.body?.stage)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to move lead' }); }
});
apiRouter.get('/campaign-performance', requireCap('area_marketing'), (req, res) =>
  discovery(res, () => mcpService.getCampaignPerformance({ campaignId: req.query.campaignId }), 'Failed to load campaign performance'));
apiRouter.get('/webinars-list', requireCap('area_marketing'), (req, res) =>
  discovery(res, () => mcpService.listWebinars(), 'Failed to list webinars'));
apiRouter.get('/bda-activity-summary', requireCap('area_bda'), (req, res) =>
  discovery(res, () => mcpService.getBdaActivity({ bdaId: req.query.bdaId, limit: req.query.limit }), 'Failed to load BDA activity'));

/* --------- courses + payments dedicated tools --------- */
// Named *-list / *-summary so they can't collide with the real /courses and
// /payments app routes reachable through the generic proxy.
apiRouter.get('/courses-list', requireCap('area_courses'), (req, res) =>
  discovery(res, () => mcpService.listCourses(), 'Failed to list courses'));
apiRouter.get('/courses-revenue', requireCap('area_courses'), (req, res) =>
  discovery(res, () => mcpService.getCourseRevenue(), 'Failed to load course revenue'));
apiRouter.get('/payments-list', requireCap('area_payments'), (req, res) =>
  discovery(res, () => mcpService.listPayments({
    state: req.query.state, courseId: req.query.courseId, search: req.query.search, limit: req.query.limit,
  }), 'Failed to list payments'));

/* --------- full access: generic proxy + catalog + bulk --------- */
apiRouter.get('/endpoints', (req, res) => res.json(mcpService.listEndpoints(req.mcp?.capabilities || {})));
apiRouter.post('/proxy', async (req, res) => {
  try {
    const out = await mcpService.proxyRequest(req.body || {}, req.mcp?.capabilities || {});
    res.status(200).json(out);
  } catch (err) { res.status(err.status || 500).json({ error: err.message || 'Proxy request failed' }); }
});
apiRouter.post('/bulk-message', requireCap('area_broadcasts'), async (req, res) => {
  try { res.status(202).json(await mcpService.sendBulkMessage(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Bulk send failed' }); }
});

/* --------- config: media / templates / automations / wa-links / lead forms ---
   Suffixed (*-create / *-list / *-submit) so they never collide with the real
   app paths the generic proxy forwards. --------- */
apiRouter.post('/media-upload', requireCap('area_broadcasts'), async (req, res) => {
  try { res.status(201).json(await mcpService.uploadMediaFromSource(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to upload media' }); }
});
apiRouter.post('/templates-create', requireCap('area_broadcasts'), async (req, res) => {
  try { res.status(201).json(await mcpService.createTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create template' }); }
});
apiRouter.post('/templates-submit', requireCap('area_broadcasts'), async (req, res) => {
  try { res.json(await mcpService.submitTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to submit template' }); }
});
apiRouter.post('/templates-sync', requireCap('area_broadcasts'), async (req, res) => {
  try { res.json(await mcpService.syncTemplate(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to sync template' }); }
});
apiRouter.post('/automations-create', requireCap('area_automations'), async (req, res) => {
  try { res.status(201).json(await mcpService.createAutomation(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create automation' }); }
});
apiRouter.post('/wa-links-create', requireCap('area_broadcasts'), async (req, res) => {
  try { res.status(201).json(await mcpService.createWaLink(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create link' }); }
});
apiRouter.post('/lead-forms-create', requireCap('area_leadforms'), async (req, res) => {
  try { res.status(201).json(await mcpService.createLeadForm(req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message || 'Failed to create lead form' }); }
});
apiRouter.get('/lead-forms-list', requireCap('area_leadforms'), (req, res) =>
  discovery(res, () => mcpService.listLeadForms(), 'Failed to list lead forms'));
apiRouter.get('/lead-forms-submissions', requireCap('area_leadforms'), (req, res) =>
  discovery(res, () => mcpService.listFormSubmissions({ formId: req.query.formId, page: req.query.page, pageSize: req.query.pageSize }), 'Failed to load submissions'));

/* --------- mutations --------- */
apiRouter.post('/agents', requireCap('create_agent'), async (req, res) => {
  try { res.status(201).json(await agentService.createAgent(req.body || {})); } catch (err) { sendErr(res, err, 'Failed to create agent'); }
});
apiRouter.put('/agents/:id', requireCap('update_agent'), async (req, res) => {
  try { res.json(await agentService.updateAgent(req.params.id, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to update agent'); }
});
apiRouter.post('/agents/:id/tools', requireCap('manage_tools'), async (req, res) => {
  try { res.status(201).json(await agentService.addTool(req.params.id, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to add tool'); }
});
apiRouter.put('/agents/:id/tools/:toolId', requireCap('manage_tools'), async (req, res) => {
  try { res.json(await agentService.updateTool(req.params.id, req.params.toolId, req.body || {})); } catch (err) { sendErr(res, err, 'Failed to update tool'); }
});
apiRouter.delete('/agents/:id/tools/:toolId', requireCap('delete'), async (req, res) => {
  try { res.json(await agentService.deleteTool(req.params.id, req.params.toolId)); } catch (err) { sendErr(res, err, 'Failed to delete tool'); }
});
apiRouter.delete('/agents/:id', requireCap('delete'), async (req, res) => {
  try { res.json(await agentService.deleteAgent(req.params.id)); } catch (err) { sendErr(res, err, 'Failed to delete agent'); }
});

module.exports = { adminRouter, apiRouter, ensureMcpTables };
