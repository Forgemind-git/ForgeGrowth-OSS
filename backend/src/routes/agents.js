// AI Agents CRUD + runs viewer.
//
// Single-owner system, same pattern as whatsappAccounts.js: every authenticated
// request is the owner. Agents no longer carry their own API key — they
// reference a workspace-wide credential in coexistence.ai_models by FK
// (ai_model_id). The provider comes from that joined row; decryption happens in
// the engine at run time. Agents have a draft/active lifecycle: a 'draft' is
// saved with incomplete config (e.g. before a model is connected) and never
// handles live traffic until completed and activated.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly } = require('../middleware/access');
const agentService = require('../services/agentService');

const router = Router();

// All agent create/update/tool business logic lives in services/agentService.js
// so the bearer-authed MCP API (routes/mcp.js) shares the exact same validation.
// These route handlers are thin wrappers that map service ApiErrors → HTTP.
function sendErr(res, err, fallback) {
  if (err instanceof agentService.ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[agents] ${fallback}:`, err.message);
  return res.status(500).json({ error: fallback });
}

router.get('/agents', async (req, res) => {
  try {
    res.json(await agentService.listAgents());
  } catch (err) {
    sendErr(res, err, 'Failed to list agents');
  }
});

router.get('/agents/:id', async (req, res) => {
  try {
    const agent = await agentService.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json(agent);
  } catch (err) {
    sendErr(res, err, 'Failed to fetch agent');
  }
});

router.post('/agents', adminOnly, async (req, res) => {
  try {
    res.status(201).json(await agentService.createAgent(req.body || {}));
  } catch (err) {
    sendErr(res, err, 'Failed to create agent');
  }
});

router.put('/agents/:id', adminOnly, async (req, res) => {
  try {
    res.json(await agentService.updateAgent(req.params.id, req.body || {}));
  } catch (err) {
    sendErr(res, err, 'Failed to update agent');
  }
});

router.delete('/agents/:id', adminOnly, async (req, res) => {
  try {
    res.json(await agentService.deleteAgent(req.params.id));
  } catch (err) {
    sendErr(res, err, 'Failed to delete agent');
  }
});

/* --------------------------- Export / Import -------------------------- */

// Export a single agent as a portable JSON object (admin-only — the file can
// carry tool secrets like HTTP auth headers).
router.get('/agents/:id/export', adminOnly, async (req, res) => {
  try {
    res.json(await agentService.exportAgent(req.params.id));
  } catch (err) {
    sendErr(res, err, 'Failed to export agent');
  }
});

// Import an agent from an export file (admin-only). Always creates a new draft.
router.post('/agents/import', adminOnly, async (req, res) => {
  try {
    res.status(201).json(await agentService.importAgent(req.body || {}));
  } catch (err) {
    sendErr(res, err, 'Failed to import agent');
  }
});

/* --------------------------- Tools (nested) --------------------------- */

router.post('/agents/:id/tools', adminOnly, async (req, res) => {
  try {
    res.status(201).json(await agentService.addTool(req.params.id, req.body || {}));
  } catch (err) {
    sendErr(res, err, 'Failed to add tool');
  }
});

router.put('/agents/:id/tools/:toolId', adminOnly, async (req, res) => {
  try {
    res.json(await agentService.updateTool(req.params.id, req.params.toolId, req.body || {}));
  } catch (err) {
    sendErr(res, err, 'Failed to update tool');
  }
});

router.delete('/agents/:id/tools/:toolId', adminOnly, async (req, res) => {
  try {
    res.json(await agentService.deleteTool(req.params.id, req.params.toolId));
  } catch (err) {
    sendErr(res, err, 'Failed to delete tool');
  }
});

/* --------------------------- Runs (viewer) ---------------------------- */

router.get('/agents/:id/runs', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '50', 10)));
    const { rows } = await pool.query(
      `SELECT id, agent_id, contact_number, inbound_message_id, status,
              total_input_tokens, total_output_tokens, final_reply, error_message,
              started_at, ended_at
         FROM coexistence.agent_runs
        WHERE agent_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [req.params.id, limit],
    );
    res.json(rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      contactNumber: r.contact_number,
      inboundMessageId: r.inbound_message_id,
      status: r.status,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      finalReply: r.final_reply,
      errorMessage: r.error_message,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    })));
  } catch (err) {
    console.error('[agents] runs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

router.get('/agents/:id/runs/:runId', async (req, res) => {
  try {
    const { rows: runs } = await pool.query(
      `SELECT * FROM coexistence.agent_runs WHERE id = $1 AND agent_id = $2`,
      [req.params.runId, req.params.id],
    );
    if (runs.length === 0) return res.status(404).json({ error: 'Not found' });
    const { rows: steps } = await pool.query(
      `SELECT * FROM coexistence.agent_run_steps WHERE run_id = $1 ORDER BY step_index`,
      [req.params.runId],
    );
    const r = runs[0];
    res.json({
      id: r.id,
      agentId: r.agent_id,
      contactNumber: r.contact_number,
      inboundMessageId: r.inbound_message_id,
      status: r.status,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      finalReply: r.final_reply,
      errorMessage: r.error_message,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      steps: steps.map(s => ({
        id: s.id,
        stepIndex: s.step_index,
        stepType: s.step_type,
        toolType: s.tool_type,
        input: s.input,
        output: s.output,
        status: s.status,
        latencyMs: s.latency_ms,
        errorMessage: s.error_message,
        createdAt: s.created_at,
      })),
    });
  } catch (err) {
    console.error('[agents] run detail error:', err.message);
    res.status(500).json({ error: 'Failed to fetch run' });
  }
});

/* --------------------------- Test chat (preview) ---------------------- */
const os = require('os');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { runAgentTest, transcribeForAgent } = require('../engine/agentEngine');
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /agents/:id/test  body: { messages: [{role:'user'|'assistant', content}] }
//
// In-app dry run of an agent. Runs the LLM loop with real tool execution
// (Sheets append/read/update WILL hit the real spreadsheet — operators are
// expected to point a test agent at a test sheet) but skips the WhatsApp send
// and skips agent_runs persistence so the run history stays clean. Returns
// the reply text + the per-step trace.
router.post('/agents/:id/test', adminOnly, async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array of {role,content}' });
    }
    const result = await runAgentTest({ agentId: req.params.id, messages });
    res.json(result);
  } catch (err) {
    console.error('[agents] test error:', err.message);
    res.status(500).json({ error: err.message || 'Agent test failed' });
  }
});

// POST /agents/:id/test/transcribe  (multipart: audio) — transcribe a voice note
// recorded in the test chat, using the agent's OpenAI key. Returns { text }.
router.post('/agents/:id/test/transcribe', adminOnly, audioUpload.single('audio'), async (req, res) => {
  let tmpPath = null;
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No audio uploaded' });
    const mime = req.file.mimetype || '';
    const ext = mime.includes('ogg') ? 'ogg'
      : (mime.includes('mp4') || mime.includes('m4a')) ? 'm4a'
      : mime.includes('mpeg') ? 'mp3'
      : mime.includes('wav') ? 'wav'
      : 'webm';
    tmpPath = path.join(os.tmpdir(), `agent-test-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`);
    fs.writeFileSync(tmpPath, req.file.buffer);
    const text = await transcribeForAgent({ agentId: req.params.id, filePath: tmpPath });
    res.json({ text: text || '' });
  } catch (err) {
    console.error('[agents] test transcribe error:', err.message);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* ignore */ } }
  }
});

module.exports = { router };
