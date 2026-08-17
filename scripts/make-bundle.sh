#!/usr/bin/env bash
#
# Build the offline install bundle — the zip a customer downloads instead of
# running the curl-pipe-bash one-liner.
#
# The bundle is a ready-made install directory, one copy per operating system so
# nobody has to work out which files apply to them. Unzip, open your OS's folder,
# run ./install.sh, and the installer continues *in place* rather than creating a
# subdirectory (see "WHERE THIS LANDS DECIDES WHICH DATABASE IT OPENS" in
# install.sh — a directory that already holds docker-compose.yml is adopted).
#
# ⚠ The bundle ships a `.forgegrowth-install` stamp naming its own version. That
#   is what keeps a v1.0.0 zip on v1.0.0: without it install.sh has nothing to
#   read, defaults FETCH_REF to `main`, and a pinned download would quietly
#   re-fetch the tip on its first run — a zip whose name promises a version it
#   does not keep.
#
# ⚠ The file list is NOT maintained here by hand. It is derived from the `fetch`
#   calls in install.sh and then verified, so adding a file to the installer
#   without adding it here fails this script instead of shipping a bundle that
#   is missing something.
#
# Usage:
#   ./scripts/make-bundle.sh                 # version from the current git tag
#   ./scripts/make-bundle.sh v1.0.0          # explicit
#   ./scripts/make-bundle.sh v1.0.0 /tmp/out # explicit output directory

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

VERSION=${1:-}
OUTDIR=${2:-$REPO_ROOT/dist}

if [ -z "$VERSION" ]; then
  VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo main)
fi

BUNDLE="forge-growth-$VERSION"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

say() { printf '  %s\n' "$*"; }

printf '\nBuilding %s\n\n' "$BUNDLE.zip"

# ── the file list, derived from install.sh ───────────────────────────────────
#
# Every `fetch <path-in-repo> <destination>` line, as "source:destination".
# Reading it from the installer is what stops the two drifting apart.
FILES=$(grep -Eo '^[[:space:]]*fetch[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+' scripts/install.sh \
        | awk '{print $2 ":" $3}')
# .env.example is fetched conditionally (only when no .env exists), so it is not
# matched by the pattern above. It has to be in the bundle regardless: it is what
# .env is created from.
FILES=$(printf '%s\n.env.example:.env.example\n' "$FILES")

[ -n "$FILES" ] || { echo "could not derive the file list from install.sh" >&2; exit 1; }

say "files to ship, per OS:"
printf '%s\n' "$FILES" | while IFS=: read -r src dst; do say "    $src → $dst"; done
echo

# ── stage one self-contained copy per OS ─────────────────────────────────────
for os in linux macos windows; do
  target="$STAGE/$BUNDLE/$os"
  mkdir -p "$target"
  printf '%s\n' "$FILES" | while IFS=: read -r src dst; do
    [ -n "$src" ] || continue
    [ -f "$src" ] || { echo "missing from this checkout: $src" >&2; exit 1; }
    mkdir -p "$target/$(dirname "$dst")"
    cp "$src" "$target/$dst"
  done
  # The manual route needs this one; the installer generates its own secrets.
  cp scripts/generate-secrets.sh "$target/generate-secrets.sh"
  chmod +x "$target"/*.sh

  # The stamp that keeps this bundle pinned to its own version. install.sh reads
  # only `ref=` and `version=`; the rest is for whoever opens the file.
  cat > "$target/.forgegrowth-install" <<STAMP
# .forgegrowth-install — written by make-bundle.sh, safe to delete
# Removing this file lets install.sh re-fetch from main instead of $VERSION.
mode=images
ref=$VERSION
version=$VERSION
STAMP
done

# ── verify the outcome, not the step ─────────────────────────────────────────
#
# That the copies ran is not the thing worth checking. That every file the
# installer will look for is present, in every OS folder, is.
missing=0
for os in linux macos windows; do
  printf '%s\n' "$FILES" | while IFS=: read -r _ dst; do
    [ -n "$dst" ] || continue
    [ -f "$STAGE/$BUNDLE/$os/$dst" ] || { echo "MISSING $os/$dst" >&2; exit 1; }
  done || missing=1
done
[ "$missing" = 0 ] || exit 1

# The compose file is the one that is silently wrong if the repo layout moves.
grep -q '^name: forgegrowth' "$STAGE/$BUNDLE/linux/docker-compose.yml" \
  || { echo "staged docker-compose.yml is not Forge Growth's" >&2; exit 1; }

say "verified: every file install.sh fetches is present in all three folders"

# ── the per-OS instructions ──────────────────────────────────────────────────
# Linux
cat > "$STAGE/$BUNDLE/linux/START-HERE.md" <<X
# Forge Growth on Linux — $VERSION

Everything in this folder is what you need. Nothing else to download.

## 1. Install Docker

Docker Engine **with the Compose v2 plugin**: https://docs.docker.com/engine/install/

Let your user reach Docker without \`sudo\`, then **log out and back in**:

\`\`\`bash
sudo usermod -aG docker \$USER
\`\`\`

Check it works — this must print a version:

\`\`\`bash
docker compose version
\`\`\`

## 2. Install Forge Growth

From **inside this folder**:

\`\`\`bash
chmod +x *.sh
./install.sh
\`\`\`

It asks one question — the address people will use — generates every secret, and
**prints the admin password once**. Write it down.

On a server with a domain, ask nothing at all:

\`\`\`bash
./install.sh --domain crm.example.com
\`\`\`

Point the domain's DNS at this machine first, and leave ports 80 and 443 free.
A Let's Encrypt certificate is obtained and verified on the way up.

## 3. Afterwards

\`\`\`bash
./up.sh          # start — and check the public URL really answers
./down.sh        # stop, keeping all data
./install.sh     # upgrade
\`\`\`

Next: attach a WhatsApp number.
https://github.com/Forgemind-git/ForgeGrowth-OSS/blob/$VERSION/docs/whatsapp.md
X

# macOS
cat > "$STAGE/$BUNDLE/macos/START-HERE.md" <<X
# Forge Growth on macOS — $VERSION

Everything in this folder is what you need. Nothing else to download.

**Apple Silicon and Intel both run natively** — nothing is emulated.

## 1. Install Docker Desktop

https://docs.docker.com/desktop/install/mac-install/ — or OrbStack, or Colima.
All three work.

Start it and wait for the whale icon to stop animating. Then, in **Terminal**,
check it works — this must print a version:

\`\`\`bash
docker compose version
\`\`\`

## 2. Install Forge Growth

In Terminal, \`cd\` into **this folder** (drag the folder onto the Terminal window
after typing \`cd \` to fill in the path):

\`\`\`bash
chmod +x *.sh
./install.sh
\`\`\`

It asks one question — the address people will use — generates every secret, and
**prints the admin password once**. Write it down.

On a laptop, take the default. It serves on http://localhost:8080, or the next
free port, which it tells you.

## 3. Afterwards

\`\`\`bash
./up.sh          # start — and check the URL really answers
./down.sh        # stop, keeping all data
./install.sh     # upgrade
\`\`\`

Next: attach a WhatsApp number. On a laptop this needs a public HTTPS address
from a tunnel — the guide covers it.
https://github.com/Forgemind-git/ForgeGrowth-OSS/blob/$VERSION/docs/whatsapp.md
X

# Windows
cat > "$STAGE/$BUNDLE/windows/START-HERE.md" <<X
# Forge Growth on Windows — $VERSION

Everything in this folder is what you need. Nothing else to download.

**These are shell scripts, so they run inside WSL2 — not in PowerShell.**
There is no PowerShell or .bat installer.

## 1. Turn on WSL2

In **PowerShell as Administrator**, then reboot:

\`\`\`powershell
wsl --install
\`\`\`

## 2. Install Docker Desktop

https://docs.docker.com/desktop/install/windows-install/

Then turn on **Settings → Resources → WSL integration** for your distro.

## 3. Copy this folder into Linux, not the C: drive

Open the **Ubuntu** terminal from the Start menu and run everything from there.
Copy this folder into your Linux home first — the Windows drive is dramatically
slower and confuses file-watching:

\`\`\`bash
cp -r /mnt/c/Users/<you>/Downloads/$BUNDLE/windows ~/forge-growth
cd ~/forge-growth
\`\`\`

Check Docker is reachable — this must print a version:

\`\`\`bash
docker compose version
\`\`\`

## 4. Install Forge Growth

\`\`\`bash
chmod +x *.sh
./install.sh
\`\`\`

The \`chmod\` matters here: unzipping on Windows drops the executable bit.

It asks one question — the address people will use — generates every secret, and
**prints the admin password once**. Write it down.

## 5. Afterwards

\`\`\`bash
./up.sh          # start — and check the URL really answers
./down.sh        # stop, keeping all data
./install.sh     # upgrade
\`\`\`

Open the folder from Explorer with \`explorer.exe .\`, or browse to
\\\\wsl\$\\Ubuntu\\home\\<you>\\forge-growth

Next: attach a WhatsApp number.
https://github.com/Forgemind-git/ForgeGrowth-OSS/blob/$VERSION/docs/whatsapp.md
X

# ── the top-level note, plain text so it opens anywhere ──────────────────────
cat > "$STAGE/$BUNDLE/READ-ME-FIRST.txt" <<X
Forge Growth $VERSION — install bundle
=======================================

Open the folder for your operating system and read START-HERE.md inside it:

    linux/     Linux
    macos/     macOS  (Apple Silicon and Intel)
    windows/   Windows  (runs inside WSL2)

Each folder is complete on its own. They contain the same install files; only
the instructions differ. Pick one and ignore the other two.

WHAT YOU STILL NEED
-------------------
Docker, and an internet connection the first time. The application images are
about 350 MB and are pulled from the internet on the first run - this bundle
contains the install files, not the images themselves.

WHAT THIS INSTALLS
------------------
Forge Growth $VERSION, pinned. Re-running install.sh later upgrades within that
pin rather than jumping to the newest version.

The installer generates every password and encryption key itself. There is no
default password and nothing to edit before you start.

KEEP A COPY OF .env
-------------------
Once installed, the .env file in the install directory holds the only key that
can decrypt your stored WhatsApp, Google and payment credentials, and the only
password that opens your database. Back it up together with your data. A
restored database with a regenerated .env cannot be opened.

Documentation:  https://github.com/Forgemind-git/ForgeGrowth-OSS
Licence:        MIT
X

# ── zip it ───────────────────────────────────────────────────────────────────
mkdir -p "$OUTDIR"
ZIP="$OUTDIR/$BUNDLE.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" "$BUNDLE" )

say "wrote $ZIP ($(du -h "$ZIP" | cut -f1))"
echo
unzip -l "$ZIP" | tail -n +4 | head -40
printf '\nDone.\n\n'
