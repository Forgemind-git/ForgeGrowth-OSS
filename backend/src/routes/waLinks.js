// Message Formats — labelled pre-filled WhatsApp openers + their tracking.
// (Was "Generate Link"; migration 093.)
//
// Answers on BOTH /message-formats (canonical) and /wa-links (the pre-093 path,
// kept so already-connected MCP clients and any integration do not 404). Same
// two-element-path-array trick as the products rename.
//
// One format -> many numbers. Each number gets its OWN slug because each is a
// different wa.me destination; a format-level rotate_slug additionally hands the
// numbers out in turn from a single link.
const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const mf = require('../services/messageFormats');

const router = Router();
const publicRouter = Router();

// Canonical path first; the legacy alias second. Express accepts an array.
const P = (suffix) => [`/message-formats${suffix}`, `/wa-links${suffix}`];

function normalizePhone(str) {
  return (str || '').replace(/\D/g, '');
}

// Slugs from both tables share one URL space (/l/<slug>), so a new one has to
// be unique across BOTH or a rotate link could shadow a per-number link.
async function generateSlug(client = pool) {
  for (let i = 0; i < 8; i++) {
    const slug = crypto.randomBytes(4).toString('hex');
    const { rows } = await client.query(
      `SELECT 1 FROM coexistence.wa_link_targets WHERE slug = $1
        UNION ALL
       SELECT 1 FROM coexistence.wa_links WHERE rotate_slug = $1
        LIMIT 1`,
      [slug]
    );
    if (!rows.length) return slug;
  }
  throw new Error('Could not allocate a unique link code');
}

function buildWaUrl(phone, message) {
  const clean = normalizePhone(phone);
  if (!clean) return null;
  const text = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${clean}${text}`;
}

function rowToFormat(r) {
  const targets = (r.targets || []).map(t => ({
    id: Number(t.id),
    waAccountId: t.wa_account_id == null ? null : Number(t.wa_account_id),
    accountName: t.account_name || null,
    phoneNumber: t.phone_number,
    slug: t.slug,
    waUrl: buildWaUrl(t.phone_number, r.message),
  }));
  return {
    id: Number(r.id),
    label: r.name,
    // `name` kept alongside `label` so the pre-093 API shape still reads.
    name: r.name,
    description: r.description || null,
    message: r.message,
    active: r.active !== false,
    rotateSlug: r.rotate_slug || null,
    targets,
    // No message => nothing to match an inbound reply against. The link still
    // works and clicks are still counted; only attribution is off.
    tracking: r.message && String(r.message).trim() ? 'on' : 'off',
    stats: {
      clicks: Number(r.clicks || 0),
      chats: Number(r.chats || 0),
      leads: Number(r.leads || 0),
      newLeads: Number(r.new_leads || 0),
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// One shape used by list + detail so the two can never disagree.
const SELECT_FORMAT = `
  SELECT l.id, l.name, l.description, l.message, l.active, l.rotate_slug,
         l.created_at, l.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', t.id, 'wa_account_id', t.wa_account_id,
                    'account_name', a.display_name,
                    'phone_number', t.phone_number, 'slug', t.slug)
                  ORDER BY t.sort_order, t.id)
             FROM coexistence.wa_link_targets t
             LEFT JOIN coexistence.whatsapp_accounts a ON a.id = t.wa_account_id
            WHERE t.format_id = l.id
         ), '[]') AS targets,
         (SELECT COUNT(*) FROM coexistence.wa_link_clicks c WHERE c.format_id = l.id) AS clicks,
         (SELECT COUNT(*) FROM coexistence.wa_link_hits h WHERE h.format_id = l.id) AS chats,
         (SELECT COUNT(DISTINCT h.lead_id) FROM coexistence.wa_link_hits h
           WHERE h.format_id = l.id AND h.lead_id IS NOT NULL) AS leads,
         (SELECT COUNT(*) FROM coexistence.wa_link_hits h
           WHERE h.format_id = l.id AND h.is_new_lead) AS new_leads
    FROM coexistence.wa_links l`;

// Resolve requested account ids -> [{waAccountId, phoneNumber}], rejecting any
// account that has no usable number (the link would be dead on arrival).
async function resolveTargets(accountIds) {
  const ids = [...new Set((accountIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return { error: 'Pick at least one WhatsApp number.' };
  const { rows } = await pool.query(
    `SELECT id, display_name, display_phone_number
       FROM coexistence.whatsapp_accounts WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  if (rows.length !== ids.length) return { error: 'One of the selected WhatsApp numbers no longer exists.' };
  // Deduped BY PHONE NUMBER, not by account id: two account rows can carry the
  // same display_phone_number, and wa_link_targets is unique on
  // (format_id, phone_number) — so without this the insert would trip a raw
  // 23505 and surface as an unexplained "Failed to create".
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const phone = normalizePhone(r.display_phone_number);
    if (!phone) return { error: `"${r.display_name || 'Account ' + r.id}" has no phone number set.` };
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push({ waAccountId: Number(r.id), phoneNumber: phone });
  }
  return { targets: out };
}

// The unique index on message_norm is what actually prevents two active formats
// owning one opener; this turns its 23505 into a sentence a person can act on.
function duplicateMessageError(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('wa_links_message_norm');
}
const DUPLICATE_MSG =
  'Another active format already uses this exact message. Two formats with the same opener cannot be told apart, so change the wording or deactivate the other one.';

// ── LIST ─────────────────────────────────────────────────────────────────────
router.get(P(''), async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_FORMAT} ORDER BY l.created_at DESC`);
    const formats = rows.map(rowToFormat);
    // `links` is the pre-093 key; kept as an alias pointing at the same array.
    res.json({ formats, links: formats });
  } catch (err) {
    console.error('[message-formats] list error:', err.message);
    res.status(500).json({ error: 'Failed to load message formats' });
  }
});

// ── DETAIL ───────────────────────────────────────────────────────────────────
router.get(P('/:id'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Message format not found' });
    const { rows } = await pool.query(`${SELECT_FORMAT} WHERE l.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Message format not found' });
    res.json({ format: rowToFormat(rows[0]), link: rowToFormat(rows[0]) });
  } catch (err) {
    console.error('[message-formats] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load the message format' });
  }
});

// ── CREATE ───────────────────────────────────────────────────────────────────
// Accepts the pre-093 body ({name, accountId}) as well as the new one
// ({label, accountIds, rotate}) so the MCP create_wa_link tool keeps working.
router.post(P(''), async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const label = String(b.label || b.name || '').trim();
    if (!label) return res.status(400).json({ error: 'Label is required' });

    const accountIds = Array.isArray(b.accountIds) && b.accountIds.length
      ? b.accountIds
      : (b.accountId ? [b.accountId] : []);
    const resolved = await resolveTargets(accountIds);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const message = b.message ? String(b.message).trim() : null;
    const description = b.description ? String(b.description).trim() : null;
    const wantRotate = b.rotate === true && resolved.targets.length > 1;

    await client.query('BEGIN');
    const rotateSlug = wantRotate ? await generateSlug(client) : null;
    const { rows } = await client.query(
      `INSERT INTO coexistence.wa_links (name, description, message, rotate_slug, created_at, updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW()) RETURNING id`,
      [label, description, message, rotateSlug]
    );
    const formatId = Number(rows[0].id);
    let sort = 0;
    for (const t of resolved.targets) {
      await client.query(
        `INSERT INTO coexistence.wa_link_targets (format_id, wa_account_id, phone_number, slug, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [formatId, t.waAccountId, t.phoneNumber, await generateSlug(client), sort++]
      );
    }
    await client.query('COMMIT');

    await mf.refreshMessageFormats();
    if (message) await mf.ensureFunnelSource(label);

    const { rows: full } = await pool.query(`${SELECT_FORMAT} WHERE l.id = $1`, [formatId]);
    const format = rowToFormat(full[0]);
    res.status(201).json({ format, link: format });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (duplicateMessageError(err)) return res.status(409).json({ error: DUPLICATE_MSG });
    console.error('[message-formats] create error:', err.message);
    res.status(500).json({ error: 'Failed to create the message format' });
  } finally {
    client.release();
  }
});

// ── UPDATE ───────────────────────────────────────────────────────────────────
router.put(P('/:id'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Message format not found' });
    const b = req.body || {};

    const { rows: cur } = await pool.query(
      `SELECT id, name, message, active, rotate_slug FROM coexistence.wa_links WHERE id = $1`, [id]
    );
    if (!cur.length) return res.status(404).json({ error: 'Message format not found' });
    const before = cur[0];

    const sets = [], vals = [];
    const label = b.label !== undefined ? b.label : b.name;
    if (label !== undefined) {
      const v = String(label || '').trim();
      if (!v) return res.status(400).json({ error: 'Label cannot be empty' });
      vals.push(v); sets.push(`name = $${vals.length}`);
    }
    if (b.description !== undefined) {
      vals.push(b.description ? String(b.description).trim() : null);
      sets.push(`description = $${vals.length}`);
    }
    if (b.message !== undefined) {
      vals.push(b.message ? String(b.message).trim() : null);
      sets.push(`message = $${vals.length}`);
    }
    if (b.active !== undefined) { vals.push(b.active === true); sets.push(`active = $${vals.length}`); }

    await client.query('BEGIN');

    if (sets.length) {
      sets.push('updated_at = NOW()');
      vals.push(id);
      await client.query(
        `UPDATE coexistence.wa_links SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals
      );
    }

    // Numbers: add the new ones, drop the removed ones. A number that STAYS
    // keeps its existing slug — regenerating it would silently kill a link
    // already printed on a video or a landing page.
    let removedTargets = 0;
    if (Array.isArray(b.accountIds)) {
      const resolved = await resolveTargets(b.accountIds);
      if (resolved.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: resolved.error }); }
      const wanted = new Map(resolved.targets.map(t => [t.phoneNumber, t]));
      const { rows: existing } = await client.query(
        `SELECT id, phone_number FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]
      );
      const have = new Set(existing.map(e => e.phone_number));
      const drop = existing.filter(e => !wanted.has(e.phone_number)).map(e => e.id);
      if (drop.length) {
        const r = await client.query(
          `DELETE FROM coexistence.wa_link_targets WHERE id = ANY($1::bigint[])`, [drop]
        );
        removedTargets = r.rowCount;
      }
      let sort = 0;
      for (const [phone, t] of wanted) {
        if (have.has(phone)) {
          await client.query(
            `UPDATE coexistence.wa_link_targets SET sort_order = $1, wa_account_id = $2
              WHERE format_id = $3 AND phone_number = $4`,
            [sort++, t.waAccountId, id, phone]
          );
        } else {
          await client.query(
            `INSERT INTO coexistence.wa_link_targets (format_id, wa_account_id, phone_number, slug, sort_order)
             VALUES ($1,$2,$3,$4,$5)`,
            [id, t.waAccountId, phone, await generateSlug(client), sort++]
          );
        }
      }
    }

    if (b.rotate !== undefined) {
      const { rows: n } = await client.query(
        `SELECT COUNT(*)::int AS c FROM coexistence.wa_link_targets WHERE format_id = $1`, [id]
      );
      if (b.rotate === true && n[0].c > 1) {
        if (!before.rotate_slug) {
          await client.query(`UPDATE coexistence.wa_links SET rotate_slug = $1 WHERE id = $2`,
            [await generateSlug(client), id]);
        }
      } else if (b.rotate === false) {
        await client.query(`UPDATE coexistence.wa_links SET rotate_slug = NULL WHERE id = $1`, [id]);
      }
    }

    await client.query('COMMIT');

    // Re-point the leads THIS format produced, then refresh the match cache.
    let renamedLeads = 0;
    const newLabel = label !== undefined ? String(label).trim() : before.name;
    if (newLabel !== before.name) {
      renamedLeads = await mf.renameFunnelSource(before.name, newLabel, id);
    } else if (b.message !== undefined && b.message) {
      await mf.ensureFunnelSource(newLabel);
    }
    await mf.refreshMessageFormats();

    const { rows: full } = await pool.query(`${SELECT_FORMAT} WHERE l.id = $1`, [id]);
    const format = rowToFormat(full[0]);
    res.json({ format, link: format, renamedLeads, removedTargets });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (duplicateMessageError(err)) return res.status(409).json({ error: DUPLICATE_MSG });
    console.error('[message-formats] update error:', err.message);
    res.status(500).json({ error: 'Failed to update the message format' });
  } finally {
    client.release();
  }
});

// ── DELETE ───────────────────────────────────────────────────────────────────
router.delete(P('/:id'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(`DELETE FROM coexistence.wa_links WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Message format not found' });
    await mf.refreshMessageFormats();
    res.json({ ok: true });
  } catch (err) {
    console.error('[message-formats] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete the message format' });
  }
});

// ── TRACKING ─────────────────────────────────────────────────────────────────
// Clicks and chats respect the date range; the per-number split and the recent
// leads come from the same window so the numbers on screen always add up.
router.get(P('/:id/stats'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'Message format not found' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = `${days} days`;

    const [totals, byNumber, series, recent] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM coexistence.wa_link_clicks c
             WHERE c.format_id = $1 AND c.clicked_at >= NOW() - $2::interval) AS clicks,
           (SELECT COUNT(*) FROM coexistence.wa_link_hits h
             WHERE h.format_id = $1 AND h.matched_at >= NOW() - $2::interval) AS chats,
           (SELECT COUNT(DISTINCT h.lead_id) FROM coexistence.wa_link_hits h
             WHERE h.format_id = $1 AND h.lead_id IS NOT NULL
               AND h.matched_at >= NOW() - $2::interval) AS leads,
           (SELECT COUNT(*) FROM coexistence.wa_link_hits h
             WHERE h.format_id = $1 AND h.is_new_lead
               AND h.matched_at >= NOW() - $2::interval) AS new_leads`,
        [id, since]
      ),
      pool.query(
        `SELECT t.id, t.phone_number, a.display_name,
                (SELECT COUNT(*) FROM coexistence.wa_link_clicks c
                  WHERE c.target_id = t.id AND c.clicked_at >= NOW() - $2::interval) AS clicks,
                (SELECT COUNT(*) FROM coexistence.wa_link_hits h
                  WHERE h.target_id = t.id AND h.matched_at >= NOW() - $2::interval) AS chats
           FROM coexistence.wa_link_targets t
           LEFT JOIN coexistence.whatsapp_accounts a ON a.id = t.wa_account_id
          WHERE t.format_id = $1
          ORDER BY t.sort_order, t.id`,
        [id, since]
      ),
      pool.query(
        `WITH d AS (
           SELECT generate_series(
                    (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') - ($2::interval - INTERVAL '1 day'))::date,
                    date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')::date,
                    INTERVAL '1 day')::date AS day
         )
         SELECT d.day,
                (SELECT COUNT(*) FROM coexistence.wa_link_clicks c
                  WHERE c.format_id = $1
                    AND (c.clicked_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS clicks,
                (SELECT COUNT(*) FROM coexistence.wa_link_hits h
                  WHERE h.format_id = $1
                    AND (h.matched_at AT TIME ZONE 'Asia/Kolkata')::date = d.day) AS chats
           FROM d ORDER BY d.day`,
        [id, since]
      ),
      pool.query(
        `SELECT h.matched_at, h.contact_number, h.wa_number, h.is_new_lead, h.match_kind,
                l.id AS lead_id, l.name AS lead_name, l.stage
           FROM coexistence.wa_link_hits h
           LEFT JOIN coexistence.leads l ON l.id = h.lead_id
          WHERE h.format_id = $1 AND h.matched_at >= NOW() - $2::interval
          ORDER BY h.matched_at DESC LIMIT 50`,
        [id, since]
      ),
    ]);

    const t = totals.rows[0];
    res.json({
      days,
      totals: {
        clicks: Number(t.clicks), chats: Number(t.chats),
        leads: Number(t.leads), newLeads: Number(t.new_leads),
      },
      byNumber: byNumber.rows.map(r => ({
        targetId: Number(r.id),
        phoneNumber: r.phone_number,
        accountName: r.display_name || null,
        clicks: Number(r.clicks),
        chats: Number(r.chats),
      })),
      series: series.rows.map(r => ({ day: r.day, clicks: Number(r.clicks), chats: Number(r.chats) })),
      recent: recent.rows.map(r => ({
        matchedAt: r.matched_at,
        contactNumber: r.contact_number,
        waNumber: r.wa_number,
        isNewLead: r.is_new_lead,
        matchKind: r.match_kind,
        leadId: r.lead_id == null ? null : Number(r.lead_id),
        leadName: r.lead_name || null,
        stage: r.stage || null,
      })),
    });
  } catch (err) {
    console.error('[message-formats] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load tracking' });
  }
});

// ── PUBLIC REDIRECT ──────────────────────────────────────────────────────────
// GET /l/:slug — the URL that actually gets shared. Resolves either a
// per-number slug or a format's rotating slug, records the tap, then hands off
// to WhatsApp.
//
// Deliberately still redirects for an INACTIVE format: someone may already have
// the link on a printed card or an old post, and a dead link is a worse outcome
// than an unattributed one. `active` governs matching and the UI, not this.
publicRouter.get('/l/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '');
    let target = null;
    let viaRotation = false;

    const direct = await pool.query(
      `SELECT t.id AS target_id, t.format_id, t.phone_number, l.message
         FROM coexistence.wa_link_targets t
         JOIN coexistence.wa_links l ON l.id = t.format_id
        WHERE t.slug = $1`,
      [slug]
    );
    if (direct.rows.length) {
      target = direct.rows[0];
    } else {
      // Rotation. The pointer is bumped in the SAME statement that reads it, so
      // two simultaneous clicks can never be handed the same number.
      const rot = await pool.query(
        `WITH f AS (
           UPDATE coexistence.wa_links SET rotate_pointer = rotate_pointer + 1
            WHERE rotate_slug = $1
            RETURNING id, message, rotate_pointer
         )
         SELECT f.id AS format_id, f.message, f.rotate_pointer,
                t.id AS target_id, t.phone_number
           FROM f JOIN coexistence.wa_link_targets t ON t.format_id = f.id
          ORDER BY t.sort_order, t.id`,
        [slug]
      );
      if (rot.rows.length) {
        const pointer = Number(rot.rows[0].rotate_pointer);
        target = rot.rows[(pointer - 1) % rot.rows.length];
        viaRotation = true;
      }
    }

    if (!target) return res.status(404).send('Link not found');

    const waUrl = buildWaUrl(target.phone_number, target.message || '');
    if (!waUrl) return res.status(404).send('Link not found');

    // Counting must never be able to break the redirect the customer is
    // mid-tap on, so it is fire-and-forget with its own catch.
    pool.query(
      `INSERT INTO coexistence.wa_link_clicks
         (format_id, target_id, slug, phone_number, via_rotation, user_agent, referer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [target.format_id, target.target_id, slug, target.phone_number, viaRotation,
       (req.get('user-agent') || '').slice(0, 500), (req.get('referer') || '').slice(0, 500)]
    ).catch(e => console.error('[message-formats] click log failed:', e.message));

    return res.redirect(302, waUrl);
  } catch (err) {
    console.error('[message-formats] redirect error:', err.message);
    res.status(500).send('Something went wrong');
  }
});

module.exports = { router, publicRouter };
