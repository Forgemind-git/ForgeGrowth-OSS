'use strict';

/**
 * Landing-page leads → the WhatsApp conversation they start.
 *
 * An ads landing page collects a visitor's details
 * and keeps them in its OWN lead service. The visitor then taps "WhatsApp" and
 * sends a message. Nothing in that message identifies the form they filled, so
 * this module reads the landing page's stored data (read-only, over its export
 * endpoint) and matches the conversation to the visitor by phone number.
 *
 * Used in two places:
 *   - engine/automationEngine.js evaluateTriggers — a keyword trigger with
 *     `landingSource` set fires ONLY when a stored record matches, hands the
 *     details to the walk as {{form_name}} / {{form_summary}}, and runs ALONE for
 *     that message (a New Contact flow on the same number does not also reply).
 *   - routes/webhook.js — preemptPausedRuns() ends a paused reply-wait for that
 *     contact first, or the landing message would be swallowed as an answer to
 *     an older flow's question and the landing flow would never run.
 *
 * ⚠ The landing project is someone else's. Nothing here writes to it — the
 * export endpoint is a GET, authenticated by the token the landing project
 * already issues for its CSV/JSON export.
 *
 * ⚠ The trigger words alone cannot mean "came from the landing page": the
 * Click-to-WhatsApp ad messages contain the same course name. The stored record
 * is what makes the difference, which is why a failed lookup must mean "not a
 * landing visitor" (the message is handled exactly as before), never an error.
 */

const pool = require('../db');

// One entry per landing page. `key` is what an automation's trigger stores, so
// it must never change once a flow uses it; `label` is display-only.
//
// None are built in. Set LANDING_SOURCES to a JSON array to connect one, e.g.
//   [{"key":"my-landing","label":"My landing page","urlEnv":"MY_LANDING_EXPORT_URL",
//     "tokenEnv":"MY_LANDING_EXPORT_TOKEN","leadSource":"Landing Page"}]
// With the list empty every landing hook in the engine and webhook is a no-op.
function parseLandingSources(raw) {
  if (!raw || !String(raw).trim()) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(s => s && s.key && s.urlEnv && s.tokenEnv) : [];
  } catch (err) {
    console.error('[landing] LANDING_SOURCES is not valid JSON — ignoring it:', err.message);
    return [];
  }
}
const LANDING_SOURCES = parseLandingSources(process.env.LANDING_SOURCES);

const FETCH_TIMEOUT_MS = 3000;
// A person who filled the page from two browsers has two landing lead ids;
// this stops the second one welcoming them again the same day.
const SAME_CONTACT_WINDOW = '24 hours';
// A lead created this recently from this very message may still carry the
// webhook's default 'Direct' source — that one is corrected; an older source is
// never rewritten (a returning lead keeps the attribution it arrived with).
const FRESH_LEAD_WINDOW = '10 minutes';
const CANCEL_REASON = 'Ended: the customer arrived from a landing page, which starts its own flow';
// How recently the visitor must have been on the page for their TYPED NAME to
// identify them. A name is not a key — two people share one sooner or later —
// so it only counts beside a fresh visit. Long enough for someone who fills the
// form, gets distracted, and messages later; short enough that a stranger with
// the same name weeks later is never mistaken for them.
const NAME_MATCH_WINDOW_MS = 60 * 60 * 1000;

// The details a visitor typed, in the order they are read back to them.
const DETAIL_FIELDS = [
  ['name', 'Name'],
  ['whatsapp', 'WhatsApp'],
  ['email', 'Email'],
  ['profession', 'Profession'],
  ['city', 'City'],
  ['used_claude', 'Used Claude before'],
  // The landing page asks this ONLY when they answered Yes above, so it is
  // blank for everyone else — and blank fields are dropped from the summary.
  ['claude_plan', 'Claude plan'],
  ['ai_tools', 'AI tools used'],
];

function sourceByKey(key) {
  return LANDING_SOURCES.find(s => s.key === key) || null;
}

function sourceConfig(src) {
  return {
    url: String(process.env[src.urlEnv] || '').trim(),
    token: String(process.env[src.tokenEnv] || '').trim(),
  };
}

/** For the builder picker. `configured:false` means the server cannot read it. */
function listLandingSources() {
  return LANDING_SOURCES.map(s => {
    const { url, token } = sourceConfig(s);
    return { key: s.key, label: s.label, configured: !!(url && token) };
  });
}

function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

// Same person, several spellings: +91 98765 43210 / 919876543210 / 9876543210.
// Every lead lookup in this app compares the last 10 digits; so does this one.
function last10(v) {
  const d = digits(v);
  return d.length >= 10 ? d.slice(-10) : '';
}

/** The number the visitor typed, from the "WhatsApp: …" line of the pre-filled message. */
function typedPhoneFromBody(body) {
  const m = String(body || '').match(/whats\s*app\s*:\s*([+\d][\d\s\-().]{6,})/i);
  return m ? m[1] : '';
}

/**
 * The name the visitor introduced themselves with: "Hi, I'm Sk Ajay. I want to
 * enroll…" — the shape the landing page pre-fills. Stops at the first sentence
 * break so the rest of the sentence never leaks into the name.
 *
 * A "Name: …" line is read too, because an older pre-fill used that form.
 */
function typedNameFromBody(body) {
  const s = String(body || '');
  const labelled = s.match(/^\s*name\s*:\s*([^\n]{2,60})/im);
  if (labelled) return labelled[1].trim();
  // "I'm", "I am" and a bare "Im" all introduce a name.
  const intro = s.match(/\bi(?:\s*['\u2018\u2019`]\s*m|\s+am|\s*m)\s+([^.,\n!?]{2,60})/i);
  const found = intro ? intro[1].trim() : '';
  // ⚠ An introduction that runs on is a SENTENCE, not a name — the old pre-fill
  // began "Hi! I'm interested in joining the …", which would otherwise be read
  // as a 60-character name. Nobody's name is six words long.
  return found && found.split(/\s+/).length <= 5 ? found : '';
}

// Names are compared on letters and digits only, so "Sk  Ajay", "sk ajay" and
// "Sk. Ajay" are one name. Never used alone — see pickRow.
function normName(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// "2026-09-22T08:37:05+0000" — Python's strftime("%z") omits the colon, which
// not every Date parser accepts. Normalise it rather than trust the parser.
function tsOf(v) {
  const s = String(v || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pick the visitor behind a message from the export's rows. Pure — the unit
 * tests drive it directly.
 *
 * Sender first: the number WhatsApp itself reports cannot be mistyped. The typed
 * number is the fallback for someone who filled the page with one number and
 * messaged from another. A row without a name is not a visitor who filled the
 * form, so it never matches.
 *
 * ⚠ THE NAME IS THE LAST RESORT, AND IT IS NOT A KEY. Measured on live data:
 * of 41 distinct names, one name belongs to two different people. So a
 * name only identifies someone when it picks out EXACTLY ONE visitor AND that
 * visitor was on the page within the last hour. Two candidates, or one stale
 * one, and we send nothing: silence is recoverable, greeting the wrong customer
 * by name with a stranger's email and city is not.
 *
 * `at` is when the message arrived (ms). Without it the recency rule cannot be
 * applied, so the name path is skipped rather than guessed at.
 */
function pickRow(rows, { senderPhone, body, at }) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(r => r && String(r.name || '').trim() && last10(r.phone));
  const latest = (cands) => cands.sort((a, b) => tsOf(b.last_seen || b.first_seen) - tsOf(a.last_seen || a.first_seen))[0] || null;

  const sender = last10(senderPhone);
  if (sender) {
    const hit = latest(list.filter(r => last10(r.phone) === sender));
    if (hit) return { row: hit, matchedBy: 'sender_phone' };
  }
  const typed = last10(typedPhoneFromBody(body));
  if (typed) {
    const hit = latest(list.filter(r => last10(r.phone) === typed));
    if (hit) return { row: hit, matchedBy: 'typed_phone' };
  }

  const name = normName(typedNameFromBody(body));
  // Two characters of "name" is a parse accident, not an introduction.
  if (name && name.replace(/ /g, '').length >= 3) {
    const when = Number.isFinite(at) ? at : Date.parse(at);
    if (Number.isFinite(when)) {
      const sameName = list.filter(r => normName(r.name) === name);
      // Exactly one, or we cannot tell them apart. Checked BEFORE the window so
      // a shared name is refused even when only one of them is recent — the
      // other may simply not have reached the page yet today.
      if (sameName.length === 1) {
        const seen = tsOf(sameName[0].last_seen || sameName[0].first_seen);
        if (seen && Math.abs(when - seen) <= NAME_MATCH_WINDOW_MS) {
          return { row: sameName[0], matchedBy: 'typed_name' };
        }
      }
    }
  }
  return null;
}

function prettyPhone(v) {
  const d = digits(v);
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  return d ? `+${d}` : '';
}

/** answers → {{form_<key>}}, summary → {{form_summary}} (blank answers left out). */
function buildDetails(row) {
  const r = row || {};
  const tools = [r.tools, r.other_tools].map(x => String(x || '').trim()).filter(Boolean).join(', ');
  const answers = {
    name: String(r.name || '').trim(),
    whatsapp: prettyPhone(r.phone),
    email: String(r.email || '').trim(),
    profession: String(r.profession || '').trim(),
    city: String(r.city || '').trim(),
    used_claude: String(r.used_claude || '').trim(),
    claude_plan: String(r.claude_plan || '').trim(),
    ai_tools: tools,
  };
  const summary = DETAIL_FIELDS
    .filter(([k]) => answers[k])
    .map(([k, label]) => `${label}: ${answers[k]}`)
    .join('\n');
  return { answers, summary };
}

// One export read per message: the webhook's preempt check and the engine both
// ask about the same message within milliseconds of each other.
const memo = new Map();
const MEMO_TTL_MS = 60 * 1000;

async function fetchRows(src) {
  const { url, token } = sourceConfig(src);
  if (!url || !token) {
    console.warn(`[landing] ${src.key}: ${src.urlEnv}/${src.tokenEnv} not set — landing lookups disabled`);
    return null;
  }
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`export answered ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : null;
}

/** Every collapsed visitor row of one landing source, or null when it cannot be read. */
async function fetchLandingRows(sourceKey) {
  const src = sourceByKey(sourceKey);
  return src ? fetchRows(src) : null;
}

/**
 * The stored landing record for this message, or null. Never throws: a down
 * landing service must leave the message on its ordinary path.
 */
async function findLandingRecord(sourceKey, record) {
  const src = sourceByKey(sourceKey);
  if (!src || !record) return null;
  const memoKey = `${sourceKey}|${record.message_id || ''}|${record.contact_number || ''}`;
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at > MEMO_TTL_MS) memo.delete(k);
  if (record.message_id && memo.has(memoKey)) return memo.get(memoKey).value;

  let value = null;
  try {
    const rows = await fetchRows(src);
    // `at` drives the name path's recency rule. Meta's timestamp is when the
    // customer actually sent it; fall back to now so a record without one still
    // matches by phone (the name path simply does not apply).
    const at = record.timestamp ? tsOf(record.timestamp) || Date.parse(record.timestamp) || Date.now() : Date.now();
    const picked = rows
      ? pickRow(rows, { senderPhone: record.contact_number, body: record.message_body, at })
      : null;
    if (picked) value = { sourceKey, ...picked };
  } catch (err) {
    console.error(`[landing] ${sourceKey} lookup failed:`, err.message);
    value = null;
  }
  if (record.message_id) memo.set(memoKey, { at: now, value });
  return value;
}

/** Has this visitor (or this contact, today) already been welcomed? */
async function alreadyClaimed(client, sourceKey, landingLeadId, contactNumber) {
  const { rows } = await client.query(
    `SELECT 1 FROM coexistence.landing_lead_links
      WHERE source = $1
        AND (landing_lead_id = $2
             OR (contact_number = $3 AND created_at > NOW() - $4::interval))
      LIMIT 1`,
    [sourceKey, landingLeadId, contactNumber, SAME_CONTACT_WINDOW]
  );
  return rows.length > 0;
}

/**
 * Claim the visitor for this message and put their details on the lead.
 * Returns `{ linkId, leadId, details }`, or null when this visitor was already
 * welcomed (the flow must then NOT run again) or the claim could not be made.
 *
 * ⚠ The claim is a UNIQUE index, not a SELECT-then-INSERT: two deliveries of the
 * same message (Meta retries) would both pass a check and both send a 15-minute
 * video.
 */
async function claimAndApply({ match, record, automationId }) {
  if (!match || !match.row || !record) return null;
  const src = sourceByKey(match.sourceKey);
  if (!src) return null;
  const row = match.row;
  const landingLeadId = String(row.lead_id || '').trim() || `phone:${last10(row.phone)}`;
  const details = buildDetails(row);

  let claim;
  try {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.landing_lead_links
         (source, landing_lead_id, wa_number, contact_number, message_id, automation_id, matched_by, details)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM coexistence.landing_lead_links
           WHERE source = $1 AND contact_number = $4 AND created_at > NOW() - $9::interval)
       ON CONFLICT (source, landing_lead_id) DO NOTHING
       RETURNING id`,
      [src.key, landingLeadId, record.wa_number || null, record.contact_number || null,
        record.message_id || null, automationId || null, match.matchedBy || null,
        JSON.stringify({ ...details, landing: pickLandingMeta(row) }), SAME_CONTACT_WINDOW]
    );
    claim = rows[0];
  } catch (err) {
    console.error('[landing] claim failed:', err.message);
    return null;
  }
  if (!claim) return null;

  let leadId = null;
  try {
    // The webhook's own attribution chain is creating this lead in parallel;
    // ensureLeadForContact is an idempotent upsert, so calling it here too is
    // safe and guarantees the lead exists before the details are written.
    const { ensureLeadForContact } = require('../routes/leads');
    const lead = await ensureLeadForContact({
      contactNumber: record.contact_number, name: record.contact_name, source: src.leadSource,
    });
    leadId = lead?.id || null;
    if (leadId) {
      const bag = {
        used_claude: details.answers.used_claude || null,
        claude_plan: details.answers.claude_plan || null,
        ai_tools: details.answers.ai_tools || null,
        landing_lead_id: landingLeadId,
        utm_campaign: String(row.utm_campaign || '').trim() || null,
      };
      Object.keys(bag).forEach(k => { if (bag[k] == null || bag[k] === '') delete bag[k]; });
      await pool.query(
        `UPDATE coexistence.leads l SET
            -- The typed name beats the WhatsApp profile name, never a name a
            -- person has since edited.
            name = CASE WHEN l.name IS NULL OR btrim(l.name) = '' OR l.name = $2 THEN $3 ELSE l.name END,
            email = COALESCE(NULLIF(btrim(l.email), ''), $4),
            profession = COALESCE(NULLIF(btrim(l.profession), ''), $5),
            city = COALESCE(NULLIF(btrim(l.city), ''), $6),
            source = CASE WHEN (l.source IS NULL OR l.source = 'Direct')
                               AND l.created_at > NOW() - $7::interval
                          THEN $8 ELSE l.source END,
            custom_fields = (CASE WHEN jsonb_typeof(l.custom_fields) = 'object'
                                  THEN l.custom_fields ELSE '{}'::jsonb END - $9::text[]) || $10::jsonb,
            last_activity_at = NOW(), updated_at = NOW()
          WHERE l.id = $1`,
        [leadId, record.contact_name || null, details.answers.name || null,
          details.answers.email || null, details.answers.profession || null, details.answers.city || null,
          FRESH_LEAD_WINDOW, src.leadSource, Object.keys(bag), JSON.stringify(bag)]
      );
      await pool.query(`UPDATE coexistence.landing_lead_links SET lead_id = $2 WHERE id = $1`, [claim.id, leadId]);
      ensureFunnelSource(src.leadSource);
      require('../events').emit('lead-changed', { leadId });
    }
  } catch (err) {
    // The claim stands: the flow still runs with the details in hand, which is
    // what the customer sees. Only the CRM write is lost, and it is logged.
    console.error('[landing] lead update failed:', err.message);
  }
  return { linkId: claim.id, leadId, details, landingLeadId, matchedBy: match.matchedBy };
}

// What the audit row keeps about where the visitor came from.
function pickLandingMeta(row) {
  const keep = ['lead_id', 'stage', 'first_seen', 'last_seen', 'price', 'utm_source', 'utm_medium',
    'utm_campaign', 'utm_content', 'ad_id', 'adset_id', 'campaign_id', 'landing_url'];
  const out = {};
  keep.forEach(k => { if (row && row[k]) out[k] = row[k]; });
  return out;
}

// The source label must exist in the managed list, or the Leads/Pipeline source
// pickers would not offer a value the funnel is full of.
async function ensureFunnelSource(label) {
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO coexistence.funnel_sources (label) VALUES ($1) ON CONFLICT (label) DO NOTHING`,
      [label]
    );
    if (rowCount) await require('./funnelConfig').refreshFunnelConfig();
  } catch (err) {
    console.error('[landing] ensureFunnelSource failed:', err.message);
  }
}

// ── Which automations are landing-gated ─────────────────────────────────────

function triggerOf(automation) {
  const nodes = (automation && automation.config && automation.config.nodes) || [];
  return nodes.find(n => n && n.type === 'trigger') || null;
}

/** The landing source a flow's trigger requires, or '' for an ordinary flow. */
function landingSourceOf(automation) {
  const t = triggerOf(automation);
  if (!t || (t.triggerKind || 'keyword') !== 'keyword') return '';
  return String(t.landingSource || '').trim();
}

/**
 * The landing-gated automations this inbound message's words would start,
 * grouped by landing source. Words and account only — no lookup yet.
 */
function landingCandidates(automations, record) {
  if (!record || record.direction === 'outgoing' || record.message_type === 'status') return new Map();
  const { keywordTriggerHit } = require('../engine/automationEngine');
  const bySource = new Map();
  for (const a of automations || []) {
    const src = landingSourceOf(a);
    if (!src) continue;
    const t = triggerOf(a);
    if ((t.triggerDirection || 'inbound') === 'outbound') continue;
    const accounts = Array.isArray(t.triggerAccounts) ? t.triggerAccounts : [];
    if (accounts.length > 0 && !accounts.includes(record.wa_number)) continue;
    if (!keywordTriggerHit(t, record.message_body)) continue;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(a);
  }
  return bySource;
}

/**
 * Called by the webhook BEFORE it resumes paused runs. When this message will
 * start a landing flow, end this contact's paused reply-waits on this number —
 * otherwise the webhook resumes the older flow with the landing message as its
 * "answer" and skips trigger evaluation altogether.
 *
 * Returns the number of runs ended. Never throws.
 */
async function preemptPausedRuns(record) {
  try {
    if (!record || !record.contact_number || !record.wa_number) return 0;
    const { rows: automations } = await pool.query(
      `SELECT id, config FROM coexistence.chatbots
        WHERE status = 'active' AND config::text LIKE '%"landingSource"%'`
    );
    if (automations.length === 0) return 0;
    const candidates = landingCandidates(automations, record);
    for (const [sourceKey] of candidates) {
      const match = await findLandingRecord(sourceKey, record);
      if (!match) continue;
      const landingLeadId = String(match.row.lead_id || '').trim() || `phone:${last10(match.row.phone)}`;
      if (await alreadyClaimed(pool, sourceKey, landingLeadId, record.contact_number)) continue;
      const { rows } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status = 'cancelled', completed_at = NOW(), error_message = $3
          WHERE wa_number = $1 AND contact_number = $2
            AND status = 'paused' AND awaiting_kind = 'reply'
          RETURNING id`,
        [record.wa_number, record.contact_number, CANCEL_REASON]
      );
      if (rows.length) {
        console.log(`[landing] ended ${rows.length} paused run(s) for ${record.contact_number} — landing flow takes over`);
      }
      return rows.length;
    }
    return 0;
  } catch (err) {
    console.error('[landing] preemptPausedRuns failed:', err.message);
    return 0;
  }
}

/**
 * RESET for landing flows: forget that this contact was welcomed, so their next
 * landing message runs the flow again (details, video, voice note, brochure).
 *
 * Matched on the last 10 digits and across every business number — the
 * once-per-visitor guard is per person, not per number, so clearing only this
 * number's rows would leave the 24-hour same-contact check still blocking.
 *
 * The lead keeps the details that were copied onto it; only the "already
 * welcomed" record goes. Returns how many rows were removed and the automation
 * the most recent one belonged to (for the reset reply). Never throws.
 */
async function clearForContact(contactNumber) {
  const d = last10(contactNumber);
  if (!d) return { cleared: 0, automationId: null };
  try {
    const { rows } = await pool.query(
      `DELETE FROM coexistence.landing_lead_links
        WHERE right(regexp_replace(contact_number, '\\D', '', 'g'), 10) = $1
        RETURNING automation_id, created_at`,
      [d]
    );
    const latest = rows.sort((a, b) => b.created_at - a.created_at)[0];
    return { cleared: rows.length, automationId: latest?.automation_id || null };
  } catch (err) {
    console.error('[landing] clearForContact failed:', err.message);
    return { cleared: 0, automationId: null };
  }
}

/**
 * The active landing-gated automation listening on this business number, or
 * null. RESET uses it to answer even a contact with nothing to reset: on a
 * number a landing flow listens on, a silent RESET reads as "the bot is broken"
 * (it was reported exactly that way), so it replies with that flow's words.
 * Scoped to landing numbers on purpose — other campaigns keep their behaviour.
 */
async function activeLandingFlowOn(waNumber) {
  try {
    const { rows } = await pool.query(
      `SELECT id, config FROM coexistence.chatbots
        WHERE status = 'active' AND config::text LIKE '%"landingSource"%' ORDER BY id`
    );
    const hit = rows.find(a => {
      if (!landingSourceOf(a)) return false;
      const accts = triggerOf(a).triggerAccounts;
      return !Array.isArray(accts) || accts.length === 0 || accts.includes(waNumber);
    });
    return hit ? hit.id : null;
  } catch (err) {
    console.error('[landing] activeLandingFlowOn failed:', err.message);
    return null;
  }
}

/** Mirrors supabase/migrations/122_landing_lead_links.sql. Idempotent. */
async function ensureLandingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.landing_lead_links (
      id               BIGSERIAL PRIMARY KEY,
      source           TEXT NOT NULL,
      landing_lead_id  TEXT NOT NULL,
      lead_id          BIGINT REFERENCES coexistence.leads(id) ON DELETE SET NULL,
      wa_number        TEXT,
      contact_number   TEXT,
      message_id       TEXT,
      automation_id    BIGINT,
      matched_by       TEXT,
      details          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_landing_lead_links_visitor
                      ON coexistence.landing_lead_links (source, landing_lead_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_landing_lead_links_contact
                      ON coexistence.landing_lead_links (source, contact_number, created_at DESC)`);
}

module.exports = {
  LANDING_SOURCES,
  listLandingSources,
  landingSourceOf,
  landingCandidates,
  findLandingRecord,
  fetchLandingRows,
  claimAndApply,
  preemptPausedRuns,
  clearForContact,
  activeLandingFlowOn,
  ensureLandingTables,
  // exported for unit tests
  pickRow,
  buildDetails,
  typedPhoneFromBody,
  typedNameFromBody,
  normName,
  NAME_MATCH_WINDOW_MS,
  last10,
  tsOf,
};
