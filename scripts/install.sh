#!/usr/bin/env bash
# ─── Forge Growth — one-command install ──────────────────────────────────────
#
#   ./scripts/install.sh
#
# Brings up the whole stack from nothing: checks prerequisites, writes a .env
# with freshly generated secrets, builds the images, waits for Postgres/Redis/
# MinIO to be genuinely ready, applies every migration, and prints the admin
# credentials you sign in with.
#
# Safe to re-run. An existing .env is never overwritten — only empty or
# placeholder values are filled in — so re-running after a `git pull` is the
# normal way to upgrade.
#
# Flags (all optional; without them the script asks, or uses the default):
#   --port <n>            host port for the web UI          (default 8080)
#   --url <origin>        public origin, e.g. https://crm.example.com
#                         (default http://localhost:<port>)
#   --admin-email <addr>  first-run admin                   (default admin@example.com)
#   --admin-password <pw> first-run admin password          (default: generated)
#   --no-build            skip `docker compose build`
#   --yes, -y             never prompt; accept every default
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

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

# ── arguments ────────────────────────────────────────────────────────────────
WEB_PORT=''; PUBLIC_URL=''; ADMIN_EMAIL=''; ADMIN_PASSWORD=''
ASSUME_YES=0; DO_BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port)           WEB_PORT="${2:-}"; shift 2 ;;
    --url)            PUBLIC_URL="${2:-}"; shift 2 ;;
    --admin-email)    ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --no-build)       DO_BUILD=0; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    -h|--help)        sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                die "unknown option: $1 (try --help)" ;;
  esac
done

ask() { # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="$2" reply
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then echo "$default"; return; fi
  printf '  %s [%s]: ' "$prompt" "$default" >&2
  read -r reply || reply=''
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
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose plugin, openssl"

# Building the frontend needs real memory; a 1 GB VPS OOMs mid-build with an
# error that looks like a code fault rather than a resource limit.
if [ -r /proc/meminfo ]; then
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if [ "$mem_mb" -lt 1800 ]; then
    warn "only ${mem_mb} MB RAM detected — the frontend build may be OOM-killed."
    warn "If it dies without a clear error, add swap or build elsewhere and push the image."
  else
    ok "${mem_mb} MB RAM"
  fi
fi

avail_mb=$(df -Pm . | awk 'NR==2 {print $4}')
if [ "$avail_mb" -lt 3000 ]; then
  warn "only ${avail_mb} MB free disk — images need roughly 2-3 GB."
else
  ok "${avail_mb} MB free disk"
fi

# ── 2. configuration ─────────────────────────────────────────────────────────
step 'Configuring'

ENV_FILE="$ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ROOT/.env.example" ] || die ".env.example is missing — is this a complete checkout?"
  cp "$ROOT/.env.example" "$ENV_FILE"
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
  tmp=$(mktemp)
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

if [ -z "$WEB_PORT" ]; then
  current=$(get_env WEB_PORT); current=${current:-8080}
  WEB_PORT=$(ask 'Host port for the web UI' "$current")
fi
case "$WEB_PORT" in ''|*[!0-9]*) die "--port must be a number (got '$WEB_PORT')" ;; esac

# Refuse a port already in use rather than letting `compose up` fail later with
# a bind error buried in the output.
if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$WEB_PORT )" 2>/dev/null | grep -q LISTEN; then
  die "port $WEB_PORT is already in use. Re-run with --port <other>."
fi

if [ -z "$PUBLIC_URL" ]; then
  current=$(get_env CORS_ORIGIN); current=${current:-http://localhost:$WEB_PORT}
  case "$current" in *localhost*) current="http://localhost:$WEB_PORT" ;; esac
  PUBLIC_URL=$(ask 'Public URL the browser will use' "$current")
fi
PUBLIC_URL=${PUBLIC_URL%/}

if [ -z "$ADMIN_EMAIL" ]; then
  current=$(get_env BOOTSTRAP_ADMIN_EMAIL); current=${current:-admin@example.com}
  ADMIN_EMAIL=$(ask 'First-run admin email' "$current")
fi

GENERATED_PASSWORD=''
if [ -z "$ADMIN_PASSWORD" ] && needs_value BOOTSTRAP_ADMIN_PASSWORD; then
  ADMIN_PASSWORD=$(openssl rand -base64 15 | tr -d '\n=+/')
  GENERATED_PASSWORD=1
fi

set_env WEB_PORT "$WEB_PORT"
set_env CORS_ORIGIN "$PUBLIC_URL"
# Cookie domain: the host without scheme/port. 'localhost' is correct as-is.
host=${PUBLIC_URL#*://}; host=${host%%:*}; host=${host%%/*}
set_env FORGECRM_DOMAIN "$host"
set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
if [ -n "$ADMIN_PASSWORD" ]; then set_env BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_PASSWORD"; fi
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

# ── 4. build ─────────────────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  step 'Building images (first run takes a few minutes)'
  docker compose build || die "the image build failed — scroll up for the first error."
  ok 'images built'
fi

# ── 5. start ─────────────────────────────────────────────────────────────────
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
step 'Applying database migrations'
"$ROOT/scripts/migrate.sh" || die "migrations failed — the schema may be half-applied. Fix the SQL error above and re-run."

# The backend runs its ensure*Tables() bootstrap at startup and may have started
# before the schema existed. Restart it now so it comes up against a complete DB.
step 'Restarting the backend against the finished schema'
docker compose restart backend >/dev/null
ok 'backend restarted'

# ── 7. verify ────────────────────────────────────────────────────────────────
step 'Verifying'
printf '  waiting for the web UI'
code=''
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null || echo 000)
  if [ "$code" = 200 ]; then break; fi
  printf '.'; sleep 2
done
echo
if [ "$code" = 200 ]; then
  ok "web UI responding on http://localhost:${WEB_PORT}/"
else
  warn "the web UI returned HTTP ${code:-none} — check: docker compose logs web backend"
fi

# ── 8. credentials ───────────────────────────────────────────────────────────
step 'Done'

cat <<EOF

  ${B}Forge Growth is running.${N}

    URL       ${PUBLIC_URL}
    Sign in   ${ADMIN_EMAIL}
EOF

if [ -n "$ADMIN_PASSWORD" ]; then
  if [ -n "$GENERATED_PASSWORD" ]; then
    printf '    Password  %s%s%s   %s(generated — also stored in .env)%s\n' "$B" "$ADMIN_PASSWORD" "$N" "$DIM" "$N"
  else
    printf '    Password  %s(the one you supplied)%s\n' "$DIM" "$N"
  fi
else
  echo '    Password  printed once in the backend log:'
  echo '                docker compose logs backend | grep -A5 "FIRST-RUN ADMIN"'
fi

cat <<EOF

  ${DIM}Next steps${N}
    Connect a WhatsApp number   Admin Settings → WhatsApp Accounts
    Point Meta's webhook at     ${PUBLIC_URL}/api/webhook/whatsapp
    with the verify token in    .env → META_WEBHOOK_VERIFY_TOKEN

  ${DIM}Managing the stack${N}
    Logs      docker compose logs -f backend
    Stop      docker compose down
    Upgrade   git pull && ./scripts/install.sh
    Remove    ./scripts/uninstall.sh          ${DIM}(deletes all data)${N}

  ${Y}Back up FORGECRM_ENCRYPTION_KEY from .env.${N} It decrypts every stored Meta,
  Google and payment-gateway credential. Lose it and they must all be re-entered.

EOF
