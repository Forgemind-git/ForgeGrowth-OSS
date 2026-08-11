#!/bin/sh
# Container entrypoint: bring the schema up to date, then start the app.
#
# This is what makes the image-only install work. With no source tree there is no
# scripts/migrate.sh to run and no psql on the host, so if the container did not
# migrate itself, `docker compose up -d` would come up against an empty database
# and every request would throw on a missing relation.
#
# AUTO_MIGRATE=0 turns it off, for the case where migrations are applied by
# something else (a CI step, a DBA, scripts/migrate.sh from a checkout) and the
# database user the app runs as should not hold DDL rights.
#
# ⚠ This runs for EVERY command, not just the server, so a one-off shell in this
# image would otherwise sit here waiting a full minute for a database it does not
# need. Inspecting the image:
#
#   docker run --rm --entrypoint sh forgegrowth-backend -c 'ls /app/migrations'
#   docker run --rm -e AUTO_MIGRATE=0 forgegrowth-backend sh
set -e

if [ "${AUTO_MIGRATE:-1}" = "1" ]; then
  node scripts/run-migrations.js
else
  echo "[entrypoint] AUTO_MIGRATE=0 — skipping migrations."
fi

# exec so the app becomes PID 1: without it this shell stays PID 1, swallows
# SIGTERM, and `docker compose down` takes the full 10-second kill timeout on
# every stop instead of shutting down cleanly.
exec "$@"
