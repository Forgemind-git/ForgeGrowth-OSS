# Contributing to Forge Growth

Thanks for being here. Issues and pull requests are welcome.

This file is about *how to get a change merged*. [`README.md`](./README.md) is about what the
product does, and [`CLAUDE.md`](./CLAUDE.md) is the list of invariants a plausible-looking change
can quietly break — read that one before touching the backend, the installer or a migration. It is
written for coding agents but it is the same set of rules for people.

By contributing you agree that your work is licensed under the [MIT licence](./LICENSE), the same as
the rest of the project. There is no CLA to sign.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
Found a vulnerability? Do **not** open an issue — see [`SECURITY.md`](./SECURITY.md).

---

## Before you start

- **Small fix, obvious bug, typo, doc correction** — just open the pull request.
- **New feature, new dependency, a schema change, anything touching the installer** — open an issue
  first. This is a single-tenant self-hosted product with a deliberately narrow shape, and it is
  kinder to disagree about the design before you have written it than after.
- **Check the invariants.** A surprising number of "bugs" in this codebase are a rule in `CLAUDE.md`
  being broken somewhere else. If your change is in that territory, say so in the PR.

Good first contributions: a route that returns a stack trace instead of `{ error: "…" }`, a chart
missing a hover tooltip, a destructive button that doesn't use `useConfirm()`, a migration that
isn't idempotent, an installer message that names the wrong cause.

## Getting it running

You need Docker with the Compose v2 plugin, and about 2 GB of RAM for the frontend build. Nothing
else — no Node, Postgres, Redis or MinIO on the host.

```bash
git clone https://github.com/Forgemind-git/ForgeGrowth-OSS.git
cd ForgeGrowth-OSS
./scripts/install.sh --source     # builds from this checkout; safe to re-run
```

For a faster edit loop, run the two apps on the host against the stack's databases:

```bash
cd backend  && npm install && npm run dev    # nodemon on :3001
cd frontend && npm install && npm run dev    # Vite on :5173, proxies /api to the backend
```

Day to day:

```bash
./scripts/up.sh              # start, then verify the public URL actually answers
./scripts/down.sh            # stop; keeps the data (it refuses -v)
./scripts/migrate.sh         # apply migrations
docker compose logs -f web   # the frontend service is called `web`, not `frontend`
```

**Use `up.sh` / `down.sh` rather than bare `docker compose up -d`.** They perform the only two
checks that catch the failures this codebase actually suffers in the field: a site that 404s while
every container reports healthy, and a second checkout quietly adopting this install's database.

## The checks

Run these before you push. CI runs the same ones on every push and pull request, and the bar is zero
problems.

```bash
cd backend  && npm run lint
cd backend  && REQUIRE_DB=1 npm test
cd frontend && npm run lint
cd frontend && npm run test:unit
cd frontend && npm run build
```

**`REQUIRE_DB=1` is not optional when you want the real answer.** A large share of the backend suite
talks to a real Postgres on purpose — the thing worth testing in a route file is its SQL, and a
mocked pool would only assert that we wrote the query we wrote. Those suites *skip* when the
database is unreachable and the run still goes green, so a green `npm test` with no database means
much less than it looks like. `REQUIRE_DB=1` turns the skip into a failure. CI sets it.

Linting is deliberately scoped to the class of mistake that reaches production and only then throws:
an identifier that does not exist, a duplicated object key, an unreachable branch. **It is not a
formatter, and please do not add formatting rules** — that produces a reformat-the-world diff that
hides every real change inside it. `frontend/eslint.config.mjs` documents the one rule that is off
on purpose and what turning it on would involve.

`npm run test:e2e` (Playwright) is not run in CI: it needs the full stack plus browser binaries.
Run it locally against a live install if your change touches a user flow.

## Conventions

The house style, in short. Match the file you are editing — comment density and structure vary
between older and newer files, and following the local style beats imposing one.

**Backend**

- Node 20, Express 4, **raw SQL via `pg`**. No ORM, no query builder.
- **All SQL parameterised** — `pool.query('… WHERE id = $1', [id])`. No string interpolation, ever.
- **API responses are camelCase**, produced by aliasing in SQL (`col AS "colName"`), not by mapping
  in JS.
- **Errors are `{ error: "human readable message" }`** — never a stack trace, never a bare code.
- Logic needed by both the UI and MCP goes in `services/` and is called from both. `agentService.js`
  and `mcpService.js` are the model.
- **Webhook handlers must never throw.** Meta retries on any non-2xx and times out at 20 seconds, so
  attribution, analytics and agent work are best-effort around message ingestion: catch, log,
  continue. Anything slow goes on a queue.

**Frontend**

- React 18 + Vite, **inline styles only**. No Tailwind, no CSS modules.
- `useState` / `useEffect`. No Redux, no Zustand.
- Colours come from `constants.js` (`C.primary`, `C.border`, …). Do not hardcode hex values.
- **Every call goes through `frontend/src/api.js`.** Components do not call `fetch`.
- Loading states are shimmer skeletons, not full-page spinners.
- Errors surface in a blocking modal via the global feedback bus — not `alert()`, not a toast.
  Success and info may be toasts.
- Destructive actions use the `useConfirm()` hook, never the browser's `confirm()`.
- Charts get hover tooltips on every point, bar and cell.
- File-upload UI needs Ctrl+V paste support **in the same change**, not as a follow-up.

Plain JavaScript throughout. No TypeScript.

## Migrations

Plain numbered SQL in `supabase/migrations/`, applied in filename order. Add the next number.

- **They must be idempotent** — `CREATE TABLE IF NOT EXISTS`, guarded `ALTER`s. Re-running them is
  the normal upgrade path, not an edge case.
- **Migrations run before the code that needs them.** An extra column is ignored by a running
  backend, so a schema slightly ahead is harmless; code ahead of its schema throws on the first
  request touching the missing column. Ship the migration first.
- Several tables are *also* created by `ensure*Tables()` functions at backend startup, so a fresh
  deploy self-heals. **If your migration changes such a table, change the matching `ensure*Tables()`
  too** — otherwise a fresh install and an upgraded one end up behaving differently.
- The schema name `coexistence` is hardcoded throughout. Isolation is per-database, not per-schema.
  Do not parameterise it without changing every query.

## Two things that are easy to get half-right

**A limit or a fix belongs in *both* compose files.** `docker-compose.yml` is the source path;
`docker-compose.images.yml` is what a customer actually runs. A memory ceiling, an env var or a
service change added only to the first reaches nobody who installed from images — which is every
customer.

**Check the outcome, not the step.** The recurring failure shape in this project is a green signal
that does not cover the thing that broke: an install that succeeded by hijacking another one, a
passing CI job publishing an image nobody can pull, a migration runner blaming the network for a
wrong password. When you add a check, check whether the thing can be *reached*, *pulled*, *loaded* —
not whether the command exited 0.

## Security rules for contributors

Non-negotiable, and CI greps for the obvious cases:

- **Never commit a real credential, hostname, phone number or customer name** — including in
  comments, fixtures, test data and migration seeds. Use `example.com` and `919876543210`.
- **No default credentials.** A known password in a public repo is a live vulnerability that
  scanners hunt for. Do not reintroduce one, including in tests.
- New credential storage goes through `util/crypto.js` (AES-256-GCM), like every existing one.
- Secrets are compared in constant time (`crypto.timingSafeEqual`).

## Pull requests

- **Scope the change tightly.** Fixing one thing does not mean restyling the components next to it.
  The diff should be the change.
- One logical change per PR. Two unrelated fixes are two pull requests.
- Write the commit subject as what the change *does* for whoever runs this — see `git log` for the
  tone. "Fix the session cookie the browser was throwing away" beats "fix bug in session.js".
- Say in the description what you ran. If you couldn't run the DB-backed tests, say that instead of
  leaving it to be assumed.
- Update `README.md` if you changed behaviour a user can see, and `CLAUDE.md` if you added or
  changed an invariant.
- Add a line to [`CHANGELOG.md`](./CHANGELOG.md) under `Unreleased` for anything user-visible.

Before you open it:

- [ ] Both lint suites pass with zero problems
- [ ] `REQUIRE_DB=1 npm test` passes in `backend/`
- [ ] `npm run test:unit` and `npm run build` pass in `frontend/`
- [ ] Any migration is idempotent, and its `ensure*Tables()` counterpart matches
- [ ] Anything added to `docker-compose.yml` is in `docker-compose.images.yml` too
- [ ] No real credentials, hostnames, phone numbers or customer names anywhere in the diff

## Releases

Maintainers cut releases by tagging `vX.Y.Z` on `main`. That tag triggers
`.github/workflows/publish-images.yml`, which builds `linux/amd64` and `linux/arm64` images and
pushes `X.Y.Z`, `X.Y` and `X` tags to GHCR. Users pin to a release with
`./install.sh --version vX.Y.Z`, which is sticky — later bare re-runs stay on it.
