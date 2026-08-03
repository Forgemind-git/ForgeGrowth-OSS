#!/usr/bin/env sh
# Print the three required secrets, ready to append to .env:
#
#   ./scripts/generate-secrets.sh >> .env
#
# Then delete the empty duplicates that .env.example left behind, or just let
# these later lines win — docker compose uses the LAST definition of a key.
set -eu

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi

echo ""
echo "# --- generated $(date -u +%Y-%m-%dT%H:%M:%SZ) ---"
echo "FORGECRM_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=' )"
# Must be exactly 32 bytes hex — util/crypto.js derives an AES-256 key from it.
echo "FORGECRM_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "META_WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 16)"
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n=/+' )"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -base64 24 | tr -d '\n=/+' )"
echo ""
echo "# Keep FORGECRM_ENCRYPTION_KEY safe: it decrypts every stored Meta/Google/" >&2
echo "# gateway credential. Losing it means re-entering all of them." >&2
