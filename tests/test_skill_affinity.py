"""Tests for skill `harnesses:` affinity (tasks 5.5, 5.6)."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest
import yaml


def _seed_registry(data_home: Path, skill_src: Path, frontmatter_harnesses=None):
    src_dir = skill_src
    src_dir.mkdir(parents=True, exist_ok=True)
    fm_lines = ["---", "name: brainstorm", "description: t"]
    if frontmatter_harnesses is not None:
        fm_lines.append(f"harnesses: {frontmatter_harnesses}")
    fm_lines.append("---")
    (src_dir / "SKILL.md").write_text("\n".join(fm_lines) + "\n")

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "",
                "source": str(src_dir),
                "type": "claude-skill",
                "scope": "global",
                "upstream": None,
            }
        },
        "projects": {},
        "bundles": {},
    }
    (data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))


def test_affinity_round_trips_via_set_meta(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, tmp_data_home / "skills" / "brainstorm")
    args = argparse.Namespace(
        name="brainstorm",
        version=None,
        description=None,
        scope=None,
        upstream=None,
        harnesses="claude-code,codex",
    )
    hub.cmd_set_meta(args)
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["skills"]["brainstorm"]["harnesses"] == ["claude-code", "codex"]


def test_set_meta_empty_string_clears_affinity(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, tmp_data_home / "skills" / "brainstorm")
    # First set
    hub.cmd_set_meta(
        argparse.Namespace(
            name="brainstorm",
            version=None,
            description=None,
            scope=None,
            upstream=None,
            harnesses="pi",
        )
    )
    capsys.readouterr()
    # Then clear
    hub.cmd_set_meta(
        argparse.Namespace(
            name="brainstorm",
            version=None,
            description=None,
            scope=None,
            upstream=None,
            harnesses="",
        )
    )
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "harnesses" not in reg["skills"]["brainstorm"]


def test_unknown_harness_id_via_cli_warns_but_accepts(tmp_data_home, capsys):
    import hub

    _seed_registry(tmp_data_home, tmp_data_home / "skills" / "brainstorm")
    hub.cmd_set_meta(
        argparse.Namespace(
            name="brainstorm",
            version=None,
            description=None,
            scope=None,
            upstream=None,
            harnesses="claude-code,aider",
        )
    )
    captured = capsys.readouterr()
    assert "unknown harness id 'aider'" in captured.err

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "aider" in reg["skills"]["brainstorm"]["harnesses"]


def test_frontmatter_harnesses_round_trips_through_sync(tmp_data_home, capsys, monkeypatch):
    """SKILL.md frontmatter `harnesses:` lands on the registry entry after sync."""
    import dataclasses

    import harnesses
    import hub

    _seed_registry(
        tmp_data_home,
        tmp_data_home / "skills" / "brainstorm",
        frontmatter_harnesses=["claude-code"],
    )
    # All harnesses installed so sync proceeds
    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg["skills"]["brainstorm"]["harnesses"] == ["claude-code"]


def test_unknown_harness_id_in_frontmatter_warns_but_skill_remains_usable(
    tmp_data_home, capsys, monkeypatch
):
    """SKILL.md with harnesses:[aider] (unknown) — skill is still synced, warning emitted."""
    import dataclasses

    import harnesses
    import hub

    _seed_registry(
        tmp_data_home,
        tmp_data_home / "skills" / "brainstorm",
        frontmatter_harnesses=["aider"],
    )
    patched = {
        h_id: dataclasses.replace(h, detect=(lambda: True))
        for h_id, h in harnesses.HARNESSES.items()
    }
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    hub.cmd_sync(argparse.Namespace())
    captured = capsys.readouterr()

    assert "unknown harness id 'aider'" in captured.err
    # Skill still in registry
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "brainstorm" in reg["skills"]
    # Affinity is the unknown id — at sync time it produces zero symlinks
    # (intersection with effective is empty), but the skill isn't removed.
    assert reg["skills"]["brainstorm"]["harnesses"] == ["aider"]
