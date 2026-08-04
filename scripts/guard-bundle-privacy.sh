#!/usr/bin/env bash
#
# guard-bundle-privacy.sh — prove a built Skill Tree .app carries NOTHING private.
#
# The source mirror has been guarded since day one; the BUILT ARTIFACT was not,
# and that is how a private plugin tree shipped inside the public v0.7.0 zip.
# This script inspects the bytes that actually ship.
#
# Usage:  scripts/guard-bundle-privacy.sh [/path/to/Skill Tree.app]
#
# Checks (all fail-closed — an unreadable bundle or an unusable probe is a
# FAILURE, never a skip):
#   1. no private-looking path names anywhere under Contents/Resources
#      (any path matching *private* or *secret*, case-insensitive)
#   2. no private identifier from scripts/private-identifiers.txt appears in any
#      text file under Contents/Resources (binaries skipped via grep -I).
#      That list is export-ignored, so a mirror-sourced tree legitimately has no
#      list — and nothing private to find; then, and ONLY then, check 2 reports
#      "not applicable".
#   3. the publishable invariant, asked of the app's OWN catalog: run the bundled
#      interpreter against the bundled hub.py with a throwaway SKILL_HUB_HOME
#      (so data-home drop-ins are invisible and only BUNDLED plugins register),
#      and fail if any connector reports publishable != true or a source other
#      than builtin/entry-point.
#
# Check 3 is the durable one: it catches a future private plugin dropped into
# code_home()/connectors/ even if its files are innocuously named and contain no
# known identifier.
#
# Negative test (the one this script must pass): copy a built .app to a temp dir,
# plant a directory whose name contains "private" under Contents/Resources/hub/
# holding a file with one identifier from the list, then re-run this script — it
# must exit non-zero and name the offending path. `tests/test_bundle_privacy_guard.py`
# automates exactly that against a synthetic bundle fixture.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENT_FILE="${PRIVATE_IDENTIFIERS_FILE:-$ROOT/scripts/private-identifiers.txt}"

APP="${1:-}"
if [[ -z "$APP" ]]; then
  APP="$ROOT/app/src-tauri/target/release/bundle/macos/Skill Tree.app"
fi

fail() { echo "guard-bundle-privacy: FAIL — $*" >&2; exit 1; }
ok()   { echo "guard-bundle-privacy: ok   — $*"; }

[[ -d "$APP" ]] || fail "no .app at: $APP"
APP="$(cd "$APP" && pwd)"
RES="$APP/Contents/Resources"
[[ -d "$RES" ]] || fail "bundle has no Contents/Resources: $APP"

# --- 1. private-looking path names -------------------------------------------
# The bundled CPython runtime is pinned, checksum-verified upstream code we do
# not author, and it legitimately ships `secrets.py` / `_ssl` internals. The
# vendored pip deps under hub/vendor are equally third-party — keyring ships
# backends literally named `SecretService.py` / `libsecret.py`. Prune BOTH from
# the NAME check (check 2 still greps their text) so the guard cannot cry wolf
# on every honest build — a guard that false-positives gets disabled.
HITS="$(/usr/bin/find "$RES" -path "$RES/python" -prune -o \
  -path "$RES/hub/vendor" -prune -o \
  \( -iname '*private*' -o -iname '*secret*' \) -print 2>/dev/null || true)"
if [[ -n "$HITS" ]]; then
  echo "$HITS" >&2
  fail "private-looking path(s) inside the bundle (listed above)"
fi
ok "no private-looking path names under Contents/Resources (runtime pruned)"

# --- 2. identifier grep (shared list with the publish workflow) ---------------
if [[ -f "$IDENT_FILE" ]]; then
  PATTERNS="$(mktemp)"
  trap 'rm -f "$PATTERNS"' EXIT
  # Strip comments + blank lines; keep one ERE per line for `grep -f`.
  /usr/bin/sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' -e 's/[[:space:]]*$//' \
    "$IDENT_FILE" > "$PATTERNS"
  [[ -s "$PATTERNS" ]] || fail "identifier list $IDENT_FILE has no patterns"
  # Distinguish grep's three outcomes explicitly: 0 = matched (leak), 1 = clean,
  # anything else = grep itself failed, which must NOT read as clean.
  set +e
  grep -rIniE -f "$PATTERNS" "$RES" >&2
  GREP_RC=$?
  set -e
  case "$GREP_RC" in
    0) fail "private identifier(s) found in the bundle (matches above)" ;;
    1) ok "no private identifiers in bundle text ($(grep -c . "$PATTERNS" | tr -d ' ') patterns)" ;;
    *) fail "identifier grep failed (exit $GREP_RC) — refusing to report clean" ;;
  esac
else
  # Only legitimate in a mirror-sourced tree: the list is export-ignored, and a
  # public tree has no private strings to match. Loud, but not a failure.
  echo "guard-bundle-privacy: note — no identifier list at $IDENT_FILE" >&2
  echo "guard-bundle-privacy: note — check 2 not applicable (public/mirror tree)" >&2
fi

# --- 3. publishable invariant, via the app's own connector catalog ------------
PYBIN="$RES/python/bin/python3"
HUB="$RES/hub/hub.py"
[[ -x "$PYBIN" ]] || fail "bundled interpreter missing/not executable: $PYBIN"
[[ -f "$HUB" ]]   || fail "bundled hub.py missing: $HUB"

TMPHOME="$(mktemp -d)"
CATALOG="$( ( cd /tmp && env -i HOME="$HOME" PATH=/usr/bin:/bin \
  SKILL_HUB_HOME="$TMPHOME" "$PYBIN" "$HUB" remote connectors --json ) 2>&1 )" \
  || { rm -rf "$TMPHOME"; fail "bundled catalog probe failed: $CATALOG"; }
rm -rf "$TMPHOME"

VERDICT="$(printf '%s' "$CATALOG" | "$PYBIN" -c '
import json, sys
try:
    rows = json.loads(sys.stdin.read())
except Exception as exc:
    print("unparsable catalog JSON: %s" % exc); sys.exit(0)
if not isinstance(rows, list):
    print("catalog is not a list"); sys.exit(0)
bad = []
for row in rows:
    src = row.get("source")
    if row.get("publishable") is not True:
        bad.append("%s (publishable=%r)" % (row.get("key"), row.get("publishable")))
    elif src not in ("builtin", "entry-point"):
        bad.append("%s (source=%r)" % (row.get("key"), src))
print("; ".join(bad) if bad else "")
sys.exit(0)
')"
[[ -z "$VERDICT" ]] || fail "non-publishable connector bundled: $VERDICT"
COUNT="$(printf '%s' "$CATALOG" | "$PYBIN" -c 'import json,sys; print(len(json.load(sys.stdin)))')"
ok "bundled connector catalog is all-publishable ($COUNT connector(s))"

echo "guard-bundle-privacy: PASS ($APP)"
