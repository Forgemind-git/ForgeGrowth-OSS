// Recording ONE form response — shared by every way a form can be filled in.
//
// There are two of those now: a human tapping /f/<slug> in a browser
// (routes/leadForms.js publicRouter), and an AI agent collecting the same
// answers conversationally over WhatsApp and submitting them on the customer's
// behalf (services/agentFormTools.js).
//
// ⚠ THIS FILE EXISTS SO THERE IS EXACTLY ONE ANSWERS -> LEAD MAPPING. Copying
// the mapping into the agent path is the anti-pattern this codebase has already
// paid for twice (the products/sales-log split, the template-row extraction): a
// second implementation drifts, and the drifted half fails in the DATABASE —
// two customers with identical answers landing as two differently-shaped leads,
// discovered weeks later by someone reading a funnel report. If a new fill
// route is ever added, it calls recordSubmission() too.
//
// What the mapping decides, in one place:
//   - which answers become real lead columns (`mapsTo`)
//   - which land in leads.custom_fields under a registry key (`mapsTo: 'cf:…'`)
//   - which land there under their own field key (no mapsTo)
//   - that a rating is FLATTENED for the lead bag but stored structured on the
//     submission row
//   - that a phone is optional, and a phone-less response is an anonymous
//     submission rather than a rejected one

const pool = require('../db');
const cfg = require('./funnelConfig');
const { isEmptyAnswer, answerToText } = require('./formAnswers');

/**
 * Find-or-create the lead behind a submission, matched on the last 10 digits of
 * the phone (the same person is stored as 9876543210 / +919876543210 / 91… across
 * the systems that feed this table).
 *
 * Every existing-lead write is COALESCE'd so a form can FILL a blank field but
 * never overwrite something a human already set — the same rule the Razorpay
 * profile path follows. `custom_fields` is merged IN SQL (`|| $::jsonb`), never
 * read-modify-written, so two submissions landing together cannot lose one
 * another's answers.
 */
async function upsertLeadFromSubmission({ phone, mapped, customFields, defaultSource }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);
  const source = mapped.source || defaultSource || null;

  const { rows: found } = await pool.query(
    `SELECT id, stage FROM coexistence.leads WHERE right(regexp_replace(whatsapp_number,'\\D','','g'),10) = $1 ORDER BY id LIMIT 1`,
    [last10]
  );

  if (found.length) {
    const leadId = found[0].id;
    await pool.query(
      `UPDATE coexistence.leads
          SET name = COALESCE(name, $2), email = COALESCE($3, email), age = COALESCE($4, age),
              profession = COALESCE($5, profession), pincode = COALESCE($6, pincode),
              city = COALESCE($7, city), source = COALESCE(source, $8),
              custom_fields = custom_fields || $9::jsonb,
              last_activity_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [leadId, mapped.name || null, mapped.email || null,
        Number.isFinite(mapped.age) ? mapped.age : null, mapped.profession || null,
        mapped.pincode || null, mapped.city || null, source, JSON.stringify(customFields || {})]
    );
    return leadId;
  }

  const stage = cfg.funnelStageKeys()[0] || 'new';
  const { rows: ins } = await pool.query(
    `INSERT INTO coexistence.leads (whatsapp_number, name, email, age, profession, pincode, city, source, stage, has_whatsapp_thread, custom_fields, stage_changed_at, last_activity_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10::jsonb,NOW(),NOW(),NOW(),NOW()) RETURNING id`,
    [digits, mapped.name || null, mapped.email || null, Number.isFinite(mapped.age) ? mapped.age : null,
      mapped.profession || null, mapped.pincode || null, mapped.city || null, source, stage, JSON.stringify(customFields || {})]
  );
  return ins[0].id;
}

/**
 * Split one answers object into (real lead columns, custom-field bag), using
 * each field's own `mapsTo`.
 *
 * Exported separately from recordSubmission because the agent path needs to
 * report back WHICH answers it understood without writing anything (a dry
 * check before it claims success to the customer).
 */
function mapAnswers({ fields, answers, phone = null }) {
  const mapped = {};
  const customFields = {};
  let resolvedPhone = phone;

  for (const f of fields) {
    const v = answers[f.key];
    if (isEmptyAnswer(f, v)) continue;
    // A rating is flattened to "4/5 - loved it" for the lead bag only. The full
    // structured answer is still stored verbatim on the submission row, so
    // nothing is lost — but the bag is read back by the Leads table and by
    // {{lead.<key>}} in follow-ups, and an object in either renders as
    // "[object Object]" to a human.
    const stored = f.type === 'rating' ? answerToText(f, v) : v;
    if (f.mapsTo && f.mapsTo.startsWith('cf:')) {
      // Mapped to a registered custom Leads field — store under the REGISTRY key
      // so the value shows on the Leads/Sales Log tables and resolves as
      // {{lead.<key>}} in follow-ups.
      customFields[f.mapsTo.slice(3)] = stored;
    } else if (f.mapsTo) {
      // An already-known phone WINS over a typed one. On the public page that
      // known value is the send token's recipient; in a chat it is the contact
      // the agent is talking to. Both are more trustworthy than a retyped field.
      if (f.mapsTo === 'phone') { if (!resolvedPhone) resolvedPhone = String(v); }
      else if (f.mapsTo === 'age') mapped.age = Number.isFinite(Number(v)) ? parseInt(v, 10) : null;
      else mapped[f.mapsTo] = String(v).trim();
    } else {
      customFields[f.key] = stored;
    }
  }
  return { mapped, customFields, phone: resolvedPhone };
}

/**
 * Every required field that is still empty, as an array of field objects.
 * The browser turns the first one into a 400; the agent turns the whole list
 * into "I still need X and Y" so it can ask for them in one go.
 */
function missingRequired({ fields, answers }) {
  return fields.filter(f => f.required && isEmptyAnswer(f, answers[f.key]));
}

/**
 * Record one response: upsert the lead (when there is a phone) and insert the
 * submission row.
 *
 * `phone` is whatever the caller already knows (send-token recipient, or the
 * chat contact). It is OPTIONAL by design — leads.whatsapp_number is NOT NULL
 * and UNIQUE, so a response with no phone genuinely cannot become a lead and
 * lives as an anonymous row on this form's own table instead. Never reject a
 * fill over a missing phone: the respondent has already done the work, and
 * requiring one is the builder's per-field decision.
 *
 * Order is lead-then-submission on purpose, but note the asymmetry from
 * anti-pattern #26: the lead here is not a side effect of a write that might
 * still fail — the submission INSERT is the last thing that happens, and a
 * throw from it rolls nothing back. That is the accepted trade: a lead with no
 * submission row is recoverable and visible; a submission pointing at a lead
 * that was never created is not.
 */
async function recordSubmission({
  form, answers, phone = null, token = null, source = null,
  ipAddress = null, userAgent = null, agentId = null,
}) {
  const fields = form.fields || [];
  const m = mapAnswers({ fields, answers, phone });

  const leadId = m.phone
    ? await upsertLeadFromSubmission({
        phone: m.phone,
        mapped: m.mapped,
        customFields: m.customFields,
        defaultSource: source || form.default_source || form.name,
      })
    : null;

  const { rows } = await pool.query(
    `INSERT INTO coexistence.lead_form_submissions (form_id, lead_id, answers, phone_number, send_token, ip_address, user_agent, created_by_agent_id)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8) RETURNING id`,
    [form.id, leadId, JSON.stringify(answers), m.phone, token, ipAddress, userAgent, agentId]
  );

  return { submissionId: rows[0].id, leadId, phone: m.phone, mapped: m.mapped, customFields: m.customFields };
}

/**
 * Rewrite the answers on a row an agent already filed.
 *
 * ⚠ Scoped to `created_by_agent_id = $agentId` IN THE SQL, not checked
 * beforehand — a read-then-write check is a race, and the thing being protected
 * is a customer's own typed answers. A row a human submitted, or one another
 * agent filed, simply does not match and the UPDATE affects zero rows.
 *
 * The lead is re-upserted from the corrected answers for the same reason the
 * insert path does it: a correction that fixed a misheard name has to reach the
 * funnel, or the table and the lead disagree and only the table is right.
 * `upsertLeadFromSubmission` writes blank-only via COALESCE, so this can never
 * clobber a value a person set by hand.
 */
async function updateSubmission({ form, submissionId, answers, agentId, source = null }) {
  const fields = form.fields || [];
  const { rows: cur } = await pool.query(
    `SELECT id, phone_number FROM coexistence.lead_form_submissions
      WHERE id = $1 AND form_id = $2 AND created_by_agent_id = $3`,
    [submissionId, form.id, agentId]
  );
  if (!cur[0]) return null;

  const m = mapAnswers({ fields, answers, phone: cur[0].phone_number });
  if (m.phone) {
    await upsertLeadFromSubmission({
      phone: m.phone,
      mapped: m.mapped,
      customFields: m.customFields,
      defaultSource: source || form.default_source || form.name,
    });
  }

  const { rows } = await pool.query(
    `UPDATE coexistence.lead_form_submissions
        SET answers = $2::jsonb
      WHERE id = $1 AND created_by_agent_id = $3
      RETURNING id, lead_id`,
    [submissionId, JSON.stringify(answers), agentId]
  );
  if (!rows[0]) return null;
  return { submissionId: rows[0].id, leadId: rows[0].lead_id, phone: m.phone };
}

module.exports = { recordSubmission, updateSubmission, mapAnswers, missingRequired, upsertLeadFromSubmission };
