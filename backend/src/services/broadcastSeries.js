// Repeating broadcasts.
//
// A series is "every Monday at 10am, message whoever matches this rule". It is
// deliberately NOT a broadcast with a repeat flag:
//
//   - a one-off has a FROZEN recipient list and fires once;
//   - a series has an audience RULE, re-resolved on every run, and fires until
//     its end condition.
//
// ⚠ A SERIES NEVER SENDS ANYTHING ITSELF. Each run inserts a normal `broadcasts`
// row and hands it to `dispatchBroadcast()` — the same function the manual
// button and the one-off scheduler call. So there is one sender in the codebase,
// a repeating send shows up in the Bulk Message list with its own delivery
// stats, and every guard the one-off path enforces (WABA match, billing block,
// the 24h window, per-recipient logging) applies unchanged.

const pool = require('../db');

// Every schedule in this app is expressed in IST; a series' timeOfDay is a
// wall-clock time in that zone, not UTC.
const TZ = 'Asia/Kolkata';

const KINDS = ['daily', 'weekly', 'monthly'];

/* ------------------------------- validation ------------------------------- */

function parseTimeOfDay(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const hh = Number(m[1]); const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Normalise the recurrence rule, or throw a sentence.
 *
 * daysOfWeek uses ISO numbering (1=Mon … 7=Sun) — the same convention Postgres
 * `isodow` uses, so the two never need translating between.
 */
function normalizeRecurrence(raw = {}) {
  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) throw Object.assign(new Error('Pick how often this repeats (daily, weekly or monthly).'), { status: 400 });

  const t = parseTimeOfDay(raw.timeOfDay);
  if (!t) throw Object.assign(new Error('Pick a time of day in HH:MM (24-hour).'), { status: 400 });

  const out = { kind, timeOfDay: `${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}` };

  if (kind === 'weekly') {
    const days = Array.isArray(raw.daysOfWeek)
      ? [...new Set(raw.daysOfWeek.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7))].sort()
      : [];
    if (days.length === 0) {
      throw Object.assign(new Error('Pick at least one day of the week.'), { status: 400 });
    }
    out.daysOfWeek = days;
  }
  if (kind === 'monthly') {
    const dom = parseInt(raw.dayOfMonth, 10);
    // Capped at 28 rather than 31: a series set to the 31st would silently skip
    // February and every 30-day month, which reads as "it stopped working".
    if (!(dom >= 1 && dom <= 28)) {
      throw Object.assign(new Error('Pick a day of the month between 1 and 28, so every month can fire it.'), { status: 400 });
    }
    out.dayOfMonth = dom;
  }
  return out;
}

/** Normalise the audience rule. Windows are RELATIVE — see the module header. */
function normalizeAudience(raw = {}) {
  const a = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const posInt = (v, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
  };
  return {
    scope: a.scope === 'all' ? 'all' : 'number',
    waNumber: a.waNumber ? String(a.waNumber) : null,
    tagIds: Array.isArray(a.tagIds) ? [...new Set(a.tagIds.map(String).filter(Boolean))].slice(0, 50) : [],
    // "arrived in the last N days" — the window that makes a weekly series
    // target new people rather than the same list forever.
    arrivedWithinDays: posInt(a.arrivedWithinDays, 3650),
    // "hasn't replied for N days" — re-engagement. Someone who has NEVER
    // replied also qualifies; see the SQL below.
    notRepliedForDays: posInt(a.notRepliedForDays, 3650),
  };
}

/* ------------------------------ next run time ----------------------------- */

/**
 * The next moment this series should fire, strictly AFTER `after`.
 *
 * ⚠ Computed in SQL rather than in JS, deliberately. The time of day is IST
 * wall-clock, and Postgres already does that conversion correctly everywhere
 * else in this codebase (`date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')
 * AT TIME ZONE 'Asia/Kolkata'`). Re-deriving it in JS from the container's
 * clock — which runs UTC — is how a send lands 5.5 hours out.
 *
 * Strictly after, never equal: computing from the run that just fired must move
 * forward, or a daily series would re-fire the same slot on the next tick.
 */
async function computeNextRun(recurrence, after = null) {
  const r = recurrence || {};
  const t = parseTimeOfDay(r.timeOfDay) || { hh: 10, mm: 0 };

  // Candidate slots for the next 400 days at the configured local time, then
  // the first one that is in the future AND matches the day rule.
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT COALESCE($1::timestamptz, NOW()) AS after_ts
     ),
     slots AS (
       SELECT ((d::date + make_time($2::int, $3::int, 0)) AT TIME ZONE $4) AS slot_ts,
              d::date AS slot_date
         FROM base,
              generate_series(
                (base.after_ts AT TIME ZONE $4)::date - 1,
                (base.after_ts AT TIME ZONE $4)::date + 400,
                INTERVAL '1 day'
              ) d
     )
     SELECT slot_ts
       FROM slots, base
      WHERE slot_ts > base.after_ts
        AND CASE $5::text
              WHEN 'daily'   THEN TRUE
              WHEN 'weekly'  THEN EXTRACT(isodow FROM slot_date)::int = ANY($6::int[])
              WHEN 'monthly' THEN EXTRACT(day    FROM slot_date)::int = $7::int
              ELSE FALSE
            END
      ORDER BY slot_ts
      LIMIT 1`,
    [
      after ? new Date(after).toISOString() : null,
      t.hh, t.mm, TZ,
      r.kind || 'daily',
      Array.isArray(r.daysOfWeek) && r.daysOfWeek.length ? r.daysOfWeek : [1],
      r.dayOfMonth || 1,
    ],
  );
  return rows[0]?.slot_ts || null;
}

/* ------------------------------- the audience ----------------------------- */

/**
 * Who this series should message RIGHT NOW.
 *
 * Reads `contacts` because a broadcast recipient is a WhatsApp thread, not a
 * lead — you message a number. `last_inbound_at` is derived from inbound
 * chat_history, never `contacts.updated_at`, which background sweeps bump on
 * hundreds of rows at once (see the recipient-filter work).
 *
 * `skipAlreadySent` excludes anyone this series has already reached, which is
 * what stops a weekly run re-hitting last week's people.
 */
async function resolveAudience(series) {
  const a = normalizeAudience(series.audience);
  const params = [];
  const where = [`COALESCE(c.name, c.profile_name) IS NOT NULL`, `COALESCE(c.name, c.profile_name) <> ''`];

  if (a.scope !== 'all') {
    const num = a.waNumber || series.from_number;
    params.push(num);
    where.push(`c.wa_number = $${params.length}`);
  }

  if (a.tagIds.length) {
    params.push(a.tagIds);
    where.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(c.tags)='array' THEN c.tags ELSE '[]'::jsonb END
      ) tg WHERE tg->>'id' = ANY($${params.length}::text[])
    )`);
  }

  if (a.arrivedWithinDays) {
    params.push(a.arrivedWithinDays);
    where.push(`c.created_at >= NOW() - ($${params.length} * INTERVAL '1 day')`);
  }

  if (a.notRepliedForDays) {
    params.push(a.notRepliedForDays);
    // Someone who has NEVER replied also counts as "not replied for N days" —
    // otherwise a re-engagement series silently skips exactly the coldest
    // people it exists to reach.
    where.push(`(li.last_inbound_at IS NULL OR li.last_inbound_at < NOW() - ($${params.length} * INTERVAL '1 day'))`);
  }

  if (series.skip_already_sent !== false) {
    params.push(series.id);
    where.push(`NOT EXISTS (
      SELECT 1 FROM coexistence.broadcast_series_sends s
       WHERE s.series_id = $${params.length} AND s.contact_number = c.contact_number
    )`);
  }

  const cap = Math.max(1, Math.min(5000, parseInt(series.max_per_run, 10) || 500));

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.contact_number)
            c.contact_number, COALESCE(c.name, c.profile_name) AS name
       FROM coexistence.contacts c
       LEFT JOIN LATERAL (
         SELECT MAX(ch.timestamp) AS last_inbound_at
           FROM coexistence.chat_history ch
          WHERE ch.wa_number = c.wa_number
            AND ch.contact_number = c.contact_number
            AND ch.direction = 'incoming'
       ) li ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY c.contact_number, c.updated_at DESC NULLS LAST
      LIMIT ${cap}`,
    params,
  );
  return rows.map(r => ({ contact_number: r.contact_number, name: r.name }));
}

/* --------------------------------- the tick ------------------------------- */

/**
 * Fire every series whose next_run_at has arrived.
 *
 * ⚠ The claim is a single atomic UPDATE … RETURNING, exactly like
 * runDueBroadcasts(). Postgres row-locks each match, so two overlapping ticks —
 * or a second backend instance — can never fire the same series twice. The
 * claim ALSO advances next_run_at in the same statement, so a slow dispatch
 * cannot leave the row due and get re-claimed mid-flight.
 *
 * The advance is computed per row afterwards; the claim parks next_run_at in
 * the future first (NOW() + 1 minute is enough to close the re-claim window)
 * and the real next slot is written once the run completes.
 */
async function runDueSeries() {
  const { rows: claimed } = await pool.query(
    `UPDATE coexistence.broadcast_series
        SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW()
      WHERE active = TRUE
        AND next_run_at IS NOT NULL
        AND next_run_at <= NOW()
      RETURNING *`
  );
  if (claimed.length === 0) return { fired: 0 };

  let fired = 0;
  for (const series of claimed) {
    try {
      const result = await runSeriesOnce(series);
      if (result.sent) fired++;
    } catch (err) {
      console.error(`[series] #${series.id} "${series.name}" threw: ${err.message}`);
      await recordRun(series.id, { status: 'failed', note: err.message });
      await pool.query(
        `UPDATE coexistence.broadcast_series SET last_error = $2, updated_at = NOW() WHERE id = $1`,
        [series.id, String(err.message).slice(0, 500)],
      );
      await advance(series);
    }
  }
  return { fired };
}

/** One run: resolve → create a real broadcast → dispatch → record → advance. */
async function runSeriesOnce(series) {
  const recipients = await resolveAudience(series);

  if (recipients.length === 0) {
    // A legitimate outcome ("nobody new this week"), NOT a failure — recorded
    // as skipped so the history explains the quiet week rather than showing an
    // alarming gap.
    await recordRun(series.id, { status: 'skipped', note: 'Nobody matched the audience rule this run', count: 0 });
    await advance(series);
    return { sent: false, reason: 'empty' };
  }

  const { rows: bRows } = await pool.query(
    `INSERT INTO coexistence.broadcasts
       (from_number, recipient_numbers, template_id, status, name,
        variable_mapping, message_type, body, url, media_library_id, caption, updated_at)
     VALUES ($1,$2,$3,'SENDING',$4,$5,$6,$7,$8,$9,$10, NOW())
     RETURNING id`,
    [
      series.from_number,
      JSON.stringify(recipients),
      series.template_id || null,
      `${series.name} · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
      JSON.stringify(series.variable_mapping || {}),
      series.message_type || 'template',
      series.body || null,
      series.url || null,
      series.media_library_id || null,
      series.caption || null,
    ],
  );
  const broadcastId = bRows[0].id;

  // preClaimed: the INSERT already set SENDING, so dispatchBroadcast must not
  // re-claim it — the same contract runDueBroadcasts uses.
  const { dispatchBroadcast } = require('../routes/broadcasts');
  const result = await dispatchBroadcast(broadcastId, { preClaimed: true });

  if (!result.ok) {
    await pool.query(`UPDATE coexistence.broadcasts SET status='FAILED', updated_at=NOW() WHERE id=$1`, [broadcastId]);
    await recordRun(series.id, { status: 'failed', broadcastId, note: result.error, count: recipients.length });
    await pool.query(
      `UPDATE coexistence.broadcast_series SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [series.id, String(result.error).slice(0, 500)],
    );
    await advance(series);
    return { sent: false, reason: result.error };
  }

  // Ledger the people we reached, so the next run skips them. ON CONFLICT DO
  // NOTHING because the PRIMARY KEY is the real guard — a concurrent run must
  // not error here, it must simply not double-record.
  if (recipients.length) {
    await pool.query(
      `INSERT INTO coexistence.broadcast_series_sends (series_id, contact_number)
       SELECT $1, x FROM unnest($2::text[]) AS x
       ON CONFLICT (series_id, contact_number) DO NOTHING`,
      [series.id, recipients.map(r => r.contact_number)],
    );
  }

  await recordRun(series.id, { status: 'sent', broadcastId, count: result.enqueued ?? recipients.length });
  await pool.query(
    `UPDATE coexistence.broadcast_series SET last_error = NULL, updated_at = NOW() WHERE id = $1`, [series.id],
  );
  await advance(series);
  console.log(`[series] #${series.id} "${series.name}" → ${result.enqueued} recipient(s) via broadcast #${broadcastId}`);
  return { sent: true, broadcastId, count: result.enqueued };
}

async function recordRun(seriesId, { status, broadcastId = null, note = null, count = 0 }) {
  await pool.query(
    `INSERT INTO coexistence.broadcast_series_runs (series_id, broadcast_id, status, note, recipient_count)
     VALUES ($1,$2,$3,$4,$5)`,
    [seriesId, broadcastId, status, note ? String(note).slice(0, 500) : null, count],
  );
}

/**
 * Move a series to its next slot, or retire it.
 *
 * ⚠ The end condition is checked AFTER incrementing, against the row's own
 * fresh counter — not against the copy claimed at the top of the tick, which is
 * already stale by one run.
 */
async function advance(series) {
  const { rows } = await pool.query(
    `UPDATE coexistence.broadcast_series
        SET runs_count = runs_count + 1, last_run_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING runs_count, max_runs, ends_on, recurrence`,
    [series.id],
  );
  const row = rows[0];
  if (!row) return;

  const hitMaxRuns = row.max_runs != null && row.runs_count >= row.max_runs;
  const next = await computeNextRun(row.recurrence, new Date());
  const pastEnd = row.ends_on && next && new Date(next) > new Date(`${row.ends_on}T23:59:59.999+05:30`);

  if (hitMaxRuns || pastEnd || !next) {
    await pool.query(
      `UPDATE coexistence.broadcast_series
          SET active = FALSE, next_run_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [series.id],
    );
    console.log(`[series] #${series.id} finished (${hitMaxRuns ? 'max runs reached' : 'past its end date'})`);
    return;
  }
  await pool.query(
    `UPDATE coexistence.broadcast_series SET next_run_at = $2, updated_at = NOW() WHERE id = $1`,
    [series.id, next],
  );
}

/** Boot self-heal, mirroring migration 105. Purely additive. */
async function ensureSeriesTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.broadcast_series (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      from_number TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'template',
      template_id BIGINT REFERENCES coexistence.message_templates(id) ON DELETE SET NULL,
      variable_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
      body TEXT,
      url TEXT,
      media_library_id BIGINT REFERENCES coexistence.media_library(id) ON DELETE SET NULL,
      caption TEXT,
      audience JSONB NOT NULL DEFAULT '{}'::jsonb,
      recurrence JSONB NOT NULL DEFAULT '{}'::jsonb,
      skip_already_sent BOOLEAN NOT NULL DEFAULT TRUE,
      max_per_run INT NOT NULL DEFAULT 500,
      ends_on DATE,
      max_runs INT,
      runs_count INT NOT NULL DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      last_error TEXT,
      created_by BIGINT REFERENCES coexistence.forgecrm_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broadcast_series_due
      ON coexistence.broadcast_series (next_run_at) WHERE active AND next_run_at IS NOT NULL;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.broadcast_series_runs (
      id BIGSERIAL PRIMARY KEY,
      series_id BIGINT NOT NULL REFERENCES coexistence.broadcast_series(id) ON DELETE CASCADE,
      broadcast_id BIGINT REFERENCES coexistence.broadcasts(id) ON DELETE SET NULL,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recipient_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'sent',
      note TEXT
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broadcast_series_runs_series
      ON coexistence.broadcast_series_runs (series_id, ran_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coexistence.broadcast_series_sends (
      series_id BIGINT NOT NULL REFERENCES coexistence.broadcast_series(id) ON DELETE CASCADE,
      contact_number TEXT NOT NULL,
      first_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (series_id, contact_number)
    );`);
}

module.exports = {
  ensureSeriesTables,
  normalizeRecurrence,
  normalizeAudience,
  computeNextRun,
  resolveAudience,
  runDueSeries,
  runSeriesOnce,
  parseTimeOfDay,
};
