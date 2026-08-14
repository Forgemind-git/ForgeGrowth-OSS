#!/usr/bin/env bash
# Stop this install. THE DATA IS KEPT.
#
#   ./scripts/down.sh
#
# Containers are removed; the volumes holding the database, the uploads and the
# object store are not. ./scripts/up.sh brings it all back with the data intact.
#
# Like up.sh, this refuses to touch an install that belongs to another
# directory — stopping somebody else's copy because it happens to share a name
# is the same mistake as starting it, and just as quiet.
#
# Works from either layout: beside docker-compose.yml (an install running
# published images) or in scripts/ (a source checkout).
set -euo pipefail

# --- locate the install -------------------------------------------------------
# See the note in up.sh: `CDPATH= cd` blanks CDPATH for that one command so a
# CDPATH in the caller's shell cannot send us to a different directory.
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

# `-v` deletes every volume: the database, the media, all of it. It sits one
# letter away from the ordinary command and there is no undo, so this refuses
# rather than passes it through. Destroying the data should be something you
# type out in full, on purpose, having read a sentence about it first.
for arg in "$@"; do
  case "$arg" in
    -v|--volumes)
      user=$(get_env POSTGRES_USER); user=${user:-forgegrowth}
      db=$(get_env POSTGRES_DB);     db=${db:-forgegrowth}
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

# --- which install is this? ---------------------------------------------------
# Kept identical to up.sh on purpose — see the note there about why this is
# duplicated rather than shared. Change one, change the other.
project_name() {
  local v
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] && { printf '%s' "$COMPOSE_PROJECT_NAME"; return; }
  v=$(get_env COMPOSE_PROJECT_NAME);          [ -n "$v" ] && { printf '%s' "$v"; return; }
  v=$(sed -n 's/^name:[[:space:]]*//p' docker-compose.yml | head -1)
                                              [ -n "$v" ] && { printf '%s' "$v"; return; }
  basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-'
}
PROJECT=$(project_name)

OTHER=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null | head -1 || true)
if [ -n "$OTHER" ]; then
  OWNER=$(docker inspect "$OTHER" \
    --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
  if [ -n "$OWNER" ] && [ "$OWNER" != "$ROOT" ]; then
    cat >&2 <<EOF
Refusing to stop: the name "$PROJECT" belongs to another install.

  this install:  $ROOT
  already used:  $OWNER

Stopping from here would shut down that one instead. If you meant to stop it,
run its own ./down.sh from $OWNER. Nothing has been changed.
EOF
    exit 1
  fi
fi

docker compose down "$@"
echo "down. Data volumes kept — up.sh brings it back."
