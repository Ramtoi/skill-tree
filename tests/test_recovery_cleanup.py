"""A restored historical path is not authority to remove local artifacts."""

from argparse import Namespace

import pytest


@pytest.mark.parametrize("action", ["edit-path", "remove"])
def test_project_lifecycle_preserves_unattached_historical_artifacts(tmp_data_home, tmp_path, monkeypatch, action):
    import hub

    old = tmp_path / "unrelated-checkout"
    skills_dir = old / ".claude" / "skills"
    skills_dir.mkdir(parents=True)
    source = tmp_data_home / "skills" / "shared"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text("---\nname: shared\n---\nShared skill\n")
    link = skills_dir / "shared"
    link.symlink_to(source)
    new = tmp_path / "selected-checkout"
    new.mkdir()
    registry = {
        "version": "1", "skills": {}, "bundles": {},
        "projects": {"restored": {"path": str(old), "path_unresolved": True, "enabled": [], "bundles": []}},
    }
    hub.save_registry(registry)
    monkeypatch.setattr(hub, "_auto_sync_tail", lambda **kwargs: True)
    if action == "edit-path":
        hub.cmd_project_edit_path(Namespace(name="restored", new_path=str(new)))
        assert hub.load_registry()["projects"]["restored"]["path"] == str(new)
    else:
        hub.cmd_project_remove(Namespace(name="restored", dry_run=False, json=False))
        assert "restored" not in hub.load_registry()["projects"]
    assert link.is_symlink(), "historical checkout belongs to no attached project"
    assert (link / "SKILL.md").read_text().endswith("Shared skill\n")
