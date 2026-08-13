// The agent's access to a Form's TABLE.
//
// A form is two things: a page people fill in, and the table their answers land
// in. The agent is connected to the TABLE, not the page — it never "fills the
// form". It collects the same columns in conversation and writes a row into the
// same `lead_form_submissions` store, through the same
// `services/formSubmission.js` the public page uses (deliberately shared, not
// copied: two implementations would drift, and the drift would only ever be
// visible in the database, as two customers with identical answers stored as
// differently-shaped rows).
//
// So one table is filled from both directions — a person tapping the link, and
// the agent typing on their behalf — and everything downstream (the Responses
// tab, the dashboard, the CSV export, `{{form.<slug>.<key>}}`) reads them
// identically because they ARE identical.
//
// Two tools per connected form: add a row, and correct a row this agent added.
//
// FOUR DESIGN RULES, each protecting against a specific failure:
//
// 1. THE TABLE'S OWN COLUMNS ARE THE TOOL'S INPUT SCHEMA, TYPES INCLUDED. One
//    property per field keyed by the field's own key, carrying that column's
//    real type — `number` for a number, `boolean` for a yes/no, an `enum` of the
//    exact choices for a dropdown/radio, an array of those for a checkbox, a
//    stated YYYY-MM-DD for a date, an object for a star rating. So the model
//    cannot invent a column, a choice, or a shape that does not fit the column
//    (a model that has to guess, guesses). `coerceAnswers` then re-validates
//    every value server-side, because a schema is a description and not a gate.
//    Required columns are declared `required`, which is what makes the model
//    collect them before calling rather than writing a half-empty row.
//
//    The admin's per-field DESCRIPTION rides along in each property's
//    description, which is how you tell the agent what actually belongs in a
//    column ("the city only, not the state") beyond what its label implies.
//
// 2. THE PHONE IS NEVER THE MODEL'S TO SUPPLY. It is the contact the agent is
//    talking to. A phone-mapped question is REMOVED from the schema, so the
//    agent cannot ask for a number we already have (and cannot be talked into
//    filing someone else's answers against a third party's lead). Identity is
//    not a conversational input — same rule as the payment amount.
//
// 3. A TEST-CHAT FILL WRITES NOTHING. The Live test chat runs the real model
//    against the real tools; it must not create leads or submissions. Every
//    executor checks `live` first and reports what it WOULD have filed.
//
// 4. THE AGENT MAY ONLY CORRECT ITS OWN ROWS. `created_by_agent_id` is stamped
//    at insert and the UPDATE is scoped to it IN THE SQL, so a response a
//    customer typed on the form themselves is never the agent's to rewrite —
//    and a read-then-check would be a race on exactly that.

const pool = require('../db');
const { recordSubmission, updateSubmission, missingRequired } = require('./formSubmission');
const { isDisplayOnly, normalizeRating, ratingScale, answerToText } = require('./formAnswers');

// Answers submitted this recently with identical content are treated as the same
// fill. A model that calls the tool twice in one turn (or a retried run) must not
// produce two submissions and two lead touches. It is deliberately NOT a unique
// index — unlike a payment link, filling the same form again later with DIFFERENT
// answers is legitimate (the public page has always allowed it), so the guard is
// scoped to an identical repeat inside a short window.
const DUPLICATE_WINDOW_MINUTES = 10;

function slugForTool(s) {
  return String(s || 'form').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'form';
}

// A question the customer can actually answer. Sections are headings with no
// answer; a phone-mapped field is filled from the chat contact (rule 2).
function isAskable(f) {
  return !isDisplayOnly(f.type) && f.mapsTo !== 'phone';
}

function optionsOf(f) {
  return Array.isArray(f.options) ? f.options.map(o => String(o)).filter(Boolean) : [];
}

/** JSON-schema property for one field, plus a human line for the description. */
function propertyFor(f) {
  const desc = [f.label, f.description ? `(${f.description})` : null].filter(Boolean).join(' ');
  const opts = optionsOf(f);
  switch (f.type) {
    case 'number':
      return { type: 'number', description: desc };
    case 'boolean':
      return { type: 'boolean', description: `${desc} — true for yes, false for no.` };
    case 'dropdown':
    case 'radio':
      // enum, so an invalid choice cannot be expressed rather than being
      // rejected after the customer has already answered.
      return opts.length
        ? { type: 'string', enum: opts, description: desc }
        : { type: 'string', description: desc };
    case 'checkbox':
      return {
        type: 'array',
        items: opts.length ? { type: 'string', enum: opts } : { type: 'string' },
        description: `${desc} — one or more choices.`,
      };
    case 'date':
      return { type: 'string', description: `${desc} — as YYYY-MM-DD.` };
    case 'rating': {
      const max = ratingScale(f);
      return {
        type: 'object',
        description: `${desc} — a star rating out of ${max}.`,
        properties: {
          rating: { type: 'integer', description: `The rating, 1 to ${max}.` },
          feedback: { type: 'string', description: 'Anything they said alongside the rating. Optional.' },
        },
        required: ['rating'],
      };
    }
    default:
      return { type: 'string', description: desc };
  }
}

/**
 * Coerce + validate the model's answers into the shape the browser would have
 * posted, so the stored `answers` blob is identical whichever way the form was
 * filled (the dashboard, the CSV export and {{form.<slug>.<key>}} all read it).
 *
 * Returns { answers, errors }. A bad choice is an ERROR, not a silent drop:
 * dropping it would leave a required question looking unanswered, and the model
 * would loop asking the customer something they already told it.
 */
function coerceAnswers(fields, raw) {
  const answers = {};
  const errors = [];
  const given = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  for (const f of fields) {
    if (!isAskable(f)) continue;
    const v = given[f.key];
    if (v == null || v === '') continue;
    const opts = optionsOf(f);

    if (f.type === 'rating') {
      const { rating, feedback } = normalizeRating(f, v);
      if (rating == null) {
        errors.push(`"${f.label}" must be a whole number from 1 to ${ratingScale(f)}.`);
        continue;
      }
      // Store {rating, feedback} — the same shape the public page posts.
      answers[f.key] = feedback ? { rating, feedback } : { rating };
      continue;
    }

    if (f.type === 'checkbox') {
      const arr = (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean);
      if (opts.length) {
        const picked = [];
        for (const a of arr) {
          const hit = opts.find(o => o.toLowerCase() === a.toLowerCase());
          if (!hit) { errors.push(`"${a}" is not a choice for "${f.label}". Valid choices: ${opts.join(', ')}.`); continue; }
          if (!picked.includes(hit)) picked.push(hit);
        }
        if (picked.length) answers[f.key] = picked;
      } else if (arr.length) {
        answers[f.key] = arr;
      }
      continue;
    }

    if (f.type === 'dropdown' || f.type === 'radio') {
      const s = String(v).trim();
      if (opts.length) {
        const hit = opts.find(o => o.toLowerCase() === s.toLowerCase());
        if (!hit) { errors.push(`"${s}" is not a choice for "${f.label}". Valid choices: ${opts.join(', ')}.`); continue; }
        answers[f.key] = hit;
      } else {
        answers[f.key] = s;
      }
      continue;
    }

    if (f.type === 'boolean') {
      if (typeof v === 'boolean') answers[f.key] = v;
      else {
        const s = String(v).trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(s)) answers[f.key] = true;
        else if (['false', 'no', 'n', '0'].includes(s)) answers[f.key] = false;
        else errors.push(`"${f.label}" must be yes or no.`);
      }
      continue;
    }

    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`"${f.label}" must be a number.`); continue; }
      answers[f.key] = n;
      continue;
    }

    answers[f.key] = String(v).trim();
  }

  return { answers, errors };
}

/**
 * An identical submission for this form + this person inside the window, if one
 * exists. Matched on the last 10 digits of the phone, the convention every
 * cross-system phone match in this codebase uses.
 */
async function findRecentDuplicate({ formId, phone, answers }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const { rows } = await pool.query(
    `SELECT id, submitted_at FROM coexistence.lead_form_submissions
      WHERE form_id = $1
        AND right(regexp_replace(COALESCE(phone_number,''),'\\D','','g'),10) = $2
        AND answers = $3::jsonb
        AND submitted_at > NOW() - make_interval(mins => $4)
      ORDER BY id DESC LIMIT 1`,
    [formId, digits.slice(-10), JSON.stringify(answers), DUPLICATE_WINDOW_MINUTES]
  );
  return rows[0] || null;
}

/**
 * Build the fill-a-form tools for one agent.
 *
 * `toolRows` are that agent's enabled `agent_tools` rows of type 'lead_form'.
 * A row whose form was deleted, or has since been unpublished, is SKIPPED and
 * logged — never surfaced as a tool that would fail when called. A draft form
 * is not fillable for the same reason its public link is dead: "draft" has to
 * mean one thing.
 */
/**
 * The most recent row THIS agent filed for THIS person on THIS form.
 *
 * Scoped to the agent because that is the only row it is allowed to change —
 * a response a customer typed on the public page, or one another agent filed,
 * is not the agent's to rewrite.
 */
async function findOwnSubmission({ formId, phone, agentId }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7 || !agentId) return null;
  const { rows } = await pool.query(
    `SELECT id, answers, submitted_at FROM coexistence.lead_form_submissions
      WHERE form_id = $1
        AND created_by_agent_id = $2
        AND right(regexp_replace(COALESCE(phone_number,''),'\\D','','g'),10) = $3
      ORDER BY id DESC LIMIT 1`,
    [formId, agentId, digits.slice(-10)]
  );
  return rows[0] || null;
}

async function buildFormTools({ toolRows, contactNumber, live, agentId = null }) {
  const tools = [];
  const executors = {};

  for (const row of toolRows) {
    const cfg = row.config || {};
    const formId = parseInt(cfg.form_id, 10);
    if (!Number.isFinite(formId)) continue;

    const { rows: fr } = await pool.query(
      `SELECT id, name, slug, description, status, fields, default_source, success_message
         FROM coexistence.lead_forms WHERE id = $1`,
      [formId]
    );
    const form = fr[0];
    if (!form) {
      console.warn(`[agentFormTools] agent tool ${row.id} points at form ${formId}, which no longer exists.`);
      continue;
    }
    if (form.status !== 'published') {
      console.warn(`[agentFormTools] form ${formId} ("${form.name}") is ${form.status}, not published — skipping its fill tool.`);
      continue;
    }

    const fields = Array.isArray(form.fields) ? form.fields : [];
    const askable = fields.filter(isAskable);
    if (askable.length === 0) {
      console.warn(`[agentFormTools] form ${formId} ("${form.name}") has no answerable questions — skipping its fill tool.`);
      continue;
    }

    const properties = {};
    const required = [];
    for (const f of askable) {
      properties[f.key] = propertyFor(f);
      if (f.required) required.push(f.key);
    }

    // The questions go in the DESCRIPTION as well as the schema: the schema tells
    // the model what shape to send, the list tells it what to actually SAY. Both
    // come from the same `askable` array, so they cannot describe different forms.
    const questionList = askable.map(f => {
      const bits = [`- ${f.label}${f.required ? ' (required)' : ' (optional)'}`];
      const opts = optionsOf(f);
      if (opts.length) bits.push(`choices: ${opts.join(' / ')}`);
      if (f.type === 'rating') bits.push(`star rating out of ${ratingScale(f)}`);
      return bits.join(' — ');
    }).join('\n');

    const slug = slugForTool(form.slug || form.name);
    const name = `save_to_${slug}_${row.id}`;
    tools.push({
      name,
      description:
        `Add a row to the "${form.name}" table`
        + (form.description ? ` (${form.description})` : '') + '.\n'
        + 'This is the SAME table people fill in themselves through the form, so what you save here sits '
        + 'alongside their responses and is read the same way.\n'
        + 'Its columns are:\n' + questionList + '\n'
        + 'Collect these naturally in the conversation — one or two at a time, in your own words, not as a '
        + 'list — then call this once you have them. '
        + 'You do NOT need their phone number: it is taken from this chat automatically. '
        + 'Every required column must be filled before you call this; if one is missing, it tells you which '
        + 'so you can ask. '
        + `Call this ONCE. If you learn a correction afterwards, use update_${slug}_${row.id} instead of adding a second row.`,
      input_schema: { type: 'object', properties, required },
    });

    executors[name] = async (args) => {
      const { answers, errors } = coerceAnswers(fields, args);
      if (errors.length) return { ok: false, errors, note: 'Nothing was recorded. Ask the customer again for these, then call this tool once more with the full set of answers.' };

      // Required is checked against the COERCED answers, so a value that failed
      // to coerce cannot pass as "answered".
      const missing = missingRequired({ fields: askable, answers });
      if (missing.length) {
        return {
          ok: false,
          missing: missing.map(f => f.label),
          note: 'Nothing was recorded yet. Ask the customer for these, then call this tool again with every answer including the ones you already have.',
        };
      }

      if (!live || !contactNumber || contactNumber === 'test') {
        // Test chat: the model and the tools are real, the write is not.
        return {
          ok: true, simulated: true, form: form.name,
          answers_understood: askable
            .filter(f => answers[f.key] !== undefined)
            .map(f => `${f.label}: ${answerToText(f, answers[f.key])}`),
          note: 'Test mode — no submission or lead was created.',
        };
      }

      const dup = await findRecentDuplicate({ formId: form.id, phone: contactNumber, answers });
      if (dup) {
        return {
          ok: true, already_submitted: true, submission_id: dup.id, form: form.name,
          note: 'These exact answers were already recorded a moment ago, so nothing was duplicated. Tell the customer it is done — do not ask the questions again.',
        };
      }

      const res = await recordSubmission({
        form,
        answers,
        phone: contactNumber,
        source: form.default_source || form.name,
        userAgent: 'forge-growth-ai-agent',
        agentId,
      });
      return {
        ok: true,
        form: form.name,
        submission_id: res.submissionId,
        lead_id: res.leadId,
        // The form's own success message, so the agent confirms in the words the
        // operator wrote for the browser page rather than inventing its own.
        success_message: form.success_message || 'Thanks — your response has been recorded.',
      };
    };

    // ── Correct a row this agent already filed ──────────────────────────────
    //
    // A separate tool rather than an "upsert" flag on the one above, because
    // the two are different intents and the model should have to pick. An
    // upsert that silently overwrote whenever a row happened to exist would
    // turn "this is a second enquiry" into "scrap the first one".
    //
    // The full corrected set is required, not a patch: a partial update would
    // need the model to remember what it previously sent, and a required column
    // it forgot would silently empty rather than stay put.
    const updateName = `update_${slug}_${row.id}`;
    tools.push({
      name: updateName,
      description:
        `Correct the row you previously added to the "${form.name}" table for this person. `
        + 'Use this — never the add tool — when they change or complete an answer they already gave you, '
        + 'so they end up with one correct row instead of two conflicting ones.\n'
        + 'Send EVERY column, not just the changed one: this replaces the whole row.\n'
        + 'Columns:\n' + questionList + '\n'
        + 'This only works on a row YOU added. A response the person filled in on the form themselves is '
        + 'theirs and cannot be changed here — if that is the situation, add a new row instead.',
      input_schema: { type: 'object', properties, required },
    });

    executors[updateName] = async (args) => {
      const { answers, errors } = coerceAnswers(fields, args);
      if (errors.length) return { ok: false, errors, note: 'Nothing was changed. Ask again for these, then call this once more with every column.' };

      const missing = missingRequired({ fields: askable, answers });
      if (missing.length) {
        return {
          ok: false,
          missing: missing.map(f => f.label),
          note: 'Nothing was changed — this replaces the whole row, so every required column must be included, even the ones that are not changing.',
        };
      }

      if (!live || !contactNumber || contactNumber === 'test') {
        return {
          ok: true, simulated: true, form: form.name,
          note: 'Test mode — nothing was changed.',
        };
      }

      const own = await findOwnSubmission({ formId: form.id, phone: contactNumber, agentId });
      if (!own) {
        return {
          ok: false,
          error: 'You have not added a row to this table for this person, so there is nothing to correct.',
          note: `Add one with save_to_${slug}_${row.id} instead.`,
        };
      }

      const res = await updateSubmission({ form, submissionId: own.id, answers, agentId, source: form.default_source || form.name });
      if (!res) {
        return { ok: false, error: 'That row could no longer be updated — it may have been deleted. Add a new one instead.' };
      }
      return {
        ok: true,
        form: form.name,
        submission_id: res.submissionId,
        lead_id: res.leadId,
        updated: true,
        note: 'The row was corrected. Confirm the change to the customer.',
      };
    };
  }

  return { tools, executors };
}

module.exports = { buildFormTools, coerceAnswers, propertyFor, isAskable, findRecentDuplicate, findOwnSubmission, DUPLICATE_WINDOW_MINUTES };
