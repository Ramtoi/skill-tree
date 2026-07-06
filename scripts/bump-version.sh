#!/usr/bin/env bash
# Bump the single version source of truth and propagate it everywhere.
#
# Usage: scripts/bump-version.sh <semver>     e.g. scripts/bump-version.sh 0.2.0
#
# Writes the same version into all four places that must stay in lockstep:
#   - VERSION                            (root source of truth, read by hub.py)
#   - app/package.json                   (read by publish.yml for the tag/release)
#   - app/src-tauri/tauri.conf.json      (Tauri bundle version + updater compare)
#   - app/src-tauri/Cargo.toml           ([package] version)
#
# Pure text edits (sed/node) — no deps beyond node, which the app build needs anyway.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <semver>   (e.g. 0.2.0)" >&2
  exit 2
fi

VERSION="$1"
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  echo "error: '$VERSION' is not a semver like 1.2.3" >&2
  exit 2
fi

# Resolve repo root from this script's location so it works from any CWD.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 1. VERSION (source of truth)
printf '%s\n' "$VERSION" > VERSION

# 2. app/package.json — surgical edit of the top-level "version" key via node.
node -e '
  const fs = require("fs");
  const p = "app/package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$VERSION"

# 3. app/src-tauri/tauri.conf.json — top-level "version" key.
node -e '
  const fs = require("fs");
  const p = "app/src-tauri/tauri.conf.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$VERSION"

# 4. app/src-tauri/Cargo.toml — the [package] version line. The `^version = `
#    anchor (with /m, no /g) hits only the line that *starts* with `version = `,
#    i.e. [package], never the `name = { version = "2" }` dependency lines.
perl -0pi -e 's/^version = "[^"]*"/version = "'"$VERSION"'"/m' \
  app/src-tauri/Cargo.toml

echo "Bumped to $VERSION:"
echo "  VERSION"
echo "  app/package.json"
echo "  app/src-tauri/tauri.conf.json"
echo "  app/src-tauri/Cargo.toml"
echo
echo "Next: commit, push to master, then trigger publish.yml (see RELEASING.md)."
