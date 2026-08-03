#!/usr/bin/env bash
# ─── Forge Growth — remove the stack ─────────────────────────────────────────
#
#   ./scripts/uninstall.sh              # stop containers, KEEP data + .env
#   ./scripts/uninstall.sh --purge      # also delete every volume and .env
#
# --purge is irreversible: it destroys the database, the queue state and every
# uploaded media file. It asks for confirmation unless --yes is also given.
#
set -euo pipefail
cd "$(dirname "$0")/.."

PURGE=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge)    PURGE=1; shift ;;
    -y|--yes)   ASSUME_YES=1; shift ;;
    -h|--help)  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$PURGE" = 1 ]; then
  if [ "$ASSUME_YES" != 1 ]; then
    echo
    echo "  This deletes the database, all queued messages and all uploaded media."
    echo "  There is no undo."
    echo
    printf '  Type the word DELETE to confirm: '
    read -r reply || reply=''
    [ "$reply" = 'DELETE' ] || { echo '  Aborted.'; exit 1; }
  fi
  docker compose down -v
  rm -f .env
  echo '  Removed containers, volumes and .env.'
else
  docker compose down
  echo '  Containers stopped. Data volumes and .env are intact —'
  echo '  bring it back with: ./scripts/install.sh'
fi
