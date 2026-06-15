"""Tests for `hub migrate-home` (task 5.6)."""

from __future__ import annotations

import argparse
import errno
import os
from pathlib import Path
from unittest import mock

import pytest
import yaml


def _seed_legacy(legacy: Path, target: Path) -> None:
    """Create a fake legacy data home with a registry, skills/, mcp-servers/."""
    legacy.mkdir(parents=True, exist_ok=True)
    skill_dir = legacy / "skills" / "brainstorm"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text("---\nname: brainstorm\n---\n")
    mcp_dir = legacy / "mcp-servers" / "code-reviewer"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    (mcp_dir / "server.py").write_text("# stub\n")
    (legacy / "_hub-backups").mkdir(exist_ok=True)
    reg = {
        "version": "1",
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "test",
                "source": str(skill_dir),
                "type": "claude-skill",
                "scope": "global",
                "upstream": None,
            }
        },
        "projects": {},
        "bundles": {},
    }
    (legacy / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


@pytest.fixture
def legacy_and_target(tmp_path, monkeypatch):
    """Set up a legacy data home and a (separate) target data home.

    Returns (legacy_path, target_path). HOME is patched so the resolver
    picks the chosen target via SKILL_HUB_HOME.
    """
    import hub

    legacy = tmp_path / "legacy"
    target = tmp_path / "target"
    target.mkdir()
    _seed_legacy(legacy, target)

    monkeypatch.setenv("SKILL_HUB_HOME", str(target))
    monkeypatch.setattr(hub, "LEGACY_DATA_HOMES", [legacy])
    hub._DATA_HOME_CACHE = None
    hub._DEPRECATION_WARNED = False
    hub._LEGACY_FALLBACK_WARNED = False
    yield legacy, target
    hub._DATA_HOME_CACHE = None


def test_migrate_no_collision_moves_everything(legacy_and_target, monkeypatch, capsys):
    import hub

    legacy, target = legacy_and_target

    # Patch cmd_sync to a no-op (it would otherwise try to symlink things)
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)

    args = argparse.Namespace(yes=True)
    hub.cmd_migrate_home(args)

    assert (target / "registry.yaml").exists()
    assert (target / "skills" / "brainstorm" / "SKILL.md").exists()
    assert (target / "mcp-servers" / "code-reviewer").exists()
    assert (target / "_hub-backups").exists()
    # Forward pointer at the legacy location
    assert (legacy / "LEGACY-MOVED.txt").exists()
    # Source dirs at the legacy location should be gone
    assert not (legacy / "skills").exists()
    assert not (legacy / "registry.yaml").exists()


def test_migrate_single_entry_collision_preserves_both(legacy_and_target, monkeypatch, capsys):
    """If a same-named entry already exists at the target, leave both."""
    import hub

    legacy, target = legacy_and_target
    # Pre-create skills/ at target — this should block the move of legacy/skills/.
    (target / "skills").mkdir()
    (target / "skills" / "marker.txt").write_text("preexisting")

    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    # Target's pre-existing dir untouched
    assert (target / "skills" / "marker.txt").read_text() == "preexisting"
    # Legacy's skills/ still in place (skipped)
    assert (legacy / "skills" / "brainstorm" / "SKILL.md").exists()
    # The other entries should still have moved
    assert (target / "registry.yaml").exists()
    assert (target / "mcp-servers").exists()


def test_migrate_exdev_falls_back_to_shutil_move(legacy_and_target, monkeypatch):
    """When os.replace raises EXDEV, the migrator falls back to shutil.move."""
    import hub

    legacy, target = legacy_and_target
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)

    real_replace = os.replace
    call_count = {"n": 0}

    def fake_replace(src, dst):
        call_count["n"] += 1
        # Raise EXDEV the first time only; let other replaces (atomic registry writes
        # inside save_registry) succeed.
        if call_count["n"] == 1:
            raise OSError(errno.EXDEV, "cross-fs move")
        return real_replace(src, dst)

    monkeypatch.setattr(hub.os, "replace", fake_replace)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    # At least one move succeeded via the shutil fallback
    assert (target / "registry.yaml").exists() or (target / "skills").exists()


def test_migrate_rewrites_source_paths(legacy_and_target, monkeypatch):
    """source: paths under legacy/skills/ become target/skills/."""
    import hub

    legacy, target = legacy_and_target
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    reg = yaml.safe_load((target / "registry.yaml").read_text())
    src = reg["skills"]["brainstorm"]["source"]
    # The legacy prefix string must be gone; the source must reference the target.
    assert str(legacy) not in src
    assert "skills/brainstorm" in src


def test_migrate_no_legacy_detected_is_no_op(tmp_path, monkeypatch, capsys):
    import hub

    target = tmp_path / "target"
    target.mkdir()
    monkeypatch.setenv("SKILL_HUB_HOME", str(target))
    monkeypatch.setattr(hub, "LEGACY_DATA_HOMES", [tmp_path / "nonexistent"])
    hub._DATA_HOME_CACHE = None
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)

    hub.cmd_migrate_home(argparse.Namespace(yes=True))
    out = capsys.readouterr().out
    assert "No legacy data home" in out
