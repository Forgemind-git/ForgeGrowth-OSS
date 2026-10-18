const socialEnv = require('./env');
// /api/crm — ManyChat-style contact management for Instagram contacts.
//   - Custom fields: typed definitions (contact_field_defs) + per-contact values
//     (ig_contact_fields, shared with the Flow Builder engine).
//   - System fields: computed from contacts / instagram_messages / instagram_users,
//     plus Instagram profile flags (follows you, verified, follower count) fetched
//     on demand through the rate-gated Graph call (refresh).
//   - Segments: saved filter sets. Bulk actions: tag / field / delete.
//   - Profile: everything about one contact incl. automation history + leads.
// Mounted after authMiddleware; definitions/segments/delete are admin-only,
// tagging and field values are user-allowed (same rule as /api/contacts/:id/tags).
const express = require('express');
const pool = require('./db');
const { adminOnly } = require('./auth');
const fetch = require('./rateLimiter').gatedFetch;

const router = express.Router();
const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'email', 'phone', 'url'];
const WINDOW_MS = 24 * 3600 * 1000;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await require('./services/flowEngine').ensureSchema();   // ig_contact_fields lives there
      await pool.query(`
        CREATE TABLE IF NOT EXISTS contact_field_defs (
          key         text PRIMARY KEY,
          name        text NOT NULL,
          type        text NOT NULL DEFAULT 'text',
          description text,
          folder      text,
          archived    boolean NOT NULL DEFAULT false,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS contact_segments (
          id          serial PRIMARY KEY,
          name        text NOT NULL,
          filter      jsonb NOT NULL DEFAULT '{}',
          created_at  timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS follows_business boolean;
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS business_follows boolean;
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_verified boolean;
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS follower_count int;
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_refreshed_at timestamptz;
        CREATE INDEX IF NOT EXISTS idx_ig_messages_peer ON instagram_messages (account_id, sender_id, ts DESC);
        -- Fields saved by automations before definitions existed become text fields.
        INSERT INTO contact_field_defs (key, name, type)
          SELECT DISTINCT key, initcap(replace(key, '_', ' ')), 'text' FROM ig_contact_fields
          ON CONFLICT (key) DO NOTHING;
      `);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

const wrap = fn => async (req, res) => {
  try { await ensureSchema(); res.json(await fn(req, res)); }
  catch (err) {
    const bad = /required|must be|not found|invalid|exists|at most|archive the field/i.test(err.message);
    if (!bad) console.error('[crm]', err.message);
    res.status(bad ? 400 : 500).json({ error: err.message });
  }
};

// Contacts from hidden / identity-less IG accounts never show (same rule as /api/contacts).
const VISIBLE = `c.platform = 'instagram' AND c.account_id NOT IN (SELECT account_id FROM instagram_accounts WHERE COALESCE(hidden,false) OR (name IS NULL AND username IS NULL))`;

// ── list (everything the filter builder needs, in one go) ───
router.get('/contacts', wrap(async (req) => {
  const params = [];
  let where = VISIBLE;
  if (req.query.account) { params.push(req.query.account); where += ` AND c.account_id = $${params.length}`; }
  const { rows } = await pool.query(`
    WITH inbound AS (
      SELECT account_id, sender_id, MAX(ts) AS last_in
        FROM instagram_messages WHERE direction = 'incoming' GROUP BY account_id, sender_id
    ), firstmsg AS (   -- contacts.first_seen_at can be reset by re-syncs; the first message is the real "subscribed" date
      SELECT account_id, CASE WHEN direction = 'incoming' THEN sender_id ELSE recipient_id END AS peer, MIN(ts) AS first_ts
        FROM instagram_messages GROUP BY 1, 2
    ), fields AS (
      SELECT account_id, peer_id, jsonb_object_agg(key, value) AS f FROM ig_contact_fields GROUP BY account_id, peer_id
    )
    SELECT c.id, c.account_id AS "accountId", c.peer_id AS "peerId", c.name, c.username, c.profile_pic AS "profilePic",
           c.tags, LEAST(c.first_seen_at, fm.first_ts) AS "subscribedAt", c.last_seen_at AS "lastSeenAt", c.message_count AS "messageCount",
           c.follows_business AS "followsYou", c.is_verified AS "verified", c.follower_count AS "followerCount",
           i.last_in AS "lastInteractionAt", COALESCE(f.f, '{}'::jsonb) AS fields,
           a.username AS "accountUsername", a.name AS "accountName"
      FROM contacts c
      LEFT JOIN inbound i ON i.account_id = c.account_id AND i.sender_id = c.peer_id
      LEFT JOIN firstmsg fm ON fm.account_id = c.account_id AND fm.peer = c.peer_id
      LEFT JOIN fields f ON f.account_id = c.account_id AND f.peer_id = c.peer_id
      LEFT JOIN instagram_accounts a ON a.account_id = c.account_id
     WHERE ${where}
     ORDER BY COALESCE(i.last_in, c.last_seen_at) DESC NULLS LAST, c.id DESC
     LIMIT 20000`, params);
  const now = Date.now();
  for (const r of rows) r.windowOpen = !!r.lastInteractionAt && now - new Date(r.lastInteractionAt).getTime() < WINDOW_MS;
  return { contacts: rows };
}));

// ── profile ─────────────────────────────────────────────────
async function getContactRow(id) {
  const { rows } = await pool.query(
    `SELECT c.*, a.username AS account_username, a.name AS account_name FROM contacts c
       LEFT JOIN instagram_accounts a ON a.account_id = c.account_id WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new Error('contact not found');
  return rows[0];
}

router.get('/contacts/:id/profile', wrap(async (req) => {
  const c = await getContactRow(Number(req.params.id));
  const [{ rows: [m] }, { rows: fields }, { rows: defs }, { rows: runs }, { rows: logs }, { rows: leads }] = await Promise.all([
    pool.query(
      `SELECT MAX(ts) FILTER (WHERE direction = 'incoming') AS last_in, MIN(ts) AS first_ts,
              (ARRAY_AGG(text ORDER BY ts DESC) FILTER (WHERE direction = 'incoming' AND COALESCE(text,'') <> ''))[1] AS last_text,
              MAX(seen_at) FILTER (WHERE direction = 'outgoing') AS last_seen,
              COUNT(*) FILTER (WHERE direction = 'incoming')::int AS n_in,
              COUNT(*) FILTER (WHERE direction = 'outgoing')::int AS n_out
         FROM instagram_messages WHERE account_id = $1 AND (sender_id = $2 OR recipient_id = $2)`, [c.account_id, c.peer_id]),
    pool.query('SELECT key, value, updated_at FROM ig_contact_fields WHERE account_id = $1 AND peer_id = $2', [c.account_id, c.peer_id]),
    pool.query('SELECT * FROM contact_field_defs ORDER BY lower(name)'),
    pool.query(
      `SELECT r.id, r.flow_id, f.name AS automation, r.trigger, r.status, r.error, r.created_at, r.updated_at
         FROM ig_flow_runs r LEFT JOIN ig_flows f ON f.id = r.flow_id
        WHERE r.account_id = $1 AND r.peer_id = $2 ORDER BY r.created_at DESC LIMIT 30`, [c.account_id, c.peer_id]).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT l.id, l.rule_id, r.name AS automation, l.trigger, l.status, l.error, l.input_text, l.created_at
         FROM ig_automation_log l LEFT JOIN ig_automation_rules r ON r.id = l.rule_id
        WHERE l.account_id = $1 AND l.user_id = $2 ORDER BY l.created_at DESC LIMIT 30`, [c.account_id, c.peer_id]).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT d.id, d.data, d.created_at, r.name AS automation FROM ig_automation_leads d
         LEFT JOIN ig_automation_rules r ON r.id = d.rule_id WHERE d.account_id = $1 AND d.peer_id = $2 ORDER BY d.created_at DESC`, [c.account_id, c.peer_id]).catch(() => ({ rows: [] })),
  ]);
  const val = Object.fromEntries(fields.map(f => [f.key, f.value]));
  const name = c.name || '';
  const [first, ...rest] = name.trim().split(/\s+/);
  const lastIn = m?.last_in || null;
  const subscribed = [c.first_seen_at, m?.first_ts].filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
  const windowLeftMs = lastIn ? WINDOW_MS - (Date.now() - new Date(lastIn).getTime()) : -1;
  const system = [
    { key: 'contact_id', label: 'Contact ID', value: String(c.id) },
    { key: 'ig_user_id', label: 'Instagram user ID', value: c.peer_id },
    { key: 'first_name', label: 'First name', value: first || null },
    { key: 'last_name', label: 'Last name', value: rest.join(' ') || null },
    { key: 'full_name', label: 'Full name', value: name || null },
    { key: 'username', label: 'Instagram username', value: c.username ? '@' + c.username : null },
    { key: 'email', label: 'Email', value: val.email || null },
    { key: 'phone', label: 'Phone', value: val.phone || null },
    { key: 'subscribed', label: 'Subscribed', value: subscribed, type: 'date' },
    { key: 'last_interaction', label: 'Last interaction in Instagram', value: lastIn, type: 'date' },
    { key: 'last_seen', label: 'Last seen in Instagram', value: m?.last_seen || null, type: 'date' },
    { key: 'window', label: 'Messaging window', value: windowLeftMs > 0 ? `Open · ${Math.max(1, Math.round(windowLeftMs / 3600000))}h left` : 'Closed', state: windowLeftMs > 0 ? 'on' : 'off' },
    { key: 'last_text', label: 'Last text input', value: m?.last_text || null },
    { key: 'follows_you', label: 'Follows your Instagram account', value: c.follows_business == null ? null : c.follows_business ? 'Yes' : 'No', state: c.follows_business == null ? null : c.follows_business ? 'on' : 'off' },
    { key: 'business_follows', label: 'Your account follows them', value: c.business_follows == null ? null : c.business_follows ? 'Yes' : 'No' },
    { key: 'verified', label: 'Verified on Instagram', value: c.is_verified == null ? null : c.is_verified ? 'Yes' : 'No' },
    { key: 'follower_count', label: 'Their follower count', value: c.follower_count == null ? null : Number(c.follower_count).toLocaleString('en-IN') },
    { key: 'page', label: 'Instagram page', value: c.account_username ? '@' + c.account_username : c.account_id },
    { key: 'messages', label: 'Messages', value: `${m?.n_in || 0} received · ${m?.n_out || 0} sent` },
  ];
  const custom = defs.filter(d => !d.archived || val[d.key] != null)
    .map(d => ({ key: d.key, name: d.name, type: d.type, archived: d.archived, value: val[d.key] ?? null, updatedAt: fields.find(f => f.key === d.key)?.updated_at || null }));
  const activity = [
    ...runs.map(r => ({ kind: 'flow', id: 'f' + r.id, automation: r.automation || 'Deleted automation', trigger: r.trigger, status: r.status, error: r.error, at: r.created_at })),
    ...logs.filter(l => l.trigger !== 'gate').map(l => ({ kind: 'quick', id: 'q' + l.id, automation: l.automation || 'Deleted automation', trigger: l.trigger, status: l.status, error: l.error, input: l.input_text, at: l.created_at })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 40);
  return {
    contact: {
      id: c.id, accountId: c.account_id, peerId: c.peer_id, name: c.name, username: c.username, profilePic: c.profile_pic,
      notes: c.notes, tags: c.tags || [], accountUsername: c.account_username, accountName: c.account_name,
      subscribedAt: subscribed, lastInteractionAt: lastIn, windowOpen: windowLeftMs > 0, profileRefreshedAt: c.profile_refreshed_at,
      messageCount: c.message_count,
    },
    system, custom, activity, leads,
  };
}));

// The conversation with this contact, oldest first — what the profile's chat
// drawer shows. Newest 300 messages; replying goes through the same
// /instagram/reply endpoint the Inbox uses.
router.get('/contacts/:id/messages', wrap(async (req) => {
  const c = await getContactRow(Number(req.params.id));
  const { rows } = await pool.query(
    `SELECT id, mid, direction, text, attachments, ts, seen, seen_at FROM (
       SELECT id, mid, direction, text, attachments, ts, seen, seen_at FROM instagram_messages
        WHERE account_id = $1 AND (sender_id = $2 OR recipient_id = $2)
        ORDER BY ts DESC NULLS LAST, id DESC LIMIT 300) m
      ORDER BY ts ASC NULLS FIRST, id ASC`, [c.account_id, c.peer_id]);
  const lastIn = rows.filter(r => r.direction === 'incoming').map(r => r.ts).filter(Boolean).pop() || null;
  return {
    accountId: c.account_id, peerId: c.peer_id,
    windowOpen: !!lastIn && Date.now() - new Date(lastIn).getTime() < WINDOW_MS,
    messages: rows.map(r => ({ id: r.id, mid: r.mid, direction: r.direction, text: r.text, attachments: r.attachments || [], ts: r.ts, seen: !!r.seen, seenAt: r.seen_at })),
  };
}));

// Refresh Instagram profile flags (1 rate-gated Graph call; consent-gated by Meta —
// works once the person has messaged the account). Shared by the profile button
// and the background follow-status sweep.
async function checkProfile(c) {
  const auth = await require('./instagram').getAccountAuth(c.account_id);
  const url = new URL(`${auth.base}/${c.peer_id}`);
  url.searchParams.set('fields', 'name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user');
  url.searchParams.set('access_token', auth.token);
  const d = await (await fetch(url)).json();
  if (d.error) {
    // Remember the attempt so the sweep doesn't retry for a week.
    await pool.query('UPDATE contacts SET profile_refreshed_at = now() WHERE id = $1', [c.id]);
    throw new Error(`Instagram didn't return this profile (${d.error.message}). It works once they've messaged you.`);
  }
  await pool.query(
    `UPDATE contacts SET name = COALESCE(name, $2), username = COALESCE($3, username), profile_pic = COALESCE($4, profile_pic),
            follower_count = $5, follows_business = $6, business_follows = $7, is_verified = $8, profile_refreshed_at = now()
      WHERE id = $1`,
    [c.id, d.name || null, d.username || null, d.profile_pic || null, d.follower_count ?? null,
     d.is_user_follow_business ?? null, d.is_business_follow_user ?? null, d.is_verified_user ?? null]);
  return d;
}

router.post('/contacts/:id/refresh', wrap(async (req) => {
  await checkProfile(await getContactRow(Number(req.params.id)));
  return { ok: true };
}));

// ── Follow-status sweep ─────────────────────────────────────
// Every 5 min, check a few contacts per account who have messaged us (Meta only
// returns the profile with their consent): never-checked first, newest
// conversations first, then re-check anyone older than 7 days. Max ~36 calls/hr
// per token out of the 180 the limiter allows, and it stops the moment the
// limiter says the budget is spent.
const SWEEP_PER_ACCOUNT = Number(socialEnv.FOLLOW_SWEEP_PER_ACCOUNT || 3);
const SWEEP_RESERVE = Number(socialEnv.FOLLOW_SWEEP_RESERVE || 60);   // calls/hour kept free for people-facing work
let sweeping = false;
async function followSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await ensureSchema();
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT c.id, c.account_id, c.peer_id, c.profile_refreshed_at, c.last_seen_at,
               row_number() OVER (PARTITION BY c.account_id
                 ORDER BY (c.profile_refreshed_at IS NULL) DESC, c.last_seen_at DESC NULLS LAST) AS rn
          FROM contacts c
         WHERE ${VISIBLE}
           AND (c.profile_refreshed_at IS NULL OR c.profile_refreshed_at < now() - interval '7 days')
           AND EXISTS (SELECT 1 FROM instagram_messages m WHERE m.account_id = c.account_id AND m.sender_id = c.peer_id AND m.direction = 'incoming')
      ) x WHERE rn <= $1`, [SWEEP_PER_ACCOUNT]);
    const dead = new Set();
    for (const c of rows) {
      if (dead.has(c.account_id)) continue;
      // Optional background work: only spend calls while the token keeps a
      // reserve of SWEEP_RESERVE for replies, automations and the Inbox.
      try {
        const auth = await require('./instagram').getAccountAuth(c.account_id);
        const u = new URL(`${auth.base}/me`); u.searchParams.set('access_token', auth.token);
        const free = await require('./rateLimiter').headroom(u);
        if (free != null && free < SWEEP_RESERVE) { dead.add(c.account_id); continue; }
      } catch (_) { dead.add(c.account_id); continue; }
      try { await checkProfile(c); }
      catch (e) {
        if (/RATE_LIMITED|rate/i.test(e.message) || /No auth/.test(e.message)) dead.add(c.account_id);
      }
    }
  } catch (e) { console.error('[crm] follow sweep:', e.message); }
  finally { sweeping = false; }
}
function startFollowSweep() {
  setTimeout(followSweep, 60 * 1000);
  setInterval(followSweep, 5 * 60 * 1000);
}

// Set / clear one custom field value.
router.put('/contacts/:id/fields', wrap(async (req) => {
  const c = await getContactRow(Number(req.params.id));
  const key = slug(req.body?.key);
  if (!key) throw new Error('key is required');
  const { rows: [def] } = await pool.query('SELECT * FROM contact_field_defs WHERE key = $1', [key]);
  if (!def) throw new Error('field not found — create it first');
  const v = req.body?.value;
  if (v == null || v === '') {
    await pool.query('DELETE FROM ig_contact_fields WHERE account_id = $1 AND peer_id = $2 AND key = $3', [c.account_id, c.peer_id, key]);
    return { ok: true, cleared: true };
  }
  const value = checkValue(def.type, v);
  await pool.query(
    `INSERT INTO ig_contact_fields (account_id, peer_id, key, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id, peer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [c.account_id, c.peer_id, key, value]);
  return { ok: true, value };
}));

function checkValue(type, raw) {
  const s = String(raw).trim().slice(0, 2000);
  if (type === 'number' && isNaN(Number(s))) throw new Error('value must be a number');
  if (type === 'boolean') return /^(true|yes|1)$/i.test(s) ? 'true' : 'false';
  if (type === 'date' && isNaN(Date.parse(s))) throw new Error('value must be a date');
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new Error('value must be an email');
  return s;
}

// ── bulk actions ────────────────────────────────────────────
router.post('/contacts/bulk', wrap(async (req) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 5000);
  const action = req.body?.action;
  if (!ids.length) throw new Error('ids are required');
  if (action === 'add_tag' || action === 'remove_tag') {
    const tags = (req.body.tags || []).map(String).filter(Boolean);
    if (!tags.length) throw new Error('tags are required');
    const sql = action === 'add_tag'
      ? `UPDATE contacts SET tags = (SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb) || $2::jsonb) t) WHERE id = ANY($1::bigint[])`
      : `UPDATE contacts SET tags = (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(tags,'[]'::jsonb)) t WHERE NOT (t = ANY($2::text[]))) WHERE id = ANY($1::bigint[])`;
    const { rowCount } = await pool.query(sql, [ids, action === 'add_tag' ? JSON.stringify(tags) : tags]);
    return { updated: rowCount };
  }
  if (action === 'set_field' || action === 'clear_field') {
    const key = slug(req.body.key);
    const { rows: [def] } = await pool.query('SELECT * FROM contact_field_defs WHERE key = $1', [key]);
    if (!def) throw new Error('field not found');
    if (action === 'clear_field') {
      const { rowCount } = await pool.query(
        `DELETE FROM ig_contact_fields f USING contacts c WHERE c.id = ANY($1::bigint[]) AND f.account_id = c.account_id AND f.peer_id = c.peer_id AND f.key = $2`, [ids, key]);
      return { updated: rowCount };
    }
    const value = checkValue(def.type, req.body.value ?? '');
    const { rowCount } = await pool.query(
      `INSERT INTO ig_contact_fields (account_id, peer_id, key, value)
         SELECT account_id, peer_id, $2, $3 FROM contacts WHERE id = ANY($1::bigint[])
       ON CONFLICT (account_id, peer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ids, key, value]);
    return { updated: rowCount };
  }
  if (action === 'delete') {
    if (req.user?.role !== 'admin') throw new Error('only admins can delete contacts — invalid role');
    const { rowCount } = await pool.query('DELETE FROM contacts WHERE id = ANY($1::bigint[])', [ids]);
    return { deleted: rowCount };
  }
  throw new Error('action must be add_tag, remove_tag, set_field, clear_field or delete');
}));

// ── custom field definitions ────────────────────────────────
router.get('/fields', wrap(async () => {
  const { rows } = await pool.query(
    `SELECT d.*, (SELECT COUNT(*)::int FROM ig_contact_fields f WHERE f.key = d.key) AS used
       FROM contact_field_defs d ORDER BY d.archived, lower(d.name)`);
  return { fields: rows, types: FIELD_TYPES };
}));

router.post('/fields', adminOnly, wrap(async (req) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) throw new Error('name is required');
  const type = FIELD_TYPES.includes(req.body?.type) ? req.body.type : 'text';
  const key = slug(req.body?.key || name);
  if (!key) throw new Error('name must contain letters or numbers');
  const { rows } = await pool.query(
    `INSERT INTO contact_field_defs (key, name, type, description, folder) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO NOTHING RETURNING *`, [key, name, type, req.body?.description || null, req.body?.folder || null]);
  if (!rows[0]) throw new Error(`a field called “${key}” already exists`);
  return rows[0];
}));

router.put('/fields/:key', adminOnly, wrap(async (req) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE contact_field_defs SET name = COALESCE($2, name), type = COALESCE($3, type), description = COALESCE($4, description),
            folder = COALESCE($5, folder), archived = COALESCE($6, archived) WHERE key = $1 RETURNING *`,
    [req.params.key, b.name ? String(b.name).slice(0, 80) : null, FIELD_TYPES.includes(b.type) ? b.type : null,
     b.description ?? null, b.folder ?? null, typeof b.archived === 'boolean' ? b.archived : null]);
  if (!rows[0]) throw new Error('field not found');
  return rows[0];
}));

// Delete = only once archived (ManyChat rule); removes the stored values too.
router.delete('/fields/:key', adminOnly, wrap(async (req) => {
  const { rows: [d] } = await pool.query('SELECT * FROM contact_field_defs WHERE key = $1', [req.params.key]);
  if (!d) throw new Error('field not found');
  if (!d.archived) throw new Error('archive the field before deleting it');
  await pool.query('DELETE FROM ig_contact_fields WHERE key = $1', [d.key]);
  await pool.query('DELETE FROM contact_field_defs WHERE key = $1', [d.key]);
  return { ok: true };
}));

// ── segments (saved filters) ────────────────────────────────
router.get('/segments', wrap(async () => (await pool.query('SELECT * FROM contact_segments ORDER BY lower(name)')).rows));
router.post('/segments', adminOnly, wrap(async (req) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) throw new Error('name is required');
  const { rows } = await pool.query('INSERT INTO contact_segments (name, filter) VALUES ($1,$2) RETURNING *', [name, JSON.stringify(req.body?.filter || {})]);
  return rows[0];
}));
router.delete('/segments/:id', adminOnly, wrap(async (req) => {
  await pool.query('DELETE FROM contact_segments WHERE id = $1', [Number(req.params.id)]);
  return { ok: true };
}));

// Quick-create a tag from anywhere (automation steps, bulk bar, profile).
// Uses the first category, creating "General" if there is none.
router.post('/tags', adminOnly, wrap(async (req) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) throw new Error('name is required');
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color || '') ? req.body.color : '#dc2626';
  const { rows: same } = await pool.query('SELECT id, name, color, category_id AS "categoryId" FROM tags WHERE lower(name) = lower($1)', [name]);
  if (same[0]) return same[0];
  let { rows: [cat] } = await pool.query('SELECT id FROM categories ORDER BY created_at NULLS LAST, id LIMIT 1');
  if (!cat) ({ rows: [cat] } = await pool.query(`INSERT INTO categories (id, name) VALUES ('general', 'General') ON CONFLICT (id) DO UPDATE SET name = categories.name RETURNING id`));
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('tag-' + Date.now().toString(36));
  const { rows: clash } = await pool.query('SELECT 1 FROM tags WHERE id = $1', [id]);
  if (clash[0]) id += '-' + Date.now().toString(36).slice(-4);
  const { rows } = await pool.query(
    `INSERT INTO tags (id, name, color, category_id) VALUES ($1,$2,$3,$4) RETURNING id, name, color, category_id AS "categoryId"`,
    [id, name, color, cat.id]);
  return rows[0];
}));

// Rename / recolour a tag (partial — keeps its category).
router.put('/tags/:id', adminOnly, wrap(async (req) => {
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 60) : null;
  const color = req.body?.color;
  if (name === '') throw new Error('name is required');
  if (color != null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('color must be a #rrggbb hex');
  if (name) {
    const { rows: dup } = await pool.query('SELECT 1 FROM tags WHERE lower(name) = lower($1) AND id <> $2', [name, req.params.id]);
    if (dup[0]) throw new Error('A tag with that name already exists');
  }
  const { rows } = await pool.query(
    `UPDATE tags SET name = COALESCE($2, name), color = COALESCE($3, color), updated_at = now() WHERE id = $1
     RETURNING id, name, color, category_id AS "categoryId"`, [req.params.id, name, color ?? null]);
  if (!rows[0]) throw new Error('Tag not found');
  return rows[0];
}));

// Delete a tag and take it off every contact that has it.
router.delete('/tags/:id', adminOnly, wrap(async (req) => {
  const id = req.params.id;
  const { rowCount } = await pool.query('DELETE FROM tags WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Tag not found');
  const { rowCount: removed } = await pool.query(
    `UPDATE contacts SET tags = tags - $1 WHERE jsonb_typeof(tags) = 'array' AND tags ? $1`, [id]);
  return { ok: true, removedFrom: removed };
}));

module.exports = router;
module.exports.ensureSchema = ensureSchema;
module.exports.startFollowSweep = startFollowSweep;
