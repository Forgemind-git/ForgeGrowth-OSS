// Flow Builder engine — ManyChat-style node graphs for Instagram.
//
// A flow is { nodes, edges } (the React Flow shape the builder saves). Node types:
//   trigger    — one or more triggers (comment / dm / story_reply / story_mention)
//   message    — text (+ ≤3 buttons), image, card, quick replies
//   collect    — ask a question, validate (text/email/phone/number/url/name), save to a field
//   condition  — tag / field / follows / last message rules, all|any → yes / no
//   randomizer — weighted A/B/C… split
//   delay      — wait minutes / hours / days (resumed by the 30 s ticker)
//   action     — add/remove tag, set/clear field, notify team, HTTP request, Google Sheet row
//   ai         — reply with an LLM (a model connected under Settings → AI Models)
//   goto       — start another flow (live flows only; its trigger is skipped. A flow
//                with only the "called" trigger runs only this way)
//   follow     — Follow Check: follows → "yes"; otherwise send the "please follow"
//                message with an "I've followed" button (payload handle "recheck",
//                which re-runs this step) up to maxAsks times, then "no".
// Edges carry sourceHandle: "next" (continue), "yes"/"no", "btn:<id>", "qr:<id>", "v:<id>",
// and "noreply" on a message whose data.noReply is on: if the person doesn't tap a
// button / link or write back within that time (≤ 23 h, inside Meta's 24 h window),
// the run continues from that message along "noreply" (ig_flow_noreply, fired by tick).
//
// A run is one contact going through one flow (ig_flow_runs). It pauses on
// collect (await_input), after a comment's private reply (await_reply — Meta
// allows nothing more until the person answers), and on delays. Button and
// quick-reply taps carry FSF:<runId>:<nodeId>:<handle> and resume from that
// node, even after the run finished, the way ManyChat buttons keep working.
//
// Meta rules kept (same as services/commentAutomation.js):
//   - one private reply per comment, within 7 days; nothing else until they respond;
//   - every other message only inside the 24 h window after their last message;
//   - one run per person per post per flow (once per user);
//   - every Graph call goes through rateLimiter (via commentAutomation.sendMessage),
//     and sends are capped per account per hour (IG_AUTOMATION_MAX_PER_HOUR).

const crypto = require('crypto');
const pool = require('../db');

const automation = () => require('./commentAutomation');   // lazy: avoids a require cycle
const shared = () => automation()._shared;

const TAP_PREFIX = 'FSF:';
const WINDOW_MS = 24 * 3600 * 1000;
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_STEPS = 40;            // per pass — stops accidental loops
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => String(s ?? '').slice(0, n);
const rid = () => crypto.randomBytes(6).toString('hex');

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ig_flows (
        id          serial PRIMARY KEY,
        name        text NOT NULL,
        account_id  text NOT NULL,
        active      boolean NOT NULL DEFAULT false,
        graph       jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
        template    text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ig_flow_runs (
        id              bigserial PRIMARY KEY,
        flow_id         int REFERENCES ig_flows(id) ON DELETE CASCADE,
        account_id      text NOT NULL,
        peer_id         text,
        username        text,
        trigger         text,
        event_id        text,
        media_id        text,
        node_id         text,
        status          text NOT NULL DEFAULT 'running',  -- running|await_input|await_reply|delayed|done|failed|stopped|expired
        wait_until      timestamptz,
        vars            jsonb NOT NULL DEFAULT '{}',
        retries         int NOT NULL DEFAULT 0,
        last_inbound_at timestamptz,
        error           text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (flow_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS ig_flow_runs_peer ON ig_flow_runs (account_id, peer_id, status);
      CREATE INDEX IF NOT EXISTS ig_flow_runs_due ON ig_flow_runs (status, wait_until);
      CREATE TABLE IF NOT EXISTS ig_flow_events (
        id          bigserial PRIMARY KEY,
        run_id      bigint REFERENCES ig_flow_runs(id) ON DELETE CASCADE,
        flow_id     int REFERENCES ig_flows(id) ON DELETE CASCADE,
        account_id  text,
        node_id     text,
        kind        text,          -- sent | public_reply | tap | input | skip | error
        detail      text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ig_flow_events_flow ON ig_flow_events (flow_id, created_at);
      CREATE INDEX IF NOT EXISTS ig_flow_events_acct ON ig_flow_events (account_id, kind, created_at);
      CREATE TABLE IF NOT EXISTS ig_contact_fields (
        account_id  text NOT NULL,
        peer_id     text NOT NULL,
        key         text NOT NULL,
        value       text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, peer_id, key)
      );
      ALTER TABLE ig_automation_links ADD COLUMN IF NOT EXISTS flow_id int;
      CREATE TABLE IF NOT EXISTS ig_flow_noreply (
        id          bigserial PRIMARY KEY,
        run_id      bigint REFERENCES ig_flow_runs(id) ON DELETE CASCADE,
        flow_id     int REFERENCES ig_flows(id) ON DELETE CASCADE,
        account_id  text NOT NULL,
        peer_id     text,
        node_id     text NOT NULL,
        due_at      timestamptz NOT NULL,
        armed_at    timestamptz NOT NULL DEFAULT now(),
        status      text NOT NULL DEFAULT 'pending',   -- pending | sending | fired | skipped
        reason      text,
        done_at     timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ig_flow_noreply_open ON ig_flow_noreply (run_id, node_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS ig_flow_noreply_due ON ig_flow_noreply (due_at) WHERE status = 'pending';
    `).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ── graph helpers ───────────────────────────────────────────
const nodeById = (g, id) => (g.nodes || []).find(n => n.id === id);
const triggerNode = (g) => (g.nodes || []).find(n => n.type === 'trigger');
function nextNode(g, fromId, handle = 'next') {
  const e = (g.edges || []).find(x => x.source === fromId && (x.sourceHandle || 'next') === handle);
  return e ? nodeById(g, e.target) : null;
}

async function event(run, nodeId, kind, detail) {
  await pool.query(
    'INSERT INTO ig_flow_events (run_id, flow_id, account_id, node_id, kind, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [run.id, run.flow_id, run.account_id, nodeId || null, kind, detail ? clip(detail, 500) : null]).catch(() => {});
}

async function saveRun(run, patch) {
  Object.assign(run, patch);
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await pool.query(
    `UPDATE ig_flow_runs SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [run.id, ...cols.map(c => (c === 'vars' ? JSON.stringify(patch[c]) : patch[c]))]);
}

async function overCap(accountId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ig_flow_events WHERE account_id = $1 AND kind IN ('sent','public_reply') AND created_at > now() - interval '1 hour'`,
    [accountId]);
  return rows[0].n >= shared().MAX_PER_HOUR;
}

// {first_name} {username} {anything} → contact info / saved fields / run vars.
function fill(text, run) {
  const v = run.vars || {};
  return String(text || '').replace(/\{([a-z0-9_]+)\}/gi, (m, k) => {
    const key = k.toLowerCase();
    if (key === 'first_name') return (v._name || v._username || '').split(' ')[0] || 'there';
    if (key === 'username') return v._username || '';
    if (key === 'account') return v._account || '';
    return v[key] != null ? String(v[key]) : m;
  });
}

// ── contact data ────────────────────────────────────────────
async function loadContact(accountId, peerId) {
  const out = { tags: [], fields: {} };
  if (!peerId) return out;
  const [{ rows: c }, { rows: f }, { rows: u }] = await Promise.all([
    pool.query(`SELECT tags, name, username FROM contacts WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`, [accountId, peerId]),
    pool.query('SELECT key, value FROM ig_contact_fields WHERE account_id = $1 AND peer_id = $2', [accountId, peerId]),
    pool.query('SELECT name, username FROM instagram_users WHERE igsid = $1', [peerId]),
  ]);
  out.tags = Array.isArray(c[0]?.tags) ? c[0].tags : [];
  out.name = c[0]?.name || u[0]?.name || null;
  out.username = c[0]?.username || u[0]?.username || null;
  for (const r of f) out.fields[r.key] = r.value;
  return out;
}

async function setField(run, key, value) {
  const k = clip(String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'), 60);
  if (!k || !run.peer_id) return;
  run.vars[k] = value;
  await pool.query(
    `INSERT INTO ig_contact_fields (account_id, peer_id, key, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id, peer_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [run.account_id, run.peer_id, k, value == null ? null : clip(value, 2000)]);
  // A field first saved by an automation shows up in Settings → Fields (as text).
  await pool.query(
    `INSERT INTO contact_field_defs (key, name, type) VALUES ($1, initcap(replace($1, '_', ' ')), $2) ON CONFLICT (key) DO NOTHING`,
    [k, ['email', 'phone', 'number', 'url'].includes(k) ? (k === 'url' ? 'url' : k) : 'text']).catch(() => {});
}

async function removeTags(accountId, peerId, tags) {
  if (!peerId || !tags?.length) return;
  await pool.query(
    `UPDATE contacts SET tags = (
        SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb)) t WHERE NOT (t = ANY($3::text[])))
      WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`, [accountId, peerId, tags]);
}

// ── link tracking (same redirect + table as rule automations) ──
async function trackUrl(run, url) {
  if (!shared().TRACK_LINKS || !/^https?:\/\//i.test(url || '')) return url;
  try {
    const token = crypto.randomBytes(9).toString('base64url');
    await pool.query(
      `INSERT INTO ig_automation_links (token, send_id, rule_id, flow_id, account_id, peer_id, url) VALUES ($1,$2,NULL,$3,$4,$5,$6)`,
      [token, `run${run.id}`, run.flow_id, run.account_id, run.peer_id, url]);
    return `${shared().PUBLIC_BASE}/api/social/ig-automations/r/${token}`;
  } catch (_) { return url; }
}

// ── message node → Graph messages ───────────────────────────
async function buildMessages(run, node) {
  const d = node.data || {};
  const out = [];
  const tapPayload = (h) => `${TAP_PREFIX}${run.id}:${node.id}:${h}`;
  const toButton = async (b) => b.kind === 'url'
    ? { type: 'web_url', title: clip(fill(b.title, run), 20) || 'Open', url: await trackUrl(run, fill(b.url, run)) }
    : { type: 'postback', title: clip(fill(b.title, run), 20) || 'Next', payload: tapPayload(`btn:${b.id}`) };
  for (const blk of d.blocks || []) {
    if (blk.type === 'text') {
      const text = fill(blk.text, run).trim();
      if (!text) continue;
      const btns = [];
      for (const b of (blk.buttons || []).filter(b => b.title && (b.kind !== 'url' || b.url)).slice(0, 3)) btns.push(await toButton(b));
      out.push(btns.length
        ? { attachment: { type: 'template', payload: { template_type: 'button', text: clip(text, 640), buttons: btns } } }
        : { text: clip(text, 1000) });
    } else if (blk.type === 'image' && blk.url) {
      out.push({ attachment: { type: 'image', payload: { url: blk.url } } });
    } else if (blk.type === 'card' && blk.title) {
      const el = { title: clip(fill(blk.title, run), 80) };
      if (blk.subtitle) el.subtitle = clip(fill(blk.subtitle, run), 80);
      if (blk.image_url) el.image_url = blk.image_url;
      if (blk.url) el.default_action = { type: 'web_url', url: await trackUrl(run, blk.url) };
      const btns = [];
      for (const b of (blk.buttons || []).filter(b => b.title && (b.kind !== 'url' || b.url)).slice(0, 3)) btns.push(await toButton(b));
      if (btns.length) el.buttons = btns;
      out.push({ attachment: { type: 'template', payload: { template_type: 'generic', elements: [el] } } });
    }
  }
  const qrs = (d.quickReplies || []).filter(q => q.title).slice(0, 13)
    .map(q => ({ content_type: 'text', title: clip(fill(q.title, run), 20), payload: tapPayload(`qr:${q.id}`) }));
  if (qrs.length) {
    const lastText = [...out].reverse().find(m => m.text);
    if (lastText) lastText.quick_replies = qrs;
    else out.push({ text: fill(d.quickText || 'Choose one:', run), quick_replies: qrs });
  }
  return out;
}

// Send respecting Meta's windows. First message after a comment = the private reply.
async function send(run, nodeId, message) {
  if (await overCap(run.account_id)) throw new Error(`hourly cap (${shared().MAX_PER_HOUR}) reached`);
  const v = run.vars;
  let recipient;
  if (v._private_reply_pending) {
    recipient = { comment_id: v._comment_id };
  } else {
    if (v._needs_reply) throw new Error('waiting for the person to reply first');
    if (!run.last_inbound_at || Date.now() - new Date(run.last_inbound_at).getTime() > WINDOW_MS) throw new Error('outside the 24-hour messaging window');
    recipient = { id: run.peer_id };
  }
  const sent = await shared().sendMessage(run.account_id, recipient, message);
  if (v._private_reply_pending) {
    v._private_reply_pending = false;
    v._needs_reply = true;   // Meta: nothing more until they answer
    if (sent.recipientId && sent.recipientId !== run.peer_id) run.peer_id = sent.recipientId;
    await saveRun(run, { vars: v, peer_id: run.peer_id });
  }
  await event(run, nodeId, 'sent', message.text || message.attachment?.payload?.text || message.attachment?.type || 'message');
  return sent;
}

// ── node executors: return { next: handle } | { wait: true } | { end: true } ──
const EXEC = {
  async trigger() { return { next: 'next' }; },

  async message(run, node, g) {
    const msgs = await buildMessages(run, node);
    if (!msgs.length) return { next: 'next' };
    if (run.vars._needs_reply) {   // after a private reply: park here until they respond
      await saveRun(run, { status: 'await_reply', node_id: node.id });
      return { wait: true };
    }
    const first = !!run.vars._private_reply_pending;
    for (let i = 0; i < msgs.length; i++) {
      if (i > 0) await sleep(900);
      await send(run, node.id, msgs[i]);
      if (first) break;   // a private reply is exactly one message
    }
    // "If no response": never after a private reply (it doesn't open the 24 h window).
    if (!first && g) await armNoReply(run, node, g).catch(e => console.warn(`[flow] run ${run.id}: no-response timer not set (${e.message})`));
    return { next: 'next' };
  },

  async collect(run, node) {
    const d = node.data || {};
    if (run.vars._needs_reply) { await saveRun(run, { status: 'await_reply', node_id: node.id }); return { wait: true }; }
    const msg = { text: clip(fill(d.prompt || 'Please reply with your answer.', run), 1000) };
    if (d.skipLabel) msg.quick_replies = [{ content_type: 'text', title: clip(d.skipLabel, 20), payload: `${TAP_PREFIX}${run.id}:${node.id}:skip` }];
    await send(run, node.id, msg);
    await saveRun(run, { status: 'await_input', node_id: node.id, retries: 0 });
    return { wait: true };
  },

  async condition(run, node) {
    const d = node.data || {};
    const rules = d.rules || [];
    if (!rules.length) return { next: 'yes' };
    const contact = await loadContact(run.account_id, run.peer_id);
    const results = [];
    for (const r of rules) results.push(await evalRule(run, r, contact));
    const ok = d.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    return { next: ok ? 'yes' : 'no' };
  },

  async randomizer(run, node) {
    const vs = (node.data?.variants || []).filter(v => Number(v.weight) > 0);
    if (!vs.length) return { end: true };
    const total = vs.reduce((a, v) => a + Number(v.weight), 0);
    let x = Math.random() * total;
    for (const v of vs) { x -= Number(v.weight); if (x <= 0) return { next: `v:${v.id}` }; }
    return { next: `v:${vs[vs.length - 1].id}` };
  },

  async delay(run, node) {
    const d = node.data || {};
    const mult = d.unit === 'days' ? 86400 : d.unit === 'hours' ? 3600 : 60;
    const secs = Math.max(1, Number(d.amount) || 1) * mult;
    await saveRun(run, { status: 'delayed', node_id: node.id, wait_until: new Date(Date.now() + secs * 1000) });
    return { wait: true };
  },

  async action(run, node) {
    for (const a of node.data?.actions || []) {
      try { await runAction(run, node, a); }
      catch (e) { await event(run, node.id, 'error', `${a.kind}: ${e.message}`); }
    }
    return { next: 'next' };
  },

  async ai(run, node) {
    if (run.vars._needs_reply) { await saveRun(run, { status: 'await_reply', node_id: node.id }); return { wait: true }; }
    const text = await aiReply(run, node.data || {});
    if (text) {
      if (node.data?.saveTo) await setField(run, node.data.saveTo, text);
      if (node.data?.send !== false) await send(run, node.id, { text: clip(text, 1000) });
    }
    return { next: 'next' };
  },

  // Follow Check. The profile lookup is consent-gated: it works once they've
  // messaged / tapped. As the first DM after a comment (private reply pending) we
  // can't look them up yet, so a "tap to continue" goes first and the tap re-runs
  // this step. If Instagram can't answer, fail open (treated as following).
  async follow(run, node) {
    const d = node.data || {};
    if (run.vars._needs_reply) { await saveRun(run, { status: 'await_reply', node_id: node.id }); return { wait: true }; }
    const button = (label) => ({ attachment: { type: 'template', payload: { template_type: 'button', text: '',
      buttons: [{ type: 'postback', title: clip(label, 20), payload: `${TAP_PREFIX}${run.id}:${node.id}:recheck` }] } } });
    const ask = async (text, label) => {
      const m = button(label);
      m.attachment.payload.text = clip(fill(text, run), 640);
      await send(run, node.id, m);
      // vars too: a tap / reply re-runs this step outside advance(), which is what normally saves them
      await saveRun(run, { status: 'await_reply', node_id: node.id, vars: run.vars });
      return { wait: true };
    };
    if (run.vars._private_reply_pending) {
      return ask(d.openText || 'Thanks! Tap below to continue.', d.openButton || 'Continue');
    }
    let follows = true;
    try {
      follows = await shared().followsAccount(run.account_id, run.peer_id);
      await pool.query(`UPDATE contacts SET follows_business = $3 WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`, [run.account_id, run.peer_id, follows]).catch(() => {});
    } catch (e) { await event(run, node.id, 'skip', `follow check unavailable (${e.message}) — treated as following`); }
    if (follows) return { next: 'yes' };
    const key = `_follow_asks_${node.id}`;
    const asks = Number(run.vars[key]) || 0;
    const max = Math.min(5, Math.max(1, Number(d.maxAsks) || 2));
    if (asks >= max) return { next: 'no' };
    run.vars[key] = asks + 1;
    return ask(d.askText || 'Almost there! Please follow @{account} first, then tap the button below.', d.button || "I've followed");
  },

  // Start another Automation: the person continues in that flow (same conversation,
  // vars carried over). Its trigger is skipped — flows meant only for this use the
  // "called" trigger ("Started by another automation"), which no Instagram event fires.
  async goto(run, node) {
    const id = Number(node.data?.flowId);
    if (!id || id === run.flow_id) return { end: true };
    const flow = await getFlow(id);
    if (!flow || flow.account_id !== run.account_id) { await event(run, node.id, 'error', 'that automation no longer exists on this account'); return { end: true }; }
    if (!flow.active) { await event(run, node.id, 'skip', `"${clip(flow.name, 60)}" is off — set it live so this step can start it`); return { end: true }; }
    const depth = Number(run.vars._goto_depth) || 0;   // A → B → A … would never stop
    if (depth >= 5) { await event(run, node.id, 'error', 'stopped: automations started each other 5 times in a row (a loop?)'); return { end: true }; }
    // Continue the same conversation inside the other flow.
    await saveRun(run, { status: 'done', node_id: node.id });
    const t = triggerNode(flow.graph);
    if (!t) return { end: true };
    const r2 = await createRun(flow, { peerId: run.peer_id, username: run.username, trigger: 'goto', eventId: `goto:${run.id}:${Date.now()}`, vars: { ...run.vars, _goto_depth: depth + 1, _called_by: run.flow_id }, lastInbound: run.last_inbound_at });
    await event(run, node.id, 'goto', clip(flow.name, 120));
    if (r2) await advance(flow, r2, t.id, 'next');
    return { stop: true };
  },
};

async function evalRule(run, r, contact) {
  const val = (k) => {
    const key = String(k || '').toLowerCase();
    if (run.vars[key] != null) return String(run.vars[key]);
    return contact.fields[key] != null ? String(contact.fields[key]) : '';
  };
  switch (r.subject) {
    case 'tag': {
      const has = contact.tags.includes(r.key);
      return r.op === 'not' ? !has : has;
    }
    case 'field': {
      const v = val(r.key), want = String(r.value || '').toLowerCase();
      if (r.op === 'set') return v !== '';
      if (r.op === 'unset') return v === '';
      if (r.op === 'eq') return v.toLowerCase() === want;
      if (r.op === 'neq') return v.toLowerCase() !== want;
      if (r.op === 'contains') return v.toLowerCase().includes(want);
      if (r.op === 'gt') return Number(v) > Number(r.value);
      if (r.op === 'lt') return Number(v) < Number(r.value);
      return false;
    }
    case 'last_text': {
      const v = String(run.vars._last_text || '').toLowerCase();
      const words = String(r.value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const hit = words.some(w => v.includes(w));
      return r.op === 'not' ? !hit : hit;
    }
    case 'follows': {
      let f = true;
      try {
        f = await shared().followsAccount(run.account_id, run.peer_id);
        await pool.query(`UPDATE contacts SET follows_business = $3 WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`, [run.account_id, run.peer_id, f]).catch(() => {});
      }
      catch (e) { await event(run, null, 'skip', `follow check unavailable (${e.message}) — treated as following`); }
      return r.op === 'not' ? !f : f;
    }
    case 'time': {   // current IST hour between from..to
      const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
      const from = Number(r.from ?? 9), to = Number(r.to ?? 18);
      const inside = from <= to ? h >= from && h < to : h >= from || h < to;
      return r.op === 'not' ? !inside : inside;
    }
    default: return false;
  }
}

async function runAction(run, node, a) {
  const s = shared();
  if (a.kind === 'add_tag' && a.tags?.length) await s.applyTags(run.account_id, run.peer_id, a.tags, run.username);
  else if (a.kind === 'remove_tag' && a.tags?.length) await removeTags(run.account_id, run.peer_id, a.tags);
  else if (a.kind === 'set_field' && a.key) await setField(run, a.key, fill(a.value, run));
  else if (a.kind === 'clear_field' && a.key) {
    delete run.vars[a.key];
    await pool.query('DELETE FROM ig_contact_fields WHERE account_id = $1 AND peer_id = $2 AND key = $3', [run.account_id, run.peer_id, a.key]);
  } else if (a.kind === 'notify') {
    await require('../notificationService').emit('automation', {
      title: clip(fill(a.title || 'Automation needs you', run), 200),
      body: clip(fill(a.body || `@${run.username || run.peer_id} reached “${node.data?.label || 'a step'}”`, run), 500),
      link: '#/social/inbox', platform: 'instagram', accountKey: run.account_id,
    });
  } else if (a.kind === 'http' && a.url) {
    const method = (a.method || 'POST').toUpperCase();
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (method !== 'GET') opts.body = fill(a.body || JSON.stringify({ username: '{username}', peer_id: run.peer_id }), run);
    const res = await globalThis.fetch(fill(a.url, run), { ...opts, signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    if (a.saveTo) await setField(run, a.saveTo, clip(body, 2000));
    await event(run, node.id, 'action', `HTTP ${method} → ${res.status}`);
  } else if (a.kind === 'sheet' && a.sheetId && a.tab) {
    const values = String(a.columns || '{username}').split(',').map(c => fill(c.trim(), run));
    await require('./sheetsAgentOps').executeOp({ op: 'append', toolConfig: { spreadsheet_id: a.sheetId, sheet_name: a.tab }, args: { values: [new Date().toISOString(), ...values] } });
  } else if (a.kind === 'stop_ai') {
    run.vars._stop_ai = true;
    await saveRun(run, { vars: run.vars });
  }
}

// One LLM reply through OpenRouter (Settings → OpenRouter). Spend is logged as 'flow_ai_step'.
const DEFAULT_AI_MODEL = 'anthropic/claude-haiku-5.5';

// One completion through OpenRouter; logs spend under `feature`.
async function aiComplete({ instructions, model, messages, feature }) {
  const llm = require('../llm');
  const openRouter = require('./openRouter');
  const apiKey = await openRouter.getKey();
  if (!apiKey) throw new Error('OpenRouter is not connected (Settings → OpenRouter)');
  model = model || DEFAULT_AI_MODEL;
  const r = await llm.runWithTools({
    provider: 'openrouter', apiKey, model, tools: [], maxIterations: 1,
    systemPrompt: `${instructions || 'You are a helpful assistant for this Instagram business. Reply briefly.'}\n\nReply in plain professional text for an Instagram DM, under 900 characters, no emojis.`,
    messages, onToolCall: async () => ({}), onStep: async () => {},
  });
  const cost = await openRouter.costOf(model, r.totalInputTokens, r.totalOutputTokens);
  await openRouter.logUsage({ feature, model, usage: { input_tokens: r.totalInputTokens, output_tokens: r.totalOutputTokens, cost } });
  return { text: String(r.finalText || '').replace(/\p{Extended_Pictographic}/gu, '').trim(), model, cost };
}

async function aiReply(run, d) {
  const { rows: hist } = await pool.query(
    `SELECT direction, text FROM instagram_messages WHERE account_id = $1 AND (sender_id = $2 OR recipient_id = $2) AND text IS NOT NULL AND text <> ''
      ORDER BY ts DESC LIMIT 12`, [run.account_id, run.peer_id]);
  const messages = hist.reverse().map(h => ({ role: h.direction === 'outgoing' ? 'assistant' : 'user', content: h.text }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) messages.push({ role: 'user', content: run.vars._last_text || 'Hi' });
  const r = await aiComplete({ instructions: fill(d.instructions || '', run), model: d.model, messages, feature: 'flow_ai_step' });
  return r.text;
}

// "Test it" in the Flow Builder: a real AI Step reply for the simulated chat (nothing is sent).
async function aiTest({ instructions, model, messages }) {
  const msgs = (Array.isArray(messages) ? messages : []).slice(-12)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: clip(String(m.content), 1000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) msgs.push({ role: 'user', content: 'Hi' });
  const r = await aiComplete({ instructions: clip(String(instructions || ''), 4000), model: model ? clip(String(model), 120) : '', messages: msgs, feature: 'flow_ai_test' });
  const fx = await require('./openRouter').inrRate();
  return { text: r.text, model: r.model, costInr: r.cost * fx.rate };
}

// ── run lifecycle ───────────────────────────────────────────
async function getFlow(id) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ig_flows WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createRun(flow, { peerId, username, trigger, eventId, mediaId = null, vars = {}, lastInbound = null }) {
  // One active conversation per person: stop their other waiting runs.
  if (peerId) {
    await pool.query(
      `UPDATE ig_flow_runs SET status = 'stopped', updated_at = now()
        WHERE account_id = $1 AND peer_id = $2 AND status IN ('await_input','await_reply','delayed','running')`,
      [flow.account_id, peerId]);
  }
  const contact = await loadContact(flow.account_id, peerId).catch(() => ({ fields: {} }));
  const acc = await shared().accountUsername(flow.account_id).catch(() => null);
  const v = { ...contact.fields, ...vars, _username: username || contact.username || vars._username || null, _name: contact.name || vars._name || null, _account: acc };
  const { rows } = await pool.query(
    `INSERT INTO ig_flow_runs (flow_id, account_id, peer_id, username, trigger, event_id, media_id, vars, last_inbound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (flow_id, event_id) DO NOTHING RETURNING *`,
    [flow.id, flow.account_id, peerId, v._username, trigger, eventId, mediaId, JSON.stringify(v), lastInbound]);
  return rows[0] || null;
}

// Walk the graph from `fromId` along `handle` until a node waits or the path ends.
async function advance(flow, run, fromId, handle = 'next') {
  const g = flow.graph || {};
  let node = nextNode(g, fromId, handle);
  for (let step = 0; node && step < MAX_STEPS; step++) {
    await saveRun(run, { status: 'running', node_id: node.id });
    let res;
    try {
      const fn = EXEC[node.type];
      res = fn ? await fn(run, node, g) : { next: 'next' };
    } catch (e) {
      await event(run, node.id, 'error', e.message);
      await saveRun(run, { status: 'failed', error: clip(e.message, 500) });
      console.warn(`[flow] ${flow.id} "${flow.name}" run ${run.id} failed at ${node.type}: ${e.message}`);
      return;
    }
    await saveRun(run, { vars: run.vars });   // keep fields set by this step for later steps / resumes
    if (res.wait || res.stop) return;
    if (res.end) break;
    node = nextNode(g, node.id, res.next || 'next');
  }
  if (!['await_input', 'await_reply', 'delayed', 'failed', 'stopped'].includes(run.status)) await saveRun(run, { status: 'done' });
}

// ── triggers ────────────────────────────────────────────────
function matchKeywords(t, text) {
  const s = shared();
  const exclude = (t.exclude || []).map(w => String(w).toLowerCase()).filter(Boolean);
  const hay = String(text || '').toLowerCase();
  if (exclude.some(w => hay.includes(w))) return false;
  if (t.anyWord || !(t.keywords || []).length) return true;
  return s.matches({ keywords: t.keywords, match_type: t.match || 'contains' }, text);
}

async function activeFlows(accountId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ig_flows WHERE active AND account_id = $1 ORDER BY id', [accountId]);
  return rows;
}

async function onComment({ accountId, comment }) {
  const v = comment || {};
  if (!accountId || !v.id || !v.from?.id || v.from.id === accountId) return;
  const flows = await activeFlows(accountId);
  if (!flows.length) return;
  const own = await shared().accountUsername(accountId);
  if (own && v.from.username === own) return;
  const mediaId = v.media?.id || null;
  const createdMs = v.created_time ? Number(v.created_time) * 1000 : Date.now();
  for (const flow of flows) {
    const tn = triggerNode(flow.graph);
    const t = (tn?.data?.triggers || []).find(x => x.kind === 'comment');
    if (!t) continue;
    if (v.parent_id && !t.includeReplies) continue;
    if (t.postMode === 'one' && t.mediaId && t.mediaId !== mediaId) continue;
    if (t.postMode === 'next') {
      if (t.mediaId && t.mediaId !== mediaId) continue;
      if (!t.mediaId) {   // lock onto the first post published after the flow went live
        const { rows } = await pool.query(`SELECT date FROM posts WHERE external_id = $1 LIMIT 1`, [mediaId]);
        if (rows[0] && t.since && new Date(rows[0].date) < new Date(String(t.since).slice(0, 10))) continue;
        t.mediaId = mediaId;
        await pool.query('UPDATE ig_flows SET graph = $2 WHERE id = $1', [flow.id, JSON.stringify(flow.graph)]);
      }
    }
    if (!matchKeywords(t, v.text)) continue;
    if (t.oncePerUser !== false) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ig_flow_runs WHERE flow_id = $1 AND media_id IS NOT DISTINCT FROM $2 AND peer_id = $3 AND status <> 'failed' LIMIT 1`,
        [flow.id, mediaId, v.from.id]);
      if (rows.length) continue;
    }
    if (Date.now() - createdMs > PRIVATE_REPLY_WINDOW_MS) continue;
    if (await overCap(accountId)) { console.warn(`[flow] ${flow.id}: hourly cap reached, skipped comment ${v.id}`); continue; }
    const run = await createRun(flow, { peerId: v.from.id, username: v.from.username, trigger: 'comment', eventId: v.id, mediaId,
      vars: { _comment_id: v.id, _private_reply_pending: true, _last_text: v.text || '' } });
    if (!run) continue;
    await sleep(2000 + Math.floor(Math.random() * 3000));   // 2–5 s before replying to a comment, like rules
    const replies = (t.replyTexts || []).filter(Boolean);
    if (replies.length) {
      try {
        await require('../instagram').replyToComment({ commentId: v.id, accountId, message: fill(replies[Math.floor(Math.random() * replies.length)], run) });
        await event(run, tn.id, 'public_reply', 'replied under the comment');
      } catch (e) { await event(run, tn.id, 'error', 'public reply: ' + e.message); }
    }
    await advance(flow, run, tn.id, 'next');
    console.log(`[flow] ${flow.id} "${flow.name}" comment ${v.id} by @${v.from.username} → ${run.status}`);
  }
}

// Inbound DM / tap. Returns true when a flow consumed it (rules then stay quiet).
async function onMessaging({ accountId, ev }) {
  if (!accountId || !ev || ev.message?.is_echo) return false;
  const peerId = ev.sender?.id;
  if (!peerId || peerId === accountId) return false;
  await ensureSchema();
  const payload = ev.postback?.payload || ev.message?.quick_reply?.payload || null;
  const text = ev.message?.text || '';
  const now = new Date();

  // 1) a button / quick reply from one of our flow messages
  if (payload && payload.startsWith(TAP_PREFIX)) {
    const [runId, nodeId, ...rest] = payload.slice(TAP_PREFIX.length).split(':');
    const handle = rest.join(':');
    const { rows } = await pool.query('SELECT r.*, f.graph, f.name, f.active FROM ig_flow_runs r JOIN ig_flows f ON f.id = r.flow_id WHERE r.id = $1', [Number(runId)]);
    const run = rows[0];
    if (!run || run.account_id !== accountId) return true;
    const flow = { id: run.flow_id, name: run.name, graph: run.graph, account_id: run.account_id };
    delete run.graph; delete run.name; delete run.active;
    run.vars._needs_reply = false;
    run.vars._last_text = ev.postback?.title || text || '';
    await saveRun(run, { vars: run.vars, last_inbound_at: now, status: 'running' });
    await event(run, nodeId, 'tap', run.vars._last_text || handle);
    if (handle === 'skip') { await advance(flow, run, nodeId, 'next'); return true; }
    if (handle === 'recheck') {   // Follow Check button: run that step again
      const node = nodeById(flow.graph, nodeId);
      if (!node) return true;
      const res = await EXEC[node.type](run, node, flow.graph).catch(async e => { await event(run, nodeId, 'error', e.message); await saveRun(run, { status: 'failed', error: e.message }); return { wait: true }; });
      if (!res.wait && !res.stop && !res.end) await advance(flow, run, nodeId, res.next || 'next');
      else if (res.end) await saveRun(run, { status: 'done' });
      return true;
    }
    await advance(flow, run, nodeId, handle);
    return true;
  }

  // 2) an open conversation waiting for this person
  if (ev.message && !payload) {
    const { rows } = await pool.query(
      `SELECT r.*, f.graph, f.name FROM ig_flow_runs r JOIN ig_flows f ON f.id = r.flow_id
        WHERE r.account_id = $1 AND r.peer_id = $2 AND r.status IN ('await_input','await_reply')
          AND r.updated_at > now() - interval '24 hours'
        ORDER BY r.updated_at DESC LIMIT 1`, [accountId, peerId]);
    const run = rows[0];
    if (run) {
      const flow = { id: run.flow_id, name: run.name, graph: run.graph, account_id: run.account_id };
      delete run.graph; delete run.name;
      run.vars._needs_reply = false;
      run.vars._last_text = text;
      await saveRun(run, { vars: run.vars, last_inbound_at: now });
      if (run.status === 'await_reply') {   // resume at the parked node
        await saveRun(run, { status: 'running' });
        const node = nodeById(flow.graph, run.node_id);
        if (!node) { await saveRun(run, { status: 'done' }); return true; }
        const res = await EXEC[node.type](run, node, flow.graph).catch(async e => { await event(run, node.id, 'error', e.message); await saveRun(run, { status: 'failed', error: e.message }); return { wait: true }; });
        if (!res.wait && !res.stop) await advance(flow, run, node.id, res.next || 'next');
        return true;
      }
      // await_input: validate the answer for the collect node
      const node = nodeById(flow.graph, run.node_id);
      if (!node) { await saveRun(run, { status: 'done' }); return true; }
      if (/^\s*(stop|cancel)\s*$/i.test(text)) {
        await saveRun(run, { status: 'stopped' });
        await send(run, node.id, { text: 'No problem, I have stopped. Message us any time if you need anything.' }).catch(() => {});
        return true;
      }
      const d = node.data || {};
      const ok = validate(d.kind, text);
      await event(run, node.id, 'input', clip(text, 200));
      if (!ok && run.retries < (Number(d.maxRetries) || 2)) {
        await saveRun(run, { retries: run.retries + 1 });
        await send(run, node.id, { text: fill(d.retryText || `That doesn't look right. Please try again (or type STOP to cancel).`, run) }).catch(() => {});
        return true;
      }
      if (d.field) await setField(run, d.field, String(text).trim());
      if (d.kind === 'name' && text.trim()) {
        await pool.query(`UPDATE contacts SET name = COALESCE(name, $3) WHERE platform = 'instagram' AND account_id = $1 AND peer_id = $2`, [accountId, peerId, text.trim()]).catch(() => {});
      }
      await saveRun(run, { vars: run.vars });
      await advance(flow, run, node.id, 'next');
      return true;
    }
  }
  return false;
}

function validate(kind, raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (kind === 'email') return EMAIL_RE.test(s);
  if (kind === 'phone') { const d = s.replace(/[^\d]/g, ''); return d.length >= 7 && d.length <= 15; }
  if (kind === 'number') return !isNaN(Number(s.replace(/,/g, '')));
  if (kind === 'url') return /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}/i.test(s);
  return true;
}

// DM / story triggers — called after rule automations had their turn.
async function onMessagingTrigger({ accountId, ev }) {
  if (!accountId || !ev?.message || ev.message.is_echo) return false;
  const peerId = ev.sender?.id;
  if (!peerId || peerId === accountId) return false;
  const flows = await activeFlows(accountId);
  if (!flows.length) return false;
  const atts = Array.isArray(ev.message.attachments) ? ev.message.attachments : [];
  const kind = atts.some(a => a?.type === 'story_mention') ? 'story_mention' : ev.message.reply_to?.story ? 'story_reply' : 'dm';
  const text = ev.message.text || '';
  for (const flow of flows) {
    const tn = triggerNode(flow.graph);
    const t = (tn?.data?.triggers || []).find(x => x.kind === kind);
    if (!t) continue;
    if (kind !== 'story_mention' && !matchKeywords(t, text)) continue;
    if (kind === 'dm' && !t.anyWord && !(t.keywords || []).length) continue;   // never answer every DM by accident
    if (await overCap(accountId)) return false;
    const eventId = ev.message.mid || `${peerId}:${ev.timestamp}`;
    const run = await createRun(flow, { peerId, trigger: kind, eventId, vars: { _last_text: text }, lastInbound: new Date() });
    if (!run) return true;
    await sleep(1000 + Math.floor(Math.random() * 1500));   // 1–2.5 s: they just messaged us
    await advance(flow, run, tn.id, 'next');
    console.log(`[flow] ${flow.id} "${flow.name}" ${kind} from ${peerId} → ${run.status}`);
    return true;   // first matching flow wins, one reply per message
  }
  return false;
}

// True while a flow owns the conversation (agentDispatch keeps the AI agent quiet).
async function isHandling(accountId, peerId) {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT 1 FROM ig_flow_runs WHERE account_id = $1 AND peer_id = $2
        AND (status IN ('await_input','await_reply','running') OR (status = 'delayed' AND wait_until < now() + interval '1 hour'))
        AND updated_at > now() - interval '24 hours' LIMIT 1`, [accountId, peerId]);
    return rows.length > 0;
  } catch (_) { return false; }
}

// ── "If no response" on a message ───────────────────────────
const NOREPLY_MAX_SECS = 23 * 3600;   // Meta: automated messages only within 24 h of their last message
function noReplySecs(nr) {
  const mult = nr?.unit === 'hours' ? 3600 : 60;
  return Math.min(NOREPLY_MAX_SECS, Math.max(15 * 60, (Number(nr?.amount) || 1) * mult));
}
async function armNoReply(run, node, g) {
  const nr = node.data?.noReply;
  if (!nr?.enabled || !nextNode(g, node.id, 'noreply')) return;
  await pool.query(
    `INSERT INTO ig_flow_noreply (run_id, flow_id, account_id, peer_id, node_id, due_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     ON CONFLICT (run_id, node_id) WHERE status = 'pending'
       DO UPDATE SET due_at = EXCLUDED.due_at, armed_at = now()`,
    [run.id, run.flow_id, run.account_id, run.peer_id, node.id, noReplySecs(nr)]);
}
async function doneNoReply(id, status, reason = null) {
  await pool.query(`UPDATE ig_flow_noreply SET status = $2, reason = $3, done_at = now() WHERE id = $1`, [id, status, reason]);
}
// Due timers: skip if they tapped / clicked / wrote back since, or the window closed;
// otherwise continue the run from that message along "noreply".
async function fireNoReplies() {
  const { rows: due } = await pool.query(
    `SELECT id FROM ig_flow_noreply WHERE status = 'pending' AND due_at <= now() ORDER BY due_at LIMIT 20`);
  for (const { id } of due) {
    const { rows: [t] } = await pool.query(`UPDATE ig_flow_noreply SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING *`, [id]);
    if (!t) continue;
    try {
      const { rows: [run] } = await pool.query('SELECT * FROM ig_flow_runs WHERE id = $1', [t.run_id]);
      const flow = run && await getFlow(run.flow_id);
      if (!run || !flow || !flow.active) { await doneNoReply(t.id, 'skipped', 'automation off'); continue; }
      if (!nextNode(flow.graph, t.node_id, 'noreply')) { await doneNoReply(t.id, 'skipped', 'path removed'); continue; }
      const { rows: [st] } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM ig_flow_events WHERE run_id = $1 AND kind IN ('tap','input') AND created_at >= $4) AS tapped,
                EXISTS (SELECT 1 FROM ig_automation_links WHERE flow_id = $2 AND peer_id = $3 AND clicked_at >= $4) AS clicked,
                EXISTS (SELECT 1 FROM instagram_messages WHERE account_id = $5 AND sender_id = $3 AND direction = 'incoming' AND ts > $4) AS replied,
                GREATEST($6::timestamptz, (SELECT MAX(ts) FROM instagram_messages WHERE account_id = $5 AND sender_id = $3 AND direction = 'incoming'))
                  + interval '23 hours 45 minutes' > now() AS in_window`,
        [run.id, run.flow_id, run.peer_id, t.armed_at, run.account_id, run.last_inbound_at || t.armed_at]);
      if (st.tapped || st.clicked) { await doneNoReply(t.id, 'skipped', 'they tapped'); continue; }
      if (st.replied) { await doneNoReply(t.id, 'skipped', 'they replied'); continue; }
      if (!st.in_window) { await doneNoReply(t.id, 'skipped', "outside Meta's 24 h window"); continue; }
      if (await overCap(run.account_id)) {
        await pool.query(`UPDATE ig_flow_noreply SET status = 'pending', due_at = now() + interval '5 minutes' WHERE id = $1`, [t.id]);
        continue;
      }
      await doneNoReply(t.id, 'fired');
      run.vars = run.vars || {};
      run.vars._needs_reply = false;
      await event(run, t.node_id, 'noreply', 'no response');
      await advance(flow, run, t.node_id, 'noreply');
      console.log(`[flow] ${flow.id} "${flow.name}" run ${run.id}: no response → follow-up path`);
    } catch (e) {
      await doneNoReply(t.id, 'skipped', clip(e.message, 300)).catch(() => {});
      console.warn(`[flow] no-response ${t.id} failed: ${e.message}`);
    }
  }
}

// Resume delayed runs; expire conversations that can no longer be answered.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await ensureSchema();
    await pool.query(`UPDATE ig_flow_runs SET status = 'expired', updated_at = now()
      WHERE status IN ('await_input','await_reply') AND updated_at < now() - interval '24 hours'`);
    const { rows } = await pool.query(
      `UPDATE ig_flow_runs SET status = 'running', updated_at = now()
        WHERE id IN (SELECT id FROM ig_flow_runs WHERE status = 'delayed' AND wait_until <= now() ORDER BY wait_until LIMIT 20)
        RETURNING *`);
    for (const run of rows) {
      const flow = await getFlow(run.flow_id);
      if (!flow || !flow.active) { await saveRun(run, { status: 'stopped' }); continue; }
      await advance(flow, run, run.node_id, 'next').catch(e => console.warn('[flow] resume failed:', e.message));
    }
    await fireNoReplies();
  } catch (e) { console.warn('[flow] tick failed:', e.message); }
  finally { ticking = false; }
}
function start() {
  setInterval(tick, 30000).unref?.();
}

async function deleteUserData(userId) {
  if (!userId) return;
  await ensureSchema();
  await pool.query('DELETE FROM ig_flow_noreply WHERE peer_id = $1', [userId]);
  await pool.query('DELETE FROM ig_flow_runs WHERE peer_id = $1', [userId]);
  await pool.query('DELETE FROM ig_contact_fields WHERE peer_id = $1', [userId]);
}

// ── CRUD + reads ────────────────────────────────────────────
function cleanGraph(g) {
  const nodes = Array.isArray(g?.nodes) ? g.nodes : [];
  const edges = Array.isArray(g?.edges) ? g.edges : [];
  if (nodes.length > 200) throw new Error('graph must have at most 200 steps');
  if (nodes.filter(n => n.type === 'trigger').length !== 1) throw new Error('graph must have exactly one trigger step');
  const ids = new Set(nodes.map(n => n.id));
  return {
    nodes: nodes.map(n => ({ id: String(n.id), type: String(n.type), position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 }, data: n.data || {} })),
    edges: edges.filter(e => ids.has(e.source) && ids.has(e.target))
      .map(e => ({ id: String(e.id || rid()), source: String(e.source), sourceHandle: e.sourceHandle || 'next', target: String(e.target) })),
  };
}

async function listFlows(accountId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.account_id, f.active, f.template, f.created_at, f.updated_at, f.graph,
            a.username AS account_username,
            (SELECT COUNT(*)::int FROM ig_flow_runs r WHERE r.flow_id = f.id) AS runs,
            (SELECT COUNT(DISTINCT send_id)::int FROM ig_automation_links k WHERE k.flow_id = f.id) AS link_sends,
            (SELECT COUNT(DISTINCT send_id)::int FROM ig_automation_links k WHERE k.flow_id = f.id AND k.clicked_at IS NOT NULL) AS clicks,
            (SELECT MAX(created_at) FROM ig_flow_runs r WHERE r.flow_id = f.id) AS last_run_at
       FROM ig_flows f LEFT JOIN instagram_accounts a ON a.account_id = f.account_id
      WHERE ($1::text IS NULL OR f.account_id = $1)
      ORDER BY f.updated_at DESC`, [accountId || null]);
  return rows;
}

async function createFlow(body) {
  await ensureSchema();
  if (!body.name || !body.account_id) throw new Error('name and account_id are required');
  const graph = cleanGraph(body.graph);
  const { rows } = await pool.query(
    'INSERT INTO ig_flows (name, account_id, active, graph, template) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [clip(body.name, 120), body.account_id, !!body.active, JSON.stringify(stampNext(graph, body.active)), body.template || null]);
  return rows[0];
}

// "Next post" triggers lock onto the first post published after going live.
function stampNext(graph, active) {
  const t = triggerNode(graph);
  for (const x of t?.data?.triggers || []) if (x.kind === 'comment' && x.postMode === 'next' && active && !x.since) x.since = new Date().toISOString();
  return graph;
}

async function updateFlow(id, body) {
  await ensureSchema();
  const cur = await getFlow(id);
  if (!cur) return null;
  const graph = body.graph ? cleanGraph(body.graph) : cur.graph;
  const active = body.active !== undefined ? !!body.active : cur.active;
  const { rows } = await pool.query(
    `UPDATE ig_flows SET name = $2, account_id = $3, active = $4, graph = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, clip(body.name ?? cur.name, 120), body.account_id || cur.account_id, active, JSON.stringify(stampNext(graph, active))]);
  if (!active) await pool.query(`UPDATE ig_flow_runs SET status = 'stopped' WHERE flow_id = $1 AND status IN ('delayed','await_input','await_reply')`, [id]);
  return rows[0];
}

async function deleteFlow(id) {
  await ensureSchema();
  const { rowCount } = await pool.query('DELETE FROM ig_flows WHERE id = $1', [id]);
  return rowCount > 0;
}

async function flowInsights(id) {
  await ensureSchema();
  const [{ rows: [r] }, { rows: [k] }, { rows: perNode }, { rows: recent }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS runs,
                       COUNT(*) FILTER (WHERE status = 'done')::int AS completed,
                       COUNT(*) FILTER (WHERE status IN ('await_input','await_reply','delayed','running'))::int AS in_progress,
                       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
                  FROM ig_flow_runs WHERE flow_id = $1`, [id]),
    pool.query(`SELECT COUNT(DISTINCT send_id)::int AS link_sends,
                       COUNT(DISTINCT send_id) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicks
                  FROM ig_automation_links WHERE flow_id = $1`, [id]),
    pool.query(`SELECT node_id, kind, COUNT(*)::int AS n FROM ig_flow_events WHERE flow_id = $1 GROUP BY node_id, kind`, [id]),
    pool.query(`SELECT r.id, COALESCE(NULLIF(r.username, ''), u.username, c.username) AS username, COALESCE(u.name, c.name) AS name,
                       r.peer_id, r.trigger, r.status, r.error, r.created_at, r.updated_at
                  FROM ig_flow_runs r
                  LEFT JOIN instagram_users u ON u.igsid = r.peer_id
                  LEFT JOIN contacts c ON c.platform = 'instagram' AND c.account_id = r.account_id AND c.peer_id = r.peer_id
                 WHERE r.flow_id = $1 ORDER BY r.created_at DESC LIMIT 30`, [id]),
  ]);
  const sends = perNode.filter(x => x.kind === 'sent').reduce((a, x) => a + x.n, 0);
  return { ...r, sends, linkSends: k.link_sends, clicks: k.clicks, ctr: k.link_sends ? Math.round((k.clicks / k.link_sends) * 100) : null, perNode, recent };
}

// Models for the AI Step picker — every OpenRouter chat model (empty until OpenRouter is connected).
async function aiModels() {
  const openRouter = require('./openRouter');
  if (!await openRouter.getKey()) return { connected: false, models: [], defaultModel: DEFAULT_AI_MODEL };
  const list = await openRouter.chatModels().catch(() => []);
  return { connected: true, defaultModel: DEFAULT_AI_MODEL, models: list.map(m => ({ id: m.id, name: m.name, inPerM: +(m.prompt * 1e6).toFixed(3), outPerM: +(m.completion * 1e6).toFixed(3) })) };
}

module.exports = {
  ensureSchema, onComment, onMessaging, onMessagingTrigger, isHandling, deleteUserData, start, tick,
  listFlows, getFlow, createFlow, updateFlow, deleteFlow, flowInsights, aiModels, aiTest,
  _test: { validate, evalRule, matchKeywords, nextNode, fill, fireNoReplies, armNoReply, noReplySecs, advance, createRun },
};
