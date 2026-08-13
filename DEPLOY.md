# Forge Growth — Deployment Guide

Running Forge Growth in production: what the containers are, what has to be backed up, what breaks
if a cron job is missing, and how to prove a fresh deployment actually works.

**If you just want it running, this is not the document you need.** The two install paths in
[`README.md`](./README.md) — published images, or `./scripts/install.sh` — do everything here for
you, including HTTPS. Come back when you want to know what they did, run against infrastructure you
already have, or operate it long-term.

> **Isolation:** the schema name `coexistence` is hardcoded throughout, so two deployments are
> separated **per-database**, not per-schema. BullMQ queue names are hardcoded too, so two
> deployments sharing one Redis server need different database indexes (`redis://redis:6379/0` vs
> `/1`), or they will consume each other's outbound sends.
>
> **One machine, several installs:** the compose project name prefixes the containers *and* the
> volumes, so it — not the directory — is what separates them. `install.sh` records
> `COMPOSE_PROJECT_NAME` in each install's `.env`. See "More than one install on one machine" in the
> README before putting a second one on a host.

---

## 1. Containers

The bundled `docker-compose.yml` brings up five services, plus one optional:

| Service | Image | Purpose |
|---|---|---|
| `backend` | built from `backend/Dockerfile` (`node:20-alpine` + ffmpeg) | Express API, BullMQ workers, migrations at startup |
| `web` | built from `frontend/Dockerfile` (`nginx:alpine` after `vite build`) | React SPA; nginx proxies `/api`, `/uploads`, `/media` to the backend |
| `postgres` | `postgres:16-alpine` | every table, in the `coexistence` schema |
| `redis` | `redis:7-alpine` | BullMQ: sends (rate-limited to 60/sec), media downloads, agent runs |
| `minio` | `minio/minio` | object store for the Media Library |
| `caddy` *(optional)* | `caddy:2-alpine` | HTTPS. Off unless the `tls` profile is on — see §4 |

The frontend service is called **`web`**, not `frontend`. `docker compose logs -f web`.

Only `web` (or `caddy`, with TLS on) publishes a host port. Postgres, Redis and MinIO stay on the
internal Docker network and are never reachable from outside.

### Using infrastructure you already have

To point at an existing Postgres, Redis or MinIO instead of the bundled ones, set the matching
variables in §3 and don't start those services. The backend cares only about the connection
details; nothing assumes the bundled containers.

---

## 2. Persistent state

| Volume | Holds | Criticality |
|---|---|---|
| `pgdata` | **everything** — chats, leads, templates, automations, and the AES-encrypted Meta tokens | **Critical.** Back up daily |
| `miniodata` | Media Library originals | High — re-uploadable, but tedious |
| `media` | downloaded WhatsApp media | Medium — re-fetchable within Meta's retention window |
| `uploads` | profile pictures | Low |
| `redisdata` | queue state | Low — in-flight jobs only |
| `caddydata` | issued certificates | Low, but keep it: without it every restart re-issues, and Let's Encrypt rate-limits to five per week per domain |

`./scripts/down.sh` and `./scripts/uninstall.sh` keep all of these. Only `uninstall.sh --purge` and
`docker compose down -v` delete them.

> **`.env` is part of your backup.** `POSTGRES_PASSWORD` is applied only when Postgres first creates
> its data directory, so a regenerated `.env` cannot open an existing database — the symptom is an
> authentication loop that appears to blame the network. `FORGECRM_ENCRYPTION_KEY` is the only thing
> that decrypts stored Meta, Google and payment credentials; lose it and they must all be re-entered.
> A database backup without the `.env` that goes with it is half a backup.

---

## 3. Environment variables

`.env.example` is the authoritative list and documents each one. The ones without a workable
default:

| | |
|---|---|
| `FORGECRM_JWT_SECRET` | signs login cookies |
| `FORGECRM_ENCRYPTION_KEY` | 64 hex characters (32 bytes). AES-256-GCM for stored credentials |
| `META_WEBHOOK_VERIFY_TOKEN` | must match what you type into Meta's webhook setup |
| `POSTGRES_PASSWORD` | |
| `MINIO_ROOT_PASSWORD` | |
| `CORS_ORIGIN` | the exact origin the browser uses. A mismatch surfaces as a generic 500, not a CORS error |
| `FORGECRM_DOMAIN` | cookie domain — the host part of `CORS_ORIGIN` |

`./scripts/install.sh` generates all five secrets. `./scripts/generate-secrets.sh` prints a set if
you are filling `.env` in by hand.

Optional, with sensible defaults: `META_API_VERSION`, `WEB_PORT`, `PORT`, `REDIS_URL`,
`FORGECRM_MEDIA_BUCKET`, `POSTGRES_SSL`, `WEBHOOK_EXTRA_ALLOWED_WABAS`, the `MINIO_*` connection
details, and the LLM keys (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) if you use AI agents.

Keep `.env` at the repo root, `chmod 600`. Never commit it.

---

## 4. DNS and TLS

**With the bundled proxy** — one flag, and the certificate is handled:

```bash
./scripts/install.sh --domain crm.example.com
```

Requirements, both checked before anything starts: ports **80 and 443 free** (the certificate
challenge arrives on 80), and the domain's **DNS already pointing at this host**. It writes
`COMPOSE_PROFILES=tls` into `.env`, so later `docker compose up -d` keeps HTTPS on.

**Behind a proxy you already run** — skip `--domain`, point your proxy at `WEB_PORT`. Route
everything to the `web` container; nginx inside it already splits `/api` from the SPA, so you do not
need two routes.

> If your proxy is configured through an extra compose file, put it in `COMPOSE_FILE` **in `.env`**:
>
> ```
> COMPOSE_FILE=/path/to/docker-compose.yml:/path/to/your-proxy.yml
> ```
>
> Compose reads that on every invocation. Exported in a shell instead, it gets forgotten, and the
> next `docker compose up -d` brings the stack up **healthy with no domain attached** — every
> container green, the site 404. Nothing detects that from inside the machine.

---

## 5. Database setup

None. The backend applies every migration in `supabase/migrations/` at startup, in filename order,
under an advisory lock so parallel replicas cannot race. Migrations are idempotent — re-running them
is the normal upgrade path.

Set `AUTO_MIGRATE=0` to turn that off, for when migrations are applied by a CI step or a DBA and the
app's database user should not hold DDL rights. Then apply them yourself with `./scripts/migrate.sh`
or by feeding the directory to `psql` in order.

Upgrading: `git pull && ./scripts/install.sh`, or `docker compose pull && docker compose up -d` on
the published-images path.

---

## 6. Bootstrap order

`docker compose up -d` handles it — the backend waits on Postgres, Redis and MinIO healthchecks, and
migrates before serving. Use `./scripts/up.sh` instead and it also fetches the public URL afterwards,
which is the only check that distinguishes "containers healthy" from "site works".

---

## 7. Cron jobs on the host

Run these from the install directory so the right project is picked up:

```cron
0  3  * * *  cd /srv/forgegrowth && docker compose exec -T backend node scripts/cleanupMedia.js
0  */4 * * * cd /srv/forgegrowth && docker compose exec -T backend node scripts/syncTemplates.js
0  2  * * *  cd /srv/forgegrowth && docker compose exec -T backend node scripts/syncTemplateAnalytics.js
30 3  * * *  cd /srv/forgegrowth && docker compose exec -T backend node scripts/cleanupWebhookEvents.js
0  4  * * *  cd /srv/forgegrowth && docker compose exec -T backend node scripts/syncMediaResync.js
```

Without them the app still works — inbound webhooks, sends, manual refresh — but media disk grows
forever, template status drifts from Meta's, analytics stop updating, and `webhook_events` grows
unbounded.

---

## 8. First-run setup

1. **Sign in.** There is no default password. Either set `BOOTSTRAP_ADMIN_EMAIL` /
   `BOOTSTRAP_ADMIN_PASSWORD` before the first start, or let one be generated and printed **once**:

   ```bash
   docker compose logs backend | grep -A5 'FIRST-RUN ADMIN'
   ```

   Only on the run that creates the account. Miss it and you can delete the user row and restart to
   get another.
2. **Admin Settings → WhatsApp Accounts → Add**: display phone number (digits only), Phone Number
   ID, WABA ID, Meta App ID, and a Meta System User access token. The token is encrypted at rest.
3. **Meta Business Suite → WhatsApp → Configuration**:
   - Callback URL `https://<your-domain>/api/webhook/whatsapp`
   - Verify token: exactly your `META_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to `messages` — that one field covers messages, statuses, echoes and template events
4. **Test it**: Admin Settings → Webhooks → *Send Test Webhook* → "Incoming text message". A row
   should appear with `processed` and `records_extracted=1`.
5. *(Optional)* Enable Template Insights in Meta Business Suite, or the Analytics drawer's refresh
   returns subcode 4182004 — the UI explains the fix when it happens.

---

## 9. Backups

A daily dump is not optional: that database holds the encrypted Meta tokens, every conversation, and
your whole funnel.

```cron
0 4 * * * cd /srv/forgegrowth && docker compose exec -T postgres \
  pg_dump -U forgegrowth -d forgegrowth -Fc > /srv/backups/forgegrowth-$(date +\%F).dump
```

Then get `/srv/backups` **off the host** — rsync, S3, Backblaze, whatever you already trust. And
back up `.env` with it, for the reason in §2.

Restore into an empty database:

```bash
docker compose exec -T postgres pg_restore -U forgegrowth -d forgegrowth --clean --if-exists < backup.dump
```

---

## 10. Rules that produce bugs when broken

- **Phone numbers are digits-only everywhere.** Normalised on insert by `normalizePhone()`; display
  never prepends `+`. Mixing formats splits one person into two chat threads.
- **Meta tokens are decrypted only at use time**, inside `getAccountWithToken()`. Never logged.
- **The JWT secret and the webhook verify token are separate variables.** Reusing one for both leaks
  the verify token into any JWT debug path.
- **The webhook returns 200 even when parsing fails.** Meta retries non-2xx and times out at 20
  seconds, so a bug that returns 500 amplifies itself. Failures are recorded in
  `webhook_events.processing_error` instead.
- **Never point freshly generated secrets at an existing database.** See §2.
- **Check outcomes, not steps.** An install that reports success can have adopted another install's
  database; a green publish job can leave an image nobody can pull; five healthy containers can
  serve a 404. Verify the thing you actually wanted — the page loads, the image pulls, the site
  answers on its domain.

---

## 11. Proving a fresh deployment works

Send a real WhatsApp message to the connected business number. Within a few seconds:

1. **Admin Settings → Webhooks** shows `MESSAGES · TEXT · processed` with your text
2. **Chats** shows the conversation, with the bubble rendered
3. Replying from the composer posts optimistically, then gets the delivered tick when Meta echoes
4. A `STATUSES · DELIVERED` row lands in the Webhooks tab

All four means every layer is working: Meta integration, parser, audit log, insert, automation
engine, send queue, status callback, and the UI.

---

Day-to-day operation and architecture: [`README.md`](./README.md). Conventions and invariants for
changing the code: [`CLAUDE.md`](./CLAUDE.md).
