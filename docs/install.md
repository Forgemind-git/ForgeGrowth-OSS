# Installing Forge Growth

Everything about getting it running: requirements, the four install routes, HTTPS, running several
installs on one machine, and the failures that are worth recognising on sight.

New here? [`README.md`](../README.md) has the short version. This page is the full reference.

| Route | Use it when |
|---|---|
| **[1 — download bundle](#route-1--the-download-bundle-zip)** | You are handing an install to someone else, or you'd rather not pipe a script into bash |
| **[2 — one-line installer](#route-2--the-one-line-installer)** | Installing on a machine you control. Fastest |
| **[3 — build from source](#route-3--build-from-source)** | You intend to change the code |
| **[4 — by hand](#route-4--by-hand-no-installer)** | You want to see every step, or automate it yourself |

> Installing on someone else's machine, or walking a non-technical person through it?
> [`ForgeGrowth-Installation-Guide.pdf`](./ForgeGrowth-Installation-Guide.pdf) is the printable
> version — every route end to end, plus attaching a domain, connecting WhatsApp, and what the
> confusing errors actually mean.

## Contents

- [Requirements](#requirements)
- [Platform notes](#platform-notes)
- [Route 1 — the download bundle (zip)](#route-1--the-download-bundle-zip)
- [Route 2 — the one-line installer](#route-2--the-one-line-installer)
- [Route 3 — build from source](#route-3--build-from-source)
- [Route 4 — by hand, no installer](#route-4--by-hand-no-installer)
- [HTTPS on a real domain](#https-on-a-real-domain)
- [Behind a reverse proxy you already run](#behind-a-reverse-proxy-you-already-run)
- [Running it on your laptop](#running-it-on-your-laptop)
- [More than one install on one machine](#more-than-one-install-on-one-machine)
- [Everyday commands](#everyday-commands)
- [Upgrading and downgrading](#upgrading-and-downgrading)
- [Backups — what you must keep](#backups--what-you-must-keep)

---

## Requirements

| | |
|---|---|
| **Docker** | with the **Compose v2** plugin — `docker compose version` must work (not `docker-compose`) |
| **Shell** | anything POSIX-ish that runs bash: Linux, macOS, or Windows via WSL2 / Git Bash |
| **RAM** | 2 GB **to build**. Running published images instead skips this peak entirely |
| **Disk** | ~3 GB for the images |

Nothing else. No Node, Postgres, Redis or MinIO on the host — everything runs in containers.

> **On 1 GB of RAM the frontend build is OOM-killed**, and the error reads like a code fault rather
> than a memory limit. If you have 1 GB, use the published images.

## Platform notes

### Linux

Works as written.

### macOS

Works as written with Docker Desktop, OrbStack or Colima. The installer handles the platform
differences it cares about — it reads memory via `sysctl` rather than `/proc`, and checks ports with
`lsof` rather than `ss`.

**Apple Silicon is fine.** The published images carry both `linux/amd64` and `linux/arm64`, and
building from source produces arm64 natively.

<details>
<summary>If a pull fails with <code>no matching manifest for linux/arm64/v8</code></summary>

An arm64 image is genuinely missing rather than mis-detected. **The error will name the wrong
services**: Compose pulls concurrently and reports one failure against every service, so it lists
`postgres`, `redis`, `minio` and `caddy` — all multi-arch, none of them the cause. Check the two
images this project publishes:

```bash
docker manifest inspect ghcr.io/forgemind-git/forgegrowth-web:latest | grep architecture
```

To carry on anyway, run the amd64 images under Rosetta — `export DOCKER_DEFAULT_PLATFORM=linux/amd64`
before installing — or build from source.

</details>

### Windows

The installer is a shell script, so run it inside a Unix shell. There is no PowerShell or `.bat`
installer.

- **WSL2 (recommended)** — install Docker Desktop, enable *Settings → Resources → WSL integration*
  for your distro, then install from the Ubuntu terminal.
- **Git Bash** also works for the install itself.

> **Use `~/forge-growth`, not `/mnt/c/...`.** A location on the Windows drive is dramatically slower
> and confuses file-watching. Open it from Explorer with `explorer.exe .`, or browse to
> `\\wsl$\Ubuntu\home\<user>\forge-growth`.

`docker compose up -d` does work from PowerShell, but you lose the two checks `up.sh` / `down.sh`
exist to perform — see [Everyday commands](#everyday-commands).

---

## Route 1 — the download bundle (zip)

One file, with a self-contained folder for each operating system. **This is the route to use when you
are handing an install to somebody else**, or when piping a script from the internet into `bash` is
not something you want to do.

### Get it

Download **`forge-growth-<version>.zip`** from the
[releases page](https://github.com/Forgemind-git/ForgeGrowth-OSS/releases/latest) — around 130 KB.

```
forge-growth-v1.0.1/
├── READ-ME-FIRST.txt        which folder to open
├── linux/
│   ├── START-HERE.md        the steps, for this OS only
│   ├── install.sh  up.sh  down.sh
│   ├── docker-compose.yml   .env.example   generate-secrets.sh
│   ├── caddy/Caddyfile
│   └── .forgegrowth-install the version pin
├── macos/                   same files, macOS instructions
└── windows/                 same files, WSL2 instructions
```

**Each folder is complete on its own.** They hold identical install files; only `START-HERE.md`
differs. Pick the one for your OS and ignore the other two.

### Use it

```bash
cd forge-growth-v1.0.1/linux     # or macos, or windows
chmod +x *.sh
./install.sh
```

The `chmod` matters on Windows — unzipping there drops the executable bit.

**The installer continues in place**, in the folder you unzipped, rather than creating a
subdirectory. A directory that already holds `docker-compose.yml` is adopted as the install root, so
what you extracted *is* the install.

### What the bundle guarantees

| | |
|---|---|
| **Pinned to its own version** | The bundled `.forgegrowth-install` names the version, so the first run cannot silently re-fetch `main`. A zip named v1.0.1 stays on v1.0.1 |
| **Complete** | The file list is derived from `install.sh`'s own `fetch` calls and verified at build time, so it cannot fall behind the installer |
| **Not a source checkout** | No `backend/Dockerfile` or `supabase/migrations`, so the installer correctly picks images mode and never tries to build |

> **You still need the internet the first time.** The bundle contains the install files, not the
> application images — those are about 350 MB and are pulled on the first run. This is a
> distribution convenience, not an air-gapped installer.

### Building the bundle yourself

From a checkout:

```bash
./scripts/make-bundle.sh v1.0.1        # writes dist/forge-growth-v1.0.1.zip
./scripts/make-bundle.sh               # version from the current git tag
```

Attach the result to the GitHub release. It refuses to build if any file the installer fetches is
missing from the staged folders.

---

## Route 2 — the one-line installer

Nothing is cloned and nothing is built. **This is the route most people want** when installing on a
machine you control.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/install.sh)"
```

It asks one question — the address people will use — and derives everything else.

### Pinned, and asking nothing

What you want on a server you are handing to somebody:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/v1.0.1/scripts/install.sh)" -- \
  --version v1.0.1 --domain crm.example.com
```

**Both halves of the pinned form matter.** The URL fixes which *script* runs; `--version` fixes what
that script then downloads and pulls. Pin only one and you get a v1.0.1 script that fetches `main`.

Give it a domain whose DNS already points at the machine and it obtains a Let's Encrypt certificate
on the way up, then **verifies the certificate actually works** before reporting success.

### After it finishes

The installer generates every secret, so there is nothing to edit. It creates `./forge-growth`,
leaves a copy of itself there, and prints the admin password once.

```bash
cd forge-growth
./up.sh          # start — and check the public URL really answers
./down.sh        # stop, keeping the data
./install.sh     # upgrade: re-fetch, pull, restart
```

Run `./install.sh --help` for the full flag list.

**There is no migrate step on this route.** Migrations are baked into the backend image and applied
at startup, which is the whole reason this path needs no repository.

<details>
<summary>What that curl-pipe-bash command actually is</summary>

It downloads a shell script over HTTPS and runs it. There is no signature, and a checksum published
on the same server would prove nothing.

What it does have: `curl --fail` so a partial download cannot execute, a sanity check on the compose
file before it is used, and `--version` so you can pin a reviewed release rather than tracking
`main`. If you would rather read it first — download it, read it, run it. It behaves identically.

</details>

<details>
<summary>Forking this? One manual step, once per package</summary>

A GHCR package is created **private** even when the repository is public, and the publish workflow
cannot change that. Flip both packages to public under
Packages → *package* → Package settings → Change visibility.

Until you do, `docker compose up -d` on this path fails with a 403 for everyone but you — **while
the workflow still reports success.**

</details>

Images are published to GHCR on every push to `main` as `ghcr.io/forgemind-git/forgegrowth-backend`
and `-web`, tagged `latest`, the release version, and `sha-<commit>` for pinning an exact build.

---

## Route 3 — build from source

```bash
git clone <your-fork-url> forge-growth
cd forge-growth
./scripts/install.sh
```

That one command:

1. checks the prerequisites and fails with a specific reason if one is missing,
2. creates `.env` and generates every secret into it,
3. builds the images and starts Postgres, Redis, MinIO, the backend and the frontend,
4. waits for the database to be genuinely accepting connections — not merely started,
5. applies every migration,
6. prints the URL and the admin credentials to sign in with.

It asks three questions — host port, public URL, admin email — each with a default you can accept by
pressing return. To skip them:

```bash
./scripts/install.sh --yes --port 8080 --url https://crm.example.com \
  --admin-email you@example.com --admin-password 'choose-a-strong-one'
```

### Flags

| Flag | |
|---|---|
| `--port <n>` | host port for the UI (default 8080) |
| `--domain <host>` | serve HTTPS on this domain, certificate and renewal included |
| `--tls-email <addr>` | certificate contact (default: the admin email; `internal` self-signs) |
| `--url <origin>` | public origin the browser will use; sets CORS. **Include the port** if people reach it on one — `http://203.0.113.10:8080`, not `http://203.0.113.10` |
| `--version <ref>` | pin the files and image tag together. `v1.0.1` and `1.0.1` both work. Sticky — later runs stay on it |
| `--images` / `--source` | published images, or build from this checkout |
| `--dir <path>` | install here rather than `./forge-growth` |
| `--admin-email <addr>` | first-run admin |
| `--admin-password <pw>` | first-run password (omit and one is generated) |
| `--proxy-routes <dir>` | emit a config fragment for a reverse proxy that already owns 80/443 |
| `--no-build` | skip the image build (source installs only) |
| `--yes` / `-y` | never prompt. Takes this machine's public address when it has one, localhost when it does not |

With no address flag at all it asks one question, offering the machine's public address as the
default — so on a server, pressing return is usually right. That form is also the portable one: it
picks a free port first and builds the address around it, so it works without you knowing either.

---

## Route 4 — by hand, no installer

The script only automates the steps below. You can run them yourself from any shell.

### From source

```bash
cp .env.example .env
# edit .env: set FORGECRM_JWT_SECRET, FORGECRM_ENCRYPTION_KEY (32 bytes hex),
# META_WEBHOOK_VERIFY_TOKEN, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD
docker compose up -d --build
./scripts/migrate.sh        # or apply supabase/migrations/*.sql in filename order
```

### From published images

Four files and a `.env` you fill in yourself:

```bash
mkdir forge-growth && cd forge-growth
curl -o docker-compose.yml https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/docker-compose.images.yml
curl -o .env               https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/.env.example
curl -O https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/up.sh
curl -O https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/down.sh
chmod +x up.sh down.sh
./scripts/generate-secrets.sh >> .env   # or fill in the five empty values yourself
```

Set `CORS_ORIGIN` and `FORGECRM_DOMAIN` to the address the browser will use, then `./up.sh`.

Either way, read the generated admin password out of the backend log:

```bash
docker compose logs backend | grep -A5 "FIRST-RUN ADMIN"
```

> **For HTTPS by hand** you also need `caddy/Caddyfile` from the repo, plus `TLS_DOMAIN`,
> `TLS_EMAIL`, `COMPOSE_PROFILES=tls` and `WEB_BIND=127.0.0.1` in `.env`. This is the part the
> installer exists to get right: if `caddy/Caddyfile` is missing, **Docker silently creates a
> _directory_ at that path** and Caddy fails with a message that mentions none of this.

---

## HTTPS on a real domain

```bash
./scripts/install.sh --domain crm.example.com
```

That is the whole thing. It starts a bundled [Caddy](https://caddyserver.com) that obtains a Let's
Encrypt certificate and renews it, sets the public URL and cookie domain to match, and closes the
plain-HTTP port to the outside so the site is not also served without a certificate. No resolver to
configure, no certificate file to create.

**Two requirements, both checked before anything starts:**

| | |
|---|---|
| Ports 80 and 443 free | The certificate is issued through a challenge that arrives on port 80. If something else holds them, the installer says so and stops |
| DNS already points here | The installer warns if the domain does not resolve, and the certificate cannot be issued until it does |

It sticks: `COMPOSE_PROFILES=tls` is written into `.env`, so a later plain `docker compose up -d`
keeps HTTPS on. Re-running the installer without `--domain` turns it back off.

**No public DNS?** `--tls-email internal` self-signs, so a LAN address or a test can exercise the
whole path without a public challenge. Browsers will warn — that is the correct response to a
self-signed certificate.

---

## Behind a reverse proxy you already run

Don't pass `--domain`. Leave the app serving plain HTTP on `WEB_PORT` and point your proxy there —
that is the default behaviour.

If the proxy is configured through an extra compose file, put it in `COMPOSE_FILE` **inside `.env`**,
not in your shell:

```
COMPOSE_FILE=/path/to/docker-compose.yml:/path/to/your-proxy.yml
```

> **Why `.env` and not `export`.** Compose reads `.env` on every invocation, so every later
> `docker compose` command picks up both files. Left in a shell variable it is eventually forgotten,
> and the install that follows **comes up healthy with no domain attached** — every container green,
> the site 404. Nothing in the stack can detect that, because from the inside nothing is wrong.

`--proxy-routes <dir>` generates the fragment for you, without letting this install claim a hostname
that already belongs to something else on the machine.

**[`reverse-proxy.md`](./reverse-proxy.md) is the full version** — a ready-to-edit Traefik overlay
([`examples/traefik-overlay.yml`](../examples/traefik-overlay.yml)), the nginx equivalent, when a
`certresolver` is actively harmful, and the two mistakes that produce a 404 while every container
reports healthy.

After routing the domain, add it in **Admin Settings → Domain** and press **Check** — the server
fetches the address from the outside and tells you which link in the chain is broken.

Deploying to a host you already run? See [`DEPLOY.md`](../DEPLOY.md).

---

## Running it on your laptop

Same one-liner. `--yes` correctly resolves to localhost, because a laptop has no public address:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/install.sh)" -- --yes
```

It creates `~/forge-growth`, serves on port 8080 — or the next free one, which it tells you — and
prints the admin password once. To read it back:

```bash
cd ~/forge-growth
grep '^BOOTSTRAP_ADMIN_PASSWORD=' .env
```

The first download is about 350 MB, with progress shown as it goes.

To connect a real WhatsApp number to a laptop you need a public HTTPS address —
see [`whatsapp.md`](./whatsapp.md#connecting-whatsapp-to-a-laptop--ngrok).

---

## More than one install on one machine

Each install is a Compose *project*, and **that name prefixes its containers and its volumes** — so
the project name, not the directory, is what keeps two installs apart.

The installer handles it. The first install is `forgegrowth`; a second one in a second directory sees
the name taken and claims `forgegrowth-2` (then `-3`), records it as `COMPOSE_PROJECT_NAME` in its
own `.env`, and moves to the next free port. Each gets its own database, queue and object storage.
`docker compose ls` shows them all.

Re-running the script in a directory that already has an `.env` always upgrades *that* install rather
than creating another.

**Two things to know if you manage these by hand:**

- **Set the name before the first start, not after.** Renaming an existing install points it at
  fresh, empty volumes. The old data is still there under the old name, but the app will not see it.
- **A second checkout sharing the name is not a second install** — it adopts the first one's
  database, then points its own freshly generated secrets at it.

---

## Everyday commands

From the install directory:

| | |
|---|---|
| Start | `./up.sh` (source checkout: `./scripts/up.sh`) |
| Rebuild and start | `./scripts/up.sh --build` |
| Stop, keep data | `./down.sh` |
| Logs | `docker compose logs -f backend` — the frontend service is called `web` |
| Upgrade | `./install.sh` — or `git pull && ./scripts/install.sh` from source |
| Remove, keep data | `./scripts/uninstall.sh` |
| Remove everything | `./scripts/uninstall.sh --purge` |
| List every install here | `docker compose ls` |

**Use `up.sh` / `down.sh` rather than `docker compose` directly.** They are not wrappers for their
own sake:

- `up.sh` finishes by loading the page a browser would actually open. **An install can have every
  container reporting healthy and still serve a 404** — from the inside those look identical, and no
  container health check will ever report it. It is also what a container hitting its memory ceiling
  looks like, so `up.sh` says so in its failure output rather than leaving you to guess.
- Both refuse to run when another folder on the machine already uses this install's name — the
  mistake that otherwise ends with two installs quietly sharing one database.
- `down.sh` refuses `-v`, which is one letter from the ordinary command and deletes your database
  with no undo. It prints the backup command instead.

They work whether they sit beside `docker-compose.yml` (an images install) or in `scripts/` (a source
checkout).

---

## Upgrading and downgrading

**Re-running the installer is the upgrade path**, and it is safe. An existing `.env` is never
overwritten — only empty or placeholder values are filled in — and every migration is idempotent.

```bash
./install.sh                    # images install: re-fetch, pull, restart
git pull && ./scripts/install.sh   # source install
./install.sh --version v1.0.1   # move deliberately, and stay there
```

A pinned install **stays pinned** — the version is remembered in `.forgegrowth-install`, so
re-running the script later to change your domain cannot silently move you onto `main`.

| Task | Command |
|---|---|
| Change the port | `./install.sh --port 9000` |
| Change the address | `./install.sh --domain new.example.com` |
| Apply migrations yourself | set `AUTO_MIGRATE=0` in `.env`; the container then only serves |

> **Downgrading is not supported.** Migrations run forward at boot, so pinning back to an older tag
> runs old code against a newer schema. Take a dump first — `down.sh` prints the command.

---

## Backups — what you must keep

**`.env` and the database are a pair. Back them up together.**

- `POSTGRES_PASSWORD` is applied **only** when Postgres first creates its data directory.
- `FORGECRM_ENCRYPTION_KEY` is the **only** thing that decrypts stored Meta, Google and
  payment-gateway credentials. Losing it means re-entering all of them; changing it turns the
  existing rows into garbage rather than re-encrypting them.

A restored database with a regenerated `.env` cannot be opened, **and the failure names the wrong
thing** — an authentication error against the host, thirty retries deep, that reads as a network
problem. The installer refuses that combination rather than starting and failing later, and
`run-migrations.js` treats the `28P01` authentication error as terminal and explains it.
