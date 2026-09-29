"""Historical paths are not local attachment authority for project writers."""
from skill_hub.infrastructure.filesystem import agent_docs


def test_quarantined_agent_docs_neither_scan_nor_write(tmp_path, monkeypatch):
    root = tmp_path / "historical"
    root.mkdir()
    (root / "CLAUDE.md").write_text("unrelated checkout\n")
    project = {"path": str(root), "path_unresolved": True, "harnesses": ["claude-code"]}
    registry = {"harnesses_global": ["claude-code"], "projects": {"old": project}}
    def forbidden(*args, **kwargs):
        raise AssertionError("historical checkout was scanned")
    monkeypatch.setattr(agent_docs, "discover_instruction_dirs", forbidden)
    status = agent_docs.detect_status(project, registry, installed={"claude-code"})
    assert status["state"] == "none"
    assert "attached" in status["reason"]
    assert agent_docs.detect_statuses(project, registry, installed={"claude-code"}) == {}
    plan = agent_docs.plan_fix(project, registry, installed={"claude-code"})
    assert plan["steps"] == []
    assert not agent_docs.apply_fix(project, registry, "old", tmp_path / "backups", plan)["applied"]
    assert not agent_docs.resolve_root(project, registry, "old", tmp_path / "backups", op="keep_claude")["applied"]
    assert sorted(p.name for p in root.iterdir()) == ["CLAUDE.md"]
    assert (root / "CLAUDE.md").read_text() == "unrelated checkout\n"


def test_targeted_subagent_provisioning_skips_quarantine(tmp_data_home, tmp_path):
    from skill_hub.entrypoints.cli.subagent import _provision_project_skill
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: alpha\n---\nBody\n")
    historical = tmp_path / "historical"
    project = {"path": str(historical), "path_unresolved": True, "harnesses": ["claude-code"]}
    registry = {"skills": {"alpha": {"source": str(source), "type": "claude-skill"}}}
    assert _provision_project_skill(project, registry, "alpha", {"claude-code"}) == {}
    assert not historical.exists()


def test_project_skill_scan_does_not_read_historical_checkouts(tmp_data_home, tmp_path):
    from skill_hub.application.sync.sync_engine import scan_project_skill_candidates
    root = tmp_path / "historical"
    skill = root / ".claude" / "skills" / "unrelated"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: unrelated\ndescription: Not this project\n---\nBody\n")
    registry = {"skills": {}, "projects": {"old": {"path": str(root), "path_unresolved": True}}}
    assert scan_project_skill_candidates(registry) == []


def test_loadout_matching_does_not_infer_identity_from_historical_path(tmp_path, monkeypatch):
    from skill_hub.infrastructure.registry import loadout_machine, project_repository

    def forbidden(*args, **kwargs):
        raise AssertionError("historical repository identity was read")

    monkeypatch.setattr(project_repository, "inspect_project_remotes", forbidden)
    registry = {"projects": {"old": {"path": str(tmp_path), "path_unresolved": True}}}
    assert loadout_machine._source_repositories(registry) == []


def test_native_permissions_refuse_unattached_project(tmp_data_home, tmp_path, monkeypatch):
    from argparse import Namespace

    import pytest

    import hub
    from skill_hub.domain.permissions.permissions import ProjectScope
    from skill_hub.entrypoints.cli import permissions
    from skill_hub.infrastructure.permissions import permission_adapters

    project = {"path": str(tmp_path), "path_unresolved": True, "permissions": {"allow": [{"pattern": "Read(*)"}]}}
    registry = {"projects": {"old": project}, "skills": {}, "bundles": {}}
    hub.save_registry(registry)

    def forbidden(*args, **kwargs):
        raise AssertionError("native permissions were read or written")

    monkeypatch.setattr(permission_adapters, "gather_import_candidates", forbidden)
    monkeypatch.setattr(permission_adapters, "select_permission_adapter", forbidden)
    scope = ProjectScope("old", str(tmp_path))
    assert permissions._sync_scope_native(registry, scope, "project", "old", {"claude-code"}) == []
    assert permissions._permissions_divergence(registry, scope, "project", "old") is None
    for command in [permissions.cmd_permissions_import, permissions.cmd_permissions_reconcile]:
        with pytest.raises(SystemExit):
            command(Namespace(project="old", global_=False, apply=True, decisions_stdin=True, json=True))
    assert hub.load_registry()["projects"]["old"]["permissions"] == project["permissions"]
