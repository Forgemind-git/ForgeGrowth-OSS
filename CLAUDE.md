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

### One machine can hold several installs, and only the project name separates them

`docker-compose.yml` pins `name: forgegrowth`, and that name prefixes the containers **and the
volumes**. Two checkouts sharing it are not two installs — the second adopts the first one's
database, then points its own freshly generated secrets at it. `install.sh` records
`COMPOSE_PROJECT_NAME` per directory (`forgegrowth`, `forgegrowth-2`, …) to keep them apart;
`COMPOSE_PROJECT_NAME` in `.env` overrides the compose file's `name:`, which is why that file needs
no change.

Anything that inspects "the stack" must resolve the project the same way the user's shell does —
from the directory they are in — or it reports on somebody else's install.

### Start and stop go through `up.sh` / `down.sh`, and both layouts must keep working

Raw `docker compose up -d` skips the only two checks that catch the failures this
codebase actually suffers: a site that 404s while every container reports healthy, and a
second folder quietly adopting this install's database. Both scripts therefore verify the
public URL and refuse to run when another directory already owns this install's name.

They must work **beside `docker-compose.yml`** (an install running published images, which
has no `scripts/`) as well as **inside `scripts/`** (a source checkout). The name-resolution
helper is duplicated verbatim in both scripts rather than sourced from a third file — an
image-only install downloads them individually, and a third required file is a third chance
to end up with a broken install. Change one, change the other.

### A limit or a fix belongs in BOTH compose files

`docker-compose.yml` is the source path; `docker-compose.images.yml` is what a customer
actually runs. A memory ceiling, an env var or a service change added only to the first
reaches nobody who installed from images — which is every customer. The published file is
not a secondary copy; for the people paying for this, it is the whole product.

Memory ceilings default to ~1.5 GB total and are overridable per service from `.env`
(`BACKEND_MEM_LIMIT` and friends). A container that reaches its ceiling is killed and
restarted, so a limit set too low presents as a container that never finishes starting —
`up.sh` says so in its failure output rather than leaving that to be guessed.

### `.env` and the database are a pair

`POSTGRES_PASSWORD` is applied **only** when Postgres first creates its data directory, and
`FORGECRM_ENCRYPTION_KEY` is the only thing that decrypts stored third-party credentials. So a
regenerated `.env` cannot open an existing database, and the failure names the wrong thing: an
authentication error against the host, thirty retries deep, that reads as a network problem.
`run-migrations.js` treats `28P01` as terminal and explains it for exactly this reason — do not
turn it back into a retry.

Never generate fresh secrets over data that already exists. `install.sh` refuses that combination
rather than starting and failing later.

### The session cookie's `Secure` flag follows the URL, not `NODE_ENV`

Both compose files pin `NODE_ENV: production`, including on an install served over plain HTTP. A
`Secure` cookie sent to an `http://` origin is discarded by the browser with no error anywhere:
login returns 200, the SPA renders from the response body, and the *next* request arrives with no
cookie and gets 401. It reads as "logged out on refresh", never as a cookie problem.

`util/session.js` therefore derives `secure` from `TLS_DOMAIN` / `CORS_ORIGIN` — the address the
browser actually uses — with `COOKIE_SECURE` as the override for TLS terminated somewhere the
container cannot see. An unknown answer resolves to **false**: guessing wrong that way only loses
hardening, while guessing wrong the other way locks everyone out.

That file is also the single definition of the session signing key. It reads `FORGECRM_JWT_SECRET`
— the name every installer writes — and refuses to boot in production rather than falling back to
the development key, which is published here. When it was read as `JWT_SECRET` at three separate
call sites, real installs signed with that published key while `mcpOAuth.js` verified with the
generated one, so the two halves disagreed and neither said so. Sign and verify from this module.

### Deployment config belongs in `.env`, not in a shell variable

Extra compose files — a reverse-proxy overlay, anything server-specific — go in `COMPOSE_FILE`
inside `.env`, which Compose reads on every invocation. Exported in a shell instead, it is
eventually forgotten, and the install that follows comes up **healthy with no domain attached**:
every container green, the site 404. Nothing in the stack can detect that, because from the inside
nothing is wrong. It is the reason `scripts/up.sh` finishes by fetching the public URL rather than
trusting container health.

The same shape recurs: a green signal that does not cover the thing that broke. A successful
install that hijacked another one; a passing CI job publishing an image nobody can pull; a
migration runner blaming the network for a wrong password. When adding a check, check the
**outcome** — can this be reached, can this be pulled, does this page load — not the step.

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
./scripts/install.sh --domain crm.example.com   # …with HTTPS, certificate included
./scripts/up.sh               # start, then verify the public URL answers
./scripts/down.sh             # stop; keeps the data (refuses -v)
./scripts/migrate.sh          # apply migrations
cd backend  && npm test       # node:test; DB-backed tests skip without a database
cd backend  && npm run lint   # eslint, zero-problem bar
cd frontend && npm run test:unit
cd frontend && npm run lint
docker compose logs -f web    # the frontend service is called `web`
```

**A green `npm test` without a database means less than it looks like.** 129 of the 334 backend tests
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
caddy/Caddyfile        HTTPS in front of `web`; only used when the `tls` profile is on
scripts/               install · up · down · uninstall · migrate · generate-secrets
```

When a capability must be reachable from both the UI and MCP, implement it once in `services/` and
call it from both. `agentService.js` and `mcpService.js` are the model to follow.
