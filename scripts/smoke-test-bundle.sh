#!/usr/bin/env bash
#
# smoke-test-bundle.sh — prove a built Skill Tree .app can run hub.py on its
# OWN bundled Python, with no system interpreter and no inherited environment.
#
# This is the "make sure it works" gate for the bundled-python-runtime change.
# It runs against a real .app (default: the tauri release output) and exits
# non-zero on any failure, so a broken bundle fails the build, not the user.
#
# Usage:  scripts/smoke-test-bundle.sh [/path/to/Skill Tree.app]
#
# Checks (see openspec change bundle-python-runtime, design D6):
#   1. bundled interpreter exists, is executable, reports the pinned version
#   2. hermetic: minimal PATH, PYTHONHOME/PYTHONPATH unset, non-repo cwd
#   3. hub.py --version matches the bundled VERSION
#   4. import probe: every stdlib module hub.py + the MCP server use, plus the
#      vendored yaml/tomlkit — catches over-trimming of the runtime
#   5. hub.py selfcheck --json exits 0 with "ok": true (the SAME probe the app's
#      Rust preflight runs; NOT `list` — registry commands exit 1 on an empty home)
#   6. bundled interpreter carries at least an ad-hoc code signature
#   7. runtime-manifest arch matches the app binary's arch
#   8. prints the measured on-disk runtime size
#
# Negative validation (manual): copy the .app, `rm` a probed stdlib module from
# Resources/python/lib/python3.*/, re-run — check 4 must fail and the script exit
# non-zero. No permanent artifact needed.
set -euo pipefail

# The pinned interpreter version — keep in sync with scripts/fetch-python-runtime.sh.
EXPECT_PY_VERSION="3.12.13"

# stdlib modules actually imported by hub.py + siblings + skill_hub_mcp_server.py.
# Regenerate with:
#   python3.12 -c 'import ast,sys,pathlib; ...'  (see the change's task 4.1)
# msvcrt is intentionally excluded (Windows-only, import-guarded).
STDLIB_IMPORTS="abc argparse ast contextlib copy dataclasses datetime enum errno \
fcntl functools hashlib importlib inspect io json logging os pathlib platform \
posixpath re shlex shutil subprocess sys tarfile tempfile threading time \
traceback typing urllib"

APP="${1:-}"
if [[ -z "$APP" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  APP="$ROOT/app/src-tauri/target/release/bundle/macos/Skill Tree.app"
fi

fail() { echo "smoke-test-bundle: FAIL — $*" >&2; exit 1; }
ok()   { echo "smoke-test-bundle: ok   — $*"; }

[[ -d "$APP" ]] || fail "no .app at: $APP"
# Absolutize — the hermetic runner cd's to /tmp, so relative paths would break.
APP="$(cd "$APP" && pwd)"
RES="$APP/Contents/Resources"
PYBIN="$RES/python/bin/python3"
HUB="$RES/hub/hub.py"
[[ -e "$PYBIN" ]] || fail "bundled interpreter missing: $PYBIN"
[[ -f "$HUB" ]]   || fail "bundled hub.py missing: $HUB"

# --- Hermetic runner: no inherited PATH/PYTHONHOME/PYTHONPATH, non-repo cwd ---
run_hermetic() {
  ( cd /tmp && env -i HOME="$HOME" PATH=/usr/bin:/bin "$@" )
}

# 1 + 2. Interpreter runs hermetically and reports the pinned version.
VER_OUT="$(run_hermetic "$PYBIN" --version 2>&1)" || fail "interpreter did not run: $VER_OUT"
[[ "$VER_OUT" == "Python $EXPECT_PY_VERSION" ]] \
  || fail "version mismatch: got '$VER_OUT', expected 'Python $EXPECT_PY_VERSION'"
ok "interpreter runs hermetically → $VER_OUT"

# 3. hub.py version matches the bundled VERSION file. `version` is a subcommand
#    (not a flag) and reads the registry, so seed an empty one in a temp home.
VERHOME="$(mktemp -d)"; printf '{}' > "$VERHOME/registry.yaml"
HUB_VER="$(run_hermetic SKILL_HUB_HOME="$VERHOME" "$PYBIN" "$HUB" version 2>&1)" \
  || fail "hub.py version failed: $HUB_VER"
rm -rf "$VERHOME"
FILE_VER="$(tr -d '[:space:]' < "$RES/hub/VERSION")"
[[ "$(echo "$HUB_VER" | tr -d '[:space:]')" == *"$FILE_VER"* ]] \
  || fail "hub.py version ('$HUB_VER') does not match VERSION ('$FILE_VER')"
ok "hub.py version matches VERSION ($FILE_VER)"

# 4. Import probe — stdlib + vendored yaml/tomlkit (via hub.py's vendor shim path).
IMPORT_PROBE="import sys; sys.path.insert(0, '$RES/hub/vendor')
for m in '''$STDLIB_IMPORTS'''.split() + ['yaml','tomlkit']:
    __import__(m)
print('imports-ok', len('''$STDLIB_IMPORTS'''.split()) + 2)"
PROBE_OUT="$(run_hermetic "$PYBIN" -c "$IMPORT_PROBE" 2>&1)" \
  || fail "import probe failed (over-trimmed runtime?): $PROBE_OUT"
ok "import probe → $PROBE_OUT"

# 5. selfcheck --json against a fresh temp home → ok:true (the real preflight path).
TMPHOME="$(mktemp -d)"
SELF_OUT="$(run_hermetic SKILL_HUB_HOME="$TMPHOME" "$PYBIN" "$HUB" selfcheck --json 2>&1)" \
  || fail "selfcheck exited non-zero: $SELF_OUT"
echo "$SELF_OUT" | run_hermetic "$PYBIN" -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") else 1)' \
  || fail "selfcheck did not report ok:true → $SELF_OUT"
rm -rf "$TMPHOME"
ok "selfcheck --json → ok:true"

# 6. Interpreter carries at least an ad-hoc signature (Apple Silicon requires it
#    once the download is quarantined).
if command -v codesign >/dev/null 2>&1; then
  codesign -dv "$PYBIN" >/dev/null 2>&1 || fail "bundled interpreter is unsigned"
  ok "interpreter is code-signed"
else
  echo "smoke-test-bundle: codesign unavailable — skipping signature check" >&2
fi

# 7. Manifest arch matches the app binary's arch.
MANIFEST="$RES/python/runtime-manifest.json"
[[ -f "$MANIFEST" ]] || fail "runtime-manifest.json missing"
MANIFEST_ARCH="$(run_hermetic "$PYBIN" -c "import json; print(json.load(open('$MANIFEST'))['arch'])")"
APP_BIN="$(/usr/bin/find "$APP/Contents/MacOS" -type f -perm +111 | head -1)"
BIN_ARCH_RAW="$(/usr/bin/lipo -archs "$APP_BIN" 2>/dev/null || /usr/bin/file "$APP_BIN")"
INTERP_ARCH_RAW="$(/usr/bin/lipo -archs "$PYBIN" 2>/dev/null || /usr/bin/file "$PYBIN")"
case "$MANIFEST_ARCH" in
  aarch64)   EXPECT_BIN="arm64" ;;
  x86_64)    EXPECT_BIN="x86_64" ;;
  # A universal app must carry a universal interpreter — every arch the app binary
  # supports must also be in the interpreter, else that slice can't run hub.py.
  universal) EXPECT_BIN="arm64" ;;
  *) fail "unknown manifest arch: $MANIFEST_ARCH" ;;
esac
[[ "$BIN_ARCH_RAW" == *"$EXPECT_BIN"* ]] \
  || fail "arch mismatch: manifest=$MANIFEST_ARCH ($EXPECT_BIN) vs binary '$BIN_ARCH_RAW'"
if [[ "$MANIFEST_ARCH" == "universal" ]]; then
  for slice in $BIN_ARCH_RAW; do
    [[ "$INTERP_ARCH_RAW" == *"$slice"* ]] \
      || fail "universal app binary has '$slice' but bundled interpreter lacks it (interp: $INTERP_ARCH_RAW)"
  done
  ok "universal arches match: binary=[$BIN_ARCH_RAW], interpreter=[$INTERP_ARCH_RAW]"
else
  ok "arch matches: manifest=$MANIFEST_ARCH, binary=$BIN_ARCH_RAW"
fi

# 8. On-disk size (informational; recorded in release notes).
SIZE="$(du -sh "$RES/python" | awk '{print $1}')"
ok "bundled runtime on-disk size: $SIZE"

echo "smoke-test-bundle: PASS ($APP)"
