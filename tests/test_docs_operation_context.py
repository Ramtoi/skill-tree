"""Regression coverage for captured docs and sub-agent routing."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace


def _context(tmp_path: Path, *, route_status: str = "shadow", ids=("claude-code",)):
    claude_agents = tmp_path / "captured" / "agents"
    codex_agents = tmp_path / "captured" / "codex-agents"
    layouts = {
        "claude-code": SimpleNamespace(
            label="Captured Claude",
            root_doc="CLAUDE.md",
            global_doc=tmp_path / "captured" / "CLAUDE.md",
            agents_dir=claude_agents,
            config_dir=tmp_path / "captured" / "claude",
            permission_project_config=Path(".claude/settings.json"),
            agent_target=lambda scope, project=None: claude_agents if scope == "user" else None,
        ),
        "codex": SimpleNamespace(
            label="Captured Codex",
            root_doc="AGENTS.md",
            global_doc=tmp_path / "captured" / "AGENTS.md",
            agents_dir=codex_agents,
            config_dir=tmp_path / "captured" / "codex",
            permission_project_config=None,
            agent_target=lambda scope, project=None: codex_agents if scope == "user" else None,
        ),
    }

    def layout(harness_id):
        return layouts.get(harness_id)

    def route(harness_id, feature):
        if harness_id not in layouts:
            return SimpleNamespace(status="unavailable", mode="unavailable")
        return SimpleNamespace(status=route_status, mode="legacy_shadow")

    return SimpleNamespace(
        data_home=str(tmp_path / "hub"),
        harness_ids=tuple(ids),
        installed_harness_ids=tuple(ids),
        layout=layout,
        route=route,
    )


def test_global_docs_uses_captured_target_and_shadow_route(tmp_path, monkeypatch):
    from skill_hub.infrastructure.filesystem import global_docs

    context = _context(tmp_path)
    target = tmp_path / "captured" / "CLAUDE.md"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"captured\x00bytes")
    declarations = dict(global_docs._harnesses.HARNESSES)
    declarations["claude-code"] = dataclasses.replace(
        declarations["claude-code"], global_doc=tmp_path / "wrong" / "CLAUDE.md"
    )
    monkeypatch.setattr(global_docs._harnesses, "HARNESSES", declarations)

    assert global_docs.doc_path("claude-code", context=context) == target
    row = global_docs.status(context=context)[0]
    assert row["path"] == str(target)
    assert row["state"] == "standalone"


def test_unavailable_doc_route_does_not_touch_foreign_symlink(tmp_path):
    from skill_hub.infrastructure.filesystem import global_docs

    context = _context(tmp_path, route_status="unavailable")
    target = tmp_path / "outside.md"
    target.write_text("foreign")
    follower = context.layout("claude-code").global_doc
    follower.parent.mkdir(parents=True)
    follower.symlink_to(target)
    before = follower.readlink()

    row = global_docs.status(context=context)[0]
    assert row["state"] == "unavailable"
    result = global_docs.unlink("claude-code", backups_root=tmp_path / "backups", context=context)
    assert result["error"] == "not_a_follower"
    assert result["state"] == "unavailable"
    assert follower.is_symlink() and follower.readlink() == before


def test_subagent_save_uses_captured_directory(tmp_path, monkeypatch):
    from skill_hub.infrastructure.harnesses import subagents

    context = _context(tmp_path)
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(tmp_path / "wrong"))
    result = subagents.save_agent(
        {
            "harness": "claude-code",
            "scope": "user",
            "original_name": None,
            "safe": {"name": "captured-agent", "description": "d", "model": ""},
            "advanced_yaml": "",
            "body": "Instructions.\n",
        },
        {},
        context=context,
    )
    assert result["ok"]
    assert Path(result["file"]).parent == context.layout("claude-code").agents_dir


def test_unlink_does_not_drop_link_with_unknown_member(tmp_path):
    from skill_hub.infrastructure.harnesses import subagent_links

    context = _context(tmp_path)
    sidecar = Path(context.data_home) / "state" / "subagents" / "links.json"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text(json.dumps({"links": [{
        "name": "pair", "scope": "user", "harnesses": ["claude-code", "codex"]
    }]}))
    before = sidecar.read_bytes()

    result = subagent_links.unlink_agents("pair", context=context)
    assert result["ok"] is False
    assert sidecar.read_bytes() == before


def test_companions_factory_captures_nested_routes_and_detected_ids(
    tmp_data_home, monkeypatch
):
    from skill_hub.entrypoints.cli import companions
    from skill_hub.infrastructure.harnesses import harnesses

    monkeypatch.setattr(harnesses, "detect_installed", lambda: {"claude-code"})
    context = companions._companions_context({
        "harnesses_global": ["claude-code", "codex"], "projects": {},
    })

    assert context.installed_harness_ids == ("claude-code",)
    assert context.layout("claude-code") is not None
    assert context.route("claude-code", "companions").mode == "legacy_shadow"
    assert context.route("claude-code", "subagents").mode == "legacy_shadow"
    assert context.route("claude-code", "hooks").mode == "legacy_shadow"
    assert context.route("claude-code", "permissions").mode == "legacy_shadow"


def test_companion_plan_reads_captured_hook_and_permission_paths(tmp_data_home, tmp_path, monkeypatch):
    from dataclasses import replace

    from skill_hub.application.harnesses import harness_operation_context
    from skill_hub.domain.skills import ships_with
    from skill_hub.infrastructure.harnesses import harnesses

    context = harness_operation_context.build_operation_context(
        tmp_data_home, ("claude-code",), installed_harness_ids=("claude-code",),
        requested_features=("companions", "hooks", "permissions"),
    )
    hook_path = tmp_path / "captured-hooks.json"
    permission_path = tmp_path / "captured-permissions.json"
    context = replace(context, layouts={"claude-code": replace(
        context.layout("claude-code"), hook_global_config=hook_path,
        permission_global_config=permission_path,
    )}, hook_observations={"claude-code": {"verdict": "supported", "reason": "fixture"}})
    registry = {"harnesses_global": ["claude-code"], "skills": {"fixture": {"scope": "global"}}}
    monkeypatch.setattr(ships_with, "declared_from_frontmatter", lambda *a: {
        "hooks": [{"name": "guard", "event": "PreToolUse", "command": "true", "activation": "always"}],
        "permissions": {"allow": ["Read"]},
    })
    monkeypatch.setattr(harnesses, "HARNESSES", {})
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(tmp_path / "changed-home"))
    plan = ships_with.plan_provision("fixture", None, registry, operation_context=context)
    targets = {item["kind"]: item["target"] for item in plan["items"]}
    assert targets["hook"] == str(hook_path)
    assert targets["permission"] == str(permission_path)
