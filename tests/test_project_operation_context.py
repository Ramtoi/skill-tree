"""Project lifecycle must use one captured operation context."""

from __future__ import annotations

import json
from pathlib import Path, PurePath
from types import SimpleNamespace

import pytest


def _context(data_home: Path, *, layouts=None, statuses=None, installed=()):
    layouts = layouts or {}
    statuses = statuses or {}

    def route(harness_id: str, feature: str):
        status = statuses.get((harness_id, feature), "unavailable")
        return SimpleNamespace(
            harness_id=harness_id,
            feature=feature,
            status=status,
            mode="legacy_shadow" if status == "shadow" else "unavailable",
            adapter_key=(
                getattr(layouts.get(harness_id), "mcp_adapter_key", None)
                if status == "shadow"
                else None
            ),
            reason="test",
        )

    return SimpleNamespace(
        context_id="fixed-context",
        data_home=str(data_home),
        layouts=layouts,
        layout=lambda harness_id: layouts.get(harness_id),
        route=route,
        harness_ids=tuple(layouts),
        installed_harness_ids=tuple(installed),
        opencode_paths=None,
    )


def _layout(harness_id: str, skills_dir: str, *, mcp_key=None):
    return SimpleNamespace(
        id=harness_id,
        project_skills_dir=PurePath(skills_dir),
        mcp_adapter_key=mcp_key,
    )


def test_cleanup_uses_captured_data_home_for_link_ownership(tmp_path):
    import hub

    project = tmp_path / "project"
    project.mkdir()
    captured_home = tmp_path / "captured-home"
    captured_target = captured_home / "skills" / "managed"
    captured_target.mkdir(parents=True)
    foreign_target = tmp_path / "foreign-home" / "skills" / "managed"
    foreign_target.mkdir(parents=True)
    skills = project / ".agents" / "skills"
    skills.mkdir(parents=True)
    managed = skills / "managed"
    managed.symlink_to(captured_target, target_is_directory=True)
    foreign = skills / "foreign"
    foreign.symlink_to(foreign_target, target_is_directory=True)

    ctx = _context(
        captured_home,
        layouts={"codex": _layout("codex", ".agents/skills")},
        statuses={("codex", "skills"): "shadow"},
        installed=("codex",),
    )
    plan = hub.clean_project_artifacts(
        project, {"skills": {}, "projects": {}}, operation_context=ctx
    )

    assert str(managed) in plan["removed_symlinks"]
    assert not managed.is_symlink()
    assert foreign.is_symlink()


def test_unavailable_shared_skill_routes_preserve_existing_artifacts(tmp_path):
    import hub

    project = tmp_path / "project"
    skills = project / ".agents" / "skills"
    skills.mkdir(parents=True)
    target = tmp_path / "hub-home" / "skills" / "old"
    target.mkdir(parents=True)
    link = skills / "old"
    link.symlink_to(target, target_is_directory=True)
    ctx = _context(
        tmp_path / "hub-home",
        layouts={
            "claude-code": _layout("claude-code", ".agents/skills"),
            "pi": _layout("pi", ".agents/skills"),
        },
        statuses={("claude-code", "skills"): "shadow"},
        installed=("claude-code", "pi"),
    )

    plan = hub.clean_project_artifacts(
        project, {"skills": {}, "projects": {}}, operation_context=ctx
    )

    assert plan["removed_symlinks"] == []
    assert link.is_symlink()


def test_unavailable_mcp_route_preserves_foreign_project_config(tmp_path):
    import hub

    project = tmp_path / "project"
    project.mkdir()
    config = project / ".mcp.json"
    original = {
        "mcpServers": {
            "registered-but-foreign": {"command": "user-command"},
            "other": {"command": "other-command"},
        }
    }
    config.write_text(json.dumps(original))
    registry = {
        "skills": {
            "registered-but-foreign": {"type": "mcp-server"},
        },
        "projects": {"demo": {"path": str(project), "harnesses": ["claude-code"]}},
    }
    ctx = _context(tmp_path / "hub-home", installed=("claude-code",))

    plan = hub.clean_project_artifacts(
        project, registry, project_name="demo", operation_context=ctx
    )

    assert plan["removed_mcp_entries"] == []
    assert json.loads(config.read_text()) == original


def test_unavailable_opencode_route_does_not_use_ambient_command_root(tmp_path):
    import hub

    project = tmp_path / "project"
    commands = project / ".opencode" / "commands"
    commands.mkdir(parents=True)
    ambient_target = tmp_path / "ambient-payload.md"
    ambient_target.write_text("payload")
    command = commands / "demo.md"
    command.symlink_to(ambient_target)
    context = _context(
        tmp_path / "hub-home",
        layouts={"opencode": _layout("opencode", ".agents/skills")},
        statuses={("opencode", "skills"): "shadow"},
        installed=("opencode",),
    )

    plan = hub.clean_project_artifacts(
        project, {"skills": {}, "projects": {}}, operation_context=context
    )

    assert str(command) not in plan["removed_symlinks"]
    assert command.is_symlink()


def test_import_skill_forwards_same_context_to_discovery_and_tail(
    tmp_data_home, tmp_path, monkeypatch
):
    import hub

    project = tmp_path / "project"
    source = project / ".claude" / "skills" / "demo"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: demo\n---\n")
    hub.save_registry(
        {
            "skills": {},
            "bundles": {},
            "projects": {
                "demo-project": {
                    "path": str(project),
                    "enabled": [],
                    "bundles": [],
                }
            },
        }
    )
    seen = {}

    def scan(_registry, *, operation_context=None):
        seen["scan"] = operation_context
        return [
            {
                "project": "demo-project",
                "name": "demo",
                "path": str(source),
                "category": "NEW",
                "version": "1.0.0",
                "description": "",
            }
        ]

    def tail(*, operation_context=None):
        seen["tail"] = operation_context
        return True

    monkeypatch.setattr(hub, "scan_project_skill_candidates", scan)
    monkeypatch.setattr(hub, "_auto_sync_tail", tail)
    hub.cmd_project_import_skill(
        SimpleNamespace(project="demo-project", name="demo")
    )

    assert seen["scan"] is seen["tail"]
    assert not source.exists()


def test_scan_skills_forwards_supplied_context(tmp_data_home, monkeypatch, capsys):
    import hub

    captured = {}

    def scan(registry, *, operation_context=None):
        captured["context"] = operation_context
        return []

    monkeypatch.setattr(hub, "scan_project_skill_candidates", scan)
    context = _context(tmp_data_home)
    hub.cmd_project_scan_skills(
        SimpleNamespace(project=None, json=True, _operation_context=context)
    )

    assert captured["context"] is context
    assert capsys.readouterr().out.strip() == "[]"


@pytest.mark.parametrize("command", ["invocation", "analytics"])
def test_project_mutation_tail_uses_supplied_context(tmp_data_home, tmp_path, monkeypatch, command):
    import hub
    from skill_hub.entrypoints.cli import project

    context = object()
    registry = {
        "skills": {"demo": {"type": "claude-skill", "scope": "portable"}},
        "projects": {"p": {"path": str(tmp_path), "enabled": ["demo"]}},
    }
    monkeypatch.setattr(project.hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(project.hub_core, "save_registry", lambda reg: None)
    seen = []
    monkeypatch.setattr(hub, "_auto_sync", lambda **kw: seen.append(kw.get("operation_context")))
    if command == "invocation":
        project.cmd_project_invocation(SimpleNamespace(
            name="p", skill="demo", mode="user-only", _operation_context=context))
    else:
        project.cmd_project_analytics(SimpleNamespace(
            name="p", verify_prefixes="pytest", _operation_context=context))
    assert seen == [context]


def test_mcp_cleanup_preview_matches_apply_for_hand_edited_entry(tmp_data_home, tmp_path):
    import hub
    from skill_hub.application.harnesses.harness_operation_context import build_operation_context
    from skill_hub.infrastructure.mcp import mcp_adapters

    project = tmp_path / "project"
    project.mkdir()
    config = project / ".mcp.json"
    recorded = {"command": "original", "args": [], "env": {}}
    edited = {"command": "hand-edited", "args": [], "env": {}}
    config.write_text(json.dumps({"mcpServers": {"demo": edited}}))
    mcp_adapters._project_sidecar_write(
        "claude-code", "p", project, config, {"demo"}, {"demo": recorded}, None)
    registry = {"skills": {"demo": {"type": "mcp-server"}},
                "projects": {"p": {"path": str(project), "harnesses": ["claude-code"]}}}
    context = build_operation_context(
        tmp_data_home, ("claude-code",), requested_features=("mcp",),
        installed_harness_ids=("claude-code",))
    before = config.read_bytes()
    preview = hub.clean_project_artifacts(
        project, registry, dry_run=True, project_name="p", operation_context=context)
    assert config.read_bytes() == before
    applied = hub.clean_project_artifacts(
        project, registry, project_name="p", operation_context=context)
    assert preview["removed_mcp_entries"] == applied["removed_mcp_entries"] == []
    assert config.read_bytes() == before
