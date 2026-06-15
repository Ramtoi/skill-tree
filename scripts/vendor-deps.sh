#!/usr/bin/env bash
#
# vendor-deps.sh — populate ./vendor/ with hub.py's pure-Python dependencies.
#
# The packaged Skill Tree app must run hub.py on an interpreter that may have
# NONE of hub.py's third-party deps installed. Rather than pip-installing at
# runtime (PEP 668 blocks --user on managed pythons, and the GUI app's resolved
# interpreter can differ from the user's terminal one), we ship the deps inside
# the bundle: hub.py prepends ./vendor/ to sys.path before importing.
#
# This script is invoked from tauri's beforeBuildCommand (see tauri.conf.json)
# and can be run by hand. vendor/ is generated, not checked in (.gitignored),
# so requirements.txt stays the single source of truth for versions.
#
# Compiled extensions (PyYAML's optional _yaml C speedup) are stripped so the
# bundle is architecture-independent (one artifact for Intel + Apple Silicon).
# PyYAML falls back to its pure-Python loader; hub.py only uses safe_load/
# safe_dump/dump/YAMLError, all of which work without the C extension.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
REQS="$ROOT/requirements.txt"

PYTHON="${PYTHON:-python3}"

if [[ ! -f "$REQS" ]]; then
  echo "vendor-deps: $REQS not found" >&2
  exit 1
fi

echo "vendor-deps: regenerating $VENDOR from $REQS"
rm -rf "$VENDOR"
mkdir -p "$VENDOR"

# --no-compile: don't emit .pyc; --no-deps not used so transitive deps come too.
# requirements.txt may carry dev-only comment lines (pytest) — pip ignores
# commented lines, so only PyYAML + tomlkit are installed.
"$PYTHON" -m pip install \
  --target "$VENDOR" \
  --no-compile \
  --disable-pip-version-check \
  -r "$REQS"

# Strip compiled artifacts → architecture-independent bundle.
find "$VENDOR" -name '*.so' -delete
find "$VENDOR" -name '*.pyc' -delete
find "$VENDOR" -type d -name '__pycache__' -prune -exec rm -rf {} +
# Drop pip's bookkeeping that we don't need shipped (keep *.dist-info: it
# carries each package's LICENSE, which MIT requires us to retain).
rm -rf "$VENDOR/bin"

echo "vendor-deps: done →"
ls -1 "$VENDOR"
