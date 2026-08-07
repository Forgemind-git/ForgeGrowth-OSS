// Shared date sorting for the entity list pages (Automations, AI Agents,
// Projects, Follow-ups, Templates, Forms).
//
// Why the caller passes ACCESSORS instead of a field name: these six endpoints
// do not agree on key casing. `agents`, `projects`, `follow-up-sequences` and
// `lead-forms` return camelCase (`createdAt`), while `chatbots` and `templates`
// return raw Postgres rows (`created_at`). A helper that guessed one casing
// would sort exactly nothing on the other three — silently, since a comparator
// over `undefined` never reorders anything and the page still renders. So each
// page states its own field names and a wrong one is a visible bug, not a
// no-op. (Forge anti-pattern #35.)
//
// Sorting is done on a COPY. Array.prototype.sort mutates, and these lists are
// React state / props — sorting one in place edits the source array without a
// re-render, so the next render can disagree with what is on screen.

export const SORT_NEWEST = 'newest';
export const SORT_OLDEST = 'oldest';
export const SORT_UPDATED = 'updated';
export const SORT_NAME = 'name';

/** Default for every list: newest at the top, oldest at the bottom. */
export const DEFAULT_SORT = SORT_NEWEST;

export const LIST_SORT_OPTIONS = [
  { value: SORT_NEWEST, label: 'Newest first' },
  { value: SORT_OLDEST, label: 'Oldest first' },
  { value: SORT_UPDATED, label: 'Recently updated' },
  { value: SORT_NAME, label: 'Name A–Z' },
];

// A missing/unparseable timestamp becomes 0 rather than NaN. Every comparison
// against NaN is false, which leaves the rows in whatever order they arrived —
// so one null `created_at` would quietly scramble the list instead of parking
// that row at the end.
function time(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function text(value) {
  return String(value ?? '').toLowerCase();
}

/**
 * @param items     the list to sort (never mutated)
 * @param sort      one of the LIST_SORT_OPTIONS values
 * @param accessors { created, updated, name } — functions reading one item.
 *                  `updated` falls back to `created` when a list has no
 *                  meaningful updated timestamp.
 */
export function sortList(items, sort, accessors = {}) {
  if (!Array.isArray(items)) return items;
  const created = accessors.created || (() => null);
  const updated = accessors.updated || created;
  const name = accessors.name || (() => '');

  const copy = [...items];
  switch (sort) {
    case SORT_OLDEST:
      return copy.sort((a, b) => time(created(a)) - time(created(b)));
    case SORT_UPDATED:
      return copy.sort((a, b) => time(updated(b)) - time(updated(a)));
    case SORT_NAME:
      return copy.sort((a, b) => text(name(a)).localeCompare(text(name(b))));
    case SORT_NEWEST:
    default:
      return copy.sort((a, b) => time(created(b)) - time(created(a)));
  }
}
