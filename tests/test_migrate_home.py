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


# ─────────────────────────────────────────────────────────────────────────────
# Canonical-manifest migration (backup-and-restore design v2 §1)
#
# Before this change `_migrate_one_legacy` hardcoded 4 entries and silently
# stranded snippets/, state/, sources/, usage/, and any unknown entry at the old
# home. The entry list now comes from the one manifest table in `backup.py`.
# ─────────────────────────────────────────────────────────────────────────────


def _seed_extra_entries(legacy: Path) -> None:
    """Add every entry the pre-fix migrator forgot, plus an unknown one."""
    (legacy / "snippets" / "review").mkdir(parents=True, exist_ok=True)
    (legacy / "snippets" / "review" / "body.md").write_text("reusable block\n")
    (legacy / "connectors").mkdir(exist_ok=True)
    (legacy / "connectors" / "custom.py").write_text("# drop-in connector\n")
    (legacy / "state" / "signing").mkdir(parents=True, exist_ok=True)
    (legacy / "state" / "signing" / "hub_ed25519").write_text("PRIVATE\n")
    (legacy / "state" / "subagents").mkdir(parents=True, exist_ok=True)
    (legacy / "state" / "subagents" / "links.json").write_text("{}\n")
    (legacy / "usage").mkdir(exist_ok=True)
    (legacy / "usage" / "counts.json").write_text("{}\n")
    (legacy / "sources" / "acme" / "skills" / "cloned").mkdir(parents=True, exist_ok=True)
    (legacy / "sources" / "acme" / "skills" / "cloned" / "SKILL.md").write_text(
        "---\nname: cloned\n---\n"
    )
    (legacy / "brand-new-thing").mkdir(exist_ok=True)
    (legacy / "brand-new-thing" / "data.txt").write_text("unknown but mine\n")


def test_migrate_moves_the_whole_canonical_manifest(legacy_and_target, monkeypatch):
    import hub

    legacy, target = legacy_and_target
    _seed_extra_entries(legacy)
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    for rel in (
        "snippets/review/body.md",
        "connectors/custom.py",
        "state/signing/hub_ed25519",
        "state/subagents/links.json",
        "usage/counts.json",
        "sources/acme/skills/cloned/SKILL.md",
        "_hub-backups",
    ):
        assert (target / rel).exists(), f"{rel} was stranded at the legacy home"
    assert not (legacy / "snippets").exists()
    assert not (legacy / "sources").exists()


def test_migrate_moves_unknown_top_level_entries(legacy_and_target, monkeypatch):
    """A local move must never abandon data the manifest has not heard of."""
    import hub

    legacy, target = legacy_and_target
    _seed_extra_entries(legacy)
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))
    assert (target / "brand-new-thing" / "data.txt").read_text() == "unknown but mine\n"


def test_migrate_merges_state_per_child_instead_of_abandoning_it(
    legacy_and_target, monkeypatch
):
    """A non-empty target `state/` must not strand the legacy signing keys."""
    import hub

    legacy, target = legacy_and_target
    _seed_extra_entries(legacy)
    # The target already has its own state/ (sync writes one on first use).
    (target / "state").mkdir(parents=True, exist_ok=True)
    (target / "state" / "sync-report.json").write_text("{}\n")

    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    assert (target / "state" / "sync-report.json").exists(), "target's own state kept"
    assert (target / "state" / "signing" / "hub_ed25519").exists(), "signing key rescued"
    assert (target / "state" / "subagents" / "links.json").exists()
    assert not (legacy / "state" / "signing").exists()


def test_migrate_state_child_collision_leaves_both(legacy_and_target, monkeypatch):
    import hub

    legacy, target = legacy_and_target
    _seed_extra_entries(legacy)
    (target / "state" / "subagents").mkdir(parents=True, exist_ok=True)
    (target / "state" / "subagents" / "links.json").write_text('{"target": true}\n')

    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    # The target's file wins; the legacy one is left in place, never clobbered.
    assert '"target"' in (target / "state" / "subagents" / "links.json").read_text()
    assert (legacy / "state" / "subagents" / "links.json").exists()


def test_migrate_rewrites_sources_and_cache_paths(legacy_and_target, monkeypatch):
    """Moving sources/ without rewriting its paths would break every git skill.

    The pre-fix migrator did not move sources/ at all, which accidentally hid
    this: now that it moves, the registry rewrite has to cover `sources.*.cache`
    and any skill sourced from inside it.
    """
    import hub

    legacy, target = legacy_and_target
    _seed_extra_entries(legacy)
    reg = yaml.safe_load((legacy / "registry.yaml").read_text())
    reg["sources"] = {"acme": {"cache": str(legacy / "sources" / "acme")}}
    reg["skills"]["cloned"] = {
        "version": "1.0.0",
        "description": "from a git source",
        "source": str(legacy / "sources" / "acme" / "skills" / "cloned"),
        "type": "claude-skill",
        "scope": "portable",
    }
    (legacy / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    moved = yaml.safe_load((target / "registry.yaml").read_text())
    assert str(legacy) not in moved["sources"]["acme"]["cache"]
    assert moved["sources"]["acme"]["cache"] == str(target / "sources" / "acme")
    assert moved["skills"]["cloned"]["source"] == str(
        target / "sources" / "acme" / "skills" / "cloned"
    )


def test_migrate_does_not_rewrite_paths_for_entries_that_did_not_move(
    legacy_and_target, monkeypatch, capsys
):
    """A skipped entry must keep its OLD registry paths (audit fix F7).

    The rewrite is a blanket prefix sweep, so a collision that leaves `skills/`
    at the legacy home used to still repoint every `source:` at the target —
    turning a visible, recoverable partial move into a registry full of paths
    that resolve to nothing.
    """
    import hub

    legacy, target = legacy_and_target
    # Block skills/ — mcp-servers/ and registry.yaml still migrate.
    (target / "skills").mkdir()
    (target / "skills" / "marker.txt").write_text("preexisting")

    reg = yaml.safe_load((legacy / "registry.yaml").read_text())
    reg["skills"]["server"] = {
        "version": "1.0.0",
        "description": "an mcp server that DOES move",
        "source": str(legacy / "mcp-servers" / "code-reviewer"),
        "type": "mcp-server",
        "scope": "global",
    }
    (legacy / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)
    hub.cmd_migrate_home(argparse.Namespace(yes=True))

    moved = yaml.safe_load((target / "registry.yaml").read_text())
    stayed = moved["skills"]["brainstorm"]["source"]
    assert stayed == str(legacy / "skills" / "brainstorm"), (
        "skills/ never moved, so its registry path must still point at the files"
    )
    assert Path(stayed).exists(), "the rewritten path must resolve to real content"
    # …while everything that DID move is rewritten as before.
    assert moved["skills"]["server"]["source"] == str(target / "mcp-servers" / "code-reviewer")

    out = capsys.readouterr().out
    assert "still point at" in out and "skills" in out, "the gap must be said out loud"


def test_migrate_entry_list_comes_from_the_shared_manifest():
    """Guard against migrate/backup/restore drifting apart again."""
    import backup

    assert set(backup.MIGRATE_HOME_ENTRIES) >= {
        "registry.yaml", "skills", "mcp-servers", "snippets",
        "connectors", "state", "sources", "_hub-backups", "usage",
    }
    assert ".lock" not in backup.MIGRATE_HOME_ENTRIES
