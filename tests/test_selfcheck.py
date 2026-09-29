"""Tests for `hub selfcheck` — the registry-free runtime probe the app's
preflight relies on (harden-onboarding change).

Covers:
- It runs without a registry and creates nothing (preflight runs pre-bootstrap).
- The vendored deps resolve even with site-packages disabled (`-S`).
- A hard import failure (no vendor, no site yaml) exits non-zero with a real
  message — what the preflight relays as `hub-unrunnable`.
- A missing *optional* dep (tomlkit) is a non-fatal warning, not a failure.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HUB_PY = REPO_ROOT / "hub.py"
VENDOR = REPO_ROOT / "vendor"

# Keep the existing registered MCP launch path in isolated code homes.
# Its implementation is copied with the package below.
SIBLING_MODULES = ["skill_hub_mcp_server.py"]

# `hub.py` imports the package at module scope. Copy the complete package,
# including nested modules that are imported only from function bodies.
SIBLING_PACKAGES = [
    "skill_hub",
    "connectors",
]


def _copy_siblings(iso: Path) -> None:
    """Copy hub.py's eager (module-scope) dependencies into an isolated dir.

    Every entry in SIBLING_MODULES/SIBLING_PACKAGES must exist in the repo. The
    package copy is intentionally whole-tree: a stale hand-maintained module
    list would silently shrink hub.py's reproduced import surface.
    """
    for mod in SIBLING_MODULES:
        src = REPO_ROOT / mod
        if not src.exists():
            raise AssertionError(f"SIBLING_MODULES entry missing from repo: {mod}")
        shutil.copy(src, iso / mod)
    for pkg in SIBLING_PACKAGES:
        src = REPO_ROOT / pkg
        if not src.is_dir():
            raise AssertionError(f"SIBLING_PACKAGES entry missing from repo: {pkg}")
        shutil.copytree(src, iso / pkg)


def _run(args, env=None, cwd=None):
    return subprocess.run(
        [sys.executable, *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
    )


def test_selfcheck_is_registry_free_and_exits_zero(tmp_data_home):
    """No registry exists at the isolated home; selfcheck must still succeed
    and must not create the registry (it runs before bootstrap)."""
    import os

    env = {**os.environ, "SKILL_HUB_HOME": str(tmp_data_home)}
    res = _run([str(HUB_PY), "selfcheck", "--json"], env=env, cwd=str(REPO_ROOT))
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert payload["ok"] is True
    assert "python" in payload and payload["python"]
    # Registry-free: nothing written into the data home.
    assert not (tmp_data_home / "registry.yaml").exists()


def test_selfcheck_resolves_vendored_deps_without_site(tmp_data_home):
    """With site-packages disabled (`-S`), yaml/tomlkit must come from the
    bundled vendor/ — proving the sys.path shim works on a clean interpreter."""
    if not VENDOR.is_dir():
        import os

        import pytest

        if os.environ.get("CI"):
            pytest.fail(
                "vendor/ not generated in CI — the Python job never stages it "
                "(TA-1-f6b0); this gate must not silently skip on every run"
            )
        pytest.skip("vendor/ not generated (run scripts/vendor-deps.sh)")
    import os

    env = {**os.environ, "SKILL_HUB_HOME": str(tmp_data_home)}
    res = _run(["-S", str(HUB_PY), "selfcheck", "--json"], env=env, cwd=str(REPO_ROOT))
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert payload["ok"] is True
    assert payload["vendor_dir"]  # vendor was on the path


def test_selfcheck_hard_failure_without_yaml(tmp_path):
    """No vendor + no site-packages yaml → hub.py's import guard fires: non-zero
    exit with a real message the preflight surfaces as hub-unrunnable."""
    iso = tmp_path / "iso"
    iso.mkdir()
    shutil.copy(HUB_PY, iso / "hub.py")
    _copy_siblings(iso)
    # No vendor/ in iso, and -S blocks user/site-packages → yaml unavailable.
    res = _run(["-S", str(iso / "hub.py"), "selfcheck"], cwd=str(iso))
    assert res.returncode != 0
    assert "pyyaml not installed" in res.stderr.lower()


def test_selfcheck_missing_optional_dep_is_nonfatal(tmp_path):
    """yaml present but tomlkit absent → exit 0 with a non-fatal warning, so a
    Codex-only dep gap never blocks onboarding."""
    if not (VENDOR / "yaml").is_dir():
        import os

        import pytest

        if os.environ.get("CI"):
            pytest.fail(
                "vendored yaml/ not present in CI — the Python job never stages "
                "vendor/ (TA-1-f6b0); this gate must not silently skip on every run"
            )
        pytest.skip("vendored yaml/ not present")
    iso = tmp_path / "iso"
    iso.mkdir()
    shutil.copy(HUB_PY, iso / "hub.py")
    _copy_siblings(iso)
    # A vendor/ with ONLY yaml (no tomlkit).
    vend = iso / "vendor"
    vend.mkdir()
    shutil.copytree(VENDOR / "yaml", vend / "yaml")
    res = _run(["-S", str(iso / "hub.py"), "selfcheck", "--json"], cwd=str(iso))
    assert res.returncode == 0, res.stderr
    payload = json.loads(res.stdout)
    assert payload["ok"] is True
    assert any("tomlkit" in w for w in payload["warnings"])
