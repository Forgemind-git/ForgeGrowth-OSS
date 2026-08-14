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
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$URL/" 2>/dev/null || echo 000)
  [ "$code" = 200 ] && break
  printf '.'; sleep 2
done
echo

if [ "$code" = 200 ]; then
  echo "up: $URL"
else
  echo "the site returned HTTP $code" >&2
  echo "  docker compose logs --tail 40 backend web" >&2
  [ -n "$DOMAIN" ] && echo "  docker compose logs --tail 40 caddy    # certificate / DNS" >&2
  # A container killed for exceeding its memory ceiling restarts endlessly and
  # otherwise reads as "the site is just slow to come up".
  echo "  docker compose ps    # a container restarting may be hitting *_MEM_LIMIT in .env" >&2
  exit 1
fi
