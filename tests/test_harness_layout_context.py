from __future__ import annotations

import dataclasses
from pathlib import Path, PureWindowsPath

import pytest

from skill_hub.application.harnesses import harness_layout_context as layout_context


@pytest.fixture(autouse=True)
def declared_layouts(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.harnesses.harness_bundled_layouts import bundled_layouts

    # These contracts only capture paths. Restore declarations masked by the
    # global execution-isolation fixture, with all roots still disposable.
    monkeypatch.setattr(harnesses, "HARNESSES", {
        item.id: harnesses._from_native_layout(item) for item in bundled_layouts()
    })
    monkeypatch.delenv("SKILL_HUB_CLAUDE_HOME", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)


def test_capture_layouts_snapshots_all_host_paths_and_overrides(tmp_path, monkeypatch):
    base = tmp_path / "home"
    claude = tmp_path / "claude-home"
    codex = tmp_path / "codex-home"
    monkeypatch.setenv("HOME", str(tmp_path / "environment-home"))
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(tmp_path / "ignored-claude"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "ignored-codex"))

    layouts = layout_context.capture_layouts(
        ("claude-code", "codex", "pi", "opencode", "missing"),
        home=base,
        home_overrides={"claude-code": f"  {claude}  ", "codex": str(codex)},
    )

    assert set(layouts) == {"claude-code", "codex", "pi", "opencode"}
    assert layouts["claude-code"].global_skills_dir == claude / "skills"
    assert layouts["claude-code"].global_doc == claude / "CLAUDE.md"
    assert layouts["claude-code"].agents_dir == claude / "agents"
    assert layouts["codex"].global_skills_dir == base / ".agents" / "skills"
    assert layouts["codex"].global_doc == codex / "AGENTS.md"
    assert layouts["codex"].agents_dir == codex / "agents"
    assert layouts["codex"].mcp_adapter_key == "codex"
    assert layouts["codex"].permission_adapter_key == "codex"
    assert layouts["codex"].hook_mechanism == "command"
    assert layouts["codex"].global_mcp_config == codex / "config.toml"
    assert layouts["codex"].config_dir == codex
    assert layouts["pi"].config_dir == base / ".pi" / "agent"
    assert layouts["opencode"].config_dir == base / ".config" / "opencode"
    assert layouts["opencode"].global_doc == base / ".config" / "opencode" / "AGENTS.md"
    assert layouts["claude-code"].project_skills_dir == Path(".claude/skills")
    assert layouts["codex"].root_doc == "AGENTS.md"


def test_targets_use_only_captured_layout_and_preserve_codex_project_gap(tmp_path):
    layouts = layout_context.capture_layouts(("claude-code", "codex"), home=tmp_path)
    project = tmp_path / "checkout"

    assert layouts["claude-code"].doc_target() == tmp_path / ".claude" / "CLAUDE.md"
    assert layouts["claude-code"].agent_target("user") == tmp_path / ".claude" / "agents"
    assert layouts["claude-code"].agent_target("project", project) == project / ".claude" / "agents"
    assert layouts["codex"].agent_target("project", project) is None
    assert layout_context.doc_target(layouts, "missing") is None
    assert layout_context.agent_target(layouts, "user", harness_id="codex") == tmp_path / ".codex" / "agents"
    with pytest.raises(ValueError):
        layouts["claude-code"].agent_target("other")
    with pytest.raises(ValueError):
        layouts["claude-code"].agent_target("project")
    with pytest.raises(ValueError):
        layouts["claude-code"].agent_target("user", project)


def test_snapshot_does_not_follow_environment_or_registry_mutation(tmp_path, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    layouts = layout_context.capture_layouts(("claude-code",), home=tmp_path)
    original = layouts["claude-code"]
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(tmp_path / "changed"))
    replacement = dataclasses.replace(
        harnesses.HARNESSES["claude-code"], label="changed", global_doc="~/changed.md"
    )
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = replacement
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    assert layouts["claude-code"] is original
    assert original.label == "Claude Code"
    assert original.global_doc == tmp_path / ".claude" / "CLAUDE.md"


def test_layout_records_and_mapping_are_deeply_immutable(tmp_path):
    layouts = layout_context.capture_layouts(("claude-code",), home=tmp_path)
    with pytest.raises(TypeError):
        layouts["new"] = layouts["claude-code"]
    with pytest.raises(dataclasses.FrozenInstanceError):
        layouts["claude-code"].label = "changed"
    with pytest.raises(TypeError):
        layouts["claude-code"].legacy_global_skills_dirs[0] = tmp_path


def test_windows_style_declarations_are_normalized_without_platform_switch(
    tmp_path, monkeypatch
):
    from skill_hub.infrastructure.harnesses import harnesses

    declaration = harnesses.HARNESSES["claude-code"]
    patched = dict(harnesses.HARNESSES)
    patched["claude-code"] = dataclasses.replace(
        declaration,
        project_skills_dir=PureWindowsPath(r".claude\skills"),
        project_agents_dir=PureWindowsPath(r".claude\agents"),
        global_doc=PureWindowsPath(r"~\.claude\CLAUDE.md"),
    )
    monkeypatch.setattr(harnesses, "HARNESSES", patched)

    layout = layout_context.capture_layouts(("claude-code",), home=tmp_path)["claude-code"]
    assert layout.project_skills_dir == Path(".claude/skills")
    assert layout.project_agents_dir == Path(".claude/agents")
    assert layout.global_doc == tmp_path / ".claude" / "CLAUDE.md"


@pytest.mark.parametrize("override", [False, True])
def test_claude_global_mcp_file_remains_a_home_sibling(tmp_path, monkeypatch, override):
    monkeypatch.setenv("SKILL_HUB_CLAUDE_HOME", str(tmp_path / "alternate") if override else "")
    layouts = layout_context.capture_layouts(("claude-code",), home=tmp_path)
    assert layouts["claude-code"].global_mcp_config == tmp_path / ".claude.json"


@pytest.mark.parametrize("raw", ["~/.claude-other/file", "~/.codex-other/file"])
def test_home_override_matches_a_directory_component_only(tmp_path, raw):
    from skill_hub.application.harnesses.harness_layout_context import _rooted_path

    assert _rooted_path(raw, tmp_path, tmp_path / "claude", tmp_path / "codex") == tmp_path / raw[2:]
