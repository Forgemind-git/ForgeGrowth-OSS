# Forge Growth

The **AI Academy growth dashboard** — a WhatsApp-native funnel that follows a person from the ad
they tapped, through the conversation, to the payment they made.

Forge Growth is built on the ForgeChat WhatsApp CRM codebase and adds a complete
**Marketing → Sales → Chats** funnel on one shared `leads` model: Meta ad spend, click-to-WhatsApp
attribution, Conversions API, a configurable pipeline, Razorpay payment links and a pulled payment
ledger.

**Live deployment:** [`growth.example.com`](https://growth.example.com) ·
also reachable at [`growth.example.com`](https://growth.example.com)

> **Relationship to ForgeChat.** This is an independent instance of the FORGECHAT-internal codebase,
> deployed as its own app against its own database. It has diverged substantially — everything under
> *Marketing* and *Sales* below exists only here. Upstream fixes are pulled from the
> `forgechat-upstream` remote; **nothing is pushed back to it.**

---

## The funnel, end to end

```
 Meta ad  ──tap──►  WhatsApp conversation  ──►  lead  ──►  stage moves  ──►  payment
    │                        │                    │             │               │
    │ Marketing API          │ referral block     │ funnel      │ lead_events   │ Razorpay
    │ (spend, creatives)     │ (ctwa_clid, ad id) │ stages      │ cursor        │ (webhook + pull)
    ▼                        ▼                    ▼             ▼               ▼
 campaigns/          ctwa_referrals          leads +        Conversions      razorpay_events
 campaign_ads                                funnel_stages  API → Meta       razorpay_payments
```

Every arrow is real data, not a diagram of intent: the click id that arrives on an inbound WhatsApp
message is the same id sent back to Meta as a conversion when that lead reaches a won stage.

## Architecture

```
Meta WhatsApp Cloud API
        │
        ▼ webhook
   Forge Growth Backend ──►  Supabase Postgres (database `forgegrowth`, schema `coexistence`)
   (Express + pg)          ├─ chat_history, contacts, tags, …
        │                  ├─ leads + funnel_stages + funnel_sources + lead_events
        │                  ├─ campaigns + campaign_adsets + campaign_ads + ad_daily_stats
        │                  ├─ ctwa_referrals + capi_config/datasets/event_map/events
        │                  ├─ clo_settings + clo_events (Lead Ads optimisation)
        │                  ├─ razorpay_config + razorpay_events + razorpay_payments
        │                  ├─ payment_requests (links minted here) + sales_log + courses
        │                  ├─ message_templates + revisions + analytics
        │                  ├─ whatsapp_accounts (multi-WABA, AES-256-GCM tokens)
        │                  ├─ chatbots + automation_folders + automation_executions
        │                  ├─ pipelines + pipeline_stages + deals
        │                  ├─ integrations + google_oauth_credentials (AES-256-GCM)
        │                  ├─ agents + agent_tools + agent_runs + agent_run_steps
        │                  ├─ ai_models + mcp_settings + mcp_api_keys
        │                  ├─ mcp_oauth_clients/codes/tokens (OAuth 2.1 for connectors)
        │                  └─ webhook_events (audit log)
        │
        ├──► BullMQ on Redis  ──►  outbound send queue (60 msg/sec)
        │                          + media download queue (concurrency 2)
        │                          + agent run queue (keeps webhooks under Meta's 20s timeout)
        │
        ▼
   Forge Growth Frontend
   (React 18 + Vite, inline styles, no Tailwind)
   Marketing · Sales · Chats sections
        │
        ▼
   Traefik (TLS) ──► browser

External MCP clients (Claude.ai custom connectors, etc.)
        │
        ├──► /api/mcp             OAuth 2.1 bearer token  (recommended)
        └──► /api/mcp/http/<key>  legacy key-in-URL       (still supported)
             both capability-gated by Admin Settings → MCP Tools
```

## Tech Stack

| Layer            | Technology                                                   |
|------------------|--------------------------------------------------------------|
| Database         | PostgreSQL (Supabase self-hosted, database `forgegrowth`, schema `coexistence`) |
| Backend          | Node.js 20 + Express 4 + `pg` (raw SQL, no ORM)              |
| Queues           | BullMQ on shared Redis (send + media-download + agent-run)   |
| Frontend         | React 18 + Vite, inline styles, DM Sans / DM Mono            |
| Icons            | `lucide-react`                                               |
| Auth             | JWT in httpOnly cookies (`forgecrm_token` — name inherited, not a typo) |
| Encryption       | AES-256-GCM for Meta tokens, Google OAuth tokens, verify tokens |
| LLM providers    | Anthropic (`@anthropic-ai/sdk`) + OpenAI (`openai`)          |
| Integrations     | Meta Marketing API + Conversions API, Razorpay, Google OAuth 2.0 (Sheets / Calendar / Gmail) |
| Object storage   | MinIO (`forgegrowth-media` bucket) for Media Library uploads  |
| MCP access       | `@modelcontextprotocol/sdk` Streamable HTTP + stdio; **OAuth 2.1** (PKCE S256) or scoped API keys |
| Reverse proxy    | Traefik (Let's Encrypt, `mytlschallenge` resolver)           |
| Container build  | Docker Compose (shared `/root/docker-compose.yml`)           |

## Features

### Marketing

- **Overview** — lead sources, click-to-WhatsApp activity and Conversions API health in one place.
- **Campaigns** — real spend/results pulled from the **Meta Marketing API**, arranged the way Meta
  structures them: Campaign → Ad Set → Ad. Ad-set spend is *fetched* at `level=adset`, never summed
  from its ads (Meta attributes part of the cost at that tier, so a sum under-reports).
- **Click-to-WhatsApp** — every conversation that began with an ad tap. Meta's `referral` block is
  promoted out of the raw webhook payload into `ctwa_referrals`, so ad → conversation → lead → stage
  → revenue joins locally with no extra Meta calls. Per-ad CPL and ROAS, placement breakdown, and a
  drill-in showing the exact creative each person saw plus a link into their WhatsApp thread.
- **Conversion API** — sends down-funnel conversions back to Meta keyed on the click id, so the ad
  account learns which clicks actually became customers. Master switch defaults **off**; test mode
  requires a test event code; every skip is logged with a reason.
- **Lead Optimisation (CLO)** — the Lead Ads equivalent, deliberately a *separate* integration
  (different action source, identifier and attribution window). Ships inert with a readiness report.

### Sales

- **Pipeline / Funnel / Leads** — a configurable funnel on one `leads` model. Stage labels, colours,
  order and won-flag are editable; the underlying `stage_key` is immutable, so renaming a stage never
  rewrites existing rows or breaks scoring, conversion maths or the tag mirror.
- **Payments** — mint Razorpay payment links (fixed / part payment / open amount) stamped with the
  lead id, so the payment attributes itself instead of being guessed from its rupee amount. A second
  tab shows the **pulled ledger**: every payment Razorpay holds, including ones taken before the
  webhook existed.
- **Sales Log** — enrolled leads with their transactions (gateway payments deduped by `payment_id`,
  unioned with manually logged sales).
- **Products** — the sellable catalogue with optional default prices.
- **Forms** — shareable lead-capture forms (`/f/<slug>`), optionally prefilled from a WhatsApp send
  token; responses without a phone number are kept as anonymous submissions.
- **Funnel-stage tags on contacts** — each lead's stage is mirrored onto its WhatsApp contact as a
  managed tag, so the Chats tag filter can segment by funnel stage.

### Chats (inherited from ForgeChat)

- **Chats** — 3-pane WhatsApp-style inbox with per-BDA filtering, media rendering (image/video/audio/document with ffmpeg Ogg→MP3 fallback for Safari), 24h customer-service-window enforcement, optimistic-UI outbound sends, mic recording in the composer
- **Contacts** — CRUD with tags + custom field definitions per WABA; **CSV / XLSX import** with sample download, drag-drop / Ctrl+V paste, alias-matched headers, idempotent upsert
- **Sales Pipelines (Deal Kanban)** — Pipedrive-style boards: multiple pipelines, custom stages with win-probability, drag-and-drop deal cards, 6 live KPI tiles (total value, weighted value, avg deal, won/lost this month with IST month boundaries), per-deal assignment, contact-to-deal sync, RBAC scoping (BDAs only see their own deals)
- **Message Templates** — full Meta lifecycle: real submit/sync/delete, PAUSED / DISABLED / REJECTED handling, quality score, COPY_CODE buttons, translations grouped by name, Carousel template editor, library browse + clone. **Media headers persist** via `header_media_library_id` FK so previews survive submit
- **Template Editing + History** — APPROVED templates editable via Meta's edit API, snapshot per change to `message_template_revisions`, 2-edits-per-24h rate limit, History side drawer with restore
- **Template Analytics** — daily Meta `template_analytics` cache, KPI tiles + SVG line chart + per-button click breakdown, daily refresh cron
- **Bulk Broadcasts** — 7 message types (template, text, link, image, video, audio, document), per-recipient send queue, live status rollup (SENDING / SENT / PARTIAL / FAILED), Media Library integration for media types, variable mapping per broadcast, aggregated activity log
- **Automation Builder** — visual flow editor (~3.9k lines), 33 block types, drag-to-connect handles; engine evaluates `keyword / anyMessage / newContact / messageRead / messageDelivered / messageSent` triggers synchronously on each webhook. **Automation Folders** organize flows (file-manager UX with drag-to-folder + breadcrumbs)
- **AI Agents** — no-code LLM agent builder per WhatsApp account with system prompt, model selection, keyword/session/new-contact triggers, multi-turn memory, tool-use loop, and full run trace:
  - **Tools:** Google Sheets (read / append / update / upsert), HTTP request, media group sends, CRM write-back (tag/assign/score/edit contact)
  - **Human handoff:** keyword or agent-driven escalation to a BDA round-robin; bot stays silent until a human returns control
  - **Close summary:** idle-conversation summariser that logs a note when a chat goes quiet
  - **Media inputs:** optional audio transcription and image/vision acceptance
  - **Queue isolation:** agent runs are enqueued and executed outside the webhook path so Meta's timeout is never hit
- **MCP Access** — external clients (Claude Desktop, etc.) can connect via stdio or Streamable HTTP using scoped bearer API keys:
  - Discovery tools for WhatsApp accounts, AI models, spreadsheets, media, templates, and existing agents
  - Agent CRUD (create / update / delete) when the capability is enabled
  - Optional conversation read/reply capabilities, gated per key
  - Optional area-level full access (contacts, messaging, broadcasts, automations, pipelines, admin, insights), each opt-in
- **Google Integrations** — OAuth-based connect for **Google Sheets**, **Google Calendar**, **Gmail**. Three-level drill-in UI (Apps → Google → Service browser) in Admin Settings → Integrations. Built-in discovery browsers (spreadsheet picker with tab preview, calendar list, Gmail labels). Automation actions: **Append to Google Sheet**, **Create Calendar Event**, **Send Email** — all variable-resolved
- **Multi-WABA** — `whatsapp_accounts` table, encrypted access tokens, **per-account encrypted webhook verify token** with env fallback + constant-time match, health tracking with topbar banner on `invalid_token`
- **Webhook History** — every inbound Meta/n8n payload audited with kind + subtype + extracted content preview + parser outcome; Send-Test-Webhook modal generates synthetic payloads of every common shape; replay button re-runs any historical payload through the handler
- **Media Library** — upload images/videos/audio/documents to MinIO once, sync per-WABA to Meta on demand (each WABA gets its own 28-day `media_id`), toggle Auto-resync to let a daily cron refresh expiring IDs ~24h before TTL
- **User management + RBAC** — `admin` / `bda_sales` / `viewer` roles, per-user WhatsApp number assignments, per-contact assignment overrides, append-only `user_audit_log`

## Project layout

```
ForgeGrowth/
├── backend/                # Express API on :3013 (Docker) / :3001 (dev)
│   ├── src/
│   │   ├── index.js                 # bootstrap, middleware, route mounting
│   │   ├── auth.js                  # JWT auth + user table mgmt
│   │   ├── db.js                    # pg Pool config
│   │   ├── llm.js                   # Anthropic / OpenAI provider factory
│   │   ├── engine/
│   │   │   ├── automationEngine.js
│   │   │   └── agentEngine.js       # LLM tool loop + outbound reply
│   │   ├── integrations/
│   │   │   ├── metaSend.js          # text / template / media
│   │   │   ├── metaMedia.js         # download from Meta CDN
│   │   │   ├── metaTemplates.js     # submit / edit / sync / library / analytics
│   │   │   ├── metaResumableUpload.js
│   │   │   └── googleClient.js      # Google OAuth + Sheets/Calendar/Gmail REST
│   │   ├── queue/
│   │   │   ├── agentQueue.js        # agent-run worker
│   │   │   ├── mediaQueue.js
│   │   │   └── sendQueue.js
│   │   ├── services/
│   │   │   ├── messageSender.js
│   │   │   ├── mediaDownloader.js
│   │   │   ├── templateAnalytics.js
│   │   │   ├── accountHealth.js
│   │   │   ├── agentService.js      # shared agent CRUD (UI + MCP)
│   │   │   ├── agentRouter.js       # webhook → agent routing
│   │   │   ├── agentHandoff.js      # human escalation
│   │   │   ├── agentCrmTools.js     # CRM write-back tools for agents
│   │   │   ├── agentCloseSummary.js # idle-conversation summariser
│   │   │   ├── mcpService.js        # MCP key validation + capability gating
│   │   │   └── sheetsAgentOps.js    # Google Sheets ops for agent tools
│   │   ├── util/crypto.js           # AES-256-GCM + API-key hashing
│   │   └── routes/
│   │       ├── webhook.js           # Meta receiver + parser + audit logger
│   │       ├── webhookHistory.js    # /webhook-events listing + replay
│   │       ├── messages.js          # numbers, contacts, chat, send paths
│   │       ├── templates.js         # CRUD + submit/sync/edit/revisions/analytics
│   │       ├── broadcasts.js        # multi-type broadcasts + send/test + status rollup
│   │       ├── chatbots.js          # automations + folders + executions
│   │       ├── pipelines.js         # pipelines + stages + deals (Kanban API)
│   │       ├── integrations.js      # Google OAuth + Sheets/Calendar/Gmail discovery routes
│   │       ├── whatsappAccounts.js  # multi-WABA + encrypted access + verify tokens
│   │       ├── mediaLibrary.js      # MinIO + Meta sync
│   │       ├── users.js             # admin user CRUD + audit log
│   │       ├── agents.js            # cookie-authed agent builder API
│   │       ├── aiModels.js          # AI model credentials
│   │       ├── mcp.js               # MCP admin UI routes + /api/mcp/v1 bearer API
│   │       ├── mcpOAuth.js          # OAuth 2.1 AS — discovery, authorize, token, DCR  (Forge Growth)
│   │       ├── leads.js             # funnel leads, board, students/sales             (Forge Growth)
│   │       ├── funnel.js            # configurable stages + sources                   (Forge Growth)
│   │       ├── marketing.js         # Meta Ads sync, campaigns, ad sets               (Forge Growth)
│   │       ├── ctwa.js              # click-to-WhatsApp + Conversions API             (Forge Growth)
│   │       ├── clo.js               # Lead Ads conversion optimisation                (Forge Growth)
│   │       ├── razorpay.js          # payment webhook + gateway config                (Forge Growth)
│   │       ├── paymentRequests.js   # Razorpay links minted here                      (Forge Growth)
│   │       ├── courses.js           # Products + payment-link price registry          (Forge Growth)
│   │       ├── salesLog.js          # manual sale transactions                        (Forge Growth)
│   │       ├── leadForms.js         # public Forms + submissions                      (Forge Growth)
│   │       ├── agentConversation.js # conversation read/reply for MCP + UI
│   │       └── media.js             # auth-proxied /api/media/:msgId
│   └── scripts/             # cron jobs (template sync, analytics, media cleanup, webhook cleanup)
├── frontend/                # React + Vite, served by nginx in prod
│   └── src/
│       ├── App.jsx
│       ├── api.js                   # fetch wrapper for every endpoint
│       ├── hooks/useHashRoute.js    # survives reload
│       ├── components/              # ChatsPage, ChatWindow, MessageBubble, AutomationBuilderView,
│       │   └── agents/              # AgentEditor, AgentList, AgentLivePreview, AgentRunsViewer, …
│       └── pages/                   # AiAgentBuilderPage, TemplateBuilderPage, BulkMessagePage,
│                                    # AdminSettingsPage, ContactsPage, PipelinesPage,
│                                    # ChatbotBuilderPage, MediaLibraryPage, …
├── mcp-server/              # stdio MCP server, development only (hosted transport is the real one)
│   └── src/index.js
└── supabase/migrations/     # numbered SQL files (001 → 088)
```

## Running locally

```bash
# Backend
cd backend
cp .env.example .env       # fill in DB url, JWT secret, encryption key, Meta verify token
npm install
npm run dev                # nodemon on :3001

# Frontend (Vite proxies /api + /uploads to backend)
cd frontend
npm install
npm run dev                # :5173

# MCP server (optional, development only — the deployed connector is the hosted
# Streamable HTTP transport, not this. Configure FORGECHAT_API_URL + FORGECHAT_API_KEY)
cd mcp-server
npm install
npm run start
```

### Tests

```bash
cd backend && npm test     # node:test — unit tests run anywhere;
                           # DB-integration tests skip without a database
```

## Connecting Claude (MCP)

Forge Growth is an MCP server. Claude connects to it as a **custom connector** over OAuth 2.1:

- **Server URL:** `https://growth.example.com/api/mcp`
- Create an OAuth client in **Admin Settings → MCP Tools**, paste the Client ID + Secret into
  Claude's *Advanced settings*, and approve the consent screen.
- 44 tools, each behind a capability toggle that defaults to off.

Full guide, including the requirements that fail silently if you get them wrong:
[`docs/mcp-oauth-setup.md`](./docs/mcp-oauth-setup.md).

## Deploying

For a **fresh host**, follow [`DEPLOY.md`](./DEPLOY.md) — it covers the 5 required containers, persistent volumes, env vars, DNS/TLS, migrations (including the Supabase-role workaround), bootstrap order, cron jobs, and end-to-end verification.

For **rolling updates** on the existing production VPS:

```bash
cd /root
docker compose build forgegrowth-backend forgegrowth-frontend
docker compose up -d --force-recreate forgegrowth-backend forgegrowth-frontend
```

Traefik labels handle TLS + path routing. The frontend nginx config proxies `/api`, `/uploads` and
`/.well-known/oauth-*` (MCP OAuth discovery) to the backend on port **3013**.

> **`docker compose restart` does not reload `.env` changes** — use `up -d --force-recreate`.

> **Apply a migration BEFORE deploying the code that needs it.** Additive columns are ignored by the
> running backend, so a schema that is slightly ahead is harmless; code that is ahead of its schema
> throws on the first request that touches the missing column.

## Database migrations

Numbered SQL files in `supabase/migrations/` are applied manually against the `supabase-db` container:

```bash
docker exec -i supabase-db psql -U postgres -d forgegrowth < supabase/migrations/0NN_xxx.sql
```

Note the database is **`forgegrowth`**, not `postgres` — Forge Growth is isolated per-database, not
per-schema (the schema name `coexistence` is hardcoded throughout the codebase).

Latest applied: `088_mcp_oauth.sql`.

Forge Growth migrations of note (058+ exist only in this fork):
- `058_ai_academy.sql` — the `leads` model, resources, campaigns, webinars, BDA activity, `lead_events`
- `059_meta_ads.sql` / `060_ads_creatives_social.sql` / `074_ad_sets.sql` — Meta Ads sync, creatives, ad sets
- `061_razorpay.sql` / `063_mcp_courses_payments_caps.sql` — payment webhook + MCP payment access
- `064_funnel_labeling.sql` — configurable funnel stages/sources (immutable `stage_key`) + sales log
- `073_ctwa_capi.sql` — click-to-WhatsApp referrals + Conversions API
- `075_capi_customer_info.sql` / `076` / `080` — advanced matching, field sources, custom conversions
- `077`–`079` — Conversion Leads Optimisation (Lead Ads), including the pending-uniqueness fix
- `082_funnel_tags.sql` — funnel stage mirrored onto `contacts.tags`
- `083_forms.sql` — Forms (link + WhatsApp), anonymous submissions
- `084_product_default_price.sql` — Courses renamed to Products, optional default price
- `085_payment_requests.sql` — Razorpay links minted by Forge Growth + API credentials
- `086_ad_creative_full_res.sql` — full-resolution ad creatives for the CTWA drill-in
- `087_razorpay_payment_ledger.sql` — the pulled payment ledger
- `088_mcp_oauth.sql` — OAuth 2.1 authorization server for MCP connectors

Earlier ForgeChat migrations (001–057) of note:
- `031_user_management.sql` — roles (`admin` / `bda_sales` / `viewer`), wa-number assignments, `user_audit_log`
- `039_automation_folders.sql` — file-manager UX for automations
- `040_pipelines.sql` — pipelines, stages, deals, KPIs
- `041_template_header_media_library.sql` — persistent media-header reference
- `042_whatsapp_verify_token.sql` — per-account encrypted webhook verify token
- `043_integrations.sql` — Google OAuth credentials + per-provider `integrations` + `oauth_states`
- `044_agents.sql` — `agents`, `agent_tools`, `agent_runs`, `agent_run_steps`
- `045_automation_node_wiring.sql` — automation builder node wiring
- `046_claude_sessions.sql`, `047_claude_console.sql`, `048_claude_projects.sql` — Claude Console projects
- `049_agent_roster.sql` — agent run roster
- `050_agent_triggers_media.sql` — agent triggers + media groups
- `051_agent_transcribe_audio.sql` — audio transcription option for agents
- `052_agents_llm_model_nullable.sql` — nullable LLM model selection
- `053_mcp.sql` — `mcp_settings`, `mcp_api_keys`
- `054_agent_accept_images.sql` — image/vision acceptance option
- `055_agent_crm_handoff_close.sql` — CRM write-back, human handoff, close summary
- `056_mcp_messaging_caps.sql` — MCP read/send message capability toggles
- `057_mcp_full_access_caps.sql` — MCP area-level full-access toggles

## Cron jobs (host crontab)

```
0  3  * * *  docker exec forgegrowth-backend node scripts/cleanupMedia.js
0  */4 * * * docker exec forgegrowth-backend node scripts/syncTemplates.js
0  2  * * *  docker exec forgegrowth-backend node scripts/syncTemplateAnalytics.js
30 3  * * *  docker exec forgegrowth-backend node scripts/cleanupWebhookEvents.js
0  4  * * *  docker exec forgegrowth-backend node scripts/syncMediaResync.js
```

## Security

- **Never commit** `/root/.env` or `backend/.env` — both gitignored
- Meta access tokens, **Google OAuth tokens** (access + refresh), Google API client secrets, **per-account webhook verify tokens**, and LLM API keys are all encrypted at rest with AES-256-GCM (`backend/src/util/crypto.js`); the key lives in `FORGECRM_ENCRYPTION_KEY` env var
- **MCP API keys** are stored as SHA-256 hashes; the plaintext is shown only once at creation
- JWT tokens use httpOnly, sameSite-strict cookies
- Webhook verify token defaults to env (`FORGECRM_META_WEBHOOK_VERIFY_TOKEN`); per-account override stored encrypted in `whatsapp_accounts.verify_token_encrypted` and matched in **constant time** (`crypto.timingSafeEqual`)
- Google OAuth uses `access_type=offline + prompt=consent` so refresh tokens are always issued; the OAuth callback is the **only public** integrations route (CSRF protection is the short-lived state nonce in `oauth_states`, not the auth cookie)
- MCP routes use their own auth (OAuth bearer token, or a legacy hashed key); every action is gated
  by explicit capability toggles that default to off. **Capabilities are global, never per-token** —
  turning one off applies immediately to every already-connected client.
- The MCP **OAuth 2.1** server requires PKCE `S256` (a missing or `plain` challenge is refused, not
  downgraded), rotates refresh tokens on use, validates the RFC 8707 audience on every request, and
  revokes tokens already issued from a replayed authorization code. `client_credentials` is
  deliberately not offered — every connection has a human in the loop.
- **The MCP proxy canonicalises a path before deciding its capability area.** `fetch()` strips
  dot-segments, so gating on the raw string once let `/marketing/../capi/config` through as
  `area_marketing`. Any change to that gate must keep "the path we check" identical to "the path the
  server receives".
- All SQL uses parameterized queries (`pg` Pool, no ORM, no string interpolation)
- helmet + rate limiter (600 req/min/user) on the API surface
- Phone numbers normalized to digits-only on insert (`normalizePhone()` in `routes/webhook.js`) to avoid duplicate chat threads from `+91…` vs `91…`

## Documentation

| Doc | What it covers |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | The engineering log — every feature, the reasoning behind it, and the invariants a change could regress. Read this before modifying anything non-trivial. |
| [`DEPLOY.md`](./DEPLOY.md) | Fresh-host deployment: containers, volumes, env vars, DNS/TLS, migrations, bootstrap order, cron. |
| [`docs/mcp-oauth-setup.md`](./docs/mcp-oauth-setup.md) | Connecting Claude over MCP + the OAuth requirements that fail silently. |
| [`docs/clo-setup.md`](./docs/clo-setup.md) | Conversion Leads Optimisation (Meta Lead Ads) setup + readiness criteria. |
| [`LLD.md`](./LLD.md) | Low-level design of the inherited ForgeChat core (chats, templates, automations). |
| [`Forge-Growth-Funnel-Labeling-Spec.md`](./Forge-Growth-Funnel-Labeling-Spec.md) | Original spec for the configurable funnel. |

## License

Private — internal Forgemind project.
