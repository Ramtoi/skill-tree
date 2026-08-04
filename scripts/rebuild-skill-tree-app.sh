#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app"
BUILT_APP="$APP_DIR/src-tauri/target/release/bundle/macos/Skill Tree.app"
INSTALLED_APP="/Applications/Skill Tree.app"

cd "$APP_DIR"

echo "==> Building Skill Tree"
npm run tauri build

echo "==> Validating bundled Python runtime"
# Gate the install on the bundle smoke test — never copy an unvalidated .app to
# /Applications (the fetch itself already ran via beforeBuildCommand).
bash "$ROOT/scripts/smoke-test-bundle.sh" "$BUILT_APP"

echo "==> Replacing installed app"
rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP"

echo "==> Done"
echo "Launch with: open -a 'Skill Tree'"
echo "Dev mode instead: cd '$ROOT' && python3 hub.py dashboard --dev"
