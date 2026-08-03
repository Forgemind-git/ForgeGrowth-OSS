// Claude Code adapter. Unlike anthropic.js / openai.js (which call a hosted LLM
// API directly), this provider forwards the inbound message to the sandboxed
// `claude-runner` service, which drives the real Claude Code CLI in headless
// mode (claude -p --resume --output-format json) inside a locked-down container
// (non-root, workspace = /root/ForgeTask only, read-only DB access).
//
// Why a provider and not a new code path: agentEngine already resolves a
// provider by name and calls runWithTools(...). Plugging in here means we reuse
// the entire pipeline for free — run rows, step traces, the optimistic
// chat_history insert, the sendQueue reply, and the AgentRunsViewer UI.
//
// Conversation continuity: Claude Code owns its own history via session_id. We
// do NOT replay ForgeChat's message history into Claude (that would double up);
// we send only the latest inbound text plus the stored session_id to resume.
// The session_id is persisted per conversation in coexistence.claude_sessions.

const pool = require('../db');

const RUNNER_URL = (process.env.CLAUDE_RUNNER_URL || 'http://claude-runner:8080').replace(/\/$/, '');
const RUNNER_TOKEN = process.env.CLAUDE_RUNNER_TOKEN || '';
const RUNNER_TIMEOUT_MS = parseInt(process.env.CLAUDE_RUNNER_TIMEOUT_MS || '300000', 10);

const RESET_COMMANDS = new Set(['/new', '/reset', '/clear']);

function result(finalText, extra = {}) {
  return {
    finalText: finalText || '',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    iterations: 1,
    ...extra,
  };
}

// Convert GitHub-markdown (what Claude emits) to WhatsApp formatting.
// WhatsApp: *bold*  _italic_  ~strike~  ```mono```  • bullets — and NO headers
// or [text](url) links. Order matters: markdown *italic* and WhatsApp *bold*
// both use a single asterisk, so bold is parked in a placeholder first.
function mdToWhatsApp(md) {
  if (!md) return md;
  // Guillemet-tagged placeholders: rare in normal text, survive every step.
  const blocks = []; const inlines = []; const bolds = [];

  // 1. Shield fenced + inline code so we never rewrite their contents.
  let s = md.replace(/```[\s\S]*?```/g, (m) => { blocks.push(m); return `«B${blocks.length - 1}»`; });
  s = s.replace(/`[^`\n]+`/g, (m) => { inlines.push(m); return `«I${inlines.length - 1}»`; });

  // 2. Headers -> bold (parked as a bold placeholder so the italic pass can't
  //    grab the single asterisks; restored as *bold* in step 6).
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, (_, t) => { bolds.push(t.trim()); return `«D${bolds.length - 1}»`; });

  // 3. Bullets: "- " / "* " / "+ " at line start -> "• ".
  s = s.replace(/^(\s*)[-*+]\s+/gm, (_, indent) => `${indent}• `);

  // 4. Park markdown bold (**x** / __x__) so single-* italic below is safe.
  s = s.replace(/\*\*([^*]+?)\*\*/g, (_, t) => { bolds.push(t); return `«D${bolds.length - 1}»`; });
  s = s.replace(/__([^_]+?)__/g, (_, t) => { bolds.push(t); return `«D${bolds.length - 1}»`; });

  // 5. Markdown italic (*x*) -> WhatsApp italic (_x_).
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, (_, pre, t) => `${pre}_${t}_`);

  // 6. Restore bold as WhatsApp bold (*x*).
  s = s.replace(/«D(\d+)»/g, (_, i) => `*${bolds[+i]}*`);

  // 7. Strikethrough ~~x~~ -> ~x~.
  s = s.replace(/~~([^~]+?)~~/g, (_, t) => `~${t}~`);

  // 8. Links [text](url) -> "text (url)" (WhatsApp auto-links the bare url).
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`));

  // restore shielded code (inline first, then fenced)
  s = s.replace(/«I(\d+)»/g, (_, i) => inlines[+i]);
  s = s.replace(/«B(\d+)»/g, (_, i) => blocks[+i]);
  return s;
}

async function getSessionId(conversationKey) {
  try {
    const { rows } = await pool.query(
      'SELECT session_id FROM coexistence.claude_sessions WHERE conversation_key = $1',
      [conversationKey],
    );
    return rows[0]?.session_id || null;
  } catch (e) {
    console.error('[claudeCode] session lookup failed:', e.message);
    return null;
  }
}

async function saveSessionId(conversationKey, sessionId, model) {
  if (!sessionId) return;
  try {
    await pool.query(
      `INSERT INTO coexistence.claude_sessions (conversation_key, session_id, model, updated_at)
         VALUES ($1, $2, $3, NOW())
       ON CONFLICT (conversation_key)
         DO UPDATE SET session_id = EXCLUDED.session_id, model = EXCLUDED.model, updated_at = NOW()`,
      [conversationKey, sessionId, model || null],
    );
  } catch (e) {
    console.error('[claudeCode] session upsert failed:', e.message);
  }
}

async function getProjectKey(agentId) {
  if (!agentId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT p.key FROM coexistence.claude_agent_settings s
         JOIN coexistence.claude_projects p ON p.id = s.project_id
        WHERE s.agent_id = $1`,
      [agentId],
    );
    return rows[0]?.key || null;
  } catch (e) {
    console.error('[claudeCode] project lookup failed:', e.message);
    return null;
  }
}

async function isAllowed(agentId, contactNumber) {
  const phone = String(contactNumber || '').replace(/\D/g, '');
  if (!phone || !agentId) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM coexistence.claude_allowlist WHERE agent_id = $1 AND phone = $2 LIMIT 1',
      [agentId, phone],
    );
    return rows.length > 0;
  } catch (e) {
    console.error('[claudeCode] allowlist check failed:', e.message);
    return false; // fail closed
  }
}

async function clearSession(conversationKey) {
  try {
    await pool.query('DELETE FROM coexistence.claude_sessions WHERE conversation_key = $1', [conversationKey]);
  } catch (e) {
    console.error('[claudeCode] session clear failed:', e.message);
  }
}

async function callRunner(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNNER_TIMEOUT_MS);
  try {
    const res = await fetch(`${RUNNER_URL}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RUNNER_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.error) {
      return { error: 'runner_http', message: `Runner HTTP ${res.status}` };
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function runWithTools({ systemPrompt, messages, onStep, model, conversationKey, contactNumber, agentId }) {
  const t0 = Date.now();

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = (lastUser?.content || '').trim();

  // Per-agent allowlist (DB-managed via the Claude Console). Non-allowlisted
  // senders get NO reply (empty finalText), so a shared number stays quiet.
  if (!(await isAllowed(agentId, contactNumber))) {
    await onStep({ step_type: 'llm_call', status: 'ok', latency_ms: Date.now() - t0, input: { provider: 'claude_code' }, output: { skipped: 'not_allowed' } }).catch(() => {});
    return result('');
  }

  const emit = async (status, extra = {}) => {
    try {
      await onStep({
        step_type: 'llm_call',
        status,
        latency_ms: Date.now() - t0,
        input: { provider: 'claude_code', model, conversationKey },
        output: extra,
      });
    } catch (e) {
      console.error('[claudeCode] onStep failed:', e.message);
    }
  };

  if (!prompt) {
    await emit('ok', { skipped: 'empty' });
    return result('');
  }

  if (RESET_COMMANDS.has(prompt.toLowerCase())) {
    await clearSession(conversationKey);
    await emit('ok', { command: 'reset' });
    return result('Started a fresh Claude Code session. Send your next message to begin.');
  }

  const sessionId = await getSessionId(conversationKey);
  const projectKey = await getProjectKey(agentId);

  let resp;
  try {
    resp = await callRunner({ agentId, projectKey, conversationKey, contactNumber, prompt, sessionId, model, systemPrompt });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    await emit('error', { error: aborted ? 'timeout' : e.message });
    return result(
      aborted
        ? 'That took too long and timed out. Try a smaller step, or send /new to reset.'
        : 'Could not reach the Claude runner right now. Please try again in a moment.',
    );
  }

  if (resp.error === 'not_allowed') {
    await emit('ok', { skipped: 'not_allowed' });
    return result('');
  }
  if (resp.error === 'busy') {
    await emit('error', { error: 'busy' });
    return result('Still working on your previous message. Please wait for it to finish, then try again.');
  }
  if (resp.error === 'rate_limit') {
    await emit('error', { error: 'rate_limit' });
    return result(resp.message || 'Claude usage limit reached for now. Please try again later.');
  }
  if (resp.error || resp.isError) {
    await emit('error', { error: resp.error || 'claude_error' });
    return result(mdToWhatsApp(resp.text) || 'Claude hit an error processing that. Send /new to reset and try again.');
  }

  await saveSessionId(conversationKey, resp.sessionId, model);
  await emit('ok', { sessionId: resp.sessionId, costUsd: resp.costUsd, numTurns: resp.numTurns, tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, media: (resp.media || []).length });

  // Pull any files the agent put in its outbox (charts/PDFs/etc.) so agentEngine
  // can upload + send them as WhatsApp media.
  const media = [];
  for (const m of (resp.media || []).slice(0, 10)) {
    try {
      const r = await fetch(`${RUNNER_URL}/outbox?agentId=${agentId}&file=${encodeURIComponent(m.file)}`, { headers: { Authorization: `Bearer ${RUNNER_TOKEN}` } });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.base64) media.push({ filename: m.file, mime: m.mime || d.mime, caption: m.caption || '', base64: d.base64 });
    } catch (e) {
      console.error('[claudeCode] outbox fetch failed:', e.message);
    }
  }

  // Convert Claude's markdown to WhatsApp formatting before it goes out.
  const text = mdToWhatsApp(resp.text) || '';
  return result(text || (media.length ? '' : '(Claude finished but produced no text reply.)'), {
    totalInputTokens: resp.tokensIn || 0,
    totalOutputTokens: resp.tokensOut || 0,
    costUsd: resp.costUsd != null ? resp.costUsd : null,
    media,
  });
}

module.exports = { runWithTools, mdToWhatsApp };
