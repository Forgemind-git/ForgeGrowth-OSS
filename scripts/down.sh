#!/usr/bin/env bash
# Stop this install. THE DATA IS KEPT.
#
#   ./scripts/down.sh
#
# Containers are removed; the volumes holding the database, the uploads and the
# object store are not. ./scripts/up.sh brings it all back with the data intact.
#
# Which install this affects is decided by the directory you run it from — see
# "More than one install on one machine" in the README. Run it from the wrong
# checkout and you will stop a different install than you meant to.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f docker-compose.yml ] || { echo "no docker-compose.yml here — run this from a checkout" >&2; exit 1; }

# `-v` deletes every volume: the database, the media, all of it. It sits one
# letter away from the ordinary command and there is no undo, so this refuses
# rather than passes it through. Destroying the data should be something you
# type out in full, on purpose, having read a sentence about it first.
for arg in "$@"; do
  case "$arg" in
    -v|--volumes)
      user=$(sed -n 's/^POSTGRES_USER=//p' .env 2>/dev/null | head -1); user=${user:-forgegrowth}
      db=$(sed -n 's/^POSTGRES_DB=//p' .env 2>/dev/null | head -1);     db=${db:-forgegrowth}
      cat >&2 <<EOF
Refusing $arg — that deletes the database, the uploads and the object store.

Back it up first:
  docker compose exec -T postgres pg_dump -U $user -d $db -Fc > backup-\$(date +%F).dump

Then, if you really mean it:
  docker compose down -v

Or use ./scripts/uninstall.sh --purge, which does the same thing and says so.
EOF
      exit 1
      ;;
  esac
done

docker compose down "$@"
echo "down. Data volumes kept — ./scripts/up.sh brings it back."
