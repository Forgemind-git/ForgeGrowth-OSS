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

### Added

- **MCP: `social_create_comment_dm_draft`** — the app's "Auto-DM links from comments" preset in one
  call (reply under the comment, DM a link button), saved as a draft.
- **MCP: `social_get_trends_anomalies`** — week-on-week / month-on-month changes and flagged
  anomalies, previously only on the separate Social MCP server.
- **`PUBLIC_URL`** in `.env` pins the address Claude and the plugin are given, for installs behind a
  proxy that rewrites the Host header or hides https. Settings → Claude & MCP says where the address
  came from and warns when only the server itself can reach it.

### Removed

- **The separate Social MCP server** (`/api/social/mcp/http/<key>`, Settings → Claude & MCP →
  Instagram API keys). The URL it handed out pointed at the main server, which does not know those
  keys, so no connector built from it could connect. Every Instagram tool is on the one MCP server
  at `/api/mcp`. Its tables are left in place.
- **Chat Analyzer** — the tab, the slide-over in Chats, its settings and business context, and its
  MCP tools (`list_analysed_chats`, `get_chat_analysis`, `analyze_chat`, `get_chat_analysis_costs`,
  `get_chat_transcript`, `transcribe_chat`, `get_chat_image`) and the `area_chat_analysis` API area.
  Voice-note transcription in Chats is unchanged (now served from `/api/voice-notes/…`), and
  `read_messages` returns any stored voice-note transcript. The AI follow-up date stays, now in the
  Leads & Funnel MCP category. Its tables are left in place and no longer written.
- **Telegram** — the Social Telegram bot (Integrations → Telegram, its chat viewer and approvals)
  and the workflow-agent Telegram output with its bot token. A Telegram output on an existing
  workflow agent is dropped when the agent is next saved. Its tables are left in place.

### Changed

- **MCP: Instagram rules and flows are always created as drafts.** `social_create_automation` and
  `social_create_flow` force `active:false`, matching WhatsApp's `create_automation`.
- **MCP connector URLs come from the server**, not the browser's address bar, so the page cannot
  show an address the OAuth metadata would not issue tokens for.
- **Settings** — regrouped into 11 pages under Workspace (General, Team, Activity log), Contacts
  (Tags, Fields, Funnel) and Connections (WhatsApp, Instagram, AI models, Google, Claude & MCP).
  The hidden Sales & Chats | Social switch is gone: each page lists its sections as pills under
  its title (WhatsApp → Accounts · Webhook, Instagram → Connection · Privacy policy, Tags → tags
  and categories for both platforms, …). Old Settings links redirect to the matching section, and
  per-user tab permissions are unchanged. "Back to home" goes home. Social MCP capability text no
  longer mentions other platforms.

## [2.0.0] — 2026-10-18

Published as multi-architecture images tagged `2.0.0`, `2.0` and `2`.

Brings in two months of work from the internal build. **This is a major release**: it removes
three features and their data, so read the upgrade notes before re-running the installer.

### Upgrade notes

- **Lead Forms, Projects and custom domains are removed — code and data.** Migrations
  `131_remove_forms_projects` and `134_remove_custom_domains` drop their tables. Export anything you
  need from those screens first. A domain that was only ever added in **Admin Settings → Domain**
  stops being accepted: put it in `CORS_ORIGIN` (and `TLS_DOMAIN`, comma-separated, if the bundled
  caddy serves it) before upgrading.
- **`install.sh --proxy-routes` is gone** with the Domain screen. It is still accepted, and ignored
  with a warning. `TRAEFIK_DYNAMIC_DIR`, `PROXY_UPSTREAM` and `PROXY_ROUTES_DIR` are no longer read.
- **Without a domain, the bundled caddy no longer starts.** It used to run with no hostname of its
  own so a domain added later in the app needed only DNS. Re-run with `--domain <host>` for HTTPS.
- **Voice notes are transcribed through OpenRouter** (`microsoft/mai-transcribe-2`) rather than
  OpenAI Whisper. Add an OpenRouter key in **Admin Settings → AI Models** to keep transcription on.

### Added

- **Workflow Agents** — scheduled or triggered LLM agents that read leads, chats and sales, draft or
  take actions behind an approvals queue, and keep a per-rep worklist.
- **Chat Analyzer** — per-conversation summaries, intent, sentiment, a suggested stage and ready-to-send
  follow-ups, with voice notes, images and documents read as well as text.
- **Follow-ups** — pin a lead chat, set a follow-up date, and work them from a calendar view (with
  optional Google Calendar sync).
- **Payments dashboard**, refunds on the Sales Log, payment status on leads and saved payment filters.
- **Conversions API and Lead Optimisation (CLO)** — previously withheld as Coming Soon. Sends mapped
  funnel stages back to Meta with the lead's click id. Off by default; turning it on is the operator's
  decision because it changes how Meta spends the ad budget.
- **Social** — a third header section for Instagram, Facebook, Threads, YouTube and LinkedIn: analytics,
  a unified inbox, comment automations, a content library and an MCP of its own. Off until
  `SOCIAL_ENCRYPTION_KEY` is set; see [`docs/social-section.md`](./docs/social-section.md).
- **Automation templates**, quick-start AI agent templates, a message-gap pause between flow steps and
  per-number display labels.
- **MCP**: dedicated tools for most read-only reporting (no `forgechat_request` round-trip), and the
  MCP Tools screen reorganised into Connect / Permissions / Access / Advanced.

### Changed

- **Images build from the lock files** (`npm ci`). A lockless `npm install` had stopped resolving at
  all — `Cannot read properties of null (reading 'edgesOut')` — so source installs and image builds
  failed without a line of this repository changing.
- **The webhook parses through `services/metaPayload.js`** — the tested copy. `routes/webhook.js`
  carried its own inline parser, which had drifted from the one the tests covered.

### Fixed

- **Opening Lead Optimisation → Stages no longer crashes the page** (`navigate` was used without being
  passed in).

- **The Claude plugin now downloads with the same address the connector actually authenticates
  against.** "What is this install's public URL" was worked out independently in four places — the
  OAuth issuer, the Streamable HTTP transport's challenge, the **Admin Settings → MCP Tools** panel
  and the plugin `.zip`. They disagreed in three ways: three split a multi-hop `x-forwarded-host`
  on commas and the plugin builder did not, so an install behind two proxies wrote
  `https://a.example.com, b.example.com` into `.mcp.json`; the plugin pinned `https://` textually,
  so a plain-HTTP install (localhost, a LAN address, someone else's proxy in front) shipped a
  connector it could never reach while the page above the download button displayed the working
  `http://` one; and the environment fallbacks were spelled `FORGEGROWTH_DOMAIN` in one and
  `FORGECRM_DOMAIN` in another. None of that presents as an address problem: the server issues an
  OAuth token for the host the request arrived on, so a connector aimed anywhere else holds a token
  it cannot spend and the client calls it a credentials error. All four now resolve through
  `backend/src/util/publicUrl.js`, and the connector URL shown in Admin Settings comes from the
  server rather than being rebuilt in the browser, so what is displayed, what is downloaded and
  what is advertised in the OAuth metadata are one string by construction.

### Added

- **A downloadable install bundle**, attached to each release as
  `forge-growth-<version>.zip`. One file with a self-contained folder per operating system —
  `linux/`, `macos/`, `windows/` — each holding the install files and a `START-HERE.md` written for
  that platform. Built by `scripts/make-bundle.sh`, whose file list is derived from `install.sh`'s
  own `fetch` calls and verified at build time, so the bundle cannot fall behind the installer. The
  bundle ships a version stamp, which is what stops a pinned zip re-fetching `main` on its first run.
  Documentation links in the bundle are resolved against the git object store before it is packed, and
  fall back to `main` when a tag predates the page they point at — a dead link inside a zip fails
  nowhere and is found by the customer holding the folder.

### Removed

- **The internal ForgeTask WhatsApp bridge**, which coupled this general-purpose product to a
  specific internal one and hardcoded a real WhatsApp Business number and its Meta phone-number id
  as fallback defaults. Neither was a credential and the bridge was inert unless
  `FORGETASK_AGENT_WEBHOOK_URL` was set, but a real number does not belong in a public repository.
  Gone with it: the ForgeCommand notify hook, the three phone-number-id skips in the webhook handler,
  and the four `FORGETASK_*` keys in `.env.example`. **Images tagged `1.0.0` / `1.0` / `1` still
  contain these values** — they were built from the tag; `latest` is rebuilt from `main` without them.
- `MCP_SERVER_PATH` no longer defaults to an absolute path from the machine this was developed on.
  It is displayed in a config snippet, never executed, so the default is now a placeholder.

### Changed

- **The README is a map rather than a manual.** It was 773 lines, 47% of it install instructions;
  it is now ~200, with the depth moved to `docs/install.md`, `docs/whatsapp.md`, `docs/features.md`
  and `docs/architecture.md`. Quick start now has explicit per-OS steps for Linux, macOS and Windows.
- Corrected three stale figures in the documentation: 97 migrations (was "88"), 414 tests with 129
  DB-backed (was "255 tests, 92"), and a pinned-install example that named `v1.4.0`, a release that
  never existed.

## [1.0.1] — 2026-08-18

Published as multi-architecture images tagged `1.0.1`, `1.0` and `1`.

### Fixed

- **`--version` now accepts the version in the form the install reports it.** Git tags here are
  `v1.0.0`; the image tag is `1.0.0` — `docker/metadata-action` strips the leading `v`, which is the
  conventional form for a container tag. `install.sh` converted the git form to the image form but
  not the reverse, so `--version 1.0.0` — the form `.env`, `docker ps` and the release notes all show,
  and therefore the form somebody copies back — asked `raw.githubusercontent` for a ref that does not
  exist and failed with "the version '1.0.0' does not exist", blaming the release for a missing
  character. A fully-qualified `refs/tags/v1.0.0` was worse: that ref IS servable, so the files
  pinned and only the image tag was discarded as unusable, leaving 1.0.0's compose file driving
  `latest` images. Both halves pin now, or neither.
- **The `v1.0.0` tag could not install itself.** The strip in the other direction landed after the
  tag was cut, so `--version v1.0.0` — the exact command the README gave for a server — passed
  `v1.0.0` through as an image tag and `docker compose pull` answered `manifest unknown`: a message
  about a registry, produced by a value that came out of a git tag. This is the release that carries
  the fix, which is why it exists.

### Added

- **The install bundle now lives in the repository** at `dist/forge-growth-<version>.zip`, as well as
  being attached to the release. Two hosts rather than one, for the same reason `install.sh` keeps a
  local copy of a file it cannot download: the case worth planning for is GitHub rate-limiting or a
  releases page that will not load.
- **A one-command server install at the top of the README.** The route for a machine that already has
  Docker was buried below three platform-by-platform sections it does not need. It now leads, with the
  two prerequisites that actually fail it — DNS already pointing at the machine, ports 80 and 443
  free — named next to the command rather than further down.

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

[Unreleased]: https://github.com/Forgemind-git/ForgeGrowth-OSS/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Forgemind-git/ForgeGrowth-OSS/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/Forgemind-git/ForgeGrowth-OSS/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Forgemind-git/ForgeGrowth-OSS/releases/tag/v1.0.0
