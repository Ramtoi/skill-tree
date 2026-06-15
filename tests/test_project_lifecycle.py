"""Tests for clean_project_artifacts + project remove/edit-path (task 8.6)."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pytest
import yaml


def _setup_project(tmp_data_home: Path, project_name: str = "alpha") -> tuple[Path, dict]:
    """Create a project dir, a hub-managed skill, and a registry referencing both."""
    proj = tmp_data_home / "projects" / project_name
    proj.mkdir(parents=True)

    skill_src = tmp_data_home / "skills" / "brainstorm"
    skill_src.mkdir(parents=True, exist_ok=True)
    (skill_src / "SKILL.md").write_text("---\nname: brainstorm\n---\n")

    mcp_src = tmp_data_home / "mcp-servers" / "code-reviewer"
    mcp_src.mkdir(parents=True, exist_ok=True)
    (mcp_src / "server.py").write_text("# stub\n")

    registry = {
        "version": "1",
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "",
                "source": str(skill_src),
                "type": "claude-skill",
                "scope": "global",
                "upstream": None,
            },
            "code-reviewer": {
                "version": "1.0.0",
                "description": "",
                "source": str(mcp_src),
                "type": "mcp-server",
                "scope": "global",
                "upstream": None,
                "mcp": {
                    "runtime": "python",
                    "command": "python3",
                    "args": ["{source}/server.py"],
                    "env": {},
                },
            },
        },
        "projects": {
            project_name: {
                "path": str(proj),
                "enabled": ["brainstorm", "code-reviewer"],
                "bundles": [],
            }
        },
        "bundles": {},
    }
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    return proj, registry


def test_clean_skips_user_owned_symlinks(tmp_data_home):
    """Symlinks not pointing under data_home/skills/ are not hub-owned and must survive."""
    import hub

    proj, registry = _setup_project(tmp_data_home)
    claude_skills = proj / ".claude" / "skills"
    claude_skills.mkdir(parents=True)

    # Hub-owned symlink (points under data_home/skills/)
    hub_link = claude_skills / "brainstorm"
    hub_link.symlink_to(tmp_data_home / "skills" / "brainstorm")

    # User-owned symlink (points elsewhere)
    user_target = tmp_data_home / "external" / "user-skill"
    user_target.mkdir(parents=True)
    user_link = claude_skills / "user-skill"
    user_link.symlink_to(user_target)

    plan = hub.clean_project_artifacts(proj, registry, dry_run=False)
    assert str(hub_link) in plan["removed_symlinks"]
    assert all("user-skill" not in s for s in plan["removed_symlinks"])
    # User link still on disk
    assert user_link.is_symlink()
    assert not hub_link.exists()


def test_clean_removes_dangling_hub_symlink(tmp_data_home):
    """A symlink to a missing target under data_home/skills/ is still hub-owned."""
    import hub

    proj, registry = _setup_project(tmp_data_home)
    claude_skills = proj / ".claude" / "skills"
    claude_skills.mkdir(parents=True)
    dangling = claude_skills / "ghost"
    dangling.symlink_to(tmp_data_home / "skills" / "ghost-target")  # nonexistent
    assert dangling.is_symlink()

    plan = hub.clean_project_artifacts(proj, registry, dry_run=False)
    assert str(dangling) in plan["removed_symlinks"]
    assert not dangling.is_symlink()


def test_clean_removes_mcp_entries(tmp_data_home):
    import hub

    proj, registry = _setup_project(tmp_data_home)
    mcp_file = proj / ".mcp.json"
    mcp_file.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "code-reviewer": {"command": "python3", "args": [], "env": {}},
                    "other": {"command": "node", "args": [], "env": {}},
                }
            }
        )
    )

    plan = hub.clean_project_artifacts(proj, registry, dry_run=False)
    assert any(e["name"] == "code-reviewer" for e in plan["removed_mcp_entries"])
    # The user-managed "other" entry must survive (not in registry)
    after = json.loads(mcp_file.read_text())
    assert "code-reviewer" not in after["mcpServers"]
    assert "other" in after["mcpServers"]


def test_clean_deletes_mcp_file_when_empty_after_removal(tmp_data_home):
    import hub

    proj, registry = _setup_project(tmp_data_home)
    mcp_file = proj / ".mcp.json"
    mcp_file.write_text(
        json.dumps({"mcpServers": {"code-reviewer": {"command": "x", "args": [], "env": {}}}})
    )
    hub.clean_project_artifacts(proj, registry, dry_run=False)
    assert not mcp_file.exists()


def test_clean_prunes_empty_skill_dirs(tmp_data_home):
    import hub

    proj, registry = _setup_project(tmp_data_home)
    claude_skills = proj / ".claude" / "skills"
    claude_skills.mkdir(parents=True)
    hub_link = claude_skills / "brainstorm"
    hub_link.symlink_to(tmp_data_home / "skills" / "brainstorm")

    plan = hub.clean_project_artifacts(proj, registry, dry_run=False)
    assert str(claude_skills) in plan["removed_empty_dirs"]
    assert not claude_skills.exists()
    # The parent (.claude/) must survive — it's user space
    assert (proj / ".claude").exists()


def test_clean_handles_missing_project_path(tmp_data_home):
    """When proj_path has been deleted, return empty plan + warning, do not raise."""
    import hub

    _, registry = _setup_project(tmp_data_home)
    plan = hub.clean_project_artifacts(tmp_data_home / "ghost-project", registry)
    assert plan["removed_symlinks"] == []
    assert plan["warnings"]
    assert "no longer exists" in plan["warnings"][0]


def test_cmd_project_remove_dry_run_emits_json(tmp_data_home, capsys):
    import hub

    proj, _ = _setup_project(tmp_data_home)
    claude_skills = proj / ".claude" / "skills"
    claude_skills.mkdir(parents=True)
    (claude_skills / "brainstorm").symlink_to(tmp_data_home / "skills" / "brainstorm")

    args = argparse.Namespace(name="alpha", dry_run=True, json=True)
    hub.cmd_project_remove(args)
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["project"] == "alpha"
    assert payload["project_path"] == str(proj)
    # Dry-run must not mutate registry
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "alpha" in reg["projects"]


def test_cmd_project_remove_clean_removes_artifacts_and_registry(tmp_data_home, capsys):
    import hub

    proj, _ = _setup_project(tmp_data_home)
    claude_skills = proj / ".claude" / "skills"
    claude_skills.mkdir(parents=True)
    hub_link = claude_skills / "brainstorm"
    hub_link.symlink_to(tmp_data_home / "skills" / "brainstorm")

    args = argparse.Namespace(name="alpha", dry_run=False, json=False)
    hub.cmd_project_remove(args)
    capsys.readouterr()

    assert not hub_link.exists()
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "alpha" not in reg["projects"]


def test_cmd_project_edit_path_rejects_collision(tmp_data_home, capsys):
    import hub

    proj_a, _ = _setup_project(tmp_data_home, "alpha")
    proj_b, _ = _setup_project(tmp_data_home, "beta")
    # Register both in registry (refresh registry from second setup)
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    reg["projects"]["alpha"] = {"path": str(proj_a), "enabled": [], "bundles": []}
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    args = argparse.Namespace(name="alpha", new_path=str(proj_b))
    with pytest.raises(SystemExit):
        hub.cmd_project_edit_path(args)
    err = capsys.readouterr()
    combined = err.out + err.err
    assert "already used by project" in combined


def test_cmd_project_edit_path_tolerates_missing_old_path(tmp_data_home, monkeypatch, capsys):
    """When the old project path is gone, edit-path proceeds (best-effort cleanup)."""
    import hub

    proj, _ = _setup_project(tmp_data_home, "alpha")
    # Move alpha's path on disk to a stale (non-existent) location.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    stale_path = tmp_data_home / "stale-location"
    reg["projects"]["alpha"]["path"] = str(stale_path)
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(reg, sort_keys=False))

    # Stub sync to avoid side effects
    monkeypatch.setattr(hub, "cmd_sync", lambda _a: None)

    new_path = tmp_data_home / "new-location"
    new_path.mkdir()
    args = argparse.Namespace(name="alpha", new_path=str(new_path))
    hub.cmd_project_edit_path(args)
    capsys.readouterr()

    reg2 = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg2["projects"]["alpha"]["path"] == str(new_path.resolve())
