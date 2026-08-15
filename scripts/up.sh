#!/usr/bin/env bash
# Start this install, then check that it actually works.
#
#   ./scripts/up.sh            start (or restart after a config change)
#   ./scripts/up.sh --build    rebuild the images from this checkout first
#
# This is `docker compose up -d` plus the two parts people skip.
#
# First, fetching the address a browser will really use. Every container
# reporting healthy is not the same claim — an install can have five healthy
# containers and a site that returns 404, which is what a missing reverse-proxy
# config looks like from the inside. The only check that matches "it works" is
# asking for the page.
#
# Second, refusing to start when another directory on this machine already owns
# this install's name. Compose identifies an install by name alone, so a second
# copy sharing it does not become a second install: it adopts the first one's
# database and then points its own freshly generated secrets at it. That failure
# is silent at the moment it happens and expensive later.
#
# Works from either layout: beside docker-compose.yml (an install running
# published images) or in scripts/ (a source checkout).
set -euo pipefail

# --- locate the install -------------------------------------------------------
# The script may sit beside the compose file or one level below it. Anything
# else is not an install.
# `CDPATH= cd` blanks CDPATH for that one command. Without it, a CDPATH set in
# the caller's shell can make `cd` land somewhere else entirely and the script
# would configure the wrong install. Deliberate, not the typo it resembles.
# shellcheck disable=SC1007
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1007
if   [ -f "$HERE/docker-compose.yml" ];    then ROOT="$HERE"
elif [ -f "$HERE/../docker-compose.yml" ]; then ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
else
  echo "no docker-compose.yml beside $0 or in its parent — run this from an install" >&2
  exit 1
fi
cd "$ROOT"

get_env() { [ -f .env ] && sed -n "s/^${1}=//p" .env | head -1 || true; }

# --- which install is this? ---------------------------------------------------
# Resolved exactly the way Compose resolves it, in the same order, or the guard
# below would be checking a different install than the one about to start.
#
# Duplicated verbatim in down.sh rather than sourced from a shared file: an
# install running published images downloads these two scripts individually, and
# a third file it must also remember is a third chance to end up with a broken
# install. Change one, change the other.
project_name() {
  local v
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] && { printf '%s' "$COMPOSE_PROJECT_NAME"; return; }
  v=$(get_env COMPOSE_PROJECT_NAME);          [ -n "$v" ] && { printf '%s' "$v"; return; }
  v=$(sed -n 's/^name:[[:space:]]*//p' docker-compose.yml | head -1)
                                              [ -n "$v" ] && { printf '%s' "$v"; return; }
  basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-'
}
PROJECT=$(project_name)

# A container already carrying this name tells us where its install lives. If
# that is somewhere else, starting here would take over its data.
OTHER=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null | head -1 || true)
if [ -n "$OTHER" ]; then
  OWNER=$(docker inspect "$OTHER" \
    --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
  if [ -n "$OWNER" ] && [ "$OWNER" != "$ROOT" ]; then
    cat >&2 <<EOF
Refusing to start: the name "$PROJECT" already belongs to another install.

  this install:  $ROOT
  already used:  $OWNER

Compose tells installs apart by name and nothing else, so starting this one
would attach it to that install's database and storage — with this install's
passwords, which cannot open them. Give this one its own name:

  echo 'COMPOSE_PROJECT_NAME=${PROJECT}-2' >> .env

Then run this script again. Nothing has been changed.
EOF
    exit 1
  fi
fi

# --- HTTPS needs a file, not just a profile -----------------------------------
# The tls profile bind-mounts ./caddy/Caddyfile. When that file is absent Docker
# does not complain — it creates a DIRECTORY at the path and Caddy exits with
# "is a directory", which names the symptom and nothing else. Checked here as
# well as in install.sh because this is the script people actually run twice.
case ",$(get_env COMPOSE_PROFILES)," in
  *,tls,*)
    if [ ! -f "$ROOT/caddy/Caddyfile" ]; then
      cat >&2 <<EOF
Refusing to start: HTTPS is on, but $ROOT/caddy/Caddyfile is missing.

Docker would create a directory at that path and Caddy would refuse to start.
Fetch it back:

  mkdir -p caddy && curl -fsSL -o caddy/Caddyfile \\
    https://raw.githubusercontent.com/Forgemind-git/ForgeGrowth-OSS/main/caddy/Caddyfile

Nothing has been changed.
EOF
      exit 1
    fi ;;
esac

# --- the address to verify ----------------------------------------------------
# In order of how public it is: a TLS domain if HTTPS is on, else whatever origin
# the app was told to expect, else the host port.
DOMAIN=$(get_env TLS_DOMAIN)
ORIGIN=$(get_env CORS_ORIGIN)
PORT=$(get_env WEB_PORT); PORT=${PORT:-8080}
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"
elif [ -n "$ORIGIN" ]; then URL="${ORIGIN%/}"
else URL="http://localhost:$PORT"; fi

docker compose up -d "$@"

printf 'waiting for %s ' "$URL"
code=000
for _ in $(seq 1 45); do
  # -k so a self-signed certificate (TLS_EMAIL=internal) still counts as
  # serving: this is a reachability check, not a trust check.
  # `|| code=000` not `|| echo 000`: curl prints its own 000 on a failed
  # connection, and echoing a second one concatenated into "HTTP 000000".
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null) || code=000
  [ "$code" = 200 ] && break
  printf '.'; sleep 2
done
echo

if [ "$code" = 200 ]; then
  echo "up: $URL"
  # The fetch above used -k, so it says "reachable", not "trusted". Those look
  # identical from here and completely different in a browser, which is the
  # whole reason this script exists. Ask again the way a browser would.
  case "$URL" in
    https://*)
      if ! curl -s -o /dev/null --max-time 15 "$URL/" 2>/dev/null; then
        echo
        echo "warning: serving with a certificate browsers do not trust."
        echo "  Visitors get an interstitial, and Meta will refuse a webhook on it."
        echo "  Usually: issuance unfinished, the domain proxied through Cloudflare"
        echo "  so the challenge cannot reach here, or an ACME rate limit."
      fi ;;
  esac
  # ⚠ A second address that also answers, and quietly breaks signing in.
  #
  # When the public origin is https, the login cookie is marked Secure. If the
  # plain-HTTP port is ALSO published to the world, the site answers there too —
  # and a browser discards a Secure cookie delivered over plain HTTP. Login
  # returns 200 and the app renders, then every request after it is a 401. It
  # looks like "logged out on every refresh", never like a URL problem, and no
  # log anywhere records it. Reported here because this is the check nothing
  # else performs: every container is healthy and the real URL works.
  BIND=$(get_env WEB_BIND); BIND=${BIND:-0.0.0.0}
  case "$URL" in
    https://*)
      if [ "$BIND" = 0.0.0.0 ] && [ -z "$(get_env TLS_DOMAIN)" ]; then
        PORT=$(get_env WEB_PORT); PORT=${PORT:-8080}
        echo
        echo "warning: this install also answers on http://<this-host>:$PORT."
        echo "  Signing in there appears to work and then fails on the next click:"
        echo "  the login cookie is Secure, so a browser drops it over plain HTTP."
        echo "  Close it by keeping the port to this machine:"
        echo "    echo 'WEB_BIND=127.0.0.1' >> .env && ./up.sh"
      fi ;;
  esac
else
  echo "the site returned HTTP $code" >&2
  echo "  docker compose logs --tail 40 backend web" >&2
  [ -n "$DOMAIN" ] && echo "  docker compose logs --tail 40 caddy    # certificate / DNS" >&2
  # A container killed for exceeding its memory ceiling restarts endlessly and
  # otherwise reads as "the site is just slow to come up".
  echo "  docker compose ps    # a container restarting may be hitting *_MEM_LIMIT in .env" >&2
  exit 1
fi
