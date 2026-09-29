"""`hub archive` / `hub rename` must visit EVERY registry site that can hold a
skill name. Regression: archiving a skill that sat in a `scope: global` bundle
left the name in `bundles.<b>.skills`, so every project failed the next sync
with `unknown skill: <name>` and the UI had no way to remove it.

Runs the CLI as a subprocess under a fake HOME + SKILL_HUB_HOME so the
auto-sync tail can never touch the developer's real harness dirs.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def _write_skill(root: Path, name: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(f"---\nname: {name}\ndescription: d\n---\n\nBody.\n")


def _seed(data_home: Path, project_dir: Path) -> None:
    for n in ("demo", "other"):
        _write_skill(data_home / "skills" / n, n)
    registry = {
        "version": "1",
        "skills": {
            n: {"source": str(data_home / "skills" / n), "type": "claude-skill", "scope": "portable"}
            for n in ("demo", "other")
        },
        "bundles": {
            "globalpack": {"description": "", "scope": "global", "skills": ["demo", "other"]},
            "pack": {"description": "", "skills": ["other", "demo"]},
        },
        "projects": {
            "proj": {
                "path": str(project_dir),
                "bundles": ["pack"],
                "enabled": ["demo"],
                "invocation_overrides": {"demo": "user-only", "other": "user-only"},
            }
        },
        "remotes": {
            "box": {
                "connector": "hermes",
                "transport": {"ssh_host": "x@y"},
                "sync_enabled": False,
                "bundles": [],
                "enabled": ["demo"],
            }
        },
        "cloud": {"claude-ai": {"bundles": [], "enabled": ["demo"]}},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def _run(data_home: Path, home: Path, args: list[str]):
    env = os.environ.copy()
    env["SKILL_HUB_HOME"] = str(data_home)
    env["HOME"] = str(home)
    env.pop("SKILL_HUB_DIR", None)
    env.pop("SKILL_HUB_CODE", None)
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "hub.py"), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _load(data_home: Path) -> dict:
    return yaml.safe_load((data_home / "registry.yaml").read_text())


@pytest.fixture
def world(tmp_data_home, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    project = tmp_path / "proj"
    project.mkdir()
    _seed(tmp_data_home, project)
    return tmp_data_home, home, project


def test_archive_dry_run_lists_every_reference_site(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo", "--dry-run"])
    assert proc.returncode == 0, proc.stderr
    assert "would unenable from: proj" in proc.stdout
    assert "would remove from bundles: globalpack, pack" in proc.stdout
    assert "would remove from invocation overrides: proj" in proc.stdout
    assert "would remove from remotes: box" in proc.stdout
    assert "would unequip from cloud targets: claude-ai" in proc.stdout
    assert "demo" in _load(data_home)["skills"], "dry-run must not mutate"


def test_archive_prunes_bundles_remotes_and_overrides(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["archive", "demo"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg = _load(data_home)
    assert "demo" not in reg["skills"]
    assert reg["bundles"]["globalpack"]["skills"] == ["other"]
    assert reg["bundles"]["pack"]["skills"] == ["other"]
    assert reg["projects"]["proj"]["enabled"] == []
    assert reg["projects"]["proj"]["invocation_overrides"] == {"other": "user-only"}
    assert reg["remotes"]["box"]["enabled"] == []
    assert reg["cloud"]["claude-ai"]["enabled"] == []
    # the untouched sibling survives everywhere
    assert "other" in reg["skills"]


def test_sync_is_clean_after_archiving_a_global_bundle_member(world):
    """The user-visible symptom: every project red with `unknown skill`."""
    data_home, home, _ = world
    assert _run(data_home, home, ["archive", "demo"]).returncode == 0
    proc = _run(data_home, home, ["sync"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "unknown skill" not in proc.stdout + proc.stderr


def test_rename_follows_the_skill_into_bundles_remotes_and_cloud(world):
    data_home, home, _ = world
    proc = _run(data_home, home, ["rename", "demo", "demo2", "--dry-run"])
    assert proc.returncode == 0, proc.stderr
    assert "would update bundles: globalpack, pack" in proc.stdout
    assert "would update remotes: box" in proc.stdout
    assert "would update cloud targets: claude-ai" in proc.stdout
    assert "would drop invocation overrides in: proj" in proc.stdout

    proc = _run(data_home, home, ["rename", "demo", "demo2"])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    reg = _load(data_home)
    assert "demo2" in reg["skills"] and "demo" not in reg["skills"]
    assert reg["bundles"]["globalpack"]["skills"] == ["demo2", "other"]
    assert reg["bundles"]["pack"]["skills"] == ["other", "demo2"]
    assert reg["projects"]["proj"]["enabled"] == ["demo2"]
    assert reg["projects"]["proj"]["invocation_overrides"] == {"other": "user-only"}
    assert reg["remotes"]["box"]["enabled"] == ["demo2"]
    assert reg["cloud"]["claude-ai"]["enabled"] == ["demo2"]
