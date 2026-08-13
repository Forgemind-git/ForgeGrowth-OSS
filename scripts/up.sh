#!/usr/bin/env bash
# Start this install, then check that it actually works.
#
#   ./scripts/up.sh            start (or restart after a config change)
#   ./scripts/up.sh --build    rebuild the images from this checkout first
#
# This is `docker compose up -d` plus the part people skip: fetching the
# address a browser will really use. Every container reporting healthy is not
# the same claim — an install can have five healthy containers and a site that
# returns 404, which is what a missing reverse-proxy config looks like from the
# inside. The only check that matches "it works" is asking for the page.
#
# Which install this affects is decided by the directory you run it from, via
# COMPOSE_PROJECT_NAME in that directory's .env. See "More than one install on
# one machine" in the README.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f docker-compose.yml ] || { echo "no docker-compose.yml here — run this from a checkout" >&2; exit 1; }

get_env() { [ -f .env ] && sed -n "s/^${1}=//p" .env | head -1 || true; }

# The address to verify, in order of how public it is: a TLS domain if HTTPS is
# on, else whatever origin the app was told to expect, else the host port.
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
  exit 1
fi
