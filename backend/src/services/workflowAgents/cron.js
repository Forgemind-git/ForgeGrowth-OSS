// Five-field cron, evaluated in Asia/Kolkata (IST has no DST, so a fixed +05:30 is exact).
//   minute hour day-of-month month day-of-week      (day-of-week: 0 or 7 = Sunday)
// Supports *, lists (1,2), ranges (1-5), steps (*/15, 10-18/2). When both
// day-of-month and day-of-week are restricted, either may match (standard cron).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(src, { name, min, max }) {
  const values = new Set();
  for (const part of String(src).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Invalid ${name} "${part}".`);
    let lo = min; let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a; hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`The ${name} "${part}" is out of range (${min}-${max}).`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** @returns {{ fields: Set<number>[], restrictedDom: boolean, restrictedDow: boolean }} or throws with a sentence. */
function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week.');
  const fields = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (fields[4].has(7)) fields[4].add(0);
  return { fields, restrictedDom: parts[2] !== '*', restrictedDow: parts[4] !== '*' };
}

function istParts(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
}

function matches(parsed, date) {
  const p = istParts(date);
  const [mi, h, dom, mo, dow] = parsed.fields;
  if (!mi.has(p.minute) || !h.has(p.hour) || !mo.has(p.month)) return false;
  const domOk = dom.has(p.dom);
  const dowOk = dow.has(p.dow);
  if (parsed.restrictedDom && parsed.restrictedDow) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Slots (minute-aligned instants) matching the cron in (after, until]. Bounded so a
 * long outage cannot enumerate millions of minutes: only the most recent slot is
 * returned when more than one was missed — a daily report should run once on
 * recovery, not once per missed day.
 */
function dueSlot(expr, after, until) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  const end = Math.floor(until.getTime() / 60000) * 60000;
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  const maxScan = 60 * 24 * 7; // one week of minutes
  for (let t = end, n = 0; t >= start && n < maxScan; t -= 60000, n += 1) {
    if (matches(parsed, new Date(t))) return new Date(t);
  }
  return null;
}

/** Next matching instant after `from` (for display), searching at most ~2 months. */
function nextRun(expr, from = new Date()) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let n = 0; n < 60 * 24 * 62; n += 1, t += 60000) if (matches(parsed, new Date(t))) return new Date(t);
  return null;
}

/** "Daily 08:00 IST" style summary for the common shapes; the raw expression otherwise. */
function describeCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, h, dom, mo, dow] = parts;
  const days = { '*': null, '1-5': 'Mon–Fri', '1-6': 'Mon–Sat', '0': 'Sundays', '7': 'Sundays', '1': 'Mondays', '2': 'Tuesdays', '3': 'Wednesdays', '4': 'Thursdays', '5': 'Fridays', '6': 'Saturdays' };
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mo === '*' && dow in days) {
    const time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} IST`;
    return days[dow] ? `${days[dow]} ${time}` : `Daily ${time}`;
  }
  const step = /^(\d+)-(\d+)\/(\d+)$/.exec(h);
  if (/^\d+$/.test(mi) && step && dom === '*' && mo === '*') {
    return `Every ${step[3]}h ${step[1]}:${String(mi).padStart(2, '0')}–${step[2]}:${String(mi).padStart(2, '0')} IST${days[dow] ? ` ${days[dow]}` : ''}`;
  }
  return `${expr} (IST)`;
}

module.exports = { parseCron, matches, dueSlot, nextRun, describeCron, istParts };
