#!/usr/bin/env bash
# ─── Forge Growth — one-command install ──────────────────────────────────────
#
# On a fresh server, with nothing checked out:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/scripts/install.sh)"
#
# From a source checkout:
#
#   ./scripts/install.sh
#
# Both paths end the same way: a .env with every secret generated, the stack
# running, and the address people will actually type verified by fetching it.
# The only difference is where the images come from — published ones are pulled,
# a checkout is built. Neither asks anyone to edit .env by hand.
#
# Safe to re-run, and re-running IS the upgrade. An existing .env is never
# overwritten (only empty or placeholder values are filled in); the compose file
# and helper scripts are re-downloaded every time.
#
# The flag list lives in usage() below rather than in this header. A header
# printed by `sed -n … "$0"` cannot work when the script arrived down a pipe and
# $0 is not a file — which is exactly how the headline command above runs it.
#
set -euo pipefail

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=''; DIM=''; R=''; G=''; Y=''; N=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%sInstall failed:%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

# ── usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Forge Growth installer. Run it with no flags and it asks one question.

Address — the only thing it genuinely needs to know:
  --domain <host>       Serve HTTPS on this domain, with a Let's Encrypt
                        certificate obtained and renewed automatically. Needs
                        ports 80 and 443 free, and the domain's DNS already
                        pointing at this machine.
  --url <origin>        Public origin when something else terminates HTTPS —
                        your own reverse proxy in front of this stack.
  --port <n>            Host port for the web UI (default 8080, or the next
                        free one if that is taken).

Where it installs from:
  --images              Published images; nothing is built. The default when
                        there is no source checkout around this script.
  --source              Build from the checkout this script lives in.
  --dir <path>          Install into this directory rather than ./forge-growth.
  --version <ref>       Pin the downloaded files AND the image tag together,
                        e.g. --version v1.4.0. Sticky: later runs stay on it
                        until you pass a different one.

Accounts and certificates:
  --admin-email <addr>  First-run admin (default: admin@<your domain>).
  --admin-password <pw> First-run admin password (default: generated, printed).
  --tls-email <addr>    Certificate contact (default: the admin email). The
                        word "internal" self-signs instead of asking Let's
                        Encrypt, for a domain with no public DNS.

Other:
  --no-build            Skip the image build (source installs only).
  --yes, -y             Never ask. With no address flag that means localhost,
                        which is not a public install.
  --help, -h            This text.
EOF
}

# ── arguments ────────────────────────────────────────────────────────────────
WEB_PORT=''; PUBLIC_URL=''; ADMIN_EMAIL=''; ADMIN_PASSWORD=''
DOMAIN=''; TLS_EMAIL=''
ASSUME_YES=0; DO_BUILD=1
MODE=''; INSTALL_DIR=''; PIN_REF=''
# --url and --domain both name the address, but they mean opposite things about
# who terminates TLS, so which one was used has to survive into the logic.
URL_GIVEN=0

# `--flag` with nothing after it used to `shift 2` off the end, which under
# `set -u` surfaces as an internal error about $2 rather than as the missing
# argument it is.
need_arg() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value (try --help)"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)           need_arg "$@"; WEB_PORT="$2"; shift 2 ;;
    --domain)         need_arg "$@"; DOMAIN="$2"; shift 2 ;;
    --tls-email)      need_arg "$@"; TLS_EMAIL="$2"; shift 2 ;;
    --url)            need_arg "$@"; PUBLIC_URL="$2"; URL_GIVEN=1; shift 2 ;;
    --admin-email)    need_arg "$@"; ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) need_arg "$@"; ADMIN_PASSWORD="$2"; shift 2 ;;
    --dir)            need_arg "$@"; INSTALL_DIR="$2"; shift 2 ;;
    --version)        need_arg "$@"; PIN_REF="$2"; shift 2 ;;
    --images)         MODE=images; shift ;;
    --source)         MODE=source; shift ;;
    --no-build)       DO_BUILD=0; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown option: $1 (try --help)" ;;
  esac
done

# ── source checkout, or published images? ────────────────────────────────────
#
# A checkout is provable: three things must be present. Its ABSENCE is not
# provable, so images is the default — a piped run in somebody's home directory
# must not conclude it is a checkout and try to build a tree that is not there.
looks_like_checkout() {
  [ -n "$1" ] && [ -f "$1/docker-compose.yml" ] \
              && [ -f "$1/backend/Dockerfile" ] \
              && [ -d "$1/supabase/migrations" ]
}

# `CDPATH= cd` blanks CDPATH for that one command. Without it, a CDPATH set in
# the caller's shell can make `cd` land somewhere else entirely and this would
# configure the wrong directory. Deliberate, not the typo it resembles.
script_parent=''
if [ -f "$0" ]; then
  # shellcheck disable=SC1007
  script_parent=$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd) || script_parent=''
fi

if [ -z "$MODE" ]; then
  # $0 is a real file only when this script was saved to disk. Under
  # `bash -c "$(curl …)"` it is "--", and nothing sits above that — which is
  # exactly what separates the two paths.
  if   looks_like_checkout "$script_parent"; then MODE=source
  elif looks_like_checkout "$PWD";           then MODE=source
  else MODE=images
  fi
fi

# ── where the install lives ──────────────────────────────────────────────────
if [ "$MODE" = source ]; then
  if   looks_like_checkout "$script_parent"; then ROOT=$script_parent
  elif looks_like_checkout "$PWD";           then ROOT=$PWD
  else die "--source needs a complete checkout beside this script: docker-compose.yml,
  backend/Dockerfile and supabase/migrations. Run it from one, or drop --source
  and install from the published images instead."
  fi
else
  # ⚠ WHERE THIS LANDS DECIDES WHICH DATABASE IT OPENS.
  #
  # Anyone who installed from the older instructions has docker-compose.yml and
  # .env sitting directly in a folder. If a re-run created ./forge-growth
  # underneath that instead, the project-name walk further down would find
  # 'forgegrowth' owned by a DIFFERENT working_dir, step past it to
  # 'forgegrowth-2', and stand up a second, empty database beside the real one.
  # The install would look new and work perfectly, while the customer's data sat
  # in a stack that nothing points at any more.
  #
  # So an install already in this directory is always continued in place.
  if   [ -n "$INSTALL_DIR" ]; then ROOT=$INSTALL_DIR
  elif [ -f "$PWD/.env" ] || [ -f "$PWD/docker-compose.yml" ]; then ROOT=$PWD
  else ROOT="$PWD/forge-growth"
  fi
  mkdir -p "$ROOT" || die "cannot create $ROOT"
  # shellcheck disable=SC1007
  ROOT=$(CDPATH= cd -- "$ROOT" && pwd)
  # A checkout's compose file builds from source. Overwriting it with the
  # published-images one would quietly retarget somebody's whole install.
  if [ -f "$ROOT/docker-compose.yml" ] && grep -qE '^[[:space:]]+build:' "$ROOT/docker-compose.yml"; then
    die "$ROOT builds from source, and installing images over it would replace its
  docker-compose.yml. Run ./scripts/install.sh from there instead, or choose
  somewhere else with --dir <path>."
  fi
fi
cd "$ROOT"

# How to spell this script in messages, which differs between the two layouts.
if [ "$MODE" = source ]; then SELF='./scripts/install.sh'; else SELF='./install.sh'; fi

REPO=${FORGEGROWTH_REPO:-Forgemind-git/ForgeGrowth-OSS}
RAW_BASE="https://raw.githubusercontent.com/$REPO"
STAMP="$ROOT/.forgegrowth-install"

# ── where questions get answered, decided once ───────────────────────────────
#
# Under `bash -c "$(curl …)"` stdin is still the terminal. Under `curl | bash`
# stdin IS the script, so a `read` there consumes the script itself — fall back
# to the controlling terminal, and when there is none, say so rather than
# silently answering every question with its default.
# The braces matter: `exec 3</dev/tty 2>/dev/null` applies its redirections left
# to right, so the /dev/tty open fails and prints before 2>/dev/null exists. In a
# cron job or a container that lands as a bare "No such device or address" above
# the first real output. Redirecting the GROUP puts the muffle in place first.
if   [ -t 0 ]; then exec 3<&0; INTERACTIVE=1
elif { exec 3</dev/tty; } 2>/dev/null; then INTERACTIVE=1
else INTERACTIVE=0
fi

ask() { # ask <prompt> <default> <flag-that-supplies-it> -> echoes the answer
  local prompt="$1" default="$2" flag="$3" reply
  if [ "$ASSUME_YES" = 1 ]; then echo "$default"; return; fi
  if [ "$INTERACTIVE" = 0 ]; then
    die "nothing here can answer \"$prompt\", and this run has no terminal.

  Guessing gives you an install on http://localhost — reachable by nobody — with
  that address stored in its database as the one to build public links from.

  Either supply it:     $SELF $flag <value>
  or accept localhost:  $SELF --yes"
  fi
  printf '  %s [%s]: ' "$prompt" "$default" >&2
  read -r reply <&3 || reply=''
  echo "${reply:-$default}"
}

# ── 1. prerequisites ─────────────────────────────────────────────────────────
step 'Checking prerequisites'

command -v docker >/dev/null 2>&1 || die \
  "docker is not installed. See https://docs.docker.com/engine/install/"

docker compose version >/dev/null 2>&1 || die \
  "the Docker Compose v2 plugin is missing ('docker compose', not 'docker-compose').
  Install it with your Docker packages, then re-run this script."

docker info >/dev/null 2>&1 || die \
  "cannot talk to the Docker daemon. Start it (or add your user to the 'docker'
  group and log back in), then re-run this script."

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."

# Only the images path downloads anything, and it downloads before it can report
# anything useful — so check for the tool here rather than failing mid-fetch.
DL=''
if [ "$MODE" = images ]; then
  if   command -v curl >/dev/null 2>&1; then DL=curl
  elif command -v wget >/dev/null 2>&1; then DL=wget
  else die "curl or wget is required to download the compose file and helper scripts."
  fi
fi
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose plugin, openssl${DL:+, $DL}"

# Building the frontend needs real memory; a 1 GB VPS OOMs mid-build with an
# error that looks like a code fault rather than a resource limit. Nothing is
# built on the images path, so the check would only be a scary irrelevance there.
if [ "$MODE" = source ]; then
  mem_mb=''
  if [ -r /proc/meminfo ]; then                                   # Linux
    mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  elif command -v sysctl >/dev/null 2>&1; then                    # macOS / BSD
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo '')
    case "$bytes" in ''|*[!0-9]*) : ;; *) mem_mb=$((bytes / 1048576)) ;; esac
  fi
  if [ -n "$mem_mb" ]; then
    if [ "$mem_mb" -lt 1800 ]; then
      warn "only ${mem_mb} MB RAM detected — the frontend build may be OOM-killed."
      warn "If it dies without a clear error, add swap or build elsewhere and push the image."
    else
      ok "${mem_mb} MB RAM"
    fi
  fi
fi

# Pulling finished images needs less room than building them does.
if [ "$MODE" = source ]; then disk_need=3000; disk_why='images need roughly 2-3 GB to build'
else                          disk_need=1500; disk_why='the images need roughly 1.5 GB'
fi
avail_mb=$(df -Pm . 2>/dev/null | awk 'NR==2 {print $4}')
case "$avail_mb" in
  ''|*[!0-9]*) : ;;   # df said something unexpected; not worth guessing about
  *)
    if [ "$avail_mb" -lt "$disk_need" ]; then
      warn "only ${avail_mb} MB free disk — $disk_why."
    else
      ok "${avail_mb} MB free disk"
    fi
    ;;
esac

# ── 1.5 download (images mode only) ──────────────────────────────────────────
#
# This is where the product arrives when there is no checkout. Everything
# fetched here is REPLACED on every run — that overwrite is precisely what makes
# re-running this script the upgrade. `.env` is the one thing never touched.
IMAGE_TAG=''; PINNED_REF=''
if [ "$MODE" = images ]; then
  # Which revision the files come from. A pinned install has to STAY pinned:
  # without this, a customer re-running the script only to change their domain
  # would be silently moved onto whatever is on main that day.
  FETCH_REF=$PIN_REF
  PINNED_REF=$PIN_REF
  if [ -f "$STAMP" ]; then
    # Two different facts, and collapsing them was a bug. `ref` is where the
    # FILES came from; it sticks so a bare re-run cannot jump an install off the
    # branch or tag it was put on. `version` records an explicit --version, and
    # ONLY that may dictate the image tag — a branch is a fine source of files
    # and publishes no image of its own, so treating every remembered ref as a
    # pin sent `docker compose pull` after a tag that was never built.
    [ -n "$FETCH_REF" ]  || FETCH_REF=$(sed -n 's/^ref=//p' "$STAMP" | head -1)
    [ -n "$PINNED_REF" ] || PINNED_REF=$(sed -n 's/^version=//p' "$STAMP" | head -1)
  fi
  # ⚠ FORGEGROWTH_REF deliberately does NOT feed PINNED_REF, and therefore does
  # not become the image tag. Git refs and image tags are different namespaces:
  # releases exist in both, but a BRANCH publishes no image of its own, so
  # pulling `:my-branch` would 404 on a branch that is otherwise fine. Moving the
  # files alone is exactly what testing an unreleased branch needs.
  FETCH_REF=${FETCH_REF:-${FORGEGROWTH_REF:-main}}

  fetch() { # fetch <path-in-repo> <destination>
    local url="$RAW_BASE/$FETCH_REF/$1" tmp="$2.part.$$" rc=0
    mkdir -p "$(dirname "$2")"
    case "$DL" in
      curl) curl -fsSL --retry 3 --connect-timeout 15 -o "$tmp" "$url" || rc=$? ;;
      wget) wget -q -T 15 -t 3 -O "$tmp" "$url" || rc=$? ;;
    esac
    if [ "$rc" != 0 ] || [ ! -s "$tmp" ]; then
      rm -f "$tmp"
      die "could not download $1
  from $url

  Either this machine cannot reach GitHub, or the version '$FETCH_REF' does not
  exist. Check the version, or pass a different one with --version."
    fi
    # mv rather than downloading straight onto $2: this replaces the inode, so a
    # file bash is still reading — install.sh replacing itself during an upgrade
    # — is never truncated underneath the running shell.
    mv "$tmp" "$2"
  }

  step "Downloading Forge Growth ($FETCH_REF)"
  fetch docker-compose.images.yml docker-compose.yml
  # A redirect or an error page that still arrived with a 200 would otherwise be
  # discovered by compose, several baffling errors later.
  grep -q '^name: forgegrowth' docker-compose.yml \
    || die "what downloaded is not Forge Growth's compose file — refusing to use it."
  # caddy/Caddyfile is bind-mounted by the tls profile. If it were missing Docker
  # would create a DIRECTORY at that path and Caddy would fail with "is a
  # directory", so it is fetched every time whether or not HTTPS is on today.
  fetch caddy/Caddyfile    caddy/Caddyfile
  fetch scripts/up.sh      up.sh
  fetch scripts/down.sh    down.sh
  fetch scripts/install.sh install.sh
  chmod +x up.sh down.sh install.sh
  # Seeded, never overwritten. .env is created FROM this by the next step, and
  # the FRESH_ENV logic that protects an existing database depends on knowing
  # which of those two things happened.
  [ -f "$ROOT/.env" ] || fetch .env.example .env.example
  ok 'compose file, Caddyfile, up.sh, down.sh, install.sh'

  {
    echo '# .forgegrowth-install — written by install.sh, safe to delete'
    echo 'mode=images'
    echo "ref=$FETCH_REF"
    echo "version=$PINNED_REF"
    echo "installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STAMP"
fi

# ── 2. configuration ─────────────────────────────────────────────────────────
step 'Configuring'

ENV_FILE="$ROOT/.env"
# Whether this run is starting from scratch. It decides whether a database that
# already exists on this machine may be adopted: an .env we just generated has
# secrets that no existing database can match (see "which install is this?").
FRESH_ENV=0
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ROOT/.env.example" ] || die ".env.example is missing from $ROOT.
  On the images path it is downloaded; on a source path it comes with the
  checkout. If this IS a checkout, pass --source to say so."
  cp "$ROOT/.env.example" "$ENV_FILE"
  FRESH_ENV=1
  ok "created .env from .env.example"
else
  ok "using the existing .env (values already set are left alone)"
fi

# get_env <key> -> current value ('' if unset/commented)
get_env() { sed -n "s/^${1}=//p" "$ENV_FILE" | head -1; }

# set_env <key> <value> — replaces the line in place, or appends if absent.
# In-place rather than appending duplicates: two definitions of one key is
# legal for compose (last wins) but is the kind of file nobody can debug later.
set_env() {
  local key="$1" val="$2" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/forgegrowth.XXXXXX")
  if grep -q "^${key}=" "$ENV_FILE"; then
    # value goes through the environment, so any character is safe in it
    KEY="$key" VAL="$val" awk '
      index($0, ENVIRON["KEY"] "=") == 1 && !done { print ENVIRON["KEY"] "=" ENVIRON["VAL"]; done=1; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

# A value counts as "needs filling" when it is empty or still a placeholder.
needs_value() {
  local v; v=$(get_env "$1")
  case "$v" in
    ''|change-me|change-me-too|changeme|your-*|CHANGE_ME) return 0 ;;
    *) return 1 ;;
  esac
}

# ── which install is this? ───────────────────────────────────────────────────
#
# ⚠ THE COMPOSE PROJECT NAME IS THE ONLY THING SEPARATING TWO INSTALLS ON ONE
# MACHINE. It prefixes the containers *and* the volumes, so two checkouts that
# share a name share a database — and the second install.sh then points freshly
# generated secrets at the first one's data.
#
# That failure is silent at install time and ugly later. Postgres reads
# POSTGRES_PASSWORD only when it first creates its data directory, so the new
# password is ignored and the backend loops on an authentication error naming
# the database rather than the real cause. FORGECRM_ENCRYPTION_KEY is worse: it
# would decrypt nothing that the first install stored.
#
# docker-compose.yml pins `name: forgegrowth`, which is right for the ordinary
# one-install-per-machine case. COMPOSE_PROJECT_NAME in .env overrides it, so a
# second install claims its own name and the published compose file needs no
# change at all.
#
# Who already holds a project name: 'me' (containers created from THIS
# directory), 'other' (another directory's), 'orphan' (no containers, but a
# database volume outlived them — `docker compose down` keeps volumes), or
# empty when the name is free.
project_owner() {
  local name="$1" dirs
  dirs=$(docker ps -a --filter "label=com.docker.compose.project=$name" \
           --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u)
  if [ -n "$dirs" ]; then
    if [ "$dirs" = "$ROOT" ]; then echo me; else echo other; fi
    return
  fi
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${name}_pgdata"; then
    echo orphan; return
  fi
  echo ''
}

# An explicit COMPOSE_PROJECT_NAME in the environment wins, so the suggestion
# printed by the guard below actually works; .env is where it then lives.
PROJECT=${COMPOSE_PROJECT_NAME:-}
[ -n "$PROJECT" ] || PROJECT=$(get_env COMPOSE_PROJECT_NAME)
if [ -n "$PROJECT" ]; then
  set_env COMPOSE_PROJECT_NAME "$PROJECT"
  ok "install name '$PROJECT'  ${DIM}(named already — upgrading this install in place)${N}"
else
  # No name recorded yet: either the first install ever, or one made before
  # install.sh started recording it. Walk up until a name is free or provably
  # ours, and never adopt data we cannot show belongs to this directory.
  candidate=forgegrowth; n=1; stepped=''; mine=0
  while : ; do
    case "$(project_owner "$candidate")" in
      '') break ;;
      # Containers created from THIS directory: not a collision at all, this is
      # the install we belong to. Anything we stepped over on the way is
      # somebody else's business and not worth reporting.
      me) mine=1; stepped=''; break ;;
      orphan)
        # An .env that survived a `docker compose down` is this directory's own
        # record of that stack, secrets included — so the data really is ours.
        # A brand-new .env cannot make that claim about anybody's data.
        [ "$FRESH_ENV" = 0 ] && { mine=1; stepped=''; break; }
        stepped="a stopped install named '$candidate' still holds a database here"
        ;;
      other) stepped="'$candidate' belongs to another install on this machine" ;;
    esac
    n=$((n + 1)); candidate="forgegrowth-$n"
  done
  PROJECT="$candidate"
  set_env COMPOSE_PROJECT_NAME "$PROJECT"
  if [ "$mine" = 1 ]; then
    ok "install name '$PROJECT'  ${DIM}(this directory's existing install)${N}"
  elif [ -n "$stepped" ]; then
    warn "$stepped"
    ok "install name '$PROJECT'  ${DIM}(a separate install — its own containers, database and volumes)${N}"
    warn "to upgrade that other install instead, run this script from ITS directory."
  else
    ok "install name '$PROJECT'"
  fi
fi
# Exported so every `docker compose` below resolves the same project even if the
# shell is invoked from elsewhere; .env carries it for every later manual run.
export COMPOSE_PROJECT_NAME="$PROJECT"

# Belt and braces for the one case the walk above cannot route around: this
# directory's containers exist (owner 'me') but its .env has been lost, so the
# secrets are new and the database they must open is not.
if [ "$FRESH_ENV" = 1 ] && docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${PROJECT}_pgdata"; then
  # Suggest a name that is actually free — pointing at a taken one would send
  # the reader straight back into this same error.
  free=forgegrowth; fn=1
  while [ -n "$(project_owner "$free")" ]; do fn=$((fn + 1)); free="forgegrowth-$fn"; done
  # .env came from .env.example moments ago and has no data behind it; leaving
  # it would make the NEXT run look like an upgrade of a database it cannot open.
  rm -f "$ENV_FILE"
  die "install '$PROJECT' already has a database, but this .env was just generated,
  so its POSTGRES_PASSWORD and FORGECRM_ENCRYPTION_KEY do not match it. Postgres
  only applies POSTGRES_PASSWORD when it first creates its data, and the
  encryption key decrypts credentials stored under the old one.

  Nothing was changed, and the generated .env has been removed.

  Either restore that install's original .env here and re-run,
  or start a separate install:   COMPOSE_PROJECT_NAME=$free $SELF
  or discard the old data:       docker volume rm ${PROJECT}_pgdata   (deletes it permanently)"
fi

# Refuse a port already in use rather than letting `compose up` fail later with
# a bind error buried in the output. Each tool here exists on a different
# platform (ss = Linux, lsof = macOS, netstat = both + Git Bash); if none is
# present we simply skip the check rather than guessing.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${1}[[:space:]]"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${1}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -qE "[:.]${1}[[:space:]].*LISTEN"
  else
    return 1
  fi
}
# ...but the port being busy is EXPECTED when re-running against a stack that is
# already up — that container is the one holding it. Only object when the
# listener is somebody else's. Resolved through COMPOSE_PROJECT_NAME above, so
# it asks about THIS install and not a namesake.
ours_running=0
if docker compose ps --status running --services 2>/dev/null | grep -qx web; then
  ours_running=1
fi

# ── the one question ─────────────────────────────────────────────────────────
#
# Everything about the public address comes from a single answer: the CORS
# origin, the host used to build public links, whether HTTPS is switched on, and
# whether the plain-HTTP port is exposed at all. Asking for those separately —
# port, then public URL, then domain — was asking one question four times in
# four different vocabularies, and every one of them could disagree with the
# others.
if   [ -n "$DOMAIN" ];     then ADDRESS=$DOMAIN
elif [ -n "$PUBLIC_URL" ]; then ADDRESS=$PUBLIC_URL
else
  # An install that already has an address KEEPS it, without asking. Re-running
  # this script is how you upgrade, and an upgrade must not need somebody at a
  # keyboard — nor quietly move the site. --domain and --url are how it moves.
  #
  # Reconstructed so the shape comes out the same as last time, which CORS_ORIGIN
  # alone cannot tell you: https://crm.example.com is a caddy install when
  # TLS_DOMAIN names it and somebody else's proxy when it does not, and those two
  # differ in whether this stack should start caddy at all.
  keep_tls=$(get_env TLS_DOMAIN)
  keep_origin=$(get_env CORS_ORIGIN)
  reuse=''
  if [ "$FRESH_ENV" = 0 ]; then
    if [ -n "$keep_tls" ]; then reuse=tls
    else
      case "$keep_origin" in
        https://*) reuse=proxy ;;
        http://*)  reuse=plain ;;
      esac
    fi
  fi
  case "$reuse" in
    tls)   DOMAIN=$keep_tls; ADDRESS=$keep_tls
           ok "address https://$keep_tls  ${DIM}(unchanged)${N}" ;;
    proxy) PUBLIC_URL=$keep_origin; URL_GIVEN=1; ADDRESS=$keep_origin
           ok "address $keep_origin  ${DIM}(unchanged)${N}" ;;
    plain)
      # A plain-HTTP origin on a real hostname can only have come from --url —
      # nothing here terminates TLS for it — so it has to come back as `proxy`,
      # or the dots in that name would read as a domain and start caddy for it.
      case "${keep_origin#http://}" in
        localhost*|127.0.0.1*) ADDRESS=${keep_origin#*://} ;;
        *) PUBLIC_URL=$keep_origin; URL_GIVEN=1; ADDRESS=$keep_origin ;;
      esac
      ok "address $keep_origin  ${DIM}(unchanged)${N}" ;;
    *)
      ADDRESS=$(ask 'Domain people will use to reach this (blank for localhost)' \
                    localhost --domain) ;;
  esac
fi

# Normalise first: a scheme, a trailing path and a trailing dot all describe the
# same address, and only one of those spellings should reach the logic below.
ADDRESS=${ADDRESS#*://}; ADDRESS=${ADDRESS%%/*}; ADDRESS=${ADDRESS%.}
ADDR_PORT=''
case "$ADDRESS" in *:[0-9]*) ADDR_PORT=${ADDRESS##*:}; ADDRESS=${ADDRESS%:*} ;; esac
ADDRESS=$(printf '%s' "$ADDRESS" | tr '[:upper:]' '[:lower:]')

is_ipv4() {
  case "$1" in ''|*[!0-9.]*) return 1 ;; esac
  local octet rest="$1" count=0
  while [ -n "$rest" ]; do
    octet=${rest%%.*}
    case "$rest" in *.*) rest=${rest#*.} ;; *) rest='' ;; esac
    [ -n "$octet" ] || return 1
    [ "$octet" -le 255 ] 2>/dev/null || return 1
    count=$((count + 1))
  done
  [ "$count" = 4 ]
}

# ⚠ The order of these tests matters. 203.0.113.4 has dots in it and is NOT a
# domain — checking for a dot first would send the installer off to obtain a
# certificate for an IP address, which Let's Encrypt will never issue, and the
# failure would surface two minutes later inside Caddy's log.
if [ -z "$ADDRESS" ] || [ "$ADDRESS" = localhost ] || [ "$ADDRESS" = 127.0.0.1 ]; then
  SHAPE=local; ADDRESS=localhost
elif is_ipv4 "$ADDRESS"; then
  SHAPE=ip
else
  case "$ADDRESS" in
    *' '*) die "'$ADDRESS' is not a hostname. Use something like crm.example.com." ;;
    *.*)   SHAPE=domain ;;
    *)     die "'$ADDRESS' has no dot in it, so no certificate could ever be issued
  for it. Use a full hostname like crm.example.com, an IP address, or leave it
  blank for an install only this machine can reach." ;;
  esac
fi
# --url means "my own proxy terminates TLS": take the origin as given and leave
# the bundled caddy alone, however domain-shaped the address looks.
if [ "$URL_GIVEN" = 1 ] && [ -z "$DOMAIN" ]; then SHAPE=proxy; fi

# ── the host port ────────────────────────────────────────────────────────────
#
# Resolved after the address, not before, because the address can contain one:
# answering "localhost:9000" has to end up serving on 9000, or the URL printed
# at the end is not the URL the stack is listening on. --port still wins over
# both, and a domain install ignores the question entirely — there the port is
# bound to loopback and only caddy talks to it.
#
# No longer asked. "Host port for the web UI" is not a question the person this
# installer exists for can answer.
if [ -z "$WEB_PORT" ]; then
  if [ -n "$ADDR_PORT" ] && [ "$SHAPE" != domain ]; then
    WEB_PORT=$ADDR_PORT
  else
    WEB_PORT=$(get_env WEB_PORT); WEB_PORT=${WEB_PORT:-8080}
    # A second install on one machine always collides on 8080, and "port in use,
    # re-run with --port" is a dead end the script can simply walk past. Only the
    # automatic choice moves: --port is still obeyed exactly, and a port given by
    # hand still fails below rather than being changed underneath you.
    if [ "$ours_running" = 0 ] && port_in_use "$WEB_PORT"; then
      busy=$WEB_PORT
      while port_in_use "$WEB_PORT"; do WEB_PORT=$((WEB_PORT + 1)); done
      warn "port $busy is in use — using $WEB_PORT instead"
    fi
  fi
fi
case "$WEB_PORT" in ''|*[!0-9]*) die "--port must be a number (got '$WEB_PORT')" ;; esac

if [ "$ours_running" = 0 ] && port_in_use "$WEB_PORT"; then
  die "port $WEB_PORT is already in use by another process. Re-run with --port <other>."
fi

# ── first-run admin ──────────────────────────────────────────────────────────
#
# Not a question either. On a domain install admin@<that domain> is an address
# the operator controls, which matters because it is also what goes to Let's
# Encrypt as the certificate contact — the old default sent admin@example.com, a
# reserved domain nobody can receive mail at. Changed in the UI afterwards.
[ -n "$ADMIN_EMAIL" ] || ADMIN_EMAIL=$(get_env BOOTSTRAP_ADMIN_EMAIL)
if [ -z "$ADMIN_EMAIL" ] || [ "$ADMIN_EMAIL" = 'admin@example.com' ]; then
  ADMIN_EMAIL='admin@example.com'
  # Only a real hostname earns this. "localhost" and an IP address are not mail
  # domains, and admin@203.0.113.4 handed to Let's Encrypt is worse than the
  # placeholder it replaced.
  case "$SHAPE" in
    domain|proxy)
      if ! is_ipv4 "$ADDRESS"; then
        case "$ADDRESS" in *.*) ADMIN_EMAIL="admin@$ADDRESS" ;; esac
      fi ;;
  esac
fi

# ── HTTPS ────────────────────────────────────────────────────────────────────
#
# A domain is the whole public-address story: it turns on the bundled caddy
# (compose profile `tls`), which obtains and renews a Let's Encrypt certificate
# knowing nothing but the domain. No resolver to configure, no acme.json, and
# nothing in this repo that names one particular server — which is what made
# the previous arrangement, a hand-written proxy file living outside the repo,
# impossible to reproduce anywhere else.
#
# COMPOSE_PROFILES goes into .env rather than being passed here, so every later
# plain `docker compose up -d` from this directory still brings HTTPS up.
DOMAIN=''
if [ "$SHAPE" = domain ]; then
  DOMAIN=$ADDRESS
  [ -z "$ADDR_PORT" ] || warn "HTTPS is served on 443 — ignoring the :$ADDR_PORT."

  # 80 is not optional: the certificate challenge arrives on it. Failing here
  # beats failing inside Caddy, where the reason is a stack trace about binding.
  tls_running=0
  if docker compose ps --status running --services 2>/dev/null | grep -qx caddy; then tls_running=1; fi
  if [ "$tls_running" = 0 ]; then
    for p in 80 443; do
      if port_in_use "$p"; then
        die "port $p is in use, and HTTPS needs both 80 and 443.
  Something else — another web server, or a reverse proxy — is already there.
  Either stop it, or give the address as --url https://$ADDRESS and point that
  proxy at port $WEB_PORT instead."
      fi
    done
  fi

  [ -n "$TLS_EMAIL" ] || TLS_EMAIL=$(get_env TLS_EMAIL)
  # Defaulting to the admin address keeps this to ONE required argument. Let's
  # Encrypt only uses it to warn before a renewal failure expires the site.
  [ -n "$TLS_EMAIL" ] || TLS_EMAIL=$ADMIN_EMAIL

  set_env TLS_DOMAIN "$DOMAIN"
  set_env TLS_EMAIL "$TLS_EMAIL"
  set_env COMPOSE_PROFILES tls
  # Admin Settings -> Domain can add more domains later and caddy will obtain
  # their certificates on first visit, because this install owns 80 and 443.
  set_env TLS_MODE caddy
  # With caddy in front, the plain-HTTP port must not also be public, or the
  # site is reachable twice and once of those has no certificate.
  set_env WEB_BIND 127.0.0.1
  export COMPOSE_PROFILES=tls

  if [ "$TLS_EMAIL" = internal ]; then
    ok "HTTPS on $DOMAIN  ${DIM}(self-signed — browsers will warn)${N}"
  else
    ok "HTTPS on $DOMAIN  ${DIM}(Let's Encrypt, renewed automatically)${N}"
    # A certificate cannot be issued for a name that does not point here, and
    # the failure otherwise appears minutes later in Caddy's log. A warning and
    # not an error: split-horizon DNS and a proxied A record both look wrong
    # from inside the machine yet work perfectly from outside.
    #
    # ⚠ The `|| true` inside each pipeline is load-bearing. `getent` exits 2 when
    # a name does not resolve, and under `set -o pipefail` that status becomes
    # the pipeline's — so `set -e` killed the install, silently, at exit 2, in
    # precisely the case this check exists to report gently: a domain whose DNS
    # has not propagated yet.
    resolved=''
    if command -v getent >/dev/null 2>&1; then
      resolved=$( { getent ahostsv4 "$DOMAIN" 2>/dev/null || true; } | awk 'NR==1{print $1}')
    elif command -v dig >/dev/null 2>&1; then
      resolved=$( { dig +short A "$DOMAIN" 2>/dev/null || true; } | head -1)
    fi
    if [ -z "$resolved" ]; then
      warn "$DOMAIN does not resolve yet — add its DNS record, or the certificate will not be issued."
    else
      ok "$DOMAIN resolves to $resolved"
    fi
  fi
else
  # Make sure a previous domain run does not leave HTTPS half-on: the profile
  # would still start caddy, now for a domain this install no longer answers to.
  if [ -n "$(get_env COMPOSE_PROFILES)" ]; then
    set_env COMPOSE_PROFILES ''
    set_env TLS_DOMAIN ''
    set_env WEB_BIND '0.0.0.0'
    warn 'HTTPS turned off — re-run with --domain <host> to bring it back.'
  fi

  # ── can this install add domains for itself later? ───────────────────────
  #
  # Admin Settings -> Domain lets someone add a domain long after installing,
  # and the bundled caddy obtains its certificate on the first visit. That only
  # works if THIS install is the thing answering on 80 and 443, and on a shared
  # server it will not be — another install, or a reverse proxy, already has
  # them. There is no way to share a port, so the honest thing is to work out
  # which situation this is now and let the app say so plainly, rather than
  # offering a button that silently does nothing on half of all servers.
  #
  # `proxy` is not a lesser install. Adding a domain there still widens the
  # allow-list immediately, which is half of what makes a domain work; only the
  # certificate has to come from whatever already owns the ports.
  if [ "$SHAPE" = proxy ]; then
    # Told explicitly that something else terminates TLS. Believe it, and do not
    # start a caddy that would fight the proxy for the ports.
    set_env TLS_MODE proxy
  elif port_in_use 80 || port_in_use 443; then
    set_env TLS_MODE proxy
    ok "another program owns ports 80/443  ${DIM}(domains added later need it pointed here)${N}"
  else
    # Free ports: run caddy now, with no domain of its own, purely so a domain
    # added later needs nothing but DNS. It costs 64 MB and binds 80/443.
    set_env COMPOSE_PROFILES tls
    set_env TLS_MODE caddy
    export COMPOSE_PROFILES=tls
    ok "HTTPS ready  ${DIM}(add a domain in Admin Settings → Domain whenever you like)${N}"
  fi
fi

# ── the derived address ──────────────────────────────────────────────────────
case "$SHAPE" in
  domain) PUBLIC_URL="https://$ADDRESS" ;;
  proxy)  PUBLIC_URL=${PUBLIC_URL%/} ;;
  # WEB_PORT already absorbed any port in the address, so there is one source
  # of truth for it rather than two that can disagree.
  *)      PUBLIC_URL="http://$ADDRESS:$WEB_PORT" ;;
esac

if [ "$SHAPE" = ip ]; then
  set_env WEB_BIND '0.0.0.0'
  # Worth saying plainly, because the install otherwise looks completely fine
  # and only fails later, in Meta's console, for a reason given nowhere here.
  warn "no certificate is possible for an IP address, so this is plain HTTP."
  warn "Meta will not accept a webhook URL that is not https://, and public lead-form"
  warn "links are built as https:// too — re-run with --domain <host> before"
  warn "connecting a WhatsApp number."
elif [ "$SHAPE" = proxy ]; then
  case "$PUBLIC_URL" in
    https://*)
      ok "public origin $PUBLIC_URL  ${DIM}(HTTPS terminated by your proxy)${N}"
      # ⚠ This binding is the fix for a bug that reads as anything but a binding.
      #
      # Left on 0.0.0.0, the same site also answers on http://<host>:$WEB_PORT,
      # and sooner or later somebody signs in THERE — it works, after all. But
      # the login cookie is marked Secure, because the configured origin is
      # https, and a browser silently discards a Secure cookie delivered over
      # plain HTTP. Login returns 200 and the app renders from the response
      # body; the next request carries no cookie and gets a 401. It presents as
      # "logged out on every refresh" and "unauthorized when I change page",
      # with nothing in any log, on an install where every check passed.
      #
      # So the second address simply stops existing. A proxy on this machine
      # still reaches it; one in a container reaches `web` over the docker
      # network and never used the host port at all.
      set_env WEB_BIND 127.0.0.1
      ok "port $WEB_PORT bound to localhost  ${DIM}(so nobody can sign in over plain HTTP)${N}"
      warn "if your proxy runs on a DIFFERENT machine, set WEB_BIND=0.0.0.0 in .env." ;;
    *)
      set_env WEB_BIND '0.0.0.0'
      warn "the public origin is not https://. Meta requires HTTPS for webhooks." ;;
  esac
  warn "nothing here terminates TLS — point your proxy at port $WEB_PORT."
elif [ "$SHAPE" = local ]; then
  set_env WEB_BIND '0.0.0.0'
  ok "http://localhost:$WEB_PORT  ${DIM}(reachable from this machine only)${N}"
fi

GENERATED_PASSWORD=''
if [ -z "$ADMIN_PASSWORD" ] && needs_value BOOTSTRAP_ADMIN_PASSWORD; then
  ADMIN_PASSWORD=$(openssl rand -base64 15 | tr -d '\n=+/')
  GENERATED_PASSWORD=1
fi

set_env WEB_PORT "$WEB_PORT"
set_env CORS_ORIGIN "$PUBLIC_URL"
# NOT a cookie domain — util/session.js sets no cookie domain at all. This is the
# fallback host for building absolute links (the public lead-form page, the MCP
# connector URL) when a request arrives with no Host header. Those are built as
# scheme://host, so a non-default port has to survive into it or the links 404.
fg_host=${PUBLIC_URL#*://}; fg_host=${fg_host%%/*}
set_env FORGECRM_DOMAIN "$fg_host"
set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
if [ -n "$ADMIN_PASSWORD" ]; then set_env BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD"; fi
# Written out rather than left to the compose default, so the version this
# install runs is visible in .env and can be changed there. A hand-edited value
# survives, because only an explicit pin overrides it.
if [ "$MODE" = images ]; then
  if [ -n "$PINNED_REF" ] && [ "$PINNED_REF" != main ]; then
    IMAGE_TAG=$PINNED_REF
  else
    IMAGE_TAG=$(get_env FORGEGROWTH_TAG)
  fi
  # A git ref is not an image tag. `refs/heads/my-branch` in this field makes
  # `docker compose pull` fail with "invalid reference format", which names the
  # format and not the field — so drop anything that cannot be a tag and fall
  # back, instead of leaving somebody to hand-edit .env to escape it.
  case "$IMAGE_TAG" in */*|*' '*|*:*) IMAGE_TAG='' ;; esac
  IMAGE_TAG=${IMAGE_TAG:-latest}
  set_env FORGEGROWTH_TAG "$IMAGE_TAG"
fi
ok "web on port $WEB_PORT, public URL $PUBLIC_URL"

# ── 3. secrets ───────────────────────────────────────────────────────────────
step 'Generating secrets'

gen_if_needed() { # gen_if_needed <key> <generator-command> <description>
  if needs_value "$1"; then
    set_env "$1" "$(eval "$2")"
    ok "generated $1  ${DIM}($3)${N}"
  else
    ok "kept existing $1"
  fi
}

gen_if_needed FORGECRM_JWT_SECRET   "openssl rand -base64 48 | tr -d '\n=+/'" 'signs login cookies'
# Must be exactly 32 bytes of hex — util/crypto.js derives an AES-256 key from it.
gen_if_needed FORGECRM_ENCRYPTION_KEY "openssl rand -hex 32"                  'encrypts stored credentials'
gen_if_needed META_WEBHOOK_VERIFY_TOKEN "openssl rand -hex 16"                'paste into Meta webhook setup'
gen_if_needed POSTGRES_PASSWORD     "openssl rand -base64 24 | tr -d '\n=+/'" 'database'
gen_if_needed MINIO_ROOT_PASSWORD   "openssl rand -base64 24 | tr -d '\n=+/'" 'object storage'

# The backend prefers MINIO_SECRET_KEY over MINIO_ROOT_PASSWORD. If one is set
# and the other is not, the server and client disagree and every upload fails
# with SignatureDoesNotMatch — so keep the pair consistent, always.
if [ -n "$(get_env MINIO_SECRET_KEY)" ]; then
  set_env MINIO_SECRET_KEY "$(get_env MINIO_ROOT_PASSWORD)"
  set_env MINIO_ACCESS_KEY "$(get_env MINIO_ROOT_USER)"
  ok 'aligned MINIO_ACCESS_KEY/SECRET_KEY with the server credentials'
fi

chmod 600 "$ENV_FILE"
ok '.env locked to owner-only (chmod 600)'

# A 32-byte hex key is load-bearing: the wrong length fails at the first
# credential write, long after install "succeeded".
enc=$(get_env FORGECRM_ENCRYPTION_KEY)
[ ${#enc} -eq 64 ] || die "FORGECRM_ENCRYPTION_KEY must be 64 hex characters (32 bytes); got ${#enc}."

# ── 4. images ────────────────────────────────────────────────────────────────
if [ "$MODE" = source ] && [ "$DO_BUILD" = 1 ]; then
  step 'Building images (first run takes a few minutes)'
  docker compose build || die "the image build failed — scroll up for the first error."
  ok 'images built'
elif [ "$MODE" = images ]; then
  step "Downloading images ($IMAGE_TAG)"
  pull_log=$(mktemp "${TMPDIR:-/tmp}/forgegrowth-pull.XXXXXX")
  if docker compose pull 2>"$pull_log"; then
    rm -f "$pull_log"
    ok 'images downloaded'
  else
    pull_err=$(cat "$pull_log"); rm -f "$pull_log"
    printf '%s\n' "$pull_err" >&2
    case "$pull_err" in
      # A GHCR package is created PRIVATE even when its repository is public, and
      # the publish workflow cannot change that. So the first install from a
      # fresh fork fails here with a bare 403 while CI reports a clean success —
      # a green signal that does not cover the thing that broke.
      *denied*|*403*|*nauthorized*)
        die "the registry refused to hand over the images.

  A GHCR package is private by default even when its repository is public.
  Whoever owns $REPO needs to publish both packages, once:
    Packages -> forgegrowth-backend, then forgegrowth-web
    -> Package settings -> Change visibility -> Public" ;;
      *manifest*nknown*|*ot\ found*|*invalid\ reference\ format*)
        die "no images are published as '$IMAGE_TAG'.
  Check the version, or leave --version off to take the current release." ;;
      *)
        die "could not download the images — the error above is Docker's." ;;
    esac
  fi
fi

# ── 5. start ─────────────────────────────────────────────────────────────────
#
# The tls profile bind-mounts ./caddy/Caddyfile. When that file is missing Docker
# silently creates a DIRECTORY in its place and Caddy exits with "is a
# directory", which describes the symptom and not one word of the cause.
case ",$(get_env COMPOSE_PROFILES)," in
  *,tls,*)
    [ -f "$ROOT/caddy/Caddyfile" ] || die "HTTPS is on, but $ROOT/caddy/Caddyfile is missing.
  Docker would create a directory at that path and Caddy would refuse to start.
  Re-run $SELF, which fetches it." ;;
esac

step 'Starting services'
docker compose up -d || die "docker compose up failed."

# depends_on with a healthcheck already gates the backend, but the migration
# step below runs from the HOST, so wait here too rather than racing it.
printf '  waiting for postgres'
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -q 2>/dev/null; then break; fi
  printf '.'; sleep 2
  if [ "$i" = 60 ]; then echo; die "postgres never became ready. Check: docker compose logs postgres"; fi
done
echo; ok 'postgres ready'

# ── 6. migrations ────────────────────────────────────────────────────────────
#
# The backend image bakes in supabase/migrations and applies them from its
# entrypoint before the app starts (AUTO_MIGRATE), on BOTH paths — so this is a
# second way of doing it, not the only one. It is worth keeping on a checkout,
# where the SQL on disk can be newer than the image that was just built. On the
# images path there is no SQL on disk and no psql on the host, which is the
# entire reason that path needs no repository.
if [ "$MODE" = source ]; then
  step 'Applying database migrations'
  "$ROOT/scripts/migrate.sh" || die "migrations failed — the schema may be half-applied. Fix the SQL error above and re-run."

  # The backend runs its ensure*Tables() bootstrap at startup and may have started
  # before the schema existed. Restart it now so it comes up against a complete DB.
  step 'Restarting the backend against the finished schema'
  docker compose restart backend >/dev/null
  ok 'backend restarted'
else
  ok 'migrations applied by the backend container at startup'
fi

# ── 7. verify ────────────────────────────────────────────────────────────────
step 'Verifying'
printf '  waiting for the web UI'
code=''
for i in $(seq 1 45); do
  # `|| code=000` rather than `|| echo 000`: curl already prints 000 of its own
  # when it cannot connect, so echoing another one concatenated them and the
  # failure message read "HTTP 000000".
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null) || code=000
  if [ "$code" = 200 ]; then break; fi
  printf '.'; sleep 2
done
echo
if [ "$code" = 200 ]; then
  ok "web UI responding on http://localhost:${WEB_PORT}/"
else
  warn "the web UI returned HTTP ${code:-none} — check: docker compose logs web backend"
fi

# With --domain, "the app is up" is only half the answer: the address people
# will actually type has to work too. Checking it here is the difference
# between an install that prints an https:// URL and one that has verified it.
if [ -n "$DOMAIN" ]; then
  printf '  waiting for the certificate'
  tls_code=''
  # Up to ~2 minutes: issuance is usually seconds, but a cold ACME challenge on
  # a busy server is slower, and this must not fail an install that will be
  # fine a minute later.
  for i in $(seq 1 40); do
    # --insecure so a self-signed (TLS_EMAIL=internal) certificate still counts
    # as "serving"; this is checking reachability, not trust.
    tls_code=$(curl -sk -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" 2>/dev/null) || tls_code=000
    if [ "$tls_code" = 200 ]; then break; fi
    printf '.'; sleep 3
  done
  echo
  if [ "$tls_code" = 200 ]; then
    ok "https://${DOMAIN}/ responding"
    # Responding is not the same claim as trusted. The loop above passes on a
    # self-signed certificate — a proxy's built-in default, or an ACME failure
    # that left one behind — and every browser then shows a warning page, while
    # Meta refuses the webhook outright. So ask the question a browser asks,
    # once, WITHOUT -k. Only when a real certificate was the goal: TLS_EMAIL of
    # "internal" means self-signed was the intention.
    if [ "$TLS_EMAIL" != internal ]; then
      if curl -s -o /dev/null --max-time 15 "https://${DOMAIN}/" 2>/dev/null; then
        ok "certificate is publicly trusted"
      else
        warn "the certificate is NOT publicly trusted — a browser will warn, and"
        warn "Meta will refuse a webhook on it. The site itself is serving fine."
        warn "Usually one of:"
        warn "  · issuance has not finished yet — re-check in a minute"
        warn "  · the domain is proxied (Cloudflare's orange cloud), so the"
        warn "    challenge never reaches this machine; use DNS-only while it issues"
        warn "  · the Let's Encrypt account is rate-limited from earlier failures"
        warn "Check with:  docker compose logs caddy | grep -i acme"
      fi
    fi
  else
    warn "https://${DOMAIN}/ returned HTTP ${tls_code:-none}."
    warn "The app itself is up; this is the certificate or the DNS. Check:"
    warn "  docker compose logs caddy"
    warn "Most often: the domain does not point at this machine yet, or port 80"
    warn "is blocked by a firewall so the certificate challenge cannot arrive."
  fi
fi

# ── 8. credentials ───────────────────────────────────────────────────────────
step 'Done'

cat <<EOF

  ${B}Forge Growth is running.${N}

    URL       ${PUBLIC_URL}
    Sign in   ${ADMIN_EMAIL}
    Install   ${PROJECT}   ${DIM}(this machine may hold several; commands below act on this one)${N}
EOF

if [ -n "$ADMIN_PASSWORD" ]; then
  if [ -n "$GENERATED_PASSWORD" ]; then
    printf '    Password  %s%s%s   %s(generated — also stored in .env)%s\n' "$B" "$ADMIN_PASSWORD" "$N" "$DIM" "$N"
  else
    printf '    Password  %s(the one you supplied)%s\n' "$DIM" "$N"
  fi
elif [ -n "$(get_env BOOTSTRAP_ADMIN_PASSWORD)" ]; then
  # Re-run against an existing install: we did not touch the password, and it is
  # sitting in .env — so do not send the reader to a log line that is long gone.
  printf '    Password  %s(unchanged — see BOOTSTRAP_ADMIN_PASSWORD in .env)%s\n' "$DIM" "$N"
else
  echo '    Password  printed once in the backend log:'
  echo '                docker compose logs backend | grep -A5 "FIRST-RUN ADMIN"'
fi

if [ "$MODE" = source ]; then
  STOP_CMD='./scripts/down.sh'
  UPGRADE_CMD='git pull && ./scripts/install.sh'
  REMOVE_CMD="./scripts/uninstall.sh          ${DIM}(deletes all data)${N}"
else
  STOP_CMD='./down.sh'
  # No `git pull` to precede it: the script re-downloads the compose file and
  # its own copy, then pulls the images. Pinned installs stay pinned — the ref
  # is remembered in .forgegrowth-install.
  UPGRADE_CMD="./install.sh                   ${DIM}(or --version vX.Y.Z)${N}"
  REMOVE_CMD="docker compose down -v          ${DIM}(deletes all data)${N}"
fi

cat <<EOF

  ${DIM}Next steps${N}
    Connect a WhatsApp number   Admin Settings → WhatsApp Accounts
    Point Meta's webhook at     ${PUBLIC_URL}/api/webhook/whatsapp
    with the verify token in    .env → META_WEBHOOK_VERIFY_TOKEN

  ${DIM}Managing the stack${N} ${DIM}— run these from ${ROOT}; the directory is what picks the install${N}
    Logs      docker compose logs -f backend
    Start     ${STOP_CMD%down.sh}up.sh
    Stop      ${STOP_CMD}
    Upgrade   ${UPGRADE_CMD}
    Remove    ${REMOVE_CMD}
    List all  docker compose ls

  ${Y}Back up FORGECRM_ENCRYPTION_KEY from .env.${N} It decrypts every stored Meta,
  Google and payment-gateway credential. Lose it and they must all be re-entered.

EOF
