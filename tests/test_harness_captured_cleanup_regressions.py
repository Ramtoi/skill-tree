from __future__ import annotations

import json
from types import MappingProxyType
from unittest.mock import patch

import pytest

from skill_hub.domain.permissions.permissions import ProjectScope, write_sidecar


def test_project_mcp_cleanup_uses_captured_home_and_preserves_foreign_sidecar(
    tmp_data_home, tmp_path
):
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    ambient.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    adapter = ClaudeMcpAdapter()
    kwargs = {"harness_id": "claude-code", "project_name": "demo"}

    with patch("skill_hub.hub_core.data_home", return_value=ambient):
        adapter.write(
            project,
            [McpServerSpec(name="owned", command="fixture")],
            **kwargs,
            data_home_path=captured,
        )
        # A same-named ambient sidecar must not become the ownership source.
        write_sidecar(
            "claude-code",
            ProjectScope("demo", str(project)),
            ["owned"],
            project / ".mcp.json",
            kind="mcp",
            managed_values={"owned": {"command": "foreign"}},
            data_home_path=ambient,
        )
        result = adapter.remove(
            project, {"owned"}, **kwargs, data_home_path=captured
        )

    assert result.removed == frozenset({"owned"})
    assert not (project / ".mcp.json").exists()
    assert (ambient / "state" / "claude-code" / "project-demo.mcp.managed.json").exists()
    assert not list(captured.rglob("*.managed.json"))


def test_project_mcp_sync_passes_captured_home_to_adapter(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.application.sync import mcp_sync
    from tests.test_mcp_operation_routing import _context

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    project = tmp_path / "project"
    project.mkdir()
    context = _context(captured, tmp_path, ("claude-code", "codex"))
    registry = {
        "skills": {
            "server": {"type": "mcp-server", "mcp": {"command": "fixture"}}
        },
        "projects": {"demo": {"path": str(project), "harnesses": ["claude-code"]}},
        "harnesses_global": ["claude-code"],
    }

    with patch("skill_hub.hub_core.data_home", return_value=ambient):
        mcp_sync.sync_mcp_for_project(
            project, ["server"], registry, project_name="demo", operation_context=context
        )

    assert (captured / "state" / "claude-code" / "project-demo.mcp.managed.json").exists()
    assert not list(ambient.rglob("*.managed.json"))
    assert json.loads((project / ".mcp.json").read_text())["mcpServers"]["server"]


def test_project_companion_cleanup_uses_captured_agent_home(tmp_path, monkeypatch):
    import argparse

    from skill_hub import hub_core
    from skill_hub.domain.skills import ships_with
    from tests.test_mcp_operation_routing import _context

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    ambient.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    context = _context(captured, tmp_path, ("claude-code", "codex"))
    from skill_hub.application.harnesses.harness_operation_context import AdapterRoute
    object.__setattr__(
        context,
        "routes",
        MappingProxyType({
            **context.routes,
            ("claude-code", "subagents"): AdapterRoute(
                "claude-code", "subagents", adapter_key="claude-code"
            ),
        }),
    )
    a_agents = context.layout("claude-code").agents_dir
    assert a_agents is not None
    a_agents.mkdir(parents=True)
    (a_agents / "reviewer.md").write_text("---\nname: reviewer\ndescription: A\n---\nA\n")
    from skill_hub.application.harnesses.harness_layout_context import capture_layouts
    b_agents = capture_layouts(
        ("claude-code",), home=ambient,
        home_overrides={"claude-code": ambient / ".claude"},
    )["claude-code"].agents_dir
    assert b_agents is not None
    b_agents.mkdir(parents=True, exist_ok=True)
    foreign = b_agents / "reviewer.md"
    foreign.write_text("---\nname: reviewer\ndescription: B\n---\nB\n")

    project_cfg = {
        "path": str(project), "harnesses": ["claude-code"], "companions": {"demo": {}},
    }
    ships_with.set_ledger_entry(
        project_cfg,
        "demo",
        {"schema": 2, "agents": ["reviewer"], "agent_state": {
            "reviewer": {"files": {"claude-code": {"written": True}}}
        }},
    )
    registry = {"projects": {"demo": project_cfg}, "skills": {}, "harnesses_global": []}
    monkeypatch.setattr("skill_hub.hub_core.data_home", lambda: ambient)
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(hub_core, "save_registry", lambda value: None)

    from skill_hub.entrypoints.cli.project import cmd_project_remove
    cmd_project_remove(argparse.Namespace(
        name="demo", dry_run=False, json=False, _operation_context=context,
    ))

    assert not (a_agents / "reviewer.md").exists()
    assert foreign.exists()


def test_project_mcp_cleanup_preview_apply_keeps_ambient_sidecar(tmp_path, monkeypatch):
    import hub
    from skill_hub.infrastructure.mcp.mcp_adapters import ClaudeMcpAdapter, McpServerSpec
    from tests.test_mcp_operation_routing import _context

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    project = tmp_path / "project"
    project.mkdir()
    context = _context(captured, tmp_path, ("claude-code",))
    adapter = ClaudeMcpAdapter()
    adapter.write(
        project, [McpServerSpec(name="owned", command="fixture")],
        harness_id="claude-code", project_name="demo", data_home_path=captured,
    )
    write_sidecar(
        "claude-code", ProjectScope("demo", str(project)), ["owned"],
        project / ".mcp.json", kind="mcp",
        managed_values={"owned": {"command": "foreign"}}, data_home_path=ambient,
    )
    registry = {
        "skills": {"owned": {"type": "mcp-server"}},
        "projects": {"demo": {"path": str(project), "harnesses": ["claude-code"]}},
        "harnesses_global": ["claude-code"],
    }
    monkeypatch.setattr("skill_hub.hub_core.data_home", lambda: ambient)
    before = (project / ".mcp.json").read_bytes()
    preview = hub.clean_project_artifacts(
        project, registry, dry_run=True, project_name="demo", operation_context=context
    )
    assert preview["removed_mcp_entries"] == [{"file": str(project / ".mcp.json"), "name": "owned"}]
    assert (project / ".mcp.json").read_bytes() == before
    applied = hub.clean_project_artifacts(
        project, registry, project_name="demo", operation_context=context
    )
    assert applied["removed_mcp_entries"] == preview["removed_mcp_entries"]
    assert not (project / ".mcp.json").exists()
    assert (ambient / "state" / "claude-code" / "project-demo.mcp.managed.json").exists()


def test_hook_cleanup_uses_captured_sidecar_and_backup_home(tmp_path, monkeypatch):
    from skill_hub.infrastructure.hooks.hook_adapters import ClaudeHookAdapter, _hook_fingerprint, _managed_key

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    project = tmp_path / "project"
    project.mkdir()
    target = project / ".claude" / "settings.local.json"
    target.parent.mkdir()
    target.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "Edit", "hooks": [{"type": "command", "command": "a"}],
        }]},
    }) + "\n")
    scope = ProjectScope("demo", str(project))
    key = _managed_key("PreToolUse", 0, _hook_fingerprint("PreToolUse", "Edit", "a"))
    write_sidecar("claude-code", scope, [key], target, kind="hooks", data_home_path=captured)
    write_sidecar("claude-code", scope, ["hooks.PreToolUse[0]#foreign"], target, kind="hooks", data_home_path=ambient)
    monkeypatch.setattr("skill_hub.hub_core.data_home", lambda: ambient)

    result = ClaudeHookAdapter().cleanup(
        scope, "claude-code", data_home_path=captured
    )

    assert result.removed
    assert json.loads(target.read_text()) == {}
    assert not (captured / "state" / "claude-code" / "project-demo.hooks.managed.json").exists()
    assert (ambient / "state" / "claude-code" / "project-demo.hooks.managed.json").exists()
    assert list((captured / "_hub-backups" / "hooks").rglob("*"))
    assert not (ambient / "_hub-backups").exists()


def test_mcp_reconcile_rollback_restores_a_and_leaves_foreign_b_untouched(
    tmp_path, monkeypatch
):
    import skill_hub.entrypoints.cli.mcp as mcp_cli
    from skill_hub.application.sync import mcp_sync
    from tests.test_mcp_operation_routing import _context
    from tests.test_mcp_reconcile_apply import _discover_and_classify, _proj_cfg, _registry

    captured = tmp_path / "home-a"
    ambient = tmp_path / "home-b"
    ambient.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    context = _context(captured, tmp_path, ("claude-code", "codex"))
    project_cfg = _proj_cfg(project)
    project_cfg["enabled"] = ["foo"]
    project_cfg["harnesses"] = ["claude-code", "codex"]
    registry = _registry(
        projects={"demo": project_cfg},
        skills={"foo": {"type": "mcp-server", "scope": "portable", "mcp": {"command": "nodeA"}}},
    )
    native = project / ".mcp.json"
    native.write_text('{"mcpServers":{"foo":{"command":"nodeB"}}}\n')
    codex_native = project / ".codex" / "config.toml"
    codex_native.parent.mkdir()
    codex_native.write_text('[mcp_servers.foo]\ncommand = "nodeC"\n')
    native_before = native.read_bytes()
    codex_before = codex_native.read_bytes()
    discovered, candidates = _discover_and_classify(
        registry, "project", registry["projects"]["demo"], {"claude-code", "codex"},
        proj_name="demo", proj_root=project,
    )
    assert next(c for c in candidates if c["name"] == "foo")["status"] == "conflict"
    scope = ProjectScope("demo", str(project))
    write_sidecar(
        "codex", scope, ["foo"], codex_native, kind="mcp",
        managed_values={"foo": {"command": "foreignB"}}, data_home_path=ambient,
    )
    b_before = (ambient / "state" / "codex" / "project-demo.mcp.managed.json").read_bytes()
    monkeypatch.setattr("skill_hub.hub_core.data_home", lambda: ambient)
    def failed_sync(*args, **kwargs):
        assert kwargs["operation_context"] is context
        assert (captured / "state" / "codex" / "project-demo.mcp.managed.json").exists()
        assert (ambient / "state" / "codex" / "project-demo.mcp.managed.json").read_bytes() == b_before
        raise RuntimeError("boom")

    monkeypatch.setattr(mcp_sync, "sync_mcp_for_project", failed_sync)

    with pytest.raises(RuntimeError):
        mcp_cli._reconcile_apply_mcp(
            registry, "project", "demo", project, candidates, discovered,
            [{"name": "foo", "action": "import", "harness": "claude-code"}],
            {"claude-code", "codex"}, operation_context=context,
        )

    assert native.read_bytes() == native_before
    assert codex_native.read_bytes() == codex_before
    assert (ambient / "state" / "codex" / "project-demo.mcp.managed.json").read_bytes() == b_before
    assert not (captured / "state" / "codex" / "project-demo.mcp.managed.json").exists()
