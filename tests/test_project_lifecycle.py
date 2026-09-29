"""Tests for clean_project_artifacts + project remove/edit-path (task 8.6)."""

from __future__ import annotations

import argparse
import json
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
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.domain.permissions.permissions import ProjectScope, write_sidecar

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
    write_sidecar(
        "claude-code",
        ProjectScope("alpha", str(proj)),
        ["code-reviewer"],
        mcp_file,
        kind="mcp",
    )
    registry["harnesses_global"] = ["claude-code"]
    context = build_operation_context(
        tmp_data_home,
        ("claude-code",),
        requested_features=("mcp",),
        installed_harness_ids=("claude-code",),
    )

    plan = hub.clean_project_artifacts(
        proj,
        registry,
        dry_run=False,
        project_name="alpha",
        operation_context=context,
    )
    assert any(e["name"] == "code-reviewer" for e in plan["removed_mcp_entries"])
    # The user-managed "other" entry must survive (not in registry)
    after = json.loads(mcp_file.read_text())
    assert "code-reviewer" not in after["mcpServers"]
    assert "other" in after["mcpServers"]


def test_clean_deletes_mcp_file_when_empty_after_removal(tmp_data_home):
    import hub
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.domain.permissions.permissions import ProjectScope, write_sidecar

    proj, registry = _setup_project(tmp_data_home)
    mcp_file = proj / ".mcp.json"
    mcp_file.write_text(json.dumps({"mcpServers": {"code-reviewer": {"command": "x", "args": [], "env": {}}}}))
    write_sidecar(
        "claude-code",
        ProjectScope("alpha", str(proj)),
        ["code-reviewer"],
        mcp_file,
        kind="mcp",
    )
    registry["harnesses_global"] = ["claude-code"]
    context = build_operation_context(
        tmp_data_home,
        ("claude-code",),
        requested_features=("mcp",),
        installed_harness_ids=("claude-code",),
    )
    hub.clean_project_artifacts(
        proj,
        registry,
        dry_run=False,
        project_name="alpha",
        operation_context=context,
    )
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


def test_project_remove_dry_run_previews_personal_worktree_without_mutation(tmp_data_home, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    proj, registry = _setup_project(tmp_data_home)
    registry["harnesses_global"] = ["claude-code"]
    (proj / ".claude").mkdir(parents=True, exist_ok=True)
    scope = ProjectScope("alpha", str(proj), personal=True)
    adapter = pa.ClaudePermissionAdapter()
    path = str(tmp_data_home / "worktrees" / "alpha")
    adapter.apply_directories(
        scope,
        adapter.plan_directories(scope, (pa.DirectoryContribution("worktree", (path,)),), "claude-code"),
        "claude-code",
    )
    native = proj / ".claude" / "settings.local.json"
    before = native.read_bytes()
    sidecar = next((tmp_data_home / "state" / "claude-code").glob("directory-v1-*.managed.json"))
    sidecar_before = sidecar.read_bytes()
    plan = hub.clean_project_artifacts(proj, registry, dry_run=True, project_name="alpha")
    assert plan["removed_worktree_access"]
    assert native.read_bytes() == before
    assert sidecar.read_bytes() == sidecar_before
    applied = pa.ClaudePermissionAdapter().cleanup_directories(scope, "claude-code")
    assert applied.config_state == plan["removed_worktree_access"][0]["config_state"]
    capsys.readouterr()


def test_cmd_project_remove_cleans_worktree_grant(tmp_data_home, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    proj, registry = _setup_project(tmp_data_home)
    registry["harnesses_global"] = ["claude-code"]
    (proj / ".claude").mkdir(parents=True, exist_ok=True)
    target = proj / ".claude" / "settings.json"
    target.write_text(json.dumps({"permissions": {}}))
    scope = ProjectScope("alpha", str(proj))
    pa.ClaudePermissionAdapter().apply_directories(
        scope,
        pa.ClaudePermissionAdapter().plan_directories(
            scope, (pa.DirectoryContribution("worktree", (str(proj / "wt"),)),), "claude-code"
        ),
        "claude-code",
    )
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    hub.cmd_project_remove(argparse.Namespace(name="alpha", dry_run=False, json=False))
    capsys.readouterr()
    assert "additionalDirectories" not in json.loads(target.read_text())["permissions"]


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


def test_cmd_project_edit_path_saves_path_even_when_trailing_sync_fails(
    tmp_data_home, monkeypatch, capsys
):
    """A5/F3 regression: a trailing sync-stream failure (missing skill sources
    after a restore) must never make a successful path save look like a failed
    command. `hub._auto_sync()` bare `sys.exit(1)`s on stream write errors, and
    the old code called it unguarded — the `SystemExit` propagated out of
    `cmd_project_edit_path`, so a caller that only checks the exit code (the
    Tauri bridge, `app/AGENTS.md`: "returns Err on any non-zero exit") saw a
    failure for a mutation that had already landed. The command must exit 0,
    keep the saved path, and say the sync did not finish cleanly instead."""
    import hub

    proj, _ = _setup_project(tmp_data_home, "alpha")

    def _fail_sync(_args):
        raise SystemExit(1)

    monkeypatch.setattr(hub, "cmd_sync", _fail_sync)

    new_path = tmp_data_home / "new-location"
    new_path.mkdir()
    args = argparse.Namespace(name="alpha", new_path=str(new_path))

    # Must not raise — the mutation succeeded even though sync did not.
    hub.cmd_project_edit_path(args)

    out, err = capsys.readouterr()
    reg2 = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert reg2["projects"]["alpha"]["path"] == str(new_path.resolve())
    assert "path saved, but the trailing sync did not finish cleanly" in out
    assert "rc 1" in err


# ─────────────────────────────────────────────────────────────────────────────
# Hook artifact cleanup on project remove / edit-path (hooks-surface task 2.7)
# ─────────────────────────────────────────────────────────────────────────────


def _seed_project_hook_artifact(proj: Path, project_name: str = "alpha") -> Path:
    """Write a project-scope native hook entry + its hooks-kind sidecar."""
    from skill_hub.domain.permissions.permissions import ProjectScope, write_sidecar

    settings_local = proj / ".claude" / "settings.local.json"
    settings_local.parent.mkdir(parents=True, exist_ok=True)
    settings_local.write_text(
        json.dumps(
            {"hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "/x"}]}]}}, indent=2
        )
        + "\n"
    )
    write_sidecar(
        "claude-code",
        ProjectScope(name=project_name, path=str(proj)),
        ["hooks.PostToolUse[0]"],
        settings_local,
        "hooks",
    )
    return settings_local


def test_project_remove_cleans_hook_native_and_sidecar(tmp_data_home, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj, _ = _setup_project(tmp_data_home)
    settings_local = _seed_project_hook_artifact(proj)

    hub.cmd_project_remove(argparse.Namespace(name="alpha", dry_run=False, json=False))
    capsys.readouterr()

    # Native hook entry stripped + hooks-kind sidecar deleted.
    data = json.loads(settings_local.read_text())
    assert "hooks" not in data
    assert read_sidecar("claude-code", ProjectScope(name="alpha", path=str(proj)), "hooks") is None
    # Registry attach lists dropped with the project block.
    reg = yaml.safe_load((tmp_data_home / "registry.yaml").read_text())
    assert "alpha" not in reg["projects"]


def test_project_remove_dry_run_reports_hook_sidecar(tmp_data_home, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj, _ = _setup_project(tmp_data_home)
    _seed_project_hook_artifact(proj)

    hub.cmd_project_remove(argparse.Namespace(name="alpha", dry_run=True, json=True))
    plan = json.loads(capsys.readouterr().out)
    assert plan["removed_hook_sidecars"]
    assert plan["removed_hook_sidecars"][0]["harness"] == "claude-code"
    # Dry-run mutates nothing.
    assert read_sidecar("claude-code", ProjectScope(name="alpha", path=str(proj)), "hooks") is not None


def test_project_edit_path_cleans_old_hook_artifacts(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope, read_sidecar

    proj, _ = _setup_project(tmp_data_home)
    settings_local = _seed_project_hook_artifact(proj)
    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: None)

    new_path = tmp_data_home / "new-alpha"
    new_path.mkdir()
    hub.cmd_project_edit_path(argparse.Namespace(name="alpha", new_path=str(new_path)))
    capsys.readouterr()

    # Old-path native hooks stripped + sidecar cleared (next sync re-writes at new path).
    data = json.loads(settings_local.read_text())
    assert "hooks" not in data
    assert read_sidecar("claude-code", ProjectScope(name="alpha", path=str(proj)), "hooks") is None


def test_project_edit_path_removes_personal_directory_ledger_when_old_path_is_gone(tmp_data_home, monkeypatch, capsys):
    import hub
    from skill_hub.domain.permissions.permissions import DirectoryLedgerIdentity, ProjectScope, directory_sidecar_path
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    proj, registry = _setup_project(tmp_data_home)
    registry["harnesses_global"] = ["claude-code"]
    scope = ProjectScope("alpha", str(proj), personal=True)
    adapter = pa.ClaudePermissionAdapter()
    adapter.apply_directories(
        scope,
        adapter.plan_directories(
            scope,
            (pa.DirectoryContribution("worktree", (str(tmp_data_home / "old-wt"),)),),
            "claude-code",
        ),
        "claude-code",
    )
    (tmp_data_home / "registry.yaml").write_text(yaml.safe_dump(registry, sort_keys=False))
    import shutil

    shutil.rmtree(proj)
    new_path = tmp_data_home / "new-alpha"
    new_path.mkdir()
    monkeypatch.setattr(hub, "_auto_sync", lambda **_kwargs: None)
    hub.cmd_project_edit_path(argparse.Namespace(name="alpha", new_path=str(new_path)))
    capsys.readouterr()
    assert not directory_sidecar_path("claude-code", DirectoryLedgerIdentity.from_scope(scope, "claude-code")).exists()


def test_project_cleanup_dry_run_uses_real_failed_directory_plan(tmp_data_home):
    import hub
    from skill_hub.domain.permissions.permission_adapter_base import plan_directory_cleanup
    from skill_hub.domain.permissions.permissions import (
        DirectoryLedgerIdentity,
        ProjectScope,
        directory_sidecar_path,
        write_directory_sidecar,
    )
    from skill_hub.infrastructure.permissions import permission_adapters as pa

    project = tmp_data_home / "malformed-project"
    project.mkdir()
    target = project / ".claude" / "settings.local.json"
    target.parent.mkdir()
    target.write_text('{"permissions": {"additionalDirectories": "bad"}}\n')
    scope = ProjectScope("malformed", str(project), personal=True)
    identity = DirectoryLedgerIdentity.from_scope(scope, "claude-code")
    write_directory_sidecar(
        identity,
        target,
        {
            "native_key": "permissions.additionalDirectories",
            "entries": {"/owned": {"owned_count": 1}},
            "contributions": {},
        },
    )
    registry = {"harnesses_global": ["claude-code"], "projects": {"malformed": {"harnesses": []}}}
    native_before = target.read_bytes()
    ledger_before = directory_sidecar_path("claude-code", identity).read_bytes()
    dry = hub.clean_project_artifacts(project, registry, dry_run=True, project_name="malformed")
    plan = plan_directory_cleanup(pa.ClaudePermissionAdapter(), scope, "claude-code")
    assert dry["worktree_access_failures"]
    assert dry["worktree_access_failures"][0]["config_state"] == plan.status.config_state == "failed"
    assert target.read_bytes() == native_before
    assert directory_sidecar_path("claude-code", identity).read_bytes() == ledger_before
