#!/usr/bin/env bash
#
# fetch-python-runtime.sh — populate ./python-runtime/ with a relocatable CPython.
#
# The packaged Skill Tree app must run hub.py even on a machine that has NO system
# python3 (macOS ships none without the Xcode Command Line Tools). Rather than
# depend on the user's interpreter, we ship one inside the bundle. This script
# fetches a pinned, checksum-verified python-build-standalone CPython, trims it,
# and lays it out at ./python-runtime/python/ so tauri.conf.json can bundle it to
# Contents/Resources/python/ (see the sibling vendor-deps.sh, which fills in the
# pure-Python third-party deps the same way).
#
# Universal builds: the release CI runs `tauri build --target
# universal-apple-darwin`, and ONE universal artifact serves both Apple Silicon
# and Intel. A single-arch interpreter inside that app would be unrunnable on the
# other arch, so for a universal target we fetch BOTH arch archives and lipo-fuse
# every Mach-O (interpreter + dylibs/.so) into fat binaries. Per-arch and host
# builds fetch just the one arch.
#
# Invoked from tauri's beforeBuildCommand (see tauri.conf.json) and runnable by
# hand. python-runtime/ is generated, not checked in (.gitignored) — the pins
# below are the single source of truth.
#
# To bump the runtime: change PY_VERSION / PBS_RELEASE / the two SHA256s to a new
# python-build-standalone `install_only_stripped` release. Get the checksums from
# that release's SHA256SUMS asset. Also bump EXPECT_PY_VERSION in
# smoke-test-bundle.sh. Nothing else changes.
set -euo pipefail

# --- Pins (the one place to bump) ------------------------------------------
PY_VERSION="3.12.13"                                        # CPython version
PBS_RELEASE="20260623"                                      # python-build-standalone release tag
SHA256_AARCH64="41df7d3ae4757e84b97874f76d634268456aaa271740d33f968d826374998fb7"
SHA256_X86_64="a6bbea996c5f14eb55ab275889d2df45408deec504b4a7219d7b59c045b2555e"
PY_MINOR="${PY_VERSION%.*}"                                 # e.g. 3.12
# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/python-runtime"
CACHE="${SKILL_HUB_BUILD_CACHE:-$HOME/.cache/skill-hub-build}"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

sha_for_arch() {
  case "$1" in
    aarch64) echo "$SHA256_AARCH64" ;;
    x86_64)  echo "$SHA256_X86_64" ;;
    *) echo "fetch-python-runtime: unknown arch $1" >&2; exit 1 ;;
  esac
}

# Download (cached, checksum-gated) + extract one arch's `python/` tree into $2.
fetch_arch() {
  local arch="$1" destparent="$2"
  local sha archive url cached got
  sha="$(sha_for_arch "$arch")"
  archive="cpython-${PY_VERSION}+${PBS_RELEASE}-${arch}-apple-darwin-install_only_stripped.tar.gz"
  url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${archive}"
  cached="$CACHE/$archive"
  mkdir -p "$CACHE"

  if [[ -f "$cached" && "$(sha256_of "$cached")" == "$sha" ]]; then
    echo "fetch-python-runtime: using cached $archive (checksum OK)"
  else
    [[ -f "$cached" ]] && { echo "fetch-python-runtime: cached $arch archive stale — re-downloading" >&2; rm -f "$cached"; }
    echo "fetch-python-runtime: downloading $url"
    curl -fSL --retry 3 -o "$cached.tmp" "$url"
    mv "$cached.tmp" "$cached"
  fi

  got="$(sha256_of "$cached")"
  if [[ "$got" != "$sha" ]]; then
    echo "fetch-python-runtime: CHECKSUM MISMATCH for $archive" >&2
    echo "  expected $sha" >&2
    echo "  got      $got" >&2
    rm -f "$cached"
    exit 1
  fi
  echo "fetch-python-runtime: checksum verified ($arch)"
  mkdir -p "$destparent"
  tar -xzf "$cached" -C "$destparent"   # extracts a top-level python/ dir
}

# Resolve target: tauri sets TAURI_ENV_TARGET_TRIPLE during a build; else host.
resolve_target() {
  local triple="${TAURI_ENV_TARGET_TRIPLE:-}"
  case "$triple" in
    universal-*) echo "universal"; return ;;
    aarch64-*)   echo "aarch64";   return ;;
    x86_64-*)    echo "x86_64";    return ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) echo "aarch64" ;;
    x86_64)        echo "x86_64" ;;
    *) echo "fetch-python-runtime: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
}

TARGET="$(resolve_target)"
echo "fetch-python-runtime: target=$TARGET cpython=$PY_VERSION release=$PBS_RELEASE"

rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"

if [[ "$TARGET" == "universal" ]]; then
  # Fetch both arches, use aarch64 as the base tree, lipo-fuse every Mach-O.
  TMP_A="$(mktemp -d)"; TMP_X="$(mktemp -d)"
  fetch_arch aarch64 "$TMP_A"
  fetch_arch x86_64  "$TMP_X"
  cp -R "$TMP_A/python" "$RUNTIME/python"
  ARCH_FIELD="universal"
  SHA_FIELD="${SHA256_AARCH64},${SHA256_X86_64}"
  echo "fetch-python-runtime: fusing Mach-O binaries (arm64 + x86_64)"
  # Fuse the interpreter + every dylib/.so present in BOTH trees.
  while IFS= read -r -d '' base; do
    rel="${base#"$RUNTIME/python/"}"
    other="$TMP_X/python/$rel"
    if [[ -f "$other" ]] && file "$base" | grep -q 'Mach-O'; then
      lipo -create "$base" "$other" -output "$base.fat" 2>/dev/null \
        && mv "$base.fat" "$base" \
        || true   # already-fat or non-fusable → leave base (arm64) in place
    fi
  done < <(find "$RUNTIME/python" \( -name '*.dylib' -o -name '*.so' -o -path "*/bin/python${PY_MINOR}" \) -type f -print0)
  rm -rf "$TMP_A" "$TMP_X"
else
  fetch_arch "$TARGET" "$RUNTIME"
  ARCH_FIELD="$TARGET"
  SHA_FIELD="$(sha_for_arch "$TARGET")"
fi

PYROOT="$RUNTIME/python"
LIB="$PYROOT/lib/python${PY_MINOR}"
if [[ ! -x "$PYROOT/bin/python${PY_MINOR}" ]]; then
  echo "fetch-python-runtime: expected interpreter missing after extract" >&2
  exit 1
fi

# --- Collapse to a single interpreter binary -------------------------------
# The archive ships `python${PY_MINOR}` (real) + `python3`/`python` symlinks to
# it. Tauri's resource bundler DEREFERENCES symlinks into full copies, so shipping
# all three would waste ~2×18 MB in the .app. We keep exactly one real binary named
# `python3` (what detect_python() + the smoke test target); the interpreter locates
# its stdlib by landmark, not by its own filename, so the rename is safe.
( cd "$PYROOT/bin"
  rm -f python python3
  mv "python${PY_MINOR}" python3
)

# --- Trim pass -------------------------------------------------------------
# Drop payload nothing in hub.py / the MCP server imports. The smoke test's
# import probe is the guard against over-trimming. Keep ssl/sqlite3/lzma/etc.
TRIMMED=()
trim() {
  local rel="$1" path="$2"
  if [[ -e "$path" ]]; then
    rm -rf "$path"
    TRIMMED+=("$rel")
  fi
}
trim "lib/python${PY_MINOR}/test"       "$LIB/test"
trim "lib/python${PY_MINOR}/idlelib"    "$LIB/idlelib"
trim "lib/python${PY_MINOR}/tkinter"    "$LIB/tkinter"
trim "lib/python${PY_MINOR}/ensurepip"  "$LIB/ensurepip"
trim "lib/python${PY_MINOR}/turtledemo" "$LIB/turtledemo"
# tcl/tk data libs (only used by tkinter).
for d in "$PYROOT"/lib/tcl* "$PYROOT"/lib/tk* "$PYROOT"/lib/Tk* "$PYROOT"/lib/itcl* "$PYROOT"/lib/thread*; do
  [[ -e "$d" ]] && trim "lib/$(basename "$d")" "$d"
done
# Non-interpreter bin/ entries: keep only the single `python3` binary.
if [[ -d "$PYROOT/bin" ]]; then
  for f in "$PYROOT"/bin/*; do
    base="$(basename "$f")"
    case "$base" in
      python3) : ;;                # keep the one interpreter
      *) trim "bin/$base" "$f" ;;
    esac
  done
fi

# --- Signature pass --------------------------------------------------------
# Apple Silicon refuses to exec an unsigned binary once it carries the
# com.apple.quarantine xattr (i.e. after a user downloads the .app). python-
# build-standalone macOS binaries are ad-hoc signed upstream, but lipo-fusing
# invalidates the signature, so re-sign every Mach-O defensively.
if command -v codesign >/dev/null 2>&1; then
  while IFS= read -r -d '' mach; do
    codesign --force -s - "$mach" >/dev/null 2>&1 || true
  done < <(find "$PYROOT" \( -name '*.dylib' -o -name '*.so' -o -path "*/bin/python3" \) -type f -print0)
else
  echo "fetch-python-runtime: codesign not available — skipping signature pass" >&2
fi

# --- Manifest --------------------------------------------------------------
TRIM_JSON="$(printf '%s\n' "${TRIMMED[@]}" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')"
cat > "$PYROOT/runtime-manifest.json" <<EOF
{
  "cpython_version": "${PY_VERSION}",
  "pbs_release": "${PBS_RELEASE}",
  "arch": "${ARCH_FIELD}",
  "sha256": "${SHA_FIELD}",
  "trimmed": ${TRIM_JSON}
}
EOF

DISK_SIZE="$(du -sh "$PYROOT" | awk '{print $1}')"
echo "fetch-python-runtime: done → $PYROOT ($DISK_SIZE on disk, arch=$ARCH_FIELD, ${#TRIMMED[@]} paths trimmed)"
"$PYROOT/bin/python3" --version
[[ "$ARCH_FIELD" == "universal" ]] && lipo -archs "$PYROOT/bin/python3" || true
