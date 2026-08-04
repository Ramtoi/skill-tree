#!/usr/bin/env bash
#
# stage-ccusage.sh — stage the platform-native ccusage binary for bundling.
#
# The Local Agent Usage dashboard shells out to `ccusage`. In dev the app runs the
# JS shim at app/node_modules/.bin/ccusage (needs a system `node`), but the packaged
# Skill Tree .app bundles NO Node runtime, so it must ship the real native binary
# instead. `resolve_ccusage_binary()` in src-tauri/src/commands/usage.rs expects that
# binary at Contents/Resources/ccusage/bin/ccusage (+ its MIT LICENSE alongside).
#
# ccusage distributes that binary as a per-platform npm optionalDependency
# (@ccusage/ccusage-<platform>-<arch>). `npm install` in app/ already fetches the ONE
# package matching the build machine, so — unlike the Python runtime — there is no
# download/checksum step here. This script just copies whatever npm resolved into a
# gitignored staging dir (src-tauri/ccusage-runtime/) that a plain, non-glob
# tauri.conf.json `bundle.resources` entry points at.
#
# Invoked from tauri's beforeBuildCommand (see tauri.conf.json) and runnable by hand.
# ccusage-runtime/ is generated, not checked in (.gitignored).
#
# NOTE (universal builds): npm installs only the host arch's optionalDependency, so a
# `--target universal-apple-darwin` build on an arm64 runner stages an arm64-only
# ccusage that will not run on Intel. Fusing both arches would require fetching the
# other-arch npm package directly (out of scope here). If universal ccusage coverage
# is needed later, mirror the two-arch lipo dance in fetch-python-runtime.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MODULES="$ROOT/app/node_modules/@ccusage"
STAGE="$ROOT/app/src-tauri/ccusage-runtime"

BIN_NAME="ccusage"
[[ "${OS:-}" == "Windows_NT" ]] && BIN_NAME="ccusage.exe"

# Find the single installed @ccusage/ccusage-<platform>-<arch>/bin/<binary>.
SRC_BIN=""
if [[ -d "$NODE_MODULES" ]]; then
  while IFS= read -r -d '' candidate; do
    SRC_BIN="$candidate"
    break
  done < <(find "$NODE_MODULES" -type f -path "*/bin/$BIN_NAME" -print0 2>/dev/null)
fi

if [[ -z "$SRC_BIN" ]]; then
  echo "stage-ccusage: no @ccusage/*/bin/$BIN_NAME found under $NODE_MODULES" >&2
  echo "stage-ccusage: run 'npm install' in app/ first (it fetches the native ccusage binary)" >&2
  exit 1
fi

SRC_DIR="$(dirname "$(dirname "$SRC_BIN")")"   # .../@ccusage/ccusage-<platform>-<arch>
echo "stage-ccusage: staging $SRC_BIN"

rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp "$SRC_BIN" "$STAGE/bin/$BIN_NAME"
chmod 0755 "$STAGE/bin/$BIN_NAME"

# MIT LICENSE must travel with the redistributed binary.
if [[ -f "$SRC_DIR/LICENSE" ]]; then
  cp "$SRC_DIR/LICENSE" "$STAGE/LICENSE"
else
  echo "stage-ccusage: WARNING — no LICENSE alongside $SRC_DIR; binary is MIT-licensed and its LICENSE should ship" >&2
fi

# Defensive ad-hoc re-sign on macOS: a Mach-O bundled inside the .app that carries
# the com.apple.quarantine xattr after download must be signed to exec. The upstream
# npm binary is ad-hoc signed; copying preserves that, but re-sign to be safe (same
# rationale as fetch-python-runtime.sh's signature pass). Best-effort.
if [[ "$(uname -s)" == "Darwin" ]] && command -v codesign >/dev/null 2>&1; then
  codesign --force -s - "$STAGE/bin/$BIN_NAME" >/dev/null 2>&1 || true
fi

echo "stage-ccusage: done → $STAGE/bin/$BIN_NAME ($(du -h "$STAGE/bin/$BIN_NAME" | awk '{print $1}'))"
