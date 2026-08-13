# Forge Growth

**A WhatsApp-native growth stack: the ad someone tapped, the conversation that followed, and the
payment at the end — joined by one key, in one self-hosted app.**

Most CRMs can tell you a lead exists. Forge Growth can tell you which ad creative they saw, what
they said in the chat, which stage they're stuck at, and how much they've actually paid — because
the click id Meta attaches to the inbound WhatsApp message is carried all the way through to the
payment record.

Open source under the **MIT licence**. Self-hosted, single-tenant, no SaaS tier, no telemetry.

---

## Requirements

| | |
|---|---|
| **Docker** | with the **Compose v2** plugin — `docker compose version` must work (not `docker-compose`) |
| **Shell** | anything POSIX-ish that can run bash: Linux, macOS, or Windows via WSL2 / Git Bash |
| **RAM** | 2 GB **to build**. The frontend build is the peak; on 1 GB it gets OOM-killed with an error that reads like a code fault. Running the published images instead skips that peak entirely |
| **Disk** | ~3 GB for the images |

Nothing else — no Node, Postgres, Redis or MinIO on the host. Everything runs in containers.

### Platform notes

**Linux** — works as written.

**macOS** — works as written, with Docker Desktop, OrbStack or Colima. The installer detects the
platform differences it cares about (it reads memory via `sysctl` rather than `/proc`, and checks
ports with `lsof` rather than `ss`). Apple Silicon is fine; the images build natively for arm64.

**Windows** — the installer is a shell script, so run it inside a Unix shell:

- **WSL2 (recommended).** Install Docker Desktop, enable *Settings → Resources → WSL integration*
  for your distro, then clone and run inside WSL.
  **Clone into the Linux filesystem** (`~/forge-growth`), not into `/mnt/c/...` — a repo on the
  Windows drive is dramatically slower and can confuse file-watching during development.
- **Git Bash** also works for the install itself.

There is no PowerShell or `.bat` installer. If you would rather not use a shell at all, run the
[published images](#run-it-from-published-images--no-source-code) instead — that path is two
downloads and `docker compose up -d`, with nothing to build and no bash anywhere, so it works from
PowerShell as-is.

## Quick start

Two ways in. Pick the first if you only want to *run* it, the second if you want to change it.

### Run it from published images — no source code

Nothing is cloned and nothing is built. You need two files and Docker:

```bash
mkdir forge-growth && cd forge-growth
curl -o docker-compose.yml https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/docker-compose.images.yml
curl -o .env               https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/.env.example
```

Edit `.env` and set five values — `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `FORGECRM_JWT_SECRET`,
`FORGECRM_ENCRYPTION_KEY` (32 bytes of hex) and `META_WEBHOOK_VERIFY_TOKEN`. Then:

```bash
docker compose up -d
docker compose logs backend | grep -A5 "FIRST-RUN ADMIN"   # the generated admin password
```

Open `http://localhost:8080`. **There is no migrate step**: the migrations are baked into the backend
image and applied at startup, which is the whole reason this path needs no repository. Upgrading is
`docker compose pull && docker compose up -d`.

| | |
|---|---|
| Pin a version | set `FORGEGROWTH_TAG=v1.2.3` in `.env` (default `latest`) |
| Change the port | set `WEB_PORT` in `.env` |
| Apply migrations yourself | set `AUTO_MIGRATE=0`; the container then only serves |

Images are published to GHCR on every push to `main`, as
`ghcr.io/forgemind-git/forgegrowth-backend` and `-web`, tagged `latest`, the release version, and
`sha-<commit>` for pinning an exact build.

### Build from source

```bash
git clone <your-fork-url> forge-growth
cd forge-growth
./scripts/install.sh
```

That one command:

1. checks the prerequisites above and fails with a specific reason if one is missing,
2. creates `.env` and generates every secret into it,
3. builds the images and starts Postgres, Redis, MinIO, the backend and the frontend,
4. waits for the database to be genuinely accepting connections (not merely started),
5. applies all 88 migrations,
6. prints the URL and the admin credentials to sign in with.

It asks three questions — host port, public URL, admin email — each with a default you can accept by
pressing return. To skip the questions entirely:

```bash
./scripts/install.sh --yes --port 8080 --url https://crm.example.com \
  --admin-email you@example.com --admin-password 'choose-a-strong-one'
```

| Flag | |
|---|---|
| `--port <n>` | host port for the UI (default 8080) |
| `--url <origin>` | public origin the browser will use; sets CORS and the cookie domain |
| `--admin-email <addr>` | first-run admin |
| `--admin-password <pw>` | first-run password (omit and one is generated) |
| `--no-build` | skip the image build |
| `--yes` / `-y` | accept every default, never prompt |

**Re-running is safe and is the upgrade path.** An existing `.env` is never overwritten — only empty
or placeholder values get filled in — and every migration is idempotent, so:

```bash
git pull && ./scripts/install.sh
```

### More than one install on one machine

Each install is a Compose *project*, and that name is what prefixes its containers **and its
volumes** — so the project name, not the directory, is what keeps two installs apart.

The installer handles this for you. The first install is `forgegrowth`; a second one, in a second
directory, sees the name taken and claims `forgegrowth-2` (then `-3`, and so on), recording it as
`COMPOSE_PROJECT_NAME` in its own `.env` and moving to the next free port. Each gets its own
database, queue and object storage, and every later `docker compose` command run from that
directory acts only on that install. `docker compose ls` shows them all.

Re-running the script in a directory that already has an `.env` always upgrades *that* install
rather than creating another.

Two things to know if you manage these by hand:

- **Set the name before the first start, not after.** Renaming an existing install points it at
  fresh, empty volumes; the old data is still there under the old name, but the app will not see it.
- **`.env` and the database are a pair.** `POSTGRES_PASSWORD` is only applied when Postgres first
  creates its data directory, and `FORGECRM_ENCRYPTION_KEY` is the only thing that decrypts stored
  Meta, Google and payment credentials. A regenerated `.env` cannot open an existing database, so
  the installer refuses that combination instead of starting up and failing later. Keep a backup of
  `.env` alongside any backup of the data.

### Installing without the script

The script only automates these steps; you can run them yourself from any shell, PowerShell
included:

```bash
cp .env.example .env
# edit .env: set FORGECRM_JWT_SECRET, FORGECRM_ENCRYPTION_KEY (32 bytes hex),
# META_WEBHOOK_VERIFY_TOKEN, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD
docker compose up -d --build
./scripts/migrate.sh        # or apply supabase/migrations/*.sql in filename order
```

Then read the generated admin password out of the backend log:

```bash
docker compose logs backend | grep -A5 "FIRST-RUN ADMIN"
```

| | |
|---|---|
| Logs | `docker compose logs -f backend` |
| Stop | `docker compose down` |
| Upgrade | `git pull && ./scripts/install.sh` |
| Remove (keep data) | `./scripts/uninstall.sh` |
| Remove everything | `./scripts/uninstall.sh --purge` |

> **Back up `FORGECRM_ENCRYPTION_KEY` from `.env`.** It decrypts every stored Meta, Google and
> payment-gateway credential. Losing it means re-entering all of them; changing it turns the
> existing rows into garbage rather than re-encrypting them.

Deploying to a host you already run, behind an existing reverse proxy? See
[`DEPLOY.md`](./DEPLOY.md).

---

## Connecting WhatsApp

The app does nothing useful until a WhatsApp Business number is attached. You need a Meta app with
the WhatsApp product enabled, and from it a **Phone Number ID**, a **WABA ID** and a **System User
access token**.

1. **Admin Settings → WhatsApp Accounts → Add** — paste the display number (digits only), Phone
   Number ID, WABA ID, App ID and access token. The token is encrypted at rest with AES-256-GCM.
2. In Meta Business Suite → WhatsApp → Configuration, set the webhook:
   - **Callback URL** `https://<your-domain>/api/webhook/whatsapp`
   - **Verify token** — the value of `META_WEBHOOK_VERIFY_TOKEN` in `.env`
   - **Subscribe to** `messages` (that single field covers messages, statuses, echoes and template events)
3. **Admin Settings → Webhooks → Send Test Webhook** — pick "Incoming text message". A row should
   appear in the audit log with `processed` status and `records_extracted=1`.

Multiple numbers are supported; each carries its own encrypted token and its own webhook verify
token.

---

## The funnel, end to end

```
 Meta ad  ──tap──►  WhatsApp conversation  ──►  lead  ──►  stage moves  ──►  payment
    │                        │                    │             │               │
    │ Marketing API          │ referral block     │ funnel      │ lead_events   │ Razorpay
    │ (spend, creatives)     │ (ctwa_clid, ad id) │ stages      │ cursor        │ (webhook + pull)
    ▼                        ▼                    ▼             ▼               ▼
 campaigns/          ctwa_referrals          leads +        funnel tags     razorpay_events
 campaign_ads                                funnel_stages                  razorpay_payments
```

Every arrow is real data rather than a diagram of intent. Because Meta puts the click id on the
inbound message itself, ad → conversation → lead → stage → revenue all resolve with local joins and
no further calls to Meta.

## What's in it

### Marketing

- **Campaigns** — real spend and results from the Meta Marketing API, arranged the way Meta
  structures them: Campaign → Ad Set → Ad. Ad-set spend is *fetched* at `level=adset`, never summed
  from its ads — Meta attributes part of the cost at that tier, so summing under-reports.
- **Click-to-WhatsApp** — every conversation that began with an ad tap. Meta's `referral` block is
  promoted out of the raw webhook payload into its own table, giving per-ad CPL and ROAS, a
  placement breakdown, and a drill-in showing the exact creative each person saw plus a link
  straight into their chat thread.
- **Conversion API** — *not shipped in this release.* The tab is present and marked Coming Soon.

### Sales

- **Leads** — one tab over one `leads` model, with Pipeline, Funnel and All-Leads as views of it
  rather than three separate pages. Stage labels, colours, order and won-flag are all editable; the
  underlying `stage_key` is immutable, so renaming a stage never rewrites existing rows or breaks
  conversion maths.
- **Configurable columns** — a field registry makes the Leads table, the Sales Log and per-installment
  transactions configurable the way Forms already were: rename "Profession", hide "Pincode", edit a
  dropdown's options, or add a new custom field, with no schema change. Built-in columns are
  relabelled rather than replaced — system fields can't be deleted or re-typed, and `field_key` is
  immutable once minted. Deleting a custom field is a *soft* delete and the key stays reserved
  forever, because a new field re-using an old key would silently inherit orphaned values still
  sitting in existing JSONB blobs.
- **Payments** — mint Razorpay payment links (fixed / part payment / open amount) stamped with the
  lead id, so a payment attributes itself instead of being guessed from its amount. A second tab
  shows the pulled ledger: every payment the gateway holds, including ones taken before the webhook
  existed.
- **Payment templates** — reach a customer who has gone quiet. WhatsApp refuses free-form text more
  than 24 hours after the customer's last message, so a link can only get through as an approved
  template. The template's URL button points at a base *this app* owns (`/pay/{{1}}`), not at the
  gateway's short-link domain — Meta bakes a button's base in at approval time, so pointing it at
  Razorpay would mean every approved template breaks the day Razorpay changes its link format.
- **Sales Log** — enrolled leads and their transactions: gateway payments deduped by `payment_id`,
  unioned with manually logged sales.
- **Forms** — shareable lead-capture forms at `/f/<slug>`, optionally prefilled from a WhatsApp send
  token. Responses without a phone number are kept as anonymous submissions rather than dropped.
  Field types include star **ratings** and **section** headings (a section is layout, so it is
  skipped when answers are collected rather than stored as an empty answer).
- **Products** — the sellable catalogue, with optional default prices.

### Chats

- **Projects** — one folder for a campaign's whole toolkit. "Run the Applied AI launch" means a
  broadcast template, an AI agent to answer the people who reply, an automation behind it and a
  form — four things that otherwise live in four unrelated lists with no way to see them as one
  campaign. A project can hold all four kinds; the link is a nullable `project_id`, so nothing is
  forced into a project.
- **Message Formats** — a labelled, pre-filled WhatsApp opener you put on an Instagram reel or a web
  page. Tapping it opens WhatsApp with that exact text, and the conversation that follows is
  attributable to the label — a brand-new lead takes the format's label as its funnel Source. One
  format can serve many numbers (each gets its own slug, since each is a different `wa.me`
  destination), and an optional rotate mode hands the numbers out in turn to spread leads across
  agents. The shared URL is now the tracked redirect, so taps are counted; previously the UI copied
  the raw `wa.me` link and nothing was ever measured.
- **Message Costs** — what the messaging above actually owes Meta, per template and per message type.
  Meta puts a `pricing` object on every status webhook and this app used to discard it; it now has a
  permanent home. The money amount is **derived** from the WABA's own pricing analytics
  (cost ÷ volume) rather than a hand-maintained rate card, because rates differ enormously by
  country — measured on a real account, India utility billed 0.1150 against Germany's 4.0322 for the
  same category, so one hardcoded rate would have under-reported by ~97%. Every send is stamped with
  its template and originating surface (broadcast / automation / agent / manual / MCP / payment)
  at send time, because working out "which template was this?" afterwards silently misses.
- **Payments** — raise a Razorpay link for a lead from Sales → Payments and track it to settlement.
  Reconciliation runs off the Razorpay webhook, which resolves a payment back to the exact lead
  through the ids carried in the link's `notes` — a fact rather than an amount-matching guess.
- **Inbox** — 3-pane WhatsApp-style client with per-agent filtering, media rendering (image / video /
  audio / document, with an ffmpeg Ogg→MP3 fallback so voice notes play in Safari), 24-hour
  customer-service-window enforcement, optimistic-UI sends and mic recording in the composer.
- **Leads** — one hub for the whole leads model: a funnel board and a list view over the same
  records, with tags, a configurable field registry and CSV/XLSX import (alias-matched headers,
  drag-drop and Ctrl+V paste, idempotent upsert). A contact is the conversation; the lead is the
  record, and there is no longer a separate Contacts CRM page holding a second copy of the person.
- **Message Templates** — the full Meta lifecycle: submit, sync, edit, delete, with PAUSED /
  DISABLED / REJECTED handling, quality score, COPY_CODE buttons, carousels and library clone.
  Editing an approved template snapshots the previous version, enforces Meta's 2-edits-per-24h
  limit, and offers restore from a history drawer.
- **Template Analytics** — cached daily Meta analytics with a per-button click breakdown.
- **Bulk Broadcasts** — 7 message types, per-recipient queue, live SENDING / SENT / PARTIAL / FAILED
  rollup, per-broadcast variable mapping. A two-step composer asks for the send mode first — send
  now, schedule once, or repeat on a schedule — because every later choice depends on it. Recipients
  can be filtered by funnel stage, tag and date range, and a scheduled broadcast stays editable
  until it fires.
- **Automation Builder** — a left-to-right visual flow editor with 20 block types and
  drag-to-connect wiring. Every branch a step can take is a labelled row on the card with its own
  connector, so a reply button, a list option and a timeout are each visibly wired rather than
  sharing one anonymous handle. The engine evaluates keyword / any-message / new-contact / read /
  delivered / sent triggers synchronously on each webhook.
- **AI Agents** — a no-code LLM agent per WhatsApp number: system prompt, model choice, triggers,
  multi-turn memory, a tool-use loop and a full run trace. Tools cover Google Sheets, HTTP requests,
  media sends and CRM write-back. Includes keyword or agent-driven **human handoff** with
  round-robin assignment, idle-conversation summaries, optional audio transcription and vision.
  Agent runs execute on a queue outside the webhook path, so Meta's 20-second timeout is never hit.
  **Usage limits** cap what an agent may spend on one person — a rolling per-person allowance that
  refills on a clock rather than a lifetime cap — and **test numbers** are exempt from the pause so
  a limit can never lock the operator out of their own rehearsal.
  Agents can also **fill a form by asking**: the form's fields become the tool schema, so the same
  answers a public form collects can be collected conversationally and land in the same table.
- **Media Library** — upload once to MinIO, sync per-account to Meta on demand (each account gets its
  own 28-day media id), with an optional daily cron that refreshes ids before they expire.
- **Webhook History** — every inbound payload audited with its parser outcome, a synthetic payload
  generator for testing, and a replay button that re-runs any historical payload through the handler.
- **Users & RBAC** — roles are rows, not an enum: `admin` is fixed and the rest are managed from
  Admin Settings, each owning its own page list, so adding a role never needs a migration. Plus
  per-user number assignments, per-contact assignment overrides, and an append-only audit log.

### Integrations

**Google** — OAuth connect for Sheets, Calendar and Gmail, with built-in discovery browsers
(spreadsheet picker with tab preview, calendar list, Gmail labels) and an automation action for each.

**MCP** — the app is itself an MCP server, so an assistant like Claude can drive it as a custom
connector. **46 tools in 17 categories**, every category defaulting to **off**.

A tool belongs to exactly one category, and the category is the gate. This replaced an earlier model
where one capability gated ten unrelated tools — an admin who wanted Claude to build a WhatsApp
template had no choice but to hand over Google Drive search as well. Categories are named after the
job someone is doing ("Template Builder", "Send Messages") rather than the internal route they call,
and each is tagged with what it can do, so the risk is legible before you switch it on:

| Tier | Meaning |
|---|---|
| **Reads only** | Cannot change anything or reach a customer |
| **Builds & configures** | Creates or edits setup — templates, agents, flows, forms, funnel stages |
| **Reaches customers** | Sends real WhatsApp messages to real people. Meta charges apply |
| **Cannot be undone** | Permanently removes something. There is no undo |
| **Full API access** | Unrestricted internal API calls, scoped separately by area |

- **OAuth 2.1** at `https://<your-domain>/api/mcp` — the recommended transport. Create a client in
  **Admin Settings → MCP Tools**, paste the Client ID and Secret into the connector's advanced
  settings, and approve the consent screen.
- A legacy key-in-URL transport at `/api/mcp/http/<key>` is still supported.

Three requirements fail *silently* if you get them wrong, so check these first when a connector
won't finish authorising:

1. **HTTPS with a valid certificate.** OAuth discovery is refused over plain HTTP.
2. **`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` must
   reach the backend.** The bundled nginx config already proxies them; a custom reverse proxy that
   forwards only `/api` will serve the SPA's HTML for these paths instead, and discovery fails with
   no useful error.
3. **PKCE `S256`.** A missing or `plain` challenge is refused rather than downgraded.

Capabilities are **global, not per-token** — turning one off applies immediately to every already-
connected client.

---

## Architecture

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

### Things worth knowing before you change anything

- **The schema name `coexistence` is hardcoded throughout.** Isolation is per-*database*, not
  per-schema. The bundled stack uses the database `forgegrowth`.
- **BullMQ queue names are hardcoded.** Two deployments sharing one Redis server must use different
  database indexes (`redis://redis:6379/0` vs `/1`) or they will consume each other's outbound sends.
- **The auth cookie is named `forgecrm_token`.** Inherited from an earlier name, not a typo.
- **Apply a migration before deploying the code that needs it.** An extra column is ignored by the
  running backend, so a schema slightly ahead is harmless; code ahead of its schema throws on the
  first request that touches the missing column.
  **A migration that renames or drops something inverts that rule** — it must ship *with* the backend
  or after it, never ahead of it, because the running image is still reading the old name and the
  whole page 500s rather than just the new feature failing.
- **Stage changes are observed, not hooked.** Eight code paths write `leads.stage`, several in raw
  SQL. Downstream consumers (the funnel-stage tag mirror today) walk the append-only `lead_events`
  log with a cursor instead, so a new write path is covered automatically. Extend that pattern
  rather than adding a ninth hook.

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
scripts/                  install.sh · uninstall.sh · migrate.sh · generate-secrets.sh
docker-compose.yml        builds from this source tree
docker-compose.images.yml runs published images, for an install with no source tree
```

The backend image's build context is the **repository root**, not `./backend` — it has to reach
`supabase/migrations/` and `forge-growth-plugin/`, and Docker cannot COPY from a parent of its
context. The root `.dockerignore` is what keeps a real `.env` out of that context.

## Development

```bash
cd backend  && npm install && npm run dev    # nodemon on :3001
cd frontend && npm install && npm run dev    # Vite on :5173, proxies /api to the backend
cd backend  && npm test                      # node:test — 255 tests, 92 of them DB-backed
cd backend  && npm run lint                  # eslint, zero-problem bar
```

**A green `npm test` without a database means less than it looks like.** The DB-backed suites *skip*
when Postgres is unreachable, so an empty schema reads as success. `REQUIRE_DB=1` turns that skip
into a hard failure — CI sets it, and so should you when you want the real answer:

```bash
REQUIRE_DB=1 npm test
```

CI runs the tests, both lint suites, and a secret scan on every push and pull request.

Linting is deliberately scoped to the class of mistake that reaches production and only then throws —
an identifier that does not exist, a duplicated object key, an unreachable branch. It is not a
formatter; adding formatting rules would produce a reformat-the-world diff that hides real changes.

Migrations are plain numbered SQL files. Add the next number, keep it idempotent
(`CREATE TABLE IF NOT EXISTS`, guarded `ALTER`s) so re-running is safe, and apply with
`./scripts/migrate.sh`.

## Security

- Every stored third-party credential — Meta access tokens, Google OAuth access and refresh tokens,
  per-account webhook verify tokens, LLM API keys — is encrypted at rest with AES-256-GCM.
- MCP API keys are stored as SHA-256 hashes; the plaintext is shown once, at creation.
- **There is no default password.** The first admin's password comes from
  `BOOTSTRAP_ADMIN_PASSWORD`, or is generated and printed once to the backend log.
- Webhook verify tokens are compared in constant time.
- All SQL is parameterised — `pg` throughout, no string interpolation, no ORM.
- helmet, plus a 600 req/min per-user rate limit on the API surface.
- Only the web frontend publishes a host port. Postgres, Redis and MinIO stay on the internal
  Docker network.

Found a vulnerability? Please report it privately rather than opening a public issue.

## Contributing

Issues and pull requests are welcome. Keep changes tightly scoped — match the conventions of the
file you are editing, and do not restyle adjacent code in the same diff. There is deliberately no
formatter config: the diff should be the change.

## License

**MIT** — see [`LICENSE`](./LICENSE).

Use it, modify it, self-host it, sell it, build a product on it. Keep the copyright notice; that is
the only condition. No copyleft, no network clause, no obligation to publish your changes.

"Forge Growth" and the Forgemind logo are the project's marks; the licence covers the code, not the
branding. Rename a fork that you distribute.
