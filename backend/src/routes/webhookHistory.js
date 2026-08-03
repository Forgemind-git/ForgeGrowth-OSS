// Webhook audit log surface — read + replay endpoints powering the Admin
// Settings → Webhooks tab. List is paginated + filterable; detail returns the
// full payload; replay re-POSTs the saved payload through the webhook handler
// (useful when debugging parser or trigger logic against a real-world payload).

const { Router } = require('express');
const pool = require('../db');

const router = Router();

// GET /api/webhook-events — paginated list with filters
// Query: limit, offset, status, kind, phoneNumberId, q (substring of payload), since, until
router.get('/webhook-events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const where = [];
    const params = [];
    const push = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

    if (req.query.status)         push('processing_status = ?', req.query.status);
    // kind accepts comma-separated values for multi-select
    if (req.query.kind) {
      const kinds = String(req.query.kind).split(',').filter(Boolean);
      if (kinds.length > 0) {
        const placeholders = kinds.map(k => { params.push(k); return `$${params.length}`; }).join(',');
        where.push(`payload_kind IN (${placeholders})`);
      }
    }
    // phone search matches the API side (phone_number_id OR display_phone_number)
    // OR the contact side (messages[].from / message_echoes[].to / statuses[].recipient_id).
    // Non-digits stripped from input so "+9193…" and "9193…" both match.
    if (req.query.phone) {
      const digits = String(req.query.phone).replace(/\D/g, '');
      if (digits) {
        params.push(`%${digits}%`);
        const p = `$${params.length}`;
        where.push(`(
          phone_number_id ILIKE ${p}
          OR regexp_replace(COALESCE(payload #>> '{entry,0,changes,0,value,metadata,display_phone_number}', ''), '[^0-9]', '', 'g') ILIKE ${p}
          OR regexp_replace(COALESCE(payload #>> '{entry,0,changes,0,value,messages,0,from}', ''), '[^0-9]', '', 'g') ILIKE ${p}
          OR regexp_replace(COALESCE(payload #>> '{entry,0,changes,0,value,message_echoes,0,to}', ''), '[^0-9]', '', 'g') ILIKE ${p}
          OR regexp_replace(COALESCE(payload #>> '{entry,0,changes,0,value,statuses,0,recipient_id}', ''), '[^0-9]', '', 'g') ILIKE ${p}
        )`);
      }
    }
    if (req.query.source)         push('source = ?', req.query.source);
    if (req.query.since)          push('received_at >= ?', req.query.since);
    if (req.query.until)          push('received_at <= ?', req.query.until);
    if (req.query.q)              push('payload::text ILIKE ?', `%${req.query.q}%`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT id, received_at, source, remote_ip, payload_kind, payload_subtype,
                records_extracted, processing_status, processing_error,
                processing_ms, phone_number_id,
                regexp_replace(COALESCE(payload #>> '{entry,0,changes,0,value,metadata,display_phone_number}', ''), '[^0-9]', '', 'g') AS display_phone_number,
                regexp_replace(COALESCE(
                  payload #>> '{entry,0,changes,0,value,messages,0,from}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,to}',
                  payload #>> '{entry,0,changes,0,value,statuses,0,recipient_id}',
                  ''
                ), '[^0-9]', '', 'g') AS contact_phone,
                COALESCE(
                  payload #>> '{entry,0,changes,0,value,messages,0,text,body}',
                  payload #>> '{entry,0,changes,0,value,messages,0,image,caption}',
                  payload #>> '{entry,0,changes,0,value,messages,0,video,caption}',
                  payload #>> '{entry,0,changes,0,value,messages,0,document,filename}',
                  payload #>> '{entry,0,changes,0,value,messages,0,interactive,button_reply,title}',
                  payload #>> '{entry,0,changes,0,value,messages,0,interactive,list_reply,title}',
                  payload #>> '{entry,0,changes,0,value,messages,0,reaction,emoji}',
                  payload #>> '{entry,0,changes,0,value,messages,0,location,name}',
                  payload #>> '{entry,0,changes,0,value,messages,0,contacts,0,name,formatted_name}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,text,body}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,image,caption}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,video,caption}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,document,filename}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,interactive,button_reply,title}',
                  payload #>> '{entry,0,changes,0,value,message_echoes,0,reaction,emoji}',
                  payload #>> '{entry,0,changes,0,value,statuses,0,errors,0,message}',
                  payload #>> '{entry,0,changes,0,value,message_template_status_update,message_template_name}',
                  payload #>> '{entry,0,changes,0,value,statuses,0,status}'
                ) AS payload_preview
           FROM coexistence.webhook_events
           ${whereSql}
          ORDER BY received_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.webhook_events ${whereSql}`, params),
    ]);

    // Also emit per-kind + per-status counts (for the filter chips)
    const { rows: counts } = await pool.query(
      `SELECT payload_kind, processing_status, COUNT(*)::int AS n
         FROM coexistence.webhook_events
        WHERE received_at > NOW() - INTERVAL '7 days'
        GROUP BY payload_kind, processing_status`
    );

    res.json({ events: rows, total, limit, offset, counts });
  } catch (err) {
    console.error('[webhook-history] list error:', err.message);
    res.status(500).json({ error: 'Failed to load webhook events' });
  }
});

// GET /api/webhook-events/:id — full payload + headers
router.get('/webhook-events/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.webhook_events WHERE id = $1`, [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[webhook-history] get error:', err.message);
    res.status(500).json({ error: 'Failed to load webhook event' });
  }
});

// POST /api/webhook-events/:id/replay — re-post the saved payload through the
// webhook handler. Tagged with X-Replay: 1 so the audit row is marked as a
// replay rather than a fresh Meta delivery.
router.post('/webhook-events/:id/replay', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT payload FROM coexistence.webhook_events WHERE id = $1`, [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const port = process.env.PORT || 3011;
    const r = await fetch(`http://localhost:${port}/api/webhook/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Replay': '1',
        'User-Agent': `forgecrm-replay/${req.params.id}`,
      },
      body: JSON.stringify(rows[0].payload),
    });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
    res.json({ ok: r.ok, status: r.status, response: parsed });
  } catch (err) {
    console.error('[webhook-history] replay error:', err.message);
    res.status(500).json({ error: 'Replay failed: ' + err.message });
  }
});

// DELETE /api/webhook-events/:id — manual cleanup
router.delete('/webhook-events/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM coexistence.webhook_events WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook-history] delete error:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = { router };
