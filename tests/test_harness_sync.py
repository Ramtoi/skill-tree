"""Tests for sync refactor with effective harnesses (tasks 3.7, 3.8, 3.9)."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest
import yaml


def _seed_skill(data_home: Path, name: str) -> Path:
    src = data_home / "skills" / name
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text(f"---\nname: {name}\ndescription: t\n---\n")
    return src


@pytest.fixture
def sync_env(tmp_data_home, monkeypatch):
    """Project + skill set + all-detected harnesses; capture symlink writes."""
    import harnesses
    import hub

    skill_src = _seed_skill(tmp_data_home, "brainstorm")
    proj_path = tmp_data_home / "projects" / "alpha"
    proj_path.mkdir(parents=True)

    registry = {
        "version": "1",
        "harnesses_global": [],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "",
                "source": str(skill_src),
                "type": "claude-skill",
                "scope": "portable",
                "upstream": None,
            }
        },
        "projects": {
            "alpha": {
                "path": str(proj_path),
                "enabled": ["brainstorm"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))

    # Force all harnesses to look "installed" so sync writes them; override
    # global dirs to point inside the tmp data home so we don't touch the real
    # ~/.claude or ~/.agents.
    import dataclasses

    fake_global = tmp_data_home / "fake-globals"
    fake_global.mkdir()
    patched = {}
    for h_id, h in harnesses.HARNESSES.items():
        patched[h_id] = dataclasses.replace(
            h,
            detect=(lambda: True),
            global_skills_dir=h.global_skills_dir.__class__(
                str(fake_global / h_id / "skills")
            ),
        )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)
    return tmp_data_home, proj_path


def _set_proj_harnesses(data_home: Path, harnesses_list: list[str], global_list: list[str] = None):
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    if global_list is not None:
        reg["harnesses_global"] = global_list
    reg["projects"]["alpha"]["harnesses"] = harnesses_list
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))


def test_sync_claude_only_writes_claude_skills_dir(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, [], ["claude-code"])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj_path / ".claude" / "skills" / "brainstorm").is_symlink()
    assert not (proj_path / ".agents" / "skills" / "brainstorm").exists()


def test_sync_codex_writes_agents_skills_dir(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["codex"], [])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj_path / ".agents" / "skills" / "brainstorm").is_symlink()
    assert not (proj_path / ".claude" / "skills" / "brainstorm").exists()


def test_sync_codex_plus_pi_produces_single_agents_link(sync_env, capsys):
    """Target dedup: codex and pi share `.agents/skills/`."""
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["codex", "pi"], [])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    link = proj_path / ".agents" / "skills" / "brainstorm"
    assert link.is_symlink()
    # And there's exactly one link in the dir (no duplicated bookkeeping)
    entries = list((proj_path / ".agents" / "skills").iterdir())
    assert len(entries) == 1


def test_sync_codex_pi_opencode_produce_single_agents_link(sync_env, capsys):
    """Target dedup extends to opencode: codex, pi, and opencode all share
    `.agents/skills/`, so three effective harnesses still yield one symlink."""
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["codex", "pi", "opencode"], [])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj_path / ".agents" / "skills" / "brainstorm").is_symlink()
    entries = list((proj_path / ".agents" / "skills").iterdir())
    assert len(entries) == 1


def test_sync_opencode_alone_writes_agents_skills_dir(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["opencode"], [])

    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()

    assert (proj_path / ".agents" / "skills" / "brainstorm").is_symlink()
    assert not (proj_path / ".claude" / "skills" / "brainstorm").exists()


def test_sync_disabling_last_consumer_cleans_shared_dir(sync_env, capsys):
    """If a project had codex+pi → .agents/skills/foo, removing both deletes it."""
    import hub

    data_home, proj_path = sync_env
    # First, sync with pi enabled
    _set_proj_harnesses(data_home, ["pi"], [])
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert (proj_path / ".agents" / "skills" / "brainstorm").is_symlink()

    # Now disable pi (and codex stays off) → re-sync should clean
    _set_proj_harnesses(data_home, [], [])
    hub.cmd_sync(argparse.Namespace())
    capsys.readouterr()
    assert not (proj_path / ".agents" / "skills" / "brainstorm").exists()


def test_sync_skill_affinity_filters_target(sync_env, capsys):
    """A skill with harnesses:[claude-code] placed on a pi-only project: zero symlinks."""
    import hub

    data_home, proj_path = sync_env
    # Annotate the skill with claude-code-only affinity
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    reg["skills"]["brainstorm"]["harnesses"] = ["claude-code"]
    (data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    _set_proj_harnesses(data_home, ["pi"], [])
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    assert not (proj_path / ".agents" / "skills" / "brainstorm").exists()
    assert not (proj_path / ".claude" / "skills" / "brainstorm").exists()
    # And the affinity-filtered log line is emitted
    assert "brainstorm not synced" in out
    assert "skill targets [claude-code]" in out


def test_sync_unknown_harness_id_logs_warning_does_not_crash(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["aider"], ["claude-code"])

    hub.cmd_sync(argparse.Namespace())
    captured = capsys.readouterr()
    combined = captured.out + captured.err

    assert "unknown harness id 'aider'" in combined
    # claude-code still synced
    assert (proj_path / ".claude" / "skills" / "brainstorm").is_symlink()
    # Registry was not auto-cleaned
    reg = yaml.safe_load((data_home / "registry.yaml").read_text())
    assert "aider" in reg["projects"]["alpha"]["harnesses"]


def test_sync_logs_effective_harnesses_per_project(sync_env, capsys):
    import hub

    data_home, proj_path = sync_env
    _set_proj_harnesses(data_home, ["pi"], ["claude-code"])

    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    assert "effective harnesses:" in out
    assert "Claude Code" in out and "Pi" in out


def test_sync_logs_uninstalled_but_listed(sync_env, capsys, monkeypatch):
    """If pi is listed but not installed, sync logs and skips."""
    import dataclasses

    import harnesses
    import hub

    data_home, proj_path = sync_env
    # Override pi to look uninstalled
    patched = dict(harnesses.HARNESSES)
    patched["pi"] = dataclasses.replace(patched["pi"], detect=(lambda: False))
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    _set_proj_harnesses(data_home, ["pi"], [])
    hub.cmd_sync(argparse.Namespace())
    out = capsys.readouterr().out

    assert "Pi listed but not installed" in out
    assert not (proj_path / ".agents" / "skills" / "brainstorm").exists()
