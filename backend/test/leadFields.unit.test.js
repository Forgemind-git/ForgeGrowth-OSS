const test = require('node:test');
const assert = require('node:assert');

const registry = require('../src/services/fieldRegistry');
const {
  WRITABLE_COLUMNS, writableLeadFields, isWritableLeadField, coerceValue,
} = require('../src/services/leadFields');

/**
 * The live registry, as it stands on the production instance. Includes the
 * `total_paid` row, whose `system_column` names a column that DOES NOT EXIST on
 * `leads` (the figure is computed from payments). That row is the whole reason
 * the writable set is a literal map in code rather than a read of
 * `entity_fields.system_column`.
 */
const LIVE_LEAD_FIELDS = [
  { fieldKey: 'name',             label: 'Name',          fieldType: 'text',     isSystem: true,  systemColumn: 'name' },
  { fieldKey: 'whatsapp_number',  label: 'WhatsApp',      fieldType: 'phone',    isSystem: true,  systemColumn: 'whatsapp_number' },
  { fieldKey: 'email',            label: 'Email',         fieldType: 'email',    isSystem: true,  systemColumn: 'email' },
  { fieldKey: 'age',              label: 'Age',           fieldType: 'number',   isSystem: true,  systemColumn: 'age' },
  { fieldKey: 'profession',       label: 'Profession',    fieldType: 'dropdown', isSystem: true,  systemColumn: 'profession', options: ['Student', 'Engineer', 'Other'] },
  { fieldKey: 'pincode',          label: 'Pincode',       fieldType: 'text',     isSystem: true,  systemColumn: 'pincode' },
  { fieldKey: 'city',             label: 'City',          fieldType: 'text',     isSystem: true,  systemColumn: 'city' },
  { fieldKey: 'source',           label: 'Source',        fieldType: 'dropdown', isSystem: true,  systemColumn: 'source' },
  { fieldKey: 'stage',            label: 'Stage',         fieldType: 'dropdown', isSystem: true,  systemColumn: 'stage' },
  { fieldKey: 'follow_up_count',  label: 'Follow-ups',    fieldType: 'number',   isSystem: true,  systemColumn: 'follow_up_count' },
  { fieldKey: 'assigned_to',      label: 'BDA',           fieldType: 'text',     isSystem: true,  systemColumn: 'assigned_user_id' },
  { fieldKey: 'paid_course',      label: 'Product',       fieldType: 'text',     isSystem: true,  systemColumn: 'paid_course' },
  { fieldKey: 'total_paid',       label: 'Total Paid',    fieldType: 'number',   isSystem: true,  systemColumn: 'total_paid' },
  { fieldKey: 'payment_date',     label: 'Payment Date',  fieldType: 'date',     isSystem: true,  systemColumn: 'payment_date' },
  { fieldKey: 'created_at',       label: 'Arrived',       fieldType: 'date',     isSystem: true,  systemColumn: 'created_at' },
  { fieldKey: 'last_activity_at', label: 'Last Activity', fieldType: 'date',     isSystem: true,  systemColumn: 'last_activity_at' },
  { fieldKey: 'batch_date',       label: 'Batch Date',    fieldType: 'date',     isSystem: false, systemColumn: null },
  { fieldKey: 'profession_2',     label: 'Profession',    fieldType: 'text',     isSystem: false, systemColumn: null },
];

test.beforeEach(() => registry._setFieldsForTests({ lead: LIVE_LEAD_FIELDS }));

test('the columns an automation may write are a fixed map, not read from the registry', () => {
  // `total_paid` is in the registry with a system_column that does not exist as
  // a column. If the writable set were ever derived from `system_column`, this
  // is the row that would produce a broken UPDATE.
  assert.ok(!Object.prototype.hasOwnProperty.call(WRITABLE_COLUMNS, 'total_paid'));
  for (const col of Object.values(WRITABLE_COLUMNS)) {
    assert.match(col, /^[a-z_]+$/, `"${col}" must be a bare identifier — it is interpolated into SQL`);
  }
});

test('engine-owned and identity fields are not writable', () => {
  // Each has a specific reason, all of them "something else already owns this":
  //   whatsapp_number = identity, stage = Set Funnel Stage + its lead_events row,
  //   source = attribution set once at creation, assigned_to = Assign to BDA,
  //   the rest are counters and timestamps the engine maintains.
  for (const locked of ['whatsapp_number', 'stage', 'source', 'assigned_to',
                        'follow_up_count', 'total_paid', 'payment_date',
                        'created_at', 'last_activity_at']) {
    assert.ok(!isWritableLeadField(locked), `${locked} must not be writable from an automation`);
  }
});

test('profile fields and every custom field are writable', () => {
  for (const open of ['name', 'email', 'city', 'age', 'profession', 'pincode', 'paid_course']) {
    assert.ok(isWritableLeadField(open), `${open} should be writable`);
  }
  // Custom fields are admin-created and owned by nobody else, so all of them
  // are writable without needing an entry in the map.
  assert.ok(isWritableLeadField('batch_date'));
  assert.ok(isWritableLeadField('profession_2'));
});

test('the picker carries live labels, types and options', () => {
  const prof = writableLeadFields().find(f => f.fieldKey === 'profession');
  assert.strictEqual(prof.label, 'Profession');
  assert.deepStrictEqual(prof.options, ['Student', 'Engineer', 'Other']);
  // A renamed field must show its new label, which is exactly why the registry
  // is still the source of labels even though it is not the source of columns.
  registry._setFieldsForTests({
    lead: LIVE_LEAD_FIELDS.map(f => f.fieldKey === 'city' ? { ...f, label: 'Town' } : f),
  });
  assert.strictEqual(writableLeadFields().find(f => f.fieldKey === 'city').label, 'Town');
});

test('a number field refuses a word rather than storing nothing', () => {
  const age = LIVE_LEAD_FIELDS.find(f => f.fieldKey === 'age');
  // "we stored your age as nothing" is worse than saying the answer was not a
  // number — the operator can then see it in the execution log and ask again.
  const bad = coerceValue(age, 'twenty five');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /not a number/);

  assert.deepStrictEqual(coerceValue(age, ' 25 '), { ok: true, value: 25 });
  // age is an INT column, so a decimal must not reach it.
  assert.strictEqual(coerceValue(age, '25.7').value, 26);
});

test('a date field refuses a non-date and normalises to a plain date', () => {
  const d = LIVE_LEAD_FIELDS.find(f => f.fieldKey === 'batch_date');
  assert.strictEqual(coerceValue(d, 'next tuesday').ok, false);
  assert.strictEqual(coerceValue(d, '2026-09-01').value, '2026-09-01');
});

test('a dropdown answer off the list is stored AND flagged, never dropped', () => {
  const prof = LIVE_LEAD_FIELDS.find(f => f.fieldKey === 'profession');
  // Matching is case-insensitive but stores the CONFIGURED spelling, so the
  // Sales Log filter can still select it.
  assert.strictEqual(coerceValue(prof, 'engineer').value, 'Engineer');
  assert.strictEqual(coerceValue(prof, 'engineer').note, undefined);

  const off = coerceValue(prof, 'Chef');
  assert.strictEqual(off.ok, true, 'the answer must not be thrown away');
  assert.strictEqual(off.value, 'Chef');
  assert.match(off.note, /not one of the configured/);
});

test('an empty answer stores null, and is not an error', () => {
  const city = LIVE_LEAD_FIELDS.find(f => f.fieldKey === 'city');
  assert.deepStrictEqual(coerceValue(city, '   '), { ok: true, value: null });
  assert.deepStrictEqual(coerceValue(city, null), { ok: true, value: null });
});
