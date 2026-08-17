# Security Policy

Forge Growth is self-hosted. Every install is a separate deployment, on hardware we have no access
to and no visibility into — which means we cannot patch you, and you will not learn about a fix
unless you go looking for one. Watch this repository's releases if you run it in production.

## Supported versions

| Version | Supported |
|---|---|
| `1.0.x` | ✅ Security fixes |
| `main` | ✅ Fixes land here first |
| Anything older | ❌ Nothing older exists yet — `v1.0.0` is the first tagged release |

There is no long-term-support branch. The upgrade path is to re-run the installer, which is safe to
re-run and leaves `.env` and your database alone:

```bash
./install.sh                  # move to the current release
./install.sh --version v1.0.0 # or pin to a specific one
```

## Reporting a vulnerability

**Email <forgemind.business@gmail.com>** with `SECURITY` in the subject line.

Please do **not** open a public issue, pull request or discussion for a suspected vulnerability.
A public report is readable by everyone running this software before any of them can patch.

Include whatever you have:

- What the issue is, and which component — backend route, frontend, MCP server, installer, compose
  file, migration.
- How to reproduce it. A `curl` invocation or a short script is ideal.
- The version or commit you tested against (`git rev-parse --short HEAD`, or the `FORGEGROWTH_TAG`
  in your `.env`).
- What an attacker gets out of it, and what access they need to start.

**Redact your own secrets before sending.** We do not need your `FORGECRM_JWT_SECRET`, your
`FORGECRM_ENCRYPTION_KEY`, your Meta access token or a dump of your database, and we would rather
not receive them.

### What to expect

| | |
|---|---|
| Acknowledgement | Within 3 working days |
| First assessment | Within 7 days — whether we can reproduce it, and how severe we think it is |
| Fix | Scaled to severity. Anything allowing unauthenticated access to data is treated as urgent |
| Credit | You will be credited in the release notes and [`AUTHORS.md`](./AUTHORS.md) unless you ask us not to |

We will tell you when the fix ships, and we would appreciate you holding off on public disclosure
until it does.

There is no bug bounty. This is a small project and we cannot pay for reports.

## Scope

**In scope** — anything in this repository:

- The backend API, its authentication, and its SQL.
- The MCP server and the API-key surface in front of it.
- The React frontend (XSS, auth bypass in the UI's gating).
- `scripts/install.sh` and the rest of `scripts/` — including secret generation and file permissions.
- `docker-compose.yml`, `docker-compose.images.yml` and the `caddy/` config, where the defaults
  expose something they should not.
- The images published to `ghcr.io/forgemind-git/forgegrowth-backend` and `…-web`.

**Out of scope:**

- Vulnerabilities in upstream images (Postgres, Redis, MinIO, Caddy, Node) — report those upstream.
  Do tell us if our *pinned version* of one is knowingly vulnerable.
- Meta, Google or your LLM provider's own APIs.
- A deployment choice you made yourself: publishing the Postgres port to the internet, running
  without TLS on a public address, reusing a password, or handing an MCP key to a third party.
- Denial of service by flooding your own install. The API is rate-limited at 600 req/min per user;
  it is not designed to survive an unauthenticated flood, and neither is your bandwidth bill.
- Reports that are pure automated-scanner output with no demonstrated impact.

## What the software already does

Detail lives in the README's [Security](./README.md#security) section; the short version:

- Third-party credentials — Meta access tokens, Google OAuth tokens, per-account webhook verify
  tokens, LLM API keys — are encrypted at rest with AES-256-GCM.
- MCP API keys are stored as SHA-256 hashes. The plaintext is shown once, at creation.
- **There is no default password.** The first admin's password comes from `BOOTSTRAP_ADMIN_PASSWORD`
  or is generated and printed once to the backend log.
- Webhook verify tokens are compared in constant time.
- All SQL is parameterised. No string interpolation, no ORM.
- Only the web frontend publishes a host port. Postgres, Redis and MinIO stay on the internal Docker
  network.

## What you are responsible for

The installer generates strong secrets and sets sane defaults, but it cannot defend an install from
the outside:

- **Keep `.env` out of version control and off shared drives.** It holds every secret this install
  has, and `FORGECRM_ENCRYPTION_KEY` is the *only* thing that can decrypt your stored third-party
  credentials. Lose it and that data is gone; leak it and so is the protection.
- **Back up `.env` together with the database.** They are a pair. A restored database with a
  regenerated `.env` cannot be opened.
- **Serve it over HTTPS** if it is reachable from the internet — `./scripts/install.sh --domain
  crm.example.com` obtains a certificate for you. Session cookies are only marked `Secure` when the
  install knows it is on HTTPS.
- **Do not publish the database, Redis or MinIO ports.** Nothing in the product needs them exposed.
- **Rotate an MCP key the moment it leaks.** Capability toggles are global, not per-key, so a leaked
  key has whatever the connector is currently allowed to do.
