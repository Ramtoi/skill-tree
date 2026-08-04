"""Tests for `hub remote equip <id> --kind {bundle|skill} --name --state {on|off}`.

Registry-only toggle of a remote's equipped bundles/skills (D8): validates the
remote id + the name's existence, mutates the remote's `bundles`/`enabled`
arrays, is idempotent, and never pushes to the box.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def _seed(tmp_data_home: Path) -> None:
    registry = {
        "version": "1",
        "skills": {
            "foo": {"source": "/x/foo", "type": "claude-skill", "scope": "portable"},
            "bar": {"source": "/x/bar", "type": "claude-skill", "scope": "portable"},
        },
        "bundles": {
            "android": {"description": "", "skills": ["foo"]},
        },
        "remotes": {
            "box": {
                "connector": "hermes",
                "transport": {"ssh_host": "h@x"},
                "bundles": [],
                "enabled": [],
                "sync_enabled": True,
            }
        },
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _run(tmp_data_home: Path, args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(tmp_data_home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _registry(tmp_data_home: Path) -> dict:
    return yaml.safe_load((tmp_data_home / "registry.yaml").read_text()) or {}


def _equip(tmp_data_home, kind, name, state):
    return _run(
        tmp_data_home,
        ["remote", "equip", "box", "--kind", kind, "--name", name,
         "--state", state, "--json"],
    )


def test_equip_bundle_on_and_off(tmp_data_home):
    _seed(tmp_data_home)
    r = _equip(tmp_data_home, "bundle", "android", "on")
    assert r.returncode == 0, r.stderr
    payload = json.loads(r.stdout)
    assert payload["ok"] is True
    assert payload["bundles"] == ["android"]
    assert payload["enabled"] == []
    assert _registry(tmp_data_home)["remotes"]["box"]["bundles"] == ["android"]

    r = _equip(tmp_data_home, "bundle", "android", "off")
    payload = json.loads(r.stdout)
    assert payload["bundles"] == []
    assert _registry(tmp_data_home)["remotes"]["box"]["bundles"] == []


def test_equip_skill_on_and_off(tmp_data_home):
    _seed(tmp_data_home)
    r = _equip(tmp_data_home, "skill", "bar", "on")
    payload = json.loads(r.stdout)
    assert payload["enabled"] == ["bar"]
    assert payload["bundles"] == []

    r = _equip(tmp_data_home, "skill", "bar", "off")
    payload = json.loads(r.stdout)
    assert payload["enabled"] == []


def test_equip_idempotent(tmp_data_home):
    _seed(tmp_data_home)
    _equip(tmp_data_home, "bundle", "android", "on")
    # on-when-present is a no-op (no duplicate)
    r = _equip(tmp_data_home, "bundle", "android", "on")
    assert json.loads(r.stdout)["bundles"] == ["android"]
    # off-when-absent is a no-op
    _equip(tmp_data_home, "bundle", "android", "off")
    r = _equip(tmp_data_home, "bundle", "android", "off")
    assert json.loads(r.stdout)["bundles"] == []


def test_unknown_remote_fails(tmp_data_home):
    _seed(tmp_data_home)
    r = _run(
        tmp_data_home,
        ["remote", "equip", "ghost", "--kind", "bundle", "--name", "android",
         "--state", "on", "--json"],
    )
    assert r.returncode != 0
    assert "ghost" in (r.stdout + r.stderr).lower()


def test_unknown_bundle_name_fails(tmp_data_home):
    _seed(tmp_data_home)
    r = _equip(tmp_data_home, "bundle", "nope", "on")
    assert r.returncode != 0
    assert "nope" in (r.stdout + r.stderr).lower()


def test_unknown_skill_name_fails(tmp_data_home):
    _seed(tmp_data_home)
    r = _equip(tmp_data_home, "skill", "nope", "on")
    assert r.returncode != 0
    assert "nope" in (r.stdout + r.stderr).lower()


def test_registry_only_no_sidecar_written(tmp_data_home):
    """Equip mutates the registry only — no ownership sidecar / box push."""
    _seed(tmp_data_home)
    _equip(tmp_data_home, "bundle", "android", "on")
    # The remote-dispatch ownership sidecar lives under state/remote_<id>/; equip
    # must not create it (the box is reconciled by a later sync, not by equip).
    assert not (tmp_data_home / "state" / "remote_box").exists()
