#!/usr/bin/env bash
#
# Render docs/guide/installation-guide.html into
# docs/ForgeGrowth-Installation-Guide.pdf — the printable guide docs/install.md
# links to.
#
# WeasyPrint runs inside a throwaway python container, so nothing is installed
# on this machine and every run renders with the same fonts.
#
# ⚠ Regenerate it whenever a release changes what the guide describes: a menu
#   path, a flag, a version in a command. The 3.0.0 guide still sent people to a
#   Settings screen that release had removed — nothing failed, because nothing
#   ever reads a PDF but a person.
#
# Usage:
#   ./scripts/make-guide.sh

set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC=docs/guide/installation-guide.html
OUT=docs/ForgeGrowth-Installation-Guide.pdf

[ -f "$REPO_ROOT/$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

docker run --rm -v "$REPO_ROOT:/repo" -w /repo python:3.12-slim sh -ec "
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 fonts-dejavu-core >/dev/null
  pip install -q --root-user-action=ignore weasyprint==68.1
  weasyprint '$SRC' '$OUT'
  chown $(id -u):$(id -g) '$OUT'
"

echo "wrote $OUT ($(du -h "$REPO_ROOT/$OUT" | cut -f1))"
