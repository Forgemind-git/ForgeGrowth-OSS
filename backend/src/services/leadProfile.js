'use strict';

// Everything Sales knows about one contact, for the profile pop-up:
//   system   — the lead's own columns (name, number, stage, owner, payments…)
//   custom   — every custom field the registry defines, plus any value stored in
//              the lead's custom_fields bag that no registered field describes
//   threads  — the WhatsApp chats this person has, one per business number
//   activity — automation runs and AI-agent runs for this person
//   stages   — the stage history (lead_events)
//
// ⚠ A person is matched on the LAST 10 DIGITS of their number, like every other
// lead lookup in this app — a lead's whatsapp_number and a chat's
// contact_number are written by different paths and disagree about the country
// code often enough that an equality match silently finds nobody.

const pool = require('../db');
const registry = require('./fieldRegistry');
const cfg = require('./funnelConfig');

// Custom-bag keys that are plumbing, not facts about the person.
const INTERNAL_KEYS = new Set(['landing_lead_id']);

const humanise = (k) => String(k).replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
const key10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const stageLabel = (k) => (k ? ((cfg.stages() || []).find(s => s.stageKey === k)?.label || k) : null);

function valueText(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// The registry's label for a system column, so a relabel in Admin Settings →
// Fields shows here too.
const sysLabel = (key, fallback) => registry.labelFor('lead', key, fallback);

function systemFields(lead) {
  const rupees = (n) => (n == null ? null : `₹${Number(n).toLocaleString('en-IN')}`);
  return [
    { key: 'name', label: sysLabel('name', 'Name'), value: lead.name || null },
    { key: 'whatsapp_number', label: sysLabel('whatsapp_number', 'WhatsApp'), value: lead.whatsappNumber || null, type: 'phone' },
    { key: 'email', label: sysLabel('email', 'Email'), value: lead.email || null },
    { key: 'city', label: sysLabel('city', 'City'), value: lead.city || null },
    { key: 'profession', label: sysLabel('profession', 'Profession'), value: lead.profession || null },
    { key: 'age', label: sysLabel('age', 'Age'), value: lead.age == null ? null : String(lead.age) },
    { key: 'pincode', label: sysLabel('pincode', 'Pincode'), value: lead.pincode || null },
    { key: 'source', label: sysLabel('source', 'Source'), value: lead.source || null },
    { key: 'stage', label: sysLabel('stage', 'Stage'), value: stageLabel(lead.stage) },
    { key: 'assigned_to', label: sysLabel('assigned_to', 'Owner'), value: lead.assignedUserName || lead.assignedBda || null },
    { key: 'paid_course', label: sysLabel('paid_course', 'Product'), value: lead.paidCourse || null },
    { key: 'total_paid', label: sysLabel('total_paid', 'Total paid'), value: rupees(lead.paidAmount) },
    { key: 'created_at', label: sysLabel('created_at', 'Arrived'), value: lead.createdAt || null, type: 'date' },
    { key: 'last_activity_at', label: sysLabel('last_activity_at', 'Last activity'), value: lead.lastActivityAt || null, type: 'date' },
    { key: 'last_inbound_at', label: 'Last message from them', value: lead.lastInboundAt || null, type: 'date' },
    { key: 'stage_changed_at', label: 'In this stage since', value: lead.stageChangedAt || null, type: 'date' },
    { key: 'lead_id', label: 'Contact ID', value: String(lead.id), mono: true },
  ];
}

function customFields(lead) {
  const bag = lead.customFields && typeof lead.customFields === 'object' && !Array.isArray(lead.customFields) ? lead.customFields : {};
  const defs = registry.customFields('lead');
  const known = new Set(defs.map(f => f.fieldKey));
  const out = defs.map(f => ({
    key: f.fieldKey, label: f.label, type: f.fieldType, options: f.options || [],
    value: valueText(bag[f.fieldKey]), registered: true,
  }));
  // Values a form, an import or the landing page wrote under a key nobody has
  // registered as a field. They are real answers, so they are shown — read-only,
  // since there is no field definition to edit them against.
  for (const [k, v] of Object.entries(bag)) {
    if (known.has(k) || INTERNAL_KEYS.has(k) || k.startsWith('_')) continue;
    const text = valueText(v);
    if (text == null) continue;
    out.push({ key: k, label: humanise(k), type: 'text', options: [], value: text, registered: false });
  }
  return out;
}

async function threadsFor(k, { userId, admin }) {
  if (!k) return [];
  const { rows } = await pool.query(
    `SELECT c.wa_number, c.contact_number, COALESCE(c.name, c.profile_name) AS contact_name,
            COALESCE(NULLIF(btrim(a.label), ''), a.display_name) AS business_name, a.display_phone_number AS business_phone,
            m.n, m.last_at, m.last_in, m.last_text
       FROM coexistence.contacts c
       LEFT JOIN coexistence.whatsapp_accounts a ON a.display_phone_number = c.wa_number
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n, MAX(h."timestamp") AS last_at,
                MAX(h."timestamp") FILTER (WHERE h.direction = 'incoming') AS last_in,
                (ARRAY_AGG(h.message_body ORDER BY h."timestamp" DESC) FILTER (WHERE COALESCE(h.message_body,'') <> ''))[1] AS last_text
           FROM coexistence.chat_history h
          WHERE h.wa_number = c.wa_number AND h.contact_number = c.contact_number
            AND h.message_type <> 'status'
       ) m ON TRUE
      WHERE right(regexp_replace(c.contact_number, '\\D', '', 'g'), 10) = $1
        AND ($2::boolean OR c.assigned_user_id = $3)
      ORDER BY m.last_at DESC NULLS LAST`,
    [k, admin, userId || 0]);
  return rows.map(r => ({
    waNumber: r.wa_number, contactNumber: r.contact_number, contactName: r.contact_name || null,
    businessName: r.business_name || null, messageCount: r.n || 0,
    lastMessageAt: r.last_at, lastIncomingAt: r.last_in, lastText: r.last_text || null,
    // WhatsApp lets a business send free text for 24h after the customer's last message.
    windowOpen: !!r.last_in && Date.now() - new Date(r.last_in).getTime() < 24 * 3600 * 1000,
  }));
}

async function activityFor(k) {
  if (!k) return [];
  const [{ rows: flows }, { rows: agents }] = await Promise.all([
    pool.query(
      `SELECT e.id, e.automation_id, b.name, e.status, e.trigger_type, e.started_at, e.completed_at,
              e.error_message, e.wa_number,
              (SELECT COUNT(*)::int FROM coexistence.automation_execution_steps s WHERE s.execution_id = e.id) AS steps
         FROM coexistence.automation_executions e
         LEFT JOIN coexistence.chatbots b ON b.id = e.automation_id
        WHERE right(regexp_replace(COALESCE(e.contact_number,''), '\\D', '', 'g'), 10) = $1
        ORDER BY e.started_at DESC LIMIT 60`, [k]),
    pool.query(
      `SELECT r.id, r.agent_id, g.name, r.status, r.started_at, r.ended_at, r.error_message, r.final_reply, r.is_test
         FROM coexistence.agent_runs r
         LEFT JOIN coexistence.agents g ON g.id = r.agent_id
        WHERE right(regexp_replace(r.contact_number, '\\D', '', 'g'), 10) = $1
        ORDER BY r.started_at DESC LIMIT 40`, [k]).catch(() => ({ rows: [] })),
  ]);
  return [
    ...flows.map(r => ({
      kind: 'automation', id: `a${r.id}`, executionId: Number(r.id),
      automationId: r.automation_id == null ? null : Number(r.automation_id),
      name: r.name || 'Deleted automation', status: r.status, trigger: r.trigger_type,
      at: r.started_at, endedAt: r.completed_at, error: r.error_message || null, steps: r.steps || 0,
      waNumber: r.wa_number || null,
    })),
    ...agents.map(r => ({
      kind: 'agent', id: `g${r.id}`, agentId: r.agent_id == null ? null : Number(r.agent_id),
      name: r.name || 'Deleted AI agent', status: r.status, trigger: r.is_test ? 'test number' : 'message',
      at: r.started_at, endedAt: r.ended_at, error: r.error_message || null,
      reply: r.final_reply ? String(r.final_reply).slice(0, 240) : null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 80);
}

async function stageHistory(leadId) {
  const { rows } = await pool.query(
    `SELECT ts, from_value, to_value, actor FROM coexistence.lead_events
      WHERE lead_id = $1 AND event_type = 'stage_changed' ORDER BY ts DESC LIMIT 50`, [leadId]);
  return rows.map(r => ({ at: r.ts, from: stageLabel(r.from_value), to: stageLabel(r.to_value), actor: r.actor || null }));
}

/** `lead` is the leadRow() shape. */
async function buildProfile(lead, { userId, admin }) {
  const k = key10(lead.whatsappNumber);
  const [threads, activity, stages] = await Promise.all([
    threadsFor(k, { userId, admin }), activityFor(k), stageHistory(lead.id),
  ]);
  return { lead, system: systemFields(lead), custom: customFields(lead), threads, activity, stages };
}

module.exports = { buildProfile, systemFields, customFields, INTERNAL_KEYS };
