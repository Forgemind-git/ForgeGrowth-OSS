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
#   --domain <host>       serve HTTPS on this domain, with a Let's Encrypt
#                         certificate obtained and renewed automatically.
#                         Needs ports 80 and 443 free, and the domain's DNS
#                         already pointing at this machine. Implies --url.
#   --tls-email <addr>    contact address for the certificate
#                         (default: the admin email; "internal" self-signs)
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
DOMAIN=''; TLS_EMAIL=''
ASSUME_YES=0; DO_BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port)           WEB_PORT="${2:-}"; shift 2 ;;
    --domain)         DOMAIN="${2:-}"; shift 2 ;;
    --tls-email)      TLS_EMAIL="${2:-}"; shift 2 ;;
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

avail_mb=$(df -Pm . | awk 'NR==2 {print $4}')
if [ "$avail_mb" -lt 3000 ]; then
  warn "only ${avail_mb} MB free disk — images need roughly 2-3 GB."
else
  ok "${avail_mb} MB free disk"
fi

# ── 2. configuration ─────────────────────────────────────────────────────────
step 'Configuring'

ENV_FILE="$ROOT/.env"
# Whether this run is starting from scratch. It decides whether a database that
# already exists on this machine may be adopted: an .env we just generated has
# secrets that no existing database can match (see "which install is this?").
FRESH_ENV=0
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ROOT/.env.example" ] || die ".env.example is missing — is this a complete checkout?"
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
  or start a separate install:   COMPOSE_PROJECT_NAME=$free ./scripts/install.sh
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

if [ -z "$WEB_PORT" ]; then
  current=$(get_env WEB_PORT); current=${current:-8080}
  # A second install on one machine always collides on 8080, and "port in use,
  # re-run with --port" is a dead end the script can just walk past. Only the
  # SUGGESTION moves: --port is still obeyed exactly, and a busy port chosen by
  # hand still fails below rather than being silently changed underneath you.
  if [ "$ours_running" = 0 ] && port_in_use "$current"; then
    busy=$current
    while port_in_use "$current"; do current=$((current + 1)); done
    warn "port $busy is in use — suggesting $current instead"
  fi
  WEB_PORT=$(ask 'Host port for the web UI' "$current")
fi
case "$WEB_PORT" in ''|*[!0-9]*) die "--port must be a number (got '$WEB_PORT')" ;; esac

if [ "$ours_running" = 0 ] && port_in_use "$WEB_PORT"; then
  die "port $WEB_PORT is already in use by another process. Re-run with --port <other>."
fi

# ── HTTPS ────────────────────────────────────────────────────────────────────
#
# --domain is the whole public-address story: it turns on the bundled caddy
# (compose profile `tls`), which obtains and renews a Let's Encrypt certificate
# knowing nothing but the domain. No resolver to configure, no acme.json, and
# nothing in this repo that names one particular server — which is what made
# the previous arrangement, a hand-written proxy file living outside the repo,
# impossible to reproduce anywhere else.
#
# COMPOSE_PROFILES goes into .env rather than being passed here, so every later
# plain `docker compose up -d` from this directory still brings HTTPS up.
[ -n "$DOMAIN" ] || DOMAIN=$(get_env TLS_DOMAIN)      # sticky across re-runs
DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}

if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in
    *' '*|*/*|'') die "--domain takes a bare hostname, e.g. crm.example.com (got '$DOMAIN')" ;;
    *.*) : ;;
    *) die "--domain needs a full hostname with a dot, e.g. crm.example.com (got '$DOMAIN')" ;;
  esac

  # 80 is not optional: the certificate challenge arrives on it. Failing here
  # beats failing inside Caddy, where the reason is a stack trace about binding.
  tls_running=0
  if docker compose ps --status running --services 2>/dev/null | grep -qx caddy; then tls_running=1; fi
  if [ "$tls_running" = 0 ]; then
    for p in 80 443; do
      if port_in_use "$p"; then
        die "port $p is in use, and HTTPS needs both 80 and 443.
  Something else — another web server, or a reverse proxy — is already there.
  Either stop it, or drop --domain and point that proxy at port $WEB_PORT instead."
      fi
    done
  fi

  [ -n "$TLS_EMAIL" ] || TLS_EMAIL=$(get_env TLS_EMAIL)
  # Defaulting to the admin address keeps this to ONE required argument. Let's
  # Encrypt only uses it to warn before a renewal failure expires the site.
  [ -n "$TLS_EMAIL" ] || TLS_EMAIL=${ADMIN_EMAIL:-$(get_env BOOTSTRAP_ADMIN_EMAIL)}
  [ -n "$TLS_EMAIL" ] || TLS_EMAIL='internal'

  set_env TLS_DOMAIN "$DOMAIN"
  set_env TLS_EMAIL "$TLS_EMAIL"
  set_env COMPOSE_PROFILES tls
  # With caddy in front, the plain-HTTP port must not also be public, or the
  # site is reachable twice and once of those has no certificate.
  set_env WEB_BIND 127.0.0.1
  export COMPOSE_PROFILES=tls
  PUBLIC_URL=${PUBLIC_URL:-https://$DOMAIN}

  if [ "$TLS_EMAIL" = internal ]; then
    ok "HTTPS on $DOMAIN  ${DIM}(self-signed — browsers will warn)${N}"
  else
    ok "HTTPS on $DOMAIN  ${DIM}(Let's Encrypt, renewed automatically)${N}"
    # A certificate cannot be issued for a name that does not point here, and
    # the failure otherwise appears minutes later in Caddy's log. A warning and
    # not an error: split-horizon DNS and a proxied A record both look wrong
    # from inside the machine yet work perfectly from outside.
    resolved=''
    if command -v getent >/dev/null 2>&1; then
      resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
    elif command -v dig >/dev/null 2>&1; then
      resolved=$(dig +short A "$DOMAIN" 2>/dev/null | head -1)
    fi
    if [ -z "$resolved" ]; then
      warn "$DOMAIN does not resolve yet — add its DNS record, or the certificate will not be issued."
    else
      ok "$DOMAIN resolves to $resolved"
    fi
  fi
else
  # No domain: make sure a previous --domain run does not leave HTTPS half-on.
  if [ -n "$(get_env COMPOSE_PROFILES)" ]; then
    set_env COMPOSE_PROFILES ''
    set_env WEB_BIND '0.0.0.0'
    warn 'HTTPS turned off — re-run with --domain <host> to bring it back.'
  fi
fi

if [ -z "$PUBLIC_URL" ]; then
  current=$(get_env CORS_ORIGIN); current=${current:-http://localhost:$WEB_PORT}
  case "$current" in *localhost*) current="http://localhost:$WEB_PORT" ;; esac
  PUBLIC_URL=$(ask 'Public URL the browser will use' "$current")
fi
PUBLIC_URL=${PUBLIC_URL%/}

# An https:// address with nothing terminating TLS is the failure this flag
# exists to remove: the summary would print a URL the script has done nothing
# to make work, which is exactly what happened before --domain existed.
case "$PUBLIC_URL" in
  https://*)
    if [ -z "$DOMAIN" ]; then
      warn "the public URL is https:// but nothing here terminates HTTPS."
      warn "Either pass --domain $(printf '%s' "${PUBLIC_URL#https://}" | cut -d/ -f1), or put your own"
      warn "reverse proxy in front of port $WEB_PORT — the app itself serves plain HTTP."
    fi
    ;;
esac

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
    tls_code=$(curl -sk -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" 2>/dev/null || echo 000)
    if [ "$tls_code" = 200 ]; then break; fi
    printf '.'; sleep 3
  done
  echo
  if [ "$tls_code" = 200 ]; then
    ok "https://${DOMAIN}/ responding"
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

cat <<EOF

  ${DIM}Next steps${N}
    Connect a WhatsApp number   Admin Settings → WhatsApp Accounts
    Point Meta's webhook at     ${PUBLIC_URL}/api/webhook/whatsapp
    with the verify token in    .env → META_WEBHOOK_VERIFY_TOKEN

  ${DIM}Managing the stack${N} ${DIM}— run these from this directory; that is what picks the install${N}
    Logs      docker compose logs -f backend
    Stop      docker compose down
    Upgrade   git pull && ./scripts/install.sh
    Remove    ./scripts/uninstall.sh          ${DIM}(deletes all data)${N}
    List all  docker compose ls

  ${Y}Back up FORGECRM_ENCRYPTION_KEY from .env.${N} It decrypts every stored Meta,
  Google and payment-gateway credential. Lose it and they must all be re-entered.

EOF
