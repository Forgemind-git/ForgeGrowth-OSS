// Find-or-create a lead from a row of typed-in profile data.
//
// Used by the sheet import (POST /leads/import). It was the shared core of the
// removed Forms feature; it lives on here because the import still needs
// exactly this rule set.
//
// Matched on the last 10 digits of the phone (the same person is stored as
// 9876543210 / +919876543210 / 91… across the systems that feed this table).
// Every existing-lead write is COALESCE'd, so an import can FILL a blank field
// but never overwrite something a human already set. `custom_fields` is merged
// IN SQL (`|| $::jsonb`), never read-modify-written.

const pool = require('../db');
const cfg = require('./funnelConfig');

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

module.exports = { upsertLeadFromSubmission };
