// Date helpers for the follow-up calendar. Every date here is an IST CALENDAR
// DAY as 'YYYY-MM-DD' — the same shape the backend stores (a DATE, not a
// timestamp), so a follow-up never slides a day for someone in another zone.

const IST_MS = 5.5 * 3600 * 1000;

export function todayIST(now = new Date()) {
  return new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD. */
export function weekday(ymd) { return new Date(`${ymd}T00:00:00Z`).getUTCDay(); }

/** The next given weekday strictly AFTER today (next Monday on a Monday = +7). */
export function nextWeekday(ymd, dow) {
  const diff = ((dow - weekday(ymd)) + 7) % 7 || 7;
  return addDays(ymd, diff);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Thu 25 Sep" */
export function shortDate(ymd) {
  if (!ymd) return '';
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Today", "Tomorrow", "Yesterday", "In 3 days", "2 days overdue", else the date. */
export function relativeDay(ymd, today = todayIST()) {
  if (!ymd) return '';
  const n = daysBetween(today, ymd);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n <= 6) return `In ${n} days`;
  if (n < -1) return `${-n} days overdue`;
  return shortDate(ymd);
}

/** "3:30 PM" from "15:30". */
export function time12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Quick picks shown as chips wherever a follow-up date is chosen. */
export function quickPicks(today = todayIST()) {
  return [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: addDays(today, 1) },
    { label: 'In 2 days', date: addDays(today, 2) },
    { label: 'In 3 days', date: addDays(today, 3) },
    { label: 'Next Mon', date: nextWeekday(today, 1) },
    { label: 'In a week', date: addDays(today, 7) },
    { label: 'In 2 weeks', date: addDays(today, 14) },
  ];
}

/** The 6×7 month grid (Monday-first) for the month containing `ymd`. */
export function monthGrid(ymd) {
  const first = `${ymd.slice(0, 7)}-01`;
  const lead = (weekday(first) + 6) % 7;            // Monday = 0
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
