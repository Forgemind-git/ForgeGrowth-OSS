// Date-range parsing + SQL helpers shared by the Marketing surfaces
// (/marketing/overview, /campaigns, /lead-sources, /ctwa/overview).
//
// Three modes, decided once here so every endpoint agrees on what a range means:
//   range — explicit ?from=YYYY-MM-DD and/or ?to=YYYY-MM-DD. Both are CALENDAR
//           DAYS IN Asia/Kolkata and BOTH ENDS ARE INCLUSIVE: `to` covers that
//           whole day. Comparing a timestamp against the bare date string would
//           drop everyone who arrived after midnight on the last day.
//   days  — the legacy rolling ?days=N (NOW() - N days). Kept exactly as before
//           because MCP clients and older callers send it.
//   all   — no bound at all.
// from/to win over days when both are sent.
//
// Every user value leaves here as a bound parameter; the SQL text only ever
// contains placeholders produced by the caller's `add()`.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date, not just the right shape — 2026-02-30 matches the regex
// and Postgres would reject it with a 500, so refuse it here with a sentence.
function validDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100;
}

/**
 * @param q            req.query
 * @param defaultDays  days to use when nothing is sent (null = all time)
 * @returns {{ error: string } | { mode: 'range'|'days'|'all', from: string|null, to: string|null, days: number|null }}
 */
function parseDateRange(q = {}, { defaultDays = null } = {}) {
  const from = q.from == null ? '' : String(q.from).trim();
  const to = q.to == null ? '' : String(q.to).trim();

  if (from || to) {
    if (from && !validDate(from)) return { error: `"${from.slice(0, 40)}" is not a valid start date. Use YYYY-MM-DD, for example 2026-09-01.` };
    if (to && !validDate(to)) return { error: `"${to.slice(0, 40)}" is not a valid end date. Use YYYY-MM-DD, for example 2026-09-30.` };
    // ISO dates compare correctly as strings.
    if (from && to && from > to) return { error: `The start date (${from}) is after the end date (${to}). Pick a start date on or before the end date.` };
    return { mode: 'range', from: from || null, to: to || null, days: null };
  }

  const raw = q.days == null ? '' : String(q.days).trim();
  if (raw === '' || raw === 'all' || raw === '0') {
    // An explicit empty/"all" means all time; a missing param falls to the default.
    if (q.days == null && defaultDays) return { mode: 'days', from: null, to: null, days: defaultDays };
    return { mode: 'all', from: null, to: null, days: null };
  }
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0 || String(days) !== raw) {
    return { error: `"${raw.slice(0, 40)}" is not a valid number of days. Send a whole number such as 30, or use from/to dates.` };
  }
  return { mode: 'days', from: null, to: null, days: Math.min(days, 3650) };
}

const isWindowed = (r) => r.mode !== 'all';

/**
 * Predicate for a TIMESTAMPTZ column. Returns '' for all-time.
 * `add(value)` must push the value onto the caller's params and return its placeholder.
 */
function timestampClause(r, col, add) {
  if (r.mode === 'days') return `${col} >= NOW() - (${add(String(r.days))} || ' days')::interval`;
  if (r.mode !== 'range') return '';
  const parts = [];
  // `timestamp AT TIME ZONE 'Asia/Kolkata'` reads the wall-clock day as IST and
  // yields the matching instant, so midnight-to-midnight is India's day.
  if (r.from) parts.push(`${col} >= (${add(r.from)}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (r.to) parts.push(`${col} < ((${add(r.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  return parts.join(' AND ');
}

/**
 * Predicate for a DATE column that already holds an IST calendar day
 * (ad_daily_stats.stat_date — Meta reports in the ad account's timezone).
 * In `days` mode the day that NOW() - N days lands on is included, matching the
 * partial day the timestamp predicate above also includes.
 */
function dateClause(r, col, add) {
  if (r.mode === 'days') return `${col} >= ((NOW() AT TIME ZONE 'Asia/Kolkata') - (${add(String(r.days))} || ' days')::interval)::date`;
  if (r.mode !== 'range') return '';
  const parts = [];
  if (r.from) parts.push(`${col} >= ${add(r.from)}::date`);
  if (r.to) parts.push(`${col} <= ${add(r.to)}::date`);
  return parts.join(' AND ');
}

/**
 * How much of the requested window the per-day spend table can actually answer.
 *
 * campaigns.spend / campaign_ads.spend are LIFETIME totals (the sync uses
 * date_preset=maximum) and can never be split by date. Windowed spend exists only
 * in ad_daily_stats, which the 6h sync keeps on a rolling window plus whatever a
 * backfill reached. A range that starts before the oldest daily row would silently
 * under-report spend, so this says so instead.
 *
 * `basis`: 'lifetime' for all-time (the lifetime totals are the right answer),
 * 'daily' for any window.
 */
async function spendCoverage(pool, r) {
  const { rows } = await pool.query(
    `SELECT MIN(stat_date)::text AS first_day, MAX(stat_date)::text AS last_day,
            (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today,
            CASE WHEN $1::int IS NULL THEN NULL
                 ELSE ((NOW() AT TIME ZONE 'Asia/Kolkata') - ($1::int || ' days')::interval)::date::text END AS days_from
       FROM coexistence.ad_daily_stats`,
    [r.mode === 'days' ? r.days : null]
  );
  const c = rows[0] || {};
  const firstDay = c.first_day || null;
  const lastDay = c.last_day || null;
  const rangeFrom = r.mode === 'range' ? r.from : r.mode === 'days' ? c.days_from : null;
  const rangeTo = r.mode === 'range' ? (r.to || c.today) : c.today;

  if (!isWindowed(r)) {
    return { basis: 'lifetime', firstDay, lastDay, rangeFrom: null, rangeTo: null, partial: false, noDailyData: !firstDay, note: null };
  }

  let partial = false;
  let note = null;
  if (!firstDay) {
    partial = true;
    note = 'No per-day spend has been synced from Meta yet, so spend for this range cannot be shown. Clicks, leads and revenue still follow the range.';
  } else if (!rangeFrom || rangeFrom < firstDay) {
    partial = true;
    note = `Per-day spend from Meta only goes back to ${firstDay}. Spend before that date is not included, so spend and cost figures for this range are too low.`;
  }
  return { basis: 'daily', firstDay, lastDay, rangeFrom, rangeTo, partial, noDailyData: !firstDay, note };
}

module.exports = { parseDateRange, isWindowed, timestampClause, dateClause, spendCoverage, validDate };
