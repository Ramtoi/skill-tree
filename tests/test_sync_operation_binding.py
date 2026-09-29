"""The sync host keeps one fixed selection through its nested workflows."""
from dataclasses import replace
from types import SimpleNamespace

import pytest

from skill_hub import hub_core
from skill_hub.application.harnesses import harness_operation_context as contexts
from skill_hub.application.sync import sync_engine


def _context(tmp_data_home, monkeypatch):
    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: None)
    return contexts.build_operation_context(
        tmp_data_home, ("codex",), installed_harness_ids=("codex",),
        requested_features=("skills", "agent_docs", "companions", "backup"),
    )


def test_nested_sync_uses_supplied_context_for_every_nested_pass(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.domain.skills import skill_refs
    from skill_hub.entrypoints.cli import companions
    from skill_hub.infrastructure.harnesses import harnesses
    from skill_hub.infrastructure.usage import usage_loadouts

    context = _context(tmp_data_home, monkeypatch)
    registry = {"skills": {}, "projects": {"p": {"path": str(tmp_path / "p"), "harnesses": ["codex"]}}}
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(sync_engine, "validate_registry_skills", lambda reg: None)
    monkeypatch.setattr(sync_engine, "sync_skill_frontmatter_metadata", lambda reg: False)
    monkeypatch.setattr(harnesses, "detect_installed", lambda: pytest.fail("nested sync redetected harnesses"))
    monkeypatch.setattr(
        sync_engine, "build_operation_context", lambda *a, **k: pytest.fail("nested sync replaced context")
    )
    monkeypatch.setattr(harnesses, "HARNESSES", {})
    monkeypatch.setattr(skill_refs, "build_graph", lambda reg: {})
    monkeypatch.setattr(usage_loadouts, "run_loadout_pass", lambda *a, **k: None)
    monkeypatch.setattr(sync_engine, "_cleanup_variant_orphans", lambda *a, **k: None)
    from skill_hub.infrastructure.harnesses import opencode_invocation
    monkeypatch.setattr(opencode_invocation, "collect_orphan_payloads", lambda *a, **k: 0)
    seen = {}
    for name in (
        "_sync_global_skills", "_run_global_mcp_dispatch", "_sync_project_skills",
        "_run_agent_docs_detection", "_run_project_skill_detection",
    ):
        monkeypatch.setattr(sync_engine, name, lambda *a, _name=name, **k: seen.update({_name: (a, k)}))
    monkeypatch.setattr(companions, "run_reconcile_pass", lambda *a, **k: seen.update({"companions": (a, k)}))
    monkeypatch.setattr(sync_engine, "_run_backup_pass", lambda *a, **k: seen.update({"backup": (a, k)}))
    monkeypatch.setattr(sync_engine, "write_sync_report", lambda report: None)
    args = SimpleNamespace(_operation_context=context, skip_hooks=True, skip_permissions=True, skip_remotes=True)
    sync_engine.cmd_sync(args)
    assert len(seen) == 7
    assert all(kwargs["operation_context"] is context for _, kwargs in seen.values())
    assert seen["_sync_project_skills"][0][4] == {"codex"}


def test_fixed_effective_set_ignores_later_registry_declarations(tmp_data_home, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    context = _context(tmp_data_home, monkeypatch)
    monkeypatch.setattr(harnesses, "HARNESSES", {})
    assert context.effective_harness_ids({"harnesses": ["codex", "pi"]}, {}) == {"codex"}
    assert replace(context, installed_harness_ids=()).effective_harness_ids({"harnesses": ["codex"]}, {}) == set()


def test_mutation_sync_tail_preserves_captured_context(tmp_data_home, monkeypatch):
    import hub

    context = _context(tmp_data_home, monkeypatch)
    seen = []
    monkeypatch.setattr(hub, "cmd_sync", lambda args: seen.append(args))
    assert sync_engine._auto_sync_tail(operation_context=context)
    assert len(seen) == 1
    assert seen[0]._operation_context is context
    assert seen[0].skip_remotes and not seen[0].backup_push


def test_project_discovery_uses_captured_layouts(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.infrastructure.harnesses import harnesses

    context = _context(tmp_data_home, monkeypatch)
    root = tmp_path / "project"
    skill = root / context.layout("codex").project_skills_dir / "local-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: local-skill\ndescription: fixture\n---\nbody\n")
    monkeypatch.setattr(harnesses, "HARNESSES", {})
    candidates = sync_engine.scan_project_skill_candidates(
        {"projects": {"p": {"path": str(root)}}}, operation_context=context
    )
    assert [item["name"] for item in candidates] == ["local-skill"]


def test_unavailable_shared_skills_route_preserves_owned_global_links(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.infrastructure.harnesses import opencode_invocation

    monkeypatch.setattr(contexts, "read_inventory_cache", lambda *args: None)
    context = contexts.build_operation_context(
        tmp_data_home, ("codex", "pi"), installed_harness_ids=("codex", "pi"), requested_features=("skills",)
    )
    shared = tmp_path / "shared-skills"
    shared.mkdir()
    source = tmp_data_home / "skills" / "last-good"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("fixture")
    link = shared / "last-good"
    link.symlink_to(source, target_is_directory=True)
    context = replace(
        context,
        layouts={hid: replace(layout, global_skills_dir=shared) for hid, layout in context.layouts.items()},
        routes={key: route for key, route in context.routes.items() if key[0] != "pi"},
    )
    monkeypatch.setattr(
        opencode_invocation, "cleanup_commands", lambda *a, **k: pytest.fail("uncaptured OpenCode cleanup")
    )
    sync_engine._sync_global_skills({"skills": {}}, {"codex", "pi"}, operation_context=context)
    assert link.is_symlink()
