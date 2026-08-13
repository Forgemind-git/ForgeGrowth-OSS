// Writing a single field onto a LEAD from an automation.
//
// WHY THIS EXISTS
// ---------------
// An "Ask a question" step parks the flow until the customer answers, and the
// answer then reached nothing: it lived in the execution log and nowhere else.
// The action that used to store an answer wrote to `contacts.custom_fields`,
// which was removed on 2026-08-11 along with contact custom fields. The lead is
// now the record of a person, so this writes there.
//
// ⚠ THE COLUMN LIST IS A LITERAL MAP, NOT `entity_fields.system_column`.
// That column is admin-editable text and is already wrong for at least one row:
// the `total_paid` field names a `total_paid` column that does not exist (the
// figure is computed from payments). Interpolating it into SQL would be both a
// broken write and a place where admin-entered text reaches a query. The
// registry is still the source of LABELS, TYPES and OPTIONS — it just does not
// get to name the target column.
//
// Custom fields live in the `leads.custom_fields` JSONB bag, keyed by
// `field_key`, exactly as lead forms and the sheet importer write them.

const registry = require('./fieldRegistry');

/**
 * System lead columns an automation may write, keyed by registry `field_key`.
 *
 * Everything omitted here is omitted on purpose:
 *   • `whatsapp_number` — the identity key. It is UNIQUE, it is how the funnel,
 *     the WhatsApp thread and the stage-tag mirror find this person, and
 *     rewriting it from a chat answer would re-point or collide the record.
 *   • `stage` — has its own action (Set Funnel Stage), which also writes the
 *     `lead_events` row that the stage-tag
 *     dispatchers all read. A raw write here would move the lead and starve
 *     every one of them.
 *   • `source` — attribution, derived once at lead creation from the CTWA
 *     referral or the message format. Overwriting it silently rewrites history
 *     in the ads and lead-source reports.
 *   • `assigned_to` — has its own action (Assign to BDA), which also syncs the
 *     contact row and emits the SSE the assignee's open tab listens for.
 *   • `follow_up_count`, `total_paid`, `payment_date`, `created_at`,
 *     `last_activity_at` — engine-owned counters and timestamps. A typed answer
 *     is not one of these.
 */
const WRITABLE_COLUMNS = {
  name: 'name',
  email: 'email',
  city: 'city',
  age: 'age',
  profession: 'profession',
  pincode: 'pincode',
  paid_course: 'paid_course',
};

/** Registry fields an automation may target, live labels and options included. */
function writableLeadFields() {
  return registry.fields('lead')
    .filter(f => (f.isSystem ? Object.prototype.hasOwnProperty.call(WRITABLE_COLUMNS, f.fieldKey) : true))
    .map(f => ({
      fieldKey: f.fieldKey,
      label: f.label,
      fieldType: f.fieldType,
      options: f.options,
      isSystem: f.isSystem,
    }));
}

function isWritableLeadField(key) {
  return writableLeadFields().some(f => f.fieldKey === key);
}

/**
 * Coerce a typed answer to what the column can hold.
 *
 * Returns `{ ok, value, note }`. A value that cannot be coerced is an ERROR,
 * never a silent null — "we stored your age as nothing" is worse than saying
 * the answer was not a number.
 */
function coerceValue(field, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, value: null };

  if (field.fieldType === 'number') {
    // `age` is an INT column. A decimal or a word must not reach it.
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, error: `"${s}" is not a number, so it cannot go in ${field.label}.` };
    return { ok: true, value: field.fieldKey === 'age' ? Math.round(n) : n };
  }

  if (field.fieldType === 'date') {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return { ok: false, error: `"${s}" is not a date, so it cannot go in ${field.label}.` };
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }

  // A dropdown answer that is not one of the options is STORED, with a note.
  // Rejecting it would throw away what the customer actually said; storing it
  // silently would leave a value the Sales Log filter cannot select. Say so.
  if (field.fieldType === 'dropdown' && Array.isArray(field.options) && field.options.length) {
    const hit = field.options.find(o => String(o).toLowerCase() === s.toLowerCase());
    if (hit) return { ok: true, value: hit };
    return { ok: true, value: s, note: `"${s}" is not one of the configured ${field.label} options, so it was stored as typed.` };
  }

  return { ok: true, value: s };
}

/**
 * Write one field onto the lead behind a WhatsApp contact number.
 *
 * Matches on the LAST 10 DIGITS, like every other lead lookup in this app
 * (Sales Log, Razorpay attribution, the agent funnel gate) — the same person is
 * stored as 9876543210 here and 919876543210 there.
 *
 * Deliberately does NOT create a lead: `webhook.js` already upserts one for
 * every inbound customer, so "no lead" means the number never messaged us and
 * inventing a record from an automation would be a second, competing creation
 * path with no source attribution.
 *
 * No `lead_events` row is written. That table's `event_type` CHECK does not
 * admit a field change, and — more to the point — it has no column to name
 * WHICH field changed, so the row would be lossy. The execution step this
 * returns into records field, old value and new value exactly.
 */
async function applyLeadField(client, { contactNumber, fieldKey, value }) {
  const last10 = String(contactNumber || '').replace(/\D/g, '').slice(-10);
  if (last10.length < 10) return { status: 'error', error: 'No usable contact number on this conversation.' };

  const field = writableLeadFields().find(f => f.fieldKey === fieldKey);
  if (!field) {
    // A field that was deleted or locked after this step was configured. Say
    // which one, rather than writing nothing and reporting success.
    return { status: 'error', error: `"${fieldKey}" is not a field an automation can write.` };
  }

  const coerced = coerceValue(field, value);
  if (!coerced.ok) return { status: 'error', error: coerced.error };

  const { rows: lr } = await client.query(
    `SELECT id, name, custom_fields FROM coexistence.leads
      WHERE right(regexp_replace(whatsapp_number, '\\D', '', 'g'), 10) = $1
      ORDER BY id LIMIT 1`,
    [last10]
  );
  if (lr.length === 0) return { status: 'skipped', note: 'No lead exists for this contact yet.' };
  const leadId = lr[0].id;

  let previous = null;
  if (field.isSystem) {
    const col = WRITABLE_COLUMNS[field.fieldKey];
    // `col` comes from the literal map above, never from user or admin input,
    // which is what makes this identifier interpolation safe. The VALUE is
    // always bound.
    const { rows } = await client.query(
      `UPDATE coexistence.leads l
          SET ${col} = $2, updated_at = NOW()
         FROM (SELECT id, ${col}::text AS old_value FROM coexistence.leads WHERE id = $1) o
        WHERE l.id = o.id
        RETURNING o.old_value`,
      [leadId, coerced.value]
    );
    previous = rows.length ? rows[0].old_value : null;
  } else {
    // The previous value comes from the row we already read. A sub-SELECT on
    // the same table inside RETURNING would be reading the statement's own
    // snapshot — correct today, but far too subtle to leave for the next
    // person to reason about.
    const bag = lr[0].custom_fields;
    previous = (bag && !Array.isArray(bag) && typeof bag === 'object' && bag[field.fieldKey] != null)
      ? String(bag[field.fieldKey]) : null;
    // ⚠ Merge IN SQL, never read-modify-write: two automations answering at
    // once would otherwise each write a bag built from the state they read,
    // and the later write would drop the earlier field. `- key` first so
    // re-answering REPLACES rather than duplicating.
    //
    // COALESCE also repairs the array-shaped bag that anti-pattern #42
    // describes: `'[]'::jsonb - 'key'` errors rather than corrupting further,
    // and a null bag starts clean.
    await client.query(
      `UPDATE coexistence.leads
          SET custom_fields = (COALESCE(custom_fields, '{}'::jsonb) - $2::text)
                              || jsonb_build_object($2::text, $3::text),
              updated_at = NOW()
        WHERE id = $1`,
      [leadId, field.fieldKey, coerced.value == null ? null : String(coerced.value)]
    );
  }

  return {
    status: 'applied',
    leadId,
    field: field.fieldKey,
    fieldLabel: field.label,
    from: previous,
    to: coerced.value,
    ...(coerced.note ? { note: coerced.note } : {}),
  };
}

module.exports = {
  WRITABLE_COLUMNS,
  writableLeadFields,
  isWritableLeadField,
  coerceValue,
  applyLeadField,
};
