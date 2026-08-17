#!/usr/bin/env bash
# Is the admin password in .env the one this install actually accepts?
#
#   ./admin-password.sh            check, and print it if it works
#   ./admin-password.sh --reset    make it work again (removes all user accounts)
#
# ⚠ WHY THIS EXISTS. `grep BOOTSTRAP_ADMIN_PASSWORD .env` answers a different
#   question from the one people ask. It reports what is in a file; what they
#   want to know is what the login screen will accept. Those agree only while
#   the admin row was created from that value and nobody has changed it since —
#   and BOOTSTRAP_ADMIN_PASSWORD is write-once: auth.js reads it when the users
#   table is EMPTY and never again. So:
#
#     - change the password in Admin Settings, and .env is stale forever
#     - keep a database from an earlier install, and it was never true at all
#
#   Both leave a file confidently showing a password that cannot work, which is
#   a bad half-hour: the value is right there, so the fault looks like the login.
#   This asks the API instead, which is the only thing whose answer counts.
#
# Runs beside docker-compose.yml (an images install) or inside scripts/ (a
# source checkout), like up.sh and down.sh.

set -eu

B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); N=$(printf '\033[0m')
GRN=$(printf '\033[32m'); RED=$(printf '\033[31m'); YLW=$(printf '\033[33m')

# Same dual-layout probe as up.sh/down.sh. Duplicated on purpose rather than
# sourced from a shared file: an images install downloads these scripts one by
# one, and a third required file is a third chance to end up with a broken
# install.
# shellcheck disable=SC1007
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if   [ -f "$HERE/docker-compose.yml" ]; then ROOT=$HERE
elif [ -f "$HERE/../docker-compose.yml" ]; then ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
else
  echo "Cannot find docker-compose.yml beside this script or one level up." >&2
  exit 1
fi
cd "$ROOT"

[ -f .env ] || { echo "No .env in $ROOT — is this an install directory?" >&2; exit 1; }

get_env() { sed -n "s/^${1}=//p" .env | head -1; }

EMAIL=$(get_env BOOTSTRAP_ADMIN_EMAIL); EMAIL=${EMAIL:-admin@example.com}
PASSWORD=$(get_env BOOTSTRAP_ADMIN_PASSWORD)
PORT=$(get_env WEB_PORT); PORT=${PORT:-8080}
URL="http://127.0.0.1:${PORT}"

# Always over loopback, never the public address. The public one may be https
# through a proxy this script cannot see, or a domain whose DNS points somewhere
# else entirely — neither of which has any bearing on whether the credentials
# are right, and both of which would turn a wrong answer into a confusing one.
#
# No Origin header, so CORS is not involved: index.js allows an origin-less
# request, which is what makes this a test of the PASSWORD and nothing else.
# A password may contain " or \ — pasting it raw builds invalid JSON, and the
# API then answers 400, which reads exactly like "wrong password".
json_str() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

try_login() { # try_login <password> -> prints the HTTP status
  # ⚠ Assign, then fall back — never `curl … || echo 000`. On a failed
  #   connection curl writes its own "000" via -w AND exits non-zero, so the
  #   echo appends a second one and the caller sees "000000". That matches no
  #   case, so an unreachable install was reported as "answered HTTP 000000",
  #   which says the opposite of what happened.
  local out
  out=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST "$URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":$(json_str "$EMAIL"),\"password\":$(json_str "$1")}" 2>/dev/null) || out=000
  printf '%s' "${out:-000}"
}

RESET=0
[ "${1:-}" = --reset ] && RESET=1

if [ "$RESET" = 1 ]; then
  echo "${YLW}This deletes every user account in this install.${N}"
  echo "The first admin is then recreated from .env when the backend restarts."
  printf 'Type yes to continue: '
  read -r reply
  [ "$reply" = yes ] || { echo 'Nothing was changed.'; exit 1; }

  db=$(get_env POSTGRES_DB);   db=${db:-forgegrowth}
  us=$(get_env POSTGRES_USER); us=${us:-forgegrowth}
  docker compose exec -T postgres psql -U "$us" -d "$db" \
    -c 'DELETE FROM coexistence.forgecrm_users;' >/dev/null
  docker compose restart backend >/dev/null

  # The backend recreates the admin during startup, so the answer is not
  # available the instant restart returns.
  printf 'waiting for the backend '
  i=0
  while [ "$i" -lt 30 ]; do
    [ "$(try_login "$PASSWORD")" = 200 ] && break
    printf '.'; sleep 2; i=$((i + 1))
  done
  echo
fi

[ -n "$PASSWORD" ] || {
  echo "${YLW}BOOTSTRAP_ADMIN_PASSWORD is empty in .env.${N}"
  echo "The first admin's password was generated and printed once to the backend log:"
  echo "  docker compose logs backend | grep -A5 'FIRST-RUN ADMIN'"
  exit 1
}

code=$(try_login "$PASSWORD")
case "$code" in
  200)
    echo "${GRN}✓${N} the password in .env is accepted by this install"
    echo
    echo "    Sign in   $EMAIL"
    echo "    Password  ${B}${PASSWORD}${N}"
    echo "    URL       $(get_env CORS_ORIGIN)"
    ;;
  401)
    echo "${RED}✗${N} the password in .env is ${B}not${N} accepted by this install"
    echo
    echo "  The value in the file is real, it is simply not the one the database"
    echo "  holds. BOOTSTRAP_ADMIN_PASSWORD is only ever applied when the first"
    echo "  admin is created, so it goes stale if the password was changed in"
    echo "  Admin Settings, or if this database came from an earlier install."
    echo
    echo "  Reset it (deletes all user accounts, keeps everything else):"
    echo "    ${DIM}$0 --reset${N}"
    exit 1
    ;;
  000)
    echo "${YLW}?${N} could not reach this install at $URL"
    echo "  It may be stopped. Start it with ./up.sh and try again."
    exit 1
    ;;
  *)
    echo "${YLW}?${N} $URL/api/auth/login answered HTTP $code, which is neither"
    echo "  success nor a rejected password — so this cannot tell you whether the"
    echo "  password is right. Check the backend log:"
    echo "    docker compose logs --tail 30 backend"
    exit 1
    ;;
esac
