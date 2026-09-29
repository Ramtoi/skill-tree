"""Context binding coverage for the subagent provisioning boundary."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest


def test_provision_skill_uses_supplied_context_after_host_registry_changes(
    tmp_path, tmp_data_home, monkeypatch
):
    import hub
    from skill_hub import hub_core
    from skill_hub.entrypoints.cli import subagent
    from skill_hub.infrastructure.harnesses import harnesses

    source = tmp_path / "skill"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: routed\ndescription: x\n---\nBody\n")
    captured = tmp_path / "captured-global-skills"
    layout = SimpleNamespace(
        global_skills_dir=captured,
        agents_dir=tmp_path / "captured-agents",
        project_skills_dir=Path(".agents/skills"),
    )
    route = SimpleNamespace(status="shadow", mode="legacy_shadow")
    context = SimpleNamespace(
        harness_ids=("claude-code",),
        installed_harness_ids=("claude-code",),
        layouts={"claude-code": layout},
        layout=lambda hid: layout if hid == "claude-code" else None,
        route=lambda hid, feature: route,
    )
    registry = {
        "skills": {"routed": {"scope": "portable", "source": str(source)}},
        "projects": {},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(hub_core, "save_registry", lambda _registry: None)

    def sync_global(_registry, _installed, *, operation_context):
        assert operation_context is context
        target = operation_context.layout("claude-code").global_skills_dir / "routed"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("captured")
        return {"routed"}

    monkeypatch.setattr(hub, "_sync_global_skills", sync_global)
    monkeypatch.setattr(harnesses, "HARNESSES", {})
    monkeypatch.setattr(
        harnesses, "detect_installed", lambda: (_ for _ in ()).throw(AssertionError("redetected"))
    )

    result = subagent._provision_skill(
        "routed", None, True, "claude-code", False,
        operation_context=context,
    )

    assert result["ok"] is True
    assert Path(result["path"]) == captured / "routed" / "SKILL.md"


def _provision_context(layouts, routes, installed, effective=None):
    effective_ids = set(installed) if effective is None else set(effective)
    return SimpleNamespace(
        installed_harness_ids=tuple(installed),
        layouts=layouts,
        layout=lambda hid: layouts.get(hid),
        route=lambda hid, feature: routes.get((hid, feature)),
        effective_harness_ids=lambda _project, _registry: set(effective_ids),
    )


def test_project_provision_failure_restores_foreign_link(
    tmp_path, tmp_data_home, monkeypatch
):
    from skill_hub import hub_core
    from skill_hub.entrypoints.cli import subagent

    source = tmp_path / "skill"
    source.mkdir()  # Deliberately lacks SKILL.md, so verification fails.
    project = tmp_path / "project"
    skills_dir = project / ".agents" / "skills"
    skills_dir.mkdir(parents=True)
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    link = skills_dir / "routed"
    link.symlink_to(foreign, target_is_directory=True)
    original_target = link.readlink()
    layout = SimpleNamespace(
        global_skills_dir=tmp_path / "global",
        agents_dir=tmp_path / "agents",
        project_skills_dir=Path(".agents/skills"),
    )
    route = SimpleNamespace(status="shadow", mode="legacy_shadow")
    context = _provision_context(
        {"claude-code": layout},
        {("claude-code", "skills"): route, ("claude-code", "subagents"): route},
        ("claude-code",),
    )
    registry = {
        "skills": {"routed": {"scope": "portable", "source": str(source)}},
        "projects": {"demo": {"path": str(project), "enabled": []}},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(hub_core, "save_registry", lambda _registry: None)

    result = subagent._provision_skill(
        "routed", "demo", False, "claude-code", False,
        operation_context=context,
    )

    assert result["ok"] is False
    assert link.is_symlink()
    assert link.readlink() == original_target


def test_project_provision_skips_shared_dir_with_unavailable_participant(
    tmp_path, tmp_data_home, monkeypatch
):
    from skill_hub import hub_core
    from skill_hub.entrypoints.cli import subagent

    source = tmp_path / "skill"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: routed\n---\n")
    project = tmp_path / "project"
    skills_dir = project / ".agents" / "skills"
    skills_dir.mkdir(parents=True)
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    link = skills_dir / "routed"
    link.symlink_to(foreign, target_is_directory=True)
    original_target = link.readlink()
    shared = SimpleNamespace(
        global_skills_dir=tmp_path / "global",
        agents_dir=tmp_path / "agents",
        project_skills_dir=Path(".agents/skills"),
    )
    available = SimpleNamespace(status="shadow", mode="legacy_shadow")
    unavailable = SimpleNamespace(status="unavailable", mode="unavailable")
    context = _provision_context(
        {"claude-code": shared, "codex": shared},
        {
            ("claude-code", "skills"): available,
            ("claude-code", "subagents"): available,
            ("codex", "skills"): unavailable,
            ("codex", "subagents"): unavailable,
        },
        ("claude-code", "codex"),
    )
    registry = {
        "skills": {"routed": {"scope": "portable", "source": str(source)}},
        "projects": {"demo": {"path": str(project), "enabled": []}},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(hub_core, "save_registry", lambda _registry: None)

    result = subagent._provision_skill(
        "routed", "demo", False, "claude-code", False,
        operation_context=context,
    )

    assert result["ok"] is False
    assert link.is_symlink()
    assert link.readlink() == original_target


@pytest.mark.parametrize("symlink_root,blocked_participant", [(True, False), (False, True)])
def test_project_provision_preserves_symlink_dir_and_affinity_excluded_participant(
    tmp_path, tmp_data_home, monkeypatch, symlink_root, blocked_participant
):
    from skill_hub import hub_core
    from skill_hub.entrypoints.cli import subagent

    source = tmp_path / "skill"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: routed\n---\n")
    project = tmp_path / "project"
    skills_dir = project / ".agents" / "skills"
    foreign = tmp_path / "foreign-skills"
    foreign.mkdir(parents=True)
    (foreign / "keep.txt").write_text("foreign")
    skills_dir.parent.mkdir(parents=True)
    if symlink_root:
        skills_dir.symlink_to(foreign, target_is_directory=True)
    else:
        skills_dir.mkdir()
    shared = SimpleNamespace(
        global_skills_dir=tmp_path / "global",
        agents_dir=tmp_path / "agents",
        project_skills_dir=Path(".agents/skills"),
    )
    available = SimpleNamespace(status="shadow", mode="legacy_shadow")
    unavailable = SimpleNamespace(status="unavailable", mode="unavailable")
    context = _provision_context(
        {"claude-code": shared, "codex": shared},
        {
            ("claude-code", "skills"): available,
            ("claude-code", "subagents"): available,
            ("codex", "skills"): unavailable if blocked_participant else available,
            ("codex", "subagents"): unavailable,
        },
        ("claude-code", "codex"),
        effective=("claude-code",),
    )
    registry = {
        "skills": {
            "routed": {
                "scope": "portable", "source": str(source),
                "harnesses": ["claude-code"],
            }
        },
        "projects": {"demo": {"path": str(project), "enabled": []}},
    }
    monkeypatch.setattr(hub_core, "load_registry", lambda: registry)
    monkeypatch.setattr(hub_core, "save_registry", lambda _registry: None)

    result = subagent._provision_skill(
        "routed", "demo", False, "claude-code", False,
        operation_context=context,
    )

    assert result["ok"] is False
    assert skills_dir.is_symlink() is symlink_root
    assert not (skills_dir / "routed").exists()
    assert (foreign / "keep.txt").read_text() == "foreign"
    assert not (foreign / "routed").exists()
