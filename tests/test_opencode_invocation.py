"""Focused contracts for opencode's bounded command-only delivery."""

from __future__ import annotations

import time
from pathlib import Path

from skill_hub import hub_core
from skill_hub.infrastructure.harnesses import opencode_invocation as oi


def _skill(root: Path, name: str = "demo", body: str = "Use the skill.") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "SKILL.md"
    path.write_text(f"---\nname: {name}\ndescription: test\n---\n{body}\n", encoding="utf-8")
    return path


def _plan(source: Path, project: Path, **kwargs):
    return oi.plan_command(
        "demo",
        source,
        project_path=project,
        target_harnesses={"opencode"},
        profile=oi.SUPPORTED_PROFILE,
        removable_links=set(),
        **kwargs,
    )


def test_native_path_snapshot_binds_plan_and_cleanup_to_captured_roots(
    tmp_path, tmp_data_home, monkeypatch
):
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    captured_home = tmp_path / "captured-home"
    captured_data = tmp_path / "captured-data"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(captured_home / "config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(captured_home / "data"))
    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", "{}")
    native_paths = oi.capture_native_paths(
        home=captured_home, data_home=captured_data
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "ambient-config"))
    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", "not json")
    monkeypatch.setattr(
        hub_core,
        "_resolve_data_home_path",
        lambda: (_ for _ in ()).throw(AssertionError("ambient data home read")),
    )

    plan = _plan(source, project, native_paths=native_paths)

    assert plan["eligible"] is True
    assert plan["command_path"] == project / ".opencode" / "commands" / "demo.md"
    assert plan["artifact_path"].is_relative_to(captured_data)
    assert oi.apply_command(plan) == 2
    assert oi.owned_command_links(project, native_paths=native_paths)
    assert oi.cleanup_commands(
        project, set(), native_paths=native_paths
    ) == 1


def test_eligible_plan_is_read_only_and_loader_does_not_inline_skill(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source", body="literal $(touch pwned) and $ARGUMENTS")
    project = tmp_path / "project"
    before = source.read_bytes()

    plan = _plan(source, project)

    assert plan["eligible"] is True
    assert plan["support"] == "enforced"
    assert plan["command_path"] == project / ".opencode" / "commands" / "demo.md"
    content = plan["content"]
    assert f"@{source.resolve().as_posix()}" in content
    assert f"Base directory for this skill: {source.parent.resolve().as_posix()}" in content
    assert "$ARGUMENTS" in content
    assert "touch pwned" not in content
    assert source.read_bytes() == before
    assert not project.exists()
    assert not (tmp_data_home / "state").exists()


def test_apply_is_atomic_and_idempotent(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    plan = _plan(source, project)

    assert oi.apply_command(plan) == 2
    command = plan["command_path"]
    artifact = plan["artifact_path"]
    first_mtime = artifact.stat().st_mtime_ns
    assert command.is_symlink()
    assert command.resolve() == artifact
    time.sleep(0.01)
    assert oi.apply_command(plan) == 0
    assert artifact.stat().st_mtime_ns == first_mtime
    assert command.read_text(encoding="utf-8") == plan["content"]


def test_project_removal_plans_then_removes_only_owned_commands(tmp_path, tmp_data_home):
    from skill_hub.entrypoints.cli.project import clean_project_artifacts

    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    plan = _plan(source, project)
    oi.apply_command(plan)
    owned = plan["command_path"]
    foreign = owned.parent / "personal.md"
    foreign.write_text("personal command")
    preview = clean_project_artifacts(project, {}, dry_run=True)
    assert str(owned) in preview["removed_symlinks"]
    assert owned.is_symlink()
    clean_project_artifacts(project, {})
    assert not owned.is_symlink()
    assert foreign.read_text() == "personal command"


def test_payload_collection_keeps_live_and_missing_project_consumers(tmp_path, tmp_data_home):
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    plan = _plan(source, project)
    oi.apply_command(plan)
    assert oi.collect_orphan_payloads([project]) == 0
    oi.cleanup_commands(project, set())
    assert oi.collect_orphan_payloads([project, tmp_path / "unmounted"]) == 0
    assert plan["artifact_path"].exists()
    assert oi.collect_orphan_payloads([project]) == 1
    assert not plan["artifact_path"].exists()


def test_argument_markers_in_source_path_are_not_expanded(tmp_path, tmp_data_home):
    source = _skill(tmp_path / "$ARGUMENTS")
    assert _plan(source, tmp_path / "project")["reason_code"] == "unsafe-source-path"


def test_same_declared_name_is_a_conflict_even_when_folder_differs(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    _skill(project / ".agents" / "skills" / "different-folder")

    plan = _plan(source, project)

    assert plan["eligible"] is False
    assert plan["support"] == "unsupported"
    assert plan["reason_code"] == "skill-discovery-conflict"


def test_symlinked_discovery_skill_is_scanned_and_owned_link_can_be_removed(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    managed = tmp_data_home / "skills" / "demo"
    _skill(managed)
    discovered = project / ".agents" / "skills" / "alias"
    discovered.parent.mkdir(parents=True)
    discovered.symlink_to(managed, target_is_directory=True)

    blocked = _plan(source, project)
    assert blocked["reason_code"] == "skill-discovery-conflict"
    allowed = oi.plan_command(
        "demo",
        source,
        project_path=project,
        target_harnesses={"opencode"},
        profile=oi.SUPPORTED_PROFILE,
        removable_links={discovered},
    )
    assert allowed["eligible"] is True


def test_user_command_and_builtin_collisions_are_preserved(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    command_dir = project / ".opencode" / "commands"
    command_dir.mkdir(parents=True)
    (command_dir / "demo.md").write_text("user command", encoding="utf-8")

    plan = _plan(source, project)
    assert plan["support"] == "unsupported"
    assert plan["reason_code"] == "command-collision"
    assert (command_dir / "demo.md").read_text(encoding="utf-8") == "user command"

    builtin = oi.plan_command(
        "review",
        _skill(tmp_path / "review-source", name="review"),
        project_path=project,
        target_harnesses={"opencode"},
        profile=oi.SUPPORTED_PROFILE,
        removable_links=set(),
    )
    assert builtin["support"] == "unsupported"
    assert builtin["reason_code"] == "builtin-command"


def test_jsonc_irrelevant_config_is_safe_but_skill_plugin_and_bad_config_fail_closed(
    tmp_path, tmp_data_home, monkeypatch
):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    project.mkdir()
    config = project / "opencode.json"
    config.write_text('{"theme": "dark", // irrelevant\n"model": "x",}\n', encoding="utf-8")
    assert _plan(source, project)["eligible"] is True

    config.write_text('{"skills": {"paths": ["/other/skills"]}}\n', encoding="utf-8")
    assert _plan(source, project)["reason_code"] == "config-discovery-unknown"
    config.write_text('{"plugins": ["remote-plugin"]}\n', encoding="utf-8")
    assert _plan(source, project)["reason_code"] == "config-discovery-unknown"
    config.write_text("{not json", encoding="utf-8")
    assert _plan(source, project)["reason_code"] == "config-unreadable"

    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", '{"theme":"dark"}')
    config.unlink()
    assert _plan(source, project)["eligible"] is True
    monkeypatch.setenv("OPENCODE_CONFIG_CONTENT", '{"skills":{"paths":["https://example.invalid"]}}')
    assert _plan(source, project)["reason_code"] == "config-discovery-unknown"


def test_source_and_inputs_are_fail_closed(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    inside = _skill(project / ".opencode" / "skills" / "demo")
    in_root = _plan(inside, project)
    assert in_root["reason_code"] == "source-in-discovery-root"

    unsafe = _skill(tmp_path / "folder with space")
    assert _plan(unsafe, project)["reason_code"] == "unsafe-source-path"
    mixed = oi.plan_command(
        "demo",
        source,
        project_path=project,
        target_harnesses={"opencode", "codex"},
        profile=oi.SUPPORTED_PROFILE,
        removable_links=set(),
    )
    assert mixed["support"] == "unsupported"
    unknown = oi.plan_command(
        "demo",
        source,
        project_path=project,
        target_harnesses={"opencode"},
        profile="opencode-unknown",
        removable_links=set(),
    )
    assert unknown["support"] == "unknown"


def test_cleanup_and_remove_preserve_foreign_commands(tmp_path, tmp_data_home):
    hub_core._DATA_HOME_CACHE = None
    source = _skill(tmp_path / "source")
    project = tmp_path / "project"
    plan = _plan(source, project)
    assert oi.apply_command(plan) == 2
    command_dir = project / ".opencode" / "commands"
    (command_dir / "foreign.md").write_text("keep", encoding="utf-8")
    stale_plan = dict(plan)
    stale_plan["command_path"] = command_dir / "stale.md"
    stale_plan["artifact_path"] = plan["artifact_path"].with_name("stale.md")
    stale_plan["content"] = "stale"
    assert oi.apply_command(stale_plan) == 2

    assert oi.cleanup_commands(project, {"demo"}) == 1
    assert not (command_dir / "stale.md").exists()
    assert (command_dir / "foreign.md").read_text(encoding="utf-8") == "keep"
    assert oi.remove_owned_command("demo", project) == 1
    assert not (command_dir / "demo.md").exists()
