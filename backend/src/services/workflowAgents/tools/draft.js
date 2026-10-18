// Draft tools: they create a suggestion or a memory PROPOSAL, never a customer-facing change.

const { toIst } = require('../format');
const { KEY10 } = require('../sql');
const { leadInScope, isAll } = require('../scope');
const { err, binder } = require('./common');

const WINDOW_MS = 24 * 36e5;

/** The thread a message to this lead should go out on: latest inbound, in-scope numbers only. */
async function leadThread(pool, scope, lead, now = new Date()) {
  const { params, add } = binder();
  const { rows } = await pool.query(
    `SELECT ch.wa_number, ch.contact_number,
            MAX(ch.timestamp) FILTER (WHERE ch.direction = 'incoming') AS last_inbound_at,
            MAX(ch.timestamp) AS last_any_at
       FROM coexistence.chat_history ch
      WHERE ${KEY10('ch.contact_number')} = ${KEY10(add(lead.whatsapp_number))}
        AND ch.timestamp <= ${add(now)}
        ${isAll(scope.business_numbers) ? '' : `AND ch.wa_number = ANY(${add(scope.business_numbers)}::text[])`}
      GROUP BY ch.wa_number, ch.contact_number
      ORDER BY MAX(ch.timestamp) FILTER (WHERE ch.direction = 'incoming') DESC NULLS LAST, MAX(ch.timestamp) DESC
      LIMIT 1`, params);
  const t = rows[0];
  if (!t) return null;
  const windowOpen = !!t.last_inbound_at && (now - new Date(t.last_inbound_at)) < WINDOW_MS;
  return {
    wa_number: t.wa_number,
    contact_number: t.contact_number,
    last_inbound_at: t.last_inbound_at,
    window_open: windowOpen,
    window_expires_at: t.last_inbound_at ? new Date(new Date(t.last_inbound_at).getTime() + WINDOW_MS) : null,
  };
}

/** Approved templates usable on a business number, with their body variable count. */
async function approvedTemplates(pool, waNumber) {
  const { rows } = await pool.query(
    `SELECT mt.id, mt.name, mt.category, mt.language, mt.header_type, mt.body, mt.buttons, mt.template_type
       FROM coexistence.message_templates mt
       LEFT JOIN coexistence.whatsapp_accounts wa ON wa.id = mt.whatsapp_account_id
      WHERE upper(mt.status) = 'APPROVED'
        AND (mt.whatsapp_account_id IS NULL OR wa.display_phone_number = $1)
      ORDER BY mt.category, mt.name`, [waNumber]);
  return rows.map(r => ({
    template_id: String(r.id), name: r.name, category: r.category, language: r.language,
    header_type: r.header_type, template_type: r.template_type,
    body: r.body, variable_count: new Set((String(r.body || '').match(/\{\{\s*\d+\s*\}\}/g) || [])).size,
    has_buttons: Array.isArray(r.buttons) && r.buttons.length > 0,
  }));
}

const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

const draftWhatsappReply = {
  key: 'draft_whatsapp_reply',
  category: 'Drafts',
  kind: 'draft',
  title: 'Draft WhatsApp reply',
  description: 'Check a suggested next message for a lead BEFORE you put it in your output. You write the message; this tool records it as a draft (nothing is sent), reports whether the WhatsApp 24-hour window is open on the lead\'s thread, and — when the window is closed or the lead has opted out — tells you free text cannot be sent and lists the approved templates for that number (with variable counts) so you can suggest one instead. Write in the language the lead last used.',
  input_schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'string' },
      message: { type: 'string', description: 'The suggested message text.' },
      language: { type: 'string', description: 'Language you wrote it in, e.g. "ta-Latn (Tanglish)", "en".' },
      purpose: { type: 'string', description: 'Short intent, e.g. "answer fee question and offer EMI".' },
    },
    required: ['contact_id', 'message'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope, now } = ctx;
    const id = Number(input.contact_id);
    if (!(await leadInScope(pool, scope, id))) return err('out_of_scope', 'That lead does not exist or is outside this agent\'s data scope.');
    const message = String(input.message || '').trim();
    if (!message) return err('invalid_input', 'message is required.');
    const { rows: [lead] } = await pool.query(`SELECT id, whatsapp_number, opted_out FROM coexistence.leads WHERE id = $1`, [id]);
    const thread = await leadThread(pool, scope, lead, now);
    const warnings = [];
    const words = wordCount(message);
    if (words > 60) warnings.push(`The message is ${words} words; keep suggested messages under 60 words.`);
    if (lead.opted_out) warnings.push('This lead has opted out: do not suggest contacting them.');
    if (!thread) warnings.push('No WhatsApp thread with this lead on an in-scope number.');
    const canSendText = !!thread && thread.window_open && !lead.opted_out;
    const out = {
      contact_id: String(id),
      recorded_as: 'draft',
      business_number_id: thread ? (ctx.accounts.byNumber.get(thread.wa_number)?.id || null) : null,
      window_open: !!thread?.window_open,
      window_expires_at: toIst(thread?.window_expires_at),
      free_text_allowed: canSendText,
      word_count: words,
      warnings,
    };
    if (thread && !thread.window_open && !lead.opted_out) {
      out.suggested_templates = (await approvedTemplates(pool, thread.wa_number)).slice(0, 25);
      out.instruction = 'The 24-hour window is closed: set suggested_template to one of these template names (and keep suggested_message as the idea behind it).';
    }
    ctx.recordDraft?.({ contact_id: String(id), message, language: input.language || null, purpose: input.purpose || null, window_open: out.window_open });
    return out;
  },
};

const proposeMemory = {
  key: 'propose_memory',
  category: 'Drafts',
  kind: 'draft',
  title: 'Propose memory',
  description: 'Propose a durable fact for this agent\'s memory: a learned pattern (kind "learned", e.g. "leads asking about weekend batches convert well"), a glossary term (kind "glossary"), or a note about one lead (kind "contact", needs contact_id). It waits for an admin to review unless the agent auto-accepts memory. Do not propose one-off observations or anything already in memory.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['learned', 'contact', 'glossary'] },
      title: { type: 'string', maxLength: 120 },
      content: { type: 'string', maxLength: 1500 },
      contact_id: { type: 'string' },
      evidence: { type: 'string', description: 'Why you believe this (counts, message_ids).' },
    },
    required: ['kind', 'title', 'content'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const { pool, scope } = ctx;
    const kind = String(input.kind || '');
    if (!['learned', 'contact', 'glossary'].includes(kind)) return err('invalid_input', 'kind must be learned, contact or glossary.');
    const title = String(input.title || '').trim().slice(0, 120);
    const content = String(input.content || '').trim().slice(0, 1500);
    if (!title || !content) return err('invalid_input', 'title and content are required.');
    let leadId = null;
    if (kind === 'contact') {
      leadId = Number(input.contact_id);
      if (!(await leadInScope(pool, scope, leadId))) return err('out_of_scope', 'contact memory needs an in-scope contact_id.');
    }
    const status = ctx.agent.auto_accept_memory ? 'active' : 'pending_review';
    const body = input.evidence ? `${content}\n\nEvidence: ${String(input.evidence).slice(0, 500)}` : content;
    // Near-duplicate guard: same kind + title already present (any status but archived).
    const { rows: dup } = await pool.query(
      `SELECT id, status FROM coexistence.workflow_agent_memory
        WHERE agent_id = $1 AND kind = $2 AND lower(title) = lower($3) AND status <> 'archived'
          AND (lead_id IS NOT DISTINCT FROM $4) LIMIT 1`, [ctx.agent.id, kind, title, leadId]);
    if (dup.length) return { status: 'already_exists', memory_id: String(dup[0].id), existing_status: dup[0].status };
    if (ctx.dryRun) {
      ctx.recordStep?.('memory_proposal', { kind, title, content: body, contact_id: leadId, simulated: true });
      return { status: 'simulated', would_be: status, note: 'Test run: nothing was saved.' };
    }
    const { rows: [m] } = await pool.query(
      `INSERT INTO coexistence.workflow_agent_memory (agent_id, kind, lead_id, title, content, source, status, proposed_by_run_id)
       VALUES ($1, $2, $3, $4, $5, 'agent_proposed', $6, $7) RETURNING id`,
      [ctx.agent.id, kind, leadId, title, body, status, ctx.runId || null]);
    ctx.recordStep?.('memory_proposal', { memory_id: String(m.id), kind, title, status });
    return { status, memory_id: String(m.id) };
  },
};

module.exports = { tools: [draftWhatsappReply, proposeMemory], leadThread, approvedTemplates, WINDOW_MS };
