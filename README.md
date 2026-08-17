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

Three steps. **Step 1 differs by platform; steps 2 and 3 are identical everywhere.**

Nothing is cloned and nothing is compiled — the installer pulls published images.

### Step 1 — Get Docker, and a shell to run it from

<details>
<summary><b>🐧 Linux</b></summary>

1. Install Docker Engine with the Compose v2 plugin —
   [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
2. Let your user reach Docker without `sudo`, then **log out and back in** for it to take effect:

   ```bash
   sudo usermod -aG docker $USER
   ```

3. Use any terminal.

</details>

<details>
<summary><b>🍎 macOS</b></summary>

1. Install **[Docker Desktop](https://docs.docker.com/desktop/install/mac-install/)** — or OrbStack
   or Colima, both of which work.
2. Start it, and wait for the whale icon to stop animating.
3. Use **Terminal** (or iTerm).

**Apple Silicon and Intel both run natively** — the images carry `linux/arm64` and `linux/amd64`, so
nothing is emulated.

</details>

<details>
<summary><b>🪟 Windows</b></summary>

The installer is a shell script, so it runs **inside WSL2** — not in PowerShell.

1. In **PowerShell as Administrator**, then reboot:

   ```powershell
   wsl --install
   ```

2. Install **[Docker Desktop](https://docs.docker.com/desktop/install/windows-install/)**, then turn
   on *Settings → Resources → WSL integration* for your distro.
3. Open the **Ubuntu** terminal from the Start menu. **Run everything from here**, and install into
   your Linux home (`~`) rather than `/mnt/c/...` — the Windows drive is dramatically slower.

Git Bash also works if you already have it. There is no PowerShell or `.bat` installer.

</details>

**Check it worked** — this must print a version, on every platform:

```bash
docker compose version
```

### Step 2 — Get Forge Growth and install it

Two ways in, same result. Pick either.

#### Option A — download the zip

Everything in one file, with a folder for each operating system.

1. Download **[`forge-growth-v1.0.0.zip`](https://github.com/Forgemind-git/ForgeGrowth-OSS/releases/latest)**
   from the releases page (~130 KB).
2. Unzip it and open the folder for your OS — `linux/`, `macos/` or `windows/`. Each one is
   complete on its own; ignore the other two.
3. In your terminal, `cd` into that folder and run:

   ```bash
   chmod +x *.sh
   ./install.sh
   ```

Each folder has a `START-HERE.md` with the same steps, so the person you hand it to does not need
this page. The bundle is pinned to its own version — re-running `./install.sh` later upgrades within
that pin rather than jumping to the newest build.

#### Option B — one command

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/install.sh)"
```

**On a server with a real domain**, pinned to a release and asking nothing at all:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/v1.0.0/scripts/install.sh)" -- \
  --version v1.0.0 --domain crm.example.com
```

---

Either way, the installer asks one question — the address people will use — generates every secret,
and **prints the admin password once**.

Give it `--domain crm.example.com` and it obtains a Let's Encrypt certificate on the way up and
verifies it actually works before reporting success. Point the domain's DNS at the machine first,
and leave ports 80 and 443 free.

> **You still need the internet the first time.** The zip holds the install files, not the
> application images — those are about 350 MB and are pulled on the first run.

### Step 3 — Sign in, then attach a number

Open the URL the installer printed and sign in with the credentials it showed. Lost the password?

```bash
cd forge-growth
grep '^BOOTSTRAP_ADMIN_PASSWORD=' .env
```

Then **[attach a WhatsApp number](./docs/whatsapp.md)** — the app does nothing useful without one.

### Afterwards

From the install directory:

```bash
./up.sh          # start — and verify the public URL really answers
./down.sh        # stop, keeping the data
./install.sh     # upgrade: re-fetch, pull, restart
```

> **Building from source instead?** `git clone`, then `./scripts/install.sh`. You need 2 GB of RAM
> for the frontend build; the published images above skip that peak entirely.

Full detail — every install route, HTTPS, reverse proxies, running several installs on one machine —
is in **[`docs/install.md`](./docs/install.md)**.

---

## Requirements

| | |
|---|---|
| **Docker** | with the Compose v2 plugin — `docker compose version` must work |
| **OS** | Linux, macOS, or Windows via WSL2 — see [step 1](#step-1--get-docker-and-a-shell-to-run-it-from) |
| **RAM** | 2 GB to build; less if you run the published images |
| **Disk** | ~3 GB |

Nothing else. No Node, Postgres, Redis or MinIO on the host — it all runs in containers.

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
