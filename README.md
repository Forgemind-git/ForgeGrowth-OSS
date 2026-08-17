# Forge Growth

**A WhatsApp-native growth stack: the ad someone tapped, the conversation that followed, and the
payment at the end — joined by one key, in one self-hosted app.**

Most CRMs can tell you a lead exists. Forge Growth can tell you which ad creative they saw, what they
said in the chat, which stage they're stuck at, and how much they've actually paid — because the click
id Meta attaches to the inbound WhatsApp message is carried all the way through to the payment record.

**MIT licensed · self-hosted · single-tenant · no SaaS tier · no telemetry**

---

## How it works

```
 Meta ad  ──tap──►  WhatsApp conversation  ──►  lead  ──►  stage moves  ──►  payment
    │                        │                    │             │               │
    │ Marketing API          │ referral block     │ funnel      │ lead_events   │ Razorpay
    │ (spend, creatives)     │ (ctwa_clid, ad id) │ stages      │ cursor        │ (webhook + pull)
    ▼                        ▼                    ▼             ▼               ▼
 campaigns/          ctwa_referrals          leads +        funnel tags     razorpay_events
 campaign_ads                                funnel_stages                  razorpay_payments
```

Every arrow is real data, not a diagram of intent. Because Meta puts the click id on the inbound
message itself, **ad → conversation → lead → stage → revenue all resolve with local joins** and no
further calls to Meta.

---

## Quick start

One command. Nothing is cloned and nothing is built:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/install.sh)"
```

It asks one question — the address people will use — generates every secret, and prints the admin
password once.

**With HTTPS on a real domain**, certificate and renewal included:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/v1.0.0/scripts/install.sh)" -- \
  --version v1.0.0 --domain crm.example.com
```

Then, from the install directory:

```bash
./up.sh          # start — and verify the public URL really answers
./down.sh        # stop, keeping the data
./install.sh     # upgrade: re-fetch, pull, restart
```

**Next:** [attach a WhatsApp number](./docs/whatsapp.md) — the app does nothing useful without one.

> **Building from source instead?** `git clone`, then `./scripts/install.sh`. You need 2 GB of RAM
> for the frontend build; the published images above skip that peak entirely.

Full detail — every install route, platform notes, reverse proxies, running several installs on one
machine — is in **[`docs/install.md`](./docs/install.md)**.

---

## Requirements

| | |
|---|---|
| **Docker** | with the Compose v2 plugin — `docker compose version` must work |
| **Shell** | Linux, macOS, or Windows via WSL2 / Git Bash |
| **RAM** | 2 GB to build; less if you run the published images |
| **Disk** | ~3 GB |

Nothing else. No Node, Postgres, Redis or MinIO on the host — it all runs in containers. Apple
Silicon is supported natively.

---

## What's in it

| Area | |
|---|---|
| **Campaigns** | Real spend from the Meta Marketing API, arranged Campaign → Ad Set → Ad |
| **Click-to-WhatsApp** | Per-ad CPL and ROAS, placement breakdown, and the exact creative each person saw |
| **Leads** | Pipeline, funnel and list views of one model, with tags, custom fields and CSV/XLSX import |
| **Payments** | Razorpay links stamped with the lead id, so a payment attributes itself |
| **Sales Log** | Gateway payments deduped and unioned with manually logged sales |
| **Forms** | Shareable lead capture at `/f/<slug>`, prefillable from a WhatsApp send token |
| **Inbox** | 3-pane WhatsApp client with media, voice notes and 24-hour window enforcement |
| **Templates** | The full Meta lifecycle — submit, sync, edit, quality score, carousels |
| **Broadcasts** | 7 message types, scheduling, per-recipient status, stage and tag filters |
| **Message Costs** | What each send actually owes Meta, derived from your WABA's own pricing |
| **Automations** | A visual flow builder — 20 block types, every branch visibly wired |
| **AI Agents** | A no-code LLM agent per number, with tools, memory, handoff and spend limits |
| **Google** | Sheets, Calendar and Gmail, with discovery browsers and automation actions |
| **MCP** | Drive the whole app from Claude — 46 tools in 17 categories, all off by default |
| **Users & RBAC** | Roles are rows, not an enum, so adding one needs no migration |

Each of these has a "why it works this way" worth knowing — **[`docs/features.md`](./docs/features.md)**
is the full catalogue.

---

## Documentation

| | |
|---|---|
| **[Installing](./docs/install.md)** | Every route, platform notes, HTTPS, reverse proxies, backups |
| **[Connecting WhatsApp](./docs/whatsapp.md)** | Meta setup, and the ngrok loop for a laptop |
| **[Features](./docs/features.md)** | The full catalogue and the reasoning behind it |
| **[Architecture](./docs/architecture.md)** | Stack, repo layout, invariants, development workflow |
| **[Reverse proxies](./docs/reverse-proxy.md)** | Traefik and nginx overlays, and the 404-while-healthy trap |
| **[Deploying](./DEPLOY.md)** | Onto a host you already run |
| **[Installation guide (PDF)](./docs/ForgeGrowth-Installation-Guide.pdf)** | The printable walkthrough |
| **[Changelog](./CHANGELOG.md)** · **[Contributing](./CONTRIBUTING.md)** · **[Security](./SECURITY.md)** | |

---

## Architecture

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16, raw SQL via `pg` — no ORM |
| Backend | Node.js 20, Express 4 |
| Queues | BullMQ on Redis — sends, media downloads, agent runs |
| Frontend | React 18 + Vite, inline styles |
| Auth | JWT in httpOnly cookies |
| Object storage | MinIO |

Diagram, invariants and the development workflow: **[`docs/architecture.md`](./docs/architecture.md)**.

---

## Security

- Every stored third-party credential — Meta access tokens, Google OAuth tokens, per-account webhook
  verify tokens, LLM API keys — is **encrypted at rest with AES-256-GCM**.
- MCP API keys are stored as SHA-256 hashes; the plaintext is shown once, at creation.
- **There is no default password.** The first admin's comes from `BOOTSTRAP_ADMIN_PASSWORD`, or is
  generated and printed once to the backend log.
- Webhook verify tokens are compared in constant time.
- All SQL is parameterised — no string interpolation, no ORM.
- helmet, plus a 600 req/min per-user rate limit.
- Only the web frontend publishes a host port. Postgres, Redis and MinIO stay on the internal Docker
  network.

> **Back up `.env` with your database — they are a pair.** `FORGECRM_ENCRYPTION_KEY` is the only thing
> that decrypts your stored credentials, and `POSTGRES_PASSWORD` is applied only when Postgres first
> creates its data directory. See [backups](./docs/install.md#backups--what-you-must-keep).

**Found a vulnerability?** Report it privately to <forgemind.business@gmail.com> rather than opening a
public issue — [`SECURITY.md`](./SECURITY.md) has the scope and what to expect.

---

## Contributing

Issues and pull requests are welcome. Keep changes tightly scoped, match the conventions of the file
you are editing, and don't restyle adjacent code in the same diff. There is deliberately no formatter
config: the diff should be the change.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the rest — how to get a development stack running, the
checks CI will run on your branch, and the two rules that are easiest to get half-right. Everyone
taking part follows the [Code of Conduct](./CODE_OF_CONDUCT.md). The people who built this are in
[`AUTHORS.md`](./AUTHORS.md).

---

## License

**MIT** — see [`LICENSE`](./LICENSE).

Use it, modify it, self-host it, sell it, build a product on it. Keep the copyright notice; that is
the only condition. No copyleft, no network clause, no obligation to publish your changes.

> "Forge Growth" and the Forgemind logo are the project's marks. The licence covers the code, not the
> branding — rename a fork that you distribute.
