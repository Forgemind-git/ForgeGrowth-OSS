# Architecture and development

How the pieces fit, what the code layout is, and the invariants a plausible-looking change can
quietly break.

Contributing? Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first — this page is the map, that one is
the workflow. [`CLAUDE.md`](../CLAUDE.md) is the exhaustive invariant list.

## How it fits together

```
Meta WhatsApp Cloud API
        │
        ▼ webhook
   Backend (Express + pg)  ──►  PostgreSQL  (schema `coexistence`)
        │                       chats · leads · funnel · campaigns
        │                       templates · automations · agents · payments
        │
        ├──►  BullMQ on Redis  ──►  outbound sends (60/sec) · media downloads · agent runs
        ├──►  MinIO                 media library objects
        │
        ▼
   Frontend (React 18 + Vite, inline styles)
        │
        ▼
   nginx ──► browser         also proxies /api, /uploads and /.well-known/oauth-*
```

## The stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16, raw SQL via `pg` — no ORM |
| Backend | Node.js 20, Express 4 |
| Queues | BullMQ on Redis (send, media-download, agent-run) |
| Frontend | React 18 + Vite, inline styles, DM Sans / DM Mono, `lucide-react` |
| Auth | JWT in httpOnly cookies |
| Encryption | AES-256-GCM for every stored third-party credential |
| LLM providers | Anthropic, OpenAI |
| Integrations | Meta Marketing API, Razorpay, Google OAuth (Sheets / Calendar / Gmail) |
| Object storage | MinIO |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP with OAuth 2.1 (PKCE S256) |

Plain JavaScript throughout. No TypeScript.

---

## Things worth knowing before you change anything

Each of these produces a bug that looks like something else, which is why they are listed.

### The schema name `coexistence` is hardcoded throughout

Isolation is per-**database**, not per-schema. The bundled stack uses the database `forgegrowth`.
Do not parameterise the schema name without changing every query.

### BullMQ queue names are hardcoded

Two deployments sharing one Redis server must use different database indexes
(`redis://redis:6379/0` vs `/1`) or **they will consume each other's outbound sends**.

### Stage changes are observed, not hooked

Eight code paths write `leads.stage`, several in raw SQL. Downstream consumers — the funnel-stage tag
mirror today — walk the append-only `lead_events` log with a saved cursor instead, so a new write path
is covered automatically.

**Extend that pattern rather than adding a ninth hook.** The ninth is the one someone forgets.

### Migrations run before the code that needs them

An extra column is ignored by the running backend, so a schema slightly ahead is harmless. Code ahead
of its schema throws on the first request touching the missing column.

> **A migration that renames or drops something inverts that rule.** It must ship *with* the backend
> or after it, never ahead of it — the running image is still reading the old name, so the whole page
> 500s rather than just the new feature failing.

Several tables are also created by `ensure*Tables()` functions at backend startup, so a fresh deploy
self-heals. **If you change such a table in a migration, change the matching `ensure*Tables()` too**,
or a fresh install and an upgraded one behave differently.

### The auth cookie is named `forgecrm_token`

Inherited from an earlier name. Not a typo.

### The session cookie's `Secure` flag follows the URL, not `NODE_ENV`

Both compose files pin `NODE_ENV: production`, including on an install served over plain HTTP. A
`Secure` cookie sent to an `http://` origin is **discarded by the browser with no error anywhere**:
login returns 200, the SPA renders from the response body, and the *next* request arrives with no
cookie and gets 401. It reads as "logged out on refresh", never as a cookie problem.

`util/session.js` derives `secure` from `TLS_DOMAIN` / `CORS_ORIGIN` — the address the browser
actually uses — with `COOKIE_SECURE` as the override. It is also the single definition of the session
signing key: sign and verify from that module, not from three call sites.

### A limit or a fix belongs in BOTH compose files

`docker-compose.yml` is the source path; `docker-compose.images.yml` is what a customer actually runs.
A memory ceiling, an env var or a service change added only to the first reaches nobody who installed
from images — which is every customer.

### Check the outcome, not the step

The recurring failure shape in this project is a green signal that does not cover the thing that
broke: an install that succeeded by hijacking another one, a passing CI job publishing an image nobody
can pull, a migration runner blaming the network for a wrong password.

When adding a check, check whether the thing can be **reached**, **pulled**, or **loaded** — not
whether the command exited 0.

---

## Repository layout

```
backend/
  src/
    index.js              bootstrap, middleware, route mounting
    auth.js               JWT auth + first-run admin
    db.js                 pg Pool
    llm/                  provider adapters (anthropic, openai) behind one interface
    engine/               automation engine + agent engine (tool loop)
    integrations/         Meta send/media/templates, Google
    queue/                BullMQ workers
    routes/               the HTTP surface, one file per area
    services/             shared logic used by both the UI routes and MCP
  scripts/                cron jobs (template sync, analytics, cleanup)
  test/                   node:test — unit tests run anywhere; DB tests skip without one
frontend/
  src/
    api.js                one fetch wrapper for every endpoint
    components/           chat UI, automation builder, agent editor
    pages/                marketing/ · sales/ · admin · chats
mcp-server/               stdio MCP server (development only — the hosted transport is the real one)
supabase/migrations/      numbered SQL, applied in order; baked into the backend image
scripts/                  install.sh · up.sh · down.sh · uninstall.sh · migrate.sh
                          generate-secrets.sh · make-bundle.sh (builds the release zip)
docker-compose.yml        builds from this source tree
docker-compose.images.yml runs published images, for an install with no source tree
```

> The backend image's build context is the **repository root**, not `./backend` — it has to reach
> `supabase/migrations/` and `forge-growth-plugin/`, and Docker cannot COPY from a parent of its
> context. The root `.dockerignore` is what keeps a real `.env` out of that context.

When a capability must be reachable from both the UI and MCP, implement it once in `services/` and
call it from both. `agentService.js` and `mcpService.js` are the model to follow.

---

## Development

```bash
cd backend  && npm install && npm run dev    # nodemon on :3001
cd frontend && npm install && npm run dev    # Vite on :5173, proxies /api to the backend
```

### Tests

```bash
cd backend  && npm test                      # node:test — 414 tests, 129 of them DB-backed
cd backend  && REQUIRE_DB=1 npm test         # what you actually want
cd frontend && npm run test:unit
cd frontend && npm run test:e2e              # Playwright — needs a live stack
```

**A green `npm test` without a database means less than it looks like.** The DB-backed suites *skip*
when Postgres is unreachable, so an empty schema reads as success. `REQUIRE_DB=1` turns that skip into
a hard failure — CI sets it, and so should you.

Playwright is not run in CI: it needs the full stack plus browser binaries. Run it locally against a
live install.

### Linting

```bash
cd backend  && npm run lint    # eslint, zero-problem bar
cd frontend && npm run lint
```

Deliberately scoped to the class of mistake that reaches production and only then throws — an
identifier that does not exist, a duplicated object key, an unreachable branch.

**It is not a formatter, and formatting rules should not be added.** They would produce a
reformat-the-world diff that hides every real change inside it.

### Migrations

Plain numbered SQL in `supabase/migrations/`, applied in filename order. Add the next number, keep it
idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`s) so re-running is safe, and apply with
`./scripts/migrate.sh`.

### CI

Every push and pull request runs both lint suites, the frontend unit tests and build, every migration
against a fresh Postgres 15, the backend suite against a real database with `REQUIRE_DB=1`, and a
secret scan over tracked files.
