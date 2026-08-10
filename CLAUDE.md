# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other coding agents working in this repository.
Human contributors should read it too — it is the set of invariants that a plausible-looking change
can quietly break.

Start with [`README.md`](./README.md) for what the product does. This file is only about *how to
change it safely*.

---

## What this is

A self-hosted WhatsApp-native growth stack: Meta ad → click-to-WhatsApp conversation → lead →
funnel stage → payment, in one Express + React app over one PostgreSQL database.

Single-tenant by design. There is no workspace or organisation concept anywhere — every config
table is a singleton `id = 1` row. Do not add a `workspace_id` that would only ever hold one value.

## Stack and conventions

| | |
|---|---|
| Backend | Node.js 20, Express 4, **raw SQL via `pg`** — no ORM, no query builder |
| Frontend | React 18 + Vite, **inline styles only** — no Tailwind, no CSS modules |
| State | `useState` / `useEffect`. No Redux, no Zustand |
| Icons | `lucide-react` |
| Fonts | DM Sans for text, DM Mono for numbers |
| Types | Plain JS throughout. No TypeScript |

- **API responses are camelCase**, produced by aliasing in SQL (`col AS "colName"`), not by mapping
  in JS.
- **Errors are `{ error: "human readable message" }`** — never a stack trace, never a bare code.
- **Every frontend call goes through `frontend/src/api.js`.** Components do not call `fetch`.
- Match the file you are editing. Comment density, naming and structure vary between older and
  newer files; follow the local style rather than imposing one.

## Hard invariants

Breaking any of these produces a bug that looks like something else, which is why they are listed.

### The schema name is hardcoded

`coexistence` appears throughout the SQL. Isolation is **per-database**, not per-schema. Do not
parameterise it without changing every query.

### Queue names are hardcoded

Two deployments sharing one Redis server will consume each other's outbound WhatsApp sends unless
they use different Redis database indexes (`redis://redis:6379/0` vs `/1`).

### Stage changes are observed, not hooked

Eight code paths write `leads.stage`, several in raw SQL. Anything that must react to a stage change
walks the append-only `lead_events` log with a saved cursor (see `services/funnelTags.js`). This is
why a new write path is covered for free. **Add to that pattern; do not add a ninth hook** — the
ninth is the one someone forgets.

### Migrations run before the code that needs them

An extra column is ignored by the running backend, so a schema slightly ahead is harmless. Code
ahead of its schema throws on the first request touching the missing column. Migrations are plain
numbered SQL in `supabase/migrations/`, applied in filename order, and must be **idempotent**
(`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`s) because re-running them is the normal upgrade path.

Several tables are additionally created by `ensure*Tables()` functions that run at backend startup,
so a fresh deploy self-heals. **If you change such a table in a migration, change the matching
`ensure*Tables()` too** — otherwise behaviour differs between a fresh install and an upgrade.

### Never introduce a sentinel-value equality check

An unconfigured env var is `''`. Comparing it directly against a record field means `'' === ''`
evaluates true for every record that also lacks the value, silently matching everything. See
`isBridgedNumber()` in `routes/webhook.js`: it returns false when unconfigured, deliberately. Do not
replace it with a bare equality.

### Webhook handling must never throw

Meta retries on non-2xx and times out at 20 seconds. Attribution, analytics and agent work are all
best-effort around message ingestion: catch, log, continue. Anything slow (agent runs, media
downloads) goes on a queue rather than running inline.

### Phone numbers are digits-only

Normalised on insert by `normalizePhone()` in `services/metaPayload.js`. `+91…` and `91…` must not
become two chat threads.

### Capabilities are global, not per-token

MCP capability toggles apply immediately to every already-connected client. There is no per-key
scoping, and code must not imply there is.

### The MCP proxy canonicalises before it gates

`fetch()` strips dot-segments, so gating on the raw path string once let `/marketing/../users`
through as `area_marketing` and then delivered it to `/api/users`. Canonicalise **first**, gate on
the result. Any change there must keep "the path we check" identical to "the path the server
receives".

## Security rules

- **All SQL parameterised.** `pool.query('… WHERE id = $1', [id])`. No string interpolation, ever.
- **No default credentials.** The first admin's password comes from `BOOTSTRAP_ADMIN_PASSWORD` or is
  generated and printed once. A known credential in a public repo is a live vulnerability that
  scanners hunt for — do not reintroduce one, including in tests or fixtures.
- **Third-party credentials are encrypted at rest** with AES-256-GCM (`util/crypto.js`), keyed by
  `FORGECRM_ENCRYPTION_KEY`. New credential storage follows the same path.
- **Secrets compared in constant time** (`crypto.timingSafeEqual`) — webhook verify tokens already do.
- **Never commit a real credential, hostname, phone number or customer name**, including in
  comments, fixtures, test data or migration seeds. Use `example.com` and `919876543210`.

## Working in this repo

```bash
./scripts/install.sh          # full stack from nothing; safe to re-run
./scripts/migrate.sh          # apply migrations
cd backend  && npm test       # node:test; DB-backed tests skip without a database
cd backend  && npm run lint   # eslint, zero-problem bar
cd frontend && npm run test:unit
cd frontend && npm run lint
docker compose logs -f frontend
```

**A green `npm test` without a database means less than it looks like.** 92 of the 255 backend tests
are DB-backed and skip when Postgres is unreachable. CI sets `REQUIRE_DB=1`, which turns that skip
into a failure — set it locally too when you want the real answer.

Linting is scoped to the class of mistake that reaches production and only then throws: an
identifier that does not exist, a duplicated object key, an unreachable branch. It is not a
formatter, and adding formatting rules would produce a reformat-the-world diff that hides real
changes. `frontend/eslint.config.mjs` documents the one rule that is deliberately off and what
turning it on would involve.

- **Scope changes tightly.** When fixing one thing, do not restyle adjacent components in the same
  diff.
- **Confirm before destructive database operations.** `DROP`, `DELETE`, truncate — take a dump first,
  even on data that looks like test data.
- **File-upload UI needs Ctrl+V paste support** in the same change, not as a follow-up.
- Prefer a fix at the layer where the invariant lives over a patch at each call site.

## Frontend specifics

- Colour tokens come from `constants.js` (`C.primary`, `C.border`, …). Do not hardcode hex values.
- Loading states are shimmer skeletons, not full-page spinners.
- Errors surface in a blocking modal via the global feedback bus — not `alert()`, not a toast.
  Success and info may be toasts.
- Destructive actions use the `useConfirm()` hook, never the browser's `confirm()`.
- Admin-only navigation is gated on `user?.role === 'admin'`.
- Charts get hover tooltips on every point, bar and cell.

## Layout

```
backend/src/
  index.js         bootstrap, middleware order, route mounting, cron intervals
  auth.js          JWT cookie auth, user table, first-run admin
  db.js            pg Pool (accepts POSTGRES_* or DB_*; POSTGRES_* wins)
  llm/             provider adapters behind one runWithTools() contract
  engine/          automationEngine (flow blocks) · agentEngine (LLM tool loop)
  integrations/    Meta send/media/templates, Google
  queue/           BullMQ workers: send · media · agent runs
  routes/          HTTP surface, one file per area
  services/        logic shared by UI routes and MCP — put it here, not in a route
    metaPayload.js   raw Meta webhook payload → message records (pure; the
                     ingestion contract, covered by test/metaPayload.unit.test.js)
frontend/src/
  api.js           the only place fetch is called
  components/      chat UI, automation builder, agent editor
  pages/           marketing/ · sales/ · admin · chats
supabase/migrations/   numbered SQL
scripts/               install · uninstall · migrate · generate-secrets
```

When a capability must be reachable from both the UI and MCP, implement it once in `services/` and
call it from both. `agentService.js` and `mcpService.js` are the model to follow.
