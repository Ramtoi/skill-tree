"""The plugin boundary: location is the shipping boundary, and it is enforced.

Private plugin code used to live inside this repo, excluded from publication by
several *remembered* mechanisms — and the one that was forgotten (a
`bundle.resources` entry) shipped it inside a public release. These tests pin the
structural replacement:

  * a connector discovered as `builtin` (i.e. inside `code_home()`) MUST declare
    `publishable = True` — a private plugin can only reach an artifact by being
    put in the code home *and* lying about the flag;
  * no `bundle.resources` entry may point at a private-looking path;
  * the private plugin tree's name must not reappear anywhere in the tracked
    tree (outside the guard's own inputs, which never ship);
  * `scripts/guard-bundle-privacy.sh` must PASS a clean bundle and FAIL a planted
    one — checked here against synthetic bundle fixtures, so the tripwire itself
    is regression-tested without a 300 MB build.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
GUARD = REPO_ROOT / "scripts" / "guard-bundle-privacy.sh"
IDENTIFIERS = REPO_ROOT / "scripts" / "private-identifiers.txt"
TAURI_CONF = REPO_ROOT / "app" / "src-tauri" / "tauri.conf.json"

# The identifier list is export-ignored (publishing the strings that must never
# be published would defeat it), so it is legitimately ABSENT on the public
# mirror — the file-flavored analog of the importorskip("connectors…") guards.
needs_identifier_list = pytest.mark.skipif(
    not IDENTIFIERS.exists(),
    reason="private-identifiers.txt is export-ignored; absent on the public mirror",
)

# Built without a string literal so this file never trips the very grep it
# defends (the publish guard scans `tests/` too).
PRIVATE_TREE = "connectors_" + "private"

# The only tracked files allowed to name the old private tree: the guard's own
# pattern list and the publish workflow — neither of which is ever published
# (export-ignored / stripped from the snapshot).
NAME_ALLOWLIST = {
    "scripts/private-identifiers.txt",
    ".github/workflows/publish.yml",
}


# ─────────────────────────────────────────────────────────────────────────────
# Invariant 1 — builtin ⇒ publishable
# ─────────────────────────────────────────────────────────────────────────────


def test_every_builtin_connector_is_publishable(tmp_data_home):
    """Anything shipped from `code_home()` is public by definition."""
    import connectors
    from connectors import discovery as disc

    connectors.ensure_discovered()
    builtin = [
        key for key in connectors.REMOTE_CONNECTORS
        if disc._SOURCE.get(key, "builtin") == "builtin"
    ]
    assert builtin, "expected at least one builtin connector (hermes)"
    offenders = [
        key for key in builtin
        if getattr(connectors.REMOTE_CONNECTORS[key], "publishable", False) is not True
    ]
    assert not offenders, (
        f"builtin connector(s) {offenders} declare publishable=False — a connector "
        f"inside code_home() ships in the .app and the public mirror. Move it to a "
        f"data_home()/connectors/ drop-in, or mark it publishable."
    )


def test_discovery_has_no_in_tree_private_source():
    """Only three sources exist; a fourth in-tree one is what leaked before."""
    from connectors import discovery as disc

    assert not hasattr(disc, "_discover_private")
    src = (REPO_ROOT / "connectors" / "discovery.py").read_text()
    assert PRIVATE_TREE not in src


# ─────────────────────────────────────────────────────────────────────────────
# Invariant 2 — nothing private-looking is a bundle resource
# ─────────────────────────────────────────────────────────────────────────────


def test_no_bundle_resource_points_at_a_private_path():
    conf = json.loads(TAURI_CONF.read_text())
    resources = conf["bundle"]["resources"]
    entries = list(resources.items()) if isinstance(resources, dict) else [
        (r, r) for r in resources
    ]
    bad = [
        (src, dst) for src, dst in entries
        if "private" in str(src).lower() or "private" in str(dst).lower()
    ]
    assert not bad, f"bundle.resources ships private-looking path(s): {bad}"


# ─────────────────────────────────────────────────────────────────────────────
# Invariant 3 — the private tree's name is gone from the tracked tree
# ─────────────────────────────────────────────────────────────────────────────


def test_tracked_tree_has_no_private_plugin_references():
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout
    hits = []
    for rel in filter(None, out.split("\0")):
        if rel in NAME_ALLOWLIST:
            continue
        path = REPO_ROOT / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary / unreadable → nothing to leak textually
        if PRIVATE_TREE in text:
            hits.append(rel)
    assert not hits, (
        f"tracked file(s) still reference the removed private plugin tree: {hits}. "
        f"Private plugins live in their own repo, installed as data-home drop-ins."
    )


def test_private_tree_is_not_on_disk_in_the_repo():
    assert not (REPO_ROOT / PRIVATE_TREE).exists()


# ─────────────────────────────────────────────────────────────────────────────
# Invariant 4 — the bundle guard actually catches a leak
# ─────────────────────────────────────────────────────────────────────────────

_FAKE_HUB = '''#!/usr/bin/env python3
"""Minimal stand-in for the bundled hub.py: answers `remote connectors --json`."""
import json, sys
CATALOG = json.loads({catalog!r})
if sys.argv[1:3] == ["remote", "connectors"]:
    print(json.dumps(CATALOG))
    sys.exit(0)
sys.exit(2)
'''


def _make_bundle(root: Path, *, catalog=None) -> Path:
    """A synthetic .app with just what the guard inspects."""
    if catalog is None:
        catalog = [{
            "key": "hermes", "publishable": True, "available": True,
            "source": "builtin",
        }]
    app = root / "Skill Tree.app"
    res = app / "Contents" / "Resources"
    (res / "hub").mkdir(parents=True)
    (res / "python" / "bin").mkdir(parents=True)
    (res / "hub" / "hub.py").write_text(_FAKE_HUB.format(catalog=json.dumps(catalog)))
    (res / "hub" / "innocuous.py").write_text("# nothing to see here\n")
    # Upstream CPython legitimately ships a `secrets.py`; the name check must
    # prune the runtime rather than reject every honest build.
    stdlib = res / "python" / "lib" / "python3.12"
    stdlib.mkdir(parents=True)
    (stdlib / "secrets.py").write_text("# CPython stdlib\n")
    # A wrapper rather than a symlink: the guard runs the interpreter from a
    # stripped environment, and a relocated symlink can confuse sys.prefix.
    # Prefer the system interpreter so the wrapper's own text can never contain
    # a path the identifier grep would (correctly) object to.
    interp = "/usr/bin/python3" if Path("/usr/bin/python3").exists() else sys.executable
    pybin = res / "python" / "bin" / "python3"
    pybin.write_text(f'#!/bin/sh\nexec {interp} "$@"\n')
    pybin.chmod(0o755)
    return app


def _run_guard(app: Path):
    return subprocess.run(
        ["bash", str(GUARD), str(app)],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )


@pytest.fixture(autouse=True)
def _require_guard():
    if not GUARD.is_file():  # pragma: no cover - the guard is tracked
        pytest.skip("guard script missing")
    if os.name != "posix":  # pragma: no cover - macOS/Linux only
        pytest.skip("guard is a POSIX shell script")


def test_guard_passes_a_clean_bundle(tmp_path):
    """Including CPython's own `secrets.py` — a guard that cries wolf gets disabled."""
    res = _run_guard(_make_bundle(tmp_path))
    assert res.returncode == 0, res.stdout + res.stderr
    assert "PASS" in res.stdout


def test_guard_passes_vendored_keyring_backend_names(tmp_path):
    """hub/vendor is third-party pip output — keyring ships `SecretService.py` /
    `libsecret.py`, which broke the first 0.9.0 publish. Pruned from the NAME
    check only; the identifier grep still covers vendor text."""
    app = _make_bundle(tmp_path)
    backends = app / "Contents" / "Resources" / "hub" / "vendor" / "keyring" / "backends"
    backends.mkdir(parents=True)
    (backends / "SecretService.py").write_text("# upstream backend\n")
    (backends / "libsecret.py").write_text("# upstream backend\n")

    res = _run_guard(app)
    assert res.returncode == 0, res.stdout + res.stderr


@needs_identifier_list
def test_guard_still_greps_vendor_text(tmp_path):
    """Vendor is pruned from the NAME check only — an identifier in its text fails."""
    app = _make_bundle(tmp_path)
    patterns = [
        ln.split("#", 1)[0].strip()
        for ln in IDENTIFIERS.read_text().splitlines()
    ]
    identifier = next(p for p in patterns if p and "/" not in p)
    vendor = app / "Contents" / "Resources" / "hub" / "vendor" / "keyring"
    vendor.mkdir(parents=True)
    (vendor / "core.py").write_text(f"# {identifier}\n")

    res = _run_guard(app)
    assert res.returncode != 0


@needs_identifier_list
def test_guard_still_greps_the_runtime_text(tmp_path):
    """The runtime is pruned from the NAME check only, not from the identifier grep."""
    app = _make_bundle(tmp_path)
    patterns = [
        ln.split("#", 1)[0].strip()
        for ln in IDENTIFIERS.read_text().splitlines()
    ]
    identifier = next(p for p in patterns if p and "/" not in p)
    (app / "Contents" / "Resources" / "python" / "lib" / "python3.12" / "sitecustomize.py"
     ).write_text(f"# {identifier}\n")

    res = _run_guard(app)
    assert res.returncode != 0


def test_guard_fails_on_a_planted_private_directory(tmp_path):
    app = _make_bundle(tmp_path)
    planted = app / "Contents" / "Resources" / "hub" / "my_private_plugin"
    planted.mkdir()
    (planted / "connector.py").write_text("# planted\n")

    res = _run_guard(app)
    assert res.returncode != 0
    assert "my_private_plugin" in (res.stdout + res.stderr)


@needs_identifier_list
def test_guard_fails_on_a_planted_private_identifier(tmp_path):
    """A file with an innocuous NAME but private CONTENT is still caught."""
    app = _make_bundle(tmp_path)
    patterns = [
        ln.split("#", 1)[0].strip()
        for ln in IDENTIFIERS.read_text().splitlines()
    ]
    identifier = next(p for p in patterns if p and "/" not in p)
    (app / "Contents" / "Resources" / "hub" / "notes.txt").write_text(
        f"deploy target: {identifier}\n"
    )

    res = _run_guard(app)
    assert res.returncode != 0
    assert "identifier" in (res.stdout + res.stderr).lower()


def test_guard_fails_on_a_non_publishable_bundled_connector(tmp_path):
    """The durable check: an innocuously-named, identifier-free private plugin."""
    app = _make_bundle(tmp_path, catalog=[
        {"key": "hermes", "publishable": True, "source": "builtin"},
        {"key": "secret-box", "publishable": False, "source": "builtin"},
    ])
    res = _run_guard(app)
    assert res.returncode != 0
    assert "secret-box" in (res.stdout + res.stderr)


def test_guard_fails_closed_on_a_broken_bundle(tmp_path):
    """No interpreter → failure, never a silent skip."""
    app = _make_bundle(tmp_path)
    (app / "Contents" / "Resources" / "python" / "bin" / "python3").unlink()
    res = _run_guard(app)
    assert res.returncode != 0


@needs_identifier_list
def test_identifier_list_has_patterns_and_is_export_ignored():
    patterns = [
        ln.split("#", 1)[0].strip()
        for ln in IDENTIFIERS.read_text().splitlines()
    ]
    assert len([p for p in patterns if p]) >= 5
    attrs = (REPO_ROOT / ".gitattributes").read_text()
    assert "scripts/private-identifiers.txt export-ignore" in attrs


def test_guard_is_wired_into_the_bundle_smoke_test():
    smoke = (REPO_ROOT / "scripts" / "smoke-test-bundle.sh").read_text()
    assert "guard-bundle-privacy.sh" in smoke


def test_guard_script_is_executable():
    assert GUARD.stat().st_mode & stat.S_IXUSR
