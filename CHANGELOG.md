# Changelog

All notable changes to Forge Growth are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a self-hosted product the
versions mean:

- **Major** — an upgrade needs a manual step. A changed environment variable, a migration that is
  not automatic, a breaking API change.
- **Minor** — new features. Re-running `./install.sh` is enough.
- **Patch** — fixes only.

Upgrade with `./scripts/install.sh` (or `./install.sh` on an images install), which is safe to
re-run and leaves `.env` and your database alone. Pin to a specific release with
`./install.sh --version vX.Y.Z`.

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-08-17

First tagged release. Everything below is what `v1.0.0` contains, not a diff against a previous
version — earlier development is in the git history.

Published as multi-architecture images (`linux/amd64` and `linux/arm64`) at
`ghcr.io/forgemind-git/forgegrowth-backend` and `ghcr.io/forgemind-git/forgegrowth-web`, tagged
`1.0.0`, `1.0` and `1`.

### Added — the product

- **Click-to-WhatsApp attribution end to end.** The click id Meta attaches to an inbound WhatsApp
  message is carried through the conversation, the lead, the funnel stage and into the payment
  record, so an ad creative can be tied to revenue rather than to a lead count. Meta's `referral`
  block is promoted out of the raw webhook payload into its own table, giving per-ad CPL and ROAS, a
  placement breakdown, and a drill-in to the exact creative each person saw.
- **Campaigns** — real spend and results from the Meta Marketing API, arranged Campaign → Ad Set →
  Ad. Ad-set spend is fetched at `level=adset` rather than summed from its ads, because Meta
  attributes part of the cost at that tier and summing under-reports it.
- **Leads** — one `leads` model with Pipeline, Funnel and All-Leads as views of it. Stage labels,
  colours, order and won-flag are editable; the underlying `stage_key` is immutable, so renaming a
  stage never rewrites existing rows or breaks conversion maths.
- **Configurable columns** — a field registry makes the Leads table, the Sales Log and per-instalment
  transactions configurable with no schema change: relabel a built-in column, hide one, edit a
  dropdown's options, or add a custom field. Custom-field deletion is soft and the key stays
  reserved permanently, so a new field cannot inherit orphaned values from an old one.
- **Payments** — Razorpay payment links (fixed, part-payment or open amount) stamped with the lead
  id, so a payment attributes itself instead of being matched by amount. A second tab shows the
  pulled gateway ledger, including payments taken before the webhook existed.
- **Payment templates** — approved WhatsApp templates for reaching a customer past the 24-hour
  free-form window. The URL button points at a base this app owns (`/pay/{{1}}`) rather than the
  gateway's short-link domain, because Meta bakes a button's base in at approval time.
- **Sales Log** — enrolled leads and their transactions, gateway payments deduped by `payment_id`
  and unioned with manually logged sales.
- **Forms** — shareable lead-capture forms at `/f/<slug>`, optionally prefilled from a WhatsApp send
  token, with star ratings and section headings among the field types. Responses with no phone
  number are kept as anonymous submissions rather than dropped.
- **Chats** — the WhatsApp inbox, with media, templates and per-conversation history.
- **Projects** — one folder holding a campaign's broadcast template, AI agent, automation and form,
  so a launch can be seen as one thing. The link is a nullable `project_id`; nothing is forced into
  a project.
- **Message Formats** — a labelled, pre-filled WhatsApp opener for a reel or a web page. The
  conversation that follows takes the format's label as its funnel Source. One format can serve many
  numbers, with an optional rotate mode to spread leads across agents. The shared URL is a tracked
  redirect, so taps are counted.
- **Broadcasts** with scheduling and recipient filters.
- **Automations and AI agents** — a flow-block automation engine and an LLM tool loop, with provider
  adapters behind one `runWithTools()` contract.
- **Google integration** — OAuth connect for Sheets, Calendar and Gmail, with discovery browsers
  (spreadsheet picker with tab preview, calendar list, Gmail labels) and an automation action for
  each.
- **MCP server** — the app is itself an MCP server, so an assistant such as Claude can drive it as a
  custom connector. 46 tools in 17 categories, every category defaulting to off, each tagged with
  what it can do (reads only · builds & configures · reaches customers · cannot be undone · full API
  access). OAuth 2.1 at `/api/mcp` with PKCE `S256` required; a legacy key-in-URL transport remains
  supported. Capabilities are global rather than per-token.
- **Products** — the sellable catalogue, with optional default prices.

### Added — installing and running it

- **One-command install from published images**, with no source tree and nothing to compile — which
  also avoids the 2 GB peak of the frontend build. `install.sh` is safe to re-run, and re-running it
  *is* the upgrade: every downloaded file is replaced and `.env` is never touched.
- **`--domain` obtains a Let's Encrypt certificate** and serves HTTPS, on any server rather than
  only the one it was developed on. A domain can also be added later from Admin Settings.
- **`--proxy-routes`** generates a config fragment for a reverse proxy this install does not own,
  without letting it claim a hostname belonging to something else already on that machine.
- **`up.sh` / `down.sh`** verify the outcome rather than the step: `up.sh` fetches the public URL
  after starting, because every container can report healthy while the site 404s. Both refuse to run
  when another directory already owns this install's name, and `down.sh` refuses `-v`.
- **Several installs on one machine** stay separate — `install.sh` records a distinct
  `COMPOSE_PROJECT_NAME` per directory, so a second checkout cannot adopt the first one's database
  and then point freshly generated secrets at it.
- **Per-service memory ceilings**, defaulting to roughly 1.5 GB in total and overridable from `.env`.
- **Migrations are idempotent** and re-runnable, applied in filename order, with several tables also
  created at backend startup so a fresh deploy self-heals.
- **`run-migrations.js` treats a `28P01` authentication failure as terminal** and explains it,
  instead of retrying thirty times and presenting a wrong password as a network problem.
- **CI** runs both lint suites, the frontend unit tests and build, every migration against a fresh
  Postgres 15, and the backend suite against a real database with `REQUIRE_DB=1` — so the DB-backed
  tests cannot silently skip and still report green. A secret scan rejects high-confidence token
  patterns in tracked files.
- **Installation guide** as a PDF in `docs/`, plus reverse-proxy documentation.

### Security

- Third-party credentials — Meta access tokens, Google OAuth access and refresh tokens, per-account
  webhook verify tokens, LLM API keys — encrypted at rest with AES-256-GCM.
- MCP API keys stored as SHA-256 hashes; the plaintext is shown once, at creation.
- **No default password.** The first admin's password comes from `BOOTSTRAP_ADMIN_PASSWORD` or is
  generated and printed once to the backend log.
- Webhook verify tokens compared in constant time.
- All SQL parameterised throughout — no string interpolation, no ORM.
- helmet, plus a 600 req/min per-user rate limit on the API surface.
- Only the web frontend publishes a host port; Postgres, Redis and MinIO stay on the internal Docker
  network.
- The MCP proxy canonicalises a path before gating on it, so `/marketing/../users` can no longer pass
  an area check and then be delivered to `/api/users`.
- The session cookie's `Secure` flag is derived from the address the browser actually uses rather
  than from `NODE_ENV`, which had made an HTTP install log in successfully and then appear logged out
  on the next request. The session signing key has a single definition and refuses to fall back to
  the published development key in production.

### Changed

- **Relicensed from AGPL-3.0 to MIT** ahead of the first public release. Use it, modify it,
  self-host it, sell it, build a product on it — keep the copyright notice, and that is the only
  condition.
- The Conversions API and the Claude Code LLM provider were removed before publication. The
  Conversions API tab is present and marked Coming Soon.

### Known limitations

- Single-tenant by design. There is no workspace or organisation concept, and every config table is a
  singleton row.
- Two deployments sharing one Redis server must use different Redis database indexes
  (`redis://redis:6379/0` vs `/1`), or they will consume each other's outbound WhatsApp sends.
- MCP capabilities are global rather than per-token; there is no per-key scoping.
- Playwright end-to-end tests are not run in CI — they need the full stack and browser binaries, so
  run them locally against a live install.

[Unreleased]: https://github.com/Forgemind-git/ForgeGrowth-OSS/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Forgemind-git/ForgeGrowth-OSS/releases/tag/v1.0.0
