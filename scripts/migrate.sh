#!/usr/bin/env bash
# Apply every migration in supabase/migrations/ in order, against the database
# used by the bundled compose stack.
#
#   ./scripts/migrate.sh
#
# Migrations are idempotent (CREATE ... IF NOT EXISTS, guarded ALTERs), so
# re-running is safe and is the normal way to upgrade after a `git pull`.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

DB="${POSTGRES_DB:-forgegrowth}"
USER="${POSTGRES_USER:-forgegrowth}"
SERVICE="${MIGRATE_PG_SERVICE:-postgres}"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
  echo "The '$SERVICE' service is not running. Start it first:  docker compose up -d $SERVICE" >&2
  exit 1
fi

echo "Applying migrations to database '$DB'…"
count=0
for f in supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  printf '  %-52s' "$(basename "$f")"
  # ON_ERROR_STOP so a broken migration fails loudly here rather than leaving
  # the schema half-applied and the backend throwing at runtime.
  if docker compose exec -T "$SERVICE" psql -v ON_ERROR_STOP=1 -q -U "$USER" -d "$DB" < "$f" >/dev/null 2>/tmp/mig.err; then
    echo "ok"
    count=$((count + 1))
  else
    echo "FAILED"
    echo "--- psql output ---" >&2
    cat /tmp/mig.err >&2
    exit 1
  fi
done
echo "Applied $count migration file(s)."
echo
echo "Next: docker compose logs backend | grep -A6 'FIRST-RUN ADMIN'"
